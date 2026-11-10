// What the document lanes add on top of the shared structured seam
// (documentLaneRequest.js): the registry's provider order, file blocks, the
// Responses body carried over, the request through structuredRequest.js,
// and one reply shape. The request rules themselves (structured output,
// adaptive thinking, stop_reason first) are structuredRequest.js's and are
// tested there; here they are checked only as the document lanes send them.
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  anthropicContentFromResponses,
  anthropicFileBlock,
  documentLaneAnthropicRequest,
  documentLaneRequestFromResponses,
  notConfiguredFailure,
  readDocumentLaneReply,
  resolveDocumentLaneProvider,
  stopFailureReason
} from './documentLaneRequest.js';
import { llmCall } from './llmCall.js';
import { buildResponsesDocumentPart } from './responsesInputPart.js';
import { STRUCTURED_ANSWER_TOOL_NAME } from './structuredRequest.js';

const sse = (events) => events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('');
const EXECUTION = { root: { type: 'test', id: 'document-lane-request' } };
const streamOf = (events) => new Response(sse(events), { status: 200, headers: { 'content-type': 'text/event-stream' } });
const textReply = (model, text, stop = 'end_turn') => [
  { type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', model, content: [], usage: { input_tokens: 5, output_tokens: 0 } } },
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
  { type: 'content_block_stop', index: 0 },
  { type: 'message_delta', delta: { stop_reason: stop }, usage: { output_tokens: 7 } },
  { type: 'message_stop' }
];

test('provider: Anthropic first by key presence; a stray OPENAI_MODEL never reaches a document lane', () => {
  const pick = (env) => {
    const r = resolveDocumentLaneProvider({ laneId: 'document_routing', env, modelEnvKeys: ['DOCUMENT_ROUTER_MODEL'], defaultModels: { anthropic: 'claude-opus-5-5', openai: 'gpt-5.4' } });
    return [r.ok, r.provider, r.model, r.source?.provider, r.source?.model];
  };
  assert.deepEqual(pick({ ANTHROPIC_API_KEY: 'a', OPENAI_API_KEY: 'o' }), [true, 'anthropic', 'claude-opus-5-5', 'key_presence', 'default']);
  // A host that kept OPENAI_MODEL from its OpenAI days and now holds only an
  // Anthropic key still reads on Claude; on OpenAI the lane's default holds.
  assert.deepEqual(pick({ ANTHROPIC_API_KEY: 'a', OPENAI_MODEL: 'gpt-5.4-mini' }), [true, 'anthropic', 'claude-opus-5-5', 'key_presence', 'default']);
  assert.deepEqual(pick({ OPENAI_API_KEY: 'o', OPENAI_MODEL: 'gpt-5.4-mini' }), [true, 'openai', 'gpt-5.4', 'key_presence', 'default']);
  // The lane's OWN knob pins (the shared resolver's rule).
  assert.deepEqual(pick({ ANTHROPIC_API_KEY: 'a', OPENAI_API_KEY: 'o', DOCUMENT_ROUTER_MODEL: 'gpt-5.4' }), [true, 'openai', 'gpt-5.4', 'model_id', 'env']);
  assert.deepEqual(pick({}), [false, null, null, 'key_presence', null]);
  // The .env file fills what the process env leaves blank.
  const viaDotEnv = resolveDocumentLaneProvider({ laneId: 'parser_repair', env: { ANTHROPIC_API_KEY: '' }, dotEnv: { ANTHROPIC_API_KEY: 'a' }, defaultModels: { anthropic: 'claude-opus-5-5', openai: 'gpt-5.4' } });
  assert.deepEqual([viaDotEnv.provider, viaDotEnv.apiKey], ['anthropic', 'a']);
});

test('no key: the failure names the provider whose key is missing, in the parse wait vocabulary', () => {
  const none = resolveDocumentLaneProvider({ laneId: 'type_extractors_legacy', env: {}, defaultModels: { anthropic: 'claude-opus-5-5', openai: 'gpt-5.4' } });
  assert.deepEqual(notConfiguredFailure(none, 'type_extractors_legacy'), { provider: 'anthropic', reason: 'anthropic_not_configured' });
  // A pinned gpt id with no OpenAI key names OpenAI.
  const pinned = resolveDocumentLaneProvider({ laneId: 'type_extractors_legacy', env: { ANTHROPIC_API_KEY: 'a', BILL_EXTRACTOR_MODEL: 'gpt-5.4' }, modelEnvKeys: ['BILL_EXTRACTOR_MODEL'], defaultModels: { anthropic: 'claude-opus-5-5', openai: 'gpt-5.4' } });
  assert.deepEqual(notConfiguredFailure(pinned, 'type_extractors_legacy'), { provider: 'openai', reason: 'openai_not_configured' });
});

test('files: a PDF is a document block titled with its file name, an image an image block; the bytes outrank the declared mime', () => {
  assert.deepEqual(anthropicFileBlock({ base64: 'JVBERi0x', mimeType: '', filename: 'a.pdf' }),
    { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: 'JVBERi0x' }, title: 'a.pdf' });
  assert.equal(anthropicFileBlock({ base64: '/9j/4AAQ', mimeType: 'image/jpeg' }).type, 'image');
  assert.equal(anthropicFileBlock({ base64: '/9j/4AAQ', mimeType: 'image/jpg' }).source.media_type, 'image/jpeg');
  assert.equal(anthropicFileBlock({ base64: 'AAAA', mimeType: 'application/octet-stream', filename: 'x.PDF' }).type, 'document');
  // The bytes outrank the label: a phone JPEG with no type, with an
  // octet-stream type, or mislabelled as a PDF is a JPEG image; PNG, GIF and
  // WebP likewise; a PDF labelled as an image is a document.
  for (const mimeType of ['', 'application/octet-stream', 'application/pdf']) {
    assert.deepEqual(anthropicFileBlock({ base64: '/9j/4AAQSkZJRg', mimeType, filename: 'IMG_0412.jpg' }).source.media_type, 'image/jpeg', mimeType || '(none)');
  }
  assert.equal(anthropicFileBlock({ base64: 'iVBORw0KGgoAAAA', mimeType: '' }).source.media_type, 'image/png');
  assert.equal(anthropicFileBlock({ base64: 'R0lGODlhAQAB', mimeType: 'application/octet-stream' }).source.media_type, 'image/gif');
  assert.equal(anthropicFileBlock({ base64: 'UklGRiQAAABXRUJQVlA4', mimeType: '' }).source.media_type, 'image/webp');
  assert.equal(anthropicFileBlock({ base64: 'JVBERi0x', mimeType: 'image/png' }).type, 'document');
});

test('a Responses body carries over unchanged: instructions → system, parts in order, image and file parts as blocks', () => {
  const pdf = buildResponsesDocumentPart({ dataUrl: 'data:application/pdf;base64,JVBERi0x', filename: 'a.pdf' });
  const jpeg = buildResponsesDocumentPart({ dataUrl: 'data:application/pdf;base64,/9j/4AAQ' });
  const { system, content } = anthropicContentFromResponses({
    instructions: 'Read it.',
    input: [{ role: 'user', content: [pdf, { type: 'input_text', text: 'one' }, jpeg, { type: 'input_text', text: 'two' }] }]
  });
  assert.equal(system, 'Read it.');
  assert.deepEqual(content.map((block) => block.type), ['document', 'text', 'image', 'text']);
  assert.equal(content[0].title, 'a.pdf');
  assert.equal(content[2].source.media_type, 'image/jpeg', 'the sniffed image type survives');
});

test('a string input (and a string turn content) is carried over as one text block; an empty user turn is refused', () => {
  assert.deepEqual(anthropicContentFromResponses({ instructions: 'S', input: '{"header":{"vendor_name":"Kahvila"}}' }).content,
    [{ type: 'text', text: '{"header":{"vendor_name":"Kahvila"}}' }]);
  assert.deepEqual(anthropicContentFromResponses({ input: [{ role: 'user', content: 'plain' }] }).content, [{ type: 'text', text: 'plain' }]);
  assert.throws(() => documentLaneRequestFromResponses({ apiKey: 'k', body: { model: 'm', instructions: 'S', input: [] }, effort: 'low', maxTokens: 1000, execution: EXECUTION }), /no user content/);
});

test('the request is the shared structured request: output_config.format, adaptive thinking, the lane\'s effort, streamed, no fallbacks', () => {
  const schema = { type: 'object', additionalProperties: false, required: ['a'], properties: { a: { type: 'string', maxLength: 5 } } };
  const options = documentLaneRequestFromResponses({
    apiKey: 'sk-ant-test',
    body: { model: 'claude-opus-5-5', instructions: 'S', input: [{ role: 'user', content: [buildResponsesDocumentPart({ dataUrl: 'data:application/pdf;base64,JVBERi0x', filename: 'a.pdf' }), { type: 'input_text', text: 'T' }] }], text: { format: { type: 'json_schema', name: 'x', strict: true, schema } } },
    effort: 'high',
    maxTokens: 64000,
    execution: EXECUTION
  });
  assert.equal(options.url, 'https://api.anthropic.com/v1/messages');
  assert.equal(options.headers['anthropic-version'], '2026-10-21');
  const body = options.body;
  assert.deepEqual([body.model, body.max_tokens, body.stream, body.system, body.thinking], ['claude-opus-5-5', 64000, true, 'S', { type: 'adaptive' }]);
  assert.deepEqual(body.output_config, { effort: 'high', format: { type: 'json_schema', schema: { type: 'object', additionalProperties: false, required: ['a'], properties: { a: { type: 'string' } } } } });
  assert.deepEqual(body.messages[0].content.map((block) => block.type), ['document', 'text'], 'the file before the text');
  for (const key of ['tool_choice', 'fallbacks', 'temperature', 'top_p']) assert.equal(key in body, false, key);
  // A schema past the grammar's limits is the one `structured_answer` tool.
  const wide = { type: 'object', additionalProperties: false, required: Array.from({ length: 17 }, (_, i) => `f${i}`), properties: Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`f${i}`, { type: ['string', 'null'] }])) };
  const viaTool = documentLaneAnthropicRequest({ apiKey: 'k', model: 'claude-opus-5-5', content: [{ type: 'text', text: 'T' }], schema: wide, effort: 'high', maxTokens: 64000, execution: EXECUTION }).body;
  assert.deepEqual([viaTool.tools.map((tool) => tool.name), viaTool.tool_choice, 'format' in viaTool.output_config], [[STRUCTURED_ANSWER_TOOL_NAME], { type: 'auto' }, false]);
  // No schema: plain text (the statement reader's transcription entry).
  const plain = documentLaneAnthropicRequest({ apiKey: 'k', model: 'claude-opus-5-5', content: [{ type: 'text', text: 'T' }], effort: 'medium', maxTokens: 64000, execution: EXECUTION }).body;
  assert.deepEqual([plain.output_config, 'tools' in plain, 'system' in plain], [{ effort: 'medium' }, false, false]);
});

test('through the envelope: the parsed answer, the RESPONSE\'s model, plain text without a schema', async () => {
  const schema = { type: 'object', additionalProperties: false, required: ['a'], properties: { a: { type: 'string' } } };
  const { result, telemetry } = await llmCall(documentLaneAnthropicRequest({
    apiKey: 'k', model: 'claude-opus-5-5', content: [{ type: 'text', text: 'T' }], schema, effort: 'low', maxTokens: 16000, execution: EXECUTION, promptVersion: 'v1',
    fetchImpl: async () => streamOf(textReply('claude-opus-5-5-served', '{"a":"b"}'))
  }));
  assert.deepEqual([result.parsed, result.model, telemetry.model, telemetry.model_source, telemetry.prompt_version], [{ a: 'b' }, 'claude-opus-5-5-served', 'claude-opus-5-5-served', 'response', 'v1']);
  const plain = await llmCall(documentLaneAnthropicRequest({
    apiKey: 'k', model: 'claude-opus-5-5', content: [{ type: 'text', text: 'T' }], effort: 'medium', maxTokens: 16000, execution: EXECUTION,
    fetchImpl: async () => streamOf(textReply('claude-opus-5-5', 'LINE 1\nLINE 2'))
  }));
  assert.equal(plain.result.text, 'LINE 1\nLINE 2');
});

test('stop_reason first: refusal and the output limit are the shared typed failures, carrying the served model; prose is not an answer', async () => {
  const schema = { type: 'object', additionalProperties: false, required: ['a'], properties: { a: { type: 'string' } } };
  const call = (events, extra = {}) => llmCall(documentLaneAnthropicRequest({
    apiKey: 'k', model: 'claude-opus-5-5', content: [{ type: 'text', text: 'T' }], schema, effort: 'low', maxTokens: 16000, execution: EXECUTION,
    fetchImpl: async () => streamOf(events), ...extra
  }));
  await assert.rejects(() => call(textReply('claude-opus-5-5', '', 'refusal')),
    (error) => error.code === 'PROVIDER_REFUSED' && error.servedModel === 'claude-opus-5-5' && stopFailureReason(error) === 'provider_refused');
  await assert.rejects(() => call(textReply('claude-opus-5-5', '{"a":', 'max_tokens')),
    (error) => error.code === 'PROVIDER_OUTPUT_LIMIT' && stopFailureReason(error) === 'provider_output_limit');
  // No schema: a plain-text turn that did not finish is the same named failure.
  await assert.rejects(() => call(textReply('claude-opus-5-5', 'LINE', 'max_tokens'), { schema: null }), (error) => error.code === 'PROVIDER_OUTPUT_LIMIT');
  const wide = { type: 'object', additionalProperties: false, required: Array.from({ length: 17 }, (_, i) => `f${i}`), properties: Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`f${i}`, { type: ['string', 'null'] }])) };
  await assert.rejects(() => call(textReply('claude-opus-5-5', '{}'), { schema: wide }),
    (error) => error.code === 'PROVIDER_INVALID_OUTPUT' && stopFailureReason(error) === 'provider_invalid_output', 'tool delivery: a text answer is not read');
});

test('validate:false (the unified extractor) keeps the stop checks and the tool-call rule but leaves the schema to the lane', async () => {
  const wide = { type: 'object', additionalProperties: false, required: Array.from({ length: 17 }, (_, i) => `f${i}`), properties: Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`f${i}`, { type: ['string', 'null'] }])) };
  const events = [
    { type: 'message_start', message: { id: 'msg_t', model: 'claude-opus-4-8', content: [], usage: { input_tokens: 1, output_tokens: 0 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_1', name: STRUCTURED_ANSWER_TOOL_NAME, input: {} } },
    { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"f0":3}' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 3 } },
    { type: 'message_stop' }
  ];
  const request = (validate) => llmCall(documentLaneAnthropicRequest({
    apiKey: 'k', model: 'claude-opus-4-8', content: [{ type: 'text', text: 'T' }], schema: wide, effort: 'high', maxTokens: 64000, execution: EXECUTION, validate,
    fetchImpl: async () => streamOf(events)
  }));
  await assert.rejects(() => request(true), (error) => error.code === 'PROVIDER_INVALID_OUTPUT');
  const { result } = await request(false);
  assert.deepEqual([result.parsed, result.model], [{ f0: 3 }, 'claude-opus-4-8']);
});

test('one reply shape for either provider; the provider\'s error object rides a non-OK status', async () => {
  const outputText = (payload) => payload.output_text;
  const anthropicOk = await readDocumentLaneReply({ provider: 'anthropic', callAnthropic: async () => ({ result: { parsed: { a: 1 }, model: 'claude-opus-5-5' } }), outputText });
  assert.deepEqual(anthropicOk, { ok: true, text: '{"a":1}', parsed: { a: 1 }, servedModel: 'claude-opus-5-5' });
  const noCredit = { type: 'invalid_request_error', message: 'Your credit balance is too low' };
  const anthropicStatus = await readDocumentLaneReply({ provider: 'anthropic', callAnthropic: async () => { throw Object.assign(new Error('x'), { code: 'LLM_CALL_PROVIDER_ERROR', status: 400, providerError: noCredit }); }, outputText });
  assert.deepEqual([anthropicStatus.kind, anthropicStatus.status, anthropicStatus.providerError], ['status', 400, noCredit]);
  const openAiStatus = await readDocumentLaneReply({ provider: 'openai', callOpenAi: async () => ({ ok: false, status: 429, json: async () => ({ error: { code: 'insufficient_quota' } }) }), outputText });
  assert.deepEqual([openAiStatus.kind, openAiStatus.status, openAiStatus.providerError], ['status', 429, { code: 'insufficient_quota' }]);
  const openAiOk = await readDocumentLaneReply({ provider: 'openai', callOpenAi: async () => ({ ok: true, status: 200, json: async () => ({ model: 'gpt-5.4', output_text: '{}' }) }), outputText });
  assert.deepEqual(openAiOk, { ok: true, text: '{}', servedModel: 'gpt-5.4' });
  await assert.rejects(() => readDocumentLaneReply({ provider: 'anthropic', callAnthropic: async () => { throw Object.assign(new Error('cap'), { code: 'PROVIDER_SPEND_LIMIT' }); }, outputText }),
    (error) => error.code === 'PROVIDER_SPEND_LIMIT', 'a spend limit is the operator\'s, not the document\'s');
});

test('fetchProviderJson (callers that own their socket) reads a streamed reply as the same Message, through the one reassembly module', async () => {
  const { fetchProviderJson } = await import('./providerTransport.js');
  const ok = await fetchProviderJson({ provider: 'anthropic', url: 'https://api.anthropic.com/v1/messages', fetchImpl: async () => streamOf(textReply('claude-opus-5-5', '{}')) });
  assert.deepEqual([ok.ok, ok.status, ok.payload.model, ok.payload.stop_reason, ok.payload.content[0].text], [true, 200, 'claude-opus-5-5', 'end_turn', '{}']);
  const failed = await fetchProviderJson({ provider: 'anthropic', url: 'https://api.anthropic.com/v1/messages', fetchImpl: async () => streamOf([
    { type: 'message_start', message: { id: 'm', model: 'claude-opus-5-5', content: [] } },
    { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }
  ]) });
  assert.deepEqual([failed.ok, failed.status, failed.payload.error.type], [false, 529, 'overloaded_error']);
  const cut = await fetchProviderJson({ provider: 'anthropic', url: 'https://api.anthropic.com/v1/messages', fetchImpl: async () => streamOf(textReply('claude-opus-5-5', '{}').slice(0, 3)) });
  assert.deepEqual([cut.ok, cut.status], [false, 500], 'a stream that ended before message_stop is a failed call');
});

// Inside a worker llmCall re-wraps every fetch in the deadline transport. The
// lane's wall must reach it: a slow streamed reply survives past the
// transport default up to the lane's wall, and fails typed at the wall. (The
// default is shrunk through its env knob so the test runs in milliseconds;
// the same arithmetic holds for the real 90 s default and 120–240 s walls.)
test('inside an execution budget a slow stream lives to the lane\'s wall, past the transport default, and fails typed at the wall', async () => {
  const { createExecutionBudget, runWithExecutionBudget } = await import('./executionBudget.js');
  const prior = process.env.PROVIDER_REQUEST_TIMEOUT_MS;
  process.env.PROVIDER_REQUEST_TIMEOUT_MS = '60';
  const schema = { type: 'object', additionalProperties: false, required: ['a'], properties: { a: { type: 'string' } } };
  // Headers at once; the events arrive after `delayMs`.
  const slowStream = (delayMs) => async (_url, init) => {
    const encoder = new TextEncoder();
    const body = new ReadableStream({
      start(controller) {
        const timer = setTimeout(() => { controller.enqueue(encoder.encode(sse(textReply('claude-opus-5-5', '{"a":"late"}')))); controller.close(); }, delayMs);
        init?.signal?.addEventListener('abort', () => { clearTimeout(timer); controller.error(Object.assign(new Error('aborted'), { name: 'AbortError' })); }, { once: true });
      }
    });
    return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };
  const call = (delayMs, timeoutMs) => runWithExecutionBudget(createExecutionBudget({ timeoutMs: 120_000, label: 'parse-test' }), () => llmCall(documentLaneAnthropicRequest({
    apiKey: 'k', model: 'claude-opus-5-5', content: [{ type: 'text', text: 'T' }], schema, effort: 'high', maxTokens: 64000, execution: EXECUTION,
    timeoutMs, fetchImpl: slowStream(delayMs)
  })));
  try {
    const { result } = await call(150, 400);
    assert.deepEqual(result.parsed, { a: 'late' }, 'a reply slower than the transport default but inside the lane\'s wall is read');
    await assert.rejects(() => call(600, 250), (error) => error.code === 'PROVIDER_TIMEOUT', 'past the lane\'s wall: a typed timeout');
    // Without a lane wall the transport default still applies.
    await assert.rejects(() => call(150, null), (error) => error.code === 'PROVIDER_TIMEOUT');
  } finally {
    if (prior === undefined) delete process.env.PROVIDER_REQUEST_TIMEOUT_MS; else process.env.PROVIDER_REQUEST_TIMEOUT_MS = prior;
  }
});
