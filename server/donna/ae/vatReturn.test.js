// AE VAT return compute-half — one pinned invariant per case, the GB
// convention: a failed field names the broken path instead of hiding it in a
// bundle.

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertAeVatReturnFoots,
  buildAeVatReturnFromLedgerLines
} from './vatReturn.js';

const period = { periodKey: 'FTA-2026-Q2', startsOn: '2026-04-01', endsOn: '2026-06-30', dueOn: '2026-07-28' };
let nextLine = 0;
const line = (tax_type, debit, credit, account_type, extra = {}) => ({
  tax_type, debit, credit, account_type, journal_id: extra.journal_id || 'j1',
  line_no: extra.line_no || ++nextLine, ...extra
});
const outputLeg = (vat, extra = {}) => line('NONE', 0, vat, 'liability', { role: 'vat_output', ...extra });
const inputLeg = (vat, extra = {}) => line('NONE', vat, 0, 'liability', { role: 'vat_input_deductible', ...extra });
const prepare = (lines, opts = {}) =>
  buildAeVatReturnFromLedgerLines({ period, lines, establishmentEmirate: 'DXB', ...opts }).vatReturn;

test('a standard-rated supply lands whole on the establishment emirate row and the total', () => {
  const vatReturn = prepare([line('AE_VAT_SR_5_OUTPUT', 0, 1000, 'revenue'), outputLeg(50)]);
  assert.deepEqual(vatReturn.fields.standard_rated_supplies.by_emirate.DXB, { amount: 1000, vat: 50 });
  assert.deepEqual(vatReturn.fields.standard_rated_supplies.by_emirate.AUH, { amount: 0, vat: 0 });
  assert.deepEqual(vatReturn.fields.standard_rated_supplies.total, { amount: 1000, vat: 50 });
  assert.equal(vatReturn.totals.output_vat, 50);
  assert.equal(vatReturn.outcome, 'payment');
});

test('zero-rated and exempt supplies report their base without output VAT', () => {
  const vatReturn = prepare([
    line('AE_VAT_ZR_OUTPUT', 0, 400, 'revenue'),
    line('AE_VAT_EXEMPT_OUTPUT', 0, 250, 'revenue')
  ]);
  assert.equal(vatReturn.fields.zero_rated_supplies.amount, 400);
  assert.equal(vatReturn.fields.exempt_supplies.amount, 250);
  assert.equal(vatReturn.totals.output_vat, 0);
});

test('a standard-rated expense recovers its input VAT', () => {
  const vatReturn = prepare([line('AE_VAT_SR_5_INPUT', 300, 0, 'expense'), inputLeg(15)]);
  assert.deepEqual(vatReturn.fields.standard_rated_expenses, { amount: 300, recoverable_vat: 15 });
  assert.equal(vatReturn.netVat, -15);
  assert.equal(vatReturn.outcome, 'refund');
});

test('a fixed-asset purchase bearing input VAT recovers like an expense', () => {
  const vatReturn = prepare([line('AE_VAT_SR_5_INPUT', 4000, 0, 'fixed_asset'), inputLeg(200)]);
  assert.equal(vatReturn.fields.standard_rated_expenses.recoverable_vat, 200);
});

test('a reverse-charge purchase reports both sides and nets to zero when fully recoverable', () => {
  const vatReturn = prepare([line('AE_VAT_RCM_5_INPUT', 800, 0, 'expense')]);
  assert.deepEqual(vatReturn.fields.reverse_charge_supplies, { amount: 800, vat: 40 });
  assert.deepEqual(vatReturn.fields.reverse_charge_expenses, { amount: 800, recoverable_vat: 40 });
  assert.equal(vatReturn.netVat, 0);
});

test('blocked input VAT recovers nothing and reports nothing', () => {
  const vatReturn = prepare([line('AE_VAT_BLOCKED_INPUT', 500, 0, 'expense')]);
  assert.equal(vatReturn.fields.standard_rated_expenses.recoverable_vat, 0);
  assert.equal(vatReturn.totals.recoverable_vat, 0);
  assert.equal(vatReturn.nilReturn, false);
});

test('an uncoded revenue line refuses by name with the line reference', () => {
  assert.throws(
    () => prepare([line('NONE', 0, 100, 'revenue')]),
    (error) => error.code === 'AE_VAT_TREATMENT_NOT_ESTABLISHED' && error.details.length === 1
  );
});

test('a foreign-vocabulary code refuses as unestablished, never silently drops', () => {
  assert.throws(
    () => prepare([line('VAT_SR_20_OUTPUT', 0, 100, 'revenue')]),
    (error) => error.code === 'AE_VAT_TREATMENT_NOT_ESTABLISHED'
  );
});

test('an uncoded bank-to-bank asset movement is not forced to carry VAT', () => {
  const vatReturn = prepare([line('NONE', 100, 0, 'asset'), line('NONE', 0, 100, 'asset')]);
  assert.equal(vatReturn.nilReturn, true);
});

test('an output treatment on an expense account refuses as a direction mismatch', () => {
  assert.throws(
    () => prepare([line('AE_VAT_SR_5_OUTPUT', 100, 0, 'expense')]),
    (error) => error.code === 'AE_VAT_TREATMENT_DIRECTION_MISMATCH'
  );
});

test('standard-rated supplies with no establishment emirate refuse by name', () => {
  assert.throws(
    () => buildAeVatReturnFromLedgerLines({
      period,
      lines: [line('AE_VAT_SR_5_OUTPUT', 0, 1000, 'revenue'), outputLeg(50)]
    }),
    (error) => error.code === 'AE_VAT_EMIRATE_NOT_ESTABLISHED'
  );
});

test('a purely zero-rated period prepares without the emirate fact', () => {
  const result = buildAeVatReturnFromLedgerLines({
    period,
    lines: [line('AE_VAT_ZR_OUTPUT', 0, 400, 'revenue')]
  });
  assert.equal(result.vatReturn.fields.zero_rated_supplies.amount, 400);
});

test('an unknown emirate value refuses even when it would not be needed', () => {
  assert.throws(
    () => prepare([], { establishmentEmirate: 'LON' }),
    (error) => error.code === 'AE_VAT_EMIRATE_UNKNOWN'
  );
});

test('a recorded qualifying e-commerce registrant refuses outright — never establishment-attributed', () => {
  assert.throws(
    () => prepare([line('AE_VAT_SR_5_OUTPUT', 0, 1000, 'revenue'), outputLeg(50)], { qualifyingEcommerceRegistrant: true }),
    (error) => error.code === 'AE_VAT_QUALIFYING_REGISTRANT_UNSUPPORTED'
  );
});

test('control legs that do not reconcile to the coded lines refuse with both totals named', () => {
  assert.throws(
    () => prepare([line('AE_VAT_SR_5_OUTPUT', 0, 1000, 'revenue'), outputLeg(37)]),
    (error) => error.code === 'AE_VAT_CONTROL_ACCOUNT_MISMATCH'
      && error.details.outputTax.expected === 50 && error.details.outputTax.actual === 37
  );
});

test('self-assessed reverse charge is excluded from the control reconciliation', () => {
  const vatReturn = prepare([
    line('AE_VAT_SR_5_OUTPUT', 0, 1000, 'revenue'), outputLeg(50),
    line('AE_VAT_RCM_5_INPUT', 800, 0, 'expense')
  ]);
  assert.equal(vatReturn.totals.output_vat, 90);
  assert.equal(vatReturn.totals.recoverable_vat, 40);
});

test('an empty period is an honest nil return in AED', () => {
  const vatReturn = prepare([]);
  assert.equal(vatReturn.nilReturn, true);
  assert.equal(vatReturn.currency, 'AED');
  assert.equal(vatReturn.netVat, 0);
  assert.equal(vatReturn.outcome, 'payment');
});

test('the declared-zero fields carry their honesty notes', () => {
  const vatReturn = prepare([]);
  for (const key of ['tourist_refunds', 'goods_imports', 'goods_imports_adjustments']) {
    assert.equal(vatReturn.fields[key].declared_zero, true, key);
    assert.ok(vatReturn.fields[key].note.length > 0, key);
  }
});

test('a period without bounds refuses before any line is read', () => {
  assert.throws(
    () => buildAeVatReturnFromLedgerLines({ period: { periodKey: 'x' }, lines: [] }),
    (error) => error.code === 'AE_VAT_PERIOD_NOT_ESTABLISHED'
  );
});

test('the footing assert trips on a doctored envelope', () => {
  const { vatReturn } = buildAeVatReturnFromLedgerLines({
    period,
    lines: [line('AE_VAT_SR_5_OUTPUT', 0, 1000, 'revenue'), outputLeg(50)],
    establishmentEmirate: 'DXB'
  });
  const doctored = structuredClone(vatReturn);
  doctored.totals.output_vat = 49;
  assert.throws(() => assertAeVatReturnFoots(doctored), (error) => error.code === 'AE_VAT_RETURN_MISFOOT_OUTPUT');
});

test('provenance rides the verdict and is honest about the primary read', () => {
  const vatReturn = prepare([]);
  assert.equal(vatReturn.provenance.confirmedAgainstPrimary, false);
  assert.equal(vatReturn.provenance.authority, 'Federal Tax Authority');
});
