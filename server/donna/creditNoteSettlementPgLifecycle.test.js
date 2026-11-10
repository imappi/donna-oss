// RT-27 — credit notes in the AR matcher's context: the real-PostgreSQL
// lifecycle proof, driven through the PRODUCTION writers (the AR LLM matcher
// with a STUBBED provider, upsertMatchAndCascade, the credit-application
// writer, the match reject writer, the doc-first drain, the named ledger
// posting writer) on the current migration chain.
//
// What is proven (the autonomous portion of the RT-27 contract):
//   1. Aroma: invoice 2 008,00 − credit note 376,50 = bank line 1 631,50
//      auto-reconciles under the existing authority (policy on + the D2
//      material auto-FYI stage the appliance seeds) — no bookkeeper click,
//      no owner question;
//   2. the credit is in the settlement reasoning (the prompt carries the
//      customer's eligible credits with call-local handles and the remaining
//      due) and only the SELECTED credit is applied;
//   3. exactly which credit went to which invoice for what amount is
//      persisted; a repeated delivery and a concurrent settlement cannot
//      consume a credit twice;
//   4. wrong-customer, wrong-currency, already-used, other-invoice, stale and
//      ambiguous credits never apply; a human reject reverses the application
//      and frees the credit; the locked-period guard on posting is intact;
//   5. credit-before-payment AND payment-before-credit converge through the
//      matcher's own clock (the credit note's arrival wakes the invoice);
//   6. the journals: ONE settlement journal on the bank line at the net
//      (DR bank 1 631,50 / CR sales 1 300,00 with the ALV code / CR ALV
//      331,50), no credit-note or invoice journal, revenue recognised once;
//   7. settlement answers existing evidence/payment asks, while generic
//      business-purpose asks survive. Refused and ambiguous cases retain
//      their prior state and generic workflow; no new credit-specific
//      question or unsupported reply action is offered.
//
// STUBBED-PROVIDER integration proof: the strong model is a deterministic
// stub keyed on the prompt's own handles. It proves the runtime wiring and
// the Keep layer, not the model's judgment — live-model evidence is a
// separate receipt (see the RT-27 handoff). Skips without DONNA_PG_TEST_URL
// (INCOMPLETE where that URL is expected).

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

import { runSalesInvoiceReconciliationLlmForDocument } from './salesInvoiceReconciliationLlm.js';
import { recoverReconciliationProviderFailures } from './reconciliationProviderFailure.js';
import { runDocumentDispositionForClient } from './documentDispositionLlm.js';
import {
  withFirmDbClient,
  __endFirmDbPoolForTests,
  updateReconciliationMatchInDb,
  postLedgerTransactionInDb,
  lockClosePeriodInDb,
  deleteDocumentInDb
} from './firmDb.js';
import { setClientFlagStage } from './clientConfig.js';
import { resolveCodingPolicy, codingPolicyReceipt } from './codingPolicy.js';
import { ledgerRecordId } from './db/ledger.js';
import {
  CREDIT_REFUSAL_CODES,
  applyCreditApplicationsWithClient,
  loadEligibleCreditNotes,
  lockAndRevalidateCreditNotes,
  planCreditApplications
} from './creditNoteApplications.js';

const PG_URL = process.env.DONNA_PG_TEST_URL || '';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const FIRM = 'firm-rt27';
const CLIENT = 'client-rt27';

const bootScratchDatabase = async () => {
  const dbName = `donna_rt27_${Date.now().toString(36)}_${process.pid}`;
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
  await seed.query(`insert into firms (id, name, slug, jurisdiction, default_currency) values ($1, 'RT-27 Firm', 'rt27-firm', 'FI', 'EUR')`, [FIRM]);
  await seed.query(
    `insert into clients (id, firm_id, company_name, jurisdiction, status, profile)
     values ($1, $2, 'Kampaamo Kultalanka Oy', 'fi', 'active', $3)`,
    [CLIENT, FIRM, { jurisdiction: 'fi', accounting_system: 'none', accounting_basis: 'cash', alv_registration: { status: 'registered', registered_from: '2020-01-01' } }]
  );
  const stop = async () => {
    await seed.end().catch(() => {});
    await admin.query(`drop database if exists "${dbName}" with (force)`).catch(() => {});
    await admin.end().catch(() => {});
  };
  return { seed, scratchUrl: scratchUrl.toString(), stop };
};

// ── fixtures ────────────────────────────────────────────────────────────────
const insertDocument = (seed, { id, customer, total, date, due = null, ref, cites = [], paymentStatus = 'unpaid', currency = 'EUR', type = 'sales_invoice', filename = null }) => seed.query(
  `insert into documents (id, firm_id, client_id, filename, document_type, status, parse_status, customer_name, total_amount, currency,
                          document_date, due_date, reference_number, payment_status, extraction_confidence, parse_summary, payload)
   values ($1, $2, $3, $4, $5, 'received', 'completed', $6, $7, $8, $9, $10, $11, $12, 0.96, $13::jsonb, '{}'::jsonb)`,
  [id, FIRM, CLIENT, filename || `${id}.pdf`, type, customer, total, currency, date, due, ref, paymentStatus,
   JSON.stringify({ warnings: [], references: cites.map((value) => ({ type: 'invoice_number', value })) })]
);
const insertBankLine = (seed, { id, amount, date, description, currency = 'EUR' }) => seed.query(
  `insert into transactions (id, firm_id, client_id, transaction_date, description, raw_description, money_in, money_out, currency, status, payload)
   values ($1, $2, $3, $4, $5, $5, $6, 0, $7, 'needs_review', '{}'::jsonb)`,
  [id, FIRM, CLIENT, date, description, amount, currency]
);
const insertDocAsk = (seed, { id, documentId, evidenceType, question, transactionId = null }) => seed.query(
  `insert into client_evidence_requests (id, firm_id, client_id, transaction_id, status, evidence_type, question, request_payload, created_by, audience)
   values ($1, $2, $3, $4, 'open', $5, $6, $7::jsonb, 'ask_batch', 'client')`,
  [id, FIRM, CLIENT, transactionId, evidenceType, question, JSON.stringify({ document_id: documentId })]
);

const q = (seed, sql, params = []) => seed.query(sql, params).then((r) => r.rows);
const one = (seed, sql, params = []) => q(seed, sql, params).then((rows) => rows[0]);
const docRow = (seed, id) => one(seed, `select payment_status, payload, convergence_state, convergence_reason from documents where firm_id = $1 and id = $2`, [FIRM, id]);
const txRow = (seed, id) => one(seed, `select reconciliation_status, coding_state, status, payload, convergence_state, convergence_reason from transactions where firm_id = $1 and id = $2`, [FIRM, id]);
const applications = (seed, invoiceId) => q(seed, `select id, credit_document_id, invoice_document_id, amount::float8 as amount, status, settlement_match_id from document_credit_applications where firm_id = $1 and invoice_document_id = $2 order by created_at, id`, [FIRM, invoiceId]);
const matchesFor = (seed, invoiceId) => q(seed, `select id, bank_transaction_id, status, match_amount::float8 as match_amount, payload from reconciliation_matches where firm_id = $1 and matched_object_id = $2 order by created_at`, [FIRM, invoiceId]);
const asksFor = (seed, documentId) => q(seed, `select id, status, evidence_type, question, transaction_id, request_payload, response_payload from client_evidence_requests where firm_id = $1 and request_payload->>'document_id' = $2 order by created_at`, [FIRM, documentId]);
const audits = (seed, action) => q(seed, `select resource_id, metadata from audit_events where firm_id = $1 and action = $2 order by id`, [FIRM, action]);

// ── the stubbed strong model ────────────────────────────────────────────────
// Decides from the prompt's OWN handles: the invoice id it is matching, the
// candidate lines (money_in) and the credit handles (amount). Never sees a
// credit-note database id (the prompt does not carry one — asserted below).
const prompts = [];
const parsePrompt = (userPrompt) => {
  const invoiceId = /Invoice:\n\s*id=(\S+)/.exec(userPrompt)?.[1] || null;
  const candidates = [...userPrompt.matchAll(/candidate_ref=(candidate_\d+)\n\s*date=[^\n]*\n\s*money_in=([\d.]+)/g)]
    .map((m) => ({ ref: m[1], amount: Number(m[2]) }));
  const credits = [...userPrompt.matchAll(/credit_ref=(credit_\d+)\n\s*date=[^\n]*\n\s*amount=(-?[\d.]+) \w* \(available=([\d.]+)/g)]
    .map((m) => ({ ref: m[1], amount: Number(m[2]), available: Number(m[3]) }));
  const remainingDue = Number(/remaining due: ([\d.]+)/.exec(userPrompt)?.[1] ?? NaN);
  return { invoiceId, candidates, credits, remainingDue };
};
const NO_MATCH = { proposals: [], credit_applications: [], unmatchable_reason: 'no_plausible_match' };
const decideMatch = ({ invoiceId, candidates, credits, remainingDue }) => {
  const line = (amount) => candidates.find((c) => Math.abs(c.amount - amount) < 0.005);
  const credit = (amount) => credits.find((c) => Math.abs(c.available - amount) < 0.005);
  if (invoiceId === 'doc-inv-aroma' || invoiceId === 'doc-inv-leipomo') {
    const l = line(invoiceId === 'doc-inv-aroma' ? 1631.5 : 750);
    const c = credit(invoiceId === 'doc-inv-aroma' ? 376.5 : 250);
    if (l && c) {
      return { proposals: [{ candidate_ref: l.ref, confidence: 0.94, reasoning: 'The customer paid the invoice net of its own credit note; the amounts close to the cent and the reference matches.', hops: ['amount_exact', 'customer_overlap', 'reference_match'], applied_credits: [c.ref] }], credit_applications: [], unmatchable_reason: null };
    }
    return NO_MATCH;
  }
  if (invoiceId === 'doc-inv-lumo') {
    const l = line(900);
    if (l) return { proposals: [{ candidate_ref: l.ref, confidence: 0.91, reasoning: 'A first instalment from the customer.', hops: ['partial_payment', 'customer_overlap'] }], credit_applications: [], unmatchable_reason: null };
    const c = credit(300);
    if (c && Math.abs(remainingDue - 300) < 0.005) {
      return { proposals: [], credit_applications: [{ credit_ref: c.ref, confidence: 0.93, reasoning: 'The credit note cites this invoice and equals what remains due after the instalment.' }], unmatchable_reason: null };
    }
    return NO_MATCH;
  }
  if (invoiceId === 'doc-inv-mixed-confidence') {
    return { proposals: [], credit_applications: credits.map((c, i) => ({ credit_ref: c.ref, confidence: i ? 0.6 : 0.99, reasoning: 'The second credit may relate to this invoice.' })), unmatchable_reason: null };
  }
  if (invoiceId === 'doc-inv-vihanta') {
    const l = line(400);
    if (l && credits.length) return { proposals: [{ candidate_ref: l.ref, confidence: 0.9, reasoning: 'The payment plus one of the credits closes the invoice.', hops: ['customer_overlap'], applied_credits: credits.map((c) => c.ref) }], credit_applications: [], unmatchable_reason: null };
    return NO_MATCH;
  }
  return NO_MATCH;
};
const decideDisposition = () => ({ disposition: 'auto_explain', materiality: 'immaterial', expense_kind: 'unknown', settlement_channel: 'cash', confidence: 0.9, reasoning: 'A small self-explanatory document.' });
const fetchStub = async (_url, init) => {
  const body = JSON.parse(init.body);
  const userPrompt = String(body.messages?.[0]?.content || '');
  const system = String(body.system || '');
  let reply;
  if (system.startsWith('You match a parsed sales invoice')) {
    const parsed = parsePrompt(userPrompt);
    prompts.push({ ...parsed, text: userPrompt });
    reply = decideMatch(parsed);
  } else {
    reply = decideDisposition();
  }
  return { ok: true, status: 200, json: async () => ({ model: 'stub-strong-model', content: [{ text: JSON.stringify(reply) }] }) };
};

const runMatcher = (documentId) => withFirmDbClient((client) => runSalesInvoiceReconciliationLlmForDocument({
  client, firmId: FIRM, clientId: CLIENT, documentId, apiKeyOverride: 'sk-test', fetchImpl: fetchStub
}));

test(
  'real PG (RT-27): invoice − credit note = bank line auto-reconciles under existing authority; credits persist exactly; both orders converge; refusals hold; the journal recognises revenue once',
  { skip: !PG_URL && 'DONNA_PG_TEST_URL not set' },
  async () => {
    const { seed, scratchUrl, stop } = await bootScratchDatabase();
    const prior = {
      DATABASE_URL: process.env.DATABASE_URL, DATABASE_POOL_MAX: process.env.DATABASE_POOL_MAX,
      RECONCILIATION_AUTO_MATCH_POLICY: process.env.RECONCILIATION_AUTO_MATCH_POLICY,
      RECONCILIATION_AUTO_MATCH_MATERIALITY_CEILING: process.env.RECONCILIATION_AUTO_MATCH_MATERIALITY_CEILING,
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY
    };
    process.env.DATABASE_URL = scratchUrl;
    process.env.DATABASE_POOL_MAX = '3';
    // The appliance posture: the auto-match policy is on (hostRuntimeDefaults)
    // and the ceiling follows the FI pack (500 EUR) — a 1 631,50 line is
    // material and auto-reconciles ONLY through the D2 material auto-FYI stage
    // the desktop seeds (DESKTOP_CLIENT_FLAG_SEEDS). No RT-27-specific flag.
    process.env.RECONCILIATION_AUTO_MATCH_POLICY = '1';
    delete process.env.RECONCILIATION_AUTO_MATCH_MATERIALITY_CEILING;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      for (const flagKey of ['RECONCILIATION_MATERIAL_AUTO_FYI', 'FINLAND_ALV_CODING']) {
        await setClientFlagStage(seed, { firmId: FIRM, clientId: CLIENT, flagKey, stage: 'auto', source: 'default', reason: 'rt27 proof' });
      }

      // ══ 1+2+5a. Aroma — CREDIT BEFORE PAYMENT ═══════════════════════════
      await insertDocument(seed, { id: 'doc-inv-aroma', customer: 'Aroma Kahvila Oy', total: 2008, date: '2025-02-03', due: '2025-02-17', ref: 'LASKU 2025-014', cites: ['2025-014'] });
      await insertDocument(seed, { id: 'doc-cn-aroma', customer: 'Aroma Kahvila Oy', total: -376.5, date: '2025-02-06', ref: 'HYVITYS 2025-002', cites: ['2025-014'], paymentStatus: 'credit_note' });
      // Existing evidence and payment questions answered by this settlement.
      await insertDocAsk(seed, { id: 'ask-cn-aroma', documentId: 'doc-cn-aroma', evidenceType: 'supporting_document', question: 'Which invoice does this credit note reduce?' });
      await insertDocAsk(seed, { id: 'ask-inv-aroma', documentId: 'doc-inv-aroma', evidenceType: 'payment_method', question: 'How was invoice 2025-014 paid?' });

      // The credit note arrives first: its own pass wakes the invoice, which
      // has no bank line yet — nothing applies, nothing is asked, the wake is
      // receipted as a verdict.
      await assert.rejects(withFirmDbClient((client) => runSalesInvoiceReconciliationLlmForDocument({
        client, firmId: FIRM, clientId: CLIENT, documentId: 'doc-cn-aroma', apiKeyOverride: 'sk-test',
        fetchImpl: async () => ({ ok: false, status: 401, json: async () => ({ error: { message: 'Invalid test key' } }) })
      })), { code: 'PROVIDER_UNAUTHORIZED' }, 'credit arrival must propagate the failed child for the existing recovery writer');
      const arrival = await runMatcher('doc-cn-aroma');
      assert.equal(arrival.credit_note_invoices_reconsidered, 1, JSON.stringify(arrival));
      assert.equal(arrival.credit_notes_applied || 0, 0);
      assert.deepEqual(await applications(seed, 'doc-inv-aroma'), []);
      const arrivalStamp = await one(seed, `select verdict, unmatchable_reason, payload from reconciliation_evaluations where firm_id = $1 and target_id = 'doc-cn-aroma' and matcher_family = 'sales_invoice'`, [FIRM]);
      assert.equal(arrivalStamp.verdict, 'no_candidates');
      assert.equal(arrivalStamp.unmatchable_reason, 'credit_note_no_bank_line');
      assert.deepEqual(arrivalStamp.payload.invoices_reconsidered.map((r) => r.invoice_document_id), ['doc-inv-aroma']);

      // The bank line lands; the invoice's pass (the sweep's) runs.
      await insertBankLine(seed, { id: 'tx-aroma', amount: 1631.5, date: '2025-02-20', description: 'AROMA KAHVILA OY VIITE 10014' });
      // A real database write failure after a successful model answer must
      // persist owed execution, then recover without another source upload.
      await seed.query(`create function fixture_credit_write_failure() returns trigger language plpgsql as $$
        begin raise exception 'fixture credit write deadlock' using errcode='40P01'; end $$;
        create trigger fixture_credit_write_failure before insert on document_credit_applications
        for each row execute function fixture_credit_write_failure()`);
      await runMatcher('doc-cn-aroma');
      const failedCredit=await one(seed, "select verdict,unmatchable_reason,payload from reconciliation_evaluations where target_id='doc-cn-aroma' and matcher_family='sales_invoice'");
      assert.equal(failedCredit.verdict,'failed');
      assert.equal(failedCredit.unmatchable_reason,'credit_note_write_failed');
      assert.equal(failedCredit.payload.failures[0].code,'40P01');
      assert.equal(failedCredit.payload.next_action,'retry_writer');
      assert.deepEqual(await applications(seed,'doc-inv-aroma'),[]);
      await seed.query('drop trigger fixture_credit_write_failure on document_credit_applications; drop function fixture_credit_write_failure()');
      await seed.query("update reconciliation_evaluations set evaluated_at=now()-interval '6 minutes' where target_id='doc-cn-aroma'");
      const {DISCOVER_RECONCILIATION_PROVIDER_FAILURES_SQL,RECONCILIATION_PROVIDER_RECOVERY_DOC_TYPES}=await import('./reconciliationProviderFailure.js');
      const discover=async()=> (await seed.query(DISCOVER_RECONCILIATION_PROVIDER_FAILURES_SQL,[FIRM,50,[...RECONCILIATION_PROVIDER_RECOVERY_DOC_TYPES]])).rows;
      assert.equal((await discover()).find(r=>r.document_id==='doc-cn-aroma').receipt.code,'RECONCILIATION_EXECUTION_PENDING');
      await seed.query("update reconciliation_evaluations set payload=jsonb_set(payload,'{attempt_count}','3') where target_id='doc-cn-aroma'");
      assert.ok(!(await discover()).some(r=>r.document_id==='doc-cn-aroma'),'writer retries are bounded');
      // A saved Jev handoff with no family completion is also owed execution.
      await seed.query(`update reconciliation_evaluations set payload='{"decision_engine":"jev","next_action":"reasoning","attempt_count":1}' where target_id='doc-cn-aroma'`);
      assert.ok((await discover()).some(r=>r.document_id==='doc-cn-aroma'));
      await seed.query("update reconciliation_evaluations set verdict='no_candidates',unmatchable_reason='credit_note_no_bank_line',payload='{}' where target_id='doc-cn-aroma'");
      // Reproduce the historic signed-credit receipt. The existing convergence
      // discovery must heal it without another upload, and stop after repair.
      await seed.query(`update reconciliation_evaluations set payload = payload ||
        '{"remaining_available":-376.5,"invoices_reconsidered":[]}'::jsonb
        where firm_id=$1 and target_id='doc-cn-aroma' and matcher_family='sales_invoice'`, [FIRM]);
      let first;
      let recoveryRuns = 0;
      const recovery = await recoverReconciliationProviderFailures({
        firmId: FIRM, withClient: withFirmDbClient,
        runFamilyFn: async ({ client, document }) => {
          recoveryRuns += 1;
          first = await runSalesInvoiceReconciliationLlmForDocument({client, firmId: FIRM, clientId: CLIENT,
            documentId: document.id, apiKeyOverride: 'sk-test', fetchImpl: fetchStub});
          return first;
        }
      });
      assert.equal(recoveryRuns, 1);
      assert.equal(recovery[0].prior, 'SIGNED_CREDIT_REMAINING_STALE');
      assert.equal(recovery[0].outcome, 'recovered');
      assert.deepEqual(await recoverReconciliationProviderFailures({firmId: FIRM, withClient: withFirmDbClient,
        runFamilyFn: async () => { throw new Error('healthy credit must leave recovery discovery'); }}), []);
      assert.equal(first.suggested_inserted, 1, JSON.stringify(first));
      assert.equal(first.credit_notes_applied, 1);
      assert.equal(Number((await one(seed, "select total_amount from documents where id='doc-cn-aroma'")).total_amount), -376.5, 'application preserves the printed signed amount');
      assert.equal(first.credit_note_owner_asks || 0, 0);
      const aromaPrompt = prompts.findLast((p) => p.invoiceId === 'doc-inv-aroma');
      assert.deepEqual(aromaPrompt.credits, [{ ref: 'credit_1', amount: -376.5, available: 376.5 }], 'the signed source and available credit ride the prompt with a call-local handle');
      assert.ok(!aromaPrompt.text.includes('doc-cn-aroma'), 'the credit note database id never reaches the model');
      assert.match(aromaPrompt.text, /credit_ref=credit_1/);

      const [aromaMatch] = await matchesFor(seed, 'doc-inv-aroma');
      assert.equal(aromaMatch.status, 'auto_matched', JSON.stringify(aromaMatch.payload.authorization));
      assert.equal(aromaMatch.match_amount, 1631.5);
      assert.equal(aromaMatch.payload.authorization.gates.C, true, 'Gate C closed on bank + credit');
      assert.equal(aromaMatch.payload.authorization.gates.E, false, 'a material line: held by the ceiling…');
      assert.deepEqual(aromaMatch.payload.authorization.reasons, ['material_auto_fyi'], '…and released by the D2 stage the appliance seeds');
      assert.deepEqual(aromaMatch.payload.authorization.credit_notes.applied, [{ credit_document_id: 'doc-cn-aroma', amount: 376.5, linkage: 'linked', already_applied: false }]);
      assert.equal(aromaMatch.payload.authorization.model, 'stub-strong-model');
      const aromaApps = await applications(seed, 'doc-inv-aroma');
      assert.equal(aromaApps.length, 1);
      assert.equal(aromaApps[0].credit_document_id, 'doc-cn-aroma');
      assert.equal(aromaApps[0].amount, 376.5);
      assert.equal(aromaApps[0].status, 'applied');
      assert.equal(aromaApps[0].settlement_match_id, aromaMatch.id);
      const aromaInvoice = await docRow(seed, 'doc-inv-aroma');
      assert.equal(aromaInvoice.payment_status, 'paid', 'bank line + credit = the invoice total');
      const aromaCredit = await docRow(seed, 'doc-cn-aroma');
      assert.equal(aromaCredit.payment_status, 'credit_note', 'the vocabulary is untouched');
      assert.equal(aromaCredit.payload.no_line_disposition.disposition, 'auto_explain');
      assert.equal(aromaCredit.payload.no_line_disposition.lane, 'credit_note_applied');
      assert.equal(aromaCredit.payload.credit_note_applications[0].invoice_document_id, 'doc-inv-aroma');
      assert.equal(aromaCredit.convergence_state, 'auto_reconciled', aromaCredit.convergence_reason);
      assert.equal(aromaInvoice.convergence_state, null, 'a matched invoice carries its verdict on the bank line');
      const aromaTx = await txRow(seed, 'tx-aroma');
      assert.equal(aromaTx.reconciliation_status, 'explained');
      assert.equal(aromaTx.convergence_state, 'hanging', 'settlement does not invent the still-missing coding');
      assert.equal(aromaTx.convergence_reason, 'explained_but_uncoded');
      // 7. no stale owner questions: both pre-existing asks are resolved with
      //    a receipt naming the application; nothing new was asked.
      const cnAsks = await asksFor(seed, 'doc-cn-aroma');
      assert.equal(cnAsks[0].status, 'resolved');
      assert.equal(cnAsks[0].response_payload.auto_resolved_by_credit_application, true);
      const invAsks = await asksFor(seed, 'doc-inv-aroma');
      assert.equal(invAsks[0].status, 'resolved');
      assert.equal(invAsks.length, 1);
      assert.equal((await audits(seed, 'reconciliation.credit_note_applied')).length, 1);
      assert.equal((await q(seed, `select count(*)::int as n from client_evidence_requests where firm_id = $1 and status in ('draft','open')`, [FIRM]))[0].n, 0, 'nothing rests on the owner');

      // 3. Redelivery: the same passes again change nothing.
      const again = await runMatcher('doc-inv-aroma');
      assert.equal(again.suggested_inserted, 0, JSON.stringify(again));
      assert.equal(again.credit_notes_applied || 0, 0);
      const againCredit = await runMatcher('doc-cn-aroma');
      assert.equal(againCredit.credit_notes_applied || 0, 0);
      assert.equal((await applications(seed, 'doc-inv-aroma')).length, 1, 'one application, however many deliveries');
      assert.equal((await audits(seed, 'reconciliation.credit_note_applied')).length, 1);

      // 6. The journal: the settlement posts on the bank line at the NET, once.
      const policy = resolveCodingPolicy({ jurisdiction: 'fi', businessDate: '2025-02-20', accountingSystem: 'none' });
      for (const [code, name, type, normal, role] of [['1910', 'Pankkitili', 'bank', 'debit', 'asset.cash'], ['3000', 'Myynti', 'revenue', 'credit', 'revenue.operating']]) {
        await seed.query(`insert into ledger_accounts (id, firm_id, client_id, code, name, account_type, normal_balance, currency, tax_type, canonical_role, status)
          values ($1, $2, $3, $4, $5, $6, $7, 'EUR', null, $8, 'active')`, [ledgerRecordId('account', FIRM, CLIENT, code), FIRM, CLIENT, code, name, type, normal, role]);
      }
      await seed.query(`update transactions set coding_state = 'applied', payload = payload || $3::jsonb where firm_id = $1 and id = $2`,
        [FIRM, 'tx-aroma', JSON.stringify({ ai_suggestion: { proposed_account: 'Myynti', account_code: '3000', tax_treatment: 'ALV 25,5 %', confidence: 'high', model: 'fixture-coder', coding_policy: codingPolicyReceipt(policy) } })]);
      const journalsBefore = (await q(seed, `select count(*)::int as n from ledger_journals where firm_id = $1`, [FIRM]))[0].n;
      assert.equal(journalsBefore, 0, 'the credit application wrote no ledger row');
      await postLedgerTransactionInDb({ firmId: FIRM, clientId: CLIENT, transactionId: 'tx-aroma', dryRun: false, skipSnapshot: true, actorId: 'fixture-owner' });
      const postedAromaTx = await txRow(seed, 'tx-aroma');
      assert.equal(postedAromaTx.coding_state, 'posted');
      assert.equal(postedAromaTx.convergence_state, 'auto_reconciled', postedAromaTx.convergence_reason);
      const journals = await q(seed, `select id, source_type, source_id from ledger_journals where firm_id = $1 and client_id = $2 order by id`, [FIRM, CLIENT]);
      assert.equal(journals.length, 1, 'ONE journal for the settlement');
      assert.equal(journals[0].source_type, 'transaction');
      assert.equal(journals[0].source_id, 'tx-aroma');
      const lines = (await q(seed, `select account_code, direction, debit::float8 as debit, credit::float8 as credit, tax_type from ledger_lines where journal_id = $1 order by line_no`, [journals[0].id]));
      assert.deepEqual(lines, [
        { account_code: '1910', direction: 'debit', debit: 1631.5, credit: 0, tax_type: 'NONE' },
        { account_code: '3000', direction: 'credit', debit: 0, credit: 1300, tax_type: 'ALV_25_5_OUTPUT' },
        { account_code: '2939', direction: 'credit', debit: 0, credit: 331.5, tax_type: 'NONE' }
      ], 'revenue 1 600 − 300 and ALV 408 − 76,50: the credit is recognised inside the cash line, never as a second journal');
      assert.equal(lines.reduce((s, l) => s + l.debit - l.credit, 0), 0, 'footing');
      assert.equal((await q(seed, `select count(*)::int as n from ledger_journals where firm_id = $1 and source_type in ('credit_note', 'sales_invoice')`, [FIRM]))[0].n, 0, 'no credit-note or invoice journal');
      assert.equal((await q(seed, `select coalesce(sum(credit), 0)::float8 as revenue from ledger_lines where account_code = '3000' and journal_id in (select id from ledger_journals where firm_id = $1)`, [FIRM]))[0].revenue, 1300, 'revenue once');
      assert.equal((await txRow(seed, 'tx-aroma')).reconciliation_status, 'posted');

      // 4d. Locked period: the posting guard is intact — a later line in a
      //     locked month refuses by name, and the RT-27 writer never touched it.
      await lockClosePeriodInDb({ firmId: FIRM, clientId: CLIENT, periodStart: '2025-02-01', periodEnd: '2025-02-28', actorId: 'fixture-owner', force: true });
      await insertBankLine(seed, { id: 'tx-locked', amount: 100, date: '2025-02-25', description: 'LATE IN LOCKED MONTH' });
      const lockedPolicy = resolveCodingPolicy({ jurisdiction: 'fi', businessDate: '2025-02-25', accountingSystem: 'none' });
      await seed.query(`update transactions set coding_state = 'applied', payload = payload || $3::jsonb where firm_id = $1 and id = $2`,
        [FIRM, 'tx-locked', JSON.stringify({ ai_suggestion: { proposed_account: 'Myynti', account_code: '3000', tax_treatment: 'ALV 25,5 %', confidence: 'high', model: 'fixture-coder', coding_policy: codingPolicyReceipt(lockedPolicy) } })]);
      await assert.rejects(
        postLedgerTransactionInDb({ firmId: FIRM, clientId: CLIENT, transactionId: 'tx-locked', dryRun: false, skipSnapshot: true, actorId: 'fixture-owner' }),
        (e) => { if (e?.code === 'LEDGER_LOCKED_PERIOD_IMMUTABLE') return true; console.error('expected LEDGER_LOCKED_PERIOD_IMMUTABLE, got', e?.code, e?.message); return false; }
      );

      // ══ 5b. Lumo — PAYMENT BEFORE CREDIT ════════════════════════════════
      await insertDocument(seed, { id: 'doc-inv-lumo', customer: 'Kukkakauppa Lumo Oy', total: 1200, date: '2025-03-03', due: '2025-03-17', ref: 'LASKU 2025-021', cites: ['2025-021'] });
      await insertBankLine(seed, { id: 'tx-lumo', amount: 900, date: '2025-03-10', description: 'KUKKAKAUPPA LUMO OY' });
      const lumoFirst = await runMatcher('doc-inv-lumo');
      assert.equal(lumoFirst.suggested_inserted, 1, JSON.stringify(lumoFirst));
      const [lumoMatch] = await matchesFor(seed, 'doc-inv-lumo');
      assert.equal(lumoMatch.status, 'auto_matched', 'a declared partial closes Gate C');
      assert.equal((await docRow(seed, 'doc-inv-lumo')).payment_status, 'partial');
      // The credit note arrives AFTER the instalment; its arrival re-runs the
      // invoice with the remaining due in context and the credit completes it.
      await insertDocument(seed, { id: 'doc-cn-lumo', customer: 'Kukkakauppa Lumo Oy', total: -300, date: '2025-03-12', ref: 'HYVITYS 2025-005', cites: ['2025-021'], paymentStatus: 'credit_note' });
      const lumoArrival = await runMatcher('doc-cn-lumo');
      assert.equal(lumoArrival.credit_note_invoices_reconsidered, 1, JSON.stringify(lumoArrival));
      assert.equal(lumoArrival.credit_notes_applied, 1);
      const lumoPrompt = prompts.findLast((p) => p.invoiceId === 'doc-inv-lumo');
      assert.equal(lumoPrompt.remainingDue, 300, 'the prompt states the remaining due after the instalment');
      assert.ok(!lumoPrompt.candidates.some((c) => c.amount === 900), 'the settled instalment is suppressed; the credit alone completes the invoice');
      const lumoApps = await applications(seed, 'doc-inv-lumo');
      assert.deepEqual(lumoApps.map((a) => [a.credit_document_id, a.amount, a.status, a.settlement_match_id]), [['doc-cn-lumo', 300, 'applied', null]]);
      const lumoInvoice = await docRow(seed, 'doc-inv-lumo');
      assert.equal(lumoInvoice.payment_status, 'paid', '900 by the line + 300 by the credit');
      const lumoCredit = await docRow(seed, 'doc-cn-lumo');
      assert.equal(lumoCredit.payload.no_line_disposition.lane, 'credit_note_applied');
      assert.equal(lumoCredit.convergence_state, 'auto_reconciled', lumoCredit.convergence_reason);
      assert.equal((await q(seed, `select count(*)::int as n from client_evidence_requests where firm_id = $1 and status in ('draft','open')`, [FIRM]))[0].n, 0);
      const lumoStamp = await one(seed, `select verdict, proposal_count from reconciliation_evaluations where firm_id = $1 and target_id = 'doc-inv-lumo' and matcher_family = 'sales_invoice'`, [FIRM]);
      assert.equal(lumoStamp.verdict, 'proposed', 'a credit-only completion is a verdict, not an absence');

      // ══ 4a-c. Vihanta — the refusal matrix ══════════════════════════════
      await insertDocument(seed, { id: 'doc-inv-vihanta', customer: 'Puutarha Vihanta Oy', total: 500, date: '2025-04-01', due: '2025-04-15', ref: 'LASKU 2025-030', cites: ['2025-030'] });
      await insertDocument(seed, { id: 'doc-inv-vihanta-2', customer: 'Puutarha Vihanta Oy', total: 800, date: '2025-04-02', due: '2025-04-16', ref: 'LASKU 2025-031', cites: ['2025-031'] });
      await insertDocument(seed, { id: 'doc-inv-used', customer: 'Puutarha Vihanta Oy', total: 100, date: '2025-03-20', ref: 'LASKU 2025-025', cites: ['2025-025'], paymentStatus: 'paid' });
      await insertDocument(seed, { id: 'doc-cn-wrong-customer', customer: 'Muu Asiakas Oy', total: 100, date: '2025-04-03', ref: 'HYVITYS 2025-010', paymentStatus: 'credit_note' });
      await insertDocument(seed, { id: 'doc-cn-wrong-currency', customer: 'Puutarha Vihanta Oy', total: 100, date: '2025-04-03', ref: 'HYVITYS 2025-011', paymentStatus: 'credit_note', currency: 'USD' });
      await insertDocument(seed, { id: 'doc-cn-used', customer: 'Puutarha Vihanta Oy', total: 100, date: '2025-04-03', ref: 'HYVITYS 2025-012', paymentStatus: 'credit_note' });
      await seed.query(`insert into document_credit_applications (id, firm_id, client_id, credit_document_id, invoice_document_id, amount, currency, status, applied_by)
        values ('credapp-used', $1, $2, 'doc-cn-used', 'doc-inv-used', 100, 'EUR', 'applied', 'system')`, [FIRM, CLIENT]);
      await insertDocument(seed, { id: 'doc-cn-other-invoice', customer: 'Puutarha Vihanta Oy', total: 100, date: '2025-04-03', ref: 'HYVITYS 2025-013', cites: ['2025-031'], paymentStatus: 'credit_note' });
      await insertDocument(seed, { id: 'doc-cn-twin-a', customer: 'Puutarha Vihanta Oy', total: 100, date: '2025-04-04', ref: 'HYVITYS 2025-014', paymentStatus: 'credit_note' });
      await insertDocument(seed, { id: 'doc-cn-twin-b', customer: 'Puutarha Vihanta Oy', total: 100, date: '2025-04-05', ref: 'HYVITYS 2025-015', paymentStatus: 'credit_note' });
      const gathered = await withFirmDbClient((client) => loadEligibleCreditNotes({ client, firmId: FIRM, clientId: CLIENT, invoice: { id: 'doc-inv-vihanta', customer_name: 'Puutarha Vihanta Oy', currency: 'EUR', total_amount: 500, document_date: '2025-04-01', reference_number: 'LASKU 2025-030', parse_summary: { references: [{ type: 'invoice_number', value: '2025-030' }] } } }));
      assert.deepEqual(gathered.eligible.map((c) => c.id).sort(), ['doc-cn-twin-a', 'doc-cn-twin-b'], 'only the two unlinked twins are eligible for this invoice');
      const ineligibleReasons = Object.fromEntries(gathered.ineligible.map((c) => [c.id, c.reasons]));
      assert.ok(ineligibleReasons['doc-cn-wrong-customer'].includes(CREDIT_REFUSAL_CODES.CUSTOMER_MISMATCH));
      assert.ok(ineligibleReasons['doc-cn-wrong-currency'].includes(CREDIT_REFUSAL_CODES.CURRENCY_MISMATCH));
      assert.ok(ineligibleReasons['doc-cn-used'].includes(CREDIT_REFUSAL_CODES.EXHAUSTED));
      assert.ok(ineligibleReasons['doc-cn-other-invoice'].includes(CREDIT_REFUSAL_CODES.OTHER_INVOICE));
      assert.ok(!('doc-cn-aroma' in ineligibleReasons) || ineligibleReasons['doc-cn-aroma'].length, 'an exhausted credit from another customer is out');

      await insertBankLine(seed, { id: 'tx-vihanta', amount: 400, date: '2025-04-10', description: 'PUUTARHA VIHANTA OY' });
      const vihanta = await runMatcher('doc-inv-vihanta');
      assert.equal(vihanta.credit_notes_applied || 0, 0, 'an ambiguous credit never applies');
      assert.equal(vihanta.credit_note_owner_asks || 0, 0, 'RT-27 cannot mint a question whose reply has no consumer');
      const vihantaPrompt = prompts.findLast((p) => p.invoiceId === 'doc-inv-vihanta');
      assert.deepEqual(vihantaPrompt.credits.map((c) => c.ref), ['credit_1', 'credit_2'], 'wrong-customer, wrong-currency, used and other-invoice credits never reach the prompt');
      assert.deepEqual(await applications(seed, 'doc-inv-vihanta'), []);
      const [vihantaMatch] = await matchesFor(seed, 'doc-inv-vihanta');
      assert.equal(vihantaMatch.status, 'suggested', 'the bank line alone does not close the invoice');
      assert.equal(vihantaMatch.payload.authorization.credit_notes.ambiguity.code, CREDIT_REFUSAL_CODES.AMBIGUOUS);
      assert.deepEqual(vihantaMatch.payload.authorization.credit_notes.refused.map((r) => r.code), [CREDIT_REFUSAL_CODES.NOT_NEEDED, CREDIT_REFUSAL_CODES.AMBIGUOUS], 'the unused selection is retained in the refusal receipt and cannot erase the actual ambiguity');
      assert.deepEqual(await asksFor(seed, 'doc-inv-vihanta'), [], 'no new credit-specific question');
      assert.equal((await txRow(seed, 'tx-vihanta')).convergence_state, 'hanging', 'the ordinary suggested match remains explicitly unresolved');
      const vihantaAgain = await runMatcher('doc-inv-vihanta');
      assert.equal(vihantaAgain.credit_note_owner_asks || 0, 0);
      assert.deepEqual(await asksFor(seed, 'doc-inv-vihanta'), [], 'a replay cannot invent a reply contract');

      // 4c. Stale: the credit moved between the gather and the write.
      const staleInvoice = await one(seed, `select * from documents where id = 'doc-inv-vihanta-2'`);
      const staleGather = await withFirmDbClient((client) => loadEligibleCreditNotes({ client, firmId: FIRM, clientId: CLIENT, invoice: staleInvoice }));
      const staleCredit = staleGather.eligible.find((c) => c.id === 'doc-cn-other-invoice');
      assert.ok(staleCredit, 'the credit citing 2025-031 is eligible for invoice 2025-031');
      const stalePlan = planCreditApplications({ invoice: staleInvoice, bankAmount: 700, bankCurrency: 'EUR', selectedIds: ['doc-cn-other-invoice'], creditNotes: [staleCredit] });
      assert.equal(stalePlan.ok, true);
      await seed.query(`update documents set total_amount = 120 where id = 'doc-cn-other-invoice'`);
      const staleLive = await withFirmDbClient(async (client) => {
        await client.query('begin');
        try { return await lockAndRevalidateCreditNotes({ client, firmId: FIRM, invoice: staleInvoice, plan: stalePlan }); }
        finally { await client.query('rollback'); }
      });
      assert.equal(staleLive.ok, false);
      assert.deepEqual(staleLive.refusals, [{ credit_document_id: 'doc-cn-other-invoice', code: CREDIT_REFUSAL_CODES.STALE }]);
      await seed.query(`update documents set total_amount = 100 where id = 'doc-cn-other-invoice'`);

      // Review reproduction: changed references/date/invoice must invalidate
      // the plan before any credit can be consumed.
      for (const [label, mutate, restore] of [
        ['credit invoice reference', `update documents set parse_summary = '{"references":[{"type":"invoice_number","value":"2025-030"}]}' where id = 'doc-cn-other-invoice'`, `update documents set parse_summary = '{"warnings":[],"references":[{"type":"invoice_number","value":"2025-031"}]}' where id = 'doc-cn-other-invoice'`],
        ['credit date', `update documents set document_date = '2025-01-01' where id = 'doc-cn-other-invoice'`, `update documents set document_date = '2025-04-03' where id = 'doc-cn-other-invoice'`],
        ['invoice amount', `update documents set total_amount = 700 where id = 'doc-inv-vihanta-2'`, `update documents set total_amount = 800 where id = 'doc-inv-vihanta-2'`],
      ]) {
        await seed.query(mutate);
        const observed = await withFirmDbClient(async (client) => {
          await client.query('begin');
          try { return await lockAndRevalidateCreditNotes({ client, firmId: FIRM, invoice: staleInvoice, plan: stalePlan }); }
          finally { await client.query('rollback'); }
        });
        await seed.query(restore);
        assert.equal(observed.ok, false, `${label} changed during reasoning must refuse: ${JSON.stringify(observed)}`);
      }

      // Same customer and amount do not authorize a credit printed by
      // another company; credit-only applications need the shared own-side guard.
      await seed.query(`update documents set parse_summary = parse_summary || '{"parties":[{"role":"supplier","name":"Vieraan Yhtion Oy"}]}'::jsonb where id = 'doc-cn-other-invoice'`);
      const foreignGather = await withFirmDbClient((client) => loadEligibleCreditNotes({ client, firmId: FIRM, clientId: CLIENT, invoice: staleInvoice }));
      const foreignPlan = planCreditApplications({ invoice: staleInvoice, bankAmount: 700, bankCurrency: 'EUR', selectedIds: ['doc-cn-other-invoice'], creditNotes: foreignGather.eligible });
      const foreignLive = await withFirmDbClient(async (client) => {
        await client.query('begin');
        try { return await lockAndRevalidateCreditNotes({ client, firmId: FIRM, invoice: staleInvoice, plan: foreignPlan }); }
        finally { await client.query('rollback'); }
      });
      assert.equal(foreignLive.ok, false, 'a foreign issuer never gains credit-only authority');
      await seed.query(`update documents set parse_summary = parse_summary - 'parties' where id = 'doc-cn-other-invoice'`);

      // A settlement committed after reasoning also invalidates the old
      // remaining-due plan; the invoice lock must protect the sum read.
      await seed.query(`insert into document_credit_applications
        (id, firm_id, client_id, credit_document_id, invoice_document_id, amount, currency)
        values ('review-prior', $1, $2, 'doc-cn-twin-b', 'doc-inv-vihanta-2', 10, 'EUR')`, [FIRM, CLIENT]);
      const changedPrior = await withFirmDbClient(async (client) => {
        await client.query('begin');
        try { return await lockAndRevalidateCreditNotes({ client, firmId: FIRM, invoice: staleInvoice, plan: stalePlan }); }
        finally { await client.query('rollback'); }
      });
      assert.equal(changedPrior.ok, false, 'new prior settlement refuses stale arithmetic');
      assert.equal(changedPrior.invoice_fresh, false);
      await seed.query(`delete from document_credit_applications where id = 'review-prior'`);

      // The credit-only named writer must obey the same entity readiness
      // admission as a bank-linked settlement; a held entity changes nothing.
      await setClientFlagStage(seed, { firmId: FIRM, clientId: CLIENT, flagKey: 'ENTITY_READINESS_ADMISSION',
        stage: 'canary', source: 'manual', reason: 'RT27 blocked writer proof', actorType: 'firm_member', actorId: 'rt27-operator' });
      const applicationsBeforeAdmission = await applications(seed, staleInvoice.id);
      await assert.rejects(withFirmDbClient(async (client) => {
        await client.query('begin');
        try {
          const live = await lockAndRevalidateCreditNotes({ client, firmId: FIRM, invoice: staleInvoice, plan: stalePlan });
          assert.equal(live.ok, true);
          await applyCreditApplicationsWithClient({ client, firmId: FIRM, clientId: CLIENT,
            invoice: staleInvoice, applications: live.applications, settlementMatchId: null });
        } finally { await client.query('rollback'); }
      }), { code: 'ENTITY_READINESS_ADMISSION_BLOCKED' });
      assert.deepEqual(await applications(seed, staleInvoice.id), applicationsBeforeAdmission);
      await setClientFlagStage(seed, { firmId: FIRM, clientId: CLIENT, flagKey: 'ENTITY_READINESS_ADMISSION',
        stage: 'off', source: 'manual', reason: 'RT27 blocked writer proof complete', actorType: 'firm_member', actorId: 'rt27-operator' });

      // 3b. Concurrency: two settlements race for ONE credit; the second waits
      //     on the row lock and then sees it exhausted.
      await insertDocument(seed, { id: 'doc-inv-race-p', customer: 'Kilpa Oy', total: 300, date: '2025-05-01', ref: 'LASKU 2025-040' });
      await insertDocument(seed, { id: 'doc-inv-race-q', customer: 'Kilpa Oy', total: 300, date: '2025-05-02', ref: 'LASKU 2025-041' });
      await insertDocument(seed, { id: 'doc-cn-race', customer: 'Kilpa Oy', total: 200, date: '2025-05-03', ref: 'HYVITYS 2025-020', paymentStatus: 'credit_note' });
      await insertDocAsk(seed, { id: 'ask-race-purpose', documentId: 'doc-cn-race', evidenceType: 'business_purpose', question: 'What was the business purpose of this credit?' });
      const raceInvoices = new Map((await q(seed, `select * from documents where id in ('doc-inv-race-p', 'doc-inv-race-q')`)).map((row) => [row.id, row]));
      const raceInvoice = (id) => raceInvoices.get(id);
      const raceGather = await withFirmDbClient((client) => loadEligibleCreditNotes({ client, firmId: FIRM, clientId: CLIENT, invoice: raceInvoice('doc-inv-race-p') }));
      const raceCredit = raceGather.eligible.find((c) => c.id === 'doc-cn-race');
      const planP = planCreditApplications({ invoice: raceInvoice('doc-inv-race-p'), bankAmount: 100, bankCurrency: 'EUR', selectedIds: ['doc-cn-race'], creditNotes: [raceCredit] });
      const planQ = planCreditApplications({ invoice: raceInvoice('doc-inv-race-q'), bankAmount: 100, bankCurrency: 'EUR', selectedIds: ['doc-cn-race'], creditNotes: [raceCredit] });
      const t1 = new pg.Client({ connectionString: scratchUrl });
      const t2 = new pg.Client({ connectionString: scratchUrl });
      await t1.connect();
      await t2.connect();
      try {
        await t1.query('begin');
        const liveP = await lockAndRevalidateCreditNotes({ client: t1, firmId: FIRM, invoice: raceInvoice('doc-inv-race-p'), plan: planP });
        assert.equal(liveP.ok, true);
        await applyCreditApplicationsWithClient({ client: t1, firmId: FIRM, clientId: CLIENT, invoice: raceInvoice('doc-inv-race-p'), applications: liveP.applications, actorId: 'system' });
        await t2.query('begin');
        const t2Pending = lockAndRevalidateCreditNotes({ client: t2, firmId: FIRM, invoice: raceInvoice('doc-inv-race-q'), plan: planQ });
        const settledFirst = await Promise.race([t2Pending.then(() => 't2'), new Promise((resolve) => setTimeout(() => resolve('blocked'), 300))]);
        assert.equal(settledFirst, 'blocked', 'the second applier waits on the credit row lock');
        await t1.query('commit');
        const liveQ = await t2Pending;
        assert.equal(liveQ.ok, false);
        assert.deepEqual(liveQ.refusals, [{ credit_document_id: 'doc-cn-race', code: CREDIT_REFUSAL_CODES.EXHAUSTED }], 'the credit was consumed by the first settlement');
        await t2.query('rollback');
      } finally {
        await t1.end().catch(() => {});
        await t2.end().catch(() => {});
      }
      assert.equal((await q(seed, `select coalesce(sum(amount), 0)::float8 as s from document_credit_applications where credit_document_id = 'doc-cn-race' and status = 'applied'`))[0].s, 200, 'applied exactly once');
      // A redelivery of the SAME pair at the same amount is idempotent, not a double.
      const redeliver = await withFirmDbClient(async (client) => {
        await client.query('begin');
        try {
          const live = await lockAndRevalidateCreditNotes({ client, firmId: FIRM, invoice: raceInvoice('doc-inv-race-p'), plan: planP });
          assert.equal(live.ok, true);
          assert.equal(live.applications[0].already_applied, true);
          const out = await applyCreditApplicationsWithClient({ client, firmId: FIRM, clientId: CLIENT, invoice: raceInvoice('doc-inv-race-p'), applications: live.applications, actorId: 'system' });
          await client.query('commit');
          return out;
        } catch (e) { await client.query('rollback'); throw e; }
      });
      assert.deepEqual(redeliver.applied, []);
      assert.deepEqual(redeliver.already_applied, ['doc-cn-race']);
      assert.equal((await applications(seed, 'doc-inv-race-p')).length, 1);
      assert.equal((await asksFor(seed, 'doc-cn-race'))[0].status, 'open', 'credit settlement does not answer an existing generic business fact');

      // ══ 4b. Leipomo — a human "no" reverses the application ═══════════
      await insertDocument(seed, { id: 'doc-inv-leipomo', customer: 'Leipomo Aamu Oy', total: 1000, date: '2025-06-02', due: '2025-06-16', ref: 'LASKU 2025-050', cites: ['2025-050'] });
      await insertDocument(seed, { id: 'doc-cn-leipomo', customer: 'Leipomo Aamu Oy', total: 250, date: '2025-06-05', ref: 'HYVITYS 2025-030', cites: ['2025-050'], paymentStatus: 'credit_note' });
      await insertBankLine(seed, { id: 'tx-leipomo', amount: 750, date: '2025-06-20', description: 'LEIPOMO AAMU OY' });
      const leipomo = await runMatcher('doc-inv-leipomo');
      assert.equal(leipomo.credit_notes_applied, 1, JSON.stringify(leipomo));
      const [leipomoMatch] = await matchesFor(seed, 'doc-inv-leipomo');
      assert.equal(leipomoMatch.status, 'auto_matched');
      assert.equal((await docRow(seed, 'doc-inv-leipomo')).payment_status, 'paid');
      await updateReconciliationMatchInDb({ firmId: FIRM, matchId: leipomoMatch.id, patch: { status: 'rejected' }, actorId: 'owner-kari', returnSnapshot: false });
      const leipomoApps = await applications(seed, 'doc-inv-leipomo');
      assert.deepEqual(leipomoApps.map((a) => a.status), ['reversed'], 'the human decision frees the credit');
      assert.equal((await docRow(seed, 'doc-inv-leipomo')).payment_status, 'unpaid');
      const leipomoCredit = await docRow(seed, 'doc-cn-leipomo');
      assert.equal(leipomoCredit.payload.no_line_disposition, undefined, 'the applied holder is cleared');
      assert.notEqual(leipomoCredit.convergence_state, 'auto_reconciled', 'the freed credit note is visible again');
      assert.equal((await audits(seed, 'reconciliation.credit_note_application_reversed')).length, 1);
      const leipomoRerun = await runMatcher('doc-inv-leipomo');
      assert.equal(leipomoRerun.credit_notes_applied || 0, 0, 'the rejected pair is suppressed; nothing re-applies behind the human');
      assert.equal((await applications(seed, 'doc-inv-leipomo')).filter((a) => a.status === 'applied').length, 0);
      const freed = await withFirmDbClient((client) => loadEligibleCreditNotes({ client, firmId: FIRM, clientId: CLIENT, invoice: { id: 'doc-inv-leipomo', customer_name: 'Leipomo Aamu Oy', currency: 'EUR', total_amount: 1000, document_date: '2025-06-02', reference_number: 'LASKU 2025-050', parse_summary: {} } }));
      assert.equal(freed.eligible.find((c) => c.id === 'doc-cn-leipomo')?.remaining, 250, 'fully available again');

      // A deleted credit note releases the credit it applied (the counterpart recomputes).
      await deleteDocumentInDb({ firmId: FIRM, documentId: 'doc-cn-race' });
      assert.equal((await docRow(seed, 'doc-inv-race-p')).payment_status, 'unpaid', 'the invoice no longer reads settled by a credit that is gone');
      assert.equal((await q(seed, `select count(*)::int as n from document_credit_applications where credit_document_id = 'doc-cn-race'`))[0].n, 0, 'the FK cascade took the rows after the reversal receipt');
      assert.equal((await audits(seed, 'reconciliation.credit_note_application_reversed')).length, 2);

      // A high-confidence sibling never supplies authority for a selected
      // credit the model itself says is uncertain.
      await insertDocument(seed, { id: 'doc-inv-mixed-confidence', customer: 'Confidens Oy', total: 1000, date: '2025-07-01', ref: 'INV-700' });
      await insertDocument(seed, { id: 'doc-cn-confident', customer: 'Confidens Oy', total: 600, date: '2025-07-02', ref: 'CN-701', cites: ['INV-700'], paymentStatus: 'credit_note' });
      await insertDocument(seed, { id: 'doc-cn-uncertain', customer: 'Confidens Oy', total: 400, date: '2025-07-03', ref: 'CN-702', cites: ['INV-700'], paymentStatus: 'credit_note' });
      const mixedConfidence = await runMatcher('doc-inv-mixed-confidence');
      assert.equal(mixedConfidence.credit_notes_applied || 0, 0, 'all selected credits must clear confidence');
      assert.deepEqual(await applications(seed, 'doc-inv-mixed-confidence'), []);
      const heldConfidence = (await audits(seed, 'reconciliation.credit_note_application_held')).find((a) => a.resource_id === 'doc-inv-mixed-confidence');
      assert.ok(heldConfidence.metadata.authorization.reasons.includes('below_floor'));
      assert.equal(heldConfidence.metadata.unresolved, true);
      assert.equal(heldConfidence.metadata.owner_reply_supported, false);
      assert.deepEqual(await asksFor(seed, 'doc-inv-mixed-confidence'), [], 'a refused credit-only proposal leaves the generic workflow unchanged');

      // ══ 7b. The drain: an applied credit note is never re-disposed; an
      //        unapplied one retains its existing generic workflow. ══════════
      const drain = await withFirmDbClient((client) => runDocumentDispositionForClient({
        client, firmId: FIRM, clientId: CLIENT, mode: 'act', apiKeyOverride: 'sk-test', fetchImpl: fetchStub,
        documentIds: ['doc-cn-aroma', 'doc-cn-lumo', 'doc-cn-twin-b']
      }));
      assert.equal(drain.evaluated, 1, JSON.stringify(drain));
      assert.equal(drain.auto_explained, 1, 'unapplied incoming documents retain their existing disposition; no purchase-funding question is inferred');
      assert.equal((await docRow(seed, 'doc-cn-aroma')).payload.no_line_disposition.lane, 'credit_note_applied', 'the applied verdict stands');
      assert.deepEqual(await asksFor(seed, 'doc-cn-twin-b'), [], 'no RT-27-specific question is substituted for the generic disposition');
      assert.notEqual((await docRow(seed, 'doc-cn-twin-b')).payload.no_line_disposition?.lane, 'credit_note_applied');
      assert.equal((await q(seed, `select count(*)::int as n from client_evidence_requests where request_payload->>'lane' = 'credit_note_application'`))[0].n, 0);

    } finally {
      await __endFirmDbPoolForTests().catch(() => {});
      for (const [k, v] of Object.entries(prior)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
      await stop();
    }
  }
);
