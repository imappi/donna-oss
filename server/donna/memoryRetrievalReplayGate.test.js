// Donna — BizOS Slice 2c-iii (sub-PR 8): the replay gate. Proves binding
// auto-invalidation (test 14), classified adds/drops (amendment 5), the §N-B
// 50/10/7 gate + internal exception, the mandatory synthetic suite, and the §N-C
// activation-tuple identity (test 17).

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CUSTOMER_GATE_THRESHOLDS,
  INTERNAL_GATE_THRESHOLDS,
  buildReplayBinding,
  replayBindingFingerprint,
  replayArtifactCurrent,
  classifyDiffItem,
  runSyntheticAdversarialSuite,
  evaluateReplayGate,
  buildActivationRecord,
  buildCanaryLaunchReceipt,
  computeArtifactDigest
} from './memoryRetrievalReplayGate.js';

const binding = (over = {}) => buildReplayBinding({ commitSha: 'abc123', configSnapshotId: 'cfg-1', clientId: 'c1', audience: 'owner', purpose: 'portal_owner_context', inputRevisionSet: ['m1@1', 'm2@3'], ...over });
// §17: a green artifact carries binding-covered generated_at + expires_at.
const greenArtifact = (b = binding(), over = {}) => ({ binding: b, passed: true, generated_at: '2026-07-13T00:00:00.000Z', expires_at: '2026-07-20T00:00:00.000Z', ...over });

// A fully-green customer input set (with the lever's clock inside the freshness window).
const greenInputs = (over = {}) => ({
  realTurnCount: 60, sessionCount: 12, dayCount: 8,
  syntheticSuite: { total: 9, passed: 9 },
  diffItems: [{ category: 'expected_governed_drop' }, { category: 'expected_authorised_add' }],
  aclIntegrityFailureCount: 0,
  sentinelFoundInPayload: false,
  artifact: greenArtifact(), currentBinding: binding(),
  now: '2026-07-15T00:00:00.000Z',
  ...over
});

// ── binding + auto-invalidation (test 14) ──────────────────────────────────────

test('replayArtifactCurrent: matching binding is current', () => {
  assert.equal(replayArtifactCurrent(greenArtifact(), binding()), true);
});

test('replayArtifactCurrent: a changed commit invalidates (test 14)', () => {
  assert.equal(replayArtifactCurrent(greenArtifact(binding({ commitSha: 'abc123' })), binding({ commitSha: 'def456' })), false);
});

test('replayArtifactCurrent: a changed config snapshot invalidates', () => {
  assert.equal(replayArtifactCurrent(greenArtifact(binding({ configSnapshotId: 'cfg-1' })), binding({ configSnapshotId: 'cfg-2' })), false);
});

test('replayArtifactCurrent: a changed input-revision-set invalidates', () => {
  assert.equal(replayArtifactCurrent(greenArtifact(binding({ inputRevisionSet: ['m1@1'] })), binding({ inputRevisionSet: ['m1@2'] })), false);
});

test('buildReplayBinding: pins the runtime versions (not re-typed)', () => {
  const b = binding();
  assert.ok(b.policy_version && b.renderer_version && b.ranker_version && b.purpose_registry_fingerprint);
  assert.ok(replayBindingFingerprint(b).startsWith('replay-'));
});

// ── classified adds/drops (amendment 5) ────────────────────────────────────────

test('classifyDiffItem: expected drops/adds do not block; critical/unauthorised/unclassified block', () => {
  assert.equal(classifyDiffItem({ category: 'expected_governed_drop' }).blocks, false);
  assert.equal(classifyDiffItem({ category: 'expected_authorised_add' }).blocks, false);
  assert.equal(classifyDiffItem({ category: 'ranking_only' }).blocks, false);
  assert.equal(classifyDiffItem({ category: 'unexpected_critical_drop' }).blocks, true);
  assert.equal(classifyDiffItem({ category: 'unauthorised_add' }).blocks, true);
  assert.equal(classifyDiffItem({ category: 'weird' }).blocks, true, 'unclassified fails closed');
  assert.equal(classifyDiffItem({}).category, 'unclassified');
});

// ── synthetic suite ─────────────────────────────────────────────────────────────

test('runSyntheticAdversarialSuite: all checks pass on the shipped modules', () => {
  const s = runSyntheticAdversarialSuite();
  assert.ok(s.total >= 8);
  assert.equal(s.passed, s.total, JSON.stringify(s.failures));
});

// ── gate evaluation (§N-B) ──────────────────────────────────────────────────────

test('evaluateReplayGate: a fully-green customer input set passes', () => {
  const r = evaluateReplayGate(greenInputs());
  assert.equal(r.passed, true, JSON.stringify(r.failures));
  assert.equal(r.internal_only, false);
});

test('evaluateReplayGate: below 50/10/7 fails (synthetic does not count)', () => {
  const r = evaluateReplayGate(greenInputs({ realTurnCount: 49 }));
  assert.equal(r.passed, false);
  assert.ok(r.failures.some((f) => /real turns/.test(f)));
});

test('evaluateReplayGate: an unauthorised add blocks; ACL/integrity failure blocks', () => {
  assert.equal(evaluateReplayGate(greenInputs({ diffItems: [{ category: 'unauthorised_add' }] })).passed, false);
  assert.equal(evaluateReplayGate(greenInputs({ aclIntegrityFailureCount: 1 })).passed, false);
});

test('evaluateReplayGate: an unclassified diff item blocks (fail closed)', () => {
  const r = evaluateReplayGate(greenInputs({ diffItems: [{ category: 'mystery' }] }));
  assert.equal(r.passed, false);
  assert.ok(r.failures.some((f) => /unclassified/.test(f)));
});

test('evaluateReplayGate: a sentinel in the payload blocks', () => {
  assert.equal(evaluateReplayGate(greenInputs({ sentinelFoundInPayload: true })).passed, false);
});

test('evaluateReplayGate: a stale artifact (binding mismatch) blocks (test 14 at the gate)', () => {
  const r = evaluateReplayGate(greenInputs({ currentBinding: binding({ commitSha: 'moved-on' }) }));
  assert.equal(r.passed, false);
  assert.ok(r.failures.some((f) => /artifact/.test(f)));
});

// ── freshness (§17) — lever-clocked expiry over binding-covered artifact fields ──

test('evaluateReplayGate: an artifact past expiry under the lever clock blocks', () => {
  const r = evaluateReplayGate(greenInputs({ now: '2026-07-21T00:00:00.000Z' })); // after expires_at
  assert.equal(r.passed, false);
  assert.ok(r.failures.some((f) => /expired/.test(f)));
});

test('evaluateReplayGate: a missing generated_at/expires_at blocks (§17 freshness)', () => {
  const artifact = { binding: binding(), passed: true }; // no timestamps
  const r = evaluateReplayGate(greenInputs({ artifact }));
  assert.equal(r.passed, false);
  assert.ok(r.failures.some((f) => /generated_at\/expires_at/.test(f)));
});

test('evaluateReplayGate: no clock supplied still requires the freshness fields but skips expiry', () => {
  const r = evaluateReplayGate(greenInputs({ now: null }));
  assert.equal(r.passed, true, JSON.stringify(r.failures));
});

test('evaluateReplayGate: synthetic suite not 100% blocks', () => {
  assert.equal(evaluateReplayGate(greenInputs({ syntheticSuite: { total: 9, passed: 8 } })).passed, false);
});

test('evaluateReplayGate: internal entity uses 20/5/3 and is marked internal_only', () => {
  const r = evaluateReplayGate(greenInputs({ realTurnCount: 20, sessionCount: 5, dayCount: 3, internalEntity: true }));
  assert.equal(r.passed, true, JSON.stringify(r.failures));
  assert.equal(r.internal_only, true);
  assert.equal(r.thresholds.realTurns, INTERNAL_GATE_THRESHOLDS.realTurns);
  // the same 20/5/3 does NOT pass a customer gate
  assert.equal(evaluateReplayGate(greenInputs({ realTurnCount: 20, sessionCount: 5, dayCount: 3 })).passed, false);
});

test('thresholds are 50/10/7 (customer) and 20/5/3 (internal)', () => {
  assert.deepEqual(CUSTOMER_GATE_THRESHOLDS, { realTurns: 50, sessions: 10, days: 7 });
  assert.deepEqual(INTERNAL_GATE_THRESHOLDS, { realTurns: 20, sessions: 5, days: 3 });
});

// ── activation record (§N-C, test 17) ──────────────────────────────────────────

test('buildActivationRecord: records the FULL tuple even when invoked with --client only', () => {
  const rec = buildActivationRecord({ firmId: 'f1', clientId: 'c1', binding: binding(), gate: evaluateReplayGate(greenInputs()) });
  assert.deepEqual(rec.activation_tuple, { client_id: 'c1', audience: 'owner', purpose: 'portal_owner_context' });
  assert.equal(rec.gate_passed, true);
  assert.ok(rec.replay_artifact_fingerprint.startsWith('replay-'));
});

// ── §17 launch receipt — live state kept OUT of the artifact ────────────────────

test('buildCanaryLaunchReceipt: binds to the artifact by digest + records the live group only', () => {
  const artifact = greenArtifact();
  const rec = buildCanaryLaunchReceipt({
    firmId: 'f1', clientId: 'c1', artifact,
    liveAttestations: { noActiveIncident: true, dashboardHealthy: true },
    onCallOwner: 'kari@books.example', attestedAt: '2026-07-15T00:00:00.000Z'
  });
  assert.equal(rec.schema, 'memret.canary.launch_receipt.v1');
  assert.deepEqual(rec.activation_tuple, { client_id: 'c1', audience: 'owner', purpose: 'portal_owner_context' });
  assert.ok(rec.replay_artifact_digest.startsWith('artifact-'));
  assert.equal(rec.replay_artifact_digest, computeArtifactDigest(artifact), 'digest binds the exact artifact');
  assert.equal(rec.on_call_owner, 'kari@books.example');
  assert.equal(rec.live_attestations.noActiveIncident, true);
  // The live group is NOT the replay evidence — the receipt carries no diff/metrics.
  assert.equal(rec.diff_items, undefined);
});

test('computeArtifactDigest: a changed artifact changes the digest', () => {
  assert.notEqual(computeArtifactDigest(greenArtifact()), computeArtifactDigest(greenArtifact(binding(), { generated_at: '2026-07-14T00:00:00.000Z' })));
});
