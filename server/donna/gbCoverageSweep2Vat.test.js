import test from 'node:test';
import assert from 'node:assert/strict';

import { createApiSeamPool, requestDonnaApi } from './testSupport/apiSeamHarness.js';

const TOKEN = 'gb-coverage-sweep-2-vat';
const auth = { authorization: `Bearer ${TOKEN}` };

const setEnv = () => {
  process.env.DONNA_ACCESS_TOKEN = TOKEN;
  process.env.DATABASE_URL = 'postgres://seam.invalid/donna';
};

const line = (journalId, lineNo, taxType, accountType, debit, credit, role = null) => ({
  journal_id: journalId, line_no: lineNo, tax_type: taxType, account_type: accountType,
  account_code: `A${lineNo}`, role, debit, credit
});

await test('coverage sweep: persisted VAT period produces the complete nine-box route envelope', async () => {
  setEnv();
  const period = {
    id: 'vp-2026-q2', period_key: '26Q2', start_date: '2026-04-01',
    end_date: '2026-06-30', due_date: '2026-08-07', status: 'open'
  };
  const lines = [
    line('j1', 1, 'VAT_SR_20_OUTPUT', 'revenue', 0, 100),
    line('j2', 2, 'VAT_RR_5_OUTPUT', 'revenue', 0, 40),
    line('j3', 3, 'VAT_SR_20_INPUT', 'expense', 30, 0),
    line('j4', 4, 'VAT_RR_5_INPUT', 'expense', 20, 0),
    line('j5', 5, 'VAT_REVERSE_CHARGE_20_INPUT', 'expense', 10, 0),
    line('j6', 6, 'VAT_EU_SUPPLY_OUTPUT', 'revenue', 0, 11),
    line('j7', 7, 'VAT_EU_ACQUISITION_20_INPUT', 'expense', 17, 0),
    line('j1', 8, 'NONE', 'liability', 0, 20, 'vat_output'),
    line('j2', 9, 'NONE', 'liability', 0, 2, 'vat_output'),
    line('j3', 10, 'NONE', 'liability', 6, 0, 'vat_input_deductible'),
    line('j4', 11, 'NONE', 'liability', 1, 0, 'vat_input_deductible')
  ];
  const pool = createApiSeamPool([
    [/select jurisdiction from clients/, { rows: [{ jurisdiction: 'GB' }], rowCount: 1 }],
    // The 200 envelope must be earned by a registration covering the period —
    // an absent record is the NOT_ESTABLISHED refusal, never a rendered return.
    [/select profile from clients/, { rows: [{ profile: { vat_registration: { status: 'registered', registered_from: '2020-01-01' } } }], rowCount: 1 }],
    [/from vat_periods/, { rows: [period], rowCount: 1 }],
    [/from ledger_lines ll/, { rows: lines, rowCount: lines.length }]
  ]);
  const response = await requestDonnaApi({
    url: '/api/donna/firms/reports/gb-vat-return?firm_id=firm-1&client_id=gb-1&period=26Q2', auth, headers: auth, pool
  });

  assert.equal(response.statusCode, 200, response.body);
  assert.deepEqual(response.json, {
    period: {
      id: 'vp-2026-q2', periodKey: '26Q2', startsOn: '2026-04-01',
      endsOn: '2026-06-30', dueOn: '2026-08-07', status: 'open'
    },
    vatReturn: {
      boxes: { 1: 24, 2: 3.4, 3: 27.4, 4: 12.4, 5: 15, 6: 151, 7: 77, 8: 11, 9: 17 },
      netVat: 15,
      outcome: 'payment',
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
  });
  assert.equal(pool.matching(/from vat_periods/).length, 1);
  assert.equal(pool.matching(/from ledger_lines ll/).length, 1);
});

await test('coverage sweep: a duplicate persisted VAT period is a named 422 and never reads ledger lines', async () => {
  setEnv();
  const period = { id: 'vp-1', period_key: '26Q2', start_date: '2026-04-01', end_date: '2026-06-30', due_date: '2026-08-07', status: 'open' };
  const pool = createApiSeamPool([
    [/select jurisdiction from clients/, { rows: [{ jurisdiction: 'GB' }], rowCount: 1 }],
    [/from vat_periods/, { rows: [period, { ...period, id: 'vp-2' }], rowCount: 2 }]
  ]);
  const response = await requestDonnaApi({
    url: '/api/donna/firms/reports/gb-vat-return?firm_id=firm-1&client_id=gb-1&period=26Q2', headers: auth, pool
  });
  assert.equal(response.statusCode, 422, response.body);
  assert.equal(response.json.code, 'GB_VAT_PERIOD_NOT_UNIQUE');
  assert.equal(pool.matching(/from vat_periods/).length, 1);
  assert.equal(pool.matching(/from ledger_lines ll/).length, 0);
});
