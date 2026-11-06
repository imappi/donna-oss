// Orphan-reply backfill helpers.
//
// PR #142 wired client portal replies to thread back into the
// transaction chat as `client_reply_received` system messages. That
// bridge only fires from the resolve route onwards — any reply
// resolved BEFORE the bridge landed is missing the chat row.
//
// This module exposes the pure pieces of the one-shot backfill so the
// shape (content, payload, derived created_at) is testable without a
// DB connection. The CLI in scripts/backfill_orphan_client_replies.js
// composes these with a direct insert.

import crypto from 'node:crypto';

// Mirrors server/donna/transactionChat.js#messageIdFor. Duplicated
// (rather than imported) to keep this module pure — the upstream
// module also exports the LLM client which we don't want pulled into
// a backfill script's runtime. Output prefix matches so a future
// audit grepping for txchat- ids treats backfilled rows identically.
export const newBackfillMessageId = ({ transactionId, kind = 'system', createdAtMs = Date.now() } = {}) => {
  const slug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32);
  const raw = `${transactionId}|${kind}|${createdAtMs}|${crypto.randomBytes(4).toString('hex')}`;
  const hash = crypto.createHash('sha256').update(raw).digest('hex').slice(0, 12);
  return `txchat-${slug(transactionId)}-${kind}-${hash}`;
};

// Pure: derive the chat-message row from an evidence_request row.
// Mirrors the content + payload PR #142 emits at the resolve route,
// so a backfilled row is indistinguishable from a live-bridged one
// to any consumer that reads transaction_chat_messages.
//
// The created_at is backdated to the evidence request's reply time so
// the system message appears in the right place chronologically. We
// prefer response_payload.responded_at (set by the resolve writer
// itself), falling back to the row's responded_at / resolved_at /
// updated_at columns. created_at on the underlying request row is
// LAST because it reflects the original draft, not the reply.
export const buildClientReplyChatMessage = (evidenceRequest) => {
  if (!evidenceRequest || typeof evidenceRequest !== 'object') return null;
  if (!evidenceRequest.transaction_id || !evidenceRequest.client_id) return null;

  const responsePayload = evidenceRequest.response_payload || {};
  const replyText = String(responsePayload.reply || '').trim();
  const docIds = Array.isArray(responsePayload.document_ids)
    ? responsePayload.document_ids.filter(Boolean)
    : [];

  let content = replyText;
  if (!content) {
    if (docIds.length > 0) {
      content = `Client uploaded ${docIds.length} document${docIds.length === 1 ? '' : 's'} in response.`;
    } else {
      content = 'Client marked this resolved.';
    }
  }

  const createdAt = coerceTimestamp(
    responsePayload.responded_at
      || evidenceRequest.responded_at
      || evidenceRequest.resolved_at
      || evidenceRequest.updated_at
      || evidenceRequest.created_at
  );

  return {
    id: newBackfillMessageId({
      transactionId: evidenceRequest.transaction_id,
      kind: 'system',
      createdAtMs: createdAt ? new Date(createdAt).getTime() : Date.now()
    }),
    firm_id: evidenceRequest.firm_id,
    client_id: evidenceRequest.client_id,
    transaction_id: evidenceRequest.transaction_id,
    role: 'system',
    content,
    payload: {
      kind: 'client_reply_received',
      evidence_request_id: evidenceRequest.id,
      document_ids: docIds,
      has_reply_text: replyText.length > 0,
      backfilled: true
    },
    actor_type: 'system',
    created_at: createdAt
  };
};

// Best-effort timestamp coercion. Accepts ISO strings, epoch millis,
// and Date instances. Returns an ISO string or null.
const coerceTimestamp = (value) => {
  if (!value) return null;
  if (value instanceof Date) {
    return Number.isFinite(value.getTime()) ? value.toISOString() : null;
  }
  if (typeof value === 'number') {
    const date = new Date(value);
    return Number.isFinite(date.getTime()) ? date.toISOString() : null;
  }
  if (typeof value === 'string') {
    const date = new Date(value);
    return Number.isFinite(date.getTime()) ? date.toISOString() : null;
  }
  return null;
};

// SQL: candidate evidence requests for backfill. Bound conditions:
//   - linked to a transaction (chat lives on the transaction)
//   - status replied/resolved (client actually responded)
//   - responded_at is set
//   - $1: optional firm_id filter (null for all firms)
//   - $2: optional client_id filter (null for all clients)
export const CANDIDATE_REQUESTS_SQL = `
  select id, firm_id, client_id, transaction_id, response_payload,
         responded_at, resolved_at, updated_at, created_at
  from client_evidence_requests
  where transaction_id is not null
    and client_id is not null
    and status in ('replied', 'resolved')
    and responded_at is not null
    and ($1::text is null or firm_id = $1)
    and ($2::text is null or client_id = $2)
  order by responded_at asc
`;

// SQL: idempotency check. The bridge identifies a reply by the
// `payload.evidence_request_id` field — same key the backfill writes —
// so a re-run of this script never duplicates.
export const EXISTING_BRIDGE_ROW_SQL = `
  select 1
  from transaction_chat_messages
  where firm_id = $1
    and client_id = $2
    and transaction_id = $3
    and role = 'system'
    and payload->>'kind' = 'client_reply_received'
    and payload->>'evidence_request_id' = $4
  limit 1
`;

// SQL: confirm the target transaction still exists. Mirrors the
// validation appendTransactionChatMessageInDb does — if a row was
// deleted (e.g. statement reimport) we skip the backfill rather than
// inserting an orphan chat message.
export const TRANSACTION_EXISTS_SQL = `
  select 1
  from transactions
  where firm_id = $1 and client_id = $2 and id = $3
  limit 1
`;

// SQL: backdated insert. Mirrors appendTransactionChatMessageInDb's
// shape but exposes created_at so the chronological order of the
// chat thread stays correct after backfill. Direct insert (rather
// than calling the helper) is the right choice for a one-off
// script — avoids modifying the live append path just to thread a
// timestamp through.
export const INSERT_CHAT_MESSAGE_SQL = `
  insert into transaction_chat_messages
    (id, firm_id, client_id, transaction_id, role, content, payload,
     actor_type, created_at)
  values ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, coalesce($9::timestamptz, now()))
  on conflict (id) do nothing
  returning id, created_at
`;
