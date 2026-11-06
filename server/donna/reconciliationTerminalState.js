// Donna Loops — the single reconciliation terminal-state derivation (uplift Step 4).
//
// See docs/loops-architecture-uplift-design.md §10 (Step 4) + §8 + INV-13, and the
// CLAUDE.md rail "Render the persisted verdict, not the legacy layer". A reconciliation
// line's terminal state must be backed by the PERSISTED pipeline verdict — the
// append-only loop_goal_reports row a LoopRun wrote (Step 3) — never by the legacy
// transactions.reconciliation_status column the verdict superseded, and never by a
// fresh render-time inference. This module is that one projection: given the latest
// GoalReport for a target's reconciliation case, it returns the terminal state a feed
// row should render. When a verdict is present it OUTRANKS the legacy column; when no
// verdict exists (pre-037, or LOOPS_SHADOW never produced one) it defers to the legacy
// value, so the change is additive and inert until the goal layer is producing reports.
//
// This is the structural #315 kill: a surface can no longer render the legacy field
// OVER the verdict, because the derivation returns the verdict and only falls back to
// legacy in its ABSENCE. Pure / dependency-free (the judgment ran upstream in the
// registry evaluator + reconciliationLlmCore); this only PROJECTS it, like
// bankLineDispositionShape.js. Nothing here calls an LLM or touches a DB.

export const RECONCILIATION_TERMINAL_SOURCES = ['goal_report', 'legacy'];

// The reconciliation gap goal (loopGoalRegistry.RECONCILIATION_GAP_GOAL) is binary:
//   met           → settled by a sticky match, OR explained as immaterial (auto_explained)
//   waived        → a human waived the whole goal (rendered as explained)
//   unmet         → a real gap the firm must resolve (needs_review)
//   impossible    → cannot be reconciled as-is → also a human gap (needs_review)
//   indeterminate → no terminal call yet → defer to the legacy column (no override)
//
// A GoalReport may arrive as the in-memory shape (camelCase nextUnmetConditions) or
// as a loop_goal_reports row (snake_case next_unmet_conditions, jsonb criteria); both
// are accepted so the same projection serves the writer and the reader.

// met splits on the criterion evidence: a sticky match RECONCILES the line, an
// auto_explained verdict EXPLAINS it. Defaults to 'reconciled' when unlabelled.
const metReconciliationStatus = (goalReport) => {
  for (const c of goalReport?.criteria || []) {
    if (Array.isArray(c?.evidenceRefs) && c.evidenceRefs.includes('auto_explained_verdict')) {
      return 'explained';
    }
  }
  return 'reconciled';
};

const nextUnmet = (goalReport) => {
  const v = goalReport?.next_unmet_conditions ?? goalReport?.nextUnmetConditions;
  return Array.isArray(v) ? v : [];
};

const legacy = (legacyStatus, goalStatus = null) => ({
  reconciliation_status: legacyStatus || null,
  goal_status: goalStatus,
  source: 'legacy',
  verdict_present: false,
  next_unmet_conditions: []
});

export const deriveReconciliationTerminalState = (goalReport, { legacyStatus = null } = {}) => {
  if (!goalReport || !goalReport.status) return legacy(legacyStatus);

  switch (goalReport.status) {
    case 'met':
      return {
        reconciliation_status: metReconciliationStatus(goalReport),
        goal_status: 'achieved', source: 'goal_report', verdict_present: true, next_unmet_conditions: []
      };
    case 'waived':
      return {
        reconciliation_status: 'explained',
        goal_status: 'waived', source: 'goal_report', verdict_present: true, next_unmet_conditions: []
      };
    case 'unmet':
    case 'impossible':
      return {
        reconciliation_status: 'needs_review',
        goal_status: 'not_achieved', source: 'goal_report', verdict_present: true,
        next_unmet_conditions: nextUnmet(goalReport)
      };
    case 'indeterminate':
    default:
      // No terminal verdict yet — do NOT override the legacy column (a pending
      // proposed match, or an unevaluated line). The legacy value stands.
      return legacy(legacyStatus, 'pending');
  }
};
