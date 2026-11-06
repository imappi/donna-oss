// HELMIKUU H-7b (Kari, 2026-09-24, option 1) on a real database. A selected
// duplicate/refund group whose members fall in different coding-policy windows
// is refused as a group (REFUND_GROUP_POLICY_WINDOW_UNSUPPORTED). The refusal is
// named on every surface and rests out of coder admission until a member's case
// evidence changes; it is never an owner question, a journal or an anonymous
// stall. Only provider HTTP is replaced; the windows come from a dated reviewed
// guidance fixture rendered through the live registry (the existing test seam),
// staged for this synthetic client inside a throwaway database.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import pg from 'pg';
import { __setFirmDbPoolForTests, __resetFirmDbPoolForTests } from './firmDb.js';
import { batchSuggestTransactionCodingInDb } from './db/coding.js';
import { runCodingConvergenceInDb, CODING_CONVERGENCE_ITEMS_SQL } from './codingConvergence.js';
import { readReconcileActivityWithClient } from './db/reconcileActivity.js';
import { buildCaseHealth } from './caseHealth.js';
import { projectGatheredTransaction } from './reconcileConvergenceState.js';
import { planRefundGroup } from './jevRefundGroup.js';
import { setClientFlagStage } from './clientConfig.js';
import { FI_JEV_DECISION_GUIDANCE_FLAG } from './codingGuidanceVariant.js';
import { __setFiReviewedGuidanceEntriesForTests } from './finland/decisionGuidance.js';
import { streamEntryState } from '../../src/lib/periodOverview.js';
import { buildBlockerView } from '../../src/lib/caseHealthView.js';

const pgUrl = process.env.DONNA_PG_TEST_URL;
const CODE = 'REFUND_GROUP_POLICY_WINDOW_UNSUPPORTED';
const firmId = 'h7b-firm', clientId = 'h7b-client';
const document = { id: 'receipt', firm_id: firmId, client_id: clientId, document_type: 'supplier_bill', parse_status: 'completed',
  document_date: '2025-02-14', currency: 'EUR', total_amount: 19.90, tax_amount: 4.04, parse_summary: { line_amounts_include_tax: true },
  lines: [{ id: 'source-line', description: 'Business supplies', amount: 19.90, raw_extraction: { tax_rate: .255 } }] };
// The refund lands after the reviewed guidance's effective date; the purchases before it.
const legs = [
  { id: 'debit-a', transaction_date: '2025-02-14', money_out: 19.90, money_in: 0 },
  { id: 'debit-b', transaction_date: '2025-02-14', money_out: 19.90, money_in: 0 },
  { id: 'refund', transaction_date: '2025-02-17', money_out: 0, money_in: 19.90 }
].map(row => ({ ...row, firm_id: firmId, client_id: clientId, description: 'Source-supported purchase/refund', currency: 'EUR' }));
const legIds = legs.map(leg => leg.id);

test('real PG: a cross-window refund group is named, rests out of coder admission, and wakes once on changed evidence', {
  skip: pgUrl ? false : 'DONNA_PG_TEST_URL required'
}, async (t) => {
  const name = `donna_h7b_${process.pid}_${Date.now().toString(36)}`;
  const admin = new pg.Client({ connectionString: pgUrl });
  await admin.connect();
  await admin.query(`create database "${name}"`);
  const url = new URL(pgUrl); url.pathname = `/${name}`;
  const pool = new pg.Pool({ connectionString: url.toString() });
  const closed = [];
  pool.on('connect', (connection) => closed.push(new Promise((resolve) => connection.once('end', resolve))));
  __setFirmDbPoolForTests(pool);
  const restoreEntries = __setFiReviewedGuidanceEntriesForTests([{ id: 'FIK-TEST-DATED', status: 'reviewed',
    reviewer: 'Fixture Reviewer', reviewed_on: '2026-09-23', claim: 'TEST-ONLY DATED REVIEWED CLAIM.', covers: ['FI-ALV-23'],
    sources: [{ url: 'https://www.vero.fi/example-fixture', captured_on: '2026-09-23', effective_from: '2025-02-15', effective_to: null }] }]);
  const saved = { fetch: globalThis.fetch, OPENAI_API_KEY: process.env.OPENAI_API_KEY };
  let providerCalls = 0;
  globalThis.fetch = async () => { providerCalls += 1; return new Response(JSON.stringify({ error: { message: 'fixture outage' } }), { status: 503 }); };
  process.env.OPENAI_API_KEY = 'fixture-h7b-key';
  t.after(async () => {
    restoreEntries();
    globalThis.fetch = saved.fetch;
    if (saved.OPENAI_API_KEY === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = saved.OPENAI_API_KEY;
    __resetFirmDbPoolForTests();
    await pool.end(); await Promise.all(closed);
    await admin.query(`drop database "${name}"`); await admin.end();
  });
  await pool.query(`create schema storage;
    create table storage.buckets (id text primary key, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]);
    create table storage.objects (id uuid default gen_random_uuid() primary key, bucket_id text references storage.buckets(id), name text, metadata jsonb);`);
  const migrations = new URL('../../db/migrations/', import.meta.url);
  for (const file of (await readdir(migrations)).filter((f) => f.endsWith('.sql')).sort()) await pool.query(await readFile(new URL(file, migrations), 'utf8'));
  await pool.query("insert into firms(id,name,slug) values($1,'Synthetic H-7b proof','h7b-proof')", [firmId]);
  await pool.query("insert into firm_members(id,firm_id,email,name,role,status) values('fixture-owner',$1,'fixture@example.invalid','Fixture','admin','active')", [firmId]);
  await pool.query("insert into clients(id,firm_id,company_name,jurisdiction,profile) values($1,$2,'Synthetic salon Oy','fi',$3)",
    [clientId, firmId, { jurisdiction: 'fi', accounting_system: 'none', accounting_basis: 'cash' }]);
  await pool.query("insert into client_capability_config(id,firm_id,client_id,flag_key,stage,source) values('tax',$1,$2,'FINLAND_ALV_CODING','auto','manual')", [firmId, clientId]);
  const connection = await pool.connect();
  try { await setClientFlagStage(connection, { firmId, clientId, flagKey: FI_JEV_DECISION_GUIDANCE_FLAG, stage: 'canary', reason: 'H-7b synthetic fixture', actorId: 'fixture-owner' }); }
  finally { connection.release(); }
  // Every source arrived yesterday, so the upload allowance is long spent.
  await pool.query(`insert into documents(id,firm_id,client_id,filename,document_type,parse_status,created_at) values
    ('statement',$1,$2,'OP 02-2025.pdf','bank_statement','completed',now()-interval '1 day')`, [firmId, clientId]);
  await pool.query(`insert into documents(id,firm_id,client_id,filename,document_type,parse_status,document_date,currency,total_amount,tax_amount,parse_summary,payload,created_at)
    values('receipt',$1,$2,'Synthetic receipt','supplier_bill','completed','2025-02-14','EUR',19.90,4.04,$3,'{}',now()-interval '1 day')`, [firmId, clientId, document.parse_summary]);
  await pool.query("insert into document_lines(id,firm_id,client_id,document_id,line_no,description,amount,payload) values('source-line',$1,$2,'receipt',1,'Business supplies',19.90,$3)",
    [firmId, clientId, { raw_extraction: { tax_rate: .255 } }]);
  await pool.query("insert into ledger_accounts(id,firm_id,client_id,name,account_type,normal_balance) values('supplies',$1,$2,'Operating supplies','expense','debit')", [firmId, clientId]);
  const plan = { ...planRefundGroup({ document, transactions: legs }), status: 'selected', model: 'fixture-provider', actor_id: 'fixture-decider' };
  assert.equal(plan.ok, true);
  for (const row of legs) {
    await pool.query(`insert into transactions(id,firm_id,client_id,document_id,transaction_date,description,money_in,money_out,currency,status,coding_state,payload,created_at)
      values($1,$2,$3,'statement',$4,$5,$6,$7,'EUR','needs_review','proposed',$8,now()-interval '1 day')`,
    [row.id, firmId, clientId, row.transaction_date, row.description, row.money_in, row.money_out, { jev_refund_group: plan }]);
    await pool.query(`insert into reconciliation_matches(id,firm_id,client_id,bank_transaction_id,matched_object_type,matched_object_id,match_amount,match_confidence,status,created_by,payload)
      values($1,$2,$3,$4,'supplier_bill','receipt',$5,.42,'auto_matched','fixture','{}')`,
    ['match-' + row.id, firmId, clientId, row.id, row.id === plan.purchase_transaction_id ? plan.amount : 0]);
  }
  // Neighbour: an independent line whose provider call fails transiently.
  await pool.query(`insert into transactions(id,firm_id,client_id,document_id,transaction_date,description,money_out,currency,status,created_at)
    values('fee',$1,$2,'statement','2025-02-28','Bank service charge',6,'EUR','needs_review',now()-interval '1 day')`, [firmId, clientId]);

  const admitted = async () => (await pool.query(CODING_CONVERGENCE_ITEMS_SQL, [firmId])).rows.map((row) => row.id).sort();
  const legRows = async () => (await pool.query('select * from transactions where id = any($1::text[]) order by id', [legIds])).rows;
  const legAudits = async () => Number((await pool.query('select count(*) n from audit_events where resource_id = any($1::text[])', [legIds])).rows[0].n);
  const noAskNoJournal = async () => {
    assert.equal(Number((await pool.query('select count(*) n from client_evidence_requests')).rows[0].n), 0, 'never an owner question');
    assert.equal(Number((await pool.query('select count(*) n from ledger_journals')).rows[0].n), 0, 'never a journal');
  };
  const coderUnits = [];
  const tick = () => runCodingConvergenceInDb({ firmId, batchSuggestFn: async (args) => {
    const result = await batchSuggestTransactionCodingInDb(args);
    for (const summary of result?.transaction_ai_batch?.summaries || []) coderUnits.push(...(summary.units || []));
    return result;
  } });
  const refusedGroupUnits = () => coderUnits.filter((unit) => unit.code === CODE);

  // Tick 1: the coder refuses the group on every leg; the transient line is attempted.
  assert.deepEqual(await admitted(), [...legIds, 'fee'].sort());
  await tick();
  assert.equal(refusedGroupUnits().length, 1, 'one group refusal');
  assert.deepEqual([...refusedGroupUnits()[0].transaction_ids].sort(), legIds);
  let rows = await legRows();
  for (const row of rows) {
    assert.equal(row.payload.ledger_post_refusal.code, CODE, row.id);
    assert.equal(row.payload.ledger_post_refusal.details.recovery, 'reason_about_cross_window_group');
    assert.match(row.payload.ledger_post_refusal.case_evidence_digest, /^[0-9a-f]{64}$/, 'refused under a named case revision');
    assert.equal(row.payload.ai_suggestion, undefined, 'the unit rolled back: no decision persisted');
  }
  await noAskNoJournal();
  const providerAfterFirst = providerCalls;
  assert.ok(providerAfterFirst >= 1, 'the independent line reached the provider');
  assert.deepEqual(await admitted(), ['fee'], 'the refused group leaves admission; the transient failure stays admitted');

  // Ticks 2 and 3: zero further coding attempts on the group, no new receipts.
  const restingRows = JSON.stringify(rows), restingAudits = await legAudits();
  for (let round = 2; round <= 3; round += 1) {
    await tick();
    assert.equal(refusedGroupUnits().length, 1, `tick ${round}: no further group attempt`);
    assert.ok(coderUnits.every((unit) => unit.code === CODE || !unit.transaction_ids.some((id) => legIds.includes(id))), `tick ${round}: no leg coded`);
    assert.equal(JSON.stringify(await legRows()), restingRows, `tick ${round}: legs untouched`);
    assert.equal(await legAudits(), restingAudits, `tick ${round}: no new receipts on the legs`);
  }
  assert.ok(providerCalls > providerAfterFirst, 'the transient provider failure is still retried');
  await noAskNoJournal();

  // Display: the refusal by name, stuck — never processing_cycle_expired,
  // reconciled or an owner question. The verdict still projects hanging.
  const display = async () => {
    const transactions = (await pool.query('select * from transactions order by id')).rows;
    const documents = (await pool.query('select * from documents order by id')).rows;
    const activity = await readReconcileActivityWithClient(pool, { firmId, transactions, documents, observedAt: new Date().toISOString() });
    return { transactions, activity };
  };
  let seen = await display();
  const matches = (await pool.query('select * from reconciliation_matches')).rows;
  for (const id of legIds) {
    const tx = seen.transactions.find((row) => row.id === id);
    const activity = seen.activity.get(id);
    assert.equal(activity?.state, 'failed', id);
    assert.equal(activity.reason_code, CODE, `${id}: named, not processing_cycle_expired`);
    assert.equal(activity.refusal_code, CODE);
    assert.equal(streamEntryState('open', { ...tx, processing_activity: activity }), 'stalled');
    assert.equal(projectGatheredTransaction(tx).state, 'hanging', 'a visible violation, never a terminal');
    const health = buildCaseHealth({ transaction: tx, documents: seen.documents || [], matches: matches.filter((m) => m.bank_transaction_id === id) });
    assert.equal(health.phase, 'stuck', id);
    assert.equal(health.blocker.kind, 'integration_failure');
    assert.equal(health.blocker.detail.failure, CODE);
    assert.match(health.blocker.detail.message, /spans accounting policy windows/);
    assert.equal(health.recovery.class, null);
    assert.equal(health.recovery.basis, CODE);
    // The mounted view renders the persisted code and message verbatim.
    assert.match(JSON.stringify(buildBlockerView(health.blocker)), new RegExp(`${CODE}.*spans accounting policy windows`));
  }

  // Changed evidence on one leg (a newly matched document) re-admits the whole group once.
  await pool.query(`insert into documents(id,firm_id,client_id,filename,document_type,parse_status,document_date,currency,total_amount,payload)
    values('refund-note',$1,$2,'Synthetic refund receipt','receipt','completed','2025-02-17','EUR',19.90,'{}')`, [firmId, clientId]);
  await pool.query(`insert into reconciliation_matches(id,firm_id,client_id,bank_transaction_id,matched_object_type,matched_object_id,match_amount,match_confidence,status,created_by,payload)
    values('match-refund-note',$1,$2,'refund','receipt','refund-note',19.90,.9,'auto_matched','fixture','{}')`, [firmId, clientId]);
  await tick();
  assert.equal(refusedGroupUnits().length, 2, 'the changed group was admitted and attempted exactly once more');
  const woken = (await pool.query("select resource_id, metadata from audit_events where action='coding.evidence_changed' and metadata->>'reason'='cross_window_group_evidence_changed'")).rows;
  assert.equal(woken.length, 1, 'one wake receipt for the group');
  assert.deepEqual(woken[0].metadata.transaction_ids, legIds);
  rows = await legRows();
  assert.ok(rows.every((row) => row.payload.ledger_post_refusal?.code === CODE && row.payload.ledger_post_refusal.case_evidence_digest), 'refused again, now under the new revision');
  assert.notEqual(rows.find((row) => row.id === 'refund').payload.ledger_post_refusal.case_evidence_digest,
    JSON.parse(restingRows).find((row) => row.id === 'refund').payload.ledger_post_refusal.case_evidence_digest);
  await tick();
  assert.equal(refusedGroupUnits().length, 2, 'and rests again without a further attempt');
  await noAskNoJournal();
});
