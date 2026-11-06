// Agreement evidence CheckReport — a READ-ONLY adapter from a parsed
// agreement document to a pass / requires_review verdict for the operator.
//
// Pipeline seam:
//   parsed document (contract.js extraction: obligations, totals, references)
//     → buildAgreementEvidenceCheckReport (THIS module)
//       → normalizes the document into the checker's input shape
//       → delegates the amount/date/party arithmetic to
//          buildAgreementEvidenceCheck (the deterministic checker)
//       → wraps the result in a conservative status gate
//
// Like the checker it wraps, this is correctness scaffolding, NOT intelligence:
// the strong LLM already extracted the obligations; this only normalizes and
// compares numbers. It NEVER reconciles, posts, or clears evidence — it returns
// a report. The gate is deliberately conservative: it PASSES only a fully clean
// match and sends everything else (totals mismatch, missing/ambiguous/extra
// rows, no match, total-only) to a human as `requires_review`. A non-agreement
// document (no extractable obligations) is `unsupported` — we never guess.

import { buildAgreementEvidenceCheck } from './agreementEvidenceCheck.js';

export const CHECK_REPORT_STATUS = Object.freeze({
  PASS: 'pass',
  REQUIRES_REVIEW: 'requires_review',
  UNSUPPORTED: 'unsupported'
});

const num = (value) => {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : null;
};
const absAmount = (value) => {
  const n = num(value);
  return n == null ? null : Math.abs(n);
};

// Totals agree within 1 cent OR 1% of the larger side — the same tolerance the
// checker uses for line amounts, applied here to the document-level total.
const totalsAgree = (a, b) => {
  if (a == null || b == null) return false;
  return Math.abs(a - b) <= Math.max(0.01, 0.01 * Math.max(Math.abs(a), Math.abs(b)));
};

const firstArray = (...candidates) => {
  for (const c of candidates) if (Array.isArray(c)) return c;
  return [];
};
const firstValue = (...candidates) => {
  for (const c of candidates) if (c != null) return c;
  return null;
};

// Defensive read across the shapes a parsed agreement can arrive in: the
// contract.js `summary`, the persisted `parse_summary` (the snapshot/document
// row shape — where obligations, counterparty_name, references, total_amount,
// currency and contract_type actually land), its `header`, or a flat object.
// Pulls only the fields the check needs — totals, currency, counterparty,
// own-party aliases, obligations, references, source-doc id, contract/document
// type.
const normalizeDocument = (document = {}) => {
  const summary = (document.summary && typeof document.summary === 'object' && document.summary)
    || (document.parse_summary && typeof document.parse_summary === 'object' && document.parse_summary)
    || {};
  const header = document.header && typeof document.header === 'object' ? document.header : {};
  const obligations = firstArray(document.obligations, summary.obligations);
  return {
    contract: {
      counterparty_name: firstValue(document.counterparty_name, summary.counterparty_name, header.counterparty_name),
      reference_number: firstValue(document.reference_number, summary.reference_number, header.reference_number),
      references: firstArray(document.references, summary.references),
      obligations
    },
    ownNames: firstArray(document.own_party_aliases, summary.own_party_aliases, document.client_aliases)
      .filter((name) => typeof name === 'string' && name.trim()),
    documentTotal: absAmount(firstValue(document.total_amount, summary.total_amount, header.total_amount)),
    currency: firstValue(document.currency, summary.currency, header.currency),
    sourceDocumentId: firstValue(document.id, document.document_id, document.source_document_id, summary.document_id),
    contractType: firstValue(document.contract_type, summary.contract_type, document.document_type, summary.document_type)
  };
};

// The deterministic status gate. Clean match → pass; anything that needs a human
// eye → requires_review with the reasons that triggered it (stable order).
const deriveReportStatus = (check, normalized) => {
  const reasons = [];
  if (check.obligations.some((o) => o.status === 'missing')) reasons.push('missing_obligations');
  if (check.obligations.some((o) => o.status === 'ambiguous')) reasons.push('ambiguous_rows');
  if (check.extras.length > 0) reasons.push('extra_rows');
  if (check.status === 'unmatched') reasons.push('no_matches');
  if (check.status === 'matched_on_total') reasons.push('total_only_low_confidence');
  // The document's declared total vs the obligations it itself lists — a
  // disagreement is an extraction inconsistency worth a human look.
  if (normalized.documentTotal != null && !totalsAgree(normalized.documentTotal, check.totals.expected)) {
    reasons.push('totals_mismatch');
  }
  const clean = reasons.length === 0 && check.status === 'matched' && check.confidence !== 'low';
  return { status: clean ? CHECK_REPORT_STATUS.PASS : CHECK_REPORT_STATUS.REQUIRES_REVIEW, reasons };
};

// Build the read-only CheckReport for a parsed agreement document.
//   { document, transactions, options } →
//   { status, reasons, sourceDocumentId, contractType, currency, totals,
//     check, posted:false, reconciled:false, cleared:false }
export const buildAgreementEvidenceCheckReport = ({ document = {}, transactions = [], options = {} } = {}) => {
  const normalized = normalizeDocument(document);

  // No extractable obligations → not a checkable agreement. We do not guess; the
  // operator sees an explicit unsupported verdict, never a false "pass".
  if (normalized.contract.obligations.length === 0) {
    return {
      status: CHECK_REPORT_STATUS.UNSUPPORTED,
      reasons: ['no_obligations'],
      sourceDocumentId: normalized.sourceDocumentId,
      contractType: normalized.contractType,
      currency: normalized.currency,
      totals: { documentTotal: normalized.documentTotal, expected: null, observed: null, variance: null },
      check: null,
      posted: false,
      reconciled: false,
      cleared: false
    };
  }

  const check = buildAgreementEvidenceCheck({
    contract: normalized.contract,
    transactions,
    options: {
      ...options,
      ownNames: [...(Array.isArray(options.ownNames) ? options.ownNames : []), ...normalized.ownNames]
    }
  });

  const { status, reasons } = deriveReportStatus(check, normalized);

  return {
    status,
    reasons,
    sourceDocumentId: normalized.sourceDocumentId,
    contractType: normalized.contractType,
    currency: normalized.currency,
    totals: {
      documentTotal: normalized.documentTotal,
      expected: check.totals.expected,
      observed: check.totals.observed,
      variance: check.totals.variance
    },
    check,
    // Boundary, restated at the report level: evidence only.
    posted: false,
    reconciled: false,
    cleared: false
  };
};
