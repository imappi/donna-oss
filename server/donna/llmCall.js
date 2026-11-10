// Donna — the shared model-call envelope (kernel-audit M3 / S1, gap G3).
//
// Design: docs/donna-kernel-audit/llm-call-envelope-design.md.
//
// THE PROBLEM IT EXISTS FOR. 31 modules call a provider URL directly with no
// shared envelope, and exactly ONE of them (intentCompiler.js — the template
// this generalizes) captures token usage at all. So the tree cannot answer
// tokens-per-outcome, calls-per-task, or retry cost, and loop budgets count
// CALLS because counting tokens was never possible.
//
// MEASUREMENT, NOT CONTROL. This wrapper does not choose models, rewrite
// prompts, cap tokens, retry on "bad" content, or second-guess a response. It
// records what a call cost and returns the provider's answer untouched. The
// moment a wrapper starts DECIDING it becomes intelligence-substituting
// scaffolding on the most load-bearing path in the system (CLAUDE.md).
//
// THE SIX RAILS, each pinned by a test in llmCall.test.js:
//  1. Sections are MEASURED, never retained. Section text never reaches the
//     telemetry object. This is G14's explicit mitigation ("the wrapper stores
//     section SIZES, never section contents") and it is why a measurement slice
//     does not widen the surface the retention control just narrowed.
//  2. The raw response is NEVER captured. This envelope does not populate
//     llm_raw_response and does not return the payload as telemetry. #1133's
//     finding 1 established that column is empty in production; this slice is
//     the natural place it would start being filled and deliberately does not
//     fill it. Filling it is a decision, not a side effect.
//  3. ONE typed root execution ref — { type, id }, both required, REFUSED if
//     malformed. Not a nullable 4-way union (the stale S1 shape): a union of
//     four nullable columns is not one identity and cannot be joined on.
//  4. Telemetry failure NEVER changes the call result. Fail-open is correct
//     here and only here — a dropped metric is not a corrupted ledger. This is
//     the deliberate inverse of the Keep layer's posture.
//  5. The model comes from the RESPONSE, not the request, and `model_source`
//     records which. OPENAI_MODEL=gpt-5.4-nano sat in prod for a month
//     silently overriding every per-module strong default; the model id is part
//     of the receipt (CLAUDE.md).
//  6. Retries are a TYPED count, not a log line.

// The cloud-evidence modules are loaded when a call first retains evidence,
// not at import: their graph (hostCertificateA.js and the stores behind it)
// would otherwise put every module that imports the envelope into an import
// cycle with the db layer (2026-11-10, when the text lanes moved onto it).
let cloudEvidenceModules = null;
const loadCloudEvidence = () => {
  cloudEvidenceModules ||= Promise.all([
    import('./cloudProviderProvenance.js'),
    import('./cloudDependencyEvidence.js')
  ]).then(([provenance, dependency]) => ({
    captureCloudProviderProvenance: provenance.captureCloudProviderProvenance,
    persistCloudDependencyEvidence: dependency.persistCloudDependencyEvidence
  }));
  return cloudEvidenceModules;
};
import { currentExecutionBudget } from './executionBudget.js';
import { providerFetchWithDeadline } from './providerTransport.js';
import { assembleAnthropicEventStream, statusForStreamError } from './anthropicEventStream.js';

const nowMs = (now) => (typeof now === 'function' ? now() : Date.now());

// A streamed request (`body.stream === true`) is read to its end and the
// server-sent events reassembled into the one Message a non-streamed call
// returns (anthropicEventStream.js); a JSON body (an error answered before
// the stream began, or a recorded test response) reads as JSON. Measurement
// stays the same either way: the payload this returns is what the rails see.
const readPayload = async (response, streamed) => {
  const contentType = String(response?.headers?.get?.('content-type') || '');
  if (streamed && /event-stream/i.test(contentType) && typeof response.text === 'function') {
    const { payload, error, complete } = assembleAnthropicEventStream(await response.text());
    if (error) return { payload: { ...(payload || {}), error }, streamError: error };
    if (!complete) {
      const truncated = { type: 'api_error', message: 'the event stream ended before message_stop' };
      return { payload: { ...(payload || {}), error: truncated }, streamError: truncated };
    }
    return { payload: payload || {}, streamError: null };
  }
  return { payload: await response.json(), streamError: null };
};

// The five prompt sections G3 names. Fixed vocabulary: a caller inventing a
// sixth would silently fall out of the accounting, so unknown keys are recorded
// under `unknown_sections` rather than dropped.
export const PROMPT_SECTIONS = Object.freeze(['system', 'tools', 'context', 'history', 'results']);

const byteLength = (value) => {
  if (value == null) return 0;
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  if (typeof text !== 'string') return 0;
  return Buffer.byteLength(text, 'utf8');
};

const charLength = (value) => {
  if (value == null) return 0;
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return typeof text === 'string' ? text.length : 0;
};

// RAIL 1 — sizes only. The returned object contains NUMBERS and section NAMES,
// never a byte of the content it measured. Provider `usage` cannot decompose a
// prompt into system/tools/context/history/results, which is exactly why this
// is computed at request construction rather than read back from the response.
export const measureSections = (sections = {}) => {
  const measured = {};
  let totalBytes = 0;
  let totalChars = 0;
  const unknown = [];
  for (const [key, value] of Object.entries(sections || {})) {
    if (!PROMPT_SECTIONS.includes(key)) unknown.push(key);
    const bytes = byteLength(value);
    const chars = charLength(value);
    measured[key] = { bytes, chars };
    totalBytes += bytes;
    totalChars += chars;
  }
  return {
    sections: measured,
    total_bytes: totalBytes,
    total_chars: totalChars,
    // Named, never silently dropped — an unmeasured section is a hole in the
    // accounting and should be visible as one.
    unknown_sections: unknown
  };
};

// RAIL 3 — a typed reference, or nothing. Both halves required, both non-empty.
const normalizeRef = (ref, label, { required }) => {
  if (ref == null) {
    if (required) {
      throw Object.assign(
        new Error(`llmCall requires a typed ${label} ref: { type, id }.`),
        { code: 'LLM_CALL_MISSING_EXECUTION_REF' }
      );
    }
    return null;
  }
  const type = typeof ref.type === 'string' ? ref.type.trim() : '';
  const id = ref.id == null ? '' : String(ref.id).trim();
  if (!type || !id) {
    throw Object.assign(
      new Error(`llmCall ${label} ref must carry a non-empty type AND id — a nullable union is not one execution identity.`),
      { code: 'LLM_CALL_BAD_EXECUTION_REF' }
    );
  }
  return { type, id };
};

// Providers report usage under different keys; normalize to ONE shape and keep
// the untouched provider blob alongside, so a normalization bug stays
// diagnosable instead of silently producing plausible wrong numbers.
export const normalizeUsage = (payload, provider) => {
  const raw = payload?.usage || null;
  if (!raw || typeof raw !== 'object') return null;
  const input = raw.input_tokens ?? raw.prompt_tokens ?? null;
  const output = raw.output_tokens ?? raw.completion_tokens ?? null;
  const total = raw.total_tokens
    ?? (Number.isFinite(input) && Number.isFinite(output) ? input + output : null);
  return {
    input_tokens: Number.isFinite(input) ? input : null,
    output_tokens: Number.isFinite(output) ? output : null,
    total_tokens: Number.isFinite(total) ? total : null,
    provider: provider || null,
    provider_usage: raw
  };
};

// Provider-side correlation id, where one is offered. Header names differ; both
// are read, neither is required.
const providerAttemptId = (response, payload) =>
  payload?.id
  || response?.headers?.get?.('x-request-id')
  || response?.headers?.get?.('request-id')
  || null;

// ── The envelope ────────────────────────────────────────────────────────────
// Returns { result, telemetry }. `result` is whatever `parseResponse` made of
// the provider payload — the caller owns meaning, this owns measurement.
//
// THROWS only for the reasons the call itself failed (transport, non-OK status,
// a throwing parseResponse) or for a malformed execution ref (rail 3, refused
// BEFORE the call so a mis-wired caller cannot spend a token). It never throws
// because telemetry failed (rail 4).
export const llmCall = async ({
  provider,
  url,
  headers = {},
  body,
  // Measured then dropped (rail 1). Pass the same strings/objects that went
  // into `body`; this does not re-serialize them into the request.
  sections = {},
  // { root: { type, id }, parent?: { type, id } } — rail 3.
  execution,
  promptVersion = null,
  configSnapshotId = null,
  parseResponse = (payload) => payload,
  maxAttempts = 1,
  fetchImpl = fetch,
  // The caller's wall for one attempt (headers AND body, a stream read to its
  // end). Inside a worker it is still bounded by the job's remaining budget,
  // never above it. Absent, the transport default (PROVIDER_REQUEST_TIMEOUT_MS).
  timeoutMs = null,
  now = Date.now,
  logger = null
} = {}) => {
  // Refused BEFORE the request: a mis-wired caller should not spend a token to
  // discover its telemetry is unjoinable.
  const root = normalizeRef(execution?.root, 'root_execution', { required: true });
  const parent = normalizeRef(execution?.parent, 'parent_execution', { required: false });

  const startedAt = nowMs(now);
  const attempts = Math.max(1, Number.isFinite(maxAttempts) ? Math.floor(maxAttempts) : 1);
  // Ordinary parser/extractor callers must honor the owning job too, even
  // when they did not supply the deadline-bearing transport themselves.
  // Outside a worker budget the existing caller's transport is unchanged.
  const boundedFetch = currentExecutionBudget()
    ? providerFetchWithDeadline({ provider, fetchImpl, ...(Number.isFinite(timeoutMs) && timeoutMs > 0 ? { timeoutMs } : {}) })
    : fetchImpl;

  let response = null;
  let payload = null;
  let attemptCount = 0;
  let lastError = null;

  while (attemptCount < attempts) {
    attemptCount += 1;
    try {
      response = await boundedFetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
      // A body read that the provider transport CANCELLED (providerTransport.js
      // providerFetchWithDeadline: the deadline or the worker's execution
      // budget) is a typed failure and must surface as one — never "no
      // payload, status OK". Any other body-read error stays what it was:
      // an empty payload the status decides.
      let streamError = null;
      ({ payload, streamError } = await readPayload(response, body?.stream === true).catch((error) => {
        if (error?.providerFailure === true) throw error;
        return { payload: {}, streamError: null };
      }));
      if (response.ok && !streamError) { lastError = null; break; }
      lastError = Object.assign(
        new Error(payload?.error?.message || `${provider || 'provider'} returned ${response.status}`),
        // `providerError`: the provider's own error object, so a caller can tell
        // an empty account from a rate limit or a rejected request. A
        // mid-stream error event after a 200 carries its own error object and
        // the status its type stands for (an overload mid-stream is a 529).
        {
          code: 'LLM_CALL_PROVIDER_ERROR',
          status: streamError ? statusForStreamError(streamError.type) : response.status,
          providerError: payload?.error && typeof payload.error === 'object' ? payload.error : null
        }
      );
    } catch (error) {
      lastError = error;
    }
    // Retry only while attempts remain. No backoff here on purpose: this
    // envelope measures, it does not own retry policy.
    if (attemptCount >= attempts) break;
    if (currentExecutionBudget()?.signal.aborted) break;
  }

  // RAIL 4 — telemetry is assembled inside its own guard, so nothing here can
  // turn a successful call into a failure or a failure into a success.
  let telemetry = null;
  try {
    // RAIL 5 — the model the API actually served, and whether we had to fall back.
    const responseModel = typeof payload?.model === 'string' && payload.model ? payload.model : null;
    telemetry = {
      provider: provider || null,
      model: responseModel || body?.model || null,
      model_source: responseModel ? 'response' : 'request',
      prompt_version: promptVersion,
      config_snapshot_id: configSnapshotId,
      root_execution: root,
      parent_execution: parent,
      usage: normalizeUsage(payload, provider),
      latency_ms: nowMs(now) - startedAt,
      attempt_count: attemptCount,
      provider_attempt_id: providerAttemptId(response, payload),
      // RAIL 1 — sizes only.
      prompt_sections: measureSections(sections),
      ok: !lastError && Boolean(response?.ok),
      status: lastError?.status ?? response?.status ?? null
    };
  } catch (telemetryError) {
    (logger || console).warn?.('[llmCall] telemetry capture failed; the call result is unaffected', {
      provider,
      error: telemetryError?.message || String(telemetryError)
    });
    telemetry = null;
  }

  const retainCloudProvenance = async (error = null) => {
    try {
      const { captureCloudProviderProvenance, persistCloudDependencyEvidence } = await loadCloudEvidence();
      const evidence = captureCloudProviderProvenance({ url, headers, response, payload, error, observedAt: new Date(nowMs(now)).toISOString() });
      if (evidence) {
        if (telemetry) telemetry.cloud_dependency_evidence = evidence;
        await persistCloudDependencyEvidence(evidence);
      }
    } catch { (logger || console).warn?.('[llmCall] cloud dependency evidence unavailable'); }
  };
  if (lastError) {
    await retainCloudProvenance(lastError);
    throw Object.assign(lastError, { telemetry });
  }

  // The caller owns meaning. A throwing parseResponse is the caller's failure
  // and propagates — with the telemetry attached, so a parse failure is still
  // measurable.
  let result;
  try {
    result = parseResponse(payload);
  } catch (parseError) {
    await retainCloudProvenance(parseError);
    throw Object.assign(parseError, { telemetry });
  }

  // RAIL 2 — note what is NOT here: no `payload`, no raw response, no section
  // text. The return value is the parsed result the caller asked for plus
  // numbers about the call.
  await retainCloudProvenance();
  return { result, telemetry };
};

// ── For sites that own their own transport ──────────────────────────────────
// A few call sites inject a STRUCTURED transport seam rather than a fetch —
// `intentCompiler.js`'s `__callAnthropic({ apiKey, model, messages, system,
// tool })` is the case this exists for, and its tests assert on those named
// args. Routing such a site through llmCall's fetch would mean rewriting its
// injection point for no behavioural gain, and would make its telemetry absent
// in exactly the tests that cover it.
//
// So they keep the socket and adopt the SHAPE — which is the actual point of an
// envelope: ONE telemetry shape and ONE join key, whoever owns the connection.
// A site using this stays on the provider-URL allowlist (it still has a direct
// fetch), and that is honest: partial adoption is recorded as partial.
export const telemetryFromParts = ({
  provider,
  payload = null,
  requestedModel = null,
  sections = {},
  execution,
  promptVersion = null,
  configSnapshotId = null,
  latencyMs = null,
  attemptCount = 1,
  ok = true,
  status = null,
  logger = null
} = {}) => {
  try {
    // Same refusal as llmCall — an unjoinable ref is a wiring bug, not a metric.
    const root = normalizeRef(execution?.root, 'root_execution', { required: true });
    const parent = normalizeRef(execution?.parent, 'parent_execution', { required: false });
    const responseModel = typeof payload?.model === 'string' && payload.model ? payload.model : null;
    return {
      provider: provider || null,
      model: responseModel || requestedModel || null,
      model_source: responseModel ? 'response' : 'request',
      prompt_version: promptVersion,
      config_snapshot_id: configSnapshotId,
      root_execution: root,
      parent_execution: parent,
      usage: normalizeUsage(payload, provider),
      latency_ms: Number.isFinite(latencyMs) ? latencyMs : null,
      attempt_count: attemptCount,
      provider_attempt_id: payload?.id || null,
      prompt_sections: measureSections(sections),
      ok: Boolean(ok),
      status
    };
  } catch (error) {
    // RAIL 4 applies here too: a caller asking for telemetry must never be
    // broken by telemetry. A bad ref is warned and yields null.
    (logger || console).warn?.('[llmCall] telemetryFromParts failed; the caller is unaffected', {
      provider,
      error: error?.message || String(error)
    });
    return null;
  }
};

// Map an envelope telemetry object onto recordLlmDecision's telemetry argument.
// Kept here rather than in llmDecisions.js so the column mapping lives beside
// the shape it maps FROM, and a change to one is visibly a change to both.
export const telemetryForDecision = (telemetry) => {
  if (!telemetry) return null;
  return {
    usage: telemetry.cloud_dependency_evidence
      ? { ...telemetry.usage, cloud_dependency_evidence: telemetry.cloud_dependency_evidence }
      : telemetry.usage || null,
    rootExecutionType: telemetry.root_execution?.type || null,
    rootExecutionId: telemetry.root_execution?.id || null,
    parentExecutionType: telemetry.parent_execution?.type || null,
    parentExecutionId: telemetry.parent_execution?.id || null,
    latencyMs: Number.isFinite(telemetry.latency_ms) ? telemetry.latency_ms : null,
    attemptCount: Number.isFinite(telemetry.attempt_count) ? telemetry.attempt_count : null,
    providerAttemptId: telemetry.provider_attempt_id || null,
    promptSections: telemetry.prompt_sections || null
  };
};

// ── For lanes whose seam is response-shaped ─────────────────────────────────
// Several document lanes expose a test seam (`__callOpenAi`) whose contract
// is a fetch Response: `{ ok, status, json() }`. Their DEFAULT transport now
// rides the envelope; this adapter turns an envelope call back into that
// shape so the seam, and every test that injects it, is unchanged. A non-OK
// provider status becomes `{ ok: false, status }` (what the seam returned
// before) whose body carries the provider's own error object, so the lane's
// readProviderError (inngest/parseErrors.js) still names an empty account;
// transport throws propagate exactly as a bare fetch's did.
export const asProviderResponse = async (envelopeCall) => {
  try {
    const { result, telemetry } = await envelopeCall;
    return { ok: true, status: 200, json: async () => result, telemetry };
  } catch (error) {
    if (error?.code === 'LLM_CALL_PROVIDER_ERROR') {
      return {
        ok: false,
        status: Number(error.status || 0),
        json: async () => (error.providerError ? { error: error.providerError } : {}),
        telemetry: error.telemetry || null
      };
    }
    throw error;
  }
};
