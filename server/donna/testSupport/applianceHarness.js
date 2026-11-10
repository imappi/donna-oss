// The appliance test harness (RT-06, docs/plan-2026-09-01-runtime-refactor-slices.md;
// audit F-20 and the eight fixtures in §9).
//
// WHAT IT PROVES. The real desktop path, end to end, on a real PostgreSQL:
//
//   createDonnaRuntimeServer (the assembly the Electron shell boots)
//     → Host Certificate A minted, scheduler admitted
//     → the local durable scheduler over the desktop handler manifest
//     → the `parse-document` local job the register route enqueued (RT-08)
//       and the parse-cron sweeps called in-process from the function
//       manifest (RT-14: no HTTP self-call, no drain on the appliance)
//     → handleParseEvent over the durable step → router → extractor → writer → matchers
//     → transactions / matches / evaluations / asks / review rows.
//
// Nothing on that path is mocked. Model calls are served at the HTTP
// boundary by recordedProviders.js (committed, wire-shaped bodies keyed by
// lane, scripted per call), so every production module — request shaping,
// parsing, retries, receipts — runs unmodified. eval_world_birth_to_parse.js
// proved the plumbing with intelligence OFF (both keys blanked, the router
// force-disabled); this harness proves the recorded strong-model lanes. Jev's
// default/recreation proof uses its own provider contract; these older recordings
// do not contain typed first-line answers. Pass CLIENT_CONFIG_FORCE_DISABLE: ''
// explicitly when supplying first-line recordings to this harness.
//
// WHAT IT DOES NOT TOUCH. No production module is modified: the harness boots
// the tree as shipped. The one thing it takes over is DISPATCH TIMING — see
// "the clock" below — because the assembly builds its scheduler with the
// wall clock and no injection seam, and a fixture must be able to say "one
// minute passes" without waiting a minute.
//
// ── How to write a fixture on it (RT-01/02/03/04/05/08/09 and the §9 set) ──
//
//   import { bootApplianceForTest, applianceHarnessSkipReason }
//     from './testSupport/applianceHarness.js';
//
//   test('…', { skip: applianceHarnessSkipReason() }, async () => {
//     const appliance = await bootApplianceForTest({
//       keys: { openai: true, anthropic: false },   // RT-01: an OpenAI-only host
//       env: { TZ: 'Asia/Dubai' },                  // §9 fixture 8: pg date columns under a +4 zone
//       now: new Date('2026-08-31T09:00:00Z')       // the scheduler's clock, if the fixture cares
//     });
//     try {
//       appliance.providers.script('document_routing', ['document_routing/ochre-supplier-bill']);
//       appliance.providers.script('supplier_bill_extraction', [
//         { status: 429 },                                          // RT-02: 429 once…
//         'supplier_bill_extraction/ochre-discount-line'            // …then the recording
//       ]);
//       const { clientId } = await appliance.createClient();       // the real create route: plane rows + readiness
//       const { documentId } = await appliance.uploadDocument({   // upload-url → signed PUT → register, real routes
//         clientId, fixture: 'supplier_bill_discount'
//       });
//       const receipt = await appliance.tick();                    // one scheduler minute: cron enqueue → claim → the parse job + the sweeps
//       const document = await appliance.read.document(documentId);
//       assert.equal(document.parse_status, 'completed');
//       assert.deepEqual(appliance.providers.unscripted, []);      // every lane that was hit was scripted
//     } finally {
//       await appliance.stop();                                    // runtime, pool, fetch, env, database, blob dir
//     }
//   });
//
//   Per slice, the seam each one leans on:
//   - RT-01 (host certificate): `keys` stages which providers are dark;
//     `read.host()` is the persisted Host A receipt; `runtime.schedulerRunning()`
//     is the admission verdict; `api.request('/api/donna/firms/health')` the
//     public lane receipt.
//   - RT-02 (drain truthfulness) and RT-08 (parse as a job): a per-call script
//     ("429 once then the body") on the extractor lane; `read.document()` for
//     parse_status / parse_error; `read.jobs()` for the local_jobs ledger;
//     `tick()` again to let the queue retry. `collapseQueueWaits` is what
//     makes a backed-off job due without waiting for the DB clock.
//   - RT-03 (one firm resolver): the harness never sets DONNA_DEFAULT_FIRM_ID to
//     the minted firm — the runtime's own sole-firm boot resolution adopts it,
//     exactly as on the appliance; `uploadDocument()` returns the storage key;
//     `read.audit({ action })` the upload_sign / local_blob_put rows.
//   - RT-04 (one totals validator): the `supplier_bill_discount` fixture is the
//     audit's discounted bill; `read.reviewQueue()` and `read.document()`'s
//     parse_summary carry the validators' outcomes.
//   - RT-05 (router promotion): the `payout_statement` fixture uploads as type
//     `unknown` with a filename no regex matches; `read.document()` shows the
//     final document_type and `parse_summary.classification`.
//   - RT-09 (readiness coherence): `read.readiness(clientId)` is the saga row;
//     `query()` can set next_retry_at into the past; `tick()` settles jobs,
//     which fires the same prompt-due entity heal the runtime wires.
//
// ── The clock ──
//
// `appliance.clock` drives cron ARITHMETIC (which ticks are due) exactly the
// way the production scheduler's injectable `now` does — the harness builds
// its dispatcher with createLocalScheduler({ now: clock.now }) over the same
// manifest, same queue tables, same handler closures the runtime built. Due-
// ness of a queued job is decided in SQL on the DATABASE clock (`run_at <=
// now()`, localScheduler.js header), which cannot be injected; so `tick()`
// first COLLAPSES the waits of pending jobs for the functions it runs (sets
// run_at to now()) and reports which jobs it collapsed in its receipt. A
// fixture that wants to see a backoff hold pass `collapseWaits: false`.
//
// The runtime's own poll loop is stopped right after boot (its admission
// verdict — Host A PASS, scheduler started — is kept and reported by
// `runtime.schedulerRunning()`); from then on only `tick()` dispatches. Two
// dispatchers over one queue would be safe (SKIP LOCKED) but not
// deterministic, and determinism is the whole point.
//
// ── Isolation ──
//
// Every boot creates its own database (migrations applied from db/migrations,
// the CI storage stub included), its own blob directory, and its own firm
// under the Gate 2A run-identity discipline (eaw-appliance-<runToken>,
// <firm>-client-N, <client>-doc-N), then drops all of it in stop(). The whole
// process env is snapshotted at boot and restored at stop, because the
// desktop boot writes runtime-ON defaults into process.env only-where-unset.

import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import PgTypeOverrides from 'pg/lib/type-overrides.js';

import { createManifestTicker, makeManifestClock } from '../desktop/manifestTicker.js';
import { defaultDotEnvFiles } from '../desktop/providerKeyDotEnv.js';
import { createDonnaRuntimeServer } from '../desktop/runtimeServer.js';
import { closeFirmDbPool, createFirmInDb, queryFirmDb, withFirmDbClient } from '../firmDb.js';
import { loadApplianceFixture } from '../fixtures/appliance/index.js';
import { makePromptDueEntityHeal } from '../runtimeReadiness.js';
import { installRecordedProviders } from './recordedProviders.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const MIGRATIONS_DIR = path.join(REPO_ROOT, 'db', 'migrations');

export const APPLIANCE_FIRM_ID_PREFIX = 'eaw-appliance-';
export const PRESENCE_ONLY_KEY = (provider) => `appliance-harness-${provider}-presence-only-not-a-key`;

const PROVIDER_KEY_ENV = Object.freeze({
  openai: 'OPENAI_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
  typesafe: 'TYPESAFE_API_KEY',
  openai_compatible: 'OPENAI_COMPATIBLE_API_KEY'
});

// Gate 2A's run-identity discipline (scripts/eval_world_birth_to_parse.js
// assertGate2aRunIdentity), generalized to N clients and N documents: every
// id belongs uniquely to its run, so nothing a fixture writes can collide
// with another run's rows or with a real book.
export const assertApplianceRunIdentity = ({ runToken, firmId, clientId = null, documentId = null } = {}) => {
  if (!/^[a-z0-9-]+$/.test(runToken || '')) throw new Error('appliance harness: runToken must be lowercase [a-z0-9-]');
  if (firmId !== `${APPLIANCE_FIRM_ID_PREFIX}${runToken}`) throw new Error('appliance harness: firm id must be eaw-appliance-<runToken>');
  if (clientId != null && !new RegExp(`^${firmId}-client-\\d+$`).test(clientId)) {
    throw new Error('appliance harness: client id must be <firm>-client-N');
  }
  if (documentId != null && !new RegExp(`^${firmId}-client-\\d+-doc-\\d+$`).test(documentId)) {
    throw new Error('appliance harness: document id must be <client>-doc-N');
  }
};

// The desktop boot fills provider keys from the repo's .env files where the
// process env is unset (providerKeyDotEnv.js), so a developer machine whose
// .env carries a key cannot stage that provider DARK. Returns the file that
// would supply it, or null. A fixture staging a dark lane skips visibly on
// this — never a silent green (the RT-01 fixture's posture).
export const dotEnvSupplyingProviderKey = (envKey) => defaultDotEnvFiles().find((file) => {
  if (!existsSync(file)) return false;
  const pattern = new RegExp(`^\\s*(?:export\\s+)?${envKey}\\s*=\\s*["']?[^"'\\s]+`);
  return readFileSync(file, 'utf8').split(/\r?\n/).some((line) => pattern.test(line));
}) || null;

// The skip reason a fixture passes to node:test. `dark` names providers the
// fixture needs ABSENT (e.g. ['anthropic'] for an OpenAI-only host).
export const applianceHarnessSkipReason = ({ dark = [] } = {}) => {
  if (!process.env.DONNA_PG_TEST_URL) return 'DONNA_PG_TEST_URL not set — the appliance path is not exercised on real PG';
  for (const provider of dark) {
    const envKey = PROVIDER_KEY_ENV[provider];
    if (!envKey) return `appliance harness: unknown provider "${provider}"`;
    const file = dotEnvSupplyingProviderKey(envKey);
    if (file) return `${path.basename(file)} supplies ${envKey} — cannot stage a ${provider}-dark host here`;
  }
  return false;
};

const freeLoopbackPort = () => new Promise((resolve, reject) => {
  const probe = net.createServer();
  probe.on('error', reject);
  probe.listen(0, '127.0.0.1', () => {
    const { port } = probe.address();
    probe.close(() => resolve(port));
  });
});

// A fresh database with every migration applied — the RT-01 / Gate 2A
// provisioning, in one place.
const provisionScratchDatabase = async ({ adminUrl, dbName }) => {
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`create database "${dbName}"`);
  const url = new URL(adminUrl);
  url.pathname = `/${dbName}`;
  // The harness's own reader hands `date` columns back as the ISO day PG
  // stores (a per-CLIENT override — the runtime's pool keeps pg's default
  // JS-Date parsing, so nothing about the production read path changes).
  // A fixture asserting a stored day must never depend on the test host's
  // zone: that is the F-11 hazard itself, not a fixture's business.
  const types = new PgTypeOverrides();
  types.setTypeParser(1082, (value) => value);
  const scratch = new pg.Client({ connectionString: url.toString(), types });
  await scratch.connect();
  // The CI storage stub (scripts/prepare_ci_host_postgres.js): migration 010
  // targets Supabase's storage schema.
  await scratch.query(`
    create schema if not exists storage;
    create table if not exists storage.buckets (
      id text primary key, name text, public boolean,
      file_size_limit bigint, allowed_mime_types text[]);
    create table if not exists storage.objects (
      id uuid default gen_random_uuid() primary key,
      bucket_id text references storage.buckets(id), name text, metadata jsonb);
  `);
  const migrations = (await readdir(MIGRATIONS_DIR)).filter((file) => file.endsWith('.sql')).sort();
  for (const file of migrations) {
    await scratch.query(await readFile(path.join(MIGRATIONS_DIR, file), 'utf8'));
    await scratch.query(
      'insert into schema_migrations (version) values ($1) on conflict (version) do nothing',
      [file.replace(/\.sql$/, '')]
    );
  }
  return { admin, scratch, url: url.toString(), migrations: migrations.length };
};

// ── INV-24 guard: the appliance cluster is never a scratch substrate (DMEM-R1 W0) ──
//
// plan v1.0 §7 W0: "guards must reject the appliance cluster fingerprint /
// database OID, real socket path, and object-root aliases — not merely the
// name donna_local". The appliance records its identity ONCE, on the mini,
// into a fingerprint file (DONNA_APPLIANCE_FINGERPRINT_FILE, default
// ~/.donna/appliance-fingerprint.json — `recordApplianceFingerprint` writes
// it; the operator script that calls it is LR-*'s inspector work, not W0's).
// Every boot then observes the ADMIN connection it was handed (the cluster's
// system identifier, socket directories, data directory, every database name
// + OID on it, the host, the object root) and refuses to create a scratch
// database when ANY observed dimension matches the record. Without a file the
// guard still refuses the appliance's database NAME. The refusal happens
// BEFORE `create database` — nothing is written to a refused cluster.
export const APPLIANCE_FINGERPRINT_FILE_ENV = 'DONNA_APPLIANCE_FINGERPRINT_FILE';
export const DEFAULT_APPLIANCE_FINGERPRINT_FILE = path.join(os.homedir(), '.donna', 'appliance-fingerprint.json');
export const APPLIANCE_DATABASE_NAMES = Object.freeze(['donna_local']);
export const APPLIANCE_FINGERPRINT_SCHEMA = 'donna.appliance-fingerprint.v1';
export const APPLIANCE_FINGERPRINT_REFUSED = 'APPLIANCE_FINGERPRINT_REFUSED';

export class ApplianceFingerprintRefused extends Error {
  constructor({ dimension, value, source, scratchDbName = null }) {
    super(`appliance harness: refused — the ${dimension} of the database handed to the harness matches the recorded appliance fingerprint (${source}); the authoritative appliance is read-only for tests (INV-24)`);
    this.code = APPLIANCE_FINGERPRINT_REFUSED;
    this.dimension = dimension;
    this.value = value;
    this.source = source;
    // The scratch database the refused boot WOULD have provisioned — a test can
    // prove "refused before any create database" by its absence, exactly, even
    // while other harness boots run concurrently on the same cluster.
    this.scratchDbName = scratchDbName;
  }
}

const readMachineId = () => {
  for (const file of ['/etc/machine-id', '/var/lib/dbus/machine-id']) {
    try {
      const value = readFileSync(file, 'utf8').trim();
      if (value) return value;
    } catch {
      // not this host
    }
  }
  return null;
};

const realpathOrNull = (target) => {
  if (!target) return null;
  try {
    return realpathSync(target);
  } catch {
    return path.resolve(target);
  }
};

// The dimensions a guard can see from one admin connection + the process.
export const observeConnectionFingerprint = async (adminUrl, { objectRoot = process.env.DONNA_DESKTOP_BLOB_DIR || null } = {}) => {
  const url = new URL(adminUrl);
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  try {
    const identity = (await admin.query(
      `select current_database() as database_name,
              (select oid::text from pg_database where datname = current_database()) as database_oid,
              inet_server_addr()::text as server_addr,
              inet_server_port() as server_port,
              current_setting('unix_socket_directories', true) as socket_directories,
              current_setting('data_directory', true) as data_directory`
    )).rows[0];
    let systemIdentifier = null;
    try {
      systemIdentifier = (await admin.query('select system_identifier::text as id from pg_control_system()')).rows[0]?.id || null;
    } catch {
      systemIdentifier = null; // not privileged here — the other dimensions still apply
    }
    const databases = (await admin.query(
      'select datname, oid::text as oid from pg_database where not datistemplate order by datname'
    )).rows;
    const socketPaths = String(identity.socket_directories || '')
      .split(',').map((s) => s.trim()).filter(Boolean)
      .map((dir) => (identity.server_port ? path.join(dir, `.s.PGSQL.${identity.server_port}`) : dir));
    return {
      schema: APPLIANCE_FINGERPRINT_SCHEMA,
      observed_at: new Date().toISOString(),
      url_host: url.hostname || null,
      url_port: url.port || null,
      url_database: decodeURIComponent(url.pathname.replace(/^\//, '')) || null,
      database_name: identity.database_name,
      database_oid: identity.database_oid,
      databases: databases.map((row) => ({ name: row.datname, oid: row.oid })),
      system_identifier: systemIdentifier,
      server_addr: identity.server_addr || null,
      server_port: identity.server_port || null,
      socket_paths: socketPaths,
      data_directory: identity.data_directory || null,
      host: { hostname: os.hostname(), machine_id: readMachineId() },
      object_root_realpath: realpathOrNull(objectRoot)
    };
  } finally {
    await admin.end();
  }
};

// The recorded shape: sets per dimension, so one file can name every alias the
// appliance is reachable through (a TCP DSN, the socket, a symlinked blob dir).
export const buildApplianceFingerprintRecord = (observed, { applianceDatabaseNames = APPLIANCE_DATABASE_NAMES } = {}) => ({
  schema: APPLIANCE_FINGERPRINT_SCHEMA,
  recorded_at: new Date().toISOString(),
  // The appliance's own database names: the built-in list plus the database the
  // recording connection was pointed at — never a system database (`postgres`,
  // `template*`), which every cluster has and which would refuse every cluster.
  database_names: [...new Set([...applianceDatabaseNames, observed.database_name]
    .filter((name) => name && name !== 'postgres' && !String(name).startsWith('template')))],
  database_oids: (observed.databases || []).map((d) => d.oid).filter(Boolean),
  system_identifiers: observed.system_identifier ? [observed.system_identifier] : [],
  socket_paths: observed.socket_paths || [],
  data_directories: observed.data_directory ? [observed.data_directory] : [],
  host_fingerprints: [observed.host].filter((h) => h && (h.hostname || h.machine_id)),
  object_roots: observed.object_root_realpath ? [observed.object_root_realpath] : []
});

export const recordApplianceFingerprint = async ({ adminUrl, objectRoot = null, file = process.env[APPLIANCE_FINGERPRINT_FILE_ENV] || DEFAULT_APPLIANCE_FINGERPRINT_FILE } = {}) => {
  const observed = await observeConnectionFingerprint(adminUrl, { objectRoot });
  const record = buildApplianceFingerprintRecord(observed);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`);
  return { file, record };
};

export const readApplianceFingerprintFile = (file = process.env[APPLIANCE_FINGERPRINT_FILE_ENV] || DEFAULT_APPLIANCE_FINGERPRINT_FILE) => {
  if (!file || !existsSync(file)) return null;
  const parsed = JSON.parse(readFileSync(file, 'utf8'));
  if (parsed?.schema !== APPLIANCE_FINGERPRINT_SCHEMA) {
    throw new Error(`appliance harness: ${file} is not a ${APPLIANCE_FINGERPRINT_SCHEMA} record`);
  }
  return parsed;
};

// null when nothing matches; otherwise the FIRST matching dimension.
export const applianceFingerprintMatch = (observed, recorded, { scratchDbName = null } = {}) => {
  const names = new Set([...APPLIANCE_DATABASE_NAMES, ...((recorded?.database_names) || [])]);
  for (const candidate of [observed.url_database, observed.database_name, scratchDbName]) {
    if (candidate && names.has(candidate)) return { dimension: 'database name', value: candidate };
  }
  if (!recorded) return null;
  const oids = new Set(recorded.database_oids || []);
  for (const db of observed.databases || []) {
    if (db.oid && oids.has(db.oid)) return { dimension: 'database OID', value: `${db.name}#${db.oid}` };
  }
  if (observed.system_identifier && (recorded.system_identifiers || []).includes(observed.system_identifier)) {
    return { dimension: 'cluster system identifier', value: observed.system_identifier };
  }
  const sockets = new Set(recorded.socket_paths || []);
  for (const socket of observed.socket_paths || []) {
    if (sockets.has(socket)) return { dimension: 'socket path', value: socket };
  }
  if (observed.data_directory && (recorded.data_directories || []).includes(observed.data_directory)) {
    return { dimension: 'data directory', value: observed.data_directory };
  }
  for (const host of recorded.host_fingerprints || []) {
    if (host?.machine_id && observed.host?.machine_id && host.machine_id === observed.host.machine_id) {
      return { dimension: 'host fingerprint', value: `machine_id:${host.machine_id.slice(0, 8)}…` };
    }
    if (host?.hostname && observed.host?.hostname && host.hostname === observed.host.hostname && !host.machine_id) {
      return { dimension: 'host fingerprint', value: `hostname:${host.hostname}` };
    }
  }
  if (observed.object_root_realpath && (recorded.object_roots || []).includes(observed.object_root_realpath)) {
    return { dimension: 'object root', value: observed.object_root_realpath };
  }
  return null;
};

export const assertNotApplianceCluster = async ({ adminUrl, scratchDbName = null, objectRoot = null, file = undefined } = {}) => {
  const recorded = readApplianceFingerprintFile(file);
  const source = recorded ? (file || process.env[APPLIANCE_FINGERPRINT_FILE_ENV] || DEFAULT_APPLIANCE_FINGERPRINT_FILE) : 'the built-in appliance database name';
  // The NAME dimension is decided from the URL alone, before any connection:
  // a DSN that names the appliance database is refused without dialling it.
  const urlDatabase = decodeURIComponent(new URL(adminUrl).pathname.replace(/^\//, '')) || null;
  const byName = applianceFingerprintMatch({ url_database: urlDatabase, databases: [], socket_paths: [] }, recorded, { scratchDbName });
  if (byName) throw new ApplianceFingerprintRefused({ ...byName, source, scratchDbName });
  const observed = await observeConnectionFingerprint(adminUrl, { objectRoot });
  const match = applianceFingerprintMatch(observed, recorded, { scratchDbName });
  if (match) throw new ApplianceFingerprintRefused({ ...match, source, scratchDbName });
  return { observed, recorded: Boolean(recorded) };
};

const makeClock = makeManifestClock;

// Ring-buffered capture of the runtime's logger so a failing fixture can
// print what the scheduler and the runtime said, without flooding stdout.
const makeCapturedLogger = ({ echo = false, limit = 2000 } = {}) => {
  const lines = [];
  const push = (level, args) => {
    const line = `[${level}] ${args.map((value) => (typeof value === 'string' ? value : JSON.stringify(value))).join(' ')}`;
    lines.push(line);
    if (lines.length > limit) lines.shift();
    if (echo) console[level === 'error' ? 'error' : 'log'](line);
  };
  return {
    lines,
    logger: {
      log: (...args) => push('log', args),
      info: (...args) => push('log', args),
      warn: (...args) => push('warn', args),
      error: (...args) => push('error', args)
    }
  };
};

export const bootApplianceForTest = async ({
  env = {},
  now = new Date(),
  keys = {},
  listen = 'tcp',
  runToken = `${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`,
  providers = null,
  firm = {},
  echoLogs = false,
  pgTestUrl = process.env.DONNA_PG_TEST_URL || '',
  applianceFingerprintFile = undefined
} = {}) => {
  if (!pgTestUrl) throw new Error('appliance harness: DONNA_PG_TEST_URL is required (use applianceHarnessSkipReason() to skip)');
  const firmId = `${APPLIANCE_FIRM_ID_PREFIX}${runToken}`;
  assertApplianceRunIdentity({ runToken, firmId });
  const dbName = `donna_appliance_${runToken.replace(/-/g, '_')}`;
  const priorEnv = { ...process.env };
  const restoreEnv = () => {
    for (const key of Object.keys(process.env)) {
      if (!(key in priorEnv)) delete process.env[key];
    }
    for (const [key, value] of Object.entries(priorEnv)) process.env[key] = value;
  };
  const wantKeys = { openai: true, anthropic: true, typesafe: true, openai_compatible: false, ...keys };
  const clock = makeClock(now);
  const captured = makeCapturedLogger({ echo: echoLogs });
  const accessToken = `appliance-harness-token-${runToken}`;

  let db = null;
  let blobDir = null;
  let socketPath = null;
  let runtime = null;
  let ownedProviders = null;
  let stopped = false;

  const stop = async () => {
    if (stopped) return;
    stopped = true;
    if (runtime) await runtime.stop().catch(() => {});
    await closeFirmDbPool().catch(() => {});
    if (ownedProviders) ownedProviders.restore();
    if (db) {
      await db.scratch.end().catch(() => {});
      await db.admin.query(
        'select pg_terminate_backend(pid) from pg_stat_activity where datname = $1 and pid <> pg_backend_pid()',
        [dbName]
      ).catch(() => {});
      await db.admin.query(`drop database if exists "${dbName}"`).catch(() => {});
      await db.admin.end().catch(() => {});
    }
    if (blobDir) await rm(blobDir, { recursive: true, force: true }).catch(() => {});
    if (socketPath) await rm(socketPath, { force: true }).catch(() => {});
    restoreEnv();
  };

  try {
    // A pool left over from an earlier boot in this process would point at a
    // dropped database; the firmDb pool is lazy and re-reads DATABASE_URL.
    await closeFirmDbPool();
    // INV-24: refuse the appliance cluster BEFORE any `create database`.
    await assertNotApplianceCluster({ adminUrl: pgTestUrl, scratchDbName: dbName, objectRoot: process.env.DONNA_DESKTOP_BLOB_DIR || null, file: applianceFingerprintFile });
    db = await provisionScratchDatabase({ adminUrl: pgTestUrl, dbName });
    blobDir = await mkdtemp(path.join(os.tmpdir(), 'donna-appliance-'));
    const port = listen === 'tcp' ? await freeLoopbackPort() : null;
    socketPath = listen === 'socket' ? path.join(os.tmpdir(), `donna-appliance-${runToken}.sock`) : null;
    const baseUrl = socketPath ? 'http://local-runtime' : `http://127.0.0.1:${port}`;

    // ── Env staging: the appliance's launch line ──
    process.env.DATABASE_URL = db.url;
    process.env.DATABASE_POOL_MAX = process.env.DATABASE_POOL_MAX || '6';
    // NOT the minted firm: the runtime's sole-firm boot resolution adopts it
    // (F-03 territory — the harness must not paper over the resolver).
    delete process.env.DONNA_DEFAULT_FIRM_ID;
    process.env.DONNA_DESKTOP_BLOB_DIR = blobDir;
    process.env.DONNA_BUILD_COMMIT_SHA = `appliance-harness-${runToken}`;
    process.env.DONNA_BUILD_DIRTY = 'false';
    process.env.DONNA_RUNTIME_BUILD_DIRTY = 'false';
    process.env.DONNA_DESKTOP_SCHEDULER = 'on';
    process.env.DONNA_ACCESS_TOKEN = accessToken;
    delete process.env.CRON_SECRET;
    delete process.env.INNGEST_EVENT_KEY;
    delete process.env.INNGEST_SIGNING_KEY;
    process.env.CLIENT_CONFIG_FORCE_DISABLE = 'JEV_RECONCILIATION';
    delete process.env.PARSE_DRAIN_THRESHOLD_SECONDS;
    delete process.env.OPENAI_COMPATIBLE_BASE_URL;
    for (const [provider, envKey] of Object.entries(PROVIDER_KEY_ENV)) {
      if (wantKeys[provider]) process.env[envKey] = PRESENCE_ONLY_KEY(provider);
      else delete process.env[envKey];
    }
    for (const [key, value] of Object.entries(env)) {
      if (value === undefined || value === null) delete process.env[key];
      else process.env[key] = String(value);
    }

    // ── The isolated firm, minted through the EAW lifecycle writer ──
    const member = {
      id: `${firmId}-member-1`,
      name: firm.memberName || 'Appliance Harness Operator',
      email: firm.memberEmail || `appliance-${runToken}@example.invalid`
    };
    await createFirmInDb({
      firmId,
      name: firm.name || `Appliance Harness ${runToken}`,
      jurisdiction: firm.jurisdiction || 'GB',
      currency: firm.currency || 'GBP',
      actor: { type: 'operator', id: `appliance-harness-${runToken}` },
      member
    });

    // ── Providers at the wire, before anything can dial out. A controller
    // passed in stays the caller's (and is not restored by stop()). ──
    ownedProviders = providers ? null : installRecordedProviders({ now: clock.now });
    const providerController = providers || ownedProviders;

    // ── Boot the assembly the shell boots ──
    runtime = await createDonnaRuntimeServer({
      listen: socketPath ? { socketPath } : { host: '127.0.0.1', port },
      logger: captured.logger
    });
    for (const [provider, envKey] of Object.entries(PROVIDER_KEY_ENV)) {
      if (!wantKeys[provider] && process.env[envKey]) {
        throw new Error(
          `appliance harness: ${envKey} was requested dark but the boot filled it `
          + `(${path.basename(dotEnvSupplyingProviderKey(envKey) || 'unknown source')}); `
          + 'skip with applianceHarnessSkipReason({ dark: [...] })'
        );
      }
    }
    // Take over dispatch (see "the clock" in the header). The admission
    // verdict is preserved: runtime.schedulerRunning() still answers.
    if (runtime.scheduler) await runtime.scheduler.stop();
    // The persisted cron baseline follows the harness clock so a fixture's
    // first tick() sees exactly one minute pass, whatever the wall clock says.
    await db.scratch.query('update local_job_cron_state set last_enqueued_tick = $1::timestamptz', [clock.now().toISOString()]);

    // ── HTTP to the runtime (both listen modes, any method, any body) ──
    const request = ({ method = 'GET', path: requestPath, headers = {}, body, auth = false } = {}) =>
      new Promise((resolve, reject) => {
        if (!requestPath) return reject(new Error('appliance harness: request needs a path'));
        const payload = body == null
          ? null
          : Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
        const normalizedHeaders = Object.fromEntries(Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]));
        if (payload && !Buffer.isBuffer(body) && typeof body !== 'string' && !normalizedHeaders['content-type']) {
          normalizedHeaders['content-type'] = 'application/json';
        }
        if (auth) normalizedHeaders.authorization = `Bearer ${accessToken}`;
        if (payload) normalizedHeaders['content-length'] = String(payload.length);
        const req = http.request(
          {
            ...(socketPath ? { socketPath } : { host: '127.0.0.1', port }),
            method,
            path: requestPath,
            headers: normalizedHeaders
          },
          (res) => {
            const chunks = [];
            res.on('data', (chunk) => chunks.push(chunk));
            res.on('end', () => {
              const text = Buffer.concat(chunks).toString('utf8');
              let json = null;
              try { json = text ? JSON.parse(text) : null; } catch { json = null; }
              resolve({ status: res.statusCode, ok: res.statusCode >= 200 && res.statusCode < 300, headers: res.headers, text, json });
            });
          }
        );
        req.on('error', reject);
        if (payload) req.write(payload);
        req.end();
      });

    const expectStatus = (response, expected, what) => {
      if (response.status !== expected) {
        throw Object.assign(
          new Error(`appliance harness: ${what} → ${response.status} (expected ${expected}): ${response.text.slice(0, 400)}`),
          { response }
        );
      }
      return response;
    };

    // ── Reads: the persisted rows, straight from the scratch database ──
    const query = (text, params = []) => db.scratch.query(text, params);
    const rows = async (text, params) => (await query(text, params)).rows;
    const read = {
      host: async () => (await rows(
        `select h.host_id, h.status, h.reason_code, h.checked_at, h.valid_until, a.certificate
           from runtime_host_readiness h
           left join runtime_host_readiness_attempts a on a.id = h.latest_attempt_id
          where h.host_id = 'desktop-local'`
      ))[0] || null,
      readiness: async (clientId) => (await rows(
        'select * from entity_readiness_sagas where firm_id = $1 and client_id = $2',
        [firmId, clientId]
      ))[0] || null,
      flags: (clientId) => rows(
        'select flag_key, stage, source, reason, valid_to from client_capability_config where firm_id = $1 and client_id = $2 order by flag_key',
        [firmId, clientId]
      ),
      document: async (documentId) => (await rows(
        'select * from documents where firm_id = $1 and id = $2',
        [firmId, documentId]
      ))[0] || null,
      documents: (clientId) => rows(
        'select * from documents where firm_id = $1 and client_id = $2 order by created_at, id',
        [firmId, clientId]
      ),
      documentLines: (documentId) => rows(
        'select * from document_lines where firm_id = $1 and document_id = $2 order by created_at, id',
        [firmId, documentId]
      ),
      transactions: (clientId) => rows(
        'select * from transactions where firm_id = $1 and client_id = $2 order by transaction_date, id',
        [firmId, clientId]
      ),
      matches: (clientId) => rows(
        'select * from reconciliation_matches where firm_id = $1 and client_id = $2 order by updated_at, id',
        [firmId, clientId]
      ),
      evaluations: (clientId, { targetId = null } = {}) => rows(
        `select * from reconciliation_evaluations
          where firm_id = $1 and client_id = $2 and ($3::text is null or target_id = $3)
          order by evaluated_at, id`,
        [firmId, clientId, targetId]
      ),
      asks: (clientId) => rows(
        'select * from client_evidence_requests where firm_id = $1 and client_id = $2 order by created_at, id',
        [firmId, clientId]
      ),
      reviewQueue: (clientId) => rows(
        'select * from transaction_review_queue where firm_id = $1 and client_id = $2 order by created_at, id',
        [firmId, clientId]
      ),
      audit: ({ clientId = null, action = null } = {}) => rows(
        `select id, client_id, actor_type, actor_id, action, resource_type, resource_id, metadata, created_at
           from audit_events
          where firm_id = $1 and ($2::text is null or client_id = $2) and ($3::text is null or action = $3)
          order by id`,
        [firmId, clientId, action]
      ),
      jobs: ({ functionId = null } = {}) => rows(
        `select id, function_id, status, run_at, attempt_count, max_attempts, last_error, result, dedupe_key, completed_at
           from local_jobs where ($1::text is null or function_id = $1) order by id`,
        [functionId]
      ),
      cronState: () => rows('select function_id, last_enqueued_tick, updated_at from local_job_cron_state order by function_id'),
      localEvidence: async (key) => (await rows(
        'select bucket, key, content_hash, byte_length, content_type from local_evidence_objects where key = $1',
        [key]
      ))[0] || null
    };

    // ── Clients: the real authenticated create route (plane rows + readiness) ──
    let clientSeq = 0;
    let documentSeq = 0;
    let batchSeq = 0;
    const createClient = async ({ id = null, profile = {} } = {}) => {
      clientSeq += 1;
      const clientId = id || `${firmId}-client-${clientSeq}`;
      assertApplianceRunIdentity({ runToken, firmId, clientId });
      const response = await request({
        method: 'POST',
        path: '/api/donna/firms/clients',
        auth: true,
        body: {
          firm_id: firmId,
          profile: {
            companyName: 'Kestrel Print Studio Ltd',
            entityType: 'gb-ltd',
            jurisdiction: 'GB',
            stage: 'active',
            accounting_system: 'none',
            accounting_basis: 'management_books',
            ...profile,
            id: clientId
          },
          queue: []
        }
      });
      expectStatus(response, 200, 'POST /api/donna/firms/clients');
      return { clientId, response: response.json, readiness: await read.readiness(clientId), flags: await read.flags(clientId) };
    };

    // ── Documents: upload-url → signed local PUT → register, the SPA's path ──
    const uploadDocument = async ({
      clientId,
      fixture = null,
      bytes = null,
      filename = null,
      mimeType = null,
      documentType = null,
      documentId = null,
      batchId = null,
      uploadedAt = null,
      note = 'appliance harness upload'
    } = {}) => {
      if (!clientId) throw new Error('appliance harness: uploadDocument needs clientId');
      const source = fixture ? loadApplianceFixture(fixture) : null;
      const fileBytes = bytes || source?.bytes;
      const fileName = filename || source?.filename;
      const mime = mimeType || source?.mimeType || 'application/pdf';
      const declaredType = documentType || source?.documentType || 'unknown';
      if (!Buffer.isBuffer(fileBytes) || !fileBytes.length || !fileName) {
        throw new Error('appliance harness: uploadDocument needs a fixture or bytes + filename');
      }
      documentSeq += 1;
      const id = documentId || `${clientId}-doc-${documentSeq}`;
      assertApplianceRunIdentity({ runToken, firmId, clientId, documentId: id });
      const checksum = createHash('sha256').update(fileBytes).digest('hex');
      const receipts = {};

      const signed = await request({
        method: 'POST',
        path: '/api/donna/firms/documents/upload-url',
        auth: true,
        body: { firm_id: firmId, client_id: clientId, filename: fileName, mime_type: mime, size: fileBytes.length, checksum_sha256: checksum }
      });
      receipts.upload_sign = signed.json;
      expectStatus(signed, 200, 'POST /documents/upload-url');
      const storageRef = { bucket: signed.json.bucket, key: signed.json.key, provider: signed.json.provider };

      const signedUrl = new URL(signed.json.signed_url, baseUrl);
      const put = await request({
        method: 'PUT',
        path: `${signedUrl.pathname}${signedUrl.search}`,
        headers: { 'content-type': mime, 'x-upsert': 'false' },
        body: fileBytes
      });
      receipts.blob_put = put.json;
      expectStatus(put, 200, 'PUT signed local evidence');

      batchSeq += 1;
      const batch = batchId || `${runToken}-batch-${batchSeq}`;
      const registration = await request({
        method: 'POST',
        path: '/api/donna/firms/documents/register',
        auth: true,
        body: {
          firm_id: firmId,
          documents: [{
            id,
            client_id: clientId,
            filename: fileName,
            document_type: declaredType,
            uploaded_at: uploadedAt ?? clock.now().getTime(),
            source: 'firm_intake',
            storage_bucket: storageRef.bucket,
            storage_object_key: storageRef.key,
            checksum_sha256: checksum,
            file_storage: {
              mode: 'object_storage',
              provider: storageRef.provider,
              bucket: storageRef.bucket,
              key: storageRef.key,
              checksum_sha256: checksum,
              filename: fileName,
              mime_type: mime,
              size: fileBytes.length,
              note
            },
            batch_id: batch
          }]
        }
      });
      receipts.register = registration.json;
      expectStatus(registration, 200, 'POST /documents/register');
      const registered = registration.json?.documents?.[0] || null;
      return { documentId: id, clientId, storageRef, checksum, registered, receipts, fixture: source };
    };

    // ── Dispatch: one scheduler minute, deterministic ──
    const promptDueEntityHeal = makePromptDueEntityHeal({ withFirmDbClientFn: withFirmDbClient, logger: captured.logger });
    // The deterministic rounds live in desktop/manifestTicker.js (shared
    // with the zero-key demo, scripts/demo_fi.mjs).
    const ticker = createManifestTicker({
      manifest: runtime.manifest,
      query: (text, params) => query(text, params),
      clock,
      logger: captured.logger,
      workerId: `appliance-harness-${runToken}`,
      onQueueActivity: (activity) => promptDueEntityHeal(activity)
    });
    const collapseQueueWaits = ticker.collapseQueueWaits;
    const tick = async (options = {}) => {
      const linesBefore = captured.lines.length;
      const receipt = await ticker.tick(options);
      return { ...receipt, log: captured.lines.slice(linesBefore) };
    };

    return Object.freeze({
      runToken,
      firmId,
      memberId: member.id,
      accessToken,
      baseUrl,
      port,
      socketPath,
      blobDir,
      databaseUrl: db.url,
      migrations: db.migrations,
      runtime,
      manifest: runtime.manifest,
      clock,
      providers: providerController,
      logs: captured.lines,
      api: {
        request,
        health: () => request({ path: '/api/donna/firms/health' })
      },
      query,
      read,
      createClient,
      uploadDocument,
      tick,
      collapseQueueWaits,
      stop
    });
  } catch (error) {
    await stop();
    throw error;
  }
};
