import { monthKeyLabel, snapshotDayString, snapshotMonthKey } from '../components/shared/snapshot-dates.js';
import { noLineDispositionFor, hasScopedNoSettlementAssessment } from './documentsInbox.js';

const rowIdentity = (row, fallback) =>
  String(
    row?.transactionId
    || row?.transaction_id
    || (row?.kind === 'review_item' && row?.item_type === 'transaction' ? row?.item_id : null)
    || row?.document_id
    || row?.id
    || row?.document?.id
    || row?.source_id
    || fallback
  );

const rowTransactionId = (row) =>
  row?.transactionId
  || row?.transaction_id
  || (row?.kind === 'review_item' && row?.item_type === 'transaction' ? row?.item_id : null)
  || row?.id
  || null;

const rowDocumentId = (row) =>
  row?.document_id
  || (row?.kind === 'review_item' && row?.item_type === 'document' ? row?.item_id : null)
  || row?.document?.id
  || null;

const transactionMonth = (row, txById) => {
  const tx = row?._tx
    || txById.get(rowTransactionId(row))
    || null;
  return snapshotMonthKey(
    tx?.date
    || tx?.transaction_date
    || tx?.created_at
    || row?.transaction_date
    || row?.periodDate
    || row?.created_at
  );
};

// A document's accounting month is the date the DOCUMENT carries. Upload time
// is not a fallback: a source with no readable date (the Kampaamo OP loan
// notice, 2026-09-21) used to land in its upload month with a blank date on
// the card. It now sits in the honest 'Date unavailable' period instead.
const documentMonth = (row) => snapshotMonthKey(
  row?.documentDate
  || row?.document?.document_date
  || row?.document?.date
);

const closeMonth = (row) => snapshotMonthKey(row?.period_start || row?.periodStart);

const transactionDay = (row, txById) => {
  const tx = row?._tx || txById.get(rowTransactionId(row)) || null;
  return snapshotDayString(
    tx?.date
    || tx?.transaction_date
    || tx?.created_at
    || row?.transaction_date
    || row?.periodDate
    || row?.created_at
  );
};

const documentDay = (row) => snapshotDayString(
  row?.documentDate
  || row?.document?.document_date
  || row?.document?.date
);

// The visible states of the single list (Kari, 2026-09-01: "pills on
// the right should be allocated for an item's state"). Two are the
// convergence terminals — 'needs_input' (on the owner) and 'reconciled'
// (auto-reconciled). 'processing' is bounded in-flight work in Donna's
// hands. 'stalled' is the persisted `hanging` verdict at rest — the
// two-terminal-states VIOLATION, surfaced honestly on its own pill and
// never laundered behind the calmer 'processing' word.
export const STREAM_STATES = Object.freeze(['needs_input', 'processing', 'stalled', 'reconciled', 'review_only', 'no_settlement']);

// Called with the renderer's clock, so a lost connection cannot keep an old
// processing receipt alive. Calendar/accounting state is left untouched.
export const expireProcessingActivity = (rows, asOf, { awaitingRefresh = false } = {}) => rows.map(row => {
  const activity = row?.processing_activity;
  if (!activity || activity.state === 'failed') return row;
  const expiry = Date.parse(activity.valid_until);
  return (Number.isFinite(expiry) && asOf < expiry) || awaitingRefresh ? row : { ...row, processing_activity: { ...activity, state: 'failed', reason_code: 'processing_receipt_expired' } };
});

// Classify one stream row. Verdict-first: when the row carries the persisted
// convergence verdict (firmDb attaches convergence_state/convergence_reason),
// the verdict decides the pill even if the lane split drifted. A row with NO
// verdict (mock / seed / pre-convergence snapshot) renders as Donna's
// ordinary work — never a fabricated violation claim (render the persisted
// verdict, not an inference).
export const streamEntryState = (lane, row = {}) => {
  const activity = row.processing_activity || row.document?.processing_activity;
  if (activity?.state === 'failed') return 'stalled';
  // A persisted terminal outranks in-flight work (2026-09-23): the projection
  // no longer stamps settled rows or owner questions, and a stale receipt
  // from an older snapshot cannot turn them back into Processing. A named
  // failure above still outranks it (an exhausted draft on an owner row).
  const terminal = ['auto_reconciled', 'on_owner'].includes(row?.convergence_state);
  if (activity && ['queued','running'].includes(activity.state) && !terminal) return 'processing';
  if (lane === 'owner' || row.convergence_state === 'on_owner') return 'needs_input';
  // Only the server's current, evidence-bound projection can label a saved
  // review. Its canonical state remains hanging and accounting incomplete.
  if (row.processing_scope && row.convergence_state === 'hanging') {
    return row.convergence_reason === 'processing_review_only'
      && row.processing_scope.enforced === true && row.processing_scope.review_current === true
      ? 'review_only' : 'stalled';
  }
  if (lane === 'reconciled') return 'reconciled';
  if (lane === 'document') {
    // Doc rows are pre-transaction identities, but they are no longer
    // verdict-less: the doc-first terminal drain persists a no-line
    // disposition on exactly this population. Read it like every other
    // pill reads its verdict (2026-09-01, the Desert Rose "Processing
    // forever" fix): a blocked source needs intervention; an open owner
    // ask on the doc is with the owner; a persisted chase/needs_human
    // verdict at rest is the surfaced violation — stalled, never
    // laundered into Processing. NO verdict stays Processing — the drain
    // makes verdict-less genuinely transient, and a Stalled claim
    // without a persisted verdict would be a fabrication.
    if (row?.materialSourceState === 'blocked') return 'stalled';
    if (row?.matchStatus === 'awaiting_owner') return 'needs_input';
    const document = row?.document || row;
    if (row?.materialSourceState === 'processing' || ['pending','processing'].includes(document.parse_status)) return 'processing';
    if (hasScopedNoSettlementAssessment(document)) return 'no_settlement';
    if (document.convergence_state === 'hanging') return 'stalled';
    const disposition = noLineDispositionFor(row?.document || row);
    if (disposition && disposition !== 'auto_explain') return 'stalled';
    return 'processing';
  }
  const conv = row?.convergence_state;
  if (conv === 'on_owner') return 'needs_input';
  if (conv === 'auto_reconciled') return 'reconciled';
  if (conv === 'hanging') {
    return 'stalled';
  }
  return 'processing';
};

// One month, ONE list (Kari, 2026-08-31: "a single list can do it all with
// states"). The lanes survive only as classification — counts — and the
// visible order is the ledger's own: every identity in one date-sorted
// stream, newest first, state carried by each row's own pill. Sort is by day
// only and the sort is stable, so a row that changes state never moves; its
// pill flips in place.
export const buildPeriodStream = (period, txById = new Map()) => {
  const entries = [];
  for (const sourceRow of period?.ownerRows || []) {
    const row = { ...sourceRow, processing_activity: txById.has(rowTransactionId(sourceRow)) ? txById.get(rowTransactionId(sourceRow)).processing_activity : sourceRow.processing_activity };
    entries.push({ lane: 'owner', state: streamEntryState('owner', row), row, day: transactionDay(row, txById) || '' });
  }
  for (const row of period?.documentRows || []) {
    entries.push({ lane: 'document', state: streamEntryState('document', row), row, day: documentDay(row) || '' });
  }
  for (const row of period?.openRows || []) {
    entries.push({ lane: 'open', state: streamEntryState('open', row), row, day: transactionDay(row, txById) || '' });
  }
  for (const sourceRow of period?.reconciledRows || []) {
    const row = { ...sourceRow, processing_activity: txById.has(rowTransactionId(sourceRow)) ? txById.get(rowTransactionId(sourceRow)).processing_activity : sourceRow.processing_activity };
    entries.push({ lane: 'reconciled', state: streamEntryState('reconciled', row), row, day: transactionDay(row, txById) || '' });
  }
  // Undated entries sink to the end; equal-day entries keep insertion order
  // (Array#sort is stable), so a snapshot refresh cannot shuffle them.
  return entries.sort((a, b) => (b.day || '').localeCompare(a.day || ''));
};

const closeStatus = (row) => {
  if (String(row?.status || '') === 'locked') return 'locked';
  const persisted = row?.payload?.close_status;
  return ['ready', 'review', 'blocked'].includes(persisted) ? persisted : 'review';
};

// Pure owner-facing projection for the continuous-close overview. It groups
// identities that were already classified by the persisted convergence
// readers; it never decides their accounting state itself.
export const buildPeriodOverview = ({
  openRows = [],
  ownerRows = [],
  reconciledRows = [],
  documentRows = [],
  closePeriods = [],
  transactions = []
} = {}) => {
  const txById = new Map((Array.isArray(transactions) ? transactions : [])
    .filter((tx) => tx?.id)
    .map((tx) => [tx.id, tx]));
  const periods = new Map();

  const ensure = (monthKey) => {
    const key = monthKey || 'undated';
    if (!periods.has(key)) {
      periods.set(key, {
        monthKey: key,
        label: key === 'undated' ? 'Date unavailable' : monthKeyLabel(key),
        openRows: [],
        ownerRows: [],
        documentRows: [],
        reconciledRows: [],
        closePeriod: null
      });
    }
    return periods.get(key);
  };

  const seenTransactions = new Set();
  const appendTransactions = (rows, lane) => {
    for (const [index, row] of (Array.isArray(rows) ? rows : []).entries()) {
      // Bank rows from one statement share document_id, not identity.
      const transactionId = rowTransactionId(row);
      const identity = txById.has(transactionId) ? String(transactionId) : rowIdentity(row, `${lane}:${index}`);
      if (seenTransactions.has(identity)) continue;
      seenTransactions.add(identity);
      ensure(transactionMonth(row, txById))[lane].push(row);
    }
  };

  // A contradictory duplicate should not become two visible pieces of work.
  // Owner-held is the safest terminal to preserve, then unresolved work, then
  // completed history.
  appendTransactions(ownerRows, 'ownerRows');
  appendTransactions(openRows, 'openRows');
  appendTransactions(reconciledRows, 'reconciledRows');

  // A document-scoped decision owns that identity just as a transaction-scoped
  // decision does. Do not repeat the same failed parse / document review in the
  // month's Donna lane after it has appeared under Needs you.
  const seenDocuments = new Set(
    (Array.isArray(ownerRows) ? ownerRows : []).map(rowDocumentId).filter(Boolean).map(String)
  );
  for (const [index, row] of (Array.isArray(documentRows) ? documentRows : []).entries()) {
    const identity = String(rowDocumentId(row) || rowIdentity(row, `document:${index}`));
    if (seenDocuments.has(identity)) continue;
    seenDocuments.add(identity);
    ensure(documentMonth(row)).documentRows.push(row);
  }

  // The persisted close row is a verdict and an action doorway, not an extra
  // list identity. A newer duplicate wins defensively; the database normally
  // enforces one row per client and period.
  for (const row of Array.isArray(closePeriods) ? closePeriods : []) {
    const monthKey = closeMonth(row);
    if (!monthKey) continue;
    const period = ensure(monthKey);
    const previousAt = Date.parse(period.closePeriod?.updated_at || '') || 0;
    const nextAt = Date.parse(row?.updated_at || '') || 0;
    if (!period.closePeriod || nextAt >= previousAt) period.closePeriod = row;
  }

  return Array.from(periods.values())
    .map((period) => {
      const closed = closeStatus(period.closePeriod) === 'locked';
      const stream = buildPeriodStream(period, txById);
      // Counts tally the SAME per-row state the pills render — one
      // classifier, so the month summary can never disagree with its rows.
      const counts = { needsInput: 0, processing: 0, stalled: 0, reconciled: 0 };
      for (const entry of stream) {
        if (entry.state === 'needs_input') counts.needsInput += 1;
        else if (entry.state === 'processing') counts.processing += 1;
        else if (entry.state === 'stalled') counts.stalled += 1;
        else if (entry.state === 'review_only') counts.reviewOnly = (counts.reviewOnly || 0) + 1;
        else if (entry.state === 'no_settlement') counts.noSettlement = (counts.noSettlement || 0) + 1;
        else counts.reconciled += 1;
      }
      counts.remaining = counts.needsInput + counts.processing + counts.stalled + (counts.reviewOnly || 0) + (counts.noSettlement || 0);
      return {
        ...period,
        closed,
        status: closed ? 'closed' : 'open',
        closeStatus: period.closePeriod ? closeStatus(period.closePeriod) : null,
        counts,
        upToDate: !closed && counts.remaining === 0,
        stream,
        periodStart: snapshotDayString(period.closePeriod?.period_start) || null,
        periodEnd: snapshotDayString(period.closePeriod?.period_end) || null
      };
    })
    .sort((a, b) => {
      if (a.monthKey === 'undated') return 1;
      if (b.monthKey === 'undated') return -1;
      return b.monthKey.localeCompare(a.monthKey);
    });
};

export const periodSummaryLabel = (period, formatMessage = null) => {
  if (!period) return '';
  const message = (id, values, fallback) => typeof formatMessage === 'function'
    ? formatMessage({ id }, values)
    : fallback;
  if (period.closed) {
    const count = period.counts?.reconciled || 0;
    return message('lifecycle.period.summary.reconciled', { count }, `${count} reconciled`);
  }
  const parts = [];
  if (period.counts?.needsInput) {
    const count = period.counts.needsInput;
    parts.push(message(
      'lifecycle.period.summary.needsInput',
      { count },
      `${count} ${count === 1 ? 'needs' : 'need'} input`
    ));
  }
  if (period.counts?.processing) {
    const count = period.counts.processing;
    parts.push(message('lifecycle.period.summary.processing', { count }, `${count} processing`));
  }
  if (period.counts?.stalled) {
    const count = period.counts.stalled;
    parts.push(message('lifecycle.period.summary.stalled', { count }, `${count} stalled`));
  }
  if (period.counts?.reviewOnly) {
    const count = period.counts.reviewOnly;
    parts.push(message('lifecycle.period.summary.reviewOnly', { count }, `${count} ${count === 1 ? 'review' : 'reviews'} saved · accounting incomplete`));
  }
  if (period.counts?.noSettlement) {
    const count = period.counts.noSettlement;
    parts.push(message('lifecycle.period.summary.noSettlement', { count }, `${count} without bank line in supplied scope`));
  }
  if (period.counts?.reconciled) {
    const count = period.counts.reconciled;
    parts.push(message('lifecycle.period.summary.reconciled', { count }, `${count} reconciled`));
  }
  return parts.length
    ? parts.join(' · ')
    : message('lifecycle.period.summary.upToDate', {}, 'Up to date');
};

// ── In-flight work (2026-09-23) ─────────────────────────────────────────────
// Kari: "all these items are processing pills … never ending". Activity rides
// only the rows that still owe work; a row with a persisted terminal renders
// its verdict. Each owed row names its own phase, and one summary per upload
// batch replaces the per-row pill wall. The projection
// (server/donna/db/reconcileActivity.js) owns every value here; this file
// only reads it.
const LIVE_ACTIVITY = new Set(['queued', 'running']);

export const WORKING_PHASES = Object.freeze({
  reading: 'lifecycle.working.reading',
  matching: 'lifecycle.working.matching',
  coding: 'lifecycle.working.coding',
  awaiting_evidence: 'lifecycle.working.awaitingEvidence',
  posting: 'lifecycle.working.posting',
  drafting_question: 'lifecycle.working.draftingQuestion',
  applying_reply: 'lifecycle.working.applyingReply',
  rechecking: 'lifecycle.working.rechecking',
  waiting_for_host: 'lifecycle.working.waitingForHost',
  in_progress: 'lifecycle.processing'
});

// The phase a Processing pill names, or null when the pill is not Processing
// or the receipt names no phase (then the plain "Processing" label stands).
export const streamEntryPhase = (lane, row = {}) => {
  if (streamEntryState(lane, row) !== 'processing') return null;
  const activity = row.processing_activity || row.document?.processing_activity;
  return LIVE_ACTIVITY.has(activity?.state) && WORKING_PHASES[activity?.phase] ? activity.phase : null;
};

// One summary per live upload batch, read off the receipts its owed rows carry.
// A batch whose work is all finished (or expired) has no live receipt and so
// no summary: the summary can never outlive, or hide, a finished row.
export const activityBatchSummaries = (rows = []) => {
  const batches = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const activity = row?.processing_activity || row?.document?.processing_activity;
    if (!LIVE_ACTIVITY.has(activity?.state) || !activity?.batch?.batch_id) continue;
    if (!batches.has(activity.batch.batch_id)) batches.set(activity.batch.batch_id, { ...activity.batch, valid_until: activity.valid_until });
  }
  return [...batches.values()].sort((a, b) => String(a.batch_id).localeCompare(String(b.batch_id)));
};

// Parts, not one string, so a mounted surface can isolate the file name for
// bidi (Arabic Alpha) and join the parts itself; the label joins them plain.
export const activityBatchSummaryParts = (summary, formatMessage = null, isolate = (value) => value) => {
  if (!summary) return [];
  const message = (id, values, fallback) => typeof formatMessage === 'function'
    ? formatMessage({ id }, values)
    : fallback;
  const reading = Array.isArray(summary.reading) ? summary.reading.filter(Boolean) : [];
  const parts = [];
  if (reading.length === 1) {
    parts.push(message('lifecycle.batch.reading', { name: isolate(reading[0]) }, `Reading ${reading[0]}`));
  } else if (reading.length > 1) {
    const more = reading.length - 1;
    parts.push(message('lifecycle.batch.readingMore', { name: isolate(reading[0]), count: more }, `Reading ${reading[0]} and ${more} more`));
  } else {
    parts.push(message('lifecycle.batch.working', {}, 'Working through this upload'));
  }
  if (summary.done) parts.push(message('lifecycle.batch.done', { count: summary.done }, `${summary.done} done`));
  if (summary.on_owner) parts.push(message('lifecycle.batch.onOwner', { count: summary.on_owner }, `${summary.on_owner} waiting on you`));
  if (summary.in_progress) parts.push(message('lifecycle.batch.inProgress', { count: summary.in_progress }, `${summary.in_progress} in progress`));
  return parts;
};

export const activityBatchSummaryLabel = (summary, formatMessage = null) =>
  activityBatchSummaryParts(summary, formatMessage).join(' · ');
