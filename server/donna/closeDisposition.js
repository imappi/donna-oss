// Exception-Routing Close Engine — disposition classifier (Phase 1).
//
// Every close item gets exactly one disposition after the automated
// pass. The disposition decides who is allowed to handle the item:
//
//   auto_cleared        -> system           (no human queue except QA)
//   confirmable         -> backup_bookkeeper (confirm-or-reject only)
//   operator_blocker    -> operator (Kari)   (judgment + risk)
//   client_info_needed  -> client            (monthly question batch)
//
// This module is a read/derive layer over existing reconciliation_matches
// and transaction_review_queue rows. It does not mutate state — callers
// use the verdict to populate feeds, gate access, or build QA samples.
//
// v1 conservative defaults (deliberately stricter than the spec's
// mapping table, see the PR description):
//
//   - status='auto_matched' rows map to CONFIRMABLE, not AUTO_CLEARED.
//     The auto_cleared path is gated behind a future rule-maturity
//     layer (Phase 5) that doesn't exist yet. Until it does, every
//     match clears through a human eye — even a $15/hour confirm-only
//     one. This session's IRS-row case taught us that "confidently
//     wrong" is strictly worse than "honestly uncategorised"; the
//     same principle applies one tier up at the routing layer.
//
//   - risk_class ∈ { tax_sensitive, owner_personal, contractor_classification }
//     always escalates to OPERATOR_BLOCKER regardless of confidence.
//     Backup bookkeepers cannot safely confirm tax filings, payroll
//     remittances, or owner-personal questions.
//
//   - High-materiality suggested items escalate to OPERATOR_BLOCKER
//     even with strong auto-match signals. Materiality bands are
//     parametrized — callers pass per-firm/per-client overrides; the
//     defaults below are sized for a small operator like Honeybee.
//
// Phase 1 is intentionally a pure-function domain module with no DB
// access. The caller is expected to fetch the match / review row and
// the related transaction, then pass them in. This keeps the
// classifier easy to test and reversible.

import { codingStateFromReviewState, normalizeCodingState } from './codingState.js';

export const CLOSE_DISPOSITIONS = Object.freeze({
  AUTO_CLEARED: 'auto_cleared',
  CONFIRMABLE: 'confirmable',
  OPERATOR_BLOCKER: 'operator_blocker',
  CLIENT_INFO_NEEDED: 'client_info_needed'
});

export const CLOSE_ACTORS = Object.freeze({
  SYSTEM: 'system',
  BACKUP: 'backup_bookkeeper',
  OPERATOR: 'operator',
  CLIENT: 'client'
});

// risk_class is a category axis ("what kind of risk?").
// risk_level is a magnitude axis ("how much risk?"). They are
// orthogonal — a known SaaS vendor at $20 is GENERAL/LOW; a
// $50 sales-tax remittance is TAX_SENSITIVE/HIGH.
export const RISK_CLASSES = Object.freeze({
  GENERAL: 'general',
  TAX_SENSITIVE: 'tax_sensitive',
  OWNER_PERSONAL: 'owner_personal',
  CONTRACTOR_CLASSIFICATION: 'contractor_classification'
});

export const RISK_LEVELS = Object.freeze({
  LOW: 'low',
  MEDIUM: 'medium',
  HIGH: 'high'
});

export const MATERIALITY = Object.freeze({
  LOW: 'low',
  MEDIUM: 'medium',
  HIGH: 'high'
});

// Phase 5 will replace this with a per-rule lookup. Until then every
// caller defaults to NONE, which keeps the auto_cleared path closed
// for status='auto_matched' rows.
export const RULE_MATURITY = Object.freeze({
  NONE: 'none',
  CANDIDATE: 'candidate',
  PROBATION: 'probation',
  TRUSTED: 'trusted',
  RESTRICTED: 'restricted',
  DISABLED: 'disabled'
});

export const DEFAULT_MATERIALITY_BANDS = Object.freeze({
  low_max: 100,       // anything strictly less than this is LOW
  medium_max: 1000    // anything strictly greater than this is HIGH
});

const DISPOSITION_ACTOR = Object.freeze({
  [CLOSE_DISPOSITIONS.AUTO_CLEARED]: CLOSE_ACTORS.SYSTEM,
  [CLOSE_DISPOSITIONS.CONFIRMABLE]: CLOSE_ACTORS.BACKUP,
  [CLOSE_DISPOSITIONS.OPERATOR_BLOCKER]: CLOSE_ACTORS.OPERATOR,
  [CLOSE_DISPOSITIONS.CLIENT_INFO_NEEDED]: CLOSE_ACTORS.CLIENT
});

// Descriptor patterns that force escalation regardless of mapping
// confidence on the other side. Mirrors the high-stakes signals in
// vendorAccountSuggestion (federal/state/sales/payroll tax, VAT/GST,
// 1099 forms) but at the routing layer — a tax-sensitive descriptor
// with even a perfect Taxes & Licenses match still routes to Kari
// until a mature rule explicitly allows the lower routing.
const TAX_SENSITIVE_DESCRIPTOR = /\birs\b|usataxpymt|federal\s+tax|state\s+tax|sales\s+tax|payroll\s+tax|941\b|940\b|fica\b|vat\s*(?:remit|return|payment)|gst\s*(?:remit|return|payment)|w-?2\b/i;
const OWNER_PERSONAL_DESCRIPTOR = /\bowner\s*(?:draw|distribution|contribution)|personal\s+credit|atm\s+(?:withdrawal|cash)|cash\s+withdrawal/i;
export const CONTRACTOR_CLASSIFICATION_DESCRIPTOR = /\b1099(?:-?nec|-?misc)?\b|independent\s+contractor|contractor\s+payment/i;

const HIGH_CONFIDENCE = 0.9;
const CANDIDATE_THRESHOLD = 0.7;

const norm = (s) => String(s || '').toLowerCase();
const safeArray = (v) => (Array.isArray(v) ? v : []);

export const detectRiskClass = (descriptor) => {
  const text = norm(descriptor);
  if (!text) return RISK_CLASSES.GENERAL;
  if (CONTRACTOR_CLASSIFICATION_DESCRIPTOR.test(text)) return RISK_CLASSES.CONTRACTOR_CLASSIFICATION;
  if (TAX_SENSITIVE_DESCRIPTOR.test(text)) return RISK_CLASSES.TAX_SENSITIVE;
  if (OWNER_PERSONAL_DESCRIPTOR.test(text)) return RISK_CLASSES.OWNER_PERSONAL;
  return RISK_CLASSES.GENERAL;
};

export const materialityFor = (amount, bands = DEFAULT_MATERIALITY_BANDS) => {
  const abs = Math.abs(Number(amount) || 0);
  const lowMax = Number.isFinite(bands?.low_max) ? bands.low_max : DEFAULT_MATERIALITY_BANDS.low_max;
  const mediumMax = Number.isFinite(bands?.medium_max) ? bands.medium_max : DEFAULT_MATERIALITY_BANDS.medium_max;
  if (abs < lowMax) return MATERIALITY.LOW;
  if (abs <= mediumMax) return MATERIALITY.MEDIUM;
  return MATERIALITY.HIGH;
};

const riskLevelFor = ({ confidence, materiality, riskClass }) => {
  if (riskClass !== RISK_CLASSES.GENERAL) return RISK_LEVELS.HIGH;
  if (materiality === MATERIALITY.HIGH) return RISK_LEVELS.HIGH;
  const conf = Number(confidence) || 0;
  if (conf >= HIGH_CONFIDENCE && materiality === MATERIALITY.LOW) return RISK_LEVELS.LOW;
  if (conf >= CANDIDATE_THRESHOLD) return RISK_LEVELS.MEDIUM;
  return RISK_LEVELS.HIGH;
};

// Proposed-action shape is a discriminated union keyed on `type`.
// Each shape is fixed so downstream UI never has to guess. Add new
// types alongside the consumers that emit them.
export const proposeAction = Object.freeze({
  none: () => ({ type: 'none' }),

  confirm_reconciliation_match: ({ matchId, bankTransactionId, matchedObjectType, matchedObjectId }) => ({
    type: 'confirm_reconciliation_match',
    match_id: matchId ?? null,
    bank_transaction_id: bankTransactionId ?? null,
    matched_object_type: matchedObjectType ?? null,
    matched_object_id: matchedObjectId ?? null
  }),

  request_evidence: ({ transactionId, evidenceType, amount }) => ({
    type: 'request_evidence',
    transaction_id: transactionId ?? null,
    evidence_type: evidenceType ?? 'unspecified',
    amount: amount ?? null
  }),

  apply_category: ({ transactionId, accountId, accountName }) => ({
    type: 'apply_category',
    transaction_id: transactionId ?? null,
    account_id: accountId ?? null,
    account_name: accountName ?? null
  })
});

const compose = ({
  disposition,
  reason_code,
  confidence,
  materiality,
  risk_class,
  risk_level,
  blocks_close,
  proposed_action,
  evidence,
  context,
  disclosure_reason = null
}) => ({
  disposition,
  allowed_actor: DISPOSITION_ACTOR[disposition],
  blocks_close: Boolean(blocks_close),
  reason_code,
  confidence: confidence === null || confidence === undefined ? null : Number(confidence),
  materiality,
  risk_class,
  risk_level,
  proposed_action: proposed_action ?? proposeAction.none(),
  evidence: evidence ?? {},
  context: context ?? {},
  disclosure_reason
});

const buildDescriptor = (transaction, reviewItem) => [
  transaction?.description,
  transaction?.counterparty,
  transaction?.merchant_name,
  transaction?.payee,
  reviewItem?.reason
].filter(Boolean).join(' ');

/**
 * Classify a reconciliation_matches row.
 *
 * @param {object} input
 * @param {object} input.match - normalized reconciliation_matches row
 *   (status, match_confidence, match_amount, payload.match_reason,
 *    payload.recommended_action, id, bank_transaction_id,
 *    matched_object_type, matched_object_id)
 * @param {object} [input.transaction] - the bank transaction row,
 *   used for descriptor-based risk classification
 * @param {object} [input.context] - { firm_id, client_id, jurisdiction,
 *   accounting_basis } — echoed back in the verdict for downstream
 *   feed rendering
 * @param {object} [input.materialityBands] - per-firm/per-client
 *   override; falls back to DEFAULT_MATERIALITY_BANDS
 * @param {string} [input.ruleMaturity] - one of RULE_MATURITY; only
 *   'trusted' opens the auto_cleared path on status='auto_matched'.
 *   Defaults to 'none' until Phase 5 lands.
 * @returns {object} disposition verdict (shape: see `compose` above)
 */
export const classifyReconciliationMatch = ({
  match,
  transaction,
  context = {},
  materialityBands = DEFAULT_MATERIALITY_BANDS,
  ruleMaturity = RULE_MATURITY.NONE
}) => {
  const status = norm(match?.status);
  const confidence = Number(match?.match_confidence) || 0;
  const payload = match?.payload || {};
  const matchReason = payload.match_reason && typeof payload.match_reason === 'object'
    ? payload.match_reason
    : {};
  const autoMatchPassed = matchReason.auto_match_passed === true;
  const blockers = safeArray(matchReason.auto_match_blockers);
  const duplicateWarning = matchReason.duplicate_warning === true
    || safeArray(matchReason.warnings).some((w) => /duplicate/i.test(String(w)));

  const descriptor = buildDescriptor(transaction);
  const riskClass = detectRiskClass(descriptor);
  const amount = Math.abs(Number(match?.match_amount ?? transaction?.amount ?? 0));
  const materiality = materialityFor(amount, materialityBands);
  const riskLevel = riskLevelFor({ confidence, materiality, riskClass });

  const evidence = {
    match_id: match?.id ?? null,
    match_status: status || null,
    match_confidence: confidence,
    match_reason: matchReason,
    recommended_action: payload.recommended_action ?? null,
    auto_match_passed: autoMatchPassed,
    auto_match_blockers: blockers,
    duplicate_warning: duplicateWarning
  };

  const confirmAction = proposeAction.confirm_reconciliation_match({
    matchId: match?.id,
    bankTransactionId: match?.bank_transaction_id,
    matchedObjectType: match?.matched_object_type,
    matchedObjectId: match?.matched_object_id
  });

  // 1. Risk-class override applies before status. A tax-sensitive
  //    descriptor with a perfect match still routes to Kari until a
  //    trusted rule explicitly allows lower routing.
  if (riskClass !== RISK_CLASSES.GENERAL && ruleMaturity !== RULE_MATURITY.TRUSTED) {
    return compose({
      disposition: CLOSE_DISPOSITIONS.OPERATOR_BLOCKER,
      reason_code: `risk_class_${riskClass}_routes_to_operator`,
      confidence, materiality,
      risk_class: riskClass, risk_level: riskLevel,
      blocks_close: true,
      proposed_action: confirmAction,
      evidence, context
    });
  }

  // 2. Terminal states.
  if (status === 'rejected') {
    return compose({
      disposition: CLOSE_DISPOSITIONS.OPERATOR_BLOCKER,
      reason_code: 'match_rejected_requires_operator',
      confidence, materiality,
      risk_class: riskClass, risk_level: riskLevel,
      blocks_close: true,
      proposed_action: proposeAction.none(),
      evidence, context
    });
  }

  if (status === 'confirmed') {
    return compose({
      disposition: CLOSE_DISPOSITIONS.AUTO_CLEARED,
      reason_code: 'match_confirmed',
      confidence, materiality,
      risk_class: riskClass, risk_level: riskLevel,
      blocks_close: false,
      proposed_action: proposeAction.none(),
      evidence, context
    });
  }

  // 3. status='auto_matched' — the conservative override.
  //    Spec's mapping table sends these to AUTO_CLEARED. v1 holds
  //    them at CONFIRMABLE until rule maturity exists. See top-of-
  //    file note.
  if (status === 'auto_matched') {
    const safeAutoClear =
      ruleMaturity === RULE_MATURITY.TRUSTED
      && materiality !== MATERIALITY.HIGH
      && !duplicateWarning;
    if (safeAutoClear) {
      return compose({
        disposition: CLOSE_DISPOSITIONS.AUTO_CLEARED,
        reason_code: 'trusted_rule_auto_matched',
        confidence, materiality,
        risk_class: riskClass, risk_level: riskLevel,
        blocks_close: false,
        proposed_action: proposeAction.none(),
        evidence, context
      });
    }
    return compose({
      disposition: CLOSE_DISPOSITIONS.CONFIRMABLE,
      reason_code: 'auto_matched_needs_backup_confirmation',
      confidence, materiality,
      risk_class: riskClass, risk_level: riskLevel,
      blocks_close: false,
      proposed_action: confirmAction,
      evidence, context
    });
  }

  if (status === 'suggested') {
    if (duplicateWarning) {
      return compose({
        disposition: CLOSE_DISPOSITIONS.OPERATOR_BLOCKER,
        reason_code: 'duplicate_warning_requires_operator',
        confidence, materiality,
        risk_class: riskClass, risk_level: riskLevel,
        blocks_close: true,
        proposed_action: confirmAction,
        evidence, context
      });
    }
    if (materiality === MATERIALITY.HIGH) {
      return compose({
        disposition: CLOSE_DISPOSITIONS.OPERATOR_BLOCKER,
        reason_code: 'high_materiality_suggested_requires_operator',
        confidence, materiality,
        risk_class: riskClass, risk_level: riskLevel,
        blocks_close: true,
        proposed_action: confirmAction,
        evidence, context
      });
    }
    if (autoMatchPassed && blockers.length === 0 && confidence >= HIGH_CONFIDENCE) {
      return compose({
        disposition: CLOSE_DISPOSITIONS.CONFIRMABLE,
        reason_code: 'auto_match_candidate_high_confidence',
        confidence, materiality,
        risk_class: riskClass, risk_level: riskLevel,
        blocks_close: false,
        proposed_action: confirmAction,
        evidence, context
      });
    }
    return compose({
      disposition: CLOSE_DISPOSITIONS.OPERATOR_BLOCKER,
      reason_code: blockers.length > 0
        ? 'auto_match_blockers_present'
        : 'suggested_below_auto_match_threshold',
      confidence, materiality,
      risk_class: riskClass, risk_level: riskLevel,
      blocks_close: materiality !== MATERIALITY.LOW,
      proposed_action: confirmAction,
      evidence, context
    });
  }

  return compose({
    disposition: CLOSE_DISPOSITIONS.OPERATOR_BLOCKER,
    reason_code: `unknown_match_status_${status || 'empty'}`,
    confidence, materiality,
    risk_class: riskClass, risk_level: riskLevel,
    blocks_close: true,
    proposed_action: proposeAction.none(),
    evidence, context
  });
};

/**
 * Classify a transaction_review_queue row.
 *
 * @param {object} input
 * @param {object} input.reviewItem - normalized transaction_review_queue
 *   row (coding_state — RT-16: the line's ONE coding state, joined onto the
 *   case file's DTO —, reason, payload, id, item_id)
 * @param {object} [input.transaction]
 * @param {object} [input.context]
 * @param {object} [input.materialityBands]
 * @param {string} [input.ruleMaturity]
 * @returns {object} disposition verdict
 */
export const classifyReviewItem = ({
  reviewItem,
  transaction,
  context = {},
  materialityBands = DEFAULT_MATERIALITY_BANDS,
  ruleMaturity = RULE_MATURITY.NONE
}) => {
  // RT-16: the ONE coding state — off the case-file DTO (joined from the
  // transaction), else the transaction itself, else the DTO's projected
  // legacy label mapped back (an in-memory caller).
  const codingState = normalizeCodingState(reviewItem?.coding_state)
    || normalizeCodingState(transaction?.coding_state)
    || codingStateFromReviewState(reviewItem?.review_state)
    || null;
  const payload = reviewItem?.payload || {};
  const reason = String(reviewItem?.reason || '');

  const descriptor = buildDescriptor(transaction, reviewItem);
  const riskClass = detectRiskClass(descriptor);
  const amount = Math.abs(Number(transaction?.amount ?? payload.amount ?? 0));
  const materiality = materialityFor(amount, materialityBands);
  const confidence = Number(payload.suggestion_confidence ?? payload.confidence);
  const safeConfidence = Number.isFinite(confidence) ? confidence : null;
  const riskLevel = riskLevelFor({
    confidence: safeConfidence ?? 0,
    materiality,
    riskClass
  });

  const evidence = {
    review_item_id: reviewItem?.id ?? null,
    coding_state: codingState,
    reason,
    payload_summary: {
      ai_suggestion_status: payload.ai_suggestion_status ?? null,
      transaction_status: payload.transaction_status ?? null,
      evidence_request_status: payload.evidence_request?.status ?? null,
      proposed_action_type: payload.proposed_action?.type ?? null
    }
  };

  // Decided coding states — already cleared by a prior actor (a human's
  // word or Donna's own apply) or a ledger fact (posted / mirrored / closed).
  if (codingState === 'applied' || codingState === 'posted' || codingState === 'synced' || codingState === 'closed') {
    return compose({
      disposition: CLOSE_DISPOSITIONS.AUTO_CLEARED,
      reason_code: `coding_state_${codingState}`,
      confidence: safeConfidence, materiality,
      risk_class: riskClass, risk_level: riskLevel,
      blocks_close: false,
      proposed_action: proposeAction.none(),
      evidence, context
    });
  }

  // The owner-facing state. Materiality decides whether it holds
  // close open or closes with disclosures.
  if (codingState === 'asked') {
    const blocks_close =
      materiality === MATERIALITY.HIGH
      || riskClass !== RISK_CLASSES.GENERAL;
    return compose({
      disposition: CLOSE_DISPOSITIONS.CLIENT_INFO_NEEDED,
      reason_code: 'coding_state_asked',
      confidence: safeConfidence, materiality,
      risk_class: riskClass, risk_level: riskLevel,
      blocks_close,
      proposed_action: proposeAction.request_evidence({
        transactionId: reviewItem?.item_id,
        evidenceType: payload.evidence_request?.evidence_type ?? 'unspecified',
        amount: transaction?.amount
      }),
      evidence,
      context,
      disclosure_reason: blocks_close
        ? null
        : `unanswered_${riskClass}_${materiality}_${reviewItem?.item_id ?? 'item'}`
    });
  }

  // Risk-class override on active items.
  if (riskClass !== RISK_CLASSES.GENERAL && ruleMaturity !== RULE_MATURITY.TRUSTED) {
    return compose({
      disposition: CLOSE_DISPOSITIONS.OPERATOR_BLOCKER,
      reason_code: `risk_class_${riskClass}_routes_to_operator`,
      confidence: safeConfidence, materiality,
      risk_class: riskClass, risk_level: riskLevel,
      blocks_close: true,
      proposed_action: proposeAction.none(),
      evidence, context
    });
  }

  // A reviewer hold is the firm's own open item — never auto-cleared.
  if (codingState === 'held') {
    return compose({
      disposition: CLOSE_DISPOSITIONS.OPERATOR_BLOCKER,
      reason_code: 'coding_state_held',
      confidence: safeConfidence, materiality,
      risk_class: riskClass, risk_level: riskLevel,
      blocks_close: true,
      proposed_action: proposeAction.none(),
      evidence, context
    });
  }

  // A proposal nobody decided — or a case file with nothing proposed yet
  // (the intel pass's default, which used to read 'suggested').
  if (codingState === 'proposed' || !codingState) {
    const proposed = payload.proposed_action;
    const hasProposed =
      proposed && typeof proposed === 'object' && typeof proposed.type === 'string';
    if (!hasProposed) {
      return compose({
        disposition: CLOSE_DISPOSITIONS.OPERATOR_BLOCKER,
        reason_code: 'review_suggestion_without_proposed_action',
        confidence: safeConfidence, materiality,
        risk_class: riskClass, risk_level: riskLevel,
        blocks_close: materiality === MATERIALITY.HIGH,
        proposed_action: proposeAction.none(),
        evidence, context
      });
    }
    if (materiality === MATERIALITY.HIGH) {
      return compose({
        disposition: CLOSE_DISPOSITIONS.OPERATOR_BLOCKER,
        reason_code: 'high_materiality_review_requires_operator',
        confidence: safeConfidence, materiality,
        risk_class: riskClass, risk_level: riskLevel,
        blocks_close: true,
        proposed_action: proposed,
        evidence, context
      });
    }
    return compose({
      disposition: CLOSE_DISPOSITIONS.CONFIRMABLE,
      reason_code: 'review_suggestion_with_proposed_action',
      confidence: safeConfidence, materiality,
      risk_class: riskClass, risk_level: riskLevel,
      blocks_close: false,
      proposed_action: proposed,
      evidence, context
    });
  }

  return compose({
    disposition: CLOSE_DISPOSITIONS.OPERATOR_BLOCKER,
    reason_code: `unknown_coding_state_${codingState || 'empty'}`,
    confidence: safeConfidence, materiality,
    risk_class: riskClass, risk_level: riskLevel,
    blocks_close: true,
    proposed_action: proposeAction.none(),
    evidence, context
  });
};

/**
 * Classify a document whose parse pipeline failed. Always operator-routed:
 * the system can't reason about the artifact yet (no extracted fields,
 * no amount, no counterparty), so a human has to look. blocks_close
 * defaults to true — failed parses on docs from the active period
 * leave a known unknown in the evidence trail.
 *
 * Kept deliberately simple: no materiality gating (we don't know the
 * amount), no risk class (we haven't read the doc). The verdict is
 * "open this, decide what to do." Action vocabulary (re-upload,
 * manually enter, mark unusable) lands later as proposed_action types.
 *
 * @param {object} input
 * @param {object} input.document - normalized documents row; expects
 *   id, client_id, parse_status, parse_error, filename, created_at.
 * @param {object} [input.context] - { firm_id, client_id, client_name,
 *   jurisdiction, accounting_basis } — echoed back in the verdict.
 * @returns {object} disposition verdict
 */
export const classifyFailedParse = ({ document, context = {} } = {}) => {
  const evidence = {
    document_id: document?.id ?? null,
    filename: document?.filename ?? null,
    parse_status: document?.parse_status ?? null,
    parse_error: document?.parse_error ?? null
  };
  return compose({
    disposition: CLOSE_DISPOSITIONS.OPERATOR_BLOCKER,
    reason_code: 'failed_parse',
    confidence: null,
    materiality: null,
    risk_class: RISK_CLASSES.GENERAL,
    risk_level: RISK_LEVELS.HIGH,
    blocks_close: true,
    proposed_action: proposeAction.none(),
    evidence,
    context,
    disclosure_reason: document?.parse_error || null
  });
};

/**
 * Classify an OPEN client_evidence_request — the ask lane's on-the-client
 * terminal, surfaced in the feed so the inbox shows the whole book. Mirrors
 * the asked_client review-item rule: material or risk-classed asks hold the
 * close open; small general ones close with a disclosure.
 *
 * @param {object} input
 * @param {object} input.request - client_evidence_requests payload row
 * @param {object} [input.transaction] - linked bank line (classifier shape)
 * @param {object} [input.context]
 * @param {object} [input.materialityBands]
 * @returns {object} disposition verdict
 */
export const classifyClientEvidenceRequest = ({
  request,
  transaction,
  context = {},
  materialityBands = DEFAULT_MATERIALITY_BANDS
} = {}) => {
  const descriptor = buildDescriptor(transaction, null);
  const riskClass = detectRiskClass(descriptor);
  const amount = Math.abs(Number(transaction?.amount ?? 0));
  const materiality = materialityFor(amount, materialityBands);
  const riskLevel = riskLevelFor({ confidence: 0, materiality, riskClass });
  const blocks_close =
    materiality === MATERIALITY.HIGH || riskClass !== RISK_CLASSES.GENERAL;
  return compose({
    disposition: request?.status === 'draft' ? CLOSE_DISPOSITIONS.OPERATOR_BLOCKER : CLOSE_DISPOSITIONS.CLIENT_INFO_NEEDED,
    reason_code: request?.status === 'draft' ? 'client_ask_draft_unsent' : 'open_client_ask',
    confidence: null,
    materiality,
    risk_class: riskClass,
    risk_level: riskLevel,
    blocks_close,
    proposed_action: proposeAction.none(),
    evidence: {
      evidence_request_id: request?.id ?? null,
      evidence_type: request?.evidence_type ?? null,
      status: request?.status ?? null,
      send_count: request?.send_count ?? null,
      due_at: request?.due_at ?? null
    },
    context,
    disclosure_reason: blocks_close
      ? null
      : `unanswered_${riskClass}_${materiality}_${request?.transaction_id ?? request?.id ?? 'ask'}`
  });
};

/**
 * Classify a drafted-but-unsent client_ask_batch. A sendable draft is the
 * firm's move (review + send/relay), so it routes to the operator — the one
 * firm-side resting state the ask lane legitimately has while sending stays
 * a per-firm human authorization.
 */
export const classifyAskBatchDraft = ({ batch, context = {} } = {}) => {
  return compose({
    disposition: CLOSE_DISPOSITIONS.OPERATOR_BLOCKER,
    reason_code: 'ask_batch_draft_unsent',
    confidence: null,
    materiality: null,
    risk_class: RISK_CLASSES.GENERAL,
    risk_level: RISK_LEVELS.MEDIUM,
    blocks_close: false,
    proposed_action: proposeAction.none(),
    evidence: {
      ask_batch_id: batch?.id ?? null,
      subject: batch?.subject ?? null,
      counts: batch?.draft?.counts ?? null,
      created_at: batch?.created_at ?? null,
      verdicts_as_of: batch?.verdicts_as_of ?? null
    },
    context
  });
};
