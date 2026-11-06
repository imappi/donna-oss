// AE — the effective-dated VAT registration record.
//   node --test server/donna/ae/vatRegistration.test.js
//
// Sibling of gb/vatRegistration.test.js. The load-bearing property is the
// TRI-STATE read side: the AE pack declares a conditional invoice floor, so
// only a RECORDED status may ever produce `false` — absence is UNKNOWN and
// refuses downstream by name, never a quiet "not registered".

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  AE_VAT_REGISTRATION_STATUSES,
  AE_VAT_REGISTRATION_BASES,
  AE_VAT_RETURN_PERIODS,
  isValidAeTrn,
  normalizeAeVatRegistration,
  resolveAeVatRegistrationOnDate,
  aeVatReturnCadenceForProfile
} from './vatRegistration.js';

// ── The TRN structural check ────────────────────────────────────────────────

test('isValidAeTrn: 15 digits, tolerant of spaces and hyphens, nothing else', () => {
  assert.equal(isValidAeTrn('100123456789012'), true);
  assert.equal(isValidAeTrn('100 1234 5678 9012'), true);
  assert.equal(isValidAeTrn('100-1234-5678-9012'), true);
  assert.equal(isValidAeTrn('10012345678901'), false);   // 14 digits
  assert.equal(isValidAeTrn('1001234567890123'), false); // 16 digits
  assert.equal(isValidAeTrn('GB123456789'), false);       // a UK VAT number is not a TRN
  assert.equal(isValidAeTrn(''), false);
  assert.equal(isValidAeTrn(null), false);
});

// ── The write-boundary normalizer ───────────────────────────────────────────

test('a registered record normalizes: status, dates, TRN as supplied, basis, period alias', () => {
  const record = normalizeAeVatRegistration({
    status: 'Registered',
    registered_from: '2026-01-01',
    vat_registration_number: '100 1234 5678 9012',
    registration_basis: 'Mandatory',
    vat_return_period: 'quarterly',
    verified_from: 'FTA VAT registration certificate',
    verified_at: '2026-02-01'
  });
  assert.equal(record.status, 'registered');
  assert.equal(record.registered_from, '2026-01-01');
  assert.equal(record.vat_registration_number, '100 1234 5678 9012');
  assert.equal(record.registration_basis, 'mandatory');
  assert.equal(record.vat_return_period, 'quarter');
  assert.equal(record.verified_at, '2026-02-01');
});

test('a registered record without a TRN is accepted — the FTA issues the number after approval', () => {
  const record = normalizeAeVatRegistration({ status: 'registered', registered_from: '2026-01-01' });
  assert.equal(record.vat_registration_number, null);
});

test('a structurally invalid TRN refuses with the typed 400', () => {
  assert.throws(
    () => normalizeAeVatRegistration({
      status: 'registered', registered_from: '2026-01-01', vat_registration_number: 'GB123456789'
    }),
    (e) => e.statusCode === 400 && e.code === 'AE_VAT_REGISTRATION_INVALID'
  );
});

test('a not_registered record must not carry a TRN — it is the field the floor forbids', () => {
  assert.throws(
    () => normalizeAeVatRegistration({ status: 'not_registered', vat_registration_number: '100123456789012' }),
    /must be absent on a not_registered record/
  );
  const record = normalizeAeVatRegistration({ status: 'not_registered' });
  assert.equal(record.status, 'not_registered');
});

test('shape refusals: missing effective dates, inverted range, unknown status, non-object', () => {
  assert.throws(() => normalizeAeVatRegistration({ status: 'registered' }), /registered_from/);
  assert.throws(() => normalizeAeVatRegistration({ status: 'deregistered' }), /registered_until/);
  assert.throws(
    () => normalizeAeVatRegistration({
      status: 'deregistered', registered_from: '2026-06-01', registered_until: '2026-01-01'
    }),
    /must not precede/
  );
  assert.throws(() => normalizeAeVatRegistration({ status: 'vibes' }), /status must be one of/);
  assert.throws(() => normalizeAeVatRegistration(null), /must be an object/);
  assert.throws(() => normalizeAeVatRegistration([]), /must be an object/);
});

test('closed vocabularies: no annual scheme in the UAE, so no year period', () => {
  assert.deepEqual([...AE_VAT_REGISTRATION_STATUSES], ['registered', 'not_registered', 'deregistered']);
  assert.deepEqual([...AE_VAT_REGISTRATION_BASES], ['mandatory', 'voluntary', 'other']);
  assert.deepEqual([...AE_VAT_RETURN_PERIODS], ['month', 'quarter']);
  const record = normalizeAeVatRegistration({
    status: 'registered', registered_from: '2026-01-01', vat_return_period: 'annual'
  });
  assert.equal(record.vat_return_period, null, 'an unknown period stores null, never a guessed cadence');
});

// ── The tri-state resolver ──────────────────────────────────────────────────

test('no record is UNKNOWN — never a quiet not-registered', () => {
  const r = resolveAeVatRegistrationOnDate({ registration: null, onDate: '2026-08-30' });
  assert.equal(r.registered, null);
  assert.equal(r.reason, 'no_record');
});

test('a recorded not_registered is a real FALSE, and carries no TRN', () => {
  const r = resolveAeVatRegistrationOnDate({
    registration: { status: 'not_registered' }, onDate: '2026-08-30'
  });
  assert.equal(r.registered, false);
  assert.equal(r.reason, 'not_registered');
  assert.equal(r.registrationId, null);
});

test('an effective registration resolves TRUE with its TRN and verification state', () => {
  const r = resolveAeVatRegistrationOnDate({
    registration: {
      status: 'registered',
      registered_from: '2026-01-01',
      vat_registration_number: '100 1234 5678 9012',
      verified_at: '2026-02-01'
    },
    onDate: '2026-08-30'
  });
  assert.equal(r.registered, true);
  assert.equal(r.reason, 'registered');
  assert.equal(r.registrationId, '100 1234 5678 9012');
  assert.equal(r.confirmedAgainstPrimary, true);
});

test('a registration not yet effective on the date resolves FALSE, and surfaces no TRN', () => {
  const r = resolveAeVatRegistrationOnDate({
    registration: {
      status: 'registered', registered_from: '2026-10-01', vat_registration_number: '100123456789012'
    },
    onDate: '2026-08-30'
  });
  assert.equal(r.registered, false);
  assert.equal(r.reason, 'not_yet_effective');
  assert.equal(r.registrationId, null);
});

test('a deregistered record resolves FALSE after registered_until, TRUE inside the window', () => {
  const registration = {
    status: 'deregistered', registered_from: '2024-01-01', registered_until: '2026-06-30'
  };
  assert.equal(resolveAeVatRegistrationOnDate({ registration, onDate: '2026-08-30' }).registered, false);
  assert.equal(resolveAeVatRegistrationOnDate({ registration, onDate: '2026-08-30' }).reason, 'deregistered');
  assert.equal(resolveAeVatRegistrationOnDate({ registration, onDate: '2026-03-01' }).registered, true);
});

test('an incomplete or unrecognisable record is UNKNOWN, not a negative', () => {
  assert.equal(
    resolveAeVatRegistrationOnDate({ registration: { status: 'registered' }, onDate: '2026-08-30' }).reason,
    'no_effective_date'
  );
  assert.equal(
    resolveAeVatRegistrationOnDate({ registration: { status: 'vibes' }, onDate: '2026-08-30' }).reason,
    'unrecognised_status'
  );
  assert.equal(
    resolveAeVatRegistrationOnDate({ registration: 'garbage', onDate: '2026-08-30' }).reason,
    'unusable_record'
  );
});

test('the resolver throws only on a missing onDate — a caller bug, not a data state', () => {
  assert.throws(() => resolveAeVatRegistrationOnDate({ registration: null }), /requires an onDate/);
});

// ── The cadence reader ──────────────────────────────────────────────────────

test('aeVatReturnCadenceForProfile reads the assigned period and never defaults one', () => {
  assert.equal(aeVatReturnCadenceForProfile({ vat_registration: { vat_return_period: 'quarter' } }), 'quarter');
  assert.equal(aeVatReturnCadenceForProfile({ vat_registration: { vat_return_period: 'monthly' } }), 'month');
  assert.equal(aeVatReturnCadenceForProfile({ vat_registration: {} }), null);
  assert.equal(aeVatReturnCadenceForProfile({}), null);
});
