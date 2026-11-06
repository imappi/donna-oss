import assert from 'node:assert/strict';
import test from 'node:test';
import { validateAndNormaliseProfilePatch } from './clientProfileSchema.js';
import { PROFILE_VALIDATION_REGISTRY, createProfileValidationRegistry } from './profileValidationRegistry.js';

const check = (patch, jurisdiction, code) => assert.throws(
  () => validateAndNormaliseProfilePatch(patch, { jurisdiction }),
  (error) => error.statusCode === 400 && error.code === code
);

test('registered profile countries preserve independent tax facts, legal form, and general forward-compatible fields', () => {
  assert.deepEqual(Object.keys(PROFILE_VALIDATION_REGISTRY.countries).sort(), ['ae', 'au', 'fi', 'gb', 'sg', 'us']);
  for (const jurisdiction of Object.keys(PROFILE_VALIDATION_REGISTRY.countries)) {
    const { patch, warnings } = validateAndNormaliseProfilePatch({ companyName: ' Test ', future_field: { retained: true } }, { jurisdiction });
    assert.deepEqual(patch, { companyName: 'Test', future_field: { retained: true } });
    assert.deepEqual(warnings, ['Unknown profile key preserved: future_field.']);
    assert.ok(!Object.hasOwn(patch, 'entity_type'));
    assert.ok(!Object.keys(patch).some((key) => key.endsWith('_registration')));
  }
  for (const jurisdiction of ['us', 'au']) {
    check({ vat_registration: { status: 'not_registered' } }, jurisdiction, 'profile_field_unsupported');
    check({ gst_registration: { status: 'not_registered' } }, jurisdiction, 'profile_field_unsupported');
  }
});

test('every country-owned non-null key requires its registered owner; null clears choose no country', () => {
  for (const key of PROFILE_VALIDATION_REGISTRY.fields) {
    check({ [key]: {} }, null, 'profile_jurisdiction_unresolved');
    check({ [key]: {} }, 'unknown', 'profile_jurisdiction_unresolved');
    check({ [key]: {} }, 'zz', 'profile_jurisdiction_unsupported');
    for (const jurisdiction of [null, 'zz', 'us', 'ae', 'fi', 'gb', 'sg', 'au']) {
      assert.deepEqual(validateAndNormaliseProfilePatch({ [key]: null }, { jurisdiction }).patch, { [key]: null });
    }
  }
  assert.deepEqual(validateAndNormaliseProfilePatch({ future_key: 1 }, { jurisdiction: 'zz' }).patch, { future_key: 1 });
  check({ vat_registration: { status: 'not_registered' } }, 'sg', 'profile_field_unsupported');
});

test('profile context uses canonical aliases and explicit patch country; missing never selects GB VAT', () => {
  const value = { status: 'not_registered' };
  assert.deepEqual(validateAndNormaliseProfilePatch({ vat_registration: value }, { jurisdiction: ' UK ' }).patch, validateAndNormaliseProfilePatch({ vat_registration: value }, { jurisdiction: 'gb' }).patch);
  assert.equal(validateAndNormaliseProfilePatch({ jurisdiction: 'AE', vat_registration: value }, { jurisdiction: 'gb' }).patch.vat_registration.status, 'not_registered');
  check({ vat_registration: value }, null, 'profile_jurisdiction_unresolved');
  check({ jurisdiction: null, vat_registration: value }, 'gb', 'profile_jurisdiction_unresolved');
});

test('a newly registered country owns shared and new fields without changes to the schema algorithm', () => {
  const calls = [];
  const registry = createProfileValidationRegistry({
    ...PROFILE_VALIDATION_REGISTRY.countries,
    nz: {
      gst_registration: (value, _warnings, { jurisdiction }) => { calls.push(jurisdiction); return { ...value, fixture: 'nz' }; },
      nz_filing_fact: (value) => value.trim()
    }
  });
  const actual = validateAndNormaliseProfilePatch({
    jurisdiction: 'NZ', gst_registration: { status: 'not_registered' }, nz_filing_fact: ' recorded '
  }, { registry });
  assert.deepEqual(actual.patch, { jurisdiction: 'nz', gst_registration: { status: 'not_registered', fixture: 'nz' }, nz_filing_fact: 'recorded' });
  assert.deepEqual(calls, ['nz']);
  assert.deepEqual(actual.warnings, []);
  assert.throws(() => validateAndNormaliseProfilePatch({ nz_filing_fact: 'x' }, { jurisdiction: 'au', registry }), (error) => error.code === 'profile_field_unsupported');
  assert.ok(!Object.hasOwn(PROFILE_VALIDATION_REGISTRY.countries, 'nz'), 'test registration cannot change runtime defaults');
});
