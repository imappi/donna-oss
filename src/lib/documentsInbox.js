// Documents inbox helpers — Receipts + Bills + Sales invoices.
//
// Pure helpers, mirrors src/lib/receiptReview.js. PR 6 of
// docs/invoice-receipt-parsing-plan.md extended what was a
// receipts-only inbox into a per-kind bucketed builder; PR 7 adds
// sales_invoice as the third kind (the AR side of the document-type
// round-trip). The status chips (parsing / failed / parsed-no-match
// / matched-suggested / matched-auto / matched-confirmed) stay shared
// across all three kinds; bill- and invoice-specific surfaces
// (due_date column, payment_status chip) read additional fields off
// the document row.
//
// For sales invoices the counterparty column reads `customer_name`
// instead of `vendor_name` — the firm IS the vendor on its own
// invoices, so its own name doesn't live on the documents row.
// `vendorDisplayFor` branches on `document_type` to handle this.
//
// Status priority (first match wins, so the user sees the most
// actionable label):
//   1. parse failed                             → 'failed'
//   2. parse pending / processing               → 'processing'
//   3. parse skipped (extractor unavailable…)   → 'skipped'
//   4. has reconciliation_match status=confirmed → 'matched_confirmed'
//   5. has reconciliation_match status=auto_matched → 'matched_auto'
//   6. has reconciliation_match status=suggested → 'matched_suggested'
//   7. parsed but no match row                  → 'parsed_no_match'
//
// "Matched" here means a `reconciliation_matches` row points at the
// document. Status 'rejected' is treated as no-match (a firm-rejected
// pair shouldn't show as matched on the document side).

// `issued_receipt` joined the inbox in PR 2 of the classification
// work. It's an AR document (the firm is the seller / payee) that
// reuses the sales_invoice extractor + matcher pipeline but carries
// receipt semantics (paid by construction, no due_date) — so
// counterparty rendering reads customer_name, not vendor_name.
const SUPPORTED_KINDS = Object.freeze(['receipt', 'supplier_bill', 'sales_invoice', 'issued_receipt', 'contract', 'payment_confirmation', 'bank_statement']);

// The inbox is lossless for every uploaded document. Older builds excluded
// bank statements on the assumption that they had a separate management
// surface; the mounted entity workspace never shipped that surface, leaving
// statement files impossible to find or delete after import. Statements are
// now a first-class inbox kind, while generic_document, statutory_record,
// unknown, and future types continue to land in the catch-all `other` bucket.
// Observed live: an Amex payment confirmation whose final type ended up
// generic_document was matched + paid in the books but invisible in the
// documents tab (41 uploads, tab counted 40). A doc the firm uploaded
// must never be unfindable because of its type.
export const INBOX_KINDS = Object.freeze([...SUPPORTED_KINDS, 'other']);

// Filename-only metadata extractor for payment_confirmation documents.
// The worker doesn't LLM-extract these — they're stored as evidence —
// so the inbox row would otherwise show empty date/amount/counterparty
// cells. The filenames follow the `YY-MM-DD_<Counterparty words>_<Amount>.ext`
// convention used by US-style AP exports (e.g. `25-06-16_IRS_Tax_Payment_3683.67.pdf`),
// which gives us enough to render a useful row without any extraction.
// Returns null fields if the filename doesn't match the convention.
export const parsePaymentConfirmationFilename = (filename = '') => {
  const m = String(filename).match(/^(\d{2})-(\d{2})-(\d{2})[_-](.+?)[_-](\d+\.\d{2})\.[a-z0-9]+$/i);
  if (!m) return { date: null, counterparty: null, amount: null };
  const [, yy, mm, dd, words, amt] = m;
  // Two-digit-year heuristic: 00-49 → 20YY, 50-99 → 19YY. Mirrors what
  // most US AP exports assume; revisit if we ever see filenames with
  // pre-2050 paper trails.
  const year = Number(yy) < 50 ? `20${yy}` : `19${yy}`;
  const counterparty = words
    .replace(/[_-]+/g, ' ')
    .trim()
    // Strip a trailing "Payment" / "Tax Payment" since it's a noun
    // that describes the document, not the payee. "IRS Tax Payment"
    // → "IRS", "Amex Payment" → "Amex".
    .replace(/\s+(tax\s+)?payment\s*$/i, '')
    .trim();
  return {
    date: `${year}-${mm}-${dd}`,
    counterparty: counterparty || null,
    amount: Number(amt)
  };
};

const MATCH_PRIORITY = Object.freeze({
  confirmed: 'matched_confirmed',
  auto_matched: 'matched_auto',
  suggested: 'matched_suggested'
});

const STATUS_CHIP = Object.freeze({
  failed: { label: 'Parse failed', tone: 'alert' },
  processing: { label: 'Processing', tone: 'amber' },
  skipped: { label: 'Skipped', tone: 'muted' },
  matched_confirmed: { label: 'Matched · confirmed', tone: 'ok' },
  matched_auto: { label: 'Matched · auto', tone: 'ok' },
  matched_suggested: { label: 'Matched · suggested', tone: 'amber' },
  statement_imported: { label: 'Imported', tone: 'muted' },
  parsed_no_match: { label: 'No match', tone: 'muted' },
  // Doc-first terminal drain (docs/donna-doc-first-terminal-drain-plan.md):
  // a parsed doc with no bank line is not allowed to REST as
  // parsed_no_match — it reaches one of the two terminals.
  //   explained_no_line — the persisted no-line disposition verdict is
  //     'auto_explain': settled outside the visible bank feed (terminal 1).
  //     The doc stays matcher-eligible; a late statement line upgrades the
  //     chip to matched_* via the normal match priority above.
  //   awaiting_owner — an OPEN doc-anchored client_evidence_request exists
  //     ("how was this paid?" / a statement request): the ball is with the
  //     client (terminal 2).
  explained_no_line: { label: 'Explained', tone: 'ok' },
  awaiting_owner: { label: 'With the client', tone: 'amber' },
  // RT-10 (F-13): duplicates are their own resting states, never "No match".
  //   duplicate_pending   — a period-overlap statement whose replace-or-keep
  //     decision the writer routed to the OWNER (terminal 2); the firm
  //     resolver is the executor.
  //   duplicate_collapsed — a byte-identical re-upload auto-collapsed onto the
  //     earlier upload (or a failed upload superseded by a later one): done.
  duplicate_pending: { label: 'Overlap · with the client', tone: 'amber' },
  duplicate_collapsed: { label: 'Duplicate upload', tone: 'muted' }
});

export const RECEIPT_STATUSES = Object.freeze(Object.keys(STATUS_CHIP));

// Payment-status chip (bill-prominent, but the helper works for any
// document row). Surfaced on the bills sub-table per Q5 of the PR 6
// brief. The vocabulary mirrors `PAYMENT_STATUS_VALUES` in the
// extractors (`server/donna/{receipt,supplierBill,salesInvoice}.js`).
// Issue #95 added 'void' and 'credit_note' so the AR/AP aging
// dashboards can exclude cancelled / reversed documents from
// overdue buckets. Both render muted — they're informational, not
// action-requiring (unlike 'unpaid' / 'partial' which use amber to
// draw attention).
const PAYMENT_STATUS_CHIP = Object.freeze({
  paid: { label: 'Paid', tone: 'ok' },
  unpaid: { label: 'Unpaid', tone: 'amber' },
  partial: { label: 'Partial', tone: 'amber' },
  unknown: { label: 'Unknown', tone: 'muted' },
  void: { label: 'Void', tone: 'muted' },
  credit_note: { label: 'Credit note', tone: 'muted' }
});

export const paymentStatusChip = (status) =>
  PAYMENT_STATUS_CHIP[String(status || '').toLowerCase()] || PAYMENT_STATUS_CHIP.unknown;

const safeString = (value) => (value == null ? '' : String(value));

// Counterparty display: which column the helper reads depends on the
// document kind, because sales invoices flip the direction:
//   - receipts + supplier bills: read `vendor_name` (the supplier).
//   - sales invoices: read `customer_name` (the buyer). The firm IS
//     the vendor on its own invoices, so its own name never sits in
//     `documents.vendor_name`. PR 7 brief invariant 4.
// The "Unknown" fallback wording flips with the column — "Unknown
// customer" for sales invoices, "Unknown vendor" otherwise. Receipts
// also accept the classifier's `merchant_display_name` as a secondary
// fallback (PR 4 / classifier path); bills and invoices don't get a
// classifier in v1 so that fallback is a no-op for them.
export const vendorDisplayFor = (doc) => {
  if (doc?.document_type === 'sales_invoice' || doc?.document_type === 'issued_receipt') {
    const customer = safeString(doc?.customer_name).trim();
    if (customer) return customer;
    return 'Unknown customer';
  }
  if (doc?.document_type === 'contract') {
    // Contracts can be either direction. Inspect parse_summary
    // .counterparty_role to know which column the extractor populated.
    // vendor_name for vendor-direction contracts (firm consumes);
    // customer_name for customer-direction contracts (firm provides).
    const role = doc?.parse_summary?.counterparty_role;
    if (role === 'customer') {
      const customer = safeString(doc?.customer_name).trim();
      if (customer) return customer;
      return 'Unknown customer';
    }
    const vendor = safeString(doc?.vendor_name).trim();
    if (vendor) return vendor;
    return 'Unknown counterparty';
  }
  if (doc?.document_type === 'payment_confirmation') {
    // Payment-confirmation rows have no extracted vendor_name — the
    // worker skips LLM extraction entirely. Pull the counterparty
    // from the filename convention instead. Falls back to a generic
    // label if the filename doesn't match (e.g. user-renamed file).
    const fromFilename = parsePaymentConfirmationFilename(doc?.filename).counterparty;
    if (fromFilename) return fromFilename;
    return 'Payment confirmation';
  }
  const direct = safeString(doc?.vendor_name).trim();
  if (direct) return direct;
  const semantic = doc?.parse_summary?.semantic;
  const merchant = safeString(semantic?.merchant_display_name).trim();
  if (merchant) return merchant;
  return 'Unknown vendor';
};

// Bank-feed match-chip sub-label: the matched document's EXTRACTED
// counterparty, falling back to a cleaned filename slug only when
// extraction produced nothing. The filename slug used to be the only
// source — the Honeybee re-upload rendered "Land Lease" / "Bank Fee 25"
// on the feed next to document rows that carried "Sonoran Land
// Holdings" / "First Horizon Bank". The model already read the doc;
// the chip should say what it read.
export const matchedDocumentVendorLabel = (doc, { maxLength = 24 } = {}) => {
  if (!doc) return null;
  const display = vendorDisplayFor(doc);
  if (display && !/^Unknown /i.test(display) && display !== 'Payment confirmation') {
    return display.slice(0, maxLength);
  }
  const filename = safeString(doc.filename);
  if (!filename) return null;
  const slug = filename
    .replace(/\.[^.]+$/, '')
    .replace(/^\d{2}[-_]\d{2}[-_]\d{2}[-_ ]*/, '')
    .replace(/[-_ ]\d+(\.\d{2})?$/, '')
    .replace(/[_-]/g, ' ')
    .trim()
    .slice(0, maxLength);
  return slug || null;
};

export const classifierKindFor = (doc) => {
  const kind = safeString(doc?.parse_summary?.semantic?.expense_kind).trim();
  if (!kind || kind === 'unknown') return null;
  return kind;
};

const titleCase = (kind = '') =>
  String(kind)
    .split('_')
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');

export const classifierKindLabel = (kind) => (kind ? titleCase(kind) : '');

// PR 8 (Q5 option B) — widen the document-match predicate to accept
// the existing document-type-shaped strings the writer paths use.
// receiptReconciliation.js writes 'receipt', the AR matcher writes
// 'sales_invoice', and firmDb.createManualReconciliationMatchInDb
// writes the document's own document_type ('receipt' / 'supplier_bill'
// / 'sales_invoice') OR falls back to 'document' when the type is
// null. Transfer-side rows still don't qualify as document matches.
const DOCUMENT_MATCH_TYPES = new Set([
  'document',
  'receipt',
  'supplier_bill',
  'sales_invoice',
  'payment_account_statement',
  'payment_confirmation'
]);

const isDocumentMatch = (match, documentId) => {
  if (!match || match.matched_object_id !== documentId) return false;
  if (!DOCUMENT_MATCH_TYPES.has(match.matched_object_type)) return false;
  return true;
};

// PR 8 — settled-amount computation. Computed on the fly from the
// reconciliation_matches array (no parse_summary cache, per Q8). For a
// sales_invoice in 'partial' state the FE renders
// "Settled: EUR 2,500 / 5,000" below the chip; the row carries both
// the raw number AND the formatted string so the panel doesn't have
// to repeat the math.
const SETTLED_STATUSES = new Set(['confirmed', 'auto_matched']);

const computeSettledAmount = (doc, reconciliationMatches = []) => {
  if (!doc?.id) return 0;
  const matches = Array.isArray(reconciliationMatches) ? reconciliationMatches : [];
  let total = 0;
  for (const match of matches) {
    if (!isDocumentMatch(match, doc.id)) continue;
    if (!SETTLED_STATUSES.has(match.status)) continue;
    const amt = Number(match.match_amount || 0);
    if (Number.isFinite(amt)) total += amt;
  }
  // Round to 2dp so floating-point sums of cents render cleanly.
  return Math.round(total * 100) / 100;
};

// PR 9 — cross-matcher competition surface. Receipt and bill matchers
// coexist in the same direction (both scan money_out transactions and
// may both propose against the same bank tx). When that happens the
// firm needs an obvious signal in the review UI that another document
// type is also pointing at this transaction. The signal is computed
// from the snapshot (no matcher-side coordination at write-time —
// Q1 confirmed) by looking at OTHER same-tx match rows whose
// document type differs from this row's.
//
// Returns the set of document_types competing with `match` on the
// same bank_transaction_id, EXCLUDING the row's own type. Empty set
// means no cross-matcher competition. Only `suggested` /
// `auto_matched` / `confirmed` rows count as competitors — rejected
// rows are dead, and a same-type row isn't "cross-matcher" by
// definition.
const COMPETITION_STATUSES = new Set(['suggested', 'auto_matched', 'confirmed']);

export const competingDocumentTypesFor = (match, reconciliationMatches = []) => {
  const empty = new Set();
  if (!match?.bank_transaction_id || !match?.matched_object_type) return empty;
  if (!DOCUMENT_MATCH_TYPES.has(match.matched_object_type)) return empty;
  const matches = Array.isArray(reconciliationMatches) ? reconciliationMatches : [];
  const result = new Set();
  for (const other of matches) {
    if (!other || other === match) continue;
    if (other.bank_transaction_id !== match.bank_transaction_id) continue;
    if (!DOCUMENT_MATCH_TYPES.has(other.matched_object_type)) continue;
    if (other.matched_object_type === match.matched_object_type) continue;
    if (!COMPETITION_STATUSES.has(other.status)) continue;
    result.add(other.matched_object_type);
  }
  return result;
};

// Returns the best-matched reconciliation row for the document, or null.
// "Best" here means: confirmed > auto_matched > suggested > (anything
// else doesn't count). Rejected/other statuses fall through to null
// (the document presents as "no match" rather than "matched · rejected"
// — rejected is a transaction-side concept).
export const matchStateFor = (doc, reconciliationMatches = []) => {
  if (!doc?.id) return { match: null, status: null };
  const matches = Array.isArray(reconciliationMatches) ? reconciliationMatches : [];
  const relevant = matches.filter((match) => isDocumentMatch(match, doc.id));
  if (!relevant.length) return { match: null, status: null };
  for (const status of ['confirmed', 'auto_matched', 'suggested']) {
    const found = relevant.find((m) => m.status === status);
    if (found) return { match: found, status: MATCH_PRIORITY[status] };
  }
  return { match: null, status: null };
};

// The persisted no-line disposition verdict for a document, or null.
// Written by the doc-first terminal drain (Slice 2) as a
// `documents.payload.no_line_disposition` merge. Snapshot docs are
// FLATTENED payloads (firmDb rowToDocumentPayload spreads row.payload to
// the top level), so the verdict reads as `doc.no_line_disposition`; raw
// DB rows still carry it under `doc.payload`. Render the persisted
// verdict, not the legacy layer (CLAUDE.md).
export const noLineDispositionFor = (doc) => {
  const holder = (doc?.no_line_disposition && typeof doc.no_line_disposition === 'object')
    ? doc.no_line_disposition
    : (doc?.payload?.no_line_disposition && typeof doc.payload.no_line_disposition === 'object')
      ? doc.payload.no_line_disposition
      : null;
  const disposition = holder ? String(holder.disposition || '').trim().toLowerCase() : '';
  return disposition || null;
};

// A completed scoped matching assessment is not proof of recognition, payment
// or reconciliation. In particular, a cash-paid source can lack a bank line.
export const hasScopedNoSettlementAssessment = (doc) =>
  doc?.convergence_reason === 'no_settlement_in_scope'
  || doc?.payload?.convergence_reason === 'no_settlement_in_scope'
  || noLineDispositionFor(doc) === 'no_settlement';

// The client_evidence_requests.status values that mean an owner ask is
// still OUTSTANDING. LOCK-STEP with OPEN_OWNER_ASK_STATUSES in
// server/donna/reconcileConvergenceState.js (the server side can't be
// imported from the FE bundle; the SQL hanging metric mirrors the same
// list) — if one changes, change all three. F8: 'replied' is NOT
// outstanding-on-owner — the owner answered; an unprocessed reply is
// firm/system-side work, so a replied doc-ask row surfaces as a violation
// ('answered, processing'), never as awaiting_owner.
export const OPEN_DOC_ASK_STATUSES = Object.freeze(['draft', 'open']);

// Set of document ids with an outstanding doc-anchored owner ask. A
// doc-first ask carries its anchor in request_payload.document_id
// (client_evidence_requests.transaction_id is a bank-line anchor and
// stays null for these).
export const openOwnerAskDocIdsFrom = (clientEvidenceRequests = []) => {
  const ids = new Set();
  for (const req of Array.isArray(clientEvidenceRequests) ? clientEvidenceRequests : []) {
    const status = String(req?.status || '').trim().toLowerCase();
    if (!OPEN_DOC_ASK_STATUSES.includes(status)) continue;
    const docId = req?.request_payload?.document_id || req?.requestPayload?.document_id;
    if (docId) ids.add(docId);
  }
  return ids;
};

// The terminal fork for a parsed doc with NO bank line (two-terminal-states,
// CLAUDE.md FIRST principle). An open owner ask outranks the auto_explain
// verdict (mirrors deriveConvergenceState's ordering: on_owner is checked
// before the settling disposition); a needs_human / absent verdict stays
// parsed_no_match — the SURFACED violation, never laundered terminal.
const noLineTerminalStatus = (doc, openOwnerAskDocIds = null) => {
  if (openOwnerAskDocIds instanceof Set && doc?.id && openOwnerAskDocIds.has(doc.id)) {
    return 'awaiting_owner';
  }
  if (noLineDispositionFor(doc) === 'auto_explain') return 'explained_no_line';
  return 'parsed_no_match';
};

export const receiptStatusFor = (doc, reconciliationMatches = [], { openOwnerAskDocIds = null } = {}) => {
  if (!doc) return null;
  // PR 19 — a firm-created manual match wins over parse_status. After
  // the firm explicitly binds a failed/skipped parse to a tx, the
  // chip should reflect their decision rather than the parse
  // failure. The parse error still surfaces in the error-message
  // column below the chip (DocumentRow renders both), so the firm
  // doesn't lose the "degraded" signal — it just stops being the
  // primary one.
  // Transient parse states (pending/processing) still win over a
  // match because matches arrive after parsing completes; if a tx
  // matched while the parse was still running, the priority would
  // be inverted from the user's mental model.
  if (doc.parse_status === 'pending' || doc.parse_status === 'processing') return 'processing';
  // RT-10 (F-13): a duplicate never matches and never awaits a bank line —
  // it rests on the owner (period overlap) or is done (collapsed /
  // superseded). Read the persisted verdict: parse_status + duplicate_of.
  if (doc.parse_status === 'duplicate_pending') return 'duplicate_pending';
  if (
    (doc.parse_status === 'skipped' && (doc.parse_summary?.reason === 'duplicate_auto_collapsed' || doc.duplicate_of))
    || (doc.parse_status === 'failed' && doc.duplicate_of)
  ) {
    return 'duplicate_collapsed';
  }
  // Statements produce bank lines; they do not wait to match one. Once the
  // parser completes, render the import receipt instead of the document-side
  // "No match" state used by receipts and invoices.
  if (doc.document_type === 'bank_statement') {
    if (doc.parse_status === 'failed') return 'failed';
    if (doc.parse_status === 'skipped') return 'skipped';
    return 'statement_imported';
  }
  const { status } = matchStateFor(doc, reconciliationMatches);
  if (status) return status;
  if (doc.parse_status === 'failed') return 'failed';
  if (doc.parse_status === 'skipped') {
    // For payment_confirmation the worker skips LLM extraction by
    // design — the doc is stored as evidence and is fully eligible
    // for reconciliation against a bank-statement debit. Surfacing
    // "SKIPPED" reads as an error and makes these rows look
    // different from supplier bills that are also waiting to match,
    // so map to `parsed_no_match` (chip: "NO MATCH"). The skipped
    // signal still lives on the document (parse_status column +
    // parse_summary.reason) for any caller that needs to know the
    // parse path; only the inbox chip is being normalised.
    if (doc.document_type === 'payment_confirmation') return noLineTerminalStatus(doc, openOwnerAskDocIds);
    return 'skipped';
  }
  return noLineTerminalStatus(doc, openOwnerAskDocIds);
};

export const receiptStatusChip = (status) => STATUS_CHIP[status] || STATUS_CHIP.parsed_no_match;

// Bank-feed-side equivalent of receiptStatusFor / receiptStatusChip.
// Stage A of the bank-feed-up-to-documents parity work: gives the
// Reconcile / Reconciled tabs the same chip vocabulary the documents
// inbox already uses, so a tx with a `suggested` doc match reads as
// "Matched · suggested" in both surfaces.
//
// Extends the shared STATUS_CHIP map with tx-only terminal states
// that have no document analogue:
//   - 'reconciled' (firm-confirmed via PATCH cascade)
//   - 'explained'  (auto-match cascade OR manual support)
//   - 'explained_waiting_evidence' (explained on the firm's/client's
//     word while the persisted verdict still says a document is owed —
//     the "APA will be supplied on request" shape. Amber, not muted:
//     a decided line with a pending follow-up, never an error)
//   - 'memory'     (rule_explained — auto-applied learned rule)
//   - 'matched_by_policy' — a #5 delegated-authority auto-accept: a MATERIAL
//     match the strong model authorized on A–D that a standing authority grant
//     let auto-reconcile past the materiality ceiling (§11). Distinct from the
//     ordinary 'matched_auto' (all gates passed under the ceiling); "Reconciled"
//     stays reserved for true accounting completion (§10).
const TRANSACTION_STATUS_CHIP = Object.freeze({
  matched_confirmed: STATUS_CHIP.matched_confirmed,
  matched_auto:      STATUS_CHIP.matched_auto,
  matched_by_policy: { label: 'Matched by policy', tone: 'ok' },
  matched_suggested: STATUS_CHIP.matched_suggested,
  reconciled:        { label: 'Reconciled', tone: 'ok'    },
  explained:         { label: 'Explained',  tone: 'ok'    },
  explained_waiting_evidence: { label: 'Waiting evidence', tone: 'amber' },
  memory:            { label: 'Memory',     tone: 'ok'    },
  no_match:          STATUS_CHIP.parsed_no_match
});

// #5 Slice 5 (§11) — read the delegated-authority verdict off the PERSISTED
// match receipt (`match.payload.authorization`), never a fresh UI-layer
// inference. This mirrors reconciliationLlmCore.js's grantAuthority /
// delegationGateProof (server side) — keep them in LOCK-STEP. A divergence
// means the chip and the accept path disagree about what "by policy" means.

// A delegated AUTO-ACCEPT: grantAuthority flipped the band to 'auto_matched',
// stamped reason 'delegated_authority', and attached a `delegated_authority`
// sub-object. Either signal proves it (the sub-object is the authority receipt).
const isDelegatedAuthorityAccept = (authorization) => {
  if (!authorization || typeof authorization !== 'object') return false;
  if (authorization.delegated_authority && typeof authorization.delegated_authority === 'object') return true;
  const reasons = Array.isArray(authorization.reasons) ? authorization.reasons : [];
  return reasons.length === 1 && reasons[0] === 'delegated_authority';
};

// FE mirror of reconciliationLlmCore.isBankLineOnlyExplained (server) — keep
// the two in LOCK-STEP. True for an 'explained' line whose settlement is ONLY
// a machine explanation: a low-materiality client rule ('rule_explained'),
// the bank-line classifier / its disposition successor, or the coder
// auto-applying a category under the ceiling. The snapshot flattens
// transactions.payload onto the row, so the markers read directly.
const isMachineOnlyExplained = (tx = {}) =>
  String(tx?.reconciliation_status || '').toLowerCase() === 'explained' &&
  (
    tx?.support_status === 'rule_explained' ||
    tx?.bank_line_auto_explained === true ||
    String(tx?.bank_line_auto_explained || '') === 'true' ||
    tx?.bank_line_disposition_explained === true ||
    String(tx?.bank_line_disposition_explained || '') === 'true' ||
    tx?.ai_suggestion_status === 'auto_applied'
  );

export const transactionStatusFor = ({ transaction = null, match = null } = {}) => {
  // A confirmed / auto_matched match wins over the cached column state — it is
  // a genuine settlement and the most actionable signal. A 'suggested' match is
  // only a PROPOSAL, so it wins over the column state ONLY when the line is not
  // already settled: a settled reconciliation_status (explained / reconciled /
  // posted / auto_reconciled) is itself the persisted terminal verdict and
  // outranks a leftover below-floor/ambiguous suggested match (CLAUDE.md "render
  // the persisted verdict, not the legacy layer"). Rejected matches are filtered
  // out by callers (matchById is built from non-rejected rows on
  // financials-view); the guards here cover the defensive case where a caller
  // passes a rejected match directly.
  if (match && match.status && match.status !== 'rejected') {
    // Render the PERSISTED authorization receipt (CLAUDE.md "render the
    // persisted verdict"): a #5 delegated auto-accept gets its own #5 label;
    // nothing here recomputes or re-infers.
    const authorization = match.payload?.authorization || null;
    if (match.status === 'confirmed')    return 'matched_confirmed';
    if (match.status === 'auto_matched') {
      return isDelegatedAuthorityAccept(authorization) ? 'matched_by_policy' : 'matched_auto';
    }
    // A 'suggested' match relabels the line as "Matched · suggested" when the
    // line is unsettled, OR when its only settlement is a MACHINE explanation
    // (§4b-xvii): the family matchers now re-propose against machine-explained
    // lines by design, so the suggested match IS the document-evidence upgrade
    // offer — hiding it behind "Explained" strands the pair out of sight while
    // the artifact panel shows the match (the Verizon 39.06 acceptance case).
    // A line settled by a human, a doc match, or posting keeps its terminal
    // label — a leftover proposal must not relabel a real settlement.
    if (match.status === 'suggested') {
      const settled = ['explained', 'reconciled', 'posted', 'auto_reconciled']
        .includes(String(transaction?.reconciliation_status || '').toLowerCase());
      if (!settled || isMachineOnlyExplained(transaction)) return 'matched_suggested';
    }
  }
  // The persisted verdict's evidence judgment survives a human accept:
  // evidence_required true means the books still owe a document even
  // though the line is explained (the firm's word carries it for now).
  // The pill resolves on its own — a matched document wins above, and
  // a client-reply re-code writes a fresh verdict with
  // evidence_required false.
  const evidenceOwed = transaction?.ai_suggestion?.evidence_required === true;
  const recon = String(transaction?.reconciliation_status || '').toLowerCase();
  if (recon === 'reconciled') return 'reconciled';
  if (recon === 'explained')  return evidenceOwed ? 'explained_waiting_evidence' : 'explained';
  const support = String(transaction?.support_status || '').toLowerCase();
  if (support === 'rule_explained') return 'memory';
  if (support === 'explained')      return evidenceOwed ? 'explained_waiting_evidence' : 'explained';
  return 'no_match';
};

export const transactionStatusChip = (input) => {
  // Ergonomic: accept either a pre-computed status key OR an
  // ({transaction, match}) object — callers shouldn't have to call
  // two helpers for one chip.
  const status = typeof input === 'string'
    ? input
    : transactionStatusFor(input || {});
  return TRANSACTION_STATUS_CHIP[status] || TRANSACTION_STATUS_CHIP.no_match;
};

// Per-document count of open `document_line` review queue entries.
// Totals validation now emits one representative-line lifecycle row for the
// document-level amount_mismatch exception. Older snapshots may still carry
// the former one-per-line fanout; counting by document keeps both readable
// until the next parse collapses those rows.
//
// Previously surfaced as a list above the bank-feed reconcile table —
// a leaky abstraction since these are documents-side parsing-quality
// signals, not transaction-side reconciliation signals. The Documents
// inbox row now renders a chip when the count is non-zero; this
// helper computes the map once and the row builder reads off it.
// RT-10: the ask statuses that mean a totals row's owner ask is CLOSED —
// the row is done even if the writer's sweep has not flipped it yet. Read
// off the persisted request rows the snapshot already carries; never an
// inference. Lock-step with settleResolvedTotalsAskRowsWithClient
// (parseDocumentsDb.js).
const CLOSED_ASK_STATUSES = Object.freeze(['resolved', 'cancelled']);

const closedAskIdsFrom = (clientEvidenceRequests = []) => {
  const ids = new Set();
  for (const req of Array.isArray(clientEvidenceRequests) ? clientEvidenceRequests : []) {
    const status = String(req?.status || '').trim().toLowerCase();
    if (req?.id && CLOSED_ASK_STATUSES.includes(status)) ids.add(req.id);
  }
  return ids;
};

const isOpenDocumentLineReview = (item, closedAskIds = null) => {
  if (!item || item.item_type !== 'document_line') return false;
  // Defaults to "open" when status is null/undefined — mirrors the
  // bank-feed filter that did the same. The DB column is nullable
  // for older rows that pre-date the status vocabulary.
  if (item.status && item.status !== 'open') return false;
  const askId = item.payload?.lane?.evidence_request_id;
  if (askId && closedAskIds instanceof Set && closedAskIds.has(askId)) return false;
  return true;
};

export const countOpenDocumentLineReviews = (reviewItems = [], clientEvidenceRequests = []) => {
  const counts = new Map();
  if (!Array.isArray(reviewItems)) return counts;
  const closedAskIds = closedAskIdsFrom(clientEvidenceRequests);
  for (const item of reviewItems) {
    if (!isOpenDocumentLineReview(item, closedAskIds)) continue;
    const docId = item.payload?.document_id;
    if (!docId) continue;
    counts.set(docId, (counts.get(docId) || 0) + 1);
  }
  return counts;
};

// RT-10 — the LANE each document's open totals exception rests in, read off
// the persisted review-row payload (`payload.lane.kind`, written by the
// parse writer in the same transaction as the owner ask): 'owner_ask' (on
// the owner), 'machine_reread' (Donna's, in flight), or null (a legacy row
// with no lane — the surfaced violation). One entry per document; the first
// open row's lane wins (the writer keeps one row per document).
export const openDocumentLineReviewLanes = (reviewItems = [], clientEvidenceRequests = []) => {
  const lanes = new Map();
  if (!Array.isArray(reviewItems)) return lanes;
  const closedAskIds = closedAskIdsFrom(clientEvidenceRequests);
  for (const item of reviewItems) {
    if (!isOpenDocumentLineReview(item, closedAskIds)) continue;
    const docId = item.payload?.document_id;
    if (!docId || lanes.has(docId)) continue;
    const lane = item.payload?.lane && typeof item.payload.lane === 'object' ? item.payload.lane : null;
    lanes.set(docId, {
      kind: lane?.kind ? String(lane.kind) : null,
      evidence_request_id: lane?.evidence_request_id || null
    });
  }
  return lanes;
};

// `null` when there's nothing to surface (zero count or negative
// input). Every open row for a document carries the SAME underlying
// exception: its extracted lines do not add up to the header total.
// The count remains available for the document detail, but the inbox
// names the one document-level problem instead of implying N distinct
// decisions. Amber draws attention without escalating to an alarm.
// RT-10: the chip names the LANE — on the owner, or Donna's in-flight
// re-read — so a totals exception never reads as a firm to-do.
export const documentLineReviewChip = (count, lane = null) => {
  const n = Number(count) || 0;
  if (n <= 0) return null;
  const kind = lane && typeof lane === 'object' ? lane.kind : lane;
  if (kind === 'owner_ask') return { label: 'Totals · asked the client', tone: 'amber' };
  if (kind === 'machine_reread') return { label: 'Totals · re-reading', tone: 'amber' };
  return { label: 'Totals don’t match', tone: 'amber' };
};

// Read-only agreement evidence cue for the documents list. `null` when the
// document carries no checkable agreement verdict (non-agreement, or no
// extracted obligations). `requires_review` draws amber attention — the firm
// should open the agreement and read the evidence; `pass` is a quiet positive.
// This is a discoverability cue only; the full CheckReport lives in the
// artifact panel and NEITHER posts nor reconciles anything.
export const evidenceCheckChip = (evidenceCheck) => {
  const status = evidenceCheck?.status;
  if (status === 'requires_review') return { label: 'Evidence: review', tone: 'amber' };
  if (status === 'pass') return { label: 'Evidence: clear', tone: 'ok' };
  return null;
};

// Phase 7.2b-ii — bank-line disposition chip for the reconcile feed. Renders
// the PERSISTED bank-line disposition verdict (server-attached as
// `tx.bank_line_disposition`) as a low-priority, *correctable* cue — never a
// render-time re-inference (CLAUDE.md: render the persisted verdict). Returns
// `null` unless the strong model auto-explained the line (verdict
// `auto_explained`, the noise-suppression case); `needs_human` / `chase_receipt`
// map to a normal `no_match` gap row + an ask-pipeline case, so they get no
// special feed chip here. The chip de-prioritizes — it does NOT hard-close: the
// line stays on the feed and stays clickable into the transaction artifact (the
// correction surface), preserving the human-correction half. The `title` is the
// receipt the reviewer reads to judge the call: what the model said + its
// confidence + the model id ("the model id is part of the receipt").
export const bankLineDispositionChip = (disposition) => {
  if (!disposition || disposition.verdict !== 'auto_explained') return null;
  const kindRaw = disposition.expense_kind;
  const kind = kindRaw && kindRaw !== 'unknown' ? String(kindRaw).replace(/_/g, ' ') : null;
  const pct = typeof disposition.confidence === 'number'
    ? `${Math.round(disposition.confidence * 100)}%`
    : null;
  const materiality = disposition.materiality || 'immaterial';
  const titleParts = [
    `Donna auto-explained this line as ${materiality} recurring noise${kind ? ` (${kind})` : ''}.`
  ];
  if (disposition.reasoning) titleParts.push(disposition.reasoning);
  const receipt = [
    pct ? `confidence ${pct}` : null,
    disposition.model ? `model ${disposition.model}` : null
  ].filter(Boolean).join(' · ');
  if (receipt) titleParts.push(receipt);
  titleParts.push('Review optional — open the line to recategorize or ask the client.');
  return {
    label: 'Auto-explained',
    sublabel: 'review optional',
    tone: 'muted',
    title: titleParts.join(' ')
  };
};

// RT-02 (audit F-02), carried into the inbox by RT-10: WHO retries is
// `parse_error.retry_owner` ('queue' | 'manual' | null). Mirrors the tray
// (labelForTrayRow): a LEGACY envelope with no owner that is retryable-class
// carries a "Retrying shortly"-style promise a writer could not keep, so its
// copy is dropped for the neutral ask. Exhausted rows (retryable false) keep
// their reason. The message is a persisted verdict, never re-inferred.
const OWNERLESS_RETRY_MESSAGE = 'Couldn’t parse — retry?';

const parseError = (doc) => {
  const err = doc?.parse_error;
  if (!err || typeof err !== 'object') return null;
  const retryOwner = err.retry_owner === 'queue' || err.retry_owner === 'manual' ? err.retry_owner : null;
  const retryable = err.retryable === true;
  const message = safeString(err.safe_user_message) || null;
  return {
    code: safeString(err.code) || null,
    safe_user_message: retryOwner === null && retryable ? OWNERLESS_RETRY_MESSAGE : message,
    retryable,
    retry_owner: retryOwner
  };
};

const compareDocumentRows = (left, right) => {
  // Newest uploaded first. Falls back to id for stable ordering on ties.
  const leftKey = safeString(left.uploadedAt || '');
  const rightKey = safeString(right.uploadedAt || '');
  if (leftKey !== rightKey) return rightKey.localeCompare(leftKey);
  return safeString(left.id).localeCompare(safeString(right.id));
};

const safeNumber = (value) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

const kindFor = (doc) => {
  const kind = safeString(doc?.document_type).trim();
  if (SUPPORTED_KINDS.includes(kind)) return kind;
  return 'other';
};

const paymentTermsDaysFor = (doc) => {
  // `Number(null)` returns 0 and 0 is finite — so a bare
  // `Number.isFinite(Number(value))` check would coerce explicit-null
  // days (EOM, TBD, anything the extractor's payment-terms normaliser
  // couldn't pin to a day count) into a misleading `0`. The panel
  // would then render "Terms: End of month (0d)". Reject `null` /
  // `undefined` before coercing.
  const raw = doc?.parse_summary?.payment_terms_days;
  if (raw == null) return null;
  const days = Number(raw);
  return Number.isFinite(days) ? days : null;
};

const paymentTermsPhraseFor = (doc) => {
  const phrase = safeString(doc?.parse_summary?.payment_terms_phrase).trim();
  return phrase || null;
};

const paymentStatusFor = (doc) => {
  // Payment confirmations are evidence that a payment ALREADY went
  // out — by definition `paid`. The doc row has no payment_status
  // field set (worker skips extraction), so without this override
  // the chip would render the muted "UNKNOWN" which is misleading.
  if (doc?.document_type === 'payment_confirmation') return 'paid';
  const status = safeString(doc?.payment_status).trim().toLowerCase();
  if (PAYMENT_STATUS_CHIP[status]) return status;
  return 'unknown';
};

// Effective payment-status DISPLAY for a document, folding in the
// reconciliation match verdict so a surface renders the persisted state
// rather than the raw parse-time `documents.payment_status` (CLAUDE.md:
// "Render the persisted verdict, not the legacy layer"; Failure B). A
// stamp-less bill/invoice defaults to 'unpaid' at extraction; that
// default is stale the moment a bank line is matched.
//   - confirmed / auto_matched match + raw 'unpaid'|'unknown' → 'paid'
//     (mirrors buildDocumentInboxRow, so the list and the artifact agree)
//   - suggested match → the raw status, annotated as a PENDING match. We
//     never silently claim 'paid' off an unconfirmed suggestion; the
//     annotation tells the reviewer a match is waiting to be authorized.
//   - no match (or only a rejected one) → the raw status, unchanged.
// Returns { status, display, pendingMatch }: `status` is the underlying
// payment enum (what inline-edit still operates on), `display` is the
// string to render, `pendingMatch` flags the suggested-but-unconfirmed
// case for callers that want to style it.
export const effectivePaymentStatusDisplay = (doc, reconciliationMatches = []) => {
  const rawStatus = paymentStatusFor(doc);
  const { match } = matchStateFor(doc, reconciliationMatches);
  if (!match) {
    return { status: rawStatus, display: rawStatus, pendingMatch: false };
  }
  if ((match.status === 'confirmed' || match.status === 'auto_matched') &&
      (rawStatus === 'unpaid' || rawStatus === 'unknown')) {
    return { status: 'paid', display: 'paid', pendingMatch: false };
  }
  if (match.status === 'suggested') {
    return { status: rawStatus, display: `${rawStatus} · match suggested`, pendingMatch: true };
  }
  return { status: rawStatus, display: rawStatus, pendingMatch: false };
};

export const classifierBandFor = (doc) => {
  const c = Number(doc?.parse_summary?.semantic?.confidence);
  if (!Number.isFinite(c)) return null;
  if (c >= 0.8) return 'high';
  if (c >= 0.5) return 'medium';
  return 'low';
};

// Build a single inbox row from a document. Every upload is renderable:
// known kinds keep their own filter and unknown/future kinds use the
// lossless `other` bucket.
export const buildDocumentInboxRow = ({ document, reconciliationMatches = [], lineReviewCount = 0, lineReviewLane = null, openOwnerAskDocIds = null }) => {
  if (!document) return null;
  const kind = kindFor(document);
  if (!kind) return null;
  const matchState = matchStateFor(document, reconciliationMatches);
  const status = receiptStatusFor(document, reconciliationMatches, { openOwnerAskDocIds });
  const classifierKind = classifierKindFor(document);
  const rawPaymentStatus = paymentStatusFor(document);
  const hasConfirmedMatch = matchState.match &&
    (matchState.match.status === 'confirmed' || matchState.match.status === 'auto_matched');
  const paymentStatus = (hasConfirmedMatch && (rawPaymentStatus === 'unknown' || rawPaymentStatus === 'unpaid'))
    ? 'paid'
    : rawPaymentStatus;
  // PR 8 — settled amount computed on the fly. Only meaningful for
  // sales invoices (1:N partial-payment direction); receipts/bills
  // either match 1:1 to 'paid' or remain 'unpaid' and don't surface
  // a settled-progress line. The row still carries the field for all
  // kinds so the renderer can branch on `kind === 'sales_invoice'`
  // without needing a per-kind compute.
  const settledAmount = computeSettledAmount(document, reconciliationMatches);
  // PR 9 — surface cross-matcher competition when the current match
  // row's tx is also pointed at by a different document type. Empty
  // array when no match exists on this doc OR no competing type is
  // present. The FE renders a small "Also matched as receipt /
  // supplier_bill" chip so the firm sees the ambiguity before
  // confirming.
  const competingDocumentTypes = matchState.match
    ? [...competingDocumentTypesFor(matchState.match, reconciliationMatches)]
    : [];
  // Payment-confirmation rows derive date + amount from the filename
  // since the worker doesn't run the LLM extractor for this type.
  // For every other kind the parsed values from the document row win.
  const filenameMeta = kind === 'payment_confirmation'
    ? parsePaymentConfirmationFilename(document.filename)
    : null;
  return {
    id: document.id,
    kind,
    document,
    vendorDisplay: vendorDisplayFor(document),
    documentDate: document.document_date
      || (kind === 'bank_statement' ? document.parse_summary?.period_end_date : null)
      || filenameMeta?.date
      || null,
    // Bills + invoices carry a due_date that the receipts sub-table
    // ignores; we surface it on every row so the per-kind sub-tables
    // can render it without re-reading the document.
    dueDate: document.due_date || null,
    // `safeNumber(null)` returns 0 (Number(null) === 0), which would
    // swallow the filename-derived fallback via `??`. Check for the
    // raw-null case first so an unextracted total_amount actually
    // hands off to the filename amount instead of rendering "$0.00".
    totalAmount: document.total_amount != null
      ? safeNumber(document.total_amount)
      : (filenameMeta?.amount ?? null),
    currency: safeString(document.currency) || null,
    classifierKind,
    classifierKindLabel: classifierKindLabel(classifierKind),
    classifierConfidenceBand: classifierBandFor(document),
    matchStatus: status,
    matchChip: kind === 'bank_statement' && status === 'statement_imported'
      ? {
          label: Number(document.parse_summary?.transaction_count) > 0
            ? `${Number(document.parse_summary.transaction_count)} transactions`
            : 'Imported',
          tone: 'muted'
        }
      : receiptStatusChip(status),
    match: matchState.match,
    // Bill-prominent surface: payment_status comes off the documents
    // row (the writer stamps it from the extractor's enum-coerced
    // header; the firm can flip it via the PATCH endpoint). Receipts
    // also have a payment_status but it typically defaults to
    // 'unknown' / 'paid' and isn't surfaced as a chip on receipts.
    paymentStatus,
    paymentStatusChip: paymentStatusChip(paymentStatus),
    paymentTermsDays: paymentTermsDaysFor(document),
    paymentTermsPhrase: paymentTermsPhraseFor(document),
    settledAmount,
    competingDocumentTypes,
    parseError: parseError(document),
    // Stage A — surfaces open document_line review queue entries
    // (parser's totalsValidation flagged a mismatch). Count plus
    // pre-computed chip so the row renderer can branch on either.
    lineReviewCount: Number(lineReviewCount) || 0,
    // RT-10: the lane the exception rests in ('owner_ask' / 'machine_reread'
    // / null), read off the persisted row; the chip names it.
    lineReviewLane: lineReviewLane && typeof lineReviewLane === 'object' ? lineReviewLane : null,
    lineReviewChip: documentLineReviewChip(lineReviewCount, lineReviewLane),
    // Read-only agreement evidence cue (contracts with obligations); null
    // otherwise. The server attaches `evidence_check` in the snapshot.
    evidenceChip: evidenceCheckChip(document.evidence_check),
    uploadedAt: document.uploaded_at || document.created_at || null
  };
};

// Deprecated alias — kept for any out-of-tree caller during the
// PR 6 rollout. Drops in the next sweep per the brief's Q7 plan.
export const buildReceiptInboxRow = ({ document, reconciliationMatches = [] }) => {
  if (!document || document.document_type !== 'receipt') return null;
  return buildDocumentInboxRow({ document, reconciliationMatches });
};

// Derived from SUPPORTED_KINDS so the two can't drift. Previously
// hardcoded with only receipt/supplier_bill/sales_invoice, which
// silently dropped `contract` rows from the inbox (PR 18 added
// contract to SUPPORTED_KINDS but missed this seed); the same trap
// would catch `payment_confirmation` if we hardcoded again.
const EMPTY_BY_KIND = Object.freeze(
  Object.fromEntries(INBOX_KINDS.map((kind) => [kind, []]))
);

// Build the inbox row list. Defaults to including every inbox kind
// (the supported kinds plus the 'other' catch-all); pass
// `documentTypes` (Set or Array) to filter.
// Returns `{ rows, byKind }` where byKind partitions the rows for the
// per-table renderer.
export const buildDocumentInbox = ({
  documents = [],
  reconciliationMatches = [],
  reviewItems = [],
  clientEvidenceRequests = [],
  documentTypes = INBOX_KINDS
} = {}) => {
  const allowed = documentTypes instanceof Set
    ? documentTypes
    : new Set(Array.isArray(documentTypes) ? documentTypes : INBOX_KINDS);
  // Stage A — per-doc line review counts feed the row chip. Computed
  // once across the whole inbox rather than once per row. RT-10: a row
  // whose owner ask has closed no longer counts, and the lane rides along.
  const lineReviewCounts = countOpenDocumentLineReviews(reviewItems, clientEvidenceRequests);
  const lineReviewLanes = openDocumentLineReviewLanes(reviewItems, clientEvidenceRequests);
  // Doc-first terminal drain — outstanding doc-anchored owner asks flip a
  // no-line row to 'awaiting_owner'. Computed once for the whole inbox.
  const openOwnerAskDocIds = openOwnerAskDocIdsFrom(clientEvidenceRequests);
  const byKind = { ...EMPTY_BY_KIND };
  // Defensive copy so callers can't mutate our cached empty arrays.
  for (const key of Object.keys(byKind)) byKind[key] = [];
  const rows = [];
  for (const document of documents) {
    const row = buildDocumentInboxRow({
      document,
      reconciliationMatches,
      lineReviewCount: lineReviewCounts.get(document.id) || 0,
      lineReviewLane: lineReviewLanes.get(document.id) || null,
      openOwnerAskDocIds
    });
    if (!row) continue;
    if (!allowed.has(row.kind)) continue;
    rows.push(row);
    if (byKind[row.kind]) byKind[row.kind].push(row);
  }
  rows.sort(compareDocumentRows);
  for (const list of Object.values(byKind)) list.sort(compareDocumentRows);
  return { rows, byKind };
};

// Deprecated alias — receipts-only. Same return shape as the old
// builder (flat array of rows). Q7 keeps this so any out-of-tree
// caller compiles during the rollout.
export const buildReceiptInbox = ({ documents = [], reconciliationMatches = [] } = {}) => {
  const { byKind } = buildDocumentInbox({
    documents,
    reconciliationMatches,
    documentTypes: ['receipt']
  });
  return byKind.receipt;
};

// Launch-hardening safety-net selector. Returns the inbox rows for parsed,
// single-amount AP/AR evidence documents that found NO bank line yet
// (matchStatus === 'parsed_no_match') — the population the transaction-anchored
// Reconcile feed silently drops (a doc with no tx has no row there). Scoped to
// the reconcilable kinds (receipt / supplier_bill / sales_invoice /
// issued_receipt / payment_confirmation): statement-type docs land in the
// 'other' bucket and PRODUCE bank lines rather than await one, and contracts
// carry no single reconcilable amount. The `totalAmount != null` guard mirrors
// scripts/diagnose_unmatched.js's `total_amount is not null` filter, so an
// amount-less doc never reads as "awaiting a bank line". Pure over the snapshot
// — no new matching logic; reuses buildDocumentInbox / receiptStatusFor.
export const RECONCILABLE_DOCUMENT_KINDS = Object.freeze([
  'receipt',
  'supplier_bill',
  'sales_invoice',
  'issued_receipt',
  'payment_confirmation'
]);

// The three statuses a no-line reconcilable doc can carry (doc-first
// terminal drain): the violation (parsed_no_match — no verdict yet, or a
// needs_human fallback) and the two terminals. The convergence metric
// ingests ALL three (a terminalized doc must keep counting, else it
// vanishes from the metric again); the Reconcile violation section shows
// ONLY parsed_no_match.
export const NO_LINE_DOC_STATUSES = Object.freeze(['parsed_no_match', 'awaiting_owner', 'explained_no_line']);

// Every parsed, amount-bearing reconcilable doc with NO bank line —
// violation AND terminal rows. Feed this to the convergence metric.
export const selectNoLineReconcilableDocs = ({
  documents = [],
  reconciliationMatches = [],
  reviewItems = [],
  clientEvidenceRequests = []
} = {}) => {
  const { rows } = buildDocumentInbox({
    documents,
    reconciliationMatches,
    reviewItems,
    clientEvidenceRequests,
    documentTypes: RECONCILABLE_DOCUMENT_KINDS
  });
  return rows.filter((row) => NO_LINE_DOC_STATUSES.includes(row.matchStatus) && row.totalAmount != null);
};

export const selectUnmatchedReconcilableDocs = (input = {}) =>
  selectNoLineReconcilableDocs(input).filter((row) => row.matchStatus === 'parsed_no_match');

const statementActivityTime = (document = {}) =>
  String(
    document.parse_completed_at ||
    document.updated_at ||
    document.uploaded_at ||
    document.created_at ||
    ''
  );

const statementSourceState = (document = {}) => {
  const parseStatus = String(document.parse_status || '').toLowerCase();
  const summary = document.parse_summary && typeof document.parse_summary === 'object'
    ? document.parse_summary
    : {};
  const extractionStatus = String(summary.extraction_status || '').toLowerCase();
  const transactionCount = Number(summary.transaction_count || 0);
  if (parseStatus === 'pending' || parseStatus === 'processing') return 'processing';
  if (
    parseStatus === 'failed' ||
    parseStatus === 'skipped' ||
    ((extractionStatus === 'failed' || extractionStatus === 'needs_review') && transactionCount === 0)
  ) {
    return 'blocked';
  }
  return null;
};

// Material is source-aware. When there are no bank transactions because the
// latest statement is still reading or failed validation, forty otherwise-
// valid receipts are not forty independent "No bank line" problems. Collapse
// that derived fallout to the one source document that owns the failure. Once
// bank rows exist (or the latest statement is healthy), the ordinary no-line
// document selector takes over unchanged.
export const selectMaterialOpenDocumentRows = (input = {}) => {
  const transactions = Array.isArray(input.transactions) ? input.transactions : [];
  const documents = Array.isArray(input.documents) ? input.documents : [];
  if (transactions.length === 0) {
    const latestStatement = documents
      .filter((document) => document?.document_type === 'bank_statement')
      .slice()
      .sort((left, right) => statementActivityTime(right).localeCompare(statementActivityTime(left)))[0];
    const sourceState = statementSourceState(latestStatement);
    if (latestStatement && sourceState) {
      const row = buildDocumentInboxRow({
        document: latestStatement,
        reconciliationMatches: input.reconciliationMatches || []
      });
      if (row) {
        return [{
          ...row,
          documentDate:
            row.documentDate ||
            String(latestStatement.uploaded_at || latestStatement.created_at || '').slice(0, 10) ||
            null,
          materialSourceState: sourceState,
          materialStatusLabel: sourceState === 'processing' ? 'Reading statement' : 'Statement needs repair',
          materialStatusTone: sourceState === 'processing' ? 'amber' : 'alert'
        }];
      }
    }
  }
  return selectUnmatchedReconcilableDocs(input);
};

// Per-kind summary counts for the section headers / future filter
// chips. Mirrors `summarizeReceiptInbox`'s contract but tracks bill
// rows in addition. `kindCounts` is a per-kind breakdown of total +
// each status, so the bills SummaryStrip can read its own numbers
// without re-summarising.
export const summarizeDocumentInbox = (input = []) => {
  // Accept either the flat `rows` list (back-compat for callers that
  // only have the rows array) or the full `{ rows, byKind }` object.
  const rows = Array.isArray(input) ? input : (input.rows || []);
  const byKind = !Array.isArray(input) && input.byKind ? input.byKind : null;

  const counts = { total: rows.length };
  for (const status of RECEIPT_STATUSES) counts[status] = 0;
  for (const row of rows) {
    if (counts[row.matchStatus] != null) counts[row.matchStatus] += 1;
  }
  counts.matched_total = counts.matched_confirmed + counts.matched_auto + counts.matched_suggested;
  counts.needs_attention =
    counts.failed + counts.parsed_no_match + counts.matched_suggested;

  const perKind = {};
  for (const kind of INBOX_KINDS) {
    const kindRows = byKind?.[kind] || rows.filter((row) => row.kind === kind);
    const kindCounts = { total: kindRows.length };
    for (const status of RECEIPT_STATUSES) kindCounts[status] = 0;
    for (const row of kindRows) {
      if (kindCounts[row.matchStatus] != null) kindCounts[row.matchStatus] += 1;
    }
    kindCounts.matched_total =
      kindCounts.matched_confirmed + kindCounts.matched_auto + kindCounts.matched_suggested;
    kindCounts.needs_attention =
      kindCounts.failed + kindCounts.parsed_no_match + kindCounts.matched_suggested;
    perKind[kind] = kindCounts;
  }
  counts.by_kind = perKind;
  return counts;
};

// Deprecated alias — receipts-only summary. Drops in the next sweep.
export const summarizeReceiptInbox = (rows = []) => {
  const receiptOnly = rows.filter((row) => row.kind === 'receipt' || !row.kind);
  return summarizeDocumentInbox(receiptOnly);
};
