// Donna — the chat-apply SPINE (pod-safety #4, the compile → authorize half).
//
// THE PROBLEM THIS MODULE EXISTS TO PREVENT (CLAUDE.md GOAL §4): the three chat
// apply routes (feed / transaction / document chat) each re-implemented the same
// six-step prologue inline — load the persisted message, resolve the action by
// index, idempotent-replay on 'applied', 409 on any other non-proposed status,
// per-surface action-type allowlist, then (on two of the three) the pod-safety #3
// capability gate and the actor-attribution derivation. Divergence was not
// hypothetical: the feed-chat route SHIPPED WITHOUT the capability gate — exactly
// the drift class a per-route re-implementation invites. This module is the ONE
// home for that discipline: a route that dispatches a writer without passing
// through gateChatApplyAction is a bug (machine-checked by chatApplySpine.test.js,
// which lints api.js the way sqlWriterLint lints the SQL writers).
//
// Scope: the COMPILE → AUTHORIZE half of the #4 spine, plus the EMISSION leg of
// the AUDIT → EXECUTE half (auditChatApplyEvent below). Writer dispatch stays
// with the named writers (INV-1: the grammar routes onto the existing writers —
// accountingMutationRegistry.js is the verb→writer map, and a writer that owns
// its audit keeps owning it); what converged here is the ROUTE-level audit rows
// the three handlers used to insert by hand, with divergent column coverage
// (two of the three api.js emissions shipped actor-LESS — the same drift class
// the compile→authorize half closed for the capability gate).
//
// Pure leaf: no firmDb import (the capability check is INJECTED as a thunk —
// firmDb.assertActionCapability in production), so it loads in-sandbox under
// `node --test` like the other contract leaves. Refusal bodies reproduce the
// routes' existing responses byte-for-byte — adopting the spine is a wiring
// change, not a behaviour change (except feed-chat gaining the gate, which lands
// dormant: OPERATOR_CAPABILITY_ENFORCE only ACTS at canary/auto).

// The chat apply surfaces the spine serves (mirrors the registry's
// `surfaces` vocabulary). 'client_chat' is the OWNER-facing portal chat
// (Slice 2 of docs/design-donna-client-portal-chat.md) — the fourth
// consumer the convergence was built for, not a fifth path.
export const CHAT_APPLY_SURFACES = Object.freeze(['feed_chat', 'transaction_chat', 'document_chat', 'client_chat']);

// Pod-safety #1 — the ONE actor-attribution ladder (was copied inline in four
// places): the authenticated principal's identity, never a bare 'system' when a
// human drove the action.
export const chatApplyActorId = (principal) =>
  principal?.email || principal?.userId || principal?.principalId || 'system';

// COMPILE: persisted message + action index + the surface's explicit allowlist →
// one disposition. Pure. Reads the action from the PERSISTED assistant message,
// never the request body (anti-tamper — plan §6).
//   { disposition: 'refuse', statusCode, body }  — respond and stop (404/409/400);
//   { disposition: 'replay', action }            — already applied; idempotent 200;
//   { disposition: 'proceed', action }           — compiled, not yet authorized.
export const compileChatApplyAction = ({ message = null, actionIndex, appliableActionTypes = [] } = {}) => {
  if (!message) {
    return { disposition: 'refuse', statusCode: 404, body: { error: 'Chat message not found.' } };
  }
  const actions = Array.isArray(message?.payload?.actions) ? message.payload.actions : [];
  const action = actions[actionIndex];
  if (!action) {
    return { disposition: 'refuse', statusCode: 404, body: { error: `Action index ${actionIndex} out of range.` } };
  }
  if (action.status === 'applied') {
    return { disposition: 'replay', action };
  }
  if (action.status && action.status !== 'proposed') {
    return { disposition: 'refuse', statusCode: 409, body: { error: `Action is in status '${action.status}' and cannot be applied.` } };
  }
  if (!appliableActionTypes.includes(action.type)) {
    return {
      disposition: 'refuse',
      statusCode: 400,
      body: { error: `Apply not yet supported for action type '${action.type}'.`, action_type: action.type }
    };
  }
  return { disposition: 'proceed', action };
};

// COMPILE → AUTHORIZE: the full gate every chat apply route passes through before
// any writer runs. `assertCapability` is firmDb.assertActionCapability injected by
// the route (dormant by default; throws 403 only when OPERATOR_CAPABILITY_ENFORCE
// acts for the client — pod-safety #3). Fail-CLOSED on a missing injection: the
// spine refuses rather than silently skipping the authorize step.
// `specialistRoleId` (S4 routing seam) is the ACTING role the route resolved for
// this apply — forwarded verbatim into the converged role/authority decision;
// firmDb owns the law that a principal's own assignment always outranks it.
// On 'proceed' the result carries the compiled action + the attributed actorId —
// the two values every downstream writer call needs.
export const gateChatApplyAction = async ({
  surface,
  firmId,
  clientId,
  principal = null,
  message = null,
  actionIndex,
  appliableActionTypes = [],
  specialistRoleId = null,
  assertCapability = null
} = {}) => {
  const compiled = compileChatApplyAction({ message, actionIndex, appliableActionTypes });
  if (compiled.disposition !== 'proceed') return compiled;
  const actionType = compiled.action.type;
  if (typeof assertCapability !== 'function') {
    return {
      disposition: 'refuse',
      statusCode: 500,
      body: { error: 'Capability gate unavailable for this apply route.', action_type: actionType }
    };
  }
  try {
    // The compiled action rides along so the seat-authority half can resolve
    // the materiality amount from the action's TARGETS (transaction/document
    // ids) — the gate owns that one read, same discipline as the
    // assignment-role read. Injected gates that ignore it are unaffected.
    await assertCapability({ firmId, clientId, principal, actionType, specialistRoleId, action: compiled.action });
  } catch (capError) {
    return {
      disposition: 'refuse',
      statusCode: capError?.statusCode || 403,
      body: {
        error: capError?.message || 'Capability denied.',
        action_type: actionType,
        // Seat auto-routing (build spec §3.4): a routed refusal is never a
        // bare deny — the body names where the approval went so the UI can
        // render "route to <role>" and the item stays proposed for the
        // authorized queue.
        ...(capError?.routing ? { routing: capError.routing } : {})
      }
    };
  }
  return { disposition: 'proceed', surface, action: compiled.action, actorId: chatApplyActorId(principal) };
};

// EXECUTE (the #4 audit → execute half, writer-dispatch leg): the ONE dispatch
// discipline around every chat-apply writer call. The per-verb writer calls,
// argument validation, result shapes, and response bodies stay with the CALLER
// (INV-1 — the grammar routes onto the existing named writers; the FE and the
// shadow hooks consume the per-verb shapes verbatim). What converged here is
// the two steps every branch re-implemented with divergent coverage:
//   1. writer-error → HTTP mapping: `statusCode || 500`, `{ error: message ||
//      fallback, action_type }` — pre-spine, 4 of 12 branches also caught the
//      status-stamp's failure with this shape while 8 let it fall to the route
//      catch WITHOUT action_type (the same drift class the gate closed);
//   2. the applied-status stamp: the spine owns the `status: 'applied'` write
//      through the surface's INJECTED status writer (`stamp.write` +
//      `stamp.scope`), so a verb branch can no longer flip an action applied
//      without passing through the spine — machine-checked by
//      chatApplySpine.test.js (api.js may reference the status writers only as
//      the stamp injection, never invoke them).
// The `execute` thunk contract:
//   - return { result, ...extras }        → the spine stamps `applied` with
//     `result` (the per-verb persisted shape) and returns the extras to the
//     caller for its response body;
//   - return { respond: { statusCode, body } } → verb-owned non-applied
//     terminal (remember_merchant's unusable-pattern 200, retry_parse's
//     not-retryable 409, feed-chat's all-rows-failed 200): passed through
//     WITHOUT stamping, the action stays proposed;
//   - throw                               → mapped by (1). `exposeErrorDetails`
//     opts a site into surfacing the writer's `code`/`details` on the error
//     body (correct_document_field's pre-spine contract); default off so the
//     other verbs' error bodies stay byte-identical.
// Pure leaf like the gate: the status writer is injected, zero imports.
export const executeChatApplyAction = async ({
  action = null,
  execute,
  stamp = null,
  fallbackErrorMessage = 'Apply failed.',
  exposeErrorDetails = false
} = {}) => {
  const refusal = (error) => ({
    disposition: 'refuse',
    statusCode: error?.statusCode || 500,
    body: {
      error: error?.message || fallbackErrorMessage,
      action_type: action?.type,
      ...(exposeErrorDetails && error?.code ? { code: error.code } : {}),
      ...(exposeErrorDetails && error?.details ? { details: error.details } : {})
    }
  });
  // Fail-CLOSED on a missing injection, like the gate: a route that forgets
  // the writer thunk or the stamp writer is refused, never silently un-stamped.
  if (typeof execute !== 'function' || typeof stamp?.write !== 'function') {
    return {
      disposition: 'refuse',
      statusCode: 500,
      body: { error: 'Apply executor unavailable for this route.', action_type: action?.type }
    };
  }
  let executed;
  try {
    executed = await execute();
  } catch (writerError) {
    return refusal(writerError);
  }
  if (executed?.respond) {
    return {
      disposition: 'respond',
      statusCode: executed.respond.statusCode,
      body: executed.respond.body,
      executed
    };
  }
  let updatedMessage;
  try {
    updatedMessage = await stamp.write({
      ...(stamp.scope || {}),
      status: 'applied',
      result: executed?.result ?? null
    });
  } catch (stampError) {
    return refusal(stampError);
  }
  return { disposition: 'applied', updatedMessage, executed };
};

// AUDIT (the #4 audit → execute half, emission leg): the ONE emitter for every
// ROUTE-level audit row a chat apply writes. The verb-specific action name,
// resource type/id, and metadata shape belong to the CALLER — downstream
// consumers read them, so the spine never renames or reshapes. What the spine
// owns is the row's DISCIPLINE: firm/client scope, actor attribution on every
// row (pod-safety #1 — an actor-less emission can no longer ship by omitting a
// column), and an EXPLICIT per-site failure mode:
//   bestEffort: true  — the mutation stands if the audit insert fails; logged,
//                       never silent (today's receipts-not-gates posture);
//   bestEffort: false — audit-as-precondition (no record, no execution): the
//                       failure propagates into the caller's own error handling.
//                       The CLAUDE.md end-state; flipping a site is a
//                       one-argument change.
// Pure leaf: the query function is INJECTED (queryFirmDb at the api.js sites,
// the deps-injected d.queryFirmDb in feedChatApply.js) so this module keeps
// loading in-sandbox under `node --test` with zero imports.
export const auditChatApplyEvent = async ({
  query,
  firmId,
  clientId = null,
  actorId = 'system',
  // Who KIND of actor drove the apply: 'firm' for the three operator
  // surfaces (the pre-existing hardcoded value), 'client' when the
  // business owner applies on the portal chat surface. Explicit so an
  // owner-driven row can never masquerade as a firm operator's.
  actorType = 'firm',
  action,
  resourceType = null,
  resourceId = null,
  metadata = {},
  bestEffort = true,
  warn = (...args) => console.warn(...args)
} = {}) => {
  try {
    if (typeof query !== 'function') {
      throw new Error('auditChatApplyEvent requires an injected query function.');
    }
    if (!firmId || !action) {
      throw new Error('auditChatApplyEvent requires firmId and action.');
    }
    await query(
      `insert into audit_events (firm_id, client_id, actor_type, actor_id, action, resource_type, resource_id, metadata)
       values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)`,
      [
        firmId,
        clientId || null,
        actorType || 'firm',
        actorId || 'system',
        action,
        resourceType || null,
        resourceId == null ? null : String(resourceId),
        JSON.stringify(metadata || {})
      ]
    );
    return true;
  } catch (err) {
    if (!bestEffort) throw err;
    warn(`[chatApplySpine] audit emission failed (best-effort) for '${action || 'unknown'}'`, err?.message || err);
    return false;
  }
};
