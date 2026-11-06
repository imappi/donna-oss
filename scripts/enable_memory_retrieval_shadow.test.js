// Unit tests for the memory-retrieval-shadow staging script (BizOS 2c-ii) — the
// PURE plan logic only (parseArgv + buildMemoryRetrievalShadowPlan), no live DB.
// Load-bearing properties:
//   - dry-run is the default (apply only when --apply present);
//   - default stage is SHADOW, default client is Honeybee (the canary discipline);
//   - §19 GUARD: an ACTING stage (canary/auto = live prompt replacement, 2c-iii) is
//     REFUSED — the lever cannot set an acting stage, and the plan never exposes an
//     act lever (willAct is always false);
//   - fail-closed: invalid stage or missing client is REFUSED;
//   - the flag key is pinned to MEMORY_RETRIEVAL_V2, never taken from argv.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  parseArgv,
  buildMemoryRetrievalShadowPlan,
  evaluateDurableApprovals,
  evaluateLiveAttestations,
  DURABLE_APPROVALS,
  LIVE_ATTESTATIONS
} from './enable_memory_retrieval_shadow.js';

test('parseArgv: dry-run + Honeybee + shadow by default', () => {
  const o = parseArgv([]);
  assert.equal(o.apply, false);
  assert.equal(o.firmId, 'donna-production');
  assert.equal(o.clientId, 'honeybee-hills-apiary-llc');
  assert.equal(o.stage, 'shadow');
});

test('parseArgv: flags override the defaults (no --flag arg — the key is pinned)', () => {
  const o = parseArgv(['--apply', '--firm', 'f2', '--client', 'c2', '--stage', 'off', '--reason', 'rollback']);
  assert.deepEqual(o, { apply: true, firmId: 'f2', clientId: 'c2', stage: 'off', reason: 'rollback', replayArtifactPath: null, commitSha: null, attests: [], onCallOwner: null });
});

test('parseArgv: §17 live attestations — repeatable --attest + --on-call-owner', () => {
  const o = parseArgv(['--stage', 'canary', '--attest', 'noActiveIncident', '--attest', 'dashboardHealthy', '--on-call-owner', 'kari@books.example']);
  assert.deepEqual(o.attests, ['noActiveIncident', 'dashboardHealthy']);
  assert.equal(o.onCallOwner, 'kari@books.example');
});

test('shadow observes; off/dry_run are dormant; the plan never acts', () => {
  const shadow = buildMemoryRetrievalShadowPlan({ firmId: 'f', clientId: 'c', stage: 'shadow', currentStage: null });
  assert.equal(shadow.ok, true);
  assert.equal(shadow.flagKey, 'MEMORY_RETRIEVAL_V2');
  assert.equal(shadow.willObserve, true);
  assert.equal(shadow.willAct, false);
  for (const stage of ['off', 'dry_run']) {
    const p = buildMemoryRetrievalShadowPlan({ firmId: 'f', clientId: 'c', stage, currentStage: 'shadow' });
    assert.equal(p.ok, true);
    assert.equal(p.willObserve, false);
    assert.equal(p.willAct, false);
    assert.equal(p.willChange, true);
  }
});

const okGroups = { gate: { passed: true }, durableApprovals: { ok: true }, liveAttestations: { ok: true } };

test('§M: auto is ALWAYS refused (separate later terminal)', () => {
  const p = buildMemoryRetrievalShadowPlan({ firmId: 'f', clientId: 'c', stage: 'auto', currentStage: null, ...okGroups });
  assert.equal(p.ok, false);
  assert.equal(p.willAct, false);
  assert.ok(p.errors.some((e) => /auto|§M/.test(e)));
});

test('§H/§17: canary requires ALL THREE groups — gate, durable approvals, live attestations', () => {
  const noGate = buildMemoryRetrievalShadowPlan({ firmId: 'f', clientId: 'c', stage: 'canary', currentStage: 'shadow' });
  assert.equal(noGate.ok, false);
  assert.equal(noGate.willAct, false);
  assert.ok(noGate.errors.some((e) => /replay gate|§H/.test(e)));

  const gateOnly = buildMemoryRetrievalShadowPlan({ firmId: 'f', clientId: 'c', stage: 'canary', currentStage: 'shadow', gate: { passed: true } });
  assert.equal(gateOnly.ok, false);
  assert.ok(gateOnly.errors.some((e) => /durable approval/.test(e)));
  assert.ok(gateOnly.errors.some((e) => /live launch attestations/.test(e)));

  // gate + durable but NO live attestations → still refused (live group is required).
  const noLive = buildMemoryRetrievalShadowPlan({ firmId: 'f', clientId: 'c', stage: 'canary', currentStage: 'shadow', gate: { passed: true }, durableApprovals: { ok: true }, liveAttestations: { ok: false, missing: ['onCallOwner'] } });
  assert.equal(noLive.ok, false);
  assert.ok(noLive.errors.some((e) => /live launch attestations.*onCallOwner/.test(e)));

  const failedGate = buildMemoryRetrievalShadowPlan({ firmId: 'f', clientId: 'c', stage: 'canary', currentStage: 'shadow', gate: { passed: false, failures: ['insufficient real turns'] }, durableApprovals: { ok: true }, liveAttestations: { ok: true } });
  assert.equal(failedGate.ok, false);
  assert.ok(failedGate.errors.some((e) => /insufficient real turns/.test(e)));
});

test('§H/§17: canary WITH all three groups is PERMITTED and acts + opens a v2 epoch', () => {
  const p = buildMemoryRetrievalShadowPlan({ firmId: 'f', clientId: 'c', stage: 'canary', currentStage: 'shadow', ...okGroups });
  assert.equal(p.ok, true, p.errors.join('; '));
  assert.equal(p.willAct, true);
  assert.equal(p.willObserve, true);       // canary observes AND acts
  assert.equal(p.opensEpoch, 'v2');
  assert.equal(p.audience, 'owner');
  assert.equal(p.purpose, 'portal_owner_context');
});

test('§F: rolling back canary → shadow opens a LEGACY epoch', () => {
  const p = buildMemoryRetrievalShadowPlan({ firmId: 'f', clientId: 'c', stage: 'shadow', currentStage: 'canary' });
  assert.equal(p.ok, true);
  assert.equal(p.willAct, false);
  assert.equal(p.opensEpoch, 'legacy');
});

test('fail-closed: invalid stage / missing client are refused', () => {
  assert.equal(buildMemoryRetrievalShadowPlan({ firmId: 'f', clientId: 'c', stage: 'on' }).ok, false);
  const noClient = buildMemoryRetrievalShadowPlan({ firmId: 'f', clientId: '', stage: 'shadow' });
  assert.equal(noClient.ok, false);
  assert.ok(noClient.errors.some((e) => e.includes('clientId')));
});

test('parseArgv: --replay-artifact and --commit are parsed for the canary gate', () => {
  const o = parseArgv(['--stage', 'canary', '--replay-artifact', './a.json', '--commit', 'sha123']);
  assert.equal(o.stage, 'canary');
  assert.equal(o.replayArtifactPath, './a.json');
  assert.equal(o.commitSha, 'sha123');
});

test('§17 evaluateDurableApprovals: all-or-nothing from the artifact receipts', () => {
  const { ok, missing } = evaluateDurableApprovals({ rollbackTested: true });
  assert.equal(ok, false);
  assert.ok(missing.includes('customerAgreement'));
  const all = Object.fromEntries(DURABLE_APPROVALS.map((k) => [k, true]));
  assert.equal(evaluateDurableApprovals(all).ok, true);
});

test('§17 evaluateLiveAttestations: every LIVE key attested + an on-call owner identity', () => {
  // onCallOwner is an identity (presence = attested), the rest are boolean attests.
  const missingOwner = evaluateLiveAttestations({ attests: LIVE_ATTESTATIONS, onCallOwner: null });
  assert.equal(missingOwner.ok, false);
  assert.ok(missingOwner.missing.includes('onCallOwner'));

  const missingAttest = evaluateLiveAttestations({ attests: ['noActiveIncident'], onCallOwner: 'kari@books.example' });
  assert.equal(missingAttest.ok, false);
  assert.ok(missingAttest.missing.includes('dashboardHealthy'));

  const complete = evaluateLiveAttestations({ attests: [...LIVE_ATTESTATIONS], onCallOwner: 'kari@books.example' });
  assert.equal(complete.ok, true);
});
