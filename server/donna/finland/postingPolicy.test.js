// The Finnish posting policy's ALV-registration check, run through the real
// resolved policy (postingPolicy.js → finland/postingPolicy.js). The twin of
// gb/postingPolicy.test.js. Synthetic data only.
//   node --test server/donna/finland/postingPolicy.test.js
import assert from 'node:assert/strict';
import test from 'node:test';
import { resolvePostingPolicy } from '../postingPolicy.js';
import { alvCodeNeedsRegistration } from './postingPolicy.js';
import { ALV_CODES } from './alvCodes.js';

const policy = resolvePostingPolicy({ jurisdiction: 'fi' });
const registered = { alv_registration: { status: 'registered', registered_from: '2020-01-01' } };
const notRegistered = { alv_registration: { status: 'not_registered' } };
const purchase = { id: 'fi-purchase', date: '2026-06-02', currency: 'EUR', money_out: 125.5 };
const sale = { id: 'fi-sale', date: '2026-06-02', currency: 'EUR', money_in: 125.5 };
const expense = (extra = {}) => ({ account_code: '7680', account_name: 'Office expenses', account_type: 'expense', ...extra });
const revenue = (extra = {}) => ({ account_code: '3000', account_name: 'Sales', account_type: 'revenue', ...extra });
// A settled source, so the evidence rule is met and only registration decides.
const settled = { id: 'fi-receipt', match_status: 'confirmed', matched_line_id: null };
const assertPostable = (input) => policy.adapter.assertPostableTaxCoding({ taxCodingEnabled: true, matchedDocument: settled, ...input });
const refusedWith = (code) => (error) => error.code === code && error.statusCode === 409;

test('FI: a business recorded as not ALV-registered gets no ALV-coded bank-line posting', () => {
  for (const [label, coding, transaction] of [
    ['explicit input code on a purchase', expense({ tax_type: 'ALV_25_5_INPUT', xero_tax_type: 'ALV_25_5_INPUT' }), purchase],
    ['a treatment that resolves to an input code', expense({ tax_treatment: 'ALV 25,5 %' }), purchase],
    ['explicit output code on a sale', revenue({ tax_type: 'ALV_25_5_OUTPUT', xero_tax_type: 'ALV_25_5_OUTPUT' }), sale],
    ['an EU service acquisition (self-assessed tax and a deduction)', expense({ tax_type: 'ALV_EU_SERVICE_ACQUISITION', xero_tax_type: 'ALV_EU_SERVICE_ACQUISITION' }), purchase],
    ['an import (self-assessed tax and a deduction)', expense({ tax_type: 'ALV_IMPORT', xero_tax_type: 'ALV_IMPORT' }), purchase]
  ]) {
    assert.throws(() => assertPostable({ coding, transaction, profile: notRegistered }),
      refusedWith('TRANSACTION_ALV_REGISTRATION_REQUIRED'), label);
  }
});

test('FI: an unknown, not-yet-effective or ended registration refuses the same way; the refusal names why', () => {
  const coding = expense({ tax_type: 'ALV_25_5_INPUT', xero_tax_type: 'ALV_25_5_INPUT' });
  for (const [profile, registeredValue, reason] of [
    [{}, null, 'no_record'],
    [undefined, null, 'no_record'],
    [{ alv_registration: 'yes' }, null, 'no_record'],
    [notRegistered, false, 'not_registered'],
    [{ alv_registration: { status: 'pending' } }, null, 'invalid_record'],
    [{ alv_registration: { status: 'registered', registered_from: '2026-07-01' } }, false, 'not_yet_effective'],
    [{ alv_registration: { status: 'deregistered', registered_from: '2020-01-01', registered_until: '2026-05-31' } }, false, 'deregistered']
  ]) {
    assert.throws(() => assertPostable({ coding, transaction: purchase, profile }), (error) =>
      error.code === 'TRANSACTION_ALV_REGISTRATION_REQUIRED' && error.details?.registered === registeredValue
        && error.details?.registration_reason === reason && error.details?.as_of === '2026-06-02', JSON.stringify(profile));
  }
});

test('FI: the registration rule binds an explicit ALV code even while the rollout switch is off', () => {
  const coding = expense({ tax_type: 'ALV_25_5_INPUT', xero_tax_type: 'ALV_25_5_INPUT' });
  assert.throws(() => assertPostable({ taxCodingEnabled: false, coding, transaction: purchase, profile: notRegistered }),
    refusedWith('TRANSACTION_ALV_REGISTRATION_REQUIRED'));
  // Switch off, no ALV code: the line posts exactly as before.
  const plain = expense();
  assert.deepEqual(assertPostable({ taxCodingEnabled: false, coding: plain, transaction: purchase, profile: notRegistered }), plain);
});

test('FI: registration binds exactly the codes that charge or deduct ALV (their ALV_CODES return boxes)', () => {
  assert.deepEqual(ALV_CODES.filter(({ code }) => alvCodeNeedsRegistration(code)).map(({ code }) => code).sort(), [
    'ALV_10_INPUT', 'ALV_10_OUTPUT', 'ALV_13_5_INPUT', 'ALV_13_5_OUTPUT', 'ALV_14_INPUT', 'ALV_14_OUTPUT',
    'ALV_25_5_INPUT', 'ALV_25_5_OUTPUT', 'ALV_EU_ACQUISITION', 'ALV_EU_SERVICE_ACQUISITION', 'ALV_IMPORT', 'ALV_REVERSE_CHARGE_PURCHASE'
  ]);
  // The codes that only classify put no ALV on the books and claim nothing:
  // an unregistered business posts them as before.
  for (const [label, coding, transaction] of [
    ['a zero-rated sale', revenue({ tax_type: 'ALV_0_OUTPUT', xero_tax_type: 'ALV_0_OUTPUT' }), sale],
    ['an intra-EU supply', revenue({ tax_type: 'ALV_EU_SUPPLY', xero_tax_type: 'ALV_EU_SUPPLY' }), sale],
    ['a construction reverse-charge sale', revenue({ tax_type: 'ALV_REVERSE_CHARGE_SALES', xero_tax_type: 'ALV_REVERSE_CHARGE_SALES' }), sale],
    ['an exempt purchase', expense({ tax_type: 'ALV_EXEMPT', xero_tax_type: 'ALV_EXEMPT' }), purchase],
    ['an out-of-scope purchase', expense({ tax_type: 'ALV_OUT_OF_SCOPE', xero_tax_type: 'ALV_OUT_OF_SCOPE' }), purchase],
    ['an out-of-scope treatment', expense({ tax_treatment: 'Ei ALV' }), purchase],
    ['a non-deductible purchase', expense({ tax_type: 'ALV_NONDEDUCTIBLE_INPUT', xero_tax_type: 'ALV_NONDEDUCTIBLE_INPUT' }), purchase]
  ]) {
    for (const profile of [notRegistered, {}]) assert.deepEqual(assertPostable({ coding, transaction, profile }), coding, label);
  }
});

test('FI: what an unregistered business may still post is unchanged', () => {
  const loan = { account_code: '2350', account_name: 'Shareholder loan', account_type: 'liability' };
  assert.deepEqual(assertPostable({ coding: loan, transaction: purchase, profile: notRegistered }), loan);
  const control = { account_code: '2939', account_name: 'Suoritettava arvonlisävero', account_type: 'liability', tax_type: 'NONE', xero_tax_type: 'NONE' };
  assert.deepEqual(assertPostable({ coding: control, transaction: purchase, profile: notRegistered }), control);
  // The unsure marker keeps its existing refusal (no relaxation, no rename).
  assert.throws(() => assertPostable({ coding: expense({ tax_treatment: 'ALV-tarkistus' }), transaction: purchase, profile: notRegistered }),
    refusedWith('TRANSACTION_ALV_TREATMENT_UNRESOLVED'));
});

test('FI: a component allocation would carry ALV codes, so it needs the registration too', () => {
  const transaction = { ...purchase, ai_suggestion: { posting_requirement: 'document_allocation',
    document_allocations: [{ line_handle: 'l1', account: 'Office expenses', tax_treatment: 'ALV 25,5 %' }] } };
  assert.throws(() => assertPostable({ coding: expense(), transaction, profile: notRegistered }),
    refusedWith('TRANSACTION_ALV_REGISTRATION_REQUIRED'));
  assert.deepEqual(assertPostable({ coding: expense(), transaction, profile: registered }), expense());
});

test('FI: a registered business posts its ALV codes as before', () => {
  const coding = expense({ tax_type: 'ALV_25_5_INPUT', xero_tax_type: 'ALV_25_5_INPUT' });
  assert.deepEqual(assertPostable({ coding, transaction: purchase, profile: registered }), coding);
  const output = revenue({ tax_type: 'ALV_25_5_OUTPUT', xero_tax_type: 'ALV_25_5_OUTPUT' });
  assert.deepEqual(assertPostable({ coding: output, transaction: sale, profile: registered }), output);
});

test('FI: an unregistered business gets no ALV-coded supplier bill post', () => {
  const document = { id: 'bill', document_date: '2026-06-02', total_amount: 125.5, tax_amount: 25.5 };
  const verdict = { account_code: '7680', account_name: 'Office expenses', tax_treatment: 'ALV 25,5 %' };
  for (const profile of [notRegistered, {}]) {
    assert.throws(() => policy.adapter.supplierBillTaxPosting({ verdict, document, taxCodingEnabled: true, profile }),
      refusedWith('SUPPLIER_BILL_ALV_REGISTRATION_REQUIRED'));
  }
  assert.throws(() => policy.adapter.supplierBillTaxPosting({ verdict: { ...verdict, tax_type: 'ALV_25_5_INPUT' }, document, taxCodingEnabled: false, profile: notRegistered }),
    refusedWith('SUPPLIER_BILL_ALV_REGISTRATION_REQUIRED'));
  const posted = policy.adapter.supplierBillTaxPosting({ verdict, document, taxCodingEnabled: true, profile: registered });
  assert.equal(posted.expenseTaxType, 'ALV_25_5_INPUT');
  assert.deepEqual([posted.alvSplit.net, posted.alvSplit.vat], [100, 25.5]);
});
