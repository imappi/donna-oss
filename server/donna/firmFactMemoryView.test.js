// Tests for the firm_facts → memory.v1 ONE-WAY compatibility projection (BizOS Slice 2a).
// The only equivalence claimed is the honest round trip:
//   firm_fact → firmFactAsMemoryView → legacyFirmFactProjection === original firm_fact
// — every legacy field preserved, nothing invented in between.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  firmFactAsMemoryView,
  legacyFirmFactProjection,
  LEGACY_UNSPECIFIED,
  FIRM_FACT_MEMORY_VIEW_VERSION
} from './firmFactMemoryView.js';

const factRow = (overrides = {}) => ({
  id: 'ff-abc123',
  firm_id: 'donna-production',
  scope: 'merchant',
  subject: 'canva',
  fact: 'Canva subscriptions are software expenses for this firm',
  provenance: { client_id: 'honeybee-hills-apiary-llc', source: 'correction' },
  confidence: 'high',
  model: 'claude-opus-4-8',
  status: 'active',
  created_at: '2026-06-01T09:00:00Z',
  updated_at: '2026-06-15T09:00:00Z',
  ...overrides
});

test('round trip: every legacy field is preserved for all four scopes, both statuses, null model', () => {
  const rows = [
    factRow(),
    factRow({ scope: 'client', subject: '201812345K', status: 'dismissed' }),
    factRow({ scope: 'jurisdiction', subject: 'SG', model: null, provenance: {} }),
    factRow({ scope: 'firm', subject: 'donna-production', confidence: 'low' })
  ];
  for (const row of rows) {
    const roundTripped = legacyFirmFactProjection(firmFactAsMemoryView(row));
    assert.deepEqual(roundTripped, row, `${row.scope}: round trip must be exact`);
  }
});

test('lifecycle mapping: client-scoped facts are legal_entity-rooted (they die with the client), practice facts are organisation-rooted', () => {
  const clientFact = firmFactAsMemoryView(factRow({ scope: 'client', subject: '201812345K' }));
  assert.equal(clientFact.scope_type, 'legal_entity');
  assert.equal(clientFact.lifecycle_owner_type, 'legal_entity');
  assert.equal(clientFact.lifecycle_owner_id, 'honeybee-hills-apiary-llc'); // from provenance.client_id
  const merchantFact = firmFactAsMemoryView(factRow());
  assert.equal(merchantFact.scope_type, 'organisation');
  assert.equal(merchantFact.lifecycle_owner_id, 'donna-production');
});

test('nothing is invented: legacy confidence stays itself, truth is null, unknowns are marked', () => {
  const view = firmFactAsMemoryView(factRow());
  assert.equal(view.view_version, FIRM_FACT_MEMORY_VIEW_VERSION);
  assert.equal(view.legacy_confidence, 'high');
  assert.equal(view.assertion_confidence, LEGACY_UNSPECIFIED, 'one historical field must not acquire two new meanings');
  assert.equal(view.truth_confidence, null);
  assert.equal(view.confidentiality, LEGACY_UNSPECIFIED);
  assert.equal(view.personal_data_class, LEGACY_UNSPECIFIED);
  assert.equal(view.assertion_origin, LEGACY_UNSPECIFIED);
  assert.equal(view.asserted_by_principal_id, LEGACY_UNSPECIFIED);
  // The legacy subject is a matcher/key, honestly typed as such — never a business-graph id.
  assert.equal(view.subject_type, 'legacy_merchant_pattern');
  assert.equal(view.predicate, 'legacy_fact');
  assert.equal(view.structured_value, null);
});

test('a client fact with no provenance client_id marks its lifecycle root unspecified (fail-closed downstream)', () => {
  const view = firmFactAsMemoryView(factRow({ scope: 'client', subject: 'x', provenance: {} }));
  assert.equal(view.lifecycle_owner_id, LEGACY_UNSPECIFIED);
});

test('the projection refuses non-view inputs and unknown scopes', () => {
  assert.throws(() => firmFactAsMemoryView({ id: 'x' }), /firm_id/);
  assert.throws(() => firmFactAsMemoryView(factRow({ scope: 'household' })), /unknown legacy scope/);
  assert.throws(() => legacyFirmFactProjection({ view_version: 'other' }), /firm_fact_memory_view/);
});
