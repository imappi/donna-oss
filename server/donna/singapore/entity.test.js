// SG-13 — the Singapore legal-form resolver + refusal guards + UEN structure.
// node --test server/donna/singapore/entity.test.js

import test from 'node:test';
import assert from 'node:assert/strict';

import { ENTITY_TYPES_BY_JURISDICTION } from '../../../src/lib/clientAxes.js';

import {
  SG_ENTITY_TYPES,
  SINGAPORE_ENTITY_FAIL_CLOSED_FLAG_KEY,
  singaporeEntityType,
  isSingaporePteLtd,
  isSingaporeLegalFormConversion,
  assertSingaporeLegalFormNotMutatedAfterPosting,
  assertSingaporeCompanyOnly,
  isValidUen,
  uenFormatClass,
  UEN_FORMAT_PROVENANCE
} from './entity.js';

test('the resolver maps the stored SG vocabulary to the internal axis and nothing else', () => {
  assert.equal(singaporeEntityType({ entity_type: 'sg-pte' }), 'pte_ltd');
  assert.equal(singaporeEntityType({ entity_type: 'SG-PTE ' }), 'pte_ltd', 'case/space tolerant');
  assert.equal(singaporeEntityType({ entity_type: 'sg-sole-prop' }), 'sole_prop');
  assert.equal(singaporeEntityType({ entity_type: 'sg-llp' }), 'llp');
  assert.equal(singaporeEntityType({ profile: { entity_type: 'sg-pte' } }), 'pte_ltd', 'nested profile read');
  // sg-llc is a legacy FE label, NOT a Singapore statutory form — never resolves.
  assert.equal(singaporeEntityType({ entity_type: 'sg-llc' }), null);
  assert.equal(singaporeEntityType({ entity_type: 'fi-oy' }), null, 'foreign forms never resolve');
  assert.equal(singaporeEntityType({}), null);
  assert.equal(isSingaporePteLtd({ entity_type: 'sg-pte' }), true);
  assert.equal(isSingaporePteLtd({ entity_type: 'sg-sole-prop' }), false);
  assert.deepEqual([...SG_ENTITY_TYPES], ['sg-sole-prop', 'sg-pte', 'sg-llp']);
  assert.deepEqual(
    [...SG_ENTITY_TYPES].sort(),
    [...ENTITY_TYPES_BY_JURISDICTION.sg].sort(),
    'intake cannot admit a form the statutory resolver rejects'
  );
  assert.equal(SINGAPORE_ENTITY_FAIL_CLOSED_FLAG_KEY, 'SINGAPORE_ENTITY_FAIL_CLOSED');
});

test('a legal-form conversion is only two RECOGNISED, DIFFERENT SG forms', () => {
  assert.equal(isSingaporeLegalFormConversion('sg-sole-prop', 'sg-pte'), true);
  assert.equal(isSingaporeLegalFormConversion('sg-pte', 'sg-pte'), false, 'same form is not a conversion');
  assert.equal(isSingaporeLegalFormConversion('sg-pte', null), false, 'omitted incoming is not a conversion');
  assert.equal(isSingaporeLegalFormConversion('sg-pte', 'fi-oy'), false, 'foreign incoming is not a conversion');
  assert.equal(isSingaporeLegalFormConversion(null, 'sg-pte'), false);
});

test('the immutable-after-posting guard: conversion on a posted book is a typed 409', () => {
  // No posted entries → allowed (a pre-books correction).
  assert.doesNotThrow(() => assertSingaporeLegalFormNotMutatedAfterPosting({
    storedEntityType: 'sg-sole-prop', incomingEntityType: 'sg-pte', hasPostedEntries: false
  }));
  // Non-conversion → no-op even with posted entries.
  assert.doesNotThrow(() => assertSingaporeLegalFormNotMutatedAfterPosting({
    storedEntityType: 'sg-pte', incomingEntityType: 'sg-pte', hasPostedEntries: true
  }));
  try {
    assertSingaporeLegalFormNotMutatedAfterPosting({
      storedEntityType: 'sg-sole-prop', incomingEntityType: 'sg-pte', hasPostedEntries: true
    });
    assert.fail('expected a refusal');
  } catch (error) {
    assert.equal(error.statusCode, 409);
    assert.equal(error.code, 'SINGAPORE_ENTITY_TYPE_IMMUTABLE');
    assert.match(error.message, /separate entity\/cutover assessment/);
  }
});

test('the company-only guard refuses sole-prop/LLP unconditionally, unknown only when fail-closed', () => {
  assert.equal(assertSingaporeCompanyOnly({ client: { entity_type: 'sg-pte' } }), 'pte_ltd');
  // Unknown form with the flip OFF (default) passes through as null.
  assert.equal(assertSingaporeCompanyOnly({ client: {} }), null);
  try {
    assertSingaporeCompanyOnly({ client: { entity_type: 'sg-sole-prop' }, surface: 'ECI filing' });
    assert.fail('expected a refusal');
  } catch (error) {
    assert.equal(error.statusCode, 409);
    assert.equal(error.code, 'SINGAPORE_ENTITY_UNSUPPORTED');
    assert.equal(error.entityType, 'sole_prop');
    assert.match(error.message, /Form B/);
  }
  try {
    assertSingaporeCompanyOnly({ client: { entity_type: 'sg-llp' } });
    assert.fail('expected a refusal');
  } catch (error) {
    assert.equal(error.entityType, 'llp');
    assert.match(error.message, /Form P/);
  }
  try {
    assertSingaporeCompanyOnly({ client: {}, failClosedOnUnknown: true });
    assert.fail('expected a refusal');
  } catch (error) {
    assert.equal(error.code, 'SINGAPORE_ENTITY_TYPE_UNKNOWN');
    assert.equal(error.entityType, 'unknown');
  }
});

test('UEN structural validation covers the three format classes and rejects the rest', () => {
  // ROB — business (8 digits + check letter).
  assert.equal(isValidUen('53012345A'), true);
  assert.equal(uenFormatClass('53012345A'), 'business');
  // ROC — local company (year + 5 digits + check letter).
  assert.equal(isValidUen('201812345K'), true);
  assert.equal(uenFormatClass('201812345K'), 'local_company');
  assert.equal(isValidUen('199912345M'), true);
  // Other entities (LLP et al.).
  assert.equal(isValidUen('T08LL0001A'), true);
  assert.equal(uenFormatClass('T08LL0001A'), 'other_entity');
  assert.equal(isValidUen('t08ll0001a'), true, 'case tolerant');
  // Rejects.
  assert.equal(isValidUen(''), false);
  assert.equal(isValidUen('1234567-8'), false, 'a Y-tunnus is not a UEN');
  assert.equal(isValidUen('12345678'), false, 'missing check letter');
  assert.equal(isValidUen('301812345K'), false, 'implausible year prefix is not ROC');
  assert.equal(uenFormatClass('nope'), null);
  // The honesty bit: structural only, checksum unvalidated.
  assert.equal(UEN_FORMAT_PROVENANCE.checkDigitValidated, false);
  assert.equal(UEN_FORMAT_PROVENANCE.confirmedAgainstPrimary, false);
});
