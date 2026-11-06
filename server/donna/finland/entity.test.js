import assert from 'node:assert/strict';
import test from 'node:test';

import { ENTITY_TYPES_BY_JURISDICTION } from '../../../src/lib/clientAxes.js';
import {
  FI_ENTITY_TYPES,
  FINLAND_ENTITY_FAIL_CLOSED_FLAG_KEY,
  finlandEntityType,
  isFinlandOsakeyhtio,
  isFinlandLegalFormConversion,
  assertFinlandLegalFormNotMutatedAfterPosting,
  assertFinlandToiminimiOnly
} from './entity.js';

test('FI_ENTITY_TYPES is the closed fi-toiminimi / fi-oy vocabulary', () => {
  assert.deepEqual([...FI_ENTITY_TYPES], ['fi-toiminimi', 'fi-oy']);
  // Frozen — the vocabulary is a closed set, not a growable list.
  assert.throws(() => { FI_ENTITY_TYPES.push('fi-oyj'); });
});

// Gap 6's last drift hole. US, GB and SG each pin their resolver against the UI
// axis list; BF-2 removed SG's old `sg-llc` intake divergence while retaining
// that value as a readable legacy label. FI was the one market in sync by luck
// rather than by test: nothing detected a form added to `clientAxes.js`
// without a resolver, which is how a toiminimi/Oy branch silently stops covering
// a form the UI already offers. Both first-class markets now carry the same pin.
test('the persisted vocabulary stays in sync with the UI axis list', () => {
  assert.deepEqual([...FI_ENTITY_TYPES].sort(), [...ENTITY_TYPES_BY_JURISDICTION.fi].sort());
});

test('finlandEntityType resolves the legal form to the internal axis', () => {
  assert.equal(finlandEntityType({ entity_type: 'fi-oy' }), 'oy');
  assert.equal(finlandEntityType({ entity_type: 'fi-toiminimi' }), 'toiminimi');
  // profile.entity_type is read too (the validated profile key).
  assert.equal(finlandEntityType({ profile: { entity_type: 'fi-oy' } }), 'oy');
  // Top-level column wins the read (same precedence as clientAxes.readEntityType).
  assert.equal(finlandEntityType({ entity_type: 'fi-toiminimi', profile: { entity_type: 'fi-oy' } }), 'toiminimi');
});

test('finlandEntityType is case/space tolerant', () => {
  assert.equal(finlandEntityType({ entity_type: '  FI-OY  ' }), 'oy');
  assert.equal(finlandEntityType({ profile: { entity_type: 'Fi-Toiminimi' } }), 'toiminimi');
});

test('finlandEntityType returns null for a missing or non-Finnish form', () => {
  assert.equal(finlandEntityType({}), null);
  assert.equal(finlandEntityType({ entity_type: '' }), null);
  assert.equal(finlandEntityType({ entity_type: 'gb-ltd' }), null);
  assert.equal(finlandEntityType({ entity_type: 'fi-osuuskunta' }), null); // not yet supported
  assert.equal(finlandEntityType({ entity_type: 42 }), null);
  assert.equal(finlandEntityType(null), null);
});

test('isFinlandOsakeyhtio is true only for an explicit fi-oy', () => {
  assert.equal(isFinlandOsakeyhtio({ entity_type: 'fi-oy' }), true);
  assert.equal(isFinlandOsakeyhtio({ entity_type: 'fi-toiminimi' }), false);
  assert.equal(isFinlandOsakeyhtio({}), false);
  assert.equal(isFinlandOsakeyhtio({ entity_type: 'gb-ltd' }), false);
});

test('assertFinlandToiminimiOnly refuses an Oy with a typed bilingual 409', () => {
  let threw = null;
  try {
    assertFinlandToiminimiOnly({
      client: { entity_type: 'fi-oy' },
      code: 'FINLAND_ANNUAL_RETURN_ENTITY_UNSUPPORTED',
      surface: 'The elinkeinonharjoittaja annual return (form 5)',
      surfaceFi: 'Elinkeinonharjoittajan veroilmoitus (lomake 5)'
    });
  } catch (e) {
    threw = e;
  }
  assert.ok(threw, 'expected a refusal');
  assert.equal(threw.statusCode, 409);
  assert.equal(threw.code, 'FINLAND_ANNUAL_RETURN_ENTITY_UNSUPPORTED');
  assert.equal(threw.entityType, 'oy');
  assert.match(threw.message, /osakeyhti/i);
  assert.match(threw.message, /6B/);
  assert.ok(typeof threw.fi === 'string' && threw.fi.includes('osakeyhtiölle'), 'carries fi copy');
});

test('assertFinlandToiminimiOnly passes through toiminimi / unknown (13.0a staging)', () => {
  // A toiminimi is allowed and returns its axis.
  assert.equal(assertFinlandToiminimiOnly({ client: { entity_type: 'fi-toiminimi' }, code: 'X' }), 'toiminimi');
  // Missing/unknown does NOT refuse in 13.0a — it resolves null and the caller
  // treats it as toiminimi (byte-identical for every existing client). The
  // fail-closed-on-unknown flip lands with the backfill migration.
  assert.equal(assertFinlandToiminimiOnly({ client: {}, code: 'X' }), null);
  assert.equal(assertFinlandToiminimiOnly({ client: { entity_type: 'gb-ltd' }, code: 'X' }), null);
});

test('assertFinlandToiminimiOnly falls back to a default code when none given', () => {
  assert.throws(
    () => assertFinlandToiminimiOnly({ client: { entity_type: 'fi-oy' } }),
    (e) => e.code === 'FINLAND_ENTITY_UNSUPPORTED' && e.statusCode === 409
  );
});

// D-FI13-1 point 4 — legal form immutable after posting / no in-place conversion.
test('isFinlandLegalFormConversion is true only for a toiminimi↔oy change', () => {
  assert.equal(isFinlandLegalFormConversion('fi-toiminimi', 'fi-oy'), true);
  assert.equal(isFinlandLegalFormConversion('fi-oy', 'fi-toiminimi'), true);
  // Same form — not a conversion.
  assert.equal(isFinlandLegalFormConversion('fi-toiminimi', 'fi-toiminimi'), false);
  // A null / omitted / non-Finnish incoming is NOT a conversion (routine
  // re-provision that does not restate the form must not trip the guard).
  assert.equal(isFinlandLegalFormConversion('fi-toiminimi', null), false);
  assert.equal(isFinlandLegalFormConversion('fi-toiminimi', 'gb-ltd'), false);
  // A stored non-Finnish / null form is not an established Finnish form.
  assert.equal(isFinlandLegalFormConversion(null, 'fi-oy'), false);
  assert.equal(isFinlandLegalFormConversion('sg-pte', 'fi-oy'), false);
});

test('assertFinlandLegalFormNotMutatedAfterPosting refuses a conversion once entries are posted', () => {
  let threw = null;
  try {
    assertFinlandLegalFormNotMutatedAfterPosting({
      storedEntityType: 'fi-toiminimi',
      incomingEntityType: 'fi-oy',
      hasPostedEntries: true
    });
  } catch (e) {
    threw = e;
  }
  assert.ok(threw, 'expected a refusal for an in-place conversion after posting');
  assert.equal(threw.statusCode, 409);
  assert.equal(threw.code, 'FINLAND_ENTITY_TYPE_IMMUTABLE');
  assert.equal(threw.storedEntityType, 'fi-toiminimi');
  assert.equal(threw.incomingEntityType, 'fi-oy');
  assert.match(threw.message, /new legal entity|new Y-tunnus|cutover/i);
  assert.ok(typeof threw.fi === 'string' && threw.fi.includes('Y-tunnus'), 'carries fi copy');
});

test('assertFinlandLegalFormNotMutatedAfterPosting allows a pre-posting correction and every non-conversion', () => {
  // Conversion but NO posted entries yet → a pre-books correction is allowed.
  assert.doesNotThrow(() => assertFinlandLegalFormNotMutatedAfterPosting({
    storedEntityType: 'fi-toiminimi', incomingEntityType: 'fi-oy', hasPostedEntries: false
  }));
  // Non-conversions never throw, even with posted entries.
  assert.doesNotThrow(() => assertFinlandLegalFormNotMutatedAfterPosting({
    storedEntityType: 'fi-toiminimi', incomingEntityType: 'fi-toiminimi', hasPostedEntries: true
  }));
  assert.doesNotThrow(() => assertFinlandLegalFormNotMutatedAfterPosting({
    storedEntityType: 'fi-toiminimi', incomingEntityType: null, hasPostedEntries: true
  }));
  assert.doesNotThrow(() => assertFinlandLegalFormNotMutatedAfterPosting({
    storedEntityType: 'sg-pte', incomingEntityType: 'gb-ltd', hasPostedEntries: true
  }));
});

test('the config-plane flag key is the born-on-the-plane rollout gate name', () => {
  assert.equal(FINLAND_ENTITY_FAIL_CLOSED_FLAG_KEY, 'FINLAND_ENTITY_FAIL_CLOSED');
});

// 13.0b flip — fail-closed-on-unknown, config-gated.
test('assertFinlandToiminimiOnly with failClosedOnUnknown refuses an unresolved legal form', () => {
  let threw = null;
  try {
    assertFinlandToiminimiOnly({
      client: {},
      unknownCode: 'FINLAND_ANNUAL_RETURN_ENTITY_UNKNOWN',
      surface: 'The elinkeinonharjoittaja annual return (form 5)',
      surfaceFi: 'Elinkeinonharjoittajan veroilmoitus (lomake 5)',
      failClosedOnUnknown: true
    });
  } catch (e) {
    threw = e;
  }
  assert.ok(threw, 'expected a refusal for an unknown legal form');
  assert.equal(threw.statusCode, 409);
  assert.equal(threw.code, 'FINLAND_ANNUAL_RETURN_ENTITY_UNKNOWN');
  assert.equal(threw.entityType, 'unknown');
  assert.ok(typeof threw.fi === 'string' && threw.fi.includes('yritysmuoto'), 'carries fi copy');
  // A non-Finnish form (gb-ltd) is also "unknown" to the Finnish surface.
  assert.throws(() => assertFinlandToiminimiOnly({ client: { entity_type: 'gb-ltd' }, failClosedOnUnknown: true }), (e) => e.entityType === 'unknown');
});

test('failClosedOnUnknown defaults OFF (byte-identical staging) and never gates the fi-oy refusal', () => {
  // OFF: unknown still passes through as null (the caller treats it as toiminimi).
  assert.equal(assertFinlandToiminimiOnly({ client: {}, failClosedOnUnknown: false }), null);
  assert.equal(assertFinlandToiminimiOnly({ client: {} }), null, 'default is OFF');
  // A known toiminimi is never refused, flip on or off.
  assert.equal(assertFinlandToiminimiOnly({ client: { entity_type: 'fi-toiminimi' }, failClosedOnUnknown: true }), 'toiminimi');
  // The fi-oy refusal is unconditional — it fires even with the flip OFF.
  assert.throws(() => assertFinlandToiminimiOnly({ client: { entity_type: 'fi-oy' }, failClosedOnUnknown: false }), (e) => e.entityType === 'oy');
});
