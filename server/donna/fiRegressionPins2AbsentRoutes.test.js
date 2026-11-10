import test from 'node:test';
import assert from 'node:assert/strict';

import { createApiSeamPool, requestDonnaApi } from './testSupport/apiSeamHarness.js';

const TOKEN = 'fi-regression-pins-2-absent';
const priorToken = process.env.DONNA_ACCESS_TOKEN;
const priorDb = process.env.DATABASE_URL;
process.env.DONNA_ACCESS_TOKEN = TOKEN;
process.env.DATABASE_URL = 'postgres://seam.invalid/donna';
const auth = { authorization: `Bearer ${TOKEN}` };

test.after(() => {
  if (priorToken === undefined) delete process.env.DONNA_ACCESS_TOKEN; else process.env.DONNA_ACCESS_TOKEN = priorToken;
  if (priorDb === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = priorDb;
});

const poolFor = () => createApiSeamPool([
  [/select id from clients where firm_id/, { rows: [{ id: 'fi-1', jurisdiction: null, profile: {} }], rowCount: 1 }],
  [/from client_capability_config/, { rows: [
    { flag_key: 'FINLAND_ALV_RETURN', stage: 'auto', source: 'test', client_id: 'fi-1' },
    { flag_key: 'FINLAND_ALV_THRESHOLD_WATCH', stage: 'auto', source: 'test', client_id: 'fi-1' }
  ] }],
  [/from cohort_capability_config/, { rows: [] }],
  [/select profile from clients/, { rows: [{ profile: { verokausi: 'quarter' } }] }],
  [/select ll\.\*, la\.account_type/, { rows: [] }],
  [/from alv_returns/, { rows: [] }],
  [/select extract\(year from lj\.journal_date\)/, { rows: [
    { year: 2026, turnover: '17500' }, { year: 2025, turnover: '10000' }
  ] }],
  [/from client_evidence_requests where id/, { rows: [{
    id: 'alv-threshold-firm-1-fi-1-2026', status: 'open', first_sent_at: '2026-07-01T00:00:00.000Z'
  }] }]
]);

const withFixedNow = async (fn) => {
  const RealDate = Date;
  globalThis.Date = class extends RealDate {
    constructor(...args) { super(...(args.length ? args : ['2026-08-01T12:00:00.000Z'])); }
    static now() { return new RealDate('2026-08-01T12:00:00.000Z').valueOf(); }
  };
  try { return await fn(); } finally { globalThis.Date = RealDate; }
};

await test('absent jurisdiction: FI ALV return route preserves its complete current envelope byte-for-byte', async () => {
  const pool = poolFor();
  const response = await withFixedNow(() => requestDonnaApi({
    url: '/api/donna/firms/reports/finland-alv-return?firm_id=firm-1&client_id=fi-1&period=2026-06', headers: auth, pool
  }));
  assert.equal(response.statusCode, 200, response.body);
  assert.deepEqual(response.json, {
    period: { key: '2026-06', type: 'month', starts_on: '2026-06-01', ends_on: '2026-06-30' },
    alvReturn: {
      boxes: Object.fromEntries(['301', '302', '303', '304', '305', '306', '307', '308', '309', '310', '311', '312', '313', '314', '318', '319', '320'].map((key) => [key, 0])),
      payable: 0, refund: false, nilReturn: true, selfAssessedFullyDeductible: true
    },
    review: {
      status: 'ready', blockers: [], uncodedRevenueLines: [], incompatibleLines: [], uncodedExpenseLineCount: 0,
      controlCheck: {
        ran: false, outputTax: { expected: 0, actual: 0 }, domesticDeductible: { expected: 0, actual: 0 },
        tolerance: 0.02, legCount: 0, unmarkedControlMovement: 0
      }
    },
    verokausi: 'quarter',
    // Additive: where the cadence came from (recorded here, nothing to disagree with).
    verokausi_basis: { cadence: 'quarter', defaulted: false, recorded: { verokausi: 'quarter', alv_registration_tax_period: null }, disagreement: false },
    provenance: {
      source: 'ledger_read_model', readAt: '2026-08-01T12:00:00.000Z', deterministic: true,
      boxMap: {
        confirmedAgainstPrimary: false,
        source: 'Verohallinto tietuekuvaus VSRALVKV (27.2.2026) + vero.fi täyttöohje, via search extraction 2026-07-10; primary fetch blocked by network policy (F-FI3-1)'
      }
    },
    lifecycle: null,
    // Additive: other live returns over these dates (none here).
    covered_by: []
  });
  assert.equal(pool.matching(/from client_capability_config/).length, 1);
  assert.equal(pool.matching(/select ll\.\*, la\.account_type/).length, 1);
  assert.equal(pool.matching(/from alv_returns/).length, 1);
});

await test('absent jurisdiction: FI ALV threshold route preserves its complete current envelope byte-for-byte', async () => {
  const pool = poolFor();
  const response = await withFixedNow(() => requestDonnaApi({
    url: '/api/donna/firms/reports/finland-alv-threshold?firm_id=firm-1&client_id=fi-1&year=2026', headers: auth, pool
  }));
  assert.equal(response.statusCode, 200, response.body);
  assert.deepEqual(response.json, {
    watch: {
      applicable: true, year: 2026, thresholdEur: 20000, currentYearTurnover: 17500,
      priorYearTurnover: 10000, drivingTurnover: 17500, fraction: 0.88, headroomEur: 2500,
      status: 'approaching',
      note: 'Liikevaihto (17500,00 €) lähestyy ALV-rekisteröinnin rajaa (20000,00 €, 88 %). Seuraa kertymää ja valmistaudu rekisteröintiin.',
      provenance: {
        confirmedAgainstPrimary: false,
        source: 'Arvonlisäverolaki €20,000 registration threshold (2025) via secondary confirmation; crossing mechanics CORROBORATED via search extraction 2026-07-11 (vero.fi small-business guidance 48658 titles + vatcalc/Marosa/Vaasa-region): exemption requires BOTH current AND previous calendar year ≤ €20k, liability starts AT the crossing date (no retroactivity to year start), sales exceeding the threshold taxable in full — the conservative warn-on-either-year watch matches. Byte-level primary read pending (network policy, F-FI8-R1 pass)'
      }
    },
    escalation: {
      ask_id: 'alv-threshold-firm-1-fi-1-2026', status: 'open', first_sent_at: '2026-07-01T00:00:00.000Z'
    },
    provenance: { source: 'ledger_read_model', readAt: '2026-08-01T12:00:00.000Z', deterministic: true }
  });
  assert.equal(pool.matching(/from client_capability_config/).length, 1);
  assert.equal(pool.matching(/select extract\(year from lj\.journal_date\)/).length, 1);
  assert.equal(pool.matching(/from client_evidence_requests where id/).length, 1);
});
