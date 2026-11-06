import test from 'node:test';
import assert from 'node:assert/strict';
import { adoptedProfileMatches, ownerAdoptedProfileDigest, ownerAdoptedAdmissionDigest,
  OWNER_ADOPTION_ADMISSION_DIGEST_VERSION } from './existingOwnerRevalidation.js';

const target = { company_name: 'Synthetic Oy', jurisdiction: 'FI', entity_type: 'fi-oy',
  profile: { uen: '9999999-2', accountingBasis: 'accrual', accountingCurrency: 'EUR',
    alv_registration: { status: 'registered', registered_from: '2025-01-01', tax_period: 'month' } } };
const legacy = { adopted_profile_digest: ownerAdoptedProfileDigest(target) };
const current = { ...legacy, adopted_admission_digest_version: OWNER_ADOPTION_ADMISSION_DIGEST_VERSION,
  adopted_admission_digest: ownerAdoptedAdmissionDigest(target) };

test('only the three server-owned jurisdiction observations leave new admission unchanged', () => {
  for (const key of ['jurisdiction_detected', 'jurisdiction_detected_confidence', 'jurisdiction_signals']) {
    const changed = { ...target, profile: { ...target.profile, [key]: { arbitrary_observation: 'value' } } };
    assert.equal(adoptedProfileMatches(current, changed), true, key);
    assert.equal(adoptedProfileMatches(legacy, changed), false, 'legacy remains exact: '+key);
  }
  for (const key of ['companyName', 'businessId', 'uen', 'jurisdiction', 'entity_type', 'incorporation_date',
    'accountingBasis', 'accountingCurrency', 'accounting_system', 'accounting_view', 'cutover_date',
    'opening_balances', 'alv_registration', 'businessDescription', 'unknown_future_fact']) {
    assert.equal(adoptedProfileMatches(current, { ...target, profile: { ...target.profile, [key]: 'changed' } }), false, key);
  }
  for (const key of ['company_name', 'jurisdiction', 'entity_type']) {
    assert.equal(adoptedProfileMatches(current, { ...target, [key]: 'changed' }), false, key);
  }
  assert.deepEqual(legacy, { adopted_profile_digest: ownerAdoptedProfileDigest(target) });
});

test('fingerprint version is explicit, fail closed, and never inferred from a digest', () => {
  assert.equal(adoptedProfileMatches(legacy, target), true);
  assert.equal(adoptedProfileMatches(current, target), true);
  assert.equal(adoptedProfileMatches({ ...current, adopted_admission_digest: undefined }, target), false);
  for (const version of [null, '', 'future', 1, {}]) {
    assert.equal(adoptedProfileMatches({ ...current, adopted_admission_digest_version: version }, target), false);
  }
  const derived = { ...target, profile: { ...target.profile, jurisdiction_detected: 'gb' } };
  assert.equal(adoptedProfileMatches({ ...current, adopted_admission_digest_version: undefined }, derived), false);
  assert.equal(adoptedProfileMatches({ ...legacy, adopted_admission_digest: ownerAdoptedAdmissionDigest(derived) }, derived), false);
  assert.equal(adoptedProfileMatches(current, { ...target, profile: Object.fromEntries(Object.entries(target.profile).reverse()) }), true);
});
