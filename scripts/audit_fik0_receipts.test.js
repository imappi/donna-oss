import assert from 'node:assert/strict';
import test from 'node:test';
import { readdir, readFile } from 'node:fs/promises';
import pg from 'pg';
import { auditFik0Receipts, summarizeFik0Receipts } from './audit_fik0_receipts.js';
import { CLOUD_PILOT_PROCESSING_VERSION } from '../server/donna/cloudPilotConfig.js';

const receipt = (overrides = {}) => ({ request_sha256s: ['a'.repeat(64)], jev_basis: 'hosted_fi_default',
  delivered_facts: [], fact_read_status: 'empty', ...overrides });

test('summary: pre-FIK-0a decisions are unknown, never "no facts delivered"', () => {
  const report = summarizeFik0Receipts({
    books: [{ client_id: 'a' }],
    decisions: [
      { transaction_id: 't-old', client_id: 'a', suggestion: { decision_engine: 'jev', jev_decision: { probability: .9 } } },
      { transaction_id: 't-new', client_id: 'a', suggestion: { decision_engine: 'jev', jev_decision: receipt() } }
    ]
  });
  assert.deepEqual([report.totals.decisions, report.totals.instrumented, report.totals.unknown], [2, 1, 1]);
  assert.deepEqual(report.books[0].by_fact_read_status, { empty: 1 });
});

test('summary: jurisdiction and cross-entity legacy deliveries are named per decision', () => {
  const facts = [
    { id: 'f-jur', scope: 'jurisdiction', provenance: { client_id: 'a' } },
    { id: 'f-legacy', scope: 'merchant', provenance: { asserted_by_clients: ['a'] }, effective_from: '2025-01-01' }
  ];
  const delivered = [{ id: 'f-legacy', scope: 'merchant', legacy_firm_scope: true }];
  const report = summarizeFik0Receipts({ facts, books: [{ client_id: 'a' }, { client_id: 'b' }], decisions: [
    { transaction_id: 't-a', client_id: 'a', suggestion: { decision_engine: 'jev', jev_decision: receipt({ fact_read_status: 'ok',
      delivered_facts: [{ id: 'f-jur', scope: 'jurisdiction', legacy_firm_scope: false }, ...delivered] }) } },
    { transaction_id: 't-b', client_id: 'b', suggestion: { decision_engine: 'strong_after_jev', jev_handoff: receipt({ fact_read_status: 'ok', delivered_facts: delivered }) } },
    { transaction_id: 't-gone', client_id: 'b', suggestion: { decision_engine: 'jev', jev_decision: receipt({ fact_read_status: 'read_failed',
      delivered_facts: [{ id: 'f-purged', scope: 'merchant', legacy_firm_scope: true }] }) } }
  ] });
  const [a, b] = report.books;
  assert.deepEqual(a.decisions_with_jurisdiction_fact, ['t-a']);
  assert.deepEqual(a.decisions_with_cross_entity_legacy_fact, [], 'the asserter keeps its own fact');
  assert.deepEqual(b.decisions_with_cross_entity_legacy_fact, ['t-b'], 'a sibling entity received it');
  assert.equal(b.delivered.fact_row_absent, 1, 'a purged row is counted, not judged');
  assert.deepEqual(b.decisions_with_read_failure, ['t-gone']);
  assert.equal(a.delivered.with_effective_interval, 1);
  assert.deepEqual(report.totals, { books: 2, decisions: 3, instrumented: 3, unknown: 0,
    decisions_with_jurisdiction_fact: 1, decisions_with_cross_entity_legacy_fact: 1, decisions_with_read_failure: 1 });
});

const pgUrl = process.env.DONNA_PG_TEST_URL;
test('real PG: the audit reads receipts and each book\'s resolved basis inside a read-only transaction', { skip: !pgUrl && 'DONNA_PG_TEST_URL required' }, async t => {
  const admin = new pg.Client({ connectionString: pgUrl }); await admin.connect();
  const name = `donna_fik0_audit_${process.pid}_${Date.now().toString(36)}`;
  await admin.query(`create database "${name}"`); const url = new URL(pgUrl); url.pathname = '/' + name;
  const client = new pg.Client({ connectionString: url.toString() }); await client.connect();
  t.after(async () => { await client.end(); await admin.query(`drop database "${name}"`); await admin.end(); });
  await client.query('create schema storage;create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);create table storage.objects(id uuid default gen_random_uuid() primary key,bucket_id text references storage.buckets(id),name text,metadata jsonb)');
  const migrations = new URL('../db/migrations/', import.meta.url);
  for (const file of (await readdir(migrations)).filter(n => n.endsWith('.sql')).sort()) await client.query(await readFile(new URL(file, migrations), 'utf8'));
  const firmId = 'fik0-firm';
  await client.query("insert into firms(id,name,slug) values($1,'Synthetic audit firm',$1)", [firmId]);
  for (const [id, entity] of [['oy-a', 'fi-oy'], ['tmi-b', 'fi-toiminimi']]) await client.query("insert into clients(id,firm_id,company_name,jurisdiction,entity_type,profile) values($1,$2,$1,'FI',$3,'{}')", [id, firmId, entity]);
  // oy-a: the hosted pilot row; tmi-b: a desktop default row.
  await client.query("insert into client_capability_config(id,firm_id,client_id,flag_key,stage,source,reason) values('cfg-a',$1,'oy-a','JEV_RECONCILIATION','auto','manual',$2)", [firmId, CLOUD_PILOT_PROCESSING_VERSION]);
  await client.query("insert into client_capability_config(id,firm_id,client_id,flag_key,stage,source) values('cfg-b',$1,'tmi-b','JEV_RECONCILIATION','auto','default')", [firmId]);
  await client.query("insert into firm_facts(id,firm_id,scope,subject,fact,provenance) values('f-jur',$1,'jurisdiction','fi','Synthetic rule',$2),('f-legacy',$1,'merchant','synthetic cafe','Synthetic merchant fact',$3)",
    [firmId, { client_id: 'oy-a' }, { asserted_by_clients: ['oy-a'] }]);
  const legacy = { id: 'f-legacy', scope: 'merchant', legacy_firm_scope: true };
  for (const [id, clientId, suggestion] of [
    ['t-a', 'oy-a', { decision_engine: 'jev', source: 'openai_batch', jev_decision: receipt({ fact_read_status: 'ok', delivered_facts: [{ id: 'f-jur', scope: 'jurisdiction', legacy_firm_scope: false }, legacy] }) }],
    ['t-b', 'tmi-b', { decision_engine: 'jev', source: 'openai', jev_decision: receipt({ jev_basis: 'desktop_default', fact_read_status: 'ok', delivered_facts: [legacy] }) }],
    ['t-old', 'tmi-b', { decision_engine: 'jev', jev_decision: { probability: .8 } }],
    ['t-strong', 'tmi-b', { decision_engine: 'openai', proposed_account: 'Office expenses' }]
  ]) await client.query("insert into transactions(id,firm_id,client_id,transaction_date,description,money_in,money_out,currency,status,payload) values($1,$2,$3,'2026-01-05','Synthetic',0,10,'EUR','needs_review',$4)", [id, firmId, clientId, { ai_suggestion: suggestion }]);
  const before = (await client.query("select count(*)::int n from audit_events")).rows[0].n;

  const report = await auditFik0Receipts({ client, firmId, model: 'fixture-model' });
  assert.equal(report.read_only, 'on');
  assert.deepEqual(report.totals, { books: 2, decisions: 3, instrumented: 2, unknown: 1,
    decisions_with_jurisdiction_fact: 1, decisions_with_cross_entity_legacy_fact: 1, decisions_with_read_failure: 0 });
  const [a, b] = report.books;
  assert.deepEqual(a.resolved_basis, { desktop: { basis: null, code: 'jev_experiment_not_authorized' }, hosted: { basis: 'hosted_fi_default' } });
  assert.deepEqual(b.resolved_basis, { desktop: { basis: 'desktop_default' }, hosted: { basis: null, code: 'jev_experiment_not_authorized' } },
    'a hosted toiminimi book never reaches Jev (§1.8)');
  assert.deepEqual(b.decisions_with_cross_entity_legacy_fact, ['t-b']);
  assert.deepEqual(a.by_source, { openai_batch: 1 });
  assert.ok(!JSON.stringify(report).includes('Synthetic rule'), 'no fact text leaves the database');
  assert.equal((await client.query("select count(*)::int n from audit_events")).rows[0].n, before, 'nothing written');
  // The report never falls back to an ambient transaction.
  assert.equal((await client.query("select current_setting('transaction_read_only') as r")).rows[0].r, 'off');
});
