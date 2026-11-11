// The zero-key demo (scripts/demo_fi.mjs) and its committed recordings.
//
// Without a database: the recordings carry no secret-shaped string, load and
// re-hash, stay small, and name the model that answered (a stand-in names
// itself); a changed prompt is refused with the re-record command; the scope
// guard, the arguments, the sealed environment, the spend arithmetic and
// replay's entry point.
// With DONNA_PG_TEST_URL, each in a child process with the network refused:
// the whole month replays as a --verify pass on an empty book, with a .env in
// its working directory and a providers.env under HOME full of fake settings,
// to a pinned end state, every request recorded and every recorded answer
// used — so the recordings cannot drift from what the code asks for without
// this test failing; a book holding another firm is refused before anything
// is written; a recording pass whose live call would pass the cap writes no
// file; a verify pass fails on a recorded answer nobody asked for.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

import http from 'node:http';

import {
  DEFAULT_RECORDINGS, DEMO_ENV_NAMES, DEMO_FIXED_ENV, IMAGE_TOKENS, LEARNED_MARGIN, PDF_PAGE_TOKENS, RECORD_ENV_NAMES, RERECORD_COMMAND, SOCKET_PATH_MAX,
  WORST_CASE_OUTPUT_TOKENS, answerFor, answersFromStandIn, assertDemoBookOnly, assertSocketPathFits, estimateCallUsd, giveOwnerAnswer, laneOutputTokensOf,
  laneUsageOf, loadRecordKeys, loadReplayRecordings, meterRefuses, modelsOf, parseDemoArgs, priceFor, priceUsage, recordedOn, sealDemoEnvironment,
  socketPathFor, standInLanesOf, validatePriceTable, FACTS_FILE
} from './demo_fi.mjs';
import { STAND_IN_MODEL_PREFIX, answerOpenAiStandIn } from './demo_fi_stand_ins.mjs';
import {
  PROVIDER_REPLAY_CODES, REPLAYED_MODEL_SUFFIX, currentProviderReplay, eventStreamIsComplete, findSecretShapes, installProviderReplay, packRecordings,
  recordedResponseModel, unpackRecordings
} from '../server/donna/providerReplay.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MAX_RECORDINGS_BYTES = 6 * 1024 * 1024;
const PG = process.env.DONNA_PG_TEST_URL;

test('the committed recordings carry no key, header or account identifier, and stay small', () => {
  const text = readFileSync(DEFAULT_RECORDINGS, 'utf8');
  assert.deepEqual(findSecretShapes(text), [], 'no secret-shaped string in the recordings');
  assert.doesNotMatch(text, /api\.(openai|anthropic)\.com\/v1\/[a-z]+\?/, 'no query string kept');
  assert.ok(statSync(DEFAULT_RECORDINGS).size < MAX_RECORDINGS_BYTES, `recordings under ${MAX_RECORDINGS_BYTES} bytes`);
  const recordings = loadReplayRecordings();
  assert.ok(recordings.entries.length > 0);
  for (const entry of recordings.entries) {
    assert.ok(['live', 'scripted_stand_in'].includes(entry.provenance), `${entry.key}: provenance`);
    assert.ok(entry.lane && entry.provider && entry.endpoint, `${entry.key}: lane, provider, endpoint`);
    for (const response of entry.responses) {
      assert.equal(typeof recordedResponseModel(response), 'string', `${entry.key}: the recorded model id`);
      if (response.body) assert.ok(!('user' in response.body) && !('organization' in response.body), `${entry.key}: no account field`);
      if (response.events) assert.ok(eventStreamIsComplete(response.events), `${entry.key}: a stream that ended well`);
      assert.equal(response.status, 200, `${entry.key}: only answers that ended well are kept`);
      // The model on the receipt is the one that answered: a stand-in names
      // itself, a live answer names the provider's model.
      const model = recordedResponseModel(response);
      assert.ok(!model.endsWith(REPLAYED_MODEL_SUFFIX), `${entry.key}: no replay marker stored`);
      if (entry.provenance === 'scripted_stand_in') assert.ok(model.startsWith(STAND_IN_MODEL_PREFIX), `${entry.key}: a stand-in names itself (${model})`);
      else assert.ok(!model.startsWith(STAND_IN_MODEL_PREFIX), `${entry.key}: a live answer names the provider's model`);
    }
  }
});

test('the secret scan knows every provider\'s key shape, and any key value it is given', () => {
  const fake = (prefix, n = 24) => `${prefix}${'x7Q'.repeat(Math.ceil(n / 3)).slice(0, n)}`;
  const shapes = {
    openai_key: `{"note":"${fake('sk-proj-')}"}`,
    anthropic_key: `{"note":"${fake('sk-ant-api03-')}"}`,
    typesafe_key: `{"note":"${fake('tsk_')}"}`,
    together_key: `{"note":"${fake('tgp_v1_')}"}`,
    key_field: `{"api_key":"${fake('', 12)}"}`,
    bearer_header: `{"h":"Bearer ${fake('', 20)}"}`
  };
  for (const [name, text] of Object.entries(shapes)) {
    assert.ok(findSecretShapes(text).some((hit) => hit.name === name), `${name} is caught`);
  }
  // Words are not keys: identifiers that merely name the lanes pass.
  for (const word of ['typesafe-first-line-decision-lane', 'typesafe_first_line_lane_receipt_v2', 'tsk_first_line_decision_handoff', 'tgp_v1_lane_receipt_without_digits']) {
    assert.deepEqual(findSecretShapes(`{"lane":"${word}"}`), [], `${word} is not a key`);
  }
  // A key with no shape of its own (a Together legacy key is 64 hex digits,
  // like the file's digests) is caught by its value.
  const legacy = 'ab'.repeat(32);
  assert.deepEqual(findSecretShapes(`{"x":"${legacy}"}`), []);
  assert.equal(findSecretShapes(`{"x":"${legacy}"}`, { extraValues: [legacy] })[0].name, 'configured_key_value');
});

test('a changed prompt is refused with the lane and the re-record command, and touches no network', async () => {
  const recordings = loadReplayRecordings();
  const entry = recordings.entries.find((e) => typeof e.request?.system === 'string')
    || recordings.entries.find((e) => typeof e.request?.instructions === 'string');
  assert.ok(entry, 'a recorded request with a system prompt');
  const target = { fetch: async () => { throw new Error('network refused in this test'); } };
  const replay = installProviderReplay({ recordings, target, rerecordHint: RERECORD_COMMAND });
  const url = `https://${entry.endpoint}`;
  try {
    // The normalized request re-sent as is is the recorded request…
    const same = await target.fetch(url, { method: 'POST', body: JSON.stringify(entry.request) });
    assert.equal(same.status, entry.responses[0].status);
    // …and with one word of its prompt changed it is not.
    const field = typeof entry.request.system === 'string' ? 'system' : 'instructions';
    const changed = { ...entry.request, [field]: `${entry.request[field]} Be brief.` };
    await assert.rejects(target.fetch(url, { method: 'POST', body: JSON.stringify(changed) }), (error) => {
      assert.equal(error.code, PROVIDER_REPLAY_CODES.UNRECORDED);
      assert.equal(error.lane, entry.lane);
      assert.match(error.message, new RegExp(`re-record with \`${RERECORD_COMMAND}\``));
      return true;
    });
  } finally {
    replay.restore();
  }
});

test('the scope guard refuses any firm or company but the demo one', async () => {
  const fakeQuery = (rows) => async (sql) => ({ rows: /to_regclass/.test(sql) ? [{ firms: true, clients: true }] : /from firms/.test(sql) ? rows.firms : rows.clients });
  await assertDemoBookOnly({ query: fakeQuery({ firms: [], clients: [] }), clientId: 'kampaamo-kultalanka-oy' });
  await assert.rejects(
    assertDemoBookOnly({ query: fakeQuery({ firms: [], clients: [{ id: 'acme-oy', firm_id: 'firm-demo-tilitoimisto' }] }), clientId: 'kampaamo-kultalanka-oy' }),
    (error) => error.code === PROVIDER_REPLAY_CODES.FOREIGN_BOOK && /company acme-oy/.test(error.message)
  );
  await assert.rejects(
    assertDemoBookOnly({ query: fakeQuery({ firms: [{ id: 'real-firm' }], clients: [] }), clientId: 'kampaamo-kultalanka-oy' }),
    (error) => error.code === PROVIDER_REPLAY_CODES.FOREIGN_BOOK && /firm real-firm/.test(error.message) && /Nothing was written/.test(error.message)
  );
  // A database with no tables holds no book: it passes, and nothing but the
  // catalogue is read.
  const asked = [];
  await assertDemoBookOnly({ query: async (sql) => { asked.push(sql); return { rows: [{ firms: false, clients: false }] }; }, clientId: 'kampaamo-kultalanka-oy' });
  assert.equal(asked.length, 1);
  assert.match(asked[0], /to_regclass/);
});

test('owner answers are matched to their statement line by date, amount and direction', () => {
  const answers = { by_statement_line: { B25: { date: '2025-02-21', amount: 28.6, direction: 'out', reply: 'r' } } };
  assert.equal(answerFor({ ask: { id: 'a1' }, transaction: { transaction_date: '2025-02-21', money_out: '28.60', money_in: '0' }, answers })?.line, 'B25');
  assert.equal(answerFor({ ask: { id: 'a1' }, transaction: { transaction_date: '2025-02-21', money_out: '0', money_in: '28.60' }, answers }), null);
  assert.equal(answerFor({ ask: { id: 'a1' }, transaction: null, answers }), null);
});

test('the demo refuses a database that does not sort text in C order', async () => {
  const { assertDemoCollation } = await import('./demo_fi.mjs');
  await assertDemoCollation({ query: async () => ({ rows: [{ datcollate: 'C.UTF-8' }] }) });
  await assert.rejects(assertDemoCollation({ query: async () => ({ rows: [{ datcollate: 'en_US.utf8' }] }) }),
    (error) => error.code === 'PROVIDER_REPLAY_COLLATION' && /template template0 locale 'C'/.test(error.message));
});

test('the arguments: a spend cap is a positive number of dollars, --verify is a replay on its own book', () => {
  assert.equal(parseDemoArgs([]).record, false);
  assert.throws(() => parseDemoArgs(['--stand-in=openai']), /only for --record/);
  assert.throws(() => parseDemoArgs(['--replay=off']), /unknown argument/);
  assert.equal(parseDemoArgs(['--record', '--cap-usd=7.5']).capUsd, 7.5);
  for (const bad of ['abc', '0', '-1', '1e3', 'Infinity', '0.0', '']) {
    assert.throws(() => parseDemoArgs(['--record', `--cap-usd=${bad}`]), bad === '' ? /unknown argument/ : /positive number of US dollars/, `--cap-usd=${bad}`);
  }
  assert.throws(() => parseDemoArgs(['--cap-usd=5']), /only for --record/);
  assert.throws(() => parseDemoArgs(['--record', '--verify']), /not for --record/);
  assert.deepEqual([parseDemoArgs(['--verify']).exitAtRest, parseDemoArgs(['--verify']).noWeb], [true, true]);
});

test('replay is entered by the command only: no runtime module installs it, whatever the environment says', async () => {
  // Statically: outside tests, the one caller of installProviderReplay is the
  // demo command, and the seam module reads no environment variable.
  const { execFileSync } = await import('node:child_process');
  const callers = execFileSync('git', ['grep', '-l', 'installProviderReplay(', '--', 'server', 'scripts', 'src', 'desktop', 'api'], { cwd: ROOT, encoding: 'utf8' })
    .split('\n').filter(Boolean).filter((file) => !/\.test\.js$/.test(file));
  assert.deepEqual(callers.sort(), ['scripts/demo_fi.mjs']);
  assert.doesNotMatch(readFileSync(path.join(ROOT, 'server/donna/providerReplay.js'), 'utf8'), /process\.env/);
  // At run time: with every name that might sound like a switch set and no
  // key, loading the envelope, the transport, the endpoints, the lane receipt
  // and the runtime assembly leaves `fetch` as it was and no replay active.
  const before = globalThis.fetch;
  const names = ['DONNA_DEMO', 'DONNA_REPLAY', 'PROVIDER_REPLAY', 'DONNA_PROVIDER_REPLAY', 'DEMO_REPLAY', 'REPLAY'];
  const prior = Object.fromEntries(names.map((n) => [n, process.env[n]]));
  for (const n of names) process.env[n] = '1';
  try {
    await import('../server/donna/llmCall.js');
    await import('../server/donna/providerTransport.js');
    await import('../server/donna/providerEndpoints.js');
    const { buildModelLaneReceipt } = await import('../server/donna/desktop/capabilityReceipt.js');
    await import('../server/donna/desktop/runtimeServer.js');
    assert.equal(globalThis.fetch, before);
    assert.equal(currentProviderReplay(), null);
    assert.doesNotMatch(buildModelLaneReceipt({ ...process.env, OPENAI_API_KEY: '', ANTHROPIC_API_KEY: '' }).line, /REPLAY/);
  } finally {
    for (const [n, v] of Object.entries(prior)) { if (v === undefined) delete process.env[n]; else process.env[n] = v; }
  }
});

test('the sealed environment keeps only the named variables, and a recording pass only two keys more', () => {
  const env = {
    PATH: '/bin', HOME: '/home/x', TZ: 'Europe/Helsinki', LC_ALL: 'fi_FI.UTF-8', LANG: 'fi_FI.UTF-8', DONNA_ACCESS_TOKEN: 't', DONNA_BUILD_COMMIT_SHA: 'abc',
    OPENAI_API_KEY: 'k1', ANTHROPIC_API_KEY: 'k2', TYPESAFE_API_KEY: 'k3', TYPESAFE_MODEL: 'm', OPENAI_COMPATIBLE_BASE_URL: 'http://x',
    OPENAI_MODEL: 'gpt-x', MERCHANT_LOOKUP_ENABLED: 'true', DATABASE_URL: 'postgres://elsewhere', NODE_OPTIONS: '--env-file=.env', HTTPS_PROXY: 'http://p'
  };
  const cwd = process.cwd();
  const replay = sealDemoEnvironment({ env: { ...env }, record: false });
  try {
    assert.notEqual(process.cwd(), cwd);
    assert.deepEqual(readdirSync(process.cwd()), [], 'the demo works from an empty directory: no <cwd>/.env');
  } finally {
    replay.undo();
  }
  assert.equal(process.cwd(), cwd);
  const sealedReplay = { ...env };
  sealDemoEnvironment({ env: sealedReplay }).undo();
  assert.deepEqual(Object.keys(sealedReplay).sort(), ['DONNA_ACCESS_TOKEN', 'DONNA_BUILD_COMMIT_SHA', 'HOME', 'LANG', 'LC_ALL', 'PATH', 'TZ']);
  // The time zone and locale are fixed, not taken from the machine.
  assert.deepEqual([sealedReplay.TZ, sealedReplay.LANG, sealedReplay.LC_ALL], [DEMO_FIXED_ENV.TZ, DEMO_FIXED_ENV.LANG, DEMO_FIXED_ENV.LC_ALL]);
  assert.equal(DEMO_FIXED_ENV.TZ, 'UTC');
  const sealedRecord = { ...env };
  sealDemoEnvironment({ env: sealedRecord, record: true }).undo();
  assert.deepEqual(Object.keys(sealedRecord).filter((k) => !Object.keys(sealedReplay).includes(k)).sort(), ['ANTHROPIC_API_KEY', 'HTTPS_PROXY', 'OPENAI_API_KEY']);
  // No kept name is a model id, a lane switch, an endpoint or a key (a
  // recording pass adds the two live keys and its proxy only).
  for (const name of DEMO_ENV_NAMES) assert.doesNotMatch(name, /MODEL|KEY|URL|ENABLED|TYPESAFE|COMPATIBLE|OPENAI|ANTHROPIC/);
  assert.deepEqual(RECORD_ENV_NAMES.filter((n) => /KEY/.test(n)), ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY']);
});

test('spend: a call is estimated before it is made, from the best source it has, and the bound counts files by what they cost', () => {
  const prices = { 'claude-': { input_per_million: 5, output_per_million: 25 }, 'gpt-': { input_per_million: 2.5, output_per_million: 15 } };
  assert.equal(priceFor(prices, 'unknown-model'), null);
  assert.equal(priceFor(prices, 'claude-opus-4-8'), prices['claude-']);
  const text = JSON.stringify({ model: 'claude-opus-4-8', max_tokens: 2048, system: 'x'.repeat(4000), messages: [{ role: 'user', content: 'y'.repeat(4000) }] });
  // The hard bound is a bound: whatever the provider reports, it is not more.
  const bound = estimateCallUsd({ price: prices['claude-'], init: { body: text }, provider: 'anthropic' });
  assert.equal(bound.input_source, 'bound');
  assert.ok(bound.usd >= priceUsage({ prices, model: 'claude-opus-4-8', provider: 'anthropic', usage: { input_tokens: Buffer.byteLength(text), output_tokens: 2048 } }));
  // An exact count (Anthropic count_tokens) replaces the bound.
  const counted = estimateCallUsd({ price: prices['claude-'], init: { body: text }, provider: 'anthropic', countedInputTokens: 1200 });
  assert.equal(counted.input_tokens, 1200);
  assert.equal(counted.input_source, 'counted');
  // What the lane's earlier calls used, with the margin.
  const learned = estimateCallUsd({ price: prices['gpt-'], init: { body: text }, provider: 'openai', laneTokensPerUnit: 0.3 });
  assert.equal(learned.input_tokens, Math.ceil(learned.bound_units * 0.3 * LEARNED_MARGIN));
  // A PDF is its pages, an image a fixed price, whatever their size.
  const pdf = Buffer.from(`%PDF-1.4\n1 0 obj << /Type /Pages /Count 2 >>\n2 0 obj << /Type /Page >>\n3 0 obj << /Type /Page >>\n${'%'.repeat(40_000)}`).toString('base64');
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(30_000)]).toString('base64');
  const withFiles = estimateCallUsd({ price: prices['gpt-'], provider: 'openai', init: { body: JSON.stringify({ model: 'gpt-5.4', input: [{ content: [
    { type: 'input_file', file_data: `data:application/pdf;base64,${pdf}` }, { type: 'input_image', image_url: `data:image/png;base64,${png}` }] }] }) } });
  assert.ok(withFiles.input_tokens >= 2 * PDF_PAGE_TOKENS + IMAGE_TOKENS);
  assert.ok(withFiles.input_tokens < 2 * PDF_PAGE_TOKENS + IMAGE_TOKENS + 400, 'the base64 itself is not counted as text');
  // Output: the request's limit; else the lane's longest answer with the
  // margin; else the stated worst case.
  assert.equal(estimateCallUsd({ price: prices['gpt-'], init: { body: '{}' }, provider: 'openai' }).output_tokens, WORST_CASE_OUTPUT_TOKENS);
  assert.equal(estimateCallUsd({ price: prices['gpt-'], init: { body: '{}' }, provider: 'openai', laneOutputTokens: 1000 }).output_tokens, 1000 * LEARNED_MARGIN);
  assert.equal(estimateCallUsd({ price: prices['gpt-'], init: { body: '{"max_output_tokens":500}' }, provider: 'openai', laneOutputTokens: 1000 }).output_tokens, 500);
  // The longest live answers per lane, from the committed recordings.
  const longest = laneOutputTokensOf(loadReplayRecordings().entries);
  assert.ok(longest['anthropic:unified_extraction'] > 0);
  assert.equal(Object.keys(longest).some((id) => id.startsWith('openai:')), false, 'stand-in answers teach nothing');
});

test('the price table must price every model the month calls, or the record command does not start; a meter that cannot read refuses', () => {
  const good = { 'claude-': { input_per_million: 5, output_per_million: 25 }, 'gpt-': { input_per_million: 2.5, output_per_million: 15, assumed: true } };
  const lines = validatePriceTable({ prices: good, models: ['claude-opus-4-8', 'gpt-5.4'] });
  assert.match(lines.find((l) => l.startsWith('gpt-')), /an assumed rate, not a published price: the cap is approximate for this model/);
  assert.doesNotMatch(lines.find((l) => l.startsWith('claude-')), /assumed/);
  const bad = [
    [{ 'claude-': { input_per_million: 5 } }, /row "claude-": output_per_million is undefined/],
    [{ 'claude-': { input_per_million: '5', output_per_million: 25 } }, /row "claude-": input_per_million is "5"/],
    [{ 'claude-': { input_per_million: 5, output_per_million: 0 } }, /output_per_million is 0/],
    [{ 'claude-': { input_per_million: 5, output_per_million: 25, cache_write_multiplier: -1 } }, /cache_write_multiplier is -1/],
    [{ 'claude-': { input_per_million: 5, output_per_million: 25 } }, /model "gpt-5.4" has no row/],
    [{}, /there is no price table/]
  ];
  for (const [prices, message] of bad) {
    assert.throws(() => validatePriceTable({ prices, models: ['claude-opus-4-8', 'gpt-5.4'] }), (error) => error.code === 'DEMO_PRICE_TABLE' && message.test(error.message) && /Nothing was called/.test(error.message));
  }
  // The committed facts file prices every model the committed recordings ask for.
  const facts = JSON.parse(readFileSync(FACTS_FILE, 'utf8'));
  assert.ok(validatePriceTable({ prices: facts.prices, models: modelsOf(loadReplayRecordings().entries) }).some((l) => /gpt-5\.4 .*assumed rate/.test(l)));
  // A row missing a field would have made the estimate NaN: refused, not zero.
  const nan = estimateCallUsd({ price: { input_per_million: 5 }, init: { body: '{"max_tokens":10}' }, provider: 'anthropic' });
  assert.equal(Number.isFinite(nan.usd), false);
  assert.equal(meterRefuses({ estimateUsd: nan.usd, spentUsd: 0 }), true);
  assert.equal(meterRefuses({ estimateUsd: 0.2, spentUsd: Number.NaN }), true);
  assert.equal(meterRefuses({ estimateUsd: 0.2, spentUsd: 1 }), false);
});

test('a pass\'s first call of a lane is estimated from the usage the recordings hold for it, with the margin', () => {
  const usage = laneUsageOf(loadReplayRecordings().entries);
  assert.ok(usage['anthropic:unified_extraction'].input > 0 && usage['anthropic:unified_extraction'].output > 0);
  const price = { input_per_million: 2.5, output_per_million: 15 };
  const body = JSON.stringify({ model: 'gpt-5.4', input: 'x'.repeat(200_000) });
  const bound = estimateCallUsd({ price, init: { body }, provider: 'openai' });
  const seeded = estimateCallUsd({ price, init: { body }, provider: 'openai', laneInputTokens: 30_000 });
  assert.equal(seeded.input_source, 'recorded');
  assert.equal(seeded.input_tokens, 30_000 * LEARNED_MARGIN);
  assert.ok(seeded.usd < bound.usd);
  // Never above the bound.
  assert.equal(estimateCallUsd({ price, init: { body: '{"input":"short"}' }, provider: 'openai', laneInputTokens: 30_000 }).input_source, 'bound');
});

test('the socket path is checked before PostgreSQL starts', () => {
  assert.doesNotThrow(() => assertSocketPathFits('/tmp/ddb-abc123', 5433));
  const deep = `/var/folders/7x/${'q'.repeat(28)}/T/donna-demo-passes-AbCdEf/fill-2-book`;
  assert.ok(Buffer.byteLength(socketPathFor(deep, 5433)) > 103);
  if (Buffer.byteLength(socketPathFor(deep, 5433)) > SOCKET_PATH_MAX) {
    assert.throws(() => assertSocketPathFits(deep, 5433), (error) => error.code === 'DEMO_SOCKET_PATH_TOO_LONG' && /shorter --data-dir/.test(error.message));
  }
  const tooDeep = `/tmp/${'d'.repeat(110)}`;
  assert.throws(() => assertSocketPathFits(tooDeep, 5433), (error) => error.code === 'DEMO_SOCKET_PATH_TOO_LONG');
});

test('a recording takes its two keys from the environment, else from .env if there is one, and nothing else', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'demo-fi-keys-'));
  const file = path.join(dir, '.env');
  assert.deepEqual(loadRecordKeys({}, file), [], 'no .env is fine');
  writeFileSync(file, 'OPENAI_API_KEY=from-file-openai\nANTHROPIC_API_KEY=from-file-anthropic\nOPENAI_MODEL=gpt-other\n');
  const env = { ANTHROPIC_API_KEY: 'from-env' };
  assert.deepEqual(loadRecordKeys(env, file), ['OPENAI_API_KEY']);
  assert.deepEqual(env, { ANTHROPIC_API_KEY: 'from-env', OPENAI_API_KEY: 'from-file-openai' });
});

test('a refused owner answer stops the demo by name', async () => {
  const client = { postJson: async () => ({ status: 409, text: '{"error":"ask already closed"}' }) };
  await assert.rejects(giveOwnerAnswer({ client, firmId: 'firm-demo-tilitoimisto', answer: { line: 'B17', ask_id: 'ask-1', reply: 'r' } }),
    (error) => error.code === 'DEMO_OWNER_ANSWER_REFUSED' && /B17/.test(error.message) && /HTTP 409/.test(error.message));
  const ok = { postJson: async () => ({ status: 200, text: '{}' }) };
  assert.equal((await giveOwnerAnswer({ client: ok, firmId: 'f', answer: { line: 'B17', ask_id: 'ask-1', reply: 'r' } })).http, 200);
});

test('a recording says which commit it was made on', () => {
  const on = recordedOn();
  assert.match(on.commit, /^[0-9a-f]{40}$/);
  assert.equal(typeof on.runtime_dirty, 'boolean');
  const file = JSON.parse(readFileSync(DEFAULT_RECORDINGS, 'utf8'));
  assert.match(String(file.recorded_on?.commit), /^[0-9a-f]{40}$/, 'the committed recordings name their commit');
});

test('a stand-in answers OpenAI requests only and names itself on the answer', async () => {
  const entries = [
    { lane: 'transaction_coding', provider: 'openai', provenance: 'scripted_stand_in' },
    { lane: 'document_routing', provider: 'openai', provenance: 'scripted_stand_in' },
    { lane: 'document_routing', provider: 'openai', provenance: 'live' },
    { lane: 'transaction_coding', provider: 'anthropic', provenance: 'live' }
  ];
  const lanes = standInLanesOf(entries);
  assert.deepEqual([...lanes], ['transaction_coding'], 'a lane with any live answer goes live');
  assert.equal(answersFromStandIn({ classified: { endpoint_class: 'openai', lane: 'transaction_coding' }, standInLanes: lanes }), true);
  assert.equal(answersFromStandIn({ classified: { endpoint_class: 'anthropic', lane: 'transaction_coding' }, standInLanes: lanes }), false, 'same lane name, other provider: never the stand-in');
  assert.equal(answersFromStandIn({ classified: { endpoint_class: 'anthropic', lane: 'x' }, standIn: 'openai' }), false);
  assert.equal(answersFromStandIn({ classified: { endpoint_class: 'openai', lane: 'document_routing' }, standInLanes: lanes }), false);
  const response = await answerOpenAiStandIn({ init: { body: JSON.stringify({ model: 'gpt-5.4', text: { format: { name: 'firm_fact_distillation' } } }) }, classified: { lane: 'memory_extraction' } });
  assert.equal((await response.json()).model, `${STAND_IN_MODEL_PREFIX}gpt-5.4`);
});

// ── With PostgreSQL ────────────────────────────────────────────────────────
const REFUSE_NETWORK = `
import net from 'node:net';
import tls from 'node:tls';
import { appendFileSync } from 'node:fs';
const LOG = process.env.DEMO_TEST_NETWORK_LOG;
const local = (o) => o.path || ['127.0.0.1', 'localhost', '::1', undefined, null, ''].includes(o.host);
const guard = (orig, mod) => function (...args) {
  const o = typeof args[0] === 'object' && args[0] !== null ? args[0] : { port: args[0], host: typeof args[1] === 'string' ? args[1] : undefined };
  if (!local(o)) { appendFileSync(LOG, JSON.stringify({ host: o.host, port: o.port }) + '\\n'); throw new Error('network refused by the demo test: ' + o.host); }
  return orig.apply(mod, args);
};
net.connect = net.createConnection = guard(net.connect, net);
tls.connect = guard(tls.connect, tls);
`;

const scratchDatabase = async (name) => {
  const admin = new pg.Client({ connectionString: PG });
  await admin.connect();
  await admin.query(`drop database if exists "${name}"`);
  // C collation, as the demo requires (demo_fi.mjs assertDemoCollation); CI's
  // server defaults to en_US.utf8.
  await admin.query(`create database "${name}" template template0 locale 'C'`);
  await admin.end();
  const url = new URL(PG);
  url.pathname = `/${name}`;
  return url.toString();
};
const dropDatabase = async (name) => {
  const admin = new pg.Client({ connectionString: PG });
  await admin.connect();
  await admin.query('select pg_terminate_backend(pid) from pg_stat_activity where datname = $1 and pid <> pg_backend_pid()', [name]);
  await admin.query(`drop database if exists "${name}"`);
  await admin.end();
};


// Every name a configuration reader on this machine might take a model id, a
// lane switch, an endpoint or a key from: the provider-key bridge's names and
// the `<cwd>/.env` fallbacks' names. The demo must use none of them.
const FAKE_SETTINGS = (compatibleBase) => ({
  OPENAI_API_KEY: 'sk-proj-fakefakefakefakefakefake0000', OPENAI_MODEL: 'gpt-fake-model', ANTHROPIC_API_KEY: 'sk-ant-fakefakefakefakefake0000', LOUIS_MODEL: 'claude-fake-model',
  TYPESAFE_API_KEY: 'typesafe_fakefakefakefakefake0000', TYPESAFE_MODEL: 'typesafe-fake-model',
  OPENAI_COMPATIBLE_API_KEY: 'tgp_v1_fakefakefakefakefake0000', OPENAI_COMPATIBLE_BASE_URL: compatibleBase, OPENAI_COMPATIBLE_MODEL: 'compatible-fake-model',
  MODEL_CHALLENGER_CAP_TOKENS: '999999999', JEV_SHADOW_SAMPLE_FRACTION: '1',
  BILL_EXTRACTOR_MODEL: 'fake', CLIENT_INTAKE_MODEL: 'fake', CONTRACT_EXTRACTOR_MODEL: 'fake', DOCUMENT_ROUTER_MODEL: 'fake', GENERIC_DOC_MODEL: 'fake',
  INTENT_COMPILER_MODEL: 'fake', INVOICE_EXTRACTOR_MODEL: 'fake', MERCHANT_LOOKUP_ENABLED: 'true', MERCHANT_LOOKUP_MODEL: 'fake', OPENAI_VISION_MODEL: 'fake',
  OPENAI_VISION_CACHE_DISABLED: 'true', OPENAI_VISION_CONCURRENCY: '9', OPENAI_VISION_PAGES_PER_CHUNK: '1', PAYOUT_EXTRACTOR_MODEL: 'fake', RECEIPT_CLASSIFIER_MODEL: 'fake',
  TRANSACTION_CHAT_MODEL: 'fake', DATABASE_URL: 'postgresql://nobody@127.0.0.1:1/elsewhere', POSTGRES_URL: 'postgresql://nobody@127.0.0.1:1/elsewhere',
  SUPABASE_URL: 'http://127.0.0.1:1', SUPABASE_SERVICE_ROLE_KEY: 'fake-service-role', DATABASE_POOL_MAX: '1', INNGEST_PARSE_CONCURRENCY: '9'
});
const dotEnvText = (vars) => `${Object.entries(vars).map(([k, v]) => `${k}=${v}`).join('\n')}\n`;

// `relative: true` runs the child in its own folder and names the report
// (and any --trace=NAME given) relative to it, as a person would.
const runDemoChild = (args, { timeoutMs = 900_000, cwd: givenCwd = null, env: extraEnv = {}, relative = false } = {}) => new Promise((resolve) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'demo-fi-test-'));
  const cwd = relative ? dir : givenCwd || ROOT;
  const preload = path.join(dir, 'refuse-network.mjs');
  const networkLog = path.join(dir, 'network.jsonl');
  writeFileSync(preload, REFUSE_NETWORK);
  writeFileSync(networkLog, '');
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/(_API_KEY|_PROXY|^NODE_USE_ENV_PROXY|_BASE_URL)$/i.test(k) && !/proxy/i.test(k)));
  Object.assign(env, {
    TZ: 'UTC',
    DEMO_TEST_NETWORK_LOG: networkLog,
    // A working tree under test is not a release build; the identity the
    // appliance harness stages for the same reason.
    DONNA_BUILD_COMMIT_SHA: 'demo-fi-test',
    DONNA_BUILD_DIRTY: 'false',
    DONNA_RUNTIME_BUILD_DIRTY: 'false'
  }, extraEnv);
  const report = path.join(dir, 'report.json');
  const child = spawn(process.execPath, ['--import', preload, path.join(ROOT, 'scripts', 'demo_fi.mjs'), ...args, relative ? '--report=report.json' : `--report=${report}`], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (c) => { out = (out + c).slice(-40000); });
  child.stderr.on('data', (c) => { out = (out + c).slice(-40000); });
  const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
  child.on('exit', (code) => {
    clearTimeout(timer);
    resolve({ code, out, dir, report: existsSync(report) ? JSON.parse(readFileSync(report, 'utf8')) : null, network: readFileSync(networkLog, 'utf8').split('\n').filter(Boolean) });
  });
});

// The month's end state, read from the stored rows (demo_fi.mjs
// readDemoEndState). A change here is a change in what the demo shows.
const PINNED_END_STATE = Object.freeze({
  journals: [
    {status: 'posted', n: 19}
  ],
  transactions_by_state: [
    {coding_state: 'applied', convergence_state: 'hanging', n: 4},
    {coding_state: 'asked', convergence_state: 'on_owner', n: 8},
    {coding_state: 'posted', convergence_state: 'auto_reconciled', n: 19},
    {coding_state: 'proposed', convergence_state: 'hanging', n: 5}
  ],
  documents_by_state: [
    {parse_status: 'completed', convergence_state: 'auto_reconciled', n: 1},
    {parse_status: 'completed', convergence_state: 'on_owner', n: 1},
    {parse_status: 'completed', convergence_state: null, n: 25}
  ],
  matches_by_status: [
    {status: 'auto_matched', n: 25},
    {status: 'suggested', n: 3}
  ],
  asks_by_status: [
    {status: 'draft', n: 9},
    {status: 'replied', n: 5},
    {status: 'resolved', n: 3}
  ],
  vat_lines: [
    {tax_type: 'ALV_25_5_INPUT', n: 4},
    {tax_type: 'ALV_25_5_OUTPUT', n: 4},
    {tax_type: 'ALV_EU_ACQUISITION', n: 1},
    {tax_type: 'ALV_EU_SERVICE_ACQUISITION', n: 2},
    {tax_type: 'ALV_EXEMPT', n: 3},
    {tax_type: 'ALV_NONDEDUCTIBLE_INPUT', n: 1},
    {tax_type: 'ALV_OUT_OF_SCOPE', n: 4},
    {tax_type: 'NONE', n: 31}
  ],
  models: [
    {model: 'scripted-stand-in-for-gpt-5.4+replayed'}
  ]
});

test('the recorded month replays as a verify pass to its pinned books, sealed from the machine\'s settings, with the network refused', { skip: PG ? false : 'DONNA_PG_TEST_URL not set', timeout: 1_200_000 }, async () => {
  const name = `donna_demo_replay_${process.pid}`;
  const url = await scratchDatabase(name);
  // A loopback "compatible endpoint" that counts what reaches it: the fake
  // settings point the challenger lane at it.
  let compatibleHits = 0;
  const compatible = http.createServer((req, res) => { compatibleHits += 1; res.writeHead(500); res.end(); });
  await new Promise((resolve) => compatible.listen(0, '127.0.0.1', resolve));
  const fakes = FAKE_SETTINGS(`http://127.0.0.1:${compatible.address().port}/v1`);
  const cwd = mkdtempSync(path.join(os.tmpdir(), 'demo-fi-cwd-'));
  const home = mkdtempSync(path.join(os.tmpdir(), 'demo-fi-home-'));
  writeFileSync(path.join(cwd, '.env'), dotEnvText(fakes));
  writeFileSync(path.join(cwd, '.env.local'), dotEnvText(fakes));
  mkdirSync(path.join(home, '.config', 'donna'), { recursive: true });
  writeFileSync(path.join(home, '.config', 'donna', 'providers.env'), dotEnvText(fakes));
  try {
    const started = Date.now();
    // The fakes are in the environment too: the seal drops them there as well.
    // And a person in Helsinki: local time zone and Finnish locale. The seal
    // fixes both, so the month asks what it asked where it was recorded.
    const run = await runDemoChild([`--database-url=${url}`, '--verify', '--quiet'], {
      cwd, env: { ...fakes, HOME: home, TZ: 'Europe/Helsinki', LANG: 'fi_FI.UTF-8', LC_ALL: 'fi_FI.UTF-8', LC_TIME: 'fi_FI.UTF-8', LC_NUMERIC: 'fi_FI.UTF-8' }
    });
    assert.equal(run.code, 0, `the replay demo failed — if a request has no recording, re-record with \`${RERECORD_COMMAND}\`:\n${run.out.slice(-8000)}`);
    const { report } = run;
    assert.deepEqual(report.provider.unrecorded, [], 'every request the code made was recorded');
    assert.deepEqual(report.provider.unused, [], 'every recorded answer was asked for');
    assert.deepEqual(report.provider.overserved, [], 'no request was asked more often than recorded');
    assert.ok(report.provider.served > 0);
    // The only other outside requests are the coder's merchant-website
    // lookups (transactionLlm.js merchantWebContextFor, a domain read from the
    // bank text). The demo refuses them before any socket, exactly as the
    // recording run did, so both runs code without web context.
    for (const refused of report.provider.network_refused) {
      assert.ok(!/(^|\.)(openai|anthropic|typesafe|together)\./.test(refused.host || ''), `a provider host was refused: ${refused.host}`);
    }
    assert.deepEqual(run.network, [], 'no socket left this machine');
    assert.equal(compatibleHits, 0, 'the fake compatible endpoint was never called');
    assert.doesNotMatch(run.out, /fake-model|provider keys loaded from repo \.env|typesafe LIT/, 'no fake setting reached the runtime');
    assert.match(run.out, /typesafe DARK/);
    assert.equal(report.at_rest, true);
    // The owner's six answers, each accepted by the reply route.
    assert.deepEqual(report.answered.map((a) => [a.line, a.http]).sort(), [['B17', 200], ['B22', 200], ['B25', 200], ['B28', 200], ['B30', 200], ['B31', 200]]);
    assert.deepEqual({ ...report.end_state, models: undefined }, { ...PINNED_END_STATE, models: undefined });
    assert.ok(report.end_state.models.length > 0, 'the coded lines name their models');
    for (const { model } of report.end_state.models) {
      assert.ok(model.endsWith(REPLAYED_MODEL_SUFFIX), `${model}: marked replayed`);
    }
    assert.deepEqual(report.end_state.models.map((m) => m.model), PINNED_END_STATE.models.map((m) => m.model));
    console.log(`replay month: ${Math.round((Date.now() - started) / 1000)} s, ${report.provider.served} answers served`);
    const db = new pg.Client({ connectionString: url });
    await db.connect();
    try {
      const sessions = (await db.query('select scope_client_id as client_id, recorded_answers from provider_replay_sessions')).rows;
      assert.equal(sessions.length, 1, 'the stored record behind the on-screen notice');
      assert.equal(sessions[0].client_id, 'kampaamo-kultalanka-oy');
      // Host A's lane inventory, as persisted, says the lanes were served by replay.
      const routes = (await db.query(`select c as detail from runtime_host_readiness_attempts a,
          jsonb_path_query(a.certificate, '$.checks[*] ? (@.id == "model_routes").detail') c order by a.id desc limit 1`)).rows[0]?.detail;
      assert.equal(routes?.provider_replay?.pack, 'fi-kultalanka-2025-02');
      assert.ok(routes.lanes.length > 0, 'Host A lists the lanes');
      assert.ok(routes.lanes.every((lane) => lane.served_by === 'replay'));
      // Every receipt that names a model from a reconciliation answer is marked.
      const evaluations = (await db.query("select count(*) filter (where model like '%+replayed')::int as marked, count(*)::int as all from reconciliation_evaluations where model is not null")).rows[0];
      assert.ok(evaluations.all > 0);
      assert.equal(evaluations.marked, evaluations.all);
    } finally {
      await db.end();
    }
  } finally {
    compatible.close();
    await dropDatabase(name);
  }
});

const catalogueOf = async (url) => {
  const db = new pg.Client({ connectionString: url });
  await db.connect();
  try {
    return JSON.stringify({
      schemas: (await db.query("select nspname from pg_namespace where nspname not like 'pg\\_%' and nspname <> 'information_schema' order by 1")).rows,
      tables: (await db.query("select table_schema, table_name, table_type from information_schema.tables where table_schema not in ('pg_catalog', 'information_schema') order by 1, 2")).rows,
      columns: (await db.query("select table_schema, table_name, column_name, data_type from information_schema.columns where table_schema not in ('pg_catalog', 'information_schema') order by 1, 2, 3")).rows,
      ledger: (await db.query("select to_regclass('public.schema_migrations') is not null as present")).rows,
      firms: (await db.query('select * from firms order by id')).rows
    });
  } finally {
    await db.end();
  }
};

test('a book holding another firm is refused before the demo writes anything: no schema, no migration', { skip: PG ? false : 'DONNA_PG_TEST_URL not set', timeout: 300_000 }, async () => {
  const name = `donna_demo_foreign_${process.pid}`;
  const url = await scratchDatabase(name);
  try {
    const db = new pg.Client({ connectionString: url });
    await db.connect();
    try {
      // Someone else's book, not migrated by Donna's ledger.
      await db.query("create table firms (id text primary key, name text); create table clients (id text primary key, firm_id text); insert into firms values ('firm-someone-else', 'Someone Else Oy')");
    } finally {
      await db.end();
    }
    const before = await catalogueOf(url);
    const run = await runDemoChild([`--database-url=${url}`, '--exit-at-rest', '--no-web', '--quiet'], { timeoutMs: 240_000 });
    assert.equal(run.code, 3, run.out.slice(-3000));
    assert.match(run.out, /PROVIDER_REPLAY_FOREIGN_BOOK/);
    assert.match(run.out, /firm firm-someone-else/);
    assert.doesNotMatch(run.out, /applying migrations/);
    assert.equal(await catalogueOf(url), before, 'byte for byte the same catalogue: no storage schema, no migration ledger, no table, no row');
  } finally {
    await dropDatabase(name);
  }
});

test('a recording pass whose next live call would pass the cap makes no call and writes no file', { skip: PG ? false : 'DONNA_PG_TEST_URL not set', timeout: 1_200_000 }, async () => {
  const name = `donna_demo_cap_${process.pid}`;
  const url = await scratchDatabase(name);
  const dir = mkdtempSync(path.join(os.tmpdir(), 'demo-fi-cap-'));
  const file = path.join(dir, 'recordings.json');
  // The committed recordings with one live answer taken out: the fill must
  // ask for it live.
  const raw = JSON.parse(readFileSync(DEFAULT_RECORDINGS, 'utf8'));
  const unpacked = unpackRecordings(raw);
  const dropped = unpacked.entries.find((entry) => entry.provenance === 'live' && entry.lane === 'unified_extraction');
  assert.ok(dropped, 'a live answer to take out');
  writeFileSync(file, `${JSON.stringify(packRecordings({ ...unpacked, entries: unpacked.entries.filter((entry) => entry !== dropped) }), null, 1)}\n`);
  const bytes = readFileSync(file);
  try {
    const run = await runDemoChild([`--database-url=${url}`, '--record', '--fill', '--exit-at-rest', '--no-web', '--quiet', `--recordings=${file}`, '--cap-usd=0.01'],
      { env: { ANTHROPIC_API_KEY: 'not-a-key-the-cap-stops-first' }, relative: true });
    assert.ok(run.report, 'a relative --report lands in the caller\'s folder');
    assert.ok(existsSync(path.join(run.dir, 'report.json.spend.json')), 'and so does its spend sidecar');
    assert.notEqual(run.code, 0, run.out.slice(-4000));
    assert.match(run.out, /DEMO_RECORDING_INCOMPLETE: demo record: no recordings written — \d+ request\(s\) ended the pass with no kept answer \(unified_extraction threw_TypeError.*live calls stopped: cap at unified_extraction/);
    assert.equal(run.report.provider.spend.live_calls, 0);
    assert.equal(run.report.provider.spend.stopped.reason, 'cap');
    // The request the cap refused ended the pass with no answer: a hole.
    assert.ok(run.report.provider.unanswered.some((hole) => hole.lane === 'unified_extraction' && /^threw_/.test(hole.last)));
    assert.equal(run.report.recordings.written, false);
    assert.deepEqual(run.network, [], 'no live call was made');
    assert.ok(readFileSync(file).equals(bytes), 'the recordings file is unchanged');
  } finally {
    await dropDatabase(name);
  }
});

test('a verify pass fails on a recorded answer nobody asked for, and on a request asked more often than recorded', { skip: PG ? false : 'DONNA_PG_TEST_URL not set', timeout: 1_200_000 }, async () => {
  const name = `donna_demo_unused_${process.pid}`;
  const url = await scratchDatabase(name);
  const dir = mkdtempSync(path.join(os.tmpdir(), 'demo-fi-unused-'));
  const file = path.join(dir, 'recordings.json');
  const unpacked = unpackRecordings(JSON.parse(readFileSync(DEFAULT_RECORDINGS, 'utf8')));
  // One answer more than the month asks for (a second answer to a request
  // made once), and one fewer (a request made twice, recorded once).
  const extra = unpacked.entries.find((entry) => entry.lane === 'reconciliation_reasoning' && entry.responses.length === 1);
  const short = unpacked.entries.find((entry) => entry.responses.length === 2);
  assert.ok(extra && short);
  const entries = unpacked.entries.map((entry) => (entry === extra ? { ...entry, responses: [...entry.responses, entry.responses[0]] }
    : entry === short ? { ...entry, responses: entry.responses.slice(0, 1) } : entry));
  writeFileSync(file, `${JSON.stringify(packRecordings({ ...unpacked, entries }), null, 1)}\n`);
  try {
    const run = await runDemoChild([`--database-url=${url}`, '--verify', '--quiet', `--recordings=${file}`, '--trace=trace.jsonl'], { relative: true });
    assert.equal(run.code, 1, run.out.slice(-4000));
    assert.match(run.out, /DEMO_VERIFY_MISMATCH/);
    assert.match(run.out, /recorded answers never asked for: reconciliation_reasoning 1/);
    assert.match(run.out, new RegExp(`requests asked more often than recorded: ${short.lane} 1`));
    assert.deepEqual(run.report.provider.unrecorded, []);
    assert.deepEqual(run.report.provider.unused.map((u) => [u.key, u.recorded, u.served]), [[extra.key, 2, 1]]);
    assert.deepEqual(run.report.provider.overserved.map((u) => [u.key, u.recorded, u.served]), [[short.key, 1, 2]]);
    // A relative --trace lands in the caller's folder too.
    assert.ok(readFileSync(path.join(run.dir, 'trace.jsonl'), 'utf8').split('\n').filter(Boolean).length >= run.report.provider.served);
  } finally {
    await dropDatabase(name);
  }
});

// No database is reached by these two: each is refused before.
test('replay refuses a --hold its recordings were not made with, by name, before any database', { timeout: 120_000 }, async () => {
  const run = await runDemoChild(['--database-url=postgresql://nobody@127.0.0.1:1/none', '--exit-at-rest', '--no-web', '--quiet', '--hold=23 Kuitti.pdf']);
  assert.equal(run.code, 1, run.out.slice(-3000));
  assert.match(run.out, /DEMO_HOLD_NOT_RECORDED: demo: these recordings were made with every document loaded \(nothing held back\); holding back "23 Kuitti.pdf"/);
});

test('an uncommitted runtime is refused up front with the remedy, before any database', { timeout: 120_000 }, async () => {
  const run = await runDemoChild(['--database-url=postgresql://nobody@127.0.0.1:1/none', '--exit-at-rest', '--no-web', '--quiet'],
    { env: { DONNA_BUILD_DIRTY: 'true', DONNA_RUNTIME_BUILD_DIRTY: 'true' } });
  assert.equal(run.code, 1, run.out.slice(-3000));
  assert.match(run.out, /DEMO_UNCOMMITTED_RUNTIME: demo: this checkout has uncommitted changes to the runtime \(.*\)\. Host A does not start the scheduler on an uncommitted runtime build \(source_build: dirty_runtime_build\), so the month would not run\. Commit the change \(a work-in-progress commit on your branch is fine\), then run `npm run demo:fi` again\./);
});

// initdb refuses to run as root, so this one needs an ordinary user.
const AS_ROOT = typeof process.getuid === 'function' && process.getuid() === 0;
const { findPgBin } = await import('../server/donna/desktop/pgSupervisor.js');
const NO_PG_BINARIES = (() => { try { findPgBin(); return false; } catch { return true; } })();
const OWN_PG_SKIP = AS_ROOT ? 'initdb cannot run as root' : NO_PG_BINARIES ? 'no PostgreSQL 16 binaries on this machine (PG_BIN)' : false;
test('--data-dir: a folder holding another firm\'s book is refused, its catalogue and rows unchanged, its running server left running', { skip: OWN_PG_SKIP, timeout: 600_000 }, async () => {
  const { ensureLocalPostgres } = await import('../server/donna/desktop/pgSupervisor.js');
  const dataDir = mkdtempSync(path.join(os.tmpdir(), 'dfb-'));
  const pgPort = 15400 + (process.pid % 500);
  const prior = { LC_ALL: process.env.LC_ALL, LANG: process.env.LANG };
  process.env.LC_ALL = 'C'; process.env.LANG = 'C';
  let handle;
  try {
    handle = ensureLocalPostgres({ dataDir, pgPort, logger: { log: () => {}, error: () => {} } });
  } finally {
    for (const [k, v] of Object.entries(prior)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
  try {
    const db = new pg.Client({ connectionString: handle.databaseUrl });
    await db.connect();
    try {
      await db.query("create table firms (id text primary key, name text); create table clients (id text primary key, firm_id text); insert into firms values ('firm-someone-else', 'Someone Else Oy')");
    } finally {
      await db.end();
    }
    const before = await catalogueOf(handle.databaseUrl);
    const run = await runDemoChild([`--data-dir=${dataDir}`, '--exit-at-rest', '--no-web', '--quiet'], { timeoutMs: 240_000, env: { DONNA_DESKTOP_PG_PORT: String(pgPort) } });
    assert.equal(run.code, 3, run.out.slice(-3000));
    assert.match(run.out, /attaching to the postgres already running/);
    assert.match(run.out, /PROVIDER_REPLAY_FOREIGN_BOOK/);
    assert.match(run.out, /leaving the attached postgres running/);
    assert.equal(await catalogueOf(handle.databaseUrl), before, 'catalogue and rows unchanged');
    const { execFileSync } = await import('node:child_process');
    assert.match(execFileSync(path.join(handle.pgBin, 'pg_ctl'), ['-D', handle.pgData, 'status'], { encoding: 'utf8' }), /server is running/);
  } finally {
    handle.stop();
  }
});

// The fixed-locale re-run: killed outright, the parent leaves nothing behind.
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const waitFor = async (fn, ms) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await new Promise((r) => setTimeout(r, 200)); } return fn(); };
const startReRun = (args, env = {}) => {
  const child = spawn(process.execPath, [path.join(ROOT, 'scripts', 'demo_fi.mjs'), ...args], {
    cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !/_API_KEY$/.test(k))), TZ: 'Europe/Helsinki', LANG: 'fi_FI.UTF-8', LC_ALL: 'fi_FI.UTF-8',
      DONNA_BUILD_COMMIT_SHA: 'demo-fi-test', DONNA_BUILD_DIRTY: 'false', DONNA_RUNTIME_BUILD_DIRTY: 'false', ...env }
  });
  let out = '';
  child.stdout.on('data', (c) => { out += c; });
  child.stderr.on('data', (c) => { out += c; });
  return { child, out: () => out };
};

test('the fixed-locale re-run: a parent killed with SIGKILL leaves no demo process behind', { skip: PG ? false : 'DONNA_PG_TEST_URL not set', timeout: 300_000 }, async () => {
  const name = `donna_demo_orphan_${process.pid}`;
  const url = await scratchDatabase(name);
  try {
    const run = startReRun([`--database-url=${url}`, '--exit-at-rest', '--no-web', '--quiet', '--port=8796']);
    assert.ok(await waitFor(() => /running as process \d+/.test(run.out()) && /applying migrations|replay: /.test(run.out()), 60_000), run.out().slice(-2000));
    const childPid = Number(/running as process (\d+)/.exec(run.out())[1]);
    assert.ok(alive(childPid));
    run.child.kill('SIGKILL');
    assert.ok(await waitFor(() => !alive(childPid), 15_000), `the re-run child ${childPid} is still running after its parent was killed`);
  } finally {
    await dropDatabase(name);
  }
});

test('the fixed-locale re-run on its own data folder: a parent killed with SIGKILL leaves no PostgreSQL behind', { skip: OWN_PG_SKIP, timeout: 300_000 }, async () => {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), 'dok-'));
  const pgPort = 15900 + (process.pid % 500);
  const run = startReRun([`--data-dir=${dataDir}`, '--exit-at-rest', '--no-web', '--quiet', '--port=8795'], { DONNA_DESKTOP_PG_PORT: String(pgPort) });
  const pgData = path.join(dataDir, 'database', 'pg');
  assert.ok(await waitFor(() => /applying migrations/.test(run.out()), 120_000), run.out().slice(-2000));
  const childPid = Number(/running as process (\d+)/.exec(run.out())[1]);
  const pgPid = Number(readFileSync(path.join(pgData, 'postmaster.pid'), 'utf8').split('\n')[0]);
  assert.ok(alive(pgPid));
  run.child.kill('SIGKILL');
  assert.ok(await waitFor(() => !alive(childPid) && !alive(pgPid), 30_000), `left running: ${[!alive(childPid) ? null : `demo ${childPid}`, !alive(pgPid) ? null : `postgres ${pgPid}`].filter(Boolean).join(', ')}`);
});
