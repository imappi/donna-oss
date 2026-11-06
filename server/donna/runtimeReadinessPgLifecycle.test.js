// Gate 1B.1 — real PostgreSQL lifecycle certificate.
//
// Full migrations, real Host A database/queue/local-storage probes, the shared
// client writer, persisted Entity B attempts, snapshot projection and bounded
// retry all run against one throwaway PostgreSQL 16 database. Missing PG is a
// visible skip locally; CI always supplies DONNA_PG_TEST_URL.

import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import pg from 'pg';

import { buildDesktopHandlerManifest } from './desktop/handlerManifest.js';
import { createLocalScheduler } from './desktop/localScheduler.js';
import { createDonnaRuntimeServer } from './desktop/runtimeServer.js';
import { DESKTOP_CLIENT_FLAG_SEEDS } from './desktop/hostPlaneSeed.js';
import {
  __endFirmDbPoolForTests,
  createClientInDb,
  getFirmSnapshotFromDb,
  queryFirmDb,
  withFirmDbClient
} from './firmDb.js';
import { observeHostCertificateA } from './hostCertificateA.js';
import {
  ENTITY_READINESS_MAX_ATTEMPTS,
  EntityReadinessRetryError,
  persistHostReadinessAttempt,
  provisionEntityReadiness
} from './runtimeReadiness.js';
import { evaluateEntityReadinessAdmissionWithClient } from './runtimeReadinessAdmission.js';
import { setClientFlagStage } from './clientConfig.js';

const PG_URL = process.env.DONNA_PG_TEST_URL || '';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const FIRM_ID = 'firm-readiness-pg';
const MEMBER_ID = 'member-readiness-pg';
const CLIENT_ID = 'client-readiness-pg';
const LEGACY_CLIENT_ID = 'client-readiness-legacy';

const restoreEnv = (key, value) => {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
};

const addMs = (iso, delta) => new Date(new Date(iso).getTime() + delta).toISOString();

const waitFor = async (probe, { timeoutMs = 15_000, intervalMs = 100, label = 'condition' } = {}) => {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await probe();
    if (last) return last;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`Timed out waiting for ${label}; last=${JSON.stringify(last)}`);
};

test(
  'real PG: Host A boot + entity create/retry are persisted, bounded and visible without rewriting legacy entities',
  { skip: PG_URL ? false : 'DONNA_PG_TEST_URL not set — Gate 1B.1 real lifecycle not exercised' },
  async () => {
    const dbName = `donna_readiness_${Date.now().toString(36)}_${process.pid}`;
    const blobDir = await mkdtemp(path.join(os.tmpdir(), 'donna-readiness-blobs-'));
    const admin = new pg.Client({ connectionString: PG_URL });
    await admin.connect();
    await admin.query(`create database "${dbName}"`);
    const scratchUrl = new URL(PG_URL);
    scratchUrl.pathname = `/${dbName}`;
    const seed = new pg.Client({ connectionString: scratchUrl.toString() });
    await seed.connect();

    const envKeys = [
      'DATABASE_URL',
      'DATABASE_POOL_MAX',
      'DONNA_DEFAULT_FIRM_ID',
      'DONNA_DESKTOP_BLOB_DIR',
      'DONNA_BUILD_COMMIT_SHA',
      'DONNA_BUILD_DIRTY',
      'DONNA_RUNTIME_BUILD_DIRTY',
      'DONNA_DESKTOP_SCHEDULER',
      'DONNA_ACCESS_TOKEN',
      'OPENAI_API_KEY',
      'ANTHROPIC_API_KEY'
    ];
    const priorEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));

    try {
      await seed.query(`
        create schema if not exists storage;
        create table if not exists storage.buckets (
          id text primary key, name text, public boolean,
          file_size_limit bigint, allowed_mime_types text[]);
        create table if not exists storage.objects (
          id uuid default gen_random_uuid() primary key,
          bucket_id text references storage.buckets(id), name text, metadata jsonb);
      `);
      const migrations = (await readdir(path.join(ROOT, 'db', 'migrations')))
        .filter((file) => file.endsWith('.sql'))
        .sort();
      for (const file of migrations) {
        await seed.query(await readFile(path.join(ROOT, 'db', 'migrations', file), 'utf8'));
        await seed.query(
          'insert into schema_migrations (version) values ($1) on conflict (version) do nothing',
          [file.replace(/\.sql$/, '')]
        );
      }

      await seed.query(
        `insert into firms (id, name, slug, jurisdiction, default_currency)
         values ($1, 'Readiness Firm', 'readiness-firm', 'GB', 'GBP')`,
        [FIRM_ID]
      );
      await seed.query(
        `insert into firm_members (id, firm_id, email, name, role, status)
         values ($1, $2, 'founder@readiness.test', 'Readiness Founder', 'admin', 'active')`,
        [MEMBER_ID, FIRM_ID]
      );

      process.env.DATABASE_URL = scratchUrl.toString();
      process.env.DATABASE_POOL_MAX = '1';
      process.env.DONNA_DEFAULT_FIRM_ID = FIRM_ID;
      process.env.DONNA_DESKTOP_BLOB_DIR = blobDir;
      process.env.DONNA_BUILD_COMMIT_SHA = 'gate1b1-real-pg-build';
      process.env.DONNA_BUILD_DIRTY = 'false';
      process.env.DONNA_RUNTIME_BUILD_DIRTY = 'false';
      process.env.DONNA_DESKTOP_SCHEDULER = 'on';
      process.env.DONNA_ACCESS_TOKEN = 'gate1b1-runtime-token';
      process.env.OPENAI_API_KEY = 'gate1b1-presence-only';
      process.env.ANTHROPIC_API_KEY = 'gate1b1-presence-only';

      const manifest = buildDesktopHandlerManifest({ rootDir: ROOT });
      const scheduler = createLocalScheduler({
        manifest,
        client: seed,
        pollIntervalMs: 60 * 60 * 1000
      });
      await scheduler.initialize();

      const baseAt = new Date().toISOString();
      const hostCertificate = await observeHostCertificateA({
        env: process.env,
        rootDir: ROOT,
        observedAt: baseAt,
        manifest,
        schedulerEnabled: true,
        query: (text, params) => queryFirmDb(text, params)
      });
      assert.equal(hostCertificate.status, 'PASS', JSON.stringify(hostCertificate.checks, null, 2));
      const hostPersisted = await persistHostReadinessAttempt({
        withFirmDbClientFn: withFirmDbClient,
        certificate: hostCertificate,
        eventType: 'boot'
      });
      assert.equal(hostPersisted.attempt_count, 1);
      const hostReplay = await persistHostReadinessAttempt({
        withFirmDbClientFn: withFirmDbClient,
        certificate: hostCertificate,
        eventType: 'boot'
      });
      assert.equal(hostReplay.attempt_count, 1, 'replaying one Host A receipt is idempotent');

      await createClientInDb({
        firmId: FIRM_ID,
        profile: {
          id: CLIENT_ID,
          companyName: 'Ready Apiary Ltd',
          jurisdiction: 'GB',
          entityType: 'gb-ltd'
        },
        creationPrincipal: {
          principalType: 'firm_member',
          principalId: MEMBER_ID,
          authoritySource: 'gate1b1_real_pg'
        }
      });
      // Actual config-writer grants must survive Entity B and mutation admission,
      // not merely work in correction fixtures with readiness unenrolled.
      const correctionFlags = ['CODING_CORRECTION_AUTO_APPLY', 'CODING_OWNER_TRANSFER_POST'];
      for (const flagKey of correctionFlags) {
        assert.ok(!DESKTOP_CLIENT_FLAG_SEEDS.includes(flagKey));
        await setClientFlagStage(seed, { firmId: FIRM_ID, clientId: CLIENT_ID,
          flagKey, stage: 'canary', source: 'manual', actorType: 'firm_member', actorId: MEMBER_ID,
          reason: 'Synthetic exact-client correction lifecycle authority' });
      }
      const ready = await provisionEntityReadiness({
        withFirmDbClientFn: withFirmDbClient,
        firmId: FIRM_ID,
        clientId: CLIENT_ID,
        creationPath: 'desktop_firm_intake',
        observedAt: baseAt,
        initiatingPrincipal: { actor_type: 'firm_member', actor_id: MEMBER_ID },
        authorityBasis: { source: 'gate1b1_real_pg', principal_id: MEMBER_ID }
      });
      assert.equal(ready.certificate.status, 'PASS', JSON.stringify(ready.certificate.checks, null, 2));
      assert.equal(ready.row.state, 'ready');
      const correctionAdmission = await withFirmDbClient(client => evaluateEntityReadinessAdmissionWithClient({
        client, firmId: FIRM_ID, clientId: CLIENT_ID, boundary: 'worker_discovery', asOf: baseAt
      }));
      assert.equal(correctionAdmission.allowed, true, JSON.stringify(correctionAdmission));
      assert.deepEqual((await seed.query(
        'select flag_key,set_by_actor_id from client_capability_config where client_id=$1 and flag_key=any($2::text[]) and valid_to is null order by flag_key',
        [CLIENT_ID, correctionFlags]
      )).rows, correctionFlags.map(flag_key => ({ flag_key, set_by_actor_id: MEMBER_ID })));
      // Episode budget (migration 130): reaching 'ready' closes the episode
      // and rewinds the counter; the attempt receipts keep the history.
      assert.equal(Number(ready.row.attempt_count), 0);
      const readyReplay = await provisionEntityReadiness({
        withFirmDbClientFn: withFirmDbClient,
        firmId: FIRM_ID,
        clientId: CLIENT_ID,
        creationPath: 'desktop_firm_intake',
        observedAt: addMs(baseAt, 1_000),
        initiatingPrincipal: { actor_type: 'firm_member', actor_id: MEMBER_ID },
        authorityBasis: { source: 'gate1b1_real_pg', principal_id: MEMBER_ID }
      });
      assert.equal(readyReplay.accepted, false);
      assert.equal(readyReplay.reason, 'unchanged_ready_generation');
      assert.equal(Number(readyReplay.row.attempt_count), 0);

      let snapshot = await getFirmSnapshotFromDb({ firmId: FIRM_ID, observedAt: baseAt });
      const readyProjection = snapshot.clients.find(({ id }) => id === CLIENT_ID).runtime_readiness;
      assert.equal(readyProjection.effective_state, 'ready');
      assert.equal(readyProjection.mutation_ready, true);
      assert.equal('certificate_receipt' in readyProjection, false, 'routine API projection carries no raw certificate');

      // A desktop process can die after claiming a cron tick and before the
      // scheduler releases its lease. On the next boot Host A must continue to
      // block enrolled client mutations, while the real scheduler stays alive
      // to recover/supersede that queue residue. Stopping the scheduler here is
      // a permanent Host-A↔queue deadlock (the 2026-09-01 fresh-client outage).
      const expiredCron = manifest.find(({ functionId }) => functionId === 'parse-cron:coding_convergence');
      assert.ok(expiredCron?.cron, 'the production manifest must contain the coding-convergence cron recovery lane');
      await seed.query(
        `update local_job_cron_state
            set last_enqueued_tick = now() - interval '10 minutes'
          where function_id = $1`,
        [expiredCron.functionId]
      );
      const expiredJob = (await seed.query(
        `insert into local_jobs
           (function_id, handler_version, payload, dedupe_key, run_at,
            attempt_count, max_attempts, status, locked_by, locked_at, lease_expires_at)
         values ($1, $2, '{}'::jsonb, $3, now() - interval '2 hours',
                 1, 1, 'running', 'dead-desktop-process',
                 now() - interval '90 minutes', now() - interval '60 minutes')
         returning id`,
        [expiredCron.functionId, expiredCron.handlerVersion || '1', `gate1b1-expired-${process.pid}`]
      )).rows[0];
      const recoverySocketPath = `/tmp/donna-g1b1-recovery-${process.pid}.sock`;
      const recoveryRuntime = await createDonnaRuntimeServer({
        listen: { socketPath: recoverySocketPath },
        logger: { log: () => {}, error: () => {}, warn: () => {} }
      });
      try {
        const queueFailure = (await seed.query(
          `select h.status, h.reason_code, a.certificate
             from runtime_host_readiness h
             join runtime_host_readiness_attempts a on a.id = h.latest_attempt_id
            where h.host_id = 'desktop-local'`
        )).rows[0];
        assert.equal(
          recoveryRuntime.schedulerRunning(),
          true,
          `queue-only Host A failure admits the scheduler repair lane: ${JSON.stringify(queueFailure.certificate.checks)}`
        );
        assert.equal(queueFailure.status, 'FAIL');
        assert.equal(queueFailure.reason_code, 'work_queue_needs_recovery');
        const admission = await withFirmDbClient(async (client) => {
          await client.query('begin');
          try {
            return await evaluateEntityReadinessAdmissionWithClient({
              client,
              firmId: FIRM_ID,
              clientId: CLIENT_ID,
              boundary: 'upload_sign',
              asOf: new Date().toISOString()
            });
          } finally {
            await client.query('rollback');
          }
        });
        assert.equal(admission.allowed, false, 'recovery mode never broadens mutation admission');
        assert.equal(admission.reason_code, 'work_queue_needs_recovery');

        const recoveredProjection = await waitFor(async () => {
          const host = (await seed.query(
            `select status, reason_code, latest_attempt_id
               from runtime_host_readiness
              where host_id = 'desktop-local'`
          )).rows[0];
          return host?.status === 'PASS' ? host : null;
        }, { label: 'queue activity to mint an immediate Host A PASS' });
        assert.equal(recoveredProjection.reason_code, null);
        const recoveredJob = (await seed.query(
          'select status, completed_at from local_jobs where id = $1',
          [expiredJob.id]
        )).rows[0];
        assert.equal(recoveredJob.status, 'dead');
        const successor = (await seed.query(
          `select id, status, completed_at
             from local_jobs
            where function_id = $1
              and status = 'succeeded'
              and completed_at > $2
            order by completed_at desc
            limit 1`,
          [expiredCron.functionId, recoveredJob.completed_at]
        )).rows[0];
        assert.ok(successor, 'a later successful cron run supersedes the recovered dead lease');

        const admittedAfterRecovery = await withFirmDbClient(async (client) => {
          await client.query('begin');
          try {
            return await evaluateEntityReadinessAdmissionWithClient({
              client,
              firmId: FIRM_ID,
              clientId: CLIENT_ID,
              boundary: 'upload_sign',
              asOf: new Date().toISOString()
            });
          } finally {
            await client.query('rollback');
          }
        });
        assert.equal(admittedAfterRecovery.allowed, true, 'successful recovery removes the stale boot refusal immediately');
      } finally {
        await recoveryRuntime.stop();
        await rm(recoverySocketPath, { force: true });
      }

      await seed.query(
        `update client_capability_config set valid_to = now()
          where firm_id = $1 and client_id = $2 and flag_key = $3 and valid_to is null`,
        [FIRM_ID, CLIENT_ID, DESKTOP_CLIENT_FLAG_SEEDS[0]]
      );
      const failed = await provisionEntityReadiness({
        withFirmDbClientFn: withFirmDbClient,
        firmId: FIRM_ID,
        clientId: CLIENT_ID,
        retry: true,
        creationPath: 'desktop_firm_intake',
        lifecycle: 'retry',
        compatibilityScope: 'current_generation_compatibility',
        observedAt: addMs(baseAt, 60_000),
        initiatingPrincipal: { actor_type: 'firm_member', actor_id: MEMBER_ID },
        authorityBasis: { source: 'dependency_revalidation', principal_id: MEMBER_ID }
      });
      assert.equal(failed.row.state, 'failed');
      // The dependency expiry above already invalidated the ready saga
      // (episode closed at 0), so this failing retry is the NEW episode's
      // attempt 1 — three failures, not "ready plus two", exhaust it.
      assert.equal(Number(failed.row.attempt_count), 1);
      assert.equal(failed.row.retry_state, 'scheduled');

      const failedAgain = await provisionEntityReadiness({
        withFirmDbClientFn: withFirmDbClient,
        firmId: FIRM_ID,
        clientId: CLIENT_ID,
        retry: true,
        lifecycle: 'retry',
        compatibilityScope: 'current_generation_compatibility',
        observedAt: addMs(baseAt, 7 * 60_000),
        initiatingPrincipal: { actor_type: 'firm_member', actor_id: MEMBER_ID },
        authorityBasis: { source: 'authenticated_readiness_retry', principal_id: MEMBER_ID }
      });
      assert.equal(Number(failedAgain.row.attempt_count), 2);
      assert.equal(failedAgain.row.retry_state, 'scheduled');

      const exhausted = await provisionEntityReadiness({
        withFirmDbClientFn: withFirmDbClient,
        firmId: FIRM_ID,
        clientId: CLIENT_ID,
        retry: true,
        lifecycle: 'retry',
        compatibilityScope: 'current_generation_compatibility',
        observedAt: addMs(baseAt, 15 * 60_000),
        initiatingPrincipal: { actor_type: 'firm_member', actor_id: MEMBER_ID },
        authorityBasis: { source: 'authenticated_readiness_retry', principal_id: MEMBER_ID }
      });
      assert.equal(exhausted.row.saga_id, ready.row.saga_id);
      assert.equal(exhausted.row.idempotency_key, ready.row.idempotency_key);
      assert.equal(Number(exhausted.row.attempt_count), ENTITY_READINESS_MAX_ATTEMPTS);
      assert.equal(exhausted.row.retry_state, 'exhausted');
      assert.equal(Number(exhausted.row.root_cause_receipt_id), Number(failed.row.root_cause_receipt_id));

      await assert.rejects(
        provisionEntityReadiness({
          withFirmDbClientFn: withFirmDbClient,
          firmId: FIRM_ID,
          clientId: CLIENT_ID,
          retry: true,
          observedAt: addMs(baseAt, 16 * 60_000)
        }),
        (error) => error instanceof EntityReadinessRetryError
          && error.code === 'ENTITY_READINESS_RETRY_EXHAUSTED'
      );
      const attempts = await seed.query(
        `select id, metadata from audit_events
          where firm_id = $1 and client_id = $2 and action = 'entity.provisioning.attempt'
          order by id`,
        [FIRM_ID, CLIENT_ID]
      );
      // Four receipts: the ready birth (its episode closed at sequence 1),
      // then the failed episode's bounded 1..3.
      assert.equal(attempts.rowCount, ENTITY_READINESS_MAX_ATTEMPTS + 1);
      assert.deepEqual(attempts.rows.map(({ metadata }) => metadata.attempt_sequence), [1, 1, 2, 3]);
      assert.ok(attempts.rows.every(({ metadata }) => metadata.saga_id === ready.row.saga_id));

      // A client that genuinely predates desktop enrollment remains visible as
      // legacy without a mass rewrite. Gate 1B.3's create hook is desktop-only.
      const desktopBlobDir = process.env.DONNA_DESKTOP_BLOB_DIR;
      delete process.env.DONNA_DESKTOP_BLOB_DIR;
      try {
        await createClientInDb({
          firmId: FIRM_ID,
          profile: {
            id: LEGACY_CLIENT_ID,
            companyName: 'Legacy Apiary Ltd',
            jurisdiction: 'GB',
            entityType: 'gb-ltd'
          },
          creationPrincipal: {
            principalType: 'firm_member',
            principalId: MEMBER_ID,
            authoritySource: 'pre_gate1b_writer'
          }
        });
      } finally {
        process.env.DONNA_DESKTOP_BLOB_DIR = desktopBlobDir;
      }
      snapshot = await getFirmSnapshotFromDb({ firmId: FIRM_ID, observedAt: addMs(baseAt, 7 * 60_000) });
      assert.equal(snapshot.clients.find(({ id }) => id === LEGACY_CLIENT_ID).runtime_readiness.state, 'legacy_uncertified');
      assert.equal((await seed.query('select count(*)::int as n from entity_readiness_sagas')).rows[0].n, 1);
      assert.equal((await seed.query(
        `select count(*)::int as n from client_capability_config
          where firm_id = $1 and client_id = $2 and flag_key = 'ENTITY_READINESS_ADMISSION' and valid_to is null`,
        [FIRM_ID, LEGACY_CLIENT_ID]
      )).rows[0].n, 0);

      // A later failed Host A receipt changes only the host read model. Reads
      // and the entity rows remain available; effective mutation readiness is
      // false. The host receipt trail itself is database-immutable.
      const hostAttemptsBeforeFailure = Number((await seed.query(
        'select count(*)::int as n from runtime_host_readiness_attempts'
      )).rows[0].n);
      const failedHost = await observeHostCertificateA({
        env: { ...process.env, DONNA_BUILD_DIRTY: 'true', DONNA_RUNTIME_BUILD_DIRTY: 'true' },
        rootDir: ROOT,
        observedAt: new Date().toISOString(),
        manifest,
        schedulerEnabled: true,
        query: (text, params) => queryFirmDb(text, params)
      });
      assert.equal(failedHost.status, 'FAIL');
      await persistHostReadinessAttempt({
        withFirmDbClientFn: withFirmDbClient,
        certificate: failedHost,
        eventType: 'renewal'
      });
      const staleReplay = await persistHostReadinessAttempt({
        withFirmDbClientFn: withFirmDbClient,
        certificate: hostCertificate,
        eventType: 'retry'
      });
      assert.equal(staleReplay.status, 'FAIL', 'an older receipt replay cannot regress the current Host A row');
      assert.equal(staleReplay.attempt_count, hostAttemptsBeforeFailure + 1);
      snapshot = await getFirmSnapshotFromDb({ firmId: FIRM_ID });
      assert.equal(snapshot.runtimeReadinessHost.mutation_ready, false);
      assert.equal(snapshot.clients.length, 2, 'read snapshot remains available');
      assert.equal(
        (await seed.query('select count(*)::int as n from runtime_host_readiness_attempts')).rows[0].n,
        hostAttemptsBeforeFailure + 1
      );
      await assert.rejects(
        seed.query('update runtime_host_readiness_attempts set status = status where id = 1'),
        /append-only/
      );

      // Exercise the actual desktop assembly, not only its injected renewal
      // seam: a failed boot receipt leaves the router listening and the real
      // scheduler constructed but not running.
      process.env.DONNA_BUILD_DIRTY = 'true';
      process.env.DONNA_RUNTIME_BUILD_DIRTY = 'true';
      const runtime = await createDonnaRuntimeServer({
        listen: { socketPath: path.join(blobDir, 'gate1b1-runtime.sock') },
        logger: { log: () => {}, error: () => {} }
      });
      try {
        assert.equal(runtime.server.listening, true);
        assert.ok(runtime.scheduler, 'scheduler is present when the diagnostic kill switch is not set');
        assert.equal(runtime.schedulerRunning(), false, 'failed Host A boot does not start mutation work');
        const bootRow = await seed.query(
          `select status, attempt_count from runtime_host_readiness
            where host_id = 'desktop-local'`
        );
        assert.equal(bootRow.rows[0].status, 'FAIL');
        assert.equal(Number(bootRow.rows[0].attempt_count), hostAttemptsBeforeFailure + 2);
      } finally {
        await runtime.stop();
      }
    } finally {
      await __endFirmDbPoolForTests();
      for (const key of envKeys) restoreEnv(key, priorEnv[key]);
      await seed.end().catch(() => {});
      await admin.query(
        'select pg_terminate_backend(pid) from pg_stat_activity where datname = $1 and pid <> pg_backend_pid()',
        [dbName]
      ).catch(() => {});
      await admin.query(`drop database if exists "${dbName}"`).catch(() => {});
      await admin.end().catch(() => {});
      await rm(blobDir, { recursive: true, force: true });
    }
  }
);
