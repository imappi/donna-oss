// The convergence invariant, machine-checked: the full policy table (at the
// end of this file) and, in detail, the held-for-authority axis.
//
// A material match the materiality ceiling holds (`matched_pending_authority`)
// is a transition, never a resting state. Pinned here:
//   - the projection: held with no covering grant is hanging under
//     matched_pending_authority_no_grant, whatever the coding / settlement
//     axes say; held WITH a covering grant reads exactly as the same row
//     with no held match (its existing outcome); the earlier-checked axes
//     (a cascade that never landed, an open agent ask) keep precedence;
//   - the reader: only a LIVE 'suggested' row whose receipt is held by
//     materiality alone is held — and the inlined receipt reader is lock-step
//     with reconciliationLlmCore.isMatchedPendingAuthority;
//   - the adapters and the persisted-column gather (projectGatheredTransaction)
//     carry the input, so the column a writer persists and the nightly
//     recompute derive the same verdict.
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CASCADE_APPLIED_STATE,
  CONVERGENCE_STATES,
  CONVERGENCE_TERMINALS,
  SETTLED_RECON_STATUSES_LOCKSTEP,
  SETTLING_DISPOSITIONS_LOCKSTEP,
  __isHeldPendingAuthorityReceipt,
  collectHeldPendingAuthorityMatches,
  convergenceForReviewItem,
  convergenceForTransaction,
  deriveConvergenceState,
  projectGatheredTransaction
} from './reconcileConvergenceState.js';
import { isMatchedPendingAuthority } from './reconciliationLlmCore.js';
import {
  CODING_STATES,
  HANGING_CODING_STATES,
  OWNER_CODING_STATE,
  RECONCILED_CODING_STATES,
  codingStateReasonKey
} from './codingState.js';

const HELD_RECEIPT = Object.freeze({
  band: 'suggested',
  reasons: ['above_materiality_ceiling'],
  gates: { A: true, B: true, C: true, D: true, E: false }
});

// Rows a coding / settlement axis alone would read finished or otherwise.
const BASES = [
  { label: 'coding applied', input: { codingState: 'applied' } },
  { label: 'coding posted', input: { codingState: 'posted' } },
  { label: 'settled match, coded', input: { reconciliationStatus: 'reconciled', codedAccount: '7100' } },
  { label: 'explained', input: { reconciliationStatus: 'explained' } },
  { label: 'auto-explain disposition', input: { disposition: 'auto_explain' } },
  { label: 'pending, uncoded', input: { reconciliationStatus: 'pending' } },
  { label: 'coding proposed', input: { codingState: 'proposed' } },
  { label: 'open owner ask', input: { codingState: 'applied', hasOpenOwnerAsk: true } }
];

test('held with no covering grant hangs under matched_pending_authority_no_grant on every base', () => {
  for (const { label, input } of BASES) {
    assert.deepEqual(
      deriveConvergenceState({ ...input, matchHeldPendingAuthority: true }),
      { state: 'hanging', reason: 'matched_pending_authority_no_grant' },
      label
    );
  }
});

test('held with a covering grant keeps the outcome the row has with no held match', () => {
  for (const { label, input } of BASES) {
    assert.deepEqual(
      deriveConvergenceState({ ...input, matchHeldPendingAuthority: true, hasCoveringAuthorityGrant: true }),
      deriveConvergenceState(input),
      label
    );
  }
  // A grant flag with nothing held changes nothing either.
  for (const { label, input } of BASES) {
    assert.deepEqual(deriveConvergenceState({ ...input, hasCoveringAuthorityGrant: true }), deriveConvergenceState(input), label);
  }
});

test('the axes checked ahead of the held match keep precedence', () => {
  assert.deepEqual(deriveConvergenceState({ codingState: 'applied', matchHeldPendingAuthority: true, cascadeState: 'failed' }),
    { state: 'hanging', reason: 'cascade_failed' });
  assert.deepEqual(deriveConvergenceState({ codingState: 'applied', matchHeldPendingAuthority: true, hasOpenAgentAsk: true }),
    { state: 'hanging', reason: 'agent_ask_unanswered' });
  // A verified review-only scope never reads terminal; held keeps its own key.
  assert.deepEqual(deriveConvergenceState({ codingState: 'applied', matchHeldPendingAuthority: true, processingScope: { enforced: true, reason_code: 'processing_review_only' } }),
    { state: 'hanging', reason: 'matched_pending_authority_no_grant' });
});

test('every projected state is one of the three, and held is never terminal', () => {
  for (const { input } of BASES) {
    for (const held of [false, true]) {
      for (const covered of [false, true]) {
        const p = deriveConvergenceState({ ...input, matchHeldPendingAuthority: held, hasCoveringAuthorityGrant: covered });
        assert.ok(CONVERGENCE_STATES.includes(p.state), JSON.stringify(p));
        if (held && !covered) assert.equal(p.state, 'hanging');
      }
    }
  }
});

test('LOCK-STEP: the inlined held receipt reader equals reconciliationLlmCore.isMatchedPendingAuthority', () => {
  const fixtures = [
    null, undefined, 'suggested', {}, HELD_RECEIPT,
    { band: 'suggested', reasons: ['above_materiality_ceiling'] },
    { band: 'suggested', reasons: ['above_materiality_ceiling', 'ambiguous_second_best'] },
    { band: 'suggested', reasons: [] },
    { band: 'suggested', reasons: 'above_materiality_ceiling' },
    { band: 'auto_matched', reasons: ['above_materiality_ceiling'] },
    { band: 'auto_matched', reasons: ['delegated_authority'] },
    { band: 'suggested', reasons: ['below_confidence_floor'] }
  ];
  for (const f of fixtures) {
    assert.equal(__isHeldPendingAuthorityReceipt(f), isMatchedPendingAuthority(f), JSON.stringify(f));
  }
});

test('collectHeldPendingAuthorityMatches reads only live suggested rows held by materiality alone', () => {
  const rows = [
    { id: 'm1', status: 'suggested', bank_transaction_id: 'tx-1', payload: { authorization: HELD_RECEIPT } },
    { id: 'm2', status: 'suggested', bank_transaction_id: 'tx-1', payload: { authorization: HELD_RECEIPT } },
    { id: 'm3', status: 'confirmed', bank_transaction_id: 'tx-2', payload: { authorization: HELD_RECEIPT } },
    { id: 'm4', status: 'auto_matched', bank_transaction_id: 'tx-3', payload: { authorization: { ...HELD_RECEIPT, band: 'auto_matched', reasons: ['delegated_authority'] } } },
    { id: 'm5', status: 'rejected', bank_transaction_id: 'tx-4', payload: { authorization: HELD_RECEIPT } },
    { id: 'm6', status: 'suggested', bank_transaction_id: 'tx-5', payload: { authorization: { band: 'suggested', reasons: ['ambiguous_second_best'] } } },
    { id: 'm7', status: 'suggested', bank_transaction_id: 'tx-6', payload: {} },
    { id: 'm8', status: 'suggested', bank_transaction_id: null, payload: { authorization: HELD_RECEIPT } }
  ];
  assert.deepEqual([...collectHeldPendingAuthorityMatches(rows)], [['tx-1', ['m1', 'm2']]]);
  assert.deepEqual([...collectHeldPendingAuthorityMatches(null)], []);
});

test('the adapters carry the held and covering-grant inputs', () => {
  const tx = { id: 'tx-1', coding_state: 'applied', account_code: '7100' };
  assert.deepEqual(convergenceForTransaction(tx), { state: 'auto_reconciled', reason: 'coding_state:applied' });
  assert.deepEqual(convergenceForTransaction(tx, { matchHeldPendingAuthority: true }),
    { state: 'hanging', reason: 'matched_pending_authority_no_grant' });
  assert.deepEqual(convergenceForTransaction(tx, { matchHeldPendingAuthority: true, hasCoveringAuthorityGrant: true }),
    { state: 'auto_reconciled', reason: 'coding_state:applied' });
  const item = { payload: { transaction_id: 'tx-1' } };
  assert.deepEqual(convergenceForReviewItem(item, tx, { matchHeldPendingAuthority: true }),
    { state: 'hanging', reason: 'matched_pending_authority_no_grant' });
  assert.deepEqual(convergenceForReviewItem(item, tx, { matchHeldPendingAuthority: true, hasCoveringAuthorityGrant: true }),
    convergenceForReviewItem(item, tx));
});

test('the persisted-column gather feeds the held input from the gathered matches', () => {
  const gathered = (matches, extra = {}) => ({
    id: 'tx-1', client_id: 'client-1', status: 'categorized', reconciliation_status: 'pending',
    account_code: '7100', coding_state: 'applied', payload: {}, review_items: [], evaluations: [], asks: [],
    goal_report: null, matches, ...extra
  });
  const held = (id) => ({ id, status: 'suggested', bank_transaction_id: 'tx-1', matched_object_type: 'supplier_bill', matched_object_id: `doc-${id}`, payload: { authorization: HELD_RECEIPT } });

  assert.deepEqual(projectGatheredTransaction(gathered([])), { state: 'auto_reconciled', reason: 'coding_state:applied' });
  assert.deepEqual(projectGatheredTransaction(gathered([held('m1')])),
    { state: 'hanging', reason: 'matched_pending_authority_no_grant' });
  assert.deepEqual(projectGatheredTransaction(gathered([held('m1')]), { coveredHeldMatchIds: new Set(['m1']) }),
    { state: 'auto_reconciled', reason: 'coding_state:applied' });
  // Every held match on the line must be covered.
  assert.deepEqual(projectGatheredTransaction(gathered([held('m1'), held('m2')]), { coveredHeldMatchIds: new Set(['m1']) }),
    { state: 'hanging', reason: 'matched_pending_authority_no_grant' });
  // A decided match is not held.
  assert.deepEqual(projectGatheredTransaction(gathered([{ ...held('m1'), status: 'confirmed' }])),
    { state: 'auto_reconciled', reason: 'coding_state:applied' });
  // Through the review-item adapter too.
  assert.deepEqual(projectGatheredTransaction(gathered([held('m1')], { review_items: [{ id: 'q1', payload: { transaction_id: 'tx-1' } }] })),
    { state: 'hanging', reason: 'matched_pending_authority_no_grant' });
});

// ── The full policy table ────────────────────────────────────────────────────
// The module header promises that this test "pins every modeled state to its
// terminal and FAILS CI if a known-leak state is ever silently reclassified as
// terminal". The policy is written here as DATA — an ordered precedence table,
// first matching row wins — built from the module's (and codingState.js's)
// exported vocabulary, and deriveConvergenceState is asserted against it for
// EVERY combination of the input classes below. A change to the projection
// that is not also made to this table fails, deliberately.
const SCOPE_CLASSES = [
  null,
  { enforced: true, reason_code: 'processing_review_only' },
  { enforced: true, native_refusal: true, reason_code: 'native_registration_unverified' }
];
// One representative per class where the module treats members alike; the
// folded members are pinned equal to their representative below.
const RECONCILED_REPRESENTATIVES = ['applied', RECONCILED_CODING_STATES.find((s) => s !== 'applied')];
const CODING_CLASSES = [null, ...RECONCILED_REPRESENTATIVES, ...HANGING_CODING_STATES, OWNER_CODING_STATE, 'legacy_unmodeled'];
const RECON_CLASSES = [null, 'explained', SETTLED_RECON_STATUSES_LOCKSTEP[0], 'pending'];
const CODED_ACCOUNT_CLASSES = [null, '7100'];
const HELD_CLASSES = [[false, false], [true, false], [true, true]];
const REFUSAL_CLASSES = [null, 'LEDGER_PERIOD_LOCKED'];
const CORRECTION_CLASSES = [null, { status: 'pending' }, { status: 'pending', recovery: { state: 'blocked', code: 'EVIDENCE_MISSING' } }];
const ASK_FLAGS = ['hasOpenOwnerAsk', 'hasUndeliverableOwnerAsk', 'hasAnsweredOwnerAsk', 'hasOpenSeatAsk', 'hasAnsweredSeatAsk', 'hasOpenAgentAsk'];
const DISPOSITION_CLASSES = [[null, null], ...SETTLING_DISPOSITIONS_LOCKSTEP.map((d) => [d, null]), ['needs_human', 'owner_ask'], ['chase_evidence', null]];
const CASCADE_CLASSES = [null, 'failed'];

const RECONCILED = new Set(RECONCILED_CODING_STATES);
const HANGING = new Set(HANGING_CODING_STATES);
const SETTLED = new Set(SETTLED_RECON_STATUSES_LOCKSTEP);
const SETTLING = new Set(SETTLING_DISPOSITIONS_LOCKSTEP);
const v = (state, reason) => ({ state, reason });

// Ordered: the first row whose `when` holds gives the verdict.
const POLICY_TABLE = [
  { when: (i) => i.cascadeState && i.cascadeState !== CASCADE_APPLIED_STATE, then: (i) => v('hanging', `cascade_${i.cascadeState}`) },
  { when: (i) => i.hasOpenAgentAsk, then: () => v('hanging', 'agent_ask_unanswered') },
  { when: (i) => i.matchHeldPendingAuthority && !i.hasCoveringAuthorityGrant, then: () => v('hanging', 'matched_pending_authority_no_grant') },
  { when: (i) => i.hasOpenOwnerAsk, then: () => v('on_owner', 'open_owner_ask') },
  { when: (i) => i.codingState === OWNER_CODING_STATE && !i.hasAnsweredOwnerAsk && !i.hasUndeliverableOwnerAsk, then: (i) => v('on_owner', codingStateReasonKey(i.codingState)) },
  { when: (i) => i.hasOpenSeatAsk, then: () => v('on_owner', 'open_seat_ask') },
  { when: (i) => i.hasUndeliverableOwnerAsk && !i.hasAnsweredOwnerAsk, then: () => v('hanging', 'owner_ask_undeliverable') },
  { when: (i) => i.hasAnsweredOwnerAsk, then: () => v('hanging', 'owner_answered_processing') },
  { when: (i) => i.hasAnsweredSeatAsk, then: () => v('hanging', 'seat_answered_processing') },
  { when: (i) => i.codingCorrectionRequired?.recovery, then: (i) => v('hanging', `posted_evidence_correction_${i.codingCorrectionRequired.recovery.state}:${i.codingCorrectionRequired.recovery.code}`) },
  { when: (i) => i.codingCorrectionRequired, then: () => v('hanging', 'posted_evidence_reconsideration_required') },
  { when: (i) => i.codingState === 'applied' && i.ledgerPostRefused, then: (i) => v('hanging', `ledger_post_refused:${i.ledgerPostRefused}`) },
  { when: (i) => RECONCILED.has(i.codingState), then: (i) => v('auto_reconciled', codingStateReasonKey(i.codingState)) },
  { when: (i) => HANGING.has(i.codingState), then: (i) => v('hanging', codingStateReasonKey(i.codingState)) },
  { when: (i) => i.codingState, then: (i) => v('hanging', `coding_state:${i.codingState}`) },
  { when: (i) => i.codingPending && SETTLED.has(i.reconciliationStatus), then: () => v('hanging', 'matched_but_uncoded') },
  { when: (i) => i.codingPending && (i.reconciliationStatus === 'explained' || SETTLING.has(i.disposition)), then: () => v('hanging', 'explained_but_uncoded') },
  { when: (i) => i.reconciliationStatus === 'explained', then: () => v('auto_reconciled', 'reconciliation_status:explained') },
  { when: (i) => SETTLED.has(i.reconciliationStatus) && i.codedAccount, then: (i) => v('auto_reconciled', `reconciliation_status:${i.reconciliationStatus}`) },
  { when: (i) => SETTLED.has(i.reconciliationStatus), then: () => v('hanging', 'matched_but_uncoded') },
  { when: (i) => SETTLING.has(i.disposition), then: (i) => v('auto_reconciled', `disposition:${i.disposition}`) },
  { when: (i) => i.disposition, then: (i) => v('hanging', i.dispositionLane ? `disposition:${i.disposition}:${i.dispositionLane}` : `disposition:${i.disposition}`) },
  { when: (i) => i.reconciliationStatus, then: (i) => v('hanging', `reconciliation_status:${i.reconciliationStatus}`) },
  { when: () => true, then: () => v('hanging', 'unclassified') }
];
// The retained processing scope, applied to the table's verdict.
const SCOPE_TABLE = [
  { when: (s) => !s?.enforced, then: (_s, verdict) => verdict },
  { when: (s) => s.reason_code === 'native_chart_lineage_invalid', then: () => v('hanging', 'native_chart_lineage_invalid') },
  { when: (s) => s.native_refusal === true, then: (s) => v('hanging', s.reason_code) },
  { when: (_s, verdict) => verdict.state === 'auto_reconciled', then: () => v('hanging', 'processing_review_only') },
  { when: () => true, then: (_s, verdict) => verdict }
];
const expectedVerdict = (input) => {
  const verdict = POLICY_TABLE.find((row) => row.when(input)).then(input);
  return SCOPE_TABLE.find((row) => row.when(input.processingScope, verdict)).then(input.processingScope, verdict);
};

// Leak classes the module names: none may ever read terminal. A named human
// owing the next move (an open owner / seat ask, or the owner-facing coding
// state with no reply in and a deliverable ask) is the only terminal 2.
const ON_A_HUMAN = (i) => i.hasOpenOwnerAsk || i.hasOpenSeatAsk
  || (i.codingState === OWNER_CODING_STATE && !i.hasAnsweredOwnerAsk && !i.hasUndeliverableOwnerAsk);
const KNOWN_LEAK = (i) => (i.cascadeState && i.cascadeState !== CASCADE_APPLIED_STATE)
  || i.hasOpenAgentAsk
  || (i.matchHeldPendingAuthority && !i.hasCoveringAuthorityGrant)
  || (!ON_A_HUMAN(i) && (i.hasAnsweredOwnerAsk || i.hasUndeliverableOwnerAsk || i.hasAnsweredSeatAsk
    || HANGING.has(i.codingState) || i.codingCorrectionRequired || (i.codingState === 'applied' && i.ledgerPostRefused)))
  || i.processingScope?.reason_code === 'native_chart_lineage_invalid'
  || i.processingScope?.native_refusal === true;

function* everyCombination() {
  for (const processingScope of SCOPE_CLASSES)
  for (const codingState of CODING_CLASSES)
  for (const reconciliationStatus of RECON_CLASSES)
  for (const codedAccount of CODED_ACCOUNT_CLASSES)
  for (const codingPending of [false, true])
  for (const [matchHeldPendingAuthority, hasCoveringAuthorityGrant] of HELD_CLASSES)
  for (const ledgerPostRefused of REFUSAL_CLASSES)
  for (const codingCorrectionRequired of CORRECTION_CLASSES)
  for (let asks = 0; asks < 2 ** ASK_FLAGS.length; asks += 1)
  for (const [disposition, dispositionLane] of DISPOSITION_CLASSES)
  for (const cascadeState of CASCADE_CLASSES) {
    const input = { processingScope, codingState, reconciliationStatus, codedAccount, codingPending,
      matchHeldPendingAuthority, hasCoveringAuthorityGrant, ledgerPostRefused, codingCorrectionRequired,
      disposition, dispositionLane, cascadeState };
    ASK_FLAGS.forEach((flag, bit) => { input[flag] = Boolean(asks & (1 << bit)); });
    yield input;
  }
}

// [axis, representative, member, the reason prefix that may name the member]:
// members the table folds into one class must project exactly as their
// representative, across every combination of the other classes.
const FOLDED_SWAPS = [
  ...RECONCILED_CODING_STATES.filter((s) => !RECONCILED_REPRESENTATIVES.includes(s)).map((s) => ['codingState', RECONCILED_REPRESENTATIVES[1], s, 'coding_state:']),
  ...SETTLED_RECON_STATUSES_LOCKSTEP.slice(1).map((s) => ['reconciliationStatus', SETTLED_RECON_STATUSES_LOCKSTEP[0], s, 'reconciliation_status:']),
  ['cascadeState', null, CASCADE_APPLIED_STATE, null]
];
const LINEAGE_INVALID = Object.freeze({ enforced: true, reason_code: 'native_chart_lineage_invalid' });

// One pass over every combination (about three million rows) checks all of it.
test('the policy table: every combination of the input classes projects to its asserted verdict', () => {
  let rows = 0;
  let folded = 0;
  const mismatches = [];
  const leaks = [];
  const foldedMismatches = [];
  const seen = new Set();
  const hits = new Array(POLICY_TABLE.length).fill(0);
  for (const input of everyCombination()) {
    rows += 1;
    const actual = deriveConvergenceState(input);
    const expected = expectedVerdict(input);
    if ((actual.state !== expected.state || actual.reason !== expected.reason) && mismatches.length < 5) mismatches.push({ input, expected, actual });
    if (!CONVERGENCE_STATES.includes(actual.state) && leaks.length < 5) leaks.push({ input, actual, problem: 'not a convergence state' });
    if (KNOWN_LEAK(input) && CONVERGENCE_TERMINALS.includes(actual.state) && leaks.length < 5) leaks.push({ input, actual, problem: 'known leak read terminal' });
    seen.add(actual.state);
    // The scope is applied to the unscoped verdict alone (SCOPE_TABLE), so the
    // remaining checks need only the unscoped rows.
    if (input.processingScope !== null) continue;
    hits[POLICY_TABLE.findIndex((row) => row.when(input))] += 1;
    // An unverifiable native lineage hangs every row under its own key.
    const lineage = deriveConvergenceState({ ...input, processingScope: LINEAGE_INVALID });
    if ((lineage.state !== 'hanging' || lineage.reason !== 'native_chart_lineage_invalid') && leaks.length < 5) leaks.push({ input, actual: lineage, problem: 'lineage invalid did not hang' });
    for (const [key, representative, member, prefix] of FOLDED_SWAPS) {
      if (input[key] !== representative) continue;
      folded += 1;
      const swapped = deriveConvergenceState({ ...input, [key]: member });
      const reason = prefix && actual.reason === `${prefix}${representative}` ? `${prefix}${member}` : actual.reason;
      if ((swapped.state !== actual.state || swapped.reason !== reason) && foldedMismatches.length < 5) foldedMismatches.push({ key, member, input, swapped, actual });
    }
  }
  assert.deepEqual(mismatches, [], 'combinations that disagree with the policy table');
  assert.deepEqual(leaks, []);
  assert.deepEqual(foldedMismatches, [], 'folded class members that differ from their representative');
  // The table is exercised end to end: every state and every precedence row.
  assert.deepEqual([...seen].sort(), [...CONVERGENCE_STATES].sort());
  assert.deepEqual(hits.map((n, i) => (n > 0 ? null : i)).filter((i) => i != null), [], 'unreached policy rows');
  assert.ok(folded > 0);
  assert.equal(rows, SCOPE_CLASSES.length * CODING_CLASSES.length * RECON_CLASSES.length * CODED_ACCOUNT_CLASSES.length * 2
    * HELD_CLASSES.length * REFUSAL_CLASSES.length * CORRECTION_CLASSES.length * 2 ** ASK_FLAGS.length
    * DISPOSITION_CLASSES.length * CASCADE_CLASSES.length);
});

test('the input classes stand for their whole vocabulary', () => {
  // codingState.js's partition: reconciled ∪ hanging ∪ {owner} = every state, disjoint.
  const partition = [...RECONCILED_CODING_STATES, ...HANGING_CODING_STATES, OWNER_CODING_STATE];
  assert.equal(new Set(partition).size, partition.length);
  assert.deepEqual([...partition].sort(), [...CODING_STATES].sort());
  assert.ok(CONVERGENCE_TERMINALS.every((s) => CONVERGENCE_STATES.includes(s)));
  assert.deepEqual(CONVERGENCE_STATES.filter((s) => !CONVERGENCE_TERMINALS.includes(s)), ['hanging']);
  // The classes the table folds together project identically.
  for (const input of [{ codingState: 'applied' }, { reconciliationStatus: 'reconciled' }, { disposition: 'needs_human' }, {}]) {
    // An uncoded account: absent, 'Suspense' and 'unknown' are one class.
    for (const account of ['Suspense', 'unknown', ' suspense ']) {
      assert.deepEqual(deriveConvergenceState({ ...input, reconciliationStatus: 'reconciled', codedAccount: account }),
        deriveConvergenceState({ ...input, reconciliationStatus: 'reconciled', codedAccount: null }), account);
    }
    // A grant flag with nothing held is no input.
    assert.deepEqual(deriveConvergenceState({ ...input, hasCoveringAuthorityGrant: true }), deriveConvergenceState(input));
    // Every non-applied cascade state hangs under its own key, ahead of the rest.
    assert.deepEqual(deriveConvergenceState({ ...input, cascadeState: 'exhausted' }), { state: 'hanging', reason: 'cascade_exhausted' });
    // Every disposition outside the settling set hangs under its own key.
    for (const disposition of ['needs_human', 'chase_receipt', 'chase_evidence', 'unmodeled_verdict']) {
      const p = deriveConvergenceState({ disposition });
      assert.deepEqual(p, { state: 'hanging', reason: `disposition:${disposition}` });
    }
  }
  // Inputs are case- and space-normalised the way the persisted rows arrive.
  assert.deepEqual(deriveConvergenceState({ codingState: ' Applied ' }), deriveConvergenceState({ codingState: 'applied' }));
  assert.deepEqual(deriveConvergenceState({ reconciliationStatus: 'EXPLAINED' }), deriveConvergenceState({ reconciliationStatus: 'explained' }));
});
