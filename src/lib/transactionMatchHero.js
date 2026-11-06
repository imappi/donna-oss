// Transaction-side match-hero helpers — Stage B of the bank-feed ↔
// documents parity stack.
//
// When a bank transaction has a confirmed/auto/suggested match to a
// document, the TransactionArtifact gets a compact summary above the chat:
// persisted status, key extracted fields, reasoning, and navigation to the
// document artifact that owns the full file review.
//
// These helpers exist so the JSX glue stays untestable but the
// derivations — title, field rows, suppression — are pinned by unit
// tests. Mirrors the split between transactionChat.js (pure helpers)
// and transaction-artifact.jsx (component).
//
// Vocabulary stays consistent with documentsInbox.js's transaction
// status chips so the hero title's status word matches the row chip
// the firm clicked.

import { vendorDisplayFor } from './documentsInbox.js';
import { formatAccountingAmount, formatAccountingDate } from '../i18n/localeFormatting.js';

const localizedLabel = (formatMessage, id, fallback) => (
  typeof formatMessage === 'function'
    ? formatMessage({ id, defaultMessage: fallback })
    : fallback
);

// A match is "meaningful" when it's a positive document-side match
// the firm should see surfaced. Rejected and stale (other-status)
// rows aren't worth surfacing; they'd be visual noise on the artifact.
const MEANINGFUL_MATCH_STATUSES = new Set(['confirmed', 'auto_matched', 'suggested']);

export const isMeaningfulMatch = (match) =>
  !!match && MEANINGFUL_MATCH_STATUSES.has(String(match.status || '').toLowerCase());

// Pick the match the artifact should render for one transaction.
// Status-ranked — confirmed > auto_matched > suggested — so a firm
// decision always outranks pipeline output, and rejected/stale rows
// never win. For artifact call sites that select per click instead of
// maintaining donna-financials-panel's precomputed per-tx map.
const MATCH_STATUS_RANK = Object.freeze({
  confirmed: 3,
  auto_matched: 2,
  suggested: 1
});

export const bestMatchForTransaction = (reconciliationMatches, transactionId) => {
  if (!transactionId) return null;
  let best = null;
  let bestRank = 0;
  for (const match of reconciliationMatches || []) {
    if (!match || match.bank_transaction_id !== transactionId) continue;
    const rank = MATCH_STATUS_RANK[String(match.status || '').toLowerCase()] || 0;
    if (rank > bestRank) {
      best = match;
      bestRank = rank;
    }
  }
  return best;
};

// Status → human label used in the hero title. Mirrors the chip
// vocabulary but reads as a participle ("auto-confirmed", "confirmed",
// "suggested") so the title flows: "Matched to <doc> · auto-confirmed".
const STATUS_TITLE_WORD = Object.freeze({
  confirmed: 'confirmed',
  auto_matched: 'auto-confirmed',
  suggested: 'suggested'
});

export const matchHeroTitle = (match, matchedDocument) => {
  if (!isMeaningfulMatch(match) || !matchedDocument) return null;
  const filename = matchedDocument.filename
    || matchedDocument.original_filename
    || matchedDocument.title
    || 'matched document';
  const statusWord = STATUS_TITLE_WORD[String(match.status).toLowerCase()] || 'matched';
  return `Matched to ${filename} · ${statusWord}`;
};

// Doc-type label vocabulary (parity with the matchHero — keeps the
// hero readable without leaking the snake_case enum). Falls back to
// title-casing the raw enum so a future doc type doesn't read as a
// blank cell.
const DOC_TYPE_LABEL = Object.freeze({
  receipt: ['transaction.match.documentType.receipt', 'Receipt'],
  supplier_bill: ['transaction.match.documentType.bill', 'Bill'],
  sales_invoice: ['transaction.match.documentType.salesInvoice', 'Sales invoice'],
  issued_receipt: ['transaction.match.documentType.issuedReceipt', 'Issued receipt'],
  payment_confirmation: ['transaction.match.documentType.paymentConfirmation', 'Payment confirmation'],
  payment_account_statement: ['transaction.match.documentType.accountStatement', 'Account statement'],
  contract: ['transaction.match.documentType.contract', 'Contract'],
  bank_statement: ['transaction.match.documentType.bankStatement', 'Bank statement']
});

const titleCaseSnake = (input) => String(input || '')
  .split('_')
  .filter(Boolean)
  .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
  .join(' ');

export const docTypeLabel = (docType, formatMessage = null) => {
  if (!docType) return '';
  const known = DOC_TYPE_LABEL[String(docType).toLowerCase()];
  return known ? localizedLabel(formatMessage, known[0], known[1]) : titleCaseSnake(docType);
};

// Format amount as "USD 3,683.67". Mirrors formatTxAmount's currency
// placement so the hero's amount field reads consistently with the
// transaction row. Returns null for unparseable / missing input so the
// field row can be dropped instead of rendering "—".
const formatMoney = (amount, currency, amountFormatter = formatAccountingAmount) => {
  // null / undefined / '' are "no amount", not zero — Number(null) is 0,
  // which would render a misleading "0" row instead of dropping it.
  if (amount === null || amount === undefined || amount === '') return null;
  const n = Number(amount);
  if (!Number.isFinite(n)) return null;
  return amountFormatter(Math.abs(n), {
    currency: String(currency || '').trim() || null,
    minimumFractionDigits: Math.abs(n) % 1 ? 2 : 0,
    maximumFractionDigits: 2,
    negativeStyle: 'minus'
  });
};

// Format a date that may arrive as a pg Date instance OR an ISO
// string. Same shape as matchExplanation's fix in #197 — coerce
// through new Date() and validate before formatting so a bad input
// drops the row rather than printing "Invalid Date".
const formatDate = (input, dateFormatter = formatAccountingDate) => {
  if (!input) return null;
  const parsed = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(parsed.getTime())) return null;
  return dateFormatter(input instanceof Date ? input : String(input).slice(0, 10), {
    day: '2-digit', month: 'short', year: 'numeric'
  });
};

// Magnitude of the bank line, defensively parsed (money_* can arrive as
// the string "0.00", which `x || y` would treat as truthy). Returns null
// when there's no usable amount.
const bankLineAmount = (transaction) => {
  if (!transaction) return null;
  const inAmt = Math.abs(Number(transaction.money_in));
  if (Number.isFinite(inAmt) && inAmt) return inAmt;
  const outAmt = Math.abs(Number(transaction.money_out));
  if (Number.isFinite(outAmt) && outAmt) return outAmt;
  const amt = Math.abs(Number(transaction.amount));
  return Number.isFinite(amt) && amt ? amt : null;
};

// Counterparty from the bank line itself — used when the matched document
// has no extracted vendor/customer (a sparsely-parsed payout settlement).
// Strips a leading rail token and a trailing reference number so
// "SHOPIFY INC ACH 889512" reads as "SHOPIFY INC".
const bankLineCounterparty = (transaction) => {
  const raw = String(
    transaction?.counterparty
    || transaction?.contact
    || transaction?.description
    || transaction?.raw_description
    || ''
  ).trim();
  if (!raw) return null;
  const cleaned = raw
    .replace(/^(card|wire|debit|credit|payment|transfer|sale)\s+/i, '')
    .split(/[|,:(]/)[0]
    .replace(/\s+\d{4,}\s*$/, '')
    .replace(/\s+(ach|eft|wire)\s*$/i, '')
    .trim();
  return cleaned || null;
};

// Extracted-field rows for the hero. Order is fixed: counterparty,
// type, amount, date. Rows with no value drop out so a sparse
// payment_confirmation doc (no extracted vendor) doesn't render an
// empty "Vendor: —" line.
//
// `match.match_amount` is preferred over the raw doc total when both
// exist — it's the amount that actually settled the bank tx and
// matches the chip on the row. When the matched document itself was
// extracted without a counterparty / amount / currency (a reply-evidence
// settlement report), the bank `transaction` — the same economic event —
// is the reliable fallback for all three rather than surfacing
// "Unknown vendor" / a dropped amount.
export const matchHeroFields = (
  matchedDocument,
  match = null,
  transaction = null,
  { formatAmount = formatAccountingAmount, formatDate: formatDateValue = formatAccountingDate, formatMessage = null } = {}
) => {
  if (!matchedDocument) {
    // Degraded mode — the match receipt exists but the document object
    // isn't resolvable in this view (stale matched_object_id, a doc
    // dropped from the client-side collection). Render what the receipt
    // and the bank line persist instead of nothing: a meaningful match
    // must never present as a blank summary.
    const fields = [];
    const counterparty = bankLineCounterparty(transaction);
    if (counterparty) {
      fields.push({
        kind: 'counterparty',
        label: localizedLabel(formatMessage, 'transaction.match.field.counterparty', 'Counterparty'),
        value: counterparty
      });
    }
    const matchAmt = Number(match?.match_amount);
    const amount = (Number.isFinite(matchAmt) && matchAmt !== 0 ? matchAmt : null)
      ?? bankLineAmount(transaction);
    const currency = match?.match_currency
      || transaction?.currency
      || transaction?.account_currency
      || '';
    const amountLabel = formatMoney(amount, currency, formatAmount);
    if (amountLabel) {
      fields.push({ kind: 'amount', label: localizedLabel(formatMessage, 'transaction.match.field.amount', 'Amount'), value: amountLabel });
    }
    return fields;
  }
  const fields = [];
  let counterparty = vendorDisplayFor(matchedDocument);
  // vendorDisplayFor returns an "Unknown …" placeholder when the doc had no
  // extracted party — prefer the bank line's counterparty in that case.
  if ((!counterparty || /^unknown\b/i.test(counterparty))) {
    const fromBank = bankLineCounterparty(transaction);
    if (fromBank) counterparty = fromBank;
  }
  if (counterparty) {
    fields.push({
      kind: 'counterparty',
      label: localizedLabel(formatMessage, 'transaction.match.field.counterparty', 'Counterparty'),
      value: counterparty
    });
  }
  const typeLabel = docTypeLabel(matchedDocument.document_type, formatMessage);
  if (typeLabel) {
    fields.push({ kind: 'type', label: localizedLabel(formatMessage, 'transaction.match.field.type', 'Type'), value: typeLabel });
  }
  // A match_amount of 0 is the absence of a settled amount, not a real
  // zero — fall through to the doc total, then the bank line.
  const matchAmt = Number(match?.match_amount);
  const amount = (Number.isFinite(matchAmt) && matchAmt !== 0 ? matchAmt : null)
    ?? (matchedDocument.total_amount != null ? matchedDocument.total_amount : null)
    ?? bankLineAmount(transaction);
  const currency = matchedDocument.currency
    || matchedDocument.total_currency
    || match?.match_currency
    || transaction?.currency
    || transaction?.account_currency
    || '';
  const amountLabel = formatMoney(amount, currency, formatAmount);
  if (amountLabel) {
    fields.push({ kind: 'amount', label: localizedLabel(formatMessage, 'transaction.match.field.amount', 'Amount'), value: amountLabel });
  }
  const date = matchedDocument.document_date
    || matchedDocument.transaction_date
    || matchedDocument.issue_date;
  const dateLabel = formatDate(date, formatDateValue);
  if (dateLabel) {
    fields.push({ kind: 'date', label: localizedLabel(formatMessage, 'transaction.match.field.date', 'Date'), value: dateLabel });
  }
  return fields;
};

// Suppression guard for the proactive "Ask client" card and pill.
// When a meaningful match exists the categorization pipeline's
// "no matching vendor pattern — client confirmation recommended"
// verdict is wrong on its face, so we don't show the pre-built
// question. Server-side suppression is the cleaner fix, but the
// FE guard here is the small focused change that ships Stage B
// without re-architecting the categorization pipeline.
export const shouldSuppressProactiveAskClient = (match) => isMeaningfulMatch(match);

// Pull the matcher's own reasoning + hops out of the match so the hero
// can show WHY this document was linked, not just the conclusion. The
// LLM reconciliation matcher writes { reasoning, hops, confidence } onto
// `payload.match_reason` (reconciliationLlmCore.upsertMatchAndCascade);
// the `match_reason` text column carries the same sentence as a
// fallback. The weighted matcher writes neither a reasoning sentence nor
// hops, so this returns null for those and the hero's reasoning block
// drops out (the chat-side matchExplanation covers them).
//
// This is the load-bearing half of the Layer 3 fix: without it a
// "suggested" FX amount-coincidence match renders as confidently as a
// settled one — the conclusion with the thinking stripped off. With the
// reasoning + hops + confidence surfaced, a thin match is visibly thin.
export const matchHeroReasoning = (match) => {
  if (!match) return null;

  // The rich object lives at payload.match_reason; some in-memory shapes
  // (and the weighted matcher) put an object directly on match_reason.
  // The match_reason COLUMN, by contrast, is a plain text summary string.
  const reasonObject =
    (match.match_reason && typeof match.match_reason === 'object' && match.match_reason)
    || (match.payload
        && typeof match.payload === 'object'
        && match.payload.match_reason
        && typeof match.payload.match_reason === 'object'
        && match.payload.match_reason)
    || null;

  const reasoning =
    (reasonObject?.reasoning && String(reasonObject.reasoning).trim())
    || (typeof match.match_reason === 'string' ? match.match_reason.trim() : '')
    || (reasonObject?.summary && String(reasonObject.summary).trim())
    || '';

  const hops = Array.isArray(reasonObject?.hops)
    ? reasonObject.hops.map((h) => String(h).trim()).filter(Boolean)
    : [];

  const rawConfidence = Number(
    reasonObject?.confidence != null ? reasonObject.confidence : match.match_confidence
  );
  const confidence = Number.isFinite(rawConfidence)
    ? Math.min(Math.max(rawConfidence, 0), 1)
    : null;

  const unmatchableReason = reasonObject?.unmatchable_reason
    ? String(reasonObject.unmatchable_reason)
    : null;

  // Only surface the block when the matcher actually explained itself —
  // a reasoning sentence or at least one hop. Confidence alone doesn't
  // warrant a "why" block.
  if (!reasoning && hops.length === 0) return null;

  return { reasoning, hops, confidence, unmatchableReason };
};
