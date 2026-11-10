import assert from 'node:assert/strict';
import test from 'node:test';
import { POSTING_POLICY_REGISTRY, PostingPolicyError, loadPostingTaxFactAutomation, resolvePostingPolicy, executePostingPolicyOperation } from './postingPolicy.js';
import { buildLedgerJournalForTransaction, buildSalesInvoiceJournal, buildSupplierBillJournal } from './ledger.js';
import { applyAlvCodingToCoding, resolveAlvSplitForPosting } from './finland/alvCodes.js';
import { applyGbVatCodingToCoding, resolveGbVatSplitForPosting, gbVatControlAccountFromChart } from './gb/vatCodes.js';

const chart = [
  { code: 'TAX-CUSTOM', name: 'My tax account', account_type: 'liability', normal_balance: 'credit', canonical_role: 'liability.sales_tax_payable' },
  { code: 'AP-CUSTOM', name: 'My payables', account_type: 'liability', normal_balance: 'credit', canonical_role: 'liability.accounts_payable' }
];
const transaction = { id: 'fixture-transaction', date: '2026-09-05', currency: 'EUR', money_out: 125.5 };
const expense = { account_code: 'OPERATING', account_name: 'Operating expense', xero_account_type: 'EXPENSE' };
const bankAccount = { code: 'BANK', name: 'Entity bank' };
// A VAT-registered UK business: VAT codes post only for one (gb/postingPolicy.js).
const gbRegistered = { vat_registration: { status: 'registered', registered_from: '2020-01-01' } };
// The Finnish twin: the business these fixtures describe posts ALV, so it is
// ALV-registered on its record (finland/postingPolicy.js refuses otherwise).
const fiRegistered = { alv_registration: { status: 'registered', registered_from: '2020-01-01' } };
const fiDated = { date: '2026-09-05' };
const hasCode = (code) => (error) => error instanceof PostingPolicyError && error.code === code;

test('six posting countries explicitly preserve native transaction behavior and operation capabilities', () => {
  for (const jurisdiction of ['fi', 'gb', 'sg', 'ae', 'us', 'au']) {
    const policy = resolvePostingPolicy({ jurisdiction });
    assert.equal(policy.jurisdiction, jurisdiction);
    assert.equal(policy.policyVersion, jurisdiction === 'ae' ? 3 : 1);
    const coding = jurisdiction === 'ae'
      ? { ...expense, tax_treatment: 'Out of scope of UAE VAT', tax_type: 'AE_VAT_OUTSIDE_SCOPE_INPUT', xero_tax_type: 'AE_VAT_OUTSIDE_SCOPE_INPUT' }
      : { ...expense, tax_type: 'NONE' };
    assert.deepEqual(policy.adapter.enrichCoding({ coding, transaction }), coding);
    if (jurisdiction === 'ae') {
      assert.deepEqual(policy.adapter.assertPostableTaxCoding({ coding, transaction, taxCodingEnabled: false }), coding);
    }
    let alvSplit = null;
    if (policy.capabilities.transactionSplit) {
      alvSplit = policy.adapter.transactionSplit({ coding, transaction });
      assert.equal(alvSplit, null);
    } else {
      assert.equal(jurisdiction, 'ae');
      assert.throws(() => policy.adapter.transactionSplit({ coding, transaction }), hasCode('posting_operation_unsupported'));
    }
    const journal = buildLedgerJournalForTransaction({ transaction, coding, bankAccount,
      alvSplit });
    assert.equal(journal.lines.length, 2);
    assert.equal(journal.amount, 125.5);
    if (['sg', 'us', 'au'].includes(jurisdiction)) {
      assert.equal(policy.postingTaxCodingFlagKey, null);
    } else {
      assert.equal(policy.postingTaxCodingFlagKey, jurisdiction === 'fi' ? 'FINLAND_ALV_CODING' : 'JURISDICTION_TAX_CODING');
    }
    if (['sg', 'ae', 'us', 'au'].includes(jurisdiction)) {
      for (const operation of ['salesInvoiceTaxPosting', 'supplierBillTaxPosting']) {
        assert.equal(policy.capabilities[operation], false);
        assert.throws(() => executePostingPolicyOperation(policy, operation, {}), hasCode('posting_operation_unsupported'));
      }
    }
  }
  assert.equal(resolvePostingPolicy({ jurisdiction: ' UK ' }).jurisdiction, 'gb');
});

test('FI selected adapter preserves enrichment, split, control and journal bytes', () => {
  const policy = resolvePostingPolicy({ jurisdiction: 'fi' });
  const original = { ...expense, tax_treatment: 'ALV 25,5 %' };
  const coding = policy.adapter.enrichCoding({ coding: original, transaction, taxCodingEnabled: true });
  assert.deepEqual(coding, applyAlvCodingToCoding({ coding: original, transaction }));
  const alvSplit = policy.adapter.transactionSplit({ coding, transaction });
  assert.deepEqual(alvSplit, resolveAlvSplitForPosting({ coding, transaction }));
  assert.equal(alvSplit.net, 100);
  assert.equal(alvSplit.vat, 25.5);
  assert.equal(alvSplit.controlAccount.code, '2940');
  const journal = buildLedgerJournalForTransaction({ transaction, coding, bankAccount, alvSplit });
  assert.deepEqual(journal, buildLedgerJournalForTransaction({ transaction, coding, bankAccount,
    alvSplit: resolveAlvSplitForPosting({ coding, transaction }) }));
  assert.equal(journal.lines.length, 3);
  assert.equal(policy.adapter.prepareLedgerAccounts({ ledgerAccounts: [], taxCodingEnabled: true })[0].code, '2939');
  assert.equal(policy.adapter.salesInvoiceTaxPosting().outputCodeForRate(25.5), 'ALV_25_5_OUTPUT');
  assert.equal(policy.adapter.salesInvoiceTaxPosting({ channel: 'outbound' }), null, 'no unbuilt issuance lane is activated');
});

test('GB selected adapter uses entity-owned accounts and preserves exact existing split bytes', () => {
  const policy = resolvePostingPolicy({ jurisdiction: 'gb' });
  const tx = { ...transaction, money_out: 120, currency: 'GBP' };
  const original = { ...expense, tax_treatment: 'VAT 20%' };
  const coding = policy.adapter.enrichCoding({ coding: original, transaction: tx, ledgerAccounts: chart, taxCodingEnabled: true });
  assert.deepEqual(coding, applyGbVatCodingToCoding({ coding: original, transaction: tx,
    controlAccount: gbVatControlAccountFromChart(chart, 'liability.sales_tax_payable') }));
  const alvSplit = policy.adapter.transactionSplit({ coding, transaction: tx });
  assert.deepEqual(alvSplit, resolveGbVatSplitForPosting({ coding, transaction: tx }));
  assert.equal(alvSplit.controlAccount.code, 'TAX-CUSTOM');
  assert.equal(alvSplit.net, 100);
  assert.equal(alvSplit.vat, 20);
  assert.equal(buildLedgerJournalForTransaction({ transaction: tx, coding, bankAccount, alvSplit }).lines.length, 3);
  assert.equal(policy.adapter.salesInvoiceTaxPosting({ controlAccount: chart[0] }).control.account.code, 'TAX-CUSTOM');
  assert.equal(policy.adapter.salesInvoiceTaxPosting().control, null, 'zero-rated invoice needs no unused control');
});

test('foreign native tax codes refuse before every coding-bearing operation, including conflicting field homes', () => {
  for (const jurisdiction of ['fi', 'gb', 'sg', 'ae', 'us', 'au']) {
    const policy = resolvePostingPolicy({ jurisdiction });
    const foreign = jurisdiction === 'fi' ? 'VAT_SR_20_INPUT' : 'ALV_25_5_INPUT';
    for (const field of ['tax_type', 'xero_tax_type']) {
      const coding = { ...expense, tax_type: 'NONE', xero_tax_type: 'NONE', [field]: foreign };
      assert.throws(() => policy.adapter.enrichCoding({ coding, transaction, taxCodingEnabled: false }), hasCode('posting_tax_code_foreign'));
      if (policy.capabilities.transactionSplit) {
        assert.throws(() => policy.adapter.transactionSplit({ coding, transaction }), hasCode('posting_tax_code_foreign'));
      }
      if (policy.capabilities.assertPostableTaxCoding) {
        assert.throws(() => policy.adapter.assertPostableTaxCoding({ coding, transaction }), hasCode('posting_tax_code_foreign'));
      }
      if (policy.capabilities.supplierBillTaxPosting) {
        assert.throws(() => policy.adapter.supplierBillTaxPosting({ verdict: coding }), hasCode('posting_tax_code_foreign'));
      }
    }
  }
  const fi = resolvePostingPolicy({ jurisdiction: 'fi' });
  assert.throws(() => fi.adapter.transactionSplit({ coding: { tax_type: 'ALV_INVENTED' } }), hasCode('posting_tax_code_invalid'));
});

test('supplier adapters preserve stated VAT tolerance, country refusals, and chart resolution', () => {
  const fi = resolvePostingPolicy({ jurisdiction: 'fi' }).adapter;
  const gb = resolvePostingPolicy({ jurisdiction: 'gb' }).adapter;
  const fiInput = { verdict: { tax_treatment: 'ALV 25,5 %' }, document: { total_amount: 125.5, tax_amount: 25.51, document_date: '2026-09-05' }, taxCodingEnabled: true, profile: fiRegistered };
  const fiResult = fi.supplierBillTaxPosting(fiInput);
  assert.equal(fiResult.alvSplit.net, 99.99);
  assert.equal(fiResult.alvSplit.vat, 25.51);
  assert.equal(fiResult.expenseTaxType, 'ALV_25_5_INPUT');
  assert.equal(fiResult.payablesAccount.code, '2870');
  assert.throws(() => fi.supplierBillTaxPosting({ ...fiInput, document: { total_amount: 125.5, tax_amount: 30, document_date: '2026-09-05' } }), { code: 'SUPPLIER_BILL_ALV_AMOUNT_MISMATCH' });
  assert.throws(() => fi.supplierBillTaxPosting({ ...fiInput, verdict: { tax_treatment: 'ALV-tarkistus' } }), { code: 'SUPPLIER_BILL_ALV_SPLIT_UNSUPPORTED' });
  const gbInput = { verdict: { tax_treatment: 'VAT 20%' }, document: { total_amount: 120, tax_amount: 20, document_date: '2026-09-05' }, taxCodingEnabled: true, ledgerAccounts: chart, profile: gbRegistered };
  const gbResult = gb.supplierBillTaxPosting(gbInput);
  assert.equal(gbResult.payablesAccount.code, 'AP-CUSTOM');
  assert.equal(gbResult.alvSplit.controlAccount.code, 'TAX-CUSTOM');
  assert.equal(gbResult.alvSplit.net, 100);
  assert.throws(() => gb.supplierBillTaxPosting({ ...gbInput, ledgerAccounts: [] }), { code: 'SUPPLIER_BILL_GB_PAYABLES_UNRESOLVED' });
  assert.throws(() => gb.supplierBillTaxPosting({ ...gbInput, ledgerAccounts: [chart[1]] }), { code: 'SUPPLIER_BILL_GB_VAT_CONTROL_UNRESOLVED' });
  assert.throws(() => gb.supplierBillTaxPosting({ ...gbInput, ledgerAccounts: [...chart, chart[0]] }), { code: 'SUPPLIER_BILL_GB_VAT_CONTROL_UNRESOLVED' });
  assert.throws(() => gb.supplierBillTaxPosting({ ...gbInput, document: { ...gbInput.document, tax_amount: 24 } }), { code: 'SUPPLIER_BILL_GB_VAT_AMOUNT_MISMATCH' });
  const blocked = gb.supplierBillTaxPosting({ ...gbInput, verdict: { tax_type: 'VAT_BLOCKED_INPUT' }, ledgerAccounts: [chart[1]] });
  assert.equal(blocked.alvSplit, null);
  assert.equal(blocked.expenseTaxType, 'VAT_BLOCKED_INPUT');
});

test('registered invoice and supplier operations feed balanced real journal builders', () => {
  for (const [jurisdiction, rate, taxCode, controlCode] of [
    ['fi', 25.5, 'ALV_25_5_OUTPUT', '2939'], ['gb', 20, 'VAT_SR_20_OUTPUT', 'TAX-CUSTOM']
  ]) {
    const adapter = resolvePostingPolicy({ jurisdiction }).adapter;
    const invoice = { invoiceNumber: 'INVOICE-FIXTURE', date: '2026-09-05', subtotal: 100,
      alvTotal: rate, total: 100 + rate, alvExempt: false,
      lines: [{ description: 'Service', quantity: 1, unitPrice: 100, alvRate: rate, net: 100, alv: rate }] };
    const journal = buildSalesInvoiceJournal({ invoice, currency: 'EUR',
      receivableAccount: { code: 'AR', name: 'Receivables', type: 'asset' },
      revenueAccount: { code: 'REV', name: 'Revenue', type: 'revenue' },
      taxPosting: adapter.salesInvoiceTaxPosting({ controlAccount: chart[0] }) });
    assert.equal(journal.lines[1].account.tax_type, taxCode);
    assert.equal(journal.lines[2].account.code, controlCode);
    assert.equal(journal.lines[0].debit, journal.lines[1].credit + journal.lines[2].credit);
    const bill = { documentId: 'BILL-FIXTURE', date: '2026-09-05', total: 100 + rate };
    const tax = adapter.supplierBillTaxPosting({ verdict: { tax_treatment: jurisdiction === 'fi' ? 'ALV 25,5 %' : 'VAT 20%' },
      document: { total_amount: 100 + rate, tax_amount: rate, document_date: '2026-09-05' }, ledgerAccounts: chart, taxCodingEnabled: true, profile: jurisdiction === 'fi' ? fiRegistered : gbRegistered });
    const supplierJournal = buildSupplierBillJournal({ bill,
      expenseAccount: { code: 'EXP', name: 'Expense', type: 'expense', tax_type: tax.expenseTaxType },
      ...(tax.payablesAccount ? { payablesAccount: tax.payablesAccount } : {}), alvSplit: tax.alvSplit });
    assert.equal(supplierJournal.lines.length, 3);
    assert.equal(supplierJournal.lines.reduce((total, line) => total + Number(line.debit || 0), 0),
      supplierJournal.lines.reduce((total, line) => total + Number(line.credit || 0), 0));
  }
});

test('absent, inconsistent and malformed policies fail with typed errors, with no country default', () => {
  assert.throws(() => resolvePostingPolicy(), hasCode('jurisdiction_unresolved'));
  assert.throws(() => resolvePostingPolicy({ jurisdiction: 'nz' }), hasCode('jurisdiction_unsupported'));
  assert.throws(() => resolvePostingPolicy({ jurisdiction: 'fi', codingPolicy: { status: 'resolved', jurisdiction: 'gb' } }), hasCode('jurisdiction_context_conflict'));
  assert.throws(() => resolvePostingPolicy({ jurisdiction: 'fi', registry: { fi: null } }), hasCode('posting_policy_unavailable'));
  assert.throws(() => resolvePostingPolicy({ jurisdiction: 'fi', registry: null }), hasCode('posting_policy_invalid'));
  for (const patch of [{ policyVersion: 0 }, { transactionSplit: null }, { capabilities: { transactionSplit: true } }, { nativeTaxCodes: 'ALV_' }]) {
    assert.throws(() => resolvePostingPolicy({ jurisdiction: 'fi', registry: { fi: { ...POSTING_POLICY_REGISTRY.fi, ...patch } } }), hasCode('posting_policy_invalid'));
  }
});

test('a tax-registration declaration must say what posting without VAT means for its country', () => {
  for (const country of ['fi', 'gb']) {
    const declared = POSTING_POLICY_REGISTRY[country].taxRegistration;
    const { withoutTax: _withoutTax, ...missing } = declared;
    for (const taxRegistration of [missing, { ...declared, withoutTax: { ...declared.withoutTax, treatments: { purchase: '', sale: 'x' } } },
      { ...declared, withoutTax: { ...declared.withoutTax, needsRegistration: null } }]) {
      assert.throws(() => resolvePostingPolicy({ jurisdiction: country, registry: { ...POSTING_POLICY_REGISTRY, [country]: { ...POSTING_POLICY_REGISTRY[country], taxRegistration } } }),
        hasCode('posting_policy_invalid'));
    }
  }
});

test('a fixture country registers operations and code ownership without editing shared algorithms', () => {
  const fixture = { ...POSTING_POLICY_REGISTRY.au, jurisdiction: 'nz', policyId: 'nz_fixture_posting',
    nativeTaxCodePrefixes: ['NZ_FIXTURE_'], nativeTaxCodes: ['NZ_FIXTURE_INPUT'],
    enrichCoding: ({ coding }) => ({ ...coding, fixture: true }) };
  const registry = { ...POSTING_POLICY_REGISTRY, nz: fixture };
  const policy = resolvePostingPolicy({ jurisdiction: 'nz', registry });
  assert.deepEqual(policy.adapter.enrichCoding({ coding: { tax_type: 'NZ_FIXTURE_INPUT' } }), { tax_type: 'NZ_FIXTURE_INPUT', fixture: true });
  assert.equal(policy.adapter.transactionSplit({ coding: { tax_type: 'NZ_FIXTURE_INPUT' }, transaction }), null);
  assert.throws(() => resolvePostingPolicy({ jurisdiction: 'au', registry }).adapter.transactionSplit({ coding: { tax_type: 'NZ_FIXTURE_INPUT' } }), hasCode('posting_tax_code_foreign'));
});

test('RT-23: assertPostableTaxCoding refuses an unresolved treatment on a P&L leg, in both VAT policies, and only there', () => {
  const fi = resolvePostingPolicy({ jurisdiction: 'fi' }).adapter;
  const gb = resolvePostingPolicy({ jurisdiction: 'gb' }).adapter;
  const revenue = { proposed_account: 'Sales', account_type: 'revenue' };
  const expense = { proposed_account: 'Utilities', account_type: 'expense' };
  const liability = { proposed_account: 'Loan', account_type: 'liability' };
  // The Kampaamo shape: the coder's own unsure marker on a revenue leg.
  assert.throws(() => fi.assertPostableTaxCoding({ coding: { ...revenue, tax_treatment: 'ALV-tarkistus' }, taxCodingEnabled: true }), { code: 'TRANSACTION_ALV_TREATMENT_UNRESOLVED' });
  assert.throws(() => fi.assertPostableTaxCoding({ coding: { ...expense }, taxCodingEnabled: true }), { code: 'TRANSACTION_ALV_TREATMENT_UNRESOLVED' });
  assert.throws(() => fi.assertPostableTaxCoding({ coding: { ...expense, tax_treatment: 'GST 9%' }, taxCodingEnabled: true }), { code: 'TRANSACTION_ALV_TREATMENT_UNRESOLVED' });
  // A resolved code, an out-of-scope code, a control-account NONE, a balance-sheet leg, or tax coding off: passes.
  assert.deepEqual(fi.assertPostableTaxCoding({ coding: { ...revenue, tax_type: 'ALV_25_5_OUTPUT' }, taxCodingEnabled: true, transaction: fiDated, profile: fiRegistered }), { ...revenue, tax_type: 'ALV_25_5_OUTPUT' });
  assert.deepEqual(fi.assertPostableTaxCoding({ coding: { ...expense, xero_tax_type: 'ALV_OUT_OF_SCOPE' }, taxCodingEnabled: true, transaction: fiDated, profile: fiRegistered }), { ...expense, xero_tax_type: 'ALV_OUT_OF_SCOPE' });
  assert.deepEqual(fi.assertPostableTaxCoding({ coding: { ...revenue, tax_type: 'NONE' }, taxCodingEnabled: true }), { ...revenue, tax_type: 'NONE' });
  assert.deepEqual(fi.assertPostableTaxCoding({ coding: { ...liability, tax_treatment: 'ALV-tarkistus' }, taxCodingEnabled: true }), { ...liability, tax_treatment: 'ALV-tarkistus' });
  assert.deepEqual(fi.assertPostableTaxCoding({ coding: { ...revenue, tax_treatment: 'ALV-tarkistus' }, taxCodingEnabled: false }), { ...revenue, tax_treatment: 'ALV-tarkistus' });
  // The GB twin.
  assert.throws(() => gb.assertPostableTaxCoding({ coding: { ...revenue, tax_treatment: 'VAT check' }, taxCodingEnabled: true }), { code: 'TRANSACTION_GB_VAT_TREATMENT_UNRESOLVED' });
  assert.deepEqual(gb.assertPostableTaxCoding({ coding: { ...revenue, tax_type: 'VAT_SR_20_OUTPUT' }, taxCodingEnabled: true, transaction: { date: '2026-09-05', money_in: 120 }, profile: gbRegistered }), { ...revenue, tax_type: 'VAT_SR_20_OUTPUT' });
  assert.deepEqual(gb.assertPostableTaxCoding({ coding: { ...liability, tax_treatment: 'VAT check' }, taxCodingEnabled: true }), { ...liability, tax_treatment: 'VAT check' });
  // A foreign native code still trips the ownership guard on this operation.
  assert.throws(() => fi.assertPostableTaxCoding({ coding: { ...revenue, tax_type: 'VAT_SR_20_OUTPUT' }, taxCodingEnabled: true }), hasCode('posting_tax_code_foreign'));
  // The policies without tax coding on the bank-line path declare it unsupported — a named no-op, never an implicit one.
  for (const jurisdiction of ['sg', 'us', 'au']) {
    const policy = resolvePostingPolicy({ jurisdiction });
    assert.equal(policy.capabilities.assertPostableTaxCoding, false, jurisdiction);
    assert.throws(() => policy.adapter.assertPostableTaxCoding({ coding: revenue, taxCodingEnabled: true }), hasCode('posting_operation_unsupported'));
  }
});


test('tax-fact automation is explicitly selected from the persisted country and loads lazily', async () => {
  const { loadClientTaxFactAutomation } = await import('./db/taxPostingFacts.js');
  let jurisdiction = 'AE';
  const client = { query: async (sql, values) => {
    assert.equal(sql, 'select jurisdiction from clients where firm_id=$1 and id=$2');
    assert.deepEqual(values, ['fixture-firm','fixture-client']);
    return { rows: [{ jurisdiction }] };
  } };
  const handler = await loadClientTaxFactAutomation({ client, firmId: 'fixture-firm', clientId: 'fixture-client', jurisdiction: 'FI' });
  assert.equal(handler.authorityBasis, 'config_plane:AE_VAT_FACT_AUTOMATION');
  jurisdiction = 'FI';
  assert.equal(await loadClientTaxFactAutomation({ client, firmId: 'fixture-firm', clientId: 'fixture-client', jurisdiction: 'AE' }), null);
  for (const country of ['fi','gb','sg','us','au']) assert.equal(await loadPostingTaxFactAutomation({ jurisdiction: country }), null);
  let calls = 0;
  const registry = { ...POSTING_POLICY_REGISTRY, ae: { ...POSTING_POLICY_REGISTRY.ae, taxFactAutomation: async () => { calls += 1; return handler; } } };
  resolvePostingPolicy({ jurisdiction: 'ae', registry });
  assert.equal(calls, 0, 'ordinary policy registration/resolution never loads model or database composition');
  assert.equal(await loadPostingTaxFactAutomation({ jurisdiction: 'ae', registry }), handler);
  assert.equal(calls, 1);
});

test('a malformed declared tax-fact loader or handler refuses instead of becoming absent', async () => {
  for (const taxFactAutomation of [null, undefined, false, 'loader', async () => null, async () => ({ actorId: 'spoofed' })]) {
    const registry = { ...POSTING_POLICY_REGISTRY, ae: { ...POSTING_POLICY_REGISTRY.ae, taxFactAutomation } };
    await assert.rejects(loadPostingTaxFactAutomation({ jurisdiction: 'ae', registry }), hasCode('posting_policy_invalid'));
  }
});

test('source component and processor fee tax planning belongs to the explicitly selected country', () => {
  const fi = resolvePostingPolicy({ jurisdiction:'fi' });
  const domestic = executePostingPolicyOperation(fi,'sourceTaxPosting',{taxTreatment:'ALV 25,5 %',direction:'in',gross:125.5});
  assert.equal(domestic.code,'ALV_25_5_INPUT');
  assert.equal(domestic.rate,25.5);
  assert.equal(domestic.split.vat,25.5);
  assert.equal(domestic.split.net,100);
  const exempt = executePostingPolicyOperation(fi,'sourceTaxPosting',{taxTreatment:'Veroton toiminta (ALV-vapaa)',direction:'in',gross:27.28});
  assert.equal(exempt.split,null);
  assert.equal(exempt.rate,0);
  for (const jurisdiction of ['gb','sg','ae','us','au']) {
    const policy=resolvePostingPolicy({jurisdiction});
    assert.equal(policy.capabilities.sourceTaxPosting,false);
    assert.throws(()=>executePostingPolicyOperation(policy,'sourceTaxPosting',{taxTreatment:'ALV 25,5 %',direction:'in',gross:125.5}),hasCode('posting_operation_unsupported'));
  }
});

test('FI: output ALV on money received needs the settled sales source; evidenced and untaxed income still post', () => {
  const fi = resolvePostingPolicy({ jurisdiction: 'fi' }).adapter;
  const received = { ...fiDated, money_in: 49.9, money_out: 0 };
  const sales = { document_type: 'sales_invoice', match_status: 'auto_matched', total_amount: 49.9, tax_amount: 10.14, matched_line_id: null };
  const post = (coding, extra = {}) => fi.assertPostableTaxCoding({ coding, transaction: received, taxCodingEnabled: true, autonomousCoding: true, profile: fiRegistered, ...extra });
  const refusal = { code: 'TRANSACTION_ALV_EVIDENCE_REQUIRED' };
  // The replay: a bank-only refund on Other income at ALV 25,5 %, typed or not yet in the chart.
  assert.throws(() => post({ proposed_account: 'Other income', account_type: 'revenue', tax_type: 'ALV_25_5_OUTPUT' }), refusal);
  assert.throws(() => post({ proposed_account: 'Synthetic custom account', tax_type: 'ALV_25_5_OUTPUT' }), refusal);
  // A held but unsettled sales invoice, or a purchase receipt, is not a sale.
  assert.throws(() => post({ proposed_account: 'Sales', account_type: 'revenue', tax_type: 'ALV_25_5_OUTPUT' }, { matchedDocument: { ...sales, match_status: 'suggested' } }), refusal);
  assert.throws(() => post({ proposed_account: 'Sales', account_type: 'revenue', tax_type: 'ALV_25_5_OUTPUT' }, { matchedDocument: { ...sales, document_type: 'receipt' } }), refusal);
  // Unchanged: operating revenue with its sales source, untaxed other income,
  // and a person's accepted decision (codingEvidence.js owns that boundary).
  const sale = { proposed_account: 'Sales', account_type: 'revenue', tax_type: 'ALV_25_5_OUTPUT' };
  assert.deepEqual(post(sale, { matchedDocument: sales }), sale);
  const interest = { proposed_account: 'Other income', account_type: 'revenue', tax_type: 'ALV_OUT_OF_SCOPE' };
  assert.deepEqual(post(interest), interest);
  assert.deepEqual(post(sale, { autonomousCoding: false }), sale);
});

test('GB: the shared source-evidence rule, as UK law and practice allow it (synthetic data)', () => {
  const gb = resolvePostingPolicy({ jurisdiction: 'gb' });
  const fi = resolvePostingPolicy({ jurisdiction: 'fi' });
  // One rule shape, declared per market; only VAT markets with a bank-line rule declare one.
  assert.equal(gb.taxEvidence.refusalCode, 'TRANSACTION_GB_VAT_EVIDENCE_REQUIRED');
  assert.equal(fi.taxEvidence.refusalCode, 'TRANSACTION_ALV_EVIDENCE_REQUIRED');
  for (const jurisdiction of ['sg', 'us', 'au', 'ae']) assert.equal(resolvePostingPolicy({ jurisdiction }).taxEvidence, null, jurisdiction);
  const refusal = { code: 'TRANSACTION_GB_VAT_EVIDENCE_REQUIRED' };
  const spent = { date: '2026-06-02', money_in: 0, money_out: 36 };
  const received = { date: '2026-06-02', money_in: 47.88, money_out: 0 };
  const invoice = { document_type: 'supplier_bill', match_status: 'confirmed', total_amount: 36, tax_amount: 6 };
  const sales = { document_type: 'sales_invoice', match_status: 'auto_matched', total_amount: 47.88, tax_amount: 7.98 };
  const post = (coding, extra = {}) => gb.adapter.assertPostableTaxCoding({ coding, transaction: spent, taxCodingEnabled: true, autonomousCoding: true, profile: gbRegistered, ...extra });
  const software = (tax) => ({ proposed_account: 'Software subscriptions', account_type: 'expense', ...tax });
  // Input: the machine's deduction needs the settled source; a bank descriptor is not one.
  assert.throws(() => post(software({ tax_type: 'VAT_SR_20_INPUT' })), refusal);
  assert.throws(() => post(software({ tax_treatment: 'VAT 20%' })), refusal);
  assert.throws(() => post(software({ tax_type: 'VAT_RR_5_INPUT' }), { matchedDocument: { ...invoice, match_status: 'suggested' } }), refusal);
  // Reverse charge and EU acquisitions claim Box 4: the conservative choice asks for the source.
  assert.throws(() => post(software({ tax_type: 'VAT_REVERSE_CHARGE_20_INPUT' })), refusal);
  assert.throws(() => post(software({ tax_type: 'VAT_EU_ACQUISITION_20_INPUT' })), refusal);
  assert.deepEqual(post(software({ tax_type: 'VAT_SR_20_INPUT' }), { matchedDocument: invoice }), software({ tax_type: 'VAT_SR_20_INPUT' }));
  // Kept UK exceptions: no deduction is claimed (blocked, zero, exempt, outside
  // scope), or a person's accepted decision carries the claim (the small-purchase
  // concession and alternative evidence are a person's judgement).
  for (const tax_type of ['VAT_BLOCKED_INPUT', 'VAT_ZR_INPUT', 'VAT_EXEMPT_INPUT', 'VAT_OUTSIDE_SCOPE_INPUT', 'NONE']) {
    assert.deepEqual(post(software({ tax_type })), software({ tax_type }), tax_type);
  }
  assert.deepEqual(post(software({ tax_type: 'VAT_SR_20_INPUT' }), { autonomousCoding: false }), software({ tax_type: 'VAT_SR_20_INPUT' }));
  // Finland keeps its stricter input rule for a person's decision too.
  assert.throws(() => fi.adapter.assertPostableTaxCoding({ coding: { proposed_account: 'Operating supplies', account_type: 'expense', tax_type: 'ALV_25_5_INPUT' },
    transaction: spent, taxCodingEnabled: true, autonomousCoding: false, profile: fiRegistered }), { code: 'TRANSACTION_ALV_EVIDENCE_REQUIRED' });
  // Output: money received at a positive rate needs a settled sales source for the machine.
  const other = (tax) => ({ proposed_account: 'Other income', account_type: 'revenue', ...tax });
  assert.throws(() => post(other({ tax_treatment: 'VAT 20%' }), { transaction: received }), refusal);
  assert.throws(() => post(other({ tax_type: 'VAT_RR_5_OUTPUT' }), { transaction: received, matchedDocument: { ...sales, document_type: 'deposit_slip' } }), refusal);
  assert.deepEqual(post(other({ tax_type: 'VAT_SR_20_OUTPUT' }), { transaction: received, matchedDocument: sales }), other({ tax_type: 'VAT_SR_20_OUTPUT' }));
  assert.deepEqual(post(other({ tax_type: 'VAT_SR_20_OUTPUT' }), { transaction: received, matchedDocument: { ...sales, document_type: 'payout_statement' } }), other({ tax_type: 'VAT_SR_20_OUTPUT' }));
  assert.deepEqual(post(other({ tax_type: 'VAT_SR_20_OUTPUT' }), { transaction: received, autonomousCoding: false }), other({ tax_type: 'VAT_SR_20_OUTPUT' }));
  for (const tax_type of ['VAT_ZR_OUTPUT', 'VAT_EXEMPT_OUTPUT', 'VAT_OUTSIDE_SCOPE_OUTPUT', 'VAT_EU_SUPPLY_OUTPUT']) {
    assert.deepEqual(post(other({ tax_type }), { transaction: received }), other({ tax_type }), tax_type);
  }
  // Tax coding off: no VAT rule runs at all.
  assert.deepEqual(post(other({ tax_treatment: 'VAT 20%' }), { transaction: received, taxCodingEnabled: false }), other({ tax_treatment: 'VAT 20%' }));
});

test('GB: the VAT side follows the account class, so a supplier refund to its expense reverses input VAT', () => {
  const control = gbVatControlAccountFromChart(chart, 'liability.sales_tax_payable');
  const refund = { id: 'fixture-refund', date: '2026-06-02', currency: 'GBP', money_in: 47.88, money_out: 0 };
  const coded = applyGbVatCodingToCoding({ coding: { proposed_account: 'Operating supplies', account_type: 'expense', tax_treatment: 'VAT 20%' }, transaction: refund, controlAccount: control });
  assert.equal(coded.tax_type, 'VAT_SR_20_INPUT');
  const split = resolveGbVatSplitForPosting({ coding: coded, transaction: refund });
  assert.deepEqual([split.net, split.vat, split.role], [39.9, 7.98, 'vat_input_deductible']);
  const journal = buildLedgerJournalForTransaction({ transaction: refund, coding: coded, bankAccount, alvSplit: split });
  // Money in credits the expense net and the VAT control: the reclaim is reversed, no sale is made.
  assert.deepEqual(journal.lines.map(l => [l.account.name, l.debit, l.credit, l.account.tax_type, l.account.role]),
    [['Entity bank', 47.88, 0, 'NONE', 'bank'], ['Operating supplies', 0, 39.9, 'VAT_SR_20_INPUT', 'counterparty'], ['My tax account', 0, 7.98, 'NONE', 'vat_input_deductible']]);
  // An account of unknown class keeps the cash-direction fallback (money in is a supply).
  assert.equal(applyGbVatCodingToCoding({ coding: { proposed_account: 'Synthetic custom account', tax_treatment: 'VAT 20%' }, transaction: refund, controlAccount: control }).tax_type, 'VAT_SR_20_OUTPUT');
  // Revenue keeps the supply side; a purchase keeps the input side.
  assert.equal(applyGbVatCodingToCoding({ coding: { proposed_account: 'Sales', account_type: 'revenue', tax_treatment: 'VAT 20%' }, transaction: refund, controlAccount: control }).tax_type, 'VAT_SR_20_OUTPUT');
  assert.equal(applyGbVatCodingToCoding({ coding: { proposed_account: 'Operating supplies', account_type: 'expense', tax_treatment: 'VAT 20%' }, transaction: { money_out: 36 }, controlAccount: control }).tax_type, 'VAT_SR_20_INPUT');
});
