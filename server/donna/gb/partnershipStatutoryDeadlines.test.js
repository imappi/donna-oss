import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildGbPartnershipStatutoryDeadlines,
  GB_PARTNERSHIP_STATUTORY_PROVENANCE
} from './partnershipStatutoryDeadlines.js';

test('partnership pack uses the resolved tax year and leaves unknown facts on the owner', () => {
  const out = buildGbPartnershipStatutoryDeadlines({ profile: { accounting_period_end: '2026-04-05' }, asOf: '2026-08-01' });
  assert.deepEqual(out, {
    entity_type: 'gb-partnership',
    tax_year: { label: '2025/26', starts_on: '2025-04-06', ends_on: '2026-04-05' },
    deadlines: [
      { key: 'partnership_return_online', label: 'Online SA800 partnership return', due_date: '2027-01-31', terminal: 'scheduled' },
      { key: 'partnership_registration', label: 'Register the partnership for Self Assessment', due_date: null, terminal: 'on_owner', reason_code: 'GB_PARTNERSHIP_TRADING_START_NOT_ESTABLISHED' },
      { key: 'vat_registration', label: 'VAT registration status', due_date: null, terminal: 'on_owner', reason_code: 'GB_PARTNERSHIP_VAT_REGISTRATION_NOT_ESTABLISHED' }
    ],
    provenance: GB_PARTNERSHIP_STATUTORY_PROVENANCE
  });
  assert.equal(out.deadlines.some(({ key }) => key.includes('payment_on_account')), false);
});

test('partnership VAT preserves tri-state registration and shared stagger dates', () => {
  const silent = buildGbPartnershipStatutoryDeadlines({ profile: { vat_registration: { status: 'not_registered' } }, asOf: '2026-08-01' });
  assert.equal(silent.deadlines.some(({ key }) => key.startsWith('vat_')), false);
  const registered = buildGbPartnershipStatutoryDeadlines({ profile: {
    accounting_period_end: '2026-04-05', vat_registration: { status: 'registered', registered_from: '2025-01-01' }, vat_stagger: 1
  }, asOf: '2026-08-01' });
  assert.deepEqual(registered.deadlines.filter(({ key }) => key.startsWith('vat_')).map(({ due_date }) => due_date), [
    '2026-05-07', '2026-08-07', '2026-11-07', '2027-02-07'
  ]);
});

test('partnership provenance pin trips on silent statutory edits', () => {
  assert.deepEqual(GB_PARTNERSHIP_STATUTORY_PROVENANCE, {
    authority: ['HM Revenue & Customs'], source: 'remembered HMRC statutory timetable', as_of: '2026-08-01', confirmedAgainstPrimary: false,
    verificationNote: 'Primary HMRC guidance was unavailable in the sandbox; confirm every remembered date before an acting filing or payment lane relies on it.'
  });
});
