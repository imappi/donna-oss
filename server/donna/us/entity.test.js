import test from 'node:test';
import assert from 'node:assert/strict';

import { ENTITY_TYPES_BY_JURISDICTION } from '../../../src/lib/clientAxes.js';
import {
  assertUsCorporationOnly,
  assertUsPartnershipReturnOnly,
  assertUsSoleProprietorOnly,
  assertUsStateResolved,
  EIN_FORMAT_PROVENANCE,
  isValidEin,
  US_ENTITY_FAIL_CLOSED_FLAG_KEY,
  US_ENTITY_TYPES,
  US_STATE_CODES,
  usEntityType,
  usStateCode
} from './entity.js';

test('US persisted entity vocabulary resolves exactly', () => {
  assert.deepEqual(US_ENTITY_TYPES, ['us-llc', 'us-c-corp', 'us-s-corp', 'us-sole-prop', 'us-partnership']);
  assert.equal(usEntityType({ profile: { entity_type: 'US-S-CORP ' } }), 's_corp');
  assert.equal(usEntityType({ entity_type: 'us-llc' }), 'llc');
  assert.equal(usEntityType({ entity_type: 'us-c-corp' }), 'c_corp');
  assert.equal(usEntityType({ entity_type: 'us-sole-prop' }), 'sole_prop');
  assert.equal(usEntityType({ entity_type: 'us-partnership' }), 'partnership');
  assert.equal(US_ENTITY_FAIL_CLOSED_FLAG_KEY, 'US_ENTITY_FAIL_CLOSED');
});

// The header promises this mirror; a drift test is what makes the promise real
// (the same discipline the SG and FI resolvers carry).
test('the persisted vocabulary stays in sync with the UI axis list', () => {
  assert.deepEqual([...US_ENTITY_TYPES].sort(), [...ENTITY_TYPES_BY_JURISDICTION.us].sort());
});

test('a foreign or absent legal form resolves to null, never a default', () => {
  assert.equal(usEntityType({ entity_type: 'sg-pte' }), null);
  assert.equal(usEntityType({ entity_type: 'fi-oy' }), null);
  assert.equal(usEntityType({}), null);
  assert.equal(usEntityType(), null);
});

test('state bridge accepts 50 states plus DC and refuses anything else', () => {
  assert.equal(US_STATE_CODES.length, 51);
  assert.ok(US_STATE_CODES.includes('DC'));
  assert.equal(usStateCode({ profile: { jurisdiction_subdivision: 'us-ca' } }), 'CA');
  assert.equal(usStateCode({ jurisdiction_subdivision: 'US-DE ' }), 'DE');
  // Territories are deliberately absent — they must not borrow a state cadence.
  for (const territory of ['us-pr', 'us-gu', 'us-vi', 'us-as', 'us-mp']) {
    assert.equal(usStateCode({ jurisdiction_subdivision: territory }), null, territory);
  }
  assert.equal(usStateCode({ jurisdiction_subdivision: 'gb-eng' }), null);
  assert.equal(usStateCode({}), null);
});

test('assertUsStateResolved refuses with a typed 409', () => {
  assert.throws(() => assertUsStateResolved({ client: {} }), (error) => {
    assert.equal(error.code, 'US_STATE_UNKNOWN');
    assert.equal(error.statusCode, 409);
    assert.equal(error.state, 'unknown');
    return true;
  });
  assert.equal(assertUsStateResolved({ client: { jurisdiction_subdivision: 'us-ny' } }), 'NY');
});

test('entity guards allow their own forms and refuse the others', () => {
  assert.equal(assertUsCorporationOnly({ client: { entity_type: 'us-c-corp' } }), 'c_corp');
  assert.equal(assertUsCorporationOnly({ client: { entity_type: 'us-s-corp' } }), 's_corp');
  assert.throws(
    () => assertUsCorporationOnly({ client: { entity_type: 'us-llc' } }),
    { code: 'US_ENTITY_UNSUPPORTED' }
  );
  assert.equal(assertUsPartnershipReturnOnly({ client: { entity_type: 'us-llc' } }), 'llc');
  assert.equal(assertUsPartnershipReturnOnly({ client: { entity_type: 'us-partnership' } }), 'partnership');
  assert.throws(
    () => assertUsPartnershipReturnOnly({ client: { entity_type: 'us-c-corp' } }),
    { code: 'US_ENTITY_UNSUPPORTED' }
  );
  assert.equal(assertUsSoleProprietorOnly({ client: { entity_type: 'us-sole-prop' } }), 'sole_prop');
});

// The US_ENTITY_FAIL_CLOSED stage in miniature: dark is permissive on UNKNOWN,
// strict refuses — but a KNOWN-but-disallowed form refuses at either stage.
test('unknown forms are permissive while the strict flag is dark, and refuse when it acts', () => {
  assert.equal(assertUsCorporationOnly({ client: {} }), null);
  assert.throws(
    () => assertUsCorporationOnly({ client: {}, failClosedOnUnknown: true }),
    { code: 'US_ENTITY_TYPE_UNKNOWN' }
  );
  assert.throws(
    () => assertUsCorporationOnly({ client: { entity_type: 'us-llc' }, failClosedOnUnknown: false }),
    { code: 'US_ENTITY_UNSUPPORTED' }
  );
});

test('EIN validation is structural, including the required hyphen', () => {
  assert.equal(isValidEin('12-3456789'), true);
  assert.equal(isValidEin(' 12-3456789 '), true);
  assert.equal(isValidEin('123456789'), false);
  assert.equal(isValidEin('1A-3456789'), false);
  assert.equal(isValidEin('12-345678'), false);
  assert.equal(isValidEin('12-34567890'), false);
  assert.equal(isValidEin(null), false);
  // The provenance must say plainly that this is not verification.
  assert.equal(EIN_FORMAT_PROVENANCE.validation, 'structural_only');
  assert.equal(EIN_FORMAT_PROVENANCE.asOf, '2026-07-27');
});
