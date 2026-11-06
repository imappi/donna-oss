// caseHealthView — pure template tests (Slice 2 of the seven-question
// contract). Pins:
//   - templates render PERSISTED fields only: the refusal reasoning, the
//     verbatim owner question, the typed failure classes
//   - a null recovery class renders as the flagged defect it is
//   - every named writer gap has visible words; an unknown kind renders raw
//   - an absent block degrades to { present: false, reason }

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildCaseHealthView,
  buildBlockerView,
  buildPhaseView,
  buildRecoveryView,
  buildOwnerHomeCounts,
  labelForCaseHealthGap,
  shouldShowOwnerHomeStrip,
  shouldShowOpenFeedSection
} from './caseHealthView.js';

await test('an absent block renders present:false with its reason', () => {
  assert.deepEqual(buildCaseHealthView(null), { present: false, reason: 'not_included' });
  assert.deepEqual(
    buildCaseHealthView({ present: false, reason: 'case_health_focus_not_yet_supported' }),
    { present: false, reason: 'case_health_focus_not_yet_supported' }
  );
});

await test('the §4 refusal block renders: refusal headline, persisted reasoning verbatim, flagged gap', () => {
  const view = buildCaseHealthView({
    present: true,
    convergence: { state: 'hanging', reason: 'review_state:suggested', terminal: false },
    phase: 'stuck',
    blocker: {
      kind: 'coding_refusal',
      detail: 'Cannot determine whether account ending 81761647226 is Honeybee-owned.',
      receipt_ref: { table: 'transactions', id: 'tx-1', path: 'payload.ai_suggestion' }
    },
    missing_evidence: [{ kind: 'owner_fact_unasked', source: 'coding_refusal' }],
    integration_failures: [],
    reasons: [],
    owner_question: null,
    recovery: { class: 'owner_action_required', basis: 'coding_refusal_owner_fact' },
    gaps: [{ kind: 'no_open_ask_for_owner_fact', source: 'coding_refusal' }]
  });
  assert.equal(view.present, true);
  assert.deepEqual(view.phase, { tone: 'violation', label: 'Needs attention' });
  assert.equal(view.blocker.headline, 'Donna could not decide — a fact about your business is missing.');
  assert.equal(view.blocker.detail, 'Cannot determine whether account ending 81761647226 is Honeybee-owned.');
  assert.equal(view.recovery.label, 'Needs your answer to continue.');
  assert.equal(view.missingEvidenceCount, 1);
  assert.deepEqual(view.gaps, ['A fact only you can answer is missing, but no question was sent to you.']);
});

await test('the owner question renders verbatim from the persisted ask', () => {
  const view = buildCaseHealthView({
    present: true,
    phase: 'needs_owner',
    blocker: { kind: 'awaiting_owner_answer', detail: 'Is the account ending 81761647226 yours?' },
    owner_question: {
      question: 'Is the account ending 81761647226 yours?',
      evidence_type: 'owner_fact',
      sent: '2026-08-17T09:01:00.000Z',
      receipt_ref: { table: 'client_evidence_requests', id: 'cer-1' }
    },
    recovery: { class: 'owner_action_required', basis: 'open_owner_ask' },
    missing_evidence: [], integration_failures: [], reasons: [], gaps: []
  });
  assert.deepEqual(view.phase, { tone: 'owner', label: 'Needs you' });
  assert.equal(view.ownerQuestion.question, 'Is the account ending 81761647226 yours?');
  assert.equal(view.blocker.headline, 'Waiting on your answer.');
  assert.equal(view.blocker.detail, 'Is the account ending 81761647226 yours?');
});

await test('typed blocker details flatten to one honest line per kind', () => {
  assert.equal(
    buildBlockerView({ kind: 'cascade_not_applied', detail: { failure: 'DeadlockDetected', attempts: 1 } }).detail,
    'Failure: DeadlockDetected after 1 attempt.'
  );
  assert.equal(
    buildBlockerView({ kind: 'coding_unapplied', detail: { proposed_account: 'Software Subscriptions', confidence: 'high' } }).detail,
    'Proposed: Software Subscriptions.'
  );
  assert.equal(
    buildBlockerView({ kind: 'processing', detail: { stage: 'reading', progress_current: 1, progress_total: 3 } }).detail,
    'Stage: reading (1 of 3).'
  );
  assert.equal(
    buildBlockerView({ kind: 'integration_failure', detail: { system: 'document_parse', failure: 'ExtractionTimeout' } }).detail,
    'document_parse — ExtractionTimeout'
  );
  assert.equal(
    buildBlockerView({ kind: 'disposition_gap_unrouted', detail: { disposition: 'chase_evidence', reasoning: 'A receipt should exist.' } }).detail,
    'A receipt should exist.'
  );
});

await test('a null recovery class is the flagged defect, never softened; unknown kinds render raw', () => {
  assert.deepEqual(
    buildRecoveryView({ class: null, basis: 'suggested_resting_on_firm_click' }),
    { class: null, label: 'No automatic path — flagged for attention.', basis: 'suggested_resting_on_firm_click' }
  );
  assert.equal(buildRecoveryView({ class: 'yes', basis: 'terminal:x' }).label, 'Will finish automatically.');
  assert.equal(buildRecoveryView({ class: 'retrying', basis: 'owner_reply_resume_leg' }).label, 'Retrying automatically.');
  assert.equal(buildRecoveryView(null), null);
  // Drift surfaces: an unlabelable kind/phase renders its raw value.
  assert.equal(buildBlockerView({ kind: 'brand_new_kind' }).headline, 'brand_new_kind');
  assert.deepEqual(buildPhaseView('brand_new_phase'), { tone: 'unknown', label: 'brand_new_phase' });
  assert.equal(labelForCaseHealthGap({ kind: 'brand_new_gap' }), 'Missing receipt: brand_new_gap');
});

await test('owner-home counts: the support-economics sentence, grammatical and defensive', () => {
  assert.deepEqual(
    buildOwnerHomeCounts({ finished: 184, processing: 6, needsOwner: 3 }),
    { finished: 184, processing: 6, needsOwner: 3, total: 193, allDone: false, label: '184 finished · 6 open · 3 need you' }
  );
  assert.equal(buildOwnerHomeCounts({ finished: 12, needsOwner: 1 }).label, '12 finished · 0 open · 1 needs you');
  const done = buildOwnerHomeCounts({ finished: 40 });
  assert.equal(done.allDone, true);
  assert.equal(done.label, '40 finished · 0 open · 0 need you');
  // An empty book renders nothing (total 0 → the strip hides itself).
  assert.deepEqual(buildOwnerHomeCounts({}), { finished: 0, processing: 0, needsOwner: 0, total: 0, allDone: true, label: '0 finished · 0 open · 0 need you' });
  // Garbage never renders as NaN.
  assert.equal(buildOwnerHomeCounts({ finished: 'x', processing: -2, needsOwner: null }).total, 0);
});

await test('the Open list renders only for open work or genuine empty-book onboarding', () => {
  assert.equal(shouldShowOpenFeedSection({ finished: 29, processing: 0, needsOwner: 13 }), false);
  assert.equal(shouldShowOpenFeedSection({ finished: 29, processing: 0, needsOwner: 0 }), false);
  assert.equal(shouldShowOpenFeedSection({ finished: 0, processing: 0, needsOwner: 13 }), false);
  assert.equal(shouldShowOpenFeedSection({ finished: 29, processing: 2, needsOwner: 13 }), true);
  assert.equal(shouldShowOpenFeedSection({}), true);
});

await test('the owner-home aggregate renders only while Open work exists', () => {
  assert.equal(shouldShowOwnerHomeStrip({ finished: 37, processing: 0, needsOwner: 30 }), false);
  assert.equal(shouldShowOwnerHomeStrip({ finished: 37, processing: 1, needsOwner: 30 }), true);
  assert.equal(shouldShowOwnerHomeStrip({}), false);
  assert.equal(shouldShowOwnerHomeStrip(null), false);
});

await test('every named writer gap has visible words', () => {
  for (const kind of [
    'no_open_ask_for_owner_fact', 'owner_ask_without_question_text',
    'untyped_integration_failure', 'missing_reasoning_receipt',
    'no_automatic_recovery_path', 'no_focus_row'
  ]) {
    const label = labelForCaseHealthGap({ kind });
    assert.ok(label && !label.startsWith('Missing receipt:'), `no words for ${kind}`);
  }
});

test('held_by_setup_recovery renders its own headline and receipt-shaped detail', async () => {
  const { buildBlockerView } = await import('./caseHealthView.js');
  const view = buildBlockerView({
    kind: 'held_by_setup_recovery',
    detail: { boundary: 'worker_discovery', reason_code: 'entity_dependency_changed' },
    receipt_ref: { table: 'audit_events', id: 4411 }
  });
  assert.equal(view.headline, 'Held while this client finishes setup recovery.');
  assert.equal(view.detail, 'entity dependency changed · worker discovery');
  assert.deepEqual(view.receiptRef, { table: 'audit_events', id: 4411 });
});

test('policy repair exposes persisted instructions and a coding retry only for system failures', () => {
  const system = buildBlockerView({ kind: 'integration_failure', detail: {
    system: 'coding_policy', failure: 'coding_policy_unavailable',
    recovery_route: 'runtime_policy_incident', escalation_required: true,
    unlock_condition: 'Repair the runtime coding configuration, then retry this transaction.'
  } });
  assert.equal(system.detail, 'Repair the runtime coding configuration, then retry this transaction.');
  assert.equal(system.canRetryCoding, true);
  assert.equal(system.escalationRequired, true);
  const owner = buildBlockerView({ kind: 'integration_failure', detail: {
    system: 'coding_policy', recovery_route: 'client_profile',
    owner_question: 'Which country is this business registered in?',
    unlock_condition: 'Confirm jurisdiction in business setup.'
  } });
  assert.equal(owner.canRetryCoding, false);
  assert.equal(owner.detail, 'Which country is this business registered in? Confirm jurisdiction in business setup.');
});

test('a ledger refusal renders its recorded code and message, never "not recorded"', () => {
  const view = buildBlockerView({ kind: 'integration_failure', detail: {
    system: 'ledger_post', failure: 'TRANSACTION_ALV_TREATMENT_UNRESOLVED', message: 'The coding says ALV-tarkistus, which maps to no ALV code.'
  } });
  assert.equal(view.headline, 'A system step failed.');
  assert.equal(view.detail, 'ledger_post — TRANSACTION_ALV_TREATMENT_UNRESOLVED · The coding says ALV-tarkistus, which maps to no ALV code.');
  assert.equal(view.canRetryCoding, undefined);
});
