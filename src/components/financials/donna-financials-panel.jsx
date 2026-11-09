// Donna Financials redesign — ports the design bundle's Reconcile workbench
// and now switches between real firm snapshot data and local demo fixtures.
//   - strip.jsx       → StatStrip + FinancialsTabs
//   - reconcile.jsx   → ReconcilePanel + GhostPicker + GroupChip + TxnRow + CategoryTag
//   - panels.jsx      → CashFlowPanel + CategoriesPanel + RecentPanel + ReconciledPanel
//   - data.jsx        → KPIS / RECONCILE / AI_GROUPS / TXNS / ALL_CATS / CASHFLOW / EXPENSE_CATS / RECENT
//
// Demo fixtures stay available only outside database mode. In database mode,
// empty financials must render honest empty states, never historical mock rows.

import { Fragment, useState, useMemo, useRef, useEffect, useCallback } from 'react';
import { useIntl } from 'react-intl';

import { BidiText, FormattedValue, IdentifierText } from '../../i18n/BidiText.jsx';
import { useInterfaceLocale } from '../../i18n/LocaleProvider.jsx';
import { T, D } from '../shared/design-tokens.js';
import { STACKED_STRIP_TOP } from '../shared/FilterPills.jsx';
import {
  BANK_FEED_AMOUNT_STYLE,
  BANK_FEED_DATE_STYLE,
  BANK_FEED_DOT_STYLE,
  BANK_FEED_EMPTY_STYLE,
  BANK_FEED_LIST_MEASURE,
  BANK_FEED_PRIMARY_STYLE,
  BANK_FEED_ROW_STYLE,
  BANK_FEED_SECTION_STYLE,
  BANK_FEED_SECTION_COUNT_STYLE,
  BANK_FEED_SECTION_HEADING_STYLE,
  BANK_FEED_TRAILING_CELL_STYLE,
  bankFeedPillStyle
} from '../shared/bank-feed-list-style.js';
import { monthKeyLabel, snapshotDayString, snapshotMonthKey } from '../shared/snapshot-dates.js';
import { feedTitle, reasonShorthand } from '../shared/feed-list.jsx';
import LedgerAuditDrawer from './donna-ledger-audit-drawer.jsx';
import { buildDocumentArtifactData } from './financials-view.jsx';
import { bankLineDispositionChip, selectMaterialOpenDocumentRows } from '../../lib/documentsInbox.js';
import { DocumentContextMenu, DocumentDeleteConfirmation } from '../documents/document-context-menu.jsx';
import AgingPanel from './aging-panel.jsx';
import { displayBankLineDescription } from '../../lib/bankLineDisplay.js';
import { buildAnnualReturnViewModel } from '../../lib/annualReturnView.js';
import { defaultAlvPeriodKey } from '../../lib/alvReturnView.js';
import { buildGbVatReturnViewModel } from '../../lib/gbVatReturnView.js';
import { buildPeriodOverview, buildPeriodStream, periodSummaryLabel, streamEntryState, streamEntryPhase, expireProcessingActivity, activityBatchSummaries, activityBatchSummaryParts, WORKING_PHASES } from '../../lib/periodOverview.js';
import { buildGbStatutoryViewModel, selectGbStatutoryAttention } from '../../lib/gbStatutoryView.js';
import AlvReturnPanel from './alv-return-panel.jsx';
import {
  getReviewState,
  buildAcceptedPatch
} from '../../lib/review-state.js';
// Orchestration helpers — used by the BE-wired call site this surface will
// switch to. Imported here so the debug trace can show the exact call shapes
// (and to flag any future signature drift at module-eval time).
import {
  createClientEvidenceRequest,
  dismissFirmFact,
  dismissMemoryCandidate,
  fetchFinlandAlvReturn,
  fetchGbVatReturn,
  fetchGbStatutory,
  fetchGbLtdClose,
  fetchFinlandSuomifiMandate,
  fetchFinlandAlvThresholdWatch,
  fetchFinlandScopeDrift,
  fetchFinlandYelStatus,
  fetchFinlandEnnakkoveroStatus,
  fetchFinlandIssuedInvoices,
  fetchFinlandQuotes,
  fetchFinlandPrepaymentRegister,
  fetchFinlandAnnualReturn,
  fetchFeedEvents,
  fetchFirmSnapshot,
  fetchFirmDocumentDownload,
  fetchFirmFacts,
  fetchFirmTransactionChatUnreadSummary,
  fetchLedgerAuditTrail,
  fetchXeroStatus,
  formatFirmError,
  promoteMemoryCandidate,
  setTransactionReviewItemState,
  writebackXeroTransaction,
  writebackXeroTransactions
} from '../../lib/firmApi.js';
import {
  computeUnreadTransactionIds,
  markTransactionChatSeen,
  readLastSeenMap
} from '../../lib/chatLastSeen.js';
import {
  RECEIPT_SUCCESS_TTL_MS,
  foldApplyOutcomeIntoReceipts,
  foldFeedEventsIntoReceipts,
  hasFeedChanges,
  pruneReceipts
} from '../../lib/feedEventsTick.js';

// ── Live row helpers ─────────────────────────────────────────────────────────

// The trailing pill is the row's STATE, read off the persisted convergence
// verdict via streamEntryState (Kari, 2026-09-01: "pills on the right should
// be allocated for an item's state"). Reconciled is the quiet default so the
// exceptional states pop; stalled is the two-terminal-states violation pill
// and speaks in the alert voice.
const STREAM_STATE_PILLS = {
  needs_input: { labelId: 'lifecycle.needsInput', voice: 'warm' },
  processing: { labelId: 'lifecycle.processing', voice: 'muted' },
  stalled: { labelId: 'lifecycle.stalled', voice: 'alert' },
  review_only: { labelId: 'lifecycle.reviewOnly', voice: 'warm' },
  reconciled: { labelId: 'lifecycle.reconciled', voice: 'muted' },
  no_settlement: { labelId: 'lifecycle.noSettlementInScope', voice: 'muted' }
};

// A Processing pill names its row's own phase when the projection receipt
// carries one (Coding, Waiting for evidence, Posting…); otherwise it reads
// plain Processing.
function StreamStatePill({ state, title = undefined, phase = null }) {
  const intl = useIntl();
  const base = STREAM_STATE_PILLS[state] || STREAM_STATE_PILLS.processing;
  const meta = state === 'processing' && WORKING_PHASES[phase] ? { ...base, labelId: WORKING_PHASES[phase] } : base;
  return (
    <span title={title} style={{ ...bankFeedPillStyle(meta.voice), ...(['no_settlement', 'review_only'].includes(state) ? {
      minWidth: 0, maxWidth: '100%', boxSizing: 'border-box', whiteSpace: 'normal',
      overflowWrap: 'anywhere', textAlign: 'end', lineHeight: 1.25, borderRadius: 10
    } : {}) }}>
      <span className={state === 'processing' ? 'processing-label' : undefined}><BidiText direction="auto">{intl.formatMessage({ id: meta.labelId })}</BidiText></span>
    </span>
  );
}

export const GbStatutoryRows = ({ view }) => {
  const intl = useIntl();
  return view?.deadlines?.map((deadline) => (
    <div key={deadline.key} data-terminal={deadline.terminal || undefined}>
      <BidiText direction="auto">{deadline.label}: {deadline.dueDate || intl.formatMessage({ id: 'mounted.financial.onYouReason' }, { reason: deadline.reasonCode })}</BidiText>
    </div>
  )) || null;
};

const formatTxDate = (input, formatDate) => {
  if (!input) return '';
  const parsed = new Date(typeof input === 'number' ? input : Date.parse(input));
  if (Number.isNaN(parsed.getTime())) return String(input).slice(0, 10);
  return formatDate(parsed.toISOString().slice(0, 10), { year: undefined, month: 'short', day: '2-digit' });
};

const formatTxAmount = (tx, formatAmount) => {
  const ccy = tx.account_currency || tx.ledger_currency || 'EUR';
  const direction = tx.direction || (Number(tx.money_in) > 0 ? 'money_in' : 'money_out');
  const isIn = direction === 'money_in';
  const value = Math.abs(Number(isIn ? tx.money_in : tx.money_out) || Number(tx.amount) || 0);
  const formatted = formatAmount(value, {
    currency: ccy,
    minimumFractionDigits: value % 1 ? 2 : 0,
    maximumFractionDigits: 2,
    negativeStyle: 'minus'
  });
  return `${isIn ? '+' : '−'}${formatted}`;
};

const periodRowTransactionId = (row) =>
  row?.transactionId
  || row?.transaction_id
  || (row?.kind === 'review_item' && row?.item_type === 'transaction' ? row?.item_id : null)
  || null;

const periodRowIdentity = (row) =>
  row?.id
  || periodRowTransactionId(row)
  || row?.document_id
  || (row?.kind === 'review_item' && row?.item_type === 'document' ? row?.item_id : null)
  || row?.source_id;

const formatEvidenceAmount = (amount, currency = 'EUR', formatAmount, fallback = '') => {
  const numeric = Number(amount);
  if (!Number.isFinite(numeric)) return currency || fallback;
  return formatAmount(Math.abs(numeric), {
    currency: currency || 'EUR',
    minimumFractionDigits: Math.abs(numeric) % 1 ? 2 : 0,
    maximumFractionDigits: 2,
    negativeStyle: 'minus'
  });
};

const confidenceBucket = (score) => {
  const n = Number(score);
  if (Number.isNaN(n)) return 'medium';
  if (n >= 0.7) return 'high';
  if (n >= 0.4) return 'medium';
  return 'low';
};

const docStatusFor = (tx) => {
  const recon = tx?.reconciliation_status || tx?.support_status;
  if (!recon || /unmatched|missing/i.test(recon)) return 'uncat';
  return 'nodoc';
};

// Joins a transaction-review item with the matching transaction row, returning
// the row shape TxnRow already renders. Items without a resolvable transaction
// drop out (defensive — the snapshot can outpace the FE schema).
// The coder's verdict may sit under any of the three keys — proposed_account
// (the coding batch), account_name / account_code (accept and post patches).
// Every server-side reader resolves this triple (caseTimeline.fromAiSuggestion,
// codingAutoPost); a surface reading only one key renders the parse-time
// fossil for a line the books already coded — the land-lease "Suspense" pill.
const aiSuggestionAccount = (suggestion) =>
  suggestion?.proposed_account || suggestion?.account_name || suggestion?.account_code || null;

const buildLiveRow = (item, txByid, { formatAmount, formatDate }) => {
  if (!item) return null;
  const txId = item.payload?.transaction_id || item.item_id;
  const tx = txByid.get(txId);
  if (!tx) return null;
  // The batch coder's persisted verdict (payload.ai_suggestion) outranks the
  // parse-time bank-line classifier's category — the chip and the expanded
  // picker default must render what the strong model said, not the legacy
  // layer it superseded. No verdict anywhere renders as missing ("Needs
  // category"), never a fabricated 'Suspense' claim.
  const aiSuggestion = item.payload?.ai_suggestion || tx.ai_suggestion || null;
  const aiCat =
    aiSuggestionAccount(aiSuggestion) ||
    item.payload?.category ||
    item.payload?.proposed_account ||
    tx.proposed_account ||
    tx.category ||
    null;
  // The coder's "this account doesn't exist in the chart" flag — a
  // firm-side CoA action, rendered so the parked line explains itself.
  const missingAccount = aiSuggestion?.missing_account || null;
  // The resolved counterpart: the pipeline created the verdict-named
  // account in the Donna chart and re-pointed the suggestion at it.
  const missingAccountResolved = aiSuggestion?.missing_account_resolved || null;
  const reviewState = getReviewState(item) || tx.review_state || 'suggested';
  // Xero identity is mirror metadata only; it must never override Donna's
  // primary review lifecycle.
  const xeroBankTransactionId =
    item.payload?.xero_bank_transaction_id ||
    item.payload?.xeroBankTransactionId ||
    tx.xero_bank_transaction_id ||
    tx.xeroBankTransactionId ||
    null;
  const synced = reviewState === 'synced';
  // Surface the mirror fields for the artifact and writeback lifecycle without
  // making provider mechanics a permanent bank-feed column. Tolerates either casing.
  const xeroWritebackStatus =
    item.payload?.xero_writeback_status ||
    item.payload?.xeroWritebackStatus ||
    tx.xero_writeback_status ||
    tx.xeroWritebackStatus ||
    null;
  const xeroWritebackError =
    item.payload?.xero_writeback_error ||
    item.payload?.last_writeback_error ||
    tx.xero_writeback_error ||
    tx.last_writeback_error ||
    null;
  const xeroWritebackErrorCode =
    item.payload?.xero_writeback_error_code ||
    item.payload?.last_writeback_error_code ||
    tx.xero_writeback_error_code ||
    tx.last_writeback_error_code ||
    null;
  return {
    id: tx.id,
    reviewItemId: item.id,
    transactionId: tx.id,
    date: formatTxDate(tx.date || item.created_at, formatDate),
    desc: displayBankLineDescription(tx),
    amount: formatTxAmount(tx, formatAmount),
    aiCat,
    // The confirmed category for a DECIDED row is the persisted verdict — the
    // POSTED account (account_name/account_code), then the coder's suggestion —
    // NOT the parse-time `category`/`auto_categorized` fossil, which the apply
    // path never updates. A line applied as Owner A Share Capital rendered
    // "income" because that fossil short-circuited ahead of the books. Render the
    // persisted verdict, not the legacy layer. Suggested rows carry no confirmed
    // category (cat=null) and fall through to the aiCat suggestion chip.
    cat: reviewState !== 'suggested'
      ? (tx.account_name
         || tx.account_code
         || aiSuggestionAccount(aiSuggestion)
         || (tx.category && tx.category !== 'unknown' ? tx.category : null))
      : null,
    confidence: confidenceBucket(item.payload?.confidence_score ?? tx.confidence_score),
    status: docStatusFor(tx),
    missingAccount,
    missingAccountResolved,
    review_state: reviewState,
    xero_bank_transaction_id: xeroBankTransactionId,
    xero_writeback_status: xeroWritebackStatus,
    xero_writeback_error: xeroWritebackError,
    xero_writeback_error_code: xeroWritebackErrorCode,
    synced,
    group: null,
    // The persisted convergence verdict rides the row so the state pill can
    // render it (streamEntryState) — the item's verdict first, then the
    // transaction's; never re-derived in the FE.
    convergence_state: item.convergence_state ?? tx.convergence_state ?? null,
    convergence_reason: item.convergence_reason ?? tx.convergence_reason ?? null,
    processing_scope: tx.processing_scope ?? item.processing_scope ?? null,
    projection_freshness: tx.projection_freshness ?? item.projection_freshness ?? null,
    processing_activity: tx.processing_activity ?? null,
    // Stash the item + tx for handlers (so we don't have to re-look-up on click).
    _item: item,
    _tx: tx
  };
};

// Visible states on the Reconcile list. Resolved/synced are kept on-list so
// the accountant can see which rows are done. The legacy `status` filter
// (open/closed/dismissed) is the gate for whether a row is on the queue at
// all — handled in the caller.
const VISIBLE_REVIEW_STATES = new Set([
  'suggested',
  'accepted',
  'asked_client',
  'waiting',
  'resolved',
  'synced'
]);

const NEEDS_ATTENTION_STATES = new Set(['suggested', 'asked_client', 'waiting']);
const RECONCILED_STATES = new Set(['accepted', 'resolved', 'synced']);
// The on_owner terminal — items resting on the OWNER (Client asks). Legacy
// fallback for pre-convergence snapshots: an asked/waiting review state.
const ON_OWNER_STATES = new Set(['asked_client', 'waiting']);

// Count the review-queue items whose persisted convergence verdict is on_owner
// — the Client-asks badge source. Mirrors needsAttentionItems exactly (same
// status/document_line gates, same "render the verdict, legacy fallback only
// pre-convergence" rule) so that hanging (Open) + on_owner (Client asks) +
// auto_reconciled (Reconciled) partition the feed and the three badges sum to
// the statement's item count.
const onOwnerItems = (items = []) =>
  (Array.isArray(items) ? items : []).filter((item) => {
    if (item?.status && item.status !== 'open') return false;
    if (item?.item_type === 'document_line') return false;
    const conv = item?.convergence_state;
    if (conv) return conv === 'on_owner';
    const rs = getReviewState(item) || 'suggested';
    return ON_OWNER_STATES.has(rs);
  });

// The single definition of "a queue item the Reconcile list renders" —
// the tab badge MUST count through this same filter (+ the buildLiveRow
// tx-join) or the badge and the list drift apart, e.g. document_line
// items: counted 61, rendered 16. document_line rows are surfaced in the
// Documents inbox, not on the bank feed (see the PR-3 note below).
const needsAttentionItems = (items = []) =>
  (Array.isArray(items) ? items : []).filter((item) => {
    if (item?.status && item.status !== 'open') return false;
    if (item?.item_type === 'document_line') return false;
    // Render the persisted convergence verdict, not the legacy review_state
    // sets (CLAUDE.md, the first principle). The Reconcile list is the
    // VIOLATION surface: only 'hanging' rows are open work — on_owner
    // (asked/waiting) belongs in Client asks, auto_reconciled in Reconciled.
    // Fall back to the legacy set only when the snapshot predates
    // convergence_state (mock / seed mode).
    const conv = item?.convergence_state;
    if (conv) return conv === 'hanging';
    const rs = getReviewState(item) || 'suggested';
    return NEEDS_ATTENTION_STATES.has(rs);
  });

// Most doc-matched lines never get a review-queue row (or the match
// cascade closed it), so their terminal verdict lives on the transaction
// row itself (`reconciliation_status`) and the match rows — render the
// persisted verdict, don't infer "done" from queue membership. Maps a
// bare transaction into the row shape ReconciledPanel renders.
const transactionToReconciledRow = (tx, { formatAmount, formatDate }) => ({
  id: tx.id,
  transactionId: tx.id,
  date: formatTxDate(tx.date, formatDate),
  desc: displayBankLineDescription(tx),
  amount: formatTxAmount(tx, formatAmount),
  aiCat: aiSuggestionAccount(tx.ai_suggestion) || (tx.category && tx.category !== 'unknown' ? tx.category : null),
  // Posted account first, then the coder's verdict (the full triple —
  // reading only proposed_account here rendered a Rent-coded line as the
  // parse-time 'Suspense' fossil); these rows are terminal (reconciled/
  // explained). See buildLiveRow.
  cat: tx.account_name
    || tx.account_code
    || aiSuggestionAccount(tx.ai_suggestion)
    || (tx.category && tx.category !== 'unknown' ? tx.category : null),
  status: docStatusFor(tx),
  synced: false,
  group: null,
  convergence_state: tx.convergence_state ?? null,
  convergence_reason: tx.convergence_reason ?? null,
  processing_scope: tx.processing_scope ?? null,
  projection_freshness: tx.projection_freshness ?? null,
  processing_activity: tx.processing_activity ?? null,
  _tx: tx
});

// Bare transactions (no OPEN review-queue row) partitioned by the convergence
// verdict the feed attached (firmDb attaches convergence_state to every tx, not
// only review items). Doc-matched bank lines mostly never get a queue row, so
// their reconcile-tab membership lives on the transaction — and it MUST honour
// the same projection the review-item paths do, or a matched-but-uncoded
// (Suspense) line leaks into Reconciled when it is actually `hanging` (Leak C).
// Only acts on the verdict when present (DB mode); a pre-convergence_state
// snapshot (mock / seed) keeps the legacy reconciliation_status split so those
// modes are unchanged — and routes nothing bare into Reconcile (the legacy
// surface only ever had review-item rows there).
const partitionBareReconcileTxs = (reviewItems = [], transactions = []) => {
  const queueTxIds = new Set();
  for (const item of Array.isArray(reviewItems) ? reviewItems : []) {
    if (item?.item_type === 'document_line') continue;
    if (item?.status && item.status !== 'open') continue;
    const txId = item.payload?.transaction_id || item.item_id;
    if (txId) queueTxIds.add(txId);
  }
  const hanging = [];
  const reconciled = [];
  const onOwner = [];
  for (const tx of Array.isArray(transactions) ? transactions : []) {
    if (!tx || queueTxIds.has(tx.id)) continue;
    const conv = tx.convergence_state;
    if (conv) {
      if (conv === 'hanging') hanging.push(tx);
      else if (conv === 'auto_reconciled') reconciled.push(tx);
      else if (conv === 'on_owner') onOwner.push(tx); // Client asks — waiting on the owner.
    } else if (
      tx.reconciliation_status === 'reconciled'
      || tx.reconciliation_status === 'explained'
      || tx.reconciliation_status === 'posted'
      || tx.reconciliation_status === 'auto_reconciled'
    ) {
      reconciled.push(tx); // legacy fallback (no verdict): prior Reconciled set
    }
  }
  const byDateDesc = (a, b) => String(b.date || '').localeCompare(String(a.date || ''));
  return {
    hanging: hanging.sort(byDateDesc),
    reconciled: reconciled.sort(byDateDesc),
    onOwner: onOwner.sort(byDateDesc)
  };
};

// Map writeback errors to user-facing copy. Codes Codex documented:
//   XERO_WRITEBACK_AMBIGUOUS_MATCH — multiple matching Xero rows
//   ALREADY_SYNCED                 — 409, treat as success after refresh
const formatWritebackError = (errorOrResult, message) => {
  if (!errorOrResult) return null;
  const code = errorOrResult.error_code || errorOrResult.code || errorOrResult.status;
  const detail = errorOrResult.error || errorOrResult.message;
  if (code === 'XERO_WRITEBACK_AMBIGUOUS_MATCH') {
    return formatFirmError(errorOrResult);
  }
  if (code === 'ALREADY_SYNCED' || code === 409 || code === '409') {
    return message('mounted.financial.writeback.alreadyPosted');
  }
  return formatFirmError(
    { ...errorOrResult, message: detail },
    message('mounted.financial.writeback.failed')
  );
};

// Pull the per-row results array out of either response shape Codex described.
const extractBatchResults = (response) => {
  if (!response) return [];
  return (
    response.xero_writeback_batch?.results ||
    response.results ||
    response.xeroWritebackBatch?.results ||
    []
  );
};

// Convert a Xero account from the snapshot into the picker's account shape.
// Snapshot accounts use Xero-native casing (Code / Name / TaxType / AccountID
// or code/name/tax_type depending on normaliser); accept either.
const normaliseXeroAccount = (a) => {
  if (!a) return null;
  const code = a.code ?? a.Code ?? a.account_code ?? null;
  const name = a.name ?? a.Name ?? a.account_name ?? null;
  if (!name) return null;
  const taxType = a.tax_type ?? a.TaxType ?? a.xero_tax_type ?? null;
  const id = a.xero_account_id ?? a.id ?? a.AccountID ?? null;
  const group = a.type ?? a.Type ?? a.group ?? a.account_class ?? 'Other';
  return {
    code: code ? String(code) : '',
    name: String(name),
    label: code ? `${code} · ${name}` : String(name),
    xero_account_id: id,
    tax_type: taxType,
    group: typeof group === 'string' ? group : 'Other'
  };
};

// ── Mock data (verbatim from workspace/data.jsx) ──────────────────────────────

const KPIS = [
  { labelId: 'mounted.financial.demo.cashOnHand', value: 'EUR 412,910', subId: 'mounted.financial.demo.cashOnHandSub' },
  { labelId: 'mounted.financial.demo.netTwelveMonths', value: '+EUR 86,420', subId: 'mounted.financial.demo.netTwelveMonthsSub' },
  { labelId: 'mounted.financial.demo.openToReconcile', value: '66', subId: 'mounted.financial.demo.openToReconcileSub', alert: true },
  { labelId: 'mounted.financial.demo.filingWindow', value: 'Q3 / 38 days', subId: 'mounted.financial.demo.filingWindowSub' }
];

const RECONCILE_COUNTS = { open: 66, done: 487 };

const AI_GROUPS = [
  {
    id: 'g1',
    titleId: 'mounted.financial.demo.group.directorCard',
    items: 9,
    catId: 'mounted.financial.demo.category.suspense',
    conf: 'low',
    confId: 'mounted.financial.confidence.low',
    qId: 'mounted.financial.demo.question.directorCard'
  },
  {
    id: 'g2',
    titleId: 'mounted.financial.demo.group.aws',
    items: 14,
    catId: 'mounted.financial.demo.category.software',
    conf: 'high',
    confId: 'mounted.financial.confidence.high',
    qId: 'mounted.financial.demo.question.aws'
  },
  {
    id: 'g3',
    titleId: 'mounted.financial.demo.group.stripe',
    items: 11,
    catId: 'mounted.financial.demo.category.salesIncome',
    conf: 'high',
    confId: 'mounted.financial.confidence.high',
    qId: 'mounted.financial.demo.question.stripe'
  },
  {
    id: 'g4',
    titleId: 'mounted.financial.demo.group.cashWithdrawals',
    items: 6,
    catId: 'mounted.financial.demo.category.suspense',
    conf: 'low',
    confId: 'mounted.financial.confidence.low',
    qId: 'mounted.financial.demo.question.cashWithdrawals'
  },
  {
    id: 'g5',
    titleId: 'mounted.financial.demo.group.intercompany',
    items: 4,
    catId: 'mounted.financial.demo.category.relatedPartyLoan',
    conf: 'medium',
    confId: 'mounted.financial.confidence.medium',
    qId: 'mounted.financial.demo.question.intercompany'
  },
  {
    id: 'g6',
    titleId: 'mounted.financial.demo.group.hotel',
    items: 3,
    catId: 'mounted.financial.demo.category.travel',
    conf: 'medium',
    confId: 'mounted.financial.confidence.medium',
    qId: 'mounted.financial.demo.question.hotel'
  }
];

// `status` here is the legacy doc-state axis (uncategorized vs missing-doc).
// `review_state` is the canonical workflow axis owned by the backend
// (suggested → accepted / waiting / resolved / synced). Both are rendered.
const TXNS = [
  { id: 't1', date: '29 Oct', desc: 'AMAZON WEB SERVICES, EMEA SARL — DUBLIN, IRL', amount: '−EUR 1,284.00', aiCat: 'IT & software', confidence: 'high', status: 'nodoc', group: 'g2', review_state: 'suggested' },
  { id: 't2', date: '27 Oct', desc: 'STRIPE PAYOUTS — REF 8821049', amount: '+EUR 4,860.20', aiCat: 'Sales income', confidence: 'high', status: 'nodoc', group: 'g3', review_state: 'suggested' },
  { id: 't3', date: '24 Oct', desc: 'TRANSFER TO NORTHWIND STUDIO LTD — IBAN GB29...', amount: '−EUR 9,500.00', aiCat: 'Related-party loan', confidence: 'medium', status: 'uncat', group: 'g5', review_state: 'suggested' },
  { id: 't4', date: '22 Oct', desc: 'CITY GYM, LISBON, PRT, (Demo, **1111): EUR 186.40 Card', amount: '−EUR 186.40', aiCat: 'Suspense', confidence: 'low', status: 'uncat', group: 'g1', review_state: 'suggested' },
  { id: 't5', date: '20 Oct', desc: 'ATM MULTIBANCO — AVENIDA CENTRAL, ATM 007731', amount: '−EUR 300.00', aiCat: 'Suspense', confidence: 'low', status: 'uncat', group: 'g4', review_state: 'waiting' },
  { id: 't6', date: '17 Oct', desc: 'HOTEL CENTRAL PORTO — 15 OCT CHECKOUT', amount: '−EUR 615.30', aiCat: 'Travel', confidence: 'medium', status: 'nodoc', group: 'g6', review_state: 'suggested' },
  { id: 't7', date: '15 Oct', desc: 'GOOGLE WORKSPACE — SUBSCRIPTION', amount: '−EUR 64.80', aiCat: 'IT & software', confidence: 'high', status: 'nodoc', group: 'g2', review_state: 'accepted' },
  { id: 't8', date: '13 Oct', desc: 'STRIPE PAYOUTS — REF 8819982', amount: '+EUR 3,210.00', aiCat: 'Sales income', confidence: 'high', status: 'nodoc', group: 'g3', review_state: 'synced' },
  { id: 't9', date: '10 Oct', desc: 'CITY GYM, LISBON, PRT (Demo, **1111): EUR 79.90 Card', amount: '−EUR 79.90', aiCat: 'Suspense', confidence: 'low', status: 'uncat', group: 'g1', review_state: 'suggested' },
  { id: 't10', date: '08 Oct', desc: 'TRANSFER TO NORTHWIND STUDIO LTD — IBAN GB29...', amount: '−EUR 3,750.00', aiCat: 'Related-party loan', confidence: 'medium', status: 'uncat', group: 'g5', review_state: 'suggested' },
  { id: 't11', date: '06 Oct', desc: 'ATM MULTIBANCO — RUA NOVA 12', amount: '−EUR 250.00', aiCat: 'Suspense', confidence: 'low', status: 'uncat', group: 'g4', review_state: 'suggested' },
  { id: 't12', date: '02 Oct', desc: 'AMAZON WEB SERVICES — REF EU-IRL-998127', amount: '−EUR 1,284.00', aiCat: 'IT & software', confidence: 'high', status: 'nodoc', group: 'g2', review_state: 'accepted' }
];

// Mock Xero chart-of-accounts. Shape mirrors the canonical BE/Xero identity
// — code + name + xero_account_id + tax_type — so the Apply patch carries
// the full account identity, not just a display name. When live Xero
// reference data arrives via /api/donna/firms/xero/status, swap this list
// for that response (it shares the same key shape).
const ALL_CATS = [
  { code: '420', name: 'Travel', group: 'Operating', xero_account_id: 'xa-420', tax_type: 'INPUT' },
  { code: '420.1', name: 'Meals and entertainment', group: 'Operating', xero_account_id: 'xa-420-1', tax_type: 'INPUT' },
  { code: '453', name: 'Office expenses', group: 'Operating', xero_account_id: 'xa-453', tax_type: 'INPUT' },
  { code: '485', name: 'IT & software', group: 'Operating', xero_account_id: 'xa-485', tax_type: 'INPUT' },
  { code: '498', name: 'Marketing & advertising', group: 'Operating', xero_account_id: 'xa-498', tax_type: 'INPUT' },
  { code: '441', name: 'Professional services', group: 'Operating', xero_account_id: 'xa-441', tax_type: 'INPUT' },
  { code: '469', name: 'Rent & utilities', group: 'Operating', xero_account_id: 'xa-469', tax_type: 'INPUT' },
  { code: '489', name: 'Telephone & internet', group: 'Operating', xero_account_id: 'xa-489', tax_type: 'INPUT' },
  { code: '433', name: 'Insurance', group: 'Operating', xero_account_id: 'xa-433', tax_type: 'NONE' },
  { code: '404', name: 'Bank fees', group: 'Operating', xero_account_id: 'xa-404', tax_type: 'NONE' },
  { code: '485.1', name: 'Subscriptions', group: 'Operating', xero_account_id: 'xa-485-1', tax_type: 'INPUT' },
  { code: '473', name: 'Repairs & maintenance', group: 'Operating', xero_account_id: 'xa-473', tax_type: 'INPUT' },
  { code: '200', name: 'Sales income', group: 'Income', xero_account_id: 'xa-200', tax_type: 'OUTPUT' },
  { code: '260', name: 'Other income', group: 'Income', xero_account_id: 'xa-260', tax_type: 'OUTPUT' },
  { code: '270', name: 'Interest income', group: 'Income', xero_account_id: 'xa-270', tax_type: 'NONE' },
  { code: '850', name: 'Suspense', group: 'Balance sheet', xero_account_id: 'xa-850', tax_type: 'NONE' },
  { code: '825', name: 'Director loan account', group: 'Balance sheet', xero_account_id: 'xa-825', tax_type: 'NONE' },
  { code: '835', name: 'Owner drawings', group: 'Balance sheet', xero_account_id: 'xa-835', tax_type: 'NONE' },
  { code: '826', name: 'Related-party loan', group: 'Balance sheet', xero_account_id: 'xa-826', tax_type: 'NONE' },
  { code: '880', name: 'Capital contribution', group: 'Balance sheet', xero_account_id: 'xa-880', tax_type: 'NONE' },
  { code: '710', name: 'Fixed assets', group: 'Balance sheet', xero_account_id: 'xa-710', tax_type: 'NONE' },
  { code: '811', name: 'VAT input', group: 'Tax', xero_account_id: 'xa-811', tax_type: 'NONE' },
  { code: '820', name: 'VAT output', group: 'Tax', xero_account_id: 'xa-820', tax_type: 'NONE' },
  { code: '477', name: 'Payroll', group: 'Payroll', xero_account_id: 'xa-477', tax_type: 'NONE' },
  { code: '478', name: 'Payroll taxes', group: 'Payroll', xero_account_id: 'xa-478', tax_type: 'NONE' }
].map((a) => ({ ...a, label: `${a.code} · ${a.name}` }));

const CASHFLOW = [
  { m: 'May 25', inc: 38400, exp: 31200, net: 7200, bal: 281000 },
  { m: 'Jun 25', inc: 41200, exp: 29800, net: 11400, bal: 292400 },
  { m: 'Jul 25', inc: 47800, exp: 36400, net: 11400, bal: 303800 },
  { m: 'Aug 25', inc: 52600, exp: 39200, net: 13400, bal: 317200 },
  { m: 'Sep 25', inc: 49100, exp: 41800, net: 7300, bal: 324500 },
  { m: 'Oct 25', inc: 56200, exp: 44100, net: 12100, bal: 336600 },
  { m: 'Nov 25', inc: 51800, exp: 38900, net: 12900, bal: 349500 },
  { m: 'Dec 25', inc: 62400, exp: 52800, net: 9600, bal: 359100 },
  { m: 'Jan 26', inc: 44600, exp: 41200, net: 3400, bal: 362500 },
  { m: 'Feb 26', inc: 48200, exp: 39800, net: 8400, bal: 370900 },
  { m: 'Mar 26', inc: 53700, exp: 42100, net: 11600, bal: 382500 },
  { m: 'Apr 26', inc: 56800, exp: 44600, net: 12200, bal: 394700 },
  { m: 'May 26', inc: 41200, exp: 22990, net: 18210, bal: 412910 }
];

const EXPENSE_CATS = [
  { name: 'IT & software', total: 142400, pct: 27, txns: 86 },
  { name: 'Professional services', total: 96200, pct: 18, txns: 42 },
  { name: 'Travel', total: 68400, pct: 13, txns: 64 },
  { name: 'Rent & utilities', total: 54000, pct: 10, txns: 14 },
  { name: 'Marketing & advertising', total: 41800, pct: 8, txns: 38 },
  { name: 'Meals and entertainment', total: 28200, pct: 5, txns: 71 },
  { name: 'Office expenses', total: 19200, pct: 4, txns: 22 },
  { name: 'Bank fees', total: 4200, pct: 1, txns: 48 },
  { name: 'Unknown', total: 71800, pct: 14, txns: 66 }
];

const RECENT = [
  { d: '29 Oct', desc: 'AMAZON WEB SERVICES, EMEA SARL', cat: 'IT & software', amt: '−EUR 1,284.00' },
  { d: '27 Oct', desc: 'STRIPE PAYOUTS — REF 8821049', cat: 'Income', amt: '+EUR 4,860.20' },
  { d: '24 Oct', desc: 'TRANSFER TO NORTHWIND STUDIO LTD', cat: 'Related-party loan', amt: '−EUR 9,500.00' },
  { d: '22 Oct', desc: 'CITY GYM, LISBON, PRT', cat: 'Unknown', amt: '−EUR 186.40' },
  { d: '20 Oct', desc: 'ATM MULTIBANCO — AVENIDA CENTRAL', cat: 'Unknown', amt: '−EUR 300.00' },
  { d: '17 Oct', desc: 'HOTEL CENTRAL PORTO', cat: 'Travel', amt: '−EUR 615.30' },
  { d: '15 Oct', desc: 'GOOGLE WORKSPACE', cat: 'IT & software', amt: '−EUR 64.80' },
  { d: '13 Oct', desc: 'STRIPE PAYOUTS — REF 8819982', cat: 'Income', amt: '+EUR 3,210.00' },
  { d: '10 Oct', desc: 'CITY GYM, LISBON, PRT', cat: 'Unknown', amt: '−EUR 79.90' },
  { d: '08 Oct', desc: 'TRANSFER TO NORTHWIND STUDIO LTD', cat: 'Related-party loan', amt: '−EUR 3,750.00' },
  { d: '06 Oct', desc: 'ATM MULTIBANCO', cat: 'Unknown', amt: '−EUR 250.00' },
  { d: '02 Oct', desc: 'NOTARY OFFICE — INVOICE 2025-118', cat: 'Professional services', amt: '−EUR 980.00' }
];

// ── Income/expense colour helpers ─────────────────────────────────────────────

const incomeColor = T.ok;
const expenseColor = T.alert;

const kbdStyle = {
  fontFamily: T.mono,
  fontSize: 10,
  background: 'rgba(26,24,21,0.08)',
  padding: '1px 5px',
  borderRadius: 3,
  color: T.inkSoft
};

// ── Stat strip + financials sub-tabs (ports strip.jsx) ───────────────────────

function StatStrip({
  databaseMode = false,
  reviewItems = [],
  ledgerJournals = []
} = {}) {
  const intl = useIntl();
  // Database mode renders NO stat banner (Kari, 2026-08-07: "we don't
  // really need it") — the honest numbers already live on the tab badges
  // (Bank feed count, Open/Reconciled counts), so the "Ready to post /
  // Posted journals" cards said nothing the strip below doesn't. The
  // mock demo lane keeps its KPI cards.
  const cards = databaseMode ? [] : KPIS;

  if (!cards.length) return null;

  return (
    <div
      style={{
        padding: '20px 0',
        display: 'grid',
        gridTemplateColumns: `repeat(${Math.max(cards.length, 1)}, 1fr)`,
        gap: 0,
        borderBottom: `1px solid ${T.ruleSoft}`
      }}
    >
      {cards.map((k, i) => (
        <div
          key={k.labelId}
          style={{
            padding: '6px 22px',
            borderInlineStart: i === 0 ? 'none' : `1px solid ${T.ruleMicro}`,
            display: 'flex',
            flexDirection: 'column',
            gap: 4
          }}
        >
          <div style={{ fontSize: 11.5, color: T.muted, letterSpacing: '0.01em' }}>{intl.formatMessage({ id: k.labelId })}</div>
          <div
            style={{
              fontSize: 18,
              fontWeight: 500,
              color: k.alert ? T.alert : T.ink,
              letterSpacing: '-0.01em',
              ...D.tabular
            }}
          >
            <FormattedValue>{k.value}</FormattedValue>
          </div>
          <div style={{ fontSize: 11, color: T.mutedSoft }}>{intl.formatMessage({ id: k.subId })}</div>
        </div>
      ))}
    </div>
  );
}

// The overview already carries open and reconciled work. This registration is
// deliberately narrow: one operational read plus real statutory returns.
function FinancialsTabs({ tab, setTab, databaseMode = false, annualReturnAvailable = false, alvReturnAvailable = false, onRegisterViewMenu = null }) {
  const intl = useIntl();
  // The Open/Reconciled SWITCH IS GONE (Kari, 2026-08-08). The feed now
  // renders both states in one scroll — open on top, reconciled below — so
  // the day's movements are read by scrolling, not by remembering which
  // half you are looking at.
  //
  // What remains here is the ⋯ registration: governance/read surfaces stay
  // behind the entity toolbar's single overflow menu (Kari, 2026-08-07).
  // This component therefore renders NOTHING — it is a registration hook.
  const menuTabs = [
    ...(databaseMode
      ? [
          // FI-12 read surface — only when the FINLAND_ANNUAL_RETURN-gated fetch
          // returned an envelope (flag off / non-Finland ⇒ the tab never exists;
          // prod is byte-identical). docs/design-donna-finland-fi12-read-surface.md
          ...(annualReturnAvailable
            ? [{ id: 'veroilmoitus', label: intl.formatMessage({ id: 'mounted.financial.tabs.annualReturn' }) }]
            : []),
          // FI-3 read surface — only when the FINLAND_ALV_RETURN-gated fetch
          // returned an envelope (flag off / non-ALV ⇒ the tab never exists;
          // prod is byte-identical). docs/design-donna-finland-fi3-alv-return.md
          ...(alvReturnAvailable
            ? [{ id: 'alv', label: intl.formatMessage({ id: 'mounted.financial.tabs.vatReturn' }) }]
            : [])
        ]
      : []),
    // AR/AP aging is the one alternate operational read that is not already
    // expressed by the lifecycle overview. It reuses the persisted document
    // inventory and opens the canonical document artifact.
    { id: 'aging', label: intl.formatMessage({ id: 'mounted.financial.tabs.aging' }) }
  ];
  // The extra views used to carry their own ⋯ at the strip's right edge;
  // stacked under the toolbar's ⋯ that read as a duplicate icon (Kari,
  // 2026-08-07). The strip now REGISTERS its menu views with the entity
  // toolbar's single ⋯ instead (same registration pattern as
  // onRegisterFeedApplyLifecycle). menuSignature stands in for menuTabs,
  // which is rebuilt every render.
  const menuSignature = menuTabs.map((t) => `${t.id}:${t.label}:${t.count || 0}`).join('|');
  useEffect(() => {
    if (typeof onRegisterViewMenu !== 'function') return undefined;
    onRegisterViewMenu({
      items: menuTabs.map((t) => ({
        id: t.id,
        label: t.count ? `${t.label} (${t.count})` : t.label
      })),
      active: tab,
      select: setTab
    });
    return () => onRegisterViewMenu(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onRegisterViewMenu, menuSignature, tab, setTab]);

  // Renders nothing: with the Open/Reconciled switch gone this component is
  // purely the ⋯ registration above.
  return null;
}

// FI-12 read surface — the persisted annual-return verdict (form 5) for a
// Finnish sole trader, rendered VERBATIM from the DB caller's consequence
// envelope through the pure view model (render-the-persisted-verdict: no
// client-side arithmetic, no re-inference). Read-only; OmaVero submission is a
// separate gated slice (D3). Design: docs/design-donna-finland-fi12-read-surface.md.
function AnnualReturnPanel({ envelope, taxYear, onYearChange }) {
  const intl = useIntl();
  const message = (id, values) => intl.formatMessage({ id }, values);
  const vm = useMemo(() => buildAnnualReturnViewModel(envelope), [envelope]);
  if (!vm) return null;
  const nowYear = new Date().getUTCFullYear();
  const yearOptions = [nowYear, nowYear - 1, nowYear - 2, nowYear - 3];
  const ready = vm.status === 'ready';

  const sectionTitle = (label) => (
    <div style={{ fontFamily: T.mono, fontSize: 10.5, letterSpacing: '0.14em', textTransform: 'uppercase', color: T.muted, marginTop: 4 }}>
      {label}
    </div>
  );
  const amountRow = (label, display, { bold = false } = {}) => (
    <div key={label} style={{ display: 'flex', alignItems: 'baseline', gap: 12, padding: '3px 0' }}>
      <span style={{ fontSize: 13, color: T.ink, fontWeight: bold ? 700 : 400, flex: 1 }}>{label}</span>
      <span style={{ fontFamily: T.mono, fontSize: 12.5, color: T.ink, fontWeight: bold ? 700 : 400 }}>{display}</span>
    </div>
  );

  return (
    <div style={{ padding: '24px 0', display: 'flex', flexDirection: 'column', gap: 14, maxWidth: 640 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <span style={{ fontFamily: T.mono, fontSize: 10.5, letterSpacing: '0.14em', textTransform: 'uppercase', color: T.muted }}>
          {message('mounted.financial.annual.title')}
        </span>
        <select
          value={taxYear}
          onChange={(e) => onYearChange(Number(e.target.value))}
          style={{ border: `1px solid ${T.rule}`, background: 'transparent', color: T.ink, borderRadius: 6, padding: '2px 6px', fontSize: 12 }}
        >
          {yearOptions.map((y) => (
            <option key={y} value={y}>{y}</option>
          ))}
        </select>
        <span style={{ flex: 1 }} />
        <span style={{ fontFamily: T.mono, fontSize: 10, letterSpacing: '0.06em', textTransform: 'uppercase', color: ready ? T.ok : T.amber }}>
          {message(ready ? 'mounted.financial.return.ready' : 'mounted.financial.return.needsReview')}
        </span>
      </div>
      <div style={{ fontSize: 12, color: T.muted }}>
        {vm.tilikausiLabel
          ? message('mounted.financial.annual.accountingPeriod', { period: vm.tilikausiLabel })
          : message('mounted.financial.annual.periodUnavailable')}
        {vm.basis ? ` · ${message(vm.basis === 'cash' ? 'mounted.financial.annual.cashBasis' : 'mounted.financial.annual.accrualBasis')}` : ''}
      </div>

      {vm.blockers.length > 0 && (
        <div style={{ border: `1px solid ${T.rule}`, borderRadius: 8, padding: '10px 14px', display: 'flex', flexDirection: 'column', gap: 8 }}>
          {vm.blockers.map((b) => (
            <div key={b.code}>
              <div style={{ fontSize: 12.5, fontWeight: 600, color: b.severity === 'info' ? T.muted : T.amber }}>{b.label}</div>
              {b.hint && <div style={{ fontSize: 12, color: T.muted, lineHeight: 1.45 }}>{b.hint}</div>}
            </div>
          ))}
        </div>
      )}

      {sectionTitle(message('mounted.financial.annual.income'))}
      <div>
        {vm.incomeRows.map((r) => amountRow(r.label, r.display))}
        {amountRow(message('mounted.financial.annual.incomeTotal'), vm.incomeTotal, { bold: true })}
      </div>

      {sectionTitle(message('mounted.financial.annual.deductibleExpenses'))}
      <div>
        {vm.expenseRows.map((r) => amountRow(r.label, r.display))}
        {amountRow(message('mounted.financial.annual.expensesTotal'), vm.expenseTotal, { bold: true })}
      </div>

      {vm.additionalTotal && (
        <>
          {sectionTitle(message('mounted.financial.annual.additionalDeductions'))}
          <div>
            {vm.additionalRows.map((r) => amountRow(r.label, r.display))}
            {amountRow(message('mounted.financial.annual.additionalDeductionsTotal'), vm.additionalTotal, { bold: true })}
          </div>
        </>
      )}

      <div style={{ borderTop: `1px solid ${T.rule}`, paddingTop: 8 }}>
        {amountRow(vm.resultLabel, vm.result, { bold: true })}
      </div>

      {vm.split && (
        <>
          {sectionTitle(message('mounted.financial.annual.capitalIncomeShare'))}
          <div>
            {vm.split.netBusinessAssets && amountRow(message('mounted.financial.annual.netBusinessAssets'), vm.split.netBusinessAssets)}
            {amountRow(message('mounted.financial.annual.capitalIncome', { rate: Math.round(vm.split.capitalReturnRate * 100) }), vm.split.capitalIncome)}
            {amountRow(message('mounted.financial.annual.earnedIncome'), vm.split.earnedIncome)}
          </div>
        </>
      )}
      {vm.splitDeferredNote && (
        <div style={{ fontSize: 12, color: T.muted, lineHeight: 1.45 }}>{vm.splitDeferredNote}</div>
      )}

      {/* F-G10-3: the EVL 30 § maximum-depreciation verdict — verbatim from the
          envelope; the proposal is display-only (confirmation rides the
          profile-patch path, never a click here). */}
      {vm.evlDepreciation && (
        <>
          {sectionTitle(message('mounted.financial.annual.depreciation'))}
          <div>
            {vm.evlDepreciation.pool && (
              <>
                {amountRow(message('mounted.financial.annual.openingTaxBasis'), vm.evlDepreciation.pool.openingBase)}
                {amountRow(
                  vm.evlDepreciation.pool.smallPoolRuleApplied
                    ? message('mounted.financial.annual.maximumDepreciationSmallPool')
                    : message('mounted.financial.annual.maximumDepreciation', { rate: vm.evlDepreciation.rateLabel ? ` (${vm.evlDepreciation.rateLabel})` : '' }),
                  vm.evlDepreciation.pool.maxPoisto,
                  { bold: true }
                )}
                {amountRow(message('mounted.financial.annual.closingTaxBasis'), vm.evlDepreciation.pool.closingIfMax)}
              </>
            )}
            {vm.evlDepreciation.comparison?.booked && amountRow(message('mounted.financial.annual.bookDepreciation'), vm.evlDepreciation.comparison.booked)}
          </div>
          {vm.evlDepreciation.comparison?.note && (
            <div style={{ fontSize: 12, color: vm.evlDepreciation.comparison.severity === 'ok' ? T.muted : T.amber, lineHeight: 1.45 }}>
              {vm.evlDepreciation.comparison.note}
            </div>
          )}
          {vm.evlDepreciation.comparison?.proposedAdjustment && (
            <div style={{ border: `1px solid ${T.rule}`, borderRadius: 8, padding: '10px 14px', fontSize: 12, color: T.ink, lineHeight: 1.45 }}>
              <span style={{ fontWeight: 600 }}>{message('mounted.financial.annual.proposedDifference', { amount: vm.evlDepreciation.comparison.proposedAdjustment.amount })}</span>
              {' — '}
              {vm.evlDepreciation.comparison.proposedAdjustment.note}
            </div>
          )}
          {vm.evlDepreciation.notComputed.map((entry) => (
            <div key={entry.category} style={{ fontSize: 12, color: T.muted, lineHeight: 1.45 }}>
              {message('mounted.financial.annual.uncomputedAsset', {
                category: message(entry.category === 'buildings' ? 'mounted.financial.annual.buildings' : 'mounted.financial.annual.otherAssets'),
                base: entry.base,
                reason: entry.reason || ''
              })}
            </div>
          ))}
          {!vm.evlDepreciation.pool && vm.evlDepreciation.summary && (
            <div style={{ fontSize: 12, color: T.muted, lineHeight: 1.45 }}>{vm.evlDepreciation.summary}</div>
          )}
          {vm.evlDepreciation.provenanceNote && (
            <div style={{ fontFamily: T.mono, fontSize: 10.5, color: T.mutedSoft }}>{vm.evlDepreciation.provenanceNote}</div>
          )}
        </>
      )}

      {vm.unmappedRows.length > 0 && (
        <>
          {sectionTitle(message('mounted.financial.annual.unmappedRows'))}
          <div>
            {vm.unmappedRows.map((r, i) => (
              <div key={`${r.code || 'row'}-${i}`} style={{ display: 'flex', gap: 12, padding: '3px 0', fontSize: 12.5, color: T.amber }}>
                <span style={{ fontFamily: T.mono }}>{r.code || '—'}</span>
                <span style={{ flex: 1 }}><BidiText direction="auto">{r.name || message('mounted.financial.annual.unknownAccount')}</BidiText></span>
                <span style={{ fontFamily: T.mono }}>{r.revenue} / {r.expense}</span>
              </div>
            ))}
          </div>
        </>
      )}

      {vm.nonDeductibleNote && (
        <div style={{ fontSize: 12, color: T.muted, lineHeight: 1.45 }}>{vm.nonDeductibleNote}</div>
      )}
      {vm.provenanceLine && (
        <div style={{ fontFamily: T.mono, fontSize: 10.5, color: T.mutedSoft }}>{vm.provenanceLine}</div>
      )}
    </div>
  );
}

// FI-3 read surface — the ALV return (ALV-ilmoitus) for a verokausi, rendered
// VERBATIM from the deterministic compute envelope + the persisted alv_returns
// lifecycle row through the pure view model (render-the-persisted-verdict: no
// client-side arithmetic, no re-inference). Read-only; the filing motion lives
// on the WhatsApp confirm lane. Design: docs/design-donna-finland-fi3-alv-return.md.
// Firm-memory governance (Phase 5). Reads firm_facts (both lifecycles) through
// the firm-member-gated list endpoint, groups Active vs Dismissed, and lets the
// operator dismiss an active fact via the single dismissFirmFact writer. Facts
// are firm-scoped (not client-scoped), so the panel ignores the workspace
// client for data — but it re-reads and resets its transient state when the
// client changes so a stale list never lingers across a switch.
function FactsPanel({ clientId, firmId }) {
  const intl = useIntl();
  const message = (id, values) => intl.formatMessage({ id }, values);
  const [facts, setFacts] = useState(null); // null while loading
  const [error, setError] = useState(null);
  const [dismissingId, setDismissingId] = useState(null);
  const [dismissError, setDismissError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    setFacts(null);
    setError(null);
    setDismissError(null);
    setDismissingId(null);
    fetchFirmFacts({ firmId, signal: controller.signal })
      .then((data) => {
        if (!cancelled) setFacts(Array.isArray(data?.facts) ? data.facts : []);
      })
      .catch((err) => {
        if (cancelled || err?.name === 'AbortError') return;
        setFacts([]);
        setError(err?.message || message('mounted.financial.memory.loadError'));
      });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [clientId, firmId]);

  const onDismiss = async (factId) => {
    setDismissingId(factId);
    setDismissError(null);
    try {
      await dismissFirmFact({ factId, firmId });
      // Reflect the server's verdict locally so the row moves to Dismissed
      // without a full reload/flash (readers honour status='active' only).
      setFacts((prev) => (Array.isArray(prev)
        ? prev.map((f) => (f.id === factId ? { ...f, status: 'dismissed' } : f))
        : prev));
    } catch (err) {
      setDismissError(err?.message || message('mounted.financial.memory.dismissError'));
    } finally {
      setDismissingId(null);
    }
  };

  const renderFact = (fact) => {
    const isActive = fact.status === 'active';
    const provenance = fact && typeof fact.provenance === 'object' && fact.provenance ? fact.provenance : {};
    const note = provenance.operator_note || provenance.source || null;
    return (
      <div
        key={fact.id}
        style={{
          border: `1px solid ${T.rule}`,
          background: isActive ? T.card : T.ruleSoft,
          borderRadius: 8,
          padding: '10px 12px',
          display: 'flex',
          flexDirection: 'column',
          gap: 6,
          opacity: isActive ? 1 : 0.72
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <span style={{ fontFamily: T.mono, fontSize: 10, letterSpacing: '0.08em', textTransform: 'uppercase', color: T.accent }}>
            {fact.scope}
          </span>
          <span style={{ fontSize: 12.5, fontWeight: 600, color: T.ink }}>{fact.subject}</span>
          <span style={{ flex: 1 }} />
          {fact.confidence && (
            <span style={{ fontFamily: T.mono, fontSize: 10.5, color: T.muted }}>{fact.confidence}</span>
          )}
          <span style={{ fontFamily: T.mono, fontSize: 10, letterSpacing: '0.06em', textTransform: 'uppercase', color: isActive ? T.ok : T.muted }}>
            {fact.status}
          </span>
        </div>
        <div style={{ fontSize: 13.5, color: T.ink, lineHeight: 1.5 }}>{fact.fact}</div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', fontSize: 11, color: T.muted }}>
          <span style={{ fontFamily: T.mono }}>{fact.id}</span>
          {fact.model && <span style={{ fontFamily: T.mono }}>· {fact.model}</span>}
          {note && <span>· {note}</span>}
        </div>
        {isActive && (
          <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
            <button
              type="button"
              onClick={() => onDismiss(fact.id)}
              disabled={dismissingId === fact.id}
              style={{
                border: `1px solid ${T.rule}`,
                background: 'transparent',
                color: T.muted,
                borderRadius: 6,
                padding: '4px 12px',
                fontSize: 12,
                cursor: dismissingId === fact.id ? 'default' : 'pointer'
              }}
            >
              {message(dismissingId === fact.id ? 'mounted.financial.memory.dismissing' : 'mounted.financial.memory.dismiss')}
            </button>
          </div>
        )}
      </div>
    );
  };

  const active = Array.isArray(facts) ? facts.filter((f) => f.status === 'active') : [];
  const dismissed = Array.isArray(facts) ? facts.filter((f) => f.status === 'dismissed') : [];

  return (
    <div style={{ padding: '24px 0', display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <span style={{ fontFamily: T.mono, fontSize: 10.5, letterSpacing: '0.14em', textTransform: 'uppercase', color: T.muted }}>
          {message('mounted.financial.memory.title')}
        </span>
        {facts !== null && (
          <span style={{ fontFamily: T.mono, fontSize: 10.5, color: T.mutedSoft }}>
            {message('mounted.financial.memory.counts', { active: active.length, dismissed: dismissed.length })}
          </span>
        )}
      </div>
      <div style={{ fontSize: 12.5, color: T.muted, lineHeight: 1.5, maxWidth: 620 }}>
        {message('mounted.financial.memory.desc')}
      </div>
      {error && <div style={{ fontSize: 12.5, color: T.alert }}>{error}</div>}
      {dismissError && <div style={{ fontSize: 12.5, color: T.alert }}>{dismissError}</div>}
      {facts === null && <div style={{ fontSize: 13, color: T.muted }}>{message('mounted.financial.memory.loading')}</div>}
      {facts !== null && facts.length === 0 && !error && (
        <div style={{ fontSize: 13, color: T.muted }}>
          {message('mounted.financial.memory.empty')}
        </div>
      )}
      {active.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <span style={{ fontFamily: T.mono, fontSize: 10, letterSpacing: '0.12em', textTransform: 'uppercase', color: T.muted }}>{message('mounted.financial.memory.active')}</span>
          {active.map(renderFact)}
        </div>
      )}
      {dismissed.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <span style={{ fontFamily: T.mono, fontSize: 10, letterSpacing: '0.12em', textTransform: 'uppercase', color: T.muted }}>{message('mounted.financial.memory.dismissed')}</span>
          {dismissed.map(renderFact)}
        </div>
      )}
    </div>
  );
}

// Memory-candidate governance (Donna Loops Phase 6.2) — the resolve surface for
// the front-gate to firm memory. The parent fetches the client's candidates
// (LOOPS_SHADOW-gated server-side, so prod renders nothing) and passes them in;
// this panel groups them by their PERSISTED status (rail #1) and exposes the
// first Loops WRITE affordance: promote (the human "yes" → mints a firm_fact) and
// dismiss (the human "no" → retires the candidate + any minted fact). A
// 'conflicted' candidate is first-class — it renders the contradicting active
// fact(s) (conflicts_with) so the operator resolves the disagreement with the
// evidence in front of them. State is optimistically reflected locally on a
// successful write so a row re-groups without a full reload/flash.
const MEMORY_STATUS_META = {
  conflicted: { label: 'Conflicted', tone: T.alert },
  suggested: { label: 'Suggested', tone: T.accent },
  promoted: { label: 'Promoted', tone: T.ok },
  dismissed: { label: 'Dismissed', tone: T.muted }
};
const MEMORY_GROUP_ORDER = ['conflicted', 'suggested', 'promoted', 'dismissed'];

function MemoryCandidatesPanel({ candidates = [], clientId, firmId }) {
  const [list, setList] = useState(Array.isArray(candidates) ? candidates : []);
  const [busyId, setBusyId] = useState(null);
  const [actionError, setActionError] = useState(null);

  // Reseed when the parent re-fetches (client switch / refresh). Resetting the
  // transient state too so a stale busy/error never lingers across a switch.
  useEffect(() => {
    setList(Array.isArray(candidates) ? candidates : []);
    setBusyId(null);
    setActionError(null);
  }, [candidates, clientId]);

  const applyStatus = (id, status, version) =>
    setList((prev) => (Array.isArray(prev)
      ? prev.map((c) => (c.id === id ? { ...c, status, version } : c))
      : prev));

  // W1: the version token the list returned rides every action (a candidate
  // that changed since it was read is refused server-side, never acted on).
  const versionFor = (candidateId) => (Array.isArray(list) ? list : []).find((c) => c.id === candidateId)?.version || null;

  const onPromote = async (candidateId) => {
    setBusyId(candidateId);
    setActionError(null);
    try {
      const res = await promoteMemoryCandidate({ candidateId, firmId, clientId, expectedVersion: versionFor(candidateId) });
      if (res?.promoted) applyStatus(candidateId, 'promoted', res.version);
      else if (res?.enabled === false) setActionError('Memory governance is disabled in this environment.');
      else if (res?.refused === 'version_mismatch') setActionError('This candidate changed since you opened it — refresh and try again.');
      else setActionError('Could not promote this candidate.');
    } catch (err) {
      setActionError(err?.message || 'Could not promote this candidate.');
    } finally {
      setBusyId(null);
    }
  };

  const onDismiss = async (candidateId) => {
    setBusyId(candidateId);
    setActionError(null);
    try {
      const res = await dismissMemoryCandidate({ candidateId, firmId, clientId, expectedVersion: versionFor(candidateId) });
      if (res?.dismissed) applyStatus(candidateId, 'dismissed', res.version);
      else if (res?.enabled === false) setActionError('Memory governance is disabled in this environment.');
      else if (res?.refused === 'version_mismatch') setActionError('This candidate changed since you opened it — refresh and try again.');
      else setActionError('Could not dismiss this candidate.');
    } catch (err) {
      setActionError(err?.message || 'Could not dismiss this candidate.');
    } finally {
      setBusyId(null);
    }
  };

  const renderCandidate = (cand) => {
    const status = cand.status || 'suggested';
    const meta = MEMORY_STATUS_META[status] || { label: status, tone: T.muted };
    const isInactive = status === 'dismissed';
    const provenance = cand && typeof cand.provenance === 'object' && cand.provenance ? cand.provenance : {};
    const note = provenance.operator_note || cand.source || null;
    const conflicts = Array.isArray(cand.conflicts_with) ? cand.conflicts_with : [];
    // Promote is offered while a candidate is still up for review; dismiss is
    // offered there too AND on a promoted fact (to retire it). A dismissed
    // candidate is terminal — never auto-resurrected (the firm_facts discipline).
    const canPromote = status === 'suggested' || status === 'conflicted';
    const canDismiss = status === 'suggested' || status === 'conflicted' || status === 'promoted';
    const busy = busyId === cand.id;
    return (
      <div
        key={cand.id}
        style={{
          border: `1px solid ${status === 'conflicted' ? T.alert : T.rule}`,
          background: isInactive ? T.ruleSoft : T.card,
          borderRadius: 8,
          padding: '10px 12px',
          display: 'flex',
          flexDirection: 'column',
          gap: 6,
          opacity: isInactive ? 0.72 : 1
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          {cand.scope && (
            <span style={{ fontFamily: T.mono, fontSize: 10, letterSpacing: '0.08em', textTransform: 'uppercase', color: T.accent }}>
              {cand.scope}
            </span>
          )}
          <span style={{ fontSize: 12.5, fontWeight: 600, color: T.ink }}>{cand.subject || cand.candidate_type}</span>
          <span style={{ flex: 1 }} />
          {cand.confidence && (
            <span style={{ fontFamily: T.mono, fontSize: 10.5, color: T.muted }}>{cand.confidence}</span>
          )}
          <span style={{ fontFamily: T.mono, fontSize: 10, letterSpacing: '0.06em', textTransform: 'uppercase', color: meta.tone }}>
            {meta.label}
          </span>
        </div>
        {cand.fact && <div style={{ fontSize: 13.5, color: T.ink, lineHeight: 1.5 }}>{cand.fact}</div>}
        {status === 'conflicted' && conflicts.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4, borderInlineStart: `2px solid ${T.alert}`, paddingInlineStart: 10 }}>
            <span style={{ fontFamily: T.mono, fontSize: 10, letterSpacing: '0.08em', textTransform: 'uppercase', color: T.alert }}>
              Contradicts an active fact
            </span>
            {conflicts.map((f) => (
              <div key={f.id} style={{ fontSize: 12.5, color: T.muted, lineHeight: 1.45 }}>{f.fact}</div>
            ))}
          </div>
        )}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', fontSize: 11, color: T.muted }}>
          <span style={{ fontFamily: T.mono }}>{cand.id}</span>
          {cand.model && <span style={{ fontFamily: T.mono }}>· {cand.model}</span>}
          {note && <span>· {note}</span>}
        </div>
        {(canPromote || canDismiss) && (
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
            {canDismiss && (
              <button
                type="button"
                onClick={() => onDismiss(cand.id)}
                disabled={busy}
                style={{
                  border: `1px solid ${T.rule}`,
                  background: 'transparent',
                  color: T.muted,
                  borderRadius: 6,
                  padding: '4px 12px',
                  fontSize: 12,
                  cursor: busy ? 'default' : 'pointer'
                }}
              >
                {busy ? '…' : 'Dismiss'}
              </button>
            )}
            {canPromote && (
              <button
                type="button"
                onClick={() => onPromote(cand.id)}
                disabled={busy}
                style={{
                  border: `1px solid ${D.ink}`,
                  background: D.ink,
                  color: D.card,
                  borderRadius: 6,
                  padding: '4px 12px',
                  fontSize: 12,
                  fontWeight: 600,
                  cursor: busy ? 'default' : 'pointer'
                }}
              >
                {busy ? '…' : 'Promote'}
              </button>
            )}
          </div>
        )}
      </div>
    );
  };

  const groups = useMemo(() => {
    const byStatus = new Map();
    for (const cand of (Array.isArray(list) ? list : [])) {
      const status = cand?.status || 'suggested';
      if (!byStatus.has(status)) byStatus.set(status, []);
      byStatus.get(status).push(cand);
    }
    const ordered = [];
    for (const status of MEMORY_GROUP_ORDER) {
      if (byStatus.has(status)) { ordered.push([status, byStatus.get(status)]); byStatus.delete(status); }
    }
    for (const [status, group] of byStatus) ordered.push([status, group]);
    return ordered;
  }, [list]);

  const pendingCount = (Array.isArray(list) ? list : [])
    .filter((c) => c.status === 'suggested' || c.status === 'conflicted').length;

  return (
    <div style={{ padding: '24px 0', display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <span style={{ fontFamily: T.mono, fontSize: 10.5, letterSpacing: '0.14em', textTransform: 'uppercase', color: T.muted }}>
          Memory candidates
        </span>
        <span style={{ fontFamily: T.mono, fontSize: 10.5, color: T.mutedSoft }}>
          {pendingCount} awaiting review · {list.length} total
        </span>
      </div>
      <div style={{ fontSize: 12.5, color: T.muted, lineHeight: 1.5, maxWidth: 620 }}>
        Each correction or client reply Donna distils into firm knowledge lands here first. Promote one to trust it as a firm fact, or dismiss it to keep it out of the model&rsquo;s context. A conflicted candidate disagrees with a fact you already hold — resolve it before it&rsquo;s trusted.
      </div>
      {actionError && <div style={{ fontSize: 12.5, color: T.alert }}>{actionError}</div>}
      {list.length === 0 && (
        <div style={{ fontSize: 13, color: T.muted }}>
          No memory candidates yet. They appear here as Donna distils durable facts from your corrections and client replies.
        </div>
      )}
      {groups.map(([status, group]) => {
        const meta = MEMORY_STATUS_META[status] || { label: status, tone: T.muted };
        return (
          <div key={status} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span aria-hidden="true" style={{ width: 6, height: 6, borderRadius: 999, background: meta.tone }} />
              <span style={{ fontFamily: T.mono, fontSize: 10, letterSpacing: '0.12em', textTransform: 'uppercase', color: T.muted }}>
                {meta.label}
              </span>
              <span style={{ fontFamily: T.mono, fontSize: 10, color: T.mutedSoft }}>{group.length}</span>
            </div>
            {group.map(renderCandidate)}
          </div>
        );
      })}
    </div>
  );
}

// ── Close-blocker dashboard (Phase 4, read-only) ─────────────────────────────
// Renders the persisted Loops close blockers — the open work keeping a client's
// books from closing — grouped by who we wait on (the case's PERSISTED status,
// rail #1). Read-only by design: no resolve/apply affordance (v1 autonomy is
// workflow state only; resolving a blocker is a later, flag-gated step). The
// parent fetches the data and passes it in, so the tab only appears when there
// is something to show — prod (LOOPS_SHADOW off) renders nothing.

const CLOSE_STATUS_META = {
  waiting_client: { label: 'Waiting on the client', tone: T.accent },
  waiting_firm: { label: 'Waiting on the firm', tone: T.amber },
  waiting_accountant: { label: 'Waiting on the accountant', tone: T.amber },
  waiting_policy: { label: 'Waiting on a policy decision', tone: T.amber },
  waiting_system: { label: 'Waiting on the system', tone: T.muted },
  blocked: { label: 'Blocked', tone: T.alert },
  engineering_escalated: { label: 'Escalated to engineering', tone: T.alert },
  open: { label: 'Open', tone: T.muted }
};

const CLOSE_BLOCKER_LABELS = {
  missing_client_answer: 'Missing client answer',
  missing_document: 'Missing document',
  missing_bank_statement: 'Missing bank statement',
  parse_pending: 'Parse pending',
  parse_failed: 'Parse failed',
  parse_stale: 'Parse stale',
  unclear_category: 'Unclear category',
  unclear_match: 'Unclear match',
  conflicting_memory: 'Conflicting memory',
  accountant_judgment_required: 'Accountant judgment required',
  firm_approval_required: 'Firm approval required',
  external_sync_pending: 'External sync pending',
  external_sync_failed: 'External sync failed',
  unsupported_connector_capability: 'Unsupported connector capability',
  engineering_investigation_required: 'Engineering investigation required'
};

const closeBlockerLabel = (type) =>
  CLOSE_BLOCKER_LABELS[type] || String(type || '').replace(/_/g, ' ');

const formatCaseActivity = (input) => {
  if (!input) return '';
  const ts = Date.parse(input);
  if (Number.isNaN(ts)) return '';
  const d = new Date(ts);
  return `${String(d.getUTCDate()).padStart(2, '0')} ${MONTH_LABELS[d.getUTCMonth()]}`;
};

// Order the groups by how much they need the firm's attention (most-severe
// first), mirroring caseManager's STATUS_SEVERITY.
const CLOSE_GROUP_ORDER = [
  'blocked', 'engineering_escalated', 'waiting_accountant', 'waiting_client',
  'waiting_firm', 'waiting_policy', 'waiting_system', 'open'
];

// Step 8 — "show the goal". Per-status tone for the persisted GoalReport status chip,
// and a per-criterion mark for the "done when" list. Reuses the workspace soft tokens so
// it sits next to the existing blocker chips without new colors.
const GOAL_STATUS_META = {
  met: { label: 'met', fg: T.ok, bg: T.okSoft },
  waived: { label: 'waived', fg: T.accent, bg: T.accentSoft },
  unmet: { label: 'unmet', fg: T.amber, bg: T.amberSoft },
  impossible: { label: 'impossible', fg: T.amber, bg: T.amberSoft },
  indeterminate: { label: 'pending', fg: T.muted, bg: T.ruleSoft }
};

const GOAL_CRITERION_MARK = {
  met: { mark: '✓', tone: T.ok },
  waived: { mark: '✓', tone: T.accent },
  unmet: { mark: '○', tone: T.amber },
  impossible: { mark: '✕', tone: T.amber },
  indeterminate: { mark: '·', tone: T.muted }
};

const humanizeGoalKey = (key) => String(key || '').replace(/_/g, ' ');

// Renders a case's PERSISTED GoalReport (INV-13 / "render the persisted verdict") —
// Goal · Done-when · Progress · Still-missing · reopen history · the evaluator receipt.
// Read-only and absent-safe: `goal` is null until the goal layer produces a report for
// the case (LOOPS_SHADOW / canary), in which case this renders nothing and the card
// looks exactly as it did before Step 8.
function CaseGoalSection({ goal }) {
  if (!goal) return null;
  const statusMeta = GOAL_STATUS_META[goal.status] || { label: goal.status || 'pending', fg: T.muted, bg: T.ruleSoft };
  const criteria = Array.isArray(goal.criteria) ? goal.criteria : [];
  const nextUnmet = Array.isArray(goal.next_unmet_conditions) ? goal.next_unmet_conditions : [];
  const history = goal.history || { reopen_count: 0, entries: [] };
  return (
    <div style={{ borderTop: `1px solid ${T.ruleSoft}`, paddingTop: 8, display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <span style={{ fontFamily: T.mono, fontSize: 9.5, letterSpacing: '0.12em', textTransform: 'uppercase', color: T.muted }}>
          Goal
        </span>
        <span style={{ display: 'inline-flex', alignItems: 'center', fontFamily: T.mono, fontSize: 9.5, letterSpacing: '0.08em', textTransform: 'uppercase', padding: '2px 7px', borderRadius: 999, background: statusMeta.bg, color: statusMeta.fg, fontWeight: 500 }}>
          {statusMeta.label}
        </span>
        {goal.answered && (
          <span style={{ fontFamily: T.mono, fontSize: 10, color: T.mutedSoft }}>
            answered {goal.answered.answered} of {goal.answered.total}
          </span>
        )}
      </div>
      {goal.title && (
        <div style={{ fontSize: 12.5, color: T.inkSoft, lineHeight: 1.5 }}>{goal.title}</div>
      )}
      {criteria.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span style={{ fontFamily: T.mono, fontSize: 9.5, letterSpacing: '0.12em', textTransform: 'uppercase', color: T.muted }}>
            Done when
          </span>
          {criteria.map((c) => {
            const cm = GOAL_CRITERION_MARK[c.status] || { mark: '·', tone: T.muted };
            return (
              <div key={c.key} style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                <span aria-hidden="true" style={{ color: cm.tone, fontFamily: T.mono, fontSize: 12, flexShrink: 0 }}>{cm.mark}</span>
                <span style={{ fontSize: 12.5, color: T.inkSoft, lineHeight: 1.5 }}>
                  {c.description || humanizeGoalKey(c.key)}
                  {c.next_condition && <span style={{ color: T.muted }}> — {c.next_condition}</span>}
                </span>
              </div>
            );
          })}
        </div>
      )}
      {nextUnmet.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
          <span style={{ fontFamily: T.mono, fontSize: 9.5, letterSpacing: '0.12em', textTransform: 'uppercase', color: T.muted }}>
            Still missing
          </span>
          {nextUnmet.map((n, i) => (
            <span key={i} style={{ fontSize: 12.5, color: T.muted, lineHeight: 1.5 }}>{n}</span>
          ))}
        </div>
      )}
      {history.reopen_count > 0 && (
        <div style={{ fontFamily: T.mono, fontSize: 10, color: T.amber }}>
          reopened {history.reopen_count}× after a regression
        </div>
      )}
      <div style={{ fontFamily: T.mono, fontSize: 9.5, color: T.mutedSoft }}>
        {goal.evaluator_type || 'deterministic'}
        {goal.evaluator_version ? ` · ${goal.evaluator_version}` : ''}
        {goal.evaluated_at ? ` · ${formatCaseActivity(goal.evaluated_at)}` : ''}
      </div>
    </div>
  );
}

function CloseBlockersPanel({ cases = [] }) {
  const list = Array.isArray(cases) ? cases : [];
  const groups = useMemo(() => {
    const byStatus = new Map();
    for (const kase of list) {
      const status = kase?.status || 'open';
      if (!byStatus.has(status)) byStatus.set(status, []);
      byStatus.get(status).push(kase);
    }
    const ordered = [];
    for (const status of CLOSE_GROUP_ORDER) {
      if (byStatus.has(status)) {
        ordered.push([status, byStatus.get(status)]);
        byStatus.delete(status);
      }
    }
    // Any status outside the canonical order still renders (defensive).
    for (const [status, group] of byStatus) ordered.push([status, group]);
    return ordered;
  }, [list]);

  const totalBlockers = useMemo(
    () => list.reduce((n, k) => n + (Array.isArray(k.blockers) ? k.blockers.length : 0), 0),
    [list]
  );

  return (
    <div style={{ padding: '24px 0', display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <span style={{ fontFamily: T.mono, fontSize: 10.5, letterSpacing: '0.14em', textTransform: 'uppercase', color: T.muted }}>
          Close blockers
        </span>
        <span style={{ fontFamily: T.mono, fontSize: 10.5, color: T.mutedSoft }}>
          {totalBlockers} open across {list.length} {list.length === 1 ? 'case' : 'cases'}
        </span>
      </div>
      <div style={{ fontSize: 12.5, color: T.muted, lineHeight: 1.5, maxWidth: 620 }}>
        The open work keeping this client&rsquo;s books from closing, grouped by who we&rsquo;re waiting on. Donna tracks each as a case; this view renders the persisted state and is read-only.
      </div>
      {list.length === 0 && (
        <div style={{ fontSize: 13, color: T.muted }}>
          No open close blockers. Every tracked case is resolved or waiting on nothing.
        </div>
      )}
      {groups.map(([status, group]) => {
        const meta = CLOSE_STATUS_META[status] || { label: status, tone: T.muted };
        return (
          <div key={status} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span aria-hidden="true" style={{ width: 6, height: 6, borderRadius: 999, background: meta.tone }} />
              <span style={{ fontFamily: T.mono, fontSize: 10, letterSpacing: '0.12em', textTransform: 'uppercase', color: T.muted }}>
                {meta.label}
              </span>
              <span style={{ fontFamily: T.mono, fontSize: 10, color: T.mutedSoft }}>{group.length}</span>
            </div>
            {group.map((kase) => (
              <div
                key={kase.id}
                style={{
                  border: `1px solid ${T.rule}`,
                  background: T.card,
                  borderRadius: 8,
                  padding: '10px 12px',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 8
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  <span style={{ fontFamily: T.mono, fontSize: 10, letterSpacing: '0.08em', textTransform: 'uppercase', color: T.accent }}>
                    {kase.case_type}
                  </span>
                  <span style={{ fontSize: 12.5, fontWeight: 600, color: T.ink }}>
                    {kase.title || kase.primary_object_id || kase.id}
                  </span>
                  <span style={{ flex: 1 }} />
                  {kase.last_activity_at && (
                    <span style={{ fontFamily: T.mono, fontSize: 10.5, color: T.mutedSoft }}>
                      {formatCaseActivity(kase.last_activity_at)}
                    </span>
                  )}
                </div>
                {kase.summary && (
                  <div style={{ fontSize: 13, color: T.inkSoft, lineHeight: 1.5 }}>{kase.summary}</div>
                )}
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {(Array.isArray(kase.blockers) ? kase.blockers : []).map((b) => (
                    <div key={b.id} style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
                      <span
                        style={{
                          fontFamily: T.mono,
                          fontSize: 10,
                          letterSpacing: '0.04em',
                          textTransform: 'uppercase',
                          color: T.amber,
                          flexShrink: 0
                        }}
                      >
                        {closeBlockerLabel(b.blocker_type)}
                      </span>
                      {b.reason && (
                        <span style={{ fontSize: 12.5, color: T.muted, lineHeight: 1.5 }}>{b.reason}</span>
                      )}
                    </div>
                  ))}
                </div>
                <CaseGoalSection goal={kase.goal} />
                <div style={{ fontFamily: T.mono, fontSize: 10, color: T.mutedSoft }}>{kase.id}</div>
              </div>
            ))}
          </div>
        );
      })}
    </div>
  );
}

// Donna Loops Step 8 — the read-only "resolved goals" view, the complement of
// CloseBlockersPanel. close-blockers only lists NON-terminal cases, so a case whose
// goal was MET (and went terminal) drops off it with no trace; this keeps the finished
// work visible with its persisted GoalReport (Goal · done-when · the evaluator receipt
// · any reopen history) via the shared CaseGoalSection. Renders the persisted verdict
// only (INV-13): a case is here because its latest report is met/waived. Empty (and the
// tab hidden) until the goal layer produces reports.
function ResolvedGoalsPanel({ cases = [] }) {
  const list = Array.isArray(cases) ? cases : [];
  return (
    <div style={{ padding: '24px 0', display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <span style={{ fontFamily: T.mono, fontSize: 10.5, letterSpacing: '0.14em', textTransform: 'uppercase', color: T.muted }}>
          Resolved goals
        </span>
        <span style={{ fontFamily: T.mono, fontSize: 10.5, color: T.mutedSoft }}>
          {list.length} {list.length === 1 ? 'case' : 'cases'}
        </span>
      </div>
      <div style={{ fontSize: 12.5, color: T.muted, lineHeight: 1.5, maxWidth: 620 }}>
        Work Donna has finished for this client &mdash; each case whose goal is met or waived, with the persisted verdict that closed it. Read-only; the complement of the close-blockers view.
      </div>
      {list.length === 0 && (
        <div style={{ fontSize: 13, color: T.muted }}>
          No resolved goals yet. Cases appear here once their goal is met or waived.
        </div>
      )}
      {list.map((kase) => (
        <div
          key={kase.id}
          style={{
            border: `1px solid ${T.rule}`,
            background: T.card,
            borderRadius: 8,
            padding: '10px 12px',
            display: 'flex',
            flexDirection: 'column',
            gap: 8
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <span style={{ fontFamily: T.mono, fontSize: 10, letterSpacing: '0.08em', textTransform: 'uppercase', color: T.accent }}>
              {kase.case_type}
            </span>
            <span style={{ fontSize: 12.5, fontWeight: 600, color: T.ink }}>
              {kase.title || kase.primary_object_id || kase.id}
            </span>
            <span style={{ flex: 1 }} />
            {kase.last_activity_at && (
              <span style={{ fontFamily: T.mono, fontSize: 10.5, color: T.mutedSoft }}>
                {formatCaseActivity(kase.last_activity_at)}
              </span>
            )}
          </div>
          {kase.summary && (
            <div style={{ fontSize: 13, color: T.inkSoft, lineHeight: 1.5 }}>{kase.summary}</div>
          )}
          <CaseGoalSection goal={kase.goal} />
          <div style={{ fontFamily: T.mono, fontSize: 10, color: T.mutedSoft }}>{kase.id}</div>
        </div>
      ))}
    </div>
  );
}

function FinancialsEmptyState({ view = 'reconcile' } = {}) {
  const intl = useIntl();
  const copy = {
    reconcile: { title: 'financial.empty.reconcile.title', body: 'financial.empty.reconcile.body' },
    reconciled: {
      title: 'financial.empty.reconciled.title',
      body: null
    },
    cashflow: {
      title: 'financial.empty.cashflow.title',
      body: 'financial.empty.cashflow.body'
    },
    categories: {
      title: 'financial.empty.categories.title',
      body: 'financial.empty.categories.body'
    },
    recent: {
      title: 'financial.empty.recent.title',
      body: null
    }
  }[view] || {
    title: 'financial.empty.default.title',
    body: null
  };

  return (
    <div style={BANK_FEED_EMPTY_STYLE}>
      <span style={{ color: T.ink }}>{intl.formatMessage({ id: copy.title })}</span>
      {copy.body && <> <span>{intl.formatMessage({ id: copy.body })}</span></>}
    </div>
  );
}

// ── Reconcile panel (ports reconcile.jsx) ────────────────────────────────────

// Section heading for the one-scroll feed (Kari, 2026-08-08). With Open and
// Reconciled stacked in a single list, these headings are what tells you
// which half you are in — they replace the segmented control's job, so they
// stick to the toolbar's underside while their section scrolls past.
function FeedSectionHeading({ label, count, top = STACKED_STRIP_TOP }) {
  return (
    <div
      style={{
        position: 'sticky',
        top,
        zIndex: 9,
        background: D.paper,
        ...BANK_FEED_SECTION_HEADING_STYLE
      }}
    >
      <span>{label}</span>
      {count != null && (
        <span style={BANK_FEED_SECTION_COUNT_STYLE}>{count}</span>
      )}
    </div>
  );
}

// Open and Reconciled are two states of one bank feed, so their columns and
// row rhythm must not drift. Open-only state markers sit outside this grid;
// they add information without shifting the ledger columns.
const BANK_FEED_INCOME_COLOR = '#2D7A4F';

function ReconciledDot() {
  return (
    <span
      aria-hidden="true"
      style={{
        ...BANK_FEED_DOT_STYLE,
        background: D.inkMute,
        opacity: 0.55
      }}
    />
  );
}

export function PeriodTransactionRow({
  row,
  lane,
  question = null,
  active = false,
  inFlight = false,
  receipt = null,
  onOpen = null
}) {
  const intl = useIntl();
  const { formatAmount, formatDate } = useInterfaceLocale();
  const clickable = typeof onOpen === 'function';
  const isFeedDecision = Boolean(row?.source_id && row?.verdict);
  const identity = periodRowIdentity(row);
  const feedRowId = `${lane}:${identity}`;
  const date = row.date || (() => {
    const calendarDate = String(row.transaction_date || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(calendarDate)) return formatTxDate(row.transaction_date, formatDate);
    return formatDate(calendarDate, { year: undefined, month: 'short', day: '2-digit' });
  })();
  const description = question || row.desc || feedTitle(row, intl.formatMessage);
  const amount = isFeedDecision && Number.isFinite(Number(row?.amount))
    ? formatAmount(Number(row.amount), {
        currency: row.currency || row.account_currency || 'EUR',
        negativeStyle: 'minus'
      })
    : row.amount;
  const decisionLabel = isFeedDecision ? reasonShorthand(row, intl.formatMessage) : '';
  return (
    <div
      className={`bank-feed-lifecycle-row${clickable ? ' bank-feed-list-row' : ''}`}
      data-bank-feed-list-row={clickable ? 'true' : undefined}
      data-bank-feed-row-id={clickable ? feedRowId : undefined}
      role={clickable ? 'button' : undefined}
      tabIndex={clickable ? 0 : undefined}
      onClick={clickable ? onOpen : undefined}
      onKeyDown={clickable ? (event) => {
        if (event.target !== event.currentTarget) return;
        if (event.key === 'Enter' || event.key === ' ' || event.key === 'Spacebar') {
          event.preventDefault();
          onOpen();
        }
      } : undefined}
      title={inFlight ? intl.formatMessage({ id: 'lifecycle.applyInFlight' }) : undefined}
      style={{
        ...BANK_FEED_ROW_STYLE,
        color: T.ink,
        cursor: clickable ? 'pointer' : 'default',
        background: active ? T.card : 'transparent',
        transition: 'background .15s',
        ...(inFlight ? { animation: 'receiptInFlightPulse 1.1s ease-in-out infinite' } : {})
      }}
      onMouseEnter={(event) => { if (clickable) event.currentTarget.style.background = T.card; }}
      onMouseLeave={(event) => { event.currentTarget.style.background = active ? T.card : 'transparent'; }}
    >
      {lane === 'owner'
        ? <span aria-hidden="true" style={{ ...BANK_FEED_DOT_STYLE, background: D.accentWarmFlat }} />
        : <ReconciledDot />}
      <span style={BANK_FEED_DATE_STYLE}><FormattedValue>{date}</FormattedValue></span>
      <span
        title={description}
        style={{ ...BANK_FEED_PRIMARY_STYLE, minWidth: 0 }}
      >
        <BidiText
          direction="auto"
          style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
        >
          {description}
        </BidiText>
      </span>
      <span style={{ ...BANK_FEED_AMOUNT_STYLE, color: amount?.startsWith('+') ? BANK_FEED_INCOME_COLOR : T.ink }}>
        <FormattedValue>{amount}</FormattedValue>
      </span>
      <span style={{ ...BANK_FEED_TRAILING_CELL_STYLE, display: 'flex', justifyContent: 'flex-end' }}>
        {/* State pill only (Kari, 2026-09-01). The why (decision label) and
            the coded account move to the hover title; full detail lives in
            the artifact. Receipt cues stay — they are state-change receipts,
            not category chips. */}
        <LiveStateCell
          state={streamEntryState(lane, row)}
          phase={streamEntryPhase(lane, row)}
          title={lane === 'owner' ? (decisionLabel || undefined) : (row.cat || row.aiCat || undefined)}
          cat={row.cat || row.aiCat || null}
          receipt={receipt}
        />
      </span>
    </div>
  );
}

// The month is a boundary label riding the single list — not a container
// (Kari, 2026-08-31: "a single list can do it all with states"). It carries
// the period's facts: name, what remains, Open/Closed, and the close-event
// doorway. Nothing collapses and nothing toggles; the label stays sticky
// while its month's run scrolls past.
export function PeriodHeader({ period, onOpenClose }) {
  const intl = useIntl();
  const { formatDate } = useInterfaceLocale();
  const hasCloseAction = !!period.closePeriod && typeof onOpenClose === 'function';
  const closeActionLabel = period.closed
    ? intl.formatMessage({ id: 'lifecycle.close.openReceipt' })
    : period.closeStatus === 'ready'
      ? intl.formatMessage({ id: 'lifecycle.close.readyToLock' })
      : intl.formatMessage({ id: 'lifecycle.close.details' });
  const periodLabel = period.monthKey === 'undated'
    ? intl.formatMessage({ id: 'lifecycle.dateUnavailable' })
    : period.monthKey === 'demo'
      ? intl.formatMessage({ id: 'lifecycle.demo' })
      : /^\d{4}-\d{2}$/.test(period.monthKey)
        ? formatDate(`${period.monthKey}-01`, { day: undefined, month: 'long', year: 'numeric' })
        : period.label;
  return (
    <div
      className="bank-feed-period-header"
      data-period-month={period.monthKey}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 15,
        boxSizing: 'border-box',
        minHeight: 46,
        padding: '6px 0',
        borderBottom: `1px solid ${T.ruleSoft}`,
        position: 'sticky',
        insetBlockStart: 0,
        zIndex: 9,
        background: D.paper
      }}
    >
      <span style={{ fontSize: 14, fontWeight: 700, minWidth: 104, color: T.ink }}>
        <FormattedValue>{periodLabel}</FormattedValue>
      </span>
      <span
        className="bank-feed-period-summary"
        style={{
          fontSize: 12,
          color: period.counts.remaining ? T.inkSoft : T.muted,
          flex: '1 1 auto',
          minWidth: 0,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap'
        }}
      >
        {periodSummaryLabel(period, intl.formatMessage)}
      </span>
      <span className="bank-feed-period-status" style={bankFeedPillStyle(period.closed ? 'ink' : period.counts.remaining ? 'warm' : 'muted')}>
        {intl.formatMessage({ id: period.closed ? 'lifecycle.closed' : 'lifecycle.open' })}
      </span>
      {hasCloseAction && (
        <button
          className="bank-feed-period-close"
          type="button"
          onClick={onOpenClose}
          style={{
            font: 'inherit',
            fontSize: 11.5,
            color: T.inkSoft,
            background: 'transparent',
            border: `1px solid ${T.rule}`,
            borderRadius: 999,
            padding: '4px 10px',
            cursor: 'pointer'
          }}
        >
          {closeActionLabel}
        </button>
      )}
    </div>
  );
}

function StatusDot({ status }) {
  const intl = useIntl();
  const map = {
    uncat: { c: T.alert, id: 'lifecycle.status.unmatched' },
    // Warm accent, not the chart-ramp gold: "no document yet" is the
    // needs-attention voice, and chips/dots only speak in the three voices.
    nodoc: { c: D.accentWarmFlat, id: 'lifecycle.status.noDocument' },
    // The mirror case — a document with no bank line yet (doc-anchored
    // Open rows). Same needs-attention voice as nodoc.
    noline: { c: D.accentWarmFlat, id: 'lifecycle.status.noBankLine' },
    reading: { c: D.accentWarmFlat, id: 'lifecycle.status.readingStatement' },
    source: { c: T.alert, id: 'lifecycle.status.statementRepair' }
  };
  const s = map[status];
  if (!s) return null;
  return (
    <span
      title={intl.formatMessage({ id: s.id })}
      style={{ width: 7, height: 7, borderRadius: 999, background: s.c, flex: '0 0 auto', display: 'inline-block' }}
    />
  );
}

// Tiny purple dot rendered before the description on bank-feed rows
// where a client_reply_received message landed after the firm's
// last-seen timestamp. Same purple as the chat surface uses for
// client-bound traffic, so the colour reads as "client" at a glance.
// Sized to match StatusDot (7px) so the description column stays
// visually balanced.
function UnreadChatDot() {
  const intl = useIntl();
  return (
    <span
      title={intl.formatMessage({ id: 'lifecycle.chat.newReply' })}
      aria-label={intl.formatMessage({ id: 'lifecycle.chat.newReply' })}
      style={{
        width: 7,
        height: 7,
        borderRadius: 999,
        background: D.accentWarmFlat,
        flex: '0 0 auto',
        display: 'inline-block'
      }}
    />
  );
}

function CategoryTag({ name, ai, missing }) {
  const intl = useIntl();
  if (missing) {
    return <span style={{ fontSize: 12.5, color: T.muted, fontStyle: 'italic' }}>{intl.formatMessage({ id: 'lifecycle.category.missing' })}</span>;
  }
  return (
    <span
      title={typeof name === 'string' ? name : undefined}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        // Single-line pill: long account names ("Investment disposal /
        // asset sale proceeds") ellipsize instead of wrapping the pill
        // to two or three lines; the full name lives in the title.
        maxWidth: '100%',
        fontSize: 12.5,
        color: T.ink,
        padding: '3px 9px',
        borderRadius: 999,
        // Always the neutral wash. This pill used to tint warm whenever the
        // category was AI-suggested, which is almost every row — so the whole
        // table read as a tinted surface rather than a white one. The warm
        // accent is reserved for the exceptional, and the "AI" marker below
        // already carries this signal on its own.
        // Wash at 4% + full-ink label (Kari's 2026-08-05 chip pass, same
        // treatment as the Inbox venture tags): the 8% ruleSoft wash with
        // 72% text read as heavy grey blocks dominating the column.
        background: 'oklch(0.08 0 0 / 0.04)'
      }}
    >
      <BidiText direction="auto" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{name}</BidiText>
      {ai && (
        <span
          style={{
            // Stays visually uppercase because "AI" is an initialism, not a
            // tracked mini-cap — the letters are the word.
            fontSize: 10.5,
            fontWeight: 600,
            // Muted, not amber: "AI" is provenance, not state — it doesn't
            // get a color voice (Kari, 2026-08-05).
            color: T.muted,
            flexShrink: 0
          }}
        >
          {intl.formatMessage({ id: 'mounted.financial.ai' })}
        </span>
      )}
    </span>
  );
}

// ── Slice 2 (realtime-truthful-feedback): receipt-driven row treatments ──────
// docs/design-realtime-truthful-feedback.md. The row cues below render ONLY
// from receipts — sanitized persisted audit events off /feed-events, or the
// per-row outcome an apply response reports on already-committed writes.
// Every chip's `title` names its persisted source.

const FEED_EVENTS_POLL_MS = 5_000;
const CATEGORY_DIFF_TTL_MS = 6_000;

// Receipt → row note. `ledger_pending` is the split state the two-terminal-
// states rail requires to stay VISIBLE (coded in review, ledger still on the
// prior account) — amber, never a clean green.
const liveReceiptNote = (receipt, message) => {
  if (!receipt) return null;
  if (receipt.ledger_pending) {
    return {
      label: message('mounted.financial.receipt.ledgerPending'),
      color: T.amber,
      title: message('mounted.financial.receipt.ledgerPendingTitle', {
        reason: receipt.reason ? ` (${receipt.reason})` : '',
        source: receipt.source
      })
    };
  }
  if (receipt.kind === 'apply_failed') {
    return {
      label: message('mounted.financial.receipt.applyFailed'),
      color: T.alert,
      title: message('mounted.financial.receipt.applyFailedTitle', {
        error: receipt.error || message('mounted.financial.receipt.applyFailedSentence'),
        source: receipt.source
      })
    };
  }
  if (receipt.kind === 'ledger_adjusted') {
    return {
      label: message('mounted.financial.receipt.ledgerReclassed'),
      color: T.ok,
      transient: true,
      title: message('mounted.financial.receipt.ledgerReclassedTitle', {
        journal: receipt.original_journal_id
          ? message('mounted.financial.receipt.againstJournal', { id: receipt.original_journal_id })
          : '',
        source: receipt.source
      })
    };
  }
  if (receipt.kind === 'recoded' || receipt.kind === 'applied') {
    return {
      label: message('mounted.financial.receipt.applied'),
      color: T.ok,
      transient: true,
      title: message('mounted.financial.receipt.recordedTitle', { source: receipt.source })
    };
  }
  return null;
};

function LiveReceiptNote({ receipt }) {
  const intl = useIntl();
  const note = liveReceiptNote(receipt, (id, values) => intl.formatMessage({ id }, values));
  if (!note) return null;
  return (
    <span
      title={note.title}
      style={{
        fontSize: 11.5,
        fontWeight: 600,
        color: note.color,
        maxWidth: 190,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
        ...(note.transient
          ? { animation: `receiptNoteFade ${RECEIPT_SUCCESS_TTL_MS}ms ease forwards` }
          : {})
      }}
    >
      {note.label}
    </span>
  );
}

// Receipt-gated diff cue: fires only when the RENDERED category changes on a
// mounted row while a live receipt for it is present — i.e. the persisted
// snapshot (or the apply's per-row outcome) moved the row. A bare optimistic
// override with no receipt does not animate: receipts, never intentions.
function useRenderedCategoryDiff(displayCat, receipt) {
  const prevCatRef = useRef(displayCat);
  const receiptRef = useRef(receipt);
  receiptRef.current = receipt;
  const [diff, setDiff] = useState(null);
  useEffect(() => {
    const prev = prevCatRef.current;
    prevCatRef.current = displayCat;
    if (!prev || !displayCat || prev === displayCat) return undefined;
    if (!receiptRef.current) return undefined;
    setDiff({ from: prev, to: displayCat });
    const timer = setTimeout(() => setDiff(null), CATEGORY_DIFF_TTL_MS);
    return () => clearTimeout(timer);
  }, [displayCat]);
  return diff;
}

function CategoryWasNote({ diff }) {
  const intl = useIntl();
  if (!diff) return null;
  return (
    <span
      title={intl.formatMessage({ id: 'mounted.financial.recodedTitle' }, { from: diff.from, to: diff.to })}
      style={{
        fontSize: 11.5,
        color: T.muted,
        maxWidth: 190,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
        animation: `receiptNoteFade ${CATEGORY_DIFF_TTL_MS}ms ease forwards`
      }}
    >
      {intl.formatMessage({ id: 'mounted.financial.wasCategory' }, { category: diff.from })}
    </span>
  );
}

// Category cell for the reconciled ARCHIVE browser (the collapsed-month
// history view) — there every row is reconciled by construction, so the
// coded account is the information and a uniform state pill would be noise.
function LiveCategoryCell({ name, missing, receipt }) {
  const catDiff = useRenderedCategoryDiff(name || null, receipt);
  return (
    <span style={{ display: 'inline-flex', flexDirection: 'column', alignItems: 'flex-end', gap: 3, minWidth: 0, maxWidth: '100%', textAlign: 'end' }}>
      <CategoryTag name={name} missing={missing} />
      <CategoryWasNote diff={catDiff} />
      <LiveReceiptNote receipt={receipt} />
    </span>
  );
}

// State cell for the stream rows — the state pill plus the receipt notes,
// in a component so the diff hook has a stable home per row. The category
// no longer claims the pill slot (state does), but a receipted recode still
// animates its "Was X" cue off the row's carried `cat`.
function LiveStateCell({ state, title, phase = null, cat = null, receipt = null }) {
  const catDiff = useRenderedCategoryDiff(cat || null, receipt);
  return (
    <span style={{ display: 'inline-flex', flexDirection: 'column', alignItems: 'flex-end', gap: 3, minWidth: 0, maxWidth: '100%', textAlign: 'end' }}>
      <StreamStatePill state={state} title={title} phase={phase} />
      <CategoryWasNote diff={catDiff} />
      <LiveReceiptNote receipt={receipt} />
    </span>
  );
}

// Look up an account by display name in a given catalogue, with a fallback
// synthesised from the name when nothing matches. Keeps callers ignorant of
// the catalogue shape — pass them a string, get back an Apply-ready account
// object that buildAcceptedPatch knows how to flatten.
const resolveAccountByName = (name, catalogue = ALL_CATS) => {
  if (!name) return null;
  const trimmed = String(name).trim();
  const list = Array.isArray(catalogue) && catalogue.length > 0 ? catalogue : ALL_CATS;
  const hit = list.find((a) => (a.name || '').toLowerCase() === trimmed.toLowerCase());
  if (hit) return hit;
  return { name: trimmed, label: trimmed };
};

const isSuspenseAccount = (account) =>
  /suspense/i.test(`${account?.name || ''} ${account?.label || ''} ${account?.account_label || ''}`);

function GhostPicker({ aiAccount, onApply, onCandidateChange, accounts = ALL_CATS }) {
  const intl = useIntl();
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const inp = useRef(null);
  useEffect(() => {
    inp.current?.focus();
  }, []);

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    const list = Array.isArray(accounts) && accounts.length > 0 ? accounts : ALL_CATS;
    const score = (c) => {
      const n = (c.name || '').toLowerCase();
      const g = (c.group || '').toLowerCase();
      if (n.startsWith(q)) return 0;
      if (n.split(/\s+/).some((w) => w.startsWith(q))) return 1;
      if (n.includes(q)) return 2;
      if (g.includes(q)) return 3;
      if (c.code && String(c.code).toLowerCase().startsWith(q)) return 1.5;
      return 9;
    };
    return list
      .map((c) => ({ ...c, _s: score(c) }))
      .filter((c) => c._s < 9)
      .sort((a, b) => a._s - b._s)
      .slice(0, 6);
  }, [query, accounts]);

  const ghost = !query;
  const aiName = aiAccount?.name || aiAccount?.label || '';
  const activeCandidate = ghost ? aiAccount : matches[active] || null;

  // Emit candidate to parent only when its stable identity changes — every
  // render rebuilds the account object reference (resolveAccountByName /
  // matches[active]), which would otherwise trigger an infinite loop:
  // parent setState → re-render TxnRow → new aiAccount obj → new
  // activeCandidate obj → effect fires → setState again → …
  const candidateKey =
    activeCandidate?.xero_account_id ||
    activeCandidate?.code ||
    activeCandidate?.name ||
    null;
  const lastCandidateKeyRef = useRef(undefined);
  useEffect(() => {
    if (lastCandidateKeyRef.current === candidateKey) return;
    lastCandidateKeyRef.current = candidateKey;
    onCandidateChange?.(activeCandidate || null);
    // candidateKey is the stable identity; we intentionally don't depend on
    // activeCandidate or onCandidateChange.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [candidateKey]);

  return (
    <div style={{ position: 'relative', display: 'flex', flexDirection: 'column', gap: 4 }}>
      <div
        style={{
          position: 'relative',
          display: 'flex',
          alignItems: 'center',
          borderBottom: `1.5px solid ${T.ink}`,
          paddingBottom: 5
        }}
      >
        {ghost && (
          <span
            style={{
              position: 'absolute',
              insetInlineStart: 0,
              top: '50%',
              transform: 'translateY(-50%)',
              fontSize: 15,
              color: T.mutedSoft,
              pointerEvents: 'none',
              display: 'inline-flex',
              alignItems: 'center',
              gap: 8
            }}
          >
            <span>{aiName}</span>
            <span
              style={{
                fontSize: 10.5,
                fontWeight: 600,
                padding: '2px 6px',
                borderRadius: 4,
                background: 'rgba(154,107,14,0.12)',
                color: T.amber
              }}
            >
              {intl.formatMessage({ id: 'mounted.financial.ai' })}
            </span>
          </span>
        )}
        <input
          ref={inp}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setActive(0);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              if (ghost && aiAccount) onApply(aiAccount);
              else if (matches[active]) onApply(matches[active]);
            }
            if (e.key === 'Tab' && ghost && !e.shiftKey && aiAccount) {
              e.preventDefault();
              onApply(aiAccount);
            }
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              setActive((i) => Math.min(i + 1, matches.length - 1));
            }
            if (e.key === 'ArrowUp') {
              e.preventDefault();
              setActive((i) => Math.max(i - 1, 0));
            }
          }}
          style={{
            font: 'inherit',
            fontSize: 15,
            border: 'none',
            outline: 'none',
            background: 'transparent',
            width: '100%',
            color: T.ink,
            padding: 0
          }}
        />
      </div>
      <div
        style={{
          minHeight: 14,
          fontSize: 12,
          color: T.mutedSoft,
          display: 'flex',
          gap: 12
        }}
      >
        {ghost ? (
          <>
            <span><kbd style={kbdStyle}>↵</kbd> {intl.formatMessage({ id: 'mounted.financial.keyboard.accept' })}</span>
            <span><kbd style={kbdStyle}>{intl.formatMessage({ id: 'mounted.financial.keyboard.tab' })}</kbd> {intl.formatMessage({ id: 'mounted.financial.keyboard.complete' })}</span>
            <span>{intl.formatMessage({ id: 'mounted.financial.keyboard.override' })}</span>
          </>
        ) : (
          <span>
            {intl.formatMessage({ id: 'mounted.financial.keyboard.matches' }, { count: matches.length })} · <kbd style={kbdStyle}>↑↓</kbd> {intl.formatMessage({ id: 'mounted.financial.keyboard.nav' })} · <kbd style={kbdStyle}>↵</kbd> {intl.formatMessage({ id: 'mounted.financial.keyboard.select' })}
          </span>
        )}
      </div>
      {matches.length > 0 && (
        <div
          style={{
            position: 'absolute',
            top: '100%',
            insetInlineStart: 0,
            insetInlineEnd: 0,
            marginTop: 6,
            background: T.card,
            borderRadius: 8,
            boxShadow: '0 12px 32px rgba(26,24,21,0.16)',
            border: `1px solid ${T.rule}`,
            overflow: 'hidden',
            zIndex: 20,
            maxHeight: 240,
            overflowY: 'auto'
          }}
        >
          {matches.map((m, i) => (
            <button
              key={m.xero_account_id || m.name}
              type="button"
              aria-label={intl.formatMessage({ id: 'mounted.financial.chooseAccount' }, { account: m.code ? `${m.code} ${m.name}` : m.name })}
              onMouseDown={(e) => {
                e.preventDefault();
                onApply(m);
              }}
              onMouseEnter={() => setActive(i)}
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                width: '100%',
                padding: '8px 12px',
                border: 'none',
                background: i === active ? T.accentSoft : 'transparent',
                font: 'inherit',
                fontSize: 13,
                color: i === active ? T.accent : T.ink,
                cursor: 'pointer',
                textAlign: 'start'
              }}
            >
              <span style={{ display: 'inline-flex', alignItems: 'baseline', gap: 8, minWidth: 0 }}>
                {m.code && (
                  <span style={{ fontFamily: T.mono, fontSize: 11.5, color: T.mutedSoft }}>{m.code}</span>
                )}
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{m.name}</span>
              </span>
              <span style={{ fontSize: 11.5, color: T.mutedSoft }}>{m.group}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function TxnRow({
  tx,
  expanded,
  active = false,
  onToggle,
  onApply,
  onAsk,
  onShowAudit,
  accounts,
  selectable,
  selected,
  onToggleSelect,
  rowError,
  // Latest "Ask" outcome for this row. Object: { evidence_request, justSent }.
  // `justSent` flips true on a successful Ask so we can render a brief
  // "Question sent" line; the underlying `evidence_request` keeps showing
  // the status chip (open / replied / resolved) on subsequent expansions.
  askResult,
  // Persisted evidence request for this row, sourced from the firm
  // snapshot's clientEvidenceRequests. Stays visible across sessions even
  // before the operator clicks Ask in this session.
  evidenceRequest,
  // Map of document_id → document record from the firm snapshot. The
  // EvidenceChip uses this to filter `evidence_request.response_payload
  // .document_ids` down to the documents we can actually offer to open.
  documentsById,
  onDismissError,
  busy,
  // True while the batch AI-coding run is in flight — pulses the
  // category chip so the operator can see the pass working the feed.
  codingActive = false,
  // True when the transaction chat has a `client_reply_received`
  // newer than the firm's last-seen timestamp for this row. Renders
  // a small purple dot before the description (matches V.intel,
  // the colour the chat uses for client-bound traffic) so the firm
  // can scan a long bank feed and spot rows that have new replies.
  unreadChat = false,
  // Slice 2 (realtime-truthful-feedback): the row's live receipt (persisted
  // audit event / per-row apply outcome) and its in-flight flag. In-flight
  // gets only a shimmer — the outcome renders when the receipt lands.
  liveReceipt = null,
  receiptInFlight = false
}) {
  const intl = useIntl();
  const isIn = tx.amount.startsWith('+');
  const catDiff = useRenderedCategoryDiff(tx.cat || tx.aiCat || null, liveReceipt);
  const reviewState = getReviewState(tx);
  // Phase 7.2b-ii — the persisted bank-line disposition verdict (server-attached
  // as `tx._tx.bank_line_disposition`), rendered as a low-priority, *correctable*
  // cue. Non-null only when the strong model auto-explained this bare line; it
  // de-prioritizes the row (dim + a muted chip in place of the "needs action"
  // badge) WITHOUT closing it — the line stays clickable into the artifact (the
  // correction surface). Render the persisted verdict, never a re-inference.
  const dispoChip = bankLineDispositionChip(tx._tx?.bank_line_disposition);
  const isAutoExplained = !!dispoChip;
  const synced = tx.synced || reviewState === 'synced';
  const aiAccount = resolveAccountByName(tx.aiCat || 'Suspense', accounts);
  const [pickerAccount, setPickerAccount] = useState(aiAccount);
  useEffect(() => {
    setPickerAccount(resolveAccountByName(tx.cat || tx.aiCat || 'Suspense', accounts));
  }, [tx.id, tx.cat, tx.aiCat, accounts]);
  const applyAccount = pickerAccount || aiAccount;
  const applyDisabled = synced || busy || !applyAccount || isSuspenseAccount(applyAccount);
  const submitApply = (account) => {
    if (!account || isSuspenseAccount(account) || synced) return;
    onApply?.(account);
  };
  return (
    <div
      title={receiptInFlight ? intl.formatMessage({ id: 'lifecycle.applyInFlight' }) : undefined}
      style={{
        background: expanded || active ? T.card : 'transparent',
        transition: 'background .15s',
        opacity: synced || isAutoExplained ? 0.78 : 1,
        ...(receiptInFlight ? { animation: 'receiptInFlightPulse 1.1s ease-in-out infinite' } : {})
      }}
    >
      <div
        className="bank-feed-list-row"
        data-bank-feed-list-row="true"
        data-bank-feed-row-id={`open:${tx.id}`}
        role="button"
        tabIndex={0}
        aria-expanded={!!expanded}
        onClick={(e) => {
          // Clicks on the checkbox shouldn't toggle the row.
          if (e.target.closest('[data-row-select]')) return;
          onToggle?.();
        }}
        onKeyDown={(e) => {
          // Only the row itself toggles on keyboard — Enter/Space on a nested
          // control (account picker, apply button, select checkbox) is that
          // control's own action and must not also expand the row.
          if (e.target !== e.currentTarget) return;
          if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') {
            e.preventDefault();
            onToggle?.();
          }
        }}
        style={{
          ...BANK_FEED_ROW_STYLE,
          cursor: 'pointer'
        }}
      >
        {/* Batch-select checkbox column removed with the toolbar — batch
            posting is the chat `sync_to_accounting` verb; single-row post is
            the artifact "Send to Xero" button. */}
        <span
          aria-hidden="true"
          style={{
            position: 'absolute',
            insetInlineStart: 0,
            top: '50%',
            transform: 'translateY(-50%)',
            display: 'inline-flex'
          }}
        >
          <StatusDot status={tx.status} />
        </span>
        {/* A date is not machine output. Tabular figures keep the column
            aligned now that the face no longer does it. */}
        <span style={BANK_FEED_DATE_STYLE}><FormattedValue>{tx.date}</FormattedValue></span>
        <span
          style={{
            ...BANK_FEED_PRIMARY_STYLE,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            minWidth: 0,
            display: 'inline-flex',
            alignItems: 'center',
            gap: 8
          }}
        >
          {unreadChat && <UnreadChatDot />}
          <BidiText direction="auto" style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{tx.desc}</BidiText>
        </span>
        {/* Money is NOT machine output — the doctrine's own example. The
            column aligns through D.tabular, never through a face swap. */}
        <span
          style={{
            ...BANK_FEED_AMOUNT_STYLE,
            color: isIn ? BANK_FEED_INCOME_COLOR : T.ink
          }}
        >
          <FormattedValue>{tx.amount}</FormattedValue>
        </span>
        <span
          style={{
            ...BANK_FEED_TRAILING_CELL_STYLE,
            display: 'inline-flex',
            flexDirection: 'column',
            alignItems: 'flex-end',
            gap: 3,
            ...(codingActive ? { animation: 'codingPulse 1.2s ease-in-out infinite' } : {})
          }}
          title={codingActive ? intl.formatMessage({ id: 'mounted.financial.codingReview' }) : undefined}
        >
          {/* The pill is the row's STATE off the persisted convergence
              verdict; an in-flight coding pass or apply receipt overrides
              to Processing for its duration (transient truth — Donna IS
              working the line right now). The suggested category and the
              hanging reason move to the hover title; the artifact carries
              the full detail. */}
          <StreamStatePill
            state={codingActive || receiptInFlight ? 'processing' : streamEntryState('open', tx)}
            phase={codingActive || receiptInFlight ? null : streamEntryPhase('open', tx)}
            title={[tx.cat || tx.aiCat, tx.convergence_reason].filter(Boolean).join(' · ') || undefined}
          />
          {tx.missingAccount?.name ? (
            <span
              title={tx.missingAccount.reason || intl.formatMessage({ id: 'mounted.financial.missingAccountTitle' }, { account: tx.missingAccount.name })}
              style={{
                fontSize: 11.5,
                fontWeight: 600,
                color: T.amber,
                maxWidth: 190,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap'
              }}
            >
              {intl.formatMessage({ id: 'mounted.financial.needsAccount' }, { account: tx.missingAccount.name })}
            </span>
          ) : tx.missingAccountResolved?.name ? (
            <span
              title={intl.formatMessage({ id: 'mounted.financial.accountCreatedTitle' }, { account: tx.missingAccountResolved.name })}
              style={{
                fontSize: 11.5,
                fontWeight: 600,
                color: T.ok,
                maxWidth: 190,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap'
              }}
            >
              {intl.formatMessage({ id: 'mounted.financial.accountCreated' }, { account: tx.missingAccountResolved.name })}
            </span>
          ) : null}
          <CategoryWasNote diff={catDiff} />
          <LiveReceiptNote receipt={liveReceipt} />
        </span>
      </div>
    </div>
  );
}

// EvidenceChip — small expanded-row status chip for the client-evidence
// loop. Renders nothing if neither the just-sent Ask result nor a persisted
// evidence_request is available. Donna lifecycle vocabulary only — never
// mentions "synced".
const EVIDENCE_CHIP_META = {
  draft: { label: 'Draft', tint: T.muted },
  open: { label: 'Awaiting client evidence', tint: T.amber },
  replied: { label: 'Client replied', tint: T.accent },
  resolved: { label: 'Resolved', tint: T.ok },
  cancelled: { label: 'Cancelled', tint: T.muted }
};

const evidenceDocumentIdsFor = ({ request, transaction } = {}) => {
  const seen = new Set();
  const collect = (list) => {
    if (!Array.isArray(list)) return;
    for (const value of list) {
      if (typeof value === 'string' && value && !seen.has(value)) seen.add(value);
      else if (value && typeof value === 'object' && value.id && !seen.has(value.id)) seen.add(value.id);
    }
  };
  collect(request?.response_payload?.document_ids);
  collect(request?.response_payload?.documents);
  collect(transaction?.evidence_document_ids);
  collect(transaction?.payload?.evidence_document_ids);
  return Array.from(seen);
};

const evidenceAuditStepsFor = ({ request, documents = [], row = null } = {}) => {
  if (!request) return [];
  const events = Array.isArray(request.evidence_audit_events) ? request.evidence_audit_events : [];
  const latestEvent = (action) => events.find((event) => event.action === action);
  const openEvent = events.find((event) => event.action === 'document.signed_url.created');
  const rejection = request.response_payload?.rejection || null;
  const steps = [
    {
      label: 'Asked',
      at: request.first_sent_at || request.request_payload?.evidence_request?.first_sent_at || request.created_at,
      detail: request.created_by || latestEvent('evidence_request.create')?.actor_id || null
    }
  ];
  if (request.responded_at || request.status === 'replied' || request.status === 'resolved') {
    steps.push({
      label: 'Client replied',
      at: request.responded_at || request.updated_at,
      detail: request.response_payload?.reply ? 'Note received' : null
    });
  }
  if (documents.length) {
    steps.push({
      label: 'Files attached',
      at: request.responded_at || request.updated_at,
      detail: `${documents.length} ${documents.length === 1 ? 'file' : 'files'}`
    });
  }
  if (openEvent) {
    steps.push({
      label: 'Opened by firm',
      at: openEvent.created_at,
      detail: openEvent.actor_id || null
    });
  }
  if (rejection || latestEvent('evidence_request.reject')) {
    const event = latestEvent('evidence_request.reject');
    steps.push({
      label: 'Rejected / re-asked',
      at: rejection?.rejected_at || event?.created_at,
      detail: rejection?.reason || event?.metadata?.reason || null
    });
  }
  if (request.status === 'resolved' || request.resolved_at || latestEvent('evidence_request.resolve')) {
    const event = latestEvent('evidence_request.resolve');
    steps.push({
      label: 'Accepted by firm',
      at: request.resolved_at || event?.created_at,
      detail: request.response_payload?.resolution_note || event?.metadata?.resolution_note || request.resolved_by || null
    });
  }
  if (row?.ledger_journal_id || row?.ledger_status === 'posted') {
    steps.push({
      label: 'Posted to Donna ledger',
      at: row?.ledger_posted_at || row?.posted_at || null,
      detail: row?.ledger_journal_id || 'Posted'
    });
  }
  return steps.filter((step) => step.label);
};

function EvidenceAuditTrail({ steps = [] }) {
  const { formatDate } = useInterfaceLocale();
  if (!steps.length) return null;
  const formatStepTime = (value) => {
    if (!value) return null;
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return null;
    return formatDate(date.toISOString().slice(0, 10), { year: undefined, month: 'short', day: 'numeric' });
  };
  return (
    <div style={{ marginTop: 8, display: 'flex', flexWrap: 'wrap', gap: 6 }}>
      {steps.map((step, index) => (
        <span
          key={`${step.label}-${index}`}
          title={[step.label, step.detail, step.at].filter(Boolean).join(' · ')}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 5,
            padding: '2px 7px',
            borderRadius: 999,
            border: `1px solid ${T.rule}`,
            background: T.paper,
            color: T.muted,
            fontSize: 11.5
          }}
        >
          <span>{step.label}</span>
          {formatStepTime(step.at) && <span style={{ color: T.mutedSoft }}>{formatStepTime(step.at)}</span>}
        </span>
      ))}
    </div>
  );
}

function EvidenceChip({ askResult, evidenceRequest, documentsById, transaction }) {
  const { formatDate } = useInterfaceLocale();
  const request = askResult?.evidence_request || evidenceRequest || null;
  const justSent = !!askResult?.justSent;
  const [opening, setOpening] = useState(null); // currently-opening document id
  const [openError, setOpenError] = useState('');
  if (!request && !justSent) return null;
  const status = request?.status || (justSent ? 'open' : null);
  const meta = (status && EVIDENCE_CHIP_META[status]) || { label: 'Question sent', tint: T.amber };
  const id = request?.id || null;
  const dueAt = request?.due_at || null;
  const dueLabel = (() => {
    if (!dueAt) return null;
    const d = new Date(dueAt);
    if (Number.isNaN(d.getTime())) return null;
    const now = new Date();
    const dDate = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const overdue = dDate < today;
    return `${formatDate(d.toISOString().slice(0, 10), {
      month: 'short', day: 'numeric', year: d.getFullYear() === now.getFullYear() ? undefined : 'numeric'
    })}${overdue ? ' · overdue' : ''}`;
  })();

  // Resolved evidence request → the BE writes document_ids to
  // response_payload (canonical) and to the transaction/review payload
  // (mirrored). We coalesce the sources, dedupe, then keep only the ones
  // that are present in the loaded snapshot — never invent attachments.
  const docMap = documentsById instanceof Map ? documentsById : null;
  const candidateDocIds = evidenceDocumentIdsFor({ request, transaction });
  const resolvableDocs = docMap
    ? candidateDocIds
        .map((docId) => docMap.get(docId))
        .filter(Boolean)
    : [];
  // Show the count from the request payload even when we can't resolve the
  // documents (snapshot cap, stale view) so the operator knows attachments
  // exist somewhere; the open action only enables when we can resolve.
  const totalAttachedCount = candidateDocIds.length;
  const canOpen = resolvableDocs.length > 0;
  const isResolvedLike = status === 'resolved' || status === 'replied';

  const openEvidence = async (documentId, popup = null) => {
    if (!documentId || opening) return;
    setOpening(documentId);
    setOpenError('');
    try {
      const response = await fetchFirmDocumentDownload({ documentId });
      const url = response?.signed_url || response?.url;
      if (!url) throw new Error('Signed URL was not returned.');
      if (popup && !popup.closed) {
        popup.location.href = url;
      } else {
        const opened = window.open(url, '_blank', 'noopener,noreferrer');
        if (!opened) throw new Error('Popup blocked. Allow popups and try again.');
      }
    } catch (err) {
      if (popup && !popup.closed) popup.close();
      setOpenError(formatFirmError(err, 'Could not open evidence file.'));
    } finally {
      setOpening(null);
    }
  };

  return (
    <span style={{ display: 'inline-flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4 }}>
      <span
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 8,
          padding: '3px 10px',
          borderRadius: 999,
          border: `1px solid ${meta.tint}40`,
          background: `${meta.tint}14`,
          color: meta.tint,
          fontSize: 12
        }}
        title={
          justSent
            ? 'Client evidence request was just created. The client will reply from the portal.'
            : 'Open client evidence request — Donna close blocker.'
        }
      >
        <span style={{ fontWeight: 600 }}>{meta.label}</span>
        {dueLabel && (
          <span style={{ color: dueLabel.endsWith('overdue') ? T.alert : 'inherit', opacity: 0.85 }}>
            Due {dueLabel}
          </span>
        )}
        {/* Attached-doc count — only render once we have evidence that
            attachments exist (resolved/replied status with non-empty list).
            Visually quiet: shown inside the chip in the status tint. */}
        {isResolvedLike && totalAttachedCount > 0 && (
          <span
            style={{ opacity: 0.85 }}
            title={`${totalAttachedCount} ${totalAttachedCount === 1 ? 'file' : 'files'} attached to this evidence request`}
          >
            {totalAttachedCount} {totalAttachedCount === 1 ? 'file' : 'files'} attached
          </span>
        )}
        {id && (
          <span style={{ opacity: 0.7 }} title={id}>
            req {String(id).slice(0, 10)}
          </span>
        )}
      </span>
      {/* Quiet "Open evidence" affordance — only when the request is
          resolved/replied AND we have at least one document whose id
          matches the loaded snapshot. Each click fetches a fresh signed
          URL (short-lived) and opens it in a new tab. */}
      {isResolvedLike && canOpen && (
        <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center', flexWrap: 'wrap', justifyContent: 'flex-end' }}>
          {resolvableDocs.slice(0, 3).map((document) => {
            const label = document.filename || document.document_label || `evidence ${String(document.id).slice(0, 6)}`;
            const isOpening = opening === document.id;
            return (
              <button
                key={document.id}
                type="button"
                onClick={(event) => {
                  event.stopPropagation();
                  const popup = window.open('about:blank', '_blank');
                  if (popup) {
                    try {
                      popup.opener = null;
                    } catch {
                      // Best-effort noopener; still navigate the short-lived signed URL below.
                    }
                  }
                  openEvidence(document.id, popup);
                }}
                disabled={isOpening || opening !== null}
                title={`Open ${label} in a new tab via short-lived signed URL`}
                style={{
                  font: 'inherit',
                  fontSize: 11.5,
                  padding: '2px 8px',
                  borderRadius: 999,
                  border: `1px solid ${T.rule}`,
                  background: T.card,
                  color: T.muted,
                  cursor: isOpening || opening !== null ? 'wait' : 'pointer',
                  opacity: isOpening || opening !== null ? 0.6 : 1,
                  fontWeight: 500
                }}
              >
                {isOpening ? 'Opening…' : 'Open evidence'}
              </button>
            );
          })}
          {resolvableDocs.length > 3 && (
            <span style={{ fontSize: 11.5, color: T.mutedSoft }}>
              +{resolvableDocs.length - 3} more
            </span>
          )}
        </span>
      )}
      {openError && (
        <span style={{ fontSize: 11.5, color: T.alert, maxWidth: 240, textAlign: 'end' }}>
          {openError}
        </span>
      )}
    </span>
  );
}

function GroupChip({ g, active, onClick }) {
  const intl = useIntl();
  const conf = g.conf;
  const confColor = conf === 'high' ? T.ok : conf === 'medium' ? T.amber : T.alert;
  return (
    <button
      onClick={onClick}
      style={{
        font: 'inherit',
        textAlign: 'start',
        padding: '10px 14px',
        borderRadius: 8,
        border: `1px solid ${active ? T.ink : T.rule}`,
        background: active ? T.paper : T.card,
        cursor: 'pointer',
        display: 'flex',
        flexDirection: 'column',
        gap: 4,
        minWidth: 180
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10 }}>
        <span style={{ fontSize: 13, fontWeight: 500, color: T.ink }}>{intl.formatMessage({ id: g.titleId })}</span>
        <span style={{ fontSize: 12, color: T.muted, ...D.tabular }}>{g.items}</span>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span style={{ width: 5, height: 5, borderRadius: 999, background: confColor }} />
        <span style={{ fontSize: 11, color: T.muted }}>
          {intl.formatMessage({ id: g.catId })} · {intl.formatMessage({ id: g.confId })}
        </span>
      </div>
    </button>
  );
}

// Doc-anchored Open rows — a parsed receipt/bill/invoice with no matching
// bank line yet renders as an ORDINARY row in the Open group (two-surface IA
// record §4, precondition P2; Kari 2026-08-26: "those solo documents belong
// to the Open group in that list view"). This SUPERSEDES the 2026-08-03
// "OFF — noise, not signal" call, which was about the SHAPE it had then — a
// banner section with an amber explainer above the feed — not about the docs
// being surfaced: the shared row grammar carries them without the noise.
// Selection stays in selectMaterialOpenDocumentRows (documentsInbox.js,
// unit-tested, source-aware, and doc-first-drain-aware): a statement parse
// blocker collapses its derived no-line fallout to one row, while a doc with an
// open owner ask or persisted auto_explain verdict never renders here. Rows
// carry no transaction / reviewItemId, so none of the tx-side
// apply / accept / sync handlers can touch them — activation opens the same
// read-only document artifact the row's matched siblings open.
function DocFeedRow({ row, active = false, deleting = false, onOpen, onContextMenu = null, onMenu = null }) {
  const intl = useIntl();
  const { formatAmount, formatDate } = useInterfaceLocale();
  // Hover reveals the ⋯ document-options button (stage D: the Documents
  // tab's per-doc actions live on this row now) — same reveal grammar as
  // the tab's DocumentRow carried.
  const [hovered, setHovered] = useState(false);
  const desc = row.materialSourceState
    ? row.document?.filename || intl.formatMessage({ id: 'mounted.financial.bankStatement' })
    : row.vendorDisplay || row.document?.filename || intl.formatMessage({ id: 'mounted.financial.document' });
  const scopedNoSettlement = streamEntryState('document', row) === 'no_settlement';
  const statusLabel = intl.formatMessage({
    id: scopedNoSettlement ? 'lifecycle.noSettlementInScope' : row.materialSourceState === 'processing'
      ? 'mounted.financial.readingStatement'
      : row.materialSourceState === 'blocked'
        ? 'mounted.financial.statementNeedsRepair'
        : 'mounted.financial.noBankLine'
  });
  const dotStatus = row.materialSourceState === 'blocked'
    ? 'source'
    : row.materialSourceState === 'processing'
      ? 'reading'
      : 'noline';
  return (
    <div
      style={{
        background: active ? T.card : 'transparent',
        transition: 'background .15s, opacity .15s',
        position: 'relative',
        opacity: deleting ? 0.45 : 1,
        pointerEvents: deleting ? 'none' : 'auto'
      }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <div
        className="bank-feed-list-row"
        data-bank-feed-list-row="true"
        data-bank-feed-row-id={`open:doc:${row.id}`}
        role="button"
        tabIndex={0}
        aria-label={intl.formatMessage({ id: 'mounted.financial.openDocument' }, { document: desc, status: statusLabel })}
        onClick={() => onOpen?.(row.document)}
        onContextMenu={onContextMenu || undefined}
        onKeyDown={(e) => {
          if (e.target !== e.currentTarget) return;
          if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') {
            e.preventDefault();
            onOpen?.(row.document);
          }
        }}
        style={{ ...BANK_FEED_ROW_STYLE, cursor: 'pointer' }}
      >
        <span
          aria-hidden="true"
          style={{
            position: 'absolute',
            insetInlineStart: 0,
            top: '50%',
            transform: 'translateY(-50%)',
            display: 'inline-flex'
          }}
        >
          <StatusDot status={dotStatus} />
        </span>
        <span style={BANK_FEED_DATE_STYLE}>
          {row.documentDate ? formatTxDate(row.documentDate, formatDate) : '—'}
        </span>
        <span
          style={{
            ...BANK_FEED_PRIMARY_STYLE,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            minWidth: 0
          }}
        >
          <BidiText direction="auto">{desc}</BidiText>
          {scopedNoSettlement && <span style={{ display: 'block', fontSize: 11, color: T.muted }}>
            {intl.formatMessage({ id: 'lifecycle.accountingIncomplete' })}
          </span>}
        </span>
        <span style={{ ...BANK_FEED_AMOUNT_STYLE, color: T.ink }}>
          {formatEvidenceAmount(row.totalAmount, row.currency, formatAmount, intl.formatMessage({ id: 'mounted.financial.amountPending' }))}
        </span>
        <span
          style={{
            ...BANK_FEED_TRAILING_CELL_STYLE,
            display: 'inline-flex',
            justifyContent: 'flex-end'
          }}
        >
          {/* State pill, like every other stream row; the specific document
              status ("No bank line yet", "Reading statement") moves to the
              hover title and stays in the aria-label. */}
          <StreamStatePill state={streamEntryState('document', row)} phase={streamEntryPhase('document', row)} title={statusLabel} />
        </span>
      </div>
      {onMenu && !deleting && (
        <span
          style={{
            position: 'absolute',
            insetInlineEnd: -30,
            top: '50%',
            transform: 'translateY(-50%)',
            opacity: hovered ? 1 : 0.2,
            transition: 'opacity .15s'
          }}
          onClick={(e) => e.stopPropagation()}
        >
          <button
            type="button"
            aria-label={intl.formatMessage({ id: 'mounted.financial.documentOptions' })}
            aria-haspopup="menu"
            title={intl.formatMessage({ id: 'mounted.financial.documentOptions' })}
            onClick={onMenu}
            style={{
              width: 26,
              height: 26,
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              border: 'none',
              borderRadius: 7,
              background: 'transparent',
              color: T.muted,
              cursor: 'pointer',
              fontSize: 16,
              lineHeight: 1,
              padding: 0
            }}
            onMouseEnter={(event) => { event.currentTarget.style.color = T.ink; }}
            onMouseLeave={(event) => { event.currentTarget.style.color = T.muted; }}
          >
            ⋯
          </button>
        </span>
      )}
    </div>
  );
}

function ReconcilePanel({
  clientId,
  databaseMode = false,
  transactions = [],
  reviewItems = [],
  clientEvidenceRequests = [],
  documents = [],
  reconciliationMatches = [],
  xeroAccounts = [],
  ledgerAccounts = [],
  ledgerJournals = [],
  ledgerLines = [],
  ownerRows = [],
  onActivatePeriodOwnerDecision = null,
  reconciledHistoryRows = [],
  closePeriods = [],
  closeArchives = [],
  periodDocumentRows = null,
  onDatabaseSnapshot,
  onBatchSuggestTransactionCoding,
  onArtifact,
  onUpdateTransaction,
  onApproveTransaction,
  onUpdateReconciliationMatch,
  activeFeedRowId = null,
  // Slice 2 (realtime-truthful-feedback): tx_id → live receipt map and the
  // in-flight id set, owned by the panel-level tick/lifecycle in
  // DonnaFinancialsPanel.
  liveReceipts = {},
  inFlightTxIds = null,
  // Per-doc actions on the doc-anchored Open rows (two-surface IA stage D
  // §3): the Documents tab's affordances — manual link (via the artifact),
  // ask Donna (the doc artifact's chat composer), delete — on the row and
  // artifact, so the fold loses nothing.
  baseCurrency = '',
  onCreateManualLink = null,
  onChatActionSnapshotApplied = null,
  onDeleteDocument = null
} = {}) {
  const intl = useIntl();
  const message = (id, values) => intl.formatMessage({ id }, values);
  const { formatAmount, formatDate } = useInterfaceLocale();
  const localeFormatters = useMemo(() => ({ formatAmount, formatDate }), [formatAmount, formatDate]);
  // Audit-trail drawer — opens when the operator picks "Ledger details" on
  // an expanded TxnRow. The full transaction record (snapshot row) flows
  // through here so the drawer can correlate to ledger_journals on its own.
  const [auditTransaction, setAuditTransaction] = useState(null);
  const [auditTrail, setAuditTrail] = useState(null);
  const [auditStatus, setAuditStatus] = useState('idle');
  const [auditError, setAuditError] = useState(null);
  // AI coding now runs automatically server-side as transactions land (no
  // manual trigger). codingBusy stays false here; it only drives the per-line
  // "coding" pulse, kept for forward compatibility.
  const [codingBusy] = useState(false);
  const [group, setGroup] = useState(null);
  const [openId, setOpenId] = useState(null);
  const [overrides, setOverrides] = useState({});
  // Workflow-state overlay layered on top of the seed values. Optimistic UI
  // updates write here on Apply/Ask while the BE PATCH/writeback are in
  // flight; the snapshot refetch eventually reconciles the source of truth.
  const [reviewStates, setReviewStates] = useState({});
  // Per-row error message keyed by row id when a BE call rejects.
  const [rowErrors, setRowErrors] = useState({});
  // Per-row writeback result (account label, matched_existing, match_strategy)
  // surfaced after a successful sync. Cleared when the row error is dismissed.
  const [rowResults, setRowResults] = useState({});
  // Per-row pending flag while the orchestration is flying.
  const [busyRows, setBusyRows] = useState({});
  // Per-row Ask result. Stores the freshly-created/updated evidence_request
  // returned by createClientEvidenceRequest plus a `justSent` flag so the
  // chip can render a brief "Question sent" tone. Snapshot refresh
  // eventually rehydrates the same record via clientEvidenceRequests.
  const [askResults, setAskResults] = useState({});

  // Unread-chat badge state. Server gives us the per-transaction
  // latest client_reply_received timestamp; we compare against the
  // localStorage last-seen map to derive which rows to dot. Refetched
  // on clientId change and when the firm opens an artifact (so the
  // badge clears immediately after viewing).
  const [unreadChatSummary, setUnreadChatSummary] = useState([]);
  const [lastSeenMap, setLastSeenMap] = useState(() => readLastSeenMap(clientId));
  const unreadChatTxIds = useMemo(
    () => computeUnreadTransactionIds(unreadChatSummary, lastSeenMap),
    [unreadChatSummary, lastSeenMap]
  );

  // Selection for batch sync. Only rows in 'accepted' or 'resolved' state
  // (and not already synced) can be picked.
  const [selectedIds, setSelectedIds] = useState(() => new Set());
  const [batchBusy, setBatchBusy] = useState(null); // 'preview' | 'sync' | null
  const [batchSummary, setBatchSummary] = useState(null);
  const [batchError, setBatchError] = useState(null);

  // Build the live row set from the snapshot. Outside database mode, fall back
  // to the mock TXNS so the local design surface still teaches the workbench.
  // In database mode, an empty firm must stay empty.
  const txByid = useMemo(() => new Map(transactions.map((t) => [t.id, t])), [transactions]);
  // Evidence requests keyed by transaction_id and review_item_id so an
  // expanded row can render the live request status (open / replied /
  // resolved) without an extra fetch. Most-recent wins when more than one
  // request targets the same transaction.
  const evidenceRequestsByTx = useMemo(() => {
    const byTx = new Map();
    const byReviewItem = new Map();
    if (!Array.isArray(clientEvidenceRequests)) return { byTx, byReviewItem };
    const sorted = [...clientEvidenceRequests].sort((a, b) => {
      const at = Date.parse(a?.updated_at || a?.created_at || '') || 0;
      const bt = Date.parse(b?.updated_at || b?.created_at || '') || 0;
      return bt - at;
    });
    for (const request of sorted) {
      if (request?.transaction_id && !byTx.has(request.transaction_id)) {
        byTx.set(request.transaction_id, request);
      }
      if (request?.review_item_id && !byReviewItem.has(request.review_item_id)) {
        byReviewItem.set(request.review_item_id, request);
      }
    }
    return { byTx, byReviewItem };
  }, [clientEvidenceRequests]);
  // Snapshot documents keyed by id so the EvidenceChip can confirm a
  // resolved request's `document_ids` are still resolvable in the loaded
  // snapshot before exposing the "Open evidence" affordance.
  const documentsById = useMemo(
    () => new Map((documents || []).map((document) => [document.id, document])),
    [documents]
  );
  const matchesByTransactionId = useMemo(() => {
    const map = new Map();
    for (const match of reconciliationMatches) {
      if (match?.bank_transaction_id) {
        const existing = map.get(match.bank_transaction_id);
        if (!existing || match.status === 'confirmed') {
          map.set(match.bank_transaction_id, match);
        }
      }
    }
    return map;
  }, [reconciliationMatches]);
  const liveRows = useMemo(() => {
    // Review-queue hanging rows (the violation surface) + the bare doc-matched
    // lines whose convergence verdict is `hanging` but never got a queue row
    // (matched-but-uncoded Suspense etc.). Without the latter a hanging bare
    // line would vanish — it is ALSO excluded from Reconciled now, so Reconcile
    // is its only honest home. document_line rows stay in the Documents inbox
    // (excluded by needsAttentionItems); the bare rows carry no reviewItemId, so
    // the apply/accept/sync handlers (all reviewItemId-guarded) no-op on them.
    const reviewRows = needsAttentionItems(reviewItems)
      .map((item) => buildLiveRow(item, txByid, localeFormatters))
      .filter(Boolean);
    const bareRows = partitionBareReconcileTxs(reviewItems, transactions).hanging
      .map((transaction) => transactionToReconciledRow(transaction, localeFormatters));
    return [...reviewRows, ...bareRows];
  }, [reviewItems, transactions, txByid, localeFormatters]);

  const reconciledRows = useMemo(() => {
    if (!Array.isArray(reviewItems) || reviewItems.length === 0) return [];
    return reviewItems
      .filter((item) => {
        if (item?.status && item.status !== 'open') return false;
        if (item?.item_type === 'document_line') return false;
        // Reconciled = the auto_reconciled terminal (render the convergence
        // verdict, not the legacy review_state set). Legacy fallback for
        // pre-convergence_state snapshots (mock / seed mode).
        const conv = item?.convergence_state;
        if (conv) return conv === 'auto_reconciled';
        const rs = getReviewState(item) || 'suggested';
        return RECONCILED_STATES.has(rs);
      })
      .map((item) => buildLiveRow(item, txByid, localeFormatters))
      .filter(Boolean);
  }, [reviewItems, txByid, localeFormatters]);

  // Doc-anchored Open rows — parsed documents with a real amount that found no
  // bank line yet (two-surface IA P2). Selection lives in
  // selectMaterialOpenDocumentRows (documentsInbox.js, unit-tested) so the
  // panel renders the persisted verdict and the logic stays machine-checked.
  // Mock mode skips it (the seed has no parsed-doc snapshot to reconcile
  // against). Sorted newest-first to match the feed's reading order.
  const unmatchedDocRows = useMemo(() => {
    if (Array.isArray(periodDocumentRows)) return periodDocumentRows;
    if (!databaseMode) return [];
    // clientEvidenceRequests included (doc-first terminal drain, Slice 1): a
    // doc with an OPEN doc-anchored ask reads 'awaiting_owner' and a doc with
    // a persisted auto_explain verdict reads 'explained_no_line' — both are at
    // a terminal already and never render here.
    return selectMaterialOpenDocumentRows({
      documents,
      transactions,
      reconciliationMatches,
      reviewItems,
      clientEvidenceRequests
    })
      .slice()
      .sort((a, b) => String(b.documentDate || '').localeCompare(String(a.documentDate || '')));
  }, [periodDocumentRows, databaseMode, documents, transactions, reconciliationMatches, reviewItems, clientEvidenceRequests]);

  // Open an unmatched doc's artifact — mirrors the openDocument helper the
  // matched-row path uses (buildDocumentArtifactData + onArtifact). Stage D:
  // the artifact carries the SAME affordances it carried when opened from the
  // Documents tab — manual link (linkable) and the chat composer
  // (focusComposer) — so the fold loses nothing.
  const docArtifactFocusRequestRef = useRef(0);
  const openUnmatchedDocument = useCallback((doc, { focusComposer = false } = {}) => {
    if (!doc || !onArtifact) return;
    const docArtifact = buildDocumentArtifactData(doc, transactions, reconciliationMatches);
    docArtifact.firmDocument = doc;
    if (focusComposer) {
      docArtifactFocusRequestRef.current += 1;
      docArtifact.focusComposerRequestId = docArtifactFocusRequestRef.current;
    }
    if (onCreateManualLink) {
      docArtifact.linkable = {
        transactions,
        reconciliationMatches,
        baseCurrency,
        onLink: async ({ bankTransactionId, reviewerNote = null }) =>
          onCreateManualLink({
            documentId: doc.id,
            bankTransactionId,
            reviewerNote
          }),
        onSnapshotApplied: onChatActionSnapshotApplied || null
      };
    }
    onArtifact({
      type: 'document',
      title: docArtifact.document?.title || doc.filename || message('mounted.financial.document'),
      data: docArtifact
    });
  }, [onArtifact, transactions, reconciliationMatches, baseCurrency, onCreateManualLink, onChatActionSnapshotApplied]);

  const openTransactionArtifact = useCallback((row, { markSeen = false } = {}) => {
    if (!row || !onArtifact) return;
    const transactionId = row.transactionId || row.id;
    const sourceTx = txByid.get(transactionId) || row._tx || null;
    const txMatch = matchesByTransactionId.get(transactionId) || null;
    const txMatchedDoc = txMatch?.matched_object_id
      ? documentsById.get(txMatch.matched_object_id) || null
      : null;
    const openDocument = (doc) => {
      if (!doc) return;
      const docArtifact = buildDocumentArtifactData(doc, transactions, reconciliationMatches);
      docArtifact.firmDocument = doc;
      onArtifact({
        type: 'document',
        title: docArtifact.document?.title || doc.filename || message('mounted.financial.document'),
        data: docArtifact
      });
    };
    const rejectMatch = (txMatch?.id && onUpdateReconciliationMatch)
      ? async () => {
          const proceed = typeof window !== 'undefined' && typeof window.confirm === 'function'
            ? window.confirm(message('mounted.financial.rejectMatchConfirm'))
            : true;
          if (!proceed) return;
          await onUpdateReconciliationMatch(txMatch.id, { status: 'rejected' });
        }
      : null;
    // Line-level confirm of THIS match (the server stamps a one-time authority
    // receipt on a held material match; it never mints a standing grant).
    const confirmMatch = (txMatch?.id && onUpdateReconciliationMatch)
      ? () => onUpdateReconciliationMatch(txMatch.id, { status: 'confirmed' })
      : null;
    onArtifact({
      type: 'transaction',
      title: sourceTx?.description || row.desc || message('mounted.financial.transaction'),
      data: {
        transaction: sourceTx || row,
        match: txMatch,
        matchedDocument: txMatchedDoc,
        onOpenMatchedDocument: txMatchedDoc ? () => openDocument(txMatchedDoc) : null,
        onOpenDocument: openDocument,
        onRejectMatch: rejectMatch,
        onConfirmMatch: confirmMatch,
        clientId,
        onSnapshotApplied: onDatabaseSnapshot,
        onUpdate: onUpdateTransaction,
        onApprove: onApproveTransaction,
        documents,
        transactions,
        reconciliationMatches
      }
    });
    if (markSeen) {
      const nowIso = new Date().toISOString();
      markTransactionChatSeen(clientId, transactionId, nowIso);
      setLastSeenMap((previous) => ({ ...previous, [transactionId]: nowIso }));
    }
  }, [
    onArtifact,
    txByid,
    matchesByTransactionId,
    documentsById,
    transactions,
    reconciliationMatches,
    onUpdateReconciliationMatch,
    clientId,
    onDatabaseSnapshot,
    onUpdateTransaction,
    onApproveTransaction
  ]);

  // Doc-row context menu + delete confirmation (single-doc: feed rows carry
  // no multi-select — bulk document work goes through the dock chat). The
  // shared components come from document-context-menu.jsx, the same ones the
  // Documents tab renders, so the two surfaces cannot drift while the flag
  // ramps.
  const [docContextMenu, setDocContextMenu] = useState(null); // { doc, x, y }
  const [docDeleteConfirm, setDocDeleteConfirm] = useState(null); // { doc }
  const [docDeletingId, setDocDeletingId] = useState(null);
  const dismissDocContextMenu = useCallback(() => setDocContextMenu(null), []);
  const confirmDocDelete = useCallback(async () => {
    const doc = docDeleteConfirm?.doc;
    setDocDeleteConfirm(null);
    if (!doc || !onDeleteDocument) return;
    setDocDeletingId(doc.id);
    try {
      // reportError defaults true — the app-level delete queue surfaces
      // failures (including retention holds) itself.
      await onDeleteDocument(doc.id);
    } finally {
      setDocDeletingId(null);
    }
  }, [docDeleteConfirm, onDeleteDocument]);
  const docContextMenuItems = docContextMenu ? [
    {
      id: 'open',
      label: intl.formatMessage({ id: 'mounted.document.openArtifact' }),
      hint: '↩',
      onSelect: () => {
        dismissDocContextMenu();
        openUnmatchedDocument(docContextMenu.doc);
      }
    },
    {
      id: 'ask-donna',
      label: intl.formatMessage({ id: 'mounted.document.askDonna' }),
      onSelect: () => {
        dismissDocContextMenu();
        openUnmatchedDocument(docContextMenu.doc, { focusComposer: true });
      }
    },
    ...(onDeleteDocument ? [{
      id: 'delete',
      label: intl.formatMessage({ id: 'mounted.document.deleteEllipsis' }),
      danger: true,
      separatorBefore: true,
      onSelect: () => {
        dismissDocContextMenu();
        setDocDeleteConfirm({ doc: docContextMenu.doc });
      }
    }] : [])
  ] : [];

  // PR 3 of docs/invoice-receipt-parsing-plan.md once surfaced
  // document_line review entries here (one row per offending line,
  // grouped per document by Stage A). They've since been moved to
  // the Documents inbox — those are documents-side parser-quality
  // signals, not transaction-side reconciliation signals; mixing
  // them onto the bank feed was a leaky abstraction.
  //
  // The Documents inbox row renders a source-level repair state when
  // a document's lines fail `totalsValidation`. Clicking the row opens
  // the canonical document conversation; parser internals are not
  // exposed as a second operator UI. The `transaction_review_queue`
  // rows themselves stay where they are — only the FE surface moved.

  const useMockRows = !databaseMode && liveRows.length === 0;
  const allRows = liveRows.length > 0 ? liveRows : useMockRows ? TXNS : [];
  const groupScopes = useMockRows ? AI_GROUPS : [];
  const activeGroup = groupScopes.find((x) => x.id === group) || null;
  const rowsByTransactionId = useMemo(() => {
    const map = new Map();
    for (const row of allRows) {
      if (row?.transactionId) map.set(row.transactionId, row);
      if (row?.id) map.set(row.id, row);
    }
    return map;
  }, [allRows]);
  const accounts = useMemo(() => {
    const normalised = (xeroAccounts || [])
      .map(normaliseXeroAccount)
      .filter(Boolean);
    return normalised.length > 0 ? normalised : ALL_CATS;
  }, [xeroAccounts]);

  const filtered = useMemo(
    () => (group ? allRows.filter((t) => t.group === group) : allRows),
    [allRows, group]
  );
  const periodOverview = useMemo(() => buildPeriodOverview({
    openRows: filtered,
    ownerRows,
    reconciledRows: reconciledHistoryRows,
    documentRows: unmatchedDocRows,
    closePeriods,
    transactions
  }), [filtered, ownerRows, reconciledHistoryRows, unmatchedDocRows, closePeriods, transactions]);
  // One line per live upload batch (2026-09-23), read off the receipts its
  // owed rows carry; settled and owner rows keep their own pills.
  const activityBatches = useMemo(
    () => (databaseMode ? activityBatchSummaries([...transactions, ...documents]) : []),
    [databaseMode, transactions, documents]
  );
  const displayPeriods = useMemo(() => {
    if (databaseMode) return periodOverview;
    const demoLanes = {
      monthKey: 'demo',
      label: 'Demo',
      openRows: filtered,
      ownerRows: [],
      documentRows: unmatchedDocRows,
      reconciledRows: [],
      closePeriod: null,
      closed: false,
      closeStatus: null,
      counts: { needsInput: 0, processing: filtered.length + unmatchedDocRows.length, stalled: 0, reconciled: 0, remaining: filtered.length + unmatchedDocRows.length }
    };
    return [{ ...demoLanes, stream: buildPeriodStream(demoLanes) }];
  }, [databaseMode, periodOverview, filtered, unmatchedDocRows]);

  const openPeriodClose = useCallback((period) => {
    if (!period?.closePeriod || !onArtifact) return;
    const closePeriod = period.closePeriod;
    const payload = closePeriod?.payload && typeof closePeriod.payload === 'object'
      ? closePeriod.payload
      : {};
    if (period.closed) {
      const archiveRecord = (Array.isArray(closeArchives) ? closeArchives : []).find(
        (archive) => snapshotDayString(archive?.period_start) === period.periodStart
          && snapshotDayString(archive?.period_end) === period.periodEnd
      ) || null;
      const periodJournals = (Array.isArray(ledgerJournals) ? ledgerJournals : []).filter((journal) => {
        const day = snapshotDayString(journal?.journal_date);
        return !!day && day >= period.periodStart && day <= period.periodEnd;
      });
      onArtifact({
        type: 'close_receipt',
        title: message('mounted.financial.periodClose', { period: period.label }),
        data: {
          clientId,
          periodStart: period.periodStart,
          periodEnd: period.periodEnd,
          label: period.label,
          closePeriod,
          archiveRecord,
          periodJournals
        }
      });
      return;
    }
    onArtifact({
      type: 'close_period',
      title: message('mounted.financial.periodClose', { period: period.label }),
      data: {
        clientId,
        periodStart: period.periodStart,
        periodEnd: period.periodEnd,
        label: period.label,
        status: period.closeStatus,
        lockable: payload.lockable === true,
        checkedAt: payload.generated_at || closePeriod?.updated_at || null,
        counts: payload.review_counts || null,
        evidenceRequests: clientEvidenceRequests,
        onDatabaseSnapshot
      }
    });
  }, [onArtifact, closeArchives, ledgerJournals, clientId, clientEvidenceRequests, onDatabaseSnapshot]);

  useEffect(() => {
    if (!group) return;
    if (!groupScopes.some((scope) => scope.id === group)) setGroup(null);
  }, [group, groupScopes]);

  // The id set the header checkbox + batch toolbar operate on. We treat a row
  // as syncable when it's a live row (has reviewItemId), is accepted/resolved
  // per the optimistic overlay or seed, and is not already synced.
  const selectable = useMemo(
    () =>
      filtered
        .filter((tx) => {
          if (!tx.reviewItemId) return false;
          if (tx.synced) return false;
          const overlay = reviewStates[tx.id] ?? tx.review_state;
          return overlay === 'accepted' || overlay === 'resolved';
        })
        .map((tx) => tx.id),
    [filtered, reviewStates]
  );

  // Prune selection when rows leave the syncable set (e.g. become synced).
  useEffect(() => {
    setSelectedIds((prev) => {
      const allowed = new Set(selectable);
      const next = new Set();
      prev.forEach((id) => {
        if (allowed.has(id)) next.add(id);
      });
      return next.size === prev.size ? prev : next;
    });
  }, [selectable]);

  // Pull the unread-chat summary for this client. Powers the small
  // V.intel dot on TxnRow that flags "client replied since you last
  // looked." Soft-fail — a transient fetch failure should not break
  // the bank-feed. Refetches when clientId changes (artifact-open
  // case also refetches via refreshUnreadChat below).
  const refreshUnreadChat = useRef(() => {});
  useEffect(() => {
    if (!clientId) {
      setUnreadChatSummary([]);
      setLastSeenMap({});
      refreshUnreadChat.current = () => {};
      return undefined;
    }
    let cancelled = false;
    const controller = new AbortController();
    setLastSeenMap(readLastSeenMap(clientId));
    const run = () => {
      fetchFirmTransactionChatUnreadSummary({ clientId, signal: controller.signal })
        .then((payload) => {
          if (cancelled) return;
          setUnreadChatSummary(Array.isArray(payload?.summary) ? payload.summary : []);
        })
        .catch((err) => {
          if (cancelled || err?.name === 'AbortError') return;
          // Soft-fail — badges stay where they were, no spinner, no toast.
        });
    };
    refreshUnreadChat.current = run;
    run();
    return () => {
      cancelled = true;
      controller.abort();
      refreshUnreadChat.current = () => {};
    };
  }, [clientId]);

  // Maps id → row, used by batch result rendering.
  const rowsById = useMemo(() => new Map(filtered.map((r) => [r.id, r])), [filtered]);

  useEffect(() => {
    if (!auditTransaction || !clientId) {
      setAuditTrail(null);
      setAuditStatus('idle');
      setAuditError(null);
      return undefined;
    }
    const transactionId = auditTransaction.transactionId || auditTransaction.id;
    if (!transactionId) return undefined;

    const controller = new AbortController();
    setAuditStatus('loading');
    setAuditTrail(null);
    setAuditError(null);
    fetchLedgerAuditTrail({
      clientId,
      transactionId,
      signal: controller.signal
    })
      .then((data) => {
        setAuditTrail(data || null);
        setAuditStatus('ready');
      })
      .catch((err) => {
        if (err?.name === 'AbortError') return;
        setAuditTrail(null);
        setAuditStatus('error');
        setAuditError(formatFirmError(err, message('mounted.financial.auditLoadFailed')));
      });

    return () => controller.abort();
  }, [auditTransaction, clientId]);

  // Helper: parse a writeback batch response, fold per-row results into local
  // state, return aggregate counts. Codex's contract:
  //   xero_writeback_batch.results[] — { transaction_id, status, coding,
  //     bank_account, bank_transaction, xero_bank_transaction_id,
  //     matched_existing, match_strategy, error, error_code }
  const ingestBatchResponse = (response, { dryRun }) => {
    const results = extractBatchResults(response);
    let synced = 0;
    let previewed = 0;
    let errors = 0;
    const nextResults = { ...rowResults };
    const nextErrors = { ...rowErrors };
    const nextStates = { ...reviewStates };
    results.forEach((r) => {
      const id = r.transaction_id;
      if (!id) return;
      const status = r.status;
      const errorCode = r.error_code || r.code;
      if (status === 'error' || errorCode) {
        errors += 1;
        nextErrors[id] = formatWritebackError(r, message);
      } else if (status === 'synced') {
        synced += 1;
        nextResults[id] = r;
        nextErrors[id] = null;
        if (!dryRun) nextStates[id] = 'synced';
      } else if (status === 'preview') {
        previewed += 1;
        nextResults[id] = r;
      }
    });
    setRowResults(nextResults);
    setRowErrors(nextErrors);
    if (!dryRun) setReviewStates(nextStates);
    return { synced, previewed, errors, total: results.length };
  };

  const runBatch = async ({ dryRun }) => {
    if (!clientId || selectedIds.size === 0) return;
    setBatchBusy(dryRun ? 'preview' : 'sync');
    setBatchError(null);
    setBatchSummary(null);
    try {
      const ids = Array.from(selectedIds)
        .map((id) => rowsById.get(id)?.transactionId || id)
        .filter(Boolean);
      const response = await writebackXeroTransactions({
        clientId,
        transactionIds: ids,
        dryRun
      });
      const counts = ingestBatchResponse(response, { dryRun });
      setBatchSummary({ ...counts, dryRun, when: Date.now() });
      // Keep selected set on dry_run so the user can re-press Sync; clear on
      // a real sync run since rows just transitioned to 'synced'.
      if (!dryRun) setSelectedIds(new Set());
    } catch (err) {
      setBatchError(formatFirmError(err, message('mounted.financial.writeback.batchFailed')));
    } finally {
      setBatchBusy(null);
    }
  };

  return (
    <>
      {codingBusy && <style>{`@keyframes codingPulse { 50% { opacity: 0.35; } }`}</style>}
      <div style={BANK_FEED_SECTION_STYLE}>
      {!databaseMode && <FeedSectionHeading label={intl.formatMessage({ id: 'lifecycle.open' })} count={allRows.length + unmatchedDocRows.length} />}
      {/* Doc-anchored Open rows (two-surface IA P2): parsed docs awaiting a
          bank line render as ordinary rows in the Open group, ahead of the
          tx-anchored feed and the empty state so an unmatched doc shows even
          when the bank feed itself is empty (nothing disappears). */}
      {!databaseMode && unmatchedDocRows.map((row) => (
        <DocFeedRow
          key={`doc:${row.id}`}
          row={row}
          active={activeFeedRowId === `open:doc:${row.id}`}
          deleting={docDeletingId != null && docDeletingId === row.document?.id}
          onOpen={openUnmatchedDocument}
          onContextMenu={(event) => {
            event.preventDefault();
            setDocContextMenu({ doc: row.document, x: event.clientX, y: event.clientY });
          }}
          onMenu={(event) => {
            event.stopPropagation();
            const rect = event.currentTarget.getBoundingClientRect();
            setDocContextMenu({ doc: row.document, x: rect.right - 220, y: rect.bottom + 4 });
          }}
        />
      ))}
      {/* AI coding runs automatically server-side as transactions land (parse
          worker → batchSuggestTransactionCodingInDb), so there is no manual
          "Run AI coding" control here anymore. */}
      {/* AI groups as scopes. Demo-only until live grouping is explicit. */}
      {groupScopes.length > 0 && (
      <div style={{ padding: '0 0 18px', display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div
            style={{
              fontSize: 12,
              fontWeight: 500,
              color: T.muted
            }}
          >
            {intl.formatMessage({ id: 'mounted.financial.aiGroups' }, { count: groupScopes.length })}
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button
              type="button"
              aria-label={intl.formatMessage({ id: 'mounted.financial.openAi' })}
              style={{
                font: 'inherit',
                fontSize: 12,
                padding: '5px 10px',
                borderRadius: 6,
                ...D.gradientBorder(),
                color: D.ink,
                fontWeight: 500,
                cursor: 'pointer'
              }}
            >
              {intl.formatMessage({ id: 'mounted.financial.aiScanOpen' })}
            </button>
            <button
              type="button"
              aria-label={intl.formatMessage({ id: 'mounted.financial.refreshAi' })}
              style={{
                font: 'inherit',
                fontSize: 12,
                padding: '5px 10px',
                borderRadius: 6,
                border: `1px solid ${T.rule}`,
                background: 'transparent',
                color: T.muted,
                cursor: 'pointer'
              }}
            >
              {intl.formatMessage({ id: 'mounted.financial.refresh' })}
            </button>
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button
            type="button"
            aria-label={intl.formatMessage({ id: 'mounted.financial.showAllAi' })}
            onClick={() => setGroup(null)}
            style={{
              font: 'inherit',
              fontSize: 13,
              padding: '10px 14px',
              borderRadius: 8,
              border: `1px solid ${!group ? T.ink : T.rule}`,
              background: !group ? T.ink : T.card,
              color: !group ? T.paper : T.inkSoft,
              cursor: 'pointer'
            }}
          >
            {intl.formatMessage({ id: 'mounted.financial.all' })} <span style={{ fontSize: 12, opacity: 0.7, marginInlineStart: 4, ...D.tabular }}>{allRows.length}</span>
          </button>
          {groupScopes.map((g) => (
            <GroupChip
              key={g.id}
              g={g}
              active={group === g.id}
              onClick={() => setGroup(group === g.id ? null : g.id)}
            />
          ))}
        </div>
        {group && (
          <div
            style={{
              marginTop: 4,
              padding: '12px 14px',
              background: T.card,
              borderRadius: 8,
              borderInlineStart: `2px solid ${T.accent}`
            }}
          >
            <div
              style={{
                fontSize: 12,
                fontWeight: 500,
                color: T.mutedSoft,
                marginBottom: 4
              }}
            >
              {message('mounted.financial.questionForClient')}
            </div>
            <p style={{ margin: 0, fontSize: 13, color: T.inkSoft, lineHeight: 1.55 }}>
              {activeGroup?.qId ? message(activeGroup.qId) : null}
            </p>
          </div>
        )}
      </div>
      )}

      {(databaseMode ? displayPeriods.length === 0 : allRows.length === 0) ? (
        // Suppress the "nothing to reconcile" empty state while unmatched docs
        // are surfaced above — otherwise the page would claim it's empty while
        // the safety-net section is listing pending documents right above it.
        unmatchedDocRows.length === 0 ? (
          <FinancialsEmptyState view="reconcile" documents={documents} transactions={transactions} />
        ) : null
      ) : (
        <>

      {/* Batch toolbar removed — the per-row Apply + checkbox-batch surface was
          retired in favour of the chat `sync_to_accounting` verb (batch) and
          the artifact "Send to Xero" button (single row). `runBatch`, the
          selection state (`selectedIds` / `batchBusy` / `batchSummary` /
          `batchError`) and the row `onApply` handler are intentionally LEFT in
          place — this is a render-only removal, so the feed no longer offers a
          posting affordance but nothing wired downstream breaks. */}

      {/* One date-sorted list per month — the month is a boundary label and
          the state is the row's own pill (Kari, 2026-08-31: "a single list
          can do it all with states"; 2026-09-01: the state-filter chips are
          gone — they made noise, and the month header's counts already carry
          the summary). */}
      {activityBatches.map((summary) => (
        <div
          key={summary.batch_id}
          className="bank-feed-batch-summary"
          role="status"
          style={{ fontSize: 12, color: T.inkSoft, padding: '8px 0', borderBottom: `1px solid ${T.ruleSoft}` }}
        >
          <span className="processing-label">
            {activityBatchSummaryParts(
              summary,
              intl.formatMessage,
              (name) => <BidiText direction="auto">{name}</BidiText>
            ).map((part, index) => (
              <Fragment key={index}>{index > 0 ? ' · ' : null}{part}</Fragment>
            ))}
          </span>
        </div>
      ))}
      {displayPeriods.map((period) => {
        const stream = period.stream || [];
        return (
          <section
            key={period.monthKey}
            style={{ margin: '6px 0', paddingBottom: 14 }}
          >
            {databaseMode && (
              <PeriodHeader
                period={period}
                onOpenClose={period.closePeriod ? () => openPeriodClose(period) : null}
              />
            )}
            {stream.map((entry) => {
              if (entry.lane === 'owner') {
                const row = entry.row;
                  const request = (row.reviewItemId && evidenceRequestsByTx.byReviewItem.get(row.reviewItemId))
                    || evidenceRequestsByTx.byTx.get(row.transactionId || row.id)
                    || null;
                  const identity = periodRowIdentity(row);
                  const transactionId = periodRowTransactionId(row);
                  const isFeedDecision = Boolean(row?.source_id && row?.verdict);
                  return (
                    <PeriodTransactionRow
                      key={`owner:${identity}`}
                      row={row}
                      lane="owner"
                      question={request?.question || request?.request_payload?.evidence_request?.question || null}
                      active={activeFeedRowId === `owner:${identity}`}
                      inFlight={Boolean(transactionId && inFlightTxIds?.has(String(transactionId)))}
                      receipt={transactionId ? liveReceipts[String(transactionId)] || null : null}
                      onOpen={isFeedDecision
                        ? (onActivatePeriodOwnerDecision
                            ? () => onActivatePeriodOwnerDecision(row, { explicit: true })
                            : null)
                        : () => openTransactionArtifact(row)}
                    />
                  );
              }
              if (entry.lane === 'document') {
                const row = entry.row;
                return (
                  <DocFeedRow
                    key={`doc:${row.id}`}
                    row={row}
                    active={activeFeedRowId === `open:doc:${row.id}`}
                    deleting={docDeletingId != null && docDeletingId === row.document?.id}
                    onOpen={openUnmatchedDocument}
                    onContextMenu={(event) => {
                      event.preventDefault();
                      setDocContextMenu({ doc: row.document, x: event.clientX, y: event.clientY });
                    }}
                    onMenu={(event) => {
                      event.stopPropagation();
                      const rect = event.currentTarget.getBoundingClientRect();
                      setDocContextMenu({ doc: row.document, x: rect.right - 220, y: rect.bottom + 4 });
                    }}
                  />
                );
              }
              if (entry.lane === 'open') {
                const tx = entry.row;
        const liveState = reviewStates[tx.id] ?? tx.review_state;
        const isBusy = !!busyRows[tx.id];
        const isSelectable = selectable.includes(tx.id);
        const liveTxId = String(tx.transactionId || tx.id);
        return (
          <TxnRow
            key={tx.id}
            liveReceipt={liveReceipts[liveTxId] || null}
            receiptInFlight={!!inFlightTxIds?.has(liveTxId)}
            tx={{
              ...tx,
              cat: overrides[tx.id] || tx.cat,
              review_state: liveState
            }}
            codingActive={codingBusy}
            expanded={openId === tx.id}
            active={activeFeedRowId === `open:${tx.id}`}
            accounts={accounts}
            busy={isBusy}
            selectable={isSelectable}
            selected={selectedIds.has(tx.id)}
            onToggleSelect={(checked) => {
              setSelectedIds((prev) => {
                const next = new Set(prev);
                if (checked) next.add(tx.id);
                else next.delete(tx.id);
                return next;
              });
            }}
            rowError={rowErrors[tx.id] || null}
            askResult={askResults[tx.id] || null}
            evidenceRequest={
              // Prefer a freshly-sent request (justSent path), then the
              // snapshot's persisted record by review_item_id (sharper
              // identity), then by transaction_id (covers rows whose
              // review_item_id we don't carry through the row shape).
              askResults[tx.id]?.evidence_request
                || (tx.reviewItemId && evidenceRequestsByTx.byReviewItem.get(tx.reviewItemId))
                || (tx.transactionId && evidenceRequestsByTx.byTx.get(tx.transactionId))
                || (tx.id && evidenceRequestsByTx.byTx.get(tx.id))
                || null
            }
            documentsById={documentsById}
            onDismissError={() => setRowErrors((prev) => ({ ...prev, [tx.id]: null }))}
            onShowAudit={() => {
              // Prefer the raw transaction record (richer fields:
              // ledger_journal_id, transaction_date, currency); fall back to
              // the row shape so the drawer still renders for mock/seed rows.
              const sourceTx = txByid.get(tx.transactionId || tx.id) || null;
              setAuditTransaction(sourceTx || tx);
            }}
            onToggle={() => {
              if (isBusy) return;
              const willOpen = openId !== tx.id;
              setOpenId(willOpen ? tx.id : null);
              if (willOpen && onArtifact) {
                openTransactionArtifact(tx, { markSeen: true });
                refreshUnreadChat.current();
              }
            }}
            unreadChat={unreadChatTxIds.has(tx.id)}
            onApply={async (account) => {
              if (!account) return;
              const displayName = account.name || account.label || '';
              const acceptedPatch = buildAcceptedPatch(account);

              // Optimistic UI: badge → Accepted, override → display name.
              setOverrides((prev) => ({ ...prev, [tx.id]: displayName }));
              setReviewStates((prev) => ({ ...prev, [tx.id]: 'accepted' }));
              setRowErrors((prev) => ({ ...prev, [tx.id]: null }));
              setOpenId(null);

              // Mock rows have no reviewItemId — pure visual demo.
              if (!tx.reviewItemId || !clientId) {
                if (typeof console !== 'undefined') {
                  console.debug(
                    '[donna] Apply (mock)',
                    tx.id,
                    'patch:',
                    acceptedPatch
                  );
                }
                return;
              }

              setBusyRows((prev) => ({ ...prev, [tx.id]: true }));
              const txId = tx.transactionId || tx.id;
              const isAlreadyAccepted = liveState === 'accepted' || liveState === 'resolved';
              try {
                // PATCH only when we're transitioning state (suggested → accepted).
                // Already-accepted rows skip straight to writeback so re-pressing
                // Apply just reissues the sync attempt.
                if (!isAlreadyAccepted) {
                  await setTransactionReviewItemState(tx.reviewItemId, 'accepted', acceptedPatch);
                }

                // Single-row writeback — Codex's contract:
                //   POST /api/donna/firms/xero/writeback-transaction
                //   { client_id, transaction_id, dry_run, force? }
                const response = await writebackXeroTransaction({
                  clientId,
                  transactionId: txId,
                  dryRun: false
                });

                // Single-row writeback returns the full firm snapshot with the
                // result wrapped under `xero_writeback`. Other shape fallbacks
                // are kept for forward compatibility with batch responses.
                const result =
                  response?.xero_writeback ||
                  response?.result ||
                  response?.xero_writeback_transaction ||
                  extractBatchResults(response)[0] ||
                  response;
                const status = result?.status;
                const errorCode = result?.error_code || result?.code;
                // BE returns the snapshot with synced_at + xero_bank_transaction_id
                // even when `status` isn't explicitly set. Treat presence of either
                // signal as a successful post.
                const looksSynced = !!(result?.xero_bank_transaction_id || result?.synced_at);

                if ((status === 'error' || errorCode) && !looksSynced) {
                  // ALREADY_SYNCED is treated as success: the row is in fact
                  // synced, so flip the state forward and clear the error.
                  if (errorCode === 'ALREADY_SYNCED' || errorCode === 409 || errorCode === '409') {
                    setReviewStates((prev) => ({ ...prev, [tx.id]: 'synced' }));
                    setRowResults((prev) => ({ ...prev, [tx.id]: result }));
                  } else {
                    setRowErrors((prev) => ({ ...prev, [tx.id]: formatWritebackError(result, message) }));
                  }
                } else {
                  setReviewStates((prev) => ({ ...prev, [tx.id]: 'synced' }));
                  setRowResults((prev) => ({ ...prev, [tx.id]: result }));
                }
              } catch (err) {
                setReviewStates((prev) => ({ ...prev, [tx.id]: tx.review_state || 'suggested' }));
                setOverrides((prev) => {
                  const next = { ...prev };
                  delete next[tx.id];
                  return next;
                });
                setRowErrors((prev) => ({
                  ...prev,
                  [tx.id]: formatWritebackError(err, message) || err?.message || message('mounted.financial.receipt.applyFailedSentence')
                }));
              } finally {
                setBusyRows((prev) => {
                  const next = { ...prev };
                  delete next[tx.id];
                  return next;
                });
              }
            }}
            onAsk={async () => {
              setReviewStates((prev) => ({ ...prev, [tx.id]: 'waiting' }));
              setRowErrors((prev) => ({ ...prev, [tx.id]: null }));
              // Keep the row expanded so the operator sees the just-sent
              // confirmation chip + status without having to re-open it.
              if (!tx.reviewItemId) return;
              setBusyRows((prev) => ({ ...prev, [tx.id]: true }));
              try {
                const response = await createClientEvidenceRequest({
                  clientId,
                  transactionId: tx.transactionId || tx.id,
                  reviewItemId: tx.reviewItemId,
                  question: `Please confirm the business purpose and upload supporting evidence for ${tx.desc || 'this transaction'}.`,
                  evidenceType: tx.status === 'nodoc' ? 'supporting_document' : 'business_purpose'
                });
                // Capture the evidence_request returned alongside the
                // snapshot — the chip renders id, status, due_at from this.
                // Fall back to a synthetic open record when the BE shape
                // differs so the UI still reflects the just-sent state.
                const evidenceRequest = response?.evidence_request
                  || response?.client_evidence_request
                  || null;
                if (response?.source === 'database' && typeof onDatabaseSnapshot === 'function') {
                  onDatabaseSnapshot(response);
                }
                setAskResults((prev) => ({
                  ...prev,
                  [tx.id]: {
                    justSent: true,
                    evidence_request: evidenceRequest || {
                      status: 'open',
                      transaction_id: tx.transactionId || tx.id,
                      review_item_id: tx.reviewItemId
                    }
                  }
                }));
              } catch (err) {
                setReviewStates((prev) => ({ ...prev, [tx.id]: tx.review_state || 'suggested' }));
                setRowErrors((prev) => ({
                  ...prev,
                  [tx.id]: formatFirmError(err, message('mounted.financial.askFailed'))
                }));
              } finally {
                setBusyRows((prev) => {
                  const next = { ...prev };
                  delete next[tx.id];
                  return next;
                });
              }
            }}
          />
        );
              }
              const row = entry.row;
              const transactionId = String(row.transactionId || row.id);
              return (
                <PeriodTransactionRow
                  key={`reconciled:${row.id}`}
                  row={row}
                  lane="reconciled"
                  active={activeFeedRowId === `reconciled:${row.id}`}
                  inFlight={!!inFlightTxIds?.has(transactionId)}
                  receipt={liveReceipts[transactionId] || null}
                  onOpen={() => openTransactionArtifact(row)}
                />
              );
            })}
          </section>
        );
      })}

      {/* Per-row error toast strip — non-modal so the user can retry inline. */}
      {Object.entries(rowErrors).filter(([, msg]) => msg).map(([id, msg]) => (
        <div
          key={`err-${id}`}
          style={{
            margin: '6px 0',
            padding: '8px 12px',
            background: T.alertSoft,
            color: T.alert,
            borderRadius: 8,
            fontSize: 12,
            display: 'flex',
            alignItems: 'center',
            gap: 8
          }}
        >
          <span>{intl.formatMessage({ id: 'lifecycle.row.error' }, { id: <IdentifierText>{id}</IdentifierText> })}</span>
          <span style={{ color: T.inkSoft }}><BidiText direction="auto">{msg}</BidiText></span>
          <button
            type="button"
            aria-label={intl.formatMessage({ id: 'lifecycle.row.dismissError' }, { id })}
            onClick={() => setRowErrors((prev) => ({ ...prev, [id]: null }))}
            style={{
              marginInlineStart: 'auto',
              font: 'inherit',
              fontSize: 11,
              padding: '2px 8px',
              borderRadius: 4,
              border: 'none',
              background: 'transparent',
              color: T.muted,
              cursor: 'pointer'
            }}
          >
            {intl.formatMessage({ id: 'common.dismiss' })}
          </button>
        </div>
      ))}

      {!databaseMode && (
      <div style={{ display: 'flex', justifyContent: 'center', padding: '20px 0' }}>
        <button
          type="button"
          aria-label={intl.formatMessage({ id: 'lifecycle.loadMore' }, { visible: 12, total: 66 })}
          style={{
            font: 'inherit',
            fontSize: 13,
            padding: '8px 16px',
            borderRadius: 8,
            border: `1px solid ${T.rule}`,
            background: T.card,
            color: T.inkSoft,
            cursor: 'pointer'
          }}
        >
          {intl.formatMessage({ id: 'lifecycle.loadMore' }, { visible: 12, total: 66 })}
        </button>
      </div>
      )}
        </>
      )}
    </div>
    {/* Audit drawer — mounted at the panel root so it overlays the
        workbench. Prefer the targeted audit-trail API; keep snapshot data as
        the honest fallback while the request is loading or if it fails. */}
    <LedgerAuditDrawer
      open={!!auditTransaction}
      transaction={auditTrail?.source_transaction || auditTransaction}
      ledgerAccounts={ledgerAccounts}
      ledgerJournals={auditTrail?.native_ledger?.journals || ledgerJournals}
      ledgerLines={
        auditTrail?.native_ledger?.journals
          ? auditTrail.native_ledger.journals.flatMap((journal) => journal.lines || [])
          : ledgerLines
      }
      status={auditStatus === 'idle' ? 'ready' : auditStatus}
      errorMessage={auditError}
      onClose={() => setAuditTransaction(null)}
    />
    {/* Doc-row context menu + delete confirmation (stage D) — both portal to
        document.body via the shared components. */}
    {docContextMenu && docContextMenuItems.length > 0 ? (
      <DocumentContextMenu
        menu={docContextMenu}
        items={docContextMenuItems}
        onDismiss={dismissDocContextMenu}
      />
    ) : null}
    {docDeleteConfirm ? (
      <DocumentDeleteConfirmation
        documents={[docDeleteConfirm.doc]}
        onCancel={() => setDocDeleteConfirm(null)}
        onConfirm={confirmDocDelete}
      />
    ) : null}
    </>
  );
}

// ── Other sub-tabs (port panels.jsx) ─────────────────────────────────────────

function CashFlowPanel() {
  const intl = useIntl();
  const { formatAmount } = useInterfaceLocale();
  const max = Math.max(...CASHFLOW.map((m) => Math.max(m.inc, m.exp)));
  return (
    <div style={{ padding: '24px 0' }}>
      <div
        style={{
          fontFamily: T.mono,
          fontSize: 10.5,
          letterSpacing: '0.14em',
          textTransform: 'uppercase',
          color: T.muted,
          marginBottom: 14
        }}
      >
        {intl.formatMessage({ id: 'mounted.financial.cashFlow' }, { count: 14 })}
      </div>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '90px 1fr 130px 130px 130px',
          gap: 16,
          padding: '8px 0',
          fontFamily: T.mono,
          fontSize: 10,
          textTransform: 'uppercase',
          letterSpacing: '0.14em',
          color: T.mutedSoft,
          borderBottom: `1px solid ${T.ruleSoft}`
        }}
      >
        <span>{intl.formatMessage({ id: 'mounted.financial.month' })}</span>
        <span>{intl.formatMessage({ id: 'mounted.financial.distribution' })}</span>
        <span style={{ textAlign: 'end' }}>{intl.formatMessage({ id: 'mounted.financial.income' })}</span>
        <span style={{ textAlign: 'end' }}>{intl.formatMessage({ id: 'mounted.financial.expenses' })}</span>
        <span style={{ textAlign: 'end' }}>{intl.formatMessage({ id: 'mounted.financial.netBalance' })}</span>
      </div>
      {CASHFLOW.map((m) => (
        <div
          key={m.m}
          style={{
            display: 'grid',
            gridTemplateColumns: '90px 1fr 130px 130px 130px',
            gap: 16,
            padding: '10px 0',
            borderBottom: `1px solid ${T.ruleMicro}`,
            alignItems: 'center'
          }}
        >
          <span style={{ fontSize: 13, color: T.inkSoft }}>{m.m}</span>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, height: 8 }}>
            <div style={{ flex: m.inc / max, height: 4, background: incomeColor, borderRadius: 2, opacity: 0.85 }} />
            <div style={{ flex: m.exp / max, height: 4, background: expenseColor, borderRadius: 2, opacity: 0.7 }} />
            <div style={{ flex: Math.max(0, 1 - (m.inc + m.exp) / max / 2), height: 4 }} />
          </div>
          <span
            style={{
              fontFamily: T.mono,
              fontSize: 12.5,
              color: incomeColor,
              textAlign: 'end',
              fontVariantNumeric: 'tabular-nums'
            }}
          >
            <FormattedValue>{formatAmount(m.inc, { currency: 'EUR', minimumFractionDigits: m.inc % 1 ? 2 : 0 })}</FormattedValue>
          </span>
          <span
            style={{
              fontFamily: T.mono,
              fontSize: 12.5,
              color: expenseColor,
              textAlign: 'end',
              fontVariantNumeric: 'tabular-nums'
            }}
          >
            <FormattedValue>{formatAmount(m.exp, { currency: 'EUR', minimumFractionDigits: m.exp % 1 ? 2 : 0 })}</FormattedValue>
          </span>
          <span style={{ textAlign: 'end' }}>
            <div
              style={{
                fontFamily: T.mono,
                fontSize: 12.5,
                color: m.net >= 0 ? incomeColor : expenseColor,
                fontVariantNumeric: 'tabular-nums',
                fontWeight: 500
              }}
            >
              {m.net >= 0 ? '+' : '−'}<FormattedValue>{formatAmount(Math.abs(m.net), { currency: 'EUR', minimumFractionDigits: Math.abs(m.net) % 1 ? 2 : 0 })}</FormattedValue>
            </div>
            <div style={{ fontFamily: T.mono, fontSize: 11, color: T.mutedSoft }}><FormattedValue>{formatAmount(m.bal, { currency: 'EUR', minimumFractionDigits: m.bal % 1 ? 2 : 0 })}</FormattedValue></div>
          </span>
        </div>
      ))}
    </div>
  );
}

function CategoriesPanel() {
  const intl = useIntl();
  const { formatAmount } = useInterfaceLocale();
  const total = EXPENSE_CATS.reduce((s, c) => s + c.total, 0);
  return (
    <div style={{ padding: '24px 0' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 14 }}>
        <div
          style={{
            fontFamily: T.mono,
            fontSize: 10.5,
            letterSpacing: '0.14em',
            textTransform: 'uppercase',
            color: T.muted
          }}
        >
          {intl.formatMessage({ id: 'mounted.financial.expensesCategory' })}
        </div>
        <div style={{ fontSize: 12, color: T.muted }}>
          {intl.formatMessage({ id: 'mounted.financial.categoryCoverage' }, { categorized: 84, unknown: 16 })}
        </div>
      </div>
      {EXPENSE_CATS.map((c) => (
        <div
          key={c.name}
          style={{
            display: 'grid',
            gridTemplateColumns: '220px 1fr 140px 60px 60px',
            gap: 16,
            alignItems: 'center',
            padding: '12px 0',
            borderBottom: `1px solid ${T.ruleMicro}`
          }}
        >
          <span
            style={{
              fontSize: 13.5,
              color: T.inkSoft,
              padding: '3px 9px',
              borderRadius: 999,
              background: c.name === 'Unknown' ? 'transparent' : T.amberSoft,
              justifySelf: 'start'
            }}
          >
            {c.name}
          </span>
          <div style={{ height: 6, background: T.ruleSoft, borderRadius: 3, overflow: 'hidden' }}>
            <div
              style={{
                width: `${(c.total / total) * 100}%`,
                height: '100%',
                background: c.name === 'Unknown' ? T.alert : T.ink,
                opacity: 0.85
              }}
            />
          </div>
          <span
            style={{
              fontFamily: T.mono,
              fontSize: 13,
              color: T.ink,
              textAlign: 'end',
              fontVariantNumeric: 'tabular-nums'
            }}
          >
            <FormattedValue>{formatAmount(c.total, { currency: 'EUR', minimumFractionDigits: c.total % 1 ? 2 : 0 })}</FormattedValue>
          </span>
          <span style={{ fontFamily: T.mono, fontSize: 12, color: T.muted, textAlign: 'end' }}>{c.pct}%</span>
          <span style={{ fontFamily: T.mono, fontSize: 12, color: T.mutedSoft, textAlign: 'end' }}>{c.txns}</span>
        </div>
      ))}
    </div>
  );
}

function RecentPanel({ databaseMode = false, transactions = [] }) {
  const { formatAmount, formatDate } = useInterfaceLocale();
  // Database mode renders the live bank feed (every imported row is
  // visible here, newest first) — RECENT is the mock-mode demo list.
  const rows = useMemo(() => {
    if (!databaseMode) return RECENT;
    return [...(Array.isArray(transactions) ? transactions : [])]
      .sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')))
      .slice(0, 25)
      .map((tx) => ({
        d: formatTxDate(tx.date, formatDate),
        desc: displayBankLineDescription(tx),
        cat: aiSuggestionAccount(tx.ai_suggestion)
          || (tx.category && tx.category !== 'unknown' ? tx.category : 'Unknown'),
        amt: formatTxAmount(tx, formatAmount)
      }));
  }, [databaseMode, formatAmount, formatDate, transactions]);
  return (
    <div style={{ padding: '24px 0' }}>
      <div
        style={{
          fontFamily: T.mono,
          fontSize: 10.5,
          letterSpacing: '0.14em',
          textTransform: 'uppercase',
          color: T.muted,
          marginBottom: 14
        }}
      >
        Recent transactions · last 25
      </div>
      {rows.map((r, i) => {
        const isIn = r.amt.startsWith('+');
        return (
          <div
            key={i}
            style={{
              display: 'grid',
              gridTemplateColumns: '64px 1fr 200px 110px',
              gap: 18,
              padding: '10px 0',
              borderBottom: `1px solid ${T.ruleMicro}`,
              alignItems: 'center'
            }}
          >
            <span style={{ fontFamily: T.mono, fontSize: 12, color: T.muted }}>{r.d}</span>
            <span
              style={{
                fontSize: 13.5,
                color: T.ink,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap'
              }}
            >
              {r.desc}
            </span>
            <span
              style={{
                fontSize: 12.5,
                color: T.inkSoft,
                padding: '3px 9px',
                borderRadius: 999,
                background:
                  r.cat === 'Unknown' ? 'transparent' : r.cat === 'Income' ? T.okSoft : T.amberSoft,
                justifySelf: 'start'
              }}
            >
              {r.cat}
            </span>
            <span
              style={{
                fontFamily: T.mono,
                fontSize: 13,
                color: isIn ? incomeColor : T.ink,
                textAlign: 'end',
                fontVariantNumeric: 'tabular-nums',
                fontWeight: 500
              }}
            >
              {r.amt}
            </span>
          </div>
        );
      })}
    </div>
  );
}

function ReconciledPanel({
  databaseMode = false,
  ledgerJournals = [],
  reconciledRows = [],
  transactions = [],
  documents = [],
  reconciliationMatches = [],
  clientId = null,
  onArtifact = null,
  onSnapshotApplied = null,
  onUpdate = null,
  onApprove = null,
  onUpdateReconciliationMatch = null,
  activeFeedRowId = null,
  // Slice 2 (realtime-truthful-feedback) — recodes of DECIDED rows land on
  // this tab, so it renders the same receipt cues as the Reconcile feed
  // (split-state chip, diff note, in-flight shimmer).
  liveReceipts = {},
  inFlightTxIds = null,
  // Stage C (C2a, Kari's pick 2026-08-26: "closed grouped, visually marked,
  // in the reconciled list itself"): under the close-fold flag the list
  // sorts by date and groups by month, and a month whose persisted
  // close_periods row is LOCKED carries the badge — render the persisted
  // verdict, never a re-derivation. Unconditional since the 2026-08-27
  // graduation.
  closePeriods = [],
  // C2c — the persisted close_archives rows, so the Locked badge's receipt
  // artifact opens with the saved continuity package (if any).
  closeArchives = []
} = {}) {
  // Completed history is reference material, not today's work. Month groups
  // therefore start collapsed and open only on demand; changing entity closes
  // any month left open in the previous book.
  const [expandedMonths, setExpandedMonths] = useState(() => new Set());
  useEffect(() => {
    setExpandedMonths(new Set());
  }, [clientId]);
  const toggleMonth = (monthKey) => {
    setExpandedMonths((previous) => {
      const next = new Set(previous);
      if (next.has(monthKey)) next.delete(monthKey);
      else next.add(monthKey);
      return next;
    });
  };
  const journalCount = databaseMode ? (Array.isArray(ledgerJournals) ? ledgerJournals.length : 0) : RECONCILE_COUNTS.done;
  const totalCount = journalCount + reconciledRows.length;
  // Stage A — row click opens the artifact panel for the tx, mirroring
  // the documents inbox. Reuses the same {transaction, match,
  // matchedDocument} payload shape the Reconcile tab uses so the
  // artifact panel renders identically on both surfaces.
  // C2a helpers — month key per row (from the SOURCE transaction's date, not
  // the display-formatted row date) and the locked months from the persisted
  // close_periods rows. C2c widened the Set to a Map (monthKey → period row)
  // so the badge can both render (has) and open the close receipt artifact
  // (get) from the same persisted verdict.
  const lockedMonths = useMemo(() => {
    const map = new Map();
    for (const p of closePeriods || []) {
      if (String(p?.status || '') !== 'locked') continue;
      // TZ-safe month key — a pg date column serialized on a non-UTC host
      // arrives shifted (Jan 1 reads "…-12-31T23:00Z"); a raw regex would
      // badge the WRONG month (the January-in-December canary sighting).
      const key = snapshotMonthKey(p.period_start);
      if (key) map.set(key, p);
    }
    return map;
  }, [closePeriods]);
  // C2c — the Locked badge opens the close receipt artifact: locked-at,
  // continuity package (generate/download), and the period's vouchers, all
  // captured from PERSISTED snapshot rows (close_periods, close_archives,
  // ledger_journals) at open time.
  const openCloseReceipt = (monthKey, monthLabel) => {
    if (!onArtifact) return;
    const period = lockedMonths.get(monthKey);
    if (!period) return;
    // TZ-safe day strings (see lockedMonths above) — the receipt's period
    // window, journal filter, and archive match all compare calendar days.
    const start = snapshotDayString(period.period_start);
    const end = snapshotDayString(period.period_end);
    const periodJournals = (Array.isArray(ledgerJournals) ? ledgerJournals : []).filter((journal) => {
      const day = snapshotDayString(journal?.journal_date);
      return !!day && day >= start && day <= end;
    });
    const archiveRecord = (Array.isArray(closeArchives) ? closeArchives : []).find(
      (a) => snapshotDayString(a?.period_start) === start
        && snapshotDayString(a?.period_end) === end
    ) || null;
    onArtifact({
      type: 'close_receipt',
      title: `${monthLabel} close`,
      data: {
        clientId,
        periodStart: start,
        periodEnd: end,
        label: monthLabel,
        closePeriod: period,
        archiveRecord,
        periodJournals
      }
    });
  };
  const txById = useMemo(
    () => new Map((transactions || []).map((tx) => [tx.id, tx])),
    [transactions]
  );
  const docsById = useMemo(
    () => new Map((documents || []).map((doc) => [doc.id, doc])),
    [documents]
  );
  const matchByTxId = useMemo(() => {
    const map = new Map();
    for (const match of reconciliationMatches || []) {
      if (match?.status === 'rejected') continue;
      const txId = match?.bank_transaction_id;
      if (!txId) continue;
      const existing = map.get(txId);
      if (!existing) { map.set(txId, match); continue; }
      const priority = { confirmed: 3, auto_matched: 2, suggested: 1 };
      if ((priority[match.status] || 0) > (priority[existing.status] || 0)) map.set(txId, match);
    }
    return map;
  }, [reconciliationMatches]);
  const openTx = (rowTx) => {
    if (!onArtifact || !rowTx) return;
    const sourceTx = txById.get(rowTx.transactionId || rowTx.id) || rowTx._tx || null;
    const txMatch = matchByTxId.get(rowTx.transactionId || rowTx.id) || null;
    const txMatchedDoc = txMatch?.matched_object_id ? docsById.get(txMatch.matched_object_id) || null : null;
    // Stage B parity with the Reconcile-tab openTx — "Review document
    // details" on the hero needs to swap to the doc-side artifact.
    const openMatchedDocument = txMatchedDoc
      ? () => {
          const docArtifact = buildDocumentArtifactData(txMatchedDoc, transactions, reconciliationMatches);
          docArtifact.firmDocument = txMatchedDoc;
          onArtifact({
            type: 'document',
            title: docArtifact.document?.title || txMatchedDoc.filename || 'Document',
            data: docArtifact
          });
        }
      : null;
    // Stage B follow-up: Reject affordance on the MatchHero. Same
    // shape as the Reconcile-tab path.
    const rejectMatch = (txMatch?.id && onUpdateReconciliationMatch)
      ? async () => {
          const proceed = typeof window !== 'undefined'
            && typeof window.confirm === 'function'
            ? window.confirm("Reject this match? The transaction will need a fresh review and this document won't auto-match it again.")
            : true;
          if (!proceed) return;
          await onUpdateReconciliationMatch(txMatch.id, { status: 'rejected' });
        }
      : null;
    // Stage E — generic opener (see ReconcilePanel openTx).
    const openDocument = (doc) => {
      if (!doc) return;
      const docArtifact = buildDocumentArtifactData(doc, transactions, reconciliationMatches);
      docArtifact.firmDocument = doc;
      onArtifact({
        type: 'document',
        title: docArtifact.document?.title || doc.filename || 'Document',
        data: docArtifact
      });
    };
    onArtifact({
      type: 'transaction',
      title: sourceTx?.description || rowTx.desc || 'Transaction',
      data: {
        transaction: sourceTx || rowTx,
        match: txMatch,
        matchedDocument: txMatchedDoc,
        onOpenMatchedDocument: openMatchedDocument,
        onOpenDocument: openDocument,
        onRejectMatch: rejectMatch,
        clientId,
        onSnapshotApplied,
        onUpdate,
        onApprove,
        documents,
        transactions,
        reconciliationMatches
      }
    });
  };
  // C2a — resolve a row's month from its source transaction; rows without a
  // parsable date ride the preceding group without minting a heading.
  const monthKeyFor = (tx) => {
    const rowTx = tx._tx || txById.get(tx.transactionId || tx.id) || null;
    // TZ-safe: tx.date is a pg date column — see lockedMonths above.
    return snapshotMonthKey(rowTx?.date || rowTx?.created_at);
  };
  const displayRows = useMemo(() => {
    // Sort by the SAME normalized day the month keys derive from, so a
    // shifted serialized date can never interleave two month groups.
    const ts = (tx) => {
      const rowTx = tx._tx || txById.get(tx.transactionId || tx.id) || null;
      const day = snapshotDayString(rowTx?.date || rowTx?.created_at);
      const t = day ? Date.parse(`${day}T00:00:00Z`) : NaN;
      return Number.isFinite(t) ? t : -Infinity;
    };
    return [...reconciledRows].sort((a, b) => ts(b) - ts(a));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reconciledRows, txById]);
  // Rows without a usable date keep riding the preceding month, matching the
  // pre-collapse rendering. A fully undated history gets one honest fallback
  // group instead of losing its rows.
  let previousDisplayMonth = null;
  const displayEntries = displayRows.map((tx) => {
    const explicitMonth = monthKeyFor(tx);
    if (explicitMonth) previousDisplayMonth = explicitMonth;
    return {
      tx,
      monthKey: explicitMonth || previousDisplayMonth || 'undated'
    };
  });
  const displayMonthCounts = displayEntries.reduce((counts, entry) => {
    counts.set(entry.monthKey, (counts.get(entry.monthKey) || 0) + 1);
    return counts;
  }, new Map());
  return (
    <div style={BANK_FEED_SECTION_STYLE}>
      <FeedSectionHeading label="Reconciled" count={totalCount} />
      {displayRows.length > 0 ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
          {displayEntries.map(({ tx, monthKey }, rowIndex) => {
            const rowTx = tx._tx || txById.get(tx.transactionId || tx.id) || null;
            const clickable = !!(onArtifact && rowTx);
            const liveTxId = String(tx.transactionId || tx.id);
            const rowInFlight = !!inFlightTxIds?.has(liveTxId);
            const feedRowId = `reconciled:${tx.id}`;
            const active = activeFeedRowId === feedRowId;
            // C2a — a month sub-heading opens each group; the badge renders
            // the persisted locked verdict for that month.
            const prevMonthKey = rowIndex > 0 ? displayEntries[rowIndex - 1].monthKey : null;
            const showMonthHeading = !!monthKey && monthKey !== prevMonthKey;
            const monthLabel = showMonthHeading
              ? (monthKey === 'undated' ? 'Date unavailable' : monthKeyLabel(monthKey))
              : null;
            const monthExpanded = expandedMonths.has(monthKey);
            const monthCount = showMonthHeading ? displayMonthCounts.get(monthKey) || 0 : 0;
            return (
              <div key={tx.id}>
              {showMonthHeading && (
                <div
                  data-reconciled-month={monthKey}
                  style={{
                    display: 'flex',
                    alignItems: 'baseline',
                    gap: 10,
                    padding: '16px 0 6px',
                    borderBottom: `1px solid ${T.ruleSoft}`
                  }}
                >
                  <button
                    type="button"
                    aria-expanded={monthExpanded}
                    onClick={() => toggleMonth(monthKey)}
                    style={{
                      font: 'inherit',
                      border: 'none',
                      background: 'transparent',
                      color: T.inkSoft,
                      padding: 0,
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 7,
                      cursor: 'pointer'
                    }}
                  >
                    <span aria-hidden="true" style={{ width: 10, color: T.muted }}>{monthExpanded ? '⌄' : '›'}</span>
                    <span style={{ fontSize: 12.5, fontWeight: 700 }}>{monthLabel}</span>
                    <span style={BANK_FEED_SECTION_COUNT_STYLE}>{monthCount}</span>
                  </button>
                  {lockedMonths.has(monthKey) && (
                    // C2c: the badge is the doorway to the close receipt
                    // artifact — the §2 "receipt when it closes".
                    <button
                      type="button"
                      onClick={() => openCloseReceipt(monthKey, monthLabel)}
                      title={intl.formatMessage({ id: 'mounted.financial.openCloseReceipt' })}
                      style={{
                        font: 'inherit',
                        fontSize: 10.5,
                        fontWeight: 600,
                        fontFamily: T.mono,
                        letterSpacing: '0.05em',
                        textTransform: 'uppercase',
                        color: T.ok,
                        background: T.okSoft,
                        border: 'none',
                        padding: '2px 8px',
                        borderRadius: 999,
                        whiteSpace: 'nowrap',
                        cursor: onArtifact ? 'pointer' : 'default'
                      }}
                    >
                      Locked
                    </button>
                  )}
                </div>
              )}
              {monthExpanded && <div
                className={clickable ? 'bank-feed-list-row' : undefined}
                data-bank-feed-list-row={clickable ? 'true' : undefined}
                data-bank-feed-row-id={clickable ? feedRowId : undefined}
                role={clickable ? 'button' : undefined}
                tabIndex={clickable ? 0 : undefined}
                onClick={clickable ? () => openTx(tx) : undefined}
                onKeyDown={clickable ? (e) => {
                  if (e.target !== e.currentTarget) return;
                  if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') {
                    e.preventDefault();
                    openTx(tx);
                  }
                } : undefined}
                title={rowInFlight ? 'Apply in flight — waiting for the persisted receipt…' : undefined}
                style={{
                  ...BANK_FEED_ROW_STYLE,
                  color: T.ink,
                  cursor: clickable ? 'pointer' : 'default',
                  background: active ? T.card : 'transparent',
                  transition: 'background .15s',
                  ...(rowInFlight ? { animation: 'receiptInFlightPulse 1.1s ease-in-out infinite' } : {})
                }}
                onMouseEnter={(e) => { if (clickable) e.currentTarget.style.background = T.card; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = active ? T.card : 'transparent'; }}
              >
                <ReconciledDot />
                <span style={BANK_FEED_DATE_STYLE}>{tx.date}</span>
                <span style={{ ...BANK_FEED_PRIMARY_STYLE, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {tx.desc}
                </span>
                <span style={{
                  ...BANK_FEED_AMOUNT_STYLE,
                  color: tx.amount?.startsWith('+') ? BANK_FEED_INCOME_COLOR : T.ink
                }}>
                  {tx.amount}
                </span>
                <span style={{ ...BANK_FEED_TRAILING_CELL_STYLE, display: 'flex' }}>
                  <LiveCategoryCell
                    name={tx.cat || tx.aiCat}
                    missing={!tx.cat && !tx.aiCat}
                    receipt={liveReceipts[liveTxId] || null}
                  />
                </span>
              </div>}
              </div>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}


// ── Public component ─────────────────────────────────────────────────────────

export default function DonnaFinancialsPanel({
  profile,
  firmId = null,
  firmDataSource = 'local',
  transactions: snapshotTransactions = [],
  transactionReviewQueue = [],
  clientEvidenceRequests = [],
  periodOwnerDecisions = [],
  onActivatePeriodOwnerDecision = null,
  // Snapshot documents — used by Reconcile's expanded row to confirm an
  // evidence request's attachments are still resolvable in this client's
  // document set before showing the "Open evidence" affordance.
  documents: snapshotDocuments = [],
  reconciliationMatches = [],
  ledgerAccounts = [],
  ledgerJournals = [],
  ledgerLines = [],
  onDatabaseSnapshot,
  // Console-level registration hook: FeedChat now lives in the right dock
  // (FirmOpsConsole → FirmDock), so this panel registers its apply-lifecycle
  // handler upward instead of mounting the chat itself.
  onRegisterFeedApplyLifecycle,
  // Registers the feed's extra views (Facts/Recent/…) with the entity
  // toolbar's single ⋯ menu — see FinancialsTabs.
  onRegisterFeedViewMenu = null,
  onBatchSuggestTransactionCoding,
  // Right-side artifact panel hook — when present, clicking a transaction
  // row opens the same case-file artifact used by Documents. Lets the
  // firm investigate a row (amount, description, signals, ask client,
  // remember-merchant rule) on the unified surface instead of the inline
  // expand only. The inline expand still toggles in parallel so the
  // existing fast keyboard categorise path (GhostPicker ↵/Tab) is
  // preserved; a follow-up consolidates them.
  onArtifact,
  onUpdateTransaction,
  onApproveTransaction,
  // PATCH /reconciliation-matches/:id. Threaded through so the bank-
  // feed-side MatchHero (transaction-artifact.jsx) can offer a Reject
  // affordance when the matcher's auto/suggested verdict is wrong —
  // mirrors the rejectMatch path financials-view.jsx already uses on
  // the Reconciled tab. Calls with { status: 'rejected' }; the BE
  // cascade reverts the tx's reconciliation_status.
  onUpdateReconciliationMatch,
  // Per-doc actions for the doc-anchored Open rows (two-surface IA stage D
  // §3): manual link + delete + the doc artifact's chat — the Documents tab's
  // affordances, threaded here so the fold loses nothing.
  baseCurrency = '',
  onCreateManualLink = null,
  onChatActionSnapshotApplied = null,
  onDeleteDocument = null,
  // Stage C (C2a): persisted close_periods rows — the Reconciled list's
  // month grouping renders the locked badge from these, never from a
  // re-derivation.
  closePeriods = [],
  // Stage C (C2c): persisted close_archives rows for the Locked badge's
  // close receipt artifact.
  closeArchives = []
} = {}) {
  const [activityClock, setActivityClock] = useState(Date.now);
  const [activityRefreshFailed, setActivityRefreshFailed] = useState(false);
  const awaitingRefresh = firmDataSource === 'database' && typeof onDatabaseSnapshot === 'function' && !activityRefreshFailed;
  const transactions = useMemo(() => expireProcessingActivity(snapshotTransactions, activityClock, { awaitingRefresh }), [snapshotTransactions, activityClock, awaitingRefresh]);
  const documents = useMemo(() => expireProcessingActivity(snapshotDocuments, activityClock, { awaitingRefresh }), [snapshotDocuments, activityClock, awaitingRefresh]);
  const hasActivity = [...snapshotTransactions, ...snapshotDocuments].some(row => row.processing_activity);
  useEffect(() => {
    if (!hasActivity) return undefined;
    setActivityClock(Date.now());
    const timer = setInterval(() => setActivityClock(Date.now()), 5000);
    return () => clearInterval(timer);
  }, [hasActivity, snapshotTransactions, snapshotDocuments]);
  const [sub, setSub] = useState('feed');
  const [activeFeedRowId, setActiveFeedRowId] = useState(null);
  const clientId = profile?.id || null;
  const databaseMode = firmDataSource === 'database';
  const intl = useIntl();
  const { formatAmount, formatDate } = useInterfaceLocale();
  const localeFormatters = useMemo(() => ({ formatAmount, formatDate }), [formatAmount, formatDate]);

  // One keyboard model for the ONE SCROLL Bank Feed. Focus stays on the row
  // after click, then Up/Down walks every interactive row across both Open and
  // Reconciled, activates the same click path, and keeps the next row visible.
  // Editable controls never enter this handler because they live either in the
  // artifact rail or inside a row and are explicitly ignored here.
  const handleFeedListKeyDown = useCallback((event) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
    const target = event.target;
    if (!(target instanceof Element)) return;
    if (target.matches('input, textarea, select, [contenteditable="true"]')) return;
    const currentRow = target.closest('[data-bank-feed-list-row="true"]');
    if (!currentRow || !event.currentTarget.contains(currentRow)) return;
    const rows = Array.from(event.currentTarget.querySelectorAll('[data-bank-feed-list-row="true"]'));
    const index = rows.indexOf(currentRow);
    if (index < 0) return;
    const offset = event.key === 'ArrowDown' ? 1 : -1;
    const nextRow = rows[Math.max(0, Math.min(rows.length - 1, index + offset))];
    if (!nextRow || nextRow === currentRow) return;
    event.preventDefault();
    event.stopPropagation();
    setActiveFeedRowId(nextRow.dataset.bankFeedRowId || null);
    nextRow.focus({ preventScroll: true });
    nextRow.click();
    nextRow.scrollIntoView({ block: 'nearest' });
  }, []);

  const selectFeedRowFromEvent = useCallback((event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const row = target.closest('[data-bank-feed-list-row="true"]');
    if (!row) return;
    setActiveFeedRowId(row.dataset.bankFeedRowId || null);
    // Electron does not apply the browser's click-focus convention uniformly
    // across platforms for div[tabindex]. Make it explicit so a mouse click is
    // always enough to hand subsequent Up/Down keys to the list.
    if (event.type === 'click' && document.activeElement !== row) {
      row.focus({ preventScroll: true });
    }
  }, []);

  useEffect(() => {
    setActiveFeedRowId(null);
  }, [clientId, sub]);
  const isGbClient = String(profile?.jurisdiction || profile?.profile?.jurisdiction || '').toUpperCase() === 'GB';
  const [gbVatEnvelope, setGbVatEnvelope] = useState(null);
  const [gbStatutoryEnvelope, setGbStatutoryEnvelope] = useState(null);
  useEffect(() => {
    if (!databaseMode || !clientId || !isGbClient) { setGbVatEnvelope(null); return undefined; }
    const controller = new AbortController();
    fetchGbVatReturn({ clientId, signal: controller.signal }).then(setGbVatEnvelope).catch((error) => { if (error?.name !== 'AbortError') setGbVatEnvelope(null); });
    return () => controller.abort();
  }, [databaseMode, clientId, isGbClient]);
  const gbVatView = useMemo(() => buildGbVatReturnViewModel(gbVatEnvelope), [gbVatEnvelope]);
  useEffect(() => { if (!databaseMode || !clientId || !isGbClient) { setGbStatutoryEnvelope(null); return undefined; } const controller = new AbortController(); fetchGbStatutory({ clientId, signal: controller.signal }).then(setGbStatutoryEnvelope).catch(() => setGbStatutoryEnvelope(null)); return () => controller.abort(); }, [databaseMode, clientId, isGbClient]);
  const gbStatutoryView = useMemo(() => selectGbStatutoryAttention(buildGbStatutoryViewModel(gbStatutoryEnvelope)), [gbStatutoryEnvelope]);
  const [gbLtdClose, setGbLtdClose] = useState(null);
  useEffect(() => { if (!databaseMode || !clientId || !isGbClient) { setGbLtdClose(null); return undefined; } const controller = new AbortController(); fetchGbLtdClose({ clientId, signal: controller.signal }).then(setGbLtdClose).catch(() => setGbLtdClose(null)); return () => controller.abort(); }, [databaseMode, clientId, isGbClient]);

  const topLevelTxByid = useMemo(
    () => new Map((transactions || []).map((tx) => [tx.id, tx])),
    [transactions]
  );
  const reconciledRows = useMemo(() => {
    if (!Array.isArray(transactionReviewQueue) || transactionReviewQueue.length === 0) return [];
    return transactionReviewQueue
      .filter((item) => {
        if (item?.status && item.status !== 'open') return false;
        if (item?.item_type === 'document_line') return false;
        // Reconciled = the auto_reconciled terminal (render the convergence
        // verdict, not the legacy review_state set). Legacy fallback for
        // pre-convergence_state snapshots (mock / seed mode).
        const conv = item?.convergence_state;
        if (conv) return conv === 'auto_reconciled';
        const rs = getReviewState(item) || 'suggested';
        return RECONCILED_STATES.has(rs);
      })
      .map((item) => buildLiveRow(item, topLevelTxByid, localeFormatters))
      .filter(Boolean);
  }, [transactionReviewQueue, topLevelTxByid, localeFormatters]);

  // Mirror of ReconcilePanel's liveRows — the tab badge counts exactly the
  // rows that tab renders.
  // The bulk of doc-matched bank lines never get an open queue row, so their
  // tab membership is decided off the transaction's convergence verdict
  // (partitionBareReconcileTxs) — the SAME projection the review-item paths use.
  // Split once: `hanging` joins the Reconcile feed (matched-but-uncoded Suspense
  // lines that previously leaked into Reconciled), `auto_reconciled` the
  // Reconciled feed. 'posted' / 'auto_reconciled' / 'explained' that are coded
  // still land in `reconciled` via the verdict; an uncoded one is now correctly
  // surfaced as hanging instead of read as done.
  const bareTxRows = useMemo(
    () => partitionBareReconcileTxs(transactionReviewQueue, transactions),
    [transactionReviewQueue, transactions]
  );
  const reconcileTxRows = useMemo(
    () => bareTxRows.hanging.map((transaction) => transactionToReconciledRow(transaction, localeFormatters)),
    [bareTxRows, localeFormatters]
  );
  const reconciledTxRows = useMemo(
    () => bareTxRows.reconciled.map((transaction) => transactionToReconciledRow(transaction, localeFormatters)),
    [bareTxRows, localeFormatters]
  );

  // Doc-anchored Open rows (two-surface IA P2) — the same selection
  // ReconcilePanel renders in the period's Donna lane, counted by the same
  // pure projection that places the row under its accounting month.
  const unmatchedDocRows = useMemo(() => {
    if (firmDataSource !== 'database') return [];
    return selectMaterialOpenDocumentRows({
      documents,
      transactions,
      reconciliationMatches,
      reviewItems: transactionReviewQueue,
      clientEvidenceRequests
    })
      .slice()
      .sort((a, b) => String(b.documentDate || '').localeCompare(String(a.documentDate || '')));
  }, [firmDataSource, documents, transactions, reconciliationMatches, transactionReviewQueue, clientEvidenceRequests]);

  const allReconciledRows = useMemo(
    () => [...reconciledRows, ...reconciledTxRows],
    [reconciledRows, reconciledTxRows]
  );

  const ownerRows = useMemo(() => {
    const reviewRows = onOwnerItems(transactionReviewQueue)
      .map((item) => buildLiveRow(item, topLevelTxByid, localeFormatters))
      .filter(Boolean);
    const bareRows = bareTxRows.onOwner.map((transaction) => transactionToReconciledRow(transaction, localeFormatters));
    // Feed decisions lead so buildPeriodOverview's owner-first identity
    // de-duplication preserves their risk label (for example tax-sensitive)
    // while removing the thinner copy of the same bank line.
    return [...periodOwnerDecisions, ...reviewRows, ...bareRows];
  }, [periodOwnerDecisions, transactionReviewQueue, topLevelTxByid, bareTxRows, localeFormatters]);

  // Pull the Xero chart of accounts from the status endpoint once per client
  // — Reconcile's category picker uses these so Apply patches carry the
  // tenant's real account codes / tax types instead of mock values.
  const [xeroAccounts, setXeroAccounts] = useState([]);
  useEffect(() => {
    if (!clientId) {
      setXeroAccounts([]);
      return;
    }
    let cancelled = false;
    fetchXeroStatus({ clientId })
      .then((status) => {
        if (cancelled) return;
        setXeroAccounts(Array.isArray(status?.accounts) ? status.accounts : []);
      })
      .catch(() => {
        if (cancelled) return;
        setXeroAccounts([]);
      });
    return () => {
      cancelled = true;
    };
  }, [clientId]);

  // FI-12 read surface — the persisted annual-return verdict. Same lifecycle as
  // the close-blockers fetch: flag-off (the DB caller's typed 403) or any error
  // ⇒ null ⇒ the Veroilmoitus tab never appears; prod is byte-identical. The
  // year picker refetches by changing annualReturnYear.
  // Design: docs/design-donna-finland-fi12-read-surface.md.
  const [annualReturnYear, setAnnualReturnYear] = useState(() => new Date().getUTCFullYear());
  const [annualReturnEnvelope, setAnnualReturnEnvelope] = useState(null);
  useEffect(() => {
    if (!databaseMode || !clientId) {
      setAnnualReturnEnvelope(null);
      return;
    }
    let cancelled = false;
    const controller = new AbortController();
    fetchFinlandAnnualReturn({ clientId, taxYear: annualReturnYear, signal: controller.signal })
      .then((data) => {
        if (cancelled) return;
        setAnnualReturnEnvelope(data && data.review && data.return ? data : null);
      })
      .catch((err) => {
        if (cancelled || err?.name === 'AbortError') return;
        setAnnualReturnEnvelope(null);
      });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [databaseMode, clientId, firmId, annualReturnYear]);

  // FI-3 read surface — the ALV-return envelope + persisted lifecycle row. Same
  // lifecycle as the annual-return fetch: flag-off (typed 403) or any error ⇒
  // null ⇒ the ALV tab never appears; prod is byte-identical. The period picker
  // refetches by changing alvPeriod (default: the previous month, D3).
  // Design: docs/design-donna-finland-fi3-alv-return.md.
  const [alvPeriod, setAlvPeriod] = useState(() => defaultAlvPeriodKey(new Date()));
  const [alvReturnEnvelope, setAlvReturnEnvelope] = useState(null);
  useEffect(() => {
    if (!databaseMode || !clientId) {
      setAlvReturnEnvelope(null);
      return;
    }
    let cancelled = false;
    const controller = new AbortController();
    fetchFinlandAlvReturn({ clientId, period: alvPeriod, signal: controller.signal })
      .then((data) => {
        if (cancelled) return;
        setAlvReturnEnvelope(data && data.review && data.alvReturn ? data : null);
      })
      .catch((err) => {
        if (cancelled || err?.name === 'AbortError') return;
        setAlvReturnEnvelope(null);
      });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [databaseMode, clientId, firmId, alvPeriod]);

  // G-3 follow-up — the Suomi.fi mandate status for the ALV filing surface.
  // Gated on the ALV envelope being live (the mandate strip only means
  // something on a Finnish ALV book); any error ⇒ null ⇒ no strip, prod is
  // byte-identical. Render-the-persisted-verdict: the envelope carries the
  // SAME dated evaluation the filing gate uses.
  const [suomifiMandateEnvelope, setSuomifiMandateEnvelope] = useState(null);
  const alvSurfaceLive = alvReturnEnvelope !== null;
  useEffect(() => {
    if (!databaseMode || !clientId || !alvSurfaceLive) {
      setSuomifiMandateEnvelope(null);
      return;
    }
    let cancelled = false;
    const controller = new AbortController();
    fetchFinlandSuomifiMandate({ clientId, signal: controller.signal })
      .then((data) => {
        if (cancelled) return;
        setSuomifiMandateEnvelope(data && data.evaluation ? data : null);
      })
      .catch((err) => {
        if (cancelled || err?.name === 'AbortError') return;
        setSuomifiMandateEnvelope(null);
      });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [databaseMode, clientId, firmId, alvSurfaceLive]);

  // FI production-readiness P0 — the ALV registration-threshold watch for a
  // NON-registered client (docs/design-donna-finland-production-readiness.md).
  // Flag-off (typed 403), not-applicable (ALV-registered client), or any error
  // ⇒ null ⇒ no banner; prod is byte-identical until the flag acts.
  const [alvThresholdWatch, setAlvThresholdWatch] = useState(null);
  useEffect(() => {
    if (!databaseMode || !clientId) {
      setAlvThresholdWatch(null);
      return;
    }
    let cancelled = false;
    const controller = new AbortController();
    fetchFinlandAlvThresholdWatch({ clientId, signal: controller.signal })
      .then((data) => {
        if (cancelled) return;
        setAlvThresholdWatch(data?.watch?.applicable ? data.watch : null);
      })
      .catch((err) => {
        if (cancelled || err?.name === 'AbortError') return;
        setAlvThresholdWatch(null);
      });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [databaseMode, clientId, firmId]);

  // G-7 (FI-15) — scope-drift detection: deterministic drift triggers over the
  // posted ledger + bank feed. Flag-off (typed 403) or any error ⇒ null ⇒ no
  // banner; prod is byte-identical until FINLAND_SCOPE_DRIFT_WATCH acts. Only
  // an actual drift verdict (≠ supported) renders.
  const [scopeDrift, setScopeDrift] = useState(null);
  useEffect(() => {
    if (!databaseMode || !clientId) {
      setScopeDrift(null);
      return;
    }
    let cancelled = false;
    const controller = new AbortController();
    fetchFinlandScopeDrift({ clientId, signal: controller.signal })
      .then((data) => {
        if (cancelled) return;
        const drift = data?.drift;
        setScopeDrift(drift && drift.verdict !== 'supported' ? drift : null);
      })
      .catch((err) => {
        if (cancelled || err?.name === 'AbortError') return;
        setScopeDrift(null);
      });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [databaseMode, clientId, firmId]);

  // G-4 (FI-15) — the YEL watch: quiet on active/exempt, a nudge line for
  // everything else. Flag-off (typed 403) or any error ⇒ null ⇒ no banner.
  const [yelStatus, setYelStatus] = useState(null);
  useEffect(() => {
    if (!databaseMode || !clientId) {
      setYelStatus(null);
      return;
    }
    let cancelled = false;
    const controller = new AbortController();
    fetchFinlandYelStatus({ clientId, signal: controller.signal })
      .then((data) => {
        if (cancelled) return;
        const yel = data?.yel;
        const quiet = yel && ['active', 'exempt'].includes(yel.status) && !(yel.flags || []).length;
        setYelStatus(yel && !quiet ? yel : null);
      })
      .catch((err) => {
        if (cancelled || err?.name === 'AbortError') return;
        setYelStatus(null);
      });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [databaseMode, clientId, firmId]);

  // G-5 (FI-15) — the ennakkovero watch: quiet on on_track/not_configured/
  // not_liable with no flags, a nudge line for everything else. Flag-off
  // (typed 403) or any error ⇒ null ⇒ no banner.
  const [ennakkoveroStatus, setEnnakkoveroStatus] = useState(null);
  useEffect(() => {
    if (!databaseMode || !clientId) {
      setEnnakkoveroStatus(null);
      return;
    }
    let cancelled = false;
    const controller = new AbortController();
    fetchFinlandEnnakkoveroStatus({ clientId, signal: controller.signal })
      .then((data) => {
        if (cancelled) return;
        const ennakkovero = data?.ennakkovero;
        const quiet = ennakkovero
          && ['on_track', 'not_configured', 'not_liable'].includes(ennakkovero.status)
          && !(ennakkovero.flags || []).length;
        setEnnakkoveroStatus(ennakkovero && !quiet ? ennakkovero : null);
      })
      .catch((err) => {
        if (cancelled || err?.name === 'AbortError') return;
        setEnnakkoveroStatus(null);
      });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [databaseMode, clientId, firmId]);

  // G-6 (FI-15) — the prepayment-register watch: banner shows the OWN-status
  // nudge and any withholding-risk suppliers; check_needed suppliers stay on
  // the report surface (they converge via the automated-lookup follow-up, not
  // a permanent banner nag). Flag-off (typed 403) or any error ⇒ null.
  const [prepaymentRegister, setPrepaymentRegister] = useState(null);
  useEffect(() => {
    if (!databaseMode || !clientId) {
      setPrepaymentRegister(null);
      return;
    }
    let cancelled = false;
    const controller = new AbortController();
    fetchFinlandPrepaymentRegister({ clientId, signal: controller.signal })
      .then((data) => {
        if (cancelled) return;
        const register = data?.register;
        if (!register) {
          setPrepaymentRegister(null);
          return;
        }
        const riskSuppliers = (register.suppliers || []).filter((s) => s.verdict === 'withholding_risk');
        const notes = [...(register.own?.notes_fi || []), ...riskSuppliers.flatMap((s) => s.notes_fi || [])];
        setPrepaymentRegister(notes.length ? {
          notes_fi: notes,
          loud: register.own?.verdict === 'not_registered' || riskSuppliers.length > 0
        } : null);
      })
      .catch((err) => {
        if (cancelled || err?.name === 'AbortError') return;
        setPrepaymentRegister(null);
      });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [databaseMode, clientId, firmId]);

  // G-8 (FI-15) — issued-invoice payment awareness: the banner surfaces ONLY
  // overdue and overpaid counts (quiet-on-healthy — paid/unpaid-not-due/
  // credited books show nothing). The full per-invoice payment states live on
  // the report surface. Flag-off (typed 403) or any error ⇒ null.
  const [issuedInvoiceBanner, setIssuedInvoiceBanner] = useState(null);
  useEffect(() => {
    if (!databaseMode || !clientId) {
      setIssuedInvoiceBanner(null);
      return;
    }
    let cancelled = false;
    const controller = new AbortController();
    fetchFinlandIssuedInvoices({ clientId, signal: controller.signal })
      .then((data) => {
        if (cancelled) return;
        // The envelope carries the quiet-on-healthy banner copy (null when
        // nothing needs a look) — render the persisted verdict, don't rebuild it.
        const banner = data?.issued_invoices?.banner_fi || null;
        setIssuedInvoiceBanner(banner ? { notes_fi: [banner] } : null);
      })
      .catch((err) => {
        if (cancelled || err?.name === 'AbortError') return;
        setIssuedInvoiceBanner(null);
      });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [databaseMode, clientId, firmId]);

  // C-1c — the quotes funnel strip: the envelope's server-built funnel + its
  // Finnish summary line, rendered verbatim (render-the-persisted-verdict).
  // Flag-off (typed 403), no quotes yet (line_fi null), or any error ⇒ null ⇒
  // no strip; prod is byte-identical until FINLAND_QUOTES acts.
  const [quotesFunnel, setQuotesFunnel] = useState(null);
  useEffect(() => {
    if (!databaseMode || !clientId) {
      setQuotesFunnel(null);
      return;
    }
    let cancelled = false;
    const controller = new AbortController();
    fetchFinlandQuotes({ clientId, signal: controller.signal })
      .then((data) => {
        if (cancelled) return;
        const summary = data?.issued_quotes;
        setQuotesFunnel(summary?.line_fi ? summary : null);
      })
      .catch((err) => {
        if (cancelled || err?.name === 'AbortError') return;
        setQuotesFunnel(null);
      });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [databaseMode, clientId, firmId]);

  // F-FI3-3: once the envelope reveals the client's verokausi cadence, default the
  // period to that cadence's previous completed period — unless the user has picked
  // one. The ref resets per client so switching clients re-defaults. The envelope
  // carries verokausi independent of the requested period, so this converges in one
  // extra fetch for a non-monthly client and is a no-op for the monthly default.
  const alvUserPickedPeriodRef = useRef(false);
  useEffect(() => { alvUserPickedPeriodRef.current = false; }, [clientId]);
  useEffect(() => {
    const cadence = alvReturnEnvelope?.verokausi;
    if (!cadence || alvUserPickedPeriodRef.current) return;
    const currentType = /^\d{4}-Q[1-4]$/.test(alvPeriod)
      ? 'quarter'
      : /^\d{4}$/.test(alvPeriod) ? 'year' : 'month';
    if (currentType !== cadence) setAlvPeriod(defaultAlvPeriodKey(new Date(), cadence));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [alvReturnEnvelope?.verokausi]);

  // ── Slice 2 (realtime-truthful-feedback): the /feed-events merge-tick ──────
  // Poll the changes cursor; when persisted receipts / touched rows arrive,
  // fold the receipts for the row treatments and refresh the firm snapshot so
  // every surface re-renders from persisted state — no page refresh. Mirrors
  // the document-chat tick lifecycle (visibility-gated, in-flight-guarded,
  // soft-fail on transient errors).
  const [liveReceipts, setLiveReceipts] = useState({});
  const [inFlightTxIds, setInFlightTxIds] = useState(() => new Set());
  // The poll closure resolves review-item → transaction against the CURRENT
  // snapshot through a ref, so the interval never rebuilds on queue changes.
  const reviewItemTxRef = useRef(new Map());
  useEffect(() => {
    reviewItemTxRef.current = new Map(
      (transactionReviewQueue || [])
        .filter((item) => item?.id)
        .map((item) => [item.id, item.payload?.transaction_id || item.item_id])
    );
  }, [transactionReviewQueue]);
  const snapshotCbRef = useRef(onDatabaseSnapshot);
  snapshotCbRef.current = onDatabaseSnapshot;
  const unfinishedRef = useRef(false);
  unfinishedRef.current = hasActivity || transactions.some(tx => tx.client_id === clientId && tx.convergence_state === 'hanging');

  useEffect(() => {
    if (!databaseMode || !clientId) {
      setLiveReceipts({});
      setInFlightTxIds(new Set());
      return undefined;
    }
    let cancelled = false;
    // First call omits the cursor: the server hands back its high-water marks
    // and no rows, so the tick never replays history the snapshot already
    // rendered.
    let cursor = null;
    let ticking = false;
    let controller = null;
    let lastActivityRefresh = 0;
    setLiveReceipts({});
    setInFlightTxIds(new Set());
    const tick = async () => {
      if (cancelled || ticking) return;
      if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
      ticking = true;
      controller = new AbortController();
      const timeout = setTimeout(() => controller?.abort(), 15000);
      try {
        const payload = await fetchFeedEvents({ firmId, clientId, cursor, signal: controller.signal });
        if (cancelled) return;
        const bootstrapped = !cursor;
        if (payload?.cursor) cursor = payload.cursor;
        const now = Date.now();
        if ((!bootstrapped && hasFeedChanges(payload)) || (unfinishedRef.current && now - lastActivityRefresh >= 15000)) {
          setLiveReceipts((prev) => pruneReceipts(
            foldFeedEventsIntoReceipts(prev, payload.events || [], {
              resolveReviewItemTransactionId: (id) => reviewItemTxRef.current.get(id) || null,
              now
            }),
            { now }
          ));
          // Merge step: rows re-render from the refreshed persisted snapshot
          // (the same apply-path mechanism), never from a UI-side guess.
          const snapshot = await fetchFirmSnapshot({ signal: controller.signal });
          lastActivityRefresh = now;
          if (!cancelled && snapshot?.source === 'database' && typeof snapshotCbRef.current === 'function') {
            setActivityRefreshFailed(false);
            snapshotCbRef.current(snapshot);
          }
        } else {
          setLiveReceipts((prev) => pruneReceipts(prev, { now }));
        }
      } catch {
        if (!cancelled) setActivityRefreshFailed(true);
        // Soft-fail: a transient tick error must not blank the page — the
        // next interval retries with the same cursor.
      } finally {
        clearTimeout(timeout);
        ticking = false;
      }
    };
    tick();
    const intervalId = setInterval(tick, FEED_EVENTS_POLL_MS);
    const onVisibility = () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'visible') tick();
    };
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', onVisibility);
    }
    return () => {
      cancelled = true;
      controller?.abort();
      clearInterval(intervalId);
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', onVisibility);
      }
    };
  }, [databaseMode, clientId, firmId]);

  // Feed-chat apply lifecycle: shimmer exactly the targeted rows while the
  // apply flies (in-flight treatment only — no success on click), then fold
  // the per-row outcome receipts on settle.
  const handleFeedApplyLifecycle = useCallback(({ phase, transactionIds = [], results = [] } = {}) => {
    const ids = (transactionIds || []).filter(Boolean).map(String);
    if (phase === 'start') {
      if (!ids.length) return;
      setInFlightTxIds((prev) => {
        const next = new Set(prev);
        ids.forEach((id) => next.add(id));
        return next;
      });
      return;
    }
    if (ids.length) {
      setInFlightTxIds((prev) => {
        const next = new Set(prev);
        ids.forEach((id) => next.delete(id));
        return next;
      });
    }
    if (Array.isArray(results) && results.length) {
      const now = Date.now();
      setLiveReceipts((prev) => foldApplyOutcomeIntoReceipts(prev, results, { now }));
    }
  }, []);

  // Register with the console-mounted dock; deregister on unmount so a
  // stale handler never receives events for an unmounted panel.
  useEffect(() => {
    if (typeof onRegisterFeedApplyLifecycle !== 'function') return undefined;
    onRegisterFeedApplyLifecycle(handleFeedApplyLifecycle);
    return () => onRegisterFeedApplyLifecycle(null);
  }, [onRegisterFeedApplyLifecycle, handleFeedApplyLifecycle]);

  return (
    <div
      style={{
        background: D.paper,
        color: T.ink,
        // STAGE 3 of the two-voice doctrine (Kari, 2026-08-08) — the reconcile
        // surface's content moves onto the system face. This is the ONE line
        // that decides the face for every cell that doesn't name its own, so
        // it is deliberately the panel root and not a per-cell sprinkle: with
        // the feed's dates/amounts/statuses de-mono'd below, leaving this on
        // DM Sans would put TWO sans faces in the same row, which reads worse
        // than the mono it replaces.
        //
        // This is the content half of the tension recorded on `D.ui` in
        // design-tokens.js: the 2026-08-07 call keeps content on T.sans, the
        // 2026-08-08 review says system face for ~98%. Staged here so Kari
        // judges the data surface on screen. If he prefers DM Sans for data,
        // reverting is this single token — the de-mono below stands either way.
        // Out-of-scope tabs get a face swap only (no sizes, no de-mono), the
        // same treatment the dock and chat got in #1502.
        fontFamily: D.ui,
        // The shared list measure — same token as Actions and Documents
        // (Kari, 2026-08-10). Caps every view this panel hosts.
        maxWidth: D.measure,
        margin: '0 auto'
      }}
    >
      <StatStrip
        databaseMode={databaseMode}
        transactions={transactions}
        reviewItems={transactionReviewQueue}
        ledgerJournals={ledgerJournals}
      />
      <FinancialsTabs
        tab={sub}
        setTab={setSub}
        databaseMode={databaseMode}
        annualReturnAvailable={annualReturnEnvelope !== null}
        alvReturnAvailable={alvReturnEnvelope !== null}
        onRegisterViewMenu={onRegisterFeedViewMenu}
      />
      {isGbClient && gbVatView && (
        <section data-testid="gb-vat-return" style={{ border: `1px solid ${T.rule}`, borderRadius: 8, padding: 14, margin: '10px 0' }}>
          <strong>{intl.formatMessage({ id: 'mounted.financial.ukVatReturn' }, { period: gbVatView.period || '' })}</strong>
          <p style={{ color: T.muted }}>{gbVatView.honesty}</p>
          {gbVatView.boxRows.map((row) => <div key={row.box}>{intl.formatMessage({ id: 'mounted.financial.box' }, { box: row.box, value: row.display })}</div>)}
          {gbVatView.outcomeLabel && <p><strong>{gbVatView.outcomeLabel}</strong>{gbVatView.dueDate ? ` · ${intl.formatMessage({ id: 'mounted.financial.due' }, { date: gbVatView.dueDate })}` : ''}</p>}
        </section>
      )}
      {isGbClient && gbStatutoryView && <section data-testid="gb-statutory" style={{ border: `1px solid ${T.rule}`, borderRadius: 8, padding: 14 }}><strong>{intl.formatMessage({ id: 'mounted.financial.ukWatch' })}</strong>{gbStatutoryView.threshold && <p>{intl.formatMessage({ id: 'mounted.financial.vatThreshold' }, { status: gbStatutoryView.threshold.status })}</p>}<GbStatutoryRows view={gbStatutoryView} /></section>}
      {isGbClient && gbLtdClose?.close && <section data-testid="gb-ltd-close" style={{ border: `1px solid ${T.rule}`, borderRadius: 8, padding: 14, marginTop: 10 }}><strong>{intl.formatMessage({ id: 'mounted.financial.ukClose' })}</strong>{(gbLtdClose.close.items || []).map((item) => <div key={item.id}>{item.id}: {item.terminal}{item.reason_code ? ` · ${item.reason_code}` : ''}</div>)}{(gbLtdClose.open_blockers || []).map((blocker) => <div key={blocker.id}>{intl.formatMessage({ id: 'mounted.financial.openBlocker' }, { reason: blocker.reason_code })}</div>)}<p style={{ color: T.muted }}>{intl.formatMessage({ id: 'mounted.financial.preparedOnly' })}</p></section>}
      {alvThresholdWatch && alvThresholdWatch.note && (
        <div style={{ border: `1px solid ${T.rule}`, borderRadius: 8, padding: '8px 14px', display: 'flex', gap: 12, alignItems: 'baseline' }}>
          <span style={{ fontSize: 12.5, fontWeight: 600, color: alvThresholdWatch.status === 'exceeded' ? T.amber : T.muted, whiteSpace: 'nowrap' }}>
            {intl.formatMessage({ id: 'mounted.financial.finland.vatThreshold' })}
          </span>
          <span style={{ fontSize: 12, color: alvThresholdWatch.status === 'exceeded' ? T.amber : T.muted, lineHeight: 1.45 }}>
            <BidiText direction="auto">{alvThresholdWatch.note}</BidiText>
          </span>
        </div>
      )}
      {yelStatus && yelStatus.notes_fi?.length > 0 && (
        <div style={{ border: `1px solid ${T.rule}`, borderRadius: 8, padding: '8px 14px', display: 'flex', gap: 12, alignItems: 'baseline' }}>
          <span style={{ fontSize: 12.5, fontWeight: 600, color: T.muted, whiteSpace: 'nowrap' }}>
            {intl.formatMessage({ id: 'mounted.financial.finland.yel' })}
          </span>
          <span style={{ fontSize: 12, color: T.muted, lineHeight: 1.45 }}>
            <BidiText direction="auto">{yelStatus.notes_fi.join(' ')}</BidiText>
          </span>
        </div>
      )}
      {ennakkoveroStatus && ennakkoveroStatus.notes_fi?.length > 0 && (
        <div style={{ border: `1px solid ${T.rule}`, borderRadius: 8, padding: '8px 14px', display: 'flex', gap: 12, alignItems: 'baseline' }}>
          <span style={{ fontSize: 12.5, fontWeight: 600, color: ennakkoveroStatus.status === 'review_recommended' ? T.amber : T.muted, whiteSpace: 'nowrap' }}>
            {intl.formatMessage({ id: 'mounted.financial.finland.prepaymentTax' })}
          </span>
          <span style={{ fontSize: 12, color: ennakkoveroStatus.status === 'review_recommended' ? T.amber : T.muted, lineHeight: 1.45 }}>
            <BidiText direction="auto">{ennakkoveroStatus.notes_fi.join(' ')}</BidiText>
          </span>
        </div>
      )}
      {prepaymentRegister && prepaymentRegister.notes_fi?.length > 0 && (
        <div style={{ border: `1px solid ${T.rule}`, borderRadius: 8, padding: '8px 14px', display: 'flex', gap: 12, alignItems: 'baseline' }}>
          <span style={{ fontSize: 12.5, fontWeight: 600, color: prepaymentRegister.loud ? T.amber : T.muted, whiteSpace: 'nowrap' }}>
            {intl.formatMessage({ id: 'mounted.financial.finland.prepaymentRegister' })}
          </span>
          <span style={{ fontSize: 12, color: prepaymentRegister.loud ? T.amber : T.muted, lineHeight: 1.45 }}>
            <BidiText direction="auto">{prepaymentRegister.notes_fi.join(' ')}</BidiText>
          </span>
        </div>
      )}
      {issuedInvoiceBanner && issuedInvoiceBanner.notes_fi?.length > 0 && (
        <div style={{ border: `1px solid ${T.rule}`, borderRadius: 8, padding: '8px 14px', display: 'flex', gap: 12, alignItems: 'baseline' }}>
          <span style={{ fontSize: 12.5, fontWeight: 600, color: T.amber, whiteSpace: 'nowrap' }}>
            {intl.formatMessage({ id: 'mounted.financial.finland.invoicing' })}
          </span>
          <span style={{ fontSize: 12, color: T.amber, lineHeight: 1.45 }}>
            <BidiText direction="auto">{issuedInvoiceBanner.notes_fi.join(' ')}</BidiText>
          </span>
        </div>
      )}
      {quotesFunnel && quotesFunnel.line_fi && (
        <div style={{ border: `1px solid ${T.rule}`, borderRadius: 8, padding: '8px 14px', display: 'flex', gap: 12, alignItems: 'baseline' }}>
          <span style={{ fontSize: 12.5, fontWeight: 600, color: quotesFunnel.funnel?.sent_expired ? T.amber : T.muted, whiteSpace: 'nowrap' }}>
            {intl.formatMessage({ id: 'mounted.financial.finland.quotes' })}
          </span>
          <span style={{ fontSize: 12, color: quotesFunnel.funnel?.sent_expired ? T.amber : T.muted, lineHeight: 1.45 }}>
            <BidiText direction="auto">{quotesFunnel.line_fi}</BidiText>
          </span>
        </div>
      )}
      {scopeDrift && scopeDrift.triggers?.length > 0 && (
        <div style={{ border: `1px solid ${T.rule}`, borderRadius: 8, padding: '8px 14px', display: 'flex', gap: 12, alignItems: 'baseline' }}>
          <span style={{ fontSize: 12.5, fontWeight: 600, color: scopeDrift.verdict === 'supported_with_review' ? T.muted : T.amber, whiteSpace: 'nowrap' }}>
            {intl.formatMessage({ id: 'mounted.financial.finland.serviceScope' })}
          </span>
          <span style={{ fontSize: 12, color: scopeDrift.verdict === 'supported_with_review' ? T.muted : T.amber, lineHeight: 1.45 }}>
            <BidiText direction="auto">{scopeDrift.triggers.map((t) => t.label_fi).filter(Boolean).join(' · ')}</BidiText>
            {intl.formatMessage({
              id: scopeDrift.verdict === 'filing_blocked'
                ? 'mounted.financial.finland.filingBlocked'
                : 'mounted.financial.finland.underReview'
            })}
          </span>
        </div>
      )}
      {/* ONE SCROLL, BOTH STATES (Kari, 2026-08-08): open on top, reconciled
          below. Replaces the Open/Reconciled segmented control — the day's
          movements are read by scrolling the feed, not by switching halves
          and trying to remember what the other one said. `feed` is the
          default `sub`; the ⋯ menu's other views still swap it away. */}
      {sub === 'feed' && (
        <div
          data-bank-feed-list="true"
          onFocusCapture={selectFeedRowFromEvent}
          onClickCapture={selectFeedRowFromEvent}
          onKeyDown={handleFeedListKeyDown}
          style={{ width: '100%', maxWidth: BANK_FEED_LIST_MEASURE, margin: '0 auto' }}
        >
          <ReconcilePanel
            clientId={clientId}
            databaseMode={databaseMode}
            transactions={transactions}
            reviewItems={transactionReviewQueue}
            clientEvidenceRequests={clientEvidenceRequests}
            documents={documents}
            reconciliationMatches={reconciliationMatches}
            ownerRows={ownerRows}
            onActivatePeriodOwnerDecision={onActivatePeriodOwnerDecision}
            reconciledHistoryRows={allReconciledRows}
            closePeriods={closePeriods}
            closeArchives={closeArchives}
            periodDocumentRows={unmatchedDocRows}
            xeroAccounts={xeroAccounts}
            ledgerAccounts={ledgerAccounts}
            ledgerJournals={ledgerJournals}
            ledgerLines={ledgerLines}
            onDatabaseSnapshot={onDatabaseSnapshot}
            onBatchSuggestTransactionCoding={onBatchSuggestTransactionCoding}
            onArtifact={onArtifact}
            onUpdateTransaction={onUpdateTransaction}
            onApproveTransaction={onApproveTransaction}
            onUpdateReconciliationMatch={onUpdateReconciliationMatch}
            activeFeedRowId={activeFeedRowId}
            liveReceipts={liveReceipts}
            inFlightTxIds={inFlightTxIds}
            baseCurrency={baseCurrency}
            onCreateManualLink={onCreateManualLink}
            onChatActionSnapshotApplied={onChatActionSnapshotApplied}
            onDeleteDocument={onDeleteDocument}
          />
        </div>
      )}
      {sub === 'veroilmoitus' && databaseMode && annualReturnEnvelope && (
        <AnnualReturnPanel
          envelope={annualReturnEnvelope}
          taxYear={annualReturnYear}
          onYearChange={setAnnualReturnYear}
        />
      )}
      {sub === 'alv' && databaseMode && alvReturnEnvelope && (
        <AlvReturnPanel
          envelope={alvReturnEnvelope}
          period={alvPeriod}
          onPeriodChange={(key) => { alvUserPickedPeriodRef.current = true; setAlvPeriod(key); }}
          mandateEnvelope={suomifiMandateEnvelope}
        />
      )}
      {sub === 'aging' && (
        <AgingPanel
          documents={documents}
          reconciliationMatches={reconciliationMatches}
          reviewItems={transactionReviewQueue}
          onOpenDocument={onArtifact ? (doc) => {
            if (!doc) return;
            const docArtifact = buildDocumentArtifactData(doc, transactions, reconciliationMatches);
            docArtifact.firmDocument = doc;
            onArtifact({
              type: 'document',
              title: docArtifact.document?.title || doc.filename || intl.formatMessage({ id: 'mounted.financial.document' }),
              data: docArtifact
            });
          } : null}
        />
      )}
      {/* Slice 2 keyframes — the in-flight row shimmer and the transient
          receipt-note fade. Rendered once for every tab. */}
      <style>{`
        .processing-label { background: linear-gradient(100deg, currentColor 30%, #aab5c5 50%, currentColor 70%); background-size: 250% 100%; background-clip: text; -webkit-background-clip: text; -webkit-text-fill-color: transparent; animation: processingTextShimmer 1.8s linear infinite; }
        @keyframes processingTextShimmer { from { background-position: 200% 0; } to { background-position: -50% 0; } }
        @media (prefers-reduced-motion: reduce) { .processing-label { animation: none; background: none; -webkit-text-fill-color: currentColor; } }
        @keyframes receiptInFlightPulse { 50% { opacity: 0.45; } }
        @keyframes receiptNoteFade { 0% { opacity: 0; } 10% { opacity: 1; } 78% { opacity: 1; } 100% { opacity: 0; } }
      `}</style>
    </div>
  );
}
