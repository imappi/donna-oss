// Donna — the request shapes of a provider-agnostic structured text lane.
//
// The owner's decision of 2026-11-10: Donna runs on Claude only. Every lane
// whose input is text (transaction coding, ask drafting, memory extraction,
// the owner-command read, document chat, the marketing drafters and the
// reply reader) moved from OpenAI-only to BOTH providers, Anthropic first;
// OpenAI stays a qualified alternative that runs only when no Anthropic key
// is configured (providerEndpoints.js resolveLaneProvider decides which).
//
// WHAT THIS MODULE OWNS, AND WHAT IT DOES NOT. It builds the llmCall
// options for one structured call — URL, headers, body, the section sizes
// and a `parseResponse` that reads the provider's answer into the lane's
// JSON object — and it types a failed call into the providerTransport
// vocabulary. It does NOT make the call: every lane module calls
// the envelope (llmCall) itself (one envelope, and the lane census in
// modelLanes.test.js keeps seeing each call site). It names no host: the
// endpoints are strings in the host registry (providerEndpoints.js). It
// holds no prompt and no judgment: each lane hands over its own
// instructions, input and schema unchanged, and its own sanitizer / Keep
// layer still decides what the answer may do.
//
// THE ANTHROPIC REQUEST (Messages API, built from the current API reference,
// 2026-11-10):
//  - Structured output through `output_config.format` (`json_schema`) with
//    the lane's own schema — valid on claude-opus-5-5 and claude-opus-4-8
//    alike. Forced tool use (`tool_choice: {type:'tool'}`, the older Claude
//    lanes' idiom) is rejected on claude-opus-5-5 and is not used here.
//    Keywords the structured-output grammar does not accept (string length,
//    numeric bounds, array bounds) are left off the WIRE copy only; the
//    parsed answer is validated against the lane's FULL schema
//    (`validateLaneSchema`) before the lane sees it, so nothing the schema
//    says is weakened.
//  - Thinking is adaptive (it cannot be switched off on claude-opus-5-5) and
//    depth is set explicitly per lane through `output_config.effort`. No
//    assistant prefill; no sampling parameters.
//  - `stop_reason` is read BEFORE content: `refusal` and `max_tokens` are
//    typed provider failures (PROVIDER_REFUSED / PROVIDER_OUTPUT_LIMIT) the
//    lane's existing failure path receipts; neither is parsed as an answer.
//  - No server-side fallback to another model is requested: the model that
//    decides is the model the receipt names (taken from the RESPONSE).
//  - The stable part of the prompt (the lane's instructions) is the system
//    block and may be marked for prompt caching (`cacheSystem`); the
//    per-call input follows it as the user turn.
//  - Long requests stream (`stream: true`); llmCall reassembles the events
//    into the one Message the parser reads.

import {
  ANTHROPIC_API_VERSION,
  ANTHROPIC_MESSAGES_URL,
  OPENAI_RESPONSES_URL
} from './providerEndpoints.js';
import {
  classifyProviderStatus,
  classifyProviderThrow,
  providerFetchWithDeadline,
  providerInvalidOutput,
  providerOutputLimit,
  providerRefused
} from './providerTransport.js';
import { validateStrictSchema } from './unifiedExtractorSchema.js';

export const ANTHROPIC_EFFORT_LEVELS = Object.freeze(['low', 'medium', 'high', 'xhigh', 'max']);

// ── schema: the wire copy and the full check ──────────────────────────────
// Constraint keywords the structured-output grammar does not take. They are
// dropped from the copy SENT; the lane's schema object is never mutated.
const WIRE_UNSUPPORTED_KEYWORDS = Object.freeze(new Set([
  'minLength', 'maxLength', 'pattern',
  'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf',
  'minItems', 'maxItems', 'uniqueItems', 'minProperties', 'maxProperties'
]));

// A nullable enum written OpenAI-style — `type: ['string', 'null']` with
// `enum: [..., null]` — is refused by the structured-output grammar
// ("Enum value … does not match declared type", live, 2026-11-10). The wire
// copy states the same set as `anyOf: [{ type, enum: non-null values },
// { type: 'null' }]`; the lane's schema keeps its own spelling.
const nullableEnumAsAnyOf = (schema) => {
  const types = schema.type.filter((type) => type !== 'null');
  const values = schema.enum.filter((value) => value !== null);
  const { type: _type, enum: _enum, ...rest } = schema;
  const branches = [];
  if (values.length) branches.push({ type: types.length === 1 ? types[0] : types, enum: values });
  if (schema.type.includes('null') || schema.enum.includes(null)) branches.push({ type: 'null' });
  return anthropicWireSchema({ ...rest, anyOf: branches });
};

export const anthropicWireSchema = (schema) => {
  if (Array.isArray(schema)) return schema.map((entry) => anthropicWireSchema(entry));
  if (!schema || typeof schema !== 'object') return schema;
  if (Array.isArray(schema.type) && Array.isArray(schema.enum)) return nullableEnumAsAnyOf(schema);
  const out = {};
  for (const [key, value] of Object.entries(schema)) {
    if (WIRE_UNSUPPORTED_KEYWORDS.has(key)) continue;
    if (key === 'properties' && value && typeof value === 'object') {
      out.properties = Object.fromEntries(Object.entries(value).map(([name, child]) => [name, anthropicWireSchema(child)]));
    } else if (key === 'enum' || key === 'required' || key === 'const' || key === 'type') {
      out[key] = value;
    } else {
      out[key] = anthropicWireSchema(value);
    }
  }
  return out;
};

// The grammar also compiles at most 16 union-typed parameters (a `type`
// array or an `anyOf`) per schema ("exponential compilation cost", live,
// 2026-11-10); document chat's action schema has 18 nullable fields. Past
// that limit the wire copy states each nullable property as OPTIONAL and
// non-null instead — absent means null — and the reader puts the nulls back
// (`restoreOmittedNulls`) before the answer is checked against the lane's
// FULL schema, which still requires every key.
export const ANTHROPIC_UNION_PARAMETER_LIMIT = 16;

export const countUnionParameters = (schema) => {
  if (Array.isArray(schema)) return schema.reduce((sum, entry) => sum + countUnionParameters(entry), 0);
  if (!schema || typeof schema !== 'object') return 0;
  let count = (Array.isArray(schema.type) || Array.isArray(schema.anyOf)) ? 1 : 0;
  for (const [key, value] of Object.entries(schema)) {
    if (key === 'properties' && value && typeof value === 'object') count += countUnionParameters(Object.values(value));
    else if (key === 'items' || key === 'anyOf') count += countUnionParameters(value);
  }
  return count;
};

const nullBranch = (branch) => branch?.type === 'null';
const isNullable = (schema) => Boolean(schema && (
  (Array.isArray(schema.type) && schema.type.includes('null'))
  || (Array.isArray(schema.anyOf) && schema.anyOf.some(nullBranch))
));
const withoutNull = (schema) => {
  if (Array.isArray(schema.anyOf)) {
    const branches = schema.anyOf.filter((branch) => !nullBranch(branch));
    const { anyOf: _anyOf, ...rest } = schema;
    return branches.length === 1 ? { ...rest, ...branches[0] } : { ...rest, anyOf: branches };
  }
  const types = schema.type.filter((type) => type !== 'null');
  return {
    ...schema,
    type: types.length === 1 ? types[0] : types,
    ...(Array.isArray(schema.enum) ? { enum: schema.enum.filter((value) => value !== null) } : {})
  };
};

// Converts at most `budget.left` nullable properties (the LAST ones, depth
// first) — only as many as the limit requires: optional properties have a
// compile cost of their own ("Schema is too complex" when all 18 went).
export const nullablePropertiesAsOptional = (schema, budget = { left: Infinity }) => {
  if (Array.isArray(schema)) return schema.map((entry) => nullablePropertiesAsOptional(entry, budget));
  if (!schema || typeof schema !== 'object') return schema;
  const out = { ...schema };
  if (schema.items) out.items = nullablePropertiesAsOptional(schema.items, budget);
  if (Array.isArray(schema.anyOf)) out.anyOf = schema.anyOf.map((branch) => nullablePropertiesAsOptional(branch, budget));
  if (schema.properties && typeof schema.properties === 'object') {
    const optional = new Set();
    const entries = Object.entries(schema.properties).reverse().map(([name, child]) => {
      if (!isNullable(child) || budget.left <= 0) return [name, nullablePropertiesAsOptional(child, budget)];
      budget.left -= 1;
      optional.add(name);
      return [name, nullablePropertiesAsOptional(withoutNull(child), budget)];
    }).reverse();
    out.properties = Object.fromEntries(entries);
    if (Array.isArray(schema.required)) out.required = schema.required.filter((name) => !optional.has(name));
  }
  return out;
};

// The inverse on the parsed answer, by the LANE schema: a required nullable
// property the answer left out is null. Nothing else is filled.
export const restoreOmittedNulls = (schema, value) => {
  if (!schema || typeof schema !== 'object') return value;
  if (Array.isArray(value)) return schema.items ? value.map((item) => restoreOmittedNulls(schema.items, item)) : value;
  if (!value || typeof value !== 'object' || !schema.properties) return value;
  const out = { ...value };
  for (const name of schema.required || []) {
    if (!(name in out) && isNullable(schema.properties[name])) out[name] = null;
  }
  for (const [name, child] of Object.entries(schema.properties)) {
    if (name in out && out[name] !== null) out[name] = restoreOmittedNulls(child, out[name]);
  }
  return out;
};

// The schema the request carries, and whether the reader must put omitted
// nulls back.
export const anthropicRequestSchema = (schema) => {
  const wire = anthropicWireSchema(schema);
  if (countUnionParameters(wire) <= ANTHROPIC_UNION_PARAMETER_LIMIT) return { wire, optionalNulls: false };
  const excess = countUnionParameters(wire) - ANTHROPIC_UNION_PARAMETER_LIMIT;
  return { wire: anthropicWireSchema(nullablePropertiesAsOptional(schema, { left: excess })), optionalNulls: true };
};

// The lane's FULL schema, checked on the parsed answer: structure, types,
// enums, required, additionalProperties (validateStrictSchema, the unified
// extractor's checker) plus the constraints the wire copy left off and the
// unions it kept (anyOf). Returns the list of violations (empty = valid).
export const validateLaneSchema = (schema, value, path = '$', out = []) => {
  if (!schema || typeof schema !== 'object') return out;
  if (Array.isArray(schema.anyOf)) {
    const passing = schema.anyOf.some((branch) => validateLaneSchema(branch, value, path, []).length === 0);
    if (!passing) out.push(`${path}: matches no anyOf branch`);
    return out;
  }
  const before = out.length;
  validateStrictSchema({ ...schema, properties: undefined, items: undefined }, value, path, out);
  if (out.length > before) return out;
  if (typeof value === 'string') {
    if (Number.isFinite(schema.minLength) && value.length < schema.minLength) out.push(`${path}: shorter than ${schema.minLength}`);
    if (Number.isFinite(schema.maxLength) && value.length > schema.maxLength) out.push(`${path}: longer than ${schema.maxLength}`);
  }
  if (typeof value === 'number') {
    if (Number.isFinite(schema.minimum) && value < schema.minimum) out.push(`${path}: below ${schema.minimum}`);
    if (Number.isFinite(schema.maximum) && value > schema.maximum) out.push(`${path}: above ${schema.maximum}`);
  }
  if (Array.isArray(value)) {
    if (Number.isFinite(schema.minItems) && value.length < schema.minItems) out.push(`${path}: fewer than ${schema.minItems} items`);
    if (Number.isFinite(schema.maxItems) && value.length > schema.maxItems) out.push(`${path}: more than ${schema.maxItems} items`);
    if (schema.items) value.forEach((item, index) => validateLaneSchema(schema.items, item, `${path}[${index}]`, out));
  }
  if (value && typeof value === 'object' && !Array.isArray(value) && schema.properties) {
    for (const key of schema.required || []) {
      if (!(key in value)) out.push(`${path}.${key}: required`);
    }
    for (const [key, child] of Object.entries(value)) {
      if (!(key in schema.properties)) {
        if (schema.additionalProperties === false) out.push(`${path}.${key}: not in schema`);
        continue;
      }
      validateLaneSchema(schema.properties[key], child, `${path}.${key}`, out);
    }
  }
  return out;
};

// ── reading an Anthropic answer ───────────────────────────────────────────
const servedModelOf = (payload) => (typeof payload?.model === 'string' && payload.model ? payload.model : null);

export const anthropicAnswerText = (payload) =>
  (Array.isArray(payload?.content) ? payload.content : [])
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('');

// stop_reason first, then the text, then JSON, then the lane's full schema.
// THROWS the typed ProviderFailureError for each way there is no answer.
export const readAnthropicStructured = ({ schema, maxTokens = null, requestedModel = null, optionalNulls = false } = {}) => (payload) => {
  const model = servedModelOf(payload) || requestedModel;
  if (payload?.stop_reason === 'refusal') {
    throw providerRefused('anthropic', { model, category: payload?.stop_details?.category || null });
  }
  if (payload?.stop_reason === 'max_tokens') {
    throw providerOutputLimit('anthropic', { model, maxTokens });
  }
  // Any other way of stopping (`pause_turn` after a long server-tool turn,
  // `tool_use`) leaves no finished answer either; it is named, not parsed.
  if (payload?.stop_reason && !['end_turn', 'stop_sequence'].includes(payload.stop_reason)) {
    throw providerInvalidOutput('anthropic', { detail: `the turn stopped at ${payload.stop_reason}`, model });
  }
  // The answer is the text; a server-tool turn (web search) may carry a
  // short text block before its tool calls, so the LAST text block is read
  // when the joined text is not one JSON value.
  let text = anthropicAnswerText(payload);
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    const blocks = (Array.isArray(payload?.content) ? payload.content : []).filter((block) => block?.type === 'text');
    try {
      text = blocks.length ? blocks[blocks.length - 1].text : '';
      parsed = JSON.parse(text);
    } catch {
      throw providerInvalidOutput('anthropic', { detail: 'the structured answer was not JSON', model });
    }
  }
  if (schema && optionalNulls) parsed = restoreOmittedNulls(schema, parsed);
  if (schema) {
    const violations = validateLaneSchema(schema, parsed);
    if (violations.length) {
      throw providerInvalidOutput('anthropic', {
        detail: `the structured answer broke its schema: ${violations.slice(0, 3).join('; ')}`,
        model
      });
    }
  }
  return {
    parsed,
    text,
    model: servedModelOf(payload),
    response_id: typeof payload?.id === 'string' ? payload.id : '',
    stop_reason: payload?.stop_reason || null,
    usage: payload?.usage || null
  };
};

// ── the Anthropic llmCall options ─────────────────────────────────────────
// `system` is the lane's instructions (stable; first), `user` its per-call
// input (string). `effort` is required: the lane states its depth.
export const anthropicStructuredRequest = ({
  apiKey,
  model,
  system,
  user,
  // A multi-turn lane (document chat) passes its own user/assistant turns;
  // the last one is the user's (no assistant prefill). Otherwise `user` is
  // the one user turn.
  messages = null,
  schema,
  effort,
  maxTokens = 16000,
  cacheSystem = false,
  stream = false,
  execution,
  promptVersion = null,
  sections = null,
  // Server tools the lane's job needs (the dossier drafter's web search);
  // none by default.
  tools = null,
  fetchImpl = fetch,
  timeoutMs = null
} = {}) => {
  if (!ANTHROPIC_EFFORT_LEVELS.includes(effort)) {
    throw new Error(`anthropicStructuredRequest needs an explicit effort (${ANTHROPIC_EFFORT_LEVELS.join('/')}), got "${effort}".`);
  }
  const { wire, optionalNulls } = anthropicRequestSchema(schema);
  const body = {
    model,
    max_tokens: maxTokens,
    system: cacheSystem
      ? [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }]
      : system,
    messages: Array.isArray(messages) && messages.length ? messages : [{ role: 'user', content: user }],
    ...(Array.isArray(tools) && tools.length ? { tools } : {}),
    thinking: { type: 'adaptive' },
    output_config: {
      effort,
      format: { type: 'json_schema', schema: wire }
    },
    ...(stream ? { stream: true } : {})
  };
  return {
    provider: 'anthropic',
    url: ANTHROPIC_MESSAGES_URL,
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': ANTHROPIC_API_VERSION
    },
    body,
    sections: sections || { system, tools: schema, context: messages || user },
    execution,
    promptVersion,
    parseResponse: readAnthropicStructured({ schema, maxTokens, requestedModel: model, optionalNulls }),
    // The socket stays llmCall's; one deadline over headers AND body (a
    // stream is read to its end under it), capped by the worker's budget,
    // with typed throws — the same transport contract as the coder's
    // existing paths.
    fetchImpl: providerFetchWithDeadline({
      provider: 'anthropic',
      fetchImpl: fetchImpl || fetch,
      ...(Number.isFinite(timeoutMs) && timeoutMs > 0 ? { timeoutMs } : {})
    })
  };
};

// ── the OpenAI llmCall options (the Responses API, strict json_schema) ────
// The exact body the bare-fetch lanes sent before they moved onto the
// envelope; `store` is passed through only when the lane sent it.
export const openAiResponsesText = (payload) => {
  if (typeof payload?.output_text === 'string' && payload.output_text) return payload.output_text;
  const chunks = [];
  for (const item of payload?.output || []) {
    for (const part of item?.content || []) {
      if (typeof part?.text === 'string') chunks.push(part.text);
    }
  }
  return chunks.join('');
};

export const openAiStructuredRequest = ({
  apiKey,
  model,
  instructions,
  input,
  schemaName,
  schema,
  store = undefined,
  execution,
  promptVersion = null,
  sections = null,
  fetchImpl = fetch,
  parse = (payload) => JSON.parse(openAiResponsesText(payload))
} = {}) => ({
  provider: 'openai',
  url: OPENAI_RESPONSES_URL,
  headers: {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${apiKey}`
  },
  body: {
    model,
    instructions,
    input,
    ...(store === undefined ? {} : { store }),
    text: { format: { type: 'json_schema', name: schemaName, strict: true, schema } }
  },
  sections: sections || { system: instructions, tools: schema, context: input },
  execution,
  promptVersion,
  parseResponse: (payload) => ({
    parsed: parse(payload),
    model: servedModelOf(payload),
    response_id: typeof payload?.id === 'string' ? payload.id : ''
  }),
  fetchImpl
});

// ── a failed call, typed ──────────────────────────────────────────────────
// llmCall throws (a) a typed ProviderFailureError from parseResponse or the
// deadline transport, (b) LLM_CALL_PROVIDER_ERROR for a non-OK status (with
// the provider's error type/code), or (c) a raw network/abort error. All
// three become the ONE providerTransport vocabulary; anything else (a bug,
// a refused execution ref) returns null so the caller rethrows it.
export const typedLlmCallFailure = (provider, error) => {
  if (error?.providerFailure === true && typeof error.code === 'string') return error;
  if (error?.code === 'LLM_CALL_PROVIDER_ERROR') {
    return classifyProviderStatus({
      provider,
      status: error.status,
      payload: { error: { message: error.message, ...(error.provider_error || {}) } },
      attempts: error.telemetry?.attempt_count || 1
    });
  }
  return classifyProviderThrow({ provider, error });
};
