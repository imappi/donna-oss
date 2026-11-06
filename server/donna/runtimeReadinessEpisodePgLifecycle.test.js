// Episode-scoped readiness retries — real PostgreSQL lifecycle.
//
// The 2026-08-31 exhaustion cliff, machine-checked: reaching 'ready' closes a
// failure episode (attempt_count rewinds to 0), a migration-127 dependency
// invalidation opens a FRESH bounded episode instead of draining a lifetime
// budget, an exhausted saga has an explicit receipted reopen, and a bounded
// retry of a never-ready new-client saga proves birth from the BIRTH RECEIPT
// (a clean birth certifies the current generation; a dirty one stays strict).
//
// The Entity B observer is injected: this file certifies the SAGA machinery
// (budget, scope selection, receipts) against the real writers, triggers and
// migrations — the certificate stack has its own suites.

import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import pg from 'pg';

import { ENTITY_READINESS_ADMISSION_FLAG, setClientFlagStage } from './clientConfig.js';
import {
  __endFirmDbPoolForTests,
  createClientInDb,
  withFirmDbClient
} from './firmDb.js';
import { provisionEntityReadiness } from './runtimeReadiness.js';

const PG_URL = process.env.DONNA_PG_TEST_URL || '';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const FIRM_ID = 'firm-readiness-episode-pg';
const MEMBER_ID = 'member-readiness-episode-pg';
const CLIENT_A = 'client-episode-a-pg';
const CLIENT_B = 'client-episode-b-clean-birth-pg';
const CLIENT_C = 'client-episode-c-dirty-birth-pg';

const restoreEnv = (key, value) => {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
};

const memberPrincipal = {
  principalType: 'firm_member',
  principalId: MEMBER_ID,
  authoritySource: 'episode_budget_real_pg'
};

// Minimal Entity B certificate the saga writer can persist. `birthChecks`
// rides into the immutable attempt receipt, which is exactly where the
// retry-scope law reads the birth-time residue verdict back from.
const certificateStub = ({ status, digest, birthChecks = [], failureId = 'stub_probe' }) => ({
  version: 'donna.entity-certificate-b.v2',
  status,
  entity_dependency_digest: digest,
  receipt_digest: `stub-receipt-${digest}-${status}-${Math.random().toString(36).slice(2)}`,
  admitted_profile: { profile_id: 'stub-profile.episode.v1' },
  checks: [
    ...birthChecks,
    ...(status === 'PASS' ? [] : [{ id: failureId, status: 'FAIL', detail: { failures: [`${failureId}_failed`] } }])
  ],
  provisioning_saga: { writer_receipts: [] }
});

const observerRecording = (calls, certificateByCall) => async (input) => {
  calls.push({ lifecycle: input.lifecycle, compatibilityScope: input.compatibilityScope });
  const certificate = certificateByCall.shift();
  if (!certificate) throw new Error('observer stub exhausted');
  return certificate;
};

test(
  'real PG: ready closes the episode, invalidation opens a fresh one, exhausted reopens with a receipt, retry scope follows the birth receipt',
  { skip: PG_URL ? false : 'DONNA_PG_TEST_URL not set — episode budget lifecycle not exercised' },
  async () => {
    const dbName = `donna_readiness_episode_${Date.now().toString(36)}_${process.pid}`;
    const admin = new pg.Client({ connectionString: PG_URL });
    await admin.connect();
    await admin.query(`create database "${dbName}"`);
    const scratchUrl = new URL(PG_URL);
    scratchUrl.pathname = `/${dbName}`;
    const seed = new pg.Client({ connectionString: scratchUrl.toString() });
    await seed.connect();

    const envKeys = ['DATABASE_URL', 'DATABASE_POOL_MAX', 'DONNA_DEFAULT_FIRM_ID', 'DONNA_DESKTOP_BLOB_DIR'];
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
         values ($1, 'Readiness Episode Firm', 'readiness-episode-firm', 'GB', 'GBP')`,
        [FIRM_ID]
      );
      await seed.query(
        `insert into firm_members (id, firm_id, email, name, role, status)
         values ($1, $2, 'founder@readiness-episode.test', 'Episode Founder', 'admin', 'active')`,
        [MEMBER_ID, FIRM_ID]
      );

      process.env.DATABASE_URL = scratchUrl.toString();
      process.env.DATABASE_POOL_MAX = '1';
      process.env.DONNA_DEFAULT_FIRM_ID = FIRM_ID;
      process.env.DONNA_DESKTOP_BLOB_DIR = '/tmp/donna-episode-blobs';

      for (const [clientId, companyName] of [
        [CLIENT_A, 'Episode Apiary A Ltd'],
        [CLIENT_B, 'Episode Clean-Birth B Ltd'],
        [CLIENT_C, 'Episode Dirty-Birth C Ltd']
      ]) {
        await createClientInDb({
          firmId: FIRM_ID,
          creationPrincipal: memberPrincipal,
          profile: { id: clientId, companyName, jurisdiction: 'GB', entityType: 'gb-ltd' }
        });
      }
      const enrollment = await seed.query(
        `select client_id from client_capability_config
          where firm_id = $1 and flag_key = $2 and valid_to is null and stage = 'canary'
          order by client_id`,
        [FIRM_ID, ENTITY_READINESS_ADMISSION_FLAG]
      );
      assert.deepEqual(enrollment.rows.map((r) => r.client_id), [CLIENT_A, CLIENT_B, CLIENT_C]);

      const sagaOf = async (clientId) => (await seed.query(
        `select state, reason_code, attempt_count, max_attempts, retry_state,
                ready_dependency_digest, observed_dependency_digest, next_retry_at
           from entity_readiness_sagas where firm_id = $1 and client_id = $2`,
        [FIRM_ID, clientId]
      )).rows[0] || null;
      const latestAttemptSequence = async (clientId) => Number((await seed.query(
        `select metadata->>'attempt_sequence' as seq from audit_events
          where firm_id = $1 and client_id = $2 and action = 'entity.provisioning.attempt'
          order by id desc limit 1`,
        [FIRM_ID, clientId]
      )).rows[0]?.seq);
      const at = (offsetMs) => new Date(Date.now() + offsetMs).toISOString();

      // ── A: ready closes the episode ─────────────────────────────────────
      const aCalls = [];
      const cold = await provisionEntityReadiness({
        withFirmDbClientFn: withFirmDbClient,
        firmId: FIRM_ID,
        clientId: CLIENT_A,
        creationPath: 'desktop_firm_intake',
        observedAt: at(0),
        observe: observerRecording(aCalls, [certificateStub({
          status: 'PASS', digest: 'gen-a-1',
          birthChecks: [{ id: 'birth_residue_proof', status: 'PASS', detail: { failures: [] } }]
        })])
      });
      assert.equal(cold.accepted, true);
      assert.equal(aCalls[0].compatibilityScope, 'birth_residue_proof');
      let saga = await sagaOf(CLIENT_A);
      assert.equal(saga.state, 'ready');
      assert.equal(Number(saga.attempt_count), 0, 'ready closes the episode: the counter rewinds');

      // Dependency change (a real capability write) → migration 127 invalidates.
      await withFirmDbClient(async (client) => {
        await client.query('begin');
        try {
          await setClientFlagStage(client, {
            firmId: FIRM_ID,
            clientId: CLIENT_A,
            flagKey: 'DOCUMENT_EXTRACTORS_ENABLED',
            stage: 'off',
            source: 'manual',
            reason: 'episode lifecycle: provoke a dependency invalidation',
            actorType: 'firm_member',
            actorId: MEMBER_ID
          });
          await client.query('commit');
        } catch (error) {
          await client.query('rollback');
          throw error;
        }
      });
      saga = await sagaOf(CLIENT_A);
      assert.equal(saga.state, 'failed');
      assert.equal(saga.reason_code, 'entity_dependency_changed');
      assert.equal(saga.retry_state, 'scheduled', 'a fresh episode opens — never straight to exhausted');
      assert.equal(Number(saga.attempt_count), 0);
      assert.ok(saga.ready_dependency_digest, 'the formerly-ready generation stays on record');

      // Retry re-certifies the CURRENT generation (everReady) and re-closes.
      const retryCalls = [];
      const healed = await provisionEntityReadiness({
        withFirmDbClientFn: withFirmDbClient,
        firmId: FIRM_ID,
        clientId: CLIENT_A,
        retry: true,
        lifecycle: 'retry',
        observedAt: at(5_000),
        observe: observerRecording(retryCalls, [certificateStub({ status: 'PASS', digest: 'gen-a-2' })])
      });
      assert.equal(healed.accepted, true);
      assert.equal(retryCalls[0].compatibilityScope, 'current_generation_compatibility');
      saga = await sagaOf(CLIENT_A);
      assert.equal(saga.state, 'ready');
      assert.equal(Number(saga.attempt_count), 0);
      assert.equal(await latestAttemptSequence(CLIENT_A), 1, 'a fresh episode numbers its attempts from 1');

      // ── Exhaust an episode, then reopen with a receipt ──────────────────
      await withFirmDbClient(async (client) => {
        await client.query('begin');
        try {
          await setClientFlagStage(client, {
            firmId: FIRM_ID,
            clientId: CLIENT_A,
            flagKey: 'DOCUMENT_LINES_ENABLED',
            stage: 'off',
            source: 'manual',
            reason: 'episode lifecycle: provoke a second invalidation',
            actorType: 'firm_member',
            actorId: MEMBER_ID
          });
          await client.query('commit');
        } catch (error) {
          await client.query('rollback');
          throw error;
        }
      });
      const failingOffsets = [10_000, 130_000, 800_000];
      for (const [index, offset] of failingOffsets.entries()) {
        await provisionEntityReadiness({
          withFirmDbClientFn: withFirmDbClient,
          firmId: FIRM_ID,
          clientId: CLIENT_A,
          retry: true,
          lifecycle: 'retry',
          observedAt: at(offset),
          observe: observerRecording([], [certificateStub({ status: 'FAIL', digest: `gen-a-fail-${index}` })])
        });
      }
      saga = await sagaOf(CLIENT_A);
      assert.equal(saga.state, 'failed');
      assert.equal(saga.retry_state, 'exhausted');
      assert.equal(Number(saga.attempt_count), 3);

      await assert.rejects(
        provisionEntityReadiness({
          withFirmDbClientFn: withFirmDbClient,
          firmId: FIRM_ID,
          clientId: CLIENT_A,
          retry: true,
          lifecycle: 'retry',
          observedAt: at(900_000),
          observe: observerRecording([], [certificateStub({ status: 'PASS', digest: 'gen-a-never' })])
        }),
        (error) => error.code === 'ENTITY_READINESS_RETRY_EXHAUSTED',
        'a plain retry still refuses an exhausted saga'
      );

      const reopened = await provisionEntityReadiness({
        withFirmDbClientFn: withFirmDbClient,
        firmId: FIRM_ID,
        clientId: CLIENT_A,
        retry: true,
        reopenExhausted: true,
        lifecycle: 'retry',
        observedAt: at(910_000),
        initiatingPrincipal: { actor_type: 'firm_member', actor_id: MEMBER_ID },
        observe: observerRecording([], [certificateStub({ status: 'PASS', digest: 'gen-a-3' })])
      });
      assert.equal(reopened.accepted, true);
      saga = await sagaOf(CLIENT_A);
      assert.equal(saga.state, 'ready');
      assert.equal(Number(saga.attempt_count), 0);
      assert.equal(await latestAttemptSequence(CLIENT_A), 1, 'the reopened episode numbers from 1');
      const reopenReceipts = await seed.query(
        `select actor_type, actor_id, metadata from audit_events
          where firm_id = $1 and client_id = $2 and action = 'entity.readiness.episode_reopened'`,
        [FIRM_ID, CLIENT_A]
      );
      assert.equal(reopenReceipts.rowCount, 1);
      assert.equal(reopenReceipts.rows[0].actor_type, 'firm_member');
      assert.equal(reopenReceipts.rows[0].actor_id, MEMBER_ID);
      assert.equal(reopenReceipts.rows[0].metadata.prior_attempt_count, 3);
      assert.equal(reopenReceipts.rows[0].metadata.prior_reason_code, 'stub_probe_failed');

      // ── B: clean birth receipt → retries certify the current generation ──
      const bRetryCalls = [];
      await provisionEntityReadiness({
        withFirmDbClientFn: withFirmDbClient,
        firmId: FIRM_ID,
        clientId: CLIENT_B,
        creationPath: 'desktop_firm_intake',
        observedAt: at(0),
        observe: observerRecording([], [certificateStub({
          status: 'FAIL', digest: 'gen-b-1', failureId: 'host_transient',
          birthChecks: [{ id: 'birth_residue_proof', status: 'PASS', detail: { failures: [] } }]
        })])
      });
      assert.equal((await sagaOf(CLIENT_B)).state, 'failed');
      await provisionEntityReadiness({
        withFirmDbClientFn: withFirmDbClient,
        firmId: FIRM_ID,
        clientId: CLIENT_B,
        retry: true,
        lifecycle: 'retry',
        observedAt: at(70_000),
        observe: observerRecording(bRetryCalls, [certificateStub({ status: 'PASS', digest: 'gen-b-2' })])
      });
      assert.equal(
        bRetryCalls[0].compatibilityScope,
        'current_generation_compatibility',
        'a birth the receipt proved clean is never re-judged against live state'
      );
      assert.equal((await sagaOf(CLIENT_B)).state, 'ready');

      // ── C: dirty birth receipt → the strict scope holds ─────────────────
      const cRetryCalls = [];
      await provisionEntityReadiness({
        withFirmDbClientFn: withFirmDbClient,
        firmId: FIRM_ID,
        clientId: CLIENT_C,
        creationPath: 'desktop_firm_intake',
        observedAt: at(0),
        observe: observerRecording([], [certificateStub({
          status: 'FAIL', digest: 'gen-c-1', failureId: 'birth_residue_probe',
          birthChecks: [{ id: 'birth_residue_proof', status: 'FAIL', detail: { failures: ['prior_client_residue:documents'] } }]
        })])
      });
      await provisionEntityReadiness({
        withFirmDbClientFn: withFirmDbClient,
        firmId: FIRM_ID,
        clientId: CLIENT_C,
        retry: true,
        lifecycle: 'retry',
        observedAt: at(70_000),
        observe: observerRecording(cRetryCalls, [certificateStub({
          status: 'FAIL', digest: 'gen-c-2', failureId: 'birth_residue_probe',
          birthChecks: [{ id: 'birth_residue_proof', status: 'FAIL', detail: { failures: ['prior_client_residue:documents'] } }]
        })])
      });
      assert.equal(
        cRetryCalls[0].compatibilityScope,
        'birth_residue_proof',
        'a birth whose own residue proof failed keeps the strict scope — anti-laundering'
      );
    } finally {
      await __endFirmDbPoolForTests().catch(() => {});
      for (const key of envKeys) restoreEnv(key, priorEnv[key]);
      await seed.end().catch(() => {});
      await admin.query(`drop database if exists "${dbName}" with (force)`).catch(() => {});
      await admin.end().catch(() => {});
    }
  }
);
