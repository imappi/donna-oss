// Gate 1B.3 — real PostgreSQL rollout certificate.
//
// The actual desktop create writer, boot assembly, Host A observer, guarded
// config writer and Entity B provisioner prove three distinct populations:
// new desktop clients are enrolled, one exact manual legacy target heals and
// retries, and every other legacy/cloud client remains untouched.

import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import pg from 'pg';

import { ENTITY_READINESS_ADMISSION_FLAG, setClientFlagStage } from './clientConfig.js';
import { createDonnaRuntimeServer } from './desktop/runtimeServer.js';
import {
  __endFirmDbPoolForTests,
  createClientInDb,
  getFirmSnapshotFromDb,
  updateClientProfileInDb,
  withFirmDbClient
} from './firmDb.js';
import {
  healTargetedEntityReadiness,
  provisionEntityReadiness
} from './runtimeReadiness.js';
import { evaluateEntityReadinessAdmissionWithClient } from './runtimeReadinessAdmission.js';
import {
  ENTITY_READINESS_ENROLLMENT_ACTION,
  ENTITY_READINESS_NEW_CLIENT_REASON
} from './runtimeReadinessEnrollment.js';

const PG_URL = process.env.DONNA_PG_TEST_URL || '';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const FIRM_ID = 'firm-readiness-enrollment-pg';
const MEMBER_ID = 'member-readiness-enrollment-pg';
const NEW_CLIENT_ID = 'client-readiness-new-pg';
const SELECTED_LEGACY_ID = 'client-readiness-selected-legacy-pg';
const UNSELECTED_LEGACY_ID = 'client-readiness-unselected-legacy-pg';
const CLOUD_CLIENT_ID = 'client-readiness-cloud-pg';

const restoreEnv = (key, value) => {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
};

const memberPrincipal = {
  principalType: 'firm_member',
  principalId: MEMBER_ID,
  authoritySource: 'gate1b3_real_pg'
};

test(
  'real PG: new desktop clients enroll, selected legacy heals/retries, unselected legacy and cloud stay observe-only',
  { skip: PG_URL ? false : 'DONNA_PG_TEST_URL not set — Gate 1B.3 real rollout not exercised' },
  async () => {
    const dbName = `donna_readiness_enrollment_${Date.now().toString(36)}_${process.pid}`;
    const blobDir = await mkdtemp(path.join(os.tmpdir(), 'donna-readiness-enrollment-blobs-'));
    const socketPath = `/tmp/donna-g1b3-${process.pid}-${Date.now().toString(36)}.sock`;
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
    let runtime = null;

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
         values ($1, 'Readiness Enrollment Firm', 'readiness-enrollment-firm', 'GB', 'GBP')`,
        [FIRM_ID]
      );
      await seed.query(
        `insert into firm_members (id, firm_id, email, name, role, status)
         values ($1, $2, 'founder@readiness-enrollment.test', 'Readiness Founder', 'admin', 'active')`,
        [MEMBER_ID, FIRM_ID]
      );

      process.env.DATABASE_URL = scratchUrl.toString();
      process.env.DATABASE_POOL_MAX = '1';
      process.env.DONNA_DEFAULT_FIRM_ID = FIRM_ID;
      process.env.DONNA_DESKTOP_BLOB_DIR = blobDir;
      process.env.DONNA_BUILD_COMMIT_SHA = 'gate1b3-real-pg-build';
      // The mounted app commonly shares a checkout with renderer work. That
      // workspace dirt must stay visible without globally blocking new-client
      // admission when the accounting runtime scope itself is clean.
      process.env.DONNA_BUILD_DIRTY = 'true';
      process.env.DONNA_RUNTIME_BUILD_DIRTY = 'false';
      process.env.DONNA_DESKTOP_SCHEDULER = 'on';
      process.env.DONNA_ACCESS_TOKEN = 'gate1b3-runtime-token';
      process.env.OPENAI_API_KEY = 'gate1b3-presence-only';
      process.env.ANTHROPIC_API_KEY = 'gate1b3-presence-only';

      await createClientInDb({
        firmId: FIRM_ID,
        creationPrincipal: memberPrincipal,
        profile: {
          id: NEW_CLIENT_ID,
          companyName: 'New Readiness Apiary Ltd',
          jurisdiction: 'GB',
          entityType: 'gb-ltd'
        }
      });
      await createClientInDb({
        firmId: FIRM_ID,
        creationPrincipal: memberPrincipal,
        profile: {
          id: NEW_CLIENT_ID,
          companyName: 'New Readiness Apiary Ltd',
          jurisdiction: 'GB',
          entityType: 'gb-ltd'
        }
      });
      const newFlag = await seed.query(
        `select stage, source, reason
           from client_capability_config
          where firm_id = $1 and client_id = $2 and flag_key = $3 and valid_to is null`,
        [FIRM_ID, NEW_CLIENT_ID, ENTITY_READINESS_ADMISSION_FLAG]
      );
      assert.deepEqual(newFlag.rows, [{
        stage: 'canary', source: 'default', reason: ENTITY_READINESS_NEW_CLIENT_REASON
      }]);
      const newEnrollmentReceipts = await seed.query(
        `select actor_type, actor_id, metadata
           from audit_events
          where firm_id = $1 and client_id = $2 and action = $3`,
        [FIRM_ID, NEW_CLIENT_ID, ENTITY_READINESS_ENROLLMENT_ACTION]
      );
      assert.equal(newEnrollmentReceipts.rowCount, 1, 'idempotent upsert does not re-enroll');
      assert.equal(newEnrollmentReceipts.rows[0].actor_type, 'system');
      assert.equal(newEnrollmentReceipts.rows[0].actor_id, 'entityReadinessNewClientEnrollment');
      assert.equal(newEnrollmentReceipts.rows[0].metadata.authority_basis.decision_date, '2026-08-30');
      assert.equal(newEnrollmentReceipts.rows[0].metadata.cloud_upload_enforcement, false);

      delete process.env.DONNA_DESKTOP_BLOB_DIR;
      for (const [clientId, companyName] of [
        [SELECTED_LEGACY_ID, 'Selected Legacy Apiary Ltd'],
        [UNSELECTED_LEGACY_ID, 'Unselected Legacy Apiary Ltd'],
        [CLOUD_CLIENT_ID, 'Cloud Observe Only Apiary Ltd']
      ]) {
        await createClientInDb({
          firmId: FIRM_ID,
          creationPrincipal: memberPrincipal,
          profile: { clientId, id: clientId, companyName, jurisdiction: 'GB', entityType: 'gb-ltd' }
        });
      }
      process.env.DONNA_DESKTOP_BLOB_DIR = blobDir;

      await updateClientProfileInDb({
        firmId: FIRM_ID,
        clientId: SELECTED_LEGACY_ID,
        profilePatch: { entity_type: 'gb-ltd' },
        actorId: MEMBER_ID
      });
      await withFirmDbClient(async (client) => {
        await client.query('begin');
        try {
          await setClientFlagStage(client, {
            firmId: FIRM_ID,
            clientId: SELECTED_LEGACY_ID,
            flagKey: ENTITY_READINESS_ADMISSION_FLAG,
            stage: 'canary',
            source: 'manual',
            reason: 'Gate 1B.3 selected legacy recovery',
            actorType: 'firm_member',
            actorId: MEMBER_ID
          });
          await client.query('commit');
        } catch (error) {
          await client.query('rollback');
          throw error;
        }
      });

      runtime = await createDonnaRuntimeServer({
        listen: { socketPath },
        logger: { log: () => {}, error: () => {} }
      });
      assert.equal(runtime.server.listening, true);
      assert.equal(runtime.schedulerRunning(), true);
      const hostSourceBuild = (await seed.query(
        `select certificate->'checks' as checks
           from runtime_host_readiness_attempts
          order by id desc limit 1`
      )).rows[0].checks.find(({ id }) => id === 'source_build');
      assert.equal(hostSourceBuild.status, 'PASS');
      assert.equal(hostSourceBuild.detail.workspace_dirty, true);
      assert.equal(hostSourceBuild.detail.dirty, false);

      const selectedSaga = await seed.query(
        `select saga_id, state, attempt_count
           from entity_readiness_sagas
          where firm_id = $1 and client_id = $2`,
        [FIRM_ID, SELECTED_LEGACY_ID]
      );
      assert.equal(selectedSaga.rows[0].state, 'ready');
      // Episode budget (migration 130): 'ready' closes the episode at 0.
      assert.equal(Number(selectedSaga.rows[0].attempt_count), 0);
      assert.equal((await seed.query(
        'select count(*)::int as n from entity_readiness_sagas where firm_id = $1 and client_id = $2',
        [FIRM_ID, UNSELECTED_LEGACY_ID]
      )).rows[0].n, 0, 'boot does not mass-heal unselected legacy clients');
      assert.equal((await seed.query(
        `select count(*)::int as n from client_capability_config
          where firm_id = $1 and client_id in ($2, $3) and flag_key = $4 and valid_to is null`,
        [FIRM_ID, UNSELECTED_LEGACY_ID, CLOUD_CLIENT_ID, ENTITY_READINESS_ADMISSION_FLAG]
      )).rows[0].n, 0, 'baseline boot heal does not enroll legacy or cloud rows');

      const legacyAttempt = (await seed.query(
        `select metadata from audit_events
          where firm_id = $1 and client_id = $2 and action = 'entity.provisioning.attempt'
          order by id`,
        [FIRM_ID, SELECTED_LEGACY_ID]
      )).rows[0].metadata;
      assert.equal(legacyAttempt.lifecycle, 'legacy_upgrade');
      assert.equal(legacyAttempt.compatibility_scope, 'current_generation_compatibility');
      assert.equal(legacyAttempt.enrollment_kind, 'manual_target');
      assert.equal(legacyAttempt.authority_basis.source, 'targeted_legacy_readiness_boot_heal');

      const observedAt = new Date().toISOString();
      const newReady = await provisionEntityReadiness({
        withFirmDbClientFn: withFirmDbClient,
        firmId: FIRM_ID,
        clientId: NEW_CLIENT_ID,
        creationPath: 'desktop_firm_intake',
        observedAt,
        initiatingPrincipal: { actor_type: 'firm_member', actor_id: MEMBER_ID },
        authorityBasis: { source: 'gate1b3_new_client_route', principal_id: MEMBER_ID }
      });
      assert.equal(newReady.row.state, 'ready');
      const newAttempt = (await seed.query(
        `select metadata from audit_events
          where firm_id = $1 and client_id = $2 and action = 'entity.provisioning.attempt'
          order by id desc limit 1`,
        [FIRM_ID, NEW_CLIENT_ID]
      )).rows[0].metadata;
      assert.equal(newAttempt.enrollment_kind, 'new_client_default');

      const admission = await withFirmDbClient(async (client) => {
        await client.query('begin');
        try {
          const decision = await evaluateEntityReadinessAdmissionWithClient({
            client,
            firmId: FIRM_ID,
            clientId: NEW_CLIENT_ID,
            boundary: 'ledger_write',
            asOf: observedAt
          });
          await client.query('commit');
          return decision;
        } catch (error) {
          await client.query('rollback');
          throw error;
        }
      });
      assert.equal(admission.allowed, true);
      assert.equal(admission.enforced, true);
      assert.equal(admission.enrollment_kind, 'new_client_default');

      // Reproduce an already-persisted failed first birth after its underlying
      // residue was repaired by a migration. The exact source-controlled
      // new-client enrollment must enter bounded boot recovery automatically,
      // and the retry must repeat birth_residue_proof rather than laundering
      // the failure through steady-state compatibility.
      await seed.query(
        `update entity_readiness_sagas
            set state = 'failed',
                ready_dependency_digest = null,
                retry_state = 'scheduled',
                reason_code = 'prior_client_residue:llm_decisions',
                responsible_system = 'donna_readiness',
                root_cause_receipt_id = latest_attempt_id,
                next_retry_at = now() - interval '1 second',
                ready_at = null,
                failed_at = now(),
                updated_at = now()
          where firm_id = $1 and client_id = $2`,
        [FIRM_ID, NEW_CLIENT_ID]
      );

      await withFirmDbClient(async (client) => {
        await client.query('begin');
        try {
          await setClientFlagStage(client, {
            firmId: FIRM_ID,
            clientId: SELECTED_LEGACY_ID,
            flagKey: 'ASK_SEND_SETTLE_GATE',
            stage: 'off',
            source: 'manual',
            reason: 'Gate 1B.3 retry proof',
            actorType: 'firm_member',
            actorId: MEMBER_ID
          });
          await setClientFlagStage(client, {
            firmId: FIRM_ID,
            clientId: SELECTED_LEGACY_ID,
            flagKey: 'ASK_SEND_SETTLE_GATE',
            stage: 'auto',
            source: 'default',
            reason: 'desktop_host_default',
            actorType: 'system',
            actorId: 'gate1b3RetryProof'
          });
          await client.query('commit');
        } catch (error) {
          await client.query('rollback');
          throw error;
        }
      });
      const invalidated = (await seed.query(
        `select saga_id, state, retry_state, attempt_count
           from entity_readiness_sagas
          where firm_id = $1 and client_id = $2`,
        [FIRM_ID, SELECTED_LEGACY_ID]
      )).rows[0];
      assert.equal(invalidated.state, 'failed');
      assert.equal(invalidated.retry_state, 'scheduled');
      const healedAgain = await healTargetedEntityReadiness({
        withFirmDbClientFn: withFirmDbClient,
        observedAt: new Date().toISOString(),
        rootDir: ROOT,
        logger: { log: () => {}, error: () => {} }
      });
      assert.equal(healedAgain.selected, 2, 'manual legacy and due failed new-client saga both recover');
      assert.equal(healedAgain.results.find(({ client_id }) => client_id === SELECTED_LEGACY_ID).status, 'ready');
      assert.equal(healedAgain.results.find(({ client_id }) => client_id === NEW_CLIENT_ID).status, 'ready');
      const retried = (await seed.query(
        `select saga_id, state, attempt_count
           from entity_readiness_sagas
          where firm_id = $1 and client_id = $2`,
        [FIRM_ID, SELECTED_LEGACY_ID]
      )).rows[0];
      assert.equal(retried.saga_id, selectedSaga.rows[0].saga_id);
      assert.equal(retried.state, 'ready');
      assert.equal(Number(retried.attempt_count), 0);

      const recoveredNew = (await seed.query(
        `select saga_id, state, attempt_count, ready_dependency_digest
           from entity_readiness_sagas
          where firm_id = $1 and client_id = $2`,
        [FIRM_ID, NEW_CLIENT_ID]
      )).rows[0];
      assert.equal(recoveredNew.state, 'ready');
      assert.equal(Number(recoveredNew.attempt_count), 0);
      assert.ok(recoveredNew.ready_dependency_digest);
      const recoveredNewAttempt = (await seed.query(
        `select metadata from audit_events
          where firm_id = $1 and client_id = $2 and action = 'entity.provisioning.attempt'
          order by id desc limit 1`,
        [FIRM_ID, NEW_CLIENT_ID]
      )).rows[0].metadata;
      assert.equal(recoveredNewAttempt.lifecycle, 'boot_heal_retry');
      // Retry-scope law (2026-08-31): birth is proven from the BIRTH RECEIPT.
      // This client's real first attempt recorded a PASSing birth residue
      // proof, so its retry certifies the current generation — re-judging a
      // receipt-clean birth against live state is what bricked Desert Rose.
      // The strict path (a birth whose OWN residue proof failed keeps
      // birth_residue_proof) is machine-checked in
      // runtimeReadinessEpisodePgLifecycle.test.js.
      assert.equal(recoveredNewAttempt.compatibility_scope, 'current_generation_compatibility');
      assert.equal(recoveredNewAttempt.enrollment_kind, 'new_client_default');
      assert.equal(recoveredNewAttempt.authority_basis.source, 'failed_new_client_readiness_boot_heal');

      const snapshot = await getFirmSnapshotFromDb({ firmId: FIRM_ID });
      assert.equal(
        snapshot.clients.find(({ id }) => id === UNSELECTED_LEGACY_ID).runtime_readiness.state,
        'legacy_uncertified'
      );
      assert.equal(
        snapshot.clients.find(({ id }) => id === CLOUD_CLIENT_ID).runtime_readiness.state,
        'legacy_uncertified'
      );
    } finally {
      if (runtime) await runtime.stop().catch(() => {});
      await __endFirmDbPoolForTests();
      for (const key of envKeys) restoreEnv(key, priorEnv[key]);
      await seed.end().catch(() => {});
      await admin.query(
        'select pg_terminate_backend(pid) from pg_stat_activity where datname = $1 and pid <> pg_backend_pid()',
        [dbName]
      ).catch(() => {});
      await admin.query(`drop database if exists "${dbName}"`).catch(() => {});
      await admin.end().catch(() => {});
      await rm(socketPath, { force: true });
      await rm(blobDir, { recursive: true, force: true });
    }
  }
);
