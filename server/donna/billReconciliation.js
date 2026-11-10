// Reconciliation PR 9 — deterministic supplier-bill candidate matching.
//
// Mirrors the shape of `server/donna/salesInvoiceReconciliation.js`
// with the direction kept on money_out (the AP side) and AP-specific
// signals (vendor-name fuzzy match, reference-substring against the
// tx description) layered on top. Always writes `status='suggested'`
// — auto-promotion is reserved for a sibling pass per PR 8's Q6
// precedent. `payload.match_reason.auto_match_passed` rides on the
// row so a future AP auto-promote pass can consume the verdict
// without re-scoring.
//
// Direction safety mirrors the receipt matcher: candidate scan
// filters on `money_out > 0 AND (money_in is null or money_in = 0)`.
// The receipt and bill matchers coexist in the same direction; they
// do NOT coordinate at write-time (Q1 — per-matcher competing-
// candidate detection only). The firm resolves cross-document-type
// competition in the review UI; the inbox library surfaces it as a
// `competingDocumentTypes` field computed from the snapshot.
//
// matched_object_type is `'supplier_bill'` (Q5 option B inherited
// from PR 8 — same convention firmDb.createManualReconciliationMatchInDb
// already writes for bills; isDocumentMatch in documentsInbox.js
// already accepts it).
//
// payment_status flipping is NOT this module's job. The match row
// lands as 'suggested'; the firm confirming via the existing PATCH
// endpoint triggers `firmDb.applyDocumentPaymentStatusAfterMatch` to
// compute the new payment_status from sum(confirmed amounts) vs
// total_amount. Bills join sales_invoice in the AR-arithmetic branch
// of that helper (Q2 — option A confirmed).

import {
  amountMatches,
  amountWithinTolerance,
  daysBetween
} from './transactionIntel.js';
import { triageReconciliationCandidates, cascadeAutoMatch } from './reconciliationTriage.js';
import { applyDocumentPaymentStatusAfterMatch, withFirmDbClient } from './firmDb.js';
// Q7 (the model lab, 2026-08-16): the reconciliation_reasoning lane's
// experiment policy + the Opus reverse-shadow hook. The wrapper resolves
// the policy per run and builds the hook (it owns firmDb access); the Llm
// orchestrator only fires it post-stamp.
import { readLaneDecidingPolicy } from './modelLanePolicy.js';
import {
  RECONCILIATION_REASONING_LANE,
  makeReconciliationReasoningChallengerHook
} from './reconciliationReasoningChallenger.js';
import { assessDocumentEntityAlignment, crossEntityPayload, readClientIdentityWithClient } from './crossEntityGuard.js';
import {
  CANDIDATE_TX_EXPLAIN_SELECT_SQL,
  CANDIDATE_TX_STATUS_SQL,
  clientAllowedToAutoMatch,
  isBankLineOnlyExplained
} from './reconciliationLlmCore.js';
import { readClientConfigSnapshot } from './clientConfig.js';
import { toUtcDayMs } from './dates.js';
import {
  currencyCompatibility,
  currenciesCompatibleForSuggestion,
  currenciesCompatibleForAutoMatch
} from './matcherCompatibility.js';
import { runSupplierBillReconciliationLlmForDocument } from './supplierBillReconciliationLlm.js';
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

// Env kill switch. Default off. Reading on every call is cheap; the
// check sits at the top of the orchestrator (before any DB read) so
// disabled sessions don't even SELECT. When disabled, the orchestrator
// returns `{ ...ZERO_STATS, disabled: true, disabled_reason }` instead
// of a silent ZERO_STATS — operators can distinguish "no matches
// because none existed" from "no matches because the flag was off".
const FLAG_ENABLED = () => {
  const raw = process?.env?.BILL_MATCHER_ENABLED;
  if (raw == null) return false;
  const v = String(raw).trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
};

// Stage 2.7 — second kill switch. When on, the matcher promotes
// candidates that clear `evaluateBillAutoMatch` to `status='auto_matched'`
// + cascade DIRECTLY, without requiring the LLM-triage path to upgrade
// them. Default OFF — preserves the long-standing "matcher stays pure
// (only writes 'suggested', firm PATCH triggers the cascade)" contract
// the bill module was built around. Firms that want clean tier-1
// bills to auto-match without manual confirmation can opt in.
const DETERMINISTIC_AUTO_PROMOTE_ENABLED = () => {
  const raw = process?.env?.BILL_MATCHER_AUTO_PROMOTE_TIER_1;
  if (raw == null) return false;
  const v = String(raw).trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
};

// Three tiers of scoring, descending confidence. Below tier 3 → no
// candidate.
const TIERS = Object.freeze({
  AMOUNT_EXACT_REFERENCE: { name: 'amount_exact_reference', confidence: 0.95 },
  AMOUNT_EXACT_VENDOR:    { name: 'amount_exact_vendor',    confidence: 0.88 },
  AMOUNT_NEAR_VENDOR:     { name: 'amount_near_vendor',     confidence: 0.72 },
  AMOUNT_EXACT_NO_VENDOR: { name: 'amount_exact_no_vendor', confidence: 0.55 }
});

// Tier-3 tolerance — 5% covers FX margin + tax-component variance on
// bills paid via a card-rail rather than a direct bank transfer.
const AMOUNT_NEAR_TOLERANCE = Object.freeze({ absolutePct: 0.05, absoluteUnits: 1 });

// AP window — Q3: issue_date − 7d through due_date + 30d. Shorter
// post-due grace than AR (60d) because firms typically pay bills on
// or before due_date. When due_date is null the fallback upper bound
// is issue_date + 30d (Net 30 is the AP default).
const ISSUE_GRACE_DAYS = 7;
const POST_DUE_GRACE_DAYS = 30;
const DEFAULT_PAYMENT_TERMS_DAYS = 30;

// Persisted-tier floor — anything below this never writes a row.
const SUGGESTED_SCORE_FLOOR = TIERS.AMOUNT_EXACT_NO_VENDOR.confidence;

// Auto-match advisory — tier 1 only, AND extraction confidence is
// good, AND no parse warnings flag the document as suspect. The flag
// rides on `payload.match_reason.auto_match_passed`; PR 9 never
// writes `'auto_matched'` directly.
const AUTO_MATCH_EXTRACTION_CONFIDENCE_FLOOR = 0.85;
const AUTO_MATCH_NULL_EXTRACTION_CONFIDENCE = 0.8;

// Transaction reconciliation_status values that mean "already
// resolved".
const RESOLVED_RECON_STATUSES = new Set([
  'explained',
  'auto_reconciled',
  'reconciled',
  'posted'
]);

// Match statuses that suppress a (transaction, document) pair from
// regenerating after a firm decision.
const SUPPRESSION_STATUSES = new Set(['rejected', 'confirmed', 'auto_matched']);

// Statuses whose `match_amount` counts toward the "settled" total.
const SETTLED_STATUSES = new Set(['confirmed', 'auto_matched']);

const SUPPLIER_BILL_OBJECT_TYPE = 'supplier_bill';

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

const makeMatchId = (clientId, txId, docId) => {
  const raw = `${clientId}|${txId}|${SUPPLIER_BILL_OBJECT_TYPE}|${docId}`;
  return (
    `recon-${slugify(clientId)}-${slugify(txId)}-${slugify(SUPPLIER_BILL_OBJECT_TYPE)}-${slugify(docId)}`.slice(0, 118) +
    `-${shortHash(raw)}`
  );
};

const transactionAmount = (transaction = {}) => {
  const outAmt = Number(transaction.money_out || 0);
  if (outAmt > 0) return outAmt;
  return 0;
};

const transactionText = (transaction = {}) =>
  `${transaction.description || ''} ${transaction.raw_description || ''} ${transaction.contact || ''} ${transaction.source_line || ''}`;

// Suggestion-level currency check. One-sided null passes here so the
// row can be SUGGESTED — auto-match enforcement is stricter (see
// `evaluateBillAutoMatch` below).
const currenciesMatch = currenciesCompatibleForSuggestion;

// Vendor-name fuzzy match. Same shape as the AR matcher's customer
// match — strip whitespace + corporate suffixes, lowercase, then a
// bidirectional substring + token-set fallback. Real bank
// descriptions abbreviate vendor names ("STRIPE INC" → "STRIPE")
// and the matcher needs to absorb that without false-positives on
// "STRIPE HOLDINGS LTD" vs "STRIPE INC".
const CORPORATE_SUFFIXES = new Set([
  'oy', 'oyj', 'ab', 'as', 'asa', 'aps',
  'ltd', 'ltda', 'limited', 'llc', 'llp', 'plc',
  'inc', 'incorporated', 'corp', 'corporation', 'co', 'company',
  'gmbh', 'ug', 'kg', 'ag', 'sa', 'srl', 'sarl', 'spa', 'sl',
  'pte', 'pty', 'sdn', 'bhd', 'kk',
  'sons', 'brothers', 'bros', 'group', 'holdings', 'partnership',
  'international', 'intl', 'enterprises', 'associates', 'partners',
  'com', 'www', 'net', 'org',
  'the', 'and'
]);

// Vendor alias groups for identity matching. If BOTH the document
// vendor and the bank description match the same pattern, they refer
// to the same merchant regardless of how the bank garbles the name.
// Only patterns that bridge genuinely different textual forms belong
// here — single-word names are already caught by token/substring.
const VENDOR_ALIASES = [
  /verizon|vzw|vzwrlss/i,
  /chevron|chvrn/i,
  /exxon(?:mobil)?|exxnmbl/i,
  /at&t|att\b/i,
  /t-?mobile|tmobile|tmobl/i,
  /comcast|xfinity/i,
  /spectrum|charter/i,
  /state\s*farm|statefarm|stfarm/i,
  /amazon|amzn/i,
  /paypal|pypl/i,
  /intuit|quickbooks|qbo/i,
  /tractor\s*supply|tsc\s*stores/i,
  /facebook|facebk/i,
  /napa\s*(?:auto\s*parts|store)/i,
  /webstaurant(?:store|str)/i,
  // Payment-account settlement aliases — bridge "American Express" on
  // the doc side to "AMEX EPAY" / "AMEX PAYMENT" on the bank side.
  // The aliases are bidirectional (both sides must match the pattern),
  // so they don't create false positives on unrelated docs.
  /amex|american\s*express|amer\s*express/i,
  // IRS tax payment confirmations — bridge "IRS" / "Internal Revenue
  // Service" on the doc side to "USATAXPYMT" / "IRS EFTPS" /
  // "INTERNAL REVENUE SERVICE" on the bank side. EFTPS is the
  // official electronic federal tax payment system.
  /irs|internal\s*revenue|usataxpymt|eftps/i,
];

const CONCAT_MIN_LENGTH = 5;

// Common bank abbreviations. Banks truncate merchant names using
// industry-standard forms ("SRVCS" for Services, "MTG" for Mortgage).
const BANK_ABBREVIATIONS = new Map([
  ['mtg', 'mortgage'],
  ['srvcs', 'services'], ['svcs', 'services'], ['svc', 'service'],
  ['imprv', 'improvement'], ['imprvmnt', 'improvement'],
  ['ins', 'insurance'],
  ['dept', 'department'],
  ['pmt', 'payment'], ['pymt', 'payment'],
  ['acct', 'account'],
  ['natl', 'national'],
  ['mgmt', 'management'],
  ['mfg', 'manufacturing'],
  ['equip', 'equipment'],
  ['maint', 'maintenance'],
  ['elec', 'electric'],
  ['pwr', 'power'],
  ['plbg', 'plumbing'],
  ['prop', 'property'],
  ['bldg', 'building'],
  ['apt', 'apartment'],
  ['assoc', 'associates'],
  ['dist', 'distribution'],
  ['mktp', 'marketplace'],
  ['sys', 'systems'],
  ['util', 'utilities'],
  ['hlth', 'health'],
  ['mtr', 'motor'],
  ['comml', 'commercial'],
  ['frght', 'freight'], ['frt', 'freight'],
  ['wrls', 'wireless'],
]);

const normalizeVendorName = (value = '') => {
  const lowered = String(value || '').toLowerCase();
  // Strip apostrophes before general cleanup so "Lowe's" → "lowes" not "lowe s"
  const noApos = lowered.replace(/['’ʼ]/g, '');
  const cleaned = noApos.replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!cleaned) return '';
  const tokens = cleaned.split(' ')
    .filter((t) => t && !CORPORATE_SUFFIXES.has(t))
    .map((t) => BANK_ABBREVIATIONS.get(t) || t);
  return tokens.join(' ');
};

// Word-boundary substring: ensures the needle starts and ends at a
// token boundary (space or string edge) inside the haystack. Prevents
// "gas" matching inside "gasket" or "art supply" spanning "smart supply".
const substringAtWordBoundary = (needle, haystack) => {
  let startIdx = 0;
  while (true) {
    const idx = haystack.indexOf(needle, startIdx);
    if (idx === -1) return false;
    const leftOk = idx === 0 || haystack[idx - 1] === ' ';
    const endIdx = idx + needle.length;
    const rightOk = endIdx === haystack.length || haystack[endIdx] === ' ';
    if (leftOk && rightOk) return true;
    startIdx = idx + 1;
  }
};

// Token-prefix matching for bank truncation. A tx token counts as a
// truncation match if it's a proper prefix of a doc token, ≥ 3 chars,
// and covers < 80% of the doc token (real truncation not pluralization).
// For long tokens (≥ 10 chars), allow up to 90% — banks truncate long
// names by 1-2 chars (e.g. "webstaurantstr" from "webstaurantstore").
const TOKEN_PREFIX_MIN_LEN = 3;
const TOKEN_PREFIX_MAX_RATIO = 0.8;
const TOKEN_PREFIX_LONG_THRESHOLD = 10;
const TOKEN_PREFIX_LONG_MAX_RATIO = 0.9;

const isTokenTruncation = (shorter, longer) => {
  if (shorter.length < TOKEN_PREFIX_MIN_LEN || shorter.length >= longer.length) return false;
  if (!longer.startsWith(shorter)) return false;
  const ratio = shorter.length / longer.length;
  const maxRatio = longer.length >= TOKEN_PREFIX_LONG_THRESHOLD
    ? TOKEN_PREFIX_LONG_MAX_RATIO
    : TOKEN_PREFIX_MAX_RATIO;
  return ratio < maxRatio;
};

export const vendorFromFilename = (filename) => {
  if (!filename) return null;
  return filename
    .replace(/^\d{2,4}[-_.]\d{2}[-_.]\d{2,4}[_ ]+/, '')
    .replace(/[_ ]\d+\.\d{2}\.pdf$/i, '')
    .replace(/\.pdf$/i, '')
    .replace(/[_-]/g, ' ')
    .trim() || null;
};

const vendorOverlaps = (vendor, transaction) => {
  const docNorm = normalizeVendorName(vendor);
  if (!docNorm) return false;
  const txNorm = normalizeVendorName(transactionText(transaction));
  if (!txNorm) return false;
  if (docNorm === txNorm) return true;
  if (substringAtWordBoundary(docNorm, txNorm) || substringAtWordBoundary(txNorm, docNorm)) return true;

  const docTokens = new Set(docNorm.split(' ').filter((t) => t.length >= 3));
  const txTokens = new Set(txNorm.split(' ').filter((t) => t.length >= 3));

  if (docTokens.size) {
    let tokenSetMatch = true;
    for (const token of docTokens) {
      if (!txTokens.has(token)) { tokenSetMatch = false; break; }
    }
    if (tokenSetMatch) return true;

    // Token-prefix fallback: banks truncate descriptions mid-word
    // ("progressive insurance" → "progressive ins"). Every doc token
    // must either appear exactly in tx or have a truncated prefix there.
    if (txTokens.size) {
      let prefixMatch = true;
      for (const dTok of docTokens) {
        if (txTokens.has(dTok)) continue;
        let found = false;
        for (const tTok of txTokens) {
          if (isTokenTruncation(tTok, dTok)) { found = true; break; }
        }
        if (!found) { prefixMatch = false; break; }
      }
      if (prefixMatch) return true;
    }

    // Concatenated-token containment: banks squash vendor names into a
    // single token (e.g. "mannlakeltd"). Check if a single tx token
    // contains the concatenated doc tokens.
    const docConcat = [...docTokens].join('');
    if (docConcat.length >= CONCAT_MIN_LENGTH) {
      for (const txTok of txTokens) {
        if (txTok.length >= docConcat.length && txTok.includes(docConcat)) return true;
      }
    }

    // Brand-anchor fallback: banks often drop descriptor words entirely
    // ("Lowe's Home Improvement" → "LOWES"). If at least one distinctive
    // doc token (≥ 5 chars) appears exactly in the tx, accept. This is
    // the loosest check — amount matching is the primary safety gate,
    // and all matches land as 'suggested' for human review.
    const BRAND_ANCHOR_MIN_LEN = 5;
    for (const dTok of docTokens) {
      if (dTok.length >= BRAND_ANCHOR_MIN_LEN && txTokens.has(dTok)) return true;
    }
  }

  // Vendor alias group: both sides matching the same known merchant
  // pattern is strong identity evidence even when character overlap is
  // minimal (e.g. "Verizon Wireless" vs "vzw vzwrlss"). Runs on raw
  // text so it works even when normalized tokens are too short (AT&T).
  const rawDoc = String(vendor || '').toLowerCase();
  const rawTx = transactionText(transaction).toLowerCase();
  for (const alias of VENDOR_ALIASES) {
    if (alias.test(rawDoc) && alias.test(rawTx)) return true;
  }

  return false;
};

// Reference-substring match. Normalizes both the bill reference and
// the transaction text by stripping non-alphanumerics + lowercasing,
// then substring-matches. Tokens shorter than 4 chars are too noisy.
const REFERENCE_MIN_LEN = 4;
const stripNonAlnum = (value) =>
  String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '');

const referenceMatches = (referenceNumber, transaction) => {
  const ref = stripNonAlnum(referenceNumber);
  if (!ref || ref.length < REFERENCE_MIN_LEN) return false;
  const tx = stripNonAlnum(transactionText(transaction));
  if (!tx) return false;
  return tx.includes(ref);
};

const documentParseWarnings = (document = {}) => {
  const summary = document.parse_summary || {};
  const warnings = Array.isArray(summary.warnings) ? summary.warnings : [];
  return warnings.map((w) => String(w));
};

const computeWindow = (document = {}) => {
  const issue = document.document_date || null;
  const due = document.due_date || null;
  if (!issue) return null;
  const issueMs = toUtcDayMs(issue);
  if (!Number.isFinite(issueMs)) return null;
  const DAY_MS = 24 * 60 * 60 * 1000;
  const lowerMs = issueMs - ISSUE_GRACE_DAYS * DAY_MS;
  let dueMs;
  if (due) {
    const parsed = toUtcDayMs(due);
    dueMs = Number.isFinite(parsed) ? parsed : issueMs + DEFAULT_PAYMENT_TERMS_DAYS * DAY_MS;
  } else {
    dueMs = issueMs + DEFAULT_PAYMENT_TERMS_DAYS * DAY_MS;
  }
  const upperMs = dueMs + POST_DUE_GRACE_DAYS * DAY_MS;
  return { lowerMs, upperMs };
};

const isWithinWindow = (transaction, window) => {
  if (!window) return false;
  const raw = transaction.date || transaction.transaction_date;
  if (!raw) return false;
  const txMs = toUtcDayMs(raw);
  if (!Number.isFinite(txMs)) return false;
  return txMs >= window.lowerMs && txMs <= window.upperMs;
};

// Pure scoring — three-tier descending ladder. `priorSettled` lets
// the scorer recognize partial-payment amounts (a tx matching the
// REMAINING due against a partially-paid bill). Returns null if no
// tier fires.
export const scoreBillMatch = ({
  transaction,
  document,
  window,
  priorSettled = 0
} = {}) => {
  if (!transaction || !document) return null;
  const txAmount = transactionAmount(transaction);
  if (txAmount <= 0) return null;
  const docAmount = Number(document.total_amount);
  if (!Number.isFinite(docAmount) || Math.abs(docAmount) < 0.01) return null;
  if (!currenciesMatch(document.currency, transaction.currency)) return null;

  const safePriorSettled = Number.isFinite(Number(priorSettled)) ? Number(priorSettled) : 0;
  const remainingDue = docAmount - safePriorSettled;

  // Amount can match the bill total (1:1 / first partial) OR the
  // remaining due (a completing partial when prior payments are
  // already confirmed).
  const exactVsTotal = amountMatches(txAmount, docAmount);
  const nearVsTotal = amountWithinTolerance(txAmount, docAmount, AMOUNT_NEAR_TOLERANCE);
  const partialEligible = safePriorSettled > 0 && remainingDue > 0;
  const exactVsRemaining = partialEligible && amountMatches(txAmount, remainingDue);
  const nearVsRemaining =
    partialEligible && amountWithinTolerance(txAmount, remainingDue, AMOUNT_NEAR_TOLERANCE);
  const amountExact = exactVsTotal || exactVsRemaining;
  const amountNear = nearVsTotal || nearVsRemaining;

  const referenceOk = referenceMatches(document.reference_number, transaction);
  const vendorDirect = vendorOverlaps(document.vendor_name, transaction);
  const filenameVendor = !vendorDirect && !document.vendor_name
    ? vendorFromFilename(document.filename)
    : null;
  const vendorFromFile = filenameVendor ? vendorOverlaps(filenameVendor, transaction) : false;

  let vendorFromCandidates = false;
  let candidateVendorSource = null;
  if (!vendorDirect && !vendorFromFile && !document.vendor_name) {
    const candidates = vendorCandidatesFromSummary(document);
    for (const c of candidates) {
      if (vendorOverlaps(c.value, transaction)) {
        vendorFromCandidates = true;
        candidateVendorSource = c.source;
        break;
      }
    }
  }

  const vendorOk = vendorDirect || vendorFromFile || vendorFromCandidates;
  const extractionSource = vendorFromCandidates
    ? (candidateVendorSource || 'vendor_candidate')
    : vendorFromFile && !vendorDirect ? 'filename' : null;
  const inWindow = isWithinWindow(transaction, window || computeWindow(document));

  const hints = [];
  if (amountExact) hints.push('amount_exact');
  else if (amountNear) hints.push('amount_near');
  if (referenceOk) hints.push('reference_match');
  if (vendorOk) hints.push('vendor_overlap');
  if (vendorFromFile && !vendorDirect) hints.push('vendor_from_filename');
  if (inWindow) hints.push('within_window');

  const matchedAgainstRemaining =
    (exactVsRemaining || nearVsRemaining) && !(exactVsTotal || nearVsTotal);

  const baseResult = { hints, matchedAgainstRemaining, extractionSource };

  if (amountExact && referenceOk) {
    return {
      confidence: TIERS.AMOUNT_EXACT_REFERENCE.confidence,
      tier: TIERS.AMOUNT_EXACT_REFERENCE.name,
      summary: 'Exact amount and bill reference matches the bank line.',
      ...baseResult
    };
  }
  if (amountExact && vendorOk) {
    return {
      confidence: TIERS.AMOUNT_EXACT_VENDOR.confidence,
      tier: TIERS.AMOUNT_EXACT_VENDOR.name,
      summary: 'Exact amount, vendor matches the bank counterparty.',
      ...baseResult
    };
  }
  if (amountNear && vendorOk && inWindow) {
    return {
      confidence: TIERS.AMOUNT_NEAR_VENDOR.confidence,
      tier: TIERS.AMOUNT_NEAR_VENDOR.name,
      summary: 'Amount close to bank line; vendor matches; within bill window.',
      ...baseResult
    };
  }
  if (amountExact && inWindow) {
    return {
      confidence: TIERS.AMOUNT_EXACT_NO_VENDOR.confidence,
      tier: TIERS.AMOUNT_EXACT_NO_VENDOR.name,
      summary: 'Exact amount within date window; vendor unconfirmed.',
      ...baseResult
    };
  }
  return null;
};

// Auto-match advisory gate. PR 9 doesn't actually auto-promote — the
// flag rides on `payload.match_reason.auto_match_passed` for a future
// AP auto-promote pass. Only tier 1 with vendor overlap, within
// window, and a healthy extraction_confidence is eligible.
export const evaluateBillAutoMatch = ({ scored, transaction, document, window } = {}) => {
  const blockers = [];
  const eligibleTiers = [TIERS.AMOUNT_EXACT_REFERENCE.name, TIERS.AMOUNT_EXACT_VENDOR.name];
  if (!scored || !eligibleTiers.includes(scored.tier)) {
    blockers.push('tier_not_eligible');
  }
  if (!scored?.hints?.includes('vendor_overlap')) {
    blockers.push('vendor_not_matched');
  }
  const effectiveWindow = window || computeWindow(document);
  if (!isWithinWindow(transaction, effectiveWindow)) {
    blockers.push('outside_window');
  }
  const extractionConfidence =
    document?.extraction_confidence == null
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
  // Strict currency parity for auto-match — one-sided or both-sided
  // null currencies block. Defence in depth with `billAutoExplain`'s
  // own currency check.
  if (!currenciesCompatibleForAutoMatch(transaction?.currency, document?.currency)) {
    blockers.push('currency_mismatch');
  }
  return { passed: blockers.length === 0, blockers };
};

const buildMatchReason = ({
  scored,
  transaction,
  document,
  candidatesConsidered,
  autoMatch,
  priorSettled,
  partialCompletion
}) => {
  const txAmount = transactionAmount(transaction);
  const docAmount = Number(document.total_amount);
  const exact = Number.isFinite(docAmount) && amountMatches(txAmount, docAmount);
  const delta = Number.isFinite(docAmount) ? Math.round((txAmount - docAmount) * 100) / 100 : null;
  const dateGap = daysBetween(
    transaction.date || transaction.transaction_date || '',
    document.document_date || ''
  );

  const hints = [...(scored.hints || [])];
  if (partialCompletion) hints.push('partial_completion');

  return {
    source: 'bill_reconciliation',
    summary: scored.summary,
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
      due_date: document.due_date || null,
      gap_days: Number.isFinite(dateGap) ? dateGap : null
    },
    candidates_considered: candidatesConsidered,
    extraction_confidence:
      document.extraction_confidence == null ? null : Number(document.extraction_confidence),
    parse_warnings: documentParseWarnings(document),
    score: scored.confidence,
    confidence_tier: scored.tier,
    hints,
    extraction_source: scored.extractionSource || null,
    matched_vendor_source: scored.extractionSource || null,
    settled_before: priorSettled,
    partial_completion: partialCompletion,
    auto_match_passed: autoMatch.passed,
    auto_match_blockers: autoMatch.blockers
  };
};

// Pure candidate generator. Mirrors generateSalesInvoiceCandidates
// with direction inverted: scans money_out transactions, filters out
// any with money_in activity.
//
// `objectType` parameterises the existing-match filter so the
// payment_account_statement matcher (Stage 2 of that work) can reuse
// this scoring path while keeping its own `matched_object_type` row
// scope. Default preserves the bill-matcher's behaviour.
export const generateBillCandidates = ({
  transactions = [],
  document,
  existingMatches = [],
  objectType = SUPPLIER_BILL_OBJECT_TYPE
} = {}) => {
  if (!document?.id) {
    return { candidates: [], skipped_rejected: 0, skipped_confirmed: 0, skipped_auto_matched: 0 };
  }

  const suppressionByStatus = { rejected: new Set(), confirmed: new Set(), auto_matched: new Set() };
  let priorSettled = 0;

  for (const row of existingMatches) {
    if (row.matched_object_type && row.matched_object_type !== objectType) continue;
    if (row.matched_object_id !== document.id) continue;
    const key = pairKey(row.bank_transaction_id, row.matched_object_id);
    if (SUPPRESSION_STATUSES.has(row.status)) {
      suppressionByStatus[row.status].add(key);
    }
    if (SETTLED_STATUSES.has(row.status)) {
      const amt = Number(row.match_amount || 0);
      if (Number.isFinite(amt)) priorSettled += amt;
    }
  }

  const window = computeWindow(document);

  const candidates = [];
  let candidatesConsidered = 0;

  for (const transaction of transactions) {
    if (!transaction?.id) continue;
    // Direction gate — money_out only. Inverse of the AR matcher.
    // Defense in depth: also exclude any money_in activity so a
    // mixed-direction import doesn't get proposed.
    if (!(Number(transaction.money_out || 0) > 0)) continue;
    if (Number(transaction.money_in || 0) > 0) continue;
    // Already-resolved transactions are not candidates — EXCEPT a line carrying
    // only a machine auto-explanation (bank-line classifier/disposition, client
    // rule, or coding auto-apply), which document evidence is allowed to
    // outrank. Same shared carve-out as the receipt matcher — the flat
    // exclusion here is what stranded the late-parsing Chevron/Verizon bills
    // against batch-explained micro-spends (2026-08-05).
    if (
      RESOLVED_RECON_STATUSES.has(transaction.reconciliation_status) &&
      !isBankLineOnlyExplained(transaction)
    ) {
      continue;
    }

    const key = pairKey(transaction.id, document.id);
    if (
      suppressionByStatus.rejected.has(key) ||
      suppressionByStatus.confirmed.has(key) ||
      suppressionByStatus.auto_matched.has(key)
    ) {
      continue;
    }

    candidatesConsidered += 1;

    const scored = scoreBillMatch({ transaction, document, window, priorSettled });
    if (!scored) continue;
    if (scored.confidence < SUGGESTED_SCORE_FLOOR) continue;

    const partialCompletion = scored.matchedAgainstRemaining === true;

    const autoMatch = evaluateBillAutoMatch({
      scored,
      transaction,
      document,
      window
    });

    const matchReason = buildMatchReason({
      scored,
      transaction,
      document,
      candidatesConsidered,
      autoMatch,
      priorSettled,
      partialCompletion
    });

    candidates.push({
      transaction,
      document,
      score: scored.confidence,
      summary: scored.summary,
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
  // Stage 2.7 — auto-match counters split out from the suggested
  // tally. Bills that pass the deterministic auto-match gate (or
  // get upgraded by LLM triage) land here.
  auto_match_inserted: 0,
  auto_match_refreshed: 0,
  auto_match_upgraded: 0,
  skipped_rejected: 0,
  skipped_confirmed: 0,
  skipped_auto_matched: 0,
  auto_match_eligible: 0,
  disabled: false,
  disabled_reason: null
});

const DISABLED_STATS = (reason) => ({ ...ZERO_STATS(), disabled: true, disabled_reason: reason });

// Test seam — defaults to the real LLM matcher (the same shape as
// receiptReconciliation.js `__llmMatcher`). Production always calls the real
// import through this object; the weighted-body suites stub `run` to a
// non-provider self-disable so the weighted body under test still runs —
// a MISSING key is no longer a way into it (it is a provider failure now).
// The default `run` WRAPS the import in an arrow rather than aliasing it,
// so the binding is read at CALL time (the wrapper ↔ LLM module ↔ core ↔
// firmDb import cycle would otherwise hit a temporal dead zone).
export const __llmMatcher = {
  run: (params) => runSupplierBillReconciliationLlmForDocument(params)
};

// Orchestrator. Mirrors `runSalesInvoiceReconciliationForDocument` —
// runs inside the writer transaction, scoped to one just-parsed bill.
// Caller (parseDocumentsDb.js) wraps this in a soft-degrade try/catch
// so a thrown error here doesn't roll back the parse.
export const runBillReconciliationForDocument = async ({
  client,
  firmId,
  clientId,
  documentId
} = {}) => {
  // Env kill switch — early return BEFORE any DB read. Surfaces a
  // `disabled` flag so callers can log the suppression instead of
  // confusing it with a genuine no-match outcome.
  if (!FLAG_ENABLED()) return DISABLED_STATS('BILL_MATCHER_ENABLED not enabled');
  if (!client || !firmId || !clientId || !documentId) return ZERO_STATS();

  // Slice E step 2 — AP coverage. The LLM matcher is PRIMARY,
  // unconditionally (batch-2 terminal state 1: the
  // RECONCILIATION_MATCHER_MODE gate is deleted,
  // docs/donna-batch2-matcher-mode-dead-branch-plan.md). It returns the
  // same stats shape so callers can `accumulate(stats)` unchanged.
  // When the LLM matcher self-disables (e.g. no ANTHROPIC_API_KEY)
  // or throws on infrastructure, fall through to the weighted
  // matcher below — same shape the AR path uses. See
  // `docs/donna-llm-trust-strategy.md` §3 Slice E + CLAUDE.md
  // Failure B (the FX-card-settlement bug this delegation closes).
  // Q7 (the model lab): the lane's active experiment policy for this
  // (firm, client). When a non-claude rung is seated: (a) the LLM
  // matcher's deciding call rides the compatible endpoint, (b) Opus
  // reverse-shadows every decision (receipt-only), and (c) the weighted
  // matcher is NOT a fallback — a policy-run failure fails LOUD (rethrow;
  // the per-doc catch upstream counts it and the next pass retries).
  // A silent decider swap mid-experiment — to Opus OR to the weighted
  // scorer — would poison the comparison the policy exists to run.
  let decidingPolicy = null;
  try {
    decidingPolicy = await readLaneDecidingPolicy({
      client, firmId, clientId, laneId: RECONCILIATION_REASONING_LANE
    });
  } catch { decidingPolicy = null; } // missing table ⇒ no policy, byte-identical
  const policyModel = typeof decidingPolicy?.deciding_model === 'string' && decidingPolicy.deciding_model.trim()
    ? decidingPolicy.deciding_model.trim()
    : null;
  const policyActive = Boolean(policyModel) && !policyModel.startsWith('claude');
  let challengerHook = null;
  if (policyActive) {
    const challengerSnapshot = await readClientConfigSnapshot(client, { firmId, clientId });
    challengerHook = makeReconciliationReasoningChallengerHook({
      decidingPolicy,
      family: 'supplier_bill',
      firmId,
      clientId,
      snapshot: challengerSnapshot,
      withClient: withFirmDbClient
    });
  }

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
      // pool. No-op when there is none.
      await clearReconciliationProviderFailureWithClient({ client, firmId, clientId, documentId, logTag: 'billReconciliation' });
      return llmStats;
    }
    const keyMissing = providerFailureFromDisabledStats(llmStats);
    if (keyMissing) {
      // No Anthropic key: a provisioning gap that rests on the OPERATOR —
      // receipted on the document, re-driven once a key exists. Never the
      // weighted body (a heuristic replacement decision), never a verdict.
      return providerFailureStats({ client, firmId, clientId, documentId, family: 'supplier_bill', failure: keyMissing, logTag: 'billReconciliation', zeroStats: ZERO_STATS });
    }
    if (policyActive) {
      console.error('[billReconciliation] LLM matcher disabled under an ACTIVE model policy — refusing the weighted fallback', {
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
      const stats = await providerFailureStats({ client, firmId, clientId, documentId, family: 'supplier_bill', failure: error, logTag: 'billReconciliation', zeroStats: ZERO_STATS });
      if (policyActive) throw error;
      return stats;
    }
    if (policyActive) {
      console.error('[billReconciliation] LLM matcher threw under an ACTIVE model policy — refusing the weighted fallback', {
        documentId,
        policy_model: policyModel,
        error: error?.message || String(error)
      });
      throw error;
    }
    console.error('[billReconciliation] LLM matcher threw, falling back to weighted (infrastructure failure, not a provider failure)', {
      documentId,
      error: error?.message || String(error)
    });
  }

  // 1. Load the just-parsed bill. Gates inline so a non-bill /
  //    no-total / duplicate doc returns zero rows.
  const docResult = await client.query(
    `select id, firm_id, client_id, document_type, vendor_name, customer_name, document_date,
            due_date, total_amount, currency, extraction_confidence, parse_summary,
            duplicate_of, reference_number, filename, payment_status
       from documents
      where firm_id = $1
        and client_id = $2
        and id = $3
        and document_type = 'supplier_bill'
        and parse_status = 'completed'
        and total_amount is not null
        and duplicate_of is null`,
    [firmId, clientId, documentId]
  );
  if (!docResult.rows.length) return ZERO_STATS();
  const document = docResult.rows[0];

  // 2. Load unreconciled money_out transactions for this client.
  //    Same JSONB shape as the receipt + AR matchers use.
  // Candidate status filter is the SHARED carve-out (reconciliationLlmCore.js)
  // — identical to the receipt + LLM matchers', so the families can't drift.
  // It admits standalone machine-explained lines (bank-line classifier/
  // disposition, client rule, coding auto-apply) so document evidence can
  // outrank them. A Donna auto-applied posting is also admitted when its
  // document arrives later; doc-matched and human/firm-posted lines stay
  // excluded. The companion SELECT (+ the disposition/coder markers) carries what
  // isBankLineOnlyExplained reads in the in-loop guard above, keeping SQL
  // and JS in lock-step.
  const txResult = await client.query(
    `select id, firm_id, client_id, money_in, money_out, currency,
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
        and (money_in is null or money_in = 0)
        and ${CANDIDATE_TX_STATUS_SQL}`,
    [firmId, clientId]
  );

  // 3. Load existing matches for this document — for suppression +
  //    partial-completion math. Scoped to this document via the
  //    matched_object_type filter (the receipt matcher's rows on the
  //    same tx are intentionally ignored — Q1 confirmed).
  const existingResult = await client.query(
    `select id, bank_transaction_id, matched_object_type, matched_object_id,
            status, match_amount, match_confidence, payload
       from reconciliation_matches
      where firm_id = $1
        and client_id = $2
        and matched_object_type = 'supplier_bill'
        and matched_object_id = $3`,
    [firmId, clientId, documentId]
  );

  // 4. Generate candidates (pure).
  const {
    candidates,
    skipped_rejected,
    skipped_confirmed,
    skipped_auto_matched
  } = generateBillCandidates({
    transactions: txResult.rows,
    document,
    existingMatches: existingResult.rows
  });

  const stats = ZERO_STATS();
  stats.skipped_rejected = skipped_rejected;
  stats.skipped_confirmed = skipped_confirmed;
  stats.skipped_auto_matched = skipped_auto_matched;

  // 4b. LLM triage for low-confidence candidates (Phase 5).
  //     Tier 3/4 candidates (confidence < 0.85) get evaluated by the
  //     LLM to confirm or reject the match. Pre-compute matchIds so
  //     the triage module can log decisions against stable identifiers.
  const apiKey = process.env.ANTHROPIC_API_KEY || '';
  let triageResults = new Map();
  if (apiKey && candidates.some((c) => c.score < 0.85)) {
    for (const c of candidates) {
      c.matchId = makeMatchId(clientId, c.transaction.id, document.id);
    }
    try {
      triageResults = await triageReconciliationCandidates({
        candidates,
        apiKey,
        client,
        firmId,
        clientId
      });
    } catch (error) {
      console.error('[billReconciliation] triage failed, falling through to suggested', {
        documentId,
        error: error?.message || String(error)
      });
    }
  }

  // 5. Persist. Stage 2.7 — auto_matched on EITHER (a) the LLM triage
  //    upgraded the candidate, OR (b) the deterministic auto-match
  //    advisory (evaluateBillAutoMatch, attached as
  //    candidate.auto_match_passed) cleared its gate: tier 1 + vendor
  //    overlap + within window + healthy extraction confidence + no
  //    amount_mismatch warning + currency parity + not a duplicate.
  //    Path (b) means the matcher no longer depends on
  //    ANTHROPIC_API_KEY being set to auto-promote clean tier-1
  //    bills; previously the advisory just rode on
  //    payload.match_reason.auto_match_passed for a "future
  //    auto-promote pass" that never actually ran in this orchestrator.
  //    Sub-tier candidates (or any blocked verdicts) still land as
  //    'suggested'. ON CONFLICT excludes terminal statuses so
  //    firm-decided rows are sticky.
  // 0A.10 — resolve the per-run config snapshot ONCE (client + firmId + clientId
  // in scope) so the auto-match canary on this legacy path is config-plane-aware.
  // Soft-fails to {} ⇒ env fallback, byte-identical until a DB row exists.
  const configSnapshot = await readClientConfigSnapshot(client, { firmId, clientId });
  // Cross-entity intake guard (2026-08-04, findings §4b-xvi): the persisted
  // extraction's OWN-SIDE party vs the book's identity. A confident mismatch
  // DEMOTES to 'suggested' (never auto) and stamps the relation for the ask
  // lane; unknown/aligned is byte-identical to before.
  const clientIdentity = await readClientIdentityWithClient(client, { firmId, clientId });
  const entityAlignment = assessDocumentEntityAlignment({ clientIdentity, document });
  for (let idx = 0; idx < candidates.length; idx++) {
    const candidate = candidates[idx];
    const triage = triageResults.get(idx);

    if (triage?.finalState === 'blocked') continue;

    const matchId = candidate.matchId || makeMatchId(clientId, candidate.transaction.id, document.id);
    const triageAutoMatched = triage?.finalState === 'auto_matched';
    // Stage 2.7 — deterministic auto-promote rides on a SEPARATE flag
    // (BILL_MATCHER_AUTO_PROMOTE_TIER_1). Default off preserves the
    // matcher-stays-pure contract. Existing LLM-triage upgrade path is
    // unchanged.
    const deterministicAutoMatched =
      DETERMINISTIC_AUTO_PROMOTE_ENABLED() && candidate.auto_match_passed === true;
    // Client-scoped auto-match canary (see reconciliationLlmCore.clientAllowedToAutoMatch):
    // honor RECONCILIATION_AUTO_MATCH_CLIENTS on this legacy path too. No-op without an
    // allowlist; otherwise a non-allowlisted client is held to 'suggested' (surfaced, not hidden).
    const writeStatus = ((triageAutoMatched || deterministicAutoMatched) && entityAlignment.verdict !== 'mismatch' && clientAllowedToAutoMatch(clientId, undefined, { configSnapshot })) ? 'auto_matched' : 'suggested';
    const writeScore = triage?.upgradedScore ?? candidate.score;
    const payload = {
      source: 'bill_reconciliation',
      ...(entityAlignment.verdict === 'mismatch' ? { cross_entity: crossEntityPayload(entityAlignment) } : {}),
      match_reason: candidate.match_reason,
      recommended_action: writeStatus === 'auto_matched' ? 'auto_matched' : 'review'
    };
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
    }
    if (writeStatus === 'auto_matched') {
      payload.match_reason = {
        ...payload.match_reason,
        auto_match_passed: true,
        auto_match_source: triageAutoMatched
          ? (deterministicAutoMatched ? 'triage_and_deterministic' : 'llm_triage')
          : 'deterministic'
      };
    }
    // See paymentConfirmationReconciliation.js for the rationale on
    // the CTE + status CASE. Pre-fix, the SET omitted `status`, so a
    // `suggested` row that the bill matcher later evaluates as
    // auto-match-passing (e.g. after BILL_MATCHER_AUTO_PROMOTE_TIER_1
    // flips on) would stay `suggested` forever, and cascadeAutoMatch
    // (gated below on `wasInserted && writeStatus === 'auto_matched'`)
    // would not re-fire on the refresh. Net result: rows the matcher
    // wants to promote get stuck. The CASE upgrades suggested →
    // auto_matched on refresh; the cascade trigger below now also
    // fires for the upgrade path.
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
        SUPPLIER_BILL_OBJECT_TYPE,
        document.id,
        transactionAmount(candidate.transaction),
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
      // Stage 2.7 — split the insert tally by status so auto-matched
      // rows are visible separately from review-required suggestions.
      if (writeStatus === 'auto_matched') stats.auto_match_inserted += 1;
      else stats.suggested_inserted += 1;
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
            match_kind: 'supplier_bill',
            confidence_tier: candidate.match_reason.confidence_tier,
            score: writeScore,
            partial_completion: candidate.match_reason.partial_completion === true,
            auto_match_passed: candidate.auto_match_passed || (triage?.finalState === 'auto_matched'),
            auto_match_blockers: candidate.auto_match_blockers,
            llm_triage: triage ? triage.verdict : null
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
            matchedObjectType: SUPPLIER_BILL_OBJECT_TYPE,
            documentId: document.id
          });
          await applyDocumentPaymentStatusAfterMatch({
            client,
            firmId,
            matchId,
            matchedObjectType: SUPPLIER_BILL_OBJECT_TYPE,
            documentId: document.id
          });
        } catch (error) {
          console.error('[billReconciliation] auto-match cascade failed', {
            matchId,
            error: error?.message || String(error)
          });
        }
      }
    } else if (wasUpgraded) {
      // suggested → auto_matched on refresh. Counter + audit + cascade
      // mirror the fresh-insert auto_matched path; the only difference
      // is the audit action name so the audit trail records the
      // transition explicitly.
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
            match_kind: 'supplier_bill',
            confidence_tier: candidate.match_reason.confidence_tier,
            score: writeScore,
            partial_completion: candidate.match_reason.partial_completion === true,
            prior_status: priorStatus,
            status: finalStatus,
            auto_match_passed: candidate.auto_match_passed || (triage?.finalState === 'auto_matched'),
            auto_match_blockers: candidate.auto_match_blockers,
            llm_triage: triage ? triage.verdict : null
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
          matchedObjectType: SUPPLIER_BILL_OBJECT_TYPE,
          documentId: document.id
        });
        await applyDocumentPaymentStatusAfterMatch({
          client,
          firmId,
          matchId,
          matchedObjectType: SUPPLIER_BILL_OBJECT_TYPE,
          documentId: document.id
        });
      } catch (error) {
        console.error('[billReconciliation] upgrade cascade failed', {
          matchId,
          error: error?.message || String(error)
        });
      }
    } else if (writeStatus === 'auto_matched') {
      stats.auto_match_refreshed += 1;
    } else {
      stats.suggested_refreshed += 1;
    }

    if (candidate.auto_match_passed || triage?.finalState === 'auto_matched') {
      stats.auto_match_eligible += 1;
    }
  }

  return stats;
};

export const __SUPPLIER_BILL_OBJECT_TYPE = SUPPLIER_BILL_OBJECT_TYPE;
export const __vendorOverlaps = vendorOverlaps;
