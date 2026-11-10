// Donna — what the DOCUMENT lanes add on top of the shared structured seam.
//
// The owner's decision of 2026-11-10: Donna runs on Claude only, and an
// installation holding only an Anthropic key must read every document. The
// document lanes (router, statement reader, unified and per-type extractors,
// receipt classifier, parser repair, client intake) resolve Anthropic first
// and keep OpenAI as the alternative that runs only when no Anthropic key is
// configured.
//
// ONE OWNER PER BEHAVIOUR. This module owns only what is particular to a
// lane whose input is a file:
//   - the lane's provider order is the registry's (modelLanes.js), resolved
//     by THE resolver (providerEndpoints.js resolveLaneProvider);
//   - a file becomes a Messages content block (a PDF → a base64 `document`
//     block carrying the file name as its title, an image → a base64 `image`
//     block), placed BEFORE the text;
//   - a lane body written once in the Responses shape is carried over
//     unchanged (instructions → system, parts in order → blocks, the strict
//     schema → the structured answer), so the two providers cannot drift.
// The request itself (structured output or the one answer tool, adaptive
// thinking, explicit effort, no fallbacks, stop_reason read first) is
// structuredRequest.js anthropicStructuredRequest; the stream and the socket
// are the envelope's (llmCall.js). Each lane module calls llmCall itself.

import { getLane } from './modelLanes.js';
import {
  envWithDotEnvFallback,
  LANE_PROVIDER_KEY_ENV,
  resolveLaneProvider
} from './providerEndpoints.js';
import {
  anthropicAnswerText,
  anthropicStructuredRequest,
  readAnthropicStructured,
  schemaDeliveryFor
} from './structuredRequest.js';
import { PROVIDER_FAILURE_CODES } from './providerTransport.js';

// Messages API request limits (32 MB per request; 600 PDF pages on the 1M
// context models). The statement reader splits below these; a lane that
// cannot split lets the provider's 413 name the failure. Nothing is ever
// truncated to fit.
export const ANTHROPIC_MAX_REQUEST_BYTES = 32 * 1024 * 1024;
export const ANTHROPIC_MAX_PDF_PAGES = 600;

// ── which provider, which model ───────────────────────────────────────────
// resolveLaneProvider with the lane's registry order and the module's .env
// fallback. Only the lane's OWN model knobs are passed: no provider-wide knob
// (OPENAI_MODEL), so a host that kept OPENAI_MODEL=gpt-5.4 from its OpenAI
// days and now holds only an Anthropic key still reads its documents on
// Claude.
export const resolveDocumentLaneProvider = ({
  laneId,
  env = process.env,
  dotEnv = {},
  provider = null,
  model = null,
  keys = null,
  providerEnvKey = null,
  modelEnvKeys = [],
  defaultModels = {}
} = {}) => ({
  ...resolveLaneProvider({
    providers: getLane(laneId)?.providers || [],
    defaultModels,
    providerEnvKey,
    modelEnvKeys,
    env: envWithDotEnvFallback(env, dotEnv),
    provider,
    model,
    keys
  }),
  lane: laneId
});

// The provider a no-key result names: the lane's first registry provider,
// so the parse pipeline's wait (inngest/parseErrors.js) names the key this
// installation is meant to hold (ANTHROPIC_API_KEY), never a provider it
// never meant to use.
export const missingProviderFor = (resolved, laneId) =>
  resolved?.provider || getLane(laneId)?.providers?.[0] || null;

export const missingKeyNameFor = (resolved, laneId) =>
  LANE_PROVIDER_KEY_ENV[missingProviderFor(resolved, laneId)] || null;

// A lane's no-key failure in #71's vocabulary: `<provider>_not_configured`
// for the provider whose key is missing (inngest/parseErrors.js
// providerWaitFor reads the provider from the prefix and names its key).
export const notConfiguredFailure = (resolved, laneId) => {
  const provider = missingProviderFor(resolved, laneId);
  const reason = !resolved?.reason || String(resolved.reason).startsWith('no_provider_key')
    ? `${provider}_not_configured`
    : resolved.reason;
  return { provider, reason };
};

// ── a file as a content block ─────────────────────────────────────────────
const looksLikePdfBase64 = (base64) => String(base64 || '').startsWith('JVBERi');
const IMAGE_TYPES = Object.freeze(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

// The bytes outrank upload metadata (an empty / octet-stream mime on a good
// PDF once sent it as an image). The file name rides as the document title:
// the OpenAI input_file part carries it, so the model reads the same input
// on either provider.
export const anthropicFileBlock = ({ base64, mimeType = '', filename = '' } = {}) => {
  const data = String(base64 || '').replace(/[\r\n\s]/g, '');
  const mt = String(mimeType || '').toLowerCase();
  const isPdf = mt === 'application/pdf' || mt === 'application/x-pdf' || looksLikePdfBase64(data)
    || /\.pdf$/i.test(String(filename || '').trim());
  const title = String(filename || '').trim();
  if (isPdf) {
    return { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data }, ...(title ? { title: title.slice(0, 500) } : {}) };
  }
  const imageType = mt === 'image/jpg' ? 'image/jpeg' : mt;
  return { type: 'image', source: { type: 'base64', media_type: IMAGE_TYPES.includes(imageType) ? imageType : 'image/png', data } };
};

// ── a Responses body, carried over ────────────────────────────────────────
const parseDataUrl = (dataUrl = '') => {
  const str = String(dataUrl || '');
  const comma = str.indexOf(',');
  if (!str.startsWith('data:') || comma === -1) return { mime: '', payload: '' };
  return { mime: str.slice(5, comma).split(';')[0].trim().toLowerCase(), payload: str.slice(comma + 1) };
};

// instructions → system; each user part, in the lane's order → a block.
export const anthropicContentFromResponses = ({ instructions = null, input = [] } = {}) => {
  const content = [];
  for (const turn of Array.isArray(input) ? input : []) {
    if (turn?.role && turn.role !== 'user') continue;
    for (const part of Array.isArray(turn?.content) ? turn.content : []) {
      if (part?.type === 'input_file') {
        const { mime, payload } = parseDataUrl(part.file_data);
        content.push(anthropicFileBlock({ base64: payload, mimeType: mime, filename: part.filename }));
      } else if (part?.type === 'input_image') {
        const { mime, payload } = parseDataUrl(part.image_url);
        content.push(anthropicFileBlock({ base64: payload, mimeType: mime }));
      } else if (part?.type === 'input_text' && typeof part.text === 'string' && part.text) {
        content.push({ type: 'text', text: part.text });
      }
    }
  }
  return { system: typeof instructions === 'string' && instructions ? instructions : null, content };
};

// ── the llmCall options for one document-lane call ────────────────────────
const withSignal = (fetchImpl, signal) => {
  const base = fetchImpl || ((...args) => globalThis.fetch(...args));
  if (!signal) return base;
  return (url, init) => base(url, { ...init, signal: init?.signal ? AbortSignal.any([init.signal, signal]) : signal });
};

const servedModelOf = (payload) => (typeof payload?.model === 'string' && payload.model ? payload.model : null);

// Plain text (the statement reader's transcription entry has no schema):
// a turn that did not finish is the shared reader's named failure; a
// finished one is its text.
const readAnthropicText = ({ maxTokens, requestedModel }) => (payload) => {
  if (!['end_turn', 'stop_sequence'].includes(payload?.stop_reason)) {
    readAnthropicStructured({ schema: null, maxTokens, requestedModel })(payload);
  }
  return {
    parsed: null,
    text: anthropicAnswerText(payload),
    model: servedModelOf(payload),
    response_id: typeof payload?.id === 'string' ? payload.id : '',
    stop_reason: payload?.stop_reason || null,
    usage: payload?.usage || null,
    delivery: 'text'
  };
};

// `content` is the one user turn (file blocks first). `validate: false` is
// for the unified extractor alone, which holds its own reply to its schema
// on both providers (and keeps the partial header of a violating one); the
// stop_reason checks and the tool-call requirement still apply.
export const documentLaneAnthropicRequest = ({
  apiKey,
  model,
  system = null,
  content,
  schema = null,
  effort,
  maxTokens,
  execution,
  promptVersion = null,
  sections = null,
  signal = null,
  timeoutMs = null,
  fetchImpl = null,
  validate = true
} = {}) => {
  const turn = [{ role: 'user', content }];
  const options = anthropicStructuredRequest({
    apiKey,
    model,
    system: system || undefined,
    messages: turn,
    // The text of the turn rides inside `content`; `user` only names the
    // context section for the envelope's accounting.
    user: '',
    schema: schema || { type: 'object' },
    effort,
    maxTokens,
    // Long document reads stream; the envelope reassembles the Message.
    stream: true,
    execution,
    promptVersion,
    sections: sections || { system: system || undefined, tools: schema || undefined },
    fetchImpl: withSignal(fetchImpl, signal),
    timeoutMs
  });
  if (!options.body.system) delete options.body.system;
  let read = options.parseResponse;
  if (!schema) {
    delete options.body.output_config.format;
    read = readAnthropicText({ maxTokens, requestedModel: model });
  } else if (!validate) {
    read = readAnthropicStructured({ schema: null, maxTokens, requestedModel: model, delivery: schemaDeliveryFor(schema).delivery });
  }
  return {
    ...options,
    parseResponse: (payload) => {
      try {
        return read(payload);
      } catch (error) {
        // The receipt's model is the response's, on a failure too.
        if (error?.providerFailure === true && !error.servedModel) error.servedModel = servedModelOf(payload);
        throw error;
      }
    }
  };
};

export const documentLaneRequestFromResponses = ({ body, ...rest } = {}) => {
  const { system, content } = anthropicContentFromResponses(body);
  return documentLaneAnthropicRequest({
    ...rest,
    model: rest.model || body?.model,
    system,
    content,
    schema: body?.text?.format?.schema || null
  });
};

// ── one reply, either provider ────────────────────────────────────────────
// The provider's named answers that are not a usable reply: final for the
// same request, receipted with the model that gave them.
const STOP_FAILURE_CODES = Object.freeze([
  PROVIDER_FAILURE_CODES.REFUSED,
  PROVIDER_FAILURE_CODES.OUTPUT_LIMIT,
  PROVIDER_FAILURE_CODES.INVALID_OUTPUT
]);
export const isProviderStopFailure = (error) => error?.providerFailure === true && STOP_FAILURE_CODES.includes(error.code);

// The extractors' reason for one: the shared code, in their lowercase
// vocabulary (provider_refused / provider_output_limit /
// provider_invalid_output).
export const stopFailureReason = (error) => String(error?.code || 'provider_invalid_output').toLowerCase();

const SPEND_LIMIT_CODES = Object.freeze(['trial_spend_cap_refused', PROVIDER_FAILURE_CODES.SPEND_LIMIT]);

// Reads a reply from whichever provider the lane resolved and hands back ONE
// outcome shape for the lane to map onto its own failure vocabulary:
//   { ok: true, text, servedModel }
//   { ok: false, kind: 'threw', error }                     transport / timeout
//   { ok: false, kind: 'status', status, providerError }    provider non-OK status
//   { ok: false, kind: 'bad_json' }                         OpenAI body unreadable
//   { ok: false, kind: 'stop', error }                      refusal / output limit / invalid answer
// `callOpenAi` returns the lane's response-shaped seam value (asProviderResponse);
// `callAnthropic` returns an llmCall result ({ result }). A spend-limit
// refusal propagates (it is the operator's, not the document's).
export const readDocumentLaneReply = async ({ provider, callOpenAi, callAnthropic, outputText }) => {
  if (provider === 'anthropic') {
    try {
      const { result } = await callAnthropic();
      const text = typeof result?.text === 'string' && result.text ? result.text : JSON.stringify(result?.parsed ?? null);
      return { ok: true, text, parsed: result?.parsed ?? null, servedModel: result?.model || null };
    } catch (error) {
      if (SPEND_LIMIT_CODES.includes(error?.code)) throw error;
      if (isProviderStopFailure(error)) return { ok: false, kind: 'stop', error };
      if (error?.code === 'LLM_CALL_PROVIDER_ERROR') {
        return { ok: false, kind: 'status', status: Number(error.status || 0), providerError: error.providerError || null, error };
      }
      return { ok: false, kind: 'threw', error };
    }
  }
  let response;
  try {
    response = await callOpenAi();
  } catch (error) {
    if (SPEND_LIMIT_CODES.includes(error?.code)) throw error;
    return { ok: false, kind: 'threw', error };
  }
  if (!response?.ok) {
    let providerError = null;
    try {
      const body = await response?.json?.();
      providerError = body?.error && typeof body.error === 'object' ? body.error : null;
    } catch { /* the status decides */ }
    return { ok: false, kind: 'status', status: Number(response?.status || 0), providerError };
  }
  let payload;
  try {
    payload = await response.json();
  } catch {
    return { ok: false, kind: 'bad_json' };
  }
  return {
    ok: true,
    text: outputText(payload),
    servedModel: typeof payload?.model === 'string' && payload.model ? payload.model : null
  };
};

// A thrown transport error's reason in the extractors' vocabulary.
export const thrownReason = (error) =>
  (error?.name === 'AbortError' || error?.code === PROVIDER_FAILURE_CODES.TIMEOUT ? 'timeout' : 'network_error');
