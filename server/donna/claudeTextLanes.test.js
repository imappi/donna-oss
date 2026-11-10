// The text lanes on Claude (owner's decision, 2026-11-10: Donna runs on
// Claude only; OpenAI stays the alternative that runs only without an
// Anthropic key). Every lane whose input is text — transaction coding, ask
// drafting, memory extraction, the owner invoice command read, document
// chat, the marketing drafters and the outbound reply reader — is driven
// here on its ANTHROPIC path with scripted provider replies at the HTTP
// boundary (testSupport/recordedProviders.js). The OpenAI-path cases stay in
// each lane's own test file, unchanged. Synthetic data only; no network.

import assert from 'node:assert/strict';
import test from 'node:test';

import { installRecordedProviders } from './testSupport/recordedProviders.js';
import { llmCall } from './llmCall.js';
import {
  resolveLaneProvider,
  resolveTextLaneProvider,
  TEXT_LANE_DEFAULT_MODELS,
  ANTHROPIC_MESSAGES_URL,
  ANTHROPIC_API_VERSION
} from './providerEndpoints.js';
import {
  anthropicStructuredRequest,
  anthropicWireSchema,
  readAnthropicStructured,
  typedLlmCallFailure,
  validateLaneSchema
} from './structuredRequest.js';
import { assembleAnthropicEventStream } from './anthropicEventStream.js';
import { classifyProviderStatus, PROVIDER_FAILURE_CODES } from './providerTransport.js';
import { getLane } from './modelLanes.js';
import { suggestTransactionCoding, suggestTransactionCodingBatch } from './transactionLlm.js';
import { resolveCodingPolicy } from './codingPolicy.js';
import { draftClientAskMessage, buildAskMessageSchema } from './askPipeline.js';
import { distillFirmFactsFromEvent } from './firmFacts.js';
import { readOwnerInvoiceCommand } from './ownerInvoiceCommandRead.js';
import { buildCommandSchema } from './ownerInvoiceCommand.js';
import { classifyOwnerReply } from './outbound/replyIngestion.js';
import { generateDocumentChatReply, DOCUMENT_CHAT_RESPONSE_SCHEMA } from './documentChat.js';
import { draftNurtureEmail } from './marketing/nurtureDrafter.js';
import { draftProspectDossier } from './marketing/dossierDrafter.js';
import { triageInboundMessage, draftInboundReply } from './marketing/replyDrafter.js';
import { draftSocialPosts } from './marketing/socialPostDrafter.js';

const TEXT_LANES = ['transaction_coding', 'document_chat', 'ask_drafting', 'memory_extraction', 'owner_invoice_command_read', 'marketing_drafting'];

// ── helpers ───────────────────────────────────────────────────────────────
const setEnv = (t, vars) => {
  const previous = {};
  for (const [name, value] of Object.entries(vars)) {
    previous[name] = process.env[name];
    if (value == null) delete process.env[name];
    else process.env[name] = value;
  }
  t.after(() => {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
};

// Only an Anthropic key, no model knob: the Claude-only installation.
const claudeOnly = (t) => setEnv(t, {
  ANTHROPIC_API_KEY: 'sk-ant-test-dummy',
  OPENAI_API_KEY: null,
  OPENAI_MODEL: null,
  OPENAI_MODEL_CHAT: null
});

const withProviders = (t) => {
  const providers = installRecordedProviders();
  t.after(() => providers.restore());
  return providers;
};

// A Messages API body as the API answers a structured-output request.
const claudeMessage = (parsed, { model = 'claude-opus-5-5', stopReason = 'end_turn', stopDetails = null, id = 'msg_synthetic_1', usage = null } = {}) => ({
  id,
  type: 'message',
  role: 'assistant',
  model,
  content: [
    { type: 'thinking', thinking: '', signature: 'synthetic-signature' },
    { type: 'text', text: typeof parsed === 'string' ? parsed : JSON.stringify(parsed) }
  ],
  stop_reason: stopReason,
  stop_details: stopDetails,
  usage: usage || { input_tokens: 120, output_tokens: 30, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }
});

const claudeReply = (parsed, options) => ({ status: 200, body: claudeMessage(parsed, options) });

// The answer as the structured tool call (schemas over the grammar limits).
const claudeToolReply = (input, { model = 'claude-opus-5-5', stopReason = 'tool_use', name = 'structured_answer' } = {}) => ({
  status: 200,
  body: {
    id: 'msg_synthetic_tool', type: 'message', role: 'assistant', model,
    content: [{ type: 'thinking', thinking: '', signature: 'sig' }, { type: 'tool_use', id: 'toolu_1', name, input }],
    stop_reason: stopReason, stop_details: null,
    usage: { input_tokens: 120, output_tokens: 30, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }
  }
});

// A schema-valid value for any lane schema: the first enum value, a
// non-empty string, zero, false, an empty array, null where null is allowed.
const sampleFor = (schema) => {
  if (!schema || typeof schema !== 'object') return null;
  if (Array.isArray(schema.anyOf)) return sampleFor(schema.anyOf[0]);
  if (Array.isArray(schema.enum)) return schema.enum[0];
  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  if (types.includes('null')) return null;
  if (types.includes('object')) {
    return Object.fromEntries(Object.keys(schema.properties || {}).map((key) => [key, sampleFor(schema.properties[key])]));
  }
  if (types.includes('array')) return [];
  if (types.includes('string')) return 'x';
  if (types.includes('integer') || types.includes('number')) return 0;
  if (types.includes('boolean')) return false;
  return null;
};

// The request a lane put on the wire (the stub journals sizes only; the
// respond hook sees the body).
const scriptCapture = (providers, lane, answer) => {
  const bodies = [];
  providers.script(lane, {
    times: Infinity,
    respond: async (body) => {
      bodies.push(body);
      return typeof answer === 'function' ? answer(body) : answer;
    }
  });
  return bodies;
};

const assertClaudeRequestShape = (body, { effort, delivery = 'output_format' }) => {
  assert.equal(body.model, 'claude-opus-5-5', 'the lane default on Anthropic');
  assert.deepEqual(body.thinking, { type: 'adaptive' }, 'adaptive thinking; never disabled, never a budget');
  assert.equal(body.output_config.effort, effort, 'effort is explicit per lane');
  if (delivery === 'output_format') {
    assert.equal(body.output_config.format.type, 'json_schema', 'structured output, not forced tool use');
    assert.equal(body.tool_choice, undefined, 'no tool_choice at all');
  } else {
    assert.equal(body.output_config.format, undefined, 'over the grammar limits: no output_config.format');
    assert.deepEqual(body.tool_choice, { type: 'auto' }, 'never forced (rejected on claude-opus-5-5)');
    assert.equal(body.tools.filter((tool) => tool.name === 'structured_answer').length, 1, 'one answer tool');
  }
  for (const field of ['temperature', 'top_p', 'top_k', 'fallbacks']) assert.equal(body[field], undefined, `no ${field}`);
  assert.equal(body.messages.at(-1).role, 'user', 'no assistant prefill');
  assert.ok(Number.isInteger(body.max_tokens) && body.max_tokens >= 16000, 'max_tokens has room');
};

// ── the registry and the shared resolver ──────────────────────────────────
test('every moved text lane is Anthropic first, OpenAI the alternative, claude-opus-5-5 qualified', () => {
  for (const id of TEXT_LANES) {
    const lane = getLane(id);
    assert.deepEqual([...lane.providers], ['anthropic', 'openai'], id);
    assert.equal(lane.endpointClass, 'anthropic', id);
    assert.ok(lane.qualified.includes('claude-opus-5-5') && lane.qualified.includes('gpt-5.4'), id);
  }
  assert.equal(TEXT_LANE_DEFAULT_MODELS.anthropic, 'claude-opus-5-5');
});

test('the one resolver: explicit argument, provider pin, model-id pin, then key presence in registry order', () => {
  const base = { providers: ['anthropic', 'openai'], defaultModels: { anthropic: 'claude-opus-5-5', openai: 'gpt-5.4' }, modelEnvKeys: ['OPENAI_MODEL'] };
  const both = { ANTHROPIC_API_KEY: 'a', OPENAI_API_KEY: 'o' };
  const pick = (env, extra = {}) => {
    const r = resolveLaneProvider({ ...base, env, ...extra });
    return [r.ok, r.provider, r.model, r.source.provider, r.source.model];
  };
  assert.deepEqual(pick(both), [true, 'anthropic', 'claude-opus-5-5', 'key_presence', 'default'], 'both keys: Anthropic');
  assert.deepEqual(pick({ OPENAI_API_KEY: 'o' }), [true, 'openai', 'gpt-5.4', 'key_presence', 'default'], 'OpenAI only without an Anthropic key');
  assert.deepEqual(pick({ ANTHROPIC_API_KEY: 'a' }), [true, 'anthropic', 'claude-opus-5-5', 'key_presence', 'default']);
  assert.deepEqual(pick({ ...both, OPENAI_MODEL: 'claude-opus-4-8' }), [true, 'anthropic', 'claude-opus-4-8', 'model_id', 'env'], 'the knob may pin a claude id');
  assert.deepEqual(pick({ ...both, OPENAI_MODEL: 'gpt-5.4' }), [true, 'openai', 'gpt-5.4', 'model_id', 'env'], 'a gpt pin keeps OpenAI');
  assert.deepEqual(pick(both, { provider: 'openai' }), [true, 'openai', 'gpt-5.4', 'param', 'default']);
  const none = resolveLaneProvider({ ...base, env: {} });
  assert.equal(none.ok, false);
  assert.equal(none.reason, 'no_provider_key');
  const pinnedMissing = resolveLaneProvider({ ...base, env: { ANTHROPIC_API_KEY: 'a', OPENAI_MODEL: 'gpt-5.4' } });
  assert.equal(pinnedMissing.reason, 'no_provider_key:openai', 'a gpt pin without an OpenAI key fails named, never silently swaps');
  // The explicit OpenAI config seam the lanes' callers pass pins OpenAI.
  const seam = resolveTextLaneProvider({ providers: base.providers, env: both, openAiConfig: { apiKey: 'k', model: 'gpt-5.4' } });
  assert.deepEqual([seam.provider, seam.model, seam.source.provider], ['openai', 'gpt-5.4', 'param']);
  // The .env fallback fills only what the process leaves blank.
  const dot = resolveTextLaneProvider({ providers: base.providers, env: { ANTHROPIC_API_KEY: '' }, dotEnv: { ANTHROPIC_API_KEY: 'from-file' } });
  assert.deepEqual([dot.ok, dot.provider, dot.apiKey], [true, 'anthropic', 'from-file']);
});

// ── the request shape and the answer reader ───────────────────────────────
const SCHEMA = {
  type: 'object', additionalProperties: false, required: ['answer', 'note', 'items'],
  properties: {
    answer: { type: 'string', minLength: 1, enum: ['yes', 'no'] },
    note: { type: ['string', 'null'] },
    items: { type: 'array', items: { type: 'string', minLength: 1 } }
  }
};

test('the Anthropic request: structured output, adaptive thinking, explicit effort, cacheable system, no prefill', () => {
  const options = anthropicStructuredRequest({
    apiKey: 'sk-ant-dummy', model: 'claude-opus-5-5', system: 'Stable instructions.', user: 'Per-call input.',
    schema: SCHEMA, effort: 'medium', cacheSystem: true, stream: true, execution: { root: { type: 't', id: '1' } }
  });
  assert.equal(options.url, ANTHROPIC_MESSAGES_URL);
  assert.equal(options.headers['anthropic-version'], ANTHROPIC_API_VERSION);
  assert.equal(options.headers['x-api-key'], 'sk-ant-dummy');
  assertClaudeRequestShape(options.body, { effort: 'medium' });
  assert.deepEqual(options.body.system, [{ type: 'text', text: 'Stable instructions.', cache_control: { type: 'ephemeral' } }], 'the stable part first, cacheable');
  assert.equal(options.body.stream, true);
  assert.equal(options.body.output_config.format.schema.properties.answer.minLength, undefined, 'unsupported keywords leave the WIRE copy');
  assert.deepEqual(options.body.output_config.format.schema.properties.answer.enum, ['yes', 'no'], 'enums stay');
  assert.equal(SCHEMA.properties.answer.minLength, 1, 'the lane schema itself is untouched');
  assert.deepEqual(anthropicWireSchema(SCHEMA).required, SCHEMA.required);
  assert.throws(() => anthropicStructuredRequest({ apiKey: 'k', model: 'm', system: 's', user: 'u', schema: SCHEMA }), /explicit effort/);
});

test('stop_reason is read before content: refusal and max_tokens are named failures; the full schema is checked', () => {
  const read = readAnthropicStructured({ schema: SCHEMA, maxTokens: 16000, requestedModel: 'claude-opus-5-5' });
  const ok = read(claudeMessage({ answer: 'yes', note: null, items: ['a'] }));
  assert.deepEqual(ok.parsed, { answer: 'yes', note: null, items: ['a'] });
  assert.equal(ok.model, 'claude-opus-5-5', 'the served model id');
  assert.throws(() => read(claudeMessage('{"answer":"yes"', { stopReason: 'refusal', stopDetails: { type: 'refusal', category: 'cyber' } })),
    (error) => error.code === PROVIDER_FAILURE_CODES.REFUSED && error.reason === 'refusal:cyber' && error.retryable === false);
  assert.throws(() => read(claudeMessage('{"answer":"ye', { stopReason: 'max_tokens' })),
    (error) => error.code === PROVIDER_FAILURE_CODES.OUTPUT_LIMIT && error.reason === 'max_tokens');
  assert.throws(() => read(claudeMessage({ answer: 'yes', note: null, items: [''] })),
    (error) => error.code === PROVIDER_FAILURE_CODES.INVALID_OUTPUT && /shorter than 1/.test(error.message), 'minLength still holds after parse');
  assert.throws(() => read(claudeMessage({ answer: 'maybe', note: null, items: [] })),
    (error) => error.code === PROVIDER_FAILURE_CODES.INVALID_OUTPUT);
  assert.throws(() => read(claudeMessage('not json')), (error) => error.code === PROVIDER_FAILURE_CODES.INVALID_OUTPUT);
  assert.throws(() => read(claudeMessage({ answer: 'yes', note: null, items: [] }, { stopReason: 'pause_turn' })),
    (error) => error.code === PROVIDER_FAILURE_CODES.INVALID_OUTPUT && /pause_turn/.test(error.message));
  assert.deepEqual(validateLaneSchema({ anyOf: [{ type: 'null' }, { type: 'string' }] }, 3), ['$: matches no anyOf branch']);
});

test('no credit, a bad key and a rate limit are recorded as what they are on Anthropic', () => {
  const credit = classifyProviderStatus({ provider: 'anthropic', status: 400, payload: { error: { type: 'invalid_request_error', message: 'Your credit balance is too low to access the Anthropic API.' } } });
  assert.equal(credit.code, PROVIDER_FAILURE_CODES.REJECTED_REQUEST);
  assert.equal(credit.reason, 'insufficient_credit');
  assert.equal(credit.owner, 'operator');
  const billing = classifyProviderStatus({ provider: 'anthropic', status: 402, payload: { error: { type: 'billing_error', message: 'billing' } } });
  assert.equal(billing.reason, 'insufficient_credit');
  const key = classifyProviderStatus({ provider: 'anthropic', status: 401, payload: { error: { type: 'authentication_error', message: 'invalid x-api-key' } } });
  assert.equal(key.code, PROVIDER_FAILURE_CODES.UNAUTHORIZED);
  const rate = classifyProviderStatus({ provider: 'anthropic', status: 429, payload: { error: { type: 'rate_limit_error', message: 'slow down' } } });
  assert.equal(rate.code, PROVIDER_FAILURE_CODES.RATE_LIMITED);
  // OpenAI's own words are unchanged.
  const quota = classifyProviderStatus({ provider: 'openai', status: 429, payload: { error: { code: 'insufficient_quota', message: 'quota' } } });
  assert.equal(quota.reason, 'insufficient_quota');
});

test('llmCall reads a streamed answer back into one Message; a mid-stream error is a typed failure', async () => {
  const sse = (events) => new Response(events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join(''), {
    status: 200, headers: { 'content-type': 'text/event-stream' }
  });
  const started = ['message_start', { type: 'message_start', message: { id: 'msg_s', type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [], usage: { input_tokens: 10, output_tokens: 1 } } }];
  const okEvents = [
    started,
    ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } }],
    ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig' } }],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    ['content_block_start', { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } }],
    ['content_block_delta', { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: '{"answer":"yes",' } }],
    ['content_block_delta', { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: '"note":null,"items":[]}' } }],
    ['content_block_stop', { type: 'content_block_stop', index: 1 }],
    ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 21 } }],
    ['message_stop', { type: 'message_stop' }]
  ];
  const request = (fetchImpl) => anthropicStructuredRequest({
    apiKey: 'k', model: 'claude-opus-5-5', system: 's', user: 'u', schema: SCHEMA, effort: 'low', stream: true,
    execution: { root: { type: 't', id: 'stream' } }, fetchImpl
  });
  const { result, telemetry } = await llmCall(request(async () => sse(okEvents)));
  assert.deepEqual(result.parsed, { answer: 'yes', note: null, items: [] });
  assert.equal(telemetry.model, 'claude-opus-5-5');
  assert.equal(telemetry.model_source, 'response');
  assert.equal(telemetry.usage.output_tokens, 21);
  const assembled = assembleAnthropicEventStream(okEvents.map(([e, d]) => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`).join(''));
  assert.equal(assembled.complete, true);

  const overloaded = [started, ['error', { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }]];
  await assert.rejects(llmCall(request(async () => sse(overloaded))), (error) => {
    const typed = typedLlmCallFailure('anthropic', error);
    return error.status === 529 && typed.code === PROVIDER_FAILURE_CODES.UNAVAILABLE && typed.retryable === true;
  });
  await assert.rejects(llmCall(request(async () => sse(okEvents.slice(0, 5)))), (error) => error.code === 'LLM_CALL_PROVIDER_ERROR',
    'a stream that ends before message_stop is not an answer');
});

// ── transaction coding ────────────────────────────────────────────────────
const TX = { id: 'tx-claude-1', date: '2026-08-01', description: 'BANK FEE', money_out: 10 };
const TX2 = { id: 'tx-claude-2', date: '2026-07-31', description: 'SOFTWARE SUBSCRIPTION', money_out: 49 };

const codingAnswer = (body) => {
  const schema = body.output_config.format.schema;
  const input = JSON.parse(body.messages[0].content);
  if (schema.properties.suggestions) {
    const item = sampleFor(schema.properties.suggestions.items);
    return { suggestions: input.transactions.map((tx) => ({ ...item, transaction_id: tx.id })), group_summary: [] };
  }
  return sampleFor(schema);
};

test('coding on Claude: single and batch, every jurisdiction, the lane policy on the wire, the served model on the receipt', async (t) => {
  claudeOnly(t);
  const providers = withProviders(t);
  const bodies = scriptCapture(providers, 'transaction_coding', (body) => claudeReply(codingAnswer(body), { id: 'msg_coding' }));
  for (const jurisdiction of ['sg', 'fi', 'gb', 'ae', 'us', 'au']) {
    const clientProfile = { jurisdiction };
    const policy = resolveCodingPolicy({ jurisdiction });
    const single = await suggestTransactionCoding({ clientProfile, transaction: TX });
    const batch = await suggestTransactionCodingBatch({ clientProfile, transactions: [TX, TX2] });
    assert.equal(batch.provider_failure, undefined, jurisdiction);
    assert.equal(single.source, 'anthropic');
    assert.equal(single.model, 'claude-opus-5-5', 'the model id is the response\'s');
    assert.equal(single.provider, 'anthropic');
    assert.equal(single.provider_source, 'key_presence');
    assert.equal(batch.suggestions.length, 2);
    for (const suggestion of [single, ...batch.suggestions]) {
      assert.ok(policy.taxTreatmentOptions.includes(suggestion.tax_treatment), jurisdiction);
      assert.equal(suggestion.coding_policy.jurisdiction, jurisdiction);
    }
    assert.equal(batch.suggestions[0].source, 'anthropic_batch');
    assert.equal(batch.suggestions[0].model, 'claude-opus-5-5');
    assert.equal(batch.suggestions[1].coding_policy.businessDate, TX2.date);
    for (const body of bodies.splice(0)) {
      assertClaudeRequestShape(body, { effort: 'high' });
      assert.equal(body.stream, true, 'the coder streams');
      assert.equal(body.system[0].cache_control.type, 'ephemeral', 'the instructions are the cached prefix');
      assert.ok(body.system[0].text.includes(policy.taxInstructions), 'the lane\'s own instructions, unchanged');
      const schema = body.output_config.format.schema;
      const properties = schema.properties.suggestions?.items.properties || schema.properties;
      assert.deepEqual(properties.tax_treatment.enum, policy.taxTreatmentOptions, 'the policy vocabulary rides the schema');
    }
  }
  providers.assertNoUnscripted();
});

test('coding on Claude: refusal, output limit, no credit, bad key and rate limit are provider failures, never codings', async (t) => {
  claudeOnly(t);
  const providers = withProviders(t);
  const clientProfile = { jurisdiction: 'fi' };
  const cases = [
    [{ status: 200, body: claudeMessage('{}', { stopReason: 'refusal', stopDetails: { type: 'refusal', category: null } }) }, PROVIDER_FAILURE_CODES.REFUSED, null],
    [{ status: 200, body: claudeMessage('{"suggestions":[', { stopReason: 'max_tokens' }) }, PROVIDER_FAILURE_CODES.OUTPUT_LIMIT, 'max_tokens'],
    [{ status: 400, body: { type: 'error', error: { type: 'invalid_request_error', message: 'Your credit balance is too low to access the Anthropic API.' } } }, PROVIDER_FAILURE_CODES.REJECTED_REQUEST, 'insufficient_credit'],
    [{ status: 401, body: { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } } }, PROVIDER_FAILURE_CODES.UNAUTHORIZED, 'authentication_error'],
    [{ status: 429, body: { type: 'error', error: { type: 'rate_limit_error', message: 'rate limited' } } }, PROVIDER_FAILURE_CODES.RATE_LIMITED, 'rate_limit_error']
  ];
  for (const [reply, code, reason] of cases) {
    providers.script('transaction_coding', [reply, reply]);
    const single = await suggestTransactionCoding({ clientProfile, transaction: TX });
    const batch = await suggestTransactionCodingBatch({ clientProfile, transactions: [TX] });
    for (const failure of [single.provider_failure, batch.provider_failure]) {
      assert.equal(failure?.code, code, `${code}`);
      assert.equal(failure.provider, 'anthropic');
      if (reason) assert.equal(failure.reason, reason);
    }
  }
  assert.equal(providers.remaining('transaction_coding'), 0);
  providers.assertNoUnscripted();
});

test('coding without any key names the Anthropic key; with only an OpenAI key the OpenAI path runs', async (t) => {
  setEnv(t, { ANTHROPIC_API_KEY: null, OPENAI_API_KEY: null, OPENAI_MODEL: null });
  const keyless = await suggestTransactionCoding({ clientProfile: { jurisdiction: 'gb' }, transaction: TX });
  assert.equal(keyless.provider_failure.code, PROVIDER_FAILURE_CODES.KEY_MISSING);
  assert.equal(keyless.provider_failure.provider, 'anthropic');
  assert.match(keyless.provider_failure.message, /ANTHROPIC_API_KEY/);

  setEnv(t, { OPENAI_API_KEY: 'sk-openai-dummy' });
  const providers = withProviders(t);
  const bodies = scriptCapture(providers, 'transaction_coding', (body) => ({
    status: 200,
    body: { id: 'resp_openai', model: 'gpt-5.4', output_text: JSON.stringify(sampleFor(body.text.format.schema)) }
  }));
  const openai = await suggestTransactionCoding({ clientProfile: { jurisdiction: 'gb' }, transaction: TX });
  assert.equal(openai.source, 'openai');
  assert.equal(bodies[0].text.format.name, 'transaction_coding_suggestion', 'the OpenAI request shape, unchanged');
});

// ── ask drafting ─────────────────────────────────────────────────────────
const CODING_ITEM = {
  id: 'txn-synthetic-1', date: '2026-03-20', description: 'KORTTIOSTO ESIMERKKIKAUPPA', money_out: 19.9,
  ai_suggestion: { ask_client_question: 'What was this purchase for?' }
};
const DRAFT = {
  subject: 'S', message_markdown: 'M', summary: 'internal',
  items: [{ transaction_ref: 'transaction_1', disposition: 'ask', question: 'Q?', evidence_type: 'business_purpose', skip_reason: '', fyi_note: '', local_document_refs: [] }],
  statement_requests: [], document_asks: []
};

test('ask drafting on Claude: the same draft contract, the served model and response id on the receipt', async (t) => {
  claudeOnly(t);
  const providers = withProviders(t);
  const bodies = scriptCapture(providers, 'ask_drafting', claudeReply(DRAFT, { id: 'msg_ask' }));
  const result = await draftClientAskMessage({ clientProfile: { companyName: 'Esimerkki Oy', jurisdiction: 'FI' }, codingItems: [CODING_ITEM] });
  assert.equal(result.model, 'claude-opus-5-5');
  assert.equal(result.response_id, 'msg_ask');
  assert.equal(result.language, 'fi');
  assert.equal(result.draft.items.length, 1);
  const body = bodies[0];
  assertClaudeRequestShape(body, { effort: 'high' });
  assert.equal(body.stream, true);
  assert.equal(body.max_tokens, 64000);
  assert.match(body.system[0].text, /client\.language/, 'the lane\'s instructions, unchanged');
  assert.equal(JSON.parse(body.messages[0].content).client.language, 'fi');
  assert.deepEqual(body.output_config.format.schema, anthropicWireSchema(buildAskMessageSchema()));
});

test('ask drafting on Claude: an empty question breaks the schema and is a provider failure, not a draft', async (t) => {
  claudeOnly(t);
  const providers = withProviders(t);
  providers.script('ask_drafting', claudeReply({ ...DRAFT, items: [{ ...DRAFT.items[0], question: '' }] }));
  await assert.rejects(
    draftClientAskMessage({ clientProfile: { jurisdiction: 'FI' }, codingItems: [CODING_ITEM] }),
    (error) => error.code === 'ASK_PIPELINE_LLM_UNAVAILABLE' && error.provider_failure.code === PROVIDER_FAILURE_CODES.INVALID_OUTPUT
  );
  providers.script('ask_drafting', { status: 400, body: { type: 'error', error: { type: 'invalid_request_error', message: 'Your credit balance is too low to access the Anthropic API.' } } });
  await assert.rejects(
    draftClientAskMessage({ clientProfile: { jurisdiction: 'FI' }, codingItems: [CODING_ITEM] }),
    (error) => error.code === 'ASK_PIPELINE_LLM_UNAVAILABLE' && error.provider_failure.reason === 'insufficient_credit' && error.provider_failure.provider === 'anthropic'
  );
});

// ── memory extraction ────────────────────────────────────────────────────
test('memory extraction on Claude: facts are distilled and sanitized; a failure is empty facts plus a typed receipt', async (t) => {
  claudeOnly(t);
  const providers = withProviders(t);
  const bodies = scriptCapture(providers, 'memory_extraction', claudeReply({
    facts: [{ scope: 'merchant', subject: 'Esimerkki Kahvila', fact: 'Esimerkki Kahvila is the client\'s regular meeting venue for client lunches.', confidence: 'medium' }]
  }));
  const event = { kind: 'recode', transaction_id: 'tx-mem-1', suggested: 'Office expenses', settled: 'Entertainment' };
  const { facts, model } = await distillFirmFactsFromEvent({ event });
  assert.equal(model, 'claude-opus-5-5');
  assert.equal(facts.length, 1);
  assert.equal(facts[0].scope, 'merchant');
  assertClaudeRequestShape(bodies[0], { effort: 'medium' });
  assert.equal(JSON.parse(bodies[0].messages[0].content).transaction_id, 'tx-mem-1');

  providers.reset();
  providers.script('memory_extraction', { status: 429, body: { type: 'error', error: { type: 'rate_limit_error', message: 'slow' } } });
  const failed = await distillFirmFactsFromEvent({ event });
  assert.deepEqual(failed.facts, []);
  assert.equal(failed.provider_failure.code, PROVIDER_FAILURE_CODES.RATE_LIMITED);
});

// ── owner invoice command read ───────────────────────────────────────────
test('owner invoice command on Claude: the raw reading and the served model; a refusal throws a typed reason', async (t) => {
  claudeOnly(t);
  const providers = withProviders(t);
  const reading = sampleFor(buildCommandSchema());
  // 19 union-typed parameters: over the grammar limit, so the answer is the tool call.
  const bodies = scriptCapture(providers, 'owner_invoice_command_read', claudeToolReply(reading));
  const result = await readOwnerInvoiceCommand({ messageText: 'Invoice Esimerkki Oy 100 euros for consulting', buyerCandidates: [{ id: 'p-1', display_name: 'Esimerkki Oy' }], sourceMessageId: 'msg-src-1' });
  assert.deepEqual(result.reading, reading);
  assert.equal(result.model, 'claude-opus-5-5');
  assert.equal(result.provider, 'anthropic');
  assert.equal(result.telemetry.root_execution.id, 'msg-src-1');
  assertClaudeRequestShape(bodies[0], { effort: 'high', delivery: 'tool' });
  assert.match(bodies[0].messages[0].content, /OWNER MESSAGE/);

  providers.reset();
  providers.script('owner_invoice_command_read', { status: 200, body: claudeMessage('{}', { stopReason: 'refusal' }) });
  await assert.rejects(readOwnerInvoiceCommand({ messageText: 'x', sourceMessageId: 'msg-src-2' }),
    (error) => error.provider_failure?.code === PROVIDER_FAILURE_CODES.REFUSED);
});

// ── outbound reply reader ────────────────────────────────────────────────
test('the outbound reply reader on Claude: the verdict and the served model; provider errors throw with the typed cause', async (t) => {
  claudeOnly(t);
  const providers = withProviders(t);
  const bodies = scriptCapture(providers, 'owner_reply_classification', claudeReply({ intent: 'send_was_wrong', action_id: 'a-1', reason: 'names Acme' }));
  const { verdict, model } = await classifyOwnerReply({
    reply: { id: 'r-1', subject: 'Re: Donna', text_body: 'The Acme reminder was wrong' },
    candidates: [{ id: 'a-1', description: 'Payment reminder to Acme' }]
  });
  assert.equal(verdict.action_id, 'a-1');
  assert.equal(model, 'claude-opus-5-5');
  assertClaudeRequestShape(bodies[0], { effort: 'medium' });
  assert.match(bodies[0].messages[0].content, /a-1/, 'candidates ride the input');

  providers.reset();
  providers.script('owner_reply_classification', { status: 401, body: { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } } });
  await assert.rejects(classifyOwnerReply({ reply: { id: 'r-2' }, candidates: [] }),
    (error) => error.provider_failure?.code === PROVIDER_FAILURE_CODES.UNAUTHORIZED && /invalid x-api-key/.test(error.message));
});

// ── document chat ────────────────────────────────────────────────────────
test('document chat on Claude: the turns keep their order and roles; actions are proposals; failures keep the union', async (t) => {
  claudeOnly(t);
  const providers = withProviders(t);
  const bodies = scriptCapture(providers, 'document_chat', claudeToolReply({ text: 'The total is 12.40 EUR.', actions: [] }));
  const reply = await generateDocumentChatReply({
    context: { document: { filename: 'kuitti.pdf', total: 12.4 } },
    history: [{ role: 'user', content: 'Hi' }, { role: 'assistant', content: 'Hello' }],
    userMessage: 'What is the total?'
  });
  assert.equal(reply.kind, 'ok');
  assert.equal(reply.model, 'claude-opus-5-5');
  assert.equal(reply.provider, 'anthropic');
  const body = bodies[0];
  assertClaudeRequestShape(body, { effort: 'medium', delivery: 'tool' });
  assert.deepEqual(body.tools.find((tool) => tool.name === 'structured_answer').input_schema, DOCUMENT_CHAT_RESPONSE_SCHEMA, 'the whole unchanged schema');
  assert.deepEqual(body.messages.map((m) => m.role), ['user', 'user', 'assistant', 'user']);
  assert.match(body.messages[0].content[0].text, /WORKSPACE_CONTEXT/);
  assert.equal(body.messages.at(-1).content[0].text, 'What is the total?');

  providers.reset();
  providers.script('document_chat', claudeReply({ text: 'prose JSON is not the answer', actions: [] }));
  const prose = await generateDocumentChatReply({ context: {}, userMessage: 'x' });
  assert.deepEqual([prose.kind, prose.code], ['failed', 'parse_error'], 'no tool call is a named failure; text is never read');
  providers.script('document_chat', { status: 200, body: claudeMessage('{}', { stopReason: 'refusal' }) });
  const refused = await generateDocumentChatReply({ context: {}, userMessage: 'x' });
  assert.deepEqual([refused.kind, refused.code], ['failed', 'anthropic_refused']);
  providers.script('document_chat', { status: 503, body: { type: 'error', error: { type: 'api_error', message: 'down' } } });
  const down = await generateDocumentChatReply({ context: {}, userMessage: 'x' });
  assert.deepEqual([down.kind, down.code], ['failed', 'anthropic_503']);
});

test('document chat with no key at all names Anthropic', async (t) => {
  setEnv(t, { ANTHROPIC_API_KEY: null, OPENAI_API_KEY: null, OPENAI_MODEL: null, OPENAI_MODEL_CHAT: null });
  const reply = await generateDocumentChatReply({ context: {}, userMessage: 'x' });
  assert.deepEqual([reply.kind, reply.code], ['failed', 'anthropic_not_configured']);
});

// ── marketing drafters ───────────────────────────────────────────────────
test('the marketing drafters on Claude: same instructions and schemas, served model id; the dossier searches the web', async (t) => {
  claudeOnly(t);
  const providers = withProviders(t);
  const nurture = scriptCapture(providers, 'marketing_nurture_draft', claudeReply({ subject: 'A note from Donna', body: 'Hello. No more emails? {{unsubscribe_url}}' }));
  const result = await draftNurtureEmail({ lead: { id: 'lead-1', email: 'owner@example.invalid', reason: 'other' } });
  assert.equal(result.model, 'claude-opus-5-5');
  assert.equal(result.subject, 'A note from Donna');
  assertClaudeRequestShape(nurture[0], { effort: 'medium' });

  const dossierBodies = scriptCapture(providers, 'prospect_dossier', (body) => claudeReply(sampleFor(body.output_config.format.schema)));
  const dossier = await draftProspectDossier({ prospect: { id: 'p-1', company_name: 'Esimerkki Ltd', jurisdiction: 'gb', tier: 'red', source: 'manual_upload' } });
  assert.equal(dossier.model, 'claude-opus-5-5');
  assert.equal(dossier.dossier.message, null);
  assert.deepEqual(dossierBodies[0].tools, [{ type: 'web_search_20260209', name: 'web_search', max_uses: 8 }]);

  const triage = scriptCapture(providers, 'marketing_reply_triage', (body) => claudeReply(sampleFor(body.output_config.format.schema)));
  const verdict = await triageInboundMessage({ message: { id: 'm-1', subject: 'Question', text_body: 'How much?' } });
  assert.equal(verdict.model, 'claude-opus-5-5');
  assertClaudeRequestShape(triage[0], { effort: 'medium' });

  scriptCapture(providers, 'marketing_reply_draft', claudeReply({ subject: 'Re: Question', body: 'From 99. {{unsubscribe_url}}' }));
  const draft = await draftInboundReply({ message: { id: 'm-1', subject: 'Question' }, verdict: { semantic_class: 'question' } });
  assert.equal(draft.model, 'claude-opus-5-5');

  scriptCapture(providers, 'marketing_social_posts', claudeReply({ posts: [{ body: 'Books, closed.', angle: 'close' }] }));
  const social = await draftSocialPosts({ count: 1 });
  assert.equal(social.model, 'claude-opus-5-5');
  assert.equal(social.posts.length, 1);
  providers.assertNoUnscripted();
});

test('a marketing drafter on Claude fails honestly with the typed cause (503, no fallback copy)', async (t) => {
  claudeOnly(t);
  const providers = withProviders(t);
  providers.script('marketing_nurture_draft', { status: 400, body: { type: 'error', error: { type: 'invalid_request_error', message: 'Your credit balance is too low to access the Anthropic API.' } } });
  await assert.rejects(draftNurtureEmail({ lead: { id: 'lead-2' } }),
    (error) => error.statusCode === 503 && error.code === 'NURTURE_DRAFTER_UNAVAILABLE' && /credit balance is too low/.test(error.message));
});

// ── the two grammar limits found on live calls (2026-11-10) ──────────────
test('a nullable enum goes on the wire as anyOf; the lane schema keeps its spelling', () => {
  const lane = { type: 'object', additionalProperties: false, required: ['direction'], properties: { direction: { type: ['string', 'null'], enum: ['money_in', 'money_out', null] } } };
  const wire = anthropicWireSchema(lane);
  assert.deepEqual(wire.properties.direction, { anyOf: [{ type: 'string', enum: ['money_in', 'money_out'] }, { type: 'null' }] });
  assert.deepEqual(lane.properties.direction.enum, ['money_in', 'money_out', null]);
  assert.deepEqual(validateLaneSchema(lane, { direction: null }), []);
  assert.equal(validateLaneSchema(lane, { direction: 'sideways' }).length, 1);
});

test('one delivery rule: within the grammar limits output_config.format, over them one non-strict tool with tool_choice auto', async (t) => {
  const { schemaDeliveryFor, STRUCTURED_OUTPUT_LIMITS } = await import('./structuredRequest.js');
  assert.deepEqual(STRUCTURED_OUTPUT_LIMITS, { unionParameters: 16, optionalProperties: 24 });
  assert.equal(schemaDeliveryFor(SCHEMA).delivery, 'output_format');
  const chat = schemaDeliveryFor(DOCUMENT_CHAT_RESPONSE_SCHEMA);
  assert.equal(chat.delivery, 'tool');
  assert.ok(chat.unionParameters > 16, `document chat: ${chat.unionParameters} unions`);
  const manyOptional = { type: 'object', additionalProperties: false, required: [],
    properties: Object.fromEntries(Array.from({ length: 25 }, (_, i) => [`f${i}`, { type: 'string' }])) };
  assert.equal(schemaDeliveryFor(manyOptional).delivery, 'tool', '25 optional properties is over the limit');

  const read = readAnthropicStructured({ schema: DOCUMENT_CHAT_RESPONSE_SCHEMA, delivery: 'tool' });
  const action = sampleFor(DOCUMENT_CHAT_RESPONSE_SCHEMA.properties.actions.items);
  assert.deepEqual(read(claudeToolReply({ text: 'ok', actions: [action] }).body).parsed, { text: 'ok', actions: [action] });
  assert.throws(() => read(claudeMessage({ text: 'ok', actions: [] })), (error) => error.code === PROVIDER_FAILURE_CODES.INVALID_OUTPUT && /not given as the structured tool call/.test(error.message));
  assert.throws(() => read(claudeToolReply({ text: 'ok' }).body), (error) => error.code === PROVIDER_FAILURE_CODES.INVALID_OUTPUT && /actions: required/.test(error.message));
  assert.throws(() => read(claudeToolReply({ text: 'ok', actions: [] }, { stopReason: 'max_tokens' }).body), (error) => error.code === PROVIDER_FAILURE_CODES.OUTPUT_LIMIT);

  // Document and image blocks ride before the text of the one user turn.
  const options = anthropicStructuredRequest({ apiKey: 'k', model: 'claude-opus-5-5', system: 's', user: 'Extract.', schema: SCHEMA, effort: 'low',
    content: [{ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: 'JVBERi0=' } }], execution: { root: { type: 't', id: 'doc' } } });
  assert.deepEqual(options.body.messages[0].content.map((block) => block.type), ['document', 'text']);
});
