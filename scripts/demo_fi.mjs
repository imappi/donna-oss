#!/usr/bin/env node
// The zero-key demo: Kampaamo Kultalanka Oy's February 2025, read, coded,
// matched and answered on this machine with no provider key, from RECORDED
// model outputs (README.md, "Run Donna locally").
//
//   npm run demo:fi                 replay (no key needed, no network call)
//   npm run demo:fi:record          re-record the outputs from live models
//
// One process does what the README's three commands do, plus the rest:
//   1. its own PostgreSQL in its own data folder (~/.donna-demo; the book
//      `npm run local:runtime` uses is never touched), migrations applied;
//   2. the runtime (createDonnaRuntimeServer, the assembly the desktop shell
//      and `npm run local:runtime` boot) and the web app on 127.0.0.1;
//   3. the demo firm and company and all 26 documents of the month, through
//      the runtime's own routes (scripts/load_finnish_demo.mjs);
//   4. the scheduler's work, run to rest in rounds (desktop/manifestTicker.js:
//      the runtime's own scheduler is stopped and the same manifest is
//      dispatched on a virtual clock, five minutes a round, so the hourly
//      sweeps come due in seconds; production timing is not changed);
//   5. the owner's answers (scripts/fixtures/fi_kultalanka_month_facts.json,
//      `owner_answers`) given through the reply route, then rest again;
//   6. a summary read from the stored rows, and the book left up to look at,
//      still ticking, so a receipt uploaded in the web app is read, coded and
//      matched within seconds. Ctrl-C stops it.
//
// REPLAY IS ENTERED ONLY HERE. Nothing in the runtime switches it on: no
// environment variable, no missing key. This command installs the replay
// seam (server/donna/providerReplay.js) on the process's `fetch` before any
// runtime module loads, and it is the only caller that does.
//
// GUARDS. Replay serves the demo book only: the command refuses to start when
// the database holds any firm but the demo firm or any company but the demo
// company (PROVIDER_REPLAY_FOREIGN_BOOK), and the seam re-reads the book
// before every answer it serves, so a company created in the web app during
// the demo stops replay instead of receiving a recorded answer. Provider keys
// in the environment or in .env are replaced in this process by a placeholder
// that is not a key (providerReplay.js REPLAY_PLACEHOLDER_KEY); every
// non-loopback request is refused.
//
// Options:
//   --data-dir=DIR        the demo's own data folder (default ~/.donna-demo)
//   --database-url=URL    use an existing, empty PostgreSQL database instead
//                         (tests and recording; the same guards apply)
//   --port=N --web-port=N runtime and web ports (default 8787 / 5173, or
//                         DONNA_DESKTOP_PORT / DONNA_LOCAL_WEB_PORT); the web
//                         app listens on DONNA_LOCAL_WEB_HOST (default
//                         127.0.0.1), as scripts/local_web.mjs does
//   --hold=FILE           leave one document out, to upload it by hand
//   --exit-at-rest        stop once the book is at rest (tests, recording)
//   --no-web              do not serve the web app
//   --quiet               keep the runtime's own log out of the terminal
//   --report=FILE         write the end-state summary as JSON
//   --trace=FILE          replay: write every normalized request (served or
//                         not) as JSON lines, to diff two runs
//   --recordings=FILE     the recordings (default data/demo-replay/…)
//   --record              re-record: live provider calls, keys from the
//                         environment, written to --recordings. Alone (as
//                         `npm run demo:fi:record`) it runs the live pass,
//                         fill passes until one needs nothing new, and a
//                         replay with no key to verify; with --exit-at-rest
//                         it is one pass
//   --cap-usd=N           with --record: stop live calls past N USD (default 20),
//                         priced from the facts file's `prices`
//   --fill                with --record: start from the existing --recordings,
//                         answer what they hold from them, call live only for
//                         what they miss, and write the union (one pass of
//                         the re-record loop, scripts/demo_fi_record.mjs)
//   --stand-in=openai     with --record: answer the OpenAI lanes from the
//                         scripted stand-in (scripts/demo_fi_stand_ins.mjs)
//                         instead of the network

import { randomBytes } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  PROVIDER_REPLAY_CODES,
  PROVIDER_REPLAY_FORMAT,
  PROVIDER_REQUEST_IDENTITY_VERSION,
  ProviderReplayError,
  REPLAY_PLACEHOLDER_KEY,
  REPLAY_PROVIDER_KEY_ENV,
  findSecretShapes,
  installProviderRecorder,
  installProviderReplay,
  packRecordings,
  recordedModels,
  recordedResponseFor,
  recordingsDigest,
  unpackRecordings
} from '../server/donna/providerReplay.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_RECORDINGS = path.join(ROOT, 'data', 'demo-replay', 'fi-kultalanka-2025-02.json');
export const FACTS_FILE = path.join(ROOT, 'scripts', 'fixtures', 'fi_kultalanka_month_facts.json');
export const DEMO_FIRM_ID = 'firm-demo-tilitoimisto';
export const RERECORD_COMMAND = 'npm run demo:fi:record';
export const SETTLE = Object.freeze({ advance_ms: 300_000, quiet_rounds: 3, max_rounds: 48 });
export const ANSWER_ROUNDS = 4;
// Daily backup packages are the one sweep a fast clock would multiply on disk;
// a demo book needs none. Everything else in the manifest runs.
const VIRTUAL_CLOCK_SKIP = new Set(['desktop-backup-daily']);

const log = (line) => console.log(`[demo] ${line}`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export const parseDemoArgs = (argv) => {
  const out = { record: false, exitAtRest: false };
  for (const arg of argv) {
    if (arg === '--record') out.record = true;
    else if (arg === '--fill') out.fill = true;
    else if (arg === '--no-web') out.noWeb = true;
    else if (arg === '--quiet') out.quietRuntime = true;
    else if (arg === '--exit-at-rest') out.exitAtRest = true;
    else {
      const m = /^--(data-dir|database-url|port|web-port|hold|report|recordings|stand-in|cap-usd|trace)=(.+)$/.exec(arg);
      if (!m) throw new Error(`unknown argument ${arg}`);
      out[m[1].replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = m[2];
    }
  }
  if (out.standIn && (!out.record || out.standIn !== 'openai')) throw new Error('--stand-in=openai is only for --record');
  if (out.fill && !out.record) throw new Error('--fill is only for --record');
  return out;
};

// The book the replay may serve: no firm but the demo firm, no company but
// the demo company. `query` reads the runtime's database.
export const assertDemoBookOnly = async ({ query, clientId, firmId = DEMO_FIRM_ID }) => {
  const foreignFirms = (await query('select id from firms where id <> $1 order by id limit 5', [firmId])).rows;
  const foreignClients = (await query('select id, firm_id from clients where id <> $1 or firm_id <> $2 order by id limit 5', [clientId, firmId])).rows;
  if (foreignFirms.length || foreignClients.length) {
    throw new ProviderReplayError({
      code: PROVIDER_REPLAY_CODES.FOREIGN_BOOK,
      message: `provider replay: refused — this book holds ${[
        ...foreignFirms.map((row) => `firm ${row.id}`),
        ...foreignClients.map((row) => `company ${row.id} (firm ${row.firm_id})`)
      ].join(', ')}; recorded answers are served only to the demo company ${clientId} of firm ${firmId}. `
        + 'Use the demo\'s own data folder (--data-dir) or an empty database.',
      detail: { foreign_firms: foreignFirms.map((row) => row.id), foreign_clients: foreignClients.map((row) => row.id) }
    });
  }
};

// The recordings were made on a database with C (byte-order) collation. Some
// queries that build a prompt sort text ids (`order by id`), and the order of
// those ids — so the prompt, so the request — follows the database's
// collation: on an en_US database the same book asks different questions. The
// demo therefore runs only on a C-collated database and says so by name.
export const DEMO_COLLATIONS = Object.freeze(['C', 'POSIX', 'C.UTF-8', 'C.utf8']);
export const assertDemoCollation = async ({ query }) => {
  const collation = (await query('select datcollate from pg_database where datname = current_database()')).rows[0]?.datcollate;
  if (!DEMO_COLLATIONS.includes(collation)) {
    throw new ProviderReplayError({
      code: 'PROVIDER_REPLAY_COLLATION',
      message: `provider replay: this database sorts text as ${collation}; the recordings were made on C collation and the prompts would differ. `
        + "Use the demo's own data folder, or create the database with: create database <name> template template0 locale 'C'"
    });
  }
};

const STORAGE_STUB_SQL = `
  create schema if not exists storage;
  create table if not exists storage.buckets (id text primary key, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]);
  create table if not exists storage.objects (id uuid default gen_random_uuid() primary key, bucket_id text references storage.buckets(id), name text, metadata jsonb);`;

export const loadReplayRecordings = (file = DEFAULT_RECORDINGS) => {
  if (!existsSync(file)) {
    throw new ProviderReplayError({ code: PROVIDER_REPLAY_CODES.BAD_RECORDINGS, message: `provider replay: no recordings at ${path.relative(ROOT, file)}; make them with \`${RERECORD_COMMAND}\`` });
  }
  const raw = JSON.parse(readFileSync(file, 'utf8'));
  const unpacked = unpackRecordings(raw);
  return { ...unpacked, digest: recordingsDigest(raw) };
};

// What one live answer cost, from the facts file's list prices (the spend
// meter of scripts/fi_month_two_stage_run.js). Null when the model is unpriced.
export const priceUsage = ({ prices = {}, model, usage, provider }) => {
  const price = prices[model] || Object.entries(prices).find(([prefix]) => model && model.startsWith(prefix))?.[1];
  if (!price || !usage) return null;
  const cacheRead = provider === 'anthropic' ? usage.cache_read_input_tokens || 0 : usage.input_tokens_details?.cached_tokens || 0;
  const cacheWrite = provider === 'anthropic' ? usage.cache_creation_input_tokens || 0 : 0;
  const input = (usage.input_tokens ?? usage.prompt_tokens ?? 0) - (provider === 'anthropic' ? 0 : cacheRead);
  const output = usage.output_tokens ?? usage.completion_tokens ?? 0;
  return (input * price.input_per_million + cacheWrite * price.input_per_million * (price.cache_write_multiplier ?? 1.25)
    + cacheRead * price.input_per_million * (price.cache_read_multiplier ?? 0.1) + output * price.output_per_million) / 1e6;
};

// The stored rows that say where the book is. Plain reads.
export const readDemoEndState = async ({ query, firmId, clientId }) => {
  const ids = [firmId, clientId];
  const one = async (sql) => (await query(sql, ids)).rows;
  return {
    journals: await one(`select status, count(*)::int as n from ledger_journals where firm_id = $1 and client_id = $2 group by 1 order by 1`),
    transactions_by_state: await one(`select coding_state, convergence_state, count(*)::int as n from transactions where firm_id = $1 and client_id = $2 group by 1, 2 order by 1, 2`),
    documents_by_state: await one(`select parse_status, convergence_state, count(*)::int as n from documents where firm_id = $1 and client_id = $2 group by 1, 2 order by 1, 2`),
    matches_by_status: await one(`select status, count(*)::int as n from reconciliation_matches where firm_id = $1 and client_id = $2 group by 1 order by 1`),
    asks_by_status: await one(`select status, count(*)::int as n from client_evidence_requests where firm_id = $1 and client_id = $2 group by 1 order by 1`),
    vat_lines: await one(`select l.tax_type, count(*)::int as n from ledger_lines l join ledger_journals j on j.id = l.journal_id where j.firm_id = $1 and j.client_id = $2 and j.status = 'posted' group by 1 order by 1`),
    models: await one(`select distinct m #>> '{}' as model from transactions t, jsonb_path_query(t.payload, 'strict $.**.model') m where t.firm_id = $1 and t.client_id = $2 and jsonb_typeof(m) = 'string' order by 1`)
  };
};

const fingerprintOf = async ({ query, firmId, clientId }) => JSON.stringify([
  (await query('select id, coding_state, convergence_state, convergence_reason from transactions where firm_id = $1 and client_id = $2 order by id', [firmId, clientId])).rows,
  (await query('select id, parse_status, document_type, convergence_state from documents where firm_id = $1 and client_id = $2 order by id', [firmId, clientId])).rows,
  (await query('select id, status, reversed_at from ledger_journals where firm_id = $1 and client_id = $2 order by id', [firmId, clientId])).rows,
  (await query('select id, status from reconciliation_matches where firm_id = $1 and client_id = $2 order by id', [firmId, clientId])).rows,
  (await query('select id, status, evidence_type from client_evidence_requests where firm_id = $1 and client_id = $2 order by id', [firmId, clientId])).rows,
  // Work still queued for the book. Cron housekeeping is left out: a sweep's
  // next tick (or its recovery tick) is always pending, and counting it would
  // make a resting book look busy forever.
  (await query("select function_id, status, count(*)::int as n from local_jobs where status in ('pending', 'running') and function_id not like 'parse-cron:%' and function_id not in (select function_id from local_job_cron_state) group by 1, 2 order by 1, 2")).rows
]);

// Open asks → the statement line they are about → the facts file's answer.
export const answerFor = ({ ask, transaction, answers }) => {
  if (!transaction) return null;
  const amount = Number(transaction.money_out || 0) > 0 ? Number(transaction.money_out) : Number(transaction.money_in || 0);
  const direction = Number(transaction.money_out || 0) > 0 ? 'out' : 'in';
  const day = typeof transaction.transaction_date === 'string' ? transaction.transaction_date.slice(0, 10) : new Date(transaction.transaction_date).toISOString().slice(0, 10);
  const hit = Object.entries(answers.by_statement_line || {}).find(([, a]) => a.date === day && a.direction === direction && Math.abs(Number(a.amount) - amount) < 0.005);
  return hit ? { line: hit[0], reply: hit[1].reply, ask_id: ask.id } : null;
};

export const runDemo = async (options) => {
  const startedAt = Date.now();
  const mode = options.record ? 'record' : 'replay';
  const facts = JSON.parse(readFileSync(FACTS_FILE, 'utf8'));
  const { DEMO_CLIENT_ID, DEMO_STATEMENT_FILE, createRuntimeClient, loadFinnishDemo } = await import('./load_finnish_demo.mjs');
  const recordingsFile = path.resolve(options.recordings || DEFAULT_RECORDINGS);

  // ── The seam, before any runtime module loads ──
  let seam;
  let spend = null;
  let bookQuery = null;
  const realKeys = Object.fromEntries(['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'TYPESAFE_API_KEY'].map((k) => [k, process.env[k] || '']));
  if (mode === 'replay') {
    const recordings = loadReplayRecordings(recordingsFile);
    seam = installProviderReplay({
      recordings,
      rerecordHint: RERECORD_COMMAND,
      logger: console,
      onRequest: options.trace ? (entry) => appendFileSync(options.trace, `${JSON.stringify(entry)}\n`) : null,
      assertScope: async () => {
        if (!bookQuery) throw new ProviderReplayError({ code: PROVIDER_REPLAY_CODES.FOREIGN_BOOK, message: 'provider replay: the book is not open yet' });
        await assertDemoBookOnly({ query: bookQuery, clientId: DEMO_CLIENT_ID });
      }
    });
    for (const key of REPLAY_PROVIDER_KEY_ENV) process.env[key] = REPLAY_PLACEHOLDER_KEY;
    log(`replay: ${recordings.entries.length} recorded answers (${recordings.recorded_at || 'date unknown'}; ${Object.entries(recordedModels(recordings)).map(([p, m]) => `${p} ${m.join(', ')}`).join('; ')}); no provider is called`);
  } else {
    const { answerOpenAiStandIn } = options.standIn ? await import('./demo_fi_stand_ins.mjs') : {};
    const realFetch = globalThis.fetch;
    if (!realKeys.ANTHROPIC_API_KEY) throw new Error('--record needs ANTHROPIC_API_KEY in the environment');
    if (!options.standIn && !realKeys.OPENAI_API_KEY) throw new Error('--record needs OPENAI_API_KEY in the environment (or --stand-in=openai)');
    if (options.standIn) process.env.OPENAI_API_KEY = REPLAY_PLACEHOLDER_KEY;
    const capUsd = Number(options.capUsd || 20);
    spend = { usd: 0, cap_usd: capUsd, live_calls: 0, stand_in: 0, unpriced: 0, reused: 0 };
    const base = options.fill ? loadReplayRecordings(recordingsFile) : null;
    const baseByKey = new Map((base?.entries || []).map((entry) => [entry.key, { entry, served: 0 }]));
    seam = installProviderRecorder({
      logger: console,
      secretValues: Object.values(realKeys).filter(Boolean),
      answer: async (input, init, classified, identity) => {
        const held = identity ? baseByKey.get(identity.key) : null;
        if (held) {
          spend.reused += 1;
          return { response: recordedResponseFor(held.entry, identity, held.served++), provenance: held.entry.provenance };
        }
        if (options.standIn && classified.endpoint_class === 'openai') {
          spend.stand_in += 1;
          return { response: await answerOpenAiStandIn({ input, init, classified }), provenance: 'scripted_stand_in' };
        }
        if (spend.usd >= capUsd) throw new TypeError(`demo record: spend cap ${capUsd} USD reached; not calling ${classified.lane}`);
        const response = await realFetch(input, init);
        let body = null;
        try { body = await response.clone().json(); } catch { body = null; }
        const usd = priceUsage({ prices: facts.prices, model: body?.model || classified.model_requested, usage: body?.usage, provider: classified.endpoint_class });
        spend.live_calls += 1;
        if (usd == null) spend.unpriced += 1; else spend.usd += usd;
        if (spend.live_calls % 10 === 0) log(`record: ${spend.live_calls} live calls, ${spend.usd.toFixed(3)} USD`);
        log(`record: live ${classified.lane} (${classified.model_requested || 'model ?'})`);
        return { response, provenance: 'live' };
      }
    });
    log(`record: live ${options.standIn ? 'anthropic; openai from the scripted stand-in' : 'openai and anthropic'}; writing ${path.relative(ROOT, recordingsFile)}`);
  }
  // Off switches only: the first-line lane needs a Typesafe key the demo
  // does not have, and the challenger rung is not part of the demo.
  delete process.env.TYPESAFE_API_KEY;
  delete process.env.OPENAI_COMPATIBLE_API_KEY;
  delete process.env.OPENAI_COMPATIBLE_BASE_URL;
  process.env.CLIENT_CONFIG_FORCE_DISABLE = [...new Set([...(process.env.CLIENT_CONFIG_FORCE_DISABLE || '').split(',').map((s) => s.trim()).filter(Boolean), 'JEV_RECONCILIATION'])].join(',');
  // One parse at a time: the same order on every run, which is what lets a
  // recording and its replay see the same book at every step.
  process.env.INNGEST_PARSE_CONCURRENCY = '1';

  // ── The database ──
  let pgHandle = null;
  if (options.databaseUrl) {
    process.env.DATABASE_URL = options.databaseUrl;
    process.env.DONNA_DESKTOP_BLOB_DIR = options.dataDir ? path.join(options.dataDir, 'documents') : path.join(os.tmpdir(), `donna-demo-blobs-${process.pid}`);
  } else {
    // A recording starts from an empty book every time: its own new folder.
    const dataDir = path.resolve(options.dataDir || (mode === 'record'
      ? mkdtempSync(path.join(os.tmpdir(), 'donna-demo-record-'))
      : path.join(os.homedir(), '.donna-demo')));
    const { ensureLocalPostgres } = await import('../server/donna/desktop/pgSupervisor.js');
    // The demo's own cluster is initialised with C collation (see
    // assertDemoCollation); only initdb and its server see this, and only for
    // the demo's own data folder.
    const priorLocale = { LC_ALL: process.env.LC_ALL, LANG: process.env.LANG };
    process.env.LC_ALL = 'C';
    process.env.LANG = 'C';
    try {
      pgHandle = ensureLocalPostgres({ dataDir, logger: { log: (l) => console.log(l), error: (l) => console.error(l) } });
    } finally {
      for (const [key, value] of Object.entries(priorLocale)) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
    }
    process.env.DATABASE_URL = pgHandle.databaseUrl;
    process.env.DONNA_DESKTOP_BLOB_DIR = path.join(dataDir, 'documents');
    log(`data folder ${dataDir}`);
  }
  mkdirSync(process.env.DONNA_DESKTOP_BLOB_DIR, { recursive: true });
  if (!process.env.DONNA_ACCESS_TOKEN) process.env.DONNA_ACCESS_TOKEN = randomBytes(24).toString('hex');
  const port = Number(options.port || process.env.DONNA_DESKTOP_PORT || 8787);
  const webPort = Number(options.webPort || process.env.DONNA_LOCAL_WEB_PORT || 5173);

  let runtime = null;
  let webServer = null;
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    if (webServer) await new Promise((resolve) => webServer.close(resolve));
    if (runtime) await runtime.stop().catch(() => {});
    const { closeFirmDbPool } = await import('../server/donna/firmDb.js');
    await closeFirmDbPool().catch(() => {});
    pgHandle?.stop();
    seam.restore();
  };

  try {
    const { queryFirmDb, withFirmDbClient } = await import('../server/donna/firmDb.js');
    if (options.databaseUrl) await queryFirmDb(STORAGE_STUB_SQL);
    log('applying migrations…');
    execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'migrate_firm_db.js')], { cwd: ROOT, stdio: 'ignore', env: process.env });
    await assertDemoCollation({ query: queryFirmDb });
    // Refuse a book that holds anything but the demo, before the runtime starts.
    await assertDemoBookOnly({ query: queryFirmDb, clientId: DEMO_CLIENT_ID });
    if (mode === 'record' && (await queryFirmDb('select 1 from firms limit 1')).rows.length) {
      throw new Error('--record needs an empty book: every request of the month must be recorded from the start');
    }
    bookQuery = queryFirmDb;
    if (mode === 'replay') {
      const { recordProviderReplaySession } = await import('../server/donna/providerReplaySession.js');
      await recordProviderReplaySession({ withFirmDbClientFn: withFirmDbClient, replay: seam.state, clientId: DEMO_CLIENT_ID, firmId: DEMO_FIRM_ID });
    }

    const { createDonnaRuntimeServer } = await import('../server/donna/desktop/runtimeServer.js');
    runtime = await createDonnaRuntimeServer({ listen: { host: '127.0.0.1', port }, logger: options.quietRuntime ? { log: () => {}, error: console.error, warn: () => {} } : console });
    // Take over dispatch: the same manifest on a virtual clock (manifestTicker.js).
    // The runtime's own scheduler runs on the wall clock; under the demo it
    // is stopped and may not be started again by a later readiness renewal,
    // so this process has exactly one dispatcher (the ticker below).
    if (runtime.scheduler) {
      await runtime.scheduler.stop();
      runtime.scheduler.start = async () => {};
    }
    const { createManifestTicker, makeManifestClock } = await import('../server/donna/desktop/manifestTicker.js');
    const { makePromptDueEntityHeal } = await import('../server/donna/runtimeReadiness.js');
    const clock = makeManifestClock(new Date());
    await queryFirmDb('update local_job_cron_state set last_enqueued_tick = $1::timestamptz', [clock.now().toISOString()]);
    const heal = makePromptDueEntityHeal({ withFirmDbClientFn: withFirmDbClient, logger: console });
    const ticker = createManifestTicker({
      manifest: runtime.manifest.filter((entry) => !VIRTUAL_CLOCK_SKIP.has(entry.functionId)),
      query: (text, params) => queryFirmDb(text, params),
      clock,
      logger: options.quietRuntime ? { log: () => {}, error: console.error, warn: () => {} } : console,
      workerId: `demo-${process.pid}`,
      maxConcurrent: 1,
      onQueueActivity: (activity) => heal(activity)
    });

    if (!options.noWeb) {
      const distDir = path.join(ROOT, 'dist');
      if (existsSync(path.join(distDir, 'index.html'))) {
        const { createLocalWebServer } = await import('./local_web.mjs');
        webServer = createLocalWebServer({ distDir, runtimePort: port });
        await new Promise((resolve, reject) => { webServer.once('error', reject); webServer.listen(webPort, process.env.DONNA_LOCAL_WEB_HOST || '127.0.0.1', resolve); });
        log(`web app on http://127.0.0.1:${webPort}/firms`);
      } else {
        log('no built web app (dist/); run `npm run build` to look at the book in a browser');
      }
    }

    // ── The month ──
    const client = createRuntimeClient({ baseUrl: `http://127.0.0.1:${port}`, accessToken: process.env.DONNA_ACCESS_TOKEN });
    const exclude = options.hold ? [options.hold] : [];
    const loaded = await loadFinnishDemo({
      client, allDocuments: true, exclude, log: (line) => console.log(line),
      // The company's ALV registration, from the facts file, through the
      // operator's profile route (the pack states it; the loader does not).
      beforeDocuments: async ({ firmId: mintedFirm, clientId: demoClient }) => {
        const saved = await client.postJson(`/api/donna/firms/clients/${encodeURIComponent(demoClient)}/profile`, {
          firm_id: mintedFirm || DEMO_FIRM_ID,
          profile_patch: { alv_registration: facts.alv_registration }
        });
        if (saved.status !== 200) throw new Error(`Recording the ALV registration failed (HTTP ${saved.status}): ${saved.text.slice(0, 300)}`);
        log(`ALV registration recorded: ${facts.alv_registration.status} from ${facts.alv_registration.registered_from}, ${facts.alv_registration.tax_period}ly`);
      }
    });
    const firmId = loaded.firmId || DEMO_FIRM_ID;
    if (firmId !== DEMO_FIRM_ID) throw new Error(`the demo firm was minted as ${firmId}, not ${DEMO_FIRM_ID}`);
    const clientId = DEMO_CLIENT_ID;
    const ids = { query: queryFirmDb, firmId, clientId };

    const docCount = Number((await queryFirmDb('select count(*)::int as n from documents where firm_id = $1 and client_id = $2', [firmId, clientId])).rows[0].n);
    await ticker.tick({ advanceMs: 0, functions: ['parse-document'], maxRounds: docCount * 4, settleTimeoutMs: 3_600_000, untilNoPending: true });
    const settle = async (label) => {
      let quiet = 0; let rounds = 0; let last = null;
      while (rounds < SETTLE.max_rounds && quiet < SETTLE.quiet_rounds) {
        rounds += 1;
        await ticker.tick({ advanceMs: SETTLE.advance_ms, settleTimeoutMs: 3_600_000, untilNoPending: true });
        const now = await fingerprintOf(ids);
        quiet = now === last ? quiet + 1 : 0;
        last = now;
      }
      log(`${label}: ${quiet >= SETTLE.quiet_rounds ? 'at rest' : 'NOT at rest'} after ${rounds} rounds (${Math.round((Date.now() - startedAt) / 1000)} s)`);
      return quiet >= SETTLE.quiet_rounds;
    };
    let atRest = await settle('first rest');

    const answered = [];
    for (let round = 1; round <= ANSWER_ROUNDS; round += 1) {
      const open = (await queryFirmDb(
        `select r.id, r.transaction_id, r.status, t.transaction_date::text as transaction_date, t.money_in, t.money_out
           from client_evidence_requests r left join transactions t on t.id = r.transaction_id and t.firm_id = r.firm_id
          where r.firm_id = $1 and r.client_id = $2 and r.status in ('draft', 'open') order by r.created_at, r.id`, [firmId, clientId])).rows
        .filter((ask) => !answered.some((a) => a.ask_id === ask.id));
      const toGive = open.map((ask) => answerFor({ ask, transaction: ask.transaction_id ? ask : null, answers: facts.owner_answers || {} })).filter(Boolean);
      if (!toGive.length) break;
      for (const answer of toGive) {
        const response = await client.postJson(`/api/donna/firms/evidence/requests/${encodeURIComponent(answer.ask_id)}/resolve`, { firm_id: firmId, reply: answer.reply });
        answered.push({ ...answer, http: response.status });
        log(`owner answered ${answer.line} (ask ${answer.ask_id}): HTTP ${response.status}`);
      }
      atRest = await settle(`rest after answers, round ${round}`);
    }

    const endState = await readDemoEndState(ids);
    const summary = {
      mode,
      at_rest: atRest,
      seconds: Math.round((Date.now() - startedAt) / 1000),
      documents_loaded: loaded.uploaded.length,
      held_back: options.hold || null,
      answered,
      end_state: endState,
      provider: mode === 'replay'
        ? { served: seam.served.length, unrecorded: seam.missed.map(({ error, request, long_texts, ...rest }) => rest), network_refused: seam.refusedNetwork }
        : { calls: seam.ledger.length, spend, by_lane: seam.ledger.reduce((t, r) => ({ ...t, [r.lane]: (t[r.lane] || 0) + 1 }), {}), network_refused: seam.refusedNetwork }
    };
    if (mode === 'record') {
      const entries = seam.entries();
      const file = packRecordings({
        format: PROVIDER_REPLAY_FORMAT,
        identity: PROVIDER_REQUEST_IDENTITY_VERSION,
        pack: 'fi-kultalanka-2025-02',
        recorded_at: new Date().toISOString().slice(0, 10),
        recorded_on: { commit: (() => { try { return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim(); } catch { return null; } })() },
        scenario: { held_back: options.hold || null, owner_answers: answered.map((a) => a.line) },
        note: 'Recorded provider answers for the zero-key demo (npm run demo:fi). Synthetic pack data only; provider ids are replaced, no header is kept. Re-record with `npm run demo:fi:record`.',
        entries
      });
      const text = `${JSON.stringify(file, null, 1)}\n`;
      const leaks = findSecretShapes(text, { extraValues: Object.values(realKeys).filter(Boolean) });
      if (leaks.length) throw new Error(`refusing to write recordings: secret-shaped content (${leaks.map((l) => l.name).join(', ')})`);
      mkdirSync(path.dirname(recordingsFile), { recursive: true });
      writeFileSync(recordingsFile, text);
      summary.recordings = { file: path.relative(ROOT, recordingsFile), entries: entries.length, bytes: Buffer.byteLength(text), models: recordedModels({ entries }) };
      log(`live spend ${spend.usd.toFixed(3)} USD over ${spend.live_calls} calls (${spend.unpriced} unpriced); ${spend.stand_in} from the stand-in; ${spend.reused} from the existing recordings`);
      log(`wrote ${entries.length} recordings (${Math.round(Buffer.byteLength(text) / 1024)} KB) to ${path.relative(ROOT, recordingsFile)}`);
    }
    if (options.report) writeFileSync(options.report, `${JSON.stringify(summary, null, 2)}\n`);
    if (options.report && mode === 'replay' && seam.missed.length) {
      // What the code asked for that the recordings do not hold, in full, to
      // diff against the recording (data/demo-replay/…, entry by lane).
      writeFileSync(`${options.report}.unrecorded.json`, `${JSON.stringify(seam.missed.map(({ error, ...rest }) => rest), null, 1)}\n`);
      log(`the unrecorded requests are in ${options.report}.unrecorded.json`);
    }
    printSummary(summary);

    if (mode === 'replay' && seam.missed.length) throw seam.missed[0].error;
    if (options.exitAtRest) return summary;

    log(`sign in at http://127.0.0.1:${webPort}/firms with the access key ${process.env.DONNA_ACCESS_TOKEN}`);
    log(`the owner's view: http://127.0.0.1:${webPort}/portal/${clientId}`);
    if (options.hold) log(`upload "${options.hold}" from data/evals/fixtures/fi-kultalanka-2025-02/sources there to watch it read, coded and matched`);
    log('the book keeps ticking (five virtual minutes every two seconds). Ctrl-C to stop.');
    const keepTicking = async () => {
      while (!stopping) {
        await ticker.tick({ advanceMs: SETTLE.advance_ms, settleTimeoutMs: 600_000 }).catch((error) => { if (!stopping) console.error(`[demo] tick failed: ${error.message}`); });
        await sleep(2000);
      }
    };
    await new Promise((resolve) => {
      const onSignal = () => { stop().then(resolve); };
      process.once('SIGINT', onSignal);
      process.once('SIGTERM', onSignal);
      keepTicking();
    });
    return summary;
  } finally {
    await stop();
  }
};

export const printSummary = (summary) => {
  const s = summary.end_state;
  const fmt = (rows, keys) => rows.map((r) => `${keys.map((k) => r[k] ?? '-').join('/')} ${r.n}`).join(', ') || 'none';
  log(`${summary.mode} ${summary.at_rest ? 'at rest' : 'NOT at rest'} in ${summary.seconds} s`);
  log(`journals: ${fmt(s.journals, ['status'])}`);
  log(`bank lines (coding/convergence): ${fmt(s.transactions_by_state, ['coding_state', 'convergence_state'])}`);
  log(`documents (parse/convergence): ${fmt(s.documents_by_state, ['parse_status', 'convergence_state'])}`);
  log(`matches: ${fmt(s.matches_by_status, ['status'])}; asks: ${fmt(s.asks_by_status, ['status'])}`);
  log(`posted lines by tax code: ${fmt(s.vat_lines, ['tax_type'])}`);
  log(`models on the coded lines: ${s.models.map((m) => m.model).join(', ') || 'none'}`);
};

// `npm run demo:fi:record`: the live pass, then fill passes until one needs
// no new answer, then a replay with no key. Why passes: a live run takes
// minutes and the replay seconds, and some of the runtime's work is paced by
// the wall clock (readiness renewal, settle gates), so a few questions are
// asked in a different state at replay speed. A fill pass runs a fresh book
// at replay speed, answers what the recordings hold from them and calls live
// only for what they miss; the file it writes holds exactly the requests a
// replay makes. Each pass is its own process (one book per process).
const runChild = (args) => new Promise((resolve) => {
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), ...args], { stdio: 'inherit', env: process.env });
  child.on('exit', (code) => resolve(code));
});
export const RECORD_MAX_FILL_PASSES = 4;
const recordAll = async (options, argv) => {
  const passthrough = argv.filter((a) => !/^--(record|fill|exit-at-rest|report|data-dir|database-url)(=|$)/.test(a));
  const temp = mkdtempSync(path.join(os.tmpdir(), 'donna-demo-passes-'));
  const report = (name) => path.join(temp, `${name}.json`);
  log('pass 1: live');
  if (await runChild(['--record', '--exit-at-rest', `--report=${report('live')}`, ...passthrough, ...(options.databaseUrl ? [`--database-url=${options.databaseUrl}`] : [])]) !== 0) return 1;
  if (options.databaseUrl) {
    log('fill passes need a fresh book each; with --database-url, run `--record --fill` against new empty databases yourself');
    return 0;
  }
  for (let pass = 2; pass <= RECORD_MAX_FILL_PASSES + 1; pass += 1) {
    log(`pass ${pass}: fill at replay speed`);
    if (await runChild(['--record', '--fill', '--exit-at-rest', `--report=${report(`fill-${pass}`)}`, ...passthrough]) !== 0) return 1;
    const spent = JSON.parse(readFileSync(report(`fill-${pass}`), 'utf8')).provider.spend;
    if (!spent.live_calls && !spent.stand_in) break;
    if (pass === RECORD_MAX_FILL_PASSES + 1) { log('the recordings did not settle; run `npm run demo:fi:record -- --fill` again'); return 1; }
  }
  log('verify: replay with no key');
  const verifyEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/_API_KEY$/.test(k)));
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--exit-at-rest', '--no-web', `--report=${report('verify')}`,
      ...passthrough.filter((a) => !/^--(stand-in|cap-usd)/.test(a))], { stdio: 'inherit', env: verifyEnv });
    child.on('exit', (code) => resolve(code));
  });
};

const isDirectRun = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isDirectRun) {
  let options;
  const argv = process.argv.slice(2);
  try { options = parseDemoArgs(argv); } catch (error) { console.error(`[demo] ${error.message}`); process.exit(2); }
  if (options.record && !options.fill && !options.exitAtRest) {
    recordAll(options, argv).then((code) => process.exit(code), (error) => { console.error(`[demo] ${error.message}`); process.exit(1); });
  } else runDemo(options).then(
    () => process.exit(0),
    (error) => {
      console.error(`[demo] ${error.code ? `${error.code}: ` : ''}${error.message}`);
      process.exit(error?.code === PROVIDER_REPLAY_CODES.FOREIGN_BOOK ? 3 : 1);
    }
  );
}
