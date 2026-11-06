// Tests for the Loops goal-regression / reopen decision (goal-first uplift,
// design §13.10). Pure / node --test only — no DB, no Inngest, no LLM. Covers the
// "met once is not met forever" gate: when a regression event reopens a terminal
// case vs bumps an open one vs is ignored, the immutable prior-report reference
// (INV-17), the idempotency key, and the fresh superseding evaluation.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  REGRESSION_KINDS,
  REGRESSION_DECISIONS,
  ACHIEVED_GOAL_STATUSES,
  validateRegressionEvent,
  buildRegressionKey,
  decideRegression,
  mintSupersedingReport,
  nextCaseVersion
} from './loopGoalRegression.js';

// A met GoalReport (the thing a regression un-meets).
const metReport = { id: 'gr-1', goalKey: 'reconcile', goalVersion: 'v1', status: 'met' };
const matchRejected = { id: 'ev-1', kind: 'match_rejected' };

// ---- vocabulary -----------------------------------------------------------

test('vocabulary is the §13.10 cause/decision/achieved set', () => {
  assert.deepEqual(REGRESSION_KINDS,
    ['match_rejected', 'document_corrected', 'posting_voided', 'evidence_retracted']);
  assert.deepEqual(REGRESSION_DECISIONS, ['reopen', 'new_case_version', 'ignore']);
  assert.deepEqual(ACHIEVED_GOAL_STATUSES, ['met', 'waived']);
});

// ---- event validation -----------------------------------------------------

test('validateRegressionEvent: normalizes a known kind; objectiveChanged defaults from kind', () => {
  const e = validateRegressionEvent({ id: 5, kind: 'match_rejected' });
  assert.equal(e.id, '5');                 // coerced to string
  assert.equal(e.kind, 'match_rejected');
  assert.equal(e.objectiveChanged, false); // a rejected match does not move the target
  assert.equal(e.supersedesReportId, null);

  // document_corrected is objective-changing by default...
  assert.equal(validateRegressionEvent({ id: '1', kind: 'document_corrected' }).objectiveChanged, true);
  // ...but an explicit hint overrides the kind default.
  assert.equal(
    validateRegressionEvent({ id: '1', kind: 'document_corrected', objectiveChanged: false }).objectiveChanged,
    false
  );
});

test('validateRegressionEvent: refuses a missing id and an unknown kind', () => {
  assert.throws(() => validateRegressionEvent({ kind: 'match_rejected' }), /needs an id/);
  assert.throws(() => validateRegressionEvent({ id: '1', kind: 'vibes' }), /unknown — refused/);
  assert.throws(() => validateRegressionEvent(null), /must be an object/);
});

test('buildRegressionKey is deterministic and needs both ids', () => {
  assert.equal(buildRegressionKey({ caseId: 'c1', regressionEventId: 'e1' }), 'regress:c1:e1');
  assert.throws(() => buildRegressionKey({ caseId: 'c1' }), /needs caseId \+ regressionEventId/);
});

// ---- decideRegression: the act decisions ----------------------------------

test('decideRegression: a terminal met case REOPENS (version++ ; prior report kept)', () => {
  const d = decideRegression({
    caseStatus: 'resolved',
    currentGoalReport: metReport,
    regressionEvent: matchRejected,
    caseVersion: 3,
    asOf: 1000
  });
  assert.equal(d.decision, 'reopen');
  assert.equal(d.reason, 'terminal_case_regressed');
  assert.equal(d.fromTerminal, true);
  assert.equal(d.nextCaseVersion, 4);
  assert.equal(d.supersededReportId, 'gr-1'); // referenced, never mutated (INV-17)
  assert.equal(d.mints, 'superseding_goal_report');
  assert.equal(d.regressionKey, 'regress:unknown:ev-1'); // no caseId on the event
  assert.equal(d.decidedAt, 1000);
  // the prior report object is untouched by the decision.
  assert.equal(metReport.status, 'met');
});

test('decideRegression: an explicit terminal=true wins over caseStatus', () => {
  const d = decideRegression({
    caseStatus: 'open',          // would derive non-terminal...
    terminal: true,              // ...but the explicit flag wins
    currentGoalReport: metReport,
    regressionEvent: matchRejected,
    caseVersion: 1
  });
  assert.equal(d.decision, 'reopen');
});

test('decideRegression: a still-open met case mints a NEW CASE VERSION', () => {
  const d = decideRegression({
    caseStatus: 'waiting_system',
    currentGoalReport: { id: 'gr-9', status: 'waived' }, // waived is also "achieved"
    regressionEvent: { id: 'ev-2', kind: 'evidence_retracted' },
    caseVersion: 7
  });
  assert.equal(d.decision, 'new_case_version');
  assert.equal(d.reason, 'open_case_regressed');
  assert.equal(d.fromTerminal, false);
  assert.equal(d.nextCaseVersion, 8);
  assert.equal(d.supersededReportId, 'gr-9');
});

test('decideRegression: objectiveChanged rides the receipt without changing the strategy', () => {
  const d = decideRegression({
    terminal: true,
    currentGoalReport: metReport,
    regressionEvent: { id: 'ev-3', kind: 'document_corrected' },
    caseVersion: 2
  });
  assert.equal(d.decision, 'reopen');         // terminality, not kind, picks the strategy
  assert.equal(d.objectiveChanged, true);     // but the hint is carried for spec re-resolution
});

// ---- decideRegression: the ignore gate ------------------------------------

test('decideRegression: no current report -> ignore', () => {
  const d = decideRegression({
    terminal: true, currentGoalReport: null, regressionEvent: matchRejected, caseVersion: 1
  });
  assert.equal(d.decision, 'ignore');
  assert.equal(d.reason, 'no_current_report');
  assert.equal(d.nextCaseVersion, null);
  assert.equal(d.mints, null);
});

test('decideRegression: a goal that was never achieved -> ignore (nothing to un-meet)', () => {
  for (const status of ['unmet', 'indeterminate', 'impossible']) {
    const d = decideRegression({
      terminal: true,
      currentGoalReport: { id: 'gr', status },
      regressionEvent: matchRejected,
      caseVersion: 1
    });
    assert.equal(d.decision, 'ignore');
    assert.equal(d.reason, 'goal_not_achieved');
  }
});

test('decideRegression: a stale event (targets a superseded report) -> ignore', () => {
  const d = decideRegression({
    terminal: true,
    currentGoalReport: metReport, // latest is gr-1
    regressionEvent: { id: 'ev-4', kind: 'match_rejected', supersedesReportId: 'gr-OLD' },
    caseVersion: 1
  });
  assert.equal(d.decision, 'ignore');
  assert.equal(d.reason, 'stale_event');
});

test('decideRegression: a matching supersedesReportId is NOT stale -> acts', () => {
  const d = decideRegression({
    terminal: true,
    currentGoalReport: metReport,
    regressionEvent: { id: 'ev-5', kind: 'match_rejected', supersedesReportId: 'gr-1' },
    caseVersion: 1
  });
  assert.equal(d.decision, 'reopen');
});

// ---- decideRegression: input discipline -----------------------------------

test('decideRegression: needs terminal or caseStatus; refuses an unknown event kind', () => {
  assert.throws(() => decideRegression({
    currentGoalReport: metReport, regressionEvent: matchRejected, caseVersion: 1
  }), /needs `terminal` .* or `caseStatus`/);

  assert.throws(() => decideRegression({
    terminal: true,
    currentGoalReport: metReport,
    regressionEvent: { id: 'x', kind: 'nope' },
    caseVersion: 1
  }), /unknown — refused/);
});

test('decideRegression: an act decision validates the case version (positive int)', () => {
  assert.throws(() => decideRegression({
    terminal: true, currentGoalReport: metReport, regressionEvent: matchRejected, caseVersion: 0
  }), /positive integer/);
  // ignore decisions never bump, so they tolerate an absent version.
  assert.doesNotThrow(() => decideRegression({
    terminal: true, currentGoalReport: null, regressionEvent: matchRejected
  }));
});

test('decideRegression: a corrupt current status throws (refuse, do not mis-gate)', () => {
  assert.throws(() => decideRegression({
    terminal: true,
    currentGoalReport: { id: 'g', status: 'totally_done' },
    regressionEvent: matchRejected,
    caseVersion: 1
  }), /invalid/);
});

// ---- mintSupersedingReport: the fresh evaluation --------------------------

const spec = { key: 'reconcile', version: 'v1', criteria: ['matched'] };

test('mintSupersedingReport: a fresh unmet evaluation supersedes the prior met report', () => {
  const { report, regressed } = mintSupersedingReport({
    goalSpec: spec,
    criterionResults: [{ key: 'matched', status: 'unmet' }],
    supersededReportId: 'gr-1',
    evaluatorVersion: 'claude-opus-4-8'
  });
  assert.equal(report.status, 'unmet');
  assert.equal(report.supersedes, 'gr-1');          // points at the prior report
  assert.equal(report.evaluatorVersion, 'claude-opus-4-8'); // the model id is the receipt
  assert.equal(regressed, true);
});

test('mintSupersedingReport: re-evaluating back to met reports regressed=false (never forced)', () => {
  // The criteria recovered (or the event did not actually invalidate the goal):
  // we do NOT force an unmet verdict the criteria do not support.
  const { report, regressed } = mintSupersedingReport({
    goalSpec: spec,
    criterionResults: [{ key: 'matched', status: 'met' }],
    supersededReportId: 'gr-1'
  });
  assert.equal(report.status, 'met');
  assert.equal(report.supersedes, 'gr-1');
  assert.equal(regressed, false);
});

test('mintSupersedingReport: a missing prior id is carried as null', () => {
  const { report } = mintSupersedingReport({
    goalSpec: spec,
    criterionResults: [{ key: 'matched', status: 'indeterminate' }]
  });
  assert.equal(report.supersedes, null);
});

// ---- re-export sanity -----------------------------------------------------

test('nextCaseVersion is re-exported from loopRun', () => {
  assert.equal(nextCaseVersion(4), 5);
});
