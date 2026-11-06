// RT-09 — migration 133's data repair, on real PostgreSQL.
//
// Before RT-09 a host-caused entity failure charged the episode budget and
// scheduled a clock no runner could honour while the host was down; three
// Retry clicks against a dead host EXHAUSTED a good entity. 133 restores
// every failed saga resting on a host-wait reason to the clockless resting
// shape the new rule writes (attempt_count 0, scheduled, next_retry_at null)
// with one receipt per row, leaves entity-side failures and ready rows alone,
// and is idempotent. The sequence matters: 126's "a scheduled retry has a
// clock" constraint must be relaxed BEFORE the restore writes the clockless
// shape, and this file proves that order on the real substrate — migrations
// applied through 132, legacy rows inserted under 126's rules, then 133.

import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import pg from 'pg';

const PG_URL = process.env.DONNA_PG_TEST_URL || '';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const MIGRATION_133 = '133_entity_readiness_admitted_write_scope';
const FIRM_ID = 'firm-host-wait-restore-pg';
const MEMBER_ID = 'member-host-wait-restore-pg';

test(
  'real PG: 133 restores host-charged sagas to the clockless host wait with receipts, leaves entity-side and ready rows alone, and is idempotent',
  { skip: PG_URL ? false : 'DONNA_PG_TEST_URL not set — host-wait restore lifecycle not exercised' },
  async () => {
    const dbName = `donna_host_wait_restore_${Date.now().toString(36)}_${process.pid}`;
    const admin = new pg.Client({ connectionString: PG_URL });
    await admin.connect();
    await admin.query(`create database "${dbName}"`);
    const scratchUrl = new URL(PG_URL);
    scratchUrl.pathname = `/${dbName}`;
    const db = new pg.Client({ connectionString: scratchUrl.toString() });
    await db.connect();
    try {
      await db.query(`
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
      const applyMigration = async (file) => {
        await db.query(await readFile(path.join(ROOT, 'db', 'migrations', file), 'utf8'));
        await db.query('insert into schema_migrations (version) values ($1) on conflict (version) do nothing', [file.replace(/\.sql$/, '')]);
      };
      const before133 = migrations.filter((file) => file < `${MIGRATION_133}.sql`);
      const from133 = migrations.filter((file) => file >= `${MIGRATION_133}.sql`);
      assert.equal(from133[0], `${MIGRATION_133}.sql`, 'this file pins 133 specifically');
      for (const file of before133) await applyMigration(file);

      // A firm, a member and five clients under 126's rules.
      await db.query(
        `insert into firms (id, name, slug, jurisdiction, default_currency)
         values ($1, 'Host Wait Restore Firm', 'host-wait-restore-firm', 'GB', 'GBP')`,
        [FIRM_ID]
      );
      await db.query(
        `insert into firm_members (id, firm_id, email, name, role, status)
         values ($1, $2, 'founder@host-wait-restore.test', 'Restore Founder', 'admin', 'active')`,
        [MEMBER_ID, FIRM_ID]
      );
      const clients = {
        exhaustedOnHost: 'client-exhausted-on-host-pg',
        clockedOnHost: 'client-clocked-on-host-pg',
        entitySide: 'client-entity-side-pg',
        ready: 'client-ready-pg',
        upgradeReady: 'client-upgrade-ready-pg'
      };
      for (const clientId of Object.values(clients)) {
        await db.query(
          `insert into clients (id, firm_id, company_name, jurisdiction, entity_type, status, profile)
           values ($1, $2, $1, 'GB', 'gb-ltd', 'active', '{"jurisdiction":"GB","entityType":"gb-ltd"}'::jsonb)`,
          [clientId, FIRM_ID]
        );
      }
      const receiptFor = async (clientId) => (await db.query(
        `insert into audit_events (firm_id, client_id, actor_type, actor_id, action, resource_type, resource_id, metadata)
         values ($1, $2, 'system', 'entityReadinessProvisioner', 'entity.provisioning.attempt', 'entity_readiness_saga', $2, '{}'::jsonb)
         returning id`,
        [FIRM_ID, clientId]
      )).rows[0].id;
      const insertSaga = async ({ clientId, state, reasonCode, attemptCount, retryState, nextRetryAt, readyDigest = null }) => {
        const receiptId = await receiptFor(clientId);
        await db.query(
          `insert into entity_readiness_sagas
             (firm_id, client_id, saga_id, idempotency_key, state, admitted_profile_id, certificate_version,
              manifest_version, ready_dependency_digest, observed_dependency_digest, latest_attempt_id,
              root_cause_receipt_id, attempt_count, max_attempts, retry_state, reason_code, responsible_system,
              next_retry_at, ready_at, failed_at)
           values ($1, $2, $3, $4, $5, 'gb-ltd.desktop-firm-intake.desktop.none.management-books.v2',
                   'donna.entity-certificate-b.v2', 'donna.admitted-entity-profiles.v2', $6, $6, $7,
                   $7, $8, 3, $9, $10, 'donna_runtime', $11::timestamptz,
                   case when $5 = 'ready' then now() else null end,
                   case when $5 = 'failed' then now() else null end)`,
          [FIRM_ID, clientId, `saga-${clientId}`, `idem-${clientId}`, state, readyDigest, receiptId,
            attemptCount, retryState, reasonCode, nextRetryAt]
        );
      };
      // The 2026-08-31 laptop shape: three Retry clicks against a dead host.
      await insertSaga({ clientId: clients.exhaustedOnHost, state: 'failed', reasonCode: 'host_certificate_not_pass', attemptCount: 3, retryState: 'exhausted', nextRetryAt: null });
      // One click in, clock running, a pre-v5 companion code.
      await insertSaga({ clientId: clients.clockedOnHost, state: 'failed', reasonCode: 'host_model_routes_not_pass', attemptCount: 1, retryState: 'scheduled', nextRetryAt: '2026-08-31T16:33:00.000Z' });
      // An entity-side failure keeps its explicit reopen exit.
      await insertSaga({ clientId: clients.entitySide, state: 'failed', reasonCode: 'required_capability_missing:CODING_AUTO_POST', attemptCount: 3, retryState: 'exhausted', nextRetryAt: null });
      // A ready row is never touched.
      await insertSaga({ clientId: clients.ready, state: 'ready', reasonCode: null, attemptCount: 0, retryState: 'idle', nextRetryAt: null, readyDigest: 'gen-ready-1' });
      await insertSaga({ clientId: clients.upgradeReady, state: 'ready', reasonCode: null, attemptCount: 0, retryState: 'idle', nextRetryAt: null, readyDigest: 'gen-upgrade-ready-1' });

      // Under 126 the clockless scheduled shape is refused — the constraint
      // 133 replaces really is in force on this substrate.
      await assert.rejects(
        db.query(
          `update entity_readiness_sagas set retry_state = 'scheduled', next_retry_at = null
            where firm_id = $1 and client_id = $2`,
          [FIRM_ID, clients.exhaustedOnHost]
        ),
        (error) => error.code === '23514'
      );

      // Pin 133's own consequence before later migrations deliberately revise
      // certificate authority. The complete remaining chain is exercised below.
      await applyMigration(from133[0]);

      const sagaOf = async (clientId) => (await db.query(
        `select state, reason_code, attempt_count, retry_state, next_retry_at, ready_dependency_digest
           from entity_readiness_sagas where firm_id = $1 and client_id = $2`,
        [FIRM_ID, clientId]
      )).rows[0];
      const restoreReceipts = async (clientId) => (await db.query(
        `select actor_id, metadata from audit_events
          where firm_id = $1 and client_id = $2 and action = 'entity.readiness.host_wait_budget_restored'
          order by id`,
        [FIRM_ID, clientId]
      )).rows;

      const exhaustedOnHost = await sagaOf(clients.exhaustedOnHost);
      assert.deepEqual(
        { ...exhaustedOnHost, attempt_count: Number(exhaustedOnHost.attempt_count) },
        { state: 'failed', reason_code: 'host_certificate_not_pass', attempt_count: 0, retry_state: 'scheduled', next_retry_at: null, ready_dependency_digest: null },
        'a saga exhausted by host failures rests as the clockless host wait the PASS-transition heal selects'
      );
      const exhaustedReceipts = await restoreReceipts(clients.exhaustedOnHost);
      assert.equal(exhaustedReceipts.length, 1);
      assert.equal(exhaustedReceipts[0].actor_id, 'entityReadinessHostWaitRestore');
      assert.equal(exhaustedReceipts[0].metadata.prior_attempt_count, 3);
      assert.equal(exhaustedReceipts[0].metadata.prior_retry_state, 'exhausted');
      assert.equal(exhaustedReceipts[0].metadata.reason_code, 'host_certificate_not_pass');
      assert.equal(exhaustedReceipts[0].metadata.recovery_route, 'host_certificate_pass_renewal');

      const clockedOnHost = await sagaOf(clients.clockedOnHost);
      assert.equal(Number(clockedOnHost.attempt_count), 0);
      assert.equal(clockedOnHost.retry_state, 'scheduled');
      assert.equal(clockedOnHost.next_retry_at, null, 'the clock the host could not honour is removed');
      assert.equal(clockedOnHost.reason_code, 'host_model_routes_not_pass', 'the pre-v5 companion is restored too; the next observation re-mints under v5');
      const clockedReceipts = await restoreReceipts(clients.clockedOnHost);
      assert.equal(clockedReceipts.length, 1);
      assert.equal(clockedReceipts[0].metadata.prior_attempt_count, 1);
      assert.equal(new Date(clockedReceipts[0].metadata.prior_next_retry_at).toISOString(), '2026-08-31T16:33:00.000Z');

      const entitySide = await sagaOf(clients.entitySide);
      assert.equal(Number(entitySide.attempt_count), 3);
      assert.equal(entitySide.retry_state, 'exhausted', 'an entity-side exhaustion keeps its explicit, receipted reopen exit');
      assert.deepEqual(await restoreReceipts(clients.entitySide), []);

      const ready = await sagaOf(clients.ready);
      assert.equal(ready.state, 'ready');
      assert.equal(ready.retry_state, 'idle');
      assert.deepEqual(await restoreReceipts(clients.ready), []);

      // Idempotent: a second application restores nothing and receipts nothing.
      await db.query(await readFile(path.join(ROOT, 'db', 'migrations', `${MIGRATION_133}.sql`), 'utf8'));
      assert.equal((await restoreReceipts(clients.exhaustedOnHost)).length, 1);
      assert.equal((await restoreReceipts(clients.clockedOnHost)).length, 1);

      // The relaxed constraint admits exactly the host wait and nothing looser.
      await db.query(
        `update entity_readiness_sagas set retry_state = 'scheduled', next_retry_at = null
          where firm_id = $1 and client_id = $2`,
        [FIRM_ID, clients.exhaustedOnHost]
      );
      await assert.rejects(
        db.query(
          `update entity_readiness_sagas
              set retry_state = 'scheduled', next_retry_at = null, reason_code = 'entity_dependency_changed'
            where firm_id = $1 and client_id = $2`,
          [FIRM_ID, clients.exhaustedOnHost]
        ),
        (error) => error.code === '23514',
        'a clockless scheduled retry must name the host it waits for'
      );

      // Same-transaction admitted-write scope at SQL level: the ready row is
      // untouched by a fenced write carrying its exact digest, invalidated by
      // one carrying a stale value.
      const fencedInsert = async (guc, suffix) => {
        await db.query('begin');
        try {
          await db.query("select set_config('donna.admitted_generation', $1, true)", [guc]);
          await db.query(
            `insert into ledger_accounts (id, firm_id, client_id, code, name, account_type, normal_balance, status, payload)
             values ($1, $2, $3, null, $4, 'expense', 'debit', 'active', '{}'::jsonb)`,
            [`${clients.ready}-${suffix}`, FIRM_ID, clients.ready, `Restore fence probe ${suffix}`]
          );
          await db.query('commit');
        } catch (error) {
          await db.query('rollback').catch(() => {});
          throw error;
        }
      };
      await fencedInsert('gen-ready-1', 'admitted');
      assert.equal((await sagaOf(clients.ready)).state, 'ready');
      const scoped = await db.query(
        `select metadata from audit_events where firm_id = $1 and client_id = $2 and action = 'entity.readiness.admitted_write_scoped'`,
        [FIRM_ID, clients.ready]
      );
      assert.equal(scoped.rows.length, 1);
      assert.equal(scoped.rows[0].metadata.ready_dependency_digest, 'gen-ready-1');
      await fencedInsert('gen-ready-0-stale', 'foreign');
      const invalidated = await sagaOf(clients.ready);
      assert.equal(invalidated.state, 'failed');
      assert.equal(invalidated.reason_code, 'entity_dependency_changed');

      // 151 intentionally retires a v2 certificate that 133 correctly preserved.
      // Keep this upgrade consequence distinct from the stale-write proof above.
      assert.equal((await sagaOf(clients.upgradeReady)).state, 'ready');
      for (const file of from133.slice(1)) await applyMigration(file);
      const upgraded = await sagaOf(clients.upgradeReady);
      assert.equal(upgraded.state, 'failed');
      assert.equal(upgraded.reason_code, 'entity_dependency_changed');
      assert.equal(upgraded.ready_dependency_digest, 'gen-upgrade-ready-1', 'the old digest remains historical provenance, not current authority');
      assert.equal(upgraded.retry_state, 'scheduled');
      assert.ok(upgraded.next_retry_at, 'the existing bounded recovery consumer receives a clock');
      const upgradeReceipts = await db.query(
        `select metadata from audit_events where firm_id = $1 and client_id = $2
          and action = 'entity.readiness.invalidated'`,
        [FIRM_ID, clients.upgradeReady]
      );
      assert.equal(upgradeReceipts.rows.length, 1);
      assert.equal(upgradeReceipts.rows[0].metadata.dependency_table, 'accounting_profile_contract');
      assert.equal(upgradeReceipts.rows[0].metadata.prior_ready_dependency_digest, 'gen-upgrade-ready-1');
    } finally {
      await db.end().catch(() => {});
      await admin.query(`drop database if exists "${dbName}" with (force)`).catch(() => {});
      await admin.end().catch(() => {});
    }
  }
);
