import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CLOUD_PILOT_PROCESSING_FLAGS, FI_HOSTED_PILOT_STAGES, HOSTED_ACCOUNTING_MARKETS, HOSTED_JEV_DEFAULT_BASES,
  HOSTED_MARKET_PROFILES, SG_HOSTED_CAPABILITY_MANIFEST, SG_HOSTED_REVIEW_STAGES, US_HOSTED_CAPABILITY_MANIFEST,
  US_HOSTED_FIRM_POLICY_REASON, US_HOSTED_PILOT_FLAG, US_HOSTED_PILOT_STAGES, hostedMarketProfileFor
} from './cloudPilotConfig.js';
import { HOSTED_PILOT_VERSION, HOSTED_PILOT_VERSIONS, SG_HOSTED_REVIEW_VERSION, US_HOSTED_PILOT_VERSION } from './internalPilotAccess.js';
import { readinessProfileCoordinate } from './runtimeReadiness.js';

// docs/design-donna-us-hosted-lane.md: ONE table of hosted markets.

test('the hosted market registry keeps FI and SG byte-identical and adds US as a third row', () => {
  assert.deepEqual(Object.keys(HOSTED_MARKET_PROFILES), ['FI', 'SG', 'US']);
  assert.equal(HOSTED_MARKET_PROFILES.FI.baselineStages, FI_HOSTED_PILOT_STAGES);
  assert.equal(HOSTED_MARKET_PROFILES.SG.baselineStages, SG_HOSTED_REVIEW_STAGES);
  assert.equal(HOSTED_MARKET_PROFILES.FI.version, HOSTED_PILOT_VERSION);
  assert.equal(HOSTED_MARKET_PROFILES.SG.version, SG_HOSTED_REVIEW_VERSION);
  assert.equal(HOSTED_MARKET_PROFILES.SG.processing, 'review_only');
  assert.equal(HOSTED_MARKET_PROFILES.SG.capabilityManifest, SG_HOSTED_CAPABILITY_MANIFEST);
  assert.deepEqual({ ...HOSTED_MARKET_PROFILES.US, baselineStages: undefined }, {
    jurisdiction: 'US', entityType: 'us-llc', currency: 'USD', version: US_HOSTED_PILOT_VERSION,
    processing: 'accounting', baselineStages: undefined, capabilityManifest: US_HOSTED_CAPABILITY_MANIFEST,
    birthSelectionFlag: US_HOSTED_PILOT_FLAG, birthPolicyReason: US_HOSTED_FIRM_POLICY_REASON
  });
  assert.equal(HOSTED_MARKET_PROFILES.FI.birthPolicyReason, 'authenticated_fi_firm_creation_default', 'FI keeps its seat reason bytes');
  assert.equal(HOSTED_MARKET_PROFILES.SG.birthPolicyReason, null, 'review-only births no reconciliation seat');
  assert.equal(HOSTED_MARKET_PROFILES.FI.birthSelectionFlag, null, 'FI birth is unchanged: no new gate in front of it');
  assert.equal(hostedMarketProfileFor('us'), HOSTED_MARKET_PROFILES.US);
  assert.equal(hostedMarketProfileFor('GB'), null);
});

test('every hosted pilot version is known to pilot access, and only to it', () => {
  assert.deepEqual([...HOSTED_PILOT_VERSIONS].sort(),
    Object.values(HOSTED_MARKET_PROFILES).map(row => row.version).sort());
});

test('US hosted stages are gross-only, send nothing and carry no Finnish flag', () => {
  assert.equal(US_HOSTED_PILOT_STAGES.JURISDICTION_TAX_CODING, 'off');
  assert.equal(US_HOSTED_PILOT_STAGES.RECONCILE_RETRACTION_AUTOSEND, 'off');
  assert.equal(US_HOSTED_PILOT_STAGES.INTERNAL_PILOT_ACCESS, 'canary');
  for (const [key, stage] of Object.entries(US_HOSTED_PILOT_STAGES)) {
    if (key.startsWith('OUTBOUND_')) assert.equal(stage, 'off', key);
    assert.doesNotMatch(key, /^FINLAND_|FISCAL_PERIOD_INTAKE/);
    assert.ok(!CLOUD_PILOT_PROCESSING_FLAGS.includes(key), `${key} is a processing extension, not baseline`);
  }
});

test('accounting markets drive the convergence worker and the first-line coder; review-only never does', () => {
  assert.deepEqual(HOSTED_ACCOUNTING_MARKETS.map(row => row.jurisdiction), ['FI', 'US']);
  assert.deepEqual(HOSTED_JEV_DEFAULT_BASES, ['hosted_fi_default', 'hosted_us_default'], 'FI keeps its historical basis bytes');
});

test('the hosted readiness coordinate names each market\'s own manifest', () => {
  const hostIdentity = { runtime_host: 'vercel' };
  const coordinate = (jurisdiction, entity_type) => readinessProfileCoordinate({ hostIdentity, creationPath: 'desktop_firm_intake',
    client: { jurisdiction, entity_type, profile: { accounting_system: 'none' } } }).capability_manifest_version;
  assert.equal(coordinate('fi', 'fi-oy'), 'fi-cloud-pilot.v1');
  assert.equal(coordinate('SG', 'sg-pte'), SG_HOSTED_CAPABILITY_MANIFEST);
  assert.equal(coordinate('us', 'us-llc'), US_HOSTED_CAPABILITY_MANIFEST);
  assert.equal(coordinate('GB', 'gb-ltd'), 'fi-cloud-pilot.v1', 'an undeclared market keeps today\'s coordinate and fails as undeclared');
});
