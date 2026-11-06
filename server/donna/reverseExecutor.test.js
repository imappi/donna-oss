// Reverse executor planner — unit tests (pod-safety #2, executor half).
//
// Load-bearing properties (CLAUDE.md two-terminal-states + the ledger isolation list):
//   - a row still in its recorded after-state → 'reverse' (the ONLY applied disposition);
//   - a row that MOVED since the apply → 'stale', never applied (optimistic concurrency);
//   - a line that POSTED to the ledger (recorded-after hint OR current recon status) →
//     'needs_ledger_adjustment', SURFACED + never auto-un-posted (Kari's call);
//   - malformed/empty before_after or a vanished target → 'skip';
//   - fail-safe: only 'reverse' entries are applicable — anything ambiguous is reported, not written.
// G2 PR-14 added the MINT legs (what the apply TAUGHT and ASKED, not just what it
// posted) — their properties are listed above their own block at the bottom of this file.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  planReverseForRow,
  planMatchReverseForRow,
  planMemoryReverseForRow,
  planReverseForCard,
  SURFACED_ONLY_WRITER_REASONS,
  summarizeReversePlan,
  applicableReverseEntries,
  matchReverseKeyForRow,
  reverseLegForWriter,
  APPLICABLE_REVERSE_DISPOSITIONS,
  REVERSE_SUPPORTED_WRITERS,
  MATCH_REVERSE_WRITERS,
  REVIEW_ITEM_REVERSE_WRITER
} from './reverseExecutor.js';

// A captured before_after row: coding was apply_category'd (category null → 'Software'),
// the review item moved open→resolved. The reverse restores category null + status open.
const row = (over = {}) => ({
  target: 'txn_1',
  before: {
    status: 'open',
    review_state: 'needs_review',
    category: null,
    account_code: null,
    transaction: { reconciliation_status: 'unreconciled' }
  },
  after: {
    status: 'resolved',
    review_state: 'explained',
    category: 'Software',
    account_code: '6201',
    transaction: { reconciliation_status: 'explained' }
  },
  ...over
});

const currentAtAfter = () => ({ present: true, status: 'resolved', review_state: 'explained', reconciliation_status: 'explained' });

test('a row still at its recorded after-state reverses, restoring the before-state patch', () => {
  const plan = planReverseForRow({ row: row(), current: currentAtAfter() });
  assert.equal(plan.disposition, 'reverse');
  assert.equal(plan.patch.category, null);
  assert.equal(plan.patch.status, 'open');
  assert.equal(plan.patch.review_state, 'needs_review');
  assert.ok(!('transaction' in plan.patch), 'the tx sub-object is not patched directly');
});

test('a moved row is stale and never applied (optimistic concurrency)', () => {
  const moved = { present: true, status: 'open', review_state: 'needs_review', reconciliation_status: 'unreconciled' };
  const plan = planReverseForRow({ row: row(), current: moved });
  assert.equal(plan.disposition, 'stale');
  assert.equal(plan.reason, 'status_moved');
  assert.ok(!APPLICABLE_REVERSE_DISPOSITIONS.has(plan.disposition));
});

test('a line posted to the ledger surfaces needs_ledger_adjustment, never auto-un-posted', () => {
  // recorded-after hint path: after.reconciliation_status is terminal
  const posted = row({ after: { ...row().after, transaction: { reconciliation_status: 'posted' } } });
  const planHint = planReverseForRow({ row: posted, current: { present: true, status: 'resolved', review_state: 'explained', reconciliation_status: 'posted' } });
  assert.equal(planHint.disposition, 'needs_ledger_adjustment');
  assert.ok(!APPLICABLE_REVERSE_DISPOSITIONS.has(planHint.disposition));

  // current-read path: capture said explained, but the line has since auto-reconciled/posted
  const planCurrent = planReverseForRow({ row: row(), current: { present: true, status: 'resolved', review_state: 'explained', reconciliation_status: 'auto_reconciled' } });
  assert.equal(planCurrent.disposition, 'needs_ledger_adjustment');
});

test('a vanished target or malformed row is skipped', () => {
  assert.equal(planReverseForRow({ row: row(), current: null }).disposition, 'skip');
  assert.equal(planReverseForRow({ row: row(), current: { present: false } }).disposition, 'skip');
  assert.equal(planReverseForRow({ row: { target: 'x', before: null, after: {} }, current: currentAtAfter() }).disposition, 'skip');
});

test('planReverseForCard aggregates entries and a summary breakdown', () => {
  const card = {
    proposal_id: 'prop-1',
    writer: 'updateTransactionReviewItemInDb',
    before_after: [
      row(),                                   // reverse
      row({ target: 'txn_2' })                 // stale (no current supplied)
    ]
  };
  const plan = planReverseForCard({
    card,
    currentByTarget: { txn_1: currentAtAfter() } // txn_2 absent → skip
  });
  assert.equal(plan.proposal_id, 'prop-1');
  assert.equal(plan.summary.total, 2);
  assert.equal(plan.summary.reverse, 1);
  assert.equal(plan.summary.skip, 1);
  assert.deepEqual(applicableReverseEntries(plan).map((e) => e.target), ['txn_1']);
});

test('planReverseForCard echoes which apply the card was (G2 PR-15 render honesty)', () => {
  // The reverse UI multi-selects over these plans; proposal_type + created_at
  // are how a founder tells one apply from another. Read-only echo of the
  // loadReversibleProposalCards row — and ABSENT keys stay absent (a pure-leaf
  // caller passing a minimal card must not grow undefined-valued keys).
  const plan = planReverseForCard({
    card: {
      proposal_id: 'prop-meta',
      proposal_type: 'feed_chat_apply',
      status: 'applied',
      created_at: '2026-08-15T10:00:00Z',
      writer: 'updateTransactionReviewItemInDb',
      before_after: [row()]
    },
    currentByTarget: { txn_1: currentAtAfter() }
  });
  assert.equal(plan.proposal_type, 'feed_chat_apply');
  assert.equal(plan.status, 'applied');
  assert.equal(plan.created_at, '2026-08-15T10:00:00Z');
  const bare = planReverseForCard({
    card: { proposal_id: 'prop-bare', writer: 'updateTransactionReviewItemInDb', before_after: [row()] },
    currentByTarget: { txn_1: currentAtAfter() }
  });
  assert.equal('proposal_type' in bare, false);
  assert.equal('created_at' in bare, false);
  // The fail-closed (unsupported writer) branch echoes the same metadata.
  const surfacedOnly = planReverseForCard({
    card: { proposal_id: 'prop-s', proposal_type: 'feed_chat_apply', writer: 'deliverEvidenceAsksOnAllChannels', before_after: [row()] }
  });
  assert.equal(surfacedOnly.proposal_type, 'feed_chat_apply');
});

test('planReverseForCard fail-closes on a writer the executor cannot restore through', () => {
  // A card whose writer has no restore leg (unknown/missing) must never plan a
  // write. Every row plans to skip — even one that would otherwise reverse.
  for (const writer of [null, undefined, 'unknown_writer', 'postLedgerTransactionInDb']) {
    const plan = planReverseForCard({
      card: { proposal_id: 'prop-m', writer, before_after: [row()] },
      currentByTarget: { txn_1: currentAtAfter() }
    });
    assert.equal(plan.summary.skip, 1, `writer=${writer}`);
    assert.equal(plan.summary.reverse, 0, `writer=${writer}`);
    assert.equal(plan.entries[0].reason, 'writer_not_supported');
    assert.equal(plan.leg, null);
    assert.equal(applicableReverseEntries(plan).length, 0);
  }
  // The supported set is exactly the five legs' writers: coding, match, and the three
  // G2 PR-14 mint legs (fact / rule / ask).
  assert.deepEqual(
    [...REVERSE_SUPPORTED_WRITERS].sort(),
    [
      'createClientEvidenceRequestInDb',
      'createManualReconciliationMatchInDb',
      'saveFirmFact',
      'saveMerchantRuleForPayload',
      'updateReconciliationMatchInDb',
      'updateTransactionReviewItemInDb'
    ]
  );
  assert.equal(reverseLegForWriter(REVIEW_ITEM_REVERSE_WRITER), 'review_item');
  for (const writer of MATCH_REVERSE_WRITERS) assert.equal(reverseLegForWriter(writer), 'match');
  assert.equal(reverseLegForWriter('anything_else'), null);
});

// ─── Match-writer reverse leg (pod-safety #2, the named follow-up from #730) ──
// Rows mirror firmDb.__matchBeforeAfter's output exactly (the capture is the input
// contract): target = bank tx id; before/after carry match_id, match_status and the tx
// reconciliation_status the writer's own branch wrote.

// A reject_match capture: confirmed → rejected reopened the tx to needs_review.
const rejectRow = (over = {}) => ({
  target: 'txn_m1',
  before: { match_id: 'recon-1', match_status: 'confirmed', transaction: { reconciliation_status: 'reconciled' } },
  after: { match_id: 'recon-1', match_status: 'rejected', transaction: { reconciliation_status: 'needs_review' } },
  ...over
});

// A fresh manual-link capture: no prior match → confirmed reconciled the tx.
const linkRow = (over = {}) => ({
  target: 'txn_m2',
  before: { match_id: 'recon-2', match_status: null, transaction: { reconciliation_status: 'needs_review' } },
  after: { match_id: 'recon-2', match_status: 'confirmed', transaction: { reconciliation_status: 'reconciled' } },
  ...over
});

test('match leg: reversing a reject RE-CONFIRMS through the match writer', () => {
  const plan = planMatchReverseForRow({
    row: rejectRow(),
    current: { present: true, match_status: 'rejected', reconciliation_status: 'needs_review', ledger_posted: false }
  });
  assert.equal(plan.disposition, 'reverse');
  assert.equal(plan.match_id, 'recon-1');
  // The patch is the writer's own verb — the confirmed branch's cascade flips the tx
  // back to 'reconciled'; the tx is never patched directly.
  assert.deepEqual(plan.patch, { status: 'confirmed' });
  assert.equal(plan.preconditions.expected_match_status, 'rejected');
  assert.equal(plan.preconditions.expected_reconciliation_status, 'needs_review');
});

test('match leg: reversing a fresh manual link REJECTS it (the writer\'s unlink verb)', () => {
  const plan = planMatchReverseForRow({
    row: linkRow(),
    current: { present: true, match_status: 'confirmed', reconciliation_status: 'reconciled', ledger_posted: false }
  });
  assert.equal(plan.disposition, 'reverse');
  assert.deepEqual(plan.patch, { status: 'rejected' });
});

test('match leg: a moved match row is stale and never applied (optimistic concurrency)', () => {
  // Someone re-confirmed the rejected match since the capture — a newer decision.
  const plan = planMatchReverseForRow({
    row: rejectRow(),
    current: { present: true, match_status: 'confirmed', reconciliation_status: 'reconciled', ledger_posted: false }
  });
  assert.equal(plan.disposition, 'stale');
  assert.equal(plan.reason, 'match_status_moved');
  assert.ok(!APPLICABLE_REVERSE_DISPOSITIONS.has(plan.disposition));
});

test('match leg: a tx that moved underneath an unchanged match is stale too', () => {
  // The match still sits at 'rejected' but another pipeline re-decided the line
  // (e.g. auto-explained it) — reversing would clobber that decision.
  const plan = planMatchReverseForRow({
    row: rejectRow(),
    current: { present: true, match_status: 'rejected', reconciliation_status: 'explained', ledger_posted: false }
  });
  assert.equal(plan.disposition, 'stale');
  assert.equal(plan.reason, 'reconciliation_status_moved');
});

test('match leg: a line posted to the ledger surfaces needs_ledger_adjustment, never auto-un-linked', () => {
  // NOTE: 'reconciled' is NOT ledger-terminal on this leg — the confirm cascade itself
  // writes it. Only a real posting receipt ('posted' status or a stamped journal id)
  // routes to the adjustment lane.
  const posted = planMatchReverseForRow({
    row: linkRow(),
    current: { present: true, match_status: 'confirmed', reconciliation_status: 'posted', ledger_posted: true }
  });
  assert.equal(posted.disposition, 'needs_ledger_adjustment');
  assert.ok(!APPLICABLE_REVERSE_DISPOSITIONS.has(posted.disposition));

  // Journal stamped but status not yet flipped — the honest receipt still wins.
  const journalOnly = planMatchReverseForRow({
    row: linkRow(),
    current: { present: true, match_status: 'confirmed', reconciliation_status: 'reconciled', ledger_posted: true }
  });
  assert.equal(journalOnly.disposition, 'needs_ledger_adjustment');
});

test('match leg: a restore the writer\'s cascade cannot reproduce fail-closes (upsert suggested→confirmed)', () => {
  // A manual link that UPSERTED a suggested match to confirmed: re-suggesting through
  // the writer touches nothing on the tx, which would strand it at 'reconciled' — not
  // the recorded before ('needs_review'). Fail-closed: skip, surfaced in the plan.
  const plan = planMatchReverseForRow({
    row: {
      target: 'txn_m3',
      before: { match_id: 'recon-3', match_status: 'suggested', transaction: { reconciliation_status: 'needs_review' } },
      after: { match_id: 'recon-3', match_status: 'confirmed', transaction: { reconciliation_status: 'reconciled' } }
    },
    current: { present: true, match_status: 'confirmed', reconciliation_status: 'reconciled', ledger_posted: false }
  });
  assert.equal(plan.disposition, 'skip');
  assert.equal(plan.reason, 'cascade_cannot_restore');
});

test('match leg: a suggested→rejected reject reverses when the cascade round-trips', () => {
  // Rejecting a suggested match on an already-needs_review line: re-suggesting leaves
  // the tx where it sits, which IS the recorded before — a faithful restore.
  const plan = planMatchReverseForRow({
    row: {
      target: 'txn_m4',
      before: { match_id: 'recon-4', match_status: 'suggested', transaction: { reconciliation_status: 'needs_review' } },
      after: { match_id: 'recon-4', match_status: 'rejected', transaction: { reconciliation_status: 'needs_review' } }
    },
    current: { present: true, match_status: 'rejected', reconciliation_status: 'needs_review', ledger_posted: false }
  });
  assert.equal(plan.disposition, 'reverse');
  assert.deepEqual(plan.patch, { status: 'suggested' });
});

test('match leg: vanished match row or malformed/non-match-shaped rows are skipped', () => {
  assert.equal(planMatchReverseForRow({ row: rejectRow(), current: null }).disposition, 'skip');
  assert.equal(planMatchReverseForRow({ row: rejectRow(), current: { present: false } }).disposition, 'skip');
  // A review-item-shaped row on a match card must never build a match patch.
  const notMatchShaped = planMatchReverseForRow({
    row: row(),
    current: { present: true, match_status: 'rejected', reconciliation_status: 'needs_review' }
  });
  assert.equal(notMatchShaped.disposition, 'skip');
  assert.equal(notMatchShaped.reason, 'not_match_shaped');
});

test('planReverseForCard routes match-writer cards through the match leg, keyed by match_id', () => {
  for (const writer of MATCH_REVERSE_WRITERS) {
    const plan = planReverseForCard({
      card: { proposal_id: 'prop-match', writer, before_after: [rejectRow(), linkRow()] },
      currentByTarget: {
        'recon-1': { present: true, match_status: 'rejected', reconciliation_status: 'needs_review', ledger_posted: false }
        // recon-2 absent → skip (target_missing)
      }
    });
    assert.equal(plan.leg, 'match', `writer=${writer}`);
    assert.equal(plan.writer, writer);
    assert.equal(plan.summary.reverse, 1);
    assert.equal(plan.summary.skip, 1);
    const applicable = applicableReverseEntries(plan);
    assert.deepEqual(applicable.map((e) => e.match_id), ['recon-1']);
    assert.deepEqual(applicable.map((e) => e.target), ['txn_m1']);
  }
  assert.equal(matchReverseKeyForRow(rejectRow()), 'recon-1');
  assert.equal(matchReverseKeyForRow({ target: 'x', before: {}, after: {} }), null);
});

test('summarizeReversePlan counts each disposition', () => {
  const s = summarizeReversePlan([
    { disposition: 'reverse' }, { disposition: 'reverse' },
    { disposition: 'stale' }, { disposition: 'needs_ledger_adjustment' }, { disposition: 'skip' }
  ]);
  assert.deepEqual(s, { total: 5, reverse: 2, stale: 1, needs_ledger_adjustment: 1, skip: 1, surfaced: 0 });
});

test('summarizeReversePlan counts surfaced entries beside — never instead of — their disposition', () => {
  const s = summarizeReversePlan([
    { disposition: 'reverse', surfaced: [{ kind: 'rule_confirmation_bump' }] },
    { disposition: 'stale', surfaced: [{ kind: 'rule_cascade_not_unwound' }] },
    { disposition: 'skip', surfaced: [] }
  ]);
  assert.deepEqual(s, { total: 3, reverse: 1, stale: 1, needs_ledger_adjustment: 0, skip: 1, surfaced: 2 });
});

// ─── The mint legs (G2 PR-14) ────────────────────────────────────────────────
//
// Load-bearing properties, each one a refusal the FIRST principle or INV-1 demands:
//   - a fact/rule/ask this apply MINTED and that still rests where the mint left it →
//     'reverse' (dismiss / retire / cancel through the object's own governed writer);
//   - an object the apply merely COLLAPSED ONTO (a re-taught fact, a re-asked line) →
//     surfaced skip, never retired: the reversed action did not create it;
//   - an ASK the owner ANSWERED → 'stale' (ask_answered) — the answer superseded the
//     action being reversed and is never clobbered;
//   - an already-dismissed/retired/cancelled object → skip (already_reversed);
//   - the ask-LIFECYCLE writers (cancel / amend / resend) → surfaced-only rows with
//     their own reason; a resend is outbound and outbound is never auto-fired;
//   - a confirmation bump and a rule cascade are SURFACED, never undone.

const mintRow = (over = {}) => ({
  target: 'fact-1',
  before: { kind: 'firm_fact', present: false, status: null },
  after: { kind: 'firm_fact', present: true, status: 'active' },
  ...over
});

const ruleMintRow = (over = {}) => ({
  target: 'rule-1',
  before: { kind: 'client_rule', present: false, status: null },
  after: { kind: 'client_rule', present: true, status: 'active', cascade_matched: 3 },
  ...over
});

const askMintRow = (over = {}) => ({
  target: 'evidence-request-1',
  before: { kind: 'client_evidence_request', present: false, status: null },
  after: { kind: 'client_evidence_request', present: true, status: 'open' },
  ...over
});

test('a minted fact still active reverses to a dismiss through the governed tombstone writer', () => {
  const plan = planMemoryReverseForRow({ row: mintRow(), current: { present: true, status: 'active' } });
  assert.equal(plan.disposition, 'reverse');
  assert.equal(plan.kind, 'firm_fact');
  assert.deepEqual(plan.patch, { status: 'dismissed' });
  assert.equal(plan.preconditions.expected_status, 'active');
});

test('a minted rule reverses to a retire; a minted ask reverses to a cancel', () => {
  const rule = planMemoryReverseForRow({ row: ruleMintRow(), current: { present: true, status: 'active' } });
  assert.equal(rule.disposition, 'reverse');
  assert.deepEqual(rule.patch, { status: 'retired' });
  const ask = planMemoryReverseForRow({ row: askMintRow(), current: { present: true, status: 'open' } });
  assert.equal(ask.disposition, 'reverse');
  assert.deepEqual(ask.patch, { status: 'cancelled' });
  assert.equal(ask.preconditions.expected_status, 'open');
});

test('an object the apply did NOT mint is surfaced, never retired', () => {
  for (const [row, reason] of [
    [mintRow({ before: { kind: 'firm_fact', present: true, status: 'active' } }), 'firm_fact_pre_existed'],
    [ruleMintRow({ before: { kind: 'client_rule', present: true, status: 'active' } }), 'client_rule_pre_existed'],
    [askMintRow({ before: { kind: 'client_evidence_request', present: true, status: 'open' } }), 'client_evidence_request_pre_existed']
  ]) {
    const plan = planMemoryReverseForRow({ row, current: { present: true, status: row.after.status } });
    assert.equal(plan.disposition, 'skip', reason);
    assert.equal(plan.reason, reason);
    assert.ok(!plan.patch, 'a pre-existing object is never patched');
  }
});

test('an ANSWERED ask is stale and refused — the owner reply is never clobbered', () => {
  for (const status of ['replied', 'resolved']) {
    const plan = planMemoryReverseForRow({ row: askMintRow(), current: { present: true, status } });
    assert.equal(plan.disposition, 'stale', `status=${status}`);
    assert.equal(plan.reason, 'ask_answered');
    assert.equal(plan.actual, status);
    assert.equal(plan.expected, 'open');
  }
});

test('an object already at its reverse status skips (already_reversed), and a vanished one skips too', () => {
  assert.equal(
    planMemoryReverseForRow({ row: mintRow(), current: { present: true, status: 'dismissed' } }).reason,
    'already_reversed'
  );
  assert.equal(
    planMemoryReverseForRow({ row: ruleMintRow(), current: { present: true, status: 'retired' } }).reason,
    'already_reversed'
  );
  assert.equal(
    planMemoryReverseForRow({ row: askMintRow(), current: { present: true, status: 'cancelled' } }).reason,
    'already_reversed'
  );
  assert.equal(
    planMemoryReverseForRow({ row: mintRow(), current: { present: false } }).reason,
    'target_missing'
  );
  assert.equal(
    planMemoryReverseForRow({ row: { target: 'x', before: {}, after: {} }, current: { present: true, status: 'active' } }).disposition,
    'skip'
  );
});

test('a fact/rule moved to some OTHER status is stale, not answered', () => {
  const plan = planMemoryReverseForRow({ row: mintRow(), current: { present: true, status: 'erased' } });
  assert.equal(plan.disposition, 'stale');
  assert.equal(plan.reason, 'status_moved');
});

test('planReverseForCard routes each mint writer to its own leg', () => {
  const cases = [
    ['saveFirmFact', 'firm_fact', mintRow(), 'fact-1', 'active'],
    ['saveMerchantRuleForPayload', 'client_rule', ruleMintRow(), 'rule-1', 'active'],
    ['createClientEvidenceRequestInDb', 'ask', askMintRow(), 'evidence-request-1', 'open']
  ];
  for (const [writer, leg, row, id, status] of cases) {
    assert.equal(reverseLegForWriter(writer), leg);
    const plan = planReverseForCard({
      card: { proposal_id: `prop-${leg}`, writer, before_after: [row] },
      currentByTarget: { [id]: { present: true, status } }
    });
    assert.equal(plan.leg, leg);
    assert.equal(plan.summary.reverse, 1, `writer=${writer}`);
    assert.deepEqual(applicableReverseEntries(plan).map((e) => e.target), [id]);
  }
});

test('the ask-lifecycle writers are surfaced-only, each with its own recorded reason', () => {
  for (const [writer, reason] of Object.entries(SURFACED_ONLY_WRITER_REASONS)) {
    const plan = planReverseForCard({
      card: { proposal_id: 'prop-life', writer, before_after: [askMintRow()] },
      currentByTarget: { 'evidence-request-1': { present: true, status: 'cancelled' } }
    });
    assert.equal(plan.leg, null, `writer=${writer}`);
    assert.equal(plan.entries[0].reason, reason);
    assert.equal(plan.summary.reverse, 0);
    assert.equal(applicableReverseEntries(plan).length, 0);
  }
  assert.equal(SURFACED_ONLY_WRITER_REASONS.deliverEvidenceAsksOnAllChannels, 'outbound_never_auto_fired');
});

test('a confirmation bump rides the plan as surfaced and is NEVER patched back down', () => {
  const bumped = row();
  bumped.after.rule_confirmation_bump = {
    rule_id: 'rule-9', review_item_id: 'ri-1', prior_count: 1, confirmation_count: 2, confidence: 0.9
  };
  const plan = planReverseForCard({
    card: { proposal_id: 'prop-bump', writer: REVIEW_ITEM_REVERSE_WRITER, before_after: [bumped] },
    currentByTarget: { txn_1: currentAtAfter() }
  });
  const entry = plan.entries[0];
  assert.equal(entry.disposition, 'reverse', 'the coding still reverses');
  assert.equal(entry.surfaced.length, 1);
  assert.equal(entry.surfaced[0].kind, 'rule_confirmation_bump');
  assert.equal(entry.surfaced[0].reversed, false);
  assert.equal(entry.surfaced[0].rule_id, 'rule-9');
  assert.equal(entry.surfaced[0].review_item_id, 'ri-1', 'the plan names WHICH item drove the bump');
  assert.equal(entry.surfaced[0].confirmation_count, 2);
  assert.ok(!('rule_confirmation_bump' in entry.patch), 'the bump is never a patch key');
  assert.equal(plan.summary.surfaced, 1);
});

test("a merchant rule's cascade is surfaced as not-unwound beside the retire", () => {
  const plan = planReverseForCard({
    card: { proposal_id: 'prop-cascade', writer: 'saveMerchantRuleForPayload', before_after: [ruleMintRow()] },
    currentByTarget: { 'rule-1': { present: true, status: 'active' } }
  });
  const entry = plan.entries[0];
  assert.equal(entry.disposition, 'reverse');
  assert.deepEqual(entry.surfaced.map((s) => s.kind), ['rule_cascade_not_unwound']);
  assert.equal(entry.surfaced[0].matched, 3);
  assert.equal(entry.surfaced[0].reversed, false);
});
