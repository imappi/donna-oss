// PR 3 of docs/invoice-receipt-parsing-plan.md. Shared review-item DTO
// and audit-event helpers. Before PR 3 the transaction_review_queue
// reader was transaction-shaped throughout — every handler in
// firmDb.js mapped rows via rowToTransactionReviewPayload and inlined
// the status-vocabulary check. PR 3 introduces a second item_type
// (`document_line`) so we pull both surfaces into one module.
//
// Three things live here:
//
//   1. Canonical status vocabulary (`open | resolved | cancelled`).
//      Migration 014 flipped existing rows from `closed | dismissed`
//      onto the new vocabulary; we still tolerate the legacy values
//      on input so any in-flight HTTP payload or stale read doesn't
//      break.
//   2. `rowToReviewItemPayload(row)` — a single envelope for both
//      item_types. `rowToTransactionReviewPayload` (the previously
//      exported helper) becomes a thin wrapper that calls this.
//   3. `emitReviewAudit(client, …)` — the dual-emit shim that writes
//      both the new `review.*` vocabulary and any legacy action name
//      a particular handler used to emit. PR 4 removes the legacy
//      half; the // PR 4 removes this comment marks each call site.

export const REVIEW_ITEM_TYPES = Object.freeze([
  'transaction',
  'reconciliation_match',
  'document_line'
]);

export const REVIEW_ITEM_STATUSES = Object.freeze(['open', 'resolved', 'cancelled']);

// Authority receipts are written by the accepted-decision owner, never by a
// generic payload merge. Property presence matters: null/delete is forgery too.
export const assertNoReviewScopePatch = (patch = {}) => {
  const owned = ['review_scope','processing_scope','projection_freshness'];
  if (owned.some(key => Object.hasOwn(patch,key) || (patch.payload && Object.hasOwn(patch.payload,key)))) {
    throw Object.assign(new Error('The saved review receipt is server-owned.'), {
      code: 'REVIEW_SCOPE_SERVER_OWNED', statusCode: 409, retryable: false
    });
  }
};

// Legacy values still accepted on input (pre-migration-014 rows + any
// caller that hasn't been updated yet). The shared helper normalises
// to the canonical form; nothing here writes the legacy values back.
const REVIEW_ITEM_STATUS_ALIASES = new Map([
  ['closed', 'resolved'],
  ['dismissed', 'cancelled']
]);

export const normalizeReviewItemStatus = (value) => {
  if (value == null) return null;
  const trimmed = String(value).trim().toLowerCase();
  if (!trimmed) return null;
  if (REVIEW_ITEM_STATUSES.includes(trimmed)) return trimmed;
  return REVIEW_ITEM_STATUS_ALIASES.get(trimmed) || null;
};

export const assertValidReviewItemStatus = (value) => {
  const normalised = normalizeReviewItemStatus(value);
  if (!normalised) {
    const error = new Error('Invalid review item status.');
    error.statusCode = 400;
    error.code = 'INVALID_REVIEW_ITEM_STATUS';
    error.details = { allowed: REVIEW_ITEM_STATUSES.slice() };
    throw error;
  }
  return normalised;
};

const toIso = (value) => {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  const dt = new Date(value);
  return Number.isNaN(dt.getTime()) ? null : dt.toISOString();
};

// Shared envelope. Keys are identical across item_types so consumers
// can branch on `item_type` without re-reading two different shapes.
// Extra item_type-specific fields land under `details` to keep the
// top-level keys stable.
export const rowToReviewItemPayload = (row = {}) => {
  const itemType = row.item_type || 'transaction';
  const status = normalizeReviewItemStatus(row.status) || 'open';
  return {
    id: row.id,
    firm_id: row.firm_id,
    client_id: row.client_id,
    item_type: itemType,
    item_id: row.item_id,
    reason: row.reason,
    priority: row.priority || 'normal',
    status,
    assigned_to: row.assigned_to || null,
    payload: row.payload || {},
    review_state: row.review_state || null,
    created_at: toIso(row.created_at),
    updated_at: toIso(row.updated_at)
  };
};

// PR 3 audit vocabulary. The transaction-side handler still emits the
// legacy `transaction_review.update` event alongside these; PR 4
// removes that emit. New surfaces (document-line PATCH, merge orphan)
// only emit the `review.*` half.
export const REVIEW_AUDIT_ACTIONS = Object.freeze({
  ACCEPTED: 'review.accepted',
  OVERRIDDEN: 'review.overridden',
  DEFERRED: 'review.deferred',
  ORPHANED: 'review.orphaned'
});

// Dual-emit helper. `legacyAction` is optional; pass it when an
// existing handler used to emit a transaction-specific action that
// we want to keep alive for one cycle.
export const emitReviewAudit = async (client, {
  firmId,
  clientId,
  itemType,
  itemId,
  action,
  metadata = {},
  legacyAction = null,
  legacyResourceType = null,
  legacyResourceId = null,
  // Pod-safety gap #1: the operator who drove this review action. Defaults to
  // 'system' so non-attributed callers are byte-identical to pre-gap-#1.
  actorId = 'system',
  actorType = 'system'
} = {}) => {
  if (!client || !firmId || !action) return;
  const baseMetadata = { ...metadata, item_type: itemType, item_id: itemId };
  const receipt = await client.query(
    `insert into audit_events (firm_id, client_id, actor_type, actor_id, action, resource_type, resource_id, metadata)
     values ($1, $2, $8, $3, $4, $5, $6, $7::jsonb) returning id`,
    [
      firmId,
      clientId || null,
      actorId,
      action,
      itemType === 'document_line' ? 'document_line' : 'transaction_review',
      itemId,
      JSON.stringify(baseMetadata),
      actorType
    ]
  );
  if (legacyAction) {
    // PR 4 removes this dual-emit. Kept for one cycle so analytics
    // and any downstream readers of `transaction_review.update`
    // don't lose continuity.
    await client.query(
      `insert into audit_events (firm_id, client_id, actor_type, actor_id, action, resource_type, resource_id, metadata)
       values ($1, $2, $8, $3, $4, $5, $6, $7::jsonb)`,
      [
        firmId,
        clientId || null,
        actorId,
        legacyAction,
        legacyResourceType || 'transaction_review',
        legacyResourceId || itemId,
        JSON.stringify(baseMetadata),
        actorType
      ]
    );
  }
  return receipt.rows?.[0]?.id == null ? null : String(receipt.rows[0].id);
};
