// The UK posting policy's VAT-registration and account-direction checks, run
// through the real resolved policy (postingPolicy.js → gb/postingPolicy.js).
// Synthetic data only.
//   node --test server/donna/gb/postingPolicy.test.js
import assert from 'node:assert/strict';
import test from 'node:test';
import { resolvePostingPolicy } from '../postingPolicy.js';
import { POSTING_SOURCE_RECHECK_REFUSALS } from '../codingPolicyRecovery.js';

const policy = resolvePostingPolicy({ jurisdiction: 'gb' });
const registered = { vat_registration: { status: 'registered', registered_from: '2020-01-01' } };
const notRegistered = { vat_registration: { status: 'not_registered' } };
const purchase = { id: 'gb-purchase', date: '2026-06-02', currency: 'GBP', money_out: 120 };
const sale = { id: 'gb-sale', date: '2026-06-02', currency: 'GBP', money_in: 120 };
const expense = (extra = {}) => ({ account_code: '5000', account_name: 'Software subscriptions', xero_account_type: 'EXPENSE', ...extra });
const revenue = (extra = {}) => ({ account_code: '4000', account_name: 'Sales', xero_account_type: 'REVENUE', ...extra });
const assertPostable = (input) => policy.adapter.assertPostableTaxCoding({ taxCodingEnabled: true, ...input });
const refusedWith = (code) => (error) => error.code === code && error.statusCode === 409;

test('GB: a business recorded as not VAT-registered gets no VAT-coded bank-line posting', () => {
  for (const [label, coding, transaction] of [
    ['explicit input code on a purchase', expense({ tax_type: 'VAT_SR_20_INPUT', xero_tax_type: 'VAT_SR_20_INPUT' }), purchase],
    ['a treatment that resolves to an input code', expense({ tax_treatment: 'VAT 20%' }), purchase],
    ['explicit output code on a sale', revenue({ tax_type: 'VAT_SR_20_OUTPUT', xero_tax_type: 'VAT_SR_20_OUTPUT' }), sale],
    ['an outside-the-scope code', expense({ tax_treatment: 'Outside the scope of VAT' }), purchase]
  ]) {
    assert.throws(() => assertPostable({ coding, transaction, profile: notRegistered }),
      refusedWith('TRANSACTION_GB_VAT_REGISTRATION_REQUIRED'), label);
  }
});

test('GB: an unknown, not-yet-effective or ended registration refuses the same way; the refusal names why', () => {
  const coding = expense({ tax_type: 'VAT_SR_20_INPUT', xero_tax_type: 'VAT_SR_20_INPUT' });
  for (const [profile, reason] of [
    [{}, 'no_record'],
    [undefined, 'no_record'],
    [{ vat_registration: { status: 'registered', registered_from: '2026-07-01' } }, 'not_yet_effective'],
    [{ vat_registration: { status: 'deregistered', registered_from: '2020-01-01', registered_until: '2026-05-31' } }, 'deregistered']
  ]) {
    assert.throws(() => assertPostable({ coding, transaction: purchase, profile }), (error) =>
      error.code === 'TRANSACTION_GB_VAT_REGISTRATION_REQUIRED' && error.details?.registration_reason === reason, reason);
  }
});

test('GB: the registration rule binds an explicit VAT code even while the rollout flag is off', () => {
  const coding = expense({ tax_type: 'VAT_SR_20_INPUT', xero_tax_type: 'VAT_SR_20_INPUT' });
  assert.throws(() => assertPostable({ taxCodingEnabled: false, coding, transaction: purchase, profile: notRegistered }),
    refusedWith('TRANSACTION_GB_VAT_REGISTRATION_REQUIRED'));
  // Flag off, no VAT code: the line posts exactly as before.
  const plain = expense({ tax_type: 'NONE' });
  assert.deepEqual(assertPostable({ taxCodingEnabled: false, coding: plain, transaction: purchase, profile: notRegistered }), plain);
});

test('GB: what an unregistered business may still post is unchanged', () => {
  // A balance-sheet movement with no VAT code (a director loan, a transfer).
  const loan = { account_code: '2300', account_name: "Director's loan", xero_account_type: 'LIABILITY' };
  assert.deepEqual(assertPostable({ coding: loan, transaction: purchase, profile: notRegistered }), loan);
  const stampedNone = { ...loan, tax_type: 'NONE', xero_tax_type: 'NONE' };
  assert.deepEqual(assertPostable({ coding: stampedNone, transaction: purchase, profile: notRegistered }), stampedNone);
  // The unsure marker keeps its existing refusal (no relaxation, no rename).
  assert.throws(() => assertPostable({ coding: expense({ tax_treatment: 'VAT check' }), transaction: purchase, profile: notRegistered }),
    refusedWith('TRANSACTION_GB_VAT_TREATMENT_UNRESOLVED'));
});

test('GB: a registered business posts its VAT codes as before', () => {
  const coding = expense({ tax_type: 'VAT_SR_20_INPUT', xero_tax_type: 'VAT_SR_20_INPUT' });
  assert.deepEqual(assertPostable({ coding, transaction: purchase, profile: registered }), coding);
  const output = revenue({ tax_type: 'VAT_SR_20_OUTPUT', xero_tax_type: 'VAT_SR_20_OUTPUT' });
  assert.deepEqual(assertPostable({ coding: output, transaction: sale, profile: registered }), output);
});

test('GB: an unregistered business gets no VAT-coded supplier bill post', () => {
  const document = { id: 'bill', document_date: '2026-06-02', total_amount: 120, tax_amount: 20 };
  const chart = [
    { code: '2202', name: 'VAT control', account_type: 'liability', normal_balance: 'credit', canonical_role: 'liability.sales_tax_payable', status: 'active' },
    { code: '2200', name: 'Trade creditors', account_type: 'liability', normal_balance: 'credit', canonical_role: 'liability.accounts_payable', status: 'active' }
  ];
  const verdict = { account_code: '5000', account_name: 'Software subscriptions', tax_treatment: 'VAT 20%' };
  for (const profile of [notRegistered, {}]) {
    assert.throws(() => policy.adapter.supplierBillTaxPosting({ verdict, document, ledgerAccounts: chart, taxCodingEnabled: true, profile }),
      refusedWith('SUPPLIER_BILL_GB_VAT_REGISTRATION_REQUIRED'));
  }
  const posted = policy.adapter.supplierBillTaxPosting({ verdict, document, ledgerAccounts: chart, taxCodingEnabled: true, profile: registered });
  assert.equal(posted.expenseTaxType, 'VAT_SR_20_INPUT');
  assert.deepEqual([posted.alvSplit.net, posted.alvSplit.vat], [100, 20]);
});

test('GB: an explicit VAT code on the wrong side of the account refuses (the FI ACCOUNT_INCOMPATIBLE twin)', () => {
  for (const [label, coding, transaction] of [
    ['output code on an expense', expense({ tax_type: 'VAT_SR_20_OUTPUT', xero_tax_type: 'VAT_SR_20_OUTPUT' }), purchase],
    ['output code on an expense, money in', expense({ tax_type: 'VAT_SR_20_OUTPUT', xero_tax_type: 'VAT_SR_20_OUTPUT' }), sale],
    ['zero-rated output code on an expense', expense({ tax_type: 'VAT_ZR_OUTPUT', xero_tax_type: 'VAT_ZR_OUTPUT' }), purchase],
    ['input code on revenue', revenue({ tax_type: 'VAT_SR_20_INPUT', xero_tax_type: 'VAT_SR_20_INPUT' }), sale]
  ]) {
    assert.throws(() => assertPostable({ coding, transaction, profile: registered }),
      refusedWith('TRANSACTION_GB_VAT_ACCOUNT_INCOMPATIBLE'), label);
  }
  // Direction follows the account class: a supplier refund (money in) on its
  // expense with the input code reverses input VAT and still posts.
  const refund = expense({ tax_type: 'VAT_SR_20_INPUT', xero_tax_type: 'VAT_SR_20_INPUT' });
  assert.deepEqual(assertPostable({ coding: refund, transaction: sale, profile: registered }), refund);
  // A balance-sheet account is not a VAT leg; the check reads P&L legs only.
  const control = { account_code: '2202', account_name: 'VAT control', xero_account_type: 'LIABILITY', tax_type: 'NONE', xero_tax_type: 'NONE' };
  assert.deepEqual(assertPostable({ coding: control, transaction: sale, profile: registered }), control);
});

test('GB: the unresolved-treatment refusal joins the source re-check list beside its Finnish twin', () => {
  assert.ok(POSTING_SOURCE_RECHECK_REFUSALS.includes('TRANSACTION_ALV_TREATMENT_UNRESOLVED'));
  assert.ok(POSTING_SOURCE_RECHECK_REFUSALS.includes('TRANSACTION_GB_VAT_TREATMENT_UNRESOLVED'));
});
