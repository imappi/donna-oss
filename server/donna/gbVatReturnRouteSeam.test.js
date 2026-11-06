import test from 'node:test';
import assert from 'node:assert/strict';

import { createApiSeamPool, requestDonnaApi } from './testSupport/apiSeamHarness.js';

const TOKEN = 'gb-vat-route-seam';
const auth = { authorization: `Bearer ${TOKEN}` };

const setFirmEnv = () => {
  process.env.DONNA_ACCESS_TOKEN = TOKEN;
  process.env.DATABASE_URL = 'postgres://seam.invalid/donna';
};

const period = {
  id: 'vat-period-1', period_key: '26Q2', start_date: '2026-04-01',
  end_date: '2026-06-30', due_date: '2026-08-07', status: 'open'
};

const base = (journal_id, line_no, tax_type, account_type, debit, credit) => ({
  journal_id, line_no, tax_type, account_type, account_code: `A${line_no}`,
  role: null, debit, credit
});
const control = (journal_id, line_no, role, debit, credit) => ({
  journal_id, line_no, tax_type: 'NONE', account_type: 'liability',
  account_code: 'VAT', role, debit, credit
});
const lines = [
  base('j1', 1, 'VAT_SR_20_OUTPUT', 'revenue', 0, 100),
  base('j2', 2, 'VAT_RR_5_OUTPUT', 'revenue', 0, 40),
  base('j3', 3, 'VAT_SR_20_INPUT', 'expense', 30, 0),
  base('j4', 4, 'VAT_RR_5_INPUT', 'expense', 20, 0),
  base('j5', 5, 'VAT_REVERSE_CHARGE_20_INPUT', 'expense', 10, 0),
  base('j6', 6, 'VAT_EU_SUPPLY_OUTPUT', 'revenue', 0, 11),
  base('j7', 7, 'VAT_EU_ACQUISITION_20_INPUT', 'expense', 17, 0),
  control('j1', 8, 'vat_output', 0, 20),
  control('j2', 9, 'vat_output', 0, 2),
  control('j3', 10, 'vat_input_deductible', 6, 0),
  control('j4', 11, 'vat_input_deductible', 1, 0)
];

// The default fixture registration covers the whole 26Q2 period — the
// happy-path envelope must be earned by an established registration, never by
// the absence of a record (the F-8C-GB-VAT-UNREGISTERED lesson).
const registeredForPeriod = { status: 'registered', registered_from: '2020-01-01' };

const poolFor = ({ vatRegistration = registeredForPeriod, periods = [period], ledgerLines = lines } = {}) => createApiSeamPool([
  [/select jurisdiction from clients/, { rows: [{ jurisdiction: 'GB' }], rowCount: 1 }],
  [/select profile from clients/, { rows: [{ profile: vatRegistration === undefined ? {} : { vat_registration: vatRegistration } }], rowCount: 1 }],
  [/from vat_periods/, { rows: periods, rowCount: periods.length }],
  [/from ledger_lines ll/, { rows: ledgerLines, rowCount: ledgerLines.length }]
]);

const expectedPreparedEnvelope = {
  period: {
    id: 'vat-period-1', periodKey: '26Q2', startsOn: '2026-04-01',
    endsOn: '2026-06-30', dueOn: '2026-08-07', status: 'open'
  },
  vatReturn: {
    boxes: { 1: 24, 2: 3.4, 3: 27.4, 4: 12.4, 5: 15, 6: 151, 7: 77, 8: 11, 9: 17 },
    outcome: 'payment',
    netVat: 15,
    nilReturn: false,
    provenance: {
      authority: 'HM Revenue & Customs',
      source: 'VAT Notice 700/12: filling in and submitting your VAT Return',
      as_of: '2026-07-29',
      confirmedAgainstPrimary: false,
      note: 'Nine-box mechanics and treatment mapping await a network-open primary-source check; gov.uk returned 403 through the session proxy. The engine therefore carries this provenance and refuses unknown treatments.'
    }
  },
  review: { status: 'ready', refusals: [] }
};

await test('GB VAT route renders the real, distinct nine-box owner envelope', async () => {
  setFirmEnv();
  const pool = poolFor();
  const response = await requestDonnaApi({
    url: '/api/donna/firms/reports/gb-vat-return?firm_id=firm-1&client_id=gb-1&period=26Q2', headers: auth, pool
  });
  assert.equal(response.statusCode, 200, response.body);
  assert.deepEqual(response.json.period, {
    id: 'vat-period-1', periodKey: '26Q2', startsOn: '2026-04-01',
    endsOn: '2026-06-30', dueOn: '2026-08-07', status: 'open'
  });
  const { boxes } = response.json.vatReturn;
  assert.deepEqual(boxes, {
    1: 24, 2: 3.4, 3: 27.4, 4: 12.4, 5: 15,
    6: 151, 7: 77, 8: 11, 9: 17
  });
  assert.equal(new Set(Object.values(boxes)).size, 9, 'every box is distinct in the fixture');
  assert.equal(boxes['3'], boxes['1'] + boxes['2']);
  assert.equal(boxes['5'], Math.round(Math.abs(boxes['3'] - boxes['4']) * 100) / 100);
  assert.equal(response.json.vatReturn.outcome, 'payment');
  assert.equal(response.json.vatReturn.netVat, 15);
  assert.equal(pool.matching(/from vat_periods/).length, 1);
  assert.equal(pool.matching(/from ledger_lines ll/).length, 1);
});

await test('GB VAT route keeps the full prepared envelope for an explicitly registered client', async () => {
  setFirmEnv();
  const pool = poolFor({
    vatRegistration: { status: 'registered', registered_from: '2020-01-01' }
  });
  const response = await requestDonnaApi({
    url: '/api/donna/firms/reports/gb-vat-return?firm_id=firm-1&client_id=gb-1&period=26Q2', headers: auth, pool
  });
  assert.equal(response.statusCode, 200, response.body);
  assert.deepEqual(response.json, expectedPreparedEnvelope);
  assert.equal(pool.matching(/from vat_periods/).length, 1);
  assert.equal(pool.matching(/from ledger_lines ll/).length, 1);
});

await test('GB VAT route refuses when no record establishes registration for the period', async () => {
  setFirmEnv();
  // null (not undefined — that would take the fixture default) serves a
  // profile whose vat_registration is absent: the resolver's no_record lane.
  const pool = poolFor({ vatRegistration: null });
  const response = await requestDonnaApi({
    url: '/api/donna/firms/reports/gb-vat-return?firm_id=firm-1&client_id=gb-1&period=26Q2', headers: auth, pool
  });
  assert.equal(response.statusCode, 422, response.body);
  assert.equal(response.json.code, 'GB_VAT_REGISTRATION_NOT_ESTABLISHED');
  assert.equal(pool.matching(/from vat_periods/).length, 1, 'the period read runs — its dates are what registration resolves at');
  assert.equal(pool.matching(/from ledger_lines ll/).length, 0, 'a registration refusal stops before ledger aggregation');
});

await test('GB VAT route refuses an explicitly unregistered client across the period before ledger reads', async () => {
  setFirmEnv();
  const pool = poolFor({ vatRegistration: { status: 'not_registered' } });
  const response = await requestDonnaApi({
    url: '/api/donna/firms/reports/gb-vat-return?firm_id=firm-1&client_id=gb-1&period=26Q2', headers: auth, pool
  });
  assert.equal(response.statusCode, 422, response.body);
  assert.deepEqual(response.json, {
    error: 'The client is recorded as not VAT-registered across this period.',
    code: 'GB_VAT_RETURN_NOT_REGISTERED_FOR_PERIOD'
  });
  assert.equal(pool.matching(/from vat_periods/).length, 1, 'the period read runs — its dates are what registration resolves at');
  assert.equal(pool.matching(/from ledger_lines ll/).length, 0, 'registration refusal stops before ledger aggregation');
});

await test('GB VAT route refuses a deregistration that predates the whole period', async () => {
  setFirmEnv();
  const pool = poolFor({
    vatRegistration: { status: 'deregistered', registered_from: '2020-01-01', registered_until: '2026-01-31' }
  });
  const response = await requestDonnaApi({
    url: '/api/donna/firms/reports/gb-vat-return?firm_id=firm-1&client_id=gb-1&period=26Q2', headers: auth, pool
  });
  assert.equal(response.statusCode, 422, response.body);
  assert.equal(response.json.code, 'GB_VAT_RETURN_NOT_REGISTERED_FOR_PERIOD');
  assert.equal(pool.matching(/from ledger_lines ll/).length, 0, 'registration refusal stops before ledger aggregation');
});

await test('GB VAT route refuses a registration covering only part of the period', async () => {
  setFirmEnv();
  const pool = poolFor({ vatRegistration: { status: 'registered', registered_from: '2026-05-15' } });
  const response = await requestDonnaApi({
    url: '/api/donna/firms/reports/gb-vat-return?firm_id=firm-1&client_id=gb-1&period=26Q2', headers: auth, pool
  });
  assert.equal(response.statusCode, 422, response.body);
  assert.equal(response.json.code, 'GB_VAT_REGISTRATION_PARTIAL_PERIOD');
  assert.equal(pool.matching(/from ledger_lines ll/).length, 0, 'a partial-period verdict never renders a silently-partial nine-box');
});

await test('GB VAT route renders the evaluator\'s named missing-period refusal', async () => {
  setFirmEnv();
  const pool = poolFor({ periods: [] });
  const response = await requestDonnaApi({
    url: '/api/donna/firms/reports/gb-vat-return?firm_id=firm-1&client_id=gb-1&period=missing', headers: auth, pool
  });
  assert.equal(response.statusCode, 422, response.body);
  assert.equal(response.json.code, 'GB_VAT_PERIOD_NOT_ESTABLISHED');
  assert.equal(pool.matching(/from vat_periods/).length, 1, 'the persisted period read ran');
  assert.equal(pool.matching(/from ledger_lines ll/).length, 0, 'a named period refusal stops before ledger aggregation');
});
