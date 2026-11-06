// Donna MCP act tier — the confirm_action executor
// (docs/design-donna-chatgpt-app-build-brief.md §3/§5 slice 3).
//
// The owner, inside ChatGPT or Claude, CONFIRMS one action Donna proposed
// in an earlier ask_donna reply. The chat host relays that confirmation
// through the funnel (mcpApi.js — auth, registry, argument shape, consent,
// receipt); THIS module runs the SAME owner apply the portal's Confirm card
// runs, through the ONE shared function both doors call
// (clientChatApply.js → chatApplySpine: compile from the PERSISTED message,
// authorize against the owner grammar, execute through the tracked ask →
// recode writer / the mileage journal writer, audit-as-precondition, stamp).
//
// Two-call shape, always: ask_donna proposes (requires_confirmation: true),
// confirm_action applies. This tool is never an implicit side effect of a
// chat turn, and it never calls a writer itself — it reaches the spine and
// nothing else (mcpConfirmAction.test.js pins the import list: no resolver,
// no ledger writer, no direct status writer; only clientChatApply.js).
// K-mcp-1 (no path from a chat surface to an UNSTAGED mutation) holds: the
// only mutation reachable is the spine-gated owner apply, and the spine
// gates it exactly as it gates the portal.
//
// What this module adds on top of the shared apply, before the spine:
//   - the tool's own closed enum: the persisted action's type must be one
//     of the OWNER-appliable types (CLIENT_PORTAL_CHAT_APPLIABLE_ACTION_TYPES
//     — answer_evidence_request, record_mileage). recategorize, post,
//     request_report, share_portal_link and every firm verb are refused HERE
//     with a coded error; the spine's own allowlist is the second gate;
//   - tenancy: the message is read scoped to (firm, entity) — a message on
//     another entity's thread, another owner's thread, or a nonexistent id
//     all read as the SAME not-found (no existence leak); the funnel has
//     already held the principal to the entity (assertFirmAccess) and the
//     entity to its consent row;
//   - the billing backstop the portal route runs (assertClientEntitled);
//   - honest rendering: a refusal is a coded error (the adapter turns it
//     into an isError tool result naming the code); a verb-owned
//     non-applied terminal (`respond` — the question is already resolved,
//     the mileage needs clarification) is a RESULT with applied: false and
//     the reason, never dressed as success; a replay of an already-applied
//     action returns the recorded result with replay: true.

import { DEFAULT_FIRM_ID, getClientPortalChatMessageFromDb } from '../firmDb.js';
import { assertClientEntitled } from '../clientSubscriptionDb.js';
import { isBillingEnabled } from '../stripeBilling.js';
import { CLIENT_PORTAL_CHAT_APPLIABLE_ACTION_TYPES } from '../clientPortalChat.js';
import { applyClientChatAction } from '../clientChatApply.js';
import { MCP_CONFIRM_ACTION_TOOL_NAME } from './mcpReadSurface.js';

// The closed enum this tool may hand to the spine — the portal's owner grammar,
// imported, never a copy. Pinned by test to be exactly the portal's set.
export const MCP_CONFIRM_ACTION_TYPES = CLIENT_PORTAL_CHAT_APPLIABLE_ACTION_TYPES;

// The refusal codes this tool names. A refused confirmation is a tool
// OUTCOME the calling model should read and relay (isError: true on the
// adapter), never a transport failure.
export const MCP_CONFIRM_ACTION_CODES = Object.freeze({
  // The message, the action index, or the ask row the action names — the
  // same answer for "not yours", "not this entity's" and "does not exist".
  target_not_found: 'CONFIRM_TARGET_NOT_FOUND',
  // The persisted action's type is outside the owner-appliable grammar.
  type_not_confirmable: 'ACTION_TYPE_NOT_CONFIRMABLE',
  // The action is no longer proposed (declined/failed) — nothing to confirm.
  not_proposed: 'ACTION_NOT_PROPOSED',
  // The owner capability gate refused the verb. (The funnel renders every
  // 403 on this surface as ACCESS_DENIED — a denial reads the same on every
  // door; the code here is the executor's own name for it.)
  not_permitted: 'ACTION_NOT_PERMITTED',
  // The writer or the audit refused; the action stays proposed.
  apply_failed: 'CONFIRM_APPLY_FAILED'
});

const confirmError = (statusCode, code, message) => Object.assign(new Error(message), { statusCode, code });

const codeForRefusal = (statusCode) => {
  switch (statusCode) {
    case 404: return MCP_CONFIRM_ACTION_CODES.target_not_found;
    case 400: return MCP_CONFIRM_ACTION_CODES.type_not_confirmable;
    case 409: return MCP_CONFIRM_ACTION_CODES.not_proposed;
    case 403: return MCP_CONFIRM_ACTION_CODES.not_permitted;
    default: return MCP_CONFIRM_ACTION_CODES.apply_failed;
  }
};

const executorDeps = (deps = {}) => ({
  getClientPortalChatMessageFromDb,
  applyClientChatAction,
  assertClientEntitled,
  isBillingEnabled,
  ...deps
});

// ({ firmId, auth, access, entities, args, surface, deps }) → result.
// `entities` is the already-resolved exposed set and `args.entity_id` is a
// member (the funnel enforces both before dispatch); `access` is the
// assertFirmAccess result (its principal is the attributed actor and the
// billing gate's subject); `surface` is the MCP surface the call came
// through — the DOOR the apply audit records.
export const runConfirmAction = async ({
  firmId = DEFAULT_FIRM_ID,
  access = null,
  entities = [],
  args = {},
  surface = null,
  deps = {}
} = {}) => {
  const d = executorDeps(deps);
  const entity = entities.find((e) => e.id === args.entity_id);
  if (!entity) throw confirmError(404, 'ENTITY_NOT_FOUND', `No exposed entity '${String(args.entity_id || '')}'.`);
  const clientId = entity.id;
  const messageId = String(args.message_id || '').trim();
  const actionIndex = args.action_index;
  if (!messageId) throw confirmError(400, 'INVALID_ARGUMENTS', 'message_id must be a non-empty string.');
  if (!Number.isInteger(actionIndex) || actionIndex < 0) {
    throw confirmError(400, 'INVALID_ARGUMENTS', 'action_index must be a non-negative integer.');
  }
  const surfaceId = surface?.id || null;
  if (!surfaceId) throw confirmError(500, 'MCP_SURFACE_UNKNOWN', 'confirm_action was dispatched without a surface.');

  // Same billing backstop as the portal's apply route.
  const principal = access?.principal || null;
  await d.assertClientEntitled({ firmId, clientId, principal, billingEnabled: d.isBillingEnabled() });

  // Tenancy + the tool's own closed enum, BEFORE the spine. The read is
  // scoped to (firm, entity): a message that is not on this entity's thread
  // is simply not found. The action's TYPE is read from the persisted row
  // (never the request) and must be owner-appliable; anything else never
  // reaches the spine.
  const message = await d.getClientPortalChatMessageFromDb({ firmId, clientId, messageId });
  if (!message) {
    throw confirmError(404, MCP_CONFIRM_ACTION_CODES.target_not_found, 'No such proposal on this business’s Donna thread.');
  }
  const actions = Array.isArray(message?.payload?.actions) ? message.payload.actions : [];
  const persistedAction = actions[actionIndex];
  if (!persistedAction) {
    throw confirmError(404, MCP_CONFIRM_ACTION_CODES.target_not_found, 'No such proposal on this business’s Donna thread.');
  }
  if (!MCP_CONFIRM_ACTION_TYPES.includes(persistedAction.type)) {
    throw confirmError(
      400, MCP_CONFIRM_ACTION_CODES.type_not_confirmable,
      `Action type '${String(persistedAction.type || '')}' cannot be confirmed from a chat surface; only an answer to one of Donna’s open questions or a mileage entry can.`
    );
  }

  // The ONE apply path — the portal's, with this surface named as the door.
  const outcome = await d.applyClientChatAction({
    firmId,
    clientId,
    messageId,
    actionIndex,
    principal,
    surface: surfaceId,
    message
  });

  const base = {
    entity: { id: entity.id, name: entity.name },
    message_id: messageId,
    action_index: actionIndex,
    action_type: persistedAction.type,
    surface: surfaceId
  };

  if (outcome.disposition === 'refuse') {
    const statusCode = Number.isInteger(outcome.statusCode) ? outcome.statusCode : 500;
    throw confirmError(statusCode, codeForRefusal(statusCode), outcome.body?.error || 'Donna refused to apply that action.');
  }
  if (outcome.disposition === 'replay') {
    // Already applied (an earlier confirm, here or in the portal): the
    // recorded result, idempotently, never a second write.
    return {
      ...base,
      applied: true,
      replay: true,
      result: outcome.action?.result ?? null,
      applied_at: outcome.action?.applied_at ?? null
    };
  }
  if (outcome.disposition === 'respond') {
    // A verb-owned non-applied terminal: the action stays proposed and the
    // body says why (the question is already resolved; the mileage entry
    // needs clarification). Honest: applied false, the reason, no error.
    const body = outcome.body || {};
    return {
      ...base,
      applied: false,
      outcome: 'not_applied',
      reason: body.error || body.reason || null,
      ...(body.status ? { status: body.status } : {}),
      ...(body.evidence_request_status ? { evidence_request_status: body.evidence_request_status } : {}),
      ...(body.computation ? { computation: body.computation } : {})
    };
  }
  // applied — the route's consequence, as the route returns it.
  const result = outcome.result || {};
  return {
    ...base,
    applied: true,
    result,
    ...(result.evidence_request_status ? { evidence_request_status: result.evidence_request_status } : {}),
    ...(result.recode ? { recode: result.recode } : {})
  };
};

export const MCP_ACT_TOOL_EXECUTORS = Object.freeze({
  [MCP_CONFIRM_ACTION_TOOL_NAME]: runConfirmAction
});
