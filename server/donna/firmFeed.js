// Exception-Routing Close Engine — global feed builder (Phase 2).
//
// Reads a firm snapshot (reconciliation_matches + transaction_review_queue
// + related transactions and clients) and produces a bucketed feed view
// the Kari dashboard can render without re-fetching per row.
//
// The feed is work-first, not client-first: every disposition bucket
// contains items from every client of the firm. Kari sees ALL
// operator_blockers across her book, not "drill into client A → see
// A's blockers, drill into client B → see B's blockers."
//
// This module is a pure function over a snapshot-shaped input. No DB
// access — the caller fetches with getFirmSnapshotFromDb (or any
// other source) and passes the rows in. Keeps the module trivially
// testable and lets the classifier shape iterate without dragging
// this surface.

import {
  CLOSE_DISPOSITIONS,
  DEFAULT_MATERIALITY_BANDS,
  RULE_MATURITY,
  classifyAskBatchDraft,
  classifyClientEvidenceRequest,
  classifyFailedParse,
  classifyReconciliationMatch,
  classifyReviewItem
} from './closeDisposition.js';

const BUCKET_ORDER = Object.freeze([
  CLOSE_DISPOSITIONS.OPERATOR_BLOCKER,
  CLOSE_DISPOSITIONS.CONFIRMABLE,
  CLOSE_DISPOSITIONS.CLIENT_INFO_NEEDED,
  CLOSE_DISPOSITIONS.AUTO_CLEARED
]);

const emptyBuckets = () => ({
  [CLOSE_DISPOSITIONS.AUTO_CLEARED]: [],
  [CLOSE_DISPOSITIONS.CONFIRMABLE]: [],
  [CLOSE_DISPOSITIONS.OPERATOR_BLOCKER]: [],
  [CLOSE_DISPOSITIONS.CLIENT_INFO_NEEDED]: []
});

const indexById = (rows, key = 'id') => {
  const out = new Map();
  for (const r of rows || []) {
    if (r && r[key] != null) out.set(r[key], r);
  }
  return out;
};

const signedAmount = (tx) => {
  const moneyIn = Number(tx?.money_in) || 0;
  const moneyOut = Number(tx?.money_out) || 0;
  if (moneyIn || moneyOut) return moneyIn - moneyOut;
  // Some snapshot shapes carry a single `amount` field (mock data).
  const amount = Number(tx?.amount);
  return Number.isFinite(amount) ? amount : 0;
};

const descriptorFor = (tx) =>
  tx?.description
  || tx?.payload?.merchant_name
  || tx?.payload?.counterparty
  || tx?.payload?.payee
  || tx?.merchant_name
  || '';

const counterpartyFor = (tx) =>
  tx?.payload?.counterparty
  || tx?.payload?.merchant_name
  || tx?.payload?.payee
  || tx?.merchant_name
  || null;

const accountingBasisFor = (client) =>
  client?.profile?.accountingBasis
  ?? client?.profile?.accounting_basis
  ?? client?.accounting_basis
  ?? null;

const clientContextFor = (client, firm) => ({
  firm_id: firm?.id ?? null,
  client_id: client?.id ?? null,
  client_name: client?.company_name ?? client?.companyName ?? null,
  jurisdiction: client?.jurisdiction || firm?.jurisdiction || null,
  accounting_basis: accountingBasisFor(client)
});

const txForClassifier = (tx) => {
  if (!tx) return null;
  return {
    id: tx.id,
    description: descriptorFor(tx),
    counterparty: counterpartyFor(tx),
    amount: signedAmount(tx),
    transaction_date: tx.transaction_date,
    currency: tx.currency
  };
};

const buildFeedItemFromMatch = ({
  match, transactionIndex, clientIndex, firm,
  materialityBands, ruleMaturity
}) => {
  const tx = transactionIndex.get(match.bank_transaction_id);
  const client = clientIndex.get(match.client_id);
  const txInput = txForClassifier(tx);
  const verdict = classifyReconciliationMatch({
    match,
    transaction: txInput,
    context: clientContextFor(client, firm),
    materialityBands,
    ruleMaturity
  });
  return {
    kind: 'reconciliation_match',
    source_id: match.id,
    client_id: match.client_id,
    transaction_id: match.bank_transaction_id,
    matched_object_type: match.matched_object_type,
    matched_object_id: match.matched_object_id,
    transaction_date: tx?.transaction_date ?? null,
    amount: txInput?.amount ?? null,
    currency: tx?.currency ?? null,
    descriptor: txInput?.description ?? null,
    counterparty: txInput?.counterparty ?? null,
    verdict
  };
};

// Failed-parse items have no transaction and no extracted amount —
// the parse is the thing that failed. We surface them with the doc's
// created_at as the sort anchor (newest failures bubble up first within
// the operator_blocker bucket) and a descriptor that names the file
// so the operator knows what to re-upload or re-key.
const buildFeedItemFromFailedParse = ({ document, clientIndex, firm }) => {
  const client = clientIndex.get(document.client_id);
  const verdict = classifyFailedParse({
    document,
    context: clientContextFor(client, firm)
  });
  const filename = document.filename || 'untitled document';
  return {
    kind: 'failed_parse',
    source_id: document.id,
    client_id: document.client_id,
    document_id: document.id,
    filename,
    transaction_date: document.created_at || document.uploaded_at || null,
    amount: null,
    currency: null,
    descriptor: document.parse_error?.code === 'DOCUMENT_SPEND_LIMIT'
      ? `Spending limit paused ${filename}` : `Couldn't read ${filename}`,
    reason: document.parse_error || 'Parse failed',
    counterparty: null,
    verdict
  };
};

// Ask-lane items. An OPEN client_evidence_request is the on-the-client
// terminal; the feed row carries the linked bank line's date/amount/
// descriptor (or the anchoring document's filename for doc-anchored asks)
// so the inbox row is legible without opening anything.
const askCountsLabel = (counts = {}) => {
  const parts = [];
  const ask = Number(counts?.ask || 0);
  const statements = Number(counts?.statement_requests || 0);
  const notify = Number(counts?.notify || 0);
  if (ask) parts.push(`${ask} question${ask === 1 ? '' : 's'}`);
  if (statements) parts.push(`${statements} statement request${statements === 1 ? '' : 's'}`);
  if (notify) parts.push(`${notify} FYI${notify === 1 ? '' : 's'}`);
  return parts.length ? parts.join(' · ') : 'empty draft';
};

const buildFeedItemFromEvidenceRequest = ({
  request, transactionIndex, documentIndex, clientIndex, firm, materialityBands
}) => {
  const tx = request.transaction_id ? transactionIndex.get(request.transaction_id) : null;
  const doc = request.request_payload?.document_id
    ? documentIndex.get(request.request_payload.document_id)
    : null;
  const client = clientIndex.get(request.client_id);
  const txInput = txForClassifier(tx);
  const verdict = classifyClientEvidenceRequest({
    request,
    transaction: txInput,
    context: clientContextFor(client, firm),
    materialityBands
  });
  return {
    kind: 'client_evidence_request',
    source_id: request.id,
    client_id: request.client_id,
    transaction_id: request.transaction_id ?? null,
    document_id: request.request_payload?.document_id ?? null,
    transaction_date: tx?.transaction_date ?? request.first_sent_at ?? request.created_at ?? null,
    amount: txInput?.amount ?? null,
    currency: tx?.currency ?? null,
    descriptor: txInput?.description || doc?.filename || null,
    reason: request.status === 'draft' ? `Draft, not sent — ${request.question || 'Question awaiting review'}` : request.question ?? null,
    counterparty: txInput?.counterparty ?? null,
    verdict
  };
};

const buildFeedItemFromAskBatchDraft = ({ batch, clientIndex, firm }) => {
  const client = clientIndex.get(batch.client_id);
  const verdict = classifyAskBatchDraft({
    batch,
    context: clientContextFor(client, firm)
  });
  // Presentation receipt: a drafted client message is ONE firm task. Keep
  // the transaction anchors it already covers on the feed item so list
  // projections can suppress duplicate per-line decisions without
  // re-inferring anything from message copy.
  const coveredTransactionIds = Array.from(new Set(
    (Array.isArray(batch.draft?.items) ? batch.draft.items : [])
      .filter((item) => item?.disposition === 'ask' || item?.disposition === 'notify')
      .map((item) => item?.transaction_id)
      .filter(Boolean)
  ));
  return {
    kind: 'ask_batch_draft',
    source_id: batch.id,
    client_id: batch.client_id,
    covered_transaction_ids: coveredTransactionIds,
    transaction_date: batch.created_at ?? null,
    amount: null,
    currency: null,
    descriptor: batch.subject || 'Client message drafted',
    reason: `drafted, not sent — ${askCountsLabel(batch.draft?.counts)}`,
    counterparty: null,
    verdict
  };
};

const buildFeedItemFromReview = ({
  reviewItem, transactionIndex, documentIndex, clientIndex, firm,
  materialityBands, ruleMaturity
}) => {
  const tx = reviewItem.item_type === 'transaction'
    ? transactionIndex.get(reviewItem.item_id)
    : null;
  // Document-scoped review items (amount_mismatch and friends) used to
  // resolve NO context at all: descriptor fell back to the raw reason, so
  // the inbox rendered "amount_mismatch / amount_mismatch" rows with no
  // amount and no name — an enum leak, not a feed item. The document is
  // the context: its filename is the descriptor, its date the sort anchor.
  const doc = reviewItem.item_type === 'document'
    ? documentIndex.get(reviewItem.item_id)
    : null;
  const client = clientIndex.get(reviewItem.client_id);
  const txInput = txForClassifier(tx);
  const verdict = classifyReviewItem({
    reviewItem,
    transaction: txInput,
    context: clientContextFor(client, firm),
    materialityBands,
    ruleMaturity
  });
  return {
    kind: 'review_item',
    source_id: reviewItem.id,
    client_id: reviewItem.client_id,
    item_id: reviewItem.item_id,
    item_type: reviewItem.item_type,
    document_id: doc?.id ?? null,
    reason: reviewItem.reason ?? null,
    transaction_date: tx?.transaction_date ?? doc?.created_at ?? doc?.uploaded_at ?? null,
    amount: txInput?.amount ?? null,
    currency: tx?.currency ?? null,
    // No raw-reason fallback here: the renderer humanizes a missing
    // descriptor from `reason` (feedTitle) — duplicating the enum into
    // the descriptor was how it leaked to the screen twice.
    descriptor: txInput?.description ?? doc?.filename ?? null,
    counterparty: txInput?.counterparty ?? null,
    verdict
  };
};

// Within a bucket: blocks_close=true rises to the top (Kari and the
// backup feed both prioritise close-blocking work). Within a
// blocks_close tier, descending transaction_date — newest first, so
// fresh items don't get buried behind historical backlog.
const sortBucket = (items) => items.slice().sort((a, b) => {
  const ab = Boolean(a.verdict?.blocks_close);
  const bb = Boolean(b.verdict?.blocks_close);
  if (ab !== bb) return ab ? -1 : 1;
  const ad = a.transaction_date || '';
  const bd = b.transaction_date || '';
  if (ad === bd) return 0;
  return ad < bd ? 1 : -1;
});

const bandsForClient = (materialityBandsByClient, clientId) =>
  materialityBandsByClient?.[clientId] ?? DEFAULT_MATERIALITY_BANDS;

/**
 * Build a bucketed feed from a firm snapshot.
 *
 * @param {object} input
 * @param {object} [input.firm] - firm row (id, jurisdiction)
 * @param {Array}  [input.clients]
 * @param {Array}  [input.transactions]
 * @param {Array}  [input.reconciliationMatches]
 * @param {Array}  [input.transactionReviewQueue]
 * @param {Array}  [input.clientEvidenceRequests] - ask lane: OPEN requests
 *   become client_info_needed rows
 * @param {Array}  [input.askBatches] - ask lane: status='draft' batches
 *   become operator_blocker rows (the firm's move: review + send)
 * @param {object} [input.materialityBandsByClient] - per-client overrides
 * @param {string} [input.ruleMaturity] - reserved for Phase 5; Phase 2
 *   callers always pass 'none' (the default)
 * @param {string} [input.bucket] - optional filter to a single bucket
 * @param {string} [input.clientId] - optional filter to a single client
 * @returns {object} { buckets, bucket_order, totals, generated_at }
 */
export const buildFirmFeed = ({
  firm = null,
  clients = [],
  transactions = [],
  documents = [],
  reconciliationMatches = [],
  transactionReviewQueue = [],
  clientEvidenceRequests = [],
  askBatches = [],
  materialityBandsByClient = {},
  ruleMaturity = RULE_MATURITY.NONE,
  bucket = null,
  clientId = null
} = {}) => {
  if (bucket && !Object.prototype.hasOwnProperty.call(emptyBuckets(), bucket)) {
    throw new Error(`unknown bucket: ${bucket}`);
  }

  const transactionIndex = indexById(transactions);
  const documentIndex = indexById(documents);
  const clientIndex = indexById(clients);
  const buckets = emptyBuckets();

  // Ask lane first: the open requests claim their transactions, so the
  // review-queue pass below can suppress its thinner asked_client rows for
  // the same lines (one line, one inbox row — the ask carries the question).
  const askCoveredTransactionIds = new Set();
  const askCoveredRequestIds = new Set();
  for (const request of clientEvidenceRequests) {
    if (clientId && request.client_id !== clientId) continue;
    if (!['draft','open'].includes(String(request?.status || '').toLowerCase())) continue;
    askCoveredRequestIds.add(request.id);
    const item = buildFeedItemFromEvidenceRequest({
      request,
      transactionIndex,
      documentIndex,
      clientIndex,
      firm,
      materialityBands: bandsForClient(materialityBandsByClient, request.client_id)
    });
    buckets[item.verdict.disposition].push(item);
    if (request.transaction_id) askCoveredTransactionIds.add(request.transaction_id);
    for (const anchorId of request.request_payload?.anchor_transaction_ids || []) {
      if (anchorId) askCoveredTransactionIds.add(anchorId);
    }
  }

  // Draft batches surface as the firm's move while they exist — but per
  // Kari's 2026-08-07 call, drafting-for-review is the RARE lane: the
  // default is autonomous send (the firm-level auto_send_client_asks
  // setting), with manual drafts kept for the occasional message the firm
  // wants to originate or shape itself through the same channel.
  for (const batch of askBatches) {
    if (clientId && batch.client_id !== clientId) continue;
    if (String(batch?.status || '').toLowerCase() !== 'draft') continue;
    const item = buildFeedItemFromAskBatchDraft({ batch, clientIndex, firm });
    buckets[item.verdict.disposition].push(item);
  }

  for (const match of reconciliationMatches) {
    if (clientId && match.client_id !== clientId) continue;
    const item = buildFeedItemFromMatch({
      match,
      transactionIndex,
      clientIndex,
      firm,
      materialityBands: bandsForClient(materialityBandsByClient, match.client_id),
      ruleMaturity
    });
    buckets[item.verdict.disposition].push(item);
  }

  for (const reviewItem of transactionReviewQueue) {
    if (clientId && reviewItem.client_id !== clientId) continue;
    const item = buildFeedItemFromReview({
      reviewItem,
      transactionIndex,
      documentIndex,
      clientIndex,
      firm,
      materialityBands: bandsForClient(materialityBandsByClient, reviewItem.client_id),
      ruleMaturity
    });
    // A review row that landed in client_info_needed for a line an open
    // evidence request already covers is the same fact twice — the request
    // row (with the drafted question) wins.
    if (
      (item.verdict.disposition === CLOSE_DISPOSITIONS.CLIENT_INFO_NEEDED
        || askCoveredRequestIds.has(reviewItem.payload?.evidence_request?.id))
      && reviewItem.payload?.coding_correction_required?.status !== 'pending'
      && reviewItem.item_type === 'transaction'
      && askCoveredTransactionIds.has(reviewItem.item_id)
    ) continue;
    buckets[item.verdict.disposition].push(item);
  }

  // Document-derived work: parse failures only, for now. Unmatched
  // bills/receipts + client-reply surfacing land in follow-up PRs.
  for (const document of documents) {
    if (clientId && document.client_id !== clientId) continue;
    if (document.parse_status !== 'failed') continue;
    const item = buildFeedItemFromFailedParse({
      document,
      clientIndex,
      firm
    });
    buckets[item.verdict.disposition].push(item);
  }

  for (const k of Object.keys(buckets)) {
    buckets[k] = sortBucket(buckets[k]);
  }

  const totals = {};
  for (const k of Object.keys(buckets)) totals[k] = buckets[k].length;
  totals.blocks_close = Object.values(buckets)
    .flat()
    .filter((i) => i.verdict?.blocks_close)
    .length;

  const result = {
    buckets,
    bucket_order: BUCKET_ORDER,
    totals,
    generated_at: new Date().toISOString()
  };

  if (bucket) {
    return {
      ...result,
      buckets: { [bucket]: buckets[bucket] }
    };
  }
  return result;
};

export const FEED_BUCKET_ORDER = BUCKET_ORDER;
