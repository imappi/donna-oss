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
  findSecretShapes,
  installProviderRecorder,
  installProviderReplay,
  packRecordings,
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
