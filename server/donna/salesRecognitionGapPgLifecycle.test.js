// FI-09 pilot minimum — the real-PostgreSQL proof on the current migration
// chain: no uploaded unpaid sales invoice is silently absent from the books,
// the ALV draft or the financial statements of an accrual book.
//
//   1. Lumikki 1002 (Kultalanka CG-1: 720,00 + 183,60 ALV, 12.2.2025, unpaid)
//      runs through the real Jev reconciliation path (decision stubbed to the
//      scoped negative, as jevReconciliation.test.js does). The runtime records
//      the open obligation AND puts it on the owner through the canonical
//      doc-anchored payment-method ask; the document projects on_owner, and a
//      second pass never asks twice.
//   2. The ALV return read (FINLAND_ALV_RETURN) keeps its posted-ledger boxes,
//      names every excluded document with its totals, and blocks: needs_review
//      with unrecognized_sales_documents. The filing start escalates instead of
//      drafting a return.
//   3. The financial statements' draft verdict carries the same exclusion.
//   4. Neighbours that ARE represented stay out: paid and posted inside the
//      period, an issued-invoice twin, a duplicate upload, another period. A
//      payment posted in March leaves the February invoice listed.
//   5. A cash-basis book is unchanged: no exclusion, no ask, no blocker.
// The Jev decision is a deterministic stub; this proves the runtime wiring
// and the read models, not model judgment. Skips without DONNA_PG_TEST_URL.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

import { __jevReconciliation } from './jevReconciliation.js';
import { readJevCase } from './jevPreview.js';
import { runSalesInvoiceReconciliationLlmForDocument } from './salesInvoiceReconciliationLlm.js';
import { runSupplierBillReconciliationLlmForDocument } from './supplierBillReconciliationLlm.js';
import { withFirmDbClient, __endFirmDbPoolForTests, getFinancialReportFromDb } from './firmDb.js';
import { getFinlandAlvReturnFromDb, startFinlandAlvReturnFilingInDb } from './finland/statutoryDb.js';
import { computeConvergenceForDocuments } from './reconcileConvergenceState.js';
import { setClientFlagStage } from './clientConfig.js';
import { requestDonnaApi } from './testSupport/apiSeamHarness.js';

const PG_URL = process.env.DONNA_PG_TEST_URL || '';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const FIRM = 'firm-fi09';
const ACCRUAL = 'client-fi09-accrual';
const CASH = 'client-fi09-cash';

const boot = async () => {
  const dbName = `donna_fi09_${Date.now().toString(36)}_${process.pid}`;
  const admin = new pg.Client({ connectionString: PG_URL });
  await admin.connect();
  await admin.query(`create database "${dbName}"`);
  const url = new URL(PG_URL); url.pathname = `/${dbName}`;
  const seed = new pg.Client({ connectionString: url.toString() });
  await seed.connect();
  const supabaseOnly = new Set(['010_evidence_object_storage.sql', '032_lock_down_public_rls.sql', '060_procountor_api_key.sql']);
  const files = (await readdir(path.join(ROOT, 'db', 'migrations'))).filter((f) => f.endsWith('.sql') && !supabaseOnly.has(f)).sort();
  for (const file of files) await seed.query(await readFile(path.join(ROOT, 'db', 'migrations', file), 'utf8'));
  await seed.query(`insert into firms (id, name, slug, jurisdiction, default_currency) values ($1, 'FI-09 Firm', 'fi09-firm', 'FI', 'EUR')`, [FIRM]);
  for (const [id, basis] of [[ACCRUAL, 'accrual'], [CASH, 'cash']]) {
    await seed.query(`insert into clients (id, firm_id, company_name, jurisdiction, entity_type, status, profile) values ($1, $2, $3, 'fi', 'fi-oy', 'active', $4)`,
      [id, FIRM, `Kampaamo ${basis} Oy`, { jurisdiction: 'fi', accounting_system: 'none', accounting_basis: basis }]);
    for (const flagKey of ['FINLAND_ALV_RETURN', 'FINLAND_ALV_CODING', 'DOCUMENT_NO_LINE_DISPOSITION', 'JEV_RECONCILIATION']) {
      await setClientFlagStage(seed, { firmId: FIRM, clientId: id, flagKey, stage: 'auto', source: 'default', reason: 'fi09 proof' });
    }
  }
  return { seed, url: url.toString(), stop: async () => {
    await seed.end().catch(() => {});
    await admin.query(`drop database if exists "${dbName}" with (force)`).catch(() => {});
    await admin.end().catch(() => {});
  } };
};

const insertDocument = (seed, { id, clientId = ACCRUAL, total, tax, date, number, customer = 'Lumikki Oy', paymentStatus = 'unpaid', duplicateOf = null }) => seed.query(
  `insert into documents (id, firm_id, client_id, filename, document_type, status, parse_status, customer_name, total_amount, tax_amount, currency,
                          document_date, reference_number, payment_status, duplicate_of, parse_summary, payload)
   values ($1, $2, $3, $4, 'sales_invoice', 'received', 'completed', $5, $6, $7, 'EUR', $8, $9, $10, $11, $12::jsonb, '{}'::jsonb)`,
  [id, FIRM, clientId, `${id}.pdf`, customer, total, tax, date, number, paymentStatus, duplicateOf,
    JSON.stringify({ references: [{ type: 'invoice_number', value: number }] })]);
// A settlement already decided and posted (or not) by the existing writers:
// the census reads persisted rows, so the neighbours are seeded in their end state.
const settle = async (seed, { documentId, txId, date, amount, journalDate = null, status = 'auto_matched' }) => {
  await seed.query(`insert into transactions (id, firm_id, client_id, transaction_date, description, money_in, money_out, currency, status, payload)
    values ($1, $2, $3, $4, $1, $5, 0, 'EUR', 'needs_review', '{}'::jsonb)`, [txId, FIRM, ACCRUAL, date, amount]);
  await seed.query(`insert into reconciliation_matches (id, firm_id, client_id, bank_transaction_id, matched_object_type, matched_object_id, status, match_amount, payload)
    values ($1, $2, $3, $4, 'sales_invoice', $5, $6, $7, '{}'::jsonb)`, [`m-${txId}`, FIRM, ACCRUAL, txId, documentId, status, amount]);
  if (journalDate) await journal(seed, { sourceType: 'transaction', sourceId: txId, date: journalDate });
};
const journal = (seed, { sourceType, sourceId, date }) => seed.query(
  `insert into ledger_journals (id, firm_id, client_id, source_type, source_id, journal_date, currency, status, posted_at)
   values ($1, $2, $3, $4, $5, $6, 'EUR', 'posted', now())`, [`lj-${sourceType}-${sourceId}`, FIRM, ACCRUAL, sourceType, sourceId, date]);

const noSettlement = async (args) => {
  const mapped = await readJevCase({ ...args, evidenceOnly: true });
  return { document: mapped.sourceDocument, candidates: mapped.candidates, consumed_evidence: mapped.caseEvidence,
    evidence_packet_sha256: mapped.caseEvidence.packet_sha256,
    decision: { terminal: 'no_settlement', probability: 0.7, plan: { terminal: 'no_settlement' }, refusals: [] }, model: 'fixture-jev' };
};
const runJev = (clientId, documentId) => withFirmDbClient((client) => runSalesInvoiceReconciliationLlmForDocument({
  client, firmId: FIRM, clientId, documentId, fetchImpl: async () => { throw new Error('legacy provider must not be called'); } }));
const asksFor = (seed, documentId) => seed.query(`select id, status, evidence_type, audience, question, request_payload from client_evidence_requests
  where firm_id = $1 and request_payload->>'document_id' = $2 order by created_at`, [FIRM, documentId]).then((r) => r.rows);

test('real PG (FI-09): an uploaded unpaid sales invoice is asked of the owner and named in the ALV and statement drafts; represented neighbours and cash books are unchanged',
  { skip: !PG_URL && 'DONNA_PG_TEST_URL not set', timeout: 300_000 }, async () => {
    const { seed, url, stop } = await boot();
    const prior = { DATABASE_URL: process.env.DATABASE_URL, DATABASE_POOL_MAX: process.env.DATABASE_POOL_MAX };
    const priorDecide = __jevReconciliation.decide;
    process.env.DATABASE_URL = url; process.env.DATABASE_POOL_MAX = '3';
    __jevReconciliation.decide = noSettlement;
    try {
      // A book with nothing uploaded: the ALV read is ready (a nil return).
      const empty = await getFinlandAlvReturnFromDb({ firmId: FIRM, clientId: ACCRUAL, period: '2025-02' });
      assert.equal(empty.review.status, 'ready'); assert.deepEqual(empty.review.blockers, []);

      // ── 1. Lumikki 1002 through the real Jev path ──────────────────────────
      await insertDocument(seed, { id: 'doc-lumikki', total: 903.6, tax: 183.6, date: '2025-02-12', number: '1002' });
      const first = await runJev(ACCRUAL, 'doc-lumikki');
      assert.equal(first.jev_reason, 'jev_no_settlement', JSON.stringify(first));
      assert.equal(first.sales_recognition_ask.minted, true, JSON.stringify(first.sales_recognition_ask));
      let asks = await asksFor(seed, 'doc-lumikki');
      assert.equal(asks.length, 1);
      assert.deepEqual([asks[0].status, asks[0].evidence_type, asks[0].audience, asks[0].request_payload.lane],
        ['draft', 'payment_method', 'client', 'sales_invoice_recognition']);
      // A Finnish book: the owner is asked in Finnish.
      assert.match(asks[0].question, /^Myyntilasku 1002 \(Lumikki Oy, 903,60 EUR, päivätty 12\.2\.2025\)/);
      const [converged] = await withFirmDbClient((client) => computeConvergenceForDocuments(client, { firmId: FIRM, documentIds: ['doc-lumikki'] }));
      assert.equal(converged.derived.state, 'on_owner', JSON.stringify(converged));
      const second = await runJev(ACCRUAL, 'doc-lumikki');
      assert.ok(!second.sales_recognition_ask?.minted, JSON.stringify(second));
      assert.equal((await asksFor(seed, 'doc-lumikki')).length, 1, 'the same invoice is never asked twice');

      // ── 4. Neighbours ───────────────────────────────────────────────────────
      await insertDocument(seed, { id: 'doc-aroma', customer: 'Aroma Oy', total: 2008, tax: 408, date: '2025-02-03', number: '1001' });
      await settle(seed, { documentId: 'doc-aroma', txId: 'tx-aroma', date: '2025-02-20', amount: 2008, journalDate: '2025-02-20' });
      await insertDocument(seed, { id: 'doc-late', customer: 'Myöhä Oy', total: 251, tax: 51, date: '2025-02-25', number: '1004' });
      await settle(seed, { documentId: 'doc-late', txId: 'tx-late', date: '2025-03-05', amount: 251, journalDate: '2025-03-05' });
      await insertDocument(seed, { id: 'doc-issued', customer: 'Kuura Oy', total: 125.5, tax: 25.5, date: '2025-02-10', number: 'INV-2025-007' });
      await journal(seed, { sourceType: 'sales_invoice', sourceId: 'INV-2025-007', date: '2025-02-10' });
      await insertDocument(seed, { id: 'doc-lumikki-copy', total: 903.6, tax: 183.6, date: '2025-02-12', number: '1002', duplicateOf: 'doc-lumikki' });
      await insertDocument(seed, { id: 'doc-march', customer: 'Maalis Oy', total: 502, tax: 102, date: '2025-03-02', number: '1005' });

      // ── 2. The ALV draft ────────────────────────────────────────────────────
      const alv = await getFinlandAlvReturnFromDb({ firmId: FIRM, clientId: ACCRUAL, period: '2025-02' });
      assert.equal(alv.review.status, 'needs_review');
      assert.ok(alv.review.blockers.includes('unrecognized_sales_documents'), JSON.stringify(alv.review.blockers));
      const gap = alv.review.unrecognizedSales;
      assert.deepEqual(gap.items.map((i) => [i.document_id, i.rests, i.net, i.tax, i.on_nobody]),
        [['doc-lumikki', 'no_settlement', 720, 183.6, false], ['doc-late', 'settled_outside_period', 200, 51, true]]);
      assert.deepEqual(gap.totals, [{ currency: 'EUR', count: 2, gross: 1154.6, net: 920, tax: 234.6, tax_unknown_count: 0 }]);
      assert.match(gap.statement, /2 uploaded sales documents are not recognised .* 920\.00 EUR net \+ 234\.60 tax/);
      // The boxes are unchanged posted-ledger arithmetic: no invented output tax.
      assert.deepEqual(alv.alvReturn, empty.alvReturn);
      // March reads its own invoice, not February's.
      const march = await getFinlandAlvReturnFromDb({ firmId: FIRM, clientId: ACCRUAL, period: '2025-03' });
      assert.deepEqual(march.review.unrecognizedSales.items.map((i) => i.document_id), ['doc-march']);

      // The filing start escalates on the blocker instead of drafting a return.
      await setClientFlagStage(seed, { firmId: FIRM, clientId: ACCRUAL, flagKey: 'FINLAND_ALV_FILING', stage: 'auto', source: 'manual', reason: 'fi09 proof' });
      const started = await startFinlandAlvReturnFilingInDb({ firmId: FIRM, clientId: ACCRUAL, period: '2025-02', actorId: 'fi09-test',
        deliverAsksImpl: async () => ({ skipped: true }), scopeDriftImpl: async () => null });
      assert.equal(started.action, 'escalated', JSON.stringify(started));
      assert.ok(started.blockers.includes('unrecognized_sales_documents'));
      assert.match(started.ask.question, /2 ladattua myyntilaskua tai hyvityslaskua/);

      // ── 3. The financial statements ────────────────────────────────────────
      const report = await getFinancialReportFromDb({ firmId: FIRM, clientId: ACCRUAL, periodStart: '2025-02-01', periodEnd: '2025-02-28' });
      const reason = report.draft.reasons.find((r) => r.code === 'unrecognized_sales_documents');
      assert.ok(reason, JSON.stringify(report.draft.reasons));
      assert.equal(reason.count, 2); assert.deepEqual(reason.document_ids, ['doc-lumikki', 'doc-late']);
      assert.equal(report.draft.is_draft, true);

      // ── 5. Cash basis: unchanged ───────────────────────────────────────────
      await insertDocument(seed, { id: 'doc-cash-lumikki', clientId: CASH, total: 903.6, tax: 183.6, date: '2025-02-12', number: '1002' });
      const cashRun = await runJev(CASH, 'doc-cash-lumikki');
      assert.equal(cashRun.jev_reason, 'jev_no_settlement');
      assert.equal(cashRun.sales_recognition_ask.minted, false); assert.equal(cashRun.sales_recognition_ask.reason, 'not_accrual');
      assert.deepEqual(await asksFor(seed, 'doc-cash-lumikki'), []);
      const cashAlv = await getFinlandAlvReturnFromDb({ firmId: FIRM, clientId: CASH, period: '2025-02' });
      assert.equal(cashAlv.review.status, 'ready'); assert.equal(cashAlv.review.unrecognizedSales, undefined);
      const cashReport = await getFinancialReportFromDb({ firmId: FIRM, clientId: CASH, periodStart: '2025-02-01', periodEnd: '2025-02-28' });
      assert.equal(cashReport.draft.reasons.some((r) => r.code === 'unrecognized_sales_documents'), false);

      // The doc-ask lane staged down: the census still names the invoice, no ask.
      await setClientFlagStage(seed, { firmId: FIRM, clientId: ACCRUAL, flagKey: 'DOCUMENT_NO_LINE_DISPOSITION', stage: 'off', source: 'manual', reason: 'fi09 proof' });
      await insertDocument(seed, { id: 'doc-dark', customer: 'Pimeä Oy', total: 100.4, tax: 20.4, date: '2025-02-14', number: '1006' });
      const dark = await runJev(ACCRUAL, 'doc-dark');
      assert.equal(dark.sales_recognition_ask.reason, 'flag_off');
      assert.deepEqual(await asksFor(seed, 'doc-dark'), []);
      const darkAlv = await getFinlandAlvReturnFromDb({ firmId: FIRM, clientId: ACCRUAL, period: '2025-02' });
      assert.equal(darkAlv.review.unrecognizedSales.items.find((i) => i.document_id === 'doc-dark').on_nobody, true);
    } finally {
      __jevReconciliation.decide = priorDecide;
      await __endFirmDbPoolForTests().catch(() => {});
      for (const [k, v] of Object.entries(prior)) { if (v == null) delete process.env[k]; else process.env[k] = v; }
      await stop();
    }
  });

const insertBill = (seed, { id, clientId = ACCRUAL, total, tax, date, number, vendor = 'Tukku Oy', paymentStatus = 'unpaid' }) => seed.query(
  `insert into documents (id, firm_id, client_id, filename, document_type, status, parse_status, vendor_name, total_amount, tax_amount, currency,
                          document_date, reference_number, payment_status, parse_summary, payload)
   values ($1, $2, $3, $4, 'supplier_bill', 'received', 'completed', $5, $6, $7, 'EUR', $8, $9, $10, $11::jsonb, '{}'::jsonb)`,
  [id, FIRM, clientId, `${id}.pdf`, vendor, total, tax, date, number, paymentStatus,
    JSON.stringify({ references: [{ type: 'invoice_number', value: number }] })]);
const runBill = (clientId, documentId) => withFirmDbClient((client) => runSupplierBillReconciliationLlmForDocument({
  client, firmId: FIRM, clientId, documentId, fetchImpl: async () => { throw new Error('legacy provider must not be called'); } }));

test('real PG: an uploaded unpaid supplier bill on an accrual book is asked of the owner once and then waits on them; cash books are unchanged and a supplier credit note is asked as a credit note',
  { skip: !PG_URL && 'DONNA_PG_TEST_URL not set', timeout: 300_000 }, async () => {
    const { seed, url, stop } = await boot();
    const prior = { DATABASE_URL: process.env.DATABASE_URL, DATABASE_POOL_MAX: process.env.DATABASE_POOL_MAX };
    const priorDecide = __jevReconciliation.decide;
    process.env.DATABASE_URL = url; process.env.DATABASE_POOL_MAX = '3';
    __jevReconciliation.decide = noSettlement;
    try {
      // Before the fix this verdict projected hanging / no_settlement_in_scope with nobody asked.
      await insertBill(seed, { id: 'bill-tukku', total: 248, tax: 48, date: '2025-02-05', number: '4711' });
      const first = await runBill(ACCRUAL, 'bill-tukku');
      assert.equal(first.jev_reason, 'jev_no_settlement', JSON.stringify(first));
      assert.equal(first.supplier_bill_settlement_ask.minted, true, JSON.stringify(first.supplier_bill_settlement_ask));
      assert.equal(first.sales_recognition_ask, undefined);
      const asks = await asksFor(seed, 'bill-tukku');
      assert.equal(asks.length, 1);
      assert.deepEqual([asks[0].status, asks[0].evidence_type, asks[0].audience, asks[0].request_payload.lane],
        ['draft', 'payment_method', 'client', 'supplier_bill_settlement']);
      assert.match(asks[0].question, /^Ostolasku 4711 \(Tukku Oy, 248,00 EUR, päivätty 5\.2\.2025\): .*Onko lasku maksettu\?/);
      const [converged] = await withFirmDbClient((client) => computeConvergenceForDocuments(client, { firmId: FIRM, documentIds: ['bill-tukku'] }));
      assert.equal(converged.derived.state, 'on_owner', JSON.stringify(converged));

      const second = await runBill(ACCRUAL, 'bill-tukku');
      assert.ok(!second.supplier_bill_settlement_ask?.minted, JSON.stringify(second));
      assert.equal((await asksFor(seed, 'bill-tukku')).length, 1, 'the same bill is never asked twice');

      // A supplier credit note is not an unpaid bill: it is asked as a credit
      // note (deducted, refunded or still open), never as "has it been paid".
      await insertBill(seed, { id: 'bill-credit', total: -62, tax: -12, date: '2025-02-09', number: 'HL-12', paymentStatus: 'credit_note' });
      const credit = await runBill(ACCRUAL, 'bill-credit');
      assert.equal(credit.supplier_bill_settlement_ask?.minted, true, JSON.stringify(credit));
      const creditAsks = await asksFor(seed, 'bill-credit');
      assert.deepEqual(creditAsks.map((a) => [a.request_payload.lane, a.request_payload.recognition]),
        [['supplier_bill_settlement', 'unrecorded_uploaded_supplier_credit_note']]);
      assert.match(creditAsks[0].question, /^Ostohyvityslasku HL-12 \(Tukku Oy, 62,00 EUR, päivätty 9\.2\.2025\): /);
      assert.doesNotMatch(creditAsks[0].question, /Onko lasku maksettu/);

      // Cash basis: unchanged, the bill is recorded when it is paid.
      await insertBill(seed, { id: 'bill-cash', clientId: CASH, total: 248, tax: 48, date: '2025-02-05', number: '4711' });
      const cashRun = await runBill(CASH, 'bill-cash');
      assert.equal(cashRun.jev_reason, 'jev_no_settlement');
      assert.equal(cashRun.supplier_bill_settlement_ask.reason, 'not_accrual');
      assert.deepEqual(await asksFor(seed, 'bill-cash'), []);
    } finally {
      __jevReconciliation.decide = priorDecide;
      await __endFirmDbPoolForTests().catch(() => {});
      for (const [k, v] of Object.entries(prior)) { if (v == null) delete process.env[k]; else process.env[k] = v; }
      await stop();
    }
  });

// The purchase side of the census through the real route: GET
// /reports/finland-alv-return on PostgreSQL with one unpaid sales invoice and
// one unpaid supplier bill in February, and a paid, posted supplier bill as the
// neighbour that IS represented (its input ALV is in box 307, not in the
// exclusions). The sales and purchase exclusions are separate blockers; the
// statements and the filing start carry both; a cash book lists neither.
const account = (seed, { id, code, name, type, clientId = ACCRUAL }) => seed.query(
  `insert into ledger_accounts (id, firm_id, client_id, code, name, account_type, normal_balance, currency)
   values ($1, $2, $3, $4, $5, $6, $7, 'EUR')`, [id, FIRM, clientId, code, name, type, ['asset', 'expense'].includes(type) ? 'debit' : 'credit']);
const line = (seed, { journalId, no, accountId, code, debit = 0, credit = 0, tax = null, role = null }) => seed.query(
  `insert into ledger_lines (id, journal_id, firm_id, client_id, account_id, account_code, line_no, direction, debit, credit, amount, currency, tax_type, payload)
   values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'EUR', $12, $13::jsonb)`,
  [`${journalId}-${no}`, journalId, FIRM, ACCRUAL, accountId, code, no, debit ? 'debit' : 'credit', debit, credit, debit || credit, tax, JSON.stringify(role ? { role } : {})]);

test('real PG route: the ALV draft names the unpaid supplier bill apart from the unpaid sales invoice; a paid bill is in the figures, not the exclusions',
  { skip: !PG_URL && 'DONNA_PG_TEST_URL not set', timeout: 300_000 }, async () => {
    const { seed, url, stop } = await boot();
    const prior = { DATABASE_URL: process.env.DATABASE_URL, DATABASE_POOL_MAX: process.env.DATABASE_POOL_MAX, DONNA_ACCESS_TOKEN: process.env.DONNA_ACCESS_TOKEN };
    process.env.DATABASE_URL = url; process.env.DATABASE_POOL_MAX = '3'; process.env.DONNA_ACCESS_TOKEN = 'fi09-purchase-route';
    const routePool = new pg.Pool({ connectionString: url, max: 3 });
    const alvRoute = async (clientId, period = '2025-02') => {
      const response = await requestDonnaApi({ url: `/api/donna/firms/reports/finland-alv-return?firm_id=${FIRM}&client_id=${clientId}&period=${period}`,
        headers: { authorization: 'Bearer fi09-purchase-route' }, pool: routePool });
      assert.equal(response.statusCode, 200, response.body);
      return response.json;
    };
    try {
      const empty = await alvRoute(ACCRUAL);
      assert.equal(empty.review.status, 'ready');

      await insertDocument(seed, { id: 'doc-lumikki', total: 903.6, tax: 183.6, date: '2025-02-12', number: '1002' });
      await insertBill(seed, { id: 'bill-tukku', total: 248, tax: 48, date: '2025-02-05', number: '4711' });
      // The neighbour: a supplier bill paid and posted inside February through
      // its bank line, ALV split to 2940 as the posting writer does.
      await insertBill(seed, { id: 'bill-kahvi', vendor: 'Kahvi Oy', total: 125.5, tax: 25.5, date: '2025-02-07', number: 'K-88', paymentStatus: 'paid' });
      await seed.query(`insert into transactions (id, firm_id, client_id, transaction_date, description, money_in, money_out, currency, status, payload)
        values ('tx-kahvi', $1, $2, '2025-02-10', 'Kahvi Oy', 0, 125.5, 'EUR', 'posted', '{}'::jsonb)`, [FIRM, ACCRUAL]);
      await seed.query(`insert into reconciliation_matches (id, firm_id, client_id, bank_transaction_id, matched_object_type, matched_object_id, status, match_amount, payload)
        values ('m-kahvi', $1, $2, 'tx-kahvi', 'supplier_bill', 'bill-kahvi', 'confirmed', 125.5, '{}'::jsonb)`, [FIRM, ACCRUAL]);
      await journal(seed, { sourceType: 'transaction', sourceId: 'tx-kahvi', date: '2025-02-10' });
      await account(seed, { id: 'acct-1910', code: '1910', name: 'Pankkitili', type: 'asset' });
      await account(seed, { id: 'acct-4000', code: '4000', name: 'Ostot', type: 'expense' });
      await account(seed, { id: 'acct-2940', code: '2940', name: 'Arvonlisäverosaamiset', type: 'liability' });
      const jid = 'lj-transaction-tx-kahvi';
      await line(seed, { journalId: jid, no: 1, accountId: 'acct-4000', code: '4000', debit: 100, tax: 'ALV_25_5_INPUT' });
      await line(seed, { journalId: jid, no: 2, accountId: 'acct-2940', code: '2940', debit: 25.5, role: 'alv_input_deductible' });
      await line(seed, { journalId: jid, no: 3, accountId: 'acct-1910', code: '1910', credit: 125.5 });
      // A supplier credit note against the unpaid bill, also unsettled: it
      // reduces the excluded purchase, never counted twice.
      await insertBill(seed, { id: 'bill-tukku-cn', total: -62, tax: -12, date: '2025-02-09', number: 'HL-12', paymentStatus: 'credit_note' });
      // A March bill is March's, not February's.
      await insertBill(seed, { id: 'bill-march', vendor: 'Maalis Tukku Oy', total: 62, tax: 12, date: '2025-03-03', number: 'M-1' });

      const alv = await alvRoute(ACCRUAL);
      assert.equal(alv.review.status, 'needs_review');
      assert.deepEqual(alv.review.blockers, ['unrecognized_sales_documents', 'unrecognized_purchase_documents']);
      // The paid bill is in the figures: box 307 carries its input ALV.
      assert.equal(alv.alvReturn.boxes['307'], 25.5);
      // Sales and purchases are separate lists with their own sentences.
      assert.deepEqual(alv.review.unrecognizedSales.items.map((i) => i.document_id), ['doc-lumikki']);
      const purchases = alv.review.unrecognizedPurchases;
      assert.equal(purchases.side, 'purchase');
      assert.deepEqual(purchases.items.map((i) => [i.document_id, i.kind, i.vendor, i.net, i.tax, i.rests]),
        [['bill-tukku', 'invoice', 'Tukku Oy', 200, 48, 'no_settlement'], ['bill-tukku-cn', 'credit_note', 'Tukku Oy', -50, -12, 'no_settlement']]);
      assert.deepEqual(purchases.represented, [{ document_id: 'bill-kahvi', by: 'settlement_journal' }]);
      assert.deepEqual(purchases.totals, [{ currency: 'EUR', count: 2, gross: 186, net: 150, tax: 36, tax_unknown_count: 0 }]);
      assert.equal(purchases.statement, '2 uploaded supplier documents are not recognised in this period\'s posted ledger and are excluded from these figures: 150.00 EUR expense + 36.00 input tax.');
      // Reconciliation: posted input ALV + named purchase exclusions account for every February supplier document.
      const februaryBillTax = (await seed.query(`select sum(case when payment_status = 'credit_note' then -abs(tax_amount) else abs(tax_amount) end)::float8 as t
        from documents where client_id = $1 and document_type = 'supplier_bill' and document_date between '2025-02-01' and '2025-02-28'`, [ACCRUAL])).rows[0].t;
      assert.equal(Math.round((alv.alvReturn.boxes['307'] + purchases.totals[0].tax) * 100) / 100, februaryBillTax);
      assert.equal(purchases.items.length + purchases.represented.length, 3);
      const march = await alvRoute(ACCRUAL, '2025-03');
      assert.deepEqual(march.review.unrecognizedPurchases.items.map((i) => i.document_id), ['bill-march']);
      assert.equal(march.review.unrecognizedSales, undefined);

      // The filing start escalates with both blockers, each counted on its own.
      await setClientFlagStage(seed, { firmId: FIRM, clientId: ACCRUAL, flagKey: 'FINLAND_ALV_FILING', stage: 'auto', source: 'manual', reason: 'fi09 proof' });
      const started = await startFinlandAlvReturnFilingInDb({ firmId: FIRM, clientId: ACCRUAL, period: '2025-02', actorId: 'fi09-test',
        deliverAsksImpl: async () => ({ skipped: true }), scopeDriftImpl: async () => null });
      assert.equal(started.action, 'escalated');
      assert.deepEqual(started.blockers, ['unrecognized_sales_documents', 'unrecognized_purchase_documents']);
      assert.match(started.ask.question, /1 ladattua myyntilaskua tai hyvityslaskua/);
      assert.match(started.ask.question, /2 ladattua ostolaskua tai ostohyvityslaskua .* kulut ja vähennettävä ALV puuttuvat/);

      // The financial statements: a reason per side.
      const report = await getFinancialReportFromDb({ firmId: FIRM, clientId: ACCRUAL, periodStart: '2025-02-01', periodEnd: '2025-02-28' });
      const byCode = Object.fromEntries(report.draft.reasons.map((r) => [r.code, r]));
      assert.deepEqual(byCode.unrecognized_sales_documents.document_ids, ['doc-lumikki']);
      assert.deepEqual(byCode.unrecognized_purchase_documents.document_ids, ['bill-tukku', 'bill-tukku-cn']);
      assert.match(byCode.unrecognized_purchase_documents.detail, /150\.00 EUR expense \+ 36\.00 input tax/);

      // Cash basis: unchanged, no purchase exclusion.
      await insertBill(seed, { id: 'bill-cash', clientId: CASH, total: 248, tax: 48, date: '2025-02-05', number: '4711' });
      const cashAlv = await alvRoute(CASH);
      assert.equal(cashAlv.review.status, 'ready');
      assert.equal(cashAlv.review.unrecognizedPurchases, undefined);
      const cashReport = await getFinancialReportFromDb({ firmId: FIRM, clientId: CASH, periodStart: '2025-02-01', periodEnd: '2025-02-28' });
      assert.equal(cashReport.draft.reasons.some((r) => r.code === 'unrecognized_purchase_documents'), false);
    } finally {
      await routePool.end().catch(() => {});
      await __endFirmDbPoolForTests().catch(() => {});
      for (const [k, v] of Object.entries(prior)) { if (v == null) delete process.env[k]; else process.env[k] = v; }
      await stop();
    }
  });

// "Still unpaid" is an answer, not an unclear reply. Both no-settlement lanes
// invite it; the owner replies it through the real reply route (the inline
// leg, then the owner-reply clock); the model, scripted to follow the
// instructions it is given, reads it. The ask stays on the owner, re-asks
// later on the normal clock, and closes when the payment posts. The other
// answers keep their consequences.
const STILL_OPEN_REPLIES = new Set(['still unpaid', 'vielä maksamatta', 'ei oo vielä maksettu', "Not paid yet, they're late"]);
const scriptedOwnerReplyModel = (calls) => async (endpoint, init) => {
  assert.equal(endpoint, 'https://api.anthropic.com/v1/messages');
  const body = JSON.parse(init.body);
  const prompt = body.messages.map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content))).join('\n');
  const reply = /The owner answered: "([^"]*)"/.exec(prompt)?.[1] || '';
  calls.push({ reply, offered: /"obligation_open"/.test(String(body.system || '')) });
  const base = { materiality: 'material', expense_kind: 'unknown', funding_source: 'unknown', confidence: 0.9, reasoning: 'Scripted read of the owner answer.' };
  const verdict = STILL_OPEN_REPLIES.has(reply)
    // A model with no "still unpaid" outcome on offer can only call it unclear.
    ? (calls.at(-1).offered ? { ...base, disposition: 'obligation_open', settlement_channel: 'unknown' }
      : { ...base, disposition: 'needs_human', settlement_channel: 'unknown', confidence: 0.4 })
    : /käteisellä|in cash/i.test(reply) ? { ...base, disposition: 'auto_explain', settlement_channel: 'cash', funding_source: 'owner' }
      : /yritystililtä|business account/i.test(reply) ? { ...base, disposition: 'chase_evidence', settlement_channel: 'uncovered_account' }
        : { ...base, disposition: 'needs_human', settlement_channel: 'unknown', confidence: 0.3 };
  return { ok: true, status: 200, json: async () => ({ id: `msg-${calls.length}`, type: 'message', role: 'assistant', model: 'fixture-model',
    content: [{ type: 'text', text: JSON.stringify(verdict) }], stop_reason: 'end_turn', usage: { input_tokens: 0, output_tokens: 0 } }) };
};

test('real PG: "still unpaid" to an unpaid sales invoice or supplier bill keeps the ask on the owner, re-asks later and closes on payment; other answers unchanged',
  { skip: !PG_URL && 'DONNA_PG_TEST_URL not set', timeout: 300_000 }, async (t) => {
    const { seed, url, stop } = await boot();
    const prior = { DATABASE_URL: process.env.DATABASE_URL, DATABASE_POOL_MAX: process.env.DATABASE_POOL_MAX, ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY };
    process.env.DATABASE_URL = url; process.env.DATABASE_POOL_MAX = '3'; process.env.ANTHROPIC_API_KEY = 'test-still-unpaid';
    const calls = [];
    t.mock.method(globalThis, 'fetch', scriptedOwnerReplyModel(calls));
    const { ensureNoSettlementAskWithClient } = await import('./salesRecognitionGap.js');
    const { resolveClientEvidenceRequestInDb } = await import('./firmDb.js');
    const { recoverOwnerRepliesInDb } = await import('./ownerReplyRecovery.js');
    const { runAskReaskSweep } = await import('./askReaskCadence.js');
    const { resolveOpenSettlementRequestsForDocument } = await import('./db/asks.js');
    try {
      const EN = 'client-fi09-accrual-en';
      await seed.query(`insert into clients (id, firm_id, company_name, jurisdiction, entity_type, status, profile) values ($1, $2, 'Studio English Oy', 'fi', 'fi-oy', 'active', $3)`,
        [EN, FIRM, { jurisdiction: 'fi', locale: 'en', accounting_system: 'none', accounting_basis: 'accrual' }]);
      for (const clientId of [ACCRUAL, EN]) {
        await setClientFlagStage(seed, { firmId: FIRM, clientId, flagKey: 'DOCUMENT_NO_LINE_DISPOSITION', stage: 'auto', source: 'default', reason: 'still unpaid proof' });
        await setClientFlagStage(seed, { firmId: FIRM, clientId, flagKey: 'ASK_REASK_CADENCE', stage: 'auto', source: 'manual', reason: 'still unpaid proof' });
        // The strong reply reader, so the scripted model sees the lane's instructions.
        await setClientFlagStage(seed, { firmId: FIRM, clientId, flagKey: 'JEV_RECONCILIATION', stage: 'off', source: 'manual', reason: 'still unpaid proof' });
      }
      // One uploaded document per case, its question minted by the real hook and sent once a day ago.
      const mint = async ({ id, clientId, type, number }) => {
        if (type === 'sales_invoice') await insertDocument(seed, { id, clientId, total: 903.6, tax: 183.6, date: '2025-02-12', number });
        else await insertBill(seed, { id, clientId, total: 248, tax: 48, date: '2025-02-05', number });
        const minted = await withFirmDbClient((client) => ensureNoSettlementAskWithClient({ client, firmId: FIRM, clientId, documentId: id, documentType: type }));
        assert.equal(minted.minted, true, JSON.stringify(minted));
        await seed.query(`update client_evidence_requests set status = 'open', send_count = 1, first_sent_at = now() - interval '1 day',
          last_sent_at = now() - interval '1 day', due_at = now() + interval '6 days' where id = $1`, [minted.evidence_request_id]);
        return minted.evidence_request_id;
      };
      const ask = async (askId) => (await seed.query('select * from client_evidence_requests where id = $1', [askId])).rows[0];
      const reply = (askId, text) => resolveClientEvidenceRequestInDb({ firmId: FIRM, evidenceRequestId: askId, reply: text, actorId: 'owner-still-unpaid', actorType: 'client' });
      const projection = async (documentId) => (await withFirmDbClient((client) => computeConvergenceForDocuments(client, { firmId: FIRM, documentIds: [documentId] })))[0].derived;
      const clarifications = async (documentId) => (await seed.query(`select count(*)::int as n from client_evidence_requests
        where request_payload->>'document_id' = $1 and request_payload->>'lane' = 'owner_reply_clarification'`, [documentId])).rows[0].n;
      const journals = async (clientId) => (await seed.query('select count(*)::int as n from ledger_journals where client_id = $1', [clientId])).rows[0].n;

      // The two questions say the same thing, in both languages.
      const questions = {};
      const cases = [
        { id: 'su-sales-fi', clientId: ACCRUAL, type: 'sales_invoice', number: '2001', text: 'vielä maksamatta' },
        { id: 'su-bill-fi', clientId: ACCRUAL, type: 'supplier_bill', number: '7001', text: 'ei oo vielä maksettu' },
        { id: 'su-sales-en', clientId: EN, type: 'sales_invoice', number: '2002', text: 'still unpaid' },
        { id: 'su-bill-en', clientId: EN, type: 'supplier_bill', number: '7002', text: "Not paid yet, they're late" }
      ];
      for (const c of cases) {
        const askId = await mint(c);
        questions[c.id] = (await ask(askId)).question;
        const before = await ask(askId);
        const journalsBefore = await journals(c.clientId);
        await reply(askId, c.text);
        // A re-drive by the clock must not change the outcome either.
        await recoverOwnerRepliesInDb({ firmId: FIRM });
        const after = await ask(askId);
        const derived = await projection(c.id);
        const observed = { status: after.status, processing: after.response_payload?.reply_processing, clarifications: await clarifications(c.id),
          projection: derived.state, due_at: after.due_at, topic: after.request_payload?.evidence_topic };
        assert.equal(after.status, 'open', `${c.id}: the ask stays with the owner ${JSON.stringify(observed)}`);
        assert.equal(derived.state, 'on_owner', `${c.id}: ${JSON.stringify(derived)}`);
        assert.equal(observed.clarifications, 0, `${c.id}: no clarification is sent`);
        assert.equal(after.response_payload.reply_processing.state, 'completed', c.id);
        assert.equal(after.response_payload.reply_processing.attempts, 1, `${c.id}: not counted as an unclear attempt`);
        assert.equal(after.response_payload.reply_processing.driven_action, 'owner_reported_still_open', c.id);
        assert.equal(await journals(c.clientId), journalsBefore, `${c.id}: nothing is posted`);
        assert.equal(after.question, before.question, `${c.id}: the question stands verbatim`);
        const turn = after.request_payload.evidence_topic.turns.at(-1);
        assert.equal(turn.outcome, 'obligation_open'); assert.ok(turn.at); assert.equal(turn.reply_excerpt, c.text);
        assert.equal(after.request_payload.evidence_topic.last_assessment.outcome, 'obligation_open');
        // Answered: the topic reminder sweep (a day after the owner's message) leaves it to the re-ask clock.
        assert.equal(after.request_payload.evidence_topic.status, 'answered');
        assert.equal(after.request_payload.obligation_open_acknowledged.send_count, 1);
        // The re-ask comes later, not now: the due date moved past the normal 7-day nudge.
        const dueInDays = (new Date(after.due_at).getTime() - Date.now()) / 86400000;
        assert.ok(dueInDays > 29 && dueInDays <= 30.01, `${c.id}: due in ${dueInDays} days`);
        assert.equal(calls.at(-1).offered, true, `${c.id}: the lane's instructions offered the still-open answer`);
      }
      assert.match(questions['su-sales-fi'], /Jos se on maksettu, kerro milloin ja mille tilille\. Jos se on vielä maksamatta, vastaa "vielä maksamatta"\./);
      assert.match(questions['su-bill-fi'], /Jos se on maksettu, kerro milloin ja miltä tililtä.*Jos se on vielä maksamatta, vastaa "vielä maksamatta"\./);
      assert.match(questions['su-sales-en'], /If it has been paid, reply when and into which account\. If it is still unpaid, reply "still unpaid"\./);
      assert.match(questions['su-bill-en'], /If it has been paid, reply when and from which account.*If it is still unpaid, reply "still unpaid"\./);

      // The re-ask clock: nothing is due today; at day 30 the question is re-sent
      // (a nudge), not escalated as if the owner had ignored it.
      const laneAsk = async (documentId) => (await seed.query(`select id from client_evidence_requests
        where request_payload->>'document_id' = $1 and request_payload->>'lane' in ('sales_invoice_recognition', 'supplier_bill_settlement')`, [documentId])).rows[0].id;
      const fiSales = await ask(await laneAsk('su-sales-fi'));
      const delivered = [];
      const deps = { readSendContainment: async () => ({ contained: false }), evaluateAdmission: async () => ({ allowed: true }),
        deliver: async ({ client, evidenceRequestIds }) => {
          delivered.push(...evidenceRequestIds);
          await client.query(`update client_evidence_requests set send_count = send_count + 1, last_sent_at = now() where id = any($1::text[])`, [evidenceRequestIds]);
          // The fan-out's contract: it names the asks it delivered.
          return { delivered: evidenceRequestIds };
        } };
      const sweep = (days) => withFirmDbClient((client) => runAskReaskSweep({ client, firmId: FIRM, clientId: ACCRUAL, now: Date.now() + days * 86400000, deps }));
      assert.equal((await sweep(8)).considered, 0, 'an acknowledged ask is not nudged on the 7-day clock');
      // Before the acknowledgement the ask had one send; push it to the old
      // escalation bound to prove the acknowledgement restarts the count.
      await seed.query('update client_evidence_requests set send_count = 3 where id = $1', [fiSales.id]);
      await seed.query(`update client_evidence_requests set request_payload = jsonb_set(request_payload, '{obligation_open_acknowledged,send_count}', '3') where id = $1`, [fiSales.id]);
      const day31 = await sweep(31);
      assert.equal(day31.escalated, 0, JSON.stringify(day31)); assert.ok(day31.nudged >= 1, JSON.stringify(day31));
      assert.ok(delivered.includes(fiSales.id));
      // Asked again, the owner answers "still unpaid" again: acknowledged again
      // (a new answer, its own first attempt), never an exhausted clarification.
      await reply(fiSales.id, 'vielä maksamatta');
      const again = await ask(fiSales.id);
      assert.equal(again.status, 'open');
      assert.equal(again.response_payload.reply_processing.driven_action, 'owner_reported_still_open');
      assert.equal(again.response_payload.reply_processing.attempts, 1);
      assert.equal(again.request_payload.evidence_topic.turns.filter((turn) => turn.outcome === 'obligation_open').length, 2);
      assert.equal(again.request_payload.obligation_open_acknowledged.send_count, 4);
      assert.equal(await clarifications('su-sales-fi'), 0);
      // Three more unanswered sends after the latest answer: then the owner is unresponsive.
      await seed.query(`update client_evidence_requests set send_count = 7, due_at = now() - interval '1 day' where id = $1`, [fiSales.id]);
      const later = await sweep(60);
      assert.ok(later.escalated >= 1, JSON.stringify(later));
      assert.equal((await ask(fiSales.id)).request_payload.escalated_to_firm.reason, 'owner_unresponsive');

      // The payment appears: the existing resolution closes the acknowledged ask.
      const fiBill = await laneAsk('su-bill-fi');
      const closed = await withFirmDbClient((client) => resolveOpenSettlementRequestsForDocument({ client, firmId: FIRM, clientId: ACCRUAL, documentId: 'su-bill-fi', transactionId: 'tx-late-payment' }));
      assert.deepEqual(closed, [fiBill]);
      assert.equal((await ask(fiBill)).status, 'resolved');

      // The other answers keep working exactly as today.
      const other = [
        { id: 'ot-cash', type: 'supplier_bill', number: '7101', text: 'Maksoin sen käteisellä omista rahoista.', status: 'resolved', clar: 0, action: 'document_redisposition' },
        { id: 'ot-uncovered', type: 'supplier_bill', number: '7102', text: 'Maksettu yritystililtä, jonka tiliotetta sinulla ei ole.', status: 'resolved', clar: 0, action: 'document_redisposition' },
        { id: 'ot-unclear', type: 'sales_invoice', number: '2101', text: 'hmm, en muista', status: 'resolved', clar: 1, action: 'owner_clarification' }
      ];
      for (const c of other) {
        const askId = await mint({ ...c, clientId: ACCRUAL });
        await reply(askId, c.text);
        const after = await ask(askId);
        assert.equal(after.status, c.status, `${c.id}: ${JSON.stringify(after.response_payload)}`);
        assert.equal(after.response_payload.reply_processing.driven_action, c.action, c.id);
        assert.equal(await clarifications(c.id), c.clar, c.id);
        assert.equal(after.request_payload.obligation_open_acknowledged, undefined, c.id);
      }
    } finally {
      await __endFirmDbPoolForTests().catch(() => {});
      for (const [k, v] of Object.entries(prior)) { if (v == null) delete process.env[k]; else process.env[k] = v; }
      await stop();
    }
  });

// Part-paid documents and a supplier credit note netted from a bill payment,
// through the real reader (the ALV read and the financial statements) on
// PostgreSQL. Every amount is a persisted fact: the document totals, the
// match_amount of each decided match, the posted settlement journal's date.
//   1. A sales invoice and a supplier bill each paid one instalment inside
//      February: the instalment is in the posted ledger, the unpaid remainder
//      is named with its amount (gross, net and tax) in both drafts.
//   2. A supplier bill paid net of a supplier credit note (the bank line is
//      matched to the bill alone, at bill − credit): Donna holds no record
//      that the credit was deducted, so it does not infer one. The bill's
//      unpaid remainder and the credit note are both named, and the owner is
//      asked about the credit note on the supplier lane, in a question that
//      fits a credit note, never twice.
const instalment = async (seed, { documentId, type, txId, date, amount, journalDate }) => {
  const [moneyIn, moneyOut] = type === 'sales_invoice' ? [amount, 0] : [0, amount];
  await seed.query(`insert into transactions (id, firm_id, client_id, transaction_date, description, money_in, money_out, currency, status, payload)
    values ($1, $2, $3, $4, $1, $5, $6, 'EUR', 'posted', '{}'::jsonb)`, [txId, FIRM, ACCRUAL, date, moneyIn, moneyOut]);
  await seed.query(`insert into reconciliation_matches (id, firm_id, client_id, bank_transaction_id, matched_object_type, matched_object_id, status, match_amount, payload)
    values ($1, $2, $3, $4, $5, $6, 'confirmed', $7, '{}'::jsonb)`, [`m-${txId}`, FIRM, ACCRUAL, txId, type, documentId, amount]);
  if (journalDate) await journal(seed, { sourceType: 'transaction', sourceId: txId, date: journalDate });
};

test('real PG: a part-paid invoice or bill names its unpaid remainder; a supplier credit note netted from a bill payment is asked of the owner, never inferred',
  { skip: !PG_URL && 'DONNA_PG_TEST_URL not set', timeout: 300_000 }, async () => {
    const { seed, url, stop } = await boot();
    const prior = { DATABASE_URL: process.env.DATABASE_URL, DATABASE_POOL_MAX: process.env.DATABASE_POOL_MAX };
    const priorDecide = __jevReconciliation.decide;
    process.env.DATABASE_URL = url; process.env.DATABASE_POOL_MAX = '3';
    __jevReconciliation.decide = noSettlement;
    try {
      // ── 1. Part-paid ───────────────────────────────────────────────────────
      // Sales invoice 1010: 800,00 + 204,00 ALV; 502,00 in February, 502,00 in March.
      await insertDocument(seed, { id: 'doc-osa', customer: 'Osamaksu Oy', total: 1004, tax: 204, date: '2025-02-04', number: '1010', paymentStatus: 'partial' });
      await instalment(seed, { documentId: 'doc-osa', type: 'sales_invoice', txId: 'tx-osa-1', date: '2025-02-20', amount: 502, journalDate: '2025-02-20' });
      await instalment(seed, { documentId: 'doc-osa', type: 'sales_invoice', txId: 'tx-osa-2', date: '2025-03-20', amount: 502, journalDate: '2025-03-20' });
      // Its neighbour paid in full by two February instalments stays represented.
      await insertDocument(seed, { id: 'doc-kaksi', customer: 'Kaksi Oy', total: 251, tax: 51, date: '2025-02-06', number: '1011', paymentStatus: 'paid' });
      await instalment(seed, { documentId: 'doc-kaksi', type: 'sales_invoice', txId: 'tx-kaksi-1', date: '2025-02-10', amount: 125.5, journalDate: '2025-02-10' });
      await instalment(seed, { documentId: 'doc-kaksi', type: 'sales_invoice', txId: 'tx-kaksi-2', date: '2025-02-24', amount: 125.5, journalDate: '2025-02-24' });
      // Supplier bill 4720: 400,00 + 96,00 ALV; 248,00 paid in February, the rest not yet.
      await insertBill(seed, { id: 'bill-osa', vendor: 'Rautakulma Oy', total: 496, tax: 96, date: '2025-02-03', number: '4720', paymentStatus: 'partial' });
      await instalment(seed, { documentId: 'bill-osa', type: 'supplier_bill', txId: 'tx-bill-osa-1', date: '2025-02-17', amount: 248, journalDate: '2025-02-17' });

      // ── 2. Netted supplier credit note ─────────────────────────────────────
      // Bill 4730 248,00 (48,00 ALV) and credit note HL-30 −62,00 (−12,00 ALV);
      // the business paid 186,00 and the line is matched to the bill alone.
      await insertBill(seed, { id: 'bill-net', vendor: 'Tukku Oy', total: 248, tax: 48, date: '2025-02-05', number: '4730', paymentStatus: 'partial' });
      await insertBill(seed, { id: 'bill-net-cn', vendor: 'Tukku Oy', total: -62, tax: -12, date: '2025-02-09', number: 'HL-30', paymentStatus: 'credit_note' });
      await instalment(seed, { documentId: 'bill-net', type: 'supplier_bill', txId: 'tx-bill-net', date: '2025-02-15', amount: 186, journalDate: '2025-02-15' });
      // Nothing links the two documents: no credit application names a supplier bill.
      assert.equal((await seed.query('select count(*)::int as n from document_credit_applications')).rows[0].n, 0);

      // The credit note's no-settlement verdict puts it on the owner, once.
      const first = await runBill(ACCRUAL, 'bill-net-cn');
      assert.equal(first.jev_reason, 'jev_no_settlement', JSON.stringify(first));
      assert.equal(first.supplier_bill_settlement_ask?.minted, true, JSON.stringify(first.supplier_bill_settlement_ask));
      const asks = await asksFor(seed, 'bill-net-cn');
      assert.equal(asks.length, 1);
      assert.deepEqual([asks[0].status, asks[0].evidence_type, asks[0].audience, asks[0].request_payload.lane, asks[0].request_payload.recognition],
        ['draft', 'payment_method', 'client', 'supplier_bill_settlement', 'unrecorded_uploaded_supplier_credit_note']);
      // A Finnish book: a credit-note question in Finnish, not "has the bill been paid".
      assert.match(asks[0].question, /^Ostohyvityslasku HL-30 \(Tukku Oy, 62,00 EUR, päivätty 9\.2\.2025\): /);
      assert.match(asks[0].question, /vähennetty/);
      assert.doesNotMatch(asks[0].question, /Onko lasku maksettu/);
      const second = await runBill(ACCRUAL, 'bill-net-cn');
      assert.ok(!second.supplier_bill_settlement_ask?.minted, JSON.stringify(second));
      assert.equal((await asksFor(seed, 'bill-net-cn')).length, 1, 'the same credit note is never asked twice');
      // The bill itself is not re-asked as unpaid: it has a decided, posted line.
      assert.deepEqual(await asksFor(seed, 'bill-net'), []);

      // ── The ALV draft ──────────────────────────────────────────────────────
      const alv = await getFinlandAlvReturnFromDb({ firmId: FIRM, clientId: ACCRUAL, period: '2025-02' });
      assert.equal(alv.review.status, 'needs_review');
      assert.deepEqual(alv.review.blockers, ['unrecognized_sales_documents', 'unrecognized_purchase_documents']);
      const sales = alv.review.unrecognizedSales;
      assert.deepEqual(sales.items.map((i) => [i.document_id, i.rests, i.gross, i.net, i.tax]), [['doc-osa', 'part_settled_in_period', 502, 400, 102]]);
      assert.deepEqual(sales.items[0].remainder, { document_gross: 1004, settled_in_period: 502, remaining_gross: 502, remaining_tax: 102 });
      assert.deepEqual(sales.represented, [{ document_id: 'doc-kaksi', by: 'settlement_journal' }]);
      assert.match(sales.statement, /^1 uploaded sales document is not fully recognised .*: 400\.00 EUR net \+ 102\.00 tax\. 1 of them is paid only in part in this period; only its unpaid remainder is counted here\.$/);
      const purchases = alv.review.unrecognizedPurchases;
      assert.deepEqual(purchases.items.map((i) => [i.document_id, i.kind, i.rests, i.gross, i.net, i.tax, i.on_nobody]), [
        ['bill-osa', 'invoice', 'part_settled_in_period', 248, 200, 48, true],
        ['bill-net', 'invoice', 'part_settled_in_period', 62, 50, 12, true],
        ['bill-net-cn', 'credit_note', 'no_settlement', -62, -50, -12, false]]);
      assert.equal(purchases.items[2].held_by[0].anchor, 'document');
      assert.deepEqual(purchases.totals, [{ currency: 'EUR', count: 3, gross: 248, net: 200, tax: 48, tax_unknown_count: 0 }]);
      assert.deepEqual(purchases.represented, []);

      // ── The financial statements ──────────────────────────────────────────
      const report = await getFinancialReportFromDb({ firmId: FIRM, clientId: ACCRUAL, periodStart: '2025-02-01', periodEnd: '2025-02-28' });
      const byCode = Object.fromEntries(report.draft.reasons.map((r) => [r.code, r]));
      assert.deepEqual(byCode.unrecognized_sales_documents?.document_ids, ['doc-osa'], JSON.stringify(report.draft.reasons));
      assert.match(byCode.unrecognized_sales_documents.detail, /400\.00 EUR net \+ 102\.00 tax/);
      assert.deepEqual(byCode.unrecognized_purchase_documents?.document_ids, ['bill-osa', 'bill-net', 'bill-net-cn']);
      assert.match(byCode.unrecognized_purchase_documents.detail, /200\.00 EUR expense \+ 48\.00 input tax/);

      // March holds the second sales instalment: the invoice is not listed there.
      const march = await getFinlandAlvReturnFromDb({ firmId: FIRM, clientId: ACCRUAL, period: '2025-03' });
      assert.equal(march.review.unrecognizedSales, undefined);
      // This module reports and asks: nothing was posted by any of it.
      assert.equal((await seed.query(`select count(*)::int as n from ledger_journals where client_id = $1`, [ACCRUAL])).rows[0].n, 6);
    } finally {
      __jevReconciliation.decide = priorDecide;
      await __endFirmDbPoolForTests().catch(() => {});
      for (const [k, v] of Object.entries(prior)) { if (v == null) delete process.env[k]; else process.env[k] = v; }
      await stop();
    }
  });

// The owner's answers to the two census questions, through the real reply
// route (resolveClientEvidenceRequestInDb, then the owner-reply clock). The
// model is scripted to follow the instructions it is given: it can only
// return an answer the asking lane offers, and anything else is unclear.
//   1. "The credit note was deducted from bill 4730": Donna records the
//      supplier-side credit application (the one writer, its checks, its
//      receipt), and the census then counts both documents as represented.
//      Nothing is posted. An unclear answer, a bill of another supplier and a
//      bill that does not exist all take the existing unclear path.
//   2. A sales invoice paid 2,50 short: no fee is recorded on the match, so
//      the census does not guess. The filing start asks the owner whether it
//      was a bank fee or a part-payment; "bank fee" is recorded on the match
//      and the invoice is then represented; "part-payment" keeps the
//      remainder open with the owner.
const LANE_REPLIES = {
  'Se vähennettiin laskun 4730 maksusta 15.2.': { disposition: 'credit_deducted', deducted_from_bill: '4730' },
  'It was taken off our payment of bill 4741.': { disposition: 'credit_deducted', deducted_from_bill: '4741' },
  'Vähennettiin laskusta 5100.': { disposition: 'credit_deducted', deducted_from_bill: '5100' },
  'Vähennettiin laskusta 9999.': { disposition: 'credit_deducted', deducted_from_bill: '9999' },
  'Se oli pankin palvelumaksu.': { disposition: 'shortfall_bank_fee' },
  'Osamaksu, loput tulee maaliskuussa.': { disposition: 'obligation_open' }
};
const scriptedLaneReplyModel = (calls) => async (endpoint, init) => {
  assert.equal(endpoint, 'https://api.anthropic.com/v1/messages');
  const body = JSON.parse(init.body);
  const prompt = body.messages.map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content))).join('\n');
  const reply = /The owner answered: "([^"]*)"/.exec(prompt)?.[1] || '';
  const system = String(body.system || '');
  const scripted = LANE_REPLIES[reply] || null;
  const offered = Boolean(scripted) && system.includes(`"${scripted.disposition}"`);
  calls.push({ reply, offered });
  const base = { materiality: 'material', expense_kind: 'unknown', settlement_channel: 'unknown', funding_source: 'unknown', confidence: 0.9, reasoning: 'Scripted read of the owner answer.' };
  const verdict = offered ? { ...base, ...scripted } : { ...base, disposition: 'needs_human', confidence: 0.3 };
  return { ok: true, status: 200, json: async () => ({ id: `msg-${calls.length}`, type: 'message', role: 'assistant', model: 'fixture-model',
    content: [{ type: 'text', text: JSON.stringify(verdict) }], stop_reason: 'end_turn', usage: { input_tokens: 0, output_tokens: 0 } }) };
};

test('real PG: the owner says a supplier credit note was deducted from bill X; Donna records the application and the census represents both; unclear or impossible answers stay on the unclear path',
  { skip: !PG_URL && 'DONNA_PG_TEST_URL not set', timeout: 300_000 }, async (t) => {
    const { seed, url, stop } = await boot();
    const prior = { DATABASE_URL: process.env.DATABASE_URL, DATABASE_POOL_MAX: process.env.DATABASE_POOL_MAX, ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY };
    process.env.DATABASE_URL = url; process.env.DATABASE_POOL_MAX = '3'; process.env.ANTHROPIC_API_KEY = 'test-credit-deducted';
    const calls = [];
    t.mock.method(globalThis, 'fetch', scriptedLaneReplyModel(calls));
    const { ensureNoSettlementAskWithClient } = await import('./salesRecognitionGap.js');
    const { resolveClientEvidenceRequestInDb } = await import('./firmDb.js');
    const { recoverOwnerRepliesInDb } = await import('./ownerReplyRecovery.js');
    try {
      const EN = 'client-fi09-accrual-en';
      await seed.query(`insert into clients (id, firm_id, company_name, jurisdiction, entity_type, status, profile) values ($1, $2, 'Studio English Oy', 'fi', 'fi-oy', 'active', $3)`,
        [EN, FIRM, { jurisdiction: 'fi', locale: 'en', accounting_system: 'none', accounting_basis: 'accrual' }]);
      for (const clientId of [ACCRUAL, EN]) {
        await setClientFlagStage(seed, { firmId: FIRM, clientId, flagKey: 'DOCUMENT_NO_LINE_DISPOSITION', stage: 'auto', source: 'default', reason: 'credit deducted proof' });
        await setClientFlagStage(seed, { firmId: FIRM, clientId, flagKey: 'JEV_RECONCILIATION', stage: 'off', source: 'manual', reason: 'credit deducted proof' });
      }
      const mint = async ({ id, clientId }) => {
        const minted = await withFirmDbClient((client) => ensureNoSettlementAskWithClient({ client, firmId: FIRM, clientId, documentId: id, documentType: 'supplier_bill' }));
        assert.equal(minted.minted, true, JSON.stringify(minted));
        await seed.query(`update client_evidence_requests set status = 'open', send_count = 1, first_sent_at = now() - interval '1 day',
          last_sent_at = now() - interval '1 day', due_at = now() + interval '6 days' where id = $1`, [minted.evidence_request_id]);
        return minted.evidence_request_id;
      };
      const ask = async (askId) => (await seed.query('select * from client_evidence_requests where id = $1', [askId])).rows[0];
      const reply = (askId, text) => resolveClientEvidenceRequestInDb({ firmId: FIRM, evidenceRequestId: askId, reply: text, actorId: 'owner-credit', actorType: 'client' });
      const applications = async (creditId) => (await seed.query(`select credit_document_id, invoice_document_id, amount::text as amount, currency, status, settlement_match_id, applied_by, payload
        from document_credit_applications where credit_document_id = $1`, [creditId])).rows;
      const journals = async () => (await seed.query('select count(*)::int as n from ledger_journals')).rows[0].n;
      const clarifications = async (documentId) => (await seed.query(`select count(*)::int as n from client_evidence_requests
        where request_payload->>'document_id' = $1 and request_payload->>'lane' = 'owner_reply_clarification'`, [documentId])).rows[0].n;

      // Bill 4730 248,00 (48,00 ALV), paid 186,00 net of credit note HL-30 −62,00 (−12,00 ALV).
      await insertBill(seed, { id: 'bill-net', total: 248, tax: 48, date: '2025-02-05', number: '4730', paymentStatus: 'partial' });
      await insertBill(seed, { id: 'bill-net-cn', total: -62, tax: -12, date: '2025-02-09', number: 'HL-30', paymentStatus: 'credit_note' });
      await instalment(seed, { documentId: 'bill-net', type: 'supplier_bill', txId: 'tx-bill-net', date: '2025-02-15', amount: 186, journalDate: '2025-02-15' });
      const journalsBefore = await journals();
      const askId = await mint({ id: 'bill-net-cn', clientId: ACCRUAL });
      await reply(askId, 'Se vähennettiin laskun 4730 maksusta 15.2.');
      await recoverOwnerRepliesInDb({ firmId: FIRM });
      const answered = await ask(askId);
      assert.equal(calls.at(-1).offered, true, 'the credit-note question offers the "deducted from bill X" answer');
      assert.equal(answered.response_payload.reply_processing.driven_action, 'owner_stated_credit_deduction', JSON.stringify(answered.response_payload));
      assert.equal(answered.status, 'resolved');
      assert.equal(await clarifications('bill-net-cn'), 0);
      const [application] = await applications('bill-net-cn');
      assert.ok(application, 'the owner answer is recorded as a supplier credit application');
      assert.deepEqual([application.invoice_document_id, application.amount, application.currency, application.status, application.settlement_match_id, application.applied_by],
        ['bill-net', '62.00', 'EUR', 'applied', 'm-tx-bill-net', 'owner-credit']);
      assert.equal(application.payload.source, 'owner_reply');
      assert.equal(application.payload.authority.evidence_request_id, askId);
      // Receipted: the application's audit event, written with the row.
      const receipt = (await seed.query(`select metadata from audit_events where action = 'reconciliation.credit_note_applied' and resource_id = 'bill-net-cn'`)).rows;
      assert.equal(receipt.length, 1);
      assert.equal(receipt[0].metadata.invoice_document_id, 'bill-net');
      // The bill is paid in full now that its credit is recorded.
      assert.equal((await seed.query(`select payment_status from documents where id = 'bill-net'`)).rows[0].payment_status, 'paid');
      // The census: both documents represented, nothing excluded.
      const alv = await getFinlandAlvReturnFromDb({ firmId: FIRM, clientId: ACCRUAL, period: '2025-02' });
      assert.equal(alv.review.unrecognizedPurchases, undefined, JSON.stringify(alv.review.unrecognizedPurchases));
      // Recording the application posts nothing.
      assert.equal(await journals(), journalsBefore);
      // The same answer re-driven is not a second application.
      await recoverOwnerRepliesInDb({ firmId: FIRM });
      assert.equal((await applications('bill-net-cn')).length, 1);

      // English: the same answer in English, the same record.
      await insertBill(seed, { id: 'bill-en', clientId: EN, total: 124, tax: 24, date: '2025-02-05', number: '4741' });
      await insertBill(seed, { id: 'bill-en-cn', clientId: EN, total: -24.8, tax: -4.8, date: '2025-02-07', number: 'CN-41', paymentStatus: 'credit_note' });
      const enAsk = await mint({ id: 'bill-en-cn', clientId: EN });
      assert.match((await ask(enAsk)).question, /^Supplier credit note CN-41 from Tukku Oy \(24\.80 EUR, dated 2025-02-07\)/);
      await reply(enAsk, 'It was taken off our payment of bill 4741.');
      assert.equal((await ask(enAsk)).response_payload.reply_processing.driven_action, 'owner_stated_credit_deduction');
      assert.deepEqual((await applications('bill-en-cn')).map((a) => [a.invoice_document_id, a.amount, a.settlement_match_id]), [['bill-en', '24.80', null]]);

      // Answers Donna cannot record go to the existing unclear path.
      const unclear = [
        // Not an answer at all.
        { credit: 'cn-unclear', number: 'HL-31', text: 'hmm, en muista', bill: null, reason: null },
        // A bill of another supplier: the same-counterparty check refuses it.
        { credit: 'cn-other-vendor', number: 'HL-32', text: 'Vähennettiin laskusta 5100.', bill: { id: 'bill-other', vendor: 'Rautakulma Oy', number: '5100' },
          reason: 'owner_answer_not_recordable:credit_vendor_mismatch' },
        // A bill Donna does not hold.
        { credit: 'cn-missing', number: 'HL-33', text: 'Vähennettiin laskusta 9999.', bill: null, reason: 'owner_answer_not_recordable:credit_bill_not_found' }
      ];
      for (const c of unclear) {
        if (c.bill) await insertBill(seed, { id: c.bill.id, vendor: c.bill.vendor, total: 248, tax: 48, date: '2025-02-05', number: c.bill.number });
        await insertBill(seed, { id: c.credit, total: -62, tax: -12, date: '2025-02-09', number: c.number, paymentStatus: 'credit_note' });
        const id = await mint({ id: c.credit, clientId: ACCRUAL });
        await reply(id, c.text);
        const after = await ask(id);
        assert.equal(after.response_payload.reply_processing.driven_action, 'owner_clarification', `${c.credit}: ${JSON.stringify(after.response_payload)}`);
        assert.equal(await clarifications(c.credit), 1, c.credit);
        assert.deepEqual(await applications(c.credit), [], c.credit);
        // The receipt says why a clear answer could not be recorded.
        if (c.reason) {
          const stamp = (await seed.query(`select unmatchable_reason as reason from reconciliation_evaluations where target_id = $1`, [c.credit])).rows;
          assert.deepEqual(stamp.map((r) => r.reason), [c.reason], c.credit);
        }
      }
      assert.equal(await journals(), journalsBefore);
    } finally {
      await __endFirmDbPoolForTests().catch(() => {});
      for (const [k, v] of Object.entries(prior)) { if (v == null) delete process.env[k]; else process.env[k] = v; }
      await stop();
    }
  });

test('real PG: a sales payment short by an unrecorded amount is asked as "bank fee or part-payment?"; a bank-fee answer is recorded on the match and settles it; a part-payment answer keeps the remainder open',
  { skip: !PG_URL && 'DONNA_PG_TEST_URL not set', timeout: 300_000 }, async (t) => {
    const { seed, url, stop } = await boot();
    const prior = { DATABASE_URL: process.env.DATABASE_URL, DATABASE_POOL_MAX: process.env.DATABASE_POOL_MAX, ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY };
    process.env.DATABASE_URL = url; process.env.DATABASE_POOL_MAX = '3'; process.env.ANTHROPIC_API_KEY = 'test-shortfall';
    const calls = [];
    t.mock.method(globalThis, 'fetch', scriptedLaneReplyModel(calls));
    const { resolveClientEvidenceRequestInDb } = await import('./firmDb.js');
    try {
      await setClientFlagStage(seed, { firmId: FIRM, clientId: ACCRUAL, flagKey: 'JEV_RECONCILIATION', stage: 'off', source: 'manual', reason: 'shortfall proof' });
      await setClientFlagStage(seed, { firmId: FIRM, clientId: ACCRUAL, flagKey: 'FINLAND_ALV_FILING', stage: 'auto', source: 'manual', reason: 'shortfall proof' });
      // Invoice 1020 1 004,00 (204,00 ALV) paid 1 001,50; invoice 1021 the same, paid 1 001,50.
      // Neither match records a fee.
      for (const [id, number, tx] of [['doc-fee', '1020', 'tx-fee'], ['doc-part', '1021', 'tx-part']]) {
        await insertDocument(seed, { id, customer: 'Pankkikulu Oy', total: 1004, tax: 204, date: '2025-02-04', number, paymentStatus: 'partial' });
        await instalment(seed, { documentId: id, type: 'sales_invoice', txId: tx, date: '2025-02-20', amount: 1001.5, journalDate: '2025-02-20' });
      }
      // Neighbours the census already handles the same way as before: a
      // cross-currency line and a line with no stated amount keep the whole
      // document represented (nothing persisted states the part in the
      // invoice's currency) and nobody is asked about them.
      await insertDocument(seed, { id: 'doc-usd', customer: 'Valuutta Oy', total: 1004, tax: 204, date: '2025-02-04', number: '1022', paymentStatus: 'paid' });
      await instalment(seed, { documentId: 'doc-usd', type: 'sales_invoice', txId: 'tx-usd', date: '2025-02-20', amount: 1050, journalDate: '2025-02-20' });
      await seed.query(`update transactions set currency = 'USD' where id = 'tx-usd'`);
      await insertDocument(seed, { id: 'doc-noamount', customer: 'Summaton Oy', total: 1004, tax: 204, date: '2025-02-04', number: '1023', paymentStatus: 'paid' });
      await instalment(seed, { documentId: 'doc-noamount', type: 'sales_invoice', txId: 'tx-noamount', date: '2025-02-20', amount: 1004, journalDate: '2025-02-20' });
      await seed.query(`update reconciliation_matches set match_amount = null where id = 'm-tx-noamount'`);
      const journalsBefore = (await seed.query('select count(*)::int as n from ledger_journals')).rows[0].n;

      const census = async () => (await getFinlandAlvReturnFromDb({ firmId: FIRM, clientId: ACCRUAL, period: '2025-02' })).review.unrecognizedSales;
      const before = await census();
      assert.deepEqual(before.items.map((i) => [i.document_id, i.rests, i.gross, i.tax]), [['doc-fee', 'part_settled_in_period', 2.5, 0.51], ['doc-part', 'part_settled_in_period', 2.5, 0.51]]);
      assert.deepEqual(before.represented.map((r) => r.document_id).sort(), ['doc-noamount', 'doc-usd']);

      // The filing start escalates and, for each unexplained shortfall, asks the owner.
      const started = await startFinlandAlvReturnFilingInDb({ firmId: FIRM, clientId: ACCRUAL, period: '2025-02', actorId: 'fi09-test',
        deliverAsksImpl: async () => ({ skipped: true }), scopeDriftImpl: async () => null });
      assert.equal(started.action, 'escalated');
      const shortfallAsk = async (documentId) => (await seed.query(`select * from client_evidence_requests
        where request_payload->>'document_id' = $1 and request_payload->>'recognition' = 'unexplained_settlement_shortfall'`, [documentId])).rows;
      const [feeAsk] = await shortfallAsk('doc-fee');
      assert.ok(feeAsk, 'the unexplained shortfall is put to the owner');
      assert.equal((await shortfallAsk('doc-part')).length, 1);
      assert.deepEqual(await shortfallAsk('doc-usd'), []);
      assert.equal(feeAsk.request_payload.lane, 'sales_invoice_recognition');
      assert.equal(feeAsk.request_payload.shortfall.amount, '2.50');
      // A Finnish book: the question in Finnish, with the amount as Finns write it.
      assert.match(feeAsk.question, /^Myyntilasku 1020 \(Pankkikulu Oy, 1004,00 EUR, päivätty 4\.2\.2025\): /);
      assert.match(feeAsk.question, /2,50 EUR/);
      assert.match(feeAsk.question, /pankin palvelumaksu vai osamaksu/);
      // Asked: both items are held by the owner now.
      const held = await census();
      assert.deepEqual(held.items.map((i) => [i.document_id, i.on_nobody]), [['doc-fee', false], ['doc-part', false]]);
      // Never twice.
      await startFinlandAlvReturnFilingInDb({ firmId: FIRM, clientId: ACCRUAL, period: '2025-02', actorId: 'fi09-test',
        deliverAsksImpl: async () => ({ skipped: true }), scopeDriftImpl: async () => null });
      assert.equal((await shortfallAsk('doc-fee')).length, 1);

      // "A bank fee": recorded on the match; the invoice is then represented.
      const open = async (id) => seed.query(`update client_evidence_requests set status = 'open', send_count = 1 where id = $1`, [id]);
      await open(feeAsk.id);
      await resolveClientEvidenceRequestInDb({ firmId: FIRM, evidenceRequestId: feeAsk.id, reply: 'Se oli pankin palvelumaksu.', actorId: 'owner-fee', actorType: 'client' });
      const feeAfter = (await shortfallAsk('doc-fee'))[0];
      assert.equal(calls.at(-1).offered, true);
      assert.equal(feeAfter.status, 'resolved', JSON.stringify(feeAfter.response_payload));
      assert.equal(feeAfter.response_payload.reply_processing.driven_action, 'owner_stated_bank_fee');
      const feeMatch = (await seed.query(`select payload from reconciliation_matches where id = 'm-tx-fee'`)).rows[0].payload;
      assert.deepEqual([feeMatch.settlement_shortfall.kind, feeMatch.settlement_shortfall.amount, feeMatch.settlement_shortfall.currency, feeMatch.settlement_shortfall.source],
        ['bank_fee', '2.50', 'EUR', 'owner_reply']);
      assert.equal(feeMatch.settlement_shortfall.evidence_request_id, feeAsk.id);
      // "A part-payment": the remainder is open; the ask stays with the owner.
      const [partAsk] = await shortfallAsk('doc-part');
      await open(partAsk.id);
      await resolveClientEvidenceRequestInDb({ firmId: FIRM, evidenceRequestId: partAsk.id, reply: 'Osamaksu, loput tulee maaliskuussa.', actorId: 'owner-fee', actorType: 'client' });
      const partAfter = (await shortfallAsk('doc-part'))[0];
      assert.equal(partAfter.status, 'open');
      assert.equal(partAfter.response_payload.reply_processing.driven_action, 'owner_reported_still_open');
      assert.equal((await seed.query(`select payload from reconciliation_matches where id = 'm-tx-part'`)).rows[0].payload.settlement_shortfall, undefined);

      const after = await census();
      assert.deepEqual(after.items.map((i) => [i.document_id, i.rests, i.gross, i.on_nobody]), [['doc-part', 'part_settled_in_period', 2.5, false]]);
      assert.deepEqual(after.represented.find((r) => r.document_id === 'doc-fee'),
        { document_id: 'doc-fee', by: 'settlement_journal', net_of_bank_fee: { amount: 2.5, match_ids: ['m-tx-fee'] } });
      // Nothing was posted by any of it.
      assert.equal((await seed.query('select count(*)::int as n from ledger_journals')).rows[0].n, journalsBefore);
    } finally {
      await __endFirmDbPoolForTests().catch(() => {});
      for (const [k, v] of Object.entries(prior)) { if (v == null) delete process.env[k]; else process.env[k] = v; }
      await stop();
    }
  });
