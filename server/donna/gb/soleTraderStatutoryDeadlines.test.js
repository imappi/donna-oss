import test from 'node:test';
import assert from 'node:assert/strict';
import { buildGbSoleTraderStatutoryDeadlines, GB_SOLE_TRADER_STATUTORY_PROVENANCE } from './soleTraderStatutoryDeadlines.js';

test('sole-trader pack renders dates and leaves unknown facts honestly on the owner', () => {
  const out = buildGbSoleTraderStatutoryDeadlines({ profile: { accounting_period_end: '2026-04-05' }, asOf: '2026-08-01' });
  assert.equal(out.deadlines.find((x) => x.key === 'self_assessment_online').due_date, '2027-01-31');
  assert.deepEqual(out.deadlines.filter((x) => x.terminal === 'on_owner').map((x) => x.reason_code), [
    'GB_SOLE_TRADER_TRADING_START_NOT_ESTABLISHED', 'GB_SOLE_TRADER_PAYMENTS_ON_ACCOUNT_NOT_ESTABLISHED',
    'GB_SOLE_TRADER_VAT_REGISTRATION_NOT_ESTABLISHED'
  ]);
});

test('sole-trader full envelope stays byte-identical across the shared VAT extraction', () => {
  assert.deepEqual(buildGbSoleTraderStatutoryDeadlines({ profile: { accounting_period_end: '2026-04-05' }, asOf: '2026-08-01' }), {
    entity_type: 'gb-sole-trader',
    tax_year: { label: '2025/26', starts_on: '2025-04-06', ends_on: '2026-04-05' },
    deadlines: [
      { key: 'self_assessment_online', label: 'Online Self Assessment return', due_date: '2027-01-31', terminal: 'scheduled' },
      { key: 'balancing_payment', label: 'Self Assessment balancing payment', due_date: '2027-01-31', terminal: 'scheduled' },
      { key: 'self_assessment_registration', label: 'Register for Self Assessment', due_date: null, terminal: 'on_owner', reason_code: 'GB_SOLE_TRADER_TRADING_START_NOT_ESTABLISHED' },
      { key: 'payments_on_account', label: 'Payments on account', due_date: null, terminal: 'on_owner', reason_code: 'GB_SOLE_TRADER_PAYMENTS_ON_ACCOUNT_NOT_ESTABLISHED' },
      { key: 'vat_registration', label: 'VAT registration status', due_date: null, terminal: 'on_owner', reason_code: 'GB_SOLE_TRADER_VAT_REGISTRATION_NOT_ESTABLISHED' }
    ],
    provenance: GB_SOLE_TRADER_STATUTORY_PROVENANCE
  });
});

test('a recorded non-registration remains correct silence for VAT duties', () => {
  const { deadlines } = buildGbSoleTraderStatutoryDeadlines({ profile: { vat_registration: { status: 'not_registered' } }, asOf: '2026-08-01' });
  assert.equal(deadlines.some(({ key }) => key.startsWith('vat_')), false);
});

test('sole-trader provenance pin trips on silent statutory edits', () => {
  assert.deepEqual(GB_SOLE_TRADER_STATUTORY_PROVENANCE, {
    authority: ['HM Revenue & Customs'], source: 'remembered HMRC statutory timetable', as_of: '2026-08-01', confirmedAgainstPrimary: false,
    verificationNote: 'Primary HMRC guidance was unavailable in the sandbox; confirm every remembered date before an acting filing or payment lane relies on it.'
  });
});

test('VAT return deadlines cover every quarter in all three staggers', () => {
  const expected = {
    1: ['2026-03-31→2026-05-07', '2026-06-30→2026-08-07', '2026-09-30→2026-11-07', '2026-12-31→2027-02-07'],
    2: ['2026-01-31→2026-03-07', '2026-04-30→2026-06-07', '2026-07-31→2026-09-07', '2026-10-31→2026-12-07'],
    3: ['2026-02-28→2026-04-07', '2026-05-31→2026-07-07', '2026-08-31→2026-10-07', '2026-11-30→2027-01-07']
  };
  for (const stagger of [1, 2, 3]) {
    const { deadlines } = buildGbSoleTraderStatutoryDeadlines({
      profile: { accounting_period_end: '2026-04-05', vat_registration: { status: 'registered', registered_from: '2025-01-01' }, vat_stagger: stagger },
      asOf: '2026-08-01'
    });
    assert.deepEqual(deadlines.filter(({ key }) => key.startsWith('vat_')).map(({ label, due_date }) => `${label.match(/\(([^)]+)\)/)[1]}→${due_date}`), expected[stagger]);
  }
});

test('phantom payment-on-account profile data cannot bypass the named owner refusal', () => {
  const { deadlines } = buildGbSoleTraderStatutoryDeadlines({ profile: { accounting_period_end: '2026-04-05', payments_on_account_required: true }, asOf: '2026-08-01' });
  assert.equal(deadlines.some(({ key }) => key === 'payment_on_account_1' || key === 'payment_on_account_2'), false);
  assert.equal(deadlines.find(({ key }) => key === 'payments_on_account').reason_code, 'GB_SOLE_TRADER_PAYMENTS_ON_ACCOUNT_NOT_ESTABLISHED');
});
