// AE — the effective-dated corporate-tax registration record.
//   node --test server/donna/ae/ctRegistration.test.js
//
// Sibling of ae/vatRegistration.test.js. The load-bearing property is the
// TRI-STATE read side: the CT registry duty means "unknown" must drive an
// owner ask — only a RECORDED status may ever produce `false`, and absence
// must never quietly assert (or discharge) an open statutory duty.

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  AE_CT_REGISTRATION_STATUSES,
  AE_CT_TRN_SHAPE_PROVENANCE,
  isValidAeCtTrn,
  normalizeAeCtRegistration,
  resolveAeCtRegistrationOnDate
} from './ctRegistration.js';

// ── The TRN structural check ────────────────────────────────────────────────

test('isValidAeCtTrn: the shared 15-digit FTA shape, tolerant of spaces and hyphens', () => {
  assert.equal(isValidAeCtTrn('100987654321098'), true);
  assert.equal(isValidAeCtTrn('100 9876 5432 1098'), true);
  assert.equal(isValidAeCtTrn('100-9876-5432-1098'), true);
  assert.equal(isValidAeCtTrn('10098765432109'), false);   // 14 digits
  assert.equal(isValidAeCtTrn('1009876543210987'), false); // 16 digits
  assert.equal(isValidAeCtTrn('GB123456789'), false);
  assert.equal(isValidAeCtTrn(''), false);
  assert.equal(isValidAeCtTrn(null), false);
});

test('the TRN-shape claim carries VERIFY provenance — corroborated, not primary-confirmed', () => {
  assert.equal(AE_CT_TRN_SHAPE_PROVENANCE.confirmedAgainstPrimary, false);
  assert.equal(AE_CT_TRN_SHAPE_PROVENANCE.asOf, '2026-08-30');
  assert.ok(Object.isFrozen(AE_CT_TRN_SHAPE_PROVENANCE));
});

// ── The write-boundary normalizer ───────────────────────────────────────────

test('a registered record normalizes: status, dates, TRN as supplied, provenance', () => {
  const record = normalizeAeCtRegistration({
    status: 'Registered',
    registered_from: '2026-06-01',
    ct_registration_number: '100 9876 5432 1098',
    verified_from: 'FTA corporate tax registration certificate',
    verified_at: '2026-07-01'
  });
  assert.equal(record.status, 'registered');
  assert.equal(record.registered_from, '2026-06-01');
  assert.equal(record.ct_registration_number, '100 9876 5432 1098');
  assert.equal(record.verified_from, 'FTA corporate tax registration certificate');
  assert.equal(record.verified_at, '2026-07-01');
});

test('a registered record without a TRN is accepted — the FTA issues the number on approval', () => {
  const record = normalizeAeCtRegistration({ status: 'registered', registered_from: '2026-06-01' });
  assert.equal(record.ct_registration_number, null);
});

test('a structurally invalid TRN refuses with the typed 400', () => {
  assert.throws(
    () => normalizeAeCtRegistration({
      status: 'registered', registered_from: '2026-06-01', ct_registration_number: 'GB123456789'
    }),
    (e) => e.statusCode === 400 && e.code === 'AE_CT_REGISTRATION_INVALID'
  );
});

test('a not_registered record must not carry a CT TRN — the pair is a contradiction', () => {
  assert.throws(
    () => normalizeAeCtRegistration({ status: 'not_registered', ct_registration_number: '100987654321098' }),
    /must be absent on a not_registered record/
  );
  const record = normalizeAeCtRegistration({ status: 'not_registered' });
  assert.equal(record.status, 'not_registered');
});

test('shape refusals: missing effective dates, inverted range, unknown status, non-object', () => {
  assert.throws(() => normalizeAeCtRegistration({ status: 'registered' }), /registered_from/);
  assert.throws(() => normalizeAeCtRegistration({ status: 'deregistered' }), /registered_until/);
  assert.throws(
    () => normalizeAeCtRegistration({
      status: 'deregistered', registered_from: '2026-06-01', registered_until: '2026-01-01'
    }),
    /must not precede/
  );
  assert.throws(() => normalizeAeCtRegistration({ status: 'vibes' }), /status must be one of/);
  assert.throws(() => normalizeAeCtRegistration(null), /must be an object/);
  assert.throws(() => normalizeAeCtRegistration([]), /must be an object/);
});

test('closed status vocabulary — and no basis or cadence fields invented for CT', () => {
  assert.deepEqual([...AE_CT_REGISTRATION_STATUSES], ['registered', 'not_registered', 'deregistered']);
  const record = normalizeAeCtRegistration({
    status: 'registered',
    registered_from: '2026-06-01',
    registration_basis: 'voluntary',
    ct_return_period: 'year'
  });
  assert.equal('registration_basis' in record, false, 'CT has no voluntary limb — no basis field');
  assert.equal('ct_return_period' in record, false, 'the return clock is the return duty\'s, not the registration\'s');
});

// ── The tri-state resolver ──────────────────────────────────────────────────

test('no record is UNKNOWN — absence neither asserts nor discharges the duty', () => {
  const r = resolveAeCtRegistrationOnDate({ registration: null, onDate: '2026-08-30' });
  assert.equal(r.registered, null);
  assert.equal(r.reason, 'no_record');
});

test('a recorded not_registered is a real FALSE, and carries no TRN', () => {
  const r = resolveAeCtRegistrationOnDate({
    registration: { status: 'not_registered' }, onDate: '2026-08-30'
  });
  assert.equal(r.registered, false);
  assert.equal(r.reason, 'not_registered');
  assert.equal(r.registrationId, null);
});

test('an effective registration resolves TRUE with its TRN and verification state', () => {
  const r = resolveAeCtRegistrationOnDate({
    registration: {
      status: 'registered',
      registered_from: '2026-06-01',
      ct_registration_number: '100 9876 5432 1098',
      verified_at: '2026-07-01'
    },
    onDate: '2026-08-30'
  });
  assert.equal(r.registered, true);
  assert.equal(r.reason, 'registered');
  assert.equal(r.registrationId, '100 9876 5432 1098');
  assert.equal(r.confirmedAgainstPrimary, true);
});

test('a registration not yet effective on the date resolves FALSE, and surfaces no TRN', () => {
  const r = resolveAeCtRegistrationOnDate({
    registration: {
      status: 'registered', registered_from: '2026-10-01', ct_registration_number: '100987654321098'
    },
    onDate: '2026-08-30'
  });
  assert.equal(r.registered, false);
  assert.equal(r.reason, 'not_yet_effective');
  assert.equal(r.registrationId, null);
});

test('a deregistered record resolves FALSE after registered_until, TRUE inside the window', () => {
  const registration = {
    status: 'deregistered', registered_from: '2025-01-01', registered_until: '2026-06-30'
  };
  assert.equal(resolveAeCtRegistrationOnDate({ registration, onDate: '2026-08-30' }).registered, false);
  assert.equal(resolveAeCtRegistrationOnDate({ registration, onDate: '2026-08-30' }).reason, 'deregistered');
  assert.equal(resolveAeCtRegistrationOnDate({ registration, onDate: '2026-03-01' }).registered, true);
});

test('an incomplete or unrecognisable record is UNKNOWN, not a negative', () => {
  assert.equal(
    resolveAeCtRegistrationOnDate({ registration: { status: 'registered' }, onDate: '2026-08-30' }).reason,
    'no_effective_date'
  );
  assert.equal(
    resolveAeCtRegistrationOnDate({ registration: { status: 'vibes' }, onDate: '2026-08-30' }).reason,
    'unrecognised_status'
  );
  assert.equal(
    resolveAeCtRegistrationOnDate({ registration: 'garbage', onDate: '2026-08-30' }).reason,
    'unusable_record'
  );
});

test('the resolver throws only on a missing onDate — a caller bug, not a data state', () => {
  assert.throws(() => resolveAeCtRegistrationOnDate({ registration: null }), /requires an onDate/);
});
