// Slice 2 of the realtime-truthful-feedback arc
// (docs/design-realtime-truthful-feedback.md): the pure fold/prune helpers
// behind the donna-financials-panel merge-tick. The UI subscribes to RECEIPTS
// — sanitized audit events off GET /feed-events, plus the per-row outcome the
// apply HTTP response reports — and never animates intentions. Everything here
// is a projection of persisted state; nothing in this module mutates or
// re-infers.
//
// A "receipt" is the per-transaction record the row treatments render from:
//   { kind, ledger_pending, account_name?, error?, reason?,
//     original_journal_id?, source, received_at }
// kind ∈ applied | recoded | ledger_pending | ledger_adjusted | apply_failed.
// `source` names the persisted stream the receipt came from (the
// render-the-persisted-verdict rail: every rendered state names its source).

// Transient success receipts (applied / recoded / ledger_adjusted) fade after
// this long — the snapshot rows already render the persisted end state, the
// receipt only carries the announcement. Failures stay much longer: silence
// on failure is the same lie as optimism on success. A ledger_pending receipt
// is NEVER pruned — it is an honest resting state until a later
// ledger.adjustment_posted receipt (or a client switch) clears it.
export const RECEIPT_SUCCESS_TTL_MS = 12_000;
export const RECEIPT_FAILURE_TTL_MS = 5 * 60_000;

export const hasFeedChanges = (payload = {}) =>
  Boolean(
    (Array.isArray(payload.events) && payload.events.length) ||
    (Array.isArray(payload.documents) && payload.documents.length) ||
    (Array.isArray(payload.transactions) && payload.transactions.length)
  );

// Fold sanitized /feed-events audit rows into the receipts map. Events arrive
// ascending by id, so a later event for the same transaction supersedes an
// earlier one by plain overwrite — e.g. ledger.adjustment_posted clears the
// ledger_pending a review.recode_decided opened.
//
// recode_decided is keyed by review-item id (its resource), so the caller
// passes resolveReviewItemTransactionId — a lookup into the snapshot's review
// queue — to land the receipt on the row that renders it. An unresolvable
// item (row not in the loaded snapshot) is skipped: the snapshot refresh the
// tick also triggers will render its persisted state anyway.
export const foldFeedEventsIntoReceipts = (
  prev = {},
  events = [],
  { resolveReviewItemTransactionId, now = 0 } = {}
) => {
  if (!Array.isArray(events) || !events.length) return prev;
  const next = { ...prev };
  let changed = false;
  for (const event of events) {
    if (!event || typeof event !== 'object') continue;
    const meta = event.metadata && typeof event.metadata === 'object' ? event.metadata : {};
    if (event.action === 'review.recode_decided') {
      const txId = typeof resolveReviewItemTransactionId === 'function'
        ? resolveReviewItemTransactionId(event.resource_id)
        : null;
      if (!txId) continue;
      next[String(txId)] = {
        kind: meta.ledger_adjustment_required ? 'ledger_pending' : 'recoded',
        ledger_pending: Boolean(meta.ledger_adjustment_required),
        account_name: meta.account_name || null,
        original_journal_id: meta.original_journal_id || null,
        source: 'audit:review.recode_decided',
        received_at: now
      };
      changed = true;
    } else if (event.action === 'ledger.adjustment_posted') {
      if (!meta.transaction_id) continue;
      next[String(meta.transaction_id)] = {
        kind: 'ledger_adjusted',
        ledger_pending: false,
        original_journal_id: meta.original_journal_id || null,
        source: 'audit:ledger.adjustment_posted',
        received_at: now
      };
      changed = true;
    } else if (event.action === 'transaction.feed_chat_apply') {
      // The feed-level receipt carries per-row detail only for FAILURES
      // (metadata.errors, capped at the writer). Successful rows are covered
      // by the snapshot refresh + the apply HTTP outcome fold.
      const failures = Array.isArray(meta.errors) ? meta.errors : [];
      for (const failure of failures) {
        if (!failure?.transaction_id) continue;
        next[String(failure.transaction_id)] = {
          kind: 'apply_failed',
          ledger_pending: false,
          error: failure.error || 'apply failed',
          source: 'audit:transaction.feed_chat_apply',
          received_at: now
        };
        changed = true;
      }
    }
  }
  return changed ? next : prev;
};

// Fold the per-row outcome of an apply HTTP response (feedChatApply's
// result.results — written to the DB in the same transaction the response
// reports on, so this is receipt-rendering, not optimism). This is what makes
// a feed apply's split state visible per row: the feed-level audit event does
// not carry ledger_adjustment_required, the row outcome does.
export const foldApplyOutcomeIntoReceipts = (prev = {}, results = [], { now = 0 } = {}) => {
  if (!Array.isArray(results) || !results.length) return prev;
  const next = { ...prev };
  let changed = false;
  for (const row of results) {
    if (!row || !row.transaction_id) continue;
    const txId = String(row.transaction_id);
    const posting = row.posting && typeof row.posting === 'object' ? row.posting : null;
    if (!row.applied) {
      next[txId] = {
        kind: 'apply_failed',
        ledger_pending: false,
        error: row.error || posting?.error || 'apply failed',
        source: 'apply-receipt',
        received_at: now
      };
    } else if (posting?.step === 'ledger_adjustment_required') {
      next[txId] = {
        kind: 'ledger_pending',
        ledger_pending: true,
        reason: posting.reason || null,
        original_journal_id: posting.original_journal_id || null,
        source: 'apply-receipt',
        received_at: now
      };
    } else if (posting?.status === 'error') {
      next[txId] = {
        kind: 'apply_failed',
        ledger_pending: false,
        error: posting.error || 'posting failed',
        source: 'apply-receipt',
        received_at: now
      };
    } else if (posting?.step === 'ledger_reclass' && posting?.status === 'posted') {
      next[txId] = {
        kind: 'ledger_adjusted',
        ledger_pending: false,
        original_journal_id: posting.original_journal_id || null,
        source: 'apply-receipt',
        received_at: now
      };
    } else {
      next[txId] = {
        kind: 'applied',
        ledger_pending: false,
        source: 'apply-receipt',
        received_at: now
      };
    }
    changed = true;
  }
  return changed ? next : prev;
};

// Expire transient receipts. ledger_pending is exempt by design — see the
// TTL note above. Returns `prev` untouched when nothing expires so React
// state setters can no-op on identity.
export const pruneReceipts = (prev = {}, { now = 0 } = {}) => {
  const entries = Object.entries(prev);
  if (!entries.length) return prev;
  const next = {};
  let changed = false;
  for (const [txId, receipt] of entries) {
    if (receipt?.ledger_pending) {
      next[txId] = receipt;
      continue;
    }
    const ttl = receipt?.kind === 'apply_failed' ? RECEIPT_FAILURE_TTL_MS : RECEIPT_SUCCESS_TTL_MS;
    if (now - (receipt?.received_at || 0) >= ttl) {
      changed = true;
      continue;
    }
    next[txId] = receipt;
  }
  return changed ? next : prev;
};
