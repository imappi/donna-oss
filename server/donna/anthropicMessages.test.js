// The shared Anthropic Messages request (anthropicMessages.js) and the
// envelope's event-stream reassembly (llmCall.js assembleAnthropicStream).
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ANTHROPIC_API_VERSION,
  anthropicFileBlock,
  anthropicRequestFromResponses,
  buildAnthropicStructuredBody,
  callAnthropicMessages,
  readStructuredReply,
  toStructuredOutputSchema
} from './anthropicMessages.js';
import { assembleAnthropicStream, llmCall } from './llmCall.js';
import { buildResponsesDocumentPart } from './responsesInputPart.js';

const sse = (events) => events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('');
const EXECUTION = { root: { type: 'test', id: 'anthropic-messages' } };

test('the request body: structured output, adaptive thinking, the given effort, streamed; no tool choice, no fallback, no sampling', () => {
  const schema = { type: 'object', additionalProperties: false, required: ['a'], properties: { a: { type: 'string' } } };
  const body = buildAnthropicStructuredBody({ model: 'claude-opus-5-5', system: 'S', content: [{ type: 'text', text: 'T' }], schema, effort: 'high', maxTokens: 64000 });
  assert.deepEqual(body, {
    model: 'claude-opus-5-5',
    max_tokens: 64000,
    stream: true,
    thinking: { type: 'adaptive' },
    output_config: { effort: 'high', format: { type: 'json_schema', schema } },
    messages: [{ role: 'user', content: [{ type: 'text', text: 'T' }] }],
    system: 'S'
  });
  assert.deepEqual(buildAnthropicStructuredBody({ model: 'm', content: [], schema: null, effort: 'medium', maxTokens: 1 }).output_config, { effort: 'medium' });
  assert.throws(() => buildAnthropicStructuredBody({ model: 'm', content: [], effort: 'none', maxTokens: 1 }), /effort/);
  assert.equal(ANTHROPIC_API_VERSION, '2026-10-21');
});

test('the schema sent drops only what structured outputs refuse; type arrays become anyOf; the caller still holds the full schema', () => {
  const schema = {
    type: 'object', additionalProperties: false, required: ['n', 'm', 'list'],
    properties: {
      n: { type: 'number', minimum: 0, maximum: 1, description: 'kept' },
      m: { type: ['string', 'null'], maxLength: 80 },
      list: { type: 'array', maxItems: 3, items: { type: 'object', additionalProperties: false, properties: { x: { type: 'integer', multipleOf: 1 } }, required: ['x'] } }
    }
  };
  assert.deepEqual(toStructuredOutputSchema(schema), {
    type: 'object', additionalProperties: false, required: ['n', 'm', 'list'],
    properties: {
      n: { type: 'number', description: 'kept' },
      m: { anyOf: [{ type: 'string' }, { type: 'null' }] },
      list: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { x: { type: 'integer' } }, required: ['x'] } }
    }
  });
  assert.equal(schema.properties.n.minimum, 0, 'the original is not mutated');
});

test('files: a PDF is a document block, an image an image block; the bytes outrank the declared mime', () => {
  assert.deepEqual(anthropicFileBlock({ base64: 'JVBERi0x', mimeType: '' }), { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: 'JVBERi0x' } });
  assert.equal(anthropicFileBlock({ base64: '/9j/4AAQ', mimeType: 'image/jpeg' }).type, 'image');
  assert.equal(anthropicFileBlock({ base64: '/9j/4AAQ', mimeType: 'image/jpg' }).source.media_type, 'image/jpeg');
  assert.equal(anthropicFileBlock({ base64: 'AAAA', mimeType: 'application/octet-stream', filename: 'x.PDF' }).type, 'document');
});

test('a Responses body carries over unchanged: instructions → system, parts in order, image and file parts as blocks', () => {
  const pdf = buildResponsesDocumentPart({ dataUrl: 'data:application/pdf;base64,JVBERi0x', filename: 'a.pdf' });
  const jpeg = buildResponsesDocumentPart({ dataUrl: 'data:application/pdf;base64,/9j/4AAQ' });
  const { system, content } = anthropicRequestFromResponses({
    instructions: 'Read it.',
    input: [{ role: 'user', content: [pdf, { type: 'input_text', text: 'one' }, jpeg, { type: 'input_text', text: 'two' }] }]
  });
  assert.equal(system, 'Read it.');
  assert.deepEqual(content.map((block) => block.type), ['document', 'text', 'image', 'text']);
  assert.equal(content[2].source.media_type, 'image/jpeg', 'the sniffed image type survives');
  assert.equal(content[1].text, 'one');
});

test('stop_reason is read before content: refusal and max_tokens are typed failures carrying the served model', () => {
  assert.deepEqual(readStructuredReply({ model: 'claude-opus-5-5', stop_reason: 'end_turn', content: [{ type: 'thinking', thinking: '' }, { type: 'text', text: '{"a":' }, { type: 'text', text: '1}' }] }),
    { text: '{"a":1}', servedModel: 'claude-opus-5-5', stopReason: 'end_turn' });
  assert.throws(() => readStructuredReply({ model: 'claude-opus-5-5', stop_reason: 'refusal', content: [], stop_details: { category: 'cyber' } }),
    (error) => error.code === 'ANTHROPIC_REFUSAL' && error.servedModel === 'claude-opus-5-5' && error.refusalCategory === 'cyber');
  assert.throws(() => readStructuredReply({ model: 'm', stop_reason: 'max_tokens', content: [{ type: 'text', text: '{' }] }),
    (error) => error.code === 'ANTHROPIC_MAX_TOKENS' && error.reason === 'provider_max_tokens');
});

test('the envelope reassembles an event stream into the Message a non-streaming call returns', () => {
  const { payload, streamError } = assembleAnthropicStream(sse([
    { type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [], stop_reason: null, usage: { input_tokens: 12, output_tokens: 1 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'abc' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'ping' },
    { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: '{"ok":' } },
    { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'true}' } },
    { type: 'content_block_stop', index: 1 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 40 } },
    { type: 'message_stop' }
  ]));
  assert.equal(streamError, null);
  assert.equal(payload.model, 'claude-opus-5-5');
  assert.equal(payload.stop_reason, 'end_turn');
  assert.deepEqual(payload.usage, { input_tokens: 12, output_tokens: 40 });
  assert.deepEqual(payload.content, [{ type: 'thinking', thinking: '', signature: 'abc' }, { type: 'text', text: '{"ok":true}' }]);
  // A JSON body (an error response, or a recorded non-streaming reply) passes through.
  assert.deepEqual(assembleAnthropicStream('{"type":"error","error":{"type":"overloaded_error"}}').payload.error, { type: 'overloaded_error' });
});

test('an error event inside a 200 stream is a provider failure with the matching status, and its telemetry', async () => {
  const fetchImpl = async () => new Response(sse([
    { type: 'message_start', message: { id: 'msg_2', model: 'claude-opus-5-5', content: [], usage: { input_tokens: 1, output_tokens: 0 } } },
    { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }
  ]), { status: 200, headers: { 'content-type': 'text/event-stream' } });
  await assert.rejects(() => llmCall({ provider: 'anthropic', url: 'https://api.anthropic.com/v1/messages', body: { model: 'claude-opus-5-5' }, stream: 'anthropic_sse', execution: EXECUTION, fetchImpl }),
    (error) => error.code === 'LLM_CALL_PROVIDER_ERROR' && error.status === 529 && error.stream_error_type === 'overloaded_error'
      && error.telemetry?.model === 'claude-opus-5-5' && error.telemetry.model_source === 'response');
});

test('callAnthropicMessages: the wire request, the response model, the telemetry', async () => {
  let seen = null;
  const fetchImpl = async (url, init) => {
    seen = { url, headers: init.headers, body: JSON.parse(init.body) };
    return new Response(sse([
      { type: 'message_start', message: { id: 'msg_3', model: 'claude-opus-5-5-served', content: [], usage: { input_tokens: 5, output_tokens: 0 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '{"a":"b"}' } },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 7 } }
    ]), { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };
  const result = await callAnthropicMessages({
    apiKey: 'sk-ant-test', model: 'claude-opus-5-5', system: 'S', content: [{ type: 'text', text: 'T' }],
    schema: { type: 'object', additionalProperties: false, properties: { a: { type: 'string' } }, required: ['a'] },
    effort: 'low', maxTokens: 16000, execution: EXECUTION, promptVersion: 'v1', fetchImpl
  });
  assert.equal(seen.url, 'https://api.anthropic.com/v1/messages');
  assert.equal(seen.headers['x-api-key'], 'sk-ant-test');
  assert.equal(seen.headers['anthropic-version'], '2026-10-21');
  assert.equal(seen.body.stream, true);
  assert.deepEqual([result.text, result.servedModel, result.stopReason], ['{"a":"b"}', 'claude-opus-5-5-served', 'end_turn']);
  assert.deepEqual([result.telemetry.model, result.telemetry.model_source, result.telemetry.prompt_version, result.telemetry.usage.output_tokens],
    ['claude-opus-5-5-served', 'response', 'v1', 7]);
});

test('fetchProviderJson (the transport for callers that own their socket) reads a streamed reply as the same Message', async () => {
  const { fetchProviderJson } = await import('./providerTransport.js');
  const stream = (events) => async () => new Response(sse(events), { status: 200, headers: { 'content-type': 'text/event-stream' } });
  const ok = await fetchProviderJson({ provider: 'anthropic', url: 'https://api.anthropic.com/v1/messages', fetchImpl: stream([
    { type: 'message_start', message: { id: 'm', model: 'claude-opus-5-5', content: [], usage: { input_tokens: 1, output_tokens: 0 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '{}' } },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } }
  ]) });
  assert.deepEqual([ok.ok, ok.status, ok.payload.model, ok.payload.stop_reason, ok.payload.content[0].text], [true, 200, 'claude-opus-5-5', 'end_turn', '{}']);
  const failed = await fetchProviderJson({ provider: 'anthropic', url: 'https://api.anthropic.com/v1/messages', fetchImpl: stream([
    { type: 'message_start', message: { id: 'm', model: 'claude-opus-5-5', content: [] } },
    { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }
  ]) });
  assert.deepEqual([failed.ok, failed.status], [false, 529]);
});

test('past the structured-output limits the schema rides one non-strict tool, auto choice, read and validated from the call', async () => {
  const { schemaDeliveryFor, structuredOutputComplexity, STRUCTURED_REPLY_TOOL } = await import('./anthropicMessages.js');
  const nullable = (n) => ({ type: 'object', additionalProperties: false, required: Array.from({ length: n }, (_, i) => `f${i}`),
    properties: Object.fromEntries(Array.from({ length: n }, (_, i) => [`f${i}`, { type: ['string', 'null'] }])) });
  assert.deepEqual(structuredOutputComplexity(toStructuredOutputSchema(nullable(16))), { unionParameters: 16, optionalParameters: 0 });
  assert.equal(schemaDeliveryFor(nullable(16)), 'output_format');
  assert.equal(schemaDeliveryFor(nullable(17)), 'tool');
  assert.equal(schemaDeliveryFor({ type: 'object', properties: Object.fromEntries(Array.from({ length: 25 }, (_, i) => [`o${i}`, { type: 'string' }])) }), 'tool', '25 optional parameters');
  const schema = nullable(17);
  const body = buildAnthropicStructuredBody({ model: 'claude-opus-5-5', content: [{ type: 'text', text: 'T' }], schema, effort: 'high', maxTokens: 64000 });
  assert.deepEqual([body.output_config, body.tool_choice, body.tools.length, body.tools[0].name, body.tools[0].input_schema === schema, body.tools[0].strict],
    [{ effort: 'high' }, { type: 'auto' }, 1, STRUCTURED_REPLY_TOOL, true, undefined]);
  const input = Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`f${i}`, i % 2 ? null : 'x']));
  const reply = (content, stop = 'tool_use') => ({ model: 'claude-opus-5-5', stop_reason: stop, content });
  const call = (value) => ({ type: 'tool_use', id: 't', name: STRUCTURED_REPLY_TOOL, input: value });
  assert.deepEqual(JSON.parse(readStructuredReply(reply([call(input)]), { delivery: 'tool', schema }).text), input);
  assert.throws(() => readStructuredReply(reply([{ type: 'text', text: JSON.stringify(input) }], 'end_turn'), { delivery: 'tool', schema }),
    (error) => error.code === 'ANTHROPIC_NO_STRUCTURED_REPLY', 'a reply in prose is not read');
  assert.throws(() => readStructuredReply(reply([call({ ...input, f0: 3 })]), { delivery: 'tool', schema }),
    (error) => error.code === 'ANTHROPIC_SCHEMA_VIOLATION' && error.violations[0].startsWith('$.f0'));
  assert.equal(JSON.parse(readStructuredReply(reply([call({ ...input, f0: 3 })]), { delivery: 'tool', schema, validate: false }).text).f0, 3,
    'a lane that validates itself (the unified extractor) reads the call as given');
});
