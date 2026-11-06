// IV-1 — the GB AP twin (design-donna-gb-input-vat-boxes-4-7.md §2):
// postSupplierBillJournalWithClient for a JURISDICTION_TAX_CODING-routed gb
// accrual client, against the same pattern-matching fake pg client as
// finlandSupplierBillPostDb.test.js. Every named refusal fires BEFORE any
// ledger write; the happy path books net expense + the role-marked
// vat_input_deductible control leg from the client's OWN chart / payables
// gross — through the untouched ledger.js builder.
//   node --test server/donna/gbSupplierBillVatSplit.test.js

import assert from 'node:assert/strict';
import test from 'node:test';

import { postSupplierBillJournalWithClient } from './firmDb.js';

const billRow = ({ total_amount = 120, tax_amount = 20 } = {}) => ({
  id: 'doc-gb-001',
  document_type: 'supplier_bill',
  parse_status: 'completed',
  duplicate_of: null,
  vendor_name: 'Synthetic Supplies Ltd',
  total_amount,
  tax_amount,
  document_date: '2026-07-02',
  currency: 'GBP',
  reference_number: 'INV-4471'
});

// The client's own chart carries the VAT control by canonical role — the UK
// ships no statutory chart (vatCodes.js header note 3).
const VAT_CONTROL_ROW = {
  id: 'acc-vat', code: '2202', name: 'VAT control', account_type: 'liability',
  normal_balance: 'credit', currency: 'GBP', tax_type: 'NONE',
  canonical_role: 'liability.sales_tax_payable', status: 'active'
};

const PAYABLES_ROW = {
  id: 'acc-ap', code: '2200', name: 'Trade creditors', account_type: 'liability',
  normal_balance: 'credit', currency: 'GBP', tax_type: 'NONE',
  canonical_role: 'liability.accounts_payable', status: 'active'
};

const GB_FLAGS = { JURISDICTION_TAX_CODING: 'auto' };

const fakeClient = ({
  flags = GB_FLAGS,
  jurisdiction = 'gb',
  profile = { accounting_basis: 'accrual' },
  document = billRow(),
  chartRows = [VAT_CONTROL_ROW, PAYABLES_ROW]
} = {}) => {
  const queries = [];
  return {
    queries,
    async query(sql, params = []) {
      queries.push({ sql, params });
      // Canonical lineage observes this same unmarked client; no native birth is seeded.
      if (sql.includes('as birth_created_at') && sql.includes('from clients')) return { rows: [{ id: params[1], firm_id: params[0], birth_created_at: null, jurisdiction: jurisdiction, entity_type: null, profile }] };
      if (sql.includes('select jurisdiction, entity_type, profile from clients')) return { rows: [{ jurisdiction: jurisdiction, entity_type: null, profile }] };
      if (sql.includes('from audit_events where firm_id=$1 and resource_id=$2')) return { rows: [] }; // no client birth receipts in this fixture
      if (sql.includes('from client_capability_config')) {
        return { rows: Object.entries(flags).map(([flag_key, stage]) => ({ flag_key, stage, source: 'test', client_id: 'client-gb-1' })) };
      }
      if (sql.includes('from cohort_capability_config')) return { rows: [] };
      if (sql.includes('select jurisdiction from clients')) return { rows: [{ jurisdiction }] };
      if (sql.includes('select profile from clients')) return { rows: [{ profile }] };
      if (sql.includes('from documents')) return { rows: document ? [document] : [] };
      if (sql.includes('from ledger_accounts')) return { rows: chartRows };
      if (sql.includes('from ledger_journals lj')) return { rows: [] };
      if (sql.includes('from close_periods')) return { rows: [] };
      if (sql.includes('insert into ledger_accounts')) return { rows: [] };
      if (sql.includes('insert into ledger_journals')) return { rows: [{ id: 'journal-gb-1' }] };
      if (sql.includes('delete from ledger_lines')) return { rows: [] };
      if (sql.includes('insert into ledger_lines')) return { rows: [] };
      if (sql.includes('incorporation_date, entity_type from clients')) return { rows: [{ incorporation_date: '2025-06-15', entity_type: 'gb-ltd' }] };
      if (sql.includes('insert into audit_events')) return { rows: [{ id: 42 }] };
      throw new Error(`Unexpected query: ${sql}`);
    }
  };
};

const confidentCoding = {
  proposed_account: 'Office costs',
  account_code: '7500',
  account_type: 'expense',
  confidence: 'high',
  model: 'test-coder-model'
};

const call = (client, overrides = {}) => postSupplierBillJournalWithClient({
  client,
  firmId: 'firm-1',
  clientId: 'client-gb-1',
  documentId: 'doc-gb-001',
  coding: confidentCoding,
  authorityBasis: { source: 'auto_explain', policy: 'supplier_bill_auto_explain_v1' },
  model: 'test-coder-model',
  actorId: 'system',
  ...overrides
});

const wroteLedger = (client) => client.queries.some((q) => q.sql.includes('insert into ledger_journals'));
const insertedLines = (client) => client.queries
  .filter((q) => q.sql.includes('insert into ledger_lines'))
  .map((q) => ({ account_code: q.params[5], debit: q.params[9], credit: q.params[10], tax_type: q.params[13], payload: JSON.parse(q.params[15]) }));

// ── The entry gate (the IV-1 addendum: FI-e-invoice OR GB coding) ──────────

test('a client with neither FI receive nor GB coding refuses at the entry gate, exactly as before', async () => {
  const client = fakeClient({ flags: {} });
  await assert.rejects(call(client), (e) => e.code === 'FINLAND_EINVOICE_RECEIVE_DISABLED' && e.statusCode === 409);
  assert.equal(wroteLedger(client), false);
});

test('a JURISDICTION_TAX_CODING client whose jurisdiction is NOT gb still refuses at the entry gate', async () => {
  const client = fakeClient({ jurisdiction: 'sg' });
  await assert.rejects(call(client), (e) => e.code === 'FINLAND_EINVOICE_RECEIVE_DISABLED');
  assert.equal(wroteLedger(client), false);
});

test('a cash-basis gb client refuses AP at receipt — settlement books via reconciliation', async () => {
  const client = fakeClient({ profile: { accounting_basis: 'cash' } });
  await assert.rejects(call(client), (e) => e.code === 'SUPPLIER_BILL_CASH_BASIS_NO_AP_POST');
  assert.equal(wroteLedger(client), false);
});

// ── The GB split (D-FI3-S4's shape) ────────────────────────────────────────

test('an unresolvable treatment refuses — posting gross would forfeit the reclaim', async () => {
  // confidentCoding carries no tax treatment → no resolvable GB code.
  const client = fakeClient();
  await assert.rejects(call(client), (e) => e.code === 'SUPPLIER_BILL_GB_VAT_SPLIT_UNSUPPORTED' && e.statusCode === 409);
  assert.equal(wroteLedger(client), false);
});

test("the unsure marker ('VAT check') refuses the same way", async () => {
  const client = fakeClient();
  await assert.rejects(
    call(client, { coding: { ...confidentCoding, tax_treatment: 'VAT check' } }),
    (e) => e.code === 'SUPPLIER_BILL_GB_VAT_SPLIT_UNSUPPORTED'
  );
  assert.equal(wroteLedger(client), false);
});

test('a VAT 20% verdict posts the SPLIT: net expense + chart-resolved control / payables gross', async () => {
  // £120 gross at 20% → net 100 + vat 20; the bill STATES 20.
  const client = fakeClient();
  await call(client, { coding: { ...confidentCoding, tax_treatment: 'VAT 20%' } });
  const lines = insertedLines(client);
  assert.equal(lines.length, 3);
  assert.deepEqual(
    lines.map((l) => [l.account_code, l.debit, l.credit]),
    [['7500', 100, 0], ['2202', 20, 0], ['2200', 0, 120]]
  );
  assert.equal(lines[0].tax_type, 'VAT_SR_20_INPUT', 'the resolved CODE rides the base line');
  assert.equal(lines[1].tax_type, 'NONE', 'no code on the control leg (the cross-market invariant)');
  assert.equal(lines[1].payload.role, 'vat_input_deductible', 'the role persists for the return cross-check');
});

test('a stated VAT that disagrees with the rate arithmetic refuses — never shaded', async () => {
  // Stated 15 vs 20%-computed 20 → beyond 2 pence. (A historical-rate bill,
  // e.g. 12.5% hospitality, trips this same honest refusal.)
  const client = fakeClient({ document: billRow({ tax_amount: 15 }) });
  await assert.rejects(
    call(client, { coding: { ...confidentCoding, tax_treatment: 'VAT 20%' } }),
    (e) => e.code === 'SUPPLIER_BILL_GB_VAT_AMOUNT_MISMATCH' && e.statusCode === 409
  );
  assert.equal(wroteLedger(client), false);
});

test('a splitting code with no single active VAT-control role row refuses — never a silent gross post', async () => {
  const client = fakeClient({ chartRows: [PAYABLES_ROW] });
  await assert.rejects(
    call(client, { coding: { ...confidentCoding, tax_treatment: 'VAT 20%' } }),
    (e) => e.code === 'SUPPLIER_BILL_GB_VAT_CONTROL_UNRESOLVED' && e.statusCode === 409
  );
  assert.equal(wroteLedger(client), false);
});

test('two candidate control rows also refuse (fail-closed both ways)', async () => {
  const client = fakeClient({ chartRows: [PAYABLES_ROW, VAT_CONTROL_ROW, { ...VAT_CONTROL_ROW, id: 'acc-vat-2', code: '2203' }] });
  await assert.rejects(
    call(client, { coding: { ...confidentCoding, tax_treatment: 'VAT 20%' } }),
    (e) => e.code === 'SUPPLIER_BILL_GB_VAT_CONTROL_UNRESOLVED'
  );
  assert.equal(wroteLedger(client), false);
});

test('a zero-rated purchase posts unsplit with its code on the base line', async () => {
  const client = fakeClient({ document: billRow({ tax_amount: 0 }) });
  await call(client, { coding: { ...confidentCoding, tax_treatment: 'Zero-rated 0%' } });
  const lines = insertedLines(client);
  assert.equal(lines.length, 2);
  assert.deepEqual(lines.map((l) => [l.account_code, l.debit, l.credit]), [['7500', 120, 0], ['2200', 0, 120]]);
  assert.equal(lines[0].tax_type, 'VAT_ZR_INPUT', 'Box 7 still sees the purchase');
});

test('a blocked purchase posts GROSS unsplit — the irrecoverable VAT stays in the expense (IV-2a)', async () => {
  const client = fakeClient({ document: billRow({ tax_amount: 20 }) });
  await call(client, { coding: { ...confidentCoding, tax_treatment: 'VAT blocked (no reclaim)' } });
  const lines = insertedLines(client);
  assert.equal(lines.length, 2);
  assert.deepEqual(lines.map((l) => [l.account_code, l.debit, l.credit]), [['7500', 120, 0], ['2200', 0, 120]]);
  assert.equal(lines[0].tax_type, 'VAT_BLOCKED_INPUT', 'no reclaim leg, no Box 4 — Box 7 only');
});

test('a chart with no accounts-payable role row refuses — CRing FI\'s 2870 into a GB book is the country corner', async () => {
  const client = fakeClient({ chartRows: [VAT_CONTROL_ROW] });
  await assert.rejects(
    call(client, { coding: { ...confidentCoding, tax_treatment: 'VAT 20%' } }),
    (e) => e.code === 'SUPPLIER_BILL_GB_PAYABLES_UNRESOLVED' && e.statusCode === 409
  );
  assert.equal(wroteLedger(client), false);
});

test('the writer returns the credited payables coding so the settlement swap cannot drift (KEEP invariant 2)', async () => {
  const client = fakeClient();
  const out = await call(client, { coding: { ...confidentCoding, tax_treatment: 'VAT 20%' } });
  assert.deepEqual(out.payables_coding, {
    account_code: '2200',
    account_name: 'Trade creditors',
    account_type: 'liability',
    account_label: '2200 · Trade creditors'
  });
});

test('an EU acquisition posts unsplit with its self-assessed code riding the base line (IV-2b)', async () => {
  const client = fakeClient({ document: billRow({ tax_amount: 0 }) });
  await call(client, { coding: { ...confidentCoding, tax_treatment: 'EU acquisition' } });
  const lines = insertedLines(client);
  assert.equal(lines.length, 2);
  assert.equal(lines[0].tax_type, 'VAT_EU_ACQUISITION_20_INPUT');
});
