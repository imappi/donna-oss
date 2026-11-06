// server/donna/db/chat.js — plane S — chat threads: document, transaction, firm and client-portal chat writers and readers (the proposal mint audit).
//
// RT-17 (2026-09-02): extracted from server/donna/firmDb.js as a pure move. Every public
// symbol keeps its old import path through firmDb.js, which re-exports it; helpers another
// plane needs are exported here and NOT re-exported by firmDb.js. Zero behaviour change.

import { chatCommentAuditEvent, isCommentPayload, REDACTED_CONTENT_MARKER, redactionPayloadStamp } from '../mentions/commentEvents.js';

import { queryFirmDb, withFirmDbClient } from './pool.js';
import { DEFAULT_FIRM_ID } from './clients.js';
import { rowToDocumentPayload } from './documents.js';

// ─── Document chat (PR 27) ─────────────────────────────────────────────
// Persistence helpers for the document artifact's chat surface. The
// thread is keyed on (firm_id, client_id, document_id); reopening the
// artifact resumes the conversation. PR 27 ships informational chat
// only — `payload.actions` items render as proposed cards in the FE,
// but Apply paths are not yet wired (action types are not in
// DOCUMENT_CHAT_APPLIABLE_ACTION_TYPES). PR 28+ will extend each row
// with `applied_at` / `result` per-action without a schema change
// (payload is jsonb).

const rowToDocumentChatMessagePayload = (row = {}) => ({
  id: row.id,
  firm_id: row.firm_id,
  client_id: row.client_id,
  document_id: row.document_id,
  role: row.role,
  content: row.content,
  payload: row.payload || {},
  model: row.model || null,
  model_version: row.model_version || null,
  actor_type: row.actor_type || 'firm',
  actor_id: row.actor_id || null,
  created_at: row.created_at ? new Date(row.created_at).toISOString() : null
});

// Load the chat thread for a single document. Ordered oldest-first
// so the FE can append without re-sorting. Bounded at 500 messages
// — well above any plausible thread length but cheap to slice.
export const getDocumentChatThreadFromDb = async ({
  firmId = DEFAULT_FIRM_ID,
  clientId,
  documentId
} = {}) => {
  if (!clientId) {
    const error = new Error('client_id is required.');
    error.statusCode = 400;
    throw error;
  }
  if (!documentId) {
    const error = new Error('document_id is required.');
    error.statusCode = 400;
    throw error;
  }
  // The document FK enforces existence; an unknown document yields
  // an empty thread (legitimate state — first time opening a doc).
  const result = await queryFirmDb(
    `select id, firm_id, client_id, document_id, role, content, payload,
            model, model_version, actor_type, actor_id, created_at
       from document_chat_messages
      where firm_id = $1 and client_id = $2 and document_id = $3
      order by created_at asc
      limit 500`,
    [firmId, clientId, documentId]
  );
  return result.rows.map(rowToDocumentChatMessagePayload);
};

// Append a single message to a thread. Used for both user-typed
// messages and assistant replies. The (firm, client, document)
// tuple is validated against the documents table to prevent a
// stray write to a doc the firm doesn't own.
// Load a single chat message by id. Used by the action-apply path
// so we can read the proposed action's params from the persisted
// payload rather than trusting whatever the FE sends in the body —
// the FE could be stale or tampered. Returns null on miss.
export const getDocumentChatMessageFromDb = async ({
  firmId = DEFAULT_FIRM_ID,
  clientId,
  documentId,
  messageId
} = {}) => {
  if (!clientId || !documentId || !messageId) return null;
  const result = await queryFirmDb(
    `select id, firm_id, client_id, document_id, role, content, payload,
            model, model_version, actor_type, actor_id, created_at
       from document_chat_messages
      where firm_id = $1 and client_id = $2 and document_id = $3 and id = $4
      limit 1`,
    [firmId, clientId, documentId, messageId]
  );
  if (!result.rows.length) return null;
  return rowToDocumentChatMessagePayload(result.rows[0]);
};

// Atomically update a single proposed action on an assistant
// message to applied (or declined / failed). Uses jsonb_set so the
// other actions in the same message payload are untouched, and is
// safe to retry — a second call simply re-writes the same patch.
//
// `status` is the new status string ('applied' | 'declined' | 'failed').
// `result` is the per-action result blob (e.g. { match_id, matched_object_type }
// for link_transaction).
export const updateDocumentChatActionStatusInDb = async ({
  firmId = DEFAULT_FIRM_ID,
  clientId,
  documentId,
  messageId,
  actionIndex,
  status,
  result = null
} = {}) => {
  if (!clientId || !documentId || !messageId) {
    const error = new Error('client_id, document_id, and message_id are required.');
    error.statusCode = 400;
    throw error;
  }
  if (!Number.isInteger(actionIndex) || actionIndex < 0) {
    const error = new Error('action_index must be a non-negative integer.');
    error.statusCode = 400;
    throw error;
  }
  if (!['applied', 'declined', 'failed'].includes(status)) {
    const error = new Error(`Invalid action status: ${status}`);
    error.statusCode = 400;
    throw error;
  }
  // Build the per-action patch — preserve every existing field on
  // the action object plus stamp the new status, applied_at, and
  // optional result blob.
  const message = await getDocumentChatMessageFromDb({ firmId, clientId, documentId, messageId });
  if (!message) {
    const error = new Error('Chat message not found.');
    error.statusCode = 404;
    throw error;
  }
  const actions = Array.isArray(message?.payload?.actions) ? message.payload.actions : [];
  const target = actions[actionIndex];
  if (!target) {
    const error = new Error(`Action index ${actionIndex} out of range (message has ${actions.length} actions).`);
    error.statusCode = 404;
    throw error;
  }
  const nowIso = new Date().toISOString();
  const patchedAction = {
    ...target,
    status,
    applied_at: status === 'applied' ? nowIso : (target.applied_at || null),
    result: result || target.result || null
  };
  // jsonb_set with the path '{actions,N}' replaces the Nth element
  // in place. Index is templated rather than parameterised because
  // path elements in jsonb_set are a text array literal; the index
  // is validated above as an integer so injection is not possible.
  const path = `{actions,${actionIndex}}`;
  const update = await queryFirmDb(
    `update document_chat_messages
        set payload = jsonb_set(payload, $5::text[], $6::jsonb, true)
      where firm_id = $1 and client_id = $2 and document_id = $3 and id = $4
      returning id, firm_id, client_id, document_id, role, content, payload,
                model, model_version, actor_type, created_at`,
    [
      firmId,
      clientId,
      documentId,
      messageId,
      path,
      JSON.stringify(patchedAction)
    ]
  );
  if (!update.rows.length) {
    const error = new Error('Chat message not found.');
    error.statusCode = 404;
    throw error;
  }
  return rowToDocumentChatMessagePayload(update.rows[0]);
};

// Slice 4 — the one insert for pre-built mention_notifications rows (124),
// run inside the appenders' transactions so a comment and its fan-out commit
// or roll back together. Deterministic ids + on-conflict-do-nothing keep the
// fan-out idempotent under retries.
const __insertMentionNotificationRows = async (client, rows = []) => {
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row?.id) continue;
    await client.query(
      `insert into mention_notifications
         (id, firm_id, client_id, principal_type, principal_id, kind,
          artifact_type, artifact_id, actor_id, actor_display, excerpt,
          message_id, ask_id)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       on conflict (id) do nothing`,
      [
        row.id, row.firm_id, row.client_id, row.principal_type, row.principal_id,
        row.kind, row.artifact_type, row.artifact_id, row.actor_id,
        row.actor_display, row.excerpt, row.message_id, row.ask_id
      ]
    );
  }
};

export const appendDocumentChatMessageInDb = async ({
  firmId = DEFAULT_FIRM_ID,
  clientId,
  documentId,
  id,
  role,
  content,
  payload = {},
  model = null,
  modelVersion = null,
  actorType = 'firm',
  // 123 — WHO typed a human row (chatApplyActorId's value). Null on machine
  // rows and legacy callers; REQUIRED for comment-lane rows (the check below).
  actorId = null,
  // Build 1 seat vocabulary: { seat_role, affiliation } when the poster is a
  // staff seat — rides the comment audit metadata like the seat.* receipts.
  actorSeat = null,
  // Slice 4 — pre-built mention_notifications rows
  // (notificationEvents.buildMentionNotificationRows): committed in the SAME
  // transaction as the message + audit, deterministic ids, on conflict do
  // nothing (a retried write cannot double-notify).
  notificationRows = []
} = {}) => {
  if (!clientId) {
    const error = new Error('client_id is required.');
    error.statusCode = 400;
    throw error;
  }
  if (!documentId) {
    const error = new Error('document_id is required.');
    error.statusCode = 400;
    throw error;
  }
  if (!id) {
    const error = new Error('message id is required.');
    error.statusCode = 400;
    throw error;
  }
  if (!['user', 'assistant', 'system'].includes(role)) {
    const error = new Error(`Invalid role: ${role}`);
    error.statusCode = 400;
    throw error;
  }
  if (typeof content !== 'string' || !content.length) {
    const error = new Error('content is required.');
    error.statusCode = 400;
    throw error;
  }
  // Validate that the document exists for this (firm, client). A
  // missing doc means stale UI state or a permissions attempt; both
  // surface as 404 to the caller.
  const docCheck = await queryFirmDb(
    `select 1 from documents
      where firm_id = $1 and client_id = $2 and id = $3
      limit 1`,
    [firmId, clientId, documentId]
  );
  if (!docCheck.rows.length) {
    const error = new Error('Document not found for this firm/client.');
    error.statusCode = 404;
    throw error;
  }
  // Same audit-as-precondition discipline as the transaction-chat writer:
  // an assistant message minting proposed actions commits together with its
  // audit row or not at all.
  const proposalAudit = __chatProposalAuditEvent({
    surface: 'document_chat',
    message: { id, role, payload, model, model_version: modelVersion },
    threadRef: { document_id: documentId }
  });
  // Universal mentions (slice 3): a comment-lane row is NOT plain
  // conversation — it commits together with its attributed audit row or not
  // at all, and it never lands anonymous.
  if (isCommentPayload(payload) && !String(actorId || '').trim()) {
    const error = new Error('A comment requires an attributed actor (actorId).');
    error.statusCode = 400;
    error.code = 'CHAT_COMMENT_ACTOR_REQUIRED';
    throw error;
  }
  const commentAudit = chatCommentAuditEvent({
    surface: 'document_chat',
    message: { id, payload },
    actorId,
    threadRef: { document_id: documentId },
    actorSeat
  });
  const result = await withFirmDbClient(async (client) => {
    await client.query('begin');
    try {
      const inserted = await client.query(
        `insert into document_chat_messages
           (id, firm_id, client_id, document_id, role, content, payload,
            model, model_version, actor_type, actor_id)
         values ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, $11)
         returning id, firm_id, client_id, document_id, role, content, payload,
                   model, model_version, actor_type, actor_id, created_at`,
        [
          id,
          firmId,
          clientId,
          documentId,
          role,
          content,
          JSON.stringify(payload || {}),
          model,
          modelVersion,
          actorType,
          actorId
        ]
      );
      if (proposalAudit) {
        await client.query(
          `insert into audit_events (firm_id, client_id, actor_type, actor_id, action, resource_type, resource_id, metadata)
           values ($1, $2, 'system', 'system', $3, $4, $5, $6::jsonb)`,
          [
            firmId,
            clientId,
            proposalAudit.action,
            proposalAudit.resourceType,
            proposalAudit.resourceId,
            JSON.stringify(proposalAudit.metadata)
          ]
        );
      }
      if (commentAudit) {
        await client.query(
          `insert into audit_events (firm_id, client_id, actor_type, actor_id, action, resource_type, resource_id, metadata)
           values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)`,
          [
            firmId,
            clientId,
            actorType,
            commentAudit.actorId,
            commentAudit.action,
            commentAudit.resourceType,
            commentAudit.resourceId,
            JSON.stringify(commentAudit.metadata)
          ]
        );
      }
      await __insertMentionNotificationRows(client, notificationRows);
      await client.query('commit');
      return inserted;
    } catch (error) {
      await client.query('rollback');
      throw error;
    }
  });
  return rowToDocumentChatMessagePayload(result.rows[0]);
};

// ─── Transaction chat helpers (migration 016) ────────────────────────────
//
// Per-(firm, client, transaction) chat thread. Mirrors the
// document-chat helpers above but keyed on a transaction. Used by
// the bank-feed artifact's case-file chat surface.

const rowToTransactionChatMessagePayload = (row = {}) => ({
  id: row.id,
  firm_id: row.firm_id,
  client_id: row.client_id,
  transaction_id: row.transaction_id,
  role: row.role,
  content: row.content,
  payload: row.payload || {},
  model: row.model || null,
  model_version: row.model_version || null,
  actor_type: row.actor_type || 'firm',
  actor_id: row.actor_id || null,
  created_at: row.created_at ? new Date(row.created_at).toISOString() : null
});

export const getTransactionChatThreadFromDb = async ({
  firmId = DEFAULT_FIRM_ID,
  clientId,
  transactionId
} = {}) => {
  if (!clientId) {
    const error = new Error('client_id is required.');
    error.statusCode = 400;
    throw error;
  }
  if (!transactionId) {
    const error = new Error('transaction_id is required.');
    error.statusCode = 400;
    throw error;
  }
  const result = await queryFirmDb(
    `select id, firm_id, client_id, transaction_id, role, content, payload,
            model, model_version, actor_type, actor_id, created_at
       from transaction_chat_messages
      where firm_id = $1 and client_id = $2 and transaction_id = $3
      order by created_at asc
      limit 500`,
    [firmId, clientId, transactionId]
  );
  return result.rows.map(rowToTransactionChatMessagePayload);
};

// Per-transaction "did the client reply recently?" rollup. Powers
// the bank-feed unread dot — the FE compares each row's
// latest_client_reply_at against a local last-seen timestamp to
// decide whether to badge it.
//
// Only `client_reply_received` system messages count. firm-typed
// messages and Donna's assistant turns don't represent inbound
// traffic the firm hasn't acted on. Transactions with no reply ever
// don't appear in the result — the FE treats absence as "no badge".
export const getTransactionChatUnreadSummaryFromDb = async ({
  firmId = DEFAULT_FIRM_ID,
  clientId
} = {}) => {
  if (!clientId) {
    const error = new Error('client_id is required.');
    error.statusCode = 400;
    throw error;
  }
  const result = await queryFirmDb(
    `select transaction_id,
            max(created_at) as latest_client_reply_at
       from transaction_chat_messages
      where firm_id = $1
        and client_id = $2
        and role = 'system'
        and payload->>'kind' = 'client_reply_received'
      group by transaction_id`,
    [firmId, clientId]
  );
  return result.rows.map((row) => ({
    transaction_id: row.transaction_id,
    latest_client_reply_at: row.latest_client_reply_at instanceof Date
      ? row.latest_client_reply_at.toISOString()
      : row.latest_client_reply_at
  }));
};

export const getTransactionChatMessageFromDb = async ({
  firmId = DEFAULT_FIRM_ID,
  clientId,
  transactionId,
  messageId
} = {}) => {
  if (!clientId || !transactionId || !messageId) return null;
  const result = await queryFirmDb(
    `select id, firm_id, client_id, transaction_id, role, content, payload,
            model, model_version, actor_type, actor_id, created_at
       from transaction_chat_messages
      where firm_id = $1 and client_id = $2 and transaction_id = $3 and id = $4
      limit 1`,
    [firmId, clientId, transactionId, messageId]
  );
  if (!result.rows.length) return null;
  return rowToTransactionChatMessagePayload(result.rows[0]);
};

export const updateTransactionChatActionStatusInDb = async ({
  firmId = DEFAULT_FIRM_ID,
  clientId,
  transactionId,
  messageId,
  actionIndex,
  status,
  result = null
} = {}) => {
  if (!clientId || !transactionId || !messageId) {
    const error = new Error('client_id, transaction_id, and message_id are required.');
    error.statusCode = 400;
    throw error;
  }
  if (!Number.isInteger(actionIndex) || actionIndex < 0) {
    const error = new Error('action_index must be a non-negative integer.');
    error.statusCode = 400;
    throw error;
  }
  if (!['applied', 'declined', 'failed'].includes(status)) {
    const error = new Error(`Invalid action status: ${status}`);
    error.statusCode = 400;
    throw error;
  }
  const message = await getTransactionChatMessageFromDb({ firmId, clientId, transactionId, messageId });
  if (!message) {
    const error = new Error('Chat message not found.');
    error.statusCode = 404;
    throw error;
  }
  const actions = Array.isArray(message?.payload?.actions) ? message.payload.actions : [];
  const target = actions[actionIndex];
  if (!target) {
    const error = new Error(`Action index ${actionIndex} out of range (message has ${actions.length} actions).`);
    error.statusCode = 404;
    throw error;
  }
  const nowIso = new Date().toISOString();
  const patchedAction = {
    ...target,
    status,
    applied_at: status === 'applied' ? nowIso : (target.applied_at || null),
    result: result || target.result || null
  };
  const path = `{actions,${actionIndex}}`;
  const update = await queryFirmDb(
    `update transaction_chat_messages
        set payload = jsonb_set(payload, $5::text[], $6::jsonb, true)
      where firm_id = $1 and client_id = $2 and transaction_id = $3 and id = $4
      returning id, firm_id, client_id, transaction_id, role, content, payload,
                model, model_version, actor_type, created_at`,
    [
      firmId,
      clientId,
      transactionId,
      messageId,
      path,
      JSON.stringify(patchedAction)
    ]
  );
  if (!update.rows.length) {
    const error = new Error('Chat message not found.');
    error.statusCode = 404;
    throw error;
  }
  return rowToTransactionChatMessagePayload(update.rows[0]);
};

// Virtual chat-thread keys: a row in transaction_chat_messages whose
// transaction_id is a SENTINEL, not a real transactions row. The feed
// chat (#381) keys its single per-client thread under '__feed__'; the
// table has no FK to transactions (migration 016) by design, because
// the thread is global to the feed, not attached to one line. The
// existence guard in appendTransactionChatMessageInDb MUST skip these —
// they will never match the transactions table, so the per-transaction
// guard would (and did) 404 every feed-chat Send. Operator-loop case
// threads will join this set under their own sentinels.
export const VIRTUAL_CHAT_THREAD_IDS = new Set(['__feed__']);
// S3 role threads join as a PATTERN, not set members: the sentinel is derived
// from the role registry (`__role_<roleId>__`, feedChat.roleChatThreadId), and
// the dunder form stays unreachable from real transaction ids. Kept as a regex
// so firmDb does not import the registry for a membership test.
const ROLE_CHAT_THREAD_ID_RE = /^__role_[a-z0-9_]+__$/;
export const isVirtualChatThreadId = (transactionId) =>
  VIRTUAL_CHAT_THREAD_IDS.has(transactionId)
  || ROLE_CHAT_THREAD_ID_RE.test(String(transactionId || ''));

// ─── Universal mentions (slice 3): comment redaction ───────────────────────
// The ONE sanctioned content mutation on a chat store, mirroring migration
// 119's erasure-scrub shape: the body becomes the marker, the payload takes
// the stamp, and the act writes its audit row in the SAME transaction. Only
// a comment-lane row is redactable — machine rows and plain conversation
// refuse. AUTHZ NOTE: this is an owner-capability action; the route gates it
// (requireMember + the capability layer), the writer only refuses shape.
const CHAT_COMMENT_SURFACES = Object.freeze({
  transaction_chat: { table: 'transaction_chat_messages', threadColumn: 'transaction_id' },
  document_chat: { table: 'document_chat_messages', threadColumn: 'document_id' }
});

export const redactChatCommentInDb = async ({
  firmId = DEFAULT_FIRM_ID,
  clientId,
  surface = 'transaction_chat',
  threadId,
  messageId,
  actorId,
  actorType = 'firm',
  reason = null
} = {}) => {
  const surfaceDef = CHAT_COMMENT_SURFACES[surface];
  if (!surfaceDef) {
    const error = new Error(`Unknown chat comment surface: ${surface}.`);
    error.statusCode = 400;
    throw error;
  }
  if (!clientId || !threadId || !messageId) {
    const error = new Error('client_id, thread id, and message id are required.');
    error.statusCode = 400;
    throw error;
  }
  const cleanActorId = String(actorId || '').trim();
  if (!cleanActorId) {
    const error = new Error('Redaction requires an attributed actor (actorId).');
    error.statusCode = 400;
    error.code = 'CHAT_COMMENT_ACTOR_REQUIRED';
    throw error;
  }
  return withFirmDbClient(async (client) => {
    await client.query('begin');
    try {
      const existing = await client.query(
        `select id, payload from ${surfaceDef.table}
          where firm_id = $1 and client_id = $2 and ${surfaceDef.threadColumn} = $3 and id = $4
          limit 1
          for update`,
        [firmId, clientId, threadId, messageId]
      );
      const row = existing.rows[0];
      if (!row) {
        const error = new Error('Chat message not found.');
        error.statusCode = 404;
        throw error;
      }
      if (String(row.payload?.kind || '') !== 'comment') {
        const error = new Error('Only comment rows can be redacted.');
        error.statusCode = 409;
        error.code = 'CHAT_REDACTION_NOT_A_COMMENT';
        throw error;
      }
      const stamp = redactionPayloadStamp({ actorId: cleanActorId, reason });
      const updated = await client.query(
        `update ${surfaceDef.table}
            set content = $5,
                payload = payload || $6::jsonb
          where firm_id = $1 and client_id = $2 and ${surfaceDef.threadColumn} = $3 and id = $4
          returning id, firm_id, client_id, ${surfaceDef.threadColumn}, role, content, payload,
                    model, model_version, actor_type, actor_id, created_at`,
        [firmId, clientId, threadId, messageId, REDACTED_CONTENT_MARKER, JSON.stringify(stamp)]
      );
      await client.query(
        `insert into audit_events (firm_id, client_id, actor_type, actor_id, action, resource_type, resource_id, metadata)
         values ($1, $2, $3, $4, 'chat.comment_redacted', $5, $6, $7::jsonb)`,
        [
          firmId,
          clientId,
          actorType,
          cleanActorId,
          surface === 'document_chat' ? 'document_chat_message' : 'transaction_chat_message',
          messageId,
          JSON.stringify({ surface, [surfaceDef.threadColumn]: threadId, ...(reason ? { reason: String(reason) } : {}) })
        ]
      );
      await client.query('commit');
      return surface === 'document_chat'
        ? rowToDocumentChatMessagePayload(updated.rows[0])
        : rowToTransactionChatMessagePayload(updated.rows[0]);
    } catch (error) {
      await client.query('rollback');
      throw error;
    }
  });
};

// ─── "Nothing silent": the chat proposal mint's audit event ────────────────
// An assistant chat message carrying open proposed actions is an LLM
// PROPOSAL mint — a persisted mutation that arms Apply buttons — and must
// leave an audit row (the CLAUDE.md "LLM proposals emit NO audit row" gap,
// closed at the WRITER like the #733 merchant mint so every surface that
// funnels through the two message writers is covered: transaction chat,
// feed chat via the '__feed__' sentinel, and document chat). Pure; returns
// null for anything that is not a proposal mint (user messages, action-less
// assistant replies) so plain conversation stays un-audited.
export const __chatProposalAuditEvent = ({ surface, message, threadRef = {} } = {}) => {
  if (!message || message.role !== 'assistant' || !message.id) return null;
  const actions = Array.isArray(message.payload?.actions) ? message.payload.actions : [];
  const proposed = actions.filter(
    (action) => action && action.type && (!action.status || action.status === 'proposed')
  );
  if (!proposed.length) return null;
  const resourceType = surface === 'document_chat'
    ? 'document_chat_message'
    : surface === 'client_chat'
      ? 'client_chat_message'
      : surface === 'firm_feed_chat'
        ? 'firm_chat_message'
        : 'transaction_chat_message';
  return {
    action: 'chat.proposal_minted',
    resourceType,
    resourceId: message.id,
    metadata: {
      surface,
      action_types: [...new Set(proposed.map((action) => action.type))],
      action_count: proposed.length,
      model: message.model || null,
      model_version: message.model_version || null,
      ...threadRef
    }
  };
};

export const appendTransactionChatMessageInDb = async ({
  firmId = DEFAULT_FIRM_ID,
  clientId,
  transactionId,
  id,
  role,
  content,
  payload = {},
  model = null,
  modelVersion = null,
  actorType = 'firm',
  // 123 — WHO typed a human row (chatApplyActorId's value). Null on machine
  // rows and legacy callers; REQUIRED for comment-lane rows (the check below).
  actorId = null,
  // Build 1 seat vocabulary: { seat_role, affiliation } when the poster is a
  // staff seat — rides the comment audit metadata like the seat.* receipts.
  actorSeat = null,
  // Slice 4 — pre-built mention_notifications rows
  // (notificationEvents.buildMentionNotificationRows): committed in the SAME
  // transaction as the message + audit, deterministic ids, on conflict do
  // nothing (a retried write cannot double-notify).
  notificationRows = []
} = {}) => {
  if (!clientId) {
    const error = new Error('client_id is required.');
    error.statusCode = 400;
    throw error;
  }
  if (!transactionId) {
    const error = new Error('transaction_id is required.');
    error.statusCode = 400;
    throw error;
  }
  if (!id) {
    const error = new Error('message id is required.');
    error.statusCode = 400;
    throw error;
  }
  if (!['user', 'assistant', 'system'].includes(role)) {
    const error = new Error(`Invalid role: ${role}`);
    error.statusCode = 400;
    throw error;
  }
  if (typeof content !== 'string' || !content.length) {
    const error = new Error('content is required.');
    error.statusCode = 400;
    throw error;
  }
  // A virtual thread (the feed sentinel) has no backing transactions
  // row by design — only validate existence for real per-transaction
  // threads.
  if (!isVirtualChatThreadId(transactionId)) {
    const txCheck = await queryFirmDb(
      `select 1 from transactions
        where firm_id = $1 and client_id = $2 and id = $3
        limit 1`,
      [firmId, clientId, transactionId]
    );
    if (!txCheck.rows.length) {
      const error = new Error('Transaction not found for this firm/client.');
      error.statusCode = 404;
      throw error;
    }
  }
  // The mint's audit event, computed BEFORE the write so the insert and its
  // record commit or roll back together (audit-as-precondition — no record,
  // no execution). Null for plain conversation: those keep the bare insert's
  // behaviour inside the same transaction shape.
  const proposalAudit = __chatProposalAuditEvent({
    surface: isVirtualChatThreadId(transactionId) ? 'feed_chat' : 'transaction_chat',
    message: { id, role, payload, model, model_version: modelVersion },
    threadRef: { transaction_id: transactionId }
  });
  // Universal mentions (slice 3): a comment-lane row is NOT plain
  // conversation — it commits together with its attributed audit row or not
  // at all, and it never lands anonymous.
  if (isCommentPayload(payload) && !String(actorId || '').trim()) {
    const error = new Error('A comment requires an attributed actor (actorId).');
    error.statusCode = 400;
    error.code = 'CHAT_COMMENT_ACTOR_REQUIRED';
    throw error;
  }
  const commentAudit = chatCommentAuditEvent({
    surface: isVirtualChatThreadId(transactionId) ? 'feed_chat' : 'transaction_chat',
    message: { id, payload },
    actorId,
    threadRef: { transaction_id: transactionId },
    actorSeat
  });
  const result = await withFirmDbClient(async (client) => {
    await client.query('begin');
    try {
      const inserted = await client.query(
        `insert into transaction_chat_messages
           (id, firm_id, client_id, transaction_id, role, content, payload,
            model, model_version, actor_type, actor_id)
         values ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, $11)
         returning id, firm_id, client_id, transaction_id, role, content, payload,
                   model, model_version, actor_type, actor_id, created_at`,
        [
          id,
          firmId,
          clientId,
          transactionId,
          role,
          content,
          JSON.stringify(payload || {}),
          model,
          modelVersion,
          actorType,
          actorId
        ]
      );
      if (proposalAudit) {
        // actor is the model ('system') — the operator's prompt is its own
        // 'firm' message row; what this records is the machine-minted proposal.
        await client.query(
          `insert into audit_events (firm_id, client_id, actor_type, actor_id, action, resource_type, resource_id, metadata)
           values ($1, $2, 'system', 'system', $3, $4, $5, $6::jsonb)`,
          [
            firmId,
            clientId,
            proposalAudit.action,
            proposalAudit.resourceType,
            proposalAudit.resourceId,
            JSON.stringify(proposalAudit.metadata)
          ]
        );
      }
      if (commentAudit) {
        // Human speech, attributed: the comment's audit row carries the
        // typing principal, never 'system'.
        await client.query(
          `insert into audit_events (firm_id, client_id, actor_type, actor_id, action, resource_type, resource_id, metadata)
           values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)`,
          [
            firmId,
            clientId,
            actorType,
            commentAudit.actorId,
            commentAudit.action,
            commentAudit.resourceType,
            commentAudit.resourceId,
            JSON.stringify(commentAudit.metadata)
          ]
        );
      }
      await __insertMentionNotificationRows(client, notificationRows);
      await client.query('commit');
      return inserted;
    } catch (error) {
      await client.query('rollback');
      throw error;
    }
  });
  // A newer proposal supersedes older unapplied proposals of the same
  // one-winner type — without this, a corrected Categorise & post
  // leaves the earlier (wrong) one armed with a live Apply button
  // right above it (sighted: Metropolitan coworking, two contradictory
  // category + merchant-rule proposals on one thread). Soft-degrade:
  // armed-stale-actions is the pre-existing state, never worth failing
  // the reply over. The apply endpoint already 409s non-'proposed'
  // statuses, so a superseded action is refused server-side too.
  if (role === 'assistant') {
    try {
      await __supersedePriorChatProposals({ firmId, clientId, transactionId, newMessageId: id, actions: payload?.actions });
    } catch (error) {
      console.warn('[transaction-chat] supersede prior proposals failed', error?.message || error);
    }
  }
  return rowToTransactionChatMessagePayload(result.rows[0]);
};

// One-winner action types: a newer proposal of the same type replaces
// the older one's intent (a row gets ONE category, ONE merchant rule,
// ONE pending client question / personal flag / document link / match
// rejection / document-field correction). leave_review_note and
// future_action are additive and never superseded.
const SUPERSEDABLE_CHAT_ACTION_TYPES = new Set([
  'apply_category',
  'remember_merchant',
  'mark_personal',
  'ask_client',
  'link_document',
  'reject_match',
  'correct_document_field'
]);

export const __supersedePriorChatProposals = async ({ firmId, clientId, transactionId, newMessageId, actions }) => {
  const newTypes = [...new Set(
    (Array.isArray(actions) ? actions : [])
      .map((action) => action?.type)
      .filter((type) => SUPERSEDABLE_CHAT_ACTION_TYPES.has(type))
  )];
  if (!newTypes.length) return { superseded: 0 };
  const prior = await queryFirmDb(
    `select id, payload from transaction_chat_messages
      where firm_id = $1 and client_id = $2 and transaction_id = $3
        and role = 'assistant' and id <> $4
        and payload->'actions' is not null`,
    [firmId, clientId, transactionId, newMessageId]
  );
  const nowIso = new Date().toISOString();
  let superseded = 0;
  const supersededMessageIds = [];
  for (const row of prior.rows) {
    const priorActions = Array.isArray(row.payload?.actions) ? row.payload.actions : [];
    let changed = false;
    const nextActions = priorActions.map((action) => {
      const isOpenProposal = !action?.status || action.status === 'proposed';
      if (isOpenProposal && newTypes.includes(action?.type)) {
        changed = true;
        superseded += 1;
        return { ...action, status: 'superseded', superseded_at: nowIso, superseded_by_message_id: newMessageId };
      }
      return action;
    });
    if (changed) {
      supersededMessageIds.push(row.id);
      await queryFirmDb(
        `update transaction_chat_messages
            set payload = jsonb_set(payload, '{actions}', $5::jsonb, true)
          where firm_id = $1 and client_id = $2 and transaction_id = $3 and id = $4`,
        [firmId, clientId, transactionId, row.id, JSON.stringify(nextActions)]
      );
    }
  }
  if (superseded > 0) {
    // "Nothing silent": the supersede disarms prior Apply buttons — a real
    // mutation of persisted proposals, recorded here. Rides the caller's
    // existing soft-fail posture (the whole supersede is best-effort by
    // design — never worth failing the reply over), so this is
    // record-with-the-mutation, not audit-as-precondition.
    await queryFirmDb(
      `insert into audit_events (firm_id, client_id, actor_type, actor_id, action, resource_type, resource_id, metadata)
       values ($1, $2, 'system', 'system', 'chat.proposals_superseded', 'transaction_chat_message', $3, $4::jsonb)`,
      [
        firmId,
        clientId,
        newMessageId,
        JSON.stringify({
          transaction_id: transactionId,
          superseded_action_count: superseded,
          superseded_message_ids: supersededMessageIds,
          action_types: newTypes
        })
      ]
    );
  }
  return { superseded };
};

// ── Firm-level chat threads (migration 114) ────────────────────────────────
// The Inbox cross-venture mass-command chat. Own table because
// transaction_chat_messages.client_id carries a hard FK to clients — a
// firm-spanning thread cannot ride a sentinel client. `thread` is the
// sentinel key ('__firm_feed__' for the Inbox chat). Every helper mirrors
// its per-client sibling above, including the proposal-mint audit inside
// the insert transaction (audit-as-precondition) and the supersede that
// disarms stale Apply buttons — scoped per (type, client_id) here, since
// two ventures' proposals of the same type are independent decisions.

const rowToFirmChatMessagePayload = (row = {}) => ({
  id: row.id,
  firm_id: row.firm_id,
  thread: row.thread,
  role: row.role,
  content: row.content,
  payload: row.payload || {},
  model: row.model || null,
  model_version: row.model_version || null,
  actor_type: row.actor_type || 'firm',
  created_at: row.created_at ? new Date(row.created_at).toISOString() : null
});

// The firm chat's venture universe — the firm's clients in a DETERMINISTIC
// order (name, then id as tiebreak) with the true total counted, so
// truncation is stated as {shown, total, offset} rather than inferred
// (G0.2). `allowedClientIds` is assertFirmAccess's own scope verdict
// threaded through (G0.3): null = unrestricted firm member (no filter);
// an array = a scoped principal's assignment set, applied in SQL so the
// window AND the total are computed over the allowed universe only. Today
// the firm routes are requireMember-only, so this always receives null —
// the filter exists so the day a scoped principal is admitted to firm
// scope, retrieval cannot leak unassigned ventures (the latent hazard
// named in the plan's §5 G0 ground-truth audit). An EMPTY array means no
// assignments → no ventures (fail-closed), never "no filter".
export const listFirmChatVentureUniverseInDb = async ({
  firmId = DEFAULT_FIRM_ID,
  offset = 0,
  limit,
  allowedClientIds = null
} = {}) => {
  const filter = Array.isArray(allowedClientIds) ? allowedClientIds.map(String) : null;
  return withFirmDbClient(async (dbClient) => {
    const totalResult = await dbClient.query(
      `select count(*)::int as total from clients
        where firm_id = $1
          and ($2::text[] is null or id = any($2::text[]))`,
      [firmId, filter]
    );
    const result = await dbClient.query(
      `select id, company_name from clients
        where firm_id = $1
          and ($2::text[] is null or id = any($2::text[]))
        order by company_name asc, id asc
        offset $3 limit $4`,
      [firmId, filter, offset, limit]
    );
    return { total: totalResult.rows[0]?.total || 0, rows: result.rows };
  });
};

// Rolling-window count of USER messages on a firm chat thread — the firm
// route's rate-limit read (G0.3, the PARSE_RATE_LIMITED house pattern:
// DB-count-based so it survives restarts, per-firm because the desktop
// appliance is a single-operator surface). Only role='user' rows count:
// assistant/system rows are consequences, not requests.
export const countRecentFirmChatUserMessagesInDb = async ({
  firmId = DEFAULT_FIRM_ID,
  thread,
  windowInterval = '1 hour'
} = {}) => {
  if (!thread) return 0;
  const result = await queryFirmDb(
    `select count(*)::int as count from firm_chat_messages
      where firm_id = $1 and thread = $2 and role = 'user'
        and created_at > now() - $3::interval`,
    [firmId, thread, windowInterval]
  );
  return result.rows[0]?.count || 0;
};

export const getFirmChatThreadFromDb = async ({ firmId = DEFAULT_FIRM_ID, thread } = {}) => {
  if (!thread) {
    const error = new Error('thread is required.');
    error.statusCode = 400;
    throw error;
  }
  const result = await queryFirmDb(
    `select id, firm_id, thread, role, content, payload,
            model, model_version, actor_type, actor_id, created_at
       from firm_chat_messages
      where firm_id = $1 and thread = $2
      order by created_at asc
      limit 500`,
    [firmId, thread]
  );
  return result.rows.map(rowToFirmChatMessagePayload);
};

export const getFirmChatMessageFromDb = async ({ firmId = DEFAULT_FIRM_ID, thread, messageId } = {}) => {
  if (!thread || !messageId) return null;
  const result = await queryFirmDb(
    `select id, firm_id, thread, role, content, payload,
            model, model_version, actor_type, actor_id, created_at
       from firm_chat_messages
      where firm_id = $1 and thread = $2 and id = $3
      limit 1`,
    [firmId, thread, messageId]
  );
  if (!result.rows.length) return null;
  return rowToFirmChatMessagePayload(result.rows[0]);
};

export const updateFirmChatActionStatusInDb = async ({
  firmId = DEFAULT_FIRM_ID,
  thread,
  messageId,
  actionIndex,
  status,
  result = null
} = {}) => {
  if (!thread || !messageId) {
    const error = new Error('thread and message_id are required.');
    error.statusCode = 400;
    throw error;
  }
  if (!Number.isInteger(actionIndex) || actionIndex < 0) {
    const error = new Error('action_index must be a non-negative integer.');
    error.statusCode = 400;
    throw error;
  }
  if (!['applied', 'declined', 'failed'].includes(status)) {
    const error = new Error(`Invalid action status: ${status}`);
    error.statusCode = 400;
    throw error;
  }
  const message = await getFirmChatMessageFromDb({ firmId, thread, messageId });
  if (!message) {
    const error = new Error('Chat message not found.');
    error.statusCode = 404;
    throw error;
  }
  const actions = Array.isArray(message?.payload?.actions) ? message.payload.actions : [];
  const target = actions[actionIndex];
  if (!target) {
    const error = new Error(`Action index ${actionIndex} out of range (message has ${actions.length} actions).`);
    error.statusCode = 404;
    throw error;
  }
  const nowIso = new Date().toISOString();
  const patchedAction = {
    ...target,
    status,
    applied_at: status === 'applied' ? nowIso : (target.applied_at || null),
    result: result || target.result || null
  };
  const path = `{actions,${actionIndex}}`;
  const update = await queryFirmDb(
    `update firm_chat_messages
        set payload = jsonb_set(payload, $4::text[], $5::jsonb, true)
      where firm_id = $1 and thread = $2 and id = $3
      returning id, firm_id, thread, role, content, payload,
                model, model_version, actor_type, created_at`,
    [firmId, thread, messageId, path, JSON.stringify(patchedAction)]
  );
  if (!update.rows.length) {
    const error = new Error('Chat message not found.');
    error.statusCode = 404;
    throw error;
  }
  return rowToFirmChatMessagePayload(update.rows[0]);
};

export const appendFirmChatMessageInDb = async ({
  firmId = DEFAULT_FIRM_ID,
  thread,
  id,
  role,
  content,
  payload = {},
  model = null,
  modelVersion = null,
  actorType = 'firm'
} = {}) => {
  if (!thread) {
    const error = new Error('thread is required.');
    error.statusCode = 400;
    throw error;
  }
  if (!id) {
    const error = new Error('message id is required.');
    error.statusCode = 400;
    throw error;
  }
  if (!['user', 'assistant', 'system'].includes(role)) {
    const error = new Error(`Invalid role: ${role}`);
    error.statusCode = 400;
    throw error;
  }
  if (typeof content !== 'string' || !content.length) {
    const error = new Error('content is required.');
    error.statusCode = 400;
    throw error;
  }
  // Mint audit computed BEFORE the write so insert + record commit or roll
  // back together — same audit-as-precondition shape as the per-client
  // writer. client_id is null on the row: the mint is firm-scoped; each
  // ACTION carries its own client_id and the apply writes client-scoped
  // audit through the shared spine.
  const proposalAudit = __chatProposalAuditEvent({
    surface: 'firm_feed_chat',
    message: { id, role, payload, model, model_version: modelVersion },
    threadRef: { thread }
  });
  const result = await withFirmDbClient(async (client) => {
    await client.query('begin');
    try {
      const inserted = await client.query(
        `insert into firm_chat_messages
           (id, firm_id, thread, role, content, payload, model, model_version, actor_type)
         values ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9)
         returning id, firm_id, thread, role, content, payload,
                   model, model_version, actor_type, created_at`,
        [id, firmId, thread, role, content, JSON.stringify(payload || {}), model, modelVersion, actorType]
      );
      if (proposalAudit) {
        await client.query(
          `insert into audit_events (firm_id, client_id, actor_type, actor_id, action, resource_type, resource_id, metadata)
           values ($1, null, 'system', 'system', $2, $3, $4, $5::jsonb)`,
          [firmId, proposalAudit.action, proposalAudit.resourceType, proposalAudit.resourceId, JSON.stringify(proposalAudit.metadata)]
        );
      }
      await client.query('commit');
      return inserted;
    } catch (error) {
      await client.query('rollback');
      throw error;
    }
  });
  if (role === 'assistant') {
    try {
      await __supersedePriorFirmChatProposals({ firmId, thread, newMessageId: id, actions: payload?.actions });
    } catch (error) {
      console.warn('[firm-chat] supersede prior proposals failed', error?.message || error);
    }
  }
  return rowToFirmChatMessagePayload(result.rows[0]);
};

// Firm-thread supersede: same one-winner types as the per-client chat, but
// keyed (type, client_id) — a new Categorise & post for venture A must not
// disarm venture B's open proposal.
export const __supersedePriorFirmChatProposals = async ({ firmId, thread, newMessageId, actions }) => {
  const newKeys = new Set(
    (Array.isArray(actions) ? actions : [])
      .filter((action) => SUPERSEDABLE_CHAT_ACTION_TYPES.has(action?.type) && action?.client_id)
      .map((action) => `${action.type}::${action.client_id}`)
  );
  if (!newKeys.size) return { superseded: 0 };
  const prior = await queryFirmDb(
    `select id, payload from firm_chat_messages
      where firm_id = $1 and thread = $2
        and role = 'assistant' and id <> $3
        and payload->'actions' is not null`,
    [firmId, thread, newMessageId]
  );
  const nowIso = new Date().toISOString();
  let superseded = 0;
  const supersededMessageIds = [];
  for (const row of prior.rows) {
    const priorActions = Array.isArray(row.payload?.actions) ? row.payload.actions : [];
    let changed = false;
    const nextActions = priorActions.map((action) => {
      const isOpenProposal = !action?.status || action.status === 'proposed';
      if (isOpenProposal && newKeys.has(`${action?.type}::${action?.client_id}`)) {
        changed = true;
        superseded += 1;
        return { ...action, status: 'superseded', superseded_at: nowIso, superseded_by_message_id: newMessageId };
      }
      return action;
    });
    if (changed) {
      supersededMessageIds.push(row.id);
      await queryFirmDb(
        `update firm_chat_messages
            set payload = jsonb_set(payload, '{actions}', $4::jsonb, true)
          where firm_id = $1 and thread = $2 and id = $3`,
        [firmId, thread, row.id, JSON.stringify(nextActions)]
      );
    }
  }
  if (superseded > 0) {
    await queryFirmDb(
      `insert into audit_events (firm_id, client_id, actor_type, actor_id, action, resource_type, resource_id, metadata)
       values ($1, null, 'system', 'system', 'chat.proposals_superseded', 'firm_chat_message', $2, $3::jsonb)`,
      [
        firmId,
        newMessageId,
        JSON.stringify({
          thread,
          superseded_action_count: superseded,
          superseded_message_ids: supersededMessageIds,
          action_keys: [...newKeys]
        })
      ]
    );
  }
  return { superseded };
};

// ── Client-portal chat (owner ↔ Donna) ────────────────────────────────────
// The business owner's thread with Donna in the client portal — its OWN
// table (migration 056), one thread per (firm, client). Kept apart from
// the firm chat tables so the portal endpoint structurally cannot read a
// firm-side conversation, and so the owner's turns carry actor_type
// 'client' (actor attribution from day one — the pod-safety precondition,
// applied to the owner surface).

const rowToClientChatMessagePayload = (row = {}) => ({
  id: row.id,
  firm_id: row.firm_id,
  client_id: row.client_id,
  role: row.role,
  content: row.content,
  payload: row.payload || {},
  model: row.model || null,
  model_version: row.model_version || null,
  actor_type: row.actor_type || 'client',
  created_at: row.created_at ? new Date(row.created_at).toISOString() : null
});

export const getClientPortalChatThreadFromDb = async ({
  firmId = DEFAULT_FIRM_ID,
  clientId
} = {}) => {
  if (!clientId) {
    const error = new Error('client_id is required.');
    error.statusCode = 400;
    throw error;
  }
  // Audit L6 — the window must hold the NEWEST 500 turns. `asc limit 500`
  // returned the OLDEST 500, so past 500 messages the model (and the portal)
  // permanently saw only the beginning of the thread. Fetch newest-first,
  // then restore chronological order for rendering and the prompt.
  const result = await queryFirmDb(
    `select id, firm_id, client_id, role, content, payload,
            model, model_version, actor_type, created_at
       from client_chat_messages
      where firm_id = $1 and client_id = $2
      order by created_at desc, id desc
      limit 500`,
    [firmId, clientId]
  );
  return result.rows.reverse().map(rowToClientChatMessagePayload);
};

export const appendClientPortalChatMessageInDb = async ({
  firmId = DEFAULT_FIRM_ID,
  clientId,
  id,
  role,
  content,
  payload = {},
  model = null,
  modelVersion = null,
  actorType = 'client'
} = {}) => {
  if (!clientId) {
    const error = new Error('client_id is required.');
    error.statusCode = 400;
    throw error;
  }
  if (!id) {
    const error = new Error('message id is required.');
    error.statusCode = 400;
    throw error;
  }
  if (!['user', 'assistant', 'system'].includes(role)) {
    const error = new Error(`Invalid role: ${role}`);
    error.statusCode = 400;
    throw error;
  }
  if (typeof content !== 'string' || !content.length) {
    const error = new Error('content is required.');
    error.statusCode = 400;
    throw error;
  }
  const clientCheck = await queryFirmDb(
    'select 1 from clients where firm_id = $1 and id = $2 limit 1',
    [firmId, clientId]
  );
  if (!clientCheck.rows.length) {
    const error = new Error('Client not found for this firm.');
    error.statusCode = 404;
    throw error;
  }
  // An assistant turn carrying proposed actions is a proposal MINT and
  // must leave its audit row in the SAME transaction (audit-as-
  // precondition — the appendTransactionChatMessageInDb pattern). Plain
  // conversation stays un-audited (__chatProposalAuditEvent returns null).
  const proposalAudit = __chatProposalAuditEvent({
    surface: 'client_chat',
    message: { id, role, payload, model, model_version: modelVersion },
    threadRef: { client_id: clientId }
  });
  const result = await withFirmDbClient(async (client) => {
    await client.query('begin');
    try {
      const inserted = await client.query(
        `insert into client_chat_messages
           (id, firm_id, client_id, role, content, payload, model, model_version, actor_type)
         values ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9)
         returning id, firm_id, client_id, role, content, payload,
                   model, model_version, actor_type, created_at`,
        [id, firmId, clientId, role, content, JSON.stringify(payload || {}), model, modelVersion, actorType]
      );
      if (proposalAudit) {
        await client.query(
          `insert into audit_events (firm_id, client_id, actor_type, actor_id, action, resource_type, resource_id, metadata)
           values ($1, $2, 'system', 'system', $3, $4, $5, $6::jsonb)`,
          [
            firmId,
            clientId,
            proposalAudit.action,
            proposalAudit.resourceType,
            proposalAudit.resourceId,
            JSON.stringify(proposalAudit.metadata)
          ]
        );
      }
      await client.query('commit');
      return inserted;
    } catch (error) {
      await client.query('rollback');
      throw error;
    }
  });
  // A newer answer proposal supersedes older unapplied proposals for the
  // SAME evidence request — without this, a corrected answer leaves the
  // earlier (wrong) one armed with a live Confirm button above it.
  // Soft-degrade like the transaction-chat supersede: never worth failing
  // the reply over; the apply route 409s non-'proposed' statuses anyway.
  if (role === 'assistant') {
    try {
      await __supersedePriorClientChatProposals({ firmId, clientId, newMessageId: id, actions: payload?.actions });
    } catch (error) {
      console.warn('[client-chat] supersede prior proposals failed', error?.message || error);
    }
  }
  return rowToClientChatMessagePayload(result.rows[0]);
};

export const __supersedePriorClientChatProposals = async ({ firmId, clientId, newMessageId, actions }) => {
  const newRequestIds = [...new Set(
    (Array.isArray(actions) ? actions : [])
      .filter((action) => action?.type === 'answer_evidence_request')
      .map((action) => action?.evidence_request_id)
      .filter(Boolean)
  )];
  if (!newRequestIds.length) return { superseded: 0 };
  const prior = await queryFirmDb(
    `select id, payload from client_chat_messages
      where firm_id = $1 and client_id = $2
        and role = 'assistant' and id <> $3
        and payload->'actions' is not null`,
    [firmId, clientId, newMessageId]
  );
  const nowIso = new Date().toISOString();
  let superseded = 0;
  const supersededMessageIds = [];
  for (const row of prior.rows) {
    const priorActions = Array.isArray(row.payload?.actions) ? row.payload.actions : [];
    let changed = false;
    const nextActions = priorActions.map((action) => {
      const isOpenProposal = !action?.status || action.status === 'proposed';
      if (isOpenProposal && action?.type === 'answer_evidence_request'
        && newRequestIds.includes(action?.evidence_request_id)) {
        changed = true;
        superseded += 1;
        return { ...action, status: 'superseded', superseded_at: nowIso, superseded_by_message_id: newMessageId };
      }
      return action;
    });
    if (changed) {
      supersededMessageIds.push(row.id);
      await queryFirmDb(
        `update client_chat_messages
            set payload = jsonb_set(payload, '{actions}', $4::jsonb, true)
          where firm_id = $1 and client_id = $2 and id = $3`,
        [firmId, clientId, row.id, JSON.stringify(nextActions)]
      );
    }
  }
  if (superseded > 0) {
    // "Nothing silent": disarming prior Confirm buttons is a real
    // mutation of persisted proposals — recorded, best-effort like the
    // caller (the transaction-chat supersede's posture).
    await queryFirmDb(
      `insert into audit_events (firm_id, client_id, actor_type, actor_id, action, resource_type, resource_id, metadata)
       values ($1, $2, 'system', 'system', 'chat.proposals_superseded', 'client_chat_message', $3, $4::jsonb)`,
      [
        firmId,
        clientId,
        newMessageId,
        JSON.stringify({
          superseded_action_count: superseded,
          superseded_message_ids: supersededMessageIds,
          evidence_request_ids: newRequestIds
        })
      ]
    );
  }
  return { superseded };
};

export const getClientPortalChatMessageFromDb = async ({
  firmId = DEFAULT_FIRM_ID,
  clientId,
  messageId
} = {}) => {
  if (!clientId || !messageId) return null;
  const result = await queryFirmDb(
    `select id, firm_id, client_id, role, content, payload,
            model, model_version, actor_type, created_at
       from client_chat_messages
      where firm_id = $1 and client_id = $2 and id = $3
      limit 1`,
    [firmId, clientId, messageId]
  );
  if (!result.rows.length) return null;
  return rowToClientChatMessagePayload(result.rows[0]);
};

// The client-chat stamp writer — invoked ONLY through the spine's stamp
// injection (executeChatApplyAction), never directly from a route
// (chatApplySpine.test.js lints api.js for exactly that).
export const updateClientPortalChatActionStatusInDb = async ({
  firmId = DEFAULT_FIRM_ID,
  clientId,
  messageId,
  actionIndex,
  status,
  result = null
} = {}) => {
  if (!clientId || !messageId) {
    const error = new Error('client_id and message_id are required.');
    error.statusCode = 400;
    throw error;
  }
  if (!Number.isInteger(actionIndex) || actionIndex < 0) {
    const error = new Error('action_index must be a non-negative integer.');
    error.statusCode = 400;
    throw error;
  }
  if (!['applied', 'declined', 'failed'].includes(status)) {
    const error = new Error(`Invalid action status: ${status}`);
    error.statusCode = 400;
    throw error;
  }
  const message = await getClientPortalChatMessageFromDb({ firmId, clientId, messageId });
  if (!message) {
    const error = new Error('Chat message not found.');
    error.statusCode = 404;
    throw error;
  }
  const actions = Array.isArray(message?.payload?.actions) ? message.payload.actions : [];
  const target = actions[actionIndex];
  if (!target) {
    const error = new Error(`Action index ${actionIndex} out of range (message has ${actions.length} actions).`);
    error.statusCode = 404;
    throw error;
  }
  const nowIso = new Date().toISOString();
  const patchedAction = {
    ...target,
    status,
    applied_at: status === 'applied' ? nowIso : (target.applied_at || null),
    result: result || target.result || null
  };
  const path = `{actions,${actionIndex}}`;
  const update = await queryFirmDb(
    `update client_chat_messages
        set payload = jsonb_set(payload, $4::text[], $5::jsonb, true)
      where firm_id = $1 and client_id = $2 and id = $3
      returning id, firm_id, client_id, role, content, payload,
                model, model_version, actor_type, created_at`,
    [firmId, clientId, messageId, path, JSON.stringify(patchedAction)]
  );
  if (!update.rows.length) {
    const error = new Error('Chat message not found.');
    error.statusCode = 404;
    throw error;
  }
  return rowToClientChatMessagePayload(update.rows[0]);
};

// The owner chat's document universe: the client's recent documents,
// newest first, with persisted verdicts (parse status, payment status)
// riding rowToDocumentPayload. Bounded; the count lets the context flag
// truncation so the model says "partial view" instead of guessing.
export const getClientPortalChatDocsFromDb = async ({
  firmId = DEFAULT_FIRM_ID,
  clientId,
  limit = 60
} = {}) => {
  if (!clientId) {
    const error = new Error('client_id is required.');
    error.statusCode = 400;
    throw error;
  }
  const [rowsResult, countResult] = await Promise.all([
    queryFirmDb(
      `select * from documents
        where firm_id = $1 and client_id = $2
        order by uploaded_at desc nulls last, created_at desc
        limit $3`,
      [firmId, clientId, limit]
    ),
    queryFirmDb(
      'select count(*)::int as total from documents where firm_id = $1 and client_id = $2',
      [firmId, clientId]
    )
  ]);
  return {
    rows: rowsResult.rows.map(rowToDocumentPayload),
    totalCount: countResult.rows[0]?.total ?? rowsResult.rows.length
  };
};
