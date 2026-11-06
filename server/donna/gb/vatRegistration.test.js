import test from 'node:test';
import assert from 'node:assert/strict';

import {
  GB_VAT_REGISTRATION_STATUSES,
  GB_VAT_REGISTRATION_BASES,
  GB_VAT_RETURN_PERIODS,
  normalizeGbVatRegistration,
  resolveGbVatRegistrationOnDate,
  gbVatReturnCadenceForProfile
} from './vatRegistration.js';

// ── The normalizer (write boundary) ─────────────────────────────────────────

test('a registered record normalizes to the canonical stored shape', () => {
  const out = normalizeGbVatRegistration({
    status: 'REGISTERED',
    registered_from: '2025-04-01T00:00:00Z',
    vat_registration_number: 'gb 123 4567 89',
    registration_basis: 'Mandatory',
    vat_return_period: 'quarterly',
    verified_from: 'HMRC VAT4 certificate',
    verified_at: '2026-07-27'
  });
  assert.deepEqual(out, {
    status: 'registered',
    registered_from: '2025-04-01',
    registered_until: null,
    vat_registration_number: 'GB 123 4567 89',
    registration_basis: 'mandatory',
    vat_return_period: 'quarter',
    verified_from: 'HMRC VAT4 certificate',
    verified_at: '2026-07-27'
  });
});

test('the closed vocabularies are refused at the boundary, not coerced', () => {
  assert.throws(() => normalizeGbVatRegistration({ status: 'pending' }), /status must be one of/);
  assert.throws(() => normalizeGbVatRegistration(null), /must be an object/);
  assert.throws(() => normalizeGbVatRegistration([]), /must be an object/);
  // An unrecognised BASIS is not statutory — it degrades to the 'other' escape
  // rather than refusing the whole record.
  assert.equal(
    normalizeGbVatRegistration({ status: 'not_registered', registration_basis: 'because' }).registration_basis,
    'other'
  );
  // An unrecognised PERIOD does not degrade — a guessed filing cadence is a
  // guessed deadline, so it drops to null and a caller must ask.
  assert.equal(
    normalizeGbVatRegistration({ status: 'not_registered', vat_return_period: 'fortnightly' }).vat_return_period,
    null
  );
});

test('an effective-dated status requires its date', () => {
  assert.throws(() => normalizeGbVatRegistration({ status: 'registered' }), /registered_from/);
  assert.throws(
    () => normalizeGbVatRegistration({ status: 'deregistered', registered_from: '2025-01-01' }),
    /registered_until/
  );
  assert.throws(
    () => normalizeGbVatRegistration({
      status: 'deregistered', registered_from: '2025-06-01', registered_until: '2025-01-01'
    }),
    /must not precede/
  );
});

test('a registered record does NOT require a VAT number — HMRC issues it after the effective date', () => {
  const out = normalizeGbVatRegistration({ status: 'registered', registered_from: '2026-07-01' });
  assert.equal(out.status, 'registered');
  assert.equal(out.vat_registration_number, null);
  // The gap is not swallowed: it surfaces downstream as the conditional floor's
  // named refusal, not as a normalizer that forced the owner to misstate status.
});

test('a structurally invalid VAT number is refused; all four real forms are accepted', () => {
  assert.throws(
    () => normalizeGbVatRegistration({ status: 'registered', registered_from: '2025-01-01', vat_registration_number: '12345' }),
    /not a structurally valid UK VAT number/
  );
  for (const number of ['123456789', 'GB123456789', '123456789012', 'GBGD001', 'GBHA999']) {
    assert.equal(
      normalizeGbVatRegistration({ status: 'registered', registered_from: '2025-01-01', vat_registration_number: number })
        .vat_registration_number,
      number.toUpperCase(),
      `expected ${number} to be accepted`
    );
  }
});

test('a not_registered record may not carry a VAT number — it is the field the pack FORBIDS', () => {
  assert.throws(
    () => normalizeGbVatRegistration({ status: 'not_registered', vat_registration_number: 'GB123456789' }),
    /must be absent on a not_registered record/
  );
});

// ── The resolver (read side) — the tri-state that gap 9 needs ───────────────

test('UNKNOWN, not false: an absent record does not answer the question', () => {
  const out = resolveGbVatRegistrationOnDate({ registration: null, onDate: '2026-07-27' });
  assert.equal(out.registered, null, 'absence is ignorance, never a "no"');
  assert.equal(out.reason, 'no_record');
  assert.equal(out.registrationId, null);
});

test('every unusable shape resolves UNKNOWN rather than defaulting', () => {
  const at = '2026-07-27';
  assert.equal(resolveGbVatRegistrationOnDate({ registration: 'garbage', onDate: at }).reason, 'unusable_record');
  assert.equal(resolveGbVatRegistrationOnDate({ registration: [], onDate: at }).reason, 'unusable_record');
  assert.equal(resolveGbVatRegistrationOnDate({ registration: { status: 'pending' }, onDate: at }).reason, 'unrecognised_status');
  // A hand-edited blob the normalizer would have refused: dated status, no date.
  assert.equal(
    resolveGbVatRegistrationOnDate({ registration: { status: 'registered' }, onDate: at }).reason,
    'no_effective_date'
  );
  for (const registration of ['garbage', [], { status: 'pending' }, { status: 'registered' }]) {
    assert.equal(resolveGbVatRegistrationOnDate({ registration, onDate: at }).registered, null);
  }
});

test('only a RECORDED negative produces false', () => {
  const at = '2026-07-27';
  assert.equal(resolveGbVatRegistrationOnDate({ registration: { status: 'not_registered' }, onDate: at }).registered, false);
  assert.equal(
    resolveGbVatRegistrationOnDate({ registration: { status: 'registered', registered_from: '2026-09-01' }, onDate: at }).reason,
    'not_yet_effective'
  );
  assert.equal(
    resolveGbVatRegistrationOnDate({
      registration: { status: 'deregistered', registered_from: '2024-01-01', registered_until: '2026-01-31' },
      onDate: at
    }).registered,
    false
  );
});

test('an effective registration resolves true and carries its number and verification', () => {
  const registration = {
    status: 'registered',
    registered_from: '2025-04-01',
    vat_registration_number: 'GB 123 4567 89',
    verified_at: '2026-07-27'
  };
  const out = resolveGbVatRegistrationOnDate({ registration, onDate: '2026-07-27' });
  assert.equal(out.registered, true);
  assert.equal(out.reason, 'registered');
  assert.equal(out.registrationId, 'GB 123 4567 89');
  assert.equal(out.confirmedAgainstPrimary, true);
  assert.equal(out.asOf, '2026-07-27');
});

test('an unverified registration still resolves, flagged', () => {
  const out = resolveGbVatRegistrationOnDate({
    registration: { status: 'registered', registered_from: '2025-04-01' },
    onDate: '2026-07-27'
  });
  assert.equal(out.registered, true);
  assert.equal(out.confirmedAgainstPrimary, false, 'honoured, but never claimed as primary-confirmed');
});

test('the VAT number is NEVER surfaced on a negative resolution', () => {
  // The GB pack FORBIDS seller_tax_registration_id when the seller is not
  // registered, so handing a stale number to the seller context would refuse the
  // very invoice this resolution says is issuable.
  const deregistered = {
    status: 'deregistered',
    registered_from: '2024-01-01',
    registered_until: '2026-01-31',
    vat_registration_number: 'GB123456789'
  };
  const out = resolveGbVatRegistrationOnDate({ registration: deregistered, onDate: '2026-07-27' });
  assert.equal(out.registered, false);
  assert.equal(out.registrationId, null);
});

test('a missing onDate is a caller bug, not a data state', () => {
  assert.throws(() => resolveGbVatRegistrationOnDate({ registration: null }), /requires an onDate/);
});

// ── Cadence ────────────────────────────────────────────────────────────────

test('the VAT return cadence is read, never defaulted', () => {
  assert.equal(gbVatReturnCadenceForProfile({}), null, 'HMRC assigns the stagger — we do not guess it');
  assert.equal(gbVatReturnCadenceForProfile({ vat_registration: { vat_return_period: 'monthly' } }), 'month');
  assert.equal(gbVatReturnCadenceForProfile({ vat_registration: { vat_return_period: 'annual' } }), 'year');
  assert.equal(gbVatReturnCadenceForProfile({ vat_registration: 'garbage' }), null);
});

test('the exported vocabularies stay closed', () => {
  assert.deepEqual([...GB_VAT_REGISTRATION_STATUSES], ['registered', 'not_registered', 'deregistered']);
  assert.deepEqual([...GB_VAT_REGISTRATION_BASES], ['mandatory', 'voluntary', 'other']);
  assert.deepEqual([...GB_VAT_RETURN_PERIODS], ['month', 'quarter', 'year']);
});
