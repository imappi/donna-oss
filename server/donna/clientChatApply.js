import { resolveDesktopClientCreationPrincipal } from './db/authority.js';
// Donna — the OWNER chat apply (the client-chat consumer of the chat-apply
// spine), as ONE function with two doors.
//
// Before slice 3 of the hosted chat surface this body lived inline in the
// api.js route `POST /client-chat/messages/:messageId/actions/:index/apply`
// (docs/design-donna-client-portal-chat.md, Slice 2). The hosted MCP tool
// `confirm_action` (docs/design-donna-chatgpt-app-build-brief.md §3/§5
// slice 3, server/donna/mcp/mcpConfirmAction.js) is the SAME owner
// confirming the SAME persisted proposal from a different door, and the
// brief's rule is "never a second apply path". So the body moved here and
// both doors call it:
//
//   portal route  → assertFirmAccess + billing → applyClientChatAction({ surface: 'client_chat' })
//   confirm_action → the MCP funnel (auth, registry, consent) + billing
//                  → applyClientChatAction({ surface: <chatgpt_app | claude_remote> })
//
// What the function owns, unchanged from the route it replaced:
//   compile   — gateChatApplyAction over the PERSISTED message (never the
//               request body), the OWNER grammar as the allowlist
//               (CLIENT_PORTAL_CHAT_APPLIABLE_ACTION_TYPES), the owner
//               capability gate (assertClientChatActionCapability);
//   execute   — executeChatApplyAction around the SAME named writers an
//               upload reply uses (resolveClientEvidenceRequestInDb → the
//               tracked ask → recode path; recordOwnerMileageExpenseInDb),
//               with the tenancy re-check on the model-named ask id;
//   audit     — auditChatApplyEvent, `client_chat.*_applied`, INSIDE the
//               execute thunk, audit-as-precondition (bestEffort false:
//               the writer has committed, but without the receipt the action
//               is not stamped applied and the caller sees the error — the
//               G2 PR-12 posture the other route-level sites carry).
//               `metadata.surface` names the DOOR the owner confirmed
//               through, so the receipt answers "which door applied this
//               owner answer" without a join;
//   stamp     — the spine's stamp injection (updateClientPortalChatActionStatusInDb),
//               never invoked directly;
//   bridge    — the [CLIENT REPLY] system row into the firm's per-transaction
//               case file, best-effort (the answer is already persisted).
//
// The response bodies are the route's, byte-for-byte: a caller sends
// `{ statusCode, body }` as-is. The spine's `surface` stays 'client_chat' on
// every door (it names the GRAMMAR and the thread the message lives on; the
// spine keys on nothing else — CHAT_APPLY_SURFACES is the grammar
// vocabulary, not the door list); the door rides `metadata.surface`.
//
// chatApplySpine.test.js lints THIS file the way it lints api.js and
// feedChatApply.js: the gate, the executor, the stamp injection, no
// best-effort audit emission, zero raw audit inserts, zero inline applied
// stamps.

import {
  DEFAULT_FIRM_ID,
  appendTransactionChatMessageInDb,
  getClientEvidenceRequestForClientFromDb,
  getClientPortalChatMessageFromDb,
  queryFirmDb,
  resolveClientEvidenceRequestInDb,
  updateClientPortalChatActionStatusInDb
} from './firmDb.js';
import { recordOwnerMileageExpenseInDb } from './ownerMileageExpense.js';
import { newTransactionChatMessageId } from './transactionChat.js';
import {
  CLIENT_PORTAL_CHAT_APPLIABLE_ACTION_TYPES,
  assertClientChatActionCapability
} from './clientPortalChat.js';
import {
  auditChatApplyEvent,
  executeChatApplyAction,
  gateChatApplyAction
} from './chatApplySpine.js';

// The spine surface for the owner grammar — every door that applies a
// client-chat proposal names this to the gate (see the header).
export const CLIENT_CHAT_APPLY_SPINE_SURFACE = 'client_chat';

// The doors an owner confirms through, as `metadata.surface` on the apply
// audit records them. 'client_chat' is the portal (the pre-slice-3 value,
// unchanged); the hosted MCP surface ids are the chat hosts.
export const CLIENT_CHAT_APPLY_DOORS = Object.freeze(['client_chat', 'chatgpt_app', 'claude_remote']);

const applyDeps = (deps = {}) => ({
  getClientPortalChatMessageFromDb,
  getClientEvidenceRequestForClientFromDb,
  resolveClientEvidenceRequestInDb,
  recordOwnerMileageExpenseInDb,
  updateClientPortalChatActionStatusInDb,
  appendTransactionChatMessageInDb,
  assertClientChatActionCapability,
  queryFirmDb,
  warn: (...args) => console.warn(...args),
  ...deps
});

// ({ firmId, clientId, messageId, actionIndex, principal, surface, message?, deps })
//   → { disposition: 'refuse' | 'replay' | 'respond' | 'applied', statusCode, body, ...extras }
//
// `surface` is the DOOR (CLIENT_CHAT_APPLY_DOORS); an unknown door is
// refused rather than receipted under a made-up name. `message` may be the
// already-loaded persisted row (a caller that pre-checked it); otherwise it
// is read here, scoped to (firm, client) — a message on another entity's
// thread reads as not found, the same answer as a nonexistent id.
export const applyClientChatAction = async ({
  firmId = DEFAULT_FIRM_ID,
  clientId,
  messageId,
  actionIndex,
  principal = null,
  surface = CLIENT_CHAT_APPLY_SPINE_SURFACE,
  message,
  deps = {}
} = {}) => {
  const d = applyDeps(deps);
  const door = String(surface || '');
  if (!CLIENT_CHAT_APPLY_DOORS.includes(door)) {
    return {
      disposition: 'refuse',
      statusCode: 500,
      body: { error: `Unknown client-chat apply door '${door}'.` }
    };
  }
  const resolvedFirmId = firmId || DEFAULT_FIRM_ID;
  const persisted = message === undefined
    ? await d.getClientPortalChatMessageFromDb({ firmId: resolvedFirmId, clientId, messageId })
    : message;

  const gated = await gateChatApplyAction({
    surface: CLIENT_CHAT_APPLY_SPINE_SURFACE,
    firmId: resolvedFirmId,
    clientId,
    principal,
    message: persisted,
    actionIndex,
    appliableActionTypes: CLIENT_PORTAL_CHAT_APPLIABLE_ACTION_TYPES,
    assertCapability: d.assertClientChatActionCapability
  });
  if (gated.disposition === 'refuse') {
    return { disposition: 'refuse', statusCode: gated.statusCode, body: gated.body };
  }
  if (gated.disposition === 'replay') {
    return {
      disposition: 'replay',
      statusCode: 200,
      body: { applied: true, replay: true, action: gated.action, message: persisted },
      action: gated.action
    };
  }
  const action = gated.action;
  if (action.type === 'answer_evidence_request') {
    principal = await resolveDesktopClientCreationPrincipal({ firmId: resolvedFirmId, principal });
    if (principal?.authenticatedVia === 'desktop_access_token') gated.actorId = principal.principalId;
  }
  const auditApplied = ({ resourceType, resourceId }) => auditChatApplyEvent({
    query: d.queryFirmDb,
    firmId: resolvedFirmId,
    clientId,
    actorId: gated.actorId,
    // Who KIND of actor drove the apply: the business owner is a
    // client-scoped collaborator ('client'); a firm member confirming on the
    // owner's thread is 'firm'. Explicit so an owner-driven row can never
    // masquerade as a firm operator's (and vice versa).
    actorType: principal?.principalType === 'firm_collaborator' ? 'client' : 'firm',
    action: action.type === 'record_mileage' ? 'client_chat.record_mileage_applied' : 'client_chat.answer_evidence_request_applied',
    resourceType,
    resourceId,
    metadata: {
      // The DOOR the owner confirmed through (CLIENT_CHAT_APPLY_DOORS) —
      // 'client_chat' for the portal, the MCP surface id for a chat host.
      surface: door,
      message_id: messageId,
      action_index: actionIndex,
      has_reply_text: Boolean(action.reply_text),
      mileage: action.type === 'record_mileage' ? { miles: action.miles, purpose: action.purpose, date: action.date } : null
    },
    // Audit-as-precondition (G2 PR-12): a failed receipt propagates out of
    // the execute thunk — the spine maps it to the refusal, the action is
    // NOT stamped applied and stays re-appliable. Never a warn line.
    bestEffort: false
  });

  const outcome = await executeChatApplyAction({
    action,
    execute: async () => {
      if (action.type === 'record_mileage') {
        const mileage = await d.recordOwnerMileageExpenseInDb({
          firmId: resolvedFirmId,
          clientId,
          action,
          actorId: gated.actorId,
          sourceMessageId: messageId,
          model: persisted?.model || null
        });
        if (mileage.status !== 'booked') {
          return {
            respond: {
              statusCode: 409,
              body: { applied: false, action_type: action.type, status: mileage.status, reason: mileage.reason, computation: mileage.computation || null }
            }
          };
        }
        await auditApplied({ resourceType: 'ledger_journal', resourceId: mileage.ledger_journal_id });
        return { result: mileage, mileage };
      }
      // Tenancy re-check on the MODEL-NAMED id: the ask must belong to this
      // (firm, client) — the sanitizer enforced it at mint time, this
      // enforces it at apply time (defense in depth).
      const ask = await d.getClientEvidenceRequestForClientFromDb({
        firmId: resolvedFirmId,
        clientId,
        evidenceRequestId: action.evidence_request_id
      });
      if (!ask) {
        const error = new Error('Evidence request not found for this client.');
        error.statusCode = 404;
        throw error;
      }
      if (!['draft', 'open', 'replied'].includes(ask.status)) {
        return {
          respond: {
            statusCode: 409,
            body: {
              error: `This question is already ${ask.status}.`,
              action_type: action.type,
              evidence_request_status: ask.status
            }
          }
        };
      }
      const resolved = await d.resolveClientEvidenceRequestInDb({
        firmId: resolvedFirmId,
        replyAuthority: { principal, source: 'authenticated_client_chat' },
        evidenceRequestId: action.evidence_request_id,
        reply: action.reply_text,
        documentIds: [],
        actorId: gated.actorId
      });
      await auditApplied({ resourceType: 'client_evidence_request', resourceId: action.evidence_request_id });
      return {
        result: {
          evidence_request_id: action.evidence_request_id,
          evidence_request_status: resolved.evidence_request?.status || 'replied',
          recode: resolved.recode ? { applied: Boolean(resolved.recode.applied) } : null
        },
        resolved
      };
    },
    stamp: {
      write: d.updateClientPortalChatActionStatusInDb,
      scope: { firmId: resolvedFirmId, clientId, messageId, actionIndex }
    },
    fallbackErrorMessage: 'Could not file that answer.'
  });
  if (outcome.disposition === 'refuse' || outcome.disposition === 'respond') {
    return { disposition: outcome.disposition, statusCode: outcome.statusCode, body: outcome.body, action };
  }

  // Bridge the answer into the firm's per-transaction case-file thread,
  // exactly as the /evidence/requests/:id/resolve endpoint does — the firm
  // must see the client's words behind the [CLIENT REPLY] marker regardless
  // of which door the answer came through. Best-effort: the answer is
  // already persisted and receipted.
  const resolvedRequest = action.type === 'answer_evidence_request' ? outcome.executed?.resolved?.evidence_request || null : null;
  if (resolvedRequest?.transaction_id) {
    try {
      await d.appendTransactionChatMessageInDb({
        firmId: resolvedFirmId,
        clientId,
        transactionId: resolvedRequest.transaction_id,
        id: newTransactionChatMessageId({
          transactionId: resolvedRequest.transaction_id,
          kind: 'system'
        }),
        role: 'system',
        content: String(action.reply_text || '').trim(),
        payload: {
          kind: 'client_reply_received',
          evidence_request_id: resolvedRequest.id,
          document_ids: [],
          has_reply_text: true,
          via: door
        },
        actorType: 'system'
      });
    } catch (chatErr) {
      d.warn('[client-chat] failed to thread answer into transaction chat', chatErr?.message || chatErr);
    }
  }
  return {
    disposition: 'applied',
    statusCode: 200,
    body: {
      applied: true,
      action_type: action.type,
      result: outcome.executed.result,
      message: outcome.updatedMessage
    },
    action,
    result: outcome.executed.result,
    updatedMessage: outcome.updatedMessage
  };
};
