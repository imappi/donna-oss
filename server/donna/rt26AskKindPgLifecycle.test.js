// RT-26 (2026-09-09, Kari's word) — the ask kind follows what the lane knows.
// Real-PG proof of the three parts, driven through the REAL writers:
//   (1) the disposition sweep: a statutory payment settles with no ask; a
//       NAMED line the lane cannot evidence is chase_receipt with NO ask from
//       the lane — the coder codes it and the coding auto-post gate asks for
//       its DOCUMENT with the coding attached (supporting_document, through the
//       real ask writer); an unnamed line still asks the owner's fact question
//       (business_purpose);
//   (3) a settling document match resolves the document ask; RT-16's release
//       returns the coded line to the coder on the next tick (asked →
//       proposed, receipted) and the gate posts it on the matched evidence;
//   (2) a statutory descriptor alone cannot post; a later matched notice
//       supplies the liability evidence through the existing match lifecycle.
// Skipped without DONNA_PG_TEST_URL (the CI runner sets it).

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

import { runBankLineDispositionForClient } from './bankLineDispositionLlm.js';
import { cascadeAutoMatch } from './reconciliationTriage.js';
import { AUTO_EXPLAIN_RETRACTS_FLAG_KEY, retractAsksSettledByAutoExplain } from './reconciliationTwinAging.js';
import { readClientConfigSnapshot, setClientFlagStage } from './clientConfig.js';
import { __loadDirectUncodedNeedsReviewPool } from './db/coding.js';
import { __releaseSettledWaitingViaDb } from './codingConvergence.js';
import { runCodingAutoPostForTransaction } from './codingAutoPost.js';
import { withFirmDbClient, __endFirmDbPoolForTests } from './firmDb.js';

const PG_URL = process.env.DONNA_PG_TEST_URL || '';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const FIRM = 'firm-rt26';
const CLIENT = 'client-rt26';

const bootScratchDatabase = async () => {
  const dbName = `donna_rt26_${Date.now().toString(36)}_${process.pid}`;
  const admin = new pg.Client({ connectionString: PG_URL });
  await admin.connect();
  await admin.query(`create database "${dbName}"`);
  const scratchUrl = new URL(PG_URL);
  scratchUrl.pathname = `/${dbName}`;
  const seed = new pg.Client({ connectionString: scratchUrl.toString() });
  await seed.connect();
  const supabaseOnly = new Set(['010_evidence_object_storage.sql', '032_lock_down_public_rls.sql', '060_procountor_api_key.sql']);
  const files = (await readdir(path.join(ROOT, 'db', 'migrations')))
    .filter((file) => file.endsWith('.sql') && !supabaseOnly.has(file))
    .sort();
  for (const file of files) await seed.query(await readFile(path.join(ROOT, 'db', 'migrations', file), 'utf8'));
  await seed.query(`insert into firms (id, name, slug, jurisdiction, default_currency) values ($1, 'RT-26 Firm', 'rt26-firm', 'FI', 'EUR')`, [FIRM]);
  await seed.query(
    `insert into clients (id, firm_id, company_name, jurisdiction, entity_type, status)
     values ($1, $2, 'Kampaamo Kultalanka Oy', 'FI', 'fi-oy', 'active')`,
    [CLIENT, FIRM]
  );
  const stop = async () => {
    await seed.end().catch(() => {});
    await admin.query(`drop database if exists "${dbName}" with (force)`).catch(() => {});
    await admin.end().catch(() => {});
  };
  return { seed, scratchUrl: scratchUrl.toString(), stop };
};

const inTransaction = (fn) => withFirmDbClient(async (client) => {
  await client.query('begin');
  try {
    const out = await fn(client);
    await client.query('commit');
    return out;
  } catch (error) {
    await client.query('rollback').catch(() => {});
    throw error;
  }
});

const LINES = {
  'tx-vat': { description: 'VEROHALLINTO OMA-ALOITTEISET VEROT', amount: 1245 },
  'tx-salary': { description: 'SAARA KORHONEN PALKKA', amount: 1500 },
  'tx-unknown': { description: 'MOBILEPAY 1234567', amount: 300 }
};

// The strong model, stubbed per line: the verdicts the second run's lines would
// carry under the v2 prompt. `id=<tx>` is rendered in the user prompt.
const VERDICTS = {
  'tx-vat': { disposition: 'statutory_payment', line_identified: true, materiality: 'material', expense_kind: 'vat_settlement', confidence: 0.97, reasoning: 'A VAT remittance to the Finnish Tax Administration for Q4 2024, a routine statutory payment that needs no receipt.' },
  'tx-salary': { disposition: 'needs_human', line_identified: true, materiality: 'material', expense_kind: 'payroll', confidence: 0.9, reasoning: 'A salary payment to an employee that should be reconciled against payroll records.' },
  'tx-unknown': { disposition: 'needs_human', line_identified: false, materiality: 'material', expense_kind: 'unknown', confidence: 0.3, reasoning: 'An unrecognized counterparty with no prior charges.' }
};
const fetchStub = async (_url, init) => {
  const body = JSON.parse(init.body);
  const text = JSON.stringify(body.messages || '');
  const id = Object.keys(VERDICTS).find((k) => text.includes(`id=${k}`));
  return { ok: true, status: 200, json: async () => ({ content: [{ text: JSON.stringify(VERDICTS[id] || VERDICTS['tx-unknown']) }] }) };
};

const txRow = (seed, id) => seed.query(
  `select status, reconciliation_status, coding_state, payload, convergence_state, convergence_reason
     from transactions where firm_id = $1 and id = $2`, [FIRM, id]
).then((r) => r.rows[0]);
const asksFor = (seed, id) => seed.query(
  `select id, status, evidence_type, question, response_payload from client_evidence_requests
     where firm_id = $1 and transaction_id = $2 order by created_at`, [FIRM, id]
).then((r) => r.rows);

test(
  'real PG (RT-26): statutory filing ask survives disposition until its notice lands and the gate posts the evidenced liability',
  { skip: !PG_URL && 'DONNA_PG_TEST_URL not set' },
  async () => {
    const { seed, scratchUrl, stop } = await bootScratchDatabase();
    const prior = { DATABASE_URL: process.env.DATABASE_URL, DATABASE_POOL_MAX: process.env.DATABASE_POOL_MAX, BANK_LINE_DISPOSITION_MODE: process.env.BANK_LINE_DISPOSITION_MODE };
    process.env.DATABASE_URL = scratchUrl;
    process.env.DATABASE_POOL_MAX = '2';
    delete process.env.BANK_LINE_DISPOSITION_MODE;
    try {
      for (const [id, line] of Object.entries(LINES)) {
        await seed.query(
          `insert into transactions (id, firm_id, client_id, transaction_date, description, raw_description, money_out, money_in, currency, status, payload)
           values ($1, $2, $3, '2025-02-14', $4, $4, $5, 0, 'EUR', 'needs_review', '{}'::jsonb)`,
          [id, FIRM, CLIENT, line.description, line.amount]
        );
      }

      // ── (1) the disposition sweep, real writers (the default lane deps) ──
      const stats = await withFirmDbClient((client) => runBankLineDispositionForClient({
        client, firmId: FIRM, clientId: CLIENT, direction: 'money_out',
        enabledOverride: true, apiKeyOverride: 'sk-test', fetchImpl: fetchStub
      }));
      assert.equal(stats.evaluated, 3, JSON.stringify(stats));
      assert.equal(stats.stamp_failures, 0, JSON.stringify(stats));
      assert.equal(stats.statutory_payment, 1);
      assert.equal(stats.chase_receipt, 1, 'needs_human on a NAMED line became the document lane');
      assert.equal(stats.needs_human, 1, 'the unnamed line is still the owner\'s fact question');
      assert.equal(stats.owner_asks_minted, 1, 'only the unnamed line asked');

      const vat = await txRow(seed, 'tx-vat');
      assert.equal(vat.reconciliation_status, 'explained', 'a statutory payment settles');
      assert.equal(vat.payload.bank_line_disposition, 'statutory_payment');
      assert.equal(vat.payload.support_basis, 'bank_line');
      assert.equal(vat.status, 'needs_review', 'it still goes to the coder');
      assert.deepEqual(await asksFor(seed, 'tx-vat'), [], 'nobody is asked about a VAT remittance');
      assert.equal(vat.convergence_state, 'hanging', vat.convergence_reason);
      assert.equal(vat.convergence_reason,'explained_but_uncoded');

      const salaryBare = await txRow(seed, 'tx-salary');
      assert.deepEqual(await asksFor(seed, 'tx-salary'), [], 'the disposition lane asks nothing on a named line');
      assert.equal(salaryBare.status, 'needs_review', 'the coder gets it first');
      assert.equal(salaryBare.coding_state, null);
      assert.equal(salaryBare.convergence_state, 'hanging', salaryBare.convergence_reason);

      // The coder names the account and wants the payslip; the gate asks for the
      // DOCUMENT with the coding attached — through the real ask writer.
      await seed.query(
        `update transactions set payload = payload || $3::jsonb, coding_state = 'proposed' where firm_id = $1 and id = $2`,
        [FIRM, 'tx-salary', JSON.stringify({ ai_suggestion: { proposed_account: 'Salaries', confidence: 'high', evidence_required: true, model: 'test-coder', reasoning: 'A salary payment; the payslip evidences it.' } })]
      );
      const salaryGate = await runCodingAutoPostForTransaction({
        firmId: FIRM, clientId: CLIENT, transactionId: 'tx-salary', env: {},
        configSnapshot: { CODING_AUTO_POST: { stage: 'auto' } },
        postLedgerFn: async () => { throw new Error('must not post an unevidenced salary'); }
      });
      assert.equal(salaryGate.owner_asked, 1, JSON.stringify(salaryGate));
      const salary = await txRow(seed, 'tx-salary');
      const salaryAsks = await asksFor(seed, 'tx-salary');
      assert.equal(salaryAsks.length, 1);
      assert.equal(salaryAsks[0].evidence_type, 'supporting_document', 'the ask is for the DOCUMENT');
      assert.match(salaryAsks[0].question, /coded it as "Salaries"/);
      assert.match(salaryAsks[0].question, /need a supporting document/);
      assert.ok(!/what was it for/i.test(salaryAsks[0].question), 'never a purpose question on a named line');
      assert.equal(salary.status, 'needs_client');
      assert.equal(salary.coding_state, 'asked');
      assert.equal(salary.convergence_state, 'on_owner', salary.convergence_reason);

      const unknownAsks = await asksFor(seed, 'tx-unknown');
      assert.equal(unknownAsks.length, 1);
      assert.equal(unknownAsks[0].evidence_type, 'business_purpose', 'an unnamed line asks the fact question');
      assert.match(unknownAsks[0].question, /^We could not tell what the EUR 300\.00 paid/);
      assert.equal((await txRow(seed, 'tx-unknown')).convergence_state, 'on_owner');

      // A pre-existing medium-confidence coding can say no evidence needed
      // before disposition subsequently requires it. Consume that current
      // persisted chase verdict without needing to erase/re-run the coding.
      await seed.query(`insert into transactions(id,firm_id,client_id,transaction_date,description,money_in,money_out,currency,status,coding_state,payload)
        values('tx-cash-chase',$1,$2,'2025-02-03','Synthetic cash takings deposit',640,0,'EUR','needs_review','proposed',
          '{"bank_line_disposition":"chase_evidence","ai_suggestion":{"proposed_account":"Sales","confidence":"medium","evidence_required":false,"source":"openai_batch","reasoning":"Synthetic existing sales coding."}}')`,[FIRM,CLIENT]);
      const chaseGate = () => runCodingAutoPostForTransaction({firmId:FIRM,clientId:CLIENT,transactionId:'tx-cash-chase',env:{},
        configSnapshot:{CODING_AUTO_POST:{stage:'auto'}},postLedgerFn:async()=>{throw new Error('Unevidenced cash must not post');}});
      const chased = await chaseGate();
      assert.equal(chased.owner_asked,1,JSON.stringify(chased));
      const cashAsks = await asksFor(seed,'tx-cash-chase');
      assert.equal(cashAsks.length,1);assert.equal(cashAsks[0].evidence_type,'supporting_document');
      assert.equal((await txRow(seed,'tx-cash-chase')).convergence_state,'on_owner');
      await chaseGate();
      assert.deepEqual(await asksFor(seed,'tx-cash-chase'),cashAsks,'the evidence handoff is idempotent');

      // A statutory descriptor never retracts the filing requirement.
      await seed.query(
        `insert into client_evidence_requests
           (id, firm_id, client_id, transaction_id, status, evidence_type, question, request_payload, created_by, audience)
         values ('ask-vat-v1', $1, $2, 'tx-vat', 'open', 'supporting_document', 'Please provide the Q4 VAT filing or notice.', '{}'::jsonb, 'ask_batch', 'client')`,
        [FIRM, CLIENT]
      );
      await setClientFlagStage(seed, { firmId: FIRM, clientId: CLIENT, flagKey: AUTO_EXPLAIN_RETRACTS_FLAG_KEY, stage: 'auto', source: 'default', reason: 'rt26 proof' });
      const retraction = await inTransaction(async (client) => retractAsksSettledByAutoExplain(client, {
        firmId: FIRM, clientId: CLIENT, configSnapshot: await readClientConfigSnapshot(client, { firmId: FIRM, clientId: CLIENT })
      }));
      assert.equal(retraction.acts, true, JSON.stringify(retraction));
      assert.deepEqual([...retraction.retracted_request_ids], [], 'a statutory descriptor cannot retract the filing request');
      const retracted = (await seed.query("select status, response_payload from client_evidence_requests where id = 'ask-vat-v1'")).rows[0];
      assert.equal(retracted.status, 'open');
      assert.notEqual(retracted.response_payload?.retracted, true);

      // ── (3) the payslip lands and auto-matches the salary line ──
      await seed.query(
        `insert into documents (id, firm_id, client_id, filename, document_type, status, parse_status, total_amount, currency, payload)
         values ('doc-payslip', $1, $2, 'palkkalaskelma-2025-02.pdf', 'supplier_bill', 'uploaded', 'completed', 1500, 'EUR', '{}'::jsonb)`,
        [FIRM, CLIENT]
      );
      await seed.query(
        `insert into reconciliation_matches (id, firm_id, client_id, bank_transaction_id, matched_object_type, matched_object_id,
                                             match_amount, match_confidence, match_reason, status, created_by)
         values ('match-payslip', $1, $2, 'tx-salary', 'supplier_bill', 'doc-payslip', 1500, 0.99, 'Exact payslip settlement.', 'auto_matched', 'system')`,
        [FIRM, CLIENT]
      );
      await inTransaction((client) => cascadeAutoMatch({
        client, firmId: FIRM, clientId: CLIENT, matchId: 'match-payslip',
        bankTransactionId: 'tx-salary', matchedObjectType: 'supplier_bill', documentId: 'doc-payslip'
      }));
      const salaryAsksAfter = await asksFor(seed, 'tx-salary');
      assert.equal(salaryAsksAfter[0].status, 'resolved', 'the document ask is answered by the document');
      assert.equal(salaryAsksAfter[0].response_payload.auto_resolved_by_match, true);
      // RT-16's window: the column still reads asked until the release below.
      assert.equal((await txRow(seed, 'tx-salary')).coding_state, 'asked');
      const released = await __releaseSettledWaitingViaDb({ firmId: FIRM });
      assert.deepEqual(released.map((row) => row.transaction_id), ['tx-salary'], 'the release returns the coded, matched, un-asked line to the coder');
      // The source transition is synchronous. A competing pool-release sweep
      // may already own its projection mark; that documented background drain
      // must finish before this foreign seed connection observes quiescence.
      let salaryAfter = await txRow(seed, 'tx-salary');
      assert.equal(salaryAfter.coding_state, 'proposed', 'asked → proposed: back with the coder');
      const projectionDeadline = Date.now() + 2000;
      while (salaryAfter.convergence_state === 'on_owner' && Date.now() < projectionDeadline) {
        await new Promise(resolve => setTimeout(resolve, 20));
        salaryAfter = await txRow(seed, 'tx-salary');
      }
      assert.notEqual(salaryAfter.convergence_state, 'on_owner', `no ask holds the line now (${salaryAfter.convergence_reason})`);
      const receipt = await seed.query(
        `select metadata from audit_events where firm_id = $1 and action = 'transaction_review.waiting_released_after_settle' and resource_id = 'tx-salary'`, [FIRM]
      );
      assert.equal(receipt.rows.length, 1, 'the release is receipted');
      assert.deepEqual(receipt.rows[0].metadata.transaction_ids, ['tx-salary']);

      // The returned line carries its coding and now its evidence: the gate
      // posts it under the matched-document law (rule 1). The coder pool holds
      // only the never-coded VAT line; the unknown line stays out — its ask is live.
      const salaryPost = await runCodingAutoPostForTransaction({
        firmId: FIRM, clientId: CLIENT, transactionId: 'tx-salary', env: {},
        configSnapshot: { CODING_AUTO_POST: { stage: 'auto' } },
        postLedgerFn: async () => ({ ledger_posting: { state: 'posted' } })
      });
      assert.equal(salaryPost.auto_posted, 1, JSON.stringify(salaryPost));
      assert.equal(salaryPost.owner_asked, 0, 'the payslip answered the document ask — no re-ask');
      assert.equal((await txRow(seed, 'tx-salary')).coding_state, 'applied');
      const pool = await withFirmDbClient((client) => __loadDirectUncodedNeedsReviewPool({ client, firmId: FIRM, clientId: CLIENT }));
      assert.deepEqual(pool.map((row) => row.id), [], 'the statutory filing request retains ownership until its source arrives');

      // ── (2) the liability needs its source, not only the bank descriptor ──
      await seed.query(
        `update transactions
            set payload = payload || $3::jsonb, coding_state = 'proposed'
          where firm_id = $1 and id = $2`,
        [FIRM, 'tx-vat', JSON.stringify({ ai_suggestion: { proposed_account: 'VAT payable', confidence: 'high', evidence_required: false, model: 'test-coder', reasoning: 'Settles the Q4 VAT liability.' } })]
      );
      const unsupported = await runCodingAutoPostForTransaction({firmId:FIRM,clientId:CLIENT,transactionId:'tx-vat',env:{},
        configSnapshot:{CODING_AUTO_POST:{stage:'auto'}},postLedgerFn:async()=>{throw new Error('A descriptor cannot authorize liability posting');}});
      assert.equal(unsupported.auto_posted,0);
      assert.equal(unsupported.owner_asked,0,'the existing filing request retains ownership without a duplicate');
      const sourceAsk=(await asksFor(seed,'tx-vat')).find(ask=>['draft','open'].includes(ask.status));
      assert.equal(sourceAsk.evidence_type,'supporting_document');
      assert.match(sourceAsk.question,/filing or notice/);
      await seed.query(`insert into documents(id,firm_id,client_id,filename,document_type,status,parse_status,total_amount,currency,payload)
        values('doc-vat-notice',$1,$2,'tax-notice.pdf','payment_confirmation','uploaded','completed',1245,'EUR','{}')`,[FIRM,CLIENT]);
      await seed.query(`insert into reconciliation_matches(id,firm_id,client_id,bank_transaction_id,matched_object_type,matched_object_id,
        match_amount,match_confidence,match_reason,status,created_by)
        values('match-vat-notice',$1,$2,'tx-vat','payment_confirmation','doc-vat-notice',1245,.99,'Notice identifies the settled liability','auto_matched','system')`,[FIRM,CLIENT]);
      await inTransaction(client=>cascadeAutoMatch({client,firmId:FIRM,clientId:CLIENT,matchId:'match-vat-notice',
        bankTransactionId:'tx-vat',matchedObjectType:'payment_confirmation',documentId:'doc-vat-notice'}));
      await __releaseSettledWaitingViaDb({firmId:FIRM});
      assert.equal((await txRow(seed,'tx-vat')).coding_state,'proposed',JSON.stringify(await asksFor(seed,'tx-vat')));
      const posts = [];
      const gate = await runCodingAutoPostForTransaction({
        firmId: FIRM, clientId: CLIENT, transactionId: 'tx-vat', env: {},
        configSnapshot: { CODING_AUTO_POST: { stage: 'auto' } },
        postLedgerFn: async (args) => { posts.push(args); return { ledger_posting: { state: 'posted' } }; }
      });
      assert.equal(gate.owner_asked, 0, 'no treatment question — a knowledge decision');
      assert.equal(gate.auto_posted, 1, JSON.stringify(gate));
      assert.equal(gate.ledger_posted, 1);
      assert.equal(posts.length, 1);
      assert.equal(posts[0].transactionId, 'tx-vat');
      const vatAfter = await txRow(seed, 'tx-vat');
      assert.equal(vatAfter.coding_state, 'applied');
      assert.match(vatAfter.payload.support_note || '', /evidenced by the matched document/);
      const vatLiveAsks = (await asksFor(seed, 'tx-vat')).filter((ask) => ['draft', 'open', 'replied'].includes(ask.status));
      assert.deepEqual(vatLiveAsks, [], 'the filing arrival resolves the original ask');
    } finally {
      await __endFirmDbPoolForTests().catch(() => {});
      for (const [k, v] of Object.entries(prior)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
      await stop();
    }
  }
);
