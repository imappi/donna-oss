import assert from 'node:assert/strict';
import test from 'node:test';

import {
  canonicalizeClientLegalForm,
  canonicalizeClientProfileLegalForm
} from './clientLegalForm.js';

test('client identity canonicalizer writes a US alias without changing the profile shape', () => {
  const result = canonicalizeClientProfileLegalForm({
    id: 'honeybee',
    jurisdiction: 'us',
    entityType: 'Limited liability company'
  });
  assert.equal(result.canonical, 'us-llc');
  assert.equal(result.jurisdiction, 'US');
  assert.equal(result.profile.jurisdiction, 'US');
  assert.equal(result.profile.entityType, 'us-llc');
  assert.equal(Object.hasOwn(result.profile, 'entity_type'), false);
});

test('a supplied snake_case legal form is canonicalized alongside the writer home', () => {
  const result = canonicalizeClientProfileLegalForm({
    id: 'apiary-ltd',
    jurisdiction: 'GB',
    entity_type: 'Limited company'
  });
  assert.equal(result.profile.entityType, 'gb-ltd');
  assert.equal(result.profile.entity_type, 'gb-ltd');
});

test('ambiguous intake refuses with a stable correction receipt', () => {
  assert.throws(
    () => canonicalizeClientLegalForm({ jurisdiction: 'US', entityType: 'Corporation' }),
    (error) => {
      assert.equal(error.statusCode, 422);
      assert.equal(error.code, 'CLIENT_LEGAL_FORM_AMBIGUOUS');
      assert.deepEqual(error.details, {
        supplied_legal_form: 'Corporation',
        jurisdiction: 'US',
        canonical_options: ['us-c-corp', 'us-s-corp'],
        correction: 'choose_supported_legal_form'
      });
      return true;
    }
  );
});

test('conflicting profile homes refuse instead of choosing one', () => {
  assert.throws(
    () => canonicalizeClientProfileLegalForm({
      jurisdiction: 'GB',
      entityType: 'Limited company',
      entity_type: 'gb-sole-trader'
    }),
    (error) => error.code === 'CLIENT_LEGAL_FORM_CONFLICT'
      && error.details.correction === 'choose_supported_legal_form'
  );
});

test('missing legal form remains an explicit compatibility state', () => {
  const result = canonicalizeClientProfileLegalForm({ id: 'unclassified', jurisdiction: 'GB' });
  assert.equal(result.canonical, null);
  assert.equal(result.compatibility.status, 'missing');
  assert.equal(Object.hasOwn(result.profile, 'entityType'), false);
});
