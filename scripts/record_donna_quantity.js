#!/usr/bin/env node
// Opt-in local recorder; uses the existing multimodal, telemetry and deadline owners.
import { openSync, writeSync, fsyncSync, closeSync, realpathSync, fstatSync, lstatSync, renameSync, unlinkSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, resolve, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { llmCall } from '../server/donna/llmCall.js';
import { providerFetchWithDeadline, providerKeyMissing, providerInvalidOutput, classifyProviderStatus,
  PROVIDER_FAILURE_CODES } from '../server/donna/providerTransport.js';
import { resolveRuntimeHostIdentity } from '../server/donna/runtimeHostIdentity.js';
import { buildResponsesDocumentPart } from '../server/donna/responsesInputPart.js';
import { buildBlindQuantityRequest, quantityProposalFromEnvelope } from '../server/donna/inventory/quantityProposal.js';
import { loadLocalQuantityCorpus, requireExternalPath, corpusError } from './donna_quantity_corpus.js';

export const LOCAL_RECORDINGS_VERSION = 'donna-quantity-local-recordings.v1';
const ENDPOINT = 'https://api.openai.com/v1/responses';
const number = v => typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;
const identifier = v => typeof v === 'string' && /^[A-Za-z0-9_.:-]{1,200}$/.test(v) ? v : null;

// Keep actual llmCall measurements, but drop untyped provider usage extensions,
// cloud metadata and raw error/body content before they reach a local receipt.
export const recordingTelemetry = t => t ? {
  provider: 'openai', model: identifier(t.model), model_source: t.model_source === 'response' ? 'response' : 'request',
  prompt_version: t.prompt_version, root_execution: t.root_execution, parent_execution: null,
  usage: t.usage ? { provider: 'openai', input_tokens: number(t.usage.input_tokens),
    output_tokens: number(t.usage.output_tokens), total_tokens: number(t.usage.total_tokens) } : null,
  latency_ms: number(t.latency_ms), attempt_count: number(t.attempt_count),
  provider_attempt_id: identifier(t.provider_attempt_id), prompt_sections: t.prompt_sections,
  ok: t.ok === true, status: number(t.status)
} : null;

export const buildLocalQuantityBody = fixture => {
  const request = buildBlindQuantityRequest(fixture.input);
  const content = [{ type: 'input_text', text: JSON.stringify(request.input) }];
  for (const [i, media] of fixture.media.entries()) {
    content.push({ type: 'input_text', text: `evidence_${i + 1}` });
    content.push(buildResponsesDocumentPart({ dataUrl: `data:${media.mime};base64,${media.bytes.toString('base64')}` }));
  }
  return { request, body: { store: false, instructions: request.system,
    input: [{ role: 'user', content }],
    text: { format: { type: 'json_schema', name: 'physical_quantity_proposal', strict: true, schema: request.responseSchema } } } };
};

const parseResult = payload => {
  try {
    if (payload?.status !== 'completed' || !Array.isArray(payload.output) || payload.output.length > 100) throw new Error();
    const parts = [];
    for (const item of payload.output) {
      if (!item || typeof item.type !== 'string') throw new Error();
      if (item.type === 'message') {
        if (!Array.isArray(item.content) || item.content.length > 100) throw new Error();
        parts.push(...item.content);
      }
    }
    if (parts.some(p => !p || p.type !== 'output_text' || typeof p.text !== 'string')) throw new Error();
    const text = parts.map(p => p.text).join('');
    if (!text || text.length > 32_000) throw new Error();
    return JSON.parse(text);
  } catch { throw providerInvalidOutput('openai'); }
};
const failureReceipt = (error, telemetry) => {
  const typed = error.code === 'LLM_CALL_PROVIDER_ERROR' ? classifyProviderStatus({ provider: 'openai', status: error.status }) : error;
  const codes = Object.values(PROVIDER_FAILURE_CODES);
  const invalid = typed.code === PROVIDER_FAILURE_CODES.INVALID_OUTPUT || typed.code?.startsWith('QUANTITY_');
  return { category: invalid ? 'invalid_output' : 'transport',
    code: codes.includes(typed.code) ? typed.code : invalid ? 'PROVIDER_INVALID_OUTPUT' : 'RECORDING_FAILED',
    status: number(typed.status ?? telemetry?.status), retryable: typed.retryable === true,
    owner: typed.owner === 'operator' ? 'operator' : 'queue' };
};

export const recordLocalQuantities = async ({ manifestPath, caseIds = [], executeProvider = false,
  model = null, maxCalls = null, deadlineMs = null, maxAttempts = 1, output = null, runId = null,
  fetchImpl = globalThis.fetch, apiKey, now = Date.now } = {}) => {
  if (resolveRuntimeHostIdentity().runtime_host !== 'desktop') corpusError('RECORDING_LOCAL_RUNTIME_REQUIRED');
  const corpus = loadLocalQuantityCorpus(manifestPath);
  if (!Array.isArray(caseIds) || !caseIds.length || caseIds.length > 10 || new Set(caseIds).size !== caseIds.length
    || caseIds.some(id => !corpus.fixtures.some(f => f.id === id))) corpusError('RECORDING_CASE_SELECTION_REQUIRED');
  const fixtures = corpus.fixtures.filter(f => caseIds.includes(f.id));
  const plan = { version: 'donna-quantity-recording-plan.v1', status: 'dry_run', manifestDigest: corpus.manifestDigest,
    selectedCases: fixtures.map(f => ({ id: f.id, split: f.split, evidenceCount: f.media.length,
      imageBytes: f.media.reduce((n, m) => n + m.bytes.length, 0) })), providerCalls: 0, spendUsd: 0 };
  if (executeProvider !== true) return plan; // Only literal opt-in permits key reads, writes or calls.
  if (!identifier(model) || !Number.isSafeInteger(maxCalls) || maxCalls < fixtures.length || maxCalls > 10
    || !Number.isSafeInteger(deadlineMs) || deadlineMs < 1000 || deadlineMs > 120_000 || maxAttempts !== 1
    || !identifier(runId) || !output || !isAbsolute(output)) corpusError('RECORDING_EXECUTION_BOUNDS_REQUIRED');
  const key = apiKey === undefined ? process.env.OPENAI_API_KEY : apiKey;
  if (!key) throw providerKeyMissing('openai', { keyName: 'OPENAI_API_KEY' });
  // Reserve an exclusive private file before the first paid call. The manifest
  // cannot choose an endpoint, output path, credential, model or execution id.
  const destination = requireExternalPath(resolve(realpathSync(dirname(output)), output.slice(dirname(output).length + 1)));
  const reservation = openSync(destination, 'wx', 0o600);
  let owned = fstatSync(reservation);
  closeSync(reservation);
  const recordings = { version: LOCAL_RECORDINGS_VERSION, recordingKind: 'recorded_provider',
    manifestDigest: corpus.manifestDigest, run: { id: runId, requestedModel: model, maxCalls, deadlineMs, maxAttempts: 1 },
    cases: [], failures: [] };
  const assertOutputOwned = () => {
    let current;
    try { current = lstatSync(destination); } catch { corpusError('RECORDING_OUTPUT_REPLACED'); }
    if (!current.isFile() || current.dev !== owned.dev || current.ino !== owned.ino
      || current.size !== owned.size || current.mtimeMs !== owned.mtimeMs || current.ctimeMs !== owned.ctimeMs) {
      corpusError('RECORDING_OUTPUT_REPLACED');
    }
  };
  const save = () => {
    assertOutputOwned();
    const temporary = `${destination}.checkpoint-${randomUUID()}`;
    const fd = openSync(temporary, 'wx', 0o600);
    const temporaryIdentity = fstatSync(fd);
    let replaced = false;
    try {
      const bytes = Buffer.from(`${JSON.stringify(recordings, null, 2)}\n`);
      let offset = 0;
      while (offset < bytes.length) {
        const written = writeSync(fd, bytes, offset, bytes.length - offset, offset);
        if (written <= 0) corpusError('RECORDING_CHECKPOINT_FAILED');
        offset += written;
      }
      fsyncSync(fd);
      // Refuse an output another process has replaced or edited since
      // our exclusive reservation/last checkpoint. Complete the private file
      // before the atomic rename, keeping the previous receipt on write failure.
      assertOutputOwned();
      renameSync(temporary, destination);
      replaced = true;
      owned = fstatSync(fd);
      const directory = openSync(dirname(destination), 'r');
      try { fsyncSync(directory); } finally { closeSync(directory); }
    } finally {
      closeSync(fd);
      if (!replaced) {
        try {
          const current = lstatSync(temporary);
          if (current.dev === temporaryIdentity.dev && current.ino === temporaryIdentity.ino) unlinkSync(temporary);
        } catch { /* Preserve the original checkpoint error. */ }
      }
    }
  };
  save();
  for (const [index, fixture] of fixtures.entries()) {
    const recordedAt = new Date(now()).toISOString();
    const { request, body } = buildLocalQuantityBody(fixture);
    const identity = { id: fixture.id, inputDigest: request.inputDigest, recordedAt, costReceipt: null };
    // A crash after this point cannot prove whether the provider received or
    // billed the request. Persist that uncertainty before admitting inference.
    const pendingIndex = recordings.failures.length;
    recordings.failures.push({ ...identity, failure: { category: 'transport', code: 'RECORDING_OUTCOME_UNKNOWN',
      status: null, retryable: false, owner: 'operator' }, telemetry: null });
    save();
    let envelope;
    try {
      envelope = await llmCall({ provider: 'openai', url: ENDPOINT,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body: { ...body, model, max_output_tokens: 1500 },
        execution: { root: { type: 'offline_quantity_recording', id: `${runId}:call-${index + 1}` } },
        promptVersion: fixture.input.protocolVersion, maxAttempts: 1, now,
        sections: { system: request.system, tools: request.responseSchema, context: request.input },
        fetchImpl: providerFetchWithDeadline({ provider: 'openai', timeoutMs: deadlineMs,
          fetchImpl: async (url, init) => {
            const response = await fetchImpl(url, { ...init, redirect: 'error' });
            if (response.url && response.url !== ENDPOINT) throw providerInvalidOutput('openai');
            return response;
          } }),
        parseResponse: parseResult, logger: { warn() {} } });
      envelope = { result: envelope.result, telemetry: recordingTelemetry(envelope.telemetry) };
      const proposal = quantityProposalFromEnvelope({ input: fixture.input, envelope,
        recordingKind: 'recorded_provider', recordedAt });
      recordings.failures.splice(pendingIndex, 1);
      recordings.cases.push({ ...identity, envelope, proposalDigest: proposal.proposalDigest });
    } catch (error) {
      const telemetry = recordingTelemetry(error.telemetry || envelope?.telemetry);
      recordings.failures.splice(pendingIndex, 1, { ...identity, failure: failureReceipt(error, telemetry), telemetry });
    }
    save();
  }
  return recordings;
};

export const main = async argv => {
  const args = {};
  for (const token of argv) {
    const match = /^--(manifest|cases|model|max-calls|deadline-ms|max-attempts|output|run-id)=(.+)$/.exec(token);
    const key = token === '--execute-provider' ? 'execute-provider' : match?.[1];
    if (!key || Object.hasOwn(args, key)) corpusError('RECORDING_ARGUMENT_INVALID');
    args[key] = match ? match[2] : true;
  }
  if (!args.manifest || !args.cases) corpusError('RECORDING_MANIFEST_AND_CASES_REQUIRED');
  const result = await recordLocalQuantities({ manifestPath: resolve(args.manifest), caseIds: args.cases.split(','),
    executeProvider: args['execute-provider'] === true, model: args.model,
    maxCalls: args['max-calls'] ? Number(args['max-calls']) : null,
    deadlineMs: args['deadline-ms'] ? Number(args['deadline-ms']) : null,
    maxAttempts: args['max-attempts'] ? Number(args['max-attempts']) : 1,
    output: args.output, runId: args['run-id'] });
  // Console output never includes proposal prose, raw imagery or provider errors.
  process.stdout.write(`${JSON.stringify(result.status === 'dry_run' ? result : {
    version: result.version, completed: result.cases.length, failed: result.failures.length,
    providerCalls: result.cases.length + result.failures.length, spendUsd: null })}\n`);
  return result;
};
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch(() => { console.error('Quantity recording refused or failed; no raw details logged.'); process.exitCode = 1; });
}
