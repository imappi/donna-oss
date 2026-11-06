// Document artifact — suggested matches helper.
//
// Two distinct surfaces in the artifact, owned by this helper:
//
//   suggestedMatches — narrow, high-confidence ranked list. Only
//     candidates that ALL of:
//       - score >= SUGGESTION_SCORE_THRESHOLD (default 0.70)
//       - same currency as the document
//       - compatible direction (strict pass already enforces this)
//       - not already reconciled (strict pass already enforces this)
//       - not blocked by a prior firm decision
//       - carry at least one strong hint (amount_exact / amount_close /
//         vendor_overlap / date_exact)
//     Capped at `limit` (default 5). One-click `Link` is the primary
//     CTA in the artifact.
//
//   searchResults — broad fallback pool. Every eligible + filtered
//     tx tagged with its chips (wrong direction / different currency /
//     already reconciled / prior decision). The CTA on these rows is
//     `Review` (two-click confirm), NEVER one-click Link, because
//     every row here failed at least one suggestion gate. Always
//     populated regardless of parse state — even an unparseable doc
//     can be linked manually if the firm KNOWS which tx it pays.
//
// hasParsedMatchingData — explicit flag for the artifact to decide
//     whether to render Suggested Matches at all. False when the
//     document has none of total / date / counterparty: no candidate
//     can score above zero, so labelling anything "suggested" would
//     be misleading.

import { buildManualLinkPickerData } from './manualLinkPicker.js';

const DEFAULT_LIMIT = 5;
export const SUGGESTION_SCORE_THRESHOLD = 0.70;

// Strong-signal vocabulary — at least one must be present for a
// candidate to qualify as a suggestion (rather than just a tx the
// search filter happens to include). `date_close` alone is weak —
// a tx the same week as the doc proves nothing.
const STRONG_SIGNALS = new Set([
  'amount_exact',
  'amount_close',
  'vendor_overlap',
  'date_exact'
]);

const safeString = (value) => (value == null ? '' : String(value));

const hasStrongSignal = (candidate) =>
  (candidate?.hints || []).some((h) => STRONG_SIGNALS.has(h));

// Any warning chip (currency mismatch / wrong direction / already
// resolved) disqualifies a candidate from being a suggestion. The
// strict pass strips direction-mismatch and resolved before we see
// them; currency_mismatch can survive into strict candidates, so we
// filter it here.
const hasAnyWarning = (candidate) =>
  Array.isArray(candidate?.warnings) && candidate.warnings.length > 0;

const counterpartyOf = (document) => {
  if (!document) return null;
  if (document.document_type === 'sales_invoice' || document.document_type === 'issued_receipt') {
    return document.customer_name || null;
  }
  return document.vendor_name
    || document?.parse_summary?.semantic?.merchant_display_name
    || null;
};

// A document has "parsed matching data" when the parser extracted
// at least one of the three signals the scoring engine rests on
// (total, date, counterparty). If all three are missing, no
// candidate can score above 0 — the artifact must render a parse-
// empty state instead of a misleading empty suggestion list.
export const hasParsedMatchingData = (document) => {
  if (!document) return false;
  const total = document.total_amount;
  const date = document.document_date;
  const counterparty = counterpartyOf(document);
  return Boolean(
    (total != null && Number.isFinite(Number(total)))
    || (date && safeString(date).trim().length > 0)
    || (counterparty && safeString(counterparty).trim().length > 0)
  );
};

// Format a transaction's raw ISO date (e.g. "2026-04-30" or full
// ISO timestamp) into a short human-readable label ("30 Apr 2026").
// Centralised so the UI never renders raw ISO and tests can pin
// the rule. Returns "—" when the input is null / empty / unparseable.
export const formatTransactionDate = (raw) => {
  if (!raw) return '—';
  const trimmed = safeString(raw).slice(0, 10);
  if (!trimmed) return '—';
  const parsed = new Date(`${trimmed}T00:00:00`);
  if (Number.isNaN(parsed.getTime())) return '—';
  try {
    return parsed.toLocaleDateString('en-GB', {
      day: '2-digit',
      month: 'short',
      year: 'numeric'
    });
  } catch {
    return trimmed;
  }
};

// Build the artifact's resolution data. Caller passes the raw firm
// document (NOT the artifact-shaped `data.document`) because the
// picker reads `document_type`, `vendor_name`, `customer_name`,
// `total_amount`, `document_date`, `currency` directly.
//
// Returns:
//   {
//     hasParsedMatchingData,   // boolean — gates rendering of Suggested Matches
//     suggestedMatches,        // qualified high-confidence ranked list (one-click Link)
//     searchResults,           // every eligible + filtered tx (Review / two-click confirm)
//     suggestionCount,         // = suggestedMatches.length
//     searchResultCount,       // = searchResults.length
//     eligibility              // funnel counters for branch-specific empty copy
//   }
export const buildSuggestedMatches = ({
  document,
  transactions = [],
  reconciliationMatches = [],
  baseCurrency = '',
  limit = DEFAULT_LIMIT,
  threshold = SUGGESTION_SCORE_THRESHOLD
} = {}) => {
  if (!document) {
    return {
      hasParsedMatchingData: false,
      suggestedMatches: [],
      searchResults: [],
      suggestionCount: 0,
      searchResultCount: 0,
      eligibility: null
    };
  }
  const parsed = hasParsedMatchingData(document);

  // Expanded pass for the searchResults surface. Always computed,
  // even when the doc lacks parsed signal — the firm can still
  // KNOW which tx the doc pays and reach it via manual search.
  const expanded = buildManualLinkPickerData({
    documentId: document.id,
    documents: [document],
    transactions,
    reconciliationMatches,
    baseCurrency,
    includeFiltered: true
  });
  const searchResults = expanded.candidates;

  if (!parsed) {
    // No usable parse → no suggestions, but search results stay
    // available so the parse-failed empty state can still hand off
    // to manual search.
    return {
      hasParsedMatchingData: false,
      suggestedMatches: [],
      searchResults,
      suggestionCount: 0,
      searchResultCount: searchResults.length,
      eligibility: null
    };
  }

  // Strict pass: direction-matching, not-reconciled txs only. The
  // suggestions list filters FROM this set, never from the expanded
  // one — wrong-direction or resolved txs cannot be suggestions by
  // definition.
  const strict = buildManualLinkPickerData({
    documentId: document.id,
    documents: [document],
    transactions,
    reconciliationMatches,
    baseCurrency
  });

  // Apply the suggestion gates. Order matters — strip blocked +
  // warned candidates BEFORE checking score / strong-signal gates
  // so the threshold reasoning sees a clean signal floor.
  const suggestedMatches = strict.candidates
    .filter((c) => !c.blocked)
    .filter((c) => !hasAnyWarning(c))
    .filter((c) => c.score >= threshold)
    .filter(hasStrongSignal)
    .slice(0, limit);

  return {
    hasParsedMatchingData: true,
    suggestedMatches,
    searchResults,
    suggestionCount: suggestedMatches.length,
    searchResultCount: searchResults.length,
    eligibility: strict.eligibility || null
  };
};

// Document types that get the resolution surface. Bank statements
// and generic documents (notes / SOPs / etc) don't get a Suggested
// Matches or Search Transactions surface. Mirrors `manualLinkPicker`
// direction logic: receipt + supplier_bill + contract are AP;
// sales_invoice + issued_receipt are AR.
const LINKABLE_DOCUMENT_TYPES = new Set([
  'receipt',
  'supplier_bill',
  'sales_invoice',
  'issued_receipt',
  'contract'
]);

export const isLinkableDocumentType = (documentType) =>
  LINKABLE_DOCUMENT_TYPES.has(String(documentType || ''));

