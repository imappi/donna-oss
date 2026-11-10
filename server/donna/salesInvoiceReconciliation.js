// Reconciliation PR 8 — deterministic sales-invoice candidate matching.
//
// Mirrors the shape of `server/donna/receiptReconciliation.js`, with
// direction flipped to money_in and AR-specific signals (customer-name
// fuzzy match, reference substring against the tx description) layered
// on top. Only ever writes `status='suggested'` — the 'auto_matched'
// flip is reserved for a future sibling pass (deferred per PR 8 Q6).
// `payload.match_reason.auto_match_passed` rides on the row so a future
// AR auto-promote can consume the verdict without re-scoring.
//
// Direction safety is invariant 2: candidate scan filters on
// `money_in > 0 AND (money_out is null or money_out = 0)`. A receipt
// matcher's candidate set (money_out) and an AR matcher's set
// (money_in) never overlap.
//
// matched_object_type is `'sales_invoice'` (per Q5 option B — same
// convention `firmDb.createManualReconciliationMatchInDb` already
// uses). The FE inbox (`src/lib/documentsInbox.js`) widens its
// `isDocumentMatch` predicate to accept document-type strings.
//
// payment_status flipping is NOT this module's job. The match row
// lands as 'suggested'; the firm confirming the row via the existing
// PATCH endpoint triggers `firmDb.updateReconciliationMatchInDb` to
// compute the new payment_status from sum(confirmed amounts) vs
// total_amount. See firmDb.js for the AR-aware status branch.

import {
  amountMatches,
  amountWithinTolerance,
  daysBetween,
  normalizeIntelText
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
import { runSalesInvoiceReconciliationLlmForDocument } from './salesInvoiceReconciliationLlm.js';
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

// Env kill switch. Default off so per-firm rollout is opt-in until
// calibration passes. Reading on every call is cheap (env access only),
// and putting the check inside the orchestrator (not at the writer
// gate) keeps the writer-side "sales_invoice triggers the orchestrator"
// test stable across flag flips. When disabled, the orchestrator
// returns `{ ...ZERO_STATS, disabled: true, disabled_reason }` so the
// suppression is visible to operators.
const FLAG_ENABLED = () => {
  const raw = process?.env?.SALES_INVOICE_MATCHER_ENABLED;
  if (raw == null) return false;
  const v = String(raw).trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
};

// Three tiers of scoring, descending confidence. Below tier 3 → no
// candidate. Tier 1 is the only auto-promote-eligible tier (Q6 — but
// PR 8 doesn't actually auto-promote; the flag is advisory for a
// future sibling).
const TIERS = Object.freeze({
  AMOUNT_EXACT_REFERENCE: { name: 'amount_exact_reference', confidence: 0.95 },
  AMOUNT_EXACT_CUSTOMER:  { name: 'amount_exact_customer',  confidence: 0.88 },
  AMOUNT_NEAR_CUSTOMER:   { name: 'amount_near_customer',   confidence: 0.72 },
  AMOUNT_EXACT_NO_CUSTOMER: { name: 'amount_exact_no_customer', confidence: 0.55 }
});

// Tier-3 tolerance — 5% covers customer-bank transaction fees that
// shave a small amount off the payment.
const AMOUNT_NEAR_TOLERANCE = Object.freeze({ absolutePct: 0.05, absoluteUnits: 1 });

// AR window — issue_date − 7 days through due_date + 60 days. The 60d
// grace covers late payments; 7d before issue covers prepayments that
// land in the bank a few days before the invoice was formally issued.
// When due_date is missing, fall back to issue_date + 30d as the upper
// bound (Net 30 is the AR default).
const ISSUE_GRACE_DAYS = 7;
const POST_DUE_GRACE_DAYS = 60;
const DEFAULT_PAYMENT_TERMS_DAYS = 30;

// Persisted-tier floor — anything below this never writes a row.
const SUGGESTED_SCORE_FLOOR = TIERS.AMOUNT_EXACT_NO_CUSTOMER.confidence;

// Auto-match advisory — Q6: tier 1 only, AND extraction confidence is
// good, AND no parse warnings flag the document as suspect. Even when
// `auto_match_passed=true` we still write `status='suggested'`; PR 8
// does not auto-promote.
const AUTO_MATCH_EXTRACTION_CONFIDENCE_FLOOR = 0.85;
const AUTO_MATCH_NULL_EXTRACTION_CONFIDENCE = 0.8;

// Transaction reconciliation_status values that mean "already
// resolved" — never propose against these.
const RESOLVED_RECON_STATUSES = new Set([
  'explained',
  'auto_reconciled',
  'reconciled',
  'posted'
]);

// Match statuses that suppress a (transaction, document) pair from
// regenerating after a firm decision.
const SUPPRESSION_STATUSES = new Set(['rejected', 'confirmed', 'auto_matched']);

// Statuses whose `match_amount` counts toward the "settled" total when
// detecting partial-completion. Mirrors the F2 PATCH-endpoint rule.
const SETTLED_STATUSES = new Set(['confirmed', 'auto_matched']);

const SALES_INVOICE_OBJECT_TYPE = 'sales_invoice';

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
  const raw = `${clientId}|${txId}|${SALES_INVOICE_OBJECT_TYPE}|${docId}`;
  return (
    `recon-${slugify(clientId)}-${slugify(txId)}-${slugify(SALES_INVOICE_OBJECT_TYPE)}-${slugify(docId)}`.slice(0, 118) +
    `-${shortHash(raw)}`
  );
};

const safeNumber = (value) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

const transactionAmount = (transaction = {}) => {
  const inAmt = Number(transaction.money_in || 0);
  if (inAmt > 0) return inAmt;
  return 0;
};

const transactionText = (transaction = {}) =>
  `${transaction.description || ''} ${transaction.raw_description || ''} ${transaction.contact || ''} ${transaction.source_line || ''}`;

// Suggestion-level currency check (tolerant of one-sided null).
// Auto-match enforcement is stricter — see `evaluateSalesInvoiceAutoMatch`.
const currenciesMatch = currenciesCompatibleForSuggestion;

// Customer-name fuzzy match. Strips whitespace, lowercases, and drops
// common corporate suffixes (Oy / Ltd / Inc / GmbH / etc.) so
// "Globex Industries Oy" matches "Globex Industries" — but
// "Globex Industries" does NOT match "Globex Holdings" (different
// non-suffix tokens). The match is bidirectional substring on the
// suffix-stripped, normalized forms.
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

const CUSTOMER_ALIASES = [
  /verizon|vzw|vzwrlss/i,
  /at&t|att\b/i,
  /t-?mobile|tmobile|tmobl/i,
  /comcast|xfinity/i,
  /spectrum|charter/i,
  /amazon|amzn/i,
  /paypal|pypl/i,
];

const CONCAT_MIN_LENGTH = 5;

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

const normalizeCustomerName = (value = '') => {
  const lowered = String(value || '').toLowerCase();
  const noApos = lowered.replace(/[''ʼ]/g, '');
  const cleaned = noApos.replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!cleaned) return '';
  const tokens = cleaned.split(' ')
    .filter((t) => t && !CORPORATE_SUFFIXES.has(t))
    .map((t) => BANK_ABBREVIATIONS.get(t) || t);
  return tokens.join(' ');
};

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

const customerOverlaps = (customer, transaction) => {
  const docNorm = normalizeCustomerName(customer);
  if (!docNorm) return false;
  const txNorm = normalizeCustomerName(transactionText(transaction));
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

    const docConcat = [...docTokens].join('');
    if (docConcat.length >= CONCAT_MIN_LENGTH) {
      for (const txTok of txTokens) {
        if (txTok.length >= docConcat.length && txTok.includes(docConcat)) return true;
      }
    }

    const BRAND_ANCHOR_MIN_LEN = 5;
    for (const dTok of docTokens) {
      if (dTok.length >= BRAND_ANCHOR_MIN_LEN && txTokens.has(dTok)) return true;
    }
  }

  const rawDoc = String(customer || '').toLowerCase();
  const rawTx = transactionText(transaction).toLowerCase();
  for (const alias of CUSTOMER_ALIASES) {
    if (alias.test(rawDoc) && alias.test(rawTx)) return true;
  }

  return false;
};

// Reference-substring match. Normalizes both the invoice reference and
// the transaction text by stripping all non-alphanumerics + lowercasing,
// then substring-matches. Catches "INV-2024-0042" vs "Payment INV2024-0042"
// vs "INV20240042" etc. Tokens shorter than 4 chars are too noisy to
// trust (the bank reference field often contains a 3-digit branch code).
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

// Pure scoring — three-tier descending ladder. Returns the highest
// tier whose predicates fire, or null if no tier matches.
//
// `priorSettled` lets the scorer recognize partial-payment-shaped
// amounts. A 2,500 tx against a 5,000 invoice with 2,500 already
// confirmed is an "amount-exact" match against the REMAINING due —
// the same scoring shape as a 1:1 full-settlement match. When the
// match is against remaining_due (not total_amount) AND prior
// settled > 0, the candidate also carries `partial_completion=true`
// upstream.
//
// Hints are categorical labels surfaced in the row's match_reason so
// the FE can render hint chips ("Exact amount", "Reference match",
// "Customer match", "Within window", "Close amount"). Mirrors the
// receipt-side hint vocabulary, with `partial_completion` added
// (only on partial settlements).
export const scoreSalesInvoiceMatch = ({
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

  // Amount can match either the invoice total (1:1 / first partial)
  // OR the remaining due (a completing partial when prior payments
  // are already confirmed). The "against remaining" path only
  // engages when priorSettled > 0 AND remainingDue > 0 — otherwise
  // it would alias to amount-vs-total.
  const exactVsTotal = amountMatches(txAmount, docAmount);
  const nearVsTotal = amountWithinTolerance(txAmount, docAmount, AMOUNT_NEAR_TOLERANCE);
  const partialEligible = safePriorSettled > 0 && remainingDue > 0;
  const exactVsRemaining = partialEligible && amountMatches(txAmount, remainingDue);
  const nearVsRemaining =
    partialEligible && amountWithinTolerance(txAmount, remainingDue, AMOUNT_NEAR_TOLERANCE);
  const amountExact = exactVsTotal || exactVsRemaining;
  const amountNear = nearVsTotal || nearVsRemaining;

  const referenceOk = referenceMatches(document.reference_number, transaction);
  const customerOk = customerOverlaps(document.customer_name, transaction);
  const inWindow = isWithinWindow(transaction, window || computeWindow(document));

  const hints = [];
  if (amountExact) hints.push('amount_exact');
  else if (amountNear) hints.push('amount_near');
  if (referenceOk) hints.push('reference_match');
  if (customerOk) hints.push('customer_overlap');
  if (inWindow) hints.push('within_window');

  // The match qualifies as a partial completion when the exact/near
  // amount baseline was the REMAINING due (not the full total) AND
  // there's a prior confirmed payment. The orchestrator surfaces
  // this as a `partial_completion` hint on top of the tier scoring.
  const matchedAgainstRemaining =
    (exactVsRemaining || nearVsRemaining) && !(exactVsTotal || nearVsTotal);

  if (amountExact && referenceOk) {
    return {
      confidence: TIERS.AMOUNT_EXACT_REFERENCE.confidence,
      tier: TIERS.AMOUNT_EXACT_REFERENCE.name,
      summary: 'Exact amount and invoice reference matches the bank line.',
      hints,
      matchedAgainstRemaining
    };
  }
  if (amountExact && customerOk) {
    return {
      confidence: TIERS.AMOUNT_EXACT_CUSTOMER.confidence,
      tier: TIERS.AMOUNT_EXACT_CUSTOMER.name,
      summary: 'Exact amount, customer matches the bank counterparty.',
      hints,
      matchedAgainstRemaining
    };
  }
  if (amountNear && customerOk && inWindow) {
    return {
      confidence: TIERS.AMOUNT_NEAR_CUSTOMER.confidence,
      tier: TIERS.AMOUNT_NEAR_CUSTOMER.name,
      summary: 'Amount close to bank line; customer matches; within invoice window.',
      hints,
      matchedAgainstRemaining
    };
  }
  if (amountExact && inWindow) {
    return {
      confidence: TIERS.AMOUNT_EXACT_NO_CUSTOMER.confidence,
      tier: TIERS.AMOUNT_EXACT_NO_CUSTOMER.name,
      summary: 'Exact amount within date window; customer unconfirmed.',
      hints,
      matchedAgainstRemaining
    };
  }
  return null;
};

// Auto-match advisory gate. PR 8 doesn't actually auto-promote — the
// flag rides on `payload.match_reason.auto_match_passed` for a future
// AR auto-promote pass. Only tier 1 (amount_exact_reference) with a
// customer overlap, within window, and a healthy extraction_confidence
// is eligible. Q6.
export const evaluateSalesInvoiceAutoMatch = ({ scored, transaction, document, window } = {}) => {
  const blockers = [];
  const eligibleTiers = [TIERS.AMOUNT_EXACT_REFERENCE.name, TIERS.AMOUNT_EXACT_CUSTOMER.name];
  if (!scored || !eligibleTiers.includes(scored.tier)) {
    blockers.push('tier_not_eligible');
  }
  if (!scored?.hints?.includes('customer_overlap')) {
    blockers.push('customer_not_matched');
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
  // null currencies block. Defence in depth with
  // `salesInvoiceAutoExplain`'s own currency check.
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
    source: 'sales_invoice_reconciliation',
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
    settled_before: priorSettled,
    partial_completion: partialCompletion,
    auto_match_passed: autoMatch.passed,
    auto_match_blockers: autoMatch.blockers
  };
};

// Pure candidate generator. Mirrors generateReceiptCandidates: the
// orchestrator passes the parsed invoice + unreconciled money_in
// transactions + existing matches, gets back a list of candidates to
// persist. Tracks settled amount (prior confirmed/auto-matched sums)
// so the partial-completion hint fires on the right transaction.
export const generateSalesInvoiceCandidates = ({
  transactions = [],
  document,
  existingMatches = [],
  // RT-27 — credit notes already APPLIED to this invoice (document_credit_
  // applications, status 'applied') settle part of it exactly like a
  // confirmed line: they seed the prior-settled sum so the remaining-due
  // scoring sees invoice − credit. Only persisted applications count here —
  // the weighted fallback never selects a credit (that is the strong model's
  // call in the LLM lane); it merely honours what was applied.
  appliedCredits = 0
} = {}) => {
  if (!document?.id) {
    return { candidates: [], skipped_rejected: 0, skipped_confirmed: 0, skipped_auto_matched: 0 };
  }

  const suppressionByStatus = { rejected: new Set(), confirmed: new Set(), auto_matched: new Set() };
  let priorSettled = Number.isFinite(Number(appliedCredits)) && Number(appliedCredits) > 0 ? Number(appliedCredits) : 0;

  for (const row of existingMatches) {
    if (row.matched_object_type && row.matched_object_type !== SALES_INVOICE_OBJECT_TYPE) continue;
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
    // Direction gate — money_in only. Receipt-matcher inverse.
    if (!(Number(transaction.money_in || 0) > 0)) continue;
    if (Number(transaction.money_out || 0) > 0) continue;
    // Already-resolved transactions are not candidates — EXCEPT a line
    // carrying only a machine auto-explanation, which document evidence is
    // allowed to outrank (the shared carve-out; see billReconciliation for
    // the stranding this prevents).
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

    const scored = scoreSalesInvoiceMatch({ transaction, document, window, priorSettled });
    if (!scored) continue;
    if (scored.confidence < SUGGESTED_SCORE_FLOOR) continue;

    // Partial-completion is true exactly when the scorer found the
    // amount-exact-or-near match against `remaining_due` (not total)
    // AND `priorSettled > 0`. The scorer reports both signals; we
    // just forward.
    const partialCompletion = scored.matchedAgainstRemaining === true;

    const autoMatch = evaluateSalesInvoiceAutoMatch({
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
  run: (params) => runSalesInvoiceReconciliationLlmForDocument(params)
};

// Orchestrator. Mirrors `runReceiptReconciliationForDocument` — runs
// inside the writer transaction, scoped to one just-parsed invoice.
// Caller (parseDocumentsDb.js) wraps this in a soft-degrade try/catch
// so a thrown error here doesn't roll back the parse.
export const runSalesInvoiceReconciliationForDocument = async ({
  client,
  firmId,
  clientId,
  documentId
} = {}) => {
  // Env kill switch — early return BEFORE any DB read so disabled
  // sessions don't even SELECT. The disabled stats let callers log the
  // suppression instead of conflating it with "no matches found".
  if (!FLAG_ENABLED()) return DISABLED_STATS('SALES_INVOICE_MATCHER_ENABLED not enabled');
  if (!client || !firmId || !clientId || !documentId) return ZERO_STATS();

  // Slice E scoping pass — the LLM matcher is PRIMARY, unconditionally
  // (batch-2 terminal state 1: the RECONCILIATION_MATCHER_MODE gate is
  // deleted, docs/donna-batch2-matcher-mode-dead-branch-plan.md). It
  // returns the same stats shape so callers can `accumulate(stats)`
  // unchanged. When the LLM matcher self-disables (e.g. no
  // ANTHROPIC_API_KEY) or throws on infrastructure, fall through to the
  // weighted matcher below. See
  // `docs/donna-llm-trust-strategy.md` §3 Slice E.
  // Q7 (the model lab): the lane's active experiment policy for this
  // (firm, client). When a non-claude rung is seated: (a) the LLM
  // matcher's deciding call rides the compatible endpoint, (b) Opus
  // reverse-shadows every decision (receipt-only), and (c) the weighted
  // matcher is NOT a fallback — a policy-run failure fails LOUD (rethrow;
  // the per-doc catch upstream counts it and the next pass retries).
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
      family: 'sales_invoice',
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
      await clearReconciliationProviderFailureWithClient({ client, firmId, clientId, documentId, logTag: 'salesInvoiceReconciliation' });
      return llmStats;
    }
    const keyMissing = providerFailureFromDisabledStats(llmStats);
    if (keyMissing) {
      // No Anthropic key: a provisioning gap that rests on the OPERATOR —
      // receipted on the document, re-driven once a key exists. Never the
      // weighted body (a heuristic replacement decision), never a verdict.
      return providerFailureStats({ client, firmId, clientId, documentId, family: 'sales_invoice', failure: keyMissing, logTag: 'salesInvoiceReconciliation', zeroStats: ZERO_STATS });
    }
    if (policyActive) {
      console.error('[salesInvoiceReconciliation] LLM matcher disabled under an ACTIVE model policy — refusing the weighted fallback', {
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
      const stats = await providerFailureStats({ client, firmId, clientId, documentId, family: 'sales_invoice', failure: error, logTag: 'salesInvoiceReconciliation', zeroStats: ZERO_STATS });
      if (policyActive) throw error;
      return stats;
    }
    if (policyActive) {
      console.error('[salesInvoiceReconciliation] LLM matcher threw under an ACTIVE model policy — refusing the weighted fallback', {
        documentId,
        policy_model: policyModel,
        error: error?.message || String(error)
      });
      throw error;
    }
    console.error('[salesInvoiceReconciliation] LLM matcher threw, falling back to weighted (infrastructure failure, not a provider failure)', {
      documentId,
      error: error?.message || String(error)
    });
  }

  // 1. Load the just-parsed invoice. Gates inline so a non-AR /
  //    no-total / duplicate doc returns zero rows. Accepts both
  //    'sales_invoice' (unpaid AR — money expected in) and
  //    'issued_receipt' (receipt the firm issued, acknowledging money
  //    already received). Both share the same scoring + reference-
  //    fuzzy semantics; payment_status semantics differ but that's
  //    settled at write time by the extractor, not here.
  const docResult = await client.query(
    `select id, firm_id, client_id, document_type, customer_name, vendor_name, document_date,
            due_date, total_amount, currency, extraction_confidence, parse_summary,
            duplicate_of, reference_number, filename, payment_status
       from documents
      where firm_id = $1
        and client_id = $2
        and id = $3
        and document_type in ('sales_invoice', 'issued_receipt')
        and parse_status = 'completed'
        and total_amount is not null
        and duplicate_of is null`,
    [firmId, clientId, documentId]
  );
  if (!docResult.rows.length) return ZERO_STATS();
  const document = docResult.rows[0];
  // RT-27 — a customer credit note has no bank line to match; the weighted
  // fallback proposes nothing for it (the LLM lane wakes the invoices it
  // reduces). Receipted on the stats so the rollup can tell it from a no-match.
  if (String(document.payment_status || '') === 'credit_note') {
    return { ...ZERO_STATS(), credit_note_skipped: true };
  }

  // 2. Load unreconciled money_in transactions for this client. Same
  //    JSONB shape as the receipt matcher uses for `contact` /
  //    `source_line` (those live on transactions.payload, not as
  //    columns) and aliases `transaction_date as date` so downstream
  //    reads work unchanged.
  // Candidate status filter is the SHARED carve-out (reconciliationLlmCore.js)
  // — admits standalone machine-explained lines so document evidence can
  // outrank them; the companion SELECT carries what isBankLineOnlyExplained
  // reads in the in-loop guard, keeping SQL and JS in lock-step.
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
        and money_in > 0
        and (money_out is null or money_out = 0)
        and ${CANDIDATE_TX_STATUS_SQL}`,
    [firmId, clientId]
  );

  // 3. Load existing matches for this document — used for suppression
  //    + partial-completion math. Scoped to the specific document so
  //    the read is small. Both AR types (sales_invoice, issued_receipt)
  //    write matches with matched_object_type='sales_invoice' so
  //    cross-type partial-completion works. The unified type keeps the
  //    FE's reconciliation lookup simple.
  const existingResult = await client.query(
    `select id, bank_transaction_id, matched_object_type, matched_object_id,
            status, match_amount, match_confidence, payload
       from reconciliation_matches
      where firm_id = $1
        and client_id = $2
        and matched_object_type = 'sales_invoice'
        and matched_object_id = $3`,
    [firmId, clientId, documentId]
  );

  // 4. Generate candidates (pure).
  const {
    candidates,
    skipped_rejected,
    skipped_confirmed,
    skipped_auto_matched
  } = generateSalesInvoiceCandidates({
    transactions: txResult.rows,
    document,
    existingMatches: existingResult.rows,
    appliedCredits: await loadAppliedCreditsForInvoice({ client, firmId, documentId })
  });

  const stats = ZERO_STATS();
  stats.skipped_rejected = skipped_rejected;
  stats.skipped_confirmed = skipped_confirmed;
  stats.skipped_auto_matched = skipped_auto_matched;

  // 4b. LLM triage for low-confidence candidates (Phase 5).
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
      console.error('[salesInvoiceReconciliation] triage failed, falling through to suggested', {
        documentId,
        error: error?.message || String(error)
      });
    }
  }

  // 5. Persist. Writes status based on triage result.
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
    // Client-scoped auto-match canary (RECONCILIATION_AUTO_MATCH_CLIENTS): honor the
    // same allowlist on this legacy path. No-op without an allowlist; otherwise a
    // non-allowlisted client is held to 'suggested' (surfaced, never hidden).
    const writeStatus = (triage?.finalState === 'auto_matched' && entityAlignment.verdict !== 'mismatch' && clientAllowedToAutoMatch(clientId, undefined, { configSnapshot })) ? 'auto_matched' : 'suggested';
    const writeScore = triage?.upgradedScore ?? candidate.score;
    const payload = {
      source: 'sales_invoice_reconciliation',
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
        SALES_INVOICE_OBJECT_TYPE,
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
            match_kind: 'sales_invoice',
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
            matchedObjectType: SALES_INVOICE_OBJECT_TYPE,
            documentId: document.id
          });
          await applyDocumentPaymentStatusAfterMatch({
            client,
            firmId,
            matchId,
            matchedObjectType: SALES_INVOICE_OBJECT_TYPE,
            documentId: document.id
          });
        } catch (error) {
          console.error('[salesInvoiceReconciliation] auto-match cascade failed', {
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
            match_kind: 'sales_invoice',
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
          matchedObjectType: SALES_INVOICE_OBJECT_TYPE,
          documentId: document.id
        });
        await applyDocumentPaymentStatusAfterMatch({
          client,
          firmId,
          matchId,
          matchedObjectType: SALES_INVOICE_OBJECT_TYPE,
          documentId: document.id
        });
      } catch (error) {
        console.error('[salesInvoiceReconciliation] upgrade cascade failed', {
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
  }

  return stats;
};

// RT-27 — the credit-note total already applied to this invoice (persisted
// applications only). Static SQL; a missing table (a pre-152 database) reads
// as zero rather than failing the fallback matcher.
const loadAppliedCreditsForInvoice = async ({ client, firmId, documentId }) => {
  try {
    const result = await client.query(
      `select coalesce(sum(amount), 0) as applied
         from document_credit_applications
        where firm_id = $1 and invoice_document_id = $2 and status = 'applied'`,
      [firmId, documentId]
    );
    const applied = Number(result.rows?.[0]?.applied || 0);
    return Number.isFinite(applied) ? applied : 0;
  } catch (error) {
    if (error?.code === '42P01') return 0;
    throw error;
  }
};

export const __SALES_INVOICE_OBJECT_TYPE = SALES_INVOICE_OBJECT_TYPE;
export const __safeNumber = safeNumber;
