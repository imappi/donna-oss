// The record / replay seam (providerReplay.js) without a database or a key.
// The month-long replay against PostgreSQL is scripts/demo_fi.test.js.

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  PROVIDER_REPLAY_CODES,
  REPLAY_PLACEHOLDER_KEY,
  REPLAYED_MODEL_SUFFIX,
  bindResponse,
  currentProviderReplay,
  eventStreamIsComplete,
  eventStreamOutcome,
  findSecretShapes,
  installProviderRecorder,
  installProviderReplay,
  packRecordings,
  parseEventStream,
  recordedModels,
  recordedResponseModel,
  providerRequestIdentity,
  unbindResponse,
  unpackRecordings
} from './providerReplay.js';
import { buildModelLaneReceipt } from './desktop/capabilityReceipt.js';

const ANTHROPIC = 'https://api.anthropic.com/v1/messages';
const DAY = 86_400_000;
const T0 = Date.parse('2026-11-10T09:00:00Z');

const pdf = Buffer.from('%PDF-1.4 synthetic receipt bytes '.repeat(20)).toString('base64');
const triageBody = ({ txId, docId, today, stamp, system = 'You match a parsed receipt to one bank line.' }) => ({
  model: 'claude-opus-4-8',
  max_tokens: 2048,
  system,
  messages: [{
    role: 'user',
    content: [
      { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: pdf } },
      { type: 'text', text: `Today is ${today}. Observed ${stamp}. Bank line ${txId} 2025-02-21 −28,60 VR; document ${docId}.` }
    ]
  }]
});
const init = (body) => ({ method: 'POST', headers: { 'x-api-key': 'sk-ant-real-key-never-recorded-123456', 'content-type': 'application/json' }, body: JSON.stringify(body) });

const recordedAnswer = (txId, today) => ({
  id: 'msg_01AbCdEfGhIjKlMnOpQrStUv',
  type: 'message',
  model: 'claude-opus-4-8',
  content: [{ type: 'text', text: JSON.stringify({ match: txId, decided_on: today }) }],
  usage: { input_tokens: 900, output_tokens: 80 }
});

// One recording made "today" on machine A.
const makeRecordings = () => {
  const body = triageBody({ txId: '1b4e28ba-2fa1-11d2-883f-0016d3cca427', docId: '8c9f2a10-0000-4000-8000-00000000aaaa', today: '2026-11-10', stamp: '2026-11-10T09:00:03.120Z' });
  const identity = providerRequestIdentity({ url: ANTHROPIC, init: init(body), now: () => T0 });
  const response = bindResponse(recordedAnswer('1b4e28ba-2fa1-11d2-883f-0016d3cca427', '2026-11-10'), identity);
  return {
    format: 'donna.provider-replay.v1',
    identity: 'donna.provider-request-identity.v1',
    pack: 'unit-pack',
    recorded_at: '2026-11-10',
    entries: [{ key: identity.key, lane: 'reconciliation_reasoning', provider: 'anthropic', endpoint: identity.endpoint, model_requested: 'claude-opus-4-8', provenance: 'live', request: identity.request, responses: [{ status: 200, content_type: 'application/json', body: response }] }]
  };
};

const withTarget = (realFetch) => ({ fetch: realFetch });
const refusingRealFetch = () => {
  const calls = [];
  const fn = async (input) => { calls.push(String(input?.url || input)); throw new Error('the network was refused in this test'); };
  return { fn, calls };
};

test('the identity is stable across machines and days: ids, dates, timestamps and file bytes are normalized, never the content', () => {
  const a = providerRequestIdentity({ url: ANTHROPIC, init: init(triageBody({ txId: '1b4e28ba-2fa1-11d2-883f-0016d3cca427', docId: '8c9f2a10-0000-4000-8000-00000000aaaa', today: '2026-11-10', stamp: '2026-11-10T09:00:03.120Z' })), now: () => T0 });
  const b = providerRequestIdentity({ url: ANTHROPIC, init: init(triageBody({ txId: '0f8fad5b-d9cb-469f-a165-70867728950e', docId: '7c9e6679-7425-40de-944b-e07fc1f90ae7', today: '2026-12-02', stamp: '2026-12-02T17:44:00Z' })), now: () => T0 + 22 * DAY });
  assert.equal(a.key, b.key, 'another day, other ids: the same request');
  assert.match(JSON.stringify(a.request), /<bytes sha256:[0-9a-f]{64}>/, 'file bytes enter as their digest');
  assert.ok(!JSON.stringify(a.request).includes(pdf.slice(0, 40)), 'the file itself is not in the identity');
  assert.match(JSON.stringify(a.request), /2025-02-21/, "the pack's own dates are content and stay");
  assert.ok(!JSON.stringify(a.request).includes('sk-ant'), 'no header enters the identity');
  const changed = providerRequestIdentity({ url: ANTHROPIC, init: init(triageBody({ txId: '1b4e28ba-2fa1-11d2-883f-0016d3cca427', docId: '8c9f2a10-0000-4000-8000-00000000aaaa', today: '2026-11-10', stamp: 'x', system: 'You match a parsed receipt to one bank line, carefully.' })), now: () => T0 });
  assert.notEqual(a.key, changed.key, 'a changed prompt is a different request');
});

test('a recorded answer is moved onto this run: its ids and run dates become this request\'s', () => {
  const recordings = makeRecordings();
  const today = providerRequestIdentity({ url: ANTHROPIC, init: init(triageBody({ txId: '0f8fad5b-d9cb-469f-a165-70867728950e', docId: '7c9e6679-7425-40de-944b-e07fc1f90ae7', today: '2026-12-02', stamp: '2026-12-02T17:44:00Z' })), now: () => T0 + 22 * DAY });
  const body = unbindResponse(recordings.entries[0].responses[0].body, today);
  assert.deepEqual(JSON.parse(body.content[0].text), { match: '0f8fad5b-d9cb-469f-a165-70867728950e', decided_on: '2026-12-02' });
});

test('replay serves the recording with no network, and marks the model and id as replayed', async () => {
  const real = refusingRealFetch();
  const target = withTarget(real.fn);
  const replay = installProviderReplay({ recordings: unpackRecordings(packRecordings(makeRecordings())), target, now: () => T0 + 3 * DAY });
  try {
    assert.equal(currentProviderReplay()?.mode, 'replay');
    const response = await target.fetch(ANTHROPIC, init(triageBody({ txId: '0f8fad5b-d9cb-469f-a165-70867728950e', docId: '7c9e6679-7425-40de-944b-e07fc1f90ae7', today: '2026-11-13', stamp: '2026-11-13T08:00:00Z' })));
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.model, `claude-opus-4-8${REPLAYED_MODEL_SUFFIX}`, 'the receipt model names the recorded model and the replay');
    assert.match(body.id, /^replay_[0-9a-f]{24}$/);
    assert.equal(JSON.parse(body.content[0].text).match, '0f8fad5b-d9cb-469f-a165-70867728950e');
    assert.deepEqual(real.calls, [], 'nothing reached the network');
  } finally {
    replay.restore();
  }
  assert.equal(currentProviderReplay(), null);
  assert.equal(target.fetch, real.fn, 'restore puts the platform fetch back');
});

test('an unrecorded request fails loudly with the lane, the model and how to re-record — and never reaches the network', async () => {
  const real = refusingRealFetch();
  const target = withTarget(real.fn);
  const replay = installProviderReplay({ recordings: unpackRecordings(packRecordings(makeRecordings())), target, now: () => T0, rerecordHint: 'npm run demo:fi:record' });
  try {
    const changedPrompt = triageBody({ txId: '1b4e28ba-2fa1-11d2-883f-0016d3cca427', docId: '8c9f2a10-0000-4000-8000-00000000aaaa', today: '2026-11-10', stamp: 'x', system: 'You match a parsed receipt to one bank line — and say why.' });
    await assert.rejects(target.fetch(ANTHROPIC, init(changedPrompt)), (error) => {
      assert.equal(error.code, PROVIDER_REPLAY_CODES.UNRECORDED);
      assert.equal(error.name, 'ProviderReplayError');
      assert.equal(error.lane, 'reconciliation_reasoning');
      assert.equal(error.model, 'claude-opus-4-8');
      assert.match(error.message, /no recording for lane "reconciliation_reasoning"/);
      assert.match(error.message, /re-record with `npm run demo:fi:record`/);
      assert.match(error.message, /first differs after \d+ chars/, 'it says where the request departs from the nearest recording');
      assert.notEqual(error.providerFailure, true, 'not a provider failure: nothing will retry it as one');
      return true;
    });
    // A lane with no recording at all, on the other provider.
    await assert.rejects(target.fetch('https://api.openai.com/v1/responses', init({ model: 'gpt-5.4', input: 'x', text: { format: { type: 'json_schema', name: 'transaction_coding_batch_suggestion', schema: {} } } })),
      (error) => error.code === PROVIDER_REPLAY_CODES.UNRECORDED && error.lane === 'transaction_coding' && /No recording of lane "transaction_coding" exists/.test(error.message));
    // Any other outside host: refused, never fetched.
    await assert.rejects(target.fetch('https://example.com/anything'), (error) => error.code === PROVIDER_REPLAY_CODES.NETWORK_REFUSED);
    assert.equal(replay.missed.length, 2);
    assert.deepEqual(real.calls, [], 'nothing reached the network');
  } finally {
    replay.restore();
  }
});

test('a scope refusal serves nothing (the demo passes "this book holds only the demo company")', async () => {
  const real = refusingRealFetch();
  const target = withTarget(real.fn);
  const replay = installProviderReplay({
    recordings: unpackRecordings(packRecordings(makeRecordings())),
    target,
    now: () => T0,
    assertScope: async () => { throw Object.assign(new Error('foreign company'), { code: PROVIDER_REPLAY_CODES.FOREIGN_BOOK }); }
  });
  try {
    await assert.rejects(target.fetch(ANTHROPIC, init(triageBody({ txId: '1b4e28ba-2fa1-11d2-883f-0016d3cca427', docId: '8c9f2a10-0000-4000-8000-00000000aaaa', today: '2026-11-10', stamp: '2026-11-10T10:00:00Z' }))),
      (error) => error.code === PROVIDER_REPLAY_CODES.FOREIGN_BOOK);
    assert.equal(replay.served.length, 0);
  } finally {
    replay.restore();
  }
});

test('the recorder keeps the answer with its identity, drops provider ids and headers, and refuses a secret-shaped one', async () => {
  const target = withTarget(async () => { throw new Error('unused'); });
  const answers = [
    recordedAnswer('1b4e28ba-2fa1-11d2-883f-0016d3cca427', '2026-11-10'),
    { ...recordedAnswer('1b4e28ba-2fa1-11d2-883f-0016d3cca427', '2026-11-10'), content: [{ type: 'text', text: 'echo sk-ant-api03-abcdefghijklmnop' }] }
  ];
  const recorder = installProviderRecorder({
    target,
    now: () => T0,
    answer: async () => ({ response: new Response(JSON.stringify(answers.shift()), { status: 200, headers: { 'content-type': 'application/json', 'request-id': 'req_0123456789abcdefghij' } }), provenance: 'live' })
  });
  try {
    const body = triageBody({ txId: '1b4e28ba-2fa1-11d2-883f-0016d3cca427', docId: '8c9f2a10-0000-4000-8000-00000000aaaa', today: '2026-11-10', stamp: '2026-11-10T09:00:03Z' });
    await target.fetch(ANTHROPIC, init(body));
    await target.fetch(ANTHROPIC, init({ ...body, max_tokens: 99 }));
  } finally {
    recorder.restore();
  }
  const entries = recorder.entries();
  assert.equal(entries.length, 1, 'the secret-shaped answer was not kept');
  const text = JSON.stringify(entries);
  assert.deepEqual(findSecretShapes(text), []);
  assert.match(entries[0].responses[0].body.id, /^recorded_[0-9a-f]{24}$/);
  assert.match(entries[0].responses[0].body.content[0].text, /<id:1>/, 'the id the request named is stored as its placeholder');
  assert.match(entries[0].responses[0].body.content[0].text, /<run-date\+0>/);
  // The packed file round-trips and every key re-hashes.
  assert.equal(unpackRecordings(packRecordings({ format: 'donna.provider-replay.v1', identity: 'donna.provider-request-identity.v1', entries })).entries[0].key, entries[0].key);
});

test('a tampered recording is refused at load', () => {
  const file = packRecordings(makeRecordings());
  file.entries[0].key = '0'.repeat(64);
  assert.throws(() => unpackRecordings(file), (error) => error.code === PROVIDER_REPLAY_CODES.BAD_RECORDINGS);
});

test('the secret scan names keys, auth headers and provider ids', () => {
  for (const sample of ['sk-proj-abcdefghijklmnopqrstuvwx', 'sk-ant-api03-xyzxyzxyzxyz', '"authorization": "x"', 'x-api-key', 'Bearer abcdefghijklmnop', 'req_011CVabcdefghijklmnop', 'msg_01AbCdEfGhIjKlMnOpQr', '"organization": "org-x"']) {
    assert.ok(findSecretShapes(sample).length > 0, sample);
  }
  assert.deepEqual(findSecretShapes('{"model":"claude-opus-4-8","id":"recorded_0123"}'), []);
});

test('with no replay installed nothing changes: the boot line and the global fetch are the old ones', () => {
  assert.equal(currentProviderReplay(), null);
  const line = buildModelLaneReceipt({ OPENAI_API_KEY: 'k', ANTHROPIC_API_KEY: 'k' }).line;
  assert.match(line, /^model lanes: openai LIT \(/);
  assert.doesNotMatch(line, /REPLAY/);
  assert.equal(buildModelLaneReceipt({ OPENAI_API_KEY: 'k' }).replay, null);
});

test('under replay the boot line says REPLAY with the recorded models, and the placeholder is not a key', async () => {
  const target = withTarget(async () => { throw new Error('unused'); });
  const replay = installProviderReplay({ recordings: unpackRecordings(packRecordings(makeRecordings())), target });
  try {
    const receipt = buildModelLaneReceipt({ OPENAI_API_KEY: REPLAY_PLACEHOLDER_KEY, ANTHROPIC_API_KEY: REPLAY_PLACEHOLDER_KEY });
    assert.equal(receipt.anthropic, false, 'the placeholder is not a credential');
    assert.match(receipt.line, /^model lanes: REPLAY of recorded outputs \(unit-pack, recorded 2026-11-10\); openai REPLAY — recorded outputs \(none recorded\), no provider called/);
    assert.match(receipt.line, /anthropic REPLAY — recorded outputs from claude-opus-4-8, no provider called/);
  } finally {
    replay.restore();
  }
});

// ── Streamed answers (text/event-stream) ────────────────────────────────────
// A consumer written here, independent of the module's parser: what a lane
// reading the stream would do — read the body as it arrives, split events,
// accumulate text deltas, take the model from message_start.
const consumeAnthropicStream = async (response) => {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let raw = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    raw += decoder.decode(value, { stream: true });
  }
  const events = raw.split('\n\n').filter(Boolean).map((block) => {
    const event = /^event: (.*)$/m.exec(block)?.[1] || null;
    const data = JSON.parse(/^data: (.*)$/m.exec(block)[1]);
    return { event, data };
  });
  return {
    events,
    model: events.find((e) => e.data.type === 'message_start')?.data.message.model,
    id: events.find((e) => e.data.type === 'message_start')?.data.message.id,
    text: events.filter((e) => e.data.type === 'content_block_delta').map((e) => e.data.delta.text).join(''),
    stopped: events.at(-1)?.data.type === 'message_stop'
  };
};

const sse = (events) => events.map(({ event, data }) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join('');
const anthropicStream = ({ txId, today, cut = false }) => {
  const id = 'msg_01QzX9k2LmNoPqRsTuVwXyZa';
  const text = JSON.stringify({ match: txId, decided_on: today });
  const half = Math.floor(txId.length / 2) + text.indexOf(txId);
  const events = [
    { event: 'message_start', data: { type: 'message_start', message: { id, type: 'message', role: 'assistant', model: 'claude-opus-4-8', content: [], usage: { input_tokens: 900, output_tokens: 1 } } } },
    { event: 'content_block_start', data: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } },
    // The transaction id is cut across two deltas, as a model may write it.
    { event: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: text.slice(0, half) } } },
    { event: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: text.slice(half) } } },
    { event: 'content_block_stop', data: { type: 'content_block_stop', index: 0 } },
    { event: 'message_delta', data: { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 80 } } },
    { event: 'message_stop', data: { type: 'message_stop' } }
  ];
  return sse(cut ? events.slice(0, 4) : events);
};
const streamedBody = (body) => ({ ...body, stream: true });

const recordStream = async ({ stream, body, now = () => T0 }) => {
  const target = withTarget(async () => { throw new Error('unused'); });
  const recorder = installProviderRecorder({
    target,
    now,
    answer: async () => ({ response: new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream; charset=utf-8', 'request-id': 'req_0123456789abcdefghij' } }), provenance: 'live' })
  });
  try {
    const response = await target.fetch(ANTHROPIC, init(body));
    await response.text();
  } finally {
    recorder.restore();
  }
  return recorder;
};

test('a streamed answer is recorded as events: ids scrubbed, deltas coalesced, the run\'s ids bound, usage kept', async () => {
  const body = streamedBody(triageBody({ txId: '1b4e28ba-2fa1-11d2-883f-0016d3cca427', docId: '8c9f2a10-0000-4000-8000-00000000aaaa', today: '2026-11-10', stamp: '2026-11-10T09:00:03Z' }));
  const recorder = await recordStream({ stream: anthropicStream({ txId: '1b4e28ba-2fa1-11d2-883f-0016d3cca427', today: '2026-11-10' }), body });
  const [entry] = recorder.entries();
  const [kept] = entry.responses;
  assert.equal(kept.content_type, 'text/event-stream');
  assert.equal(kept.body, undefined);
  const text = JSON.stringify(kept);
  assert.deepEqual(findSecretShapes(text), [], 'no provider id survives inside the events');
  assert.doesNotMatch(text, /msg_01QzX9k2/);
  assert.match(kept.events[0].data.message.id, /^recorded_[0-9a-f]{16}_1$/);
  const deltas = kept.events.filter((e) => e.data.type === 'content_block_delta');
  assert.equal(deltas.length, 1, 'the two deltas of one block are one');
  assert.match(deltas[0].data.delta.text, /<id:1>/, 'the id written across two deltas is bound whole');
  assert.match(deltas[0].data.delta.text, /<run-date\+0>/);
  assert.equal(recorder.ledger[0].model, 'claude-opus-4-8');
  assert.deepEqual(recorder.ledger[0].usage, { input_tokens: 900, output_tokens: 80 });
  assert.equal(recordedResponseModel(kept), 'claude-opus-4-8');
  assert.equal(recordedModels({ entries: recorder.entries() }).anthropic[0], 'claude-opus-4-8');
});

test('a streamed answer is replayed as a stream the lane reads, with the marker on its model and this run\'s ids', async () => {
  const body = streamedBody(triageBody({ txId: '1b4e28ba-2fa1-11d2-883f-0016d3cca427', docId: '8c9f2a10-0000-4000-8000-00000000aaaa', today: '2026-11-10', stamp: '2026-11-10T09:00:03Z' }));
  const recorder = await recordStream({ stream: anthropicStream({ txId: '1b4e28ba-2fa1-11d2-883f-0016d3cca427', today: '2026-11-10' }), body });
  const file = packRecordings({ format: 'donna.provider-replay.v1', identity: 'donna.provider-request-identity.v1', pack: 'unit', entries: recorder.entries() });
  const real = refusingRealFetch();
  const target = withTarget(real.fn);
  const replay = installProviderReplay({ recordings: unpackRecordings(file), target, now: () => T0 + 5 * DAY });
  try {
    const later = streamedBody(triageBody({ txId: '0f8fad5b-d9cb-469f-a165-70867728950e', docId: '7c9e6679-7425-40de-944b-e07fc1f90ae7', today: '2026-11-15', stamp: '2026-11-15T10:00:00Z' }));
    const response = await target.fetch(ANTHROPIC, init(later));
    assert.equal(response.headers.get('content-type'), 'text/event-stream');
    const read = await consumeAnthropicStream(response);
    assert.equal(read.model, `claude-opus-4-8${REPLAYED_MODEL_SUFFIX}`, 'the receipt model names the recorded model and the replay');
    assert.match(read.id, /^replay_[0-9a-f]{16}_1$/);
    assert.deepEqual(JSON.parse(read.text), { match: '0f8fad5b-d9cb-469f-a165-70867728950e', decided_on: '2026-11-15' });
    assert.equal(read.stopped, true);
    assert.equal(replay.served[0].stream, true);
    assert.deepEqual(real.calls, []);
  } finally {
    replay.restore();
  }
});

test('an OpenAI Responses stream is marked wherever it names the model', async () => {
  const events = [
    { event: 'response.created', data: { type: 'response.created', response: { id: 'resp_abc123', model: 'gpt-5.4', status: 'in_progress' } } },
    { event: 'response.output_text.delta', data: { type: 'response.output_text.delta', item_id: 'msg_xyz789', content_index: 0, delta: '{"ok":' } },
    { event: 'response.output_text.delta', data: { type: 'response.output_text.delta', item_id: 'msg_xyz789', content_index: 0, delta: 'true}' } },
    { event: 'response.completed', data: { type: 'response.completed', response: { id: 'resp_abc123', model: 'gpt-5.4', status: 'completed', usage: { input_tokens: 10, output_tokens: 3 } } } }
  ];
  const url = 'https://api.openai.com/v1/responses';
  const body = { model: 'gpt-5.4', stream: true, input: 'x', text: { format: { type: 'json_schema', name: 'document_routing', schema: {} } } };
  const target = withTarget(async () => { throw new Error('unused'); });
  const recorder = installProviderRecorder({ target, now: () => T0, answer: async () => ({ response: new Response(sse(events), { status: 200, headers: { 'content-type': 'text/event-stream' } }), provenance: 'live' }) });
  try { await (await target.fetch(url, init(body))).text(); } finally { recorder.restore(); }
  const kept = recorder.entries()[0].responses[0];
  assert.equal(kept.events.filter((e) => e.data.type === 'response.output_text.delta').length, 1);
  assert.equal(kept.events[0].data.response.id, kept.events.at(-1).data.response.id, 'one provider id → one recorded id');
  const replay = installProviderReplay({ recordings: unpackRecordings(packRecordings({ format: 'donna.provider-replay.v1', identity: 'donna.provider-request-identity.v1', entries: recorder.entries() })), target, now: () => T0 });
  try {
    const served = parseEventStream(await (await target.fetch(url, init(body))).text());
    assert.equal(served[0].data.response.model, 'gpt-5.4+replayed');
    assert.equal(served.at(-1).data.response.model, 'gpt-5.4+replayed');
    assert.equal(served[1].data.delta, '{"ok":true}');
  } finally {
    replay.restore();
  }
});

test('a cut-off stream is never a silent success: not kept when recorded, refused when found in a file, a miss on replay', async () => {
  const body = streamedBody(triageBody({ txId: '1b4e28ba-2fa1-11d2-883f-0016d3cca427', docId: '8c9f2a10-0000-4000-8000-00000000aaaa', today: '2026-11-10', stamp: '2026-11-10T09:00:03Z' }));
  const recorder = await recordStream({ stream: anthropicStream({ txId: '1b4e28ba-2fa1-11d2-883f-0016d3cca427', today: '2026-11-10', cut: true }), body });
  assert.equal(recorder.entries().length, 0, 'a stream that ended before message_stop is not an answer');
  assert.equal(recorder.ledger[0].complete, false);
  // A file someone edited to hold a cut-off stream is refused at load.
  const whole = await recordStream({ stream: anthropicStream({ txId: '1b4e28ba-2fa1-11d2-883f-0016d3cca427', today: '2026-11-10' }), body });
  const entries = whole.entries().map((entry) => ({ ...entry, responses: entry.responses.map((r) => ({ ...r, events: r.events.slice(0, -2) })) }));
  assert.throws(() => unpackRecordings(packRecordings({ format: 'donna.provider-replay.v1', identity: 'donna.provider-request-identity.v1', entries })),
    (error) => error.code === PROVIDER_REPLAY_CODES.BAD_RECORDINGS && /never reached its end/.test(error.message));
  // And with nothing kept, the replay of that request is a named miss.
  const target = withTarget(async () => { throw new Error('network refused in this test'); });
  const replay = installProviderReplay({ recordings: { entries: [] }, target, now: () => T0 });
  try {
    await assert.rejects(target.fetch(ANTHROPIC, init(body)), (error) => error.code === PROVIDER_REPLAY_CODES.UNRECORDED);
  } finally {
    replay.restore();
  }
});

test('a stream that ends in a failure event is treated like a non-200: not kept, logged, refused in a file, a miss on replay', async () => {
  const body = streamedBody(triageBody({ txId: '1b4e28ba-2fa1-11d2-883f-0016d3cca427', docId: '8c9f2a10-0000-4000-8000-00000000aaaa', today: '2026-11-10', stamp: '2026-11-10T09:00:03Z' }));
  const anthropicHead = [
    { event: 'message_start', data: { type: 'message_start', message: { id: 'msg_01QzX9k2LmNoPqRsTuVwXyZa', model: 'claude-opus-4-8', content: [], usage: { input_tokens: 9, output_tokens: 1 } } } },
    { event: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '{"match":' } } }
  ];
  const endings = {
    // Anthropic: an overloaded error mid-stream (a message_stop may still follow).
    error: [...anthropicHead, { event: 'error', data: { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } } }, { event: 'message_stop', data: { type: 'message_stop' } }],
    // OpenAI Responses: the run failed, or stopped short of its answer.
    'response.failed': [{ event: 'response.created', data: { type: 'response.created', response: { id: 'resp_abc123', model: 'gpt-5.4' } } }, { event: 'response.failed', data: { type: 'response.failed', response: { id: 'resp_abc123', model: 'gpt-5.4', status: 'failed' } } }],
    'response.incomplete': [{ event: 'response.created', data: { type: 'response.created', response: { id: 'resp_abc123', model: 'gpt-5.4' } } }, { event: 'response.incomplete', data: { type: 'response.incomplete', response: { id: 'resp_abc123', model: 'gpt-5.4', status: 'incomplete' } } }]
  };
  for (const [ending, events] of Object.entries(endings)) {
    assert.equal(eventStreamOutcome(events).outcome, 'failed', ending);
    assert.equal(eventStreamIsComplete(events), false, ending);
    const logged = [];
    const target = withTarget(async () => { throw new Error('unused'); });
    const recorder = installProviderRecorder({ target, now: () => T0, logger: { error: (line) => logged.push(line) }, answer: async () => ({ response: new Response(sse(events), { status: 200, headers: { 'content-type': 'text/event-stream' } }), provenance: 'live' }) });
    try { await (await target.fetch(ANTHROPIC, init(body))).text(); } finally { recorder.restore(); }
    assert.equal(recorder.entries().length, 0, `${ending}: not kept`);
    assert.equal(recorder.ledger[0].kept, false);
    assert.equal(recorder.ledger[0].dropped, `stream_${ending}`);
    assert.match(logged.join('\n'), new RegExp(`did not keep .*stream_${ending.replace('.', '\\.')}`));
  }
  // A non-200 is dropped the same way and named in the ledger.
  const target = withTarget(async () => { throw new Error('unused'); });
  const recorder = installProviderRecorder({ target, now: () => T0, answer: async () => ({ response: new Response('{"error":{"type":"overloaded_error"}}', { status: 529, headers: { 'content-type': 'application/json' } }), provenance: 'live' }) });
  try { await (await target.fetch(ANTHROPIC, init(triageBody({ txId: '1b4e28ba-2fa1-11d2-883f-0016d3cca427', docId: '8c9f2a10-0000-4000-8000-00000000aaaa', today: '2026-11-10', stamp: '2026-11-10T09:00:03Z' })))).text(); } finally { recorder.restore(); }
  assert.equal(recorder.entries().length, 0);
  assert.deepEqual([recorder.ledger[0].kept, recorder.ledger[0].dropped], [false, 'http_529']);
  // A file edited to hold a failed stream is refused at load.
  const whole = await recordStream({ stream: anthropicStream({ txId: '1b4e28ba-2fa1-11d2-883f-0016d3cca427', today: '2026-11-10' }), body });
  const entries = whole.entries().map((entry) => ({ ...entry, responses: entry.responses.map((r) => ({ ...r, events: [...r.events.slice(0, -1), endings.error[2], r.events.at(-1)] })) }));
  assert.throws(() => unpackRecordings(packRecordings({ format: 'donna.provider-replay.v1', identity: 'donna.provider-request-identity.v1', entries })),
    (error) => error.code === PROVIDER_REPLAY_CODES.BAD_RECORDINGS && /ended in error/.test(error.message));
  // With nothing kept, replay of that request is a named miss.
  const replayTarget = withTarget(async () => { throw new Error('network refused in this test'); });
  const replay = installProviderReplay({ recordings: { entries: [] }, target: replayTarget, now: () => T0 });
  try {
    await assert.rejects(replayTarget.fetch(ANTHROPIC, init(body)), (error) => error.code === PROVIDER_REPLAY_CODES.UNRECORDED);
  } finally {
    replay.restore();
  }
});

test('a dropped attempt that the lane retried well is not a hole; a request that ended with no kept answer, or threw, is', async () => {
  const body = triageBody({ txId: '1b4e28ba-2fa1-11d2-883f-0016d3cca427', docId: '8c9f2a10-0000-4000-8000-00000000aaaa', today: '2026-11-10', stamp: '2026-11-10T09:00:03Z' });
  const other = triageBody({ txId: '0f8fad5b-d9cb-469f-a165-70867728950e', docId: '7c9e6679-7425-40de-944b-e07fc1f90ae7', today: '2026-11-10', stamp: '2026-11-10T09:00:03Z', system: 'You match a parsed invoice to one bank line.' });
  const ok = () => new Response(JSON.stringify({ id: 'msg_01QzX9k2LmNoPqRsTuVwXyZa', model: 'claude-opus-4-8', content: [{ type: 'text', text: '{}' }], usage: { input_tokens: 1, output_tokens: 1 } }), { status: 200, headers: { 'content-type': 'application/json' } });
  const overloaded = () => new Response('{"type":"error","error":{"type":"overloaded_error"}}', { status: 529, headers: { 'content-type': 'application/json' } });
  const plan = [overloaded, ok, overloaded, overloaded];
  const target = withTarget(async () => { throw new Error('unused'); });
  const recorder = installProviderRecorder({ target, now: () => T0, answer: async () => ({ response: plan.shift()(), provenance: 'live' }) });
  const thrower = withTarget(async () => { throw new Error('unused'); });
  const throwing = installProviderRecorder({ target: thrower, now: () => T0, answer: async () => { throw new TypeError('fetch failed'); } });
  try {
    // 529, then the lane's retry answered well: kept, no hole.
    await (await target.fetch(ANTHROPIC, init(body))).text();
    await (await target.fetch(ANTHROPIC, init(body))).text();
    // 529 twice and given up: a hole.
    await (await target.fetch(ANTHROPIC, init(other))).text();
    await (await target.fetch(ANTHROPIC, init(other))).text();
    await assert.rejects(thrower.fetch(ANTHROPIC, init(body)), /fetch failed/);
  } finally {
    recorder.restore();
    throwing.restore();
  }
  assert.equal(recorder.entries().length, 1);
  assert.equal(recorder.ledger.filter((row) => !row.kept).length, 3, 'three attempts kept nothing');
  assert.deepEqual(recorder.unanswered().map((hole) => [hole.lane, hole.attempts, hole.last]), [['reconciliation_reasoning', 2, 'http_529']]);
  // A request that threw has a ledger row of its own, and is a hole.
  assert.deepEqual(throwing.ledger.map((row) => [row.kept, row.dropped]), [[false, 'threw_TypeError']]);
  assert.equal(throwing.unanswered().length, 1);
});

test('replay names a request asked more often than it was recorded', async () => {
  const body = streamedBody(triageBody({ txId: '1b4e28ba-2fa1-11d2-883f-0016d3cca427', docId: '8c9f2a10-0000-4000-8000-00000000aaaa', today: '2026-11-10', stamp: '2026-11-10T09:00:03Z' }));
  const recorder = await recordStream({ stream: anthropicStream({ txId: '1b4e28ba-2fa1-11d2-883f-0016d3cca427', today: '2026-11-10' }), body });
  const recordings = unpackRecordings(packRecordings({ format: 'donna.provider-replay.v1', identity: 'donna.provider-request-identity.v1', entries: recorder.entries() }));
  const target = withTarget(async () => { throw new Error('network refused in this test'); });
  const replay = installProviderReplay({ recordings, target, now: () => T0 });
  try {
    await (await target.fetch(ANTHROPIC, init(body))).text();
    assert.deepEqual(replay.overserved(), []);
    await (await target.fetch(ANTHROPIC, init(body))).text();
    assert.deepEqual(replay.overserved().map((o) => [o.recorded, o.served]), [[1, 2]]);
  } finally {
    replay.restore();
  }
});

test('replay names every recorded answer the run never asked for', async () => {
  const body = streamedBody(triageBody({ txId: '1b4e28ba-2fa1-11d2-883f-0016d3cca427', docId: '8c9f2a10-0000-4000-8000-00000000aaaa', today: '2026-11-10', stamp: '2026-11-10T09:00:03Z' }));
  const recorder = await recordStream({ stream: anthropicStream({ txId: '1b4e28ba-2fa1-11d2-883f-0016d3cca427', today: '2026-11-10' }), body });
  const recordings = unpackRecordings(packRecordings({ format: 'donna.provider-replay.v1', identity: 'donna.provider-request-identity.v1', entries: recorder.entries() }));
  const target = withTarget(async () => { throw new Error('network refused in this test'); });
  const replay = installProviderReplay({ recordings, target, now: () => T0 });
  try {
    assert.deepEqual(replay.unused().map((u) => [u.lane, u.recorded, u.served]), [[recordings.entries[0].lane, 1, 0]]);
    await (await target.fetch(ANTHROPIC, init(body))).text();
    assert.deepEqual(replay.unused(), []);
  } finally {
    replay.restore();
  }
});

test('the health route\'s replay read never hangs: a blocked query gives null within its bound, a down database null', async () => {
  const { readLatestProviderReplaySession } = await import('./providerReplaySession.js');
  const started = Date.now();
  assert.equal(await readLatestProviderReplaySession({ queryFn: () => new Promise(() => {}), timeoutMs: 200 }), null);
  assert.ok(Date.now() - started < 1500, 'answered within the bound, not the pool\'s 30 s');
  assert.equal(await readLatestProviderReplaySession({ queryFn: async () => { throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }); } }), null);
  assert.equal(await readLatestProviderReplaySession({ queryFn: async () => ({ rows: [] }) }), null);
});
