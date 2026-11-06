// View model for the case-health block (Slice 2 of the seven-question
// contract; caseHealth.js is the projection) — the snapshot `case_health`
// block rendered as template prose over PERSISTED receipt fields.
//
// Render-the-persisted-verdict rail: every label below is a TEMPLATE over
// the block's typed fields — no LLM call renders or narrates anything on
// this path. The owner question renders VERBATIM from the persisted ask;
// where the projection could not answer one of the seven, the named writer
// gap renders as a visible hole, never papered over. A blocker/gap kind the
// templates cannot label renders its raw kind — an unlabelable value is
// drift to surface.

const viewMessage = (formatMessage, id, defaultMessage, values = {}) => (
  typeof formatMessage === 'function'
    ? formatMessage({ id, defaultMessage }, values)
    : defaultMessage.replace(/\{(\w+)\}/g, (_match, key) => String(values[key] ?? ''))
);

const PHASE_VIEWS = {
  review_only: { tone: 'review', id: 'transaction.health.phase.reviewOnly', label: 'Review saved · accounting incomplete' },
  finished: { tone: 'settled', id: 'transaction.health.phase.finished', label: 'Finished' },
  needs_owner: { tone: 'owner', id: 'transaction.health.phase.needsOwner', label: 'Needs you' },
  processing: { tone: 'working', id: 'transaction.health.phase.processing', label: 'Processing' },
  stuck: { tone: 'violation', id: 'transaction.health.phase.stuck', label: 'Needs attention' }
};

export const buildPhaseView = (phase, formatMessage = null) => {
  const known = PHASE_VIEWS[phase];
  if (!known) {
    return {
      tone: 'unknown',
      label: phase
        ? String(phase)
        : viewMessage(formatMessage, 'transaction.health.phase.unknown', 'Unknown')
    };
  }
  return { tone: known.tone, label: viewMessage(formatMessage, known.id, known.label) };
};

// Q1 — the blocker in owner words. `detail` carries the persisted receipt
// text (refusal reasoning, the open question, the failure class); templates
// add no facts of their own.
const BLOCKER_HEADLINES = {
  processing_review_only: ['transaction.health.blocker.processingReviewOnly', 'Accounting posting is unavailable for this workspace.'],
  native_review_refused: ['transaction.health.blocker.nativeReviewRefused', 'This workspace\'s chart or registration record needs repair before Donna can continue.'],
  owner_ask_undeliverable: ['transaction.health.blocker.ownerAskUndeliverable', 'A question is drafted but no one can receive it yet.'],
  awaiting_owner_answer: ['transaction.health.blocker.awaitingOwner', 'Waiting on your answer.'],
  coding_refusal: ['transaction.health.blocker.codingRefusal', 'Donna could not decide — a fact about your business is missing.'],
  coding_unapplied: ['transaction.health.blocker.codingUnapplied', 'A coding proposal is waiting to be applied.'],
  reviewer_hold: ['transaction.health.blocker.reviewerHold', 'On hold by a reviewer.'],
  match_awaiting_authority: ['transaction.health.blocker.awaitingAuthority', 'A match is waiting on authority.'],
  matched_but_uncoded: ['transaction.health.blocker.matchedUncoded', 'Matched, but the account is not decided yet.'],
  cascade_not_applied: ['transaction.health.blocker.cascadeNotApplied', 'The match did not finish settling in the books.'],
  disposition_gap_unrouted: ['transaction.health.blocker.unrouted', 'Needs an answer that never reached you.'],
  owner_reply_unprocessed: ['transaction.health.blocker.replyProcessing', 'You answered — Donna is processing your reply.'],
  integration_failure: ['transaction.health.blocker.integrationFailure', 'A system step failed.'],
  processing: ['transaction.health.blocker.processing', 'Still working on this line.'],
  held_by_setup_recovery: ['transaction.health.blocker.setupRecovery', 'Held while this client finishes setup recovery.'],
  unclassified: ['transaction.health.blocker.unclassified', 'Stuck for a reason that was not recorded.']
};

const blockerDetailText = (blocker, formatMessage) => {
  const detail = blocker?.detail;
  if (detail == null) return null;
  if (typeof detail === 'string') return detail;
  if (typeof detail !== 'object') return String(detail);
  if (blocker.kind === 'processing_review_only') {
    const label = detail.review_current
      ? ['reviewSaved','The review is saved. Accounting remains incomplete.']
      : detail.review_reason === 'stale_review_receipt'
        ? ['reviewStale','The earlier review no longer matches the current evidence.']
        : ['reviewMissing','No current review is saved.'];
    return viewMessage(formatMessage,`transaction.health.detail.${label[0]}`,label[1]);
  }
  // The typed detail shapes the projection emits, flattened to one line.
  if (blocker.kind === 'coding_unapplied') {
    return detail.proposed_account
      ? viewMessage(formatMessage, 'transaction.health.detail.proposed', 'Proposed: {account}.', { account: detail.proposed_account })
      : null;
  }
  if (blocker.kind === 'matched_but_uncoded') {
    return detail.proposed_account
      ? viewMessage(formatMessage, 'transaction.health.detail.lastProposal', 'Last proposal: {account}.', { account: detail.proposed_account })
      : null;
  }
  if (blocker.kind === 'cascade_not_applied') {
    if (!detail.failure) return null;
    if (detail.attempts == null) {
      return viewMessage(formatMessage, 'transaction.health.detail.failure', 'Failure: {failure}.', { failure: detail.failure });
    }
    return typeof formatMessage === 'function'
      ? viewMessage(
          formatMessage,
          'transaction.health.detail.failureAttempts',
          'Failure: {failure} after {attempts, plural, one {# attempt} other {# attempts}}.',
          { failure: detail.failure, attempts: detail.attempts }
        )
      : `Failure: ${detail.failure} after ${detail.attempts} attempt${detail.attempts === 1 ? '' : 's'}.`;
  }
  if (blocker.kind === 'disposition_gap_unrouted') {
    return detail.reasoning || (detail.disposition
      ? viewMessage(formatMessage, 'transaction.health.detail.verdict', 'Verdict: {verdict}.', {
          verdict: String(detail.disposition).replace(/_/g, ' ')
        })
      : null);
  }
  if (blocker.kind === 'integration_failure') {
    if (detail.system === 'coding_policy') {
      return [detail.owner_question, detail.unlock_condition].filter(Boolean).join(' ')
        || [detail.system, detail.failure].filter(Boolean).join(' — ') || null;
    }
    // The persisted refusal message is the recorded cause; render it verbatim.
    // A named cause (H-5a: the coder left a treatment the verified source
    // prints unsettled) rides beside it, so the row never reads as a bare stall.
    return [[detail.system, detail.failure].filter(Boolean).join(' — '),
      detail.cause ? String(detail.cause).replace(/_/g, ' ') : null, detail.message].filter(Boolean).join(' · ') || null;
  }
  if (blocker.kind === 'held_by_setup_recovery') {
    return [detail.reason_code, detail.boundary]
      .filter(Boolean)
      .map((value) => String(value).replace(/_/g, ' '))
      .join(' · ') || null;
  }
  if (blocker.kind === 'processing') {
    if (!detail.stage) return null;
    const stage = String(detail.stage).replace(/_/g, ' ');
    return detail.progress_current != null && detail.progress_total != null
      ? viewMessage(formatMessage, 'transaction.health.detail.stageProgress', 'Stage: {stage} ({current} of {total}).', {
          stage, current: detail.progress_current, total: detail.progress_total
        })
      : viewMessage(formatMessage, 'transaction.health.detail.stage', 'Stage: {stage}.', { stage });
  }
  if (Array.isArray(detail)) return detail.map((v) => String(v).replace(/_/g, ' ')).join(' · ') || null;
  return null;
};

export const buildBlockerView = (blocker, formatMessage = null) => {
  if (!blocker) return null;
  const known = BLOCKER_HEADLINES[blocker.kind];
  return {
    kind: blocker.kind || 'unclassified',
    headline: known
      ? viewMessage(formatMessage, known[0], known[1])
      : String(blocker.kind || viewMessage(formatMessage, 'transaction.health.blocker.blocked', 'Blocked')),
    detail: blockerDetailText(blocker, formatMessage),
    receiptRef: blocker.receipt_ref || null,
    ...(blocker.kind === 'integration_failure' && blocker.detail?.system === 'coding_policy' ? {
      canRetryCoding: blocker.detail.recovery_route !== 'client_profile',
      recoveryRoute: blocker.detail.recovery_route || null,
      escalationRequired: blocker.detail.escalation_required === true
    } : {})
  };
};

// Q7 — the typed recovery class in owner words. A null class is the
// projection saying NO honest class exists — rendered as the flagged
// defect it is, never softened.
const RECOVERY_LABELS = {
  yes: ['transaction.health.recovery.automatic', 'Will finish automatically.'],
  retrying: ['transaction.health.recovery.retrying', 'Retrying automatically.'],
  waiting_for_external_system: ['transaction.health.recovery.external', 'Waiting on an external system.'],
  owner_action_required: ['transaction.health.recovery.owner', 'Needs your answer to continue.']
};

export const buildRecoveryView = (recovery, formatMessage = null) => {
  if (!recovery) return null;
  if (recovery.class == null) {
    return {
      class: null,
      label: viewMessage(formatMessage, 'transaction.health.recovery.none', 'No automatic path — flagged for attention.'),
      basis: recovery.basis || null
    };
  }
  const known = RECOVERY_LABELS[recovery.class];
  return {
    class: recovery.class,
    label: known ? viewMessage(formatMessage, known[0], known[1]) : String(recovery.class),
    basis: recovery.basis || null
  };
};

// Q6 — the persisted question, verbatim; the view only frames it.
export const buildOwnerQuestionView = (ownerQuestion) => {
  if (!ownerQuestion || !ownerQuestion.question) return null;
  return {
    question: ownerQuestion.question,
    evidenceType: ownerQuestion.evidence_type || null,
    sent: ownerQuestion.sent || null,
    receiptRef: ownerQuestion.receipt_ref || null
  };
};

// The named writer gaps (caseHealth CASE_HEALTH_GAP_KINDS) in visible words —
// each is a statement that a persisted receipt SHOULD exist and does not.
const GAP_LABELS = {
  no_open_ask_for_owner_fact: ['transaction.health.gap.noOwnerAsk', 'A fact only you can answer is missing, but no question was sent to you.'],
  owner_ask_without_question_text: ['transaction.health.gap.noQuestionText', 'This line is marked as waiting on you, but no question text is on record.'],
  untyped_integration_failure: ['transaction.health.gap.untypedFailure', 'A system failure was recorded without its retry contract.'],
  missing_reasoning_receipt: ['transaction.health.gap.missingReasoning', 'A decision was recorded without its reasoning.'],
  no_automatic_recovery_path: ['transaction.health.gap.noRecovery', 'No automatic path out of this state — it needs attention.'],
  no_focus_row: ['transaction.health.gap.noFocus', 'No case to project — nothing was loaded.']
};

export const labelForCaseHealthGap = (gap, formatMessage = null) => {
  const known = GAP_LABELS[gap?.kind];
  return known
    ? viewMessage(formatMessage, known[0], known[1])
    : viewMessage(formatMessage, 'transaction.health.gap.missingReceipt', 'Missing receipt: {kind}', {
        kind: gap?.kind || 'unknown'
      });
};

// ── The owner-home aggregate ("184 finished · 6 open · 3 need you") ─────────
//
// Slice 3 of the case-health contract: the support-economics sentence — "why
// isn't August finished?" answered at a glance. The COUNTS come from the feed
// panel's own rendered partitions (auto_reconciled rows / hanging rows /
// on_owner asks), which are tallied from the PERSISTED per-row convergence
// verdicts — so the strip and the tab badges agree by construction, never by
// parallel maintenance.
//
// The input property remains `processing` for call-site compatibility, but the
// rendered label is deliberately `open`: this bucket is a count of unresolved
// material rows, not proof that a queue worker is currently active. Calling it
// processing made a static limbo count look like live progress. The same rows
// render in the Open list and the convergence metrics remain untouched.
export const buildOwnerHomeCounts = ({ finished = 0, processing = 0, needsOwner = 0 } = {}) => {
  const n = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : 0);
  const f = n(finished);
  const p = n(processing);
  const o = n(needsOwner);
  return {
    finished: f,
    processing: p,
    needsOwner: o,
    total: f + p + o,
    allDone: p === 0 && o === 0,
    label: `${f} finished · ${p} open · ${o} ${o === 1 ? 'needs' : 'need'} you`
  };
};

// The aggregate is useful only while it locates real Open work. Once Open is
// zero, Finished is already represented by Reconciled and needs-owner work is
// enumerated above the feed, so repeating all three counts adds no orientation.
export const shouldShowOwnerHomeStrip = (counts = {}) =>
  buildOwnerHomeCounts(counts || {}).processing > 0;

// The aggregate already says whether unresolved material exists. Do not echo
// a zero-count Open heading plus “Nothing needs attention” beneath a book whose
// rows have all reached finished/on-human terminals. The all-zero case is the
// exception: it keeps the upload onboarding state for a genuinely empty book.
export const shouldShowOpenFeedSection = (counts = {}) => {
  const normalized = buildOwnerHomeCounts(counts);
  return normalized.processing > 0 || normalized.total === 0;
};

// The whole block → one render-ready view. `caseHealth` is the snapshot's
// case_health block ({ present, convergence, phase, blocker, ... } or an
// absent marker). Q4 (actions) is deliberately NOT re-rendered here — the
// timeline block/view is the one home for the event stream.
export const buildCaseHealthView = (caseHealth, formatMessage = null) => {
  if (!caseHealth || caseHealth.present !== true) {
    return { present: false, reason: caseHealth?.reason || 'not_included' };
  }
  return {
    present: true,
    phase: buildPhaseView(caseHealth.phase, formatMessage),
    convergence: caseHealth.convergence || null,
    blocker: buildBlockerView(caseHealth.blocker, formatMessage),
    ownerQuestion: buildOwnerQuestionView(caseHealth.owner_question),
    recovery: buildRecoveryView(caseHealth.recovery, formatMessage),
    missingEvidenceCount: Array.isArray(caseHealth.missing_evidence) ? caseHealth.missing_evidence.length : 0,
    integrationFailureCount: Array.isArray(caseHealth.integration_failures) ? caseHealth.integration_failures.length : 0,
    gaps: (Array.isArray(caseHealth.gaps) ? caseHealth.gaps : [])
      .map((gap) => labelForCaseHealthGap(gap, formatMessage))
  };
};
