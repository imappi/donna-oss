import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ENTITY_TYPE_LABEL,
  ENTITY_TYPES_BY_JURISDICTION,
  legalFormCompatibility,
  normalizeLegalFormJurisdiction,
  normalizeLegalFormToken
} from './legalForms.js';

test('every displayed legal-form label round-trips to its canonical value', () => {
  for (const [jurisdiction, canonicalValues] of Object.entries(ENTITY_TYPES_BY_JURISDICTION)) {
    for (const canonical of canonicalValues) {
      const result = legalFormCompatibility({
        jurisdiction,
        entityType: ENTITY_TYPE_LABEL[canonical]
      });
      assert.equal(result.canonical, canonical, `${jurisdiction}: ${ENTITY_TYPE_LABEL[canonical]}`);
    }
  }
});

test('known US and GB intake labels resolve to the runtime canonical vocabulary', () => {
  assert.deepEqual(
    legalFormCompatibility({ jurisdiction: 'US', entityType: 'Limited liability company' }),
    {
      status: 'alias',
      supplied: 'Limited liability company',
      jurisdiction: 'us',
      canonical: 'us-llc',
      options: ['us-llc', 'us-c-corp', 'us-s-corp', 'us-sole-prop', 'us-partnership']
    }
  );
  assert.equal(
    legalFormCompatibility({ jurisdiction: 'UK', entityType: 'Private limited company' }).canonical,
    'gb-ltd'
  );
  assert.equal(
    legalFormCompatibility({ jurisdiction: 'gb', entityType: 'sole_trader' }).canonical,
    'gb-sole-trader'
  );
});

test('canonical forms remain canonical and a foreign canonical form is a mismatch', () => {
  assert.equal(
    legalFormCompatibility({ jurisdiction: 'US', entityType: 'US_LLC' }).status,
    'canonical'
  );
  const mismatch = legalFormCompatibility({ jurisdiction: 'GB', entityType: 'us-llc' });
  assert.equal(mismatch.status, 'jurisdiction_mismatch');
  assert.equal(mismatch.suppliedJurisdiction, 'us');
  assert.equal(mismatch.canonical, null);
});

test('ambiguous and unsupported values never acquire a guessed canonical form', () => {
  const ambiguous = legalFormCompatibility({ jurisdiction: 'US', entityType: 'Corporation' });
  assert.equal(ambiguous.status, 'ambiguous');
  assert.deepEqual(ambiguous.options, ['us-c-corp', 'us-s-corp']);
  assert.equal(ambiguous.canonical, null);

  const unsupported = legalFormCompatibility({ jurisdiction: 'GB', entityType: 'Charity' });
  assert.equal(unsupported.status, 'unsupported');
  assert.equal(unsupported.canonical, null);

  const legacySgLlc = legalFormCompatibility({ jurisdiction: 'SG', entityType: 'sg-llc' });
  assert.equal(legacySgLlc.status, 'unsupported', 'a legacy display label is not an admitted statutory form');
  assert.equal(legacySgLlc.canonical, null);
});

test('legal form never guesses a missing jurisdiction', () => {
  const result = legalFormCompatibility({ entityType: 'us-llc' });
  assert.equal(result.status, 'jurisdiction_required');
  assert.equal(result.suggestedJurisdiction, 'us');
  assert.equal(result.canonical, null);
});

test('normalizers are deterministic across display punctuation and the UK alias', () => {
  assert.equal(normalizeLegalFormJurisdiction(' UK '), 'gb');
  assert.equal(normalizeLegalFormToken('  Osakeyhtiö (OY)  '), 'osakeyhtio-oy');
  assert.equal(normalizeLegalFormToken('LIMITED_LIABILITY COMPANY'), 'limited-liability-company');
});
