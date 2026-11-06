// Reconciliation PR 4 — pure helpers for the receipt reconciliation
// review UI.
//
// Mirrors `src/lib/uploadTray.js` — every export is a pure function
// that takes plain objects and returns plain objects. No React, no
// DOM, no fetch, no localStorage. The React component in
// `src/components/financials/financials-view.jsx` imports these and
// renders.
//
// The buckets feed the new "Auto-explained · awaiting review" section
// (PR 3 set the row, the firm has not yet confirmed) and preserve the
// existing "Suggested" / "Confirmed" / "Rejected" semantics for the
// rest of the receipt-reconciliation surface.

import { AUTO_EXPLAIN_BLOCKERS } from './receiptAutoExplainBlockers.js';

const RECEIPT_MATCH_SOURCE = 'receipt_reconciliation';

const STATUSES = Object.freeze({
  AUTO_MATCHED: 'auto_matched',
  SUGGESTED: 'suggested',
  CONFIRMED: 'confirmed',
  REJECTED: 'rejected'
});

const ALL_STATUSES = Object.freeze(Object.values(STATUSES));

const CHIP_LABEL = Object.freeze({
  auto_matched: 'Auto-explained',
  suggested: 'Suggested',
  confirmed: 'Confirmed',
  rejected: 'Rejected'
});

// Human-facing copy for the diagnostic blocker hint. Keys are the
// categorical tokens from `AUTO_EXPLAIN_BLOCKERS`. Copy is
// intentionally short, neutral, and informational — never a warning
// or red flag. Diagnostic, not gating (hard invariant 6).
const BLOCKER_COPY = Object.freeze({
  [AUTO_EXPLAIN_BLOCKERS.FIRM_DISABLED]: 'firm disabled',
  [AUTO_EXPLAIN_BLOCKERS.MATCH_NOT_SUGGESTED]: 'match not in suggested state',
  [AUTO_EXPLAIN_BLOCKERS.PR1_NOT_ELIGIBLE]: 'PR 1 gates not all green',
  [AUTO_EXPLAIN_BLOCKERS.CLASSIFIER_MISSING]: 'classifier output missing',
  [AUTO_EXPLAIN_BLOCKERS.CLASSIFIER_STALE_VERSION]: 'classifier version stale',
  [AUTO_EXPLAIN_BLOCKERS.CLASSIFIER_FALLBACK]: 'classifier fell back',
  [AUTO_EXPLAIN_BLOCKERS.EXPENSE_KIND_CAUTIOUS]: 'cautious category',
  [AUTO_EXPLAIN_BLOCKERS.EXPENSE_KIND_UNKNOWN]: 'expense kind unknown',
  [AUTO_EXPLAIN_BLOCKERS.CONFIDENCE_BELOW_FLOOR]: 'confidence below floor',
  [AUTO_EXPLAIN_BLOCKERS.EVIDENCE_INSUFFICIENT]: 'evidence not sufficient',
  [AUTO_EXPLAIN_BLOCKERS.MATERIALITY_NOT_LOW]: 'materiality not low',
  [AUTO_EXPLAIN_BLOCKERS.AMOUNT_ABOVE_LIMIT]: 'amount above per-kind limit',
  [AUTO_EXPLAIN_BLOCKERS.PARSE_WARNING]: 'parse warning flagged',
  [AUTO_EXPLAIN_BLOCKERS.CLASSIFIER_WARNING]: 'classifier red-flag warning',
  [AUTO_EXPLAIN_BLOCKERS.TRANSACTION_ALREADY_RESOLVED]: 'transaction already resolved'
});

const PII_FIELDS = Object.freeze([
  'vendor_name',
  'merchant_display_name',
  'reference_number',
  'description',
  'business_purpose_guess',
  'needs_human_reason',
  'contact'
]);

const isReceiptMatch = (match) =>
  !!match && match.payload && match.payload.source === RECEIPT_MATCH_SOURCE;

const safeStatus = (match) => {
  const status = match?.status;
  return ALL_STATUSES.includes(status) ? status : null;
};

const safeArray = (value) => (Array.isArray(value) ? value : []);

const compareForStableOrder = (left, right) => {
  const leftCreated = String(left?.match?.created_at || '');
  const rightCreated = String(right?.match?.created_at || '');
  if (leftCreated !== rightCreated) {
    return leftCreated.localeCompare(rightCreated);
  }
  return String(left?.match?.id || '').localeCompare(String(right?.match?.id || ''));
};

// Most-recently-auto-explained first. Falls back to created_at for
// rows missing updated_at (PR 1-era matches that never went through
// PR 3); ties break by id for determinism.
const compareForAutoMatchedDisplay = (left, right) => {
  const leftUpdated = String(left?.match?.updated_at || left?.match?.created_at || '');
  const rightUpdated = String(right?.match?.updated_at || right?.match?.created_at || '');
  if (leftUpdated !== rightUpdated) {
    return rightUpdated.localeCompare(leftUpdated);
  }
  return String(left?.match?.id || '').localeCompare(String(right?.match?.id || ''));
};

export const reviewStatusChip = (match) => {
  const status = safeStatus(match);
  if (!status) return 'suggested';
  return status;
};

export const reviewStatusLabel = (match) => CHIP_LABEL[reviewStatusChip(match)] || CHIP_LABEL.suggested;

export const classifierSummaryFor = (document) => {
  const semantic = document?.parse_summary?.semantic;
  if (!semantic || typeof semantic !== 'object') return null;
  const expenseKind = semantic.expense_kind;
  if (!expenseKind || typeof expenseKind !== 'string') return null;

  const confidenceBand =
    semantic.confidence_band === 'high' || semantic.confidence_band === 'medium' || semantic.confidence_band === 'low'
      ? semantic.confidence_band
      : 'low';

  const warningsRaw = safeArray(semantic.warnings).filter((token) => typeof token === 'string' && token.length > 0);

  return {
    expense_kind: expenseKind,
    confidence_band: confidenceBand,
    evidence_sufficient: semantic.evidence_sufficient_signal === true,
    used_fallback: semantic.used_fallback === true,
    is_safe_list: semantic.is_safe_list === true,
    warnings: warningsRaw
  };
};

const titleCaseExpenseKind = (kind = '') =>
  String(kind)
    .split('_')
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');

export const formatClassifierChip = (summary) => {
  if (!summary) return '';
  const label = titleCaseExpenseKind(summary.expense_kind);
  const confidence = `${summary.confidence_band} confidence`;
  const fallbackQualifier = summary.used_fallback ? ' (fallback)' : '';
  return `${label} · ${confidence}${fallbackQualifier}`;
};

export const evidenceIndicatorFor = (summary) => {
  if (!summary) return null;
  return summary.evidence_sufficient ? 'Evidence: sufficient' : 'Evidence: needs context';
};

export const autoExplainHintFor = (match) => {
  const blockers = safeArray(match?.payload?.auto_explain_blockers).filter(
    (token) => typeof token === 'string' && token.length > 0
  );
  if (!blockers.length) return '';
  const firstWithCopy = blockers.find((token) => BLOCKER_COPY[token]);
  const reason = firstWithCopy ? BLOCKER_COPY[firstWithCopy] : 'not eligible';
  return `Auto-explain skipped: ${reason}`;
};

export const undoTargetStatus = (match) =>
  safeStatus(match) === STATUSES.AUTO_MATCHED ? STATUSES.SUGGESTED : null;

export const allowedActionsFor = (match) => {
  const status = safeStatus(match);
  if (status === STATUSES.AUTO_MATCHED) return ['confirm', 'undo', 'reject'];
  if (status === STATUSES.SUGGESTED) return ['confirm', 'reject'];
  return [];
};

export const buildPatchForAction = ({ action, match }) => {
  if (action === 'confirm') return { status: STATUSES.CONFIRMED };
  if (action === 'reject') return { status: STATUSES.REJECTED };
  if (action === 'undo') {
    const target = undoTargetStatus(match);
    return target ? { status: target } : null;
  }
  return null;
};

export const requiresConfirmPrompt = (action) => action === 'reject';

export const buildReviewRow = ({ match, document, transaction }) => {
  if (!isReceiptMatch(match)) return null;
  if (!document || !transaction) return null;
  const status = safeStatus(match);
  if (!status) return null;
  const classifierSummary = classifierSummaryFor(document);
  return {
    id: match.id,
    match,
    document,
    transaction,
    status,
    chip: reviewStatusChip(match),
    chipLabel: reviewStatusLabel(match),
    classifierSummary,
    evidenceIndicator: evidenceIndicatorFor(classifierSummary),
    autoExplainHint: autoExplainHintFor(match),
    allowedActions: allowedActionsFor(match)
  };
};

export const buildReviewBuckets = ({
  reconciliationMatches = [],
  documents = [],
  transactions = []
} = {}) => {
  const documentById = new Map();
  documents.forEach((document) => {
    if (document && document.id) documentById.set(document.id, document);
  });
  const transactionById = new Map();
  transactions.forEach((transaction) => {
    if (transaction && transaction.id) transactionById.set(transaction.id, transaction);
  });

  const buckets = {
    auto_matched_to_review: [],
    suggested_review: [],
    confirmed_handled: [],
    rejected_archived: []
  };

  reconciliationMatches.forEach((match) => {
    if (!isReceiptMatch(match)) return;
    const status = safeStatus(match);
    if (!status) return;
    const transaction = transactionById.get(match.bank_transaction_id);
    const document =
      match.matched_object_type === 'document' ? documentById.get(match.matched_object_id) : null;
    const row = buildReviewRow({ match, document, transaction });
    if (!row) return;
    if (status === STATUSES.AUTO_MATCHED) buckets.auto_matched_to_review.push(row);
    else if (status === STATUSES.SUGGESTED) buckets.suggested_review.push(row);
    else if (status === STATUSES.CONFIRMED) buckets.confirmed_handled.push(row);
    else if (status === STATUSES.REJECTED) buckets.rejected_archived.push(row);
  });

  buckets.auto_matched_to_review.sort(compareForAutoMatchedDisplay);
  buckets.suggested_review.sort(compareForStableOrder);
  buckets.confirmed_handled.sort(compareForStableOrder);
  buckets.rejected_archived.sort(compareForStableOrder);

  return buckets;
};

// Telemetry payload shape. Pure helper — the React caller is free to
// fire it or not. v1 ships WITHOUT a sink (no analytics infra exists
// in the codebase yet); the JSX call site is a TODO marker. The
// contract this helper enforces — no PII, enum/numeric metadata only
// — is the load-bearing piece tested here.
export const buildActionTelemetry = ({ action, match, document } = {}) => {
  const prevStatus = safeStatus(match) || null;
  const patch = buildPatchForAction({ action, match });
  const nextStatus = patch?.status || null;
  const summary = classifierSummaryFor(document);
  return {
    event: 'reconciliation_review.action_clicked',
    action: action || null,
    prev_status: prevStatus,
    next_status: nextStatus,
    has_classifier_metadata: summary !== null,
    expense_kind_band: summary ? summary.confidence_band : null
  };
};

// Strict PII check — used by tests; importable for callers that want
// to assert at a call site before firing telemetry.
export const telemetryHasPii = (payload) => {
  if (!payload || typeof payload !== 'object') return false;
  return PII_FIELDS.some((field) => Object.prototype.hasOwnProperty.call(payload, field));
};
