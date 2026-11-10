// Donna — the Anthropic Messages request for a structured lane.
//
// ONE builder for every lane that asks Claude for a JSON object against the
// lane's own schema (the document lanes moved 2026-11-10 by the owner's
// decision that Donna runs on Claude; the text lanes follow the same path).
// It owns the request SHAPE only; the transport, retries, telemetry and the
// response-model rule are the envelope's (llmCall.js) — no second socket.
//
// The request, per the current Messages API:
//   - model: the lane's resolved id (laneProviderResolver.js);
//   - files ride as content blocks BEFORE the text: a PDF as a base64
//     `document` block, an image as a base64 `image` block. Inline base64,
//     not the Files API: every lane sends a document once, in one request,
//     so an upload would add a round trip and a stored copy for no reuse;
//   - structured output through `output_config.format` (json_schema). Forced
//     tool use (`tool_choice: {type:'tool'}`) is rejected on claude-opus-5-5
//     and structured outputs are valid on every current model. The schema
//     sent is the lane's own minus the keywords structured outputs refuse
//     (numeric / string-length bounds); the CALLER still validates the
//     parsed result against its full schema exactly as before;
//   - thinking is adaptive (it cannot be switched off on claude-opus-5-5)
//     and depth is set per lane with `output_config.effort`;
//   - streamed, so a long extraction never sits silent until an idle
//     timeout; the envelope reassembles the stream into one Message;
//   - NO server-side `fallbacks`: the deciding model must be the one on the
//     lane's receipt, so a refusal is a named failure, not a silent re-run
//     on another model.
//
// stop_reason is checked BEFORE content is read. `refusal` and `max_tokens`
// are typed provider failures (ANTHROPIC_REFUSAL / ANTHROPIC_MAX_TOKENS)
// carrying the served model and the envelope telemetry, so every lane's
// existing failure path receipts them.

// llmCall is loaded at call time: its cloud-evidence writer reaches the firm
// database layer, whose parse writer imports the extractors that import this
// module — a static import here closes that cycle at load.
const loadEnvelope = () => import('./llmCall.js');
import { validateStrictSchema } from './unifiedExtractorSchema.js';

export const ANTHROPIC_MESSAGES_URL = 'https://api.anthropic.com/v1/messages';
export const ANTHROPIC_API_VERSION = '2026-10-21';

// Request limits on the Messages API (32 MB request; 600 PDF pages on 1M
// context models). Callers that can split (the statement reader) split
// below these; callers that cannot let the provider's 413 name the failure
// — never a silent truncation.
export const ANTHROPIC_MAX_REQUEST_BYTES = 32 * 1024 * 1024;
export const ANTHROPIC_MAX_PDF_PAGES = 600;

export const ANTHROPIC_EFFORTS = Object.freeze(['low', 'medium', 'high', 'xhigh', 'max']);

const looksLikePdfBase64 = (base64) => String(base64 || '').startsWith('JVBERi');
const IMAGE_TYPES = Object.freeze(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

// A file → its content block. The bytes outrank upload metadata (an empty /
// octet-stream mime on a perfectly good PDF once sent it as an image).
export const anthropicFileBlock = ({ base64, mimeType = '', filename = '' } = {}) => {
  const data = String(base64 || '').replace(/[\r\n\s]/g, '');
  const mt = String(mimeType || '').toLowerCase();
  const isPdf = mt === 'application/pdf' || mt === 'application/x-pdf' || looksLikePdfBase64(data)
    || /\.pdf$/i.test(String(filename || '').trim());
  if (isPdf) return { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data } };
  const imageType = mt === 'image/jpg' ? 'image/jpeg' : mt;
  return { type: 'image', source: { type: 'base64', media_type: IMAGE_TYPES.includes(imageType) ? imageType : 'image/png', data } };
};

// Structured outputs refuse these keywords. Removing them from the copy we
// SEND never weakens a check: the caller validates against its full schema.
const UNSUPPORTED_SCHEMA_KEYWORDS = new Set([
  'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf',
  'minLength', 'maxLength', 'pattern', 'minItems', 'maxItems', 'uniqueItems',
  'minProperties', 'maxProperties'
]);

export const toStructuredOutputSchema = (schema) => {
  if (Array.isArray(schema)) return schema.map(toStructuredOutputSchema);
  if (!schema || typeof schema !== 'object') return schema;
  const out = {};
  for (const [key, value] of Object.entries(schema)) {
    if (UNSUPPORTED_SCHEMA_KEYWORDS.has(key)) continue;
    if (key === 'type' && Array.isArray(value)) {
      // `type: ['string','null']` → the anyOf form structured outputs take.
      return toStructuredOutputSchema({
        ...Object.fromEntries(Object.entries(schema).filter(([k]) => k !== 'type')),
        anyOf: value.map((t) => ({ type: t }))
      });
    }
    out[key] = (key === 'properties' || key === '$defs' || key === 'definitions')
      ? Object.fromEntries(Object.entries(value || {}).map(([name, sub]) => [name, toStructuredOutputSchema(sub)]))
      : toStructuredOutputSchema(value);
  }
  return out;
};

// ── How the schema rides the request ───────────────────────────────────────
// Structured outputs compile the schema into a grammar and refuse a schema
// past the documented complexity limits (per request: 16 parameters with
// union types — anyOf or type arrays, which is every nullable field — and 24
// optional parameters). Several lanes' schemas carry more nullable fields
// than that (the unified extractor 63, the payout extractor 22). Those
// schemas are NOT trimmed to fit (a lane's schema is carried over as it is):
// the schema goes, whole, as the input schema of one non-strict tool with
// tool_choice auto (forced tool choice is rejected on claude-opus-5-5), and
// the reply is held to the full schema here before any lane reads it. A
// reply that calls no tool is a named failure, never read from prose.
export const STRUCTURED_OUTPUT_LIMITS = Object.freeze({ unionParameters: 16, optionalParameters: 24 });
export const STRUCTURED_REPLY_TOOL = 'record_structured_result';

export const structuredOutputComplexity = (schema) => {
  let unionParameters = 0;
  let optionalParameters = 0;
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (node.properties && typeof node.properties === 'object') {
      for (const [name, child] of Object.entries(node.properties)) {
        if (child && (Array.isArray(child.anyOf) || Array.isArray(child.type))) unionParameters += 1;
        if (!(Array.isArray(node.required) && node.required.includes(name))) optionalParameters += 1;
      }
    }
    if (node.items && (Array.isArray(node.items.anyOf) || Array.isArray(node.items.type))) unionParameters += 1;
    for (const value of Object.values(node)) walk(value);
  };
  walk(schema);
  return { unionParameters, optionalParameters };
};

export const schemaDeliveryFor = (schema) => {
  if (!schema) return 'none';
  const { unionParameters, optionalParameters } = structuredOutputComplexity(toStructuredOutputSchema(schema));
  return unionParameters <= STRUCTURED_OUTPUT_LIMITS.unionParameters && optionalParameters <= STRUCTURED_OUTPUT_LIMITS.optionalParameters
    ? 'output_format'
    : 'tool';
};

export const buildAnthropicStructuredBody = ({
  model,
  system = null,
  content,
  schema,
  effort,
  maxTokens
} = {}) => {
  if (!ANTHROPIC_EFFORTS.includes(effort)) {
    throw Object.assign(new Error(`anthropicMessages: effort must be one of ${ANTHROPIC_EFFORTS.join('/')}`), { code: 'ANTHROPIC_BAD_EFFORT' });
  }
  const delivery = schemaDeliveryFor(schema);
  const body = {
    model,
    max_tokens: maxTokens,
    stream: true,
    thinking: { type: 'adaptive' },
    // A lane that asks for plain text (the statement reader's transcription
    // entry) passes no schema; every structured lane passes its own.
    output_config: delivery === 'output_format'
      ? { effort, format: { type: 'json_schema', schema: toStructuredOutputSchema(schema) } }
      : { effort },
    messages: [{ role: 'user', content }]
  };
  if (delivery === 'tool') {
    body.tools = [{
      name: STRUCTURED_REPLY_TOOL,
      description: 'Record the result of this request. The input is the complete result and must follow this schema exactly.',
      input_schema: schema,
      // Streamed as it is generated; this module validates the input.
      eager_input_streaming: true
    }];
    body.tool_choice = { type: 'auto' };
  }
  if (system) body.system = system;
  return body;
};

const textOf = (payload) => (Array.isArray(payload?.content) ? payload.content : [])
  .filter((block) => block?.type === 'text' && typeof block.text === 'string')
  .map((block) => block.text)
  .join('');

const servedModelOf = (payload) => (typeof payload?.model === 'string' && payload.model ? payload.model : null);

// stop_reason first. Returns the parsed reply or throws the typed failure.
// With `schema` (tool delivery), the reply is the tool input, held to the
// lane's full schema: a missing call or a violation is a typed failure.
export const readStructuredReply = (payload, { delivery = 'output_format', schema = null, validate = true } = {}) => {
  const servedModel = servedModelOf(payload);
  const stopReason = payload?.stop_reason || null;
  if (stopReason === 'refusal') {
    throw Object.assign(new Error('Anthropic declined the request (stop_reason refusal).'), {
      code: 'ANTHROPIC_REFUSAL', reason: 'provider_refusal', servedModel, stopReason,
      refusalCategory: payload?.stop_details?.category ?? null
    });
  }
  if (stopReason === 'max_tokens') {
    throw Object.assign(new Error('Anthropic reply reached max_tokens before the structured output was complete.'), {
      code: 'ANTHROPIC_MAX_TOKENS', reason: 'provider_max_tokens', servedModel, stopReason
    });
  }
  if (delivery !== 'tool') return { text: textOf(payload), servedModel, stopReason };
  const call = (Array.isArray(payload?.content) ? payload.content : [])
    .find((block) => block?.type === 'tool_use' && block.name === STRUCTURED_REPLY_TOOL);
  if (!call || !call.input || typeof call.input !== 'object') {
    throw Object.assign(new Error('Anthropic reply carried no structured result (no tool call).'), {
      code: 'ANTHROPIC_NO_STRUCTURED_REPLY', reason: 'provider_no_structured_reply', servedModel, stopReason
    });
  }
  if (validate) {
    const violations = validateStrictSchema(schema, call.input);
    if (violations.length) {
      throw Object.assign(new Error('Anthropic structured result violates the lane schema.'), {
        code: 'ANTHROPIC_SCHEMA_VIOLATION', reason: 'provider_schema_violation', servedModel, stopReason,
        violations: violations.slice(0, 12)
      });
    }
  }
  return { text: JSON.stringify(call.input), servedModel, stopReason };
};

// The provider's own named answers that are not a usable reply: final for
// the same request, receipted with the model that gave them.
export const isAnthropicStopFailure = (error) =>
  ['ANTHROPIC_REFUSAL', 'ANTHROPIC_MAX_TOKENS', 'ANTHROPIC_NO_STRUCTURED_REPLY', 'ANTHROPIC_SCHEMA_VIOLATION'].includes(error?.code);

// One call through the envelope (structured when `schema` is given). Returns { text, servedModel,
// stopReason, telemetry }; throws LLM_CALL_PROVIDER_ERROR (with status),
// a transport error, or a typed stop failure (with telemetry attached).
export const callAnthropicMessages = async ({
  apiKey,
  model,
  system = null,
  content,
  schema,
  effort,
  maxTokens,
  execution,
  promptVersion = null,
  sections = {},
  fetchImpl = undefined,
  signal = null,
  // The unified extractor validates its own reply (and keeps the partial
  // header of a violating one); every other lane is validated here.
  validate = true
} = {}) => {
  const base = fetchImpl || ((...args) => globalThis.fetch(...args));
  const delivery = schemaDeliveryFor(schema);
  const fetcher = signal
    ? (url, init) => base(url, { ...init, signal: init?.signal ? AbortSignal.any([init.signal, signal]) : signal })
    : base;
  const { llmCall } = await loadEnvelope();
  const { result, telemetry } = await llmCall({
    provider: 'anthropic',
    url: ANTHROPIC_MESSAGES_URL,
    headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': ANTHROPIC_API_VERSION },
    body: buildAnthropicStructuredBody({ model, system, content, schema, effort, maxTokens }),
    stream: 'anthropic_sse',
    sections,
    execution,
    promptVersion,
    parseResponse: (payload) => readStructuredReply(payload, { delivery, schema, validate }),
    fetchImpl: fetcher
  });
  return { ...result, delivery, telemetry };
};

// ── One reply, either provider ──────────────────────────────────────────────
// The document lanes' modules each own their failure vocabulary; this reads
// a reply from whichever provider the lane resolved and hands back ONE
// outcome shape for them to map, so the provider branch is not re-written
// per module:
//   { ok: true, text, servedModel }
//   { ok: false, kind: 'threw', error }          transport / timeout
//   { ok: false, kind: 'status', status }        provider non-OK status
//   { ok: false, kind: 'bad_json' }              OpenAI body unreadable
//   { ok: false, kind: 'stop', error }           Anthropic refusal / max_tokens
// `callOpenAi` returns the lane's response-shaped seam value; `callAnthropic`
// is a callAnthropicMessages call. Spend-limit refusals propagate (they are
// the operator's, not the document's).
export const readProviderReply = async ({ provider, callOpenAi, callAnthropic, outputText }) => {
  if (provider === 'anthropic') {
    try {
      const { text, servedModel } = await callAnthropic();
      return { ok: true, text, servedModel };
    } catch (error) {
      if (['trial_spend_cap_refused', 'PROVIDER_SPEND_LIMIT'].includes(error?.code)) throw error;
      if (isAnthropicStopFailure(error)) return { ok: false, kind: 'stop', error };
      if (error?.code === 'LLM_CALL_PROVIDER_ERROR') return { ok: false, kind: 'status', status: Number(error.status || 0), error };
      return { ok: false, kind: 'threw', error };
    }
  }
  let response;
  try {
    response = await callOpenAi();
  } catch (error) {
    if (['trial_spend_cap_refused', 'PROVIDER_SPEND_LIMIT'].includes(error?.code)) throw error;
    return { ok: false, kind: 'threw', error };
  }
  if (!response?.ok) return { ok: false, kind: 'status', status: Number(response?.status || 0) };
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
  (error?.name === 'AbortError' || error?.code === 'PROVIDER_TIMEOUT' ? 'timeout' : 'network_error');

// ── The same request, carried over from a lane's Responses body ─────────────
// The document lanes were written against the OpenAI Responses shape:
// `instructions` + user `input` parts (input_file / input_image carrying a
// data URL, input_text) + `text.format.schema`. Rather than re-type each
// lane's prompt for a second provider (and let the two drift), the lane
// builds its body ONCE and this carries it over unchanged: instructions →
// `system`; each part, in order → a document / image / text block; the
// strict schema → structured output. Only user turns are carried (these
// lanes send exactly one).
const parseDataUrl = (dataUrl = '') => {
  const str = String(dataUrl || '');
  const comma = str.indexOf(',');
  if (!str.startsWith('data:') || comma === -1) return { mime: '', payload: '' };
  return { mime: str.slice(5, comma).split(';')[0].trim().toLowerCase(), payload: str.slice(comma + 1) };
};

export const anthropicRequestFromResponses = ({ instructions = null, input = [] } = {}) => {
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
      } else if (part?.type === 'input_text' && typeof part.text === 'string') {
        content.push({ type: 'text', text: part.text });
      }
    }
  }
  return { system: typeof instructions === 'string' && instructions ? instructions : null, content };
};

export const callAnthropicFromResponsesBody = ({
  apiKey,
  body,
  effort,
  maxTokens,
  execution,
  promptVersion = null,
  signal = null,
  fetchImpl = undefined
} = {}) => {
  const { system, content } = anthropicRequestFromResponses(body);
  const schema = body?.text?.format?.schema || null;
  return callAnthropicMessages({
    apiKey,
    model: body?.model,
    system,
    content,
    schema,
    effort,
    maxTokens,
    execution,
    promptVersion,
    sections: { system: system || undefined, tools: schema || undefined },
    signal,
    fetchImpl
  });
};
