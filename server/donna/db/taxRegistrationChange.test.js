// The posted-line registration basis and the change rule (no database).
import assert from 'node:assert/strict';
import test from 'node:test';
import { postedTaxRegistrationStatus, taxRegistrationChangeFor, taxRegistrationRuleFor } from './taxRegistrationChange.js';

const fi = taxRegistrationRuleFor('FI');
const gb = taxRegistrationRuleFor('gb');
const line = (taxType, debit = 100) => ({ tax_type: taxType, debit, credit: 0 });
const row = (payload = {}, date = '2026-06-02') => ({ id: 'tx', transaction_date: date, payload });
const unregisteredReceipt = { ai_suggestion: { tax_registration_fact: { status: 'not_registered', on_date: '2026-06-02' } } };

test('only countries that declare a registration record are read; Singapore and the UAE are not', () => {
  assert.ok(fi?.withoutTax && gb?.withoutTax);
  assert.equal(taxRegistrationRuleFor('sg'), null);
  assert.equal(taxRegistrationRuleFor('ae'), null);
});

test('the posted basis: a VAT-carrying code means registered; the coding receipt means not registered; neither is unknown', () => {
  assert.deepEqual(postedTaxRegistrationStatus({ rule: fi, payload: {}, lines: [line('ALV_25_5_INPUT')] }),
    { status: 'registered', basis: 'posted_vat_code', vat_codes: ['ALV_25_5_INPUT'], on_date: null });
  assert.equal(postedTaxRegistrationStatus({ rule: gb, payload: {}, lines: [line('VAT_SR_20_INPUT')] })?.status, 'registered');
  assert.equal(postedTaxRegistrationStatus({ rule: fi, payload: unregisteredReceipt, lines: [line('ALV_NONDEDUCTIBLE_INPUT')] }).basis, 'coding_receipt');
  // A pre-#64 line with no VAT code and no receipt: no known basis.
  assert.equal(postedTaxRegistrationStatus({ rule: fi, payload: {}, lines: [line('ALV_NONDEDUCTIBLE_INPUT')] }), null);
  assert.equal(postedTaxRegistrationStatus({ rule: gb, payload: {}, lines: [line(null)] }), null);
  // A VAT line netted to zero by a correction journal no longer counts.
  assert.equal(postedTaxRegistrationStatus({ rule: fi, payload: {}, lines: [line('ALV_25_5_INPUT', 0)] }), null);
  // After a correction for this reason, the status it was corrected under.
  assert.equal(postedTaxRegistrationStatus({ rule: fi, payload: { coding_correction_required: { status: 'corrected',
    tax_registration: { on_date: '2026-06-02', current: { status: 'registered' } } } }, lines: [] }).status, 'registered');
});

test('a change is only the opposite definite status; an unknown record or another fact of the record is not one', () => {
  const posted = row(unregisteredReceipt);
  const at = (alv_registration) => taxRegistrationChangeFor({ rule: fi, profile: { alv_registration }, row: posted, lines: [] });
  assert.equal(at({ status: 'not_registered' }), null);
  assert.equal(at(null), null, 'a silent record is the registration question\'s, not a change');
  assert.equal(at({ status: 'registered', registered_from: '2026-07-01' }), null, 'still not registered on the date');
  const change = at({ status: 'registered', registered_from: '2026-01-01' });
  assert.equal(change.direction, 'became_registered');
  assert.equal(change.digest, at({ status: 'registered', registered_from: '2026-01-01', tax_period: 'quarter' }).digest,
    'a filing period does not change the digest');
  const vat = taxRegistrationChangeFor({ rule: gb, profile: { vat_registration: { status: 'not_registered' } },
    row: row(), lines: [line('VAT_SR_20_INPUT')] });
  assert.equal(vat.direction, 'became_not_registered');
  assert.equal(vat.on_date, '2026-06-02', 'no receipt: the line\'s own date governs');
});
