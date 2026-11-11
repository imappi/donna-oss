// FI-9 (P) — postSupplierBillJournalWithClient against a pattern-matching fake
// pg client (same style as finlandSalesInvoicePostDb.test.js): every refusal
// gate fires BEFORE any ledger write, and the happy path routes through the
// shared journal-insert discipline with the audit receipt in the same
// transaction.
//   node --test server/donna/finlandSupplierBillPostDb.test.js
// Design + acceptance criteria: docs/design-donna-finland-fi9-receive-and-ap-post.md §P.

import assert from 'node:assert/strict';
import test from 'node:test';

import { postSupplierBillJournalWithClient } from './firmDb.js';

const billRow = ({
  document_type = 'supplier_bill',
  parse_status = 'completed',
  duplicate_of = null,
  total_amount = 620,
  tax_amount = 120
} = {}) => ({
  id: 'doc-001',
  document_type,
  parse_status,
  duplicate_of,
  vendor_name: 'Toimittaja Oy',
  total_amount,
  tax_amount,
  document_date: '2026-07-02',
  currency: 'EUR',
  reference_number: 'RF18539007547034'
});

// Pattern-matching fake client. `flags` become client_capability_config rows;
// `queries` records every SQL for gate-ordering assertions.
const fakeClient = ({
  flags = { FINLAND_EINVOICE_RECEIVE: 'auto' },
  profile = { accounting_basis: 'accrual', alv_registration: { status: 'registered', registered_from: '2020-01-01' } },
  document = billRow(),
  lockedAtDate = false,
  existingJournal = null
} = {}) => {
  const queries = [];
  return {
    queries,
    async query(sql, params = []) {
      queries.push({ sql, params });
      // The filed-VAT-return guard's reads (db/ledger.js assertJournalDateOutsideFiledReturn,
      // 2026-11-10): no stored chart for the journal's codes and no filed return in this fixture.
      if (sql.includes('select code, account_type from ledger_accounts')) return { rows: [] };
      if (sql.includes('from alv_returns')) return { rows: [] };
      if (sql === 'select id from ledger_accounts where firm_id=$1 and client_id=$2 order by id for update') {
        assert.deepEqual(params,['firm-1','client-1']);
        return {rows:[]};
      }
      // Canonical lineage observes this same unmarked client; no native birth is seeded.
      if (sql.includes('as birth_created_at') && sql.includes('from clients')) return { rows: [{ id: params[1], firm_id: params[0], birth_created_at: null, jurisdiction: 'fi', entity_type: 'fi-toiminimi', profile }] };
      if (sql.includes('select jurisdiction, entity_type, profile from clients')) return { rows: [{ jurisdiction: 'fi', entity_type: 'fi-toiminimi', profile }] };
      if (sql.includes('from audit_events where firm_id=$1 and resource_id=$2')) return { rows: [] }; // no client birth receipts in this fixture
      if (sql === 'select id,code,name,account_type,normal_balance,canonical_role,status,currency,payload\n    from ledger_accounts where firm_id=$1 and client_id=$2 order by id') return { rows: [] }; // no pre-existing chart is seeded
      if (sql.includes('from client_capability_config')) {
        return { rows: Object.entries(flags).map(([flag_key, stage]) => ({ flag_key, stage, source: 'test', client_id: 'client-1' })) };
      }
      if (sql.includes('from cohort_capability_config')) return { rows: [] };
      if (sql.includes('select profile from clients')) return { rows: [{ profile }] };
      if (sql.includes('from documents')) return { rows: document ? [document] : [] };
      if (sql.includes('from ledger_journals lj')) return { rows: existingJournal ? [existingJournal] : [] };
      if (sql.includes('from close_periods')) return { rows: lockedAtDate ? [{ id: 'cp-1' }] : [] };
      if (sql.startsWith('select id, code from ledger_accounts') || sql.startsWith('select 1 from ledger_accounts where firm_id=$1 and client_id=$2 and id=$3')) return { rows: [] }; // the mint's existing-row lookup (2026-11-10)
      if (sql.includes('insert into ledger_accounts')) return { rows: [] };
      if (sql.includes('insert into ledger_journals')) return { rows: [{ id: 'journal-1' }] };
      if (sql.includes('delete from ledger_lines')) return { rows: [] };
      if (sql.includes('insert into ledger_lines')) return { rows: [] };
      if (sql.includes('incorporation_date, entity_type from clients')) return { rows: [{ incorporation_date: '2025-06-15', entity_type: 'fi-toiminimi' }] };
      if (sql.includes('insert into audit_events')) return { rows: [{ id: 42 }] };
      throw new Error(`Unexpected query: ${sql}`);
    }
  };
};

const confidentCoding = {
  proposed_account: 'Ulkopuoliset palvelut',
  account_code: '4400',
  account_type: 'expense',
  confidence: 'high',
  model: 'test-coder-model'
};

const call = (client, overrides = {}) => postSupplierBillJournalWithClient({
  client,
  firmId: 'firm-1',
  clientId: 'client-1',
  documentId: 'doc-001',
  coding: confidentCoding,
  authorityBasis: { source: 'auto_explain', policy: 'supplier_bill_auto_explain_v1' },
  model: 'test-model',
  actorId: 'system',
  ...overrides
});

const wroteLedger = (client) => client.queries.some((q) => q.sql.includes('insert into ledger_journals'));

test('flag off refuses (409) before touching the ledger', async () => {
  const client = fakeClient({ flags: {} });
  await assert.rejects(call(client), (e) => e.code === 'FINLAND_EINVOICE_RECEIVE_DISABLED' && e.statusCode === 409);
  assert.equal(wroteLedger(client), false);
});

test('cash-basis client refuses the AP post before touching the ledger', async () => {
  const client = fakeClient({ profile: { accounting_basis: 'cash' } });
  await assert.rejects(call(client), (e) => e.code === 'SUPPLIER_BILL_CASH_BASIS_NO_AP_POST' && e.statusCode === 409);
  assert.equal(wroteLedger(client), false);
});

test('a missing coding verdict refuses (D-FI9-2) before touching the ledger', async () => {
  const client = fakeClient();
  await assert.rejects(call(client, { coding: null }), (e) => e.code === 'SUPPLIER_BILL_CODING_VERDICT_REQUIRED' && e.statusCode === 409);
  assert.equal(wroteLedger(client), false);
});

test('a placeholder (Suspense) verdict refuses — a bare guess is not a coding', async () => {
  const client = fakeClient();
  await assert.rejects(
    call(client, { coding: { proposed_account: 'Suspense', confidence: 'high' } }),
    (e) => e.code === 'SUPPLIER_BILL_CODING_VERDICT_REQUIRED'
  );
  assert.equal(wroteLedger(client), false);
});

test('a below-high-confidence verdict refuses — unsure stays an owner ask', async () => {
  const client = fakeClient();
  await assert.rejects(
    call(client, { coding: { ...confidentCoding, confidence: 'medium' } }),
    (e) => e.code === 'SUPPLIER_BILL_CODING_NOT_CONFIDENT' && e.statusCode === 409
  );
  assert.equal(wroteLedger(client), false);
});

test('a red / balance-sheet-class account refuses — stubborn per the L1 doctrine', async () => {
  const client = fakeClient();
  await assert.rejects(
    call(client, { coding: { proposed_account: "Director's loan", account_code: '901', confidence: 'high' } }),
    (e) => e.code === 'SUPPLIER_BILL_CODING_RED_ACCOUNT' && e.statusCode === 409
  );
  assert.equal(wroteLedger(client), false);
});

// ── FI-3 slice S (D-FI3-S4) — the ALV split retires the D-FI9-3 blanket refusal ──

const ALV_FLAGS = { FINLAND_EINVOICE_RECEIVE: 'auto', FINLAND_ALV_CODING: 'auto' };
const insertedLines = (client) => client.queries
  .filter((q) => q.sql.includes('insert into ledger_lines'))
  .map((q) => ({ account_code: q.params[5], direction: q.params[8], debit: q.params[9], credit: q.params[10], tax_type: q.params[13], payload: JSON.parse(q.params[15]) }));

test('ALV-coding client with an unresolvable treatment still refuses — gross would forfeit the deduction', async () => {
  const client = fakeClient({ flags: ALV_FLAGS });
  // confidentCoding carries no tax treatment → no resolvable ALV code.
  await assert.rejects(call(client), (e) => e.code === 'SUPPLIER_BILL_ALV_SPLIT_UNSUPPORTED' && e.statusCode === 409);
  assert.equal(wroteLedger(client), false);
});

test('ALV-coding client with a domestic-rate verdict posts the SPLIT: net expense + 2940 VAT / 2870 gross', async () => {
  // 620 gross at 25.5% → net 494.02 + vat 125.98; the bill STATES 125.98.
  const client = fakeClient({ flags: ALV_FLAGS, document: billRow({ tax_amount: 125.98 }) });
  await call(client, { coding: { ...confidentCoding, tax_treatment: 'ALV 25,5 %' } });
  const lines = insertedLines(client);
  assert.equal(lines.length, 3);
  assert.deepEqual(
    lines.map((l) => [l.account_code, l.debit, l.credit]),
    [['4400', 494.02, 0], ['2940', 125.98, 0], ['2870', 0, 620]]
  );
  assert.equal(lines[0].tax_type, 'ALV_25_5_INPUT', 'the resolved CODE rides the base line');
  assert.equal(lines[1].tax_type, 'NONE', 'no code on the control leg (D-FI3-S3)');
  assert.equal(lines[1].payload.role, 'alv_input_deductible', 'the role persists for the cross-check (D-FI3-S5)');
});

test('a stated VAT that disagrees with the rate arithmetic refuses (D-FI3-S4) — never shaded', async () => {
  // Stated 120 vs 25.5%-computed 125.98 → mismatch beyond 2 cents.
  const client = fakeClient({ flags: ALV_FLAGS, document: billRow({ tax_amount: 120 }) });
  await assert.rejects(
    call(client, { coding: { ...confidentCoding, tax_treatment: 'ALV 25,5 %' } }),
    (e) => e.code === 'SUPPLIER_BILL_ALV_AMOUNT_MISMATCH' && e.statusCode === 409
  );
  assert.equal(wroteLedger(client), false);
});

test('a non-splitting code (EU service purchase) posts unsplit — the billed amount IS the base (D-FI3-S1)', async () => {
  const client = fakeClient({ flags: ALV_FLAGS, document: billRow({ tax_amount: 0 }) });
  await call(client, { coding: { ...confidentCoding, tax_treatment: 'EU-palveluosto' } });
  const lines = insertedLines(client);
  assert.equal(lines.length, 2);
  assert.deepEqual(lines.map((l) => [l.account_code, l.debit, l.credit]), [['4400', 620, 0], ['2870', 0, 620]]);
  assert.equal(lines[0].tax_type, 'ALV_EU_SERVICE_ACQUISITION', 'the self-assessed code still rides the base line for the return engine');
});

test('a missing document refuses 404 before touching the ledger', async () => {
  const client = fakeClient({ document: null });
  await assert.rejects(call(client), (e) => e.code === 'SUPPLIER_BILL_DOCUMENT_NOT_FOUND' && e.statusCode === 404);
  assert.equal(wroteLedger(client), false);
});

test('a non-supplier_bill document refuses', async () => {
  const client = fakeClient({ document: billRow({ document_type: 'receipt' }) });
  await assert.rejects(call(client), (e) => e.code === 'SUPPLIER_BILL_WRONG_DOCUMENT_TYPE' && e.statusCode === 409);
  assert.equal(wroteLedger(client), false);
});

test('an unfinished parse refuses', async () => {
  const client = fakeClient({ document: billRow({ parse_status: 'processing' }) });
  await assert.rejects(call(client), (e) => e.code === 'SUPPLIER_BILL_PARSE_NOT_COMPLETED' && e.statusCode === 409);
  assert.equal(wroteLedger(client), false);
});

test('a duplicate bill refuses — the original carries the AP journal', async () => {
  const client = fakeClient({ document: billRow({ duplicate_of: 'doc-000' }) });
  await assert.rejects(call(client), (e) => e.code === 'SUPPLIER_BILL_DUPLICATE_DOCUMENT' && e.statusCode === 409);
  assert.equal(wroteLedger(client), false);
});

test('a locked period at the bill date refuses (one-way-door) before touching the ledger', async () => {
  const client = fakeClient({ lockedAtDate: true });
  await assert.rejects(call(client), (e) => e.code === 'LEDGER_LOCKED_PERIOD_IMMUTABLE' && e.statusCode === 409);
  assert.equal(wroteLedger(client), false);
});

test('an existing supplier_bill journal inside a locked period refuses re-post', async () => {
  const client = fakeClient({ existingJournal: { id: 'journal-old', close_period_id: 'cp-1' } });
  await assert.rejects(call(client), (e) => e.code === 'LEDGER_LOCKED_PERIOD_IMMUTABLE');
  assert.equal(wroteLedger(client), false);
});

test('happy path posts DR expense / CR 2870 GROSS through the shared writer with the in-txn audit receipt', async () => {
  const client = fakeClient();
  const result = await call(client);

  assert.equal(result.journal_id, 'journal-1');
  assert.equal(result.document_id, 'doc-001');
  assert.equal(result.audit_event_id, '42');
  // tosite stays null: FI-4/FI-5 flags are off in this snapshot (allocator no-op).
  assert.equal(result.tosite_number, null);

  const journalInsert = client.queries.find((q) => q.sql.includes('insert into ledger_journals'));
  assert.equal(journalInsert.params[3], 'supplier_bill');
  assert.equal(journalInsert.params[4], 'doc-001');
  assert.equal(journalInsert.params[5], '2026-07-02');
  const payload = JSON.parse(journalInsert.params[8]);
  assert.equal(payload.source, 'native_ledger_supplier_bill');
  assert.equal(payload.document_id, 'doc-001');
  assert.equal(payload.vendor_name, 'Toimittaja Oy');
  assert.equal(payload.coding.account_code, '4400');
  assert.equal(payload.coding.confidence, 'high');
  assert.equal(payload.coding.model, 'test-coder-model');
  assert.equal(payload.model, 'test-model');
  assert.equal(payload.authority_basis.source, 'auto_explain');

  // GROSS (D-FI9-3): both lines carry the full 620 even though tax_amount=120.
  const lineInserts = client.queries.filter((q) => q.sql.includes('insert into ledger_lines'));
  assert.equal(lineInserts.length, 2);
  assert.deepEqual(lineInserts.map((q) => [q.params[5], q.params[8]]), [['4400', 'debit'], ['2870', 'credit']]);
  assert.equal(lineInserts[0].params[9], 620);
  assert.equal(lineInserts[1].params[10], 620);

  const audit = client.queries.find((q) => q.sql.includes('insert into audit_events'));
  assert.ok(audit.sql.includes('ledger.post_supplier_bill'));
  assert.equal(audit.params[2], 'system');
  const metadata = JSON.parse(audit.params[4]);
  assert.equal(metadata.document_id, 'doc-001');
  assert.equal(metadata.total, 620);
  assert.equal(metadata.coding.account_code, '4400');
  assert.equal(metadata.coding.model, 'test-coder-model');
  assert.equal(metadata.model, 'test-model');
  assert.equal(metadata.authority_basis.policy, 'supplier_bill_auto_explain_v1');
});

test('re-post of the same bill reuses the existing journal id (idempotent, no duplicate AP)', async () => {
  const client = fakeClient({ existingJournal: { id: 'journal-old', close_period_id: null } });
  const result = await call(client);
  const journalInsert = client.queries.find((q) => q.sql.includes('insert into ledger_journals'));
  // The existing row's id is passed through — the on-conflict upsert updates it.
  assert.equal(journalInsert.params[0], 'journal-old');
  assert.equal(result.journal_id, 'journal-1');
});
