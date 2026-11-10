// The zero-key demo (scripts/demo_fi.mjs) and its committed recordings.
//
// Without a database: the recordings carry no secret-shaped string, load and
// re-hash, stay small, and a changed prompt is refused with the re-record
// command; the scope guard refuses a foreign book.
// With DONNA_PG_TEST_URL: the whole month replays, in a child process with
// every provider key unset and the network refused, to coded and reconciled
// books — so the recordings cannot drift from what the code asks for without
// this test failing — and replay refuses to start on a book holding another
// company.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, statSync, writeFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

import { DEFAULT_RECORDINGS, RERECORD_COMMAND, assertDemoBookOnly, answerFor, loadReplayRecordings, parseDemoArgs } from './demo_fi.mjs';
import { PROVIDER_REPLAY_CODES, findSecretShapes, installProviderReplay } from '../server/donna/providerReplay.js';

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
      assert.equal(typeof response.body?.model, 'string', `${entry.key}: the recorded model id`);
      assert.ok(!('user' in response.body) && !('organization' in response.body), `${entry.key}: no account field`);
    }
  }
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
  const fakeQuery = (rows) => async (sql) => ({ rows: /from firms/.test(sql) ? rows.firms : rows.clients });
  await assertDemoBookOnly({ query: fakeQuery({ firms: [], clients: [] }), clientId: 'kampaamo-kultalanka-oy' });
  await assert.rejects(
    assertDemoBookOnly({ query: fakeQuery({ firms: [], clients: [{ id: 'acme-oy', firm_id: 'firm-demo-tilitoimisto' }] }), clientId: 'kampaamo-kultalanka-oy' }),
    (error) => error.code === PROVIDER_REPLAY_CODES.FOREIGN_BOOK && /company acme-oy/.test(error.message)
  );
  await assert.rejects(
    assertDemoBookOnly({ query: fakeQuery({ firms: [{ id: 'real-firm' }], clients: [] }), clientId: 'kampaamo-kultalanka-oy' }),
    (error) => error.code === PROVIDER_REPLAY_CODES.FOREIGN_BOOK && /firm real-firm/.test(error.message)
  );
});

test('owner answers are matched to their statement line by date, amount and direction', () => {
  const answers = { by_statement_line: { B25: { date: '2025-02-21', amount: 28.6, direction: 'out', reply: 'r' } } };
  assert.equal(answerFor({ ask: { id: 'a1' }, transaction: { transaction_date: '2025-02-21', money_out: '28.60', money_in: '0' }, answers })?.line, 'B25');
  assert.equal(answerFor({ ask: { id: 'a1' }, transaction: { transaction_date: '2025-02-21', money_out: '0', money_in: '28.60' }, answers }), null);
  assert.equal(answerFor({ ask: { id: 'a1' }, transaction: null, answers }), null);
});

test('replay is entered by the command only', () => {
  assert.equal(parseDemoArgs([]).record, false);
  assert.throws(() => parseDemoArgs(['--stand-in=openai']), /only for --record/);
  assert.throws(() => parseDemoArgs(['--replay=off']), /unknown argument/);
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
  await admin.query(`create database "${name}"`);
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

const runDemoChild = (args, { timeoutMs = 900_000 } = {}) => new Promise((resolve) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'demo-fi-test-'));
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
  });
  const report = path.join(dir, 'report.json');
  const child = spawn(process.execPath, ['--import', preload, path.join(ROOT, 'scripts', 'demo_fi.mjs'), ...args, `--report=${report}`], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (c) => { out = (out + c).slice(-20000); });
  child.stderr.on('data', (c) => { out = (out + c).slice(-20000); });
  const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
  child.on('exit', (code) => {
    clearTimeout(timer);
    resolve({ code, out, report: existsSync(report) ? JSON.parse(readFileSync(report, 'utf8')) : null, network: readFileSync(networkLog, 'utf8').split('\n').filter(Boolean) });
  });
});

test('the recorded month replays to coded and reconciled books with no key and the network refused', { skip: PG ? false : 'DONNA_PG_TEST_URL not set', timeout: 1_200_000 }, async () => {
  const name = `donna_demo_replay_${process.pid}`;
  const url = await scratchDatabase(name);
  try {
    const started = Date.now();
    const run = await runDemoChild([`--database-url=${url}`, '--exit-at-rest', '--no-web', '--quiet']);
    assert.equal(run.code, 0, `the replay demo failed — if a request has no recording, re-record with \`${RERECORD_COMMAND}\`:\n${run.out.slice(-6000)}`);
    const { report } = run;
    assert.deepEqual(report.provider.unrecorded, [], 'every request the code made was recorded');
    // The only other outside requests are the coder's merchant-website
    // lookups (transactionLlm.js merchantWebContextFor, a domain read from the
    // bank text). The demo refuses them before any socket, exactly as the
    // recording run did, so both runs code without web context.
    for (const refused of report.provider.network_refused) {
      assert.ok(!/(^|\.)(openai|anthropic|typesafe|together)\./.test(refused.host || ''), `a provider host was refused: ${refused.host}`);
    }
    assert.deepEqual(run.network, [], 'no socket left this machine');
    assert.equal(report.at_rest, true);
    const posted = report.end_state.journals.find((row) => row.status === 'posted')?.n || 0;
    assert.ok(posted > 0, 'journals were posted');
    assert.ok(report.end_state.vat_lines.some((row) => /^ALV_/.test(row.tax_type)), 'posted lines carry ALV codes');
    assert.ok(report.end_state.models.every((row) => row.model.endsWith('+replayed')), 'every model on a coded line is marked replayed');
    console.log(`replay month: ${Math.round((Date.now() - started) / 1000)} s, ${report.provider.served} answers served, ${posted} journals posted`);
    const db = new pg.Client({ connectionString: url });
    await db.connect();
    try {
      const sessions = (await db.query('select scope_client_id as client_id, recorded_answers from provider_replay_sessions')).rows;
      assert.equal(sessions.length, 1, 'the stored record behind the on-screen notice');
      assert.equal(sessions[0].client_id, 'kampaamo-kultalanka-oy');
    } finally {
      await db.end();
    }
  } finally {
    await dropDatabase(name);
  }
});

test('replay refuses to start on a book that holds another company, before any answer is served', { skip: PG ? false : 'DONNA_PG_TEST_URL not set', timeout: 300_000 }, async () => {
  const name = `donna_demo_foreign_${process.pid}`;
  const url = await scratchDatabase(name);
  try {
    const db = new pg.Client({ connectionString: url });
    await db.connect();
    try {
      await db.query(`create schema if not exists storage;
        create table if not exists storage.buckets (id text primary key, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]);
        create table if not exists storage.objects (id uuid default gen_random_uuid() primary key, bucket_id text references storage.buckets(id), name text, metadata jsonb);`);
    } finally {
      await db.end();
    }
    const { execFileSync } = await import('node:child_process');
    execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'migrate_firm_db.js')], { cwd: ROOT, env: { ...process.env, DATABASE_URL: url }, stdio: 'ignore' });
    const seeded = new pg.Client({ connectionString: url });
    await seeded.connect();
    try {
      await seeded.query("insert into firms (id, name, slug) values ('firm-someone-else', 'Someone Else Oy', 'someone-else')");
    } finally {
      await seeded.end();
    }
    const run = await runDemoChild([`--database-url=${url}`, '--exit-at-rest', '--no-web', '--quiet'], { timeoutMs: 240_000 });
    assert.equal(run.code, 3, run.out.slice(-3000));
    assert.match(run.out, /PROVIDER_REPLAY_FOREIGN_BOOK/);
    assert.match(run.out, /firm firm-someone-else/);
    const check = new pg.Client({ connectionString: url });
    await check.connect();
    try {
      assert.equal((await check.query('select count(*)::int as n from provider_replay_sessions')).rows[0].n, 0, 'no replay session was opened');
      assert.equal((await check.query('select count(*)::int as n from clients')).rows[0].n, 0, 'nothing was written into the book');
    } finally {
      await check.end();
    }
  } finally {
    await dropDatabase(name);
  }
});
