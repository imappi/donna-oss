// Donna — the consequence-diff engine (Accounting Runtime Hardening, Slice E).
//
// "Every mutation returns a consequence diff. NEVER just say 'done'." (CLAUDE.md
// L1.) This is that artifact: a machine-parseable account of an apply —
//   what changed · why · which invariant was checked · what looks suspicious
//   (MUST-FIX / MUST-REVIEW / WARNING) · before→after convergence · can this
//   commit, or must it stay proposed.
// It is how the runtime prevents silent ledger rot: an apply hands back this
// diff, not a bare success string.
//
// IT MINTS NO NEW HOME. Slice B pinned `consequence_diff` → APPLY_RECEIPT_SCHEMA /
// apply_receipts, and the diff's durable parts ALREADY persist there and on the
// card: the before/after state is the ProposalCard's `before_after`; the checks,
// per-target outcome, rows_touched and writer are the ApplyReceipt's existing
// fields. This module ASSEMBLES those persisted pieces into one diff VIEW and
// projects its persistable subset back onto the receipt shape (toApplyReceiptFields)
// — it never adds a column, a table, or a second receipt type. And it is NOT a
// second convergence verdict: the receipt answers "what changed + is it safe", the
// GoalReport answers "did the case reach a terminal" (uplift §4.3, pinned by Slice B).
//
// Pure leaf: imports ONLY operatorContract.js (CHECK_STATUSES + the appliability
// policy + the severity roll-up) so it runs in-sandbox under `node --test`. All
// inputs are PRE-COMPUTED and passed in (the card, the Slice-D CheckReport, the
// writer's per-target outcome, the Slice-C convergence verdicts) — no DB, no LLM.

import {
  CHECK_STATUSES,
  worstCheckStatus,
  proposalCardIsAppliable
} from './operatorContract.js';

// CheckReport status → consequence-diff bucket. Index-stable to CHECK_STATUSES so a
// new status can't silently fall through (it maps to MUST-FIX, fail-closed).
const CHECK_BUCKET = Object.freeze({
  fail: 'must_fix',
  requires_review: 'must_review',
  warning: 'warning',
  pass: 'passed'
});

// Group a CheckReport's member checks by severity bucket. A status outside the
// known vocabulary is treated as the most severe (MUST-FIX) — a gate never
// becomes more permissive via a typo (mirrors worstCheckStatus's fail-closed).
export const groupChecks = (checkReport) => {
  const groups = { must_fix: [], must_review: [], warning: [], passed: [] };
  const checks = Array.isArray(checkReport?.checks) ? checkReport.checks : [];
  for (const check of checks) {
    const bucket = CHECK_BUCKET[check?.status] || 'must_fix';
    groups[bucket].push({ name: check?.name ?? null, detail: check?.detail ?? null });
  }
  return groups;
};

// Join the card's before_after state diff to the writer's per-target outcome.
// before_after is the proposed change; per_target is what actually happened. A
// target present in one but not the other is surfaced (visible, never dropped).
const buildChanged = (card, perTarget) => {
  const beforeAfter = Array.isArray(card?.before_after) ? card.before_after : [];
  const outcomeByTarget = new Map();
  for (const pt of Array.isArray(perTarget) ? perTarget : []) {
    if (pt && pt.target != null) outcomeByTarget.set(String(pt.target), pt);
  }
  const seen = new Set();
  const changed = beforeAfter.map((ba) => {
    const target = String(ba?.target);
    seen.add(target);
    const pt = outcomeByTarget.get(target) || null;
    return {
      target,
      before: ba?.before ?? null,
      after: ba?.after ?? null,
      applied: pt ? pt.applied === true : null,   // null = no outcome reported for this target
      error: pt?.error ?? null
    };
  });
  // Per-target outcomes with no before_after entry (e.g. a target the card never
  // diffed) are still surfaced so the diff can't hide a write.
  for (const [target, pt] of outcomeByTarget) {
    if (seen.has(target)) continue;
    changed.push({ target, before: null, after: null, applied: pt.applied === true, error: pt.error ?? null });
  }
  return changed;
};

// before→after convergence (Slice-C verdicts). Both optional — a missing verdict
// is a visible null, never a fabricated terminal.
const buildConvergenceDelta = (before, after) => {
  const beforeState = before?.state ?? null;
  const afterState = after?.state ?? null;
  return {
    before: beforeState,
    after: afterState,
    shifted: beforeState != null && afterState != null && beforeState !== afterState,
    // Reached a terminal on THIS apply: terminal now, and not already terminal before.
    reached_terminal: after?.terminal === true && before?.terminal !== true
  };
};

// The commit verdict. Two distinct questions, both honoured:
//   can_apply       — does the Apply button render? (mirrors the contract's
//                     proposalCardIsAppliable: everything except a `fail`)
//   can_auto_commit — may this post UNATTENDED? Stricter: only pass/warning. A
//                     `requires_review` line is appliable but must NOT auto-post —
//                     it stays proposed pending the authority envelope (Slice G).
//                     "Low-confidence stays proposed, never posted" (CLAUDE.md).
//
// The two-terminal-states precondition ON COMMIT (CLAUDE.md, the FIRST
// principle): an unattended commit that leaves the row NON-TERMINAL — hanging,
// i.e. neither auto-reconciled nor on the owner — is the forbidden firm-side
// limbo. Even with every check green, such a commit must NOT auto-post: it is
// held and routed to the owner terminal (the authority envelope reads a
// `stay_proposed` reason other than `requires_review_authority` as an owner
// escalation). This is what makes the projection ENFORCING: it doesn't just
// measure hanging, it refuses to auto-commit a row into it. Keyed off an
// AFFIRMATIVE non-terminal verdict (`convergenceAfter.terminal === false`); an
// absent/undecidable verdict never invents a hold (the omit-when-you-can't-
// decide rule preflight follows) — so this only tightens, never loosens.
const buildCommit = (checkReport, convergenceAfter = null) => {
  const status = worstCheckStatus([
    checkReport?.status,
    ...(Array.isArray(checkReport?.checks) ? checkReport.checks.map((c) => c?.status) : [])
  ]);
  const can_apply = proposalCardIsAppliable({ checks: checkReport });
  const checksPermitAutoCommit = status === 'pass' || status === 'warning';
  // Would this commit leave the row hanging? Only when we AFFIRMATIVELY know the
  // post-apply convergence verdict is non-terminal (terminal === false). The diff
  // engine's convention is that a convergence verdict carries `.terminal`
  // (deriveCaseConvergence supplies it); a bare/absent verdict is undecidable and
  // does not block.
  const wouldLeaveHanging = convergenceAfter?.terminal === false && convergenceAfter?.state != null;
  const can_auto_commit = checksPermitAutoCommit && !wouldLeaveHanging;
  return {
    status,
    can_apply,
    can_auto_commit,
    // Explicit two-terminal-states signal, so a consumer sees the hold's cause
    // even when every check passed.
    leaves_row_hanging: wouldLeaveHanging,
    disposition: can_auto_commit ? 'commit' : 'stay_proposed',
    reason: can_auto_commit
      ? (status === 'warning' ? 'warnings_only' : 'all_checks_pass')
      : status === 'fail'
        ? 'blocking_check_failed'
        : (wouldLeaveHanging && checksPermitAutoCommit)
          ? 'would_leave_row_hanging'
          : 'requires_review_authority'
  };
};

// The public builder. Assembles the consequence diff from pre-computed parts.
//   card             — the ProposalCard (before_after, writer, reversibility, …)
//   checkReport      — the Slice-D CheckReport ({status, checks})
//   perTarget        — the writer's outcome: [{target, applied, error}]
//   convergenceBefore/After — Slice-C deriveCaseConvergence results (optional)
//   remediation      — Slice-D classifyRemediation result (optional)
//   rowsTouched      — ids actually mutated (defaults to the applied targets)
//   writer           — final writer (defaults to card.writer)
export const buildAccountingDiff = ({
  card = null,
  checkReport = null,
  perTarget = [],
  convergenceBefore = null,
  convergenceAfter = null,
  remediation = null,
  rowsTouched = null,
  writer = null
} = {}) => {
  const changed = buildChanged(card, perTarget);
  const appliedTargets = changed.filter((c) => c.applied === true).map((c) => c.target);
  const checks = groupChecks(checkReport);
  return {
    writer: writer ?? card?.writer ?? null,
    reversibility: card?.reversibility ?? null,
    why: {
      triage_source: card?.triage_source ?? null,
      detail: card?.detail ?? null,
      before_after_total: card?.before_after_total ?? changed.length
    },
    changed,
    rows_touched: Array.isArray(rowsTouched) ? rowsTouched.map(String) : appliedTargets,
    checks: { status: checkReport?.status ?? null, ...checks },
    convergence: buildConvergenceDelta(convergenceBefore, convergenceAfter),
    remediation: remediation ?? null,
    commit: buildCommit(checkReport, convergenceAfter)
  };
};

// Project the diff's PERSISTABLE subset onto the existing APPLY_RECEIPT_SCHEMA
// fields — proof that the diff lives in the receipt home (Slice B), not a new one.
// Returns ONLY the fields the diff fills; the caller merges the rest (model,
// context_snapshot_id, facts_*, …) and persists via proposalStore.persistApplyReceipt,
// which validates against the closed schema. The receipt stores the RAW CheckReport
// (the grouped view is recomputable from it — never store a derived duplicate).
export const toApplyReceiptFields = (diff, { checkReport = null } = {}) => ({
  checks: checkReport ?? (diff?.checks
    ? { status: diff.checks.status, checks: [
        ...diff.checks.must_fix.map((c) => ({ ...c, status: 'fail' })),
        ...diff.checks.must_review.map((c) => ({ ...c, status: 'requires_review' })),
        ...diff.checks.warning.map((c) => ({ ...c, status: 'warning' })),
        ...diff.checks.passed.map((c) => ({ ...c, status: 'pass' }))
      ] }
    : null),
  final_writer: diff?.writer ?? null,
  rows_touched: Array.isArray(diff?.rows_touched) ? diff.rows_touched : [],
  per_target: Array.isArray(diff?.changed)
    ? diff.changed
        .filter((c) => c.applied !== null)
        .map((c) => ({ target: c.target, applied: c.applied === true, error: c.error ?? null }))
    : []
});

export { CHECK_STATUSES };
