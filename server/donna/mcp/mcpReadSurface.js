// Donna MCP surface registry — the tools an external chat model may call,
// and nothing else (docs/design-donna-mcp-surface.md; the hosted surfaces in
// docs/design-donna-chatgpt-app-build-brief.md).
//
// Doctrine (the non-negotiables the design records):
//   - The external model is an UNTRUSTED ACTOR: actor_type 'external_model'.
//     Capability enforcement, not model cooperation, is the security boundary.
//   - The registry is CLOSED and TIERED (MCP_TIERS). Tier 'read' tools are
//     read-only by construction (every executor in this file is a projection
//     over governed reads). Tier 'converse' (slice 2, 2026-09-14) is exactly
//     ONE tool, ask_donna: it persists a conversation turn on the owner's own
//     chat thread and changes no book state; the actions it returns are
//     PROPOSALS the owner must confirm separately — its executor lives in
//     mcpAskDonna.js, never here. Tier 'act' (slice 3, 2026-09-15) is exactly
//     ONE tool, confirm_action: the OWNER confirming one of those persisted
//     proposals, through the SAME chat-apply spine and named writers the
//     portal's Confirm card uses (clientChatApply.js) — its executor lives in
//     mcpConfirmAction.js, never here. No tool name maps to a ledger writer
//     directly; the only mutation this surface can reach is the spine-gated
//     owner apply (K-mcp-1). mcpReadSurface.test.js pins all of it.
//   - Tools are listed PER SURFACE (`surfaces` on each entry): the local
//     desktop shim keeps the five read tools byte-identically; ask_donna and
//     confirm_action are served only on the hosted chat surfaces. The funnel
//     refuses a tool that is not on the calling surface.
//   - Per-entity consent: a client is visible to the MCP surface ONLY while
//     MCP_ENTITY_EXPOSE resolves to an ACTING stage for that client on the
//     config control plane (client_capability_config — never an env pair).
//     No row ⇒ not exposed (fail-closed); CLIENT_CONFIG_FORCE_DISABLE kills
//     the whole surface (env may KILL, never enable).
//   - Every call is receipted in audit_events BEFORE the result is served
//     (recordMcpToolReceipt) — receipt-as-precondition, the G2 PR-12 posture:
//     if the access can't be receipted, the data is not served.
//
// This module is a READ projection assembler: it reuses the same governed
// reads the operator UI renders (getAuthorizedFirmSnapshotFromDb +
// buildFirmFeed — the reconcile tab's own projection) and never re-implements
// classification. No ledger writer, no proposal mint, no chat action type is
// imported here — keep it that way (INV-1: a new tool surface is never a
// second accounting backend).

import { randomUUID } from 'node:crypto';

import {
  DEFAULT_FIRM_ID,
  withFirmDbClient,
  getAuthorizedFirmSnapshotFromDb,
  getAskBatchDraftsForFirmFromDb
} from '../firmDb.js';
import { readClientConfigSnapshot, clientFlagActs } from '../clientConfig.js';
import { buildFirmFeed } from '../firmFeed.js';

// ── Constants ──────────────────────────────────────────────────────────────

// The per-entity consent flag. Born on the config control plane (the rollout
// rail): a client-specific row staged canary/auto = the owner's explicit
// "expose this entity to the chat surfaces" decision (ONE consent for every
// surface in MCP_SURFACES — the settings "AI chat access" screen), written
// through the audited setClientFlagStage writer. It is in AUTO_FORBIDDEN_FLAGS (clientConfig.js)
// so a blanket firm-default 'auto' row can never expose every client at once
// — consent is per entity, by construction.
export const MCP_ENTITY_EXPOSE_FLAG_KEY = 'MCP_ENTITY_EXPOSE';

// Actor attribution for every receipt this surface writes. ONE actor_type
// (an external chat model is an untrusted actor whatever window it speaks
// through) and one actor_id PER SURFACE — the receipt must answer "which
// door did this read come through" without a join. The local MCPB shim is
// the original surface; the hosted remote endpoint (mcpRemoteAdapter.js,
// docs/design-donna-chatgpt-app-build-brief.md) mints one id per registered
// chat host. A new surface adds a row here, never reuses another's id.
export const MCP_ACTOR_TYPE = 'external_model';

export const MCP_SURFACES = Object.freeze({
  claude_desktop_mcp: Object.freeze({
    id: 'claude_desktop_mcp',
    actor_id: 'claude_desktop_mcp',
    transport: 'local_stdio_shim',
    label: 'Claude Desktop (local extension)'
  }),
  chatgpt_app: Object.freeze({
    id: 'chatgpt_app',
    actor_id: 'chatgpt_app',
    transport: 'remote_streamable_http',
    label: 'ChatGPT (Donna app)'
  }),
  claude_remote: Object.freeze({
    id: 'claude_remote',
    actor_id: 'claude_remote',
    transport: 'remote_streamable_http',
    label: 'Claude (remote connector)'
  })
});

export const DEFAULT_MCP_SURFACE = MCP_SURFACES.claude_desktop_mcp;

// Kept as the local shim's id — the receipt writer's default when no surface
// is passed, so the local route's attribution is byte-identical to before.
export const MCP_ACTOR_ID = DEFAULT_MCP_SURFACE.actor_id;

export const findMcpSurface = (id) => MCP_SURFACES[String(id || '')] || null;

export const MCP_RECEIPT_ACTION = 'mcp.tool_invoked';

// The tiers a registry entry may carry. The funnel (mcpApi.js) serves exactly
// these and refuses anything else, so a registry mistake fails closed.
//   read     — a projection over governed reads; no persistence of any kind.
//   converse — persists a chat turn on the owner's thread (the same rows the
//              portal renders), changes no book state, applies nothing; the
//              proposals it returns need the owner's confirmation separately.
//   act      — the owner's confirmation of ONE persisted proposal
//              (confirm_action, slice 3): reaches the chat-apply spine and
//              nothing else; the spine's gates, writers, stamp and audit are
//              the portal's own. Never a direct writer, never a firm verb.
// Each tier is a deliberate registry change with its own pins
// (mcpReadSurface.test.js), never a value added here in passing.
export const MCP_TIERS = Object.freeze({ read: 'read', converse: 'converse', act: 'act' });

// The surfaces on which every tool is available, by tier. The read tier is
// served everywhere; the converse and act tiers only on the hosted chat
// surfaces (the desktop shim's listing stays byte-identical, and a chat
// message from a Claude Desktop extension has no owner thread to land in
// yet — so nothing there to confirm either).
const ALL_SURFACES = Object.freeze(['claude_desktop_mcp', 'chatgpt_app', 'claude_remote']);
export const MCP_HOSTED_SURFACE_IDS = Object.freeze(['chatgpt_app', 'claude_remote']);

// Annotations as the MCP hosts read them. They are DATA on the registry so
// a transport copies them 1:1 and never decides them. A read tool is
// read-only and idempotent; ask_donna is neither (it appends a message to
// the owner's thread every call) — both chat hosts key their per-call
// confirmation on readOnlyHint (brief §8 F2/F3), so the annotation must be
// honest even though the tool changes no book state.
const READ_ANNOTATIONS = Object.freeze({
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false
});
const CONVERSE_ANNOTATIONS = Object.freeze({
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false
});
// confirm_action WRITES (it files the owner's answer / books the mileage)
// and is not idempotent as the hosts define it (a second call replays the
// applied result, but a declined or resolved action answers differently);
// it is not destructive (nothing is deleted or reversed — the writers are
// the portal's tracked ask → recode path and the mileage journal). Both
// hosts key their per-call confirmation on readOnlyHint (brief §8 F2/F3):
// a write tool without it is treated as a write, which is the point.
const ACT_ANNOTATIONS = Object.freeze({
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false
});

// The MCP Apps card bundle (slice 4, mcpAppCards.js): ONE ui:// resource, two
// cards. A tool entry carrying `ui: { resource_uri }` is rendered by the host
// through that resource when the host supports the extension; every tool
// still returns its text block, so a text-only host is unchanged. Data on the
// registry, copied by the transport, never decided there.
export const MCP_UI_CARDS_RESOURCE_URI = 'ui://donna-books/cards';
const CARD_UI = Object.freeze({ resource_uri: MCP_UI_CARDS_RESOURCE_URI });

export const MCP_ASK_DONNA_TOOL_NAME = 'ask_donna';
export const MCP_ASK_DONNA_MAX_MESSAGE_CHARS = 4000;
export const MCP_CONFIRM_ACTION_TOOL_NAME = 'confirm_action';
export const MCP_CONFIRM_ACTION_MAX_MESSAGE_ID_CHARS = 200;

// Result caps — an agent loop must not be able to drag the whole book into
// one tool result. Claude Desktop truncates ~150K chars; we stay far under.
export const MCP_DEFAULT_PAGE_SIZE = 20;
export const MCP_MAX_PAGE_SIZE = 50;
export const MCP_MAX_BLOCKERS = 20;
export const MCP_MAX_AUDIT_EVENTS = 50;
export const MCP_MAX_RESULT_CHARS = 60_000;

// ── Tool registry (the closed surface) ─────────────────────────────────────
//
// The single source of truth for what the MCP surface exposes. The HTTP
// handler (mcpApi.js) serves this to the MCPB shim, which translates it
// 1:1 into MCP tools/list — the shim carries no tool logic of its own.
// `entity_scoped: 'required'` tools take one exposed entity; 'optional'
// tools accept one or default to every exposed entity. Tiers are the
// MCP_TIERS values only; the test file pins that no other tier value ever
// appears and that exactly one converse tool and one act tool exist. `title` is the
// human-readable name the hosted surfaces list (Claude's review criteria
// require one per tool); the local shim ignores it. `surfaces` and
// `annotations` are listing facts a transport copies, never decides.

export const MCP_TOOLS = Object.freeze([
  Object.freeze({
    name: 'entity_list',
    title: 'Exposed businesses',
    tier: MCP_TIERS.read,
    surfaces: ALL_SURFACES,
    annotations: READ_ANNOTATIONS,
    entity_scoped: 'none',
    description:
      'List the businesses (entities) their owner has exposed to this chat surface, '
      + 'with a close-status summary for each. Entities are exposed one by one inside '
      + 'Donna’s settings (AI chat access); an entity not listed here is not reachable.',
    input_schema: Object.freeze({ type: 'object', properties: {}, additionalProperties: false })
  }),
  Object.freeze({
    name: 'close_status',
    title: 'Close status',
    tier: MCP_TIERS.read,
    surfaces: ALL_SURFACES,
    annotations: READ_ANNOTATIONS,
    ui: CARD_UI,
    entity_scoped: 'required',
    description:
      'Close/reconcile state for one entity: item counts per disposition bucket, '
      + 'how many items block the close, open owner questions, and the top blocking '
      + 'items. This is the same projection Donna’s own reconcile tab renders.',
    input_schema: Object.freeze({
      type: 'object',
      properties: {
        entity_id: { type: 'string', description: 'Entity id from entity_list.' }
      },
      required: Object.freeze(['entity_id']),
      additionalProperties: false
    })
  }),
  Object.freeze({
    name: 'unmatched_items',
    title: 'Unresolved items',
    tier: MCP_TIERS.read,
    surfaces: ALL_SURFACES,
    annotations: READ_ANNOTATIONS,
    entity_scoped: 'required',
    description:
      'Unresolved work for one entity — transactions and documents that are neither '
      + 'auto-reconciled nor waiting on the owner’s answer, plus items waiting on '
      + 'client info. Paginated.',
    input_schema: Object.freeze({
      type: 'object',
      properties: {
        entity_id: { type: 'string', description: 'Entity id from entity_list.' },
        page: { type: 'integer', minimum: 1, description: 'Page number, 1-based. Default 1.' },
        page_size: { type: 'integer', minimum: 1, maximum: MCP_MAX_PAGE_SIZE, description: `Items per page, max ${MCP_MAX_PAGE_SIZE}. Default ${MCP_DEFAULT_PAGE_SIZE}.` }
      },
      required: Object.freeze(['entity_id']),
      additionalProperties: false
    })
  }),
  Object.freeze({
    name: 'document_status',
    title: 'Outstanding documents',
    tier: MCP_TIERS.read,
    surfaces: ALL_SURFACES,
    annotations: READ_ANNOTATIONS,
    entity_scoped: 'optional',
    description:
      'Outstanding document/evidence requests — what each business still owes. '
      + 'Pass entity_id for one entity, or omit it for every exposed entity.',
    input_schema: Object.freeze({
      type: 'object',
      properties: {
        entity_id: { type: 'string', description: 'Optional entity id from entity_list.' }
      },
      additionalProperties: false
    })
  }),
  Object.freeze({
    name: 'audit_recent',
    title: 'Recent Donna activity',
    tier: MCP_TIERS.read,
    surfaces: ALL_SURFACES,
    annotations: READ_ANNOTATIONS,
    entity_scoped: 'optional',
    description:
      'Recent actions from Donna’s audit trail ("what did Donna do overnight"). '
      + 'Pass entity_id for one entity, or omit it for every exposed entity.',
    input_schema: Object.freeze({
      type: 'object',
      properties: {
        entity_id: { type: 'string', description: 'Optional entity id from entity_list.' },
        limit: { type: 'integer', minimum: 1, maximum: MCP_MAX_AUDIT_EVENTS, description: `Events to return, max ${MCP_MAX_AUDIT_EVENTS}. Default ${MCP_MAX_AUDIT_EVENTS}.` }
      },
      additionalProperties: false
    })
  }),
  // The converse tier — ONE tool. The owner talks to Donna; Donna's own
  // runtime answers with her own context (the portal chat engine,
  // clientPortalChat.js, behind the SAME context builder and sanitizer as
  // POST /client-chat) and her own qualified model. The calling chat host is
  // a window, never the brain. The turn is persisted on the owner's portal
  // thread; proposed actions come back requires_confirmation: true and are
  // NEVER applied by this tool (executor: mcpAskDonna.js).
  Object.freeze({
    name: MCP_ASK_DONNA_TOOL_NAME,
    title: 'Ask Donna',
    tier: MCP_TIERS.converse,
    surfaces: MCP_HOSTED_SURFACE_IDS,
    annotations: CONVERSE_ANNOTATIONS,
    ui: CARD_UI,
    entity_scoped: 'required',
    description:
      'Ask Donna, the bookkeeper, a question about one business’s books, or answer a '
      + 'question she has open. Donna answers from the recorded state of the books '
      + 'with her own model; the message and her reply are saved to the owner’s chat '
      + 'thread in Donna (nothing else is recorded). If the message answers one of '
      + 'Donna’s open questions or states business mileage, the reply may carry a '
      + 'proposed action — it is NOT applied by this tool; the owner confirms it '
      + 'separately. Send the owner’s words as written; do not answer for them.',
    input_schema: Object.freeze({
      type: 'object',
      properties: {
        entity_id: { type: 'string', description: 'Entity id from entity_list.' },
        message: {
          type: 'string',
          minLength: 1,
          maxLength: MCP_ASK_DONNA_MAX_MESSAGE_CHARS,
          description: 'The owner’s message to Donna, in their own words.'
        }
      },
      required: Object.freeze(['entity_id', 'message']),
      additionalProperties: false
    })
  }),
  // The act tier — ONE tool. The owner CONFIRMS one proposal that ask_donna
  // (or the portal) persisted on their thread: the same persisted row, the
  // same action index, the same chat-apply spine, gates, writers, stamp and
  // audit as the portal's Confirm card (clientChatApply.js). Two-call shape
  // regardless of the host: ask_donna proposes, confirm_action applies —
  // never an implicit side effect of a chat turn. Only the owner-appliable
  // grammar (answer an open question, record mileage) can reach the spine;
  // anything else is refused before it (executor: mcpConfirmAction.js).
  Object.freeze({
    name: MCP_CONFIRM_ACTION_TOOL_NAME,
    title: 'Confirm a proposed action',
    tier: MCP_TIERS.act,
    surfaces: MCP_HOSTED_SURFACE_IDS,
    annotations: ACT_ANNOTATIONS,
    entity_scoped: 'required',
    description:
      'Confirm ONE action Donna proposed in an earlier ask_donna reply for this business, '
      + 'on the owner’s explicit say-so: filing the owner’s answer to one of Donna’s open '
      + 'questions, or recording business mileage. This WRITES to the books through the '
      + 'same tracked path as the Confirm button in the owner’s Donna portal, and is '
      + 'recorded in Donna’s audit trail with this chat named as the door. Pass the '
      + 'message_id and the action’s index exactly as ask_donna returned them. Call it '
      + 'only after the owner has clearly confirmed that specific action; never to '
      + 'confirm on their behalf. Anything other than those two owner actions is refused.',
    input_schema: Object.freeze({
      type: 'object',
      properties: {
        entity_id: { type: 'string', description: 'Entity id from entity_list — the business the proposal belongs to.' },
        message_id: {
          type: 'string',
          minLength: 1,
          maxLength: MCP_CONFIRM_ACTION_MAX_MESSAGE_ID_CHARS,
          description: 'The message_id from the ask_donna reply that carried the proposal.'
        },
        action_index: {
          type: 'integer',
          minimum: 0,
          description: 'The index of the action on that reply, from actions[].index.'
        }
      },
      required: Object.freeze(['entity_id', 'message_id', 'action_index']),
      additionalProperties: false
    })
  })
]);

// The registry as ONE surface lists it: the read tier everywhere, the converse
// and act tiers on the hosted chat surfaces only. An unknown surface id lists
// nothing.
export const mcpToolsForSurface = (surfaceId) =>
  MCP_TOOLS.filter((tool) => tool.surfaces.includes(String(surfaceId || '')));

export const MCP_READ_TOOLS = Object.freeze(MCP_TOOLS.filter((tool) => tool.tier === MCP_TIERS.read));
export const MCP_TOOLS_WITH_CARDS = Object.freeze(MCP_TOOLS.filter((tool) => tool.ui?.resource_uri).map((tool) => tool.name));
export const MCP_CONVERSE_TOOLS = Object.freeze(MCP_TOOLS.filter((tool) => tool.tier === MCP_TIERS.converse));
export const MCP_ACT_TOOLS = Object.freeze(MCP_TOOLS.filter((tool) => tool.tier === MCP_TIERS.act));

export const findMcpTool = (name) => MCP_TOOLS.find((t) => t.name === name) || null;

// ── Entity exposure (the consent gate) ─────────────────────────────────────

// Resolve which of the firm's clients are exposed to the MCP surface. Reads
// each client's config through the ONE precedence resolver
// (readClientConfigSnapshot) and asks clientFlagActs with a hard-false env
// fallback: no DB row ever exposes anything, and CLIENT_CONFIG_FORCE_DISABLE
// ('all' or the flag key) kills exposure everywhere at once.
export const listExposedEntities = async ({
  firmId = DEFAULT_FIRM_ID,
  deps = {}
} = {}) => {
  const d = {
    withFirmDbClient,
    readClientConfigSnapshot,
    clientFlagActs,
    env: process.env,
    ...deps
  };
  return d.withFirmDbClient(async (dbClient) => {
    const clientsRes = await dbClient.query(
      `select id, company_name, status, profile
         from clients
        where firm_id = $1
        order by company_name asc, id asc`,
      [firmId]
    );
    const exposed = [];
    for (const row of clientsRes.rows || []) {
      const snapshot = await d.readClientConfigSnapshot(dbClient, { firmId, clientId: row.id });
      const acts = d.clientFlagActs({
        flagKey: MCP_ENTITY_EXPOSE_FLAG_KEY,
        snapshot,
        envFallback: () => false,
        env: d.env
      });
      if (acts) {
        exposed.push({
          id: row.id,
          name: row.company_name || row.id,
          status: row.status || null,
          jurisdiction: row.profile?.jurisdiction ?? null,
          accounting_basis:
            row.profile?.accountingBasis ?? row.profile?.accounting_basis ?? null
        });
      }
    }
    return exposed;
  });
};

// ── Shared feed load (the reconcile tab's own projection) ─────────────────

const loadFeed = async ({ firmId, auth, clientId = null, deps }) => {
  const snapshot = await deps.getAuthorizedFirmSnapshotFromDb({ firmId, auth });
  const snapshotClientIds = new Set((snapshot.clients || []).map((c) => c.id));
  const askBatchDrafts = (await deps.getAskBatchDraftsForFirmFromDb({ firmId }))
    .filter((batch) => snapshotClientIds.has(batch.client_id));
  const feed = deps.buildFirmFeed({
    firm: snapshot.firm,
    clients: snapshot.clients,
    transactions: snapshot.transactions,
    documents: snapshot.documents,
    reconciliationMatches: snapshot.reconciliationMatches,
    transactionReviewQueue: snapshot.transactionReviewQueue,
    clientEvidenceRequests: snapshot.clientEvidenceRequests,
    askBatches: askBatchDrafts,
    clientId
  });
  return { snapshot, feed };
};

// Compact projection of a feed item — the accounting-relevant view, not the
// raw row (compressed reads, never raw dumps).
const compactFeedItem = (item) => ({
  kind: item.kind,
  disposition: item.verdict?.disposition ?? null,
  blocks_close: Boolean(item.verdict?.blocks_close),
  entity_id: item.client_id ?? null,
  transaction_id: item.transaction_id ?? null,
  document_id: item.document_id ?? null,
  date: item.transaction_date ?? null,
  amount: item.amount ?? null,
  currency: item.currency ?? null,
  descriptor: item.descriptor ?? null,
  counterparty: item.counterparty ?? null,
  reason: item.reason ?? null
});

const bucketTotalsFor = (feed, clientId) => {
  const totals = { auto_cleared: 0, confirmable: 0, operator_blocker: 0, client_info_needed: 0, blocks_close: 0 };
  for (const bucketName of Object.keys(feed.buckets || {})) {
    for (const item of feed.buckets[bucketName] || []) {
      if (clientId && item.client_id !== clientId) continue;
      if (bucketName in totals) totals[bucketName] += 1;
      if (item.verdict?.blocks_close) totals.blocks_close += 1;
    }
  }
  return totals;
};

// ── Tool executors ─────────────────────────────────────────────────────────
//
// Every executor takes ({ firmId, auth, entities, args, deps }) where
// `entities` is the ALREADY-RESOLVED exposed set (mcpApi.js resolves it once
// per call and enforces entity_id membership BEFORE dispatch — an executor
// never sees a non-exposed entity id). deps carries the injectable reads.

const executorDeps = (deps = {}) => ({
  withFirmDbClient,
  getAuthorizedFirmSnapshotFromDb,
  getAskBatchDraftsForFirmFromDb,
  buildFirmFeed,
  ...deps
});

export const runEntityList = async ({ firmId, auth, entities, deps = {} } = {}) => {
  const d = executorDeps(deps);
  if (!entities.length) return { entities: [], count: 0 };
  const { feed } = await loadFeed({ firmId, auth, deps: d });
  return {
    entities: entities.map((entity) => ({
      ...entity,
      close: bucketTotalsFor(feed, entity.id)
    })),
    count: entities.length
  };
};

export const runCloseStatus = async ({ firmId, auth, entities, args = {}, deps = {} } = {}) => {
  const d = executorDeps(deps);
  const entity = entities.find((e) => e.id === args.entity_id);
  const { feed } = await loadFeed({ firmId, auth, clientId: entity.id, deps: d });
  const totals = bucketTotalsFor(feed, entity.id);
  const blocking = []
    .concat(feed.buckets?.operator_blocker || [], feed.buckets?.client_info_needed || [])
    .filter((item) => item.client_id === entity.id);
  const openOwnerAsks = blocking.filter((item) => item.kind === 'client_evidence_request').length;
  return {
    entity: { id: entity.id, name: entity.name },
    totals,
    open_owner_asks: openOwnerAsks,
    blockers: blocking
      .slice()
      .sort((a, b) => Number(Boolean(b.verdict?.blocks_close)) - Number(Boolean(a.verdict?.blocks_close)))
      .slice(0, MCP_MAX_BLOCKERS)
      .map(compactFeedItem),
    blockers_truncated: blocking.length > MCP_MAX_BLOCKERS,
    generated_at: feed.generated_at
  };
};

export const runUnmatchedItems = async ({ firmId, auth, entities, args = {}, deps = {} } = {}) => {
  const d = executorDeps(deps);
  const entity = entities.find((e) => e.id === args.entity_id);
  const page = Math.max(1, Number.parseInt(args.page, 10) || 1);
  const pageSize = Math.min(
    MCP_MAX_PAGE_SIZE,
    Math.max(1, Number.parseInt(args.page_size, 10) || MCP_DEFAULT_PAGE_SIZE)
  );
  const { feed } = await loadFeed({ firmId, auth, clientId: entity.id, deps: d });
  const open = []
    .concat(
      feed.buckets?.operator_blocker || [],
      feed.buckets?.client_info_needed || [],
      feed.buckets?.confirmable || []
    )
    .filter((item) => item.client_id === entity.id);
  const start = (page - 1) * pageSize;
  return {
    entity: { id: entity.id, name: entity.name },
    total: open.length,
    page,
    page_size: pageSize,
    has_more: start + pageSize < open.length,
    items: open.slice(start, start + pageSize).map(compactFeedItem)
  };
};

export const runDocumentStatus = async ({ firmId, entities, args = {}, deps = {} } = {}) => {
  const d = executorDeps(deps);
  const scope = args.entity_id ? entities.filter((e) => e.id === args.entity_id) : entities;
  const scopeIds = scope.map((e) => e.id);
  if (!scopeIds.length) return { entities: [], open_requests: 0 };
  const rows = await d.withFirmDbClient(async (dbClient) => {
    const res = await dbClient.query(
      `select id, client_id, transaction_id, evidence_type, question,
              first_sent_at, last_sent_at, send_count, due_at, created_at
         from client_evidence_requests
        where firm_id = $1 and client_id = any($2) and status = 'open'
        order by created_at asc`,
      [firmId, scopeIds]
    );
    return res.rows || [];
  });
  const byEntity = new Map(scope.map((e) => [e.id, { entity: { id: e.id, name: e.name }, requests: [] }]));
  for (const row of rows) {
    byEntity.get(row.client_id)?.requests.push({
      id: row.id,
      transaction_id: row.transaction_id || null,
      evidence_type: row.evidence_type || null,
      question: row.question || null,
      first_sent_at: row.first_sent_at || null,
      last_sent_at: row.last_sent_at || null,
      send_count: Number(row.send_count) || 0,
      due_at: row.due_at || null,
      created_at: row.created_at || null
    });
  }
  return {
    entities: Array.from(byEntity.values()),
    open_requests: rows.length
  };
};

export const runAuditRecent = async ({ firmId, entities, args = {}, deps = {} } = {}) => {
  const d = executorDeps(deps);
  const scope = args.entity_id ? entities.filter((e) => e.id === args.entity_id) : entities;
  const scopeIds = scope.map((e) => e.id);
  const limit = Math.min(
    MCP_MAX_AUDIT_EVENTS,
    Math.max(1, Number.parseInt(args.limit, 10) || MCP_MAX_AUDIT_EVENTS)
  );
  if (!scopeIds.length) return { events: [], count: 0 };
  // Fail-closed scoping: only events attributed to an EXPOSED client are
  // served. Firm-level events (client_id null) stay firm-internal — they can
  // reference non-exposed clients in their metadata.
  const rows = await d.withFirmDbClient(async (dbClient) => {
    const res = await dbClient.query(
      `select client_id, actor_type, actor_id, action, resource_type, resource_id, created_at
         from audit_events
        where firm_id = $1 and client_id = any($2)
        order by created_at desc
        limit $3`,
      [firmId, scopeIds, limit]
    );
    return res.rows || [];
  });
  return {
    events: rows.map((row) => ({
      entity_id: row.client_id,
      actor_type: row.actor_type || null,
      actor_id: row.actor_id || null,
      action: row.action,
      resource_type: row.resource_type || null,
      resource_id: row.resource_id || null,
      created_at: row.created_at || null
    })),
    count: rows.length
  };
};

// The READ-tier executors — projections only. The converse tier's executor
// (ask_donna) lives in mcpAskDonna.js because it persists chat rows; the act
// tier's (confirm_action) in mcpConfirmAction.js because it reaches the
// apply spine; the funnel (mcpApi.js) composes the three maps and
// mcpApi.test.js pins that the composed map covers exactly the registry.
export const MCP_TOOL_EXECUTORS = Object.freeze({
  entity_list: runEntityList,
  close_status: runCloseStatus,
  unmatched_items: runUnmatchedItems,
  document_status: runDocumentStatus,
  audit_recent: runAuditRecent
});

// ── The receipt (audit-as-precondition) ────────────────────────────────────

// Sanitized argument echo for the receipt: only the known scalar keys, never
// free text — tool arguments arrive from an untrusted model. The ask_donna
// message is echoed as a LENGTH only; the text itself lives on the owner's
// chat row (client_chat_messages), which is its home, not the audit row.
// confirm_action's message_id + action_index are ids, echoed as given (they
// are what the apply audit row also names, so the two receipts join).
const receiptArgs = (args = {}) => ({
  ...(args.entity_id ? { entity_id: String(args.entity_id) } : {}),
  ...(args.page ? { page: Number(args.page) || null } : {}),
  ...(args.page_size ? { page_size: Number(args.page_size) || null } : {}),
  ...(args.limit ? { limit: Number(args.limit) || null } : {}),
  ...(typeof args.message === 'string' ? { message_chars: args.message.length } : {}),
  ...(typeof args.message_id === 'string' ? { message_id: args.message_id } : {}),
  ...(Number.isInteger(args.action_index) ? { action_index: args.action_index } : {})
});

// The authorizing principal as the receipt records it: type + stable id
// only (a user id or the access-token marker), never the raw auth object —
// an email is PII the audit row does not need to carry twice.
export const receiptPrincipalFor = (auth) => {
  if (!auth || typeof auth !== 'object') return null;
  const type = String(auth.type || 'unknown');
  if (type === 'supabase_user') return { type, id: auth.userId ? String(auth.userId) : null };
  return { type, id: null };
};

// Insert the receipt row. NOT best-effort: the caller serves the result only
// after this resolves — an unreceipted external-model read must not happen.
//
// The receipt carries, beside the tool/args/result summary: the SURFACE the
// call came through (actor_id + metadata.surface), the authorizing PRINCIPAL
// (metadata.principal), and the proposing MODEL id (metadata.model_id —
// null on the read tier, where no model of Donna's proposes anything, and
// null on the act tier, where the owner applies and no model proposes; the
// ask_donna tool writes Donna's own model id here).
export const recordMcpToolReceipt = async ({
  firmId,
  clientId = null,
  tool,
  args = {},
  resultMeta = {},
  surface = DEFAULT_MCP_SURFACE,
  principal = null,
  modelId = null,
  deps = {}
} = {}) => {
  const d = { withFirmDbClient, ...deps };
  const resolvedSurface = (surface && MCP_SURFACES[surface.id]) || DEFAULT_MCP_SURFACE;
  const receiptId = randomUUID();
  await d.withFirmDbClient(async (dbClient) => {
    await dbClient.query(
      `insert into audit_events
         (firm_id, client_id, actor_type, actor_id, action, resource_type, resource_id, metadata)
       values ($1, $2, $3, $4, $5, 'mcp_tool', $6, $7::jsonb)`,
      [
        firmId,
        clientId,
        MCP_ACTOR_TYPE,
        resolvedSurface.actor_id,
        MCP_RECEIPT_ACTION,
        tool,
        JSON.stringify({
          receipt_id: receiptId,
          tool,
          args: receiptArgs(args),
          result: resultMeta,
          surface: resolvedSurface.id,
          transport: resolvedSurface.transport,
          principal: principal || null,
          model_id: modelId || null
        })
      ]
    );
  });
  return receiptId;
};

// Small meta summary of a result for the receipt — counts only, no content.
export const resultMetaFor = (tool, result) => {
  if (!result || typeof result !== 'object') return {};
  switch (tool) {
    case 'entity_list':
      return { entities: result.count ?? 0 };
    case 'close_status':
      return { blocks_close: result.totals?.blocks_close ?? 0, blockers: result.blockers?.length ?? 0 };
    case 'unmatched_items':
      return { total: result.total ?? 0, page: result.page ?? 1, returned: result.items?.length ?? 0 };
    case 'document_status':
      return { open_requests: result.open_requests ?? 0 };
    case 'audit_recent':
      return { events: result.count ?? 0 };
    case MCP_ASK_DONNA_TOOL_NAME:
      // Ids and counts only — the reply text is on the chat row, not here.
      return {
        message_id: result.message_id ?? null,
        user_message_id: result.user_message_id ?? null,
        actions: Array.isArray(result.actions) ? result.actions.length : 0,
        ...(result.memory_status ? { memory_status: result.memory_status } : {}),
        // The portal deep link share (slice 4 D): its status only; the link
        // itself is on the chat row and the owner_portal_link.shared audit.
        ...(result.portal_link?.status ? { portal_link: result.portal_link.status } : {})
      };
    case MCP_CONFIRM_ACTION_TOOL_NAME:
      // The consequence in ids and flags — what was applied, or why not.
      // The full apply row is the client_chat.*_applied audit (metadata.
      // surface names this door); this receipt is the surface's own.
      return {
        message_id: result.message_id ?? null,
        action_index: Number.isInteger(result.action_index) ? result.action_index : null,
        action_type: result.action_type ?? null,
        applied: Boolean(result.applied),
        ...(result.replay ? { replay: true } : {}),
        ...(result.outcome ? { outcome: result.outcome } : {}),
        ...(result.evidence_request_status ? { evidence_request_status: result.evidence_request_status } : {}),
        ...(result.recode ? { recode_applied: Boolean(result.recode.applied) } : {})
      };
    default:
      return {};
  }
};

// The proposing model id the receipt records. Only the converse tier has a
// model of Donna's answering; it is read from the executor's RESULT (which
// carries what the engine actually reported for this turn), never from a
// code default (CLAUDE.md: the model id is part of the receipt). The read
// tier records null — no model of Donna's proposes anything there. The act
// tier records null too: the owner applies, no model proposes; the model
// that proposed the action is on the ask_donna receipt and the chat row.
export const receiptModelIdFor = (tool, result) => {
  if (!tool || tool.tier !== MCP_TIERS.converse) return null;
  const modelId = result && typeof result === 'object' ? result.model_id : null;
  return typeof modelId === 'string' && modelId.trim() ? modelId.trim() : null;
};
