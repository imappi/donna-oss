// Owner VAT-return envelope route — GET /clients/:id/vat-return through the
// REAL api handler (apiSeamHarness). Pins the row-17 binding-state contract:
// the server owns the whole verdict (jurisdiction, prep refusals folded as
// data), the surface is unconditional for covered jurisdictions (the
// born-dark flag was deleted 2026-08-31, Kari "nothing dark"), and the
// pattern route has its vercel.json rewrite (vercelRewrites pin covers
// literal routes only — the rewrite ships in the same commit as this file).

import test from 'node:test';
import assert from 'node:assert/strict';

import { createApiSeamPool, requestDonnaApi } from './testSupport/apiSeamHarness.js';

const setEnv = () => {
  process.env.DONNA_ACCESS_TOKEN = 'owner-vat-seam';
  process.env.DATABASE_URL = 'postgres://seam.invalid/donna';
};

const periodRow = { id: 'p1', period_key: '26A2', start_date: '2020-01-01', end_date: '2099-12-31', due_date: '2099-12-31', status: 'open' };
const ledgerLines = [
  { journal_id: 'j1', line_no: 1, debit: 0, credit: 100, tax_type: 'VAT_SR_20_OUTPUT', account_type: 'revenue' },
  { journal_id: 'j1', line_no: 2, debit: 0, credit: 20, tax_type: 'NONE', account_type: 'liability', role: 'vat_output' }
];

const request = async ({ answers }) => {
  setEnv();
  const pool = createApiSeamPool(answers);
  const response = await requestDonnaApi({
    method: 'GET', url: '/api/donna/firms/clients/client-gb/vat-return',
    headers: { authorization: 'Bearer owner-vat-seam' }, pool
  });
  return { response, pool };
};

await test('owner vat-return: a jurisdiction with no registered preparer stays dark, no flag consulted', async () => {
  const { response, pool } = await request({ answers: [
    [/select jurisdiction, profile from clients/, { rows: [{ jurisdiction: 'FI', profile: {} }] }]
  ] });
  assert.equal(response.statusCode, 200, response.body);
  assert.deepEqual(response.json, { surface_acts: false, prepared: null, refusal: null });
  assert.equal(pool.matching(/capability_config/).length, 0, 'no flag is consulted');
});

await test('owner vat-return: a missing VAT registration folds as the named owner-fact refusal, HTTP 200', async () => {
  const { response } = await request({ answers: [
    [/select jurisdiction, profile from clients/, { rows: [{ jurisdiction: 'GB', profile: {} }] }],
    [/from vat_periods/, { rows: [periodRow] }]
  ] });
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.json.surface_acts, true);
  assert.equal(response.json.prepared, null);
  assert.equal(response.json.refusal.code, 'GB_VAT_REGISTRATION_NOT_ESTABLISHED');
});

await test('owner vat-return: registered GB client gets the prepared nine-box, current period resolved by today', async () => {
  const { response, pool } = await request({ answers: [
    [/select jurisdiction, profile from clients/, { rows: [{ jurisdiction: 'GB', profile: { vat_registration: { status: 'registered', registered_from: '2020-01-01' } } }] }],
    [/from vat_periods/, { rows: [periodRow] }],
    [/from ledger_lines/, { rows: ledgerLines }]
  ] });
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.json.surface_acts, true);
  assert.equal(response.json.refusal, null);
  assert.equal(response.json.prepared.vatReturn.boxes['1'], 20);
  assert.equal(response.json.prepared.period.periodKey, '26A2');
  assert.match(pool.matching(/from ledger_lines/)[0].sql, /lj\.status in \('posted', 'closed'\)/);
});

test.after(() => {
  delete process.env.DONNA_ACCESS_TOKEN;
  delete process.env.DATABASE_URL;
});
