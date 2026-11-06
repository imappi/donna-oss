// GB entity resolver (gap 6 — the entity-type leg).
//   node --test server/donna/gb/entity.test.js
//
// The drift pin against src/lib/clientAxes.js is the load-bearing test here:
// gap 6 is a SYNC-DISCIPLINE problem, so the test that matters is the one that
// fails when the two vocabularies diverge.

import assert from 'node:assert/strict';
import test from 'node:test';

import { ENTITY_TYPES_BY_JURISDICTION } from '../../../src/lib/clientAxes.js';
import {
  GB_CONSTITUENT_COUNTRIES,
  GB_ENTITY_FAIL_CLOSED_FLAG_KEY,
  GB_ENTITY_TYPES,
  GB_INCORPORATED_AXES,
  GB_UNINCORPORATED_AXES,
  assertGbConstituentCountryResolved,
  assertGbCorporationTaxOnly,
  assertGbEntityOnly,
  assertGbIncorporatedOnly,
  assertGbSelfAssessmentOnly,
  assertGbSoleTraderOnly,
  gbConstituentCountry,
  gbEntityType,
  isValidCompanyNumber,
  isValidGbVatNumber
} from './entity.js';

test('the persisted vocabulary does not drift from clientAxes', () => {
  assert.deepEqual([...GB_ENTITY_TYPES].sort(), [...ENTITY_TYPES_BY_JURISDICTION.gb].sort());
});

test('every declared legal form resolves to an axis', () => {
  for (const type of GB_ENTITY_TYPES) {
    assert.ok(gbEntityType({ entity_type: type }), `${type} must resolve`);
  }
  // The axes partition cleanly into incorporated / unincorporated.
  const axes = GB_ENTITY_TYPES.map((t) => gbEntityType({ entity_type: t })).sort();
  assert.deepEqual(axes, [...GB_INCORPORATED_AXES, ...GB_UNINCORPORATED_AXES].sort());
});

test('reads either the top-level column or the profile blob', () => {
  assert.equal(gbEntityType({ entity_type: 'gb-ltd' }), 'ltd');
  assert.equal(gbEntityType({ profile: { entity_type: 'gb-llp' } }), 'llp');
  assert.equal(gbEntityType({ entity_type: '  GB-Sole-Trader  ' }), 'sole_trader');
});

test('unknown or foreign legal forms resolve to null, never a default', () => {
  for (const bad of [{}, { entity_type: 'fi-oy' }, { entity_type: 'us-llc' }, { entity_type: '' }, { entity_type: 7 }]) {
    assert.equal(gbEntityType(bad), null);
  }
});

test('the fail-closed flag is dark by default: an unknown form passes through as null', () => {
  assert.equal(assertGbEntityOnly({ client: {}, allowed: ['ltd'] }), null);
});

test('fail-closed ON refuses an unknown form with a typed 409', () => {
  assert.throws(
    () => assertGbEntityOnly({ client: {}, allowed: ['ltd'], failClosedOnUnknown: true }),
    (e) => e.statusCode === 409 && e.code === 'GB_ENTITY_TYPE_UNKNOWN'
  );
});

test('a KNOWN but disallowed form refuses at either stage', () => {
  for (const failClosedOnUnknown of [false, true]) {
    assert.throws(
      () => assertGbEntityOnly({ client: { entity_type: 'gb-sole-trader' }, allowed: ['ltd'], failClosedOnUnknown }),
      (e) => e.statusCode === 409 && e.code === 'GB_ENTITY_UNSUPPORTED' && e.entityType === 'sole_trader'
    );
  }
});

test('Companies House duties apply to LTD and LLP, not to the unincorporated forms', () => {
  assert.equal(assertGbIncorporatedOnly({ client: { entity_type: 'gb-ltd' } }), 'ltd');
  assert.equal(assertGbIncorporatedOnly({ client: { entity_type: 'gb-llp' } }), 'llp');
  for (const type of ['gb-sole-trader', 'gb-partnership']) {
    assert.throws(() => assertGbIncorporatedOnly({ client: { entity_type: type } }),
      (e) => e.code === 'GB_ENTITY_UNSUPPORTED');
  }
});

test('corporation tax is a company duty — an LLP is tax-transparent and is refused', () => {
  assert.equal(assertGbCorporationTaxOnly({ client: { entity_type: 'gb-ltd' } }), 'ltd');
  assert.throws(() => assertGbCorporationTaxOnly({ client: { entity_type: 'gb-llp' } }),
    (e) => e.code === 'GB_ENTITY_UNSUPPORTED');
});

test('Self Assessment covers the unincorporated forms only', () => {
  assert.equal(assertGbSelfAssessmentOnly({ client: { entity_type: 'gb-sole-trader' } }), 'sole_trader');
  assert.equal(assertGbSelfAssessmentOnly({ client: { entity_type: 'gb-partnership' } }), 'partnership');
  assert.throws(() => assertGbSelfAssessmentOnly({ client: { entity_type: 'gb-ltd' } }),
    (e) => e.code === 'GB_ENTITY_UNSUPPORTED');
  assert.equal(assertGbSoleTraderOnly({ client: { entity_type: 'gb-sole-trader' } }), 'sole_trader');
});

test('constituent country resolves the four UK countries and nothing else', () => {
  assert.equal(gbConstituentCountry({ jurisdiction_subdivision: 'gb-sct' }), 'SCT');
  assert.equal(gbConstituentCountry({ profile: { jurisdiction_subdivision: 'gb-nir' } }), 'NIR');
  assert.deepEqual(
    GB_CONSTITUENT_COUNTRIES.map((c) => gbConstituentCountry({ jurisdiction_subdivision: `gb-${c.toLowerCase()}` })),
    [...GB_CONSTITUENT_COUNTRIES]
  );
  // A county, another country's subdivision, or junk ⇒ null. Never England.
  for (const bad of ['gb-xyz', 'us-ca', 'gb', '', 'fi-18']) {
    assert.equal(gbConstituentCountry({ jurisdiction_subdivision: bad }), null);
  }
});

test('a surface that depends on the country refuses rather than defaulting to England', () => {
  assert.throws(
    () => assertGbConstituentCountryResolved({ client: {} }),
    (e) => e.statusCode === 409 && e.code === 'GB_CONSTITUENT_COUNTRY_UNKNOWN'
  );
  assert.equal(assertGbConstituentCountryResolved({ client: { jurisdiction_subdivision: 'gb-wls' } }), 'WLS');
});

test('company number: 8 digits, or a 2-letter registry prefix + 6 digits', () => {
  for (const good of ['01234567', 'SC123456', 'NI123456', 'OC301234', 'SO301234', 'NC001234', 'sc123456']) {
    assert.ok(isValidCompanyNumber(good), `${good} should be structurally valid`);
  }
  for (const bad of ['1234567', '123456789', 'S1234567', 'SCC12345', '', null, undefined, 'SC12345']) {
    assert.ok(!isValidCompanyNumber(bad), `${JSON.stringify(bad)} should be rejected`);
  }
});

test('VAT number: 9 digits, 12-digit branch traders, and the GD/HA series', () => {
  for (const good of ['GB123456789', '123456789', 'GB 123 4567 89', 'gb123456789', '123456789012', 'GBGD001', 'GBHA599']) {
    assert.ok(isValidGbVatNumber(good), `${good} should be structurally valid`);
  }
  for (const bad of ['12345678', '1234567890', 'GBXX123456', '', null, undefined, 'GBGD01']) {
    assert.ok(!isValidGbVatNumber(bad), `${JSON.stringify(bad)} should be rejected`);
  }
});

test('the structural checks are advertised as structural, not as verification', async () => {
  const mod = await import('./entity.js');
  assert.equal(mod.COMPANY_NUMBER_FORMAT_PROVENANCE.validation, 'structural_only');
  assert.equal(mod.VAT_NUMBER_FORMAT_PROVENANCE.validation, 'structural_only');
  // gov.uk is 403 through this environment's proxy — the read must not claim
  // a primary confirmation it does not have.
  assert.equal(mod.VAT_NUMBER_FORMAT_PROVENANCE.confirmedAgainstPrimary, false);
});

test('the fail-closed flag key is the config-plane constant, not an env pair', () => {
  assert.equal(GB_ENTITY_FAIL_CLOSED_FLAG_KEY, 'GB_ENTITY_FAIL_CLOSED');
});
