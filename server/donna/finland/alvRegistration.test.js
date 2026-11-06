// FI-13 13.4 PR1 — the effective-dated ALV registration model (D-FI13-17).
// node --test server/donna/finland/alvRegistration.test.js

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ALV_REGISTRATION_STATUSES,
  ALV_REGISTRATION_BASES,
  ALV_TAX_PERIODS,
  normalizeAlvRegistrationProfile,
  resolveAlvRegistrationAsOf,
  alvInvoicingApplies
} from './alvRegistration.js';
import { validateAndNormaliseProfilePatch } from '../clientProfileSchema.js';

test('pins: the closed status / basis / tax-period vocabularies', () => {
  assert.deepEqual([...ALV_REGISTRATION_STATUSES], ['registered', 'not_registered', 'deregistered']);
  assert.deepEqual([...ALV_REGISTRATION_BASES], ['mandatory', 'voluntary', 'other']);
  assert.deepEqual([...ALV_TAX_PERIODS], ['month', 'quarter', 'year']);
});

test('normalizer: a full registered record round-trips, tax_period aliases canonicalise', () => {
  const out = normalizeAlvRegistrationProfile({
    status: 'Registered', registered_from: '2025-01-01', tax_period: 'monthly',
    registration_basis: 'mandatory', verified_at: '2025-01-15', verified_from: '2025-01-01',
    note: '  Vero decision 12/2024  '
  });
  assert.deepEqual(out, {
    status: 'registered', registered_from: '2025-01-01', verified_at: '2025-01-15',
    verified_from: '2025-01-01', tax_period: 'month', registration_basis: 'mandatory',
    note: 'Vero decision 12/2024'
  });
  assert.equal(normalizeAlvRegistrationProfile({ status: 'registered', registered_from: '2025-01-01', tax_period: 'neljännes' }).tax_period, 'quarter');
});

test('normalizer: null clears; wrong shapes and enum misses are 400s', () => {
  assert.equal(normalizeAlvRegistrationProfile(null), null);
  const rejects = (v, needle) => {
    try { normalizeAlvRegistrationProfile(v); assert.fail(`expected 400 for ${JSON.stringify(v)}`); }
    catch (e) { assert.equal(e.statusCode, 400); if (needle) assert.ok(String(e.message).includes(needle)); }
  };
  rejects([], 'object');
  rejects({}, 'status is required');
  rejects({ status: 'bogus' }, 'status must be');
  rejects({ status: 'registered' }, 'registered_from is required'); // registered needs a start
  rejects({ status: 'deregistered', registered_from: '2024-01-01' }, 'registered_until is required'); // dereg needs an end
  rejects({ status: 'registered', registered_from: 'not-a-date' }, 'ISO date');
  rejects({ status: 'registered', registered_from: '2025-01-01', registered_until: '2024-01-01' }, 'must not precede');
  rejects({ status: 'registered', registered_from: '2025-01-01', tax_period: 'fortnight' }, 'tax_period must be');
  rejects({ status: 'registered', registered_from: '2025-01-01', registration_basis: 'guessing' }, 'registration_basis must be');
});

test('resolveAsOf: an ongoing registration is active from its start date onward', () => {
  const reg = normalizeAlvRegistrationProfile({ status: 'registered', registered_from: '2025-01-01' });
  assert.equal(resolveAlvRegistrationAsOf({ registration: reg, asOf: '2024-12-31' }).registered, false);
  assert.equal(resolveAlvRegistrationAsOf({ registration: reg, asOf: '2025-01-01' }).registered, true); // inclusive start
  assert.equal(resolveAlvRegistrationAsOf({ registration: reg, asOf: '2030-06-01' }).registered, true);
});

test('resolveAsOf: a deregistered record is active only within its window (inclusive end)', () => {
  const reg = normalizeAlvRegistrationProfile({ status: 'deregistered', registered_from: '2023-01-01', registered_until: '2024-06-30' });
  assert.equal(resolveAlvRegistrationAsOf({ registration: reg, asOf: '2022-12-31' }).registered, false);
  assert.equal(resolveAlvRegistrationAsOf({ registration: reg, asOf: '2024-06-30' }).registered, true); // inclusive end
  assert.equal(resolveAlvRegistrationAsOf({ registration: reg, asOf: '2024-07-01' }).registered, false);
});

test('resolveAsOf: not_registered is never active; confirmedAgainstPrimary tracks verified_at', () => {
  assert.equal(resolveAlvRegistrationAsOf({ registration: { status: 'not_registered' }, asOf: '2025-06-01' }).registered, false);
  const unverified = normalizeAlvRegistrationProfile({ status: 'registered', registered_from: '2025-01-01' });
  assert.equal(resolveAlvRegistrationAsOf({ registration: unverified, asOf: '2025-06-01' }).confirmedAgainstPrimary, false);
  const verified = normalizeAlvRegistrationProfile({ status: 'registered', registered_from: '2025-01-01', verified_at: '2025-02-01' });
  assert.equal(resolveAlvRegistrationAsOf({ registration: verified, asOf: '2025-06-01' }).confirmedAgainstPrimary, true);
});

test('resolveAsOf is fail-safe: an absent or garbage record resolves to not-registered, never throws', () => {
  assert.equal(resolveAlvRegistrationAsOf({}).registered, false);
  assert.equal(resolveAlvRegistrationAsOf({ registration: null, asOf: null }).registered, false);
  assert.doesNotThrow(() => resolveAlvRegistrationAsOf({ registration: 'nope', asOf: 5 }));
  assert.equal(resolveAlvRegistrationAsOf({ registration: 'nope', asOf: '2025-06-01' }).registered, false);
  // A registered record read with no asOf date cannot be confirmed active.
  const reg = normalizeAlvRegistrationProfile({ status: 'registered', registered_from: '2025-01-01' });
  assert.equal(resolveAlvRegistrationAsOf({ registration: reg }).registered, false);
});

test('alvInvoicingApplies is form-INDEPENDENT and taxable-line-gated', () => {
  const reg = normalizeAlvRegistrationProfile({ status: 'registered', registered_from: '2025-01-01' });
  // No entity_type anywhere — the gate is registration + date + taxable line only.
  assert.equal(alvInvoicingApplies({ registration: reg, asOf: '2025-06-01' }), true);
  assert.equal(alvInvoicingApplies({ registration: reg, asOf: '2025-06-01', lineTaxable: false }), false);
  assert.equal(alvInvoicingApplies({ registration: reg, asOf: '2024-01-01' }), false); // before registration
  // Fail-safe: absent registration ⇒ false ⇒ the exempt path (byte-identical to today).
  assert.equal(alvInvoicingApplies({ asOf: '2025-06-01' }), false);
  assert.equal(alvInvoicingApplies({ registration: 'garbage', asOf: '2025-06-01' }), false);
});

test('profile schema: alv_registration is a known key routed through the normalizer', () => {
  const { patch, warnings } = validateAndNormaliseProfilePatch({
    alv_registration: { status: 'registered', registered_from: '2025-01-01', tax_period: 'quarter' }
  }, { jurisdiction: 'fi' });
  assert.deepEqual(patch.alv_registration, { status: 'registered', registered_from: '2025-01-01', tax_period: 'quarter' });
  assert.equal(warnings.length, 0); // a KNOWN key, not preserved-with-warning
  // A malformed write is a 400 at the schema boundary.
  assert.throws(() => validateAndNormaliseProfilePatch({ alv_registration: { status: 'nope' } }, { jurisdiction: 'fi' }), (e) => e.statusCode === 400);
  // null clears.
  assert.equal(validateAndNormaliseProfilePatch({ alv_registration: null }, { jurisdiction: 'fi' }).patch.alv_registration, null);
});
