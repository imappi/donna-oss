// Manual link-to-transaction picker — pure helpers.
//
// Consumes the firm snapshot's `documents`, `transactions`, and
// `reconciliationMatches` arrays plus the user's filter input, and
// produces a ranked candidate list the picker modal renders.
//
// Eligibility rules (mirror the backend's CREATE writer):
//   - Direction is determined by document type: receipts and supplier
//     bills pay OUT (money_out > 0), sales invoices receive IN
//     (money_in > 0). PR 8 introduces the AR direction; receipts and
//     bills keep the legacy money_out filter.
//   - Reconciliation_status NOT in {reconciled, posted, auto_reconciled}
//     — those are already settled
//   - Currency matches the document's currency (cross-currency manual
//     link is out of scope for v1; same restriction as the matcher)
//   - No existing `confirmed` or `rejected` match for this (tx, doc)
//     pair — those need the PATCH endpoint, not POST
//
// Ranking signal (higher score → more likely match, listed first):
//   - amount delta (smaller = better)
//   - date delta (smaller = better)
//   - vendor / canonical pattern overlap (more = better)
//
// The picker shows ALL eligible txs (not just top N) so the firm can
// still find an outlier; ranking just orders them.

import { normalizeUnicodeSearchKey } from './unicodeInputNormalization.js';

const DAY_MS = 24 * 60 * 60 * 1000;

const safeString = (value) => (value == null ? '' : String(value));

const safeAmount = (value) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

// Direction depends on document type. Sales invoices and issued
// receipts both represent money_in (the firm is the seller / payee);
// expense receipts and supplier bills represent money_out. The picker
// reads the document's type to pick the right side of the transaction.
export const isMoneyInDocument = (doc) =>
  doc?.document_type === 'sales_invoice' || doc?.document_type === 'issued_receipt';

const txAmount = (tx, doc) => {
  if (isMoneyInDocument(doc)) {
    const inAmt = Number(tx?.money_in || 0);
    if (inAmt > 0) return inAmt;
    const amt = Number(tx?.amount || 0);
    return Number.isFinite(amt) && amt > 0 ? amt : 0;
  }
  const out = Number(tx?.money_out || 0);
  if (out > 0) return out;
  const amt = Number(tx?.amount || 0);
  return Number.isFinite(amt) && amt < 0 ? Math.abs(amt) : 0;
};

const txDateMs = (tx) => {
  const raw = tx?.transaction_date || tx?.date;
  if (!raw) return null;
  const ms = new Date(`${String(raw).slice(0, 10)}T00:00:00Z`).getTime();
  return Number.isFinite(ms) ? ms : null;
};

const docDateMs = (doc) => {
  const raw = doc?.document_date;
  if (!raw) return null;
  const ms = new Date(`${String(raw).slice(0, 10)}T00:00:00Z`).getTime();
  return Number.isFinite(ms) ? ms : null;
};

// Preserve the picker's established ASCII token policy while retaining Arabic
// letters in its presentation-only search key. Invalid keys stay null so bidi
// controls can never be stripped into an identifier match.
const normalize = (value) => {
  const key = normalizeUnicodeSearchKey(value);
  return key == null ? null : key.replace(/[^a-z0-9\p{Script=Arabic}]+/gu, ' ').trim();
};

const RESOLVED_STATUSES = new Set([
  'reconciled',
  'auto_reconciled',
  'posted'
]);

// Per the writer: matches with status='confirmed' or 'rejected' block a
// new manual link on that (tx, doc) pair.
const BLOCKING_MATCH_STATUSES = new Set(['confirmed', 'rejected']);

// Returns Set<tx_id> of transactions that already have a blocking
// match against THIS specific document. We can still show those txs
// for a DIFFERENT document — the block is per-pair, not per-tx.
const blockingPairsForDocument = (matches, documentId) => {
  const blocked = new Set();
  for (const match of matches || []) {
    if (!match || match.matched_object_id !== documentId) continue;
    if (BLOCKING_MATCH_STATUSES.has(match.status)) {
      blocked.add(match.bank_transaction_id);
    }
  }
  return blocked;
};

// Compute a [0..1] score where 1 = perfect candidate. Three weighted
// inputs: amount (45%), date (30%), vendor token overlap (25%). The
// caller filters by hard rules first; this only orders the survivors.
const scoreCandidate = ({ tx, doc }) => {
  const tAmt = txAmount(tx, doc);
  const dAmt = safeAmount(doc?.total_amount);

  // Amount: exact match → 1, within 5% → 0.85, within 25% → 0.5,
  // beyond → linearly decay to 0.
  let amountScore = 0;
  if (dAmt != null && tAmt > 0) {
    const diff = Math.abs(tAmt - dAmt);
    if (diff <= 0.01) amountScore = 1;
    else {
      const denom = Math.max(Math.abs(tAmt), Math.abs(dAmt));
      const pct = denom > 0 ? diff / denom : 1;
      if (pct <= 0.05) amountScore = 0.85;
      else if (pct <= 0.25) amountScore = 0.5;
      else amountScore = Math.max(0, 1 - pct);
    }
  }

  // Date: same day → 1, within 7d → 0.7, within 30d → 0.3, beyond → 0.
  let dateScore = 0;
  const tMs = txDateMs(tx);
  const dMs = docDateMs(doc);
  if (tMs != null && dMs != null) {
    const gapDays = Math.abs(tMs - dMs) / DAY_MS;
    if (gapDays === 0) dateScore = 1;
    else if (gapDays <= 7) dateScore = 0.7;
    else if (gapDays <= 30) dateScore = 0.3;
  }

  // Vendor token overlap: count shared tokens (length >= 3) between
  // the doc's vendor display and the tx's description/raw_description.
  let vendorScore = 0;
  // PR 8 — sales invoices flip counterparty to customer_name (the
  // firm IS the vendor on its own invoice; vendor_name is null).
  const counterparty = isMoneyInDocument(doc)
    ? doc?.customer_name
    : (doc?.vendor_name || doc?.parse_summary?.semantic?.merchant_display_name);
  const vendorNorm = normalize(counterparty);
  const txNorm = normalize(`${tx?.description || ''} ${tx?.raw_description || ''} ${tx?.contact || ''}`);
  if (vendorNorm && txNorm) {
    const vendorTokens = vendorNorm.split(' ').filter((t) => t.length >= 3);
    const matchedTokens = vendorTokens.filter((t) => txNorm.includes(t));
    if (vendorTokens.length) {
      vendorScore = matchedTokens.length / vendorTokens.length;
    }
  }

  return amountScore * 0.45 + dateScore * 0.30 + vendorScore * 0.25;
};

// Apply the user's free-text filter. Matches tx description /
// raw_description / amount string / date. Empty string → pass all.
const matchesQuery = (tx, query) => {
  const q = normalize(query);
  if (q == null) return false;
  if (!q) return true;
  const haystack = normalize(
    `${tx?.description || ''} ${tx?.raw_description || ''} ${tx?.contact || ''} ` +
    `${tx?.money_out || ''} ${tx?.transaction_date || ''}`
  );
  return haystack != null && haystack.includes(q);
};

// Build a list of hints surfaced per row. Categorical only — no PII
// concern because we're showing firm data to the firm. The hints
// let the firm see at a glance WHY this tx ranks high.
const hintsFor = ({ tx, doc }) => {
  const hints = [];
  const tAmt = txAmount(tx, doc);
  const dAmt = safeAmount(doc?.total_amount);
  if (dAmt != null && Math.abs(tAmt - dAmt) <= 0.01) {
    hints.push('amount_exact');
  } else if (dAmt != null && tAmt > 0) {
    const denom = Math.max(Math.abs(tAmt), Math.abs(dAmt));
    const pct = denom > 0 ? Math.abs(tAmt - dAmt) / denom : 1;
    if (pct <= 0.05) hints.push('amount_close');
  }

  const tMs = txDateMs(tx);
  const dMs = docDateMs(doc);
  if (tMs != null && dMs != null) {
    const gapDays = Math.round(Math.abs(tMs - dMs) / DAY_MS);
    if (gapDays === 0) hints.push('date_exact');
    else if (gapDays <= 7) hints.push('date_close');
  }

  // PR 8 — sales invoices flip counterparty to customer_name (the
  // firm IS the vendor on its own invoice; vendor_name is null).
  const counterparty = isMoneyInDocument(doc)
    ? doc?.customer_name
    : (doc?.vendor_name || doc?.parse_summary?.semantic?.merchant_display_name);
  const vendorNorm = normalize(counterparty);
  const txNorm = normalize(`${tx?.description || ''} ${tx?.raw_description || ''}`);
  if (vendorNorm && txNorm) {
    const vendorTokens = vendorNorm.split(' ').filter((t) => t.length >= 3);
    if (vendorTokens.some((t) => txNorm.includes(t))) {
      hints.push('vendor_overlap');
    }
  }

  return hints;
};

// Main entry. Returns an object the picker modal renders directly:
//   { document, candidates: [{ transaction, score, hints, blocked,
//                              blocked_reason }] }
//
// `candidates` is sorted descending by score. `blocked` rows still
// appear (so the firm sees why they can't pick them) but with the
// row visually disabled.
//
// PR 22 — `includeFiltered`: when true, additionally surface txs that
// fail the direction or resolved-status gates, tagged with
// `wrong_direction` / `already_resolved` warning chips. The modal
// uses this to power a "Show N more transactions" button at the
// bottom of the list — the firm-bug scenario was a real bill payment
// stored on the wrong side of the money_in/money_out split, which
// the strict picker silently hid. Backend accepts any direction so
// long as no confirmed/rejected match exists for the pair, so
// surfacing these is safe.
export const buildManualLinkPickerData = ({
  documentId,
  documents = [],
  transactions = [],
  reconciliationMatches = [],
  query = '',
  baseCurrency = '',
  includeFiltered = false
} = {}) => {
  const document = (documents || []).find((d) => d && d.id === documentId);
  if (!document) {
    return { document: null, candidates: [], additionalCandidateCount: 0 };
  }

  const blockedPairs = blockingPairsForDocument(reconciliationMatches, documentId);
  const docCurrency = safeString(document.currency).toUpperCase();
  const baseUpper = safeString(baseCurrency).toUpperCase();

  const arDocument = isMoneyInDocument(document);
  const strictCandidates = [];
  const filteredCandidates = [];
  // PR 21 — eligibility counters surface in the return so the modal
  // can render branch-specific empty states (vs. a single generic
  // "no candidates match" message that hides the real cause).
  let totalTransactions = 0;
  let directionEligible = 0;
  let notResolved = 0;
  // PR 22 — count of additional candidates the modal could surface
  // by toggling includeFiltered. Tracks query-matched txs that fail
  // direction or resolved gates. Drives the "Show N more" button.
  let additionalCandidateCount = 0;

  const buildCandidate = (tx, extraWarnings = []) => {
    const txCurrency = safeString(tx.currency).toUpperCase();
    let blocked = false;
    let blockedReason = null;
    const warnings = [...extraWarnings];
    if (blockedPairs.has(tx.id)) {
      blocked = true;
      blockedReason = 'prior_decision';
    } else if (docCurrency && txCurrency && docCurrency !== txCurrency) {
      warnings.push('currency_mismatch');
    } else if (!docCurrency && baseUpper && txCurrency && txCurrency !== baseUpper) {
      warnings.push('currency_mismatch');
    }
    return {
      transaction: tx,
      score: scoreCandidate({ tx, doc: document }),
      hints: hintsFor({ tx, doc: document }),
      blocked,
      blocked_reason: blockedReason,
      warnings
    };
  };

  for (const tx of (transactions || [])) {
    if (!tx || !tx.id) continue;
    totalTransactions += 1;

    // Hard rule 1: direction matches the document's side.
    // Sales invoices receive money_in; receipts/bills pay money_out.
    let passesDirection;
    if (arDocument) {
      // Don't surface mixed-direction txs (rare but possible imports
      // with both sides populated) — the AR side strictly excludes
      // any money_out activity.
      passesDirection = Number(tx.money_in) > 0 && !(Number(tx.money_out) > 0);
    } else {
      passesDirection = Number(tx.money_out) > 0;
    }

    if (!passesDirection) {
      // Direction gate failed. If includeFiltered + matches query,
      // tag with wrong_direction warning and add to filtered bucket.
      if (matchesQuery(tx, query)) {
        additionalCandidateCount += 1;
        if (includeFiltered) {
          filteredCandidates.push(buildCandidate(tx, ['wrong_direction']));
        }
      }
      continue;
    }
    directionEligible += 1;

    // Hard rule 2: not already resolved.
    if (RESOLVED_STATUSES.has(tx.reconciliation_status)) {
      if (matchesQuery(tx, query)) {
        additionalCandidateCount += 1;
        if (includeFiltered) {
          filteredCandidates.push(buildCandidate(tx, ['already_resolved']));
        }
      }
      continue;
    }
    notResolved += 1;

    // Free-text query filter applies to the visible list, not the
    // hard-eligibility rules.
    if (!matchesQuery(tx, query)) continue;

    // Currency check — PR 20 demotes cross-currency from a hard
    // block to a warning. Manual link is an explicit firm decision;
    // FX-realised payments (GBP invoice paid in EUR after conversion)
    // are a real workflow the same-currency block was trapping. The
    // firm sees the "Different currency" chip and can still pick the
    // row. Only prior firm decisions (rejected/confirmed for this
    // pair) remain truly blocking.
    strictCandidates.push(buildCandidate(tx));
  }

  // Sort each tier independently by blocked-at-bottom then score.
  // Strict tier renders first, then filtered (so the firm sees the
  // strongest candidates up top regardless of the toggle state).
  const sortByBlockedThenScore = (a, b) => {
    if (a.blocked !== b.blocked) return a.blocked ? 1 : -1;
    return b.score - a.score;
  };
  strictCandidates.sort(sortByBlockedThenScore);
  filteredCandidates.sort(sortByBlockedThenScore);

  const candidates = includeFiltered
    ? [...strictCandidates, ...filteredCandidates]
    : strictCandidates;

  return {
    document,
    candidates,
    // PR 22 — count of additional candidates the modal could surface
    // by toggling includeFiltered. Counts query-matched txs that
    // failed the direction or resolved gates. The modal uses this
    // to decide whether to render the "Show N more" button.
    additionalCandidateCount,
    // PR 21 — funnel counters for branch-specific empty states.
    // Each value is the count remaining after applying the
    // corresponding filter. Direction = matched the doc's
    // money-in/out side AND was not mixed-direction. Resolved =
    // additionally not in a `reconciled`/`auto_reconciled`/`posted`
    // status. matchedQuery = additionally matched the free-text
    // query (= strictCandidates.length, NOT candidates.length when
    // includeFiltered is true — the funnel always measures the
    // strict path so empty-state copy stays meaningful).
    eligibility: {
      totalTransactions,
      directionEligible,
      notResolved,
      matchedQuery: strictCandidates.length
    }
  };
};

// Returns Set<doc_id> of documents that already have a blocking match
// against THIS specific transaction. Symmetric inverse of
// blockingPairsForDocument — used by buildTransactionCandidatePickerData.
const blockingPairsForTransaction = (matches, transactionId) => {
  const blocked = new Set();
  for (const match of matches || []) {
    if (!match || match.bank_transaction_id !== transactionId) continue;
    if (BLOCKING_MATCH_STATUSES.has(match.status)) {
      blocked.add(match.matched_object_id);
    }
  }
  return blocked;
};

// Stage E — bank-feed candidate picker. Inverse of
// buildManualLinkPickerData: given a transactionId, find documents
// that could match. Uses the same scoring + hint helpers as the
// doc-side picker so a (tx, doc) pair ranks identically from either
// direction — the bank-feed strip on the IRS row reads the same
// signals as the picker would on the IRS receipt.
//
// Eligibility:
//   - Doc-direction matches the tx-direction (sales invoices and
//     issued receipts on money_in; supplier bills and receipts on
//     money_out).
//   - The (tx, doc) pair has no `confirmed` or `rejected` match
//     blocking it.
//   - Currency mismatch is demoted to a warning (not a hard block),
//     mirroring buildManualLinkPickerData's PR 20 behaviour.
//
// Returns:
//   {
//     transaction,
//     candidates: [{ document, score, hints, blocked,
//                    blocked_reason, warnings }]
//   }
//
// Candidates are sorted blocked-at-bottom then descending score.
// Callers typically filter to `!blocked && score > 0.15` and take
// the top N for display (the doc-side picker uses N=5).
export const buildTransactionCandidatePickerData = ({
  transactionId,
  documents = [],
  transactions = [],
  reconciliationMatches = []
} = {}) => {
  const transaction = (transactions || []).find((t) => t && t.id === transactionId);
  if (!transaction) {
    return { transaction: null, candidates: [] };
  }

  const txCurrency = safeString(transaction.currency).toUpperCase();
  const txIsMoneyIn = Number(transaction.money_in) > 0;
  const blockedDocIds = blockingPairsForTransaction(reconciliationMatches, transactionId);

  const candidates = [];
  for (const doc of (documents || [])) {
    if (!doc || !doc.id) continue;

    // Hard rule 1: doc direction matches tx side. Sales invoices and
    // issued receipts settle money_in for the firm; supplier bills
    // and expense receipts settle money_out.
    const docIsAr = isMoneyInDocument(doc);
    const passesDirection = txIsMoneyIn ? docIsAr : !docIsAr;
    if (!passesDirection) continue;

    const warnings = [];
    const docCurrency = safeString(doc.currency).toUpperCase();
    if (txCurrency && docCurrency && txCurrency !== docCurrency) {
      warnings.push('currency_mismatch');
    }

    // Blocked by prior firm decision (confirmed or rejected match
    // already exists on this pair).
    let blocked = false;
    let blockedReason = null;
    if (blockedDocIds.has(doc.id)) {
      blocked = true;
      blockedReason = 'prior_decision';
    }

    candidates.push({
      document: doc,
      score: scoreCandidate({ tx: transaction, doc }),
      hints: hintsFor({ tx: transaction, doc }),
      blocked,
      blocked_reason: blockedReason,
      warnings
    });
  }

  candidates.sort((a, b) => {
    if (a.blocked !== b.blocked) return a.blocked ? 1 : -1;
    return b.score - a.score;
  });

  return { transaction, candidates };
};

// Convenience helper for tests + the picker modal: short
// human-readable blocked reason. Categorical labels only.
export const blockedReasonLabel = (reason) => {
  switch (reason) {
    case 'prior_decision': return 'Already decided';
    case 'currency_mismatch': return 'Different currency';
    default: return null;
  }
};

// PR 20 — non-blocking warnings shown alongside hints. The row stays
// selectable; the chip signals the firm should look twice before
// confirming.
// PR 22 — `wrong_direction` and `already_resolved` join the warning
// vocabulary for txs surfaced by the "Show more" toggle.
export const warningLabel = (warning) => {
  switch (warning) {
    case 'currency_mismatch': return 'Different currency';
    case 'wrong_direction': return 'Wrong direction';
    case 'already_resolved': return 'Already reconciled';
    default: return null;
  }
};

// Convenience helper: short human-readable hint labels.
export const hintLabel = (hint) => {
  switch (hint) {
    case 'amount_exact': return 'Exact amount';
    case 'amount_close': return 'Close amount';
    case 'date_exact': return 'Same day';
    case 'date_close': return 'Close date';
    case 'vendor_overlap': return 'Vendor match';
    default: return null;
  }
};
