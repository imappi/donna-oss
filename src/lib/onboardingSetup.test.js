import test from 'node:test';
import assert from 'node:assert/strict';

import { channelConnectPending, deriveSetupWizard, jurisdictionCaptureState, persistedClientIdentity, entityTypeIdentityConflict } from './onboardingSetup.js';

test('channelConnectPending: a step only while the channel acts and nothing is bound', () => {
  assert.equal(channelConnectPending({ channel_acts: true, binding: null }), true);
  assert.equal(channelConnectPending({ channel_acts: true, binding: { id: 'tgb_1' } }), false);
  assert.equal(channelConnectPending({ channel_acts: false, binding: null }), false);
  assert.equal(channelConnectPending(null), false);
});

test('jurisdiction confirmation precedes legal form and cannot be satisfied by a detected hint', () => {
  const missing = jurisdictionCaptureState({ profile: { jurisdiction_detected: 'sg' } });
  assert.equal(missing.show, true);
  const wizard = deriveSetupWizard({ due: { entity_type: true, jurisdiction: missing.show } });
  assert.equal(wizard.active.id, 'jurisdiction');
  assert.equal(jurisdictionCaptureState({ jurisdiction: 'SG', profile: { jurisdiction: 'gb' } }).conflict, true);
  assert.equal(jurisdictionCaptureState({ jurisdiction: 'UK', profile: { jurisdiction: 'gb' } }).show, false);
  assert.equal(jurisdictionCaptureState({ jurisdiction: 'hk' }).show, false, 'an unsupported country needs policy support, not a fabricated change of country');
  assert.equal(jurisdictionCaptureState({ jurisdiction: 'unknown', profile: {} }).show, true);
  assert.equal(jurisdictionCaptureState({ profile: { jurisdiction: 'gb' } }).show, true, 'profile-only country has not established the canonical column');
  assert.equal(jurisdictionCaptureState({ jurisdiction: 'gb', entity_type: 'sg-pte-ltd' }).show, true, 'country/entity conflict must have a reachable setup repair');
});

test('deriveSetupWizard: steps keep dependency order regardless of input key order', () => {
  const wizard = deriveSetupWizard({
    due: { channel_connect: true, entity_type: true, fiscal_period: true, gb_filing: true }
  });
  assert.deepEqual(wizard.steps.map((step) => step.id), ['entity_type', 'fiscal_period', 'gb_filing', 'channel_connect']);
  assert.equal(wizard.mode, 'wizard');
  assert.equal(wizard.active.id, 'entity_type');
  assert.equal(wizard.activeIndex, 0);
  assert.equal(wizard.parked, false);
});

test('deriveSetupWizard: zero or one due step is a plain stack, never wizard chrome', () => {
  assert.equal(deriveSetupWizard({ due: {} }).mode, 'stack');
  const one = deriveSetupWizard({ due: { fiscal_period: true } });
  assert.equal(one.mode, 'stack');
  assert.equal(one.active.id, 'fiscal_period');
  assert.equal(one.parked, false);
});

test('deriveSetupWizard: a skip advances to the next unskipped step, index stays absolute', () => {
  const wizard = deriveSetupWizard({
    due: { entity_type: true, fiscal_period: true, channel_connect: true },
    skipped: new Set(['entity_type'])
  });
  assert.equal(wizard.active.id, 'fiscal_period');
  assert.equal(wizard.activeIndex, 1);
  assert.equal(wizard.steps.length, 3);
});

test('deriveSetupWizard: all due steps skipped parks the wizard instead of hiding the work', () => {
  const wizard = deriveSetupWizard({
    due: { entity_type: true, channel_connect: true },
    skipped: ['entity_type', 'channel_connect']
  });
  assert.equal(wizard.active, null);
  assert.equal(wizard.activeIndex, -1);
  assert.equal(wizard.parked, true);
  assert.equal(wizard.steps.length, 2);
});

test('deriveSetupWizard: a step whose show condition is false is not a step, skipped or not', () => {
  const wizard = deriveSetupWizard({
    due: { entity_type: false, fiscal_period: true, gb_filing: true },
    skipped: new Set(['entity_type'])
  });
  assert.deepEqual(wizard.steps.map((step) => step.id), ['fiscal_period', 'gb_filing']);
  assert.equal(wizard.active.id, 'fiscal_period');
});


test('persisted snapshot identity exposes conflicts hidden by flattened display fields', () => {
  const client = { jurisdiction: 'sg', entityType: 'gb-sole-trader', persisted_identity: {
    jurisdiction: 'gb', entity_type: 'gb-ltd', profile_jurisdiction: 'sg',
    profile_entity_type: null, profile_entityType: 'gb-sole-trader'
  } };
  assert.equal(jurisdictionCaptureState(client).conflict, true);
  assert.equal(entityTypeIdentityConflict(client), true);
  assert.equal(persistedClientIdentity(client).entity_type, 'gb-ltd');
  assert.equal(entityTypeIdentityConflict({ ...client, persisted_identity: { ...client.persisted_identity, profile_entityType: 'gb-ltd' } }), false);
  assert.equal(jurisdictionCaptureState({ jurisdiction: 'gb', profile: { jurisdiction: 'unknown' } }).show, true);
  assert.equal(jurisdictionCaptureState({ jurisdiction: 'gb', profile: { jurisdiction: 'invalid' } }).show, true);
});
