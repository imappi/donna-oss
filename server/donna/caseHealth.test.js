// buildCaseHealth — the seven-question contract (Slice 1,
// docs/session-handoff-2026-08-17-case-health-projection.md). Pins:
//   - the §4 proof case: a qwen Suspense refusal on a transfer line with no
//     open ask projects blocker 'coding_refusal' (carrying the PERSISTED
//     reasoning), recovery 'owner_action_required', and the VISIBLE
//     `no_open_ask_for_owner_fact` gap — the invariant working
//   - the convergence verdict is the one precedence authority; blocker kinds
//     map its reasons, never a second derivation
//   - Q4 reuses the caseTimeline events verbatim (pre-built or internally
//     built — identical either way; never a second merge)
//   - Q7 stays exactly the four typed classes; a firm-side limbo none fits
//     answers class null + `no_automatic_recovery_path` — surfaced, never a
//     wrong label
//   - every hole in the seven answers is a NAMED writer gap, and every
//     emitted kind is in the closed enums

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildCaseHealth,
  RECOVERY_CLASSES,
  CASE_PHASES,
  BLOCKER_KINDS,
  CASE_HEALTH_GAP_KINDS
} from './caseHealth.js';
import { CODING_RECONSIDERATION_CONTRACT } from './codingPolicyRecovery.js';
import { buildCaseTimeline } from './caseTimeline.js';

// ── fixtures ────────────────────────────────────────────────────────────────

// The §4 proof case, shaped as it persists on the mini's honeybee book:
// ONLINE TRANSFER TO SAV — qwen refused to code (Suspense; counter-account
// ownership is an owner FACT), proposal resting at review_state 'suggested',
// NO client_evidence_request minted.
const TRANSFER_REFUSAL_REASONING =
  'Cannot determine whether account ending 81761647226 is Honeybee-owned; transfer vs. payment depends on it.';
const TRANSFER_TX = {
  id: 'tx-transfer-1',
  document_id: 'statement-1',
  created_at: '2026-08-17T08:00:03.000Z',
  reconciliation_status: null,
  payload: {
    ai_suggestion: {
      proposed_account: 'Suspense',
      confidence: 'low',
      evidence_required: true,
      model: 'qwen/qwen3.8-27b',
      policy_basis: 'experiment',
      reasoning: TRANSFER_REFUSAL_REASONING,
      suggested_at: Date.parse('2026-08-17T08:05:00.000Z')
    }
  }
};
const TRANSFER_REVIEW_ITEM = {
  id: 'rq-transfer-1',
  item_id: 'tx-transfer-1',
  review_state: 'suggested',
  payload: { transaction_id: 'tx-transfer-1', review_state: 'suggested' }
};

const OPEN_ASK = {
  id: 'cer-1',
  transaction_id: 'tx-transfer-1',
  question: 'Is the account ending 81761647226 yours?',
  evidence_type: 'owner_fact',
  status: 'open',
  created_at: '2026-08-17T09:00:00.000Z',
  first_sent_at: '2026-08-17T09:01:00.000Z'
};

const APPLIED_TX = {
  id: 'tx-done-1',
  created_at: '2026-08-17T08:00:03.000Z',
  reconciliation_status: 'reconciled',
  account_name: 'Rent',
  payload: {
    ai_suggestion_status: 'auto_applied',
    ai_suggestion: {
      proposed_account: 'Rent',
      confidence: 'high',
      model: 'qwen/qwen3.8-27b',
      policy_basis: 'experiment',
      reasoning: 'Recurring monthly office rent to the known landlord.',
      suggested_at: Date.parse('2026-08-17T08:05:00.000Z')
    }
  }
};

const AUTO_MATCH = {
  id: 'm-1',
  bank_transaction_id: 'tx-done-1',
  matched_object_type: 'supplier_bill',
  matched_object_id: 'doc-bill-1',
  status: 'auto_matched',
  created_at: '2026-08-17T08:10:00.000Z',
  updated_at: '2026-08-17T08:10:01.000Z',
  payload: {
    match_reason: { summary: 'Exact amount on the bill date.', reasoning: 'No competing candidate.' },
    authorization: { band: 'auto_matched', model: 'qwen/qwen3.8-27b' },
    cascade: { state: 'applied', at: '2026-08-17T08:10:02.000Z', attempts: 1 }
  }
};

const dispositionEval = (disposition, { id = 'ev-disp-1', reasoning = 'Small recurring bank fee.', txId = 'tx-transfer-1' } = {}) => ({
  id,
  target_type: 'transaction',
  target_id: txId,
  matcher_family: 'bank_line_disposition',
  verdict: 'unmatchable',
  model: 'qwen/qwen3.8-27b',
  evaluated_at: '2026-08-17T08:06:00.000Z',
  payload: { disposition, reasoning, confidence: 0.9 }
});

const enumsOk = (health) => {
  assert.ok([...CASE_PHASES, null].includes(health.phase), `phase ${health.phase} not in CASE_PHASES`);
  if (health.blocker) assert.ok(BLOCKER_KINDS.includes(health.blocker.kind), `blocker kind ${health.blocker.kind}`);
  assert.ok(health.recovery.class === null || RECOVERY_CLASSES.includes(health.recovery.class), `recovery ${health.recovery.class}`);
  for (const gap of health.gaps) assert.ok(CASE_HEALTH_GAP_KINDS.includes(gap.kind), `gap kind ${gap.kind}`);
};

// ── the §4 proof case ───────────────────────────────────────────────────────

await test('§4 proof case: a Suspense refusal with no open ask — blocker, evidence, recovery, and the VISIBLE gap', () => {
  const health = buildCaseHealth({ transaction: TRANSFER_TX, reviewItem: TRANSFER_REVIEW_ITEM });
  enumsOk(health);
  assert.deepEqual(health.convergence, { state: 'hanging', reason: 'coding_state:proposed', terminal: false });
  assert.equal(health.phase, 'stuck');
  // Q1 — the blocker is the coder's refusal, carrying the PERSISTED reasoning
  assert.equal(health.blocker.kind, 'coding_refusal');
  assert.equal(health.blocker.detail, TRANSFER_REFUSAL_REASONING);
  assert.deepEqual(health.blocker.receipt_ref, { table: 'transactions', id: 'tx-transfer-1', path: 'payload.ai_suggestion' });
  // Q2 — the missing thing is an owner fact nobody asked for
  assert.deepEqual(health.missing_evidence.map((e) => e.kind), ['owner_fact_unasked']);
  assert.equal(health.missing_evidence[0].source, 'coding_refusal');
  assert.equal(health.missing_evidence[0].reasoning, TRANSFER_REFUSAL_REASONING);
  // Q6 — no persisted question exists; the module never composes one
  assert.equal(health.owner_question, null);
  // Q7 — the unlock is an owner fact
  assert.deepEqual(health.recovery, { class: 'owner_action_required', basis: 'coding_refusal_owner_fact' });
  // The invariant working: the missing ask mint is a NAMED writer gap
  assert.deepEqual(
    health.gaps.filter((g) => g.kind === 'no_open_ask_for_owner_fact'),
    [{ kind: 'no_open_ask_for_owner_fact', source: 'coding_refusal', receipt_ref: { table: 'transactions', id: 'tx-transfer-1', path: 'payload.ai_suggestion' } }]
  );
});

await test('the same refusal WITH an open ask projects on_owner: question verbatim, no ask-mint gap', () => {
  const health = buildCaseHealth({
    transaction: TRANSFER_TX,
    reviewItem: TRANSFER_REVIEW_ITEM,
    evidenceRequests: [OPEN_ASK]
  });
  enumsOk(health);
  assert.deepEqual(health.convergence, { state: 'on_owner', reason: 'open_owner_ask', terminal: true });
  assert.equal(health.phase, 'needs_owner');
  assert.equal(health.blocker.kind, 'awaiting_owner_answer');
  assert.equal(health.blocker.detail, 'Is the account ending 81761647226 yours?');
  assert.equal(health.owner_question.question, 'Is the account ending 81761647226 yours?');
  assert.equal(health.owner_question.evidence_type, 'owner_fact');
  assert.deepEqual(health.recovery, { class: 'owner_action_required', basis: 'open_owner_ask' });
  assert.ok(!health.gaps.some((g) => g.kind === 'no_open_ask_for_owner_fact'), 'ask exists — no mint gap');
  assert.ok(!health.gaps.some((g) => g.kind === 'owner_ask_without_question_text'));
});

// ── terminals ───────────────────────────────────────────────────────────────

await test('a finished line: phase finished, no blocker, recovery yes, reasons carry model + policy basis', () => {
  const health = buildCaseHealth({ transaction: APPLIED_TX, matches: [AUTO_MATCH] });
  enumsOk(health);
  assert.equal(health.convergence.state, 'auto_reconciled');
  assert.equal(health.phase, 'finished');
  assert.equal(health.blocker, null);
  assert.equal(health.recovery.class, 'yes');
  const coding = health.reasons.find((r) => r.decision === 'coding');
  assert.equal(coding.model, 'qwen/qwen3.8-27b');
  assert.equal(coding.policy_basis, 'experiment');
  assert.equal(coding.at, '2026-08-17T08:05:00.000Z'); // epoch millis → ISO
  const match = health.reasons.find((r) => r.decision === 'match');
  assert.equal(match.summary, 'Exact amount on the bill date.');
  assert.deepEqual(health.gaps, []);
});

await test('disposition auto_explain settles the line: finished, recovery yes, the verdict in reasons', () => {
  const tx = { id: 'tx-fee-1', created_at: '2026-08-17T08:00:00.000Z' };
  const health = buildCaseHealth({
    transaction: tx,
    evaluations: [dispositionEval('auto_explain', { txId: 'tx-fee-1' })]
  });
  enumsOk(health);
  assert.deepEqual(health.convergence, { state: 'auto_reconciled', reason: 'disposition:auto_explain', terminal: true });
  assert.equal(health.recovery.class, 'yes');
  const disp = health.reasons.find((r) => r.decision === 'disposition');
  assert.equal(disp.disposition, 'auto_explain');
  assert.equal(disp.reasoning, 'Small recurring bank fee.');
  assert.equal(disp.model, 'qwen/qwen3.8-27b');
});

// ── owner-side states ───────────────────────────────────────────────────────

await test('on_owner via review_state with NO persisted question is the owner_ask_without_question_text gap', () => {
  const health = buildCaseHealth({
    transaction: { id: 'tx-asked-1' },
    reviewItem: { id: 'rq-2', item_id: 'tx-asked-1', review_state: 'asked_client', payload: { transaction_id: 'tx-asked-1' } }
  });
  enumsOk(health);
  assert.equal(health.convergence.state, 'on_owner');
  assert.equal(health.owner_question, null);
  assert.equal(health.blocker.kind, 'awaiting_owner_answer');
  assert.equal(health.blocker.detail, null);
  assert.deepEqual(health.gaps, [{ kind: 'owner_ask_without_question_text', reason: 'coding_state:asked' }]);
});

await test('F8 — an answered, unprocessed reply: phase processing to the owner, hanging in the metric, recovery retrying', () => {
  const replied = { ...OPEN_ASK, status: 'replied', responded_at: '2026-08-17T10:00:00.000Z' };
  const health = buildCaseHealth({
    transaction: TRANSFER_TX,
    reviewItem: TRANSFER_REVIEW_ITEM,
    evidenceRequests: [replied]
  });
  enumsOk(health);
  assert.deepEqual(health.convergence, { state: 'hanging', reason: 'owner_answered_processing', terminal: false });
  assert.equal(health.phase, 'processing', 'the owner did their part — the owner-facing bucket is processing');
  assert.equal(health.blocker.kind, 'owner_reply_unprocessed');
  assert.deepEqual(health.recovery, { class: 'retrying', basis: 'owner_reply_resume_leg' });
  assert.equal(health.owner_question, null, 'a replied ask is no longer an open question');
});

// ── firm-side limbo: every branch names its blocker; none gets a wrong label ─

await test('a failed cascade: typed integration failure, blocker cascade_not_applied, recovery null + named gaps', () => {
  const failedMatch = {
    ...AUTO_MATCH,
    bank_transaction_id: 'tx-cascade-1',
    payload: {
      ...AUTO_MATCH.payload,
      cascade: { state: 'failed', at: '2026-08-17T08:10:02.000Z', attempts: 1, error_class: 'DeadlockDetected' }
    }
  };
  const health = buildCaseHealth({ transaction: { id: 'tx-cascade-1' }, matches: [failedMatch] });
  enumsOk(health);
  assert.deepEqual(health.convergence, { state: 'hanging', reason: 'cascade_failed', terminal: false });
  assert.equal(health.phase, 'stuck');
  assert.equal(health.blocker.kind, 'cascade_not_applied');
  assert.deepEqual(health.blocker.detail, { failure: 'DeadlockDetected', attempts: 1 });
  const failure = health.integration_failures.find((f) => f.system === 'reconciliation_cascade');
  assert.equal(failure.failure, 'DeadlockDetected');
  assert.equal(failure.retry_safe, null, 'retry contract not persisted — the visible hole');
  assert.deepEqual(health.recovery, { class: null, basis: 'cascade_has_no_retry_contract' });
  assert.ok(health.gaps.some((g) => g.kind === 'untyped_integration_failure' && g.system === 'reconciliation_cascade'));
  assert.ok(health.gaps.some((g) => g.kind === 'no_automatic_recovery_path'));
});

await test('a confident SUGGESTED coding resting on a firm click: coding_unapplied, recovery null + gap', () => {
  const confidentTx = {
    ...TRANSFER_TX,
    id: 'tx-conf-1',
    payload: {
      ai_suggestion: {
        proposed_account: 'Software Subscriptions', confidence: 'high',
        model: 'qwen/qwen3.8-27b', reasoning: 'Known monthly SaaS vendor.',
        suggested_at: Date.parse('2026-08-17T08:05:00.000Z')
      }
    }
  };
  const health = buildCaseHealth({
    transaction: confidentTx,
    reviewItem: { id: 'rq-3', item_id: 'tx-conf-1', review_state: 'suggested', payload: { transaction_id: 'tx-conf-1' } }
  });
  enumsOk(health);
  assert.equal(health.blocker.kind, 'coding_unapplied');
  assert.deepEqual(health.blocker.detail, { proposed_account: 'Software Subscriptions', confidence: 'high' });
  assert.deepEqual(health.recovery, { class: null, basis: 'suggested_resting_on_firm_click' });
  assert.ok(health.gaps.some((g) => g.kind === 'no_automatic_recovery_path'));
  assert.ok(!health.gaps.some((g) => g.kind === 'no_open_ask_for_owner_fact'), 'a confident proposal is not a refusal');
});

await test('a reviewer hold: blocker reviewer_hold, recovery null + gap', () => {
  const health = buildCaseHealth({
    transaction: { id: 'tx-held-1' },
    reviewItem: { id: 'rq-4', item_id: 'tx-held-1', review_state: 'held', payload: { transaction_id: 'tx-held-1' } }
  });
  enumsOk(health);
  assert.equal(health.blocker.kind, 'reviewer_hold');
  assert.equal(health.recovery.class, null);
});

await test('a held suggested match resting on authorization: match_awaiting_authority with the persisted hold reasons', () => {
  // matched_pending_authority is a feed-supplied axis the adapters cannot
  // see; the receipt-shaped read is the held match row itself. Convergence
  // still binds via the review_state, and the blocker renders the
  // authorization receipt.
  const heldMatch = {
    id: 'm-held-1',
    bank_transaction_id: 'tx-mat-1',
    status: 'suggested',
    created_at: '2026-08-17T08:10:00.000Z',
    payload: {
      match_reason: { summary: 'Amount and vendor agree.' },
      authorization: { band: 'suggested', reasons: ['materiality_ceiling'], gates: { E: false }, model: 'qwen/qwen3.8-27b' }
    }
  };
  const health = buildCaseHealth({
    transaction: { id: 'tx-mat-1', reconciliation_status: 'reconciled' }, // settled but uncoded
    matches: [heldMatch]
  });
  enumsOk(health);
  assert.equal(health.convergence.reason, 'matched_but_uncoded');
  assert.equal(health.blocker.kind, 'matched_but_uncoded');
  const matchReason = health.reasons.find((r) => r.decision === 'match');
  assert.equal(matchReason.model, 'qwen/qwen3.8-27b');
  assert.equal(health.recovery.class, null);
});

await test('a chase_evidence verdict with no open ask: disposition_gap_unrouted + the ask-mint gap, recovery owner_action_required', () => {
  const tx = { id: 'tx-chase-1', created_at: '2026-08-17T08:00:00.000Z' };
  const health = buildCaseHealth({
    transaction: tx,
    evaluations: [dispositionEval('chase_evidence', { txId: 'tx-chase-1', reasoning: 'A receipt should exist for this card spend.' })]
  });
  enumsOk(health);
  assert.deepEqual(health.convergence, { state: 'hanging', reason: 'disposition:chase_evidence', terminal: false });
  assert.equal(health.blocker.kind, 'disposition_gap_unrouted');
  assert.deepEqual(health.blocker.detail, { disposition: 'chase_evidence', reasoning: 'A receipt should exist for this card spend.' });
  assert.deepEqual(health.missing_evidence.map((e) => [e.kind, e.source]), [['owner_fact_unasked', 'disposition:chase_evidence']]);
  assert.deepEqual(health.recovery, { class: 'owner_action_required', basis: 'disposition:chase_evidence' });
  assert.ok(health.gaps.some((g) => g.kind === 'no_open_ask_for_owner_fact' && g.source === 'disposition:chase_evidence'));
});

await test('INV-4: a settling match outranks the disposition verdict — the superseded verdict drops from reasons', () => {
  const settledMatch = { ...AUTO_MATCH, bank_transaction_id: 'tx-inv4-1' };
  const health = buildCaseHealth({
    transaction: { id: 'tx-inv4-1', reconciliation_status: 'reconciled', account_name: 'Rent' },
    matches: [settledMatch],
    evaluations: [dispositionEval('needs_human', { txId: 'tx-inv4-1' })]
  });
  enumsOk(health);
  assert.equal(health.convergence.state, 'auto_reconciled');
  assert.ok(!health.reasons.some((r) => r.decision === 'disposition'), 'settled match outranks the verdict');
  assert.ok(!health.gaps.some((g) => g.kind === 'no_open_ask_for_owner_fact'));
});

// ── integration failures + processing refinements ───────────────────────────

await test('a failed parse: typed document_parse failure with last_good_state, blocker integration_failure', () => {
  const health = buildCaseHealth({
    transaction: { id: 'tx-parse-1' },
    documents: [{
      id: 'doc-stuck-1', filename: 'airwallex.pdf', parse_status: 'failed',
      parse_stage: 'extracting', parse_error: 'ExtractionTimeout', uploaded_at: '2026-08-17T07:00:00.000Z'
    }]
  });
  enumsOk(health);
  const failure = health.integration_failures.find((f) => f.system === 'document_parse');
  assert.equal(failure.failure, 'ExtractionTimeout');
  assert.equal(failure.last_good_state, 'extracting');
  assert.equal(failure.retry_safe, null);
  assert.equal(health.blocker.kind, 'integration_failure');
  assert.deepEqual(health.blocker.detail, { system: 'document_parse', failure: 'ExtractionTimeout' });
  assert.ok(health.gaps.some((g) => g.kind === 'untyped_integration_failure' && g.system === 'document_parse'));
});

await test('an inline post-parse leg failure receipt: TYPED integration failure, blocker integration_failure, no untyped gap', () => {
  // The 2026-08-19 side-lab finding: the drain's leg died, the parse row
  // stayed `completed`, and without the audit receipt this line rendered
  // "Stuck for a reason that was not recorded."
  const health = buildCaseHealth({
    transaction: { id: 'tx-leg-1', document_id: 'doc-leg-1' },
    documents: [{
      id: 'doc-leg-1', parse_status: 'completed', parse_run_id: 'run-a', uploaded_at: '2026-08-19T07:00:00.000Z'
    }],
    auditEvents: [{
      id: 'ae-leg-1', action: 'document.parse.leg_failed', resource_type: 'document', resource_id: 'doc-leg-1',
      actor_type: 'system', created_at: '2026-08-19T07:05:00.000Z',
      metadata: { leg: 'reconciliation-scan', parse_run_id: 'run-a', retry_safe: true, error: 'connect ECONNREFUSED 127.0.0.1:5432' }
    }]
  });
  enumsOk(health);
  const failure = health.integration_failures.find((f) => f.system === 'post_parse_leg');
  assert.equal(failure.operation, 'reconciliation-scan');
  assert.equal(failure.failure, 'connect ECONNREFUSED 127.0.0.1:5432');
  assert.equal(failure.retry_safe, true);
  assert.equal(failure.last_good_state, 'parse:completed');
  assert.deepEqual(failure.receipt_ref, { table: 'audit_events', id: 'ae-leg-1', path: 'metadata' });
  assert.equal(health.blocker.kind, 'integration_failure');
  assert.deepEqual(health.blocker.detail, { system: 'post_parse_leg', failure: 'connect ECONNREFUSED 127.0.0.1:5432' });
  // The receipt is TYPED — no untyped_integration_failure gap for it, and
  // the recovery basis says so (nothing re-drives a dead drain leg).
  assert.ok(!health.gaps.some((g) => g.kind === 'untyped_integration_failure' && g.system === 'post_parse_leg'));
  assert.deepEqual(health.recovery, { class: null, basis: 'integration_failure_no_redrive' });
});

await test('a leg-failure receipt from a SUPERSEDED parse run is history, not the current blocker', () => {
  const health = buildCaseHealth({
    transaction: { id: 'tx-leg-2', document_id: 'doc-leg-2' },
    documents: [{ id: 'doc-leg-2', parse_status: 'completed', parse_run_id: 'run-b-fresh' }],
    auditEvents: [{
      id: 'ae-leg-2', action: 'document.parse.leg_failed', resource_type: 'document', resource_id: 'doc-leg-2',
      actor_type: 'system', created_at: '2026-08-19T07:05:00.000Z',
      metadata: { leg: 'ai-coding', parse_run_id: 'run-b-stale', retry_safe: true, error: 'boom' }
    }]
  });
  enumsOk(health);
  assert.equal(health.integration_failures.length, 0);
  assert.equal(health.blocker.kind, 'unclassified');
});

await test('a parse mid-flight with no other axis: phase processing, concrete stage, recovery yes', () => {
  const health = buildCaseHealth({
    transaction: { id: 'tx-flight-1' },
    documents: [{
      id: 'doc-flight-1', parse_status: 'processing', parse_stage: 'reading',
      parse_progress_current: 1, parse_progress_total: 3
    }]
  });
  enumsOk(health);
  assert.equal(health.phase, 'processing');
  assert.equal(health.blocker.kind, 'processing');
  assert.deepEqual(health.blocker.detail, { stage: 'reading', progress_current: 1, progress_total: 3 });
  assert.deepEqual(health.recovery, { class: 'yes', basis: 'parse_in_flight' });
});

// ── Q4 reuse + Q5 holes + shape discipline ──────────────────────────────────

await test('Q4: a pre-built timeline rides verbatim; absent, the internal build is identical', () => {
  const inputs = { transaction: APPLIED_TX, matches: [AUTO_MATCH] };
  const prebuilt = buildCaseTimeline({ transaction: APPLIED_TX, documents: [], matches: [AUTO_MATCH], evaluations: [], evidenceRequests: [], auditEvents: [], actors: [] });
  const withPrebuilt = buildCaseHealth({ ...inputs, timeline: prebuilt });
  const withoutPrebuilt = buildCaseHealth(inputs);
  assert.equal(withPrebuilt.actions, prebuilt.events, 'the same array, not a re-merge');
  assert.deepEqual(withoutPrebuilt.actions, prebuilt.events);
});

await test('Q5: a consequential decision without persisted reasoning is a missing_reasoning_receipt gap', () => {
  const bareMatch = {
    id: 'm-bare-1', bank_transaction_id: 'tx-bare-1', status: 'auto_matched',
    created_at: '2026-08-17T08:10:00.000Z',
    payload: { authorization: { model: 'qwen/qwen3.8-27b' }, cascade: { state: 'applied' } }
  };
  const health = buildCaseHealth({
    transaction: { id: 'tx-bare-1', reconciliation_status: 'reconciled', account_name: 'Rent' },
    matches: [bareMatch]
  });
  assert.deepEqual(
    health.gaps.filter((g) => g.kind === 'missing_reasoning_receipt'),
    [{ kind: 'missing_reasoning_receipt', decision: 'match', receipt_ref: { table: 'reconciliation_matches', id: 'm-bare-1' } }]
  );
});

await test('no focus row: stable shape, the no_focus_row gap, nothing invented', () => {
  const health = buildCaseHealth({});
  assert.equal(health.convergence, null);
  assert.equal(health.phase, null);
  assert.equal(health.blocker, null);
  assert.deepEqual(health.gaps, [{ kind: 'no_focus_row' }]);
  assert.deepEqual(health.recovery, { class: null, basis: 'no_focus_row' });
});

await test('the enums are closed and frozen', () => {
  for (const list of [RECOVERY_CLASSES, CASE_PHASES, BLOCKER_KINDS, CASE_HEALTH_GAP_KINDS]) {
    assert.ok(Object.isFrozen(list));
    assert.ok(list.length > 0);
  }
  assert.deepEqual(RECOVERY_CLASSES, ['yes', 'retrying', 'waiting_for_external_system', 'owner_action_required']);
});

await test('an unmodeled state concedes honestly: blocker unclassified, recovery null + gap — never a fabricated answer', () => {
  const health = buildCaseHealth({ transaction: { id: 'tx-mystery-1' } });
  enumsOk(health);
  assert.equal(health.convergence.state, 'hanging');
  assert.equal(health.blocker.kind, 'unclassified');
  assert.equal(health.recovery.class, null);
  assert.ok(health.gaps.some((g) => g.kind === 'no_automatic_recovery_path'));
});

await test('a live readiness-admission hold names itself instead of conceding unclassified', () => {
  const hold = {
    boundary: 'worker_discovery',
    reason_code: 'entity_dependency_changed',
    retry_state: 'scheduled',
    receipt_ref: { table: 'audit_events', id: 4411 }
  };
  const health = buildCaseHealth({ transaction: { id: 'tx-held-1' }, readinessHold: hold });
  enumsOk(health);
  assert.equal(health.convergence.state, 'hanging');
  assert.equal(health.blocker.kind, 'held_by_setup_recovery');
  assert.deepEqual(health.blocker.detail, {
    boundary: 'worker_discovery',
    reason_code: 'entity_dependency_changed'
  });
  assert.deepEqual(health.blocker.receipt_ref, { table: 'audit_events', id: 4411 });
  assert.equal(health.phase, 'processing');
  assert.equal(health.recovery.class, 'retrying');
  assert.equal(health.recovery.basis, 'readiness_recovery_in_progress');
});

await test('an exhausted readiness hold is stuck with no automatic path — the reopen is a human act', () => {
  const health = buildCaseHealth({
    transaction: { id: 'tx-held-2' },
    readinessHold: {
      boundary: 'reconciliation_authority',
      reason_code: 'prior_client_residue:client_evidence_requests',
      retry_state: 'exhausted',
      receipt_ref: { table: 'audit_events', id: 4412 }
    }
  });
  enumsOk(health);
  assert.equal(health.blocker.kind, 'held_by_setup_recovery');
  assert.equal(health.phase, 'stuck');
  assert.equal(health.recovery.class, null);
  assert.equal(health.recovery.basis, 'readiness_recovery_exhausted');
  assert.ok(health.gaps.some((g) => g.kind === 'no_automatic_recovery_path'));
});

await test('the hold outranks parse-in-flight: a pending doc behind a hold is not live progress', () => {
  const health = buildCaseHealth({
    transaction: { id: 'tx-held-3' },
    documents: [{ id: 'doc-held-1', parse_status: 'pending', parse_stage: null }],
    readinessHold: {
      boundary: 'parse_claim',
      reason_code: 'entity_readiness_failed',
      retry_state: 'scheduled',
      receipt_ref: { table: 'audit_events', id: 4413 }
    }
  });
  enumsOk(health);
  assert.equal(health.blocker.kind, 'held_by_setup_recovery');
  assert.equal(health.blocker.detail.boundary, 'parse_claim');
});

// RT-23 refusal rendering (Kampaamo, 2026-09-21): nine applied codings the
// ledger refused rendered as "not recorded" although the refusal was persisted.
await test('an applied coding the ledger refused shows its recorded refusal; a clock-owned code is retrying until its bound is spent', () => {
  // The sweep and the posting-policy receipt both persist the sentence as `error`.
  const refusal = { code: 'TRANSACTION_ALV_TREATMENT_UNRESOLVED', error: 'The coding says ALV-tarkistus, which maps to no ALV code.', source: 'ledger_auto_post_sweep' };
  const refused = { ...APPLIED_TX, payload: { ...APPLIED_TX.payload, ledger_post_refusal: refusal } };
  const health = buildCaseHealth({ transaction: refused });
  enumsOk(health);
  assert.equal(health.convergence.state, 'hanging');
  assert.equal(health.convergence.reason, 'ledger_post_refused:TRANSACTION_ALV_TREATMENT_UNRESOLVED');
  // Freshly refused: the evidence clock (statement-only) or the source re-read
  // lane (settled source) picks it up on the next tick — never a stall flash.
  assert.equal(health.phase, 'processing');
  assert.equal(health.blocker.kind, 'integration_failure');
  assert.deepEqual(health.blocker.detail, { system: 'ledger_post', failure: refusal.code, message: refusal.error });
  assert.deepEqual(health.blocker.receipt_ref, { table: 'transactions', id: 'tx-done-1', path: 'payload.ledger_post_refusal' });
  assert.deepEqual(health.recovery, { class: 'retrying', basis: 'ledger_post_refusal_recovery' });
  const contract = CODING_RECONSIDERATION_CONTRACT;
  const owned = buildCaseHealth({ transaction: { ...refused, payload: { ...refused.payload, coding_evidence_reconsideration: { contract, attempts: 1 } } } });
  assert.equal(owned.phase, 'processing');
  // Snapshot rows flatten payload keys; the flattened shape reads the same.
  const flattened = buildCaseHealth({ transaction: { ...APPLIED_TX, ledger_post_refusal: refusal, coding_evidence_reconsideration: { contract, attempts: 2 } } });
  assert.equal(flattened.phase, 'processing');
  assert.equal(flattened.blocker.detail.message, refusal.error);
  const spent = buildCaseHealth({ transaction: { ...refused, payload: { ...refused.payload, coding_evidence_reconsideration: { contract, attempts: 3 } } } });
  assert.equal(spent.phase, 'stuck');
  assert.equal(spent.recovery.class, null);
  assert.ok(spent.gaps.some((g) => g.kind === 'no_automatic_recovery_path'));
  // A bound spent under an earlier coding contract (the ten Kampaamo rows,
  // 2026-09-21) is re-admitted by the evidence clock, so it is processing —
  // the projection reads the worker's own attempt rule, never a bare count.
  const legacy = buildCaseHealth({ transaction: { ...refused, payload: { ...refused.payload, coding_evidence_reconsideration: { attempts: 3 } } } });
  assert.equal(legacy.phase, 'processing');
  assert.deepEqual(legacy.recovery, { class: 'retrying', basis: 'ledger_post_refusal_recovery' });
  const recheckExhausted = buildCaseHealth({ transaction: { ...refused, payload: { ...refused.payload, posting_recovery: { state: 'exhausted' } } } });
  assert.equal(recheckExhausted.phase, 'stuck');
  // A refusal no clock reconsiders has no automatic path from the first tick.
  const unowned = buildCaseHealth({ transaction: { ...APPLIED_TX, payload: { ...APPLIED_TX.payload,
    ledger_post_refusal: { code: 'TRANSACTION_ALV_ACCOUNT_INCOMPATIBLE', error: 'The explicit ALV code conflicts with the resolved account.' } } } });
  assert.equal(unowned.phase, 'stuck');
  assert.equal(unowned.blocker.detail.message, 'The explicit ALV code conflicts with the resolved account.');
  assert.equal(unowned.recovery.class, null);
});

await test('verified saved review has no accounting terminal or invented recovery; stale receipt loses its label', () => {
  const transaction = {id:'native-review',coding_state:'applied',account_code:'7000',
    convergence_state:'hanging',convergence_reason:'processing_review_only',
    processing_scope:{enforced:true,review_current:true},review_scope:{acceptance_audit:{table:'audit_events',id:'accept-1'}}};
  const saved = buildCaseHealth({transaction});
  enumsOk(saved);
  assert.equal(saved.phase,'review_only'); assert.equal(saved.convergence.terminal,false);
  assert.equal(saved.accounting_ready,false); assert.equal(saved.converged,false);
  assert.equal(saved.blocker.kind,'processing_review_only');
  assert.equal(saved.recovery.class,null);
  assert.ok(saved.gaps.some(row=>row.kind==='no_automatic_recovery_path'));
  const stale=buildCaseHealth({transaction:{...transaction,processing_scope:{enforced:true,review_current:false,review_reason:'stale_review_receipt'}}});
  assert.equal(stale.phase,'stuck'); assert.equal(stale.recovery.class,null); assert.equal(stale.blocker.receipt_ref,null);
  const owner=buildCaseHealth({transaction:{...transaction,convergence_state:'on_owner',convergence_reason:'open_owner_ask'}});
  assert.equal(owner.phase,'needs_owner');
  const agent=buildCaseHealth({transaction:{...transaction,convergence_reason:'agent_ask_unanswered'}});
  assert.equal(agent.phase,'processing'); assert.equal(agent.blocker.kind,'agent_ask_unanswered');
});

await test('F-34/F-32: a native refusal and an undeliverable owner ask are named blockers, never "unclassified"', () => {
  for (const reason of ['native_chart_lineage_invalid', 'native_review_refused:revision_chain_invalid']) {
    const health = buildCaseHealth({ transaction: { id: 'refused', convergence_state: 'hanging', convergence_reason: reason,
      processing_scope: { enforced: true, review_current: false } } });
    enumsOk(health);
    assert.equal(health.blocker.kind, 'native_review_refused');
    assert.equal(health.phase, 'stuck');
    assert.equal(health.blocker.detail.reason, reason);
  }
  const undeliverable = buildCaseHealth({ transaction: { id: 'u', convergence_state: 'hanging', convergence_reason: 'owner_ask_undeliverable' } });
  enumsOk(undeliverable);
  assert.equal(undeliverable.blocker.kind, 'owner_ask_undeliverable');
  assert.equal(undeliverable.phase, 'stuck');
});
