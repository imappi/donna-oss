// Reconciliation PR 1 — deterministic receipt candidate matching.
//
// Generates one-to-one receipt ↔ money_out candidates and persists them
// as `reconciliation_matches` rows with `status='suggested'` and
// `payload.source='receipt_reconciliation'`. Never writes 'auto_matched'
// (firmDb.js:2332 cascades that into `transactions.reconciliation_status
// = 'reconciled'` + `documents.payment_status='paid'`, which is the
// auto-explain semantic that belongs to Reconciliation PR 3). The
// "auto-match eligible" verdict rides in `payload.match_reason
// .auto_match_passed` instead.
//
// Cohabits with the legacy `refreshTransactionIntelForClient` flow via
// the namespace tag — that flow's DELETE predicate is narrowed in this
// PR to `coalesce(payload->>'source', 'transaction_intel') =
// 'transaction_intel'`, so receipt_reconciliation rows survive the next
// transaction-side mutation.

import {
  amountMatches,
  amountWithinTolerance,
  canonicalMerchantPattern,
  daysBetween,
  normalizeIntelText,
  textOverlaps
} from './transactionIntel.js';
import { REFERENCE_TYPE_PRIORITY } from './receipt.js';
import { triageReconciliationCandidates, cascadeAutoMatch } from './reconciliationTriage.js';
import { applyDocumentPaymentStatusAfterMatch, withFirmDbClient } from './firmDb.js';
// Q8 (the model lab, all-entities call 2026-08-16): the lane's experiment
// policy + the Opus reverse-shadow hook. The wrapper resolves the policy per
// run and builds the hook (it owns firmDb access); the Llm orchestrator only
// fires it post-stamp.
import { readLaneDecidingPolicy } from './modelLanePolicy.js';
import {
  RECONCILIATION_REASONING_LANE,
  makeReconciliationReasoningChallengerHook
} from './reconciliationReasoningChallenger.js';
import { assessDocumentEntityAlignment, crossEntityPayload, readClientIdentityWithClient } from './crossEntityGuard.js';
import {
  clientAllowedToAutoMatch,
  CANDIDATE_TX_STATUS_SQL,
  CANDIDATE_TX_EXPLAIN_SELECT_SQL,
  isBankLineOnlyExplained
} from './reconciliationLlmCore.js';
import { clientFlagActs, readClientConfigSnapshot } from './clientConfig.js';
import {
  currencyCompatibility,
  currenciesCompatibleForSuggestion,
  currenciesCompatibleForAutoMatch
} from './matcherCompatibility.js';
import { runReceiptReconciliationLlmForDocument } from './receiptReconciliationLlm.js';
// The provider-failure contract (2026-09-13, reconciliationProviderFailure.js):
// a typed provider failure from the LLM matcher — a missing/rejected key, a
// rate limit, an outage, a reset socket, a hung request, an unreadable body —
// is receipted on the document and re-driven by the convergence clock. It
// NEVER enters the weighted body below: the weighted matcher is a heuristic
// replacement decision, and a provider failure is not a matching judgment.
import {
  clearReconciliationProviderFailureWithClient,
  isProviderFailure,
  providerFailureFromDisabledStats,
  providerFailureStats
} from './reconciliationProviderFailure.js';

// Env kill switch. UNLIKE the bill + sales_invoice matchers' flags
// (default OFF, opt-in per firm), the receipt matcher defaults ON
// because it's the longest-running, most-relied-on matcher. The flag
// exists for incident-response symmetry — if the matcher misbehaves
// in production, an operator can disable it without a deploy. Only
// explicit 'false' / '0' / 'no' / 'off' disables; everything else
// (including unset, empty string, or any other value) keeps it on.
const FLAG_ENABLED = () => {
  const raw = process?.env?.RECEIPT_MATCHER_ENABLED;
  if (raw == null) return true;
  const v = String(raw).trim().toLowerCase();
  if (v === '' || v === '1' || v === 'true' || v === 'yes' || v === 'on') return true;
  if (v === '0' || v === 'false' || v === 'no' || v === 'off') return false;
  // Unrecognised value — default to enabled. We'd rather a typo'd
  // env keep matching running than silently disappear matches.
  return true;
};

// Persisted-tier floor — anything scoring below this never lands in
// `reconciliation_matches`. Brief §"Persisted-as-suggested requires
// ALL of (the looser tier)".
const SUGGESTED_SCORE_FLOOR = 0.55;
const SUGGESTED_DATE_GAP_DAYS = 3;

// auto_match_passed=true requires (a) the suggested-tier floor PLUS (b)
// the stricter gate below. Status stays 'suggested' regardless — the
// flag is the only difference.
const AUTO_MATCH_DATE_GAP_DAYS = 1;
const AUTO_MATCH_EXTRACTION_CONFIDENCE_FLOOR = 0.85;
const AUTO_MATCH_NULL_EXTRACTION_CONFIDENCE = 0.8;
const COMPETING_CANDIDATE_DELTA = 0.05;

// v2 — reference-token comparison defends against false matches on
// 4-digit card last-4 fragments and 3-letter currency codes. Q3
// confirmed: drop below 6 chars.
const REFERENCE_TOKEN_MIN_LENGTH = 6;

// v2 — tier 5 (amount_near_vendor) tolerance bound. Q1 confirmed: ±5% or
// ±€10, whichever is larger. Covers FX margin + small tax-component
// variance without admitting pure-amount noise.
const AMOUNT_NEAR_TOLERANCE = Object.freeze({ absolutePct: 0.05, absoluteUnits: 10 });

// v2 — categorical tier names emitted on `payload.match_reason
// .confidence_tier`. Ordering is the strict descending confidence
// ladder scoreReceiptMatch walks; Q9 confirmed reference_only (0.85)
// outranks amount_exact_same_day (0.82).
const CONFIDENCE_TIERS = Object.freeze({
  AMOUNT_EXACT_REFERENCE: { name: 'amount_exact_reference', confidence: 0.98, dateGap: 14 },
  AMOUNT_EXACT_VENDOR:    { name: 'amount_exact_vendor',    confidence: 0.92, dateGap: 7 },
  REFERENCE_ONLY:         { name: 'reference_only',         confidence: 0.85, dateGap: 14 },
  AMOUNT_EXACT_SAME_DAY:  { name: 'amount_exact_same_day',  confidence: 0.82, dateGap: 0 },
  AMOUNT_NEAR_VENDOR:     { name: 'amount_near_vendor',     confidence: 0.72, dateGap: 7 },
  VENDOR_ONLY:            { name: 'vendor_only',            confidence: 0.68, dateGap: 14 },
  AMOUNT_EXACT_NO_VENDOR: { name: 'amount_exact_no_vendor', confidence: 0.55, dateGap: 7 }
});

const NEW_TIER_NAMES = new Set([
  CONFIDENCE_TIERS.REFERENCE_ONLY.name,
  CONFIDENCE_TIERS.AMOUNT_EXACT_SAME_DAY.name,
  CONFIDENCE_TIERS.AMOUNT_NEAR_VENDOR.name,
  CONFIDENCE_TIERS.AMOUNT_EXACT_NO_VENDOR.name
]);

// Transaction reconciliation_status values that mean "already
// resolved" — we never propose candidates against these.
const RESOLVED_RECON_STATUSES = new Set([
  'explained',
  'auto_reconciled',
  'reconciled',
  'posted'
]);

// Existing match statuses that suppress a (transaction, document) pair
// from ever being re-suggested.
const SUPPRESSION_STATUSES = new Set(['rejected', 'confirmed', 'auto_matched']);

const RECEIPT_OBJECT_TYPE = 'receipt';

const pairKey = (txId, docId) => `${txId}|${docId}`;

const shortHash = (value = '') => {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = ((hash << 5) - hash + value.charCodeAt(index)) | 0;
  }
  return Math.abs(hash).toString(36);
};

const slugify = (value = '') =>
  String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32);

// Match id shape matches `makeMatchId` in transactionIntel.js so PR 4's
// review UI can dedupe across namespaces by id pattern.
const makeMatchId = (clientId, txId, docId) => {
  const raw = `${clientId}|${txId}|${RECEIPT_OBJECT_TYPE}|${docId}`;
  return `recon-${slugify(clientId)}-${slugify(txId)}-${slugify(RECEIPT_OBJECT_TYPE)}-${slugify(docId)}`.slice(0, 118) + `-${shortHash(raw)}`;
};

const transactionAmount = (transaction = {}) => {
  const out = Number(transaction.money_out || 0);
  if (out > 0) return out;
  return Number(transaction.amount || 0);
};

const transactionText = (transaction = {}) =>
  `${transaction.description || ''} ${transaction.raw_description || ''} ${transaction.contact || ''} ${transaction.source_line || ''}`;

// Currency comparison lives in `./matcherCompatibility.js` so the
// receipt, bill, and sales-invoice matchers share semantics. Suggestion
// vs auto-match have different bars:
//   - Suggestion: tolerant of one-sided null (the reviewer is the
//     source of truth for the missing side).
//   - Auto-match: strict — both sides must declare the same non-null
//     currency. The `currenciesCompatibleForAutoMatch` call below in
//     `evaluateAutoMatch` enforces that.
const currenciesMatch = currenciesCompatibleForSuggestion;

const documentParseWarnings = (document = {}) => {
  const summary = document.parse_summary || {};
  const warnings = Array.isArray(summary.warnings) ? summary.warnings : [];
  return warnings.map((w) => String(w));
};

const documentVendorPattern = (document = {}) =>
  canonicalMerchantPattern(document.vendor_name || '');

const transactionVendorPattern = (transaction = {}) =>
  canonicalMerchantPattern(transactionText(transaction));

const vendorMatchKind = (transaction = {}, document = {}, aliasResolves = false) => {
  const txPattern = transactionVendorPattern(transaction);
  const docPattern = documentVendorPattern(document);
  if (txPattern && docPattern && txPattern === docPattern) return 'exact';
  if (aliasResolves) return 'alias';
  if (textOverlaps(transactionText(transaction), document.vendor_name || '')) return 'overlap';
  return 'none';
};

// v2 — strip whitespace + punctuation, lowercase. Used to normalize
// reference tokens and bank descriptions so cross-format matches work
// (e.g. "105 1234567890" vs "1051234567890", "INV-2024-001" vs
// "INV2024001").
const stripPunctuationAndSpaces = (value) =>
  String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');

// v2 — returns a Set of equivalent normalized forms of a reference value,
// or null if the normalized token is shorter than REFERENCE_TOKEN_MIN_LENGTH.
// The leading-zero variant covers airline / courier IDs that get emitted
// with or without padding.
const normalizeReferenceToken = (value) => {
  const stripped = stripPunctuationAndSpaces(value);
  if (stripped.length < REFERENCE_TOKEN_MIN_LENGTH) return null;
  const variants = new Set([stripped]);
  const noLeadingZeros = stripped.replace(/^0+/, '');
  if (noLeadingZeros && noLeadingZeros !== stripped && noLeadingZeros.length >= REFERENCE_TOKEN_MIN_LENGTH) {
    variants.add(noLeadingZeros);
  }
  return variants;
};

// v2 — resolve the document's reference list. PR 83 introduced
// `parse_summary.references` (structured `{type, value}` array sorted by
// REFERENCE_TYPE_PRIORITY). Pre-PR-83 receipts only have
// `documents.reference_number`; fall back to treating it as a single
// `other`-typed entry so the legacy path still produces matches.
const documentReferences = (document = {}) => {
  const summary = document.parse_summary || {};
  const fromSummary = Array.isArray(summary.references) ? summary.references : [];
  const structured = fromSummary.filter(
    (entry) =>
      entry && typeof entry === 'object' &&
      typeof entry.type === 'string' && REFERENCE_TYPE_PRIORITY.includes(entry.type) &&
      typeof entry.value === 'string' && entry.value.trim()
  );
  if (structured.length) {
    const priorityIndex = (type) => REFERENCE_TYPE_PRIORITY.indexOf(type);
    return [...structured].sort((a, b) => priorityIndex(a.type) - priorityIndex(b.type));
  }
  if (document.reference_number) {
    return [{ type: 'other', value: String(document.reference_number) }];
  }
  return [];
};

const bankDescriptionNormalized = (transaction = {}) =>
  stripPunctuationAndSpaces(transactionText(transaction));

// v2 — walk references in priority order; return the (categorical) type of
// the first one whose normalized form (or leading-zero variant) appears as
// a substring of the normalized bank description. The reference VALUE is
// intentionally NOT returned — the matched_reference_type on
// payload.match_reason stays categorical-only.
const matchReferenceAgainstBank = (references, bankNormalized) => {
  if (!bankNormalized) return null;
  for (const ref of references) {
    const variants = normalizeReferenceToken(ref.value);
    if (!variants) continue;
    for (const variant of variants) {
      if (bankNormalized.includes(variant)) {
        return { type: ref.type };
      }
    }
  }
  return null;
};

// v2 — bounded percentage helper. Returns null on near-zero side so the
// gate never crashes on a €0.00 receipt — a "100% off" reading isn't
// useful diagnostic data. Test 18 pins this.
export const amountGapPct = (txAmount, docAmount) => {
  const tx = Number(txAmount);
  const doc = Number(docAmount);
  if (!Number.isFinite(tx) || !Number.isFinite(doc)) return null;
  if (Math.min(Math.abs(tx), Math.abs(doc)) < 0.01) return null;
  const denom = Math.max(Math.abs(tx), Math.abs(doc));
  return Math.round((Math.abs(tx - doc) / denom) * 10000) / 100;
};

const MAX_VENDOR_CANDIDATES = 3;

const vendorCandidatesFromSummary = (document = {}) => {
  const summary = document.parse_summary || {};
  const raw = Array.isArray(summary.vendor_candidates) ? summary.vendor_candidates : [];
  const seen = new Set();
  const out = [];
  for (const c of raw) {
    if (!c?.value || typeof c.value !== 'string') continue;
    const key = c.value.toLowerCase().trim();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(c);
    if (out.length >= MAX_VENDOR_CANDIDATES) break;
  }
  return out;
};

// Pure scoring — confidence ladder mirrors transactionIntel.js
// `bestDocumentMatchFor` (~line 285), extended by v2 with two new tiers
// (REFERENCE_ONLY at 0.85, AMOUNT_NEAR_VENDOR at 0.72) interleaved by
// strict descending confidence (Q9 confirmed). Returns null when no tier
// fires.
export const scoreReceiptMatch = ({ transaction, document, aliasResolves = false } = {}) => {
  if (!transaction || !document) return null;
  const txAmount = transactionAmount(transaction);
  const docAmount = Number(document.total_amount);
  // Degenerate amount inputs short-circuit even if reference/vendor would
  // otherwise hit. A receipt with total=0 is almost always an extraction
  // failure; failing the match closed is safer than auto-suggesting a
  // possibly-noisy reference hit. Test 18 pins this.
  if (!Number.isFinite(docAmount) || Math.abs(docAmount) < 0.01) return null;
  const txDate = transaction.date || transaction.transaction_date || '';
  const docDate = document.document_date || '';
  const txText = transactionText(transaction);
  const docVendor = document.vendor_name || '';

  const dateGap = daysBetween(txDate, docDate);
  const amountExact = amountMatches(txAmount, docAmount);
  const amountNear = amountWithinTolerance(txAmount, docAmount, AMOUNT_NEAR_TOLERANCE);
  const vendorOk = textOverlaps(txText, docVendor);
  const txCanonical = transactionVendorPattern(transaction);
  const docCanonical = documentVendorPattern(document);
  const canonicalEq = Boolean(txCanonical) && txCanonical === docCanonical;

  let candidateVendorSource = null;
  let vendorFromCandidates = false;
  if (!vendorOk && !canonicalEq && !aliasResolves && !docVendor) {
    const candidates = vendorCandidatesFromSummary(document);
    for (const c of candidates) {
      if (textOverlaps(txText, c.value)) {
        vendorFromCandidates = true;
        candidateVendorSource = c.source;
        break;
      }
    }
  }

  const vendorOrCanonical = vendorOk || canonicalEq || Boolean(aliasResolves) || vendorFromCandidates;

  const references = documentReferences(document);
  const bankNormalized = bankDescriptionNormalized(transaction);
  const referenceMatch = matchReferenceAgainstBank(references, bankNormalized);
  const referenceOk = Boolean(referenceMatch);
  const matchedReferenceType = referenceMatch?.type ?? null;
  const gapPct = amountGapPct(txAmount, docAmount);

  const baseExtras = {
    matched_reference_type: matchedReferenceType,
    amount_gap_pct: gapPct,
    matched_vendor_source: candidateVendorSource
  };

  if (referenceOk && amountExact && dateGap <= CONFIDENCE_TIERS.AMOUNT_EXACT_REFERENCE.dateGap) {
    return {
      confidence: CONFIDENCE_TIERS.AMOUNT_EXACT_REFERENCE.confidence,
      reason: 'Exact reference, amount, and date-window match.',
      tier: CONFIDENCE_TIERS.AMOUNT_EXACT_REFERENCE.name,
      ...baseExtras
    };
  }
  if (amountExact && vendorOrCanonical && dateGap <= CONFIDENCE_TIERS.AMOUNT_EXACT_VENDOR.dateGap) {
    return {
      confidence: CONFIDENCE_TIERS.AMOUNT_EXACT_VENDOR.confidence,
      reason: 'Exact amount, same counterparty, and close date.',
      tier: CONFIDENCE_TIERS.AMOUNT_EXACT_VENDOR.name,
      ...baseExtras,
      matched_reference_type: null
    };
  }
  if (referenceOk && dateGap <= CONFIDENCE_TIERS.REFERENCE_ONLY.dateGap) {
    return {
      confidence: CONFIDENCE_TIERS.REFERENCE_ONLY.confidence,
      reason: 'Reference identifier matches the bank line; amount may differ because of FX margin or tax components.',
      tier: CONFIDENCE_TIERS.REFERENCE_ONLY.name,
      ...baseExtras
    };
  }
  if (amountExact && dateGap === CONFIDENCE_TIERS.AMOUNT_EXACT_SAME_DAY.dateGap) {
    return {
      confidence: CONFIDENCE_TIERS.AMOUNT_EXACT_SAME_DAY.confidence,
      reason: 'Receipt/document amount matches same-day bank movement.',
      tier: CONFIDENCE_TIERS.AMOUNT_EXACT_SAME_DAY.name,
      ...baseExtras,
      matched_reference_type: null
    };
  }
  if (amountNear && vendorOrCanonical && dateGap <= CONFIDENCE_TIERS.AMOUNT_NEAR_VENDOR.dateGap) {
    return {
      confidence: CONFIDENCE_TIERS.AMOUNT_NEAR_VENDOR.confidence,
      reason: 'Amount close to bank line within typical FX/tax tolerance; vendor matches.',
      tier: CONFIDENCE_TIERS.AMOUNT_NEAR_VENDOR.name,
      ...baseExtras,
      matched_reference_type: null
    };
  }
  if (vendorOrCanonical && dateGap <= CONFIDENCE_TIERS.VENDOR_ONLY.dateGap) {
    return {
      confidence: CONFIDENCE_TIERS.VENDOR_ONLY.confidence,
      reason: 'Counterparty matches, but amount may differ because of fees, tax, FX, or partial payment.',
      tier: CONFIDENCE_TIERS.VENDOR_ONLY.name,
      ...baseExtras,
      matched_reference_type: null
    };
  }
  if (amountExact && dateGap <= CONFIDENCE_TIERS.AMOUNT_EXACT_NO_VENDOR.dateGap) {
    return {
      confidence: CONFIDENCE_TIERS.AMOUNT_EXACT_NO_VENDOR.confidence,
      reason: 'Exact amount within date window; vendor unconfirmed.',
      tier: CONFIDENCE_TIERS.AMOUNT_EXACT_NO_VENDOR.name,
      ...baseExtras,
      matched_reference_type: null
    };
  }
  return null;
};

// Pure auto-match gate — the row's DB status stays 'suggested' either
// way, but `auto_match_passed=true` lights up the "auto-explain
// candidate" verdict that Reconciliation PR 3 will consume. Brief
// §"auto_match_passed = true requires ALL of".
export const evaluateAutoMatch = ({
  score,
  transaction,
  document,
  competingCandidates = [],
  aliasResolves = false
}) => {
  const blockers = [];
  const txAmount = transactionAmount(transaction);
  const docAmount = Number(document?.total_amount);
  const txDate = transaction?.date || transaction?.transaction_date || '';
  const docDate = document?.document_date || '';

  const exactAmount = Number.isFinite(docAmount) && amountMatches(txAmount, docAmount);
  if (!exactAmount) blockers.push('amount_not_exact');

  // Auto-match requires STRICT currency parity (both populated AND
  // equal). One-sided null or both-null currencies pass the suggestion
  // gate above but lose the auto-match flag — the auto-explain gates
  // (`receiptAutoExplain`, `billAutoExplain`, `salesInvoiceAutoExplain`)
  // re-enforce strict parity as defence in depth.
  if (!currenciesCompatibleForAutoMatch(transaction?.currency, document?.currency)) {
    blockers.push('currency_mismatch');
  }

  const dateGap = daysBetween(txDate, docDate);
  if (!(dateGap <= AUTO_MATCH_DATE_GAP_DAYS)) {
    blockers.push('date_gap_too_wide');
  }

  // Canonical-vendor pattern equality OR alias resolves to same merchant.
  // Brief: "NOT substring overlap — that's looser than auto_match should
  // tolerate".
  const txCanonical = transactionVendorPattern(transaction || {});
  const docCanonical = documentVendorPattern(document || {});
  const canonicalEq = Boolean(txCanonical) && txCanonical === docCanonical;
  if (!canonicalEq && !aliasResolves) {
    blockers.push('vendor_not_canonical_match');
  }

  const extractionConfidence = document?.extraction_confidence == null
    ? AUTO_MATCH_NULL_EXTRACTION_CONFIDENCE
    : Number(document.extraction_confidence);
  if (!(extractionConfidence >= AUTO_MATCH_EXTRACTION_CONFIDENCE_FLOOR)) {
    blockers.push('low_extraction_confidence');
  }

  const warnings = documentParseWarnings(document || {});
  if (warnings.includes('amount_mismatch')) {
    blockers.push('parse_warning_amount_mismatch');
  }

  if (document?.duplicate_of) {
    blockers.push('document_duplicate');
  }

  // Competing-candidate guardrail. competingCandidates is the set of
  // OTHER existing receipt_reconciliation rows on the same
  // bank_transaction_id (matched_object_id != this doc) with status
  // 'suggested' — their match_confidence is the comparison point.
  for (const competitor of competingCandidates) {
    const competitorScore = Number(competitor.match_confidence || competitor.score || 0);
    if (Math.abs(competitorScore - Number(score)) <= COMPETING_CANDIDATE_DELTA) {
      blockers.push('competing_candidate');
      break;
    }
  }

  return { passed: blockers.length === 0, blockers };
};

const buildMatchReason = ({
  scored,
  transaction,
  document,
  competingCandidates,
  candidatesConsidered,
  autoMatch,
  aliasResolves
}) => {
  const txAmount = transactionAmount(transaction);
  const docAmount = Number(document.total_amount);
  const exact = Number.isFinite(docAmount) && amountMatches(txAmount, docAmount);
  const delta = Number.isFinite(docAmount) ? Math.round((txAmount - docAmount) * 100) / 100 : null;
  const dateGap = daysBetween(transaction.date || transaction.transaction_date || '', document.document_date || '');

  return {
    source: 'receipt_reconciliation',
    summary: scored.reason,
    amount: {
      transaction: txAmount,
      document: Number.isFinite(docAmount) ? docAmount : null,
      exact,
      delta
    },
    currency: (() => {
      const compat = currencyCompatibility(transaction.currency, document.currency);
      return {
        transaction: transaction.currency || null,
        document: document.currency || null,
        same: compat.suggestion,
        certainty: compat.certainty,
        auto_match_ok: compat.autoMatch
      };
    })(),
    date: {
      transaction: transaction.date || transaction.transaction_date || null,
      document: document.document_date || null,
      gap_days: Number.isFinite(dateGap) ? dateGap : null
    },
    vendor: {
      transaction_pattern: transactionVendorPattern(transaction),
      document_pattern: documentVendorPattern(document),
      match_kind: vendorMatchKind(transaction, document, aliasResolves)
    },
    candidates_considered: candidatesConsidered,
    competing_candidates: competingCandidates.length,
    extraction_confidence: document.extraction_confidence == null ? null : Number(document.extraction_confidence),
    parse_warnings: documentParseWarnings(document),
    score: scored.confidence,
    auto_match_passed: autoMatch.passed,
    auto_match_blockers: autoMatch.blockers,
    // v2 — categorical-only diagnostic fields for tier ordering, reference
    // attribution, and amount-gap bucketing. Brief §"Audit metadata
    // extension on the `reconciliation_matches` payload".
    confidence_tier: scored.tier,
    matched_reference_type: scored.matched_reference_type,
    amount_gap_pct: scored.amount_gap_pct,
    matched_vendor_source: scored.matched_vendor_source || null
  };
};

// Persistence gate. The scorer already enforces per-tier predicates
// (amount, vendor, date window). The gate's only universal requirement
// is currency match (Q7 confirmed). The previous "old tier" path
// re-applied vendor + dateGap ≤ 3 checks which silently dropped
// valid scored candidates at wider date gaps.
const passesPersistenceGate = ({
  tier,
  transaction,
  document,
  dateGap,
  aliasResolves
}) => {
  if (!currenciesMatch(transaction.currency, document.currency)) return false;
  return true;
};

// Pure candidate generator. The orchestrator passes the just-parsed
// receipt + all unreconciled money_out transactions + the full set of
// existing matches (for both suppression and competing-candidate
// detection).
export const generateReceiptCandidates = ({
  transactions = [],
  document,
  existingMatches = [],
  aliasMatchedTransactionIds = new Set()
} = {}) => {
  if (!document?.id) {
    return { candidates: [], skipped_rejected: 0, skipped_confirmed: 0, skipped_auto_matched: 0 };
  }

  // Per-pair suppression set from terminal-status rows.
  const suppressionByStatus = { rejected: new Set(), confirmed: new Set(), auto_matched: new Set() };
  // Per-transaction competing map — only same-document-type, same-source
  // 'suggested' rows count as competing. Brief: "no competing candidate
  // within score 0.05 of this pair's score".
  const competingByTx = new Map();

  for (const row of existingMatches) {
    if (row.matched_object_type && row.matched_object_type !== RECEIPT_OBJECT_TYPE) continue;
    const key = pairKey(row.bank_transaction_id, row.matched_object_id);
    if (SUPPRESSION_STATUSES.has(row.status)) {
      suppressionByStatus[row.status].add(key);
    }
    if (row.status === 'suggested') {
      const payload = row.payload || {};
      if (payload.source !== 'receipt_reconciliation') continue;
      // Same-pair entries don't count as competing against themselves.
      if (row.matched_object_id === document.id) continue;
      const list = competingByTx.get(row.bank_transaction_id) || [];
      list.push({
        matched_object_id: row.matched_object_id,
        match_confidence: Number(row.match_confidence || 0)
      });
      competingByTx.set(row.bank_transaction_id, list);
    }
  }

  const candidates = [];
  let candidatesConsidered = 0;

  for (const transaction of transactions) {
    if (!transaction?.id) continue;
    // Direction gate — PR 1 is money_out only.
    if (!(Number(transaction.money_out || 0) > 0)) continue;
    // Already-resolved transactions are not candidates — EXCEPT a line carrying
    // only a machine auto-explanation (bank-line classifier/disposition, client
    // rule, or coding auto-apply), which document evidence is allowed to outrank.
    // Mirrors the SQL carve-out via the shared isBankLineOnlyExplained predicate
    // so the gate and this defensive in-loop guard can't drift (the marker-drift
    // that stranded the Chevron receipt). The SQL is the authoritative gate; this
    // guard protects non-DB callers (tests) and stays in lock-step with it.
    if (
      RESOLVED_RECON_STATUSES.has(transaction.reconciliation_status) &&
      !isBankLineOnlyExplained(transaction)
    ) {
      continue;
    }

    const key = pairKey(transaction.id, document.id);
    // Suppression: pairs already terminally resolved never regenerate.
    if (
      suppressionByStatus.rejected.has(key) ||
      suppressionByStatus.confirmed.has(key) ||
      suppressionByStatus.auto_matched.has(key)
    ) {
      continue;
    }

    candidatesConsidered += 1;

    const aliasResolves = aliasMatchedTransactionIds.has(transaction.id);
    const scored = scoreReceiptMatch({ transaction, document, aliasResolves });
    if (!scored) continue;
    if (scored.confidence < SUGGESTED_SCORE_FLOOR) continue;

    const dateGap = daysBetween(transaction.date || transaction.transaction_date || '', document.document_date || '');
    if (!passesPersistenceGate({ tier: scored.tier, transaction, document, dateGap, aliasResolves })) {
      continue;
    }

    const competingForTx = competingByTx.get(transaction.id) || [];
    // v2 — NEW tiers (reference_only, amount_near_vendor) never auto-match.
    // Brief invariant 7: "auto_match_passed stays governed by tiers 1-3
    // only." Wider tiers always carry auto_match_passed=false with a
    // categorical blocker so PR 3's gate at receiptAutoExplain.js:190
    // never promotes them.
    const autoMatch = NEW_TIER_NAMES.has(scored.tier)
      ? { passed: false, blockers: ['wider_tier_requires_review'] }
      : evaluateAutoMatch({
          score: scored.confidence,
          transaction,
          document,
          competingCandidates: competingForTx,
          aliasResolves
        });

    const matchReason = buildMatchReason({
      scored,
      transaction,
      document,
      competingCandidates: competingForTx,
      candidatesConsidered,
      autoMatch,
      aliasResolves
    });

    candidates.push({
      transaction,
      document,
      score: scored.confidence,
      summary: scored.reason,
      // Top-level tier mirrors match_reason.confidence_tier — the
      // exact-match backstop filters candidates by it without reaching
      // into the nested payload.
      tier: scored.tier,
      match_reason: matchReason,
      auto_match_passed: autoMatch.passed,
      auto_match_blockers: autoMatch.blockers
    });
  }

  return {
    candidates,
    skipped_rejected: suppressionByStatus.rejected.size,
    skipped_confirmed: suppressionByStatus.confirmed.size,
    skipped_auto_matched: suppressionByStatus.auto_matched.size
  };
};

const ZERO_STATS = () => ({
  suggested_inserted: 0,
  suggested_refreshed: 0,
  auto_match_upgraded: 0,
  skipped_rejected: 0,
  skipped_confirmed: 0,
  skipped_auto_matched: 0,
  auto_match_eligible: 0,
  // Default behaviour is enabled. The disabled fields are populated
  // when an operator explicitly disables the matcher via the
  // RECEIPT_MATCHER_ENABLED env flag.
  disabled: false,
  disabled_reason: null
});

const DISABLED_STATS = (reason) => ({ ...ZERO_STATS(), disabled: true, disabled_reason: reason });

// ── Deterministic exact-match backstop under the LLM matcher ──────────
//
// The LLM receipt matcher (always primary since the batch-2 matcher-mode
// dead-branch delete) is strong but
// NOT deterministic: it can return no_match on a trivially-exact pair and
// then bind the SAME pair on the next call (the Mann Lake whiff — same
// input, different verdict). Because the delegation block in the
// orchestrator returns the LLM's stats on ANY non-disabled result and
// falls through to the weighted body ONLY on a thrown error, one such
// whiff silently ORPHANS the receipt: its bank line drops to the
// description-only lane and parks at SUGGESTED — the forbidden third state
// under CLAUDE.md's two-terminal-states principle.
//
// This backstop is a deterministic recall FLOOR under the LLM, NOT a
// second opinion. It does not re-rank or distrust the model. It only fires
// when the LLM bound NOTHING, and even then it rescues ONLY a top-tier
// EXACT pair (exact amount + vendor/reference corroboration + tight date
// window) that ALSO clears the auto-match gate. An exact amount+vendor+date
// match is arithmetic the math can verify — correctness scaffolding (the
// *keep* category in CLAUDE.md's trust-the-strong-LLM table), never
// intelligence-substitution. The LLM stays primary for everything that
// needs judgment (FX, processors, multi-hop, partial / ambiguous).
//
// Fail-closed + client-scoped, mirroring askEscalationQuiescenceGateAllows.
// Off → the weighted body is never even entered (byte-identical to today).
// NEVER widen by deleting the _CLIENTS allowlist while the flag is on —
// that silently turns the per-client canary into a global flip.
//
// 0A.6a: this env predicate is now the FALLBACK behind the config control plane —
// runReceiptReconciliationForDocument passes `() => exactMatchBackstopAllows(clientId)`
// as clientFlagActs' envFallback, so a client with no client_capability_config row keeps
// exactly this behaviour. The flag key is shared with the config plane via
// EXACT_MATCH_BACKSTOP_FLAG_KEY so the env master var and the DB flag_key can never drift
// (mirrors MATERIAL_AUTO_FYI_FLAG_KEY).
export const EXACT_MATCH_BACKSTOP_FLAG_KEY = 'RECONCILIATION_EXACT_MATCH_BACKSTOP';
export const exactMatchBackstopAllows = (clientId, env = process.env) => {
  const flag = String(env?.[EXACT_MATCH_BACKSTOP_FLAG_KEY] ?? '').trim().toLowerCase();
  if (!(flag === '1' || flag === 'true' || flag === 'on' || flag === 'yes')) return false;
  const raw = env?.[`${EXACT_MATCH_BACKSTOP_FLAG_KEY}_CLIENTS`];
  const allow = raw ? String(raw).split(',').map((s) => s.trim()).filter(Boolean) : null;
  if (!allow || !allow.length) return true; // flag on, no allowlist → every client
  const id = clientId == null ? '' : String(clientId).trim();
  return !!id && allow.includes(id);
};

// The ONLY tiers the backstop will rescue. Both require an EXACT amount
// match (amountMatches) plus a vendor/reference corroboration and a tight
// date window. Being ABSENT from NEW_TIER_NAMES, they route through
// evaluateAutoMatch — so a rescued candidate must additionally carry
// auto_match_passed=true, which fails closed on a competing twin
// (the COMPETING_CANDIDATE_DELTA guard) and on a wide date gap. An
// ambiguous same-amount pair therefore never auto-binds via the backstop.
const EXACT_MATCH_BACKSTOP_TIERS = new Set([
  CONFIDENCE_TIERS.AMOUNT_EXACT_REFERENCE.name,
  CONFIDENCE_TIERS.AMOUNT_EXACT_VENDOR.name
]);

// "The LLM bound nothing" for this receipt = it persisted no
// reconciliation_matches row (no insert / refresh / upgrade). A
// no_match / no_candidates / already_settled verdict all leave these
// counters at zero. Read off the stats the LLM matcher RETURNED — never
// re-query (see CLAUDE.md "render the persisted verdict, not the absence
// of data": the stats ARE the persisted verdict of that run).
const llmMatcherBoundNothing = (llmStats) => {
  if (!llmStats) return true;
  const wrote =
    Number(llmStats.suggested_inserted || 0) +
    Number(llmStats.suggested_refreshed || 0) +
    Number(llmStats.auto_match_upgraded || 0);
  return wrote === 0;
};

// Test seam — defaults to the real LLM matcher. Lets the backstop suite
// drive the LLM's verdict (a no_match whiff vs a bound proposal) without a
// live Anthropic call. Production always calls the real import through this
// object; tests reassign `__llmMatcher.run` and restore it.
//
// The default `run` WRAPS the import in an arrow rather than aliasing it, so
// the `runReceiptReconciliationLlmForDocument` binding is read at CALL time,
// not at module-eval time — receiptReconciliation ↔ receiptReconciliationLlm
// (via reconciliationLlmCore ↔ firmDb ↔ parseDocumentsDb) form an import
// cycle, and a bare init-time alias would hit the imported binding's temporal
// dead zone.
export const __llmMatcher = {
  run: (params) => runReceiptReconciliationLlmForDocument(params)
};

// Orchestrator. Called from `performWriteParsedDocumentExtraction`
// inside the writer transaction, AFTER summary recompute, BEFORE
// commit. Scoped to ONE just-parsed receipt — never a client-wide
// sweep.
export const runReceiptReconciliationForDocument = async ({
  client,
  firmId,
  clientId,
  documentId
} = {}) => {
  // Env kill switch — checked BEFORE any DB read. Disabled sessions
  // surface a visible `disabled` flag so callers can log the
  // suppression instead of conflating it with a no-match outcome.
  if (!FLAG_ENABLED()) return DISABLED_STATS('RECEIPT_MATCHER_ENABLED explicitly disabled');
  if (!client || !firmId || !clientId || !documentId) return ZERO_STATS();

  // Slice E — the LLM matcher is PRIMARY, unconditionally (batch-2 terminal
  // state 1: the RECONCILIATION_MATCHER_MODE gate is deleted,
  // docs/donna-batch2-matcher-mode-dead-branch-plan.md). It returns the same
  // stats shape so callers can `accumulate(stats)` unchanged. The weighted
  // body below remains the fallback when the LLM matcher self-disables
  // (e.g. no ANTHROPIC_API_KEY) or throws on infrastructure — same shape
  // the AR + AP paths use (see billReconciliation.js). See
  // docs/donna-llm-trust-strategy.md §3 Slice E + CLAUDE.md Failures
  // A/B/C: receipts are AP-direction (money_out / vendor), so the
  // FX / payment-processor / settlement-lag reasoning the bill matcher
  // exists for applies here too.
  // Set when a stochastic LLM whiff (bound nothing) + the backstop canary
  // sends us into the weighted body in restricted exact-only mode below.
  // Q8 (the model lab): the lane's active experiment policy for this
  // (firm, client). Non-claude rung seated => the deciding call rides the
  // compatible endpoint, Opus reverse-shadows, and the weighted matcher is
  // NOT a fallback — policy-run failures fail LOUD.
  let decidingPolicy = null;
  try {
    decidingPolicy = await readLaneDecidingPolicy({
      client, firmId, clientId, laneId: RECONCILIATION_REASONING_LANE
    });
  } catch { decidingPolicy = null; } // missing table => no policy, byte-identical
  const policyModel = typeof decidingPolicy?.deciding_model === 'string' && decidingPolicy.deciding_model.trim()
    ? decidingPolicy.deciding_model.trim()
    : null;
  const policyActive = Boolean(policyModel) && !policyModel.startsWith('claude');
  let challengerHook = null;
  if (policyActive) {
    const challengerSnapshot = await readClientConfigSnapshot(client, { firmId, clientId });
    challengerHook = makeReconciliationReasoningChallengerHook({
      family: 'receipt',
      firmId,
      clientId,
      snapshot: challengerSnapshot,
      withClient: withFirmDbClient
    });
  }

  let exactBackstopMode = false;
  try {
    const llmStats = await __llmMatcher.run({
      client,
      firmId,
      clientId,
      documentId,
      decidingPolicy,
      challengerHook
    });
    if (!llmStats?.disabled) {
      // The strong model ran (any verdict): a provider-failure receipt from
      // an earlier attempt is cleared — the document has left the re-drive
      // pool (reconciliationProviderFailure.js). No-op when there is none.
      await clearReconciliationProviderFailureWithClient({ client, firmId, clientId, documentId, logTag: 'receiptReconciliation' });
      // The scoped Jev lane owns this decision, including an explicit unsupported
      // outcome. The legacy exact-match backstop must not replace its answer.
      if (llmStats.decision_engine === 'jev') return llmStats;
      // The LLM is primary — return its stats verbatim, UNLESS it bound
      // nothing AND the deterministic exact-match backstop canary is on
      // for this client. In that one case we fall through to the weighted
      // body in exactBackstopMode to rescue an arithmetic-certain exact
      // pair the model whiffed on (the Mann Lake case). Off / LLM bound →
      // byte-identical to the prior `return llmStats`.
      //
      // 0A.6a — config control plane shim. Resolve the per-client config
      // snapshot LAZILY, only on the bound-nothing path (the only branch
      // where the backstop can fire), so a successful LLM match adds no DB
      // read. A DB row for this client ⇒ its stage decides (empty=∅,
      // fail-closed); no row ⇒ the env canary (envFallback), byte-identical
      // to pre-0A.6a. The lazy resolve preserves the original `&&`
      // short-circuit: the config read happens iff the LLM bound nothing.
      let backstopActs = false;
      if (llmMatcherBoundNothing(llmStats)) {
        const configSnapshot = await readClientConfigSnapshot(client, { firmId, clientId });
        backstopActs = clientFlagActs({
          flagKey: EXACT_MATCH_BACKSTOP_FLAG_KEY,
          snapshot: configSnapshot,
          envFallback: () => exactMatchBackstopAllows(clientId)
        });
      }
      if (backstopActs) {
        exactBackstopMode = true;
        console.log('[receiptReconciliation] LLM matcher bound nothing; entering deterministic exact-match backstop', {
          documentId,
          clientId
        });
      } else {
        return llmStats;
      }
    } else if (providerFailureFromDisabledStats(llmStats)) {
      // No Anthropic key: a provisioning gap that rests on the OPERATOR —
      // receipted on the document, re-driven once a key exists. Never the
      // weighted body (a heuristic replacement decision), never a verdict,
      // and never the exact-match backstop (which is a floor UNDER an LLM
      // verdict, and no verdict exists here).
      return providerFailureStats({ client, firmId, clientId, documentId, family: 'receipt', failure: providerFailureFromDisabledStats(llmStats), logTag: 'receiptReconciliation', zeroStats: ZERO_STATS });
    } else if (policyActive) {
      // Q8 — an ACTIVE policy never falls through to the weighted body.
      // (The deterministic exact-match backstop above stays legal — it is
      // arithmetic, not a model.)
      console.error('[receiptReconciliation] LLM matcher disabled under an ACTIVE model policy — refusing the weighted fallback', {
        documentId,
        reason: llmStats?.disabled_reason || null,
        policy_model: policyModel
      });
      return llmStats;
    }
  } catch (error) {
    // A typed provider failure (providerTransport.js) is a TRANSPORT fact:
    // receipt it on the document (the convergence clock re-drives it) and
    // return the zero shape. Under an active policy the run still fails
    // LOUD after the receipt; without one, nothing replaces the strong
    // model's judgment — the weighted body is for infrastructure throws only.
    if (isProviderFailure(error)) {
      const stats = await providerFailureStats({ client, firmId, clientId, documentId, family: 'receipt', failure: error, logTag: 'receiptReconciliation', zeroStats: ZERO_STATS });
      if (policyActive) throw error;
      return stats;
    }
    if (policyActive) {
      console.error('[receiptReconciliation] LLM matcher threw under an ACTIVE model policy — refusing the weighted fallback', {
        documentId,
        policy_model: policyModel,
        error: error?.message || String(error)
      });
      throw error;
    }
    console.error('[receiptReconciliation] LLM matcher threw, falling back to weighted (infrastructure failure, not a provider failure)', {
      documentId,
      error: error?.message || String(error)
    });
  }

  // 1. Load the just-parsed doc. Filter on the gates inline so a
  //    non-receipt / no-total / duplicate doc returns zero rows.
  const docResult = await client.query(
    `select id, firm_id, client_id, document_type, vendor_name, customer_name, document_date,
            total_amount, currency, extraction_confidence, parse_summary,
            duplicate_of, reference_number, filename
       from documents
      where firm_id = $1
        and client_id = $2
        and id = $3
        and document_type = 'receipt'
        and parse_status = 'completed'
        and total_amount is not null
        and duplicate_of is null`,
    [firmId, clientId, documentId]
  );
  if (!docResult.rows.length) return ZERO_STATS();
  const document = docResult.rows[0];

  // 2. Load unreconciled money_out transactions for this client.
  //    Several fields the matcher reads (`contact`, `source_line`)
  //    live inside `transactions.payload`, not as table columns —
  //    extract them via JSONB so the downstream `transaction.contact`
  //    / `transaction.source_line` reads work unchanged. `date` is
  //    aliased from `transaction_date` for the same reason. Dropped
  //    the previously-selected `account_currency` and `support_status`
  //    because they're never read in this code path (and would also
  //    need JSONB extraction if a future caller wanted them).
  // Candidate status filter is the SHARED carve-out (reconciliationLlmCore.js)
  // — identical to the LLM matcher's, so the deterministic fallback can't drift
  // from it. It admits standalone machine-explained lines (bank-line classifier/
  // disposition, client rule, coding auto-apply) so document evidence can outrank
  // them. A Donna auto-applied posting is also admitted when its document arrives
  // later; doc-matched and human/firm-posted lines stay excluded. The companion SELECT
  // (+ the disposition/coder markers) carries what isBankLineOnlyExplained reads
  // in the in-loop guard below, keeping SQL and JS in lock-step.
  const txResult = await client.query(
    `select id, firm_id, client_id, money_out, currency,
            transaction_date as date,
            description, raw_description,
            payload->>'contact' as contact,
            payload->>'source_line' as source_line,
            ${CANDIDATE_TX_EXPLAIN_SELECT_SQL},
            payload->>'bank_line_disposition_explained' as bank_line_disposition_explained,
            payload->>'ai_suggestion_status' as ai_suggestion_status,
            reconciliation_status, account_code,
            status
       from transactions
      where firm_id = $1
        and client_id = $2
        and money_out > 0
        and ${CANDIDATE_TX_STATUS_SQL}`,
    [firmId, clientId]
  );

  // 3. Load every existing match for this client. Used for both
  //    suppression (rejected/confirmed/auto_matched pairs) and
  //    competing-candidate detection (other receipt_reconciliation
  //    'suggested' rows on the same transaction).
  const existingResult = await client.query(
    `select id, bank_transaction_id, matched_object_type, matched_object_id,
            status, match_confidence, payload
       from reconciliation_matches
      where firm_id = $1 and client_id = $2`,
    [firmId, clientId]
  );

  // 4. Optional alias resolution. Best-effort — if the merchant_aliases
  //    table doesn't exist in this firm (it should, migration 002) we
  //    fall through to overlap-only matching.
  const aliasMatchedTxIds = new Set();
  const vendorNormalized = normalizeIntelText(document.vendor_name || '');
  if (vendorNormalized) {
    const aliasResult = await client
      .query(
        `select ma.normalized_alias, m.normalized_name
           from merchant_aliases ma
           join merchants m on m.id = ma.merchant_id
          where ma.firm_id = $1
            and (m.normalized_name = $2 or ma.normalized_alias = $2)`,
        [firmId, vendorNormalized]
      )
      .catch((error) => {
        if (error?.code === '42P01' || error?.code === '42703') return { rows: [] };
        throw error;
      });
    const aliasNorms = new Set();
    for (const row of aliasResult.rows) {
      if (row.normalized_alias) aliasNorms.add(row.normalized_alias);
      if (row.normalized_name) aliasNorms.add(row.normalized_name);
    }
    if (aliasNorms.size) {
      for (const tx of txResult.rows) {
        const txNorm = normalizeIntelText(
          `${tx.description || ''} ${tx.raw_description || ''} ${tx.contact || ''}`
        );
        for (const candidate of aliasNorms) {
          if (txNorm.includes(candidate)) {
            aliasMatchedTxIds.add(tx.id);
            break;
          }
        }
      }
    }
  }

  // 5. Generate candidates (pure).
  const { candidates, skipped_rejected, skipped_confirmed, skipped_auto_matched } =
    generateReceiptCandidates({
      transactions: txResult.rows,
      document,
      existingMatches: existingResult.rows,
      aliasMatchedTransactionIds: aliasMatchedTxIds
    });

  const stats = ZERO_STATS();
  stats.skipped_rejected = skipped_rejected;
  stats.skipped_confirmed = skipped_confirmed;
  stats.skipped_auto_matched = skipped_auto_matched;

  // Backstop mode: keep ONLY top-tier EXACT candidates that also clear the
  // auto-match gate. Anything looser would be weighted 'suggested' noise
  // the LLM (primary) already declined — the backstop does not second-guess
  // it, it only rescues an arithmetic-certain exact pair. Normal mode: every
  // candidate the scorer produced.
  const effectiveCandidates = exactBackstopMode
    ? candidates.filter(
        (c) => EXACT_MATCH_BACKSTOP_TIERS.has(c.tier) && c.auto_match_passed === true
      )
    : candidates;

  if (exactBackstopMode) {
    console.log('[receiptReconciliation] exact-match backstop candidate selection', {
      documentId,
      clientId,
      scored: candidates.length,
      rescuable: effectiveCandidates.length
    });
  }

  // 5b. LLM triage for low-confidence candidates (Phase 5). SKIPPED in
  //     backstop mode — the only candidates left are exact + auto-match-
  //     passed (score ≥ 0.92), and the LLM has already had its say on this
  //     receipt; re-triaging would just re-invoke the model we are
  //     backstopping.
  const apiKey = process.env.ANTHROPIC_API_KEY || '';
  let triageResults = new Map();
  if (!exactBackstopMode && apiKey && effectiveCandidates.some((c) => c.score < 0.85)) {
    for (const c of effectiveCandidates) {
      c.matchId = makeMatchId(clientId, c.transaction.id, document.id);
    }
    try {
      triageResults = await triageReconciliationCandidates({
        candidates: effectiveCandidates,
        apiKey,
        client,
        firmId,
        clientId
      });
    } catch (error) {
      console.error('[receiptReconciliation] triage failed, falling through to suggested', {
        documentId,
        error: error?.message || String(error)
      });
    }
  }

  // 6. Persist + emit audit per INSERT. Triage-blocked candidates are
  //    skipped. Green-lane LLM-confirmed write as 'auto_matched'.
  // 0A.10 — resolve the per-run config snapshot ONCE for the auto-match canary
  // (client + firmId + clientId in scope). Separate from the lazy backstop-only
  // snapshot above (that one is block-scoped). Soft-fails to {} ⇒ env fallback,
  // byte-identical until a DB row exists.
  const autoMatchConfigSnapshot = await readClientConfigSnapshot(client, { firmId, clientId });
  // Cross-entity intake guard (2026-08-04, findings §4b-xvi): the persisted
  // extraction's OWN-SIDE party vs the book's identity. A confident mismatch
  // DEMOTES to 'suggested' (never auto) and stamps the relation for the ask
  // lane; unknown/aligned is byte-identical to before.
  const clientIdentity = await readClientIdentityWithClient(client, { firmId, clientId });
  const entityAlignment = assessDocumentEntityAlignment({ clientIdentity, document });
  for (let idx = 0; idx < effectiveCandidates.length; idx++) {
    const candidate = effectiveCandidates[idx];
    const triage = triageResults.get(idx);

    if (triage?.finalState === 'blocked') continue;

    const matchId = candidate.matchId || makeMatchId(clientId, candidate.transaction.id, document.id);
    // Client-scoped auto-match canary (RECONCILIATION_AUTO_MATCH_CLIENTS): a
    // matcher that bypasses authorizeMatch must still honor the same allowlist,
    // so a non-allowlisted client can never auto-confirm via the legacy path.
    // No-op when no allowlist is set. Demotes to 'suggested' (surfaces, never hides).
    //
    // In backstop mode there is no triage (skipped above): the auto-match
    // decision rests on the candidate already being exact-tier +
    // auto_match_passed=true, still gated by the same client allowlist.
    const writeStatus = entityAlignment.verdict === 'mismatch'
      ? 'suggested'
      : exactBackstopMode
        ? (clientAllowedToAutoMatch(clientId, undefined, { configSnapshot: autoMatchConfigSnapshot }) ? 'auto_matched' : 'suggested')
        : ((triage?.finalState === 'auto_matched' && clientAllowedToAutoMatch(clientId, undefined, { configSnapshot: autoMatchConfigSnapshot })) ? 'auto_matched' : 'suggested');
    const writeScore = triage?.upgradedScore ?? candidate.score;
    const payload = {
      source: 'receipt_reconciliation',
      ...(entityAlignment.verdict === 'mismatch' ? { cross_entity: crossEntityPayload(entityAlignment) } : {}),
      match_reason: candidate.match_reason,
      recommended_action: writeStatus === 'auto_matched'
        ? 'auto_matched'
        : (candidate.auto_match_passed ? 'auto_match_candidate' : 'review')
    };
    // Tag the rescued row so it is distinguishable from a normal weighted
    // match in the DB (validation: payload->>'exact_backstop'='true') and
    // so downstream suppression/competing logic — which keys off
    // source='receipt_reconciliation' (unchanged) — is unaffected.
    if (exactBackstopMode) {
      payload.exact_backstop = true;
    }
    if (triage) {
      payload.match_reason = {
        ...payload.match_reason,
        llm_triage: {
          verdict: triage.verdict,
          confidence: triage.confidence,
          reasoning: triage.reasoning,
          lane: triage.lane,
          louis_verdict: triage.louisVerdict,
          final_state: triage.finalState
        }
      };
      if (writeStatus === 'auto_matched') {
        payload.match_reason.auto_match_passed = true;
      }
    }
    // See paymentConfirmationReconciliation.js for the rationale on
    // the CTE + status CASE. Same upsert-status-stuck bug, same fix.
    const insertResult = await client.query(
      `with prior as (
         select status as prior_status
         from reconciliation_matches
         where bank_transaction_id = $4
           and matched_object_type = $5
           and matched_object_id = $6
       )
       insert into reconciliation_matches (
         id, firm_id, client_id, bank_transaction_id,
         matched_object_type, matched_object_id,
         match_amount, match_confidence, match_reason,
         status, created_by, payload
       ) values (
         $1, $2, $3, $4,
         $5, $6,
         $7, $8, $9,
         $10, 'system', $11::jsonb
       )
       on conflict (bank_transaction_id, matched_object_type, matched_object_id) do update
         set match_amount = excluded.match_amount,
             match_confidence = excluded.match_confidence,
             match_reason = excluded.match_reason,
             payload = reconciliation_matches.payload || excluded.payload,
             status = case
               when reconciliation_matches.status = 'suggested'
                and excluded.status = 'auto_matched'
               then 'auto_matched'
               else reconciliation_matches.status
             end,
             updated_at = now()
         where reconciliation_matches.status not in ('confirmed', 'rejected', 'auto_matched')
       returning
         id,
         (xmax = 0) as inserted,
         status as final_status,
         coalesce((select prior_status from prior), 'inserted') as prior_status`,
      [
        matchId,
        firmId,
        clientId,
        candidate.transaction.id,
        RECEIPT_OBJECT_TYPE,
        document.id,
        Number(document.total_amount),
        writeScore,
        candidate.summary,
        writeStatus,
        JSON.stringify(payload)
      ]
    );

    if (!insertResult.rows.length) {
      continue;
    }

    const wasInserted = Boolean(insertResult.rows[0].inserted);
    const priorStatus = insertResult.rows[0].prior_status;
    const finalStatus = insertResult.rows[0].final_status;
    const wasUpgraded = !wasInserted
      && priorStatus === 'suggested'
      && finalStatus === 'auto_matched';

    if (wasInserted) {
      stats.suggested_inserted += 1;
      const auditAction = writeStatus === 'auto_matched'
        ? 'reconciliation.candidate.auto_matched'
        : 'reconciliation.candidate.suggested';
      await client.query(
        `insert into audit_events (firm_id, client_id, actor_type, action, resource_type, resource_id, metadata)
         values ($1, $2, 'system', $3, 'reconciliation_match', $4, $5::jsonb)`,
        [
          firmId,
          clientId,
          auditAction,
          matchId,
          JSON.stringify({
            match_id: matchId,
            bank_transaction_id: candidate.transaction.id,
            matched_object_id: document.id,
            score: writeScore,
            auto_match_passed: candidate.auto_match_passed || (triage?.finalState === 'auto_matched'),
            auto_match_blockers: candidate.auto_match_blockers,
            llm_triage: triage ? triage.verdict : null,
            exact_backstop: exactBackstopMode ? true : undefined
          })
        ]
      );

      if (writeStatus === 'auto_matched') {
        try {
          await cascadeAutoMatch({
            client,
            firmId,
            clientId,
            matchId,
            bankTransactionId: candidate.transaction.id,
            matchedObjectType: RECEIPT_OBJECT_TYPE,
            documentId: document.id
          });
          await applyDocumentPaymentStatusAfterMatch({
            client,
            firmId,
            matchId,
            matchedObjectType: RECEIPT_OBJECT_TYPE,
            documentId: document.id
          });
        } catch (error) {
          console.error('[receiptReconciliation] auto-match cascade failed', {
            matchId,
            error: error?.message || String(error)
          });
        }
      }
    } else if (wasUpgraded) {
      stats.auto_match_upgraded += 1;
      await client.query(
        `insert into audit_events (firm_id, client_id, actor_type, action, resource_type, resource_id, metadata)
         values ($1, $2, 'system', $3, 'reconciliation_match', $4, $5::jsonb)`,
        [
          firmId,
          clientId,
          'reconciliation.candidate.status_upgraded',
          matchId,
          JSON.stringify({
            match_id: matchId,
            bank_transaction_id: candidate.transaction.id,
            matched_object_id: document.id,
            match_kind: RECEIPT_OBJECT_TYPE,
            score: writeScore,
            prior_status: priorStatus,
            status: finalStatus,
            auto_match_passed: candidate.auto_match_passed || (triage?.finalState === 'auto_matched'),
            auto_match_blockers: candidate.auto_match_blockers,
            llm_triage: triage ? triage.verdict : null,
            exact_backstop: exactBackstopMode ? true : undefined
          })
        ]
      );
      try {
        await cascadeAutoMatch({
          client,
          firmId,
          clientId,
          matchId,
          bankTransactionId: candidate.transaction.id,
          matchedObjectType: RECEIPT_OBJECT_TYPE,
          documentId: document.id
        });
        await applyDocumentPaymentStatusAfterMatch({
          client,
          firmId,
          matchId,
          matchedObjectType: RECEIPT_OBJECT_TYPE,
          documentId: document.id
        });
      } catch (error) {
        console.error('[receiptReconciliation] upgrade cascade failed', {
          matchId,
          error: error?.message || String(error)
        });
      }
    } else {
      stats.suggested_refreshed += 1;
    }

    if (candidate.auto_match_passed || triage?.finalState === 'auto_matched') {
      stats.auto_match_eligible += 1;
    }

    if (candidate.auto_match_blockers.includes('competing_candidate')) {
      const competitorsResult = await client.query(
        `select id, payload
           from reconciliation_matches
          where firm_id = $1
            and client_id = $2
            and bank_transaction_id = $3
            and matched_object_type = 'receipt'
            and matched_object_id != $4
            and status = 'suggested'
            and payload->>'source' = 'receipt_reconciliation'
            and abs(coalesce(match_confidence, 0) - $5) <= $6`,
        [firmId, clientId, candidate.transaction.id, document.id, writeScore, COMPETING_CANDIDATE_DELTA]
      );
      for (const competitor of competitorsResult.rows) {
        const competitorPayload = competitor.payload || {};
        const competitorReason = competitorPayload.match_reason || {};
        const existingBlockers = Array.isArray(competitorReason.auto_match_blockers)
          ? competitorReason.auto_match_blockers
          : [];
        if (
          competitorReason.auto_match_passed === false &&
          existingBlockers.includes('competing_candidate')
        ) {
          continue;
        }
        const nextBlockers = [...new Set([...existingBlockers, 'competing_candidate'])];
        const patch = {
          match_reason: {
            ...competitorReason,
            auto_match_passed: false,
            auto_match_blockers: nextBlockers
          },
          recommended_action: 'review'
        };
        await client.query(
          `update reconciliation_matches
              set payload = payload || $2::jsonb, updated_at = now()
            where id = $1 and status = 'suggested'`,
          [competitor.id, JSON.stringify(patch)]
        );
      }
    }
  }

  return stats;
};
