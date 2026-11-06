// server/donna/db/pool.js — the PostgreSQL pool and client checkout (RT-13's convergence settle hook is installed here, with the pool), the database-url and production-isolation helpers.
//
// RT-17 (2026-09-02): extracted from server/donna/firmDb.js as a pure move. Every public
// symbol keeps its old import path through firmDb.js, which re-exports it; helpers another
// plane needs are exported here and NOT re-exported by firmDb.js. Zero behaviour change.

import { existsSync, readFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import { installConvergenceSettleOnPool } from '../reconcileConvergenceState.js';
import { cleanupAdmissionLeasesAtCheckoutEnd, retainAdmissionCleanupCause } from './admissionLeaseLifecycle.js';

let poolPromise = null;
let initializedPool = null;
let dotEnvCache = null;

// Diagnostics must not initialize a pool, await acquisition, or run SQL while
// reporting a failed read. Only expose counts already held by this process.
export const readFirmDbPoolCounts = () => {
  if (!initializedPool) return null;
  const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
  return { total: count(initializedPool.totalCount), idle: count(initializedPool.idleCount),
    waiting: count(initializedPool.waitingCount), max: count(initializedPool.options?.max) };
};

// API seam tests exercise the real request router without opening a socket or
// connecting to Postgres. Keep this deliberately tiny: production still owns
// pool construction, while tests may replace only the cached Pool promise.
// An injected pool belongs to its injector: the hosted release below never
// ends it (`owned: true` is only for the release's own unit tests). PR #2190's
// first cut ended injected pools too — the real-PG suites that drive the
// router on a real HTTP server (partialUploadHttpProof.js) then lost their
// pool mid-test, their teardown failed on the already-ended pool, and the
// leaked admin client kept node --test alive: the cloud-readiness job hung
// until the 6-hour runner limit (2026-09-21).
export const __setFirmDbPoolForTests = (fakePool, { owned = false } = {}) => {
  poolPromise = Promise.resolve(fakePool);
  initializedPool = fakePool;
  poolOwnedByRuntime = owned;
};

export const __resetFirmDbPoolForTests = () => {
  poolPromise = null;
  initializedPool = null;
  poolOwnedByRuntime = false;
  activeHostedInvocations = 0;
};

// ─── Hosted (serverless) session hygiene ─────────────────────────────────────
//
// The hosted database URL is the Supabase pooler in SESSION mode: every pg
// client this process keeps open holds one pooler session, and the pooler
// caps sessions at its pool_size (30 on 2026-09-21 — `EMAXCONNSESSION max
// clients reached in session mode`, Kampaamo re-upload). Session mode is not
// negotiable here: the readiness admission leases and the worker leases are
// session-level advisory locks (admissionLeaseLifecycle.js refuses the
// transaction endpoint by name).
//
// A Vercel function instance is frozen once its invocation has responded. A
// frozen instance cannot run pg-pool's idle reaper (idleTimeoutMillis), so
// each warm instance keeps up to `max` sessions open for as long as the
// platform keeps it around — and the platform fans one instance out per
// concurrent invocation: eight parallel parse runs, the per-minute cron
// tasks, every request the books screen makes. Fifteen warm instances × two
// idle clients is the whole cap, before a single request does any work.
//
// The remedy is to hold NO session while frozen: an invocation's response
// finishing hands its idle clients back to the pooler when nothing else in
// this instance is using them. The next invocation rebuilds the pool through
// loadPgPool (one connect, same as the reaper's cost after ten idle seconds).
// Only the hosted entry points (api/donna-router.js, api/inngest.js) track
// their invocations; the appliance and the CLI never call this, so their
// long-lived pool is untouched.
let activeHostedInvocations = 0;
// True only for a pool loadPgPool built in this process. The release ends
// nothing else: a pool handed in through the test seam is its owner's to end.
let poolOwnedByRuntime = false;

export const readHostedInvocationCount = () => activeHostedInvocations;

// End the pool when this instance has nothing checked out and nobody waiting,
// so a frozen instance holds zero pooler sessions. Returns a receipt; never
// throws, never touches a pool that is in use (fluid concurrency: another
// invocation still running here releases at its own end).
export const releaseFirmDbPoolWhenIdle = async () => {
  const pool = initializedPool;
  if (!pool || !poolPromise) return { released: false, reason: 'no_pool' };
  if (!poolOwnedByRuntime) return { released: false, reason: 'not_owned' };
  if (activeHostedInvocations > 0) return { released: false, reason: 'invocation_active', active: activeHostedInvocations };
  const counts = readFirmDbPoolCounts();
  if (counts.total == null || counts.idle == null || counts.waiting == null) return { released: false, reason: 'counts_unavailable' };
  if (counts.waiting > 0 || counts.total !== counts.idle) return { released: false, reason: 'in_use', ...counts };
  if (typeof pool.end !== 'function') return { released: false, reason: 'not_endable' };
  // Detach BEFORE ending (no await in between): a concurrent loadPgPool call
  // builds a fresh pool instead of racing this one's end.
  poolPromise = null;
  initializedPool = null;
  poolOwnedByRuntime = false;
  try { await pool.end(); }
  catch (error) { return { released: true, reason: 'end_failed', error: error?.message || String(error), ...counts }; }
  return { released: true, ...counts };
};

// Count one hosted invocation from now until its response finishes or its
// connection closes; the last invocation out releases the idle pool. Returns
// the settle function for hosts that end a response without the events.
export const trackHostedInvocation = (res, { release = releaseFirmDbPoolWhenIdle, log = console } = {}) => {
  activeHostedInvocations += 1;
  let settled = false;
  const settle = () => {
    if (settled) return;
    settled = true;
    activeHostedInvocations = Math.max(0, activeHostedInvocations - 1);
    if (activeHostedInvocations > 0) return;
    release().then((receipt) => {
      if (receipt?.reason === 'end_failed') log.warn?.(`[firmDb] hosted pool release failed: ${receipt.error}`);
    }).catch((error) => log.warn?.(`[firmDb] hosted pool release threw: ${error?.message || error}`));
  };
  res?.once?.('finish', settle);
  res?.once?.('close', settle);
  return settle;
};

// Bounded host tools and real-PG tests must RELEASE the pool before their
// process exits or drops a scratch database. The long-lived API/runtime never
// calls this; it retains the pool for its normal lifetime.
export const closeFirmDbPool = async () => {
  const pending = poolPromise;
  poolPromise = null;
  const pool = pending ? await pending.catch(() => null) : null;
  if (initializedPool === pool) { initializedPool = null; poolOwnedByRuntime = false; }
  if (pool && typeof pool.end === 'function') await pool.end().catch(() => {});
};

// Backward-compatible name for the real-PG lifecycle suites that introduced
// the pool-drain seam before host tooling needed it too.
export const __endFirmDbPoolForTests = closeFirmDbPool;

const readDotEnv = () => {
  if (dotEnvCache) return dotEnvCache;
  const vars = {};
  try {
    const envPath = resolvePath(process.cwd(), '.env');
    if (existsSync(envPath)) {
      for (const line of readFileSync(envPath, 'utf8').split('\n')) {
        const match = line.match(/^(\w+)=(.*)$/);
        if (match) vars[match[1]] = match[2].trim().replace(/^['"]|['"]$/g, '');
      }
    }
  } catch {
    // Best-effort dotenv fallback for local development.
  }
  dotEnvCache = vars;
  return vars;
};

export const getFirmDatabaseUrl = (env = process.env) => {
  const dotEnv = readDotEnv();
  return (
    env.DATABASE_URL ||
    env.POSTGRES_URL ||
    env.SUPABASE_DB_URL ||
    dotEnv.DATABASE_URL ||
    dotEnv.POSTGRES_URL ||
    dotEnv.SUPABASE_DB_URL ||
    ''
  );
};

export const isFirmDatabaseConfigured = () => Boolean(getFirmDatabaseUrl());

// ─── Production isolation: never silently serve or seed demo data ───────────
//
// The in-memory seed snapshot is a LOCAL-DEV convenience. In a real deployment
// it is a hazard: a missing or mistyped DATABASE_URL would silently serve demo
// books to a real user, and a careless `npm run db:seed` would clobber a real
// database with demo rows. These pure helpers encode the policy that makes both
// fail loudly instead. Pure (env/argv injectable) so they are unit-tested.

// True in a real hosted deployment (Vercel production or NODE_ENV=production),
// where serving/seeding demo data must be refused rather than treated as a
// convenience.
export const isProductionRuntime = (env = process.env) =>
  env.VERCEL_ENV === 'production' || env.NODE_ENV === 'production';

// Whether falling back to the in-memory seed snapshot is acceptable when the DB
// is unconfigured. Allowed outside production, or when an operator explicitly
// opts in for an intentional demo deployment.
export const isSeedFallbackAllowed = (env = process.env) =>
  env.DONNA_ALLOW_SEED_FALLBACK === 'true' || !isProductionRuntime(env);

// A local Postgres target (safe to seed freely). A hosted host is the kind a
// careless seed could clobber. Unparseable → treated as non-local (fail safe).
export const isLocalDatabaseUrl = (url = '') => {
  const value = String(url || '');
  if (!value) return false;
  let host = '';
  try {
    host = new URL(value).hostname;
  } catch {
    const match = value.match(/@([^:/?]+)/);
    host = match ? match[1] : '';
  }
  host = host.toLowerCase();
  return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]' || host.endsWith('.local');
};

// Guard for the seed/demo scripts: refuse to write demo data into a non-local
// database unless explicitly forced (--force or DONNA_ALLOW_SEED=true). Returns
// the resolved { host, forced } when allowed; throws otherwise. The footgun this
// closes is `npm run db:seed` against a production connection string.
export const assertSeedTargetAllowed = ({
  databaseUrl = getFirmDatabaseUrl(),
  env = process.env,
  argv = process.argv
} = {}) => {
  if (!databaseUrl) {
    throw new Error('Firm database is not configured. Set DATABASE_URL before seeding.');
  }
  let host = '(unparseable)';
  try { host = new URL(databaseUrl).hostname; } catch { /* keep placeholder */ }
  const forced = (Array.isArray(argv) && argv.includes('--force')) || env.DONNA_ALLOW_SEED === 'true';
  if (!isLocalDatabaseUrl(databaseUrl) && !forced) {
    throw new Error(
      `Refusing to seed demo data into a non-local database (host: ${host}). ` +
      'This guards against clobbering production. Re-run with --force or DONNA_ALLOW_SEED=true if you are certain.'
    );
  }
  return { host, forced };
};

export const loadPgPool = async () => {
  if (poolPromise) return poolPromise;

  poolPromise = (async () => {
    const databaseUrl = getFirmDatabaseUrl();
    if (!databaseUrl) return null;

    const { Pool } = await import('pg');
    const needsHostedSsl = /supabase|neon|render|railway|amazonaws/i.test(databaseUrl);
    const pool = new Pool({
      connectionString: databaseUrl,
      max: Number(process.env.DATABASE_POOL_MAX || 2),
      idleTimeoutMillis: 10_000,
      // Fail loud on pool exhaustion. Without this, a caller that can never
      // get a connection waits FOREVER — which is how the local-blob nested
      // acquisition presented as a total silent freeze (every upload stuck
      // at "Uploading 0%") instead of an error anyone could see. 30s is
      // far beyond any healthy acquisition (local PG or hosted); hitting it
      // means the pool is starved and the request should error, not hang.
      connectionTimeoutMillis: Number(process.env.DATABASE_POOL_CONNECT_TIMEOUT_MS || 30_000),
      ssl: needsHostedSsl
        ? { rejectUnauthorized: process.env.DATABASE_SSL_REJECT_UNAUTHORIZED === 'true' }
        : undefined
    });
    // RT-13 — the persisted convergence verdict's write-through seam: every
    // firm-database access goes through this pool, so this ONE call hooks
    // checked-out clients (settle the transaction's marks right before its
    // COMMIT, sweep on release) and write-shaped pool.query calls (sweep
    // after). The law itself lives in reconcileConvergenceState.js; firmDb.js
    // adds nothing.
    poolOwnedByRuntime = true;
    installConvergenceSettleOnPool(pool);
    // node-postgres emits 'error' on the Pool for a backend failure on an
    // IDLE client (a hosted-PG restart/failover, or a scratch-DB force-drop
    // in the real-PG test suites) — and with no listener that crashes the
    // whole process as an uncaughtException. The pool already discards the
    // broken client, and an in-flight query still rejects to its caller, so
    // handling here loses nothing fail-loud: it only stops a background
    // disconnect from taking down the runtime (or failing an unrelated test).
    pool.on('error', (error) => {
      console.warn(`[firmDb] idle pool client error handled: ${error?.message || error}`);
    });
    initializedPool = pool;
    return pool;
  })();

  return poolPromise;
};

export const queryFirmDb = async (text, params = []) => {
  const pool = await loadPgPool();
  if (!pool) {
    const error = new Error('Firm database is not configured. Set DATABASE_URL to enable Postgres-backed firm data.');
    error.code = 'FIRM_DB_NOT_CONFIGURED';
    throw error;
  }
  return pool.query(text, params);
};

// All firm ids, for fleet-wide periodic jobs (e.g. the daily convergence-metrics
// sampler in the parse-cron worker). Ordered for stable iteration.
export const listFirmIdsInDb = async () => {
  const result = await queryFirmDb('select id from firms order by id');
  return (result.rows || []).map((row) => row.id);
};

export const queryOptionalFirmDb = async (text, params = []) => {
  try {
    return await queryFirmDb(text, params);
  } catch (error) {
    if (error?.code === '42P01' || error?.code === '42703') return { rows: [] };
    throw error;
  }
};

export const withFirmDbClient = async (callback) => {
  const pool = await loadPgPool();
  if (!pool) {
    const error = new Error('Firm database is not configured. Set DATABASE_URL to enable Postgres-backed firm data.');
    error.code = 'FIRM_DB_NOT_CONFIGURED';
    throw error;
  }

  const client = await pool.connect();
  let firstError;
  try {
    return await callback(client);
  } catch (error) {
    firstError = error;
    throw error;
  } finally {
    let cleanupError;
    try { await cleanupAdmissionLeasesAtCheckoutEnd(client); }
    catch (error) { cleanupError = error; }
    // A connection with an unresolved session lease must not return to the
    // healthy pool. Cleanup runs before the convergence release hook as well.
    // The installed convergence release hook returns a promise. Its checkout
    // must be back in the pool before a caller starts a response snapshot.
    try { await client.release(cleanupError); }
    catch (error) {
      if (cleanupError) retainAdmissionCleanupCause(cleanupError, error);
      else cleanupError = error;
    }
    if (cleanupError) {
      if (firstError) retainAdmissionCleanupCause(firstError, cleanupError);
      else throw cleanupError;
    }
  }
};
