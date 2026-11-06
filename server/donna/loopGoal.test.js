// Tests for the goal runtime + the reconciliation goal evaluator + the scenario
// harness (the design proof for docs/loops-architecture-uplift-design.md).
// Pure / node --test only — no DB, no Inngest, no LLM.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  evaluateGoal,
  computeProgressFingerprint,
  detectNoProgress,
  shouldEscalateForNoProgress,
  deriveStopReason,
  classifyClosure,
  computeGoalSpecHash,
  buildLoopRunKey,
  buildGoalReportKey,
  buildCriterionCorrectionKey,
  GOAL_STATUSES,
  STOP_REASONS,
  CLOSURE_REASONS
} from './loopGoal.js';
import {
  evaluateReconciliationGoal,
  getLoopDefinition,
  RECONCILIATION_GAP_GOAL
} from './loopGoalRegistry.js';
import { runLoopGoalEval, runGoalScenario, scoreGoalScenario } from './loopGoalEvalHarness.js';

const spec = (criteria) => ({
  key: 'demo', version: '1', evaluatorType: 'deterministic', criteria
});

// ---- evaluateGoal lattice -------------------------------------------------

test('evaluateGoal: all required criteria met -> met', () => {
  const r = evaluateGoal(spec(['a', 'b']), [
    { key: 'a', status: 'met' }, { key: 'b', status: 'met' }
  ]);
  assert.equal(r.status, 'met');
  assert.equal(r.nextUnmetConditions.length, 0);
});

test('evaluateGoal: a waived criterion still counts as satisfied -> met', () => {
  const r = evaluateGoal(spec(['a', 'b']), [
    { key: 'a', status: 'met' }, { key: 'b', status: 'waived' }
  ]);
  assert.equal(r.status, 'met');
});

test('evaluateGoal: any required unmet (none impossible) -> unmet, with nextUnmetConditions', () => {
  const r = evaluateGoal(spec(['a', 'b']), [
    { key: 'a', status: 'met' },
    { key: 'b', status: 'unmet', nextCondition: 'firm must approve' }
  ]);
  assert.equal(r.status, 'unmet');
  assert.deepEqual(r.nextUnmetConditions, ['firm must approve']);
});

test('evaluateGoal: an impossible required criterion dominates unmet -> impossible', () => {
  const r = evaluateGoal(spec(['a', 'b']), [
    { key: 'a', status: 'unmet' }, { key: 'b', status: 'impossible' }
  ]);
  assert.equal(r.status, 'impossible');
});

test('evaluateGoal: some indeterminate, none unmet/impossible -> indeterminate', () => {
  const r = evaluateGoal(spec(['a', 'b']), [
    { key: 'a', status: 'met' }, { key: 'b', status: 'indeterminate' }
  ]);
  assert.equal(r.status, 'indeterminate');
});

test('evaluateGoal: a missing criterion result is treated as indeterminate, never silently met', () => {
  const r = evaluateGoal(spec(['a', 'b']), [{ key: 'a', status: 'met' }]);
  assert.equal(r.status, 'indeterminate');
  const b = r.criteria.find((c) => c.key === 'b');
  assert.equal(b.status, 'indeterminate');
});

test('evaluateGoal: an optional unmet criterion does not block the goal', () => {
  const r = evaluateGoal(spec([{ key: 'a', required: true }, { key: 'b', required: false }]), [
    { key: 'a', status: 'met' }, { key: 'b', status: 'unmet' }
  ]);
  assert.equal(r.status, 'met');
});

test('evaluateGoal: goal-level waiver -> waived (a human waived the whole objective)', () => {
  const r = evaluateGoal(spec(['a']), [{ key: 'a', status: 'unmet' }], { waived: true });
  assert.equal(r.status, 'waived');
});

test('evaluateGoal: a criterion result for an unknown key is REFUSED (hallucinated-key discipline)', () => {
  assert.throws(
    () => evaluateGoal(spec(['a']), [{ key: 'a', status: 'met' }, { key: 'ghost', status: 'met' }]),
    /unknown key "ghost"/
  );
});

test('evaluateGoal: a GoalSpec with no version is refused (goals are versioned — INV-14)', () => {
  assert.throws(() => evaluateGoal({ key: 'x', criteria: ['a'] }, []), /version is required/);
});

test('evaluateGoal: evaluatorVersion + snapshotId ride the report (the model id is the receipt)', () => {
  const r = evaluateGoal(spec(['a']), [{ key: 'a', status: 'met' }],
    { evaluatorVersion: 'recon-v3', snapshotId: 'snap_42' });
  assert.equal(r.evaluatorVersion, 'recon-v3');
  assert.equal(r.evaluatedFromSnapshotId, 'snap_42');
  assert.ok(GOAL_STATUSES.includes(r.status));
});

// ---- spec snapshot + idempotency keys (INV-17 / §13.4-13.5) --------------

test('computeGoalSpecHash: stable for identical content, changes with version or criteria', () => {
  const a = computeGoalSpecHash(spec(['x', 'y']));
  const same = computeGoalSpecHash({ key: 'demo', version: '1', evaluatorType: 'deterministic', criteria: ['x', 'y'] });
  const bumped = computeGoalSpecHash({ key: 'demo', version: '2', criteria: ['x', 'y'] });
  const changed = computeGoalSpecHash(spec(['x', 'z']));
  assert.equal(a, same, 'same content -> same hash (replay anchors on content, not label)');
  assert.notEqual(a, bumped, 'a version bump changes the hash');
  assert.notEqual(a, changed, 'a criteria change under the same version changes the hash');
});

test('buildLoopRunKey: deterministic per (case, trigger event); refuses partial input', () => {
  assert.equal(buildLoopRunKey({ caseId: 'c1', triggerEventId: 'e1' }), 'run:c1:e1');
  assert.throws(() => buildLoopRunKey({ caseId: 'c1' }), /needs caseId/);
});

test('buildGoalReportKey: one report per run, else the full reproducibility vector', () => {
  assert.equal(buildGoalReportKey({ loopRunId: 'r1' }), 'report:r1');
  const vector = buildGoalReportKey({
    caseId: 'c1', snapshotId: 's1', goalKey: 'g', goalVersion: '1',
    evaluatorVersion: 'v3', progressFingerprint: 'fp'
  });
  assert.equal(vector, 'report:c1:s1:g:1:v3:fp');
  assert.throws(() => buildGoalReportKey({ caseId: 'c1' }), /needs loopRunId/);
});

test('buildCriterionCorrectionKey: idempotent per (report, criterion, actor, event)', () => {
  const k = buildCriterionCorrectionKey({
    goalReportId: 'gr1', criterionKey: 'evidence_sufficient', actorId: 'u1', correctionEventId: 'ev1'
  });
  assert.equal(k, 'correction:gr1:evidence_sufficient:u1:ev1');
});

// ---- progress / no-progress (INV-15) -------------------------------------

test('computeProgressFingerprint: stable across key/blocker ordering, sensitive to status change', () => {
  const a = computeProgressFingerprint({
    goalStatus: 'unmet',
    criteria: [{ key: 'x', status: 'unmet' }, { key: 'y', status: 'met' }],
    ownerType: 'firm', openBlockerTypes: ['unclear_match', 'missing_document'], proposalId: 'p1'
  });
  const reordered = computeProgressFingerprint({
    goalStatus: 'unmet',
    criteria: [{ key: 'y', status: 'met' }, { key: 'x', status: 'unmet' }],
    ownerType: 'firm', openBlockerTypes: ['missing_document', 'unclear_match'], proposalId: 'p1'
  });
  const moved = computeProgressFingerprint({
    goalStatus: 'unmet',
    criteria: [{ key: 'x', status: 'met' }, { key: 'y', status: 'met' }],
    ownerType: 'firm', openBlockerTypes: ['unclear_match', 'missing_document'], proposalId: 'p1'
  });
  assert.equal(a, reordered, 'ordering must not change the fingerprint');
  assert.notEqual(a, moved, 'a criterion status change must change the fingerprint');
});

test('detectNoProgress: identical fingerprints = no progress; a change = progress', () => {
  assert.equal(detectNoProgress('abc', 'abc'), true);
  assert.equal(detectNoProgress('abc', 'def'), false);
  assert.equal(detectNoProgress(null, 'abc'), false);
});

test('shouldEscalateForNoProgress: stops once consecutive no-progress runs hit the policy max', () => {
  const policy = { maxNoProgressRuns: 2 };
  assert.equal(shouldEscalateForNoProgress(1, policy), false);
  assert.equal(shouldEscalateForNoProgress(2, policy), true);
  assert.equal(shouldEscalateForNoProgress(0, {}), false); // default max 2
});

// ---- stop reason + three-axis closure ------------------------------------

test('deriveStopReason: precedence superseded > failed > goal_met > budget > no_progress > authority > waiting', () => {
  const met = { status: 'met' };
  const unmet = { status: 'unmet' };
  assert.equal(deriveStopReason({ goalReport: met, superseded: true }), 'superseded');
  assert.equal(deriveStopReason({ goalReport: met, failed: true }), 'failed');
  assert.equal(deriveStopReason({ goalReport: met }), 'goal_met');
  assert.equal(deriveStopReason({ goalReport: unmet, budgetExhausted: true }), 'budget_exhausted');
  assert.equal(deriveStopReason({ goalReport: unmet, noProgress: true }), 'no_progress');
  assert.equal(deriveStopReason({ goalReport: unmet }), 'authority_required');
  assert.equal(deriveStopReason({ goalReport: { status: 'indeterminate' } }), 'waiting');
  assert.ok(STOP_REASONS.includes(deriveStopReason({ goalReport: met })));
});

test('classifyClosure: goal_met -> resolved + achieved + goal_met (the happy path)', () => {
  const c = classifyClosure({ goalReport: { status: 'met' }, stopReason: 'goal_met' });
  assert.deepEqual(c, { case_status: 'resolved', goal_status: 'achieved', closure_reason: 'goal_met', terminal: true });
});

test('classifyClosure: a waived goal closes as goal_waived, not goal_met', () => {
  const c = classifyClosure({ goalReport: { status: 'waived' }, stopReason: 'goal_met' });
  assert.equal(c.goal_status, 'waived');
  assert.equal(c.closure_reason, 'goal_waived');
});

test('classifyClosure: NO-PROGRESS stop is terminal (escalates) yet goal is NOT achieved — stopping != success (feedback #9)', () => {
  const c = classifyClosure({ goalReport: { status: 'unmet' }, stopReason: 'no_progress' });
  assert.equal(c.terminal, true);
  assert.equal(c.case_status, 'engineering_escalated');
  assert.equal(c.goal_status, 'not_achieved');
  assert.equal(c.closure_reason, 'engineering_escalation');
  assert.ok(CLOSURE_REASONS.includes(c.closure_reason));
});

test('classifyClosure: authority_required waits (non-terminal), goal still pending/not-achieved', () => {
  const c = classifyClosure({ goalReport: { status: 'unmet' }, stopReason: 'authority_required' });
  assert.equal(c.terminal, false);
  assert.equal(c.case_status, 'waiting_firm');
  assert.equal(c.closure_reason, null);
});

// ---- the reconciliation goal evaluator (the centralized projection) -------

test('reconciliation: INV-4 — a sticky match settles the target despite a no_match verdict', () => {
  const { goalReport, action, desiredCase } = evaluateReconciliationGoal({
    verdict: 'no_match', hasStickyMatch: true
  });
  assert.equal(goalReport.status, 'met');
  assert.equal(action, 'resolve_gap');
  assert.equal(desiredCase, null);
});

test('reconciliation: auto_explained suppresses the case EXPLICITLY (met, noop) — not by filter omission', () => {
  const { goalReport, action, desiredCase } = evaluateReconciliationGoal({ verdict: 'auto_explained' });
  assert.equal(goalReport.status, 'met');
  assert.equal(action, 'noop');
  assert.equal(desiredCase, null);
});

test('reconciliation: no_match opens an unclear_match firm gap', () => {
  const { goalReport, action, desiredCase } = evaluateReconciliationGoal({ verdict: 'no_match' });
  assert.equal(goalReport.status, 'unmet');
  assert.equal(action, 'open_gap');
  assert.deepEqual(desiredCase, {
    caseType: 'reconciliation', blockerType: 'unclear_match', ownerType: 'firm', gapKind: 'unmatched_verdict'
  });
});

test('reconciliation: a no_match with reason already_settled is MET (settled, resolve_gap) — not a firm gap', () => {
  // The strong matcher returns no_match + already_settled when the obligation is
  // already accounted for by other bank lines. That is DONE, not a "no matching bank
  // line" gap — project it as met + resolve_gap so it never opens (and closes) a blocker.
  const { goalReport, action, desiredCase } = evaluateReconciliationGoal({
    verdict: 'no_match', unmatchableReason: 'already_settled'
  });
  assert.equal(goalReport.status, 'met');
  assert.equal(action, 'resolve_gap');
  assert.equal(desiredCase, null);
  // a genuine no_match (any other reason) is still an open firm gap
  const genuine = evaluateReconciliationGoal({ verdict: 'no_match', unmatchableReason: 'no_plausible_match' });
  assert.equal(genuine.action, 'open_gap');
});

test('reconciliation: a document no_match whose amount a SETTLED line covers is MET (resolve_gap), not firm limbo', () => {
  // The Failure-B smaller half: a receipt the weighted matcher returned
  // 'no_plausible_match' for, but whose amount is already accounted for by a settled
  // bank line (caller-confirmed via coveredBySettledLine). It is corroboration of a
  // closed line, NOT firm work — resolve, never open waiting_firm limbo.
  const covered = evaluateReconciliationGoal({
    verdict: 'no_match', unmatchableReason: 'no_plausible_match', coveredBySettledLine: true
  });
  assert.equal(covered.goalReport.status, 'met');
  assert.equal(covered.action, 'resolve_gap');
  assert.equal(covered.desiredCase, null);
  // Same verdict WITHOUT a settled line covering it is still a genuine firm gap.
  const uncovered = evaluateReconciliationGoal({
    verdict: 'no_match', unmatchableReason: 'no_plausible_match', coveredBySettledLine: false
  });
  assert.equal(uncovered.action, 'open_gap');
  assert.equal(uncovered.desiredCase.ownerType, 'firm');
  // A disposition (owner) reason still routes to the client even if a settled line
  // happens to share the amount — the owner question is about THIS line, not a match.
  const ownerReason = evaluateReconciliationGoal({
    verdict: 'no_match', unmatchableReason: 'receipt_needed', coveredBySettledLine: true
  });
  assert.equal(ownerReason.desiredCase.ownerType, 'client');
});

test('reconciliation: a disposition no_match rests on the OWNER (waiting_client), never firm limbo', () => {
  // The two-terminal FIRST principle: a bare bank line the disposition pass could not
  // settle is a question only the business OWNER can answer (what is this / where is the
  // receipt / the payout report). Each disposition reason opens a CLIENT-owned gap; the
  // close hook still resolves it on a later match (blockerType stays unclear_match).
  for (const reason of ['needs_human_review', 'receipt_needed', 'evidence_needed']) {
    const { action, desiredCase } = evaluateReconciliationGoal({ verdict: 'no_match', unmatchableReason: reason });
    assert.equal(action, 'open_gap', `${reason} opens a gap`);
    assert.deepEqual(desiredCase, {
      caseType: 'reconciliation', blockerType: 'unclear_match', ownerType: 'client', gapKind: 'unmatched_verdict'
    }, `${reason} → owner-owned (waiting_client), not waiting_firm`);
  }
  // A document-anchored no_match (any non-disposition reason) is still genuine FIRM work.
  const docGap = evaluateReconciliationGoal({ verdict: 'no_match', unmatchableReason: 'no_plausible_match' });
  assert.equal(docGap.desiredCase.ownerType, 'firm', 'document no_match stays firm');
});

test('reconciliation: no_candidates is TYPED as missing_bank_statement (the divergence made explicit)', () => {
  const { desiredCase } = evaluateReconciliationGoal({ verdict: 'no_candidates' });
  assert.equal(desiredCase.blockerType, 'missing_bank_statement');
  assert.equal(desiredCase.gapKind, 'unmatched_verdict');
});

test('reconciliation: an unpaid obligation with no verdict/match opens unevaluated_obligation', () => {
  const { action, desiredCase } = evaluateReconciliationGoal({
    verdict: null, hasEvaluation: false, hasAnyMatch: false, paymentStatus: 'unpaid'
  });
  assert.equal(action, 'open_gap');
  assert.equal(desiredCase.gapKind, 'unevaluated_obligation');
});

test('reconciliation: a proposed match leaves the goal indeterminate and opens no new gap', () => {
  const { goalReport, action, desiredCase } = evaluateReconciliationGoal({ verdict: 'proposed' });
  assert.equal(goalReport.status, 'indeterminate');
  assert.equal(action, 'noop');
  assert.equal(desiredCase, null);
});

test('reconciliation: the goal report validates against the registered GoalSpec', () => {
  const { goalReport } = evaluateReconciliationGoal({ verdict: 'no_match' });
  assert.equal(goalReport.goalKey, RECONCILIATION_GAP_GOAL.key);
  assert.equal(goalReport.goalVersion, RECONCILIATION_GAP_GOAL.version);
  assert.equal(goalReport.criteria.length, 1);
});

test('registry: the reconciliation LoopDefinition is resolvable and bounded (INV-15)', () => {
  const def = getLoopDefinition('reconciliation_gap_resolution', '1');
  assert.ok(def);
  assert.equal(def.executionPolicy.maxModelCallsPerWake, 0); // workflow-only
  assert.equal(def.executionPolicy.maxNoProgressRuns, 2);
});

test('reconciliation regression: a settled target whose match is later rejected re-evaluates to unmet — "met once" is not "met forever" (§13.10)', () => {
  // First wake: a sticky match settles the target -> goal met.
  const first = evaluateReconciliationGoal({ verdict: 'no_match', hasStickyMatch: true });
  assert.equal(first.goalReport.status, 'met');
  const snapshotOfFirstReport = JSON.stringify(first.goalReport);

  // Regression event: the match is rejected, so the target is unsettled again
  // and the standing no_match verdict governs. A FRESH report is produced.
  const second = evaluateReconciliationGoal({ verdict: 'no_match', hasStickyMatch: false });
  assert.equal(second.goalReport.status, 'unmet');
  assert.equal(second.action, 'open_gap');

  // The prior report is a distinct, untouched object (append-only receipt: a new
  // report supersedes it; it is never mutated in place).
  assert.notEqual(first.goalReport, second.goalReport);
  assert.equal(JSON.stringify(first.goalReport), snapshotOfFirstReport, 'the prior met report must be immutable');
});

// ---- the scenario harness over the designed corpus ------------------------

test('scoreGoalScenario: a full match passes; a single mismatch fails', () => {
  const fixture = { expected: { goal_status: 'unmet', action: 'open_gap' } };
  assert.equal(scoreGoalScenario(fixture, { goal_status: 'unmet', action: 'open_gap' }).status, 'pass');
  const bad = scoreGoalScenario(fixture, { goal_status: 'met', action: 'open_gap' });
  assert.equal(bad.status, 'fail');
  assert.equal(bad.falseNegative, 1);
});

test('runGoalScenario: derives the stop reason a LoopRun would (open_gap -> authority_required)', () => {
  const def = getLoopDefinition('reconciliation_gap_resolution', '1');
  const out = runGoalScenario(def, { input: { verdict: 'no_match' } });
  assert.equal(out.action, 'open_gap');
  assert.equal(out.stop_reason, 'authority_required');
});

test('runLoopGoalEval: the whole designed scenario corpus passes against the evaluator', async () => {
  const result = await runLoopGoalEval({});
  assert.ok(result.totals.fixtures >= 6, 'corpus should have at least 6 scenarios');
  assert.equal(result.totals.errored, 0);
  assert.equal(result.totals.failed, 0, `failing scenarios: ${result.cases.filter((c) => c.status !== 'pass').map((c) => c.id).join(', ')}`);
  assert.equal(result.metrics.accuracy, 1);
});
