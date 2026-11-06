// AE VAT posting-code vocabulary — the pin tests. Same two jobs as GB's:
// trip CI on any silent rate/code edit, and pin the boundaries the module
// deliberately keeps (semantic field keys, provenance honesty, the
// unsupported destination-emirate rule staying upstream).

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AE_EMIRATES,
  AE_VAT201_FIELD_PROVENANCE,
  AE_VAT_CODES,
  AE_VAT_INPUT_ROLE,
  AE_VAT_OUTPUT_ROLE,
  AE_VAT_RATE_PROVENANCE,
  AE_VAT_STANDARD_RATE,
  aeVatOutputCodeForRate,
  isKnownAeEmirate,
  resolveAeVatCode
} from './vatCodes.js';

test('the standard rate is pinned at 5 percent', () => {
  assert.equal(AE_VAT_STANDARD_RATE, 5);
});

test('the exact code set is pinned — an addition or removal is a deliberate edit', () => {
  assert.deepEqual(AE_VAT_CODES.map((entry) => entry.code), [
    'AE_VAT_SR_5_OUTPUT',
    'AE_VAT_ZR_OUTPUT',
    'AE_VAT_EXEMPT_OUTPUT',
    'AE_VAT_OUTSIDE_SCOPE_OUTPUT',
    'AE_VAT_SR_5_INPUT',
    'AE_VAT_ZR_INPUT',
    'AE_VAT_EXEMPT_INPUT',
    'AE_VAT_OUTSIDE_SCOPE_INPUT',
    'AE_VAT_BLOCKED_INPUT',
    'AE_VAT_RCM_5_INPUT'
  ]);
});

test('rate provenance is honest: FTA authority, dated, and NOT confirmed against primary', () => {
  assert.equal(AE_VAT_RATE_PROVENANCE.authority, 'Federal Tax Authority');
  assert.ok(AE_VAT_RATE_PROVENANCE.source.includes('Federal Decree-Law No. 8 of 2017'));
  assert.match(AE_VAT_RATE_PROVENANCE.as_of, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(AE_VAT_RATE_PROVENANCE.confirmedAgainstPrimary, false);
});

test('field provenance carries the semantic-key decision and stays unconfirmed', () => {
  assert.equal(AE_VAT201_FIELD_PROVENANCE.confirmedAgainstPrimary, false);
  assert.ok(AE_VAT201_FIELD_PROVENANCE.note.includes('semantic field ids'));
});

test('return fields are semantic keys — no numeric box labels anywhere in the vocabulary', () => {
  for (const entry of AE_VAT_CODES) {
    for (const value of Object.values(entry.return_fields)) {
      assert.doesNotMatch(String(value), /^\d+$/, `${entry.code} carries a numeric box label`);
    }
  }
});

test('zero-rated, exempt, outside-scope and blocked PURCHASES carry no return fields', () => {
  for (const code of ['AE_VAT_ZR_INPUT', 'AE_VAT_EXEMPT_INPUT', 'AE_VAT_OUTSIDE_SCOPE_INPUT', 'AE_VAT_BLOCKED_INPUT']) {
    assert.deepEqual(resolveAeVatCode(code).return_fields, {}, code);
  }
});

test('the reverse-charge code reports both sides: supply value with self-assessed output, recovery on the expense side', () => {
  const entry = resolveAeVatCode('AE_VAT_RCM_5_INPUT');
  assert.equal(entry.return_fields.net, 'reverse_charge_supplies');
  assert.equal(entry.return_fields.output_tax, 'reverse_charge_supplies');
  assert.equal(entry.return_fields.input_net, 'reverse_charge_expenses');
  assert.equal(entry.return_fields.input_tax, 'reverse_charge_expenses');
});

test('resolveAeVatCode is case/whitespace tolerant and refuses unknowns with null', () => {
  assert.equal(resolveAeVatCode(' ae_vat_sr_5_output ').code, 'AE_VAT_SR_5_OUTPUT');
  assert.equal(resolveAeVatCode('VAT_SR_20_OUTPUT'), null);
  assert.equal(resolveAeVatCode(''), null);
});

test('aeVatOutputCodeForRate maps 5 and 0 only — an unmapped rate is the caller\'s refusal', () => {
  assert.equal(aeVatOutputCodeForRate(5), 'AE_VAT_SR_5_OUTPUT');
  assert.equal(aeVatOutputCodeForRate(0), 'AE_VAT_ZR_OUTPUT');
  assert.equal(aeVatOutputCodeForRate(20), null);
  assert.equal(aeVatOutputCodeForRate(null), null);
});

test('the seven emirates are pinned and the membership check is strict', () => {
  assert.deepEqual(Object.keys(AE_EMIRATES), ['AUH', 'DXB', 'SHJ', 'AJM', 'UAQ', 'RAK', 'FUJ']);
  assert.equal(isKnownAeEmirate('dxb'), true);
  assert.equal(isKnownAeEmirate('LON'), false);
  assert.equal(isKnownAeEmirate(''), false);
});

test('line roles are the market-neutral strings shared with GB, on purpose', () => {
  assert.equal(AE_VAT_OUTPUT_ROLE, 'vat_output');
  assert.equal(AE_VAT_INPUT_ROLE, 'vat_input_deductible');
});
