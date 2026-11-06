import assert from 'node:assert/strict';
import test from 'node:test';
import { createApiSeamPool, requestDonnaApi } from './testSupport/apiSeamHarness.js';

const TOKEN = 'gb-input-vat-route';
const period = { id: 'p1', period_key: '26Q2', start_date: '2026-04-01', end_date: '2026-06-30', due_date: '2026-08-07', status: 'open' };
const base = (tax_type, debit, journal_id = tax_type) => ({ journal_id, line_no: 1, tax_type, account_type: 'expense', account_code: '7500', role: null, debit, credit: 0 });
const control = (amount, journal_id) => ({ journal_id, line_no: 2, tax_type: 'NONE', account_type: 'liability', account_code: '2202', role: 'vat_input_deductible', debit: amount, credit: 0 });
const poolFor = (ledgerLines) => createApiSeamPool([
  [/select jurisdiction from clients/, { rows: [{ jurisdiction: 'gb' }] }],
  [/select profile from clients/, { rows: [{ profile: { vat_registration: { status: 'registered', registered_from: '2020-01-01' } } }] }],
  [/from vat_periods/, { rows: [period] }],
  [/from ledger_lines ll/, { rows: ledgerLines }]
]);
const request = async (ledgerLines) => {
  process.env.DONNA_ACCESS_TOKEN = TOKEN;
  process.env.DATABASE_URL = 'postgres://seam.invalid/donna';
  const pool = poolFor(ledgerLines);
  const response = await requestDonnaApi({ url: '/api/donna/firms/reports/gb-vat-return?firm_id=f1&client_id=c1&period=26Q2', headers: { authorization: `Bearer ${TOKEN}` }, pool });
  assert.equal(pool.matching(/from ledger_lines ll/).length, 1);
  return response;
};

const cases = [
  ['VAT_SR_20_INPUT', 100, 20, 100],
  ['VAT_RR_5_INPUT', 100, 5, 100],
  ['VAT_ZR_INPUT', 100, 0, 100],
  ['VAT_EXEMPT_INPUT', 100, 0, 100],
  ['VAT_OUTSIDE_SCOPE_INPUT', 100, 0, 0],
  ['VAT_REVERSE_CHARGE_20_INPUT', 100, 20, 100],
  ['VAT_EU_ACQUISITION_20_INPUT', 100, 20, 100],
  ['VAT_BLOCKED_INPUT', 120, 0, 120]
];
for (const [code, net, box4, box7] of cases) {
  test(`${code} reaches the route with its exact Boxes 4/7 treatment`, async () => {
    const journal = `j-${code}`;
    const ledger = [base(code, net, journal)];
    if (code === 'VAT_SR_20_INPUT' || code === 'VAT_RR_5_INPUT') ledger.push(control(box4, journal));
    const response = await request(ledger);
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.json.vatReturn.boxes['4'], box4);
    assert.equal(response.json.vatReturn.boxes['7'], box7);
  });
}

test('an uncoded expense refuses the route with GB_VAT_TREATMENT_NOT_ESTABLISHED', async () => {
  const response = await request([base('NONE', 100, 'uncoded')]);
  assert.equal(response.statusCode, 422, response.body);
  assert.equal(response.json.code, 'GB_VAT_TREATMENT_NOT_ESTABLISHED');
});

test('a domestic splitting code without its control leg refuses the gross-post regression', async () => {
  const response = await request([base('VAT_SR_20_INPUT', 120, 'gross-post')]);
  assert.equal(response.statusCode, 422, response.body);
  assert.equal(response.json.code, 'GB_VAT_CONTROL_ACCOUNT_MISMATCH');
  assert.deepEqual(response.json.details.inputTax, { expected: 24, actual: 0 });
});
