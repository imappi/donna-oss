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

test('real PG: an uploaded unpaid supplier bill on an accrual book is asked of the owner once and then waits on them; cash books and credit notes are unchanged',
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

      // A supplier credit note is not an unpaid bill: no ask.
      await insertBill(seed, { id: 'bill-credit', total: -62, tax: -12, date: '2025-02-09', number: 'HL-12', paymentStatus: 'credit_note' });
      const credit = await runBill(ACCRUAL, 'bill-credit');
      assert.equal(credit.supplier_bill_settlement_ask?.minted ?? false, false, JSON.stringify(credit));
      assert.deepEqual(await asksFor(seed, 'bill-credit'), []);

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
