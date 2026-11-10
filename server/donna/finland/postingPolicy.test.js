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

// The other side (not-registered lines post without VAT): the declared no-VAT
// treatments carry no tax box and no deduction, so an unregistered business's
// purchase and sale post through the same rule with no split; the rule itself
// is unchanged and still refuses every code that needs registration.
test('FI: the declared no-VAT treatments post for an unregistered business, gross with no split', () => {
  const { withoutTax } = policy.taxRegistration;
  assert.deepEqual(withoutTax.treatments, { purchase: 'Vähennyskelvoton ALV (osto)', sale: 'Ei ALV-käsittelyä' });
  for (const [coding, transaction, code] of [[expense({ tax_treatment: withoutTax.treatments.purchase }), purchase, 'ALV_NONDEDUCTIBLE_INPUT'],
    [revenue({ tax_treatment: withoutTax.treatments.sale }), sale, 'ALV_OUT_OF_SCOPE']]) {
    const enriched = policy.adapter.enrichCoding({ coding, transaction, taxCodingEnabled: true });
    assert.equal(enriched.tax_type, code);
    assert.equal(alvCodeNeedsRegistration(code), false);
    for (const profile of [notRegistered, { alv_registration: { status: 'registered', registered_from: '2026-07-01' } }]) {
      assert.deepEqual(assertPostable({ coding: enriched, transaction, profile }), enriched);
    }
    assert.equal(policy.adapter.transactionSplit({ coding: enriched, transaction }), null, 'no ALV leg');
  }
  const direction = (transaction) => (transaction.money_out ? 'in' : 'out');
  assert.equal(withoutTax.needsRegistration({ taxTreatment: withoutTax.treatments.purchase, direction: direction(purchase) }), false);
  assert.equal(withoutTax.needsRegistration({ taxTreatment: withoutTax.treatments.sale, direction: direction(sale) }), false);
  assert.equal(withoutTax.needsRegistration({ taxTreatment: 'ALV 25,5 %', direction: 'in' }), true);
  assert.equal(withoutTax.needsRegistration({ taxTreatment: 'ALV 25,5 %', direction: 'out' }), true);
  assert.match(withoutTax.instruction({ onDate: '2026-06-02' }), /not in the Finnish VAT register .* on 2026-06-02/);
  // The rule is unchanged: a rated purchase is still refused.
  assert.throws(() => assertPostable({ coding: expense({ tax_treatment: 'ALV 25,5 %' }), transaction: purchase, profile: notRegistered }),
    refusedWith('TRANSACTION_ALV_REGISTRATION_REQUIRED'));
});

test('FI: a supplier bill coded with the no-VAT purchase treatment posts its gross for an unregistered business', () => {
  const document = { id: 'bill', document_date: '2026-02-10', total_amount: 125.5, tax_amount: 25.5 };
  const verdict = { account_code: '7680', account_name: 'Office expenses', tax_treatment: 'Vähennyskelvoton ALV (osto)' };
  const posted = policy.adapter.supplierBillTaxPosting({ verdict, document, taxCodingEnabled: true,
    profile: { alv_registration: { status: 'registered', registered_from: '2026-03-01' } } });
  assert.equal(posted.expenseTaxType, 'ALV_NONDEDUCTIBLE_INPUT');
  assert.equal(posted.alvSplit, null);
  assert.throws(() => policy.adapter.supplierBillTaxPosting({ verdict: { ...verdict, tax_treatment: 'ALV 25,5 %' }, document, taxCodingEnabled: true, profile: notRegistered }),
    refusedWith('SUPPLIER_BILL_ALV_REGISTRATION_REQUIRED'));
});

// A sale whose own sales document shows ALV, for a business the record says
// is not in the register on the line's date (taxSourceEvidence.js
// assertSalesSourceTaxRegistration through this policy's declaration).
test('FI: a sale settling its own sales invoice that shows ALV is refused by name for a business recorded as not registered, whatever the coding', () => {
  const invoice = (extra = {}) => ({ document_id: 'fi-invoice', document_type: 'sales_invoice', match_status: 'auto_matched', filename: 'Synthetic invoice.pdf',
    document_date: '2026-06-02', total_amount: 125.5, tax_amount: 25.5, currency: 'EUR', lines: [], ...extra });
  const { salesSourceShowsTax, refusalCodes } = policy.taxRegistration;
  assert.equal(salesSourceShowsTax.refusalCode, 'TRANSACTION_ALV_SALE_SOURCE_SHOWS_VAT_UNREGISTERED');
  assert.ok(refusalCodes.includes(salesSourceShowsTax.refusalCode));
  assert.equal(refusalCodes[0], 'TRANSACTION_ALV_REGISTRATION_REQUIRED', 'the bank-line registration code stays first (db/ledger.js)');
  const refused = refusedWith('TRANSACTION_ALV_SALE_SOURCE_SHOWS_VAT_UNREGISTERED');
  for (const [label, coding, document] of [
    ['the no-ALV treatment', revenue({ tax_treatment: 'Ei ALV-käsittelyä' }), invoice()],
    ['a rated treatment', revenue({ tax_treatment: 'ALV 25,5 %' }), invoice()],
    ['an issued receipt', revenue({ tax_treatment: 'Ei ALV-käsittelyä' }), invoice({ document_type: 'issued_receipt' })],
    ['header without tax, a rated printed line', revenue({ tax_treatment: 'Ei ALV-käsittelyä' }), invoice({ tax_amount: null, lines: [{ amount: 125.5, tax_rate: 25.5 }] })]
  ]) {
    assert.throws(() => assertPostable({ coding, transaction: sale, profile: notRegistered, matchedDocument: document }), (error) => refused(error)
      && error.details.registered === false && error.details.as_of === '2026-06-02' && error.details.sales_source.document_id === 'fi-invoice', label);
  }
  // Neighbours that do not change.
  const plain = revenue({ tax_treatment: 'Ei ALV-käsittelyä' });
  for (const [label, input] of [
    ['an invoice that shows no ALV', { coding: plain, profile: notRegistered, matchedDocument: invoice({ tax_amount: 0, lines: [{ amount: 125.5, tax_rate: 0 }] }) }],
    ['a suggested (unsettled) match', { coding: plain, profile: notRegistered, matchedDocument: invoice({ match_status: 'suggested' }) }],
    ['a balance-sheet coding (the receivable)', { coding: { account_code: '1700', account_name: 'Myyntisaamiset', account_type: 'asset' }, profile: notRegistered, matchedDocument: invoice() }],
    ['an invoice dated while registered, paid after the registration ended', { coding: plain, matchedDocument: invoice({ document_date: '2026-05-15' }),
      profile: { alv_registration: { status: 'deregistered', registered_from: '2020-01-01', registered_until: '2026-05-31' } } }],
    ['the tax-coding switch off', { coding: plain, profile: notRegistered, matchedDocument: invoice(), taxCodingEnabled: false }]
  ]) assert.doesNotThrow(() => assertPostable({ transaction: sale, ...input }), label);
  // A registered business: the sale meets the ordinary rules (the rated code posts).
  assert.doesNotThrow(() => assertPostable({ coding: revenue({ tax_treatment: 'ALV 25,5 %' }), transaction: sale, profile: registered, matchedDocument: invoice() }));
  // A purchase whose receipt prints ALV is not this rule.
  assert.doesNotThrow(() => assertPostable({ coding: expense({ tax_treatment: 'Vähennyskelvoton ALV (osto)' }), transaction: purchase, profile: notRegistered,
    matchedDocument: { ...settled, document_type: 'receipt', tax_amount: 25.5, total_amount: 125.5 } }));
});
