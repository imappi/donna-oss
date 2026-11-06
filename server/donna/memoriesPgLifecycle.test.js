// Memories v2 — the real-PostgreSQL lifecycle test (G−1(a), build spec PR-1).
//
// CI runs every other test against mocked clients, which is exactly how the
// 2026-08-11 supersede-order bug survived: the mocked test pinned the SQL
// order, and only real PostgreSQL enforces migration 085's
// `memories_one_active_per_key` partial unique index. This file exercises the
// governed writers against a real database:
//
//   save → (index probe) → supersede → stale-replay refusal → contest
//   (disputed head) → conflict-not-overwrite → dismiss → dismissed-slot
//   refusal → erase → erased-slot anti-resurrection — with the one-active
//   invariant asserted throughout and the audit trail counted at the end.
//
// OPT-IN: set DONNA_PG_TEST_URL to a PostgreSQL connection string whose role
// may CREATE DATABASE (a scratch instance — never production). Without it the
// test SKIPS loudly. It joins the bridge ship-readiness drill list: run it
// against the appliance's local PG, where desktop Donna actually lives.
//
// Everything runs in a throwaway DATABASE (the writers probe
// to_regclass('public.memories'), so a schema sandbox is not enough), with a
// minimal firms + audit_events substrate and migration 085 executed
// VERBATIM — the real DDL, the real indexes, the real constraints.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

import {
  MEMORY_MODEL_V2_FLAG_KEY,
  saveMemory,
  supersedeMemory,
  dismissMemory,
  eraseUserMemories
} from './memoriesDb.js';

const PG_URL = process.env.DONNA_PG_TEST_URL || '';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const ENV = { MEMORY_KEY_HMAC_SECRET: 'pg-lifecycle-test-secret' };
const ON = { [MEMORY_MODEL_V2_FLAG_KEY]: { stage: 'canary', source: 'pg-lifecycle-test' } };
const TENANT = 'firm-pglc';

const baseDraft = () => ({
  tenant_id: TENANT,
  scope_type: 'organisation',
  scope_id: TENANT,
  lifecycle_owner_type: 'organisation',
  lifecycle_owner_id: TENANT,
  subject_type: 'contact',
  subject_id: 'contact-123',
  kind: 'assertion',
  predicate: 'office_location',
  structured_value: { value_type: 'string', value: 'Helsinki' },
  source_text: 'Our office is in Helsinki',
  source_refs: [{ message_id: 'msg-1' }],
  asserted_by_principal_id: 'user-kari',
  assertion_origin: 'owner_asserted',
  observed_at: '2026-07-12T10:00:00.000Z',
  assertion_confidence: 'high',
  confidentiality: 'internal',
  personal_data_class: 'none'
});

const activeCount = async (client, memoryKey) => {
  const res = await client.query(
    `select count(*)::int as n from memories where memory_key = $1 and record_state = 'active'`,
    [memoryKey]
  );
  return res.rows[0].n;
};

const rowById = async (client, memoryId) => {
  const res = await client.query(`select * from memories where memory_id = $1`, [memoryId]);
  return res.rows[0] || null;
};

test(
  'memories v2 real-PG lifecycle: save → supersede → contest → dismiss → erase under the one-active index',
  { skip: PG_URL ? false : 'DONNA_PG_TEST_URL not set — real-PG memory lifecycle not exercised in this run' },
  async () => {
    const dbName = `donna_memlc_${Date.now().toString(36)}_${process.pid}`;
    const admin = new pg.Client({ connectionString: PG_URL });
    await admin.connect();
    await admin.query(`create database "${dbName}"`);
    const scratchUrl = new URL(PG_URL);
    scratchUrl.pathname = `/${dbName}`;
    const client = new pg.Client({ connectionString: scratchUrl.toString() });
    await client.connect();
    try {
      // Minimal substrate 085 references: firms (FK target), audit_events
      // (the writers' same-transaction audit sink — columns mirror the audit
      // insert the writers actually run), and a bare memory_candidates for
      // 085's `add column if not exists` amendments (migration 036's table;
      // its content is irrelevant to this lifecycle).
      await client.query(`create table firms (id text primary key)`);
      await client.query(`create table memory_candidates ()`);
      await client.query(`insert into firms (id) values ($1)`, [TENANT]);
      await client.query(`
        create table audit_events (
          id bigint generated always as identity primary key,
          firm_id text not null,
          client_id text,
          actor_type text,
          actor_id text,
          action text not null,
          resource_type text,
          resource_id text,
          metadata jsonb,
          created_at timestamptz not null default now()
        )`);

      // Migration 085 VERBATIM — real tables, real partial unique index.
      const migration = await readFile(path.join(ROOT, 'db', 'migrations', '085_memories.sql'), 'utf8');
      await client.query(migration);
      // DMEM-R1 W2: the writers mint memory.v2 (migrations 142 / 143 / 146 —
      // applicability + provenance + evidence links, the relation scope guard +
      // dependency rows, the claim generation). Applied VERBATIM as well, over
      // bare stubs of the unrelated tables those migrations also touch (their
      // content is irrelevant to this lifecycle; the memories-side statements
      // are what the writers exercise).
      for (const stub of ['client_rules', 'firm_facts', 'reconciliation_matches', 'reconciliation_evaluations', 'client_evidence_requests', 'local_jobs', 'loop_event_outbox']) {
        await client.query(`create table ${stub} ()`);
      }
      for (const file of ['142_claim_applicability_evidence_links.sql', '143_memory_relations_same_scope_dependencies.sql', '146_claim_generation.sql']) {
        await client.query(await readFile(path.join(ROOT, 'db', 'migrations', file), 'utf8'));
      }

      // ── 1. save: one active head ──────────────────────────────────────────
      const saved = await saveMemory({
        client, tenantId: TENANT, record: baseDraft(),
        actor: { type: 'firm', id: 'kari' }, configSnapshot: ON, env: ENV
      });
      assert.equal(saved.status, 'persisted');
      const key = saved.write.memory_key;
      const v1 = saved.write.memory_id;
      assert.equal(await activeCount(client, key), 1);

      // ── 2. index probe: the scratch schema really enforces one-active ─────
      // A second active row in the slot must be a 23505 — this is what makes
      // the rest of the lifecycle meaningful as a regression pin. Clone the
      // whole row (no generated columns in 085) so only the identity fields
      // differ and the partial unique index is the ONLY thing that can object.
      await client.query(`create temp table _probe as select * from memories where memory_id = $1`, [v1]);
      await client.query(`update _probe set memory_id = 'memx_probe_duplicate', revision = 999, record_state = 'active'`);
      await assert.rejects(
        client.query(`insert into memories select * from _probe`),
        (err) => err.code === '23505',
        'a second active row per memory_key must violate memories_one_active_per_key'
      );
      await client.query(`drop table _probe`);

      // ── 3. supersede: with the pre-fix insert-first order this call is the
      // exact collision above; flip-first must pass, leaving one active head.
      const superseded = await supersedeMemory({
        client, tenantId: TENANT, priorMemoryId: v1,
        changes: {
          structured_value: { value_type: 'string', value: 'Espoo' },
          source_text: 'We moved to Espoo',
          source_refs: [{ message_id: 'msg-2' }]
        },
        actor: { type: 'firm', id: 'kari' }, configSnapshot: ON, env: ENV
      });
      assert.equal(superseded.status, 'superseded');
      const v2 = superseded.write.memory_id;
      assert.equal(superseded.write.revision, 2);
      assert.equal(await activeCount(client, key), 1);
      assert.equal((await rowById(client, v1)).record_state, 'superseded');
      assert.equal((await rowById(client, v2)).record_state, 'active');
      const edge = await client.query(
        `select 1 from memory_relations where source_memory_id = $1 and relation = 'supersedes' and target_memory_id = $2`,
        [v2, v1]
      );
      assert.equal(edge.rowCount, 1);

      // ── 4. stale replay: correcting the OLD head again refuses loudly ─────
      const stale = await supersedeMemory({
        client, tenantId: TENANT, priorMemoryId: v1,
        changes: { structured_value: { value_type: 'string', value: 'Tampere' }, source_text: 'x', source_refs: [{ message_id: 'msg-3' }] },
        actor: { type: 'firm', id: 'late-corrector' }, configSnapshot: ON, env: ENV
      });
      assert.equal(stale.status, 'refused');
      assert.ok(stale.errors.some((e) => /only the active head may be superseded/.test(e)));
      assert.equal(await activeCount(client, key), 1);

      // ── 5. contest: a disputed head via supersede, standing stated ────────
      const contested = await supersedeMemory({
        client, tenantId: TENANT, priorMemoryId: v2,
        changes: {
          epistemic_state: 'disputed',
          source_text: 'Owner disputes the Espoo move',
          source_refs: [{ message_id: 'msg-4' }]
        },
        actor: { type: 'owner', id: 'owner-1' }, configSnapshot: ON, env: ENV
      });
      assert.equal(contested.status, 'superseded');
      const v3 = contested.write.memory_id;
      assert.equal((await rowById(client, v3)).epistemic_state, 'disputed');
      assert.equal(await activeCount(client, key), 1);

      // ── 6. conflict, never overwrite: different content vs the active head ─
      const conflict = await saveMemory({
        client, tenantId: TENANT, record: baseDraft(),
        actor: { type: 'firm', id: 'kari' }, configSnapshot: ON, env: ENV
      });
      assert.equal(conflict.status, 'conflict');
      assert.equal(await activeCount(client, key), 1);

      // ── 7. dismiss: the human "no" ────────────────────────────────────────
      const dismissed = await dismissMemory({
        client, tenantId: TENANT, memoryId: v3, reason: 'test-no',
        actor: { type: 'firm', id: 'kari' }, configSnapshot: ON, env: ENV
      });
      assert.equal(dismissed.status, 'dismissed');
      assert.equal(await activeCount(client, key), 0);

      // ── 8. a dismissed slot is not resurrected by re-assertion ────────────
      const reassert = await saveMemory({
        client, tenantId: TENANT, record: baseDraft(),
        actor: { type: 'firm', id: 'kari' }, configSnapshot: ON, env: ENV
      });
      assert.equal(reassert.status, 'refused');
      assert.ok(reassert.errors.some((e) => /dismissed/.test(e)));

      // ── 9. erase: scrub-in-place, then anti-resurrection ──────────────────
      const erased = await eraseUserMemories({
        client, tenantId: TENANT,
        lifecycleOwnerType: 'organisation', lifecycleOwnerId: TENANT,
        reason: 'test-erase', actor: { type: 'firm', id: 'kari' },
        configSnapshot: ON, env: ENV
      });
      assert.equal(erased.status, 'erased');
      assert.ok(erased.writes.length >= 3, 'all revisions in the lifecycle root scrub');
      const scrubbed = await client.query(
        `select count(*)::int as n from memories
          where tenant_id = $1 and (structured_value is not null or source_text is not null)`,
        [TENANT]
      );
      assert.equal(scrubbed.rows[0].n, 0, 'no content survives erasure');
      const remint = await saveMemory({
        client, tenantId: TENANT, record: baseDraft(),
        actor: { type: 'firm', id: 'kari' }, configSnapshot: ON, env: ENV
      });
      assert.equal(remint.status, 'refused');
      assert.ok(remint.errors.some((e) => /erased/.test(e)));

      // ── 10. the audit trail tells the whole story ─────────────────────────
      const audits = await client.query(
        `select action, count(*)::int as n from audit_events
          where firm_id = $1 and action like 'memory.%' group by action`,
        [TENANT]
      );
      const byAction = Object.fromEntries(audits.rows.map((r) => [r.action, r.n]));
      assert.equal(byAction['memory.record_saved'], 1);
      assert.equal(byAction['memory.record_superseded'], 2);
      assert.equal(byAction['memory.record_dismissed'], 1);
      assert.ok(
        Object.keys(byAction).some((a) => /erase/.test(a)),
        'the erase batch is audited'
      );
    } finally {
      await client.end();
      try { await admin.query(`drop database "${dbName}"`); } catch { /* teardown best-effort */ }
      await admin.end();
    }
  }
);
