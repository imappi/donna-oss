import assert from 'node:assert/strict';
import test from 'node:test';
import { __commitPreparedLedgerPosting, postSupplierBillJournalWithClient } from './firmDb.js';
import { resolvePostingContextWithClient, postingSourceReceipt } from './db/postingPolicyContext.js';

const VAT = { id: 'vat', code: '2202', name: 'VAT control', account_type: 'liability', normal_balance: 'credit', currency: 'GBP', tax_type: 'NONE', canonical_role: 'liability.sales_tax_payable', status: 'active' };
const AP = { id: 'ap', code: '2200', name: 'Trade creditors', account_type: 'liability', normal_balance: 'credit', currency: 'GBP', tax_type: 'NONE', canonical_role: 'liability.accounts_payable', status: 'active' };
const document = (over = {}) => ({ id: 'doc1', document_type: 'supplier_bill', parse_status: 'completed', duplicate_of: null, vendor_name: 'Supplier', total_amount: 120, tax_amount: 20, document_date: '2026-07-02', currency: 'GBP', reference_number: 'B1', ...over });
const pool = ({ doc = document(), chart = [VAT, AP] } = {}) => {
  const queries = [];
  return { queries, async query(sql, params = []) {
    queries.push({ sql, params });
    // Policy receipt shares the caller-owned posting transaction and lock.
    if (['savepoint runtime_policy_incident', 'release savepoint runtime_policy_incident',
      'rollback to savepoint runtime_policy_incident',
      'select pg_advisory_xact_lock(hashtextextended($1, 0))'].includes(sql)) return { rows: [] };
    // Canonical lineage observes this same unmarked client; no native birth is seeded.
    if (sql.includes('as birth_created_at') && sql.includes('from clients')) return { rows: [{ id: params[1], firm_id: params[0], birth_created_at: null, jurisdiction: 'gb', entity_type: null, profile: { accounting_basis: 'accrual', accounting_system: 'none' } }] };
    if (sql.includes('select jurisdiction, entity_type, profile from clients')) return { rows: [{ jurisdiction: 'gb', entity_type: null, profile: { accounting_basis: 'accrual', accounting_system: 'none' } }] };
    if (sql.includes('select * from transactions')) return { rows: this.transaction ? [this.transaction] : [] };
    if (sql.includes('select id from transactions')) return { rows: this.transaction ? [{ id: this.transaction.id }] : [] };
    if (sql.includes('from audit_events') && sql.trimStart().startsWith('select')) return { rows: [] };
    if (sql.includes('from client_capability_config')) return { rows: [{ flag_key: 'JURISDICTION_TAX_CODING', stage: 'auto', source: 'test', client_id: 'c1' }] };
    if (sql.includes('from cohort_capability_config')) return { rows: [] };
    if (sql.includes('select jurisdiction from clients')) return { rows: [{ jurisdiction: 'gb' }] };
    if (sql.includes('select coding_state from transactions')) return { rows: [{ coding_state: 'applied' }] }; // RT-16: the coding writer's lock read at commit
    if (sql.includes('select profile from clients')) return { rows: [{ profile: { accounting_basis: 'accrual' } }] };
    // The caller supplies an AP plan here; this fixture has no persisted match
    // rows. Exercise the current source-lock/read fences without inventing one.
    if (sql.includes('from reconciliation_matches m') && sql.includes('join documents d')) return { rows: [] };
    if (sql.includes('from reconciliation_matches rm') && sql.includes('join documents d')) return { rows: [] };
    if (sql.includes('from documents')) return { rows: [doc] };
    if (sql.includes('from ledger_accounts')) return { rows: chart };
    if (sql.includes('from ledger_journals lj') || sql.includes('from close_periods')) return { rows: [] };
    if (sql.includes('insert into ledger_accounts') || sql.includes('delete from ledger_lines') || sql.includes('update transactions') || sql.includes('update client_evidence_requests') || sql.includes('update transaction_review_queue')) return { rows: [] };
    if (sql.includes('insert into ledger_journals')) return { rows: [{ id: 'journal1' }] };
    if (sql.includes('insert into ledger_lines')) return { rows: [] };
    if (sql.includes('incorporation_date, entity_type from clients')) return { rows: [{ incorporation_date: '2025-01-01', entity_type: 'gb-ltd' }] };
    if (sql.includes('insert into audit_events')) return { rows: [{ id: 1 }] };
    throw new Error(`Unexpected query: ${sql}`);
  }};
};
const coding = (tax_treatment) => ({ proposed_account: 'Costs', account_code: '7500', account_type: 'expense', confidence: 'high', model: 'fixture-model', ...(tax_treatment ? { tax_treatment } : {}) });
const post = (client, taxTreatment) => postSupplierBillJournalWithClient({ client, firmId: 'f1', clientId: 'c1', documentId: 'doc1', coding: coding(taxTreatment), authorityBasis: { source: 'ap_settlement', transaction_id: 'tx1' }, model: 'fixture-model', actorId: 'owner1' });
const lines = (client) => client.queries.filter(q => q.sql.includes('insert into ledger_lines')).map(q => ({ code: q.params[5], debit: q.params[9], credit: q.params[10], tax: q.params[13], payload: JSON.parse(q.params[15]) }));
const wrote = (client) => client.queries.some(q => q.sql.includes('insert into ledger_journals'));

test('SR 20 stated-VAT agreement posts the GB AP twin split through the writer', async () => {
  const client = pool(); await post(client, 'VAT 20%');
  assert.deepEqual(lines(client).map(x => [x.code, x.debit, x.credit, x.tax]), [['7500',100,0,'VAT_SR_20_INPUT'],['2202',20,0,'NONE'],['2200',0,120,'NONE']]);
  assert.equal(lines(client)[1].payload.role, 'vat_input_deductible');
});

for (const [label, tax, expected] of [
  ['zero', 'Zero-rated 0%', 'VAT_ZR_INPUT'], ['exempt', 'VAT exempt', 'VAT_EXEMPT_INPUT'],
  ['outside', 'Outside the scope of VAT', 'VAT_OUTSIDE_SCOPE_INPUT'], ['reverse charge', 'Reverse charge', 'VAT_REVERSE_CHARGE_20_INPUT'],
  ['EU acquisition', 'EU acquisition', 'VAT_EU_ACQUISITION_20_INPUT']
]) test(`${label} posts unsplit with its resolved input code`, async () => {
  const client = pool({ doc: document({ tax_amount: 0 }) }); await post(client, tax);
  assert.deepEqual(lines(client).map(x => [x.code, x.debit, x.credit]), [['7500',120,0],['2200',0,120]]);
  assert.equal(lines(client)[0].tax, expected);
});

for (const [name, options, treatment, code] of [
  ['stated VAT mismatch', { doc: document({ tax_amount: 15 }) }, 'VAT 20%', 'SUPPLIER_BILL_GB_VAT_AMOUNT_MISMATCH'],
  ['unresolvable label', {}, 'VAT check', 'SUPPLIER_BILL_GB_VAT_SPLIT_UNSUPPORTED'],
  ['unresolved control', { chart: [AP] }, 'VAT 20%', 'SUPPLIER_BILL_GB_VAT_CONTROL_UNRESOLVED']
]) test(`${name} is the exact pre-write refusal consumed by the enumerated AP fallback`, async () => {
  const client = pool(options);
  await assert.rejects(post(client, treatment), error => error.code === code && error.statusCode === 409);
  assert.equal(wrote(client), false, 'fallback receives a clean transaction; no partial AP posting exists');
});


const commitFallback = async (client, treatment) => {
  const verdict = coding(treatment);
  const transaction = { id: 'tx1', client_id: 'c1', transaction_date: '2026-07-08', date: '2026-07-08', description: 'Supplier payment', money_in: 0, money_out: 120, currency: 'GBP', account_currency: 'GBP', payload: { currency: 'GBP', ai_suggestion: verdict }, ai_suggestion: verdict };
  client.transaction = transaction;
  const postingContext = await resolvePostingContextWithClient({ client, firmId: 'f1', clientId: 'c1', businessDate: transaction.date });
  return __commitPreparedLedgerPosting({
    client, firmId: 'f1', clientId: 'c1', transactionId: 'tx1', actorId: 'owner1',
    prepared: {
      transaction, postingContext, sourceReceipt: postingSourceReceipt(transaction),
      preview: { coding: verdict, bank_account: { code: '1200', name: 'Bank', account_type: 'bank', normal_balance: 'debit' } },
      apSettlement: { planned: true, document_id: 'doc1', reference_number: 'B1', vendor_name: 'Supplier' },
      arSettlement: null
    }
  });
};
const transactionLines = (client) => {
  const journal = client.queries.find(q => q.sql.includes('insert into ledger_journals') && q.params[3] === 'transaction');
  return client.queries.filter(q => q.sql.includes('insert into ledger_lines') && q.params[1] === journal?.params[0]).map(q => q.params);
};
const settlementReceipt = (client) => {
  const audit = client.queries.find(q => q.sql.includes('ledger.post_transaction'));
  return JSON.parse(audit.params[4]).ap_settlement;
};

test('each GB refusal is enumerated at commit: byte-identical legacy posting plus a typed receipt', async () => {
  // RT-23 (2026-09-09): the unsure marker on an expense leg no longer falls
  // back to a gross uncoded post — the Keep layer refuses the whole post by
  // name before any journal (the FI twin: TRANSACTION_ALV_TREATMENT_UNRESOLVED).
  const unsure = pool();
  await assert.rejects(commitFallback(unsure, 'VAT check'), (e) => e.code === 'TRANSACTION_GB_VAT_TREATMENT_UNRESOLVED' && e.statusCode === 409);
  assert.equal(wrote(unsure), false, 'no journal of any source');
  const scenarios = [
    [{ doc: document({ tax_amount: 15 }) }, 'VAT 20%', 'SUPPLIER_BILL_GB_VAT_AMOUNT_MISMATCH'],
    [{ chart: [AP] }, 'VAT 20%', 'SUPPLIER_BILL_GB_VAT_CONTROL_UNRESOLVED']
  ];
  for (const [options, treatment, reason] of scenarios) {
    const baseline = pool(options);
    const verdict = coding(treatment);
    const transaction = { id: 'tx1', client_id: 'c1', transaction_date: '2026-07-08', date: '2026-07-08', description: 'Supplier payment', money_in: 0, money_out: 120, currency: 'GBP', account_currency: 'GBP', payload: { currency: 'GBP', ai_suggestion: verdict }, ai_suggestion: verdict };
    baseline.transaction = transaction;
    const postingContext = await resolvePostingContextWithClient({ client: baseline, firmId: 'f1', clientId: 'c1', businessDate: transaction.date });
    await __commitPreparedLedgerPosting({ client: baseline, firmId: 'f1', clientId: 'c1', transactionId: 'tx1', actorId: 'owner1', prepared: { transaction, postingContext, sourceReceipt: postingSourceReceipt(transaction), preview: { coding: verdict, bank_account: { code: '1200', name: 'Bank', account_type: 'bank', normal_balance: 'debit' } }, apSettlement: null, arSettlement: null } });
    const client = pool(options);
    await commitFallback(client, treatment);
    assert.equal(client.queries.filter(q => q.sql.includes('insert into ledger_journals') && q.params[3] === 'supplier_bill').length, 0);
    assert.deepEqual(transactionLines(client), transactionLines(baseline), `${reason}: fallback journal is byte-identical`);
    assert.deepEqual(settlementReceipt(client), { applied: false, reason });
  }
});
