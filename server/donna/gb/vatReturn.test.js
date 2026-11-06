import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertGbVatReturnFoots,
  buildGbVatReturnFromLedgerLines,
  resolveGbVatPeriod
} from './vatReturn.js';

const period = { id: 'p1', periodKey: '#001', startsOn: '2026-01-01', endsOn: '2026-03-31', dueOn: '2026-05-07', status: 'open' };
let nextLine = 0;
const line = (tax_type, debit, credit, account_type, extra = {}) => ({
  tax_type, debit, credit, account_type, journal_id: extra.journal_id || 'j1',
  line_no: extra.line_no || ++nextLine, ...extra
});
const outputLeg = (vat, extra = {}) => line('NONE', 0, vat, 'liability', { role: 'vat_output', ...extra });
const inputLeg = (vat, extra = {}) => line('NONE', vat, 0, 'liability', { role: 'vat_input_deductible', ...extra });
const prepare = (lines) => buildGbVatReturnFromLedgerLines({ period, lines }).vatReturn;

// Each case below pins one statutory or refusal invariant.  Keeping them split
// makes a failed box name the broken path instead of hiding it in a bundle.
test('standard-rated output reports VAT in Box 1 and net sales in Box 6', () => {
  const vatReturn = prepare([line('VAT_SR_20_OUTPUT', 0, 1000, 'revenue'), outputLeg(200)]);
  assert.deepEqual([vatReturn.boxes['1'], vatReturn.boxes['6']], [200, 1000]);
});

test('reduced-rated output uses its own 5 percent calculation', () => {
  const vatReturn = prepare([line('VAT_RR_5_OUTPUT', 0, 200, 'revenue'), outputLeg(10)]);
  assert.equal(vatReturn.boxes['1'], 10);
});

test('zero-rated output reports its base without output VAT', () => {
  const vatReturn = prepare([line('VAT_ZR_OUTPUT', 0, 50, 'revenue')]);
  assert.deepEqual([vatReturn.boxes['1'], vatReturn.boxes['6']], [0, 50]);
});

test('domestic input VAT reports the deduction in Box 4 and purchases in Box 7', () => {
  const vatReturn = prepare([line('VAT_SR_20_INPUT', 300, 0, 'expense'), inputLeg(60)]);
  assert.deepEqual([vatReturn.boxes['4'], vatReturn.boxes['7']], [60, 300]);
});

test('a fixed-asset purchase bearing input VAT deducts in Boxes 4 and 7', () => {
  const vatReturn = prepare([line('VAT_SR_20_INPUT', 4000, 0, 'fixed_asset'), inputLeg(800)]);
  assert.deepEqual([vatReturn.boxes['4'], vatReturn.boxes['7']], [800, 4000]);
});

test('an uncoded bank-to-bank asset movement is not forced to carry VAT', () => {
  const vatReturn = prepare([line('NONE', 100, 0, 'asset'), line('NONE', 0, 100, 'asset')]);
  assert.equal(vatReturn.nilReturn, true);
});

test('a blocked purchase reports Box 7 only — no Box 4 reclaim, no control leg expected (IV-2a)', () => {
  // Business entertainment / car purchase: the VAT is real but never
  // reclaimable, so the line posts gross with the irrecoverable VAT inside
  // the expense. kind 'blocked' is outside the standard/reduced control
  // reconciliation, so the absence of a vat_input_deductible leg is correct,
  // not a mismatch.
  const vatReturn = prepare([line('VAT_BLOCKED_INPUT', 120, 0, 'expense')]);
  assert.deepEqual([vatReturn.boxes['4'], vatReturn.boxes['7']], [0, 120]);
});

test('EU acquisitions report Box 2, deduct in Box 4, and report Box 9', () => {
  const vatReturn = prepare([line('VAT_EU_ACQUISITION_20_INPUT', 40, 0, 'expense')]);
  assert.deepEqual([vatReturn.boxes['2'], vatReturn.boxes['4'], vatReturn.boxes['9']], [8, 8, 40]);
});

test('EU acquisition VAT is neutral in Box 5', () => {
  const vatReturn = prepare([line('VAT_EU_ACQUISITION_20_INPUT', 40, 0, 'expense')]);
  assert.equal(vatReturn.boxes['5'], 0);
});

test('reverse-charge purchases report the Box 1, Box 4, and Box 7 trio', () => {
  const vatReturn = prepare([line('VAT_REVERSE_CHARGE_20_INPUT', 100, 0, 'expense')]);
  assert.deepEqual([vatReturn.boxes['1'], vatReturn.boxes['4'], vatReturn.boxes['7']], [20, 20, 100]);
});

test('EU supplies report their net value in Box 8', () => {
  const vatReturn = prepare([line('VAT_EU_SUPPLY_OUTPUT', 0, 25, 'revenue')]);
  assert.equal(vatReturn.boxes['8'], 25);
});

test('exempt supplies are not reported in the nine boxes', () => {
  const vatReturn = prepare([line('VAT_EXEMPT_OUTPUT', 0, 75, 'revenue')]);
  assert.deepEqual(Object.values(vatReturn.boxes), Array(9).fill(0));
});

test('explicit outside-scope lines are not reported in the nine boxes', () => {
  const vatReturn = prepare([
    line('VAT_OUTSIDE_SCOPE_OUTPUT', 0, 75, 'revenue'),
    line('VAT_OUTSIDE_SCOPE_INPUT', 25, 0, 'expense')
  ]);
  assert.deepEqual(Object.values(vatReturn.boxes), Array(9).fill(0));
});

test('credit notes net by code before rate arithmetic', () => {
  const vatReturn = prepare([
    line('VAT_SR_20_OUTPUT', 0, 100.03, 'revenue'), outputLeg(20.01),
    line('VAT_SR_20_OUTPUT', 0.03, 0, 'revenue'), outputLeg(0, { debit: 0.01, credit: 0 })
  ]);
  assert.deepEqual([vatReturn.boxes['1'], vatReturn.boxes['6']], [20, 100]);
});

test('a repayment period preserves the signed net-VAT outcome', () => {
  const vatReturn = prepare([line('VAT_SR_20_INPUT', 100, 0, 'expense'), inputLeg(20)]);
  assert.deepEqual([vatReturn.netVat, vatReturn.outcome, vatReturn.boxes['5']], [-20, 'repayment', 20]);
});

test('a period with no activity is a valid nil return', () => {
  assert.equal(prepare([]).nilReturn, true);
});

test('a coded domestic line missing its control leg blocks', () => {
  assert.throws(() => prepare([line('VAT_SR_20_OUTPUT', 0, 100, 'revenue')]),
    (error) => error.code === 'GB_VAT_CONTROL_ACCOUNT_MISMATCH');
});

test('an edited control leg blocks', () => {
  assert.throws(() => prepare([line('VAT_SR_20_OUTPUT', 0, 100, 'revenue'), outputLeg(19)]),
    (error) => error.code === 'GB_VAT_CONTROL_ACCOUNT_MISMATCH');
});

test('a role-preserving reversal nets the control cross-check', () => {
  const vatReturn = prepare([
    line('VAT_SR_20_OUTPUT', 0, 100, 'revenue'), outputLeg(20),
    line('VAT_SR_20_OUTPUT', 100, 0, 'revenue', { journal_id: 'j-rev' }),
    outputLeg(0, { debit: 20, credit: 0, journal_id: 'j-rev' })
  ]);
  assert.deepEqual([vatReturn.boxes['1'], vatReturn.boxes['6']], [0, 0]);
});

test('per-line rounding drift within tolerance does not block', () => {
  const vatReturn = prepare([
    line('VAT_SR_20_OUTPUT', 0, 10.03, 'revenue'), outputLeg(2.01),
    line('VAT_SR_20_OUTPUT', 0, 10.03, 'revenue'), outputLeg(2.01)
  ]);
  assert.equal(vatReturn.boxes['1'], 4.01);
});

test('GB_VAT_TREATMENT_NOT_ESTABLISHED fires for an uncoded fixed-asset purchase', () => {
  assert.throws(() => prepare([line(null, 100, 0, 'fixed_asset')]),
    (error) => error.code === 'GB_VAT_TREATMENT_NOT_ESTABLISHED');
});

test('GB_VAT_TREATMENT_DIRECTION_MISMATCH fires for input VAT on revenue', () => {
  assert.throws(() => prepare([line('VAT_SR_20_INPUT', 0, 100, 'revenue')]),
    (error) => error.code === 'GB_VAT_TREATMENT_DIRECTION_MISMATCH');
});

test('GB_VAT_PERIOD_NOT_ESTABLISHED fires without a bounded persisted period', () => {
  assert.throws(() => buildGbVatReturnFromLedgerLines({ lines: [] }),
    (error) => error.code === 'GB_VAT_PERIOD_NOT_ESTABLISHED');
});

test('period resolution preserves an opaque persisted period key', () => {
  const rows = [{ id: 'p1', period_key: ' #001 ', start_date: '2026-01-01', end_date: '2026-03-31', due_date: '2026-05-07', status: 'open' }];
  assert.equal(resolveGbVatPeriod({ periods: rows, periodKey: ' #001 ' }).periodKey, ' #001 ');
});

test('period resolution uses persisted date boundaries', () => {
  const rows = [{ id: 'p1', period_key: '#001', start_date: '2026-01-01', end_date: '2026-03-31', due_date: '2026-05-07', status: 'open' }];
  assert.equal(resolveGbVatPeriod({ periods: rows, asOf: '2026-02-01' }).endsOn, '2026-03-31');
});

test('GB_VAT_PERIOD_NOT_ESTABLISHED fires when no persisted period matches', () => {
  assert.throws(() => resolveGbVatPeriod({ periods: [], periodKey: '#001' }),
    (error) => error.code === 'GB_VAT_PERIOD_NOT_ESTABLISHED');
});

test('GB_VAT_PERIOD_NOT_UNIQUE fires when persisted periods overlap', () => {
  const row = { id: 'p1', period_key: '#001', start_date: '2026-01-01', end_date: '2026-03-31', due_date: '2026-05-07' };
  assert.throws(() => resolveGbVatPeriod({ periods: [row, { ...row, id: 'p2' }], asOf: '2026-02-01' }),
    (error) => error.code === 'GB_VAT_PERIOD_NOT_UNIQUE');
});

test('GB_VAT_PERIOD_INCOMPLETE fires when a persisted period lacks a due date', () => {
  const row = { id: 'p1', period_key: '#001', start_date: '2026-01-01', end_date: '2026-03-31' };
  assert.throws(() => resolveGbVatPeriod({ periods: [row], periodKey: '#001' }),
    (error) => error.code === 'GB_VAT_PERIOD_INCOMPLETE');
});

test('GB_VAT_RETURN_MISFOOT_BOX_3 fires when Box 3 is tampered', () => {
  assert.throws(() => assertGbVatReturnFoots({ boxes: { '1': 20, '2': 5, '3': 24, '4': 10, '5': 14 } }),
    (error) => error.code === 'GB_VAT_RETURN_MISFOOT_BOX_3');
});

test('GB_VAT_RETURN_MISFOOT_BOX_5 fires when Box 5 is tampered', () => {
  assert.throws(() => assertGbVatReturnFoots({ boxes: { '1': 20, '2': 5, '3': 25, '4': 10, '5': 14 } }),
    (error) => error.code === 'GB_VAT_RETURN_MISFOOT_BOX_5');
});

test('box-map provenance remains explicitly unconfirmed against primary material', () => {
  assert.equal(prepare([]).provenance.confirmedAgainstPrimary, false);
});
