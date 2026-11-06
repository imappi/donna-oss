// Donna MCP converse tier — the ask_donna executor
// (docs/design-donna-chatgpt-app-build-brief.md §3/§5 slice 2).
//
// The owner, inside ChatGPT or Claude, talks to Donna. The chat host relays
// the owner's words through the funnel (mcpApi.js — auth, registry, argument
// shape, consent, receipt); THIS module runs the SAME owner-chat turn the
// portal's POST /client-chat/messages runs:
//
//   persist the owner's message  (persistClientPortalTurnMessage — the ONE
//                                 writer the portal thread has)
//   → assembleClientPortalTurn   (the ONE context builder: compressed,
//                                 entity-scoped, persisted-verdict-only)
//   → generateClientPortalChatReply (Donna's own engine, Donna's own model;
//                                 the sanitizer inside it drops non-grammar
//                                 types and ask ids not in this turn's context)
//   → the report narration path, when the engine asked for a report (a
//                                 read-only server-run report, as the portal)
//   → persist Donna's reply       (proposal mint audited inside the writer)
//   → the observational sidecars  (intent-compiler / memory-retrieval
//                                 shadows; flag-gated, no-throw)
//
// No second chat engine, no second context builder, no second writer. The
// external model is a WINDOW: it sees Donna's text and Donna's PROPOSED
// actions, never Donna's context or prompt, and it can apply nothing —
// this module imports no apply spine, no resolver, no ledger writer
// (mcpAskDonna.test.js pins the import list).
//
// The portal deep link (slice 4, the share_portal_link re-look — brief §3):
// inside ChatGPT or Claude the owner has NO portal open, so the deep link to
// "What I still need from you" is exactly the door they need for uploads.
// The NARROW version ships: when the flag-gated self-knowledge pack arms it
// for this client (SELF_KNOWLEDGE_CONTEXT + OWNER_PORTAL_LINK acting, on the
// external_chat surface), the engine may propose share_portal_link, the
// runtime resolves the REAL link deterministically (selfKnowledge.js —
// never model-typed; an unset base URL degrades to a named instruction),
// appends it to Donna's reply text, and receipts the share
// (owner_portal_link.shared, channel = this surface). No new tool, no send,
// nothing applied: the link is plain text in the reply, exactly as the
// owner channels render it. Off by default like every flag-gated entry. A proposed action reaches the
// books only when the OWNER confirms it: on the Confirm card the portal
// renders from the very row this module persisted, or through the SEPARATE
// confirm_action tool (mcpConfirmAction.js, slice 3) naming this row's
// message_id and the action's index — two calls, never one. K-mcp-1 (no
// path from a chat surface to an unstaged mutation) holds by construction.

import { DEFAULT_FIRM_ID, withFirmDbClient } from '../firmDb.js';
import { getFinancialReportFromDb } from '../db/close.js';
import { assertClientEntitled } from '../clientSubscriptionDb.js';
import { isBillingEnabled } from '../stripeBilling.js';
import { assembleClientPortalTurn, persistClientPortalTurnMessage } from '../clientPortalTurn.js';
import {
  CLIENT_PORTAL_CHAT_APPLIABLE_ACTION_TYPES,
  findClientPortalReportRequest,
  generateClientPortalChatReply,
  generateClientPortalReportNarration,
  newClientPortalChatMessageId
} from '../clientPortalChat.js';
import { ownerActorAttribution } from '../ownerActorAttribution.js';
import { controlledMemoryUnavailableText } from '../ownerMemorySeam.js';
import { composePortalLinkReply, recordOwnerPortalLinkShare, resolveOwnerPortalLink } from '../selfKnowledge.js';
import { onOwnerMessagePersisted } from '../intentCompilerShadow.js';
import { onOwnerTurnMemoryShadow } from '../memoryRetrievalShadow.js';
import { MCP_ASK_DONNA_TOOL_NAME } from './mcpReadSurface.js';

// The surface this tool speaks on, for BOTH the engine (clientPortalChat.js
// appends the external-chat block to the system prompt for it: the doors the
// portal prompt names — the confirm card below, the upload box, "the list
// above" — do not exist inside a chat host, and Donna must name the ones
// that do) and the self-knowledge pack (selfKnowledge.js renders the third
// surface: confirm here or in the portal; upload in the portal; the portal
// deep link when OWNER_PORTAL_LINK acts).
export const MCP_ASK_DONNA_ENGINE_SURFACE = 'external_chat';

// Where the owner confirms a proposal minted through this tool, as the tool
// result states it: right here, through the separate confirm_action tool
// (the two-call shape — this tool proposes, that one applies), and still on
// the Confirm card in the portal's Ask Donna thread. Both doors run the
// same apply (clientChatApply.js); the audit names the door.
export const MCP_ASK_DONNA_CONFIRM_VIA = Object.freeze({
  tool: 'confirm_action',
  tool_arguments: 'entity_id, message_id (this reply’s message_id), action_index (the action’s index)',
  also: 'the Confirm card on the Ask Donna thread in the owner’s Donna portal',
  note: 'Proposed actions are not applied by ask_donna. The owner can confirm one right here, in this chat, by clearly saying so (then call confirm_action with this message_id and the action’s index), or on the Confirm card in their Donna portal. Nothing is recorded until they do.'
});

const chatError = (statusCode, code, message) => Object.assign(new Error(message), { statusCode, code });

// One line per proposal, in plain words, for the chat host to show beside
// Donna's text. Only the owner-appliable grammar is surfaced (request_report
// was already run and narrated server-side; share_portal_link never survives
// the sanitizer on this surface); `index` is the position on the persisted
// row, which is what the portal's apply route and confirm_action address.
const summarizeAction = (action = {}) => {
  switch (action.type) {
    case 'answer_evidence_request':
      return `Answer Donna’s open question ${action.evidence_request_id} with: “${String(action.reply_text || '').trim()}”`;
    case 'record_mileage':
      return `Record ${Number(action.miles)} business miles${action.date ? ` on ${action.date}` : ''}${action.purpose ? ` for ${String(action.purpose).trim()}` : ''}, computed at the current mileage rate`;
    default:
      return `Proposed ${String(action.type || 'action')}`;
  }
};

export const projectProposedActions = (actions = []) =>
  (Array.isArray(actions) ? actions : [])
    .map((action, index) => ({ action, index }))
    .filter(({ action }) => action && CLIENT_PORTAL_CHAT_APPLIABLE_ACTION_TYPES.includes(action.type))
    .map(({ action, index }) => ({
      index,
      type: action.type,
      summary: summarizeAction(action),
      ...(action.type === 'answer_evidence_request' ? { evidence_request_id: action.evidence_request_id } : {}),
      requires_confirmation: true
    }));

const executorDeps = (deps = {}) => ({
  assembleClientPortalTurn,
  persistClientPortalTurnMessage,
  generateClientPortalChatReply,
  generateClientPortalReportNarration,
  getFinancialReportFromDb,
  assertClientEntitled,
  isBillingEnabled,
  onOwnerMessagePersisted,
  onOwnerTurnMemoryShadow,
  withFirmDbClient,
  resolveOwnerPortalLink,
  recordOwnerPortalLinkShare: (args) => withFirmDbClient((dbClient) => recordOwnerPortalLinkShare(dbClient, args)),
  env: process.env,
  now: () => new Date(),
  warn: (...args) => console.warn(...args),
  ...deps
});

// ({ firmId, auth, access, entities, args, surface, deps }) → result.
// `entities` is the already-resolved exposed set and `args.entity_id` is a
// member (the funnel enforces both before dispatch); `access` is the
// assertFirmAccess result (principal for attribution and the billing gate);
// `surface` is the MCP surface the call came through (stamped on the rows
// and named to the sidecars as the channel).
export const runAskDonna = async ({
  firmId = DEFAULT_FIRM_ID,
  auth,
  access = null,
  entities = [],
  args = {},
  surface = null,
  deps = {}
} = {}) => {
  const d = executorDeps(deps);
  const entity = entities.find((e) => e.id === args.entity_id);
  if (!entity) throw chatError(404, 'ENTITY_NOT_FOUND', `No exposed entity '${String(args.entity_id || '')}'.`);
  const clientId = entity.id;
  const userMessage = String(args.message || '').trim();
  if (!userMessage) throw chatError(400, 'INVALID_ARGUMENTS', 'message must be a non-empty string.');
  const surfaceId = surface?.id || 'unknown_surface';

  // Same billing backstop as the portal's POST (a client-scoped owner on an
  // inactive plan gets a 402; a firm member is exempt; no-op until billing
  // is enabled).
  const principal = access?.principal || null;
  await d.assertClientEntitled({ firmId, clientId, principal, billingEnabled: d.isBillingEnabled() });

  // Actor attribution from day one, exactly as the portal stamps it: the
  // owner is a client-scoped collaborator ('client'); anyone else speaking
  // into the owner's thread is 'firm'. The MCP surface rides the payload so
  // the thread shows which door the turn came through.
  const actorType = principal?.principalType === 'firm_collaborator' ? 'client' : 'firm';
  const actorId = ownerActorAttribution({ principal, auth }).actor_id;
  const rowPayloadBase = { actor_id: actorId, surface: surfaceId, channel: surfaceId };

  const userMessageRow = await d.persistClientPortalTurnMessage({
    firmId,
    clientId,
    id: newClientPortalChatMessageId({ clientId, kind: 'user' }),
    role: 'user',
    content: userMessage,
    payload: rowPayloadBase,
    actorType
  });

  const assembled = await d.assembleClientPortalTurn({
    firmId,
    clientId,
    userMessageRow,
    ownerPrincipal: principal,
    now: d.now(),
    // The self-knowledge pack renders the external-chat surface (slice 4):
    // the doors that exist here, and the portal deep link when armed.
    surface: MCP_ASK_DONNA_ENGINE_SURFACE,
    channel: surfaceId
  });
  const {
    context,
    history,
    validAskIds,
    assistantName,
    ownerMemory,
    memoryRetrievalSnapshot,
    selfKnowledge,
    knowledgeGrounding,
    firmFacts,
    effectiveFirmId
  } = assembled;

  const resultBase = {
    entity: { id: entity.id, name: entity.name },
    user_message_id: userMessageRow.id,
    surface: surfaceId,
    applied: false,
    confirm_via: MCP_ASK_DONNA_CONFIRM_VIA
  };

  // A `blocked` memory status ⇒ the controlled memory-unavailable reply,
  // WITHOUT calling the model (the portal's §D short-circuit, unchanged).
  if (ownerMemory?.shortCircuit) {
    const controlled = await d.persistClientPortalTurnMessage({
      firmId,
      clientId,
      id: newClientPortalChatMessageId({ clientId, kind: 'assistant' }),
      role: 'assistant',
      content: controlledMemoryUnavailableText(),
      payload: { ...rowPayloadBase, actions: [], memory_status: 'blocked' },
      actorType: 'system'
    });
    return {
      ...resultBase,
      message_id: controlled.id,
      text: controlled.content,
      actions: [],
      model_id: null,
      memory_status: 'blocked'
    };
  }

  const promptContext = ownerMemory?.promptContext || context;
  const reply = await d.generateClientPortalChatReply({
    context: promptContext,
    history: ownerMemory?.promptHistory || history.slice(0, -1),
    userMessage,
    // The anti-self-licensing gate: a proposed answer may target ONLY an ask
    // that was actually in this turn's context (sanitizer-enforced).
    validAskIds,
    assistantName,
    memoryExtra: [ownerMemory?.systemPromptExtra, selfKnowledge?.systemPromptExtra, knowledgeGrounding?.answer?.grounding_block]
      .filter(Boolean).join('\n\n') || null,
    // share_portal_link is armed ONLY by the pack's verdict for this client
    // (SELF_KNOWLEDGE_CONTEXT + OWNER_PORTAL_LINK acting); default false
    // keeps the sanitizer dropping it, as before slice 4.
    allowPortalLink: selfKnowledge?.portal_link_enabled === true,
    surface: MCP_ASK_DONNA_ENGINE_SURFACE
  });

  if (reply.kind !== 'ok') {
    // Same honesty as the portal: the failure is persisted as a system row
    // (with the model-id diagnostic) so the thread never shows an orphan
    // owner message, and the caller gets a refusal, never a made-up answer.
    const diagnostic = reply.diagnostic || null;
    const failureContent = diagnostic
      ? `Chat unavailable: ${reply.reason || reply.code || 'unknown'} (model=${diagnostic.model || 'unknown'}, stop_reason=${diagnostic.stop_reason || 'unknown'}).`
      : `Chat unavailable: ${reply.reason || reply.code || 'unknown'}.`;
    await d.persistClientPortalTurnMessage({
      firmId,
      clientId,
      id: newClientPortalChatMessageId({ clientId, kind: 'system' }),
      role: 'system',
      content: failureContent,
      payload: { ...rowPayloadBase, failure_code: reply.code || 'unknown', ...(diagnostic ? { diagnostic } : {}) },
      actorType: 'system'
    });
    throw chatError(502, 'DONNA_CHAT_UNAVAILABLE', `Donna could not answer right now (${reply.code || 'unknown'}). The owner’s message is saved on their thread; ask again in a moment.`);
  }

  // A request_report proposal is a READ the server runs now and Donna
  // narrates — the same deterministic report path as the portal, never a
  // model-typed total.
  const reportRequest = findClientPortalReportRequest(reply, { today: promptContext?.today });
  let finalReply = reply;
  let reportResult = null;
  if (reportRequest) {
    try {
      reportResult = await d.getFinancialReportFromDb({
        firmId,
        clientId,
        periodStart: reportRequest.period_start,
        periodEnd: reportRequest.period_end,
        basis: reportRequest.basis
      });
    } catch (error) {
      d.warn('[mcp-ask-donna] report read failed', error?.message || error);
      await d.persistClientPortalTurnMessage({
        firmId,
        clientId,
        id: newClientPortalChatMessageId({ clientId, kind: 'system' }),
        role: 'system',
        content: 'Report unavailable: couldn\'t run that report.',
        payload: { ...rowPayloadBase, failure_code: 'report_read_failed', report_request: reportRequest },
        actorType: 'system'
      });
      throw chatError(502, 'DONNA_REPORT_UNAVAILABLE', 'Donna could not run that report right now. The owner’s message is saved on their thread.');
    }
    const narration = await d.generateClientPortalReportNarration({
      context: promptContext,
      report: reportResult,
      request: reportRequest,
      userMessage,
      assistantName
    });
    if (narration.kind !== 'ok') {
      await d.persistClientPortalTurnMessage({
        firmId,
        clientId,
        id: newClientPortalChatMessageId({ clientId, kind: 'system' }),
        role: 'system',
        content: `Report unavailable: ${narration.reason || narration.code || 'unknown'}.`,
        payload: { ...rowPayloadBase, failure_code: narration.code || 'report_narration_failed', report_request: reportRequest },
        actorType: 'system'
      });
      throw chatError(502, 'DONNA_REPORT_UNAVAILABLE', `Donna could not narrate that report right now (${narration.code || 'unknown'}).`);
    }
    finalReply = narration;
  }

  // The portal deep link (narrow version, see header). Defence in depth
  // beyond the sanitizer: the runtime re-checks the pack's verdict, never
  // the model's emission. The link is resolved deterministically and the
  // share is receipted; a failed receipt is named on the row, not hidden.
  let portalLink = null;
  const portalLinkAction = (Array.isArray(finalReply.actions) ? finalReply.actions : [])
    .find((candidate) => candidate?.type === 'share_portal_link');
  if (portalLinkAction && selfKnowledge?.portal_link_enabled === true) {
    portalLink = d.resolveOwnerPortalLink({ clientId, env: d.env });
    try {
      await d.recordOwnerPortalLinkShare({
        firmId: effectiveFirmId || firmId,
        clientId,
        actorId,
        actorType: actorType === 'client' ? 'client' : 'firm',
        channel: surfaceId,
        status: portalLink.status,
        linkPath: portalLink.path,
        selfKnowledgeVersion: selfKnowledge?.receipt?.self_knowledge_version || null,
        selfKnowledgeFingerprint: selfKnowledge?.receipt?.self_knowledge_fingerprint || null,
        configSnapshotId: selfKnowledge?.receipt?.config_snapshot_id || null
      });
    } catch (error) {
      d.warn('[mcp-ask-donna] portal-link audit write failed', error?.message || error);
      portalLink = { ...portalLink, audit: 'failed' };
    }
  }
  const replyText = portalLink ? composePortalLinkReply({ text: finalReply.text, link: portalLink }) : finalReply.text;

  const modelId = finalReply.model || reply.model || null;
  const assistantMessage = await d.persistClientPortalTurnMessage({
    firmId,
    clientId,
    id: newClientPortalChatMessageId({ clientId, kind: 'assistant' }),
    role: 'assistant',
    content: replyText,
    payload: {
      ...rowPayloadBase,
      actions: finalReply.actions,
      ...(portalLink ? { portal_link: portalLink } : {}),
      ...(reportRequest ? { report_request: reportRequest, report_result: { period_start: reportResult?.period_start || null, period_end: reportResult?.period_end || null, draft: reportResult?.draft || null } } : {}),
      ...(selfKnowledge ? { self_knowledge: selfKnowledge.receipt } : {}),
      ...(knowledgeGrounding?.receipt ? { knowledge_grounding: knowledgeGrounding.receipt } : {})
    },
    model: modelId,
    actorType: 'llm'
  });

  // Observational sidecars — after the persisted answer, flag-gated,
  // no-throw by contract (the portal runs the same two).
  await d.onOwnerMessagePersisted({
    firmId: effectiveFirmId || firmId,
    clientId,
    channel: surfaceId,
    sourceMessageId: userMessageRow.id,
    ownerText: userMessage,
    ownerActorId: actorId,
    sourceMessageCreatedAt: userMessageRow.created_at || null,
    history: history.slice(0, -1),
    deps: { withFirmDbClient: d.withFirmDbClient }
  });
  await d.onOwnerTurnMemoryShadow({
    firmId: effectiveFirmId || firmId,
    clientId,
    snapshot: memoryRetrievalSnapshot,
    channel: surfaceId,
    answer: { messageId: assistantMessage.id, content: replyText, modelId },
    firmFacts,
    deps: { withFirmDbClient: d.withFirmDbClient }
  });

  return {
    ...resultBase,
    message_id: assistantMessage.id,
    text: replyText,
    actions: projectProposedActions(finalReply.actions),
    model_id: modelId,
    // The deep link, when the runtime resolved one: status + path + url (the
    // url is already in the text; here so a card can offer it as a button).
    ...(portalLink ? { portal_link: { status: portalLink.status, path: portalLink.path || null, url: portalLink.url || null } } : {})
  };
};

export const MCP_CONVERSE_TOOL_EXECUTORS = Object.freeze({
  [MCP_ASK_DONNA_TOOL_NAME]: runAskDonna
});
