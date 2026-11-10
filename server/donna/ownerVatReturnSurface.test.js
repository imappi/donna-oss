// The market-neutral owner VAT-return dispatcher — unconditional for covered
// jurisdictions (the born-dark flag was deleted 2026-08-31, Kari "nothing
// dark"); jurisdiction decides WHICH preparation (ownerVatReturnSurface.js).
// Pins: GB dispatch preserves the pre-move gb/vatReturnRoute.js envelope (the
// api-level twin stays pinned in ownerVatReturnRouteSeam.test.js); AE
// dispatch with the profile facts flowing through; named refusals folded as
// data for BOTH markets; non-GB/AE dark; infrastructure errors still
// throwing.

import assert from 'node:assert/strict';
import test from 'node:test';

import { ownerVatReturnFromDb } from './ownerVatReturnSurface.js';

const GB_REGISTRATION = { status: 'registered', registered_from: '2020-01-01' };
const AE_REGISTRATION = { status: 'registered', registered_from: '2020-01-01', vat_registration_number: '100 1234 5678 9012' };

// A wide-open period so the no-periodKey call resolves the current period by
// today's date (the "where do I stand NOW" default carried over from GB).
const GB_PERIOD_ROW = { id: 'p1', period_key: '26A2', start_date: '2020-01-01', end_date: '2099-12-31', due_date: '2099-12-31', status: 'open' };
const AE_PERIOD_ROW = { id: 'p1', period_key: 'Apr-Jun 2026', start_date: '2026-04-01', end_date: '2026-06-30', due_date: '2026-07-28', status: 'open' };

const GB_LINES = [
  { journal_id: 'j1', line_no: 1, debit: 0, credit: 100, tax_type: 'VAT_SR_20_OUTPUT', account_type: 'revenue' },
  { journal_id: 'j1', line_no: 2, debit: 0, credit: 20, tax_type: 'NONE', account_type: 'liability', role: 'vat_output' }
];
const AE_LINES = [
  { journal_id: 'j1', line_no: 1, debit: 0, credit: 1000, tax_type: 'AE_VAT_SR_5_OUTPUT', account_type: 'revenue' },
  { journal_id: 'j1', line_no: 2, debit: 0, credit: 50, tax_type: 'NONE', account_type: 'liability', role: 'vat_output' }
].map((line) => ({
  ...line,
  currency: 'AED',
  journal_date: '2026-04-01',
  tax_point: {
    date_of_supply: '2026-04-01',
    reporting_date: '2026-04-01',
    document_id: 'doc-1',
    evidence_digest: 'retained-evidence-digest',
    actor_id: 'owner-1',
    authority_basis: 'transaction_review_correction'
  }
}));

// Regex-answered fake DB client (the apiSeamHarness pool shape, inlined for a
// module-level test); unmatched queries throw so an unexpected read is loud.
const fakeClient = (answers) => {
  const calls = [];
  return {
    calls,
    matching: (pattern) => calls.filter((call) => pattern.test(call.sql)),
    query: async (sql, params) => {
      calls.push({ sql, params });
      const answer = answers.find(([pattern]) => pattern.test(sql));
      if (!answer) throw new Error(`unexpected query: ${sql}`);
      const value = answer[1];
      if (value instanceof Error) throw value;
      return value;
    }
  };
};

const dispatch = ({ answers, periodKey } = {}) => {
  const client = fakeClient(answers);
  const result = ownerVatReturnFromDb({
    firmId: 'firm-1',
    clientId: 'client-1',
    periodKey,
    withFirmDbClientFn: (fn) => fn(client)
  });
  return result.then((envelope) => ({ envelope, client }));
};

test('no config-plane read: the surface is unconditional, not flag-gated', async () => {
  const { client } = await dispatch({ answers: [
    [/select jurisdiction, profile from clients/, { rows: [{ jurisdiction: 'FI', profile: {} }] }]
  ] });
  assert.equal(client.matching(/capability_config/).length, 0, 'no flag is consulted');
});

test('a GB client dispatches to the GB preparation, current period resolved by today', async () => {
  const { envelope, client } = await dispatch({ answers: [
    [/select jurisdiction, profile from clients/, { rows: [{ jurisdiction: 'GB', profile: { vat_registration: GB_REGISTRATION } }] }],
    [/from vat_periods/, { rows: [GB_PERIOD_ROW] }],
    [/from ledger_lines/, { rows: GB_LINES }],
    [/from transactions t/, { rows: [] }]
  ] });
  assert.equal(envelope.surface_acts, true);
  assert.equal(envelope.refusal, null);
  assert.equal(envelope.prepared.vatReturn.boxes['1'], 20);
  assert.equal(envelope.prepared.period.periodKey, '26A2');
  assert.match(client.matching(/from ledger_lines/)[0].sql, /lj\.status in \('posted', 'closed'\)/);
});

test('an AE client dispatches to the AE preparation with both profile facts flowing through', async () => {
  const { envelope } = await dispatch({
    periodKey: 'Apr-Jun 2026',
    answers: [
        [/select jurisdiction, profile from clients/, { rows: [{ jurisdiction: 'AE', profile: { vat_registration: AE_REGISTRATION, ae_establishment: { emirate: 'DXB' } } }] }],
      [/from ae_vat_periods/, { rows: [AE_PERIOD_ROW] }],
      [/from ledger_lines/, { rows: AE_LINES }]
    ]
  });
  assert.equal(envelope.surface_acts, true);
  assert.equal(envelope.refusal, null);
  assert.deepEqual(envelope.prepared.vatReturn.fields.standard_rated_supplies.by_emirate.DXB, { amount: 1000, vat: 50 });
  assert.equal(envelope.prepared.period.periodKey, 'Apr-Jun 2026');
});

test('an AE preparation refusal folds into the envelope as data, exactly like GB', async () => {
  const { envelope } = await dispatch({
    periodKey: 'Apr-Jun 2026',
    answers: [
        [/select jurisdiction, profile from clients/, { rows: [{ jurisdiction: 'AE', profile: {} }] }],
      [/from ae_vat_periods/, { rows: [AE_PERIOD_ROW] }]
    ]
  });
  assert.equal(envelope.surface_acts, true);
  assert.equal(envelope.prepared, null);
  assert.equal(envelope.refusal.code, 'AE_VAT_REGISTRATION_NOT_ESTABLISHED');
});

test('an AE standard journal without a tax-point receipt returns the named refusal through the owner surface', async () => {
  const { envelope } = await dispatch({
    periodKey: 'Apr-Jun 2026',
    answers: [
      [/select jurisdiction, profile from clients/, { rows: [{ jurisdiction: 'AE', profile: { vat_registration: AE_REGISTRATION, ae_establishment: { emirate: 'DXB' } } }] }],
      [/from ae_vat_periods/, { rows: [AE_PERIOD_ROW] }],
      [/from ledger_lines/, { rows: AE_LINES.map((line) => ({ ...line, tax_point: null })) }]
    ]
  });
  assert.equal(envelope.surface_acts, true);
  assert.equal(envelope.prepared, null);
  assert.equal(envelope.refusal.code, 'AE_VAT_POSTED_TAX_POINT_UNSUPPORTED');
});

test('a client in a jurisdiction with no registered preparer stays dark', async () => {
  for (const jurisdiction of ['FI', 'SG', 'US', 'AU', 'NZ', 'UK', null, 'unknown']) {
    const { envelope } = await dispatch({ answers: [
      [/select jurisdiction, profile from clients/, { rows: [{ jurisdiction, profile: {} }] }]
    ] });
    assert.deepEqual(envelope, { surface_acts: false, prepared: null, refusal: null }, String(jurisdiction));
  }
});

test('an infrastructure error (no typed code) still throws instead of folding', async () => {
  await assert.rejects(
    dispatch({
      periodKey: 'Apr-Jun 2026',
      answers: [
            [/select jurisdiction, profile from clients/, { rows: [{ jurisdiction: 'AE', profile: { vat_registration: AE_REGISTRATION, ae_establishment: { emirate: 'DXB' } } }] }],
        [/from ae_vat_periods/, new Error('connection reset')]
      ]
    }),
    /connection reset/
  );
});
