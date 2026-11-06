// DMEM-R1 W2 — migrations 141–147 applied to the REALISTIC N-1 STATE (plan v1.0
// "Wave 2" exit gate: "Migrations apply from empty and realistic N-1 states,
// preserve old-binary compatibility, and change no active behavior when
// disabled"). The from-empty half is every appliance-harness boot (the complete
// migration set, dmemW2FoundationsPgLifecycle.test.js); this file is the other
// half: a scratch database migrated to the head BEFORE W2 (138), populated with
// the rows an appliance at that head really carries — a v1 memory with its
// supersedes relation, a legacy candidate, a merchant rule, a firm fact, an ask
// stamped sent at mint with send_count 0 (the F-11 shape LR-2 targets), a pending
// local job, an outbox row, a retained LLM decision, a local evidence object — then
// 141–147 applied through the same file order the migrator uses, and PROVED:
//   - every migration applies cleanly on top of those rows;
//   - every pre-existing row is byte-identical over its pre-W2 columns (no
//     backfill, no rewrite — a backfill is W3's dry-run);
//   - the new columns carry their declared defaults (memories / local_jobs
//     claim_generation 1, candidate_version 1) or null;
//   - the F-11 false-sent ask is NOT refused and NOT repaired (147 is dark until
//     armed; LR-2 repairs from a delivery fact);
//   - an OLD binary's memory.v1 insert (the 085 column list only) still succeeds
//     after the migrations, and a v1 row rebuilt through the writer's reader
//     validates as v1 (old-binary compatibility, the version is a field);
//   - the schema_version widening admits memory.v2 and refuses anything else.
// Plain assertions, expected to pass from W2 on. INV-24: the guard refuses the
// appliance cluster before any `create database`; the scratch database is dropped.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

import { applianceHarnessSkipReason, assertNotApplianceCluster } from './testSupport/applianceHarness.js';
import { canonicalDigest } from './testSupport/dmemFixtureSupport.js';
import { completeMemoryRecordDraft, rowToMemoryRecord } from './memoriesDb.js';
import { MEMORY_SCHEMA_VERSION, validateMemoryRecord } from './memoryModel.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const MIGRATIONS_DIR = path.join(ROOT, 'db', 'migrations');
const PRIOR_HEAD = '138_coding_state';
const FIRST_W2 = '141_';
const LAST_W2 = '147_';
const ENV = { MEMORY_KEY_HMAC_SECRET: 'dmem-w2-n1-hmac' };

const FIRM = 'dmem-w2-n1-firm';
const CLIENT = 'dmem-w2-n1-client';

// The 085 column list — what an OLD binary's insert names (memoriesDb.js before W2).
const V1_COLUMNS = [
  'memory_id', 'memory_key', 'revision', 'content_hash', 'schema_version',
  'tenant_id', 'scope_type', 'scope_id', 'lifecycle_owner_type', 'lifecycle_owner_id',
  'owner_user_id', 'owner_organisation_id', 'owner_client_id', 'owner_ephemeral_ref',
  'subject_type', 'subject_id', 'observed_alias',
  'kind', 'predicate', 'predicate_class', 'structured_value', 'source_text', 'source_refs',
  'asserted_by_principal_id', 'assertion_origin', 'transport_actor',
  'extraction_model_id', 'extraction_prompt_version', 'validator_version', 'activation_confirmation',
  'observed_at', 'recorded_at', 'valid_from', 'valid_until',
  'retention_policy_id', 'retain_until', 'review_after', 'last_confirmed_at',
  'assertion_confidence', 'truth_confidence', 'confidentiality', 'personal_data_class',
  'record_state', 'epistemic_state', 'record_version', 'supersedes_memory_id',
  'erased_at', 'creation_provenance'
];
const V1_JSONB = new Set(['structured_value', 'source_refs', 'activation_confirmation', 'creation_provenance']);

const insertV1Memory = async (client, record) => {
  const roots = {
    owner_user_id: record.lifecycle_owner_type === 'user' ? record.lifecycle_owner_id : null,
    owner_organisation_id: record.lifecycle_owner_type === 'organisation' ? record.lifecycle_owner_id : null,
    owner_client_id: record.lifecycle_owner_type === 'legal_entity' ? record.lifecycle_owner_id : null,
    owner_ephemeral_ref: record.lifecycle_owner_type === 'ephemeral' ? record.lifecycle_owner_id : null
  };
  const row = { ...record, ...roots };
  const values = V1_COLUMNS.map((col) => {
    const v = row[col] ?? null;
    return V1_JSONB.has(col) && v !== null ? JSON.stringify(v) : v;
  });
  await client.query(
    `insert into memories (${V1_COLUMNS.join(', ')}) values (${V1_COLUMNS.map((col, i) => (V1_JSONB.has(col) ? `$${i + 1}::jsonb` : `$${i + 1}`)).join(', ')})`,
    values
  );
};

const v1Draft = (overrides = {}) => completeMemoryRecordDraft({
  record: {
    schema_version: MEMORY_SCHEMA_VERSION,
    tenant_id: FIRM, scope_type: 'legal_entity', scope_id: CLIENT, lifecycle_owner_type: 'legal_entity', lifecycle_owner_id: CLIENT,
    subject_type: 'merchant', subject_id: 'acme-supplies', observed_alias: 'ACME SUPPLIES LTD',
    kind: 'assertion', predicate: 'supplier_category',
    structured_value: { value_type: 'string', value: 'stationery' }, source_text: 'Acme Supplies sells stationery to the studio.',
    source_refs: [{ transaction_id: `${CLIENT}-tx-1` }], asserted_by_principal_id: 'n1-owner', assertion_origin: 'owner_asserted',
    observed_at: '2026-08-01T10:00:00.000Z', assertion_confidence: 'high', confidentiality: 'internal', personal_data_class: 'none',
    ...overrides
  },
  env: ENV
});

const columnsOf = async (client, table) => (await client.query(
  'select column_name from information_schema.columns where table_schema = $1 and table_name = $2 order by ordinal_position',
  ['public', table]
)).rows.map((r) => r.column_name);

// A byte-level snapshot of the named rows over EXACTLY the given columns.
const snapshotRows = async (client, table, columns, where, params) => {
  const rows = (await client.query(`select ${columns.map((c) => `"${c}"`).join(', ')} from ${table} where ${where} order by 1`, params)).rows;
  return { digest: canonicalDigest(rows), rows };
};

test(
  'real PG (DMEM W2): migrations 141–147 apply to the realistic N-1 state, backfill nothing, and keep an old binary\'s v1 writes valid',
  { skip: applianceHarnessSkipReason() },
  async (t) => {
    const adminUrl = process.env.DONNA_PG_TEST_URL;
    const dbName = `donna_dmem_w2_n1_${Date.now().toString(36)}_${process.pid}`;
    await assertNotApplianceCluster({ adminUrl, scratchDbName: dbName });
    const admin = new pg.Client({ connectionString: adminUrl });
    await admin.connect();
    await admin.query(`create database "${dbName}"`);
    const url = new URL(adminUrl);
    url.pathname = `/${dbName}`;
    const client = new pg.Client({ connectionString: url.toString() });
    await client.connect();
    try {
      // The CI storage stub (migration 010 targets Supabase's storage schema).
      await client.query(`
        create schema if not exists storage;
        create table if not exists storage.buckets (id text primary key, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]);
        create table if not exists storage.objects (id uuid default gen_random_uuid() primary key, bucket_id text references storage.buckets(id), name text, metadata jsonb);
      `);
      const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();
      const prior = files.filter((f) => f < FIRST_W2);
      const w2 = files.filter((f) => f >= FIRST_W2 && f < `${LAST_W2}~`);
      const beyond = files.filter((f) => f >= `${LAST_W2}~`);
      assert.equal(prior[prior.length - 1].replace(/\.sql$/, ''), PRIOR_HEAD, 'the N-1 head is 138 (the tree before W2)');
      assert.deepEqual(w2.map((f) => f.slice(0, 3)), ['141', '142', '143', '144', '145', '146', '147'], 'exactly the W2 reservations');
      // 148–149 stay HELD (W2 gap G-2 / the reserved slot): nothing may take
      // them. Later numbers are outside this proof's subject — W2 is 141–147 on
      // the N-1 state — so a slice that takes the next free number (RT-21c's
      // 150, `reconciliation_matches.matched_line_id`) is admitted here and
      // simply not applied in the W2 phase below.
      const held = beyond.filter((f) => f.startsWith('148_') || f.startsWith('149_'));
      assert.deepEqual(held, [], '148–149 are held (W2 gap G-2 / reserved) — nothing may take them');
      for (const file of beyond) assert.ok(Number(file.slice(0, 3)) >= 150, `${file}: only migrations after the held slots may follow W2`);
      for (const file of prior) {
        await client.query(await readFile(path.join(MIGRATIONS_DIR, file), 'utf8'));
        await client.query('insert into schema_migrations (version) values ($1) on conflict (version) do nothing', [file.replace(/\.sql$/, '')]);
      }

      // ── The realistic N-1 book: rows an appliance at 138 really carries. ──
      await client.query("insert into firms (id, name, slug, jurisdiction, default_currency) values ($1, 'N-1 Firm', $1, 'GB', 'GBP')", [FIRM]);
      await client.query("insert into clients (id, firm_id, company_name, jurisdiction) values ($1, $2, 'N-1 Client Ltd', 'GB')", [CLIENT, FIRM]);
      const { record: head, errors: headErrors } = v1Draft();
      assert.deepEqual(headErrors, []);
      const { record: successor } = v1Draft({ memory_key: head.memory_key, revision: 2, supersedes_memory_id: head.memory_id, structured_value: { value_type: 'string', value: 'software' }, source_text: 'Acme Supplies is a software vendor.' });
      head.record_state = 'superseded';
      await insertV1Memory(client, head);
      await insertV1Memory(client, successor);
      await client.query("insert into memory_relations (tenant_id, source_memory_id, relation, target_memory_id, created_by) values ($1, $2, 'supersedes', $3, 'n1-owner')", [FIRM, successor.memory_id, head.memory_id]);
      await client.query(
        `insert into memory_candidates (id, firm_id, client_id, candidate_type, status, source, scope, subject, fact, confidence, provenance)
         values ('memcand-n1', $1, $2, 'fact', 'suggested', 'n1_distiller', 'merchant', 'ACME SUPPLIES LTD', 'Acme Supplies sells stationery.', 'medium', '{"client_id":"dmem-w2-n1-client"}'::jsonb)`,
        [FIRM, CLIENT]
      );
      await client.query(
        `insert into client_rules (id, firm_id, client_id, rule_type, pattern_text, account_code, status, created_by, payload)
         values ('rule-n1', $1, $2, 'merchant_category', 'acme supplies', '6400', 'active', 'ai', '{"source":"ai_batch"}'::jsonb)`,
        [FIRM, CLIENT]
      );
      await client.query(
        `insert into firm_facts (id, firm_id, scope, subject, fact, provenance, status) values ('fact-n1', $1, 'merchant', 'ACME SUPPLIES LTD', 'Acme sells stationery.', '{"client_id":"dmem-w2-n1-client"}'::jsonb, 'active')`,
        [FIRM]
      );
      // The F-11 shape: minted "sent" with send_count 0 and no delivery-ledger row.
      await client.query(
        `insert into client_evidence_requests (id, firm_id, client_id, status, evidence_type, question, request_payload, first_sent_at, last_sent_at, send_count)
         values ('ask-n1-false-sent', $1, $2, 'open', 'supporting_document', 'Which receipt covers this?', '{"sent_at": 1756684800000}'::jsonb, '2026-09-01T09:00:00Z', '2026-09-01T09:00:00Z', 0)`,
        [FIRM, CLIENT]
      );
      await client.query("insert into local_jobs (function_id, payload, dedupe_key) values ('parse-cron:stuck', '{\"tick\":\"n1\"}'::jsonb, 'n1-stuck')");
      await client.query("insert into loop_event_outbox (id, firm_id, client_id, event_type, payload) values ('outbox-n1', $1, $2, 'goal.regressed', '{}'::jsonb)", [FIRM, CLIENT]);
      await client.query("insert into llm_decisions (id, firm_id, client_id, decision_type, target_type, target_id, model_name) values ('decision-n1', $1, $2, 'match', 'reconciliation_match', 'match-n1', 'recorded-matcher')", [FIRM, CLIENT]);
      await client.query("insert into local_evidence_objects (bucket, key, content_hash, byte_length) values ('evidence', $1, 'sha256:n1', 12)", [`${FIRM}/${CLIENT}/receipt.pdf`]);

      const before = {};
      const tracked = [
        ['memories', 'tenant_id = $1', [FIRM]], ['memory_relations', 'tenant_id = $1', [FIRM]], ['memory_candidates', 'firm_id = $1', [FIRM]],
        ['client_rules', 'firm_id = $1', [FIRM]], ['firm_facts', 'firm_id = $1', [FIRM]], ['client_evidence_requests', 'firm_id = $1', [FIRM]],
        ['local_jobs', 'true', []], ['loop_event_outbox', 'firm_id = $1', [FIRM]], ['llm_decisions', 'firm_id = $1', [FIRM]], ['local_evidence_objects', 'true', []]
      ];
      for (const [table, where, params] of tracked) {
        const columns = await columnsOf(client, table);
        before[table] = { columns, ...(await snapshotRows(client, table, columns, where, params)) };
        assert.ok(before[table].rows.length >= 1, `${table}: the N-1 book has rows`);
      }

      // ── Apply W2 on top, the migrator's way (one transaction per file). ──
      for (const file of w2) {
        await client.query('begin');
        try {
          await client.query(await readFile(path.join(MIGRATIONS_DIR, file), 'utf8'));
          await client.query('insert into schema_migrations (version) values ($1) on conflict (version) do nothing', [file.replace(/\.sql$/, '')]);
          await client.query('commit');
        } catch (error) {
          await client.query('rollback');
          throw new Error(`${file} failed on the N-1 state: ${error.message}`);
        }
      }

      await t.test('every pre-existing row is byte-identical over its pre-W2 columns (no backfill, no rewrite)', async () => {
        for (const [table, where, params] of tracked) {
          const after = await snapshotRows(client, table, before[table].columns, where, params);
          assert.equal(after.digest, before[table].digest, `${table}: the N-1 rows are untouched over their original columns`);
          assert.equal(after.rows.length, before[table].rows.length);
        }
      });

      await t.test('the new columns carry their declared defaults or null; the F-11 ask is neither refused nor repaired', async () => {
        const mem = (await client.query('select schema_version, applicability, evidence_fingerprint, claim_generation::int as claim_generation, confirmation_history, source_object_id from memories where memory_id = $1', [successor.memory_id])).rows[0];
        assert.equal(mem.schema_version, 'memory.v1', 'a v1 row stays v1 — the version is a field');
        assert.equal(mem.applicability, null);
        assert.equal(mem.evidence_fingerprint, null);
        assert.equal(mem.claim_generation, 1);
        assert.deepEqual(mem.confirmation_history, []);
        assert.equal((await client.query("select candidate_version, scoped_identity, expected_claim_generation from memory_candidates where id = 'memcand-n1'")).rows[0].candidate_version, 1);
        assert.equal((await client.query("select scoped_identity from memory_candidates where id = 'memcand-n1'")).rows[0].scoped_identity, null);
        assert.equal(Number((await client.query('select claim_generation from local_jobs')).rows[0].claim_generation), 1);
        assert.deepEqual((await client.query("select valid_from, valid_until, jurisdiction, claim_generation from client_rules where id = 'rule-n1'")).rows[0], { valid_from: null, valid_until: null, jurisdiction: null, claim_generation: null });
        assert.deepEqual((await client.query("select envelope_id, pre_action_envelope_digest from llm_decisions where id = 'decision-n1'")).rows[0], { envelope_id: null, pre_action_envelope_digest: null });
        assert.deepEqual((await client.query("select owner_firm_id, owner_client_id from local_evidence_objects")).rows[0], { owner_firm_id: null, owner_client_id: null });
        const ask = (await client.query("select first_sent_at, send_count, request_payload from client_evidence_requests where id = 'ask-n1-false-sent'")).rows[0];
        assert.ok(ask.first_sent_at && ask.send_count === 0 && ask.request_payload.sent_at, 'the false-sent shape survives untouched (LR-2 repairs it from a delivery fact, never a migration)');
        // Dark: an unarmed UPDATE of that legacy row still commits (no behaviour change).
        await client.query("update client_evidence_requests set updated_at = now() where id = 'ask-n1-false-sent'");
        // Armed: the same row's dishonesty is refused at commit — the law exists, it is just not armed on this tree.
        await client.query('begin');
        await client.query("select set_config('donna.delivery_state_constraints', 'enforce', true)");
        await client.query("update client_evidence_requests set updated_at = now() where id = 'ask-n1-false-sent'");
        await assert.rejects(() => client.query('commit'), /client_evidence_requests_delivery_state/);
      });

      await t.test('old-binary compatibility: a memory.v1 insert over the 085 column list still succeeds, and the reader rebuilds it as a valid v1 record', async () => {
        const { record: fresh, errors } = v1Draft({ subject_id: 'dune-apparel', observed_alias: 'DUNE APPAREL LTD', source_refs: [{ transaction_id: `${CLIENT}-tx-2` }] });
        assert.deepEqual(errors, []);
        await insertV1Memory(client, fresh);
        const row = (await client.query('select * from memories where memory_id = $1', [fresh.memory_id])).rows[0];
        assert.equal(Number(row.claim_generation), 1, 'the default filled the new column');
        const rebuilt = rowToMemoryRecord(row);
        assert.equal(rebuilt.schema_version, MEMORY_SCHEMA_VERSION);
        assert.equal(rebuilt.applicability, undefined, 'a v1 row rebuilds into the v1 envelope');
        assert.deepEqual(validateMemoryRecord(rebuilt), [], 'the old binary\'s row validates as v1 after the migrations');
        assert.equal(rebuilt.content_hash, fresh.content_hash, 'hash-stable');
      });

      await t.test('the schema_version check admits memory.v2 and refuses anything else; a v2 row must declare its applicability', async () => {
        await assert.rejects(() => client.query("update memories set schema_version = 'memory.v9' where memory_id = $1", [successor.memory_id]), /memories_schema_version_check/);
        await assert.rejects(() => client.query("update memories set schema_version = 'memory.v2' where memory_id = $1", [successor.memory_id]), /memories_v2_carries_applicability/, 'a v2 row without applicability is refused (the contract is structural)');
        assert.equal((await client.query("select count(*)::int as n from schema_migrations where version >= '141' and version < '148'")).rows[0].n, 7);
      });
    } finally {
      await client.end().catch(() => {});
      await admin.query('select pg_terminate_backend(pid) from pg_stat_activity where datname = $1 and pid <> pg_backend_pid()', [dbName]).catch(() => {});
      await admin.query(`drop database if exists "${dbName}"`).catch(() => {});
      await admin.end().catch(() => {});
    }
  }
);
