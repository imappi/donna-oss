import { createHash } from 'node:crypto';

import { KNOWN_PROVIDER_HOSTS } from '../server/donna/providerEndpoints.js';
import { buildGate2bLiveBudget } from '../server/donna/world/gate2bConvergenceProof.js';
import { canonicalJson } from '../server/donna/world/unitExecutionReceipt.js';

export const GATE2B_PROVIDER_CAPTURE_VERSION = 'eaw.gate2b.provider-capture.v1';

// Reuse the production provider registry instead of introducing a second set
// of provider endpoint literals at the certificate boundary. Gate 2B prices
// and permits only the two provider-owned endpoint classes used by the world;
// compatible/local challengers need their own explicitly priced lane before
// they can enter a live certificate.
const PROVIDERS = new Map(
  KNOWN_PROVIDER_HOSTS
    .filter(({ endpointClass }) => endpointClass === 'openai' || endpointClass === 'anthropic')
    .map(({ host, endpointClass }) => [host, endpointClass]),
);

/**
 * Install a run-scoped provider boundary around the existing production calls.
 * It records request sizes/digests and response telemetry, never prompt or
 * response content. Unknown network egress and calls outside the approved
 * lane/call/token caps are refused before a socket is opened.
 */
export function createGate2bProviderCapture({
  budget,
  fetchImpl = globalThis.fetch,
  countTokensImpl = countProviderInputTokens,
  now = Date.now,
} = {}) {
  assertApprovedBudget(budget);
  if (typeof fetchImpl !== 'function') throw coded('EAW_GATE2B_FETCH_REQUIRED', 'A provider fetch implementation is required.');
  if (typeof countTokensImpl !== 'function') throw coded('EAW_GATE2B_TOKEN_COUNTER_REQUIRED', 'A provider input-token counter is required.');
  const calls = [];
  const perRunLane = new Map();
  let activeRunToken = null;
  let installed = false;

  const setRunToken = (runToken) => {
    if (typeof runToken !== 'string' || !runToken.trim()) throw coded('EAW_GATE2B_RUN_TOKEN_REQUIRED', 'Provider capture requires a run token.');
    activeRunToken = runToken.trim();
  };

  const trackedFetch = async (input, init = {}) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input?.url);
    const provider = PROVIDERS.get(url.hostname);
    if (!provider) throw coded('EAW_GATE2B_EGRESS_REFUSED', `Gate 2B refused network egress to ${url.hostname || 'an unknown host'}.`);
    if (!activeRunToken) throw coded('EAW_GATE2B_RUN_TOKEN_REQUIRED', 'A Gate 2B run token must be bound before a provider call.');

    const originalRequestBytes = bodyBytes(init?.body);
    let requestBody = null;
    try { requestBody = JSON.parse(originalRequestBytes.toString('utf8')); } catch { /* refused below */ }
    if (!requestBody || typeof requestBody !== 'object' || Array.isArray(requestBody)) {
      throw coded('EAW_GATE2B_PROVIDER_BODY_INVALID', 'Provider requests must carry a JSON object so the hard cap can be enforced.');
    }
    const requestedModel = String(requestBody.model || '').trim();
    const lane = budget.lanes.find((item) => item.provider === provider && item.model_id === requestedModel);
    if (!lane) throw coded('EAW_GATE2B_PROVIDER_LANE_UNAPPROVED', `${provider}/${requestedModel || '<missing>'} is outside the approved Gate 2B budget.`);
    const requestedOutputCap = readOutputCap(requestBody, provider);
    if (requestedOutputCap == null) {
      // Several production call sites predate request-level output ceilings.
      // The evaluation boundary supplies the already-approved ceiling rather
      // than permitting an unbounded request or changing product behaviour for
      // ordinary runs. The digest below covers this exact transmitted body.
      writeOutputCap(requestBody, provider, lane.max_output_tokens_per_call);
    } else if (!Number.isSafeInteger(requestedOutputCap) || requestedOutputCap <= 0 || requestedOutputCap > lane.max_output_tokens_per_call) {
      throw coded('EAW_GATE2B_OUTPUT_CAP_REFUSED', `${provider}/${requestedModel} requested an invalid or excessive output cap.`);
    }
    const requestBytes = Buffer.from(JSON.stringify(requestBody), 'utf8');
    const runLaneKey = `${activeRunToken}:${lane.lane}`;
    const usedForRun = perRunLane.get(runLaneKey) || 0;
    if (usedForRun >= lane.max_calls_per_run || calls.length >= budget.totals.calls) {
      throw coded('EAW_GATE2B_CALL_CAP_REFUSED', `The approved call cap is exhausted for ${lane.lane}.`);
    }
    perRunLane.set(runLaneKey, usedForRun + 1);

    const requestDigest = sha256(requestBytes);
    const retryIndex = calls.filter((call) => call.run_token === activeRunToken && call.request_digest === requestDigest).length;
    const startedAt = Number(now());
    let tokenCount;
    try {
      tokenCount = await countTokensImpl({ provider, url, init, requestBody, fetchImpl });
    } catch (error) {
      calls.push(incompleteCall({
        activeRunToken, lane, provider, requestDigest, retryIndex,
        startedAt, now, outcome: 'input_token_count_error', error,
      }));
      throw coded('EAW_GATE2B_TOKEN_COUNT_FAILED', `${provider}/${requestedModel} input-token preflight failed: ${error?.message || String(error)}`);
    }
    if (!Number.isSafeInteger(tokenCount?.input_tokens) || tokenCount.input_tokens < 0) {
      const error = coded('EAW_GATE2B_TOKEN_COUNT_INVALID', `${provider}/${requestedModel} input-token preflight returned no usable count.`);
      calls.push(incompleteCall({
        activeRunToken, lane, provider, requestDigest, retryIndex,
        startedAt, now, outcome: 'input_token_count_error', error,
      }));
      throw error;
    }
    // Anthropic documents that its count is an estimate that may differ by a
    // small amount. Keep a 10% admission reserve while pricing the full lane
    // ceiling, so a counted request cannot consume the whole approved bound.
    const admissionLimit = Math.floor(lane.max_input_tokens_per_call * 0.9);
    if (tokenCount.input_tokens > admissionLimit) {
      const error = coded('EAW_GATE2B_INPUT_CAP_REFUSED', `${provider}/${requestedModel} counted input exceeds the approved admission ceiling.`);
      calls.push(incompleteCall({
        activeRunToken, lane, provider, requestDigest, retryIndex,
        startedAt, now, outcome: 'input_cap_refused', error,
        inputTokens: tokenCount.input_tokens, tokenCount,
      }));
      throw error;
    }
    let response;
    try {
      response = await fetchImpl(input, { ...init, body: requestBytes.toString('utf8') });
    } catch (error) {
      calls.push({
        run_token: activeRunToken, lane: lane.lane, provider,
        response_id: null, model_id: null, input_tokens: null, output_tokens: null,
        wall_time_ms: elapsed(startedAt, now), request_digest: requestDigest,
        http_status: null, retry_index: retryIndex, retry_disposition: 'transport_error',
        cache_disposition: 'not_reported', outcome: 'transport_error',
        error_code: error?.code || error?.name || 'provider_transport_error',
        input_token_preflight: tokenCount,
      });
      throw error;
    }
    let payload = null;
    try { payload = await response.clone().json(); } catch { /* incompleteness is explicit in the receipt */ }
    const usage = normalizeUsage(payload);
    const servedModel = stringOrNull(payload?.model);
    const outcome = Number.isSafeInteger(usage.input) && usage.input > lane.max_input_tokens_per_call
      ? 'input_cap_breached'
      : Number.isSafeInteger(usage.output) && usage.output > lane.max_output_tokens_per_call
        ? 'output_cap_breached'
        : servedModel && !servedModelMatches(requestedModel, servedModel)
          ? 'served_model_unapproved'
          : response.ok ? 'success' : 'http_error';
    calls.push({
      run_token: activeRunToken,
      lane: lane.lane,
      provider,
      response_id: stringOrNull(payload?.id || response.headers?.get?.('x-request-id') || response.headers?.get?.('request-id')),
      model_id: servedModel,
      input_tokens: usage.input,
      output_tokens: usage.output,
      wall_time_ms: elapsed(startedAt, now),
      request_digest: requestDigest,
      http_status: Number.isInteger(response.status) ? response.status : null,
      retry_index: retryIndex,
      retry_disposition: retryIndex ? 'retry_attempt' : 'initial_attempt',
      cache_disposition: cacheDisposition(response),
      outcome,
      input_token_preflight: tokenCount,
    });
    if (outcome === 'input_cap_breached') {
      throw coded('EAW_GATE2B_INPUT_CAP_BREACHED', `${provider}/${requestedModel} reported input usage above the approved hard ceiling.`);
    }
    if (outcome === 'output_cap_breached') {
      throw coded('EAW_GATE2B_OUTPUT_CAP_BREACHED', `${provider}/${requestedModel} reported output usage above the approved hard ceiling.`);
    }
    if (outcome === 'served_model_unapproved') {
      throw coded('EAW_GATE2B_SERVED_MODEL_UNAPPROVED', `${provider} served ${servedModel} outside the approved ${requestedModel} model family.`);
    }
    return response;
  };

  const install = () => {
    if (installed || globalThis.fetch !== fetchImpl) throw coded('EAW_GATE2B_FETCH_SCOPE_BUSY', 'The global fetch boundary changed before Gate 2B could install its capture.');
    installed = true;
    globalThis.fetch = trackedFetch;
  };
  const restore = () => {
    if (!installed) return;
    if (globalThis.fetch !== trackedFetch) throw coded('EAW_GATE2B_FETCH_SCOPE_CHANGED', 'The Gate 2B provider boundary was replaced while the run was active.');
    globalThis.fetch = fetchImpl;
    installed = false;
  };

  const receipt = ({ runToken = null, configurationDigest, artifactDigests, priceSources = budget.lanes.map((lane) => lane.price_source) } = {}) => {
    const selectedCalls = runToken == null ? calls : calls.filter((call) => call.run_token === runToken);
    const completeCalls = selectedCalls.filter(isCompleteCall);
    const cashUsd = roundUsd(selectedCalls.reduce((total, call) => {
      const lane = budget.lanes.find((item) => item.lane === call.lane && item.provider === call.provider);
      if (!lane || !Number.isSafeInteger(call.input_tokens) || !Number.isSafeInteger(call.output_tokens)) return total;
      return total + (
        call.input_tokens * lane.price_source.input_usd_per_million
        + call.output_tokens * lane.price_source.output_usd_per_million
      ) / 1_000_000;
    }, 0));
    const body = {
      version: GATE2B_PROVIDER_CAPTURE_VERSION,
      status: completeCalls.length === selectedCalls.length && selectedCalls.length > 0 ? 'counted' : 'incomplete',
      solveCalls: selectedCalls.filter((call) => call.outcome === 'success').length,
      calls: selectedCalls.map(({ run_token: _runToken, lane: _lane, error_code: _errorCode, ...call }) => ({ ...call })),
      calls_by_run: Object.fromEntries([...new Set(selectedCalls.map((call) => call.run_token))].sort().map((token) => [token, selectedCalls.filter((call) => call.run_token === token).length])),
      cash: { usd: cashUsd, price_source: { sources: structuredClone(priceSources) } },
      configurationDigest,
      artifactDigests: [...new Set(artifactDigests || [])].sort(),
      incomplete_attempts: selectedCalls.filter((call) => !isCompleteCall(call)).map((call) => ({
        run_token: call.run_token,
        request_digest: call.request_digest,
        error_code: call.error_code || 'provider_receipt_incomplete',
      })),
    };
    return Object.freeze({ ...body, receipt_digest: sha256(Buffer.from(canonicalJson(body))) });
  };

  return Object.freeze({ setRunToken, install, restore, receipt, calls: () => structuredClone(calls) });
}

function assertApprovedBudget(budget) {
  if (budget?.status !== 'APPROVED' || budget?.first_live_call_allowed !== true || !Array.isArray(budget?.lanes) || !budget.lanes.length) {
    throw coded('EAW_GATE2B_BUDGET_NOT_APPROVED', 'Gate 2B provider capture requires an approved measured hard cap.');
  }
  for (const lane of budget.lanes) {
    for (const field of ['max_calls_per_run', 'max_input_tokens_per_call', 'max_output_tokens_per_call']) {
      if (!Number.isSafeInteger(lane?.[field]) || lane[field] <= 0) throw coded('EAW_GATE2B_BUDGET_INVALID', `Approved budget lane ${lane?.lane || '<unknown>'} lacks ${field}.`);
    }
  }
  const rebuilt = buildGate2bLiveBudget({
    worldId: budget.world_id,
    k: budget.k,
    lanes: budget.lanes,
    approved: budget.approval,
  });
  if (rebuilt.status !== 'APPROVED' || canonicalJson(rebuilt) !== canonicalJson(budget)) {
    throw coded('EAW_GATE2B_BUDGET_INVALID', 'The approved budget does not match the calculated lane totals and approval receipt.');
  }
}

function readOutputCap(body, provider) {
  if (provider === 'anthropic') return body.max_tokens ?? null;
  return body.max_output_tokens ?? body.max_completion_tokens ?? body.max_tokens ?? null;
}
function writeOutputCap(body, provider, value) {
  if (provider === 'anthropic') body.max_tokens = value;
  else body.max_output_tokens = value;
}
async function countProviderInputTokens({ provider, url, init, requestBody, fetchImpl }) {
  const body = structuredClone(requestBody);
  delete body.max_output_tokens;
  delete body.max_completion_tokens;
  delete body.max_tokens;
  delete body.store;
  const endpoint = provider === 'anthropic'
    ? new URL('/v1/messages/count_tokens', url)
    : new URL('/v1/responses/input_tokens', url);
  const bytes = Buffer.from(JSON.stringify(body), 'utf8');
  const response = await fetchImpl(endpoint, { ...init, method: 'POST', body: bytes.toString('utf8') });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw coded('EAW_GATE2B_TOKEN_COUNT_HTTP_ERROR', payload?.error?.message || `Token counter returned ${response.status}.`);
  const inputTokens = payload.input_tokens;
  return {
    input_tokens: Number.isSafeInteger(inputTokens) && inputTokens >= 0 ? inputTokens : null,
    http_status: Number.isInteger(response.status) ? response.status : null,
    request_digest: sha256(bytes),
    endpoint_path: endpoint.pathname,
    cost: 'free_provider_token_count',
  };
}
function normalizeUsage(payload) {
  const usage = payload?.usage || {};
  const input = usage.input_tokens ?? usage.prompt_tokens;
  const output = usage.output_tokens ?? usage.completion_tokens;
  return {
    input: Number.isSafeInteger(input) && input >= 0 ? input : null,
    output: Number.isSafeInteger(output) && output >= 0 ? output : null,
  };
}
function bodyBytes(body) {
  if (Buffer.isBuffer(body)) return body;
  if (body instanceof Uint8Array) return Buffer.from(body);
  if (typeof body === 'string') return Buffer.from(body, 'utf8');
  return Buffer.alloc(0);
}
function cacheDisposition(response) {
  const value = response?.headers?.get?.('x-cache') || response?.headers?.get?.('cf-cache-status');
  return value ? String(value).toLowerCase() : 'not_reported';
}
function isCompleteCall(call) {
  return typeof call.response_id === 'string' && call.response_id
    && typeof call.model_id === 'string' && call.model_id
    && Number.isSafeInteger(call.input_tokens) && call.input_tokens >= 0
    && Number.isSafeInteger(call.output_tokens) && call.output_tokens >= 0
    && Number.isSafeInteger(call.wall_time_ms) && call.wall_time_ms >= 0
    && Number.isInteger(call.http_status) && call.http_status >= 100 && call.http_status <= 599
    && Number.isSafeInteger(call.input_token_preflight?.input_tokens)
    && call.input_token_preflight.input_tokens >= 0;
}
function incompleteCall({ activeRunToken, lane, provider, requestDigest, retryIndex, startedAt, now, outcome, error, inputTokens = null, tokenCount = null }) {
  return {
    run_token: activeRunToken, lane: lane.lane, provider,
    response_id: null, model_id: null, input_tokens: inputTokens, output_tokens: null,
    wall_time_ms: elapsed(startedAt, now), request_digest: requestDigest,
    http_status: null, retry_index: retryIndex, retry_disposition: 'preflight_refusal',
    cache_disposition: 'not_reported', outcome,
    error_code: error?.code || error?.name || 'provider_preflight_error',
    input_token_preflight: tokenCount,
  };
}
function elapsed(startedAt, now) { return Math.max(0, Math.round(Number(now()) - startedAt)); }
function stringOrNull(value) { return typeof value === 'string' && value.trim() ? value.trim() : null; }
function servedModelMatches(requested, served) { return served === requested || served.startsWith(`${requested}-`); }
function roundUsd(value) { return Math.ceil(value * 1_000_000) / 1_000_000; }
function sha256(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
function coded(code, message) { return Object.assign(new Error(message), { code }); }
