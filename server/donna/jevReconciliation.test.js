import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import pg from 'pg';
import { executableJevSettlement, __jevReconciliation, completeOwnerConfirmedJevPlanWithClient } from './jevReconciliation.js';
import { readClientConfigSnapshot } from './clientConfig.js';
import { runPaymentConfirmationReconciliationLlmForDocument } from './paymentConfirmationReconciliationLlm.js';
import { runPaymentAccountStatementReconciliationLlmForDocument } from './paymentAccountStatementReconciliationLlm.js';
import { runPayoutReconciliationLlmForDocument } from './payoutReconciliationLlm.js';
import { readJevCase } from './jevPreview.js';
import { decideJevReconciliation } from './jevRuntimeDecision.js';
import { runSalesInvoiceReconciliationLlmForDocument } from './salesInvoiceReconciliationLlm.js';
import { runSupplierBillReconciliationLlmForDocument } from './supplierBillReconciliationLlm.js';
import { runReceiptReconciliationLlmForDocument } from './receiptReconciliationLlm.js';
import { runReceiptReconciliationForDocument } from './receiptReconciliation.js';
import { __setFirmDbPoolForTests, __resetFirmDbPoolForTests } from './firmDb.js';
import { providerKeyMissing } from './providerTransport.js';
import { runDocumentDispositionForClient } from './documentDispositionLlm.js';
import { convergenceForUnmatchedDocument } from './reconcileConvergenceState.js';
import { recoverReconciliationProviderFailures } from './reconciliationProviderFailure.js';

// The first-line lane decides only on a host with its provider configured
// (firstLineLane.js, 2026-11-10); these cases are about the lane deciding.
process.env.TYPESAFE_API_KEY ||= 'fixture-first-line-key';
process.env.TYPESAFE_MODEL ||= 'fixture-first-line';

const resultFor = (type = 'sales_invoice') => ({ document: { id: 'doc', document_type: type, total_amount: 100, currency: 'EUR' },
  candidates: [{ id: 'bank', currency: 'EUR', money_in: type === 'sales_invoice' ? 100 : 0, money_out: type === 'sales_invoice' ? 0 : 100 }],
  decision: { terminal: 'resolve', probability: 0.36, refusals: [], plan: { allocations: [{ transaction_id: 'bank', amount_minor: 10000, currency: 'EUR' }], retained_balance_minor: 0, requests: [] } } });

test('executable scope retains raw Jev confidence and rejects partial, fee and companion consequences', () => {
  const chosen = executableJevSettlement(resultFor());
  assert.equal(chosen.ok, true);
  assert.equal(chosen.proposal.confidence, 0.36);
  assert.equal(chosen.proposal.decision_source, 'jev_full_settlement');
  for (const field of ['fee_minor', 'surplus_minor']) {
    const result = resultFor(); result.decision.plan.allocations[0][field] = 1;
    assert.equal(executableJevSettlement(result).ok, false);
  }
  const partial = resultFor(); partial.decision.plan.retained_balance_minor = 100;
  assert.equal(executableJevSettlement(partial).ok, false);
  const companion = resultFor(); companion.decision.plan.requests = [{ transaction_id: 'other' }];
  assert.equal(executableJevSettlement(companion).ok, false);
});

test('real PG: all scoped families dispatch Jev before Anthropic credentials and persist through existing writers', { skip: !process.env.DONNA_PG_TEST_URL }, async t => {
  const name = `donna_jev_writer_${process.pid}`;
  const admin = new pg.Client({ connectionString: process.env.DONNA_PG_TEST_URL }); await admin.connect();
  await admin.query(`create database "${name}"`);
  const url = new URL(process.env.DONNA_PG_TEST_URL); url.pathname = `/${name}`;
  const pool = new pg.Pool({ connectionString: url.toString() });
  __setFirmDbPoolForTests(pool);
  const priorDecide = __jevReconciliation.decide;
  const oldPolicy = process.env.RECONCILIATION_AUTO_MATCH_POLICY;
  const oldCeiling = process.env.RECONCILIATION_AUTO_MATCH_MATERIALITY_CEILING;
  const oldKey = process.env.ANTHROPIC_API_KEY;
  process.env.RECONCILIATION_AUTO_MATCH_POLICY = '1';
  process.env.RECONCILIATION_AUTO_MATCH_MATERIALITY_CEILING = '1000';
  delete process.env.ANTHROPIC_API_KEY;
  t.after(async () => {
    __jevReconciliation.decide = priorDecide;
    for (const [key, value] of [['RECONCILIATION_AUTO_MATCH_POLICY', oldPolicy], ['RECONCILIATION_AUTO_MATCH_MATERIALITY_CEILING', oldCeiling], ['ANTHROPIC_API_KEY', oldKey]]) {
      if (value == null) delete process.env[key]; else process.env[key] = value;
    }
    __resetFirmDbPoolForTests(); await pool.end();
    await admin.query(`drop database "${name}"`); await admin.end();
  });
  await pool.query(`create schema storage;
    create table storage.buckets (id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
    create table storage.objects (id uuid default gen_random_uuid() primary key,bucket_id text references storage.buckets(id),name text,metadata jsonb)`);
  const root = new URL('../../db/migrations/', import.meta.url);
  for (const file of (await readdir(root)).filter(f => f.endsWith('.sql')).sort()) await pool.query(await readFile(new URL(file, root), 'utf8'));
  await pool.query("insert into firms(id,name,slug) values('jev-firm','Jev Test','jev-test')");
  await pool.query("insert into clients(id,firm_id,company_name,jurisdiction,entity_type,profile) values('jev-company','jev-firm','Example','fi','fi-oy','{\"jurisdiction\":\"fi\",\"accounting_system\":\"none\"}')");
  for (const flag of ['JEV_RECONCILIATION', 'RECONCILIATION_AUTO_MATCH', 'RECONCILIATION_EXACT_MATCH_BACKSTOP']) await pool.query("insert into client_capability_config(id,firm_id,client_id,flag_key,stage,source) values($1,'jev-firm','jev-company',$1,'auto','manual')", [flag]);
  let decisions = 0;
  __jevReconciliation.decide = async args => {
    decisions++;
    const mapped = await readJevCase(args);
    const bank = mapped.candidates.find(b => b.id === `bank-${args.documentId}`);
    return { document: mapped.sourceDocument, candidates: mapped.candidates, evidence_packet_sha256: mapped.prepared.packet_sha256,
      decision: { terminal: 'resolve', probability: 0.36, refusals: [], plan: { allocations: [{ transaction_id: bank.id, amount_minor: 10000, currency: 'EUR' }], retained_balance_minor: 0, requests: [] } },
      model: 'fixture-returned-model', usage: { input_tokens: 1, output_tokens: 1 } };
  };
  const client = await pool.connect();
  try {
    for (const [family, runner] of [['sales_invoice', runSalesInvoiceReconciliationLlmForDocument], ['supplier_bill', runSupplierBillReconciliationLlmForDocument], ['receipt', runReceiptReconciliationLlmForDocument], ['payment_confirmation', runPaymentConfirmationReconciliationLlmForDocument], ['payment_account_statement', runPaymentAccountStatementReconciliationLlmForDocument], ['payout_statement', runPayoutReconciliationLlmForDocument], ['deposit_slip', runPayoutReconciliationLlmForDocument]]) {
      await client.query("insert into documents(id,firm_id,client_id,filename,document_type,parse_status,document_date,total_amount,currency,payment_status) values($1,'jev-firm','jev-company',$1,$1,'completed','2026-09-01',100,'EUR','unpaid')", [family]);
      await client.query("insert into transactions(id,firm_id,client_id,transaction_date,description,money_in,money_out,currency,status,payload) values($1,'jev-firm','jev-company','2026-09-02',$1,$2,$3,'EUR','needs_review','{}')", [`bank-${family}`, ['sales_invoice','payout_statement','deposit_slip'].includes(family) ? 100 : 0, ['sales_invoice','payout_statement','deposit_slip'].includes(family) ? 0 : 100]);
      const stats = await runner({ client, firmId: 'jev-firm', clientId: 'jev-company', documentId: family,
        fetchImpl: async () => { throw new Error('Unexpected legacy provider call'); } });
      assert.equal(stats.decision_engine, 'jev');
      assert.equal(stats.jev_reason, null, JSON.stringify(stats));
      const { rows } = await client.query("select status,match_confidence,payload from reconciliation_matches where matched_object_id=$1", [family]);
      assert.equal(rows.length, 1);
      assert.equal(rows[0].status, 'auto_matched');
      assert.equal(Number(rows[0].match_confidence), 0.36);
      assert.equal(rows[0].payload.authorization.model, 'fixture-returned-model');
      const { rows: evaluations } = await client.query("select payload,model from reconciliation_evaluations where target_id=$1", [family]);
      assert.equal(evaluations[0].payload.execution, 'existing_reconciliation_writer');
      assert.equal(evaluations[0].model, 'fixture-returned-model');
    }
    // H-3b: a match the writer holds above the materiality ceiling is a settled
    // held verdict. The held-match owner confirmation is its terminal; the
    // recovery sweep must not buy another Jev decision for it.
    const familyDecide = __jevReconciliation.decide;
    // The recovery sweep re-drives through the family orchestrator; its env gate.
    const priorBillFlag = process.env.BILL_MATCHER_ENABLED; process.env.BILL_MATCHER_ENABLED = '1';
    t.after(() => { if (priorBillFlag === undefined) delete process.env.BILL_MATCHER_ENABLED; else process.env.BILL_MATCHER_ENABLED = priorBillFlag; });
    const sweep = () => recoverReconciliationProviderFailures({ client, firmId: 'jev-firm', withClient: fn => fn(client), onRunCompletedFn: null });
    const backdate = id => client.query("update reconciliation_evaluations set evaluated_at=now()-interval '10 minutes' where target_id=$1", [id]);
    const evaluationFor = async id => (await client.query("select verdict,unmatchable_reason,proposal_count,payload from reconciliation_evaluations where target_id=$1 and matcher_family='supplier_bill'", [id])).rows[0];
    let laterDecisions = 0;
    let afterDecide = null;
    __jevReconciliation.decide = async args => {
      laterDecisions++;
      const mapped = await readJevCase(args);
      const bank = mapped.candidates.find(b => b.id === `bank-${args.documentId}`);
      const decided = { document: mapped.sourceDocument, candidates: mapped.candidates, evidence_packet_sha256: mapped.prepared.packet_sha256,
        decision: { terminal: 'resolve', probability: 0.9, refusals: [], plan: { allocations: [{ transaction_id: bank.id, amount_minor: Math.round(Number(bank.money_out) * 100), currency: 'EUR' }], retained_balance_minor: 0, requests: [] } },
        model: 'fixture-returned-model', usage: { input_tokens: 1, output_tokens: 1 } };
      if (afterDecide) await afterDecide(args);
      return decided;
    };
    for (const [id, amount] of [['held-rent', 1500], ['refused-bill', 200], ['raced-bill', 300]]) {
      await client.query("insert into documents(id,firm_id,client_id,filename,document_type,parse_status,document_date,total_amount,currency,payment_status) values($1,'jev-firm','jev-company',$1,'supplier_bill','completed','2026-09-01',$2,'EUR','unpaid')", [id, amount]);
      await client.query("insert into transactions(id,firm_id,client_id,transaction_date,description,money_in,money_out,currency,status,payload) values($1,'jev-firm','jev-company','2026-09-02',$1,0,$2,'EUR','needs_review','{}')", [`bank-${id}`, amount]);
    }
    const heldRun = await runSupplierBillReconciliationLlmForDocument({ client, firmId: 'jev-firm', clientId: 'jev-company', documentId: 'held-rent' });
    assert.equal(heldRun.jev_reason, 'jev_match_held_for_authority', JSON.stringify(heldRun));
    const heldMatches = (await client.query("select status,payload from reconciliation_matches where matched_object_id='held-rent'")).rows;
    assert.equal(heldMatches.length, 1);
    assert.equal(heldMatches[0].status, 'suggested');
    assert.ok(heldMatches[0].payload.authorization.reasons.includes('above_materiality_ceiling'));
    const heldVerdict = await evaluationFor('held-rent');
    assert.equal(heldVerdict.verdict, 'proposed', 'a persisted held proposal is not a no_match');
    assert.equal(heldVerdict.proposal_count, 1);
    assert.equal(heldVerdict.unmatchable_reason, null);
    assert.equal(heldVerdict.payload.next_action, null, 'no retry_writer for a correct hold');
    assert.equal(heldVerdict.payload.failure_class, null);
    assert.equal(heldVerdict.payload.execution, 'held_for_authority');
    assert.equal(heldVerdict.payload.execution_reason, 'jev_match_held_for_authority');
    assert.equal(heldVerdict.payload.writer_receipt.status, 'suggested');
    await backdate('held-rent');
    assert.deepEqual((await sweep()).filter(row => row.document_id === 'held-rent'), []);
    assert.equal(laterDecisions, 1, 'the recovery sweep makes no further Jev call for a held match');
    // Rows written before this fix carry retry_writer. They wake once, re-record
    // as held on the same suggested row, and post nothing.
    await client.query(`update reconciliation_evaluations set verdict='no_match',unmatchable_reason='jev_writer_did_not_auto_reconcile',proposal_count=0,
      payload=payload||'{"next_action":"retry_writer","failure_class":"writer_refusal","execution":"not_applied","execution_reason":"jev_writer_did_not_auto_reconcile"}'::jsonb
      where target_id='held-rent' and matcher_family='supplier_bill'`);
    await backdate('held-rent');
    const legacyWake = (await sweep()).filter(row => row.document_id === 'held-rent');
    assert.deepEqual(legacyWake.map(row => row.outcome), ['recovered'], JSON.stringify(legacyWake));
    assert.equal(laterDecisions, 2);
    assert.equal((await evaluationFor('held-rent')).payload.execution, 'held_for_authority');
    assert.equal((await evaluationFor('held-rent')).payload.attempt_count, 2);
    assert.deepEqual((await client.query("select status from reconciliation_matches where matched_object_id='held-rent'")).rows, [{ status: 'suggested' }]);
    assert.equal((await client.query("select count(*)::int n from ledger_journals where source_id='bank-held-rent'")).rows[0].n, 0);
    await backdate('held-rent');
    await sweep();
    assert.equal(laterDecisions, 2, 'the re-recorded hold rests');
    // Neighbour: a writer that persisted nothing is still a writer refusal and
    // is retried; the retry settles below the ceiling.
    const normalWriter = __jevReconciliation.write;
    __jevReconciliation.write = async () => {};
    try { await runSupplierBillReconciliationLlmForDocument({ client, firmId: 'jev-firm', clientId: 'jev-company', documentId: 'refused-bill' }); }
    finally { __jevReconciliation.write = normalWriter; }
    const refused = await evaluationFor('refused-bill');
    assert.equal(refused.verdict, 'no_match');
    assert.equal(refused.payload.next_action, 'retry_writer');
    assert.equal(refused.payload.failure_class, 'writer_refusal');
    assert.equal(refused.payload.execution, 'not_applied');
    // Neighbour: evidence that changed before the write is reconsidered.
    afterDecide = args => args.documentId === 'raced-bill' && client.query("update transactions set description='Changed while deciding' where id='bank-raced-bill'");
    await runSupplierBillReconciliationLlmForDocument({ client, firmId: 'jev-firm', clientId: 'jev-company', documentId: 'raced-bill' });
    afterDecide = null;
    assert.equal((await evaluationFor('raced-bill')).payload.next_action, 'reconsider_current_evidence');
    const decisionsBeforeRetry = laterDecisions;
    await backdate('refused-bill'); await backdate('raced-bill');
    const retried = await sweep();
    assert.deepEqual(retried.map(row => [row.document_id, row.outcome]).sort(), [['raced-bill', 'recovered'], ['refused-bill', 'recovered']]);
    assert.equal(laterDecisions - decisionsBeforeRetry, 2, 'genuine refusals and races are still retried');
    assert.deepEqual((await client.query("select matched_object_id,status from reconciliation_matches where matched_object_id in ('refused-bill','raced-bill') order by 1")).rows,
      [{ matched_object_id: 'raced-bill', status: 'auto_matched' }, { matched_object_id: 'refused-bill', status: 'auto_matched' }]);
    // HELMIKUU S5: three multi-member plans keep today's retry. Each held first
    // write leaves one suggested row and the other members unwritten, and the
    // owner's confirmation of that row does not write them
    // (cloudProducerPgLifecycle proveJevHeldPlanGaps). A held verdict would
    // strand them, so the evaluation stays retry_writer and the recovery sweep
    // pays up to the attempt bound to reach the same hold. This pins that gap.
    for (const [key, value] of [['PAYOUT_MATCHER_ENABLED', '1'], ['SALES_INVOICE_MATCHER_ENABLED', '1']]) {
      const prior = process.env[key]; process.env[key] = value;
      t.after(() => { if (prior === undefined) delete process.env[key]; else process.env[key] = prior; });
    }
    await client.query(`insert into documents(id,firm_id,client_id,filename,document_type,parse_status,document_date,total_amount,currency,parse_summary)
      values('held-payout','jev-firm','jev-company','held-payout.pdf','payout_statement','completed','2026-09-01',4000,'EUR','{}');
      insert into document_lines(id,firm_id,client_id,document_id,line_no,description,amount,payload)
      values('held-payout-row-1','jev-firm','jev-company','held-payout',1,'Settlement 1',1500,'{"raw_extraction":{"settlement_row":{"gross":1510,"fees":10,"net":1500}}}'),
      ('held-payout-row-2','jev-firm','jev-company','held-payout',2,'Settlement 2',2500,'{"raw_extraction":{"settlement_row":{"gross":2520,"fees":20,"net":2500}}}');
      insert into transactions(id,firm_id,client_id,transaction_date,description,money_in,money_out,currency,status,payload)
      values('held-payout-bank-1','jev-firm','jev-company','2026-09-02','Processor settlement 1',1500,0,'EUR','needs_review','{}'),
      ('held-payout-bank-2','jev-firm','jev-company','2026-09-03','Processor settlement 2',2500,0,'EUR','needs_review','{}');
      insert into documents(id,firm_id,client_id,filename,document_type,parse_status,document_date,total_amount,tax_amount,currency,parse_summary)
      values('held-purchase','jev-firm','jev-company','held-purchase.pdf','receipt','completed','2026-09-01',1990,404.26,'EUR','{"line_amounts_include_tax":true}');
      insert into document_lines(id,firm_id,client_id,document_id,line_no,description,amount,tax_rate,payload)
      values('held-purchase-line','jev-firm','jev-company','held-purchase',1,'Equipment',1990,0.255,'{}');
      insert into transactions(id,firm_id,client_id,transaction_date,description,money_in,money_out,currency,status,payload)
      values('held-group-a','jev-firm','jev-company','2026-09-01','Equipment shop',0,1990,'EUR','needs_review','{}'),
      ('held-group-b','jev-firm','jev-company','2026-09-01','Equipment shop',0,1990,'EUR','needs_review','{}'),
      ('held-group-refund','jev-firm','jev-company','2026-09-03','Equipment shop refund',1990,0,'EUR','needs_review','{}');`);
    for (const d of [{ id: 'held-original', ref: 'INV-7002', date: '2026-08-01', total: 1204.80, tax: 244.80, summary: { line_amounts_include_tax: false }, lines: [['held-original-line', 'Service', 960, 0.255]] },
      { id: 'held-reminder', ref: 'REM-7002', date: '2026-08-20', total: 1224.80, tax: null, summary: { line_amounts_include_tax: true, references: [{ type: 'invoice_number', value: 'INV-7002' }] },
        lines: [['held-reminder-principal', 'Original invoice', 1204.80, 0.255], ['held-reminder-charge', 'Reminder charge', 20, 0]] }]) {
      await client.query(`insert into documents(id,firm_id,client_id,filename,document_type,parse_status,customer_name,reference_number,document_date,currency,total_amount,tax_amount,parse_summary,payment_status)
        values($1,'jev-firm','jev-company',$1,'sales_invoice','completed','Synthetic customer Oy',$2,$3,'EUR',$4,$5,$6,'unpaid')`, [d.id, d.ref, d.date, d.total, d.tax, d.summary]);
      for (const [i, [id, description, amount, rate]] of d.lines.entries()) await client.query(`insert into document_lines(id,firm_id,client_id,document_id,line_no,description,amount,payload)
        values($1,'jev-firm','jev-company',$2,$3,$4,$5,$6)`, [id, d.id, i + 1, description, amount, { raw_extraction: { tax_rate: rate } }]);
    }
    await client.query("insert into transactions(id,firm_id,client_id,transaction_date,description,money_in,money_out,currency,status,payload) values('held-reminder-bank','jev-firm','jev-company','2026-09-02','Invoice and reminder',1224.80,0,'EUR','needs_review','{}')");
    const plans = [
      { id: 'held-payout', family: 'payout_statement', run: runPayoutReconciliationLlmForDocument, first: 'held-payout-bank-1', rest: ['held-payout-bank-2'],
        choose: criteria => Object.keys(criteria).find(k => k.startsWith('candidate_')), shape: plan => plan.settlement_rows === true && plan.allocations.length === 2 },
      { id: 'held-purchase', family: 'receipt', run: runReceiptReconciliationLlmForDocument, first: 'held-group-a', rest: ['held-group-b', 'held-group-refund'],
        choose: criteria => Object.keys(criteria).find(k => k.startsWith('refund_group_')), shape: plan => plan.refund_group?.ok === true },
      { id: 'held-reminder', family: 'sales_invoice', run: runSalesInvoiceReconciliationLlmForDocument, first: 'held-reminder-bank', rest: [],
        choose: criteria => Object.keys(criteria).find(k => k.endsWith('_via_reminder')), shape: plan => plan.reminder_obligation?.invoice_document_id === 'held-original' }
    ];
    const heldDecisions = new Map();
    __jevReconciliation.decide = args => decideJevReconciliation({ ...args, provider: async request => {
      heldDecisions.set(args.documentId, (heldDecisions.get(args.documentId) || 0) + 1);
      const plan = plans.find(p => p.id === args.documentId);
      return { model: 'fixture-returned-model', answers: Object.fromEntries(Object.entries(request.questions).map(([key, question]) => [key, { choice: plan.choose(question.criteria), probability: 0.95 }])) };
    } });
    const planEvaluation = async plan => (await client.query("select verdict,unmatchable_reason,proposal_count,payload from reconciliation_evaluations where target_id=$1 and matcher_family=$2", [plan.id, plan.family])).rows[0];
    const planMatches = plan => client.query("select bank_transaction_id,status,payload from reconciliation_matches where matched_object_id=$1 or bank_transaction_id=any($2::text[]) order by id", [plan.id, [plan.first, ...plan.rest]]).then(r => r.rows);
    const assertPlanGap = async (plan, attempt) => {
      const evaluation = await planEvaluation(plan);
      assert.ok(plan.shape(evaluation.payload.selected_plan), `${plan.id}: the plan shape under test was selected`);
      assert.equal(evaluation.verdict, 'no_match', plan.id);
      assert.equal(evaluation.unmatchable_reason, 'jev_writer_did_not_auto_reconcile', plan.id);
      assert.equal(evaluation.payload.next_action, 'retry_writer', `${plan.id}: the multi-member hold keeps today's retry`);
      assert.equal(evaluation.payload.failure_class, 'writer_refusal', plan.id);
      assert.equal(evaluation.payload.execution, 'not_applied', plan.id);
      assert.equal(evaluation.payload.writer_receipt.status, 'suggested', plan.id);
      assert.equal(evaluation.payload.attempt_count, attempt, plan.id);
      const matches = await planMatches(plan);
      assert.deepEqual(matches.map(m => [m.bank_transaction_id, m.status]), [[plan.first, 'suggested']], `${plan.id}: one held row, the other members unwritten, no duplicate`);
      assert.ok(matches[0].payload.authorization.reasons.includes('above_materiality_ceiling'), plan.id);
      assert.equal(matches[0].payload.reminder_obligation, undefined, `${plan.id}: no reminder settlement is applied on a hold`);
      assert.equal((await client.query("select count(*)::int n from transactions where id=any($1::text[]) and payload ? 'jev_refund_group'", [[plan.first, ...plan.rest]])).rows[0].n, 0, `${plan.id}: no group marker on a hold`);
      assert.equal((await client.query("select count(*)::int n from ledger_journals where source_id=any($1::text[])", [[plan.first, ...plan.rest]])).rows[0].n, 0, plan.id);
    };
    for (const plan of plans) {
      const stats = await plan.run({ client, firmId: 'jev-firm', clientId: 'jev-company', documentId: plan.id });
      assert.equal(stats.jev_reason, 'jev_writer_did_not_auto_reconcile', `${plan.id}: ${JSON.stringify(stats)}`);
      await assertPlanGap(plan, 1);
    }
    assert.equal((await client.query("select payment_status from documents where id='held-original'")).rows[0].payment_status, 'unpaid', 'the original invoice is not settled through a held reminder');
    // The recovery sweep re-drives each hold to the attempt bound (3 decisions),
    // reaching the same single suggested row every time, then rests.
    const heldIds = plans.map(plan => plan.id);
    for (const attempt of [2, 3, 'bound']) {
      for (const id of heldIds) await backdate(id);
      const woke = (await sweep()).filter(row => heldIds.includes(row.document_id));
      assert.deepEqual(woke.map(row => [row.document_id, row.outcome]).sort(),
        attempt === 'bound' ? [] : heldIds.map(id => [id, 'unchanged']).sort(), JSON.stringify(woke));
      for (const plan of plans) await assertPlanGap(plan, attempt === 'bound' ? 3 : attempt);
    }
    assert.deepEqual(Object.fromEntries(heldDecisions), { 'held-payout': 3, 'held-purchase': 3, 'held-reminder': 3 }, 'each multi-member hold costs the full attempt bound in decisions');
    // HELMIKUU S7: with JEV_HELD_PLAN_COMPLETION the owner's confirmation of a
    // held match completes its plan, so a held multi-member plan records the
    // held verdict and buys no retry. Statement rows are all written up front;
    // each row above the ceiling rests on its own owner question.
    await client.query("insert into client_capability_config(id,firm_id,client_id,flag_key,stage,source) values('JEV_HELD_PLAN_COMPLETION','jev-firm','jev-company','JEV_HELD_PLAN_COMPLETION','auto','manual')");
    await client.query(`insert into documents(id,firm_id,client_id,filename,document_type,parse_status,document_date,total_amount,currency,parse_summary)
      values('owner-payout','jev-firm','jev-company','owner-payout.pdf','payout_statement','completed','2026-09-01',4800,'EUR','{}');
      insert into document_lines(id,firm_id,client_id,document_id,line_no,description,amount,payload)
      values('owner-payout-row-1','jev-firm','jev-company','owner-payout',1,'Settlement 1',1600,'{"raw_extraction":{"settlement_row":{"gross":1610,"fees":10,"net":1600}}}'),
      ('owner-payout-row-2','jev-firm','jev-company','owner-payout',2,'Settlement 2',600,'{"raw_extraction":{"settlement_row":{"gross":605,"fees":5,"net":600}}}'),
      ('owner-payout-row-3','jev-firm','jev-company','owner-payout',3,'Settlement 3',2600,'{"raw_extraction":{"settlement_row":{"gross":2620,"fees":20,"net":2600}}}');
      insert into transactions(id,firm_id,client_id,transaction_date,description,money_in,money_out,currency,status,payload)
      values('owner-payout-bank-1','jev-firm','jev-company','2026-09-02','Processor settlement 1',1600,0,'EUR','needs_review','{}'),
      ('owner-payout-bank-2','jev-firm','jev-company','2026-09-03','Processor settlement 2',600,0,'EUR','needs_review','{}'),
      ('owner-payout-bank-3','jev-firm','jev-company','2026-09-04','Processor settlement 3',2600,0,'EUR','needs_review','{}');
      insert into documents(id,firm_id,client_id,filename,document_type,parse_status,document_date,total_amount,tax_amount,currency,parse_summary)
      values('owner-purchase','jev-firm','jev-company','owner-purchase.pdf','receipt','completed','2026-09-01',1790,363.63,'EUR','{"line_amounts_include_tax":true}');
      insert into document_lines(id,firm_id,client_id,document_id,line_no,description,amount,tax_rate,payload)
      values('owner-purchase-line','jev-firm','jev-company','owner-purchase',1,'Tools',1790,0.255,'{}');
      insert into transactions(id,firm_id,client_id,transaction_date,description,money_in,money_out,currency,status,payload)
      values('owner-group-a','jev-firm','jev-company','2026-09-01','Tool shop',0,1790,'EUR','needs_review','{}'),
      ('owner-group-b','jev-firm','jev-company','2026-09-01','Tool shop',0,1790,'EUR','needs_review','{}'),
      ('owner-group-refund','jev-firm','jev-company','2026-09-03','Tool shop refund',1790,0,'EUR','needs_review','{}');`);
    for (const d of [{ id: 'owner-original', ref: 'INV-8002', date: '2026-08-01', total: 1506, tax: 306, summary: { line_amounts_include_tax: false }, lines: [['owner-original-line', 'Service', 1200, 0.255]] },
      { id: 'owner-reminder', ref: 'REM-8002', date: '2026-08-20', total: 1521, tax: null, summary: { line_amounts_include_tax: true, references: [{ type: 'invoice_number', value: 'INV-8002' }] },
        lines: [['owner-reminder-principal', 'Original invoice', 1506, 0.255], ['owner-reminder-charge', 'Reminder charge', 15, 0]] },
      { id: 'owner-original-2', ref: 'INV-8003', date: '2026-08-01', total: 1255, tax: 255, summary: { line_amounts_include_tax: false }, lines: [['owner-original-2-line', 'Service', 1000, 0.255]] },
      { id: 'owner-reminder-2', ref: 'REM-8003', date: '2026-08-20', total: 1265, tax: null, summary: { line_amounts_include_tax: true, references: [{ type: 'invoice_number', value: 'INV-8003' }] },
        lines: [['owner-reminder-2-principal', 'Original invoice', 1255, 0.255], ['owner-reminder-2-charge', 'Reminder charge', 10, 0]] }]) {
      await client.query(`insert into documents(id,firm_id,client_id,filename,document_type,parse_status,customer_name,reference_number,document_date,currency,total_amount,tax_amount,parse_summary,payment_status)
        values($1,'jev-firm','jev-company',$1,'sales_invoice','completed','Synthetic customer Oy',$2,$3,'EUR',$4,$5,$6,'unpaid')`, [d.id, d.ref, d.date, d.total, d.tax, d.summary]);
      for (const [i, [id, description, amount, rate]] of d.lines.entries()) await client.query(`insert into document_lines(id,firm_id,client_id,document_id,line_no,description,amount,payload)
        values($1,'jev-firm','jev-company',$2,$3,$4,$5,$6)`, [id, d.id, i + 1, description, amount, { raw_extraction: { tax_rate: rate } }]);
    }
    for (const [id, amount] of [['owner-bill', 1300], ['owner-bill-raced', 1400]]) {
      await client.query("insert into documents(id,firm_id,client_id,filename,document_type,parse_status,document_date,total_amount,currency,payment_status) values($1,'jev-firm','jev-company',$1,'supplier_bill','completed','2026-09-01',$2,'EUR','unpaid')", [id, amount]);
      await client.query("insert into transactions(id,firm_id,client_id,transaction_date,description,money_in,money_out,currency,status,payload) values($1,'jev-firm','jev-company','2026-09-02',$1,0,$2,'EUR','needs_review','{}')", [`${id}-bank`, amount]);
    }
    await client.query("insert into transactions(id,firm_id,client_id,transaction_date,description,money_in,money_out,currency,status,payload) values('owner-reminder-bank','jev-firm','jev-company','2026-09-02','Invoice and reminder',1521,0,'EUR','needs_review','{}')");
    await client.query("insert into transactions(id,firm_id,client_id,transaction_date,description,money_in,money_out,currency,status,payload) values('owner-reminder-2-bank','jev-firm','jev-company','2026-09-02','Second invoice and reminder',1265,0,'EUR','needs_review','{}')");
    const ownerPlans = [
      { id: 'owner-payout', family: 'payout_statement', run: runPayoutReconciliationLlmForDocument, choose: criteria => Object.keys(criteria).find(k => k.startsWith('candidate_')) },
      { id: 'owner-purchase', family: 'receipt', run: runReceiptReconciliationLlmForDocument, choose: criteria => Object.keys(criteria).find(k => k.startsWith('refund_group_')) },
      { id: 'owner-reminder', family: 'sales_invoice', run: runSalesInvoiceReconciliationLlmForDocument, choose: criteria => Object.keys(criteria).find(k => k.endsWith('_via_reminder')) },
      { id: 'owner-reminder-2', family: 'sales_invoice', run: runSalesInvoiceReconciliationLlmForDocument, choose: criteria => Object.keys(criteria).find(k => k.endsWith('_via_reminder')) },
      { id: 'owner-bill', family: 'supplier_bill', run: runSupplierBillReconciliationLlmForDocument, choose: criteria => Object.keys(criteria).find(k => k.startsWith('candidate_')) },
      { id: 'owner-bill-raced', family: 'supplier_bill', run: runSupplierBillReconciliationLlmForDocument, choose: criteria => Object.keys(criteria).find(k => k.startsWith('candidate_')) }];
    const ownerDecisions = new Map();
    __jevReconciliation.decide = args => decideJevReconciliation({ ...args, provider: async request => {
      ownerDecisions.set(args.documentId, (ownerDecisions.get(args.documentId) || 0) + 1);
      const plan = ownerPlans.find(p => p.id === args.documentId);
      return { model: 'fixture-returned-model', answers: Object.fromEntries(Object.entries(request.questions).map(([key, question]) => [key, { choice: plan.choose(question.criteria), probability: 0.95 }])) };
    } });
    const matchStates = id => client.query("select bank_transaction_id,matched_line_id,status from reconciliation_matches where matched_object_id=$1 order by bank_transaction_id", [id]).then(r => r.rows.map(m => [m.bank_transaction_id, m.status]));
    const ownerEvaluation = async plan => (await client.query("select verdict,payload from reconciliation_evaluations where target_id=$1 and matcher_family=$2", [plan.id, plan.family])).rows[0];
    for (const plan of ownerPlans) {
      const stats = await plan.run({ client, firmId: 'jev-firm', clientId: 'jev-company', documentId: plan.id });
      assert.equal(stats.jev_reason, 'jev_match_held_for_authority', `${plan.id}: ${JSON.stringify(stats)}`);
      const evaluation = await ownerEvaluation(plan);
      assert.equal(evaluation.verdict, 'proposed', plan.id);
      assert.equal(evaluation.payload.next_action, null, `${plan.id}: a completable hold buys no retry`);
      assert.equal(evaluation.payload.execution, 'held_for_authority', plan.id);
    }
    assert.deepEqual(await matchStates('owner-payout'), [['owner-payout-bank-1', 'suggested'], ['owner-payout-bank-2', 'auto_matched'], ['owner-payout-bank-3', 'suggested']],
      'every row is written; a row under the ceiling settles, each row above it is held on its own');
    assert.deepEqual(await matchStates('owner-purchase'), [['owner-group-a', 'suggested']], 'the group waits for its first match');
    assert.deepEqual(await matchStates('owner-reminder'), [['owner-reminder-bank', 'suggested']]);
    for (const plan of ownerPlans) await backdate(plan.id);
    assert.deepEqual((await sweep()).filter(row => ownerPlans.some(plan => plan.id === row.document_id)), [], 'the recovery sweep buys nothing for a completable hold');
    assert.deepEqual(Object.fromEntries(ownerDecisions), Object.fromEntries(ownerPlans.map(plan => [plan.id, 1])));
    // The owner-reply consumer's call, once per confirmed bank line.
    const confirm = async (transactionId, documentId) => {
      await client.query('begin');
      try {
        const result = await completeOwnerConfirmedJevPlanWithClient({ client, firmId: 'jev-firm', clientId: 'jev-company', transactionId, documentId,
          actorId: 'fixture-owner', evidenceRequestId: `ask-${transactionId}`, configSnapshot: await readClientConfigSnapshot(client, { firmId: 'jev-firm', clientId: 'jev-company', strict: true }) });
        await client.query('commit'); return result;
      } catch (error) { await client.query('rollback'); throw error; }
    };
    // Statement rows: each confirmation settles its own row; the plan stays
    // held until the last row, then completes.
    assert.deepEqual(await confirm('owner-payout-bank-1', 'owner-payout'), { completed: false, held_rows: 1, match_id: (await client.query("select id from reconciliation_matches where bank_transaction_id='owner-payout-bank-1'")).rows[0].id });
    assert.equal((await ownerEvaluation(ownerPlans[0])).payload.execution, 'held_for_authority');
    assert.equal((await confirm('owner-payout-bank-3', 'owner-payout')).completed, true);
    assert.deepEqual(await matchStates('owner-payout'), [['owner-payout-bank-1', 'auto_matched'], ['owner-payout-bank-2', 'auto_matched'], ['owner-payout-bank-3', 'auto_matched']]);
    const payoutDone = await ownerEvaluation(ownerPlans[0]);
    assert.equal(payoutDone.payload.execution, 'existing_reconciliation_writer');
    assert.equal(payoutDone.payload.execution_reason, 'jev_owner_confirmed_held_match');
    const confirmedRow = (await client.query("select payload from reconciliation_matches where bank_transaction_id='owner-payout-bank-3'")).rows[0].payload;
    assert.ok(confirmedRow.authorization.reasons.includes('owner_confirmed_held_match'));
    assert.equal(confirmedRow.owner_confirmation.actor_id, 'fixture-owner');
    assert.equal(confirmedRow.owner_confirmation.evidence_request_id, 'ask-owner-payout-bank-3');
    // Refund group: the confirmation settles the first debit and the whole group.
    assert.equal((await confirm('owner-group-a', 'owner-purchase')).completed, true);
    assert.deepEqual(await matchStates('owner-purchase'), [['owner-group-a', 'auto_matched'], ['owner-group-b', 'auto_matched'], ['owner-group-refund', 'auto_matched']]);
    assert.equal((await client.query("select count(*)::int n from transactions where id like 'owner-group-%' and payload->'jev_refund_group'->>'status'='selected'")).rows[0].n, 3);
    // Reminder: the confirmation settles the reminder and the original invoice once.
    assert.equal((await confirm('owner-reminder-bank', 'owner-reminder')).completed, true);
    assert.equal((await client.query("select payload->'reminder_obligation'->>'status' s from reconciliation_matches where matched_object_id='owner-reminder'")).rows[0].s, 'applied');
    assert.equal((await client.query("select payment_status from documents where id='owner-original'")).rows[0].payment_status, 'paid');
    // A single held match settles too.
    assert.equal((await confirm('owner-bill-bank', 'owner-bill')).completed, true);
    assert.deepEqual(await matchStates('owner-bill'), [['owner-bill-bank', 'auto_matched']]);
    // Facts that changed after the hold are not confirmed: the match stays
    // held and Jev gets the current evidence back.
    await client.query("update transactions set money_out=1450 where id='owner-bill-raced-bank'");
    assert.deepEqual(await confirm('owner-bill-raced-bank', 'owner-bill-raced'), { completed: false, reason: 'jev_evidence_changed_before_write' });
    assert.deepEqual(await matchStates('owner-bill-raced'), [['owner-bill-raced-bank', 'suggested']]);
    assert.equal((await client.query("select payload->>'next_action' n from reconciliation_evaluations where target_id='owner-bill-raced' and matcher_family='supplier_bill'")).rows[0].n, 'reconsider_current_evidence');
    // A writer refusal inside the completion (the original invoice's customer
    // changed, so the reminder relationship no longer holds) rolls back only
    // the completion: the reply's own transaction commits, the match stays
    // held, the refusal is receipted and Jev gets the current evidence back.
    await client.query("update documents set customer_name='Another customer Oy' where id='owner-original-2'");
    await client.query('begin');
    await client.query("update transactions set payload=payload||'{\"reply_probe\":true}'::jsonb where id='owner-reminder-2-bank'");
    const ownerRefused = await completeOwnerConfirmedJevPlanWithClient({ client, firmId: 'jev-firm', clientId: 'jev-company', transactionId: 'owner-reminder-2-bank', documentId: 'owner-reminder-2',
      actorId: 'fixture-owner', evidenceRequestId: 'ask-owner-reminder-2-bank', configSnapshot: await readClientConfigSnapshot(client, { firmId: 'jev-firm', clientId: 'jev-company', strict: true }) });
    await client.query('commit');
    assert.deepEqual(ownerRefused, { completed: false, reason: 'jev_evidence_changed_before_write', refusal: 'REMINDER_OBLIGATION_REFUSED' });
    assert.equal((await client.query("select payload->>'reply_probe' p from transactions where id='owner-reminder-2-bank'")).rows[0].p, 'true', 'the enclosing reply transaction still commits');
    assert.deepEqual(await matchStates('owner-reminder-2'), [['owner-reminder-2-bank', 'suggested']]);
    assert.equal((await client.query("select payment_status from documents where id='owner-original-2'")).rows[0].payment_status, 'unpaid');
    assert.equal((await client.query("select payload->>'next_action' n from reconciliation_evaluations where target_id='owner-reminder-2' and matcher_family='sales_invoice'")).rows[0].n, 'reconsider_current_evidence');
    assert.equal((await client.query("select metadata->>'code' c from audit_events where action='reconciliation_match.owner_confirmation_refused'")).rows[0].c, 'REMINDER_OBLIGATION_REFUSED');
    // A repeated confirmation, or one for a line that is not held, does nothing.
    const matchesBefore = (await client.query("select id,status,match_amount from reconciliation_matches where matched_object_id like 'owner-%' order by id")).rows;
    assert.equal((await confirm('owner-group-a', 'owner-purchase')).skipped, 'no_held_match');
    assert.equal((await confirm('owner-payout-bank-2', 'owner-payout')).skipped, 'no_held_match');
    assert.deepEqual((await client.query("select id,status,match_amount from reconciliation_matches where matched_object_id like 'owner-%' order by id")).rows, matchesBefore, 'a retry duplicates nothing');
    assert.equal((await client.query("select count(*)::int n from reconciliation_authority_grants")).rows[0].n, 0, 'an owner confirmation mints no standing grant');
    await client.query("delete from client_capability_config where flag_key='JEV_HELD_PLAN_COMPLETION'");
    __jevReconciliation.decide = familyDecide;
    await client.query('begin');
    await client.query("insert into documents(id,firm_id,client_id,filename,document_type,parse_status,document_date,total_amount,currency,payment_status) values('nested','jev-firm','jev-company','nested.pdf','supplier_bill','completed','2026-09-01',100,'EUR','unpaid')");
    await client.query("insert into transactions(id,firm_id,client_id,transaction_date,description,money_in,money_out,currency,status,payload) values('bank-nested','jev-firm','jev-company','2026-09-02','nested',0,100,'EUR','needs_review','{}')");
    const nested = await runSupplierBillReconciliationLlmForDocument({client,firmId:'jev-firm',clientId:'jev-company',documentId:'nested'});
    assert.equal(nested.jev_reason, null, JSON.stringify(nested));
    await client.query('rollback');
    assert.equal((await client.query("select id from documents where id='nested'")).rows.length, 0, 'Jev never commits a caller-owned parse transaction');
    await client.query(`insert into documents(id,firm_id,client_id,filename,document_type,parse_status,document_date,total_amount,tax_amount,currency,parse_summary)
      values('purchase-group','jev-firm','jev-company','purchase.pdf','receipt','completed','2026-09-01',19.90,4.04,'EUR','{"line_amounts_include_tax":true}');
      insert into document_lines(id,firm_id,client_id,document_id,line_no,description,amount,tax_rate,payload)
      values('group-source','jev-firm','jev-company','purchase-group',1,'Supplies',19.90,0.255,'{}');
      insert into transactions(id,firm_id,client_id,transaction_date,description,money_in,money_out,currency,status,payload)
      values('group-a','jev-firm','jev-company','2026-09-01','Shop',0,19.90,'EUR','needs_review','{}'),
      ('group-b','jev-firm','jev-company','2026-09-01','Shop',0,19.90,'EUR','needs_review','{}'),
      ('group-refund','jev-firm','jev-company','2026-09-03','Shop refund',19.90,0,'EUR','needs_review','{}');`);
    __jevReconciliation.decide=args=>decideJevReconciliation({...args,provider:async request=>{
      assert.ok(request.questions.plan.criteria.refund_group_1,'Jev can choose the whole group');
      return {answers:{plan:{choice:'refund_group_1',probability:0.39,probabilities:{refund_group_1:0.39}}},model:'fixture-model'};
    }});
    const groupResult=await runReceiptReconciliationForDocument({client,firmId:'jev-firm',clientId:'jev-company',documentId:'purchase-group'});
    assert.equal(groupResult.jev_reason,null,JSON.stringify(groupResult));
    const groupMatches=(await client.query("select status,match_amount from reconciliation_matches where matched_object_id='purchase-group'")).rows;
    assert.equal(groupMatches.length,3);
    assert.ok(groupMatches.every(m=>m.status==='auto_matched'));
    assert.equal(groupMatches.reduce((sum,m)=>sum+Number(m.match_amount),0),19.90,'one purchase consumes source once');
    const groupRows=(await client.query("select payload from transactions where id like 'group-%'")).rows;
    assert.ok(groupRows.every(t=>t.payload.jev_refund_group?.allocation_basis==='chronological_convention_without_instrument_identity'));
    await client.query(`insert into documents(id,firm_id,client_id,filename,document_type,parse_status,document_date,total_amount,currency,parse_summary)
      values('processor','jev-firm','jev-company','settlements.pdf','payout_statement','completed','2026-09-01',293,'EUR','{}');
      insert into document_lines(id,firm_id,client_id,document_id,line_no,description,amount,payload)
      values('processor-row-1','jev-firm','jev-company','processor',1,'Settlement 1',97,'{"raw_extraction":{"settlement_row":{"gross":100,"fees":3,"net":97}}}'),
      ('processor-row-2','jev-firm','jev-company','processor',2,'Settlement 2',196,'{"raw_extraction":{"settlement_row":{"gross":200,"fees":4,"net":196}}}');
      insert into transactions(id,firm_id,client_id,transaction_date,description,money_in,money_out,currency,status,payload)
      values('processor-bank-1','jev-firm','jev-company','2026-09-02','Processor settlement 1',97,0,'EUR','needs_review','{}'),
      ('processor-bank-2','jev-firm','jev-company','2026-09-03','Processor settlement 2',196,0,'EUR','needs_review','{}');`);
    __jevReconciliation.decide=args=>decideJevReconciliation({...args,provider:async request=>({model:'fixture-model',answers:Object.fromEntries(Object.entries(request.questions).map(([key,q])=>[key,{choice:Object.keys(q.criteria).find(k=>k.startsWith('candidate_')),probability:0.38}]))})});
    const normalWrite=__jevReconciliation.write;
    let memberWrites=0;
    __jevReconciliation.write=async args=>{
      if(++memberWrites===2) throw Object.assign(new Error('Second row writer failed'),{code:'SECOND_ROW_FAILURE'});
      return normalWrite(args);
    };
    try {
      const failedGroup=await runPayoutReconciliationLlmForDocument({client,firmId:'jev-firm',clientId:'jev-company',documentId:'processor'});
      assert.equal(failedGroup.jev_reason,'jev_runtime_failed');
      assert.equal((await client.query("select id from reconciliation_matches where matched_object_id='processor'")).rows.length,0);
      const rollbackReceipt=(await client.query("select payload from reconciliation_evaluations where target_id='processor' and matcher_family='payout_statement'")).rows[0].payload;
      assert.equal(rollbackReceipt.execution,'not_applied');
      assert.equal(rollbackReceipt.writer_receipt,null);
      assert.equal(rollbackReceipt.next_action,'retry_writer');
    } finally { __jevReconciliation.write=normalWrite; }
    const processor=await runPayoutReconciliationLlmForDocument({client,firmId:'jev-firm',clientId:'jev-company',documentId:'processor'});
    assert.equal(processor.jev_reason,null,JSON.stringify(processor));
    const processorMatches=(await client.query("select status,match_amount,matched_line_id from reconciliation_matches where matched_object_id='processor'")).rows;
    assert.equal(processorMatches.length,2);
    assert.ok(processorMatches.every(m=>m.status==='auto_matched' && m.matched_line_id));
    assert.equal(processorMatches.reduce((sum,m)=>sum+Number(m.match_amount),0),293);
    await client.query("insert into documents(id,firm_id,client_id,filename,document_type,parse_status,document_date,total_amount,currency,payment_status) values('declined','jev-firm','jev-company','declined.pdf','receipt','completed','2026-09-01',200,'EUR','paid')");
    await client.query("insert into transactions(id,firm_id,client_id,transaction_date,description,money_in,money_out,currency,status,payload) values('bank-declined','jev-firm','jev-company','2026-09-02','declined',0,200,'EUR','needs_review','{}')");
    __jevReconciliation.decide = async args => {
      const mapped=await readJevCase({...args,evidenceOnly:true});
      return {document:mapped.sourceDocument,candidates:mapped.candidates,consumed_evidence:mapped.caseEvidence,
        evidence_packet_sha256:mapped.caseEvidence.packet_sha256,
        decision:{terminal:'no_settlement',probability:0.6,plan:{terminal:'no_settlement'},refusals:[]},model:'fixture-returned-model'};
    };
    const cleanNegative=__jevReconciliation.decide;
    __jevReconciliation.decide=async args=>{
      const result=await cleanNegative(args);
      await client.query("update transactions set description='Late competing payment' where id='bank-declined'");
      return result;
    };
    const staleNegative=await runReceiptReconciliationForDocument({client,firmId:'jev-firm',clientId:'jev-company',documentId:'declined'});
    assert.equal(staleNegative.jev_reason,'jev_evidence_changed_before_write');
    assert.equal((await client.query("select id from reconciliation_evaluations where target_id='declined' and matcher_family='document_no_line_disposition'")).rows.length,0);
    __jevReconciliation.decide=cleanNegative;
    const declined = await runReceiptReconciliationForDocument({ client, firmId: 'jev-firm', clientId: 'jev-company', documentId: 'declined' });
    assert.equal(declined.decision_engine, 'jev');
    assert.equal(declined.jev_reason, 'jev_no_settlement');
    const { rows: declinedMatches } = await client.query("select id from reconciliation_matches where matched_object_id='declined'");
    assert.deepEqual(declinedMatches, [], 'the enabled legacy exact-match backstop must not replace Jev');
    assert.equal((await client.query("select id from reconciliation_evaluations where target_id='declined' and matcher_family='document_no_line_disposition' and verdict <> 'superseded'")).rows.length,0,
      'a true negative bank match does not own settlement disposition for a receipt');
    await client.query("insert into documents(id,firm_id,client_id,filename,document_type,parse_status,document_date,total_amount,currency,payment_status) values('unpaid','jev-firm','jev-company','unpaid.pdf','supplier_bill','completed','2026-09-01',220,'EUR','unpaid')");
    const unpaid = await runSupplierBillReconciliationLlmForDocument({client,firmId:'jev-firm',clientId:'jev-company',documentId:'unpaid'});
    assert.equal(unpaid.jev_reason,'jev_no_settlement');
    assert.equal((await client.query("select id from reconciliation_evaluations where target_id='unpaid' and matcher_family='document_no_line_disposition' and verdict <> 'superseded'")).rows.length,1,
      'an invoice obligation retains the existing scoped-negative holder');
    // A shipped receipt may already have the misplaced negative holder. The
    // normal disposition sweep must heal it without another upload or matcher.
    await __jevReconciliation.record({client,firmId:'jev-firm',clientId:'jev-company',targetId:'declined',
      matcherFamily:'document_no_line_disposition',verdict:'no_match',unmatchableReason:'jev_no_settlement',model:'fixture',
      payload:{decision_engine:'jev',disposition:'no_settlement',accounting_complete:false}});
    for(const [key,value] of Object.entries({DONNA_DESKTOP_BLOB_DIR:'/tmp/fixture-jev-desktop',TYPESAFE_MODEL:'fixture-first-line',TYPESAFE_API_KEY:'fixture-key'})) {
      const prior=process.env[key];process.env[key]=value;
      t.after(()=>{if(prior===undefined)delete process.env[key];else process.env[key]=prior;});
    }
    await client.query("update client_capability_config set source='default' where flag_key='JEV_RECONCILIATION'");
    await client.query(`update documents set parse_summary='{"payment_method":"cash","purpose":"business premises"}' where id='declined'`);
    let dispositionCalls=0;
    const dispositionArgs={client,firmId:'jev-firm',clientId:'jev-company',documentIds:['declined','unpaid'],mode:'act',jevEnabled:true,fetchImpl:async(url,options)=>{
      dispositionCalls++;
      assert.match(url,/typesafe/);
      const request=JSON.parse(options.body),criteria=request.questions.disposition.criteria;
      assert.ok(criteria.ask_cash_funding);
      assert.equal(request.state.observation.extracted_summary.payment_method,'cash','source payment evidence reaches the production route');
      return new Response(JSON.stringify({model:'fixture-first-line',usage:{input_tokens:10,output_tokens:5},answers:{disposition:{type:'choice',choice:'ask_cash_funding',confidence:1,
        probabilities:Object.fromEntries(Object.keys(criteria).map(key=>[key,key==='ask_cash_funding'?1:0]))}}}),{status:200});
    }};
    const disposed=await runDocumentDispositionForClient(dispositionArgs);
    assert.equal(disposed.evaluated,1,JSON.stringify(disposed));
    assert.equal(disposed.owner_asks_minted,1,JSON.stringify(disposed));
    const cashAsks=(await client.query("select status,evidence_type,request_payload from client_evidence_requests where request_payload->>'document_id' in ('declined','unpaid')")).rows;
    assert.equal(cashAsks.length,1);assert.equal(cashAsks[0].status,'draft');assert.equal(cashAsks[0].evidence_type,'payment_method');
    assert.equal(cashAsks[0].request_payload.document_id,'declined');
    const disposedDocument=(await client.query("select * from documents where id='declined'")).rows[0];
    assert.equal(convergenceForUnmatchedDocument(disposedDocument,{hasOpenOwnerAsk:true}).state,'on_owner');
    const repeated=await runDocumentDispositionForClient(dispositionArgs);
    assert.equal(repeated.evaluated,0);assert.equal(dispositionCalls,1,'the existing sweep does not duplicate the question or reasoning');
    __jevReconciliation.decide=async()=>{throw new Error('fixture runtime error before a new judgment');};
    await runSupplierBillReconciliationLlmForDocument({client,firmId:'jev-firm',clientId:'jev-company',documentId:'unpaid'});
    assert.equal((await client.query("select id from reconciliation_evaluations where target_id='unpaid' and matcher_family='document_no_line_disposition' and verdict <> 'superseded'")).rows.length,1,
      'a runtime failure with no new result preserves the prior obligation assessment');
    await client.query("insert into documents(id,firm_id,client_id,filename,document_type,parse_status,document_date,total_amount,currency,payment_status) values('handoff','jev-firm','jev-company','handoff.pdf','supplier_bill','completed','2026-09-01',400,'EUR','unpaid')");
    await client.query("insert into transactions(id,firm_id,client_id,transaction_date,description,money_in,money_out,currency,status,payload) values('bank-handoff','jev-firm','jev-company','2026-09-02','handoff',0,400,'EUR','needs_review','{}')");
    __jevReconciliation.decide = async () => ({ document: { document_type: 'supplier_bill' }, candidates: [], evidence_packet_sha256: 'fixture-hash', decision: { terminal: 'abstain', selected: 'needs_more_work', probability: 0.51, plan: { terminal: 'abstain' }, refusals: [] }, model: 'fixture-jev-handoff' });
    let strongCalls = 0;
    await assert.rejects(runSupplierBillReconciliationLlmForDocument({client,firmId:'jev-firm',clientId:'jev-company',documentId:'handoff',apiKeyOverride:'fixture-key',fetchImpl:async () => {
      strongCalls++;
      const recorded = await client.query("select model,payload from reconciliation_evaluations where target_id='handoff' and matcher_family='jev_first_decision'");
      assert.equal(recorded.rows[0].model, 'fixture-jev-handoff', 'first decision is durably receipted before strong dispatch');
      assert.equal(recorded.rows[0].payload.handoff.probability, 0.51);
      return new Response(JSON.stringify({error:{message:'fixture unauthorized'}}),{status:401});
    }}), error => error.providerFailure === true);
    assert.equal(strongCalls, 1, 'only an explicit Jev handoff reaches the reasoning provider');
    await client.query("insert into documents(id,firm_id,client_id,filename,document_type,parse_status,document_date,total_amount,currency,payment_status) values('provider-failed','jev-firm','jev-company','provider-failed.pdf','receipt','completed','2026-09-01',300,'EUR','paid')");
    __jevReconciliation.decide = async () => { throw providerKeyMissing('typesafe', { keyName: 'TYPESAFE_API_KEY' }); };
    const failed = await runReceiptReconciliationForDocument({ client, firmId: 'jev-firm', clientId: 'jev-company', documentId: 'provider-failed' });
    assert.equal(failed.provider_failure.code, 'PROVIDER_KEY_MISSING');
    assert.equal(failed.provider_failure.provider, 'typesafe');
    const { rows: failureDocs } = await client.query("select payload->'reconciliation_provider_failure' as receipt from documents where id='provider-failed'");
    assert.equal(failureDocs[0].receipt.owner, 'operator');
    const { rows: failureVerdicts } = await client.query("select id from reconciliation_evaluations where target_id='provider-failed'");
    assert.deepEqual(failureVerdicts, [], 'a provider failure is not a semantic no_match');
    const { rows: failureMatches } = await client.query("select id from reconciliation_matches where matched_object_id='provider-failed'");
    assert.deepEqual(failureMatches, [], 'a provider failure cannot fall back to the legacy matcher');
  } finally { client.release(); }
  assert.equal(decisions, 8);
});
