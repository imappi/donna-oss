// Real PostgreSQL proof for migration 129 and the client-delete archive writer.
// A retained Tier-1 decision receipt must survive firm-side, but no old plain
// client_id may collide with a deterministic recreated client identity.

import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import pg from 'pg';

import { readEntityCertificateSnapshot } from './entityCertificateB.js';
import { archiveLlmDecisionsForDeletedClient } from './llmDecisionRetention.js';

const PG_URL = process.env.DONNA_PG_TEST_URL || '';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const MIGRATION = '129_llm_decision_client_detachment.sql';
const FIRM_ID = 'firm-llm-detachment-pg';
const RECREATED_ID = 'recreated-client-pg';
const ACTIVE_ID = 'active-client-pg';

const insertClient = (client, { id, createdAt }) => client.query(
  `insert into clients
     (id, firm_id, company_name, jurisdiction, entity_type, profile, created_at, updated_at)
   values ($1, $2, $3, 'GB', 'gb-ltd', $4::jsonb, $5::timestamptz, $5::timestamptz)`,
  [id, FIRM_ID, id, JSON.stringify({ accounting_system: 'none' }), createdAt]
);

const insertDecision = (client, {
  id, clientId, createdAt, reasoning = null, raw = null
}) => client.query(
  `insert into llm_decisions
     (id, firm_id, client_id, decision_type, target_type, target_id,
      llm_reasoning, llm_raw_response, final_state, created_at)
   values ($1, $2, $3, 'match', 'document', $1, $4, $5::jsonb, 'no_match', $6::timestamptz)`,
  [id, FIRM_ID, clientId, reasoning, raw == null ? null : JSON.stringify(raw), createdAt]
);

const serializedQueryFor = (client) => {
  let tail = Promise.resolve();
  return (text, params) => {
    const result = tail.then(() => client.query(text, params));
    tail = result.then(() => undefined, () => undefined);
    return result;
  };
};

test(
  'real PG: migration and delete writer de-link old decisions; recreate birth sees zero residue',
  { skip: PG_URL ? false : 'DONNA_PG_TEST_URL not set — decision detachment lifecycle not exercised' },
  async () => {
    const dbName = `donna_llm_detachment_${Date.now().toString(36)}_${process.pid}`;
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
        .filter((file) => file.endsWith('.sql') && file !== MIGRATION)
        .sort();
      for (const file of migrations) {
        await db.query(await readFile(path.join(ROOT, 'db', 'migrations', file), 'utf8'));
        await db.query(
          'insert into schema_migrations (version) values ($1) on conflict (version) do nothing',
          [file.replace(/\.sql$/, '')]
        );
      }
      await db.query(
        `insert into firms (id, name, slug, jurisdiction, default_currency)
         values ($1, 'Decision Detachment Firm', 'decision-detachment-firm', 'GB', 'GBP')`,
        [FIRM_ID]
      );
      await insertClient(db, { id: RECREATED_ID, createdAt: '2026-08-31T12:00:00.000Z' });
      await insertClient(db, { id: ACTIVE_ID, createdAt: '2026-08-01T12:00:00.000Z' });
      await insertDecision(db, {
        id: 'llmd-prior-prose',
        clientId: RECREATED_ID,
        createdAt: '2026-08-10T12:00:00.000Z',
        reasoning: 'old client reasoning',
        raw: { old: 'provider payload' }
      });
      await insertDecision(db, {
        id: 'llmd-prior-structured-only',
        clientId: RECREATED_ID,
        createdAt: '2026-08-11T12:00:00.000Z'
      });
      await insertDecision(db, {
        id: 'llmd-active',
        clientId: ACTIVE_ID,
        createdAt: '2026-08-02T12:00:00.000Z',
        reasoning: 'current client reasoning'
      });
      await insertDecision(db, {
        id: 'llmd-orphan',
        clientId: 'deleted-client-pg',
        createdAt: '2026-08-03T12:00:00.000Z',
        reasoning: 'orphan reasoning'
      });

      await db.query(await readFile(path.join(ROOT, 'db', 'migrations', MIGRATION), 'utf8'));
      await db.query(
        'insert into schema_migrations (version) values ($1) on conflict (version) do nothing',
        [MIGRATION.replace(/\.sql$/, '')]
      );

      const repaired = await db.query(
        `select id, client_id, client_detached_at, llm_reasoning,
                llm_reasoning_redacted_at, llm_raw_response,
                llm_raw_response_redacted_at
           from llm_decisions order by id`
      );
      const byId = new Map(repaired.rows.map((row) => [row.id, row]));
      for (const id of ['llmd-prior-prose', 'llmd-prior-structured-only', 'llmd-orphan']) {
        assert.equal(byId.get(id).client_id, null, `${id} is no longer a live client link`);
        assert.ok(byId.get(id).client_detached_at, `${id} carries the detachment stamp`);
      }
      assert.equal(byId.get('llmd-prior-prose').llm_reasoning, null);
      assert.ok(byId.get('llmd-prior-prose').llm_reasoning_redacted_at);
      assert.equal(byId.get('llmd-prior-prose').llm_raw_response, null);
      assert.ok(byId.get('llmd-prior-prose').llm_raw_response_redacted_at);
      assert.equal(byId.get('llmd-active').client_id, ACTIVE_ID, 'current-generation receipt stays linked');
      assert.equal(byId.get('llmd-active').llm_reasoning, 'current client reasoning');
      assert.equal(byId.get('llmd-active').client_detached_at, null);
      const backfillReceipt = (await db.query(
        `select metadata from audit_events
          where firm_id = $1 and action = 'llm_decision.client_detachment_backfill'`,
        [FIRM_ID]
      )).rows[0];
      assert.equal(backfillReceipt.metadata.detached_receipts, 3,
        'the migration receipts actual completed transitions, not candidate estimates');

      await assert.rejects(
        db.query(
          `update llm_decisions
              set client_id = null, client_detached_at = now()
            where id = 'llmd-active'`
        ),
        (error) => error?.code === '23514',
        'ordinary SQL cannot use the archival exception'
      );

      const birthSnapshot = await readEntityCertificateSnapshot({
        query: serializedQueryFor(db),
        firmId: FIRM_ID,
        clientId: RECREATED_ID
      });
      assert.equal(birthSnapshot.client_table_counts.llm_decisions, 0,
        'prior receipts cannot become residue of the recreated generation');

      await db.query('begin');
      await db.query('delete from clients where firm_id = $1 and id = $2', [FIRM_ID, ACTIVE_ID]);
      const archived = await archiveLlmDecisionsForDeletedClient({
        client: db,
        firmId: FIRM_ID,
        clientId: ACTIVE_ID
      });
      await db.query('commit');
      assert.equal(archived.redacted, 1);
      assert.equal(archived.detached, 1);
      assert.equal((await db.query(
        `select count(*)::int as n from audit_events
          where firm_id = $1 and action = 'llm_decision.client_detached'
            and resource_id = $2`,
        [FIRM_ID, ACTIVE_ID]
      )).rows[0].n, 1, 'future deletes carry a firm-level archival receipt');

      await insertClient(db, { id: ACTIVE_ID, createdAt: '2026-08-31T13:00:00.000Z' });
      const recreatedSnapshot = await readEntityCertificateSnapshot({
        query: serializedQueryFor(db),
        firmId: FIRM_ID,
        clientId: ACTIVE_ID
      });
      assert.equal(recreatedSnapshot.client_table_counts.llm_decisions, 0,
        'the production writer also leaves recreate birth clean');
    } finally {
      await db.query('rollback').catch(() => {});
      await db.end().catch(() => {});
      await admin.query(
        'select pg_terminate_backend(pid) from pg_stat_activity where datname = $1 and pid <> pg_backend_pid()',
        [dbName]
      ).catch(() => {});
      await admin.query(`drop database if exists "${dbName}"`).catch(() => {});
      await admin.end().catch(() => {});
    }
  }
);
