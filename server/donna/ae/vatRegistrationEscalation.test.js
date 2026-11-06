// AE ae_vat_registration — the status watch's pure half: the closed
// skip/ask table, the re-ask window, the ask-id shape and the question copy.
//   node --test server/donna/ae/vatRegistrationEscalation.test.js

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  AE_VAT_ACTIVITY_EVIDENCE_KINDS,
  AE_VAT_REGISTRATION_ASK_OPEN_STATUSES,
  AE_VAT_REGISTRATION_REASK_DAYS,
  AE_VAT_REGISTRATION_STATUS_EVIDENCE_TYPE,
  aeVatRegistrationStatusAskId,
  buildAeVatRegistrationStatusQuestion,
  classifyAeVatRegistrationAsk,
  describeAeVatActivityEvidence,
  isoDayOf
} from './vatRegistrationEscalation.js';
import { resolveAeVatRegistrationOnDate } from './vatRegistration.js';
import { VAT_MANDATORY_REGISTRATION_THRESHOLD_AED } from './vatRegistrationThreshold.js';
import { AE_VAT_RETURN_DUE_DAYS } from './vatPeriods.js';

const AS_OF = '2026-09-01';
const resolve = (registration) => resolveAeVatRegistrationOnDate({ registration, onDate: AS_OF });
const EVIDENCE = [{ kind: 'vat_control_account_coding', ref: 'tx-1', on_date: '2026-04-28', amount: 1250, currency: 'AED', label: 'FTA VAT PAYMENT' }];

test('pins: evidence type, window, open statuses and evidence kinds are closed vocabularies', () => {
  assert.equal(AE_VAT_REGISTRATION_STATUS_EVIDENCE_TYPE, 'vat_registration_status');
  assert.equal(AE_VAT_REGISTRATION_REASK_DAYS, 90);
  assert.deepEqual([...AE_VAT_REGISTRATION_ASK_OPEN_STATUSES], ['draft', 'open', 'replied']);
  assert.deepEqual([...AE_VAT_ACTIVITY_EVIDENCE_KINDS],
    ['vat_control_account_coding', 'vat_control_account_posting', 'vat_bearing_sales_invoice']);
  assert.equal(aeVatRegistrationStatusAskId({ firmId: 'f', clientId: 'c', asOf: '2026-09-01T10:00:00Z' }),
    'vat-registration-status-f-c-2026-09-01');
});

test('unknown status asks — with or without activity — and the copy names the activity when there is any', () => {
  assert.deepEqual(classifyAeVatRegistrationAsk({ registration: resolve(null), asOf: AS_OF }),
    { action: 'ask', reason: 'status_unknown' });
  assert.deepEqual(classifyAeVatRegistrationAsk({ registration: resolve(null), evidence: EVIDENCE, asOf: AS_OF }),
    { action: 'ask', reason: 'status_unknown_with_activity' });
  const plain = buildAeVatRegistrationStatusQuestion({ reason: 'status_unknown' });
  assert.match(plain, /Are you registered for VAT with the FTA\?/);
  assert.match(plain, /15-digit VAT TRN/);
  assert.match(plain, /tax period the FTA assigned you in EmaraTax/);
  assert.match(plain, /cannot register on your behalf/);
  const withActivity = buildAeVatRegistrationStatusQuestion({ reason: 'status_unknown_with_activity', evidence: EVIDENCE });
  assert.match(withActivity, /a bank line coded to your VAT payable account on 2026-04-28 \(AED 1,250\.00\)/);
  assert.match(withActivity, /"FTA VAT PAYMENT"/);
});

test('the statutory numbers in the copy come from their provenance homes, never re-typed here', () => {
  const copy = buildAeVatRegistrationStatusQuestion({ reason: 'status_unknown' });
  assert.match(copy, new RegExp(`within ${AE_VAT_RETURN_DUE_DAYS} days of the period end`));
  const threshold = `AED ${VAT_MANDATORY_REGISTRATION_THRESHOLD_AED.toLocaleString('en-AE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  assert.ok(copy.includes(threshold), `copy must cite ${threshold}`);
  assert.equal(threshold, 'AED 375,000.00');
});

test('an open (or replied-but-unrecorded) ask dedupes; a recorded registration discharges', () => {
  for (const status of ['draft', 'open', 'replied']) {
    assert.deepEqual(classifyAeVatRegistrationAsk({ registration: resolve(null), latestAsk: { status }, evidence: EVIDENCE, asOf: AS_OF }),
      { action: 'skip', reason: 'ask_open' });
  }
  const registered = resolve({ status: 'registered', registered_from: '2026-01-01', vat_registration_number: '100123456789012' });
  assert.deepEqual(classifyAeVatRegistrationAsk({ registration: registered, evidence: EVIDENCE, asOf: AS_OF }),
    { action: 'skip', reason: 'registered' });
  const future = resolve({ status: 'registered', registered_from: '2026-12-01' });
  assert.deepEqual(classifyAeVatRegistrationAsk({ registration: future, asOf: AS_OF }),
    { action: 'skip', reason: 'recorded_not_yet_effective' });
  const deregistered = resolve({ status: 'registered', registered_from: '2024-01-01', registered_until: '2025-12-31' });
  assert.deepEqual(classifyAeVatRegistrationAsk({ registration: deregistered, evidence: EVIDENCE, asOf: AS_OF }),
    { action: 'skip', reason: 'recorded_deregistered' });
});

test('a "not registered" answer holds: silent without activity, silent inside the window, re-asked after it when the book contradicts it', () => {
  const notRegistered = resolve({ status: 'not_registered' });
  const answered = (resolvedOn) => ({ status: 'resolved', resolved_at: `${resolvedOn}T09:00:00Z` });
  // No activity: the threshold watch governs — never re-asked from here.
  assert.deepEqual(classifyAeVatRegistrationAsk({ registration: notRegistered, latestAsk: answered('2025-01-01'), asOf: AS_OF }),
    { action: 'skip', reason: 'not_registered_no_activity' });
  // Activity inside the window: the answer stands.
  assert.deepEqual(classifyAeVatRegistrationAsk({ registration: notRegistered, latestAsk: answered('2026-06-04'), evidence: EVIDENCE, asOf: AS_OF }),
    { action: 'skip', reason: 'answered_recently' }, '89 days');
  // The 90th day is the first day the window has elapsed.
  assert.deepEqual(classifyAeVatRegistrationAsk({ registration: notRegistered, latestAsk: answered('2026-06-03'), evidence: EVIDENCE, asOf: AS_OF }),
    { action: 'ask', reason: 'not_registered_but_vat_activity' }, '90 days');
  // A not-registered record with no ask history at all (recorded by an
  // operator) and activity: asked — nothing says the owner was ever asked.
  assert.deepEqual(classifyAeVatRegistrationAsk({ registration: notRegistered, evidence: EVIDENCE, asOf: AS_OF }),
    { action: 'ask', reason: 'not_registered_but_vat_activity' });
  const copy = buildAeVatRegistrationStatusQuestion({ reason: 'not_registered_but_vat_activity', evidence: EVIDENCE, answeredAt: '2026-06-03' });
  assert.match(copy, /You told me on 2026-06-03 that you are not VAT registered, but your books now show a bank line coded/);
  assert.match(copy, /Has that changed/);
});

test('a timestamptz Date from pg is read as the HOST\'s calendar day (the real-PG shape of resolved_at), on any zone', () => {
  const notRegistered = resolve({ status: 'not_registered' });
  const asDate = { status: 'resolved', resolved_at: new Date('2026-06-04T23:30:00Z') };
  assert.deepEqual(classifyAeVatRegistrationAsk({ registration: notRegistered, latestAsk: asDate, evidence: EVIDENCE, asOf: AS_OF }),
    { action: 'skip', reason: 'answered_recently' });
  // Local components, so the pin holds under TZ=Asia/Dubai as well as UTC.
  assert.equal(isoDayOf(new Date(2026, 5, 4, 23, 30)), '2026-06-04');
  assert.equal(isoDayOf('2026-06-04'), '2026-06-04');
  assert.equal(isoDayOf('garbage'), null);
  assert.equal(isoDayOf(null), null);
});

test('a resolved ask that left the status unknown still holds for the window', () => {
  const recent = { status: 'resolved', resolved_at: '2026-08-20T09:00:00Z' };
  assert.deepEqual(classifyAeVatRegistrationAsk({ registration: resolve(null), latestAsk: recent, asOf: AS_OF }),
    { action: 'skip', reason: 'answered_recently' });
  const stale = { status: 'resolved', resolved_at: '2026-05-01T09:00:00Z' };
  assert.deepEqual(classifyAeVatRegistrationAsk({ registration: resolve(null), latestAsk: stale, asOf: AS_OF }),
    { action: 'ask', reason: 'status_unknown' });
  // Cancelled history frees the question.
  assert.deepEqual(classifyAeVatRegistrationAsk({ registration: resolve(null), latestAsk: { status: 'cancelled', resolved_at: '2026-08-30' }, asOf: AS_OF }),
    { action: 'ask', reason: 'status_unknown' });
});

test('evidence descriptions cover every kind and never invent an amount', () => {
  const lines = describeAeVatActivityEvidence([
    { kind: 'vat_control_account_coding', on_date: '2026-04-28', amount: '1250.00', currency: 'AED', label: 'FTA' },
    { kind: 'vat_control_account_posting', on_date: '2026-05-01', amount: 300, currency: 'AED' },
    { kind: 'vat_bearing_sales_invoice', on_date: '2026-05-03', amount: 50, currency: 'AED', label: 'INV-1042' },
    { kind: 'vat_bearing_sales_invoice', on_date: null, amount: null, currency: null }
  ]);
  assert.equal(lines[0], 'a bank line coded to your VAT payable account on 2026-04-28 (AED 1,250.00) — "FTA"');
  assert.equal(lines[1], 'a posted journal on your VAT payable account on 2026-05-01 (AED 300.00)');
  assert.equal(lines[2], 'a sales invoice carrying VAT (INV-1042) on 2026-05-03, VAT AED 50.00');
  assert.equal(lines[3], 'a sales invoice carrying VAT');
  assert.throws(() => classifyAeVatRegistrationAsk({ registration: resolve(null), asOf: 'nope' }), /ISO asOf/);
});
