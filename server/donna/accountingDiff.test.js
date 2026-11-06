// Slice E — the consequence-diff engine. Load-bearing properties:
//   - pure: no DB, no LLM; assembles pre-computed parts
//   - "never just say done": every apply yields what-changed + grouped severity +
//     before→after convergence + a commit verdict
//   - mints NO new home: its persistable subset projects onto the existing
//     APPLY_RECEIPT_SCHEMA fields (toApplyReceiptFields), and the projected
//     receipt VALIDATES against the closed operator contract
//   - low-confidence stays proposed: requires_review is appliable but never
//     auto-commits

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildAccountingDiff,
  groupChecks,
  toApplyReceiptFields
} from './accountingDiff.js';
import {
  assertMatchesOperatorContract,
  EXAMPLE_PROPOSAL_CARD,
  EXAMPLE_APPLY_RECEIPT
} from './operatorContract.js';

const CHECK_REPORT = {
  status: 'requires_review',
  checks: [
    { name: 'targets_exist', status: 'pass', detail: null },
    { name: 'evidence_required', status: 'requires_review', detail: 'persisted_model_verdict' },
    { name: 'period_not_locked', status: 'warning', detail: 'near boundary' },
    { name: 'totals_balance', status: 'fail', detail: 'subtotal+tax != total' }
  ]
};

test('groupChecks buckets by severity; an unknown status fails closed to must_fix', () => {
  const g = groupChecks(CHECK_REPORT);
  assert.deepEqual(g.passed.map((c) => c.name), ['targets_exist']);
  assert.deepEqual(g.must_review.map((c) => c.name), ['evidence_required']);
  assert.deepEqual(g.warning.map((c) => c.name), ['period_not_locked']);
  assert.deepEqual(g.must_fix.map((c) => c.name), ['totals_balance']);
  // unknown status → most severe bucket (never silently dropped or downgraded)
  const weird = groupChecks({ checks: [{ name: 'x', status: 'banana' }] });
  assert.deepEqual(weird.must_fix.map((c) => c.name), ['x']);
});

test('buildAccountingDiff joins before_after to per-target outcome (what changed)', () => {
  const diff = buildAccountingDiff({
    card: {
      writer: 'updateTransactionReviewItemInDb',
      reversibility: 'recode_before_posting',
      triage_source: 'state_correction',
      before_after: [
        { target: 'tx-1', before: { account: 'Suspense' }, after: { account: 'Consulting revenue' } },
        { target: 'tx-2', before: { account: 'Suspense' }, after: { account: 'Travel' } }
      ],
      before_after_total: 2
    },
    checkReport: { status: 'pass', checks: [{ name: 'targets_exist', status: 'pass', detail: null }] },
    perTarget: [
      { target: 'tx-1', applied: true, error: null },
      { target: 'tx-2', applied: false, error: 'no_review_item' }
    ]
  });
  assert.equal(diff.writer, 'updateTransactionReviewItemInDb');
  assert.equal(diff.reversibility, 'recode_before_posting');
  const byTarget = Object.fromEntries(diff.changed.map((c) => [c.target, c]));
  assert.equal(byTarget['tx-1'].applied, true);
  assert.equal(byTarget['tx-1'].after.account, 'Consulting revenue');
  assert.equal(byTarget['tx-2'].applied, false);
  assert.equal(byTarget['tx-2'].error, 'no_review_item');
  // rows_touched defaults to the applied targets only
  assert.deepEqual(diff.rows_touched, ['tx-1']);
});

test('buildAccountingDiff surfaces a per-target write that had no before_after (never hidden)', () => {
  const diff = buildAccountingDiff({
    card: { before_after: [], writer: 'w' },
    checkReport: { status: 'pass', checks: [] },
    perTarget: [{ target: 'tx-9', applied: true, error: null }]
  });
  assert.equal(diff.changed.length, 1);
  assert.equal(diff.changed[0].target, 'tx-9');
  assert.equal(diff.changed[0].before, null);
  assert.equal(diff.changed[0].applied, true);
});

test('convergence delta: before→after shift + reached_terminal on THIS apply', () => {
  const diff = buildAccountingDiff({
    card: { before_after: [], writer: 'w' },
    checkReport: { status: 'pass', checks: [] },
    perTarget: [],
    convergenceBefore: { state: 'hanging', terminal: false },
    convergenceAfter: { state: 'auto_reconciled', terminal: true }
  });
  assert.equal(diff.convergence.before, 'hanging');
  assert.equal(diff.convergence.after, 'auto_reconciled');
  assert.equal(diff.convergence.shifted, true);
  assert.equal(diff.convergence.reached_terminal, true);
  // A missing verdict is a visible null, not a fabricated terminal.
  const blind = buildAccountingDiff({ card: { before_after: [], writer: 'w' }, checkReport: { status: 'pass', checks: [] } });
  assert.equal(blind.convergence.before, null);
  assert.equal(blind.convergence.reached_terminal, false);
});

test('commit verdict: fail blocks; requires_review is appliable but does NOT auto-commit; pass commits', () => {
  const failing = buildAccountingDiff({ card: { before_after: [], writer: 'w' }, checkReport: CHECK_REPORT });
  assert.equal(failing.commit.can_apply, false);          // CHECK_REPORT has a fail → Apply blocked
  assert.equal(failing.commit.can_auto_commit, false);
  assert.equal(failing.commit.disposition, 'stay_proposed');
  assert.equal(failing.commit.reason, 'blocking_check_failed');

  const review = buildAccountingDiff({
    card: { before_after: [], writer: 'w' },
    checkReport: { status: 'requires_review', checks: [{ name: 'evidence_required', status: 'requires_review', detail: null }] }
  });
  assert.equal(review.commit.can_apply, true);            // appliable (mirrors proposalCardIsAppliable)
  assert.equal(review.commit.can_auto_commit, false);     // but never auto-posts
  assert.equal(review.commit.disposition, 'stay_proposed');
  assert.equal(review.commit.reason, 'requires_review_authority');

  const clean = buildAccountingDiff({
    card: { before_after: [], writer: 'w' },
    checkReport: { status: 'pass', checks: [{ name: 'targets_exist', status: 'pass', detail: null }] }
  });
  assert.equal(clean.commit.can_auto_commit, true);
  assert.equal(clean.commit.disposition, 'commit');

  const warn = buildAccountingDiff({
    card: { before_after: [], writer: 'w' },
    checkReport: { status: 'warning', checks: [{ name: 'period_not_locked', status: 'warning', detail: null }] }
  });
  assert.equal(warn.commit.can_auto_commit, true);        // warnings render but don't block
  assert.equal(warn.commit.reason, 'warnings_only');
});

test('commit verdict: two-terminal-states ON COMMIT — clean checks but a hanging row does NOT auto-commit', () => {
  // Every check passes, but the post-apply convergence verdict is non-terminal
  // (hanging). Auto-committing would leave the row in firm-side limbo — the
  // FIRST-principle violation. The commit must hold + route to the owner.
  const hanging = buildAccountingDiff({
    card: { before_after: [], writer: 'w' },
    checkReport: { status: 'pass', checks: [{ name: 'targets_exist', status: 'pass', detail: null }] },
    convergenceAfter: { state: 'hanging', terminal: false, reason: 'review_state:suggested' }
  });
  assert.equal(hanging.commit.can_apply, true);            // still appliable (no fail)
  assert.equal(hanging.commit.can_auto_commit, false);     // but must NOT auto-post
  assert.equal(hanging.commit.disposition, 'stay_proposed');
  assert.equal(hanging.commit.reason, 'would_leave_row_hanging');
  assert.equal(hanging.commit.leaves_row_hanging, true);

  // A terminal post-apply verdict (auto_reconciled) with clean checks commits.
  const terminal = buildAccountingDiff({
    card: { before_after: [], writer: 'w' },
    checkReport: { status: 'pass', checks: [{ name: 'targets_exist', status: 'pass', detail: null }] },
    convergenceAfter: { state: 'auto_reconciled', terminal: true, reason: 'review_state:accepted' }
  });
  assert.equal(terminal.commit.can_auto_commit, true);
  assert.equal(terminal.commit.disposition, 'commit');
  assert.equal(terminal.commit.leaves_row_hanging, false);

  // An on_owner terminal is a valid terminal — it commits (the ask IS the resolution).
  const onOwner = buildAccountingDiff({
    card: { before_after: [], writer: 'w' },
    checkReport: { status: 'pass', checks: [] },
    convergenceAfter: { state: 'on_owner', terminal: true, reason: 'open_owner_ask' }
  });
  assert.equal(onOwner.commit.can_auto_commit, true);
});

test('commit verdict: an ABSENT convergence verdict is undecidable — never invents a hold (only tightens)', () => {
  // No convergenceAfter → the two-terminal gate cannot decide → behaves exactly
  // as before (clean checks commit). Same shadow-safe omit-when-undecidable rule
  // preflight follows.
  const noVerdict = buildAccountingDiff({
    card: { before_after: [], writer: 'w' },
    checkReport: { status: 'pass', checks: [{ name: 'targets_exist', status: 'pass', detail: null }] }
  });
  assert.equal(noVerdict.commit.can_auto_commit, true);
  assert.equal(noVerdict.commit.leaves_row_hanging, false);
});

test('commit verdict: a check-level block outranks the hanging reason (precedence)', () => {
  // fail + hanging → the blocking check is the primary reason, unchanged.
  const failAndHanging = buildAccountingDiff({
    card: { before_after: [], writer: 'w' },
    checkReport: { status: 'fail', checks: [{ name: 'totals_balance', status: 'fail', detail: 'x' }] },
    convergenceAfter: { state: 'hanging', terminal: false }
  });
  assert.equal(failAndHanging.commit.reason, 'blocking_check_failed');

  // requires_review + hanging → the authority hold stays primary (unchanged), so
  // the materiality/authority path still resolves it rather than the hanging label.
  const reviewAndHanging = buildAccountingDiff({
    card: { before_after: [], writer: 'w' },
    checkReport: { status: 'requires_review', checks: [{ name: 'materiality_band', status: 'requires_review', detail: null }] },
    convergenceAfter: { state: 'hanging', terminal: false }
  });
  assert.equal(reviewAndHanging.commit.can_auto_commit, false);
  assert.equal(reviewAndHanging.commit.reason, 'requires_review_authority');
});

test('toApplyReceiptFields projects onto the EXISTING receipt shape (no new home) and VALIDATES', () => {
  const diff = buildAccountingDiff({
    card: {
      writer: 'updateTransactionReviewItemInDb',
      before_after: [{ target: 'tx-1', before: { account: 'Suspense' }, after: { account: 'Travel' } }]
    },
    checkReport: { status: 'pass', checks: [{ name: 'targets_exist', status: 'pass', detail: null }] },
    perTarget: [{ target: 'tx-1', applied: true, error: null }]
  });
  const fields = toApplyReceiptFields(diff, { checkReport: { status: 'pass', checks: [{ name: 'targets_exist', status: 'pass', detail: null }] } });
  assert.equal(fields.final_writer, 'updateTransactionReviewItemInDb');
  assert.deepEqual(fields.rows_touched, ['tx-1']);
  assert.deepEqual(fields.per_target, [{ target: 'tx-1', applied: true, error: null }]);
  assert.equal(fields.checks.status, 'pass');

  // Merge into a full receipt and assert it passes the CLOSED operator contract —
  // proof the diff populates apply_receipts, not a parallel structure.
  const receipt = { ...EXAMPLE_APPLY_RECEIPT, ...fields };
  assert.doesNotThrow(() => assertMatchesOperatorContract('apply_receipt', receipt));
});

test('the diff is not a second convergence verdict — it carries the receipt content, the verdict stays a passthrough', () => {
  // uplift §4.3 / Slice B: receipt = "what changed + is it safe"; the GoalReport is
  // the terminal verdict. The diff RENDERS the convergence verdicts it was handed;
  // it does not recompute them.
  const before = { state: 'hanging', terminal: false, reason: 'review_state:suggested' };
  const after = { state: 'on_owner', terminal: true, reason: 'open_owner_ask' };
  const diff = buildAccountingDiff({ card: { before_after: [], writer: 'w' }, checkReport: { status: 'pass', checks: [] }, convergenceBefore: before, convergenceAfter: after });
  assert.equal(diff.convergence.before, 'hanging');
  assert.equal(diff.convergence.after, 'on_owner');
  // It surfaced the handed-in verdicts verbatim; no field re-derives a state.
  assert.equal(diff.convergence.shifted, true);
});

// A sanity anchor: the canonical contract examples remain valid (we didn't drift
// the receipt shape this slice).
test('the canonical proposal-card + apply-receipt examples still validate', () => {
  assert.doesNotThrow(() => assertMatchesOperatorContract('proposal_card', EXAMPLE_PROPOSAL_CARD));
  assert.doesNotThrow(() => assertMatchesOperatorContract('apply_receipt', EXAMPLE_APPLY_RECEIPT));
});
