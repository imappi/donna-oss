import assert from 'node:assert/strict';
import test from 'node:test';

import {
  GB_LLP_STATUTORY_PROVENANCE,
  buildGbLlpStatutoryDeadlines
} from './llpStatutoryDeadlines.js';

test('LLP receipt remains explicitly unconfirmed against primary guidance', () => {
  assert.deepEqual(GB_LLP_STATUTORY_PROVENANCE, {
    authority: ['Companies House', 'HM Revenue & Customs'],
    source: 'remembered Companies House and HMRC statutory timetable',
    as_of: '2026-08-01',
    confirmedAgainstPrimary: false,
    verificationNote: 'Primary guidance was unavailable in the sandbox; confirm every remembered date before an acting filing or payment lane relies on it.'
  });
});

test('LLP reuses Companies House and VAT machinery without company-tax rows', () => {
  const envelope = buildGbLlpStatutoryDeadlines({ profile: {
    accounting_period_end: '2026-12-31', confirmation_review_period_end: '2026-07-31',
    vat_stagger: 2, vat_registration: { status: 'registered', registered_from: '2025-01-01' }
  }, asOf: '2026-08-01' });
  assert.deepEqual(envelope.deadlines.map(({ key, due_date }) => [key, due_date]), [
    ['accounts', '2027-09-30'], ['confirmation', '2026-08-14'],
    ['partnership_return_online', '2028-01-31'], ['partnership_registration', null],
    ['vat_1', '2026-03-07'], ['vat_2', '2026-06-07'],
    ['vat_3', '2026-09-07'], ['vat_4', '2026-12-07']
  ]);
  assert.equal(envelope.deadlines.some(({ key }) => key === 'ct600' || key === 'corporation_tax'), false);
});

test('each absent LLP fact becomes a named on-owner row — and SA800 still schedules', () => {
  const envelope = buildGbLlpStatutoryDeadlines({ profile: {}, asOf: '2026-08-01' });
  assert.deepEqual(envelope.deadlines.filter(({ terminal }) => terminal === 'on_owner').map(({ reason_code }) => reason_code), [
    'GB_LLP_ACCOUNTING_PERIOD_NOT_ESTABLISHED',
    'GB_LLP_CONFIRMATION_REVIEW_PERIOD_NOT_ESTABLISHED',
    'GB_LLP_SA_REGISTRATION_NOT_ESTABLISHED',
    'GB_LLP_VAT_REGISTRATION_NOT_ESTABLISHED'
  ]);
  // The partnership pack's posture: the return schedules off the current tax
  // year even before the period fact lands (2026-08-01 sits in the year
  // ending 2027-04-05 → due 2028-01-31).
  assert.deepEqual(envelope.deadlines.find(({ key }) => key === 'partnership_return_online'), {
    key: 'partnership_return_online', label: 'Online SA800 partnership return (LLP)',
    due_date: '2028-01-31', terminal: 'scheduled'
  });
});

test('explicit LLP VAT non-registration omits VAT while preserving Companies House and SA800 rows', () => {
  const envelope = buildGbLlpStatutoryDeadlines({
    profile: { vat_registration: { status: 'not_registered' } }, asOf: '2026-08-01'
  });
  assert.deepEqual(envelope.deadlines.map(({ key }) => key), [
    'accounts', 'confirmation', 'partnership_return_online', 'partnership_registration'
  ]);
});
