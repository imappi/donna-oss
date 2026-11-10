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
//    numeric bounds, array bounds) are left off the WIRE copy only and are
//    checked on the parsed answer (`validateDroppedConstraints`); the rest of
//    the schema the grammar holds, as strict mode does on OpenAI. Over the
//    grammar's limits the answer comes as one non-strict tool call and is
//    checked against the lane's FULL schema (`validateLaneSchema`). Nothing
//    the schema says is weakened.
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
//  - The lane's wall (`timeoutMs`, one attempt: headers AND body) is ONE
//    deadline transport per call. Inside a worker llmCall wraps the fetch in
//    the deadline transport and needs the wall handed to it (top-level
//    `timeoutMs`), still capped by the job's remaining budget; outside a
//    worker llmCall does not wrap, so the builder's own transport applies the
//    wall. Before this, the builder's wall sat only on an inner wrapper and,
//    inside a worker, llmCall's outer one cut every call at the 90 s default.

import {
  ANTHROPIC_API_VERSION,
  ANTHROPIC_MESSAGES_URL,
  OPENAI_RESPONSES_URL,
  shapeOpenAiCompatibleRequest
} from './providerEndpoints.js';
import { extractJson } from './extractJson.js';
import {
  classifyProviderStatus,
  classifyProviderThrow,
  providerFetchWithDeadline,
  providerInvalidOutput,
  providerOutputLimit,
  providerRefused
} from './providerTransport.js';
import { currentExecutionBudget } from './executionBudget.js';
import { validateStrictSchema } from './unifiedExtractorSchema.js';
import { PROVIDER_FAULTS, providerFaultOfResponse } from './inngest/parseErrors.js';

export const ANTHROPIC_EFFORT_LEVELS = Object.freeze(['low', 'medium', 'high', 'xhigh', 'max']);

// ── the lane's wall: one deadline transport per call ──────────────────────
const laneWall = (timeoutMs) => (Number.isFinite(timeoutMs) && timeoutMs > 0 ? { timeoutMs } : {});

// The fetch a builder hands llmCall. Decided per attempt, in the same async
// context llmCall reads the budget from: inside a worker the bare fetch (llmCall
// adds the one deadline transport, with the wall); outside, the deadline
// transport with the wall (the transport default when the lane names none).
// `bareOutsideWorker` keeps a lane that had no deadline outside a worker
// (the OpenAI bare-fetch lanes, when they name no wall) exactly as it was.
export const laneDeadlineFetch = ({ provider, fetchImpl = fetch, timeoutMs = null, bareOutsideWorker = false } = {}) => {
  const base = fetchImpl || fetch;
  if (bareOutsideWorker && !laneWall(timeoutMs).timeoutMs) return base;
  const outsideWorker = providerFetchWithDeadline({ provider, fetchImpl: base, ...laneWall(timeoutMs) });
  return (url, init) => (currentExecutionBudget() ? base(url, init) : outsideWorker(url, init));
};

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

// ── the one delivery rule (shared by every lane on this seam) ─────────────
// The structured-output grammar compiles a schema only within two limits,
// both measured on live calls on 2026-11-10: at most 16 union-typed
// parameters (a `type` array or an `anyOf`; document chat has 18, the
// unified extractor 63) and at most 24 optional properties ("Schema is too
// complex" past that). Within them a lane's answer is constrained by
// `output_config.format`. Over either, the lane's WHOLE, unchanged schema is
// the `input_schema` of ONE non-strict tool offered with `tool_choice:
// {type: 'auto'}` (forced tool choice is rejected on claude-opus-5-5); the
// answer is that tool call's input, validated against the lane's full
// schema exactly like the format answer. No tool call, or an input that
// breaks the schema, is a named failure; prose is never read as the answer.
export const STRUCTURED_OUTPUT_LIMITS = Object.freeze({ unionParameters: 16, optionalProperties: 24 });
export const STRUCTURED_ANSWER_TOOL_NAME = 'structured_answer';

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

export const countOptionalProperties = (schema) => {
  if (Array.isArray(schema)) return schema.reduce((sum, entry) => sum + countOptionalProperties(entry), 0);
  if (!schema || typeof schema !== 'object') return 0;
  let count = 0;
  if (schema.properties && typeof schema.properties === 'object') {
    const required = new Set(schema.required || []);
    count += Object.keys(schema.properties).filter((name) => !required.has(name)).length;
    count += countOptionalProperties(Object.values(schema.properties));
  }
  if (schema.items) count += countOptionalProperties(schema.items);
  if (Array.isArray(schema.anyOf)) count += countOptionalProperties(schema.anyOf);
  return count;
};

// Measured on the WIRE copy (what the grammar would compile).
export const structuredOutputComplexity = (schema) => {
  const wire = anthropicWireSchema(schema);
  return { unionParameters: countUnionParameters(wire), optionalProperties: countOptionalProperties(wire) };
};

// 'output_format' within the limits, 'tool' over either.
export const schemaDeliveryFor = (schema) => {
  const complexity = structuredOutputComplexity(schema);
  const over = complexity.unionParameters > STRUCTURED_OUTPUT_LIMITS.unionParameters
    || complexity.optionalProperties > STRUCTURED_OUTPUT_LIMITS.optionalProperties;
  return { delivery: over ? 'tool' : 'output_format', ...complexity };
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

// On the `output_config.format` path the API's grammar already holds the
// answer to the wire schema — structure, types, enums, required keys,
// additionalProperties — exactly as OpenAI strict mode does on the OpenAI
// path, and the lane's sanitizer reads the result as it always has. What the
// grammar did NOT hold is what the wire copy left off (string lengths,
// numeric and array bounds, patterns): those are checked here, wherever the
// answer carries a value they constrain.
export const validateDroppedConstraints = (schema, value, path = '$', out = []) => {
  if (!schema || typeof schema !== 'object' || value === null || value === undefined) return out;
  if (Array.isArray(schema.anyOf)) {
    const fits = schema.anyOf.filter((branch) => validateLaneSchema(branch, value, path, []).length === 0);
    if (fits.length) return out;
    for (const branch of schema.anyOf) validateDroppedConstraints(branch, value, path, out);
    return out;
  }
  if (typeof value === 'string') {
    if (Number.isFinite(schema.minLength) && value.length < schema.minLength) out.push(`${path}: shorter than ${schema.minLength}`);
    if (Number.isFinite(schema.maxLength) && value.length > schema.maxLength) out.push(`${path}: longer than ${schema.maxLength}`);
    if (typeof schema.pattern === 'string') {
      try { if (!new RegExp(schema.pattern, 'u').test(value)) out.push(`${path}: does not match its pattern`); } catch { /* an unusable pattern constrains nothing */ }
    }
  }
  if (typeof value === 'number') {
    if (Number.isFinite(schema.minimum) && value < schema.minimum) out.push(`${path}: below ${schema.minimum}`);
    if (Number.isFinite(schema.maximum) && value > schema.maximum) out.push(`${path}: above ${schema.maximum}`);
  }
  if (Array.isArray(value)) {
    if (Number.isFinite(schema.minItems) && value.length < schema.minItems) out.push(`${path}: fewer than ${schema.minItems} items`);
    if (Number.isFinite(schema.maxItems) && value.length > schema.maxItems) out.push(`${path}: more than ${schema.maxItems} items`);
    if (schema.items) value.forEach((item, index) => validateDroppedConstraints(schema.items, item, `${path}[${index}]`, out));
  } else if (typeof value === 'object' && schema.properties) {
    for (const [key, child] of Object.entries(value)) {
      if (schema.properties[key]) validateDroppedConstraints(schema.properties[key], child, `${path}.${key}`, out);
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
export const readAnthropicStructured = ({ schema, maxTokens = null, requestedModel = null, delivery = 'output_format' } = {}) => (payload) => {
  const model = servedModelOf(payload) || requestedModel;
  if (payload?.stop_reason === 'refusal') {
    throw providerRefused('anthropic', { model, category: payload?.stop_details?.category || null });
  }
  if (payload?.stop_reason === 'max_tokens') {
    throw providerOutputLimit('anthropic', { model, maxTokens });
  }
  // Any other way of stopping (`pause_turn` after a long server-tool turn;
  // `tool_use` unless the answer IS the tool call) leaves no finished
  // answer; it is named, not parsed.
  const finished = delivery === 'tool' ? ['end_turn', 'stop_sequence', 'tool_use'] : ['end_turn', 'stop_sequence'];
  if (payload?.stop_reason && !finished.includes(payload.stop_reason)) {
    throw providerInvalidOutput('anthropic', { detail: `the turn stopped at ${payload.stop_reason}`, model });
  }
  if (delivery === 'tool') {
    const call = (Array.isArray(payload?.content) ? payload.content : [])
      .filter((block) => block?.type === 'tool_use' && block.name === STRUCTURED_ANSWER_TOOL_NAME);
    if (call.length !== 1 || !call[0].input || typeof call[0].input !== 'object') {
      throw providerInvalidOutput('anthropic', {
        detail: call.length ? 'the structured answer was called more than once or without input' : 'the answer was not given as the structured tool call',
        model
      });
    }
    const violations = validateLaneSchema(schema, call[0].input);
    if (violations.length) {
      throw providerInvalidOutput('anthropic', {
        detail: `the structured answer broke its schema: ${violations.slice(0, 3).join('; ')}`,
        model
      });
    }
    return {
      parsed: call[0].input,
      text: '',
      model: servedModelOf(payload),
      response_id: typeof payload?.id === 'string' ? payload.id : '',
      stop_reason: payload?.stop_reason || null,
      usage: payload?.usage || null,
      delivery
    };
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
  if (schema) {
    const violations = validateDroppedConstraints(schema, parsed);
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
    usage: payload?.usage || null,
    delivery
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
  // Document / image content blocks for the one user turn, placed BEFORE the
  // text (the document lanes); the user text follows them.
  content = null,
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
  const { delivery } = schemaDeliveryFor(schema);
  const laneTools = Array.isArray(tools) && tools.length ? tools : [];
  const answerTool = delivery === 'tool'
    ? [{
      name: STRUCTURED_ANSWER_TOOL_NAME,
      description: 'Give your answer by calling this tool once; its input is the answer.',
      input_schema: schema
    }]
    : [];
  const userTurn = Array.isArray(content) && content.length
    ? [...content, { type: 'text', text: user }]
    : user;
  const body = {
    model,
    max_tokens: maxTokens,
    system: cacheSystem
      ? [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }]
      : system,
    messages: Array.isArray(messages) && messages.length ? messages : [{ role: 'user', content: userTurn }],
    ...([...laneTools, ...answerTool].length ? { tools: [...laneTools, ...answerTool] } : {}),
    ...(delivery === 'tool' ? { tool_choice: { type: 'auto' } } : {}),
    thinking: { type: 'adaptive' },
    output_config: {
      effort,
      ...(delivery === 'output_format' ? { format: { type: 'json_schema', schema: anthropicWireSchema(schema) } } : {})
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
    parseResponse: readAnthropicStructured({ schema, maxTokens, requestedModel: model, delivery }),
    // The socket stays llmCall's; one deadline over headers AND body (a
    // stream is read to its end under it), capped by the worker's budget,
    // with typed throws — the same transport contract as the coder's
    // existing paths. The wall reaches llmCall too (see the header).
    fetchImpl: laneDeadlineFetch({ provider: 'anthropic', fetchImpl, timeoutMs }),
    ...laneWall(timeoutMs)
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
  // The lane's wall, as for the Anthropic request. Without one, the bare
  // fetch outside a worker and the transport default inside one, as before.
  timeoutMs = null,
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
  fetchImpl: laneDeadlineFetch({ provider: 'openai', fetchImpl, timeoutMs, bareOutsideWorker: true }),
  ...laneWall(timeoutMs)
});

// ── the openai_compatible llmCall options (one seam) ───────────────────────
// 2026-11-10 (modelLanes.js SELF_HOSTED_DECISION): every lane whose deciding
// call can ride the openai_compatible endpoint — a policy-seated lab rung or
// a self-hosted, unqualified model — builds its call HERE: the lane's own
// instructions and input unchanged, the chat/completions body, the lane's wall
// as one deadline transport, and a reader that turns each way of having no
// answer into the providerTransport vocabulary the cloud paths use:
//  - finish_reason `length`          → PROVIDER_OUTPUT_LIMIT (never parsed)
//  - finish_reason `content_filter`
//    or a `refusal` message          → PROVIDER_REFUSED
//  - an empty reply                  → PROVIDER_INVALID_OUTPUT
//  - (json) prose, not JSON          → PROVIDER_INVALID_OUTPUT
//  - (json + schema) a schema breach → PROVIDER_INVALID_OUTPUT (validateLaneSchema,
//                                      the lane's FULL schema)
// HTTP statuses and timeouts are typed by typedLlmCallFailure, as for every
// lane. Most compatible servers take no strict-schema grammar the same way, so
// with `pinSchema` the schema travels in the system prompt and the answer is
// held to it after parsing — the same check, done on our side. No fallback to
// another model is ever requested or made here.
export const openAiCompatibleReplyText = (payload) => {
  const content = payload?.choices?.[0]?.message?.content;
  return typeof content === 'string' ? content : '';
};

export const readOpenAiCompatibleReply = ({ json = false, schema = null, maxTokens = null, requestedModel = null } = {}) => (payload) => {
  const choice = payload?.choices?.[0] || null;
  const model = servedModelOf(payload) || requestedModel;
  const finishReason = choice?.finish_reason ?? null;
  if (finishReason === 'length') throw providerOutputLimit('openai_compatible', { model, maxTokens });
  if (finishReason === 'content_filter' || (typeof choice?.message?.refusal === 'string' && choice.message.refusal.trim())) {
    throw providerRefused('openai_compatible', { model, category: finishReason === 'content_filter' ? 'content_filter' : 'refusal' });
  }
  const text = openAiCompatibleReplyText(payload);
  if (!text.trim()) throw providerInvalidOutput('openai_compatible', { detail: 'the reply was empty', model });
  const base = {
    text,
    model: servedModelOf(payload),
    response_id: typeof payload?.id === 'string' ? payload.id : '',
    finish_reason: finishReason
  };
  if (!json) return base;
  let parsed;
  try {
    parsed = extractJson(text);
  } catch {
    parsed = undefined;
  }
  if (!parsed || typeof parsed !== 'object') {
    throw providerInvalidOutput('openai_compatible', { detail: 'the structured answer was not JSON', model });
  }
  if (schema) {
    const violations = validateLaneSchema(schema, parsed);
    if (violations.length) {
      throw providerInvalidOutput('openai_compatible', {
        detail: `the structured answer broke its schema: ${violations.slice(0, 3).join('; ')}`,
        model
      });
    }
  }
  return { ...base, parsed };
};

// The schema, pinned into the instructions for a server that takes no
// grammar (the coding lane's wording since Q9, now shared).
export const pinSchemaInstructions = (instructions, { schemaName, schema }) => `${instructions}

Respond with a SINGLE JSON object only — no markdown fences, no prose. The object must be valid against this JSON Schema ("${schemaName}"):
${JSON.stringify(schema)}`;

// `transport` is { endpoint: { url, headers }, model } (the seat's resolved
// transport). `user` is the per-call input string.
export const openAiCompatibleStructuredRequest = ({
  transport,
  system,
  user,
  maxTokens = null,
  json = false,
  schema = null,
  schemaName = null,
  pinSchema = false,
  execution,
  promptVersion = null,
  sections = null,
  fetchImpl = fetch,
  timeoutMs = null
} = {}) => {
  const instructions = pinSchema && schema ? pinSchemaInstructions(system, { schemaName, schema }) : system;
  return {
    provider: 'openai_compatible',
    url: transport.endpoint.url,
    headers: transport.endpoint.headers,
    body: shapeOpenAiCompatibleRequest({
      model: transport.model,
      system: instructions,
      messages: [{ role: 'user', content: user }],
      maxTokens
    }),
    sections: sections || { system: instructions, context: user },
    execution,
    promptVersion,
    parseResponse: readOpenAiCompatibleReply({ json, schema, maxTokens, requestedModel: transport.model }),
    fetchImpl: laneDeadlineFetch({ provider: 'openai_compatible', fetchImpl, timeoutMs }),
    ...laneWall(timeoutMs)
  };
};

// The served-model guard, one spelling: a llama-server-class endpoint serves
// ONE loaded model and may ignore the request's model field. When the
// response ATTESTS a different id than the seat's, there is no verdict under
// either id. Returns { requested, served } on a mismatch, else null.
export const seatModelMismatch = (transport, telemetry) => {
  const served = telemetry?.model_source === 'response' && typeof telemetry?.model === 'string' && telemetry.model
    ? telemetry.model
    : null;
  return served && served !== transport?.model ? { requested: transport?.model || null, served } : null;
};

// ── a failed call, typed ──────────────────────────────────────────────────
// llmCall throws (a) a typed ProviderFailureError from parseResponse or the
// deadline transport, (b) LLM_CALL_PROVIDER_ERROR for a non-OK status (with
// the provider's error type/code), or (c) a raw network/abort error. All
// three become the ONE providerTransport vocabulary; anything else (a bug,
// a refused execution ref) returns null so the caller rethrows it.
export const typedLlmCallFailure = (provider, error) => {
  if (error?.providerFailure === true && typeof error.code === 'string') return error;
  if (error?.code === 'LLM_CALL_PROVIDER_ERROR') {
    const typed = classifyProviderStatus({
      provider,
      status: error.status,
      // llmCall's `providerError` (the provider's own error object): its
      // type/code name the cause (no credit, a bad key, a rate limit).
      payload: { error: { ...(error.providerError || {}), message: error.providerError?.message || error.message } },
      attempts: error.telemetry?.attempt_count || 1
    });
    // An account with no credit left is named as what it is, for either
    // provider, by the one detector (inngest/parseErrors.js
    // providerFaultOfResponse); the code — and so the retry posture — stays
    // the one the status gives.
    if (providerFaultOfResponse({ status: error.status, providerError: error.providerError }) === PROVIDER_FAULTS.NO_CREDIT) {
      typed.reason = PROVIDER_FAULTS.NO_CREDIT;
    }
    return typed;
  }
  return classifyProviderThrow({ provider, error });
};
