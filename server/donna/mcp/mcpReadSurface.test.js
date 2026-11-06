// MCP read surface — unit tests (docs/design-donna-mcp-surface.md).
//
// Load-bearing properties:
//   - the registry is CLOSED and TIERED: every tool carries a MCP_TIERS value
//     (read, or converse for exactly ask_donna — a persisted chat turn that
//     changes no book state), no tool name contains a mutating verb, the
//     converse tool is served only on the hosted surfaces with honest
//     annotations (readOnlyHint false), and the read executor map
//     covers exactly the registry (no orphan executor a handler could reach);
//   - per-entity consent fail-closes: no MCP_ENTITY_EXPOSE row ⇒ not exposed;
//     only acting stages (canary/auto) expose; CLIENT_CONFIG_FORCE_DISABLE
//     kills exposure;
//   - executors return compact, capped projections (pagination bounds hold);
//   - the receipt writer records actor_type 'external_model' with sanitized
//     args, and its failure PROPAGATES (audit-as-precondition — no receipt,
//     no data).

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MCP_ACTOR_ID,
  MCP_ACTOR_TYPE,
  MCP_ACT_TOOLS,
  MCP_ASK_DONNA_MAX_MESSAGE_CHARS,
  MCP_ASK_DONNA_TOOL_NAME,
  MCP_CONFIRM_ACTION_MAX_MESSAGE_ID_CHARS,
  MCP_CONFIRM_ACTION_TOOL_NAME,
  MCP_CONVERSE_TOOLS,
  MCP_DEFAULT_PAGE_SIZE,
  MCP_ENTITY_EXPOSE_FLAG_KEY,
  MCP_HOSTED_SURFACE_IDS,
  MCP_MAX_BLOCKERS,
  MCP_MAX_PAGE_SIZE,
  MCP_READ_TOOLS,
  MCP_SURFACES,
  MCP_TIERS,
  MCP_TOOLS,
  MCP_TOOL_EXECUTORS,
  findMcpTool,
  listExposedEntities,
  mcpToolsForSurface,
  receiptModelIdFor,
  receiptPrincipalFor,
  recordMcpToolReceipt,
  resultMetaFor,
  runAuditRecent,
  runCloseStatus,
  runDocumentStatus,
  runUnmatchedItems
} from './mcpReadSurface.js';
import { AUTO_FORBIDDEN_FLAGS } from '../clientConfig.js';

// ── Registry invariants ────────────────────────────────────────────────────

test('every registered tool carries a MCP_TIERS value; exactly one converse tool (ask_donna) and exactly one act tool (confirm_action)', () => {
  assert.equal(MCP_TOOLS.length, 7);
  // The act tier is a DELIBERATE registry change (slice 3, 2026-09-15) with
  // its own pins — this line is the pin; a fourth tier is the next such change.
  assert.deepEqual(MCP_TIERS, { read: 'read', converse: 'converse', act: 'act' });
  const tiers = new Set(MCP_TOOLS.map((t) => t.tier));
  for (const tier of tiers) assert.ok(Object.values(MCP_TIERS).includes(tier), `tier '${tier}' is not a MCP_TIERS value`);
  assert.deepEqual(MCP_READ_TOOLS.map((t) => t.name), ['entity_list', 'close_status', 'unmatched_items', 'document_status', 'audit_recent']);
  assert.deepEqual(MCP_CONVERSE_TOOLS.map((t) => t.name), [MCP_ASK_DONNA_TOOL_NAME]);
  assert.deepEqual(MCP_ACT_TOOLS.map((t) => t.name), [MCP_CONFIRM_ACTION_TOOL_NAME]);
  assert.equal(findMcpTool(MCP_ASK_DONNA_TOOL_NAME).tier, 'converse');
  assert.equal(findMcpTool(MCP_CONFIRM_ACTION_TOOL_NAME).tier, 'act');
});

test('tools are listed per surface: the read tier everywhere, ask_donna and confirm_action only on the hosted chat surfaces', () => {
  for (const tool of MCP_READ_TOOLS) {
    assert.deepEqual([...tool.surfaces].sort(), ['chatgpt_app', 'claude_desktop_mcp', 'claude_remote'], tool.name);
  }
  assert.deepEqual([...findMcpTool(MCP_ASK_DONNA_TOOL_NAME).surfaces].sort(), ['chatgpt_app', 'claude_remote']);
  // The local shim surface never lists the write: nothing there to confirm
  // (no owner thread), and the brief lists it on the hosted surfaces only.
  assert.deepEqual([...findMcpTool(MCP_CONFIRM_ACTION_TOOL_NAME).surfaces].sort(), ['chatgpt_app', 'claude_remote']);
  assert.deepEqual(MCP_HOSTED_SURFACE_IDS, ['chatgpt_app', 'claude_remote']);
  // The desktop shim's listing is byte-identical to before: the five read tools.
  assert.deepEqual(mcpToolsForSurface('claude_desktop_mcp').map((t) => t.name), MCP_READ_TOOLS.map((t) => t.name));
  assert.deepEqual(mcpToolsForSurface('chatgpt_app').map((t) => t.name), MCP_TOOLS.map((t) => t.name));
  assert.deepEqual(mcpToolsForSurface('claude_remote').map((t) => t.name), MCP_TOOLS.map((t) => t.name));
  assert.deepEqual(mcpToolsForSurface('nope'), []);
  assert.deepEqual(mcpToolsForSurface(undefined), []);
});

test('annotations are honest data on the registry: read tools read-only + idempotent; ask_donna neither, never destructive', () => {
  for (const tool of MCP_READ_TOOLS) {
    assert.deepEqual(tool.annotations, { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }, tool.name);
  }
  const ask = findMcpTool(MCP_ASK_DONNA_TOOL_NAME);
  assert.deepEqual(ask.annotations, { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false });
  assert.equal(ask.entity_scoped, 'required');
  assert.deepEqual(ask.input_schema.required, ['entity_id', 'message']);
  assert.equal(ask.input_schema.additionalProperties, false);
  assert.equal(ask.input_schema.properties.message.maxLength, MCP_ASK_DONNA_MAX_MESSAGE_CHARS);
  assert.ok(!('thread_id' in ask.input_schema.properties), 'the owner thread is one per entity (migration 056) — no thread id to name');
  assert.match(ask.description, /NOT applied by this tool/);
  assert.match(ask.description, /own model/);
});

test('confirm_action: honest act-tier annotations (a write, never destructive, not idempotent), a title, a closed input shape, and copy in the bridge register', () => {
  const confirm = findMcpTool(MCP_CONFIRM_ACTION_TOOL_NAME);
  // Both hosts key their per-call confirmation on readOnlyHint (brief §8
  // F2/F3): a write tool must not carry it. destructiveHint stays false —
  // the writers are the tracked ask → recode path and the mileage journal;
  // nothing is deleted or reversed.
  assert.deepEqual(confirm.annotations, { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false });
  assert.equal(confirm.title, 'Confirm a proposed action');
  assert.equal(confirm.entity_scoped, 'required');
  assert.deepEqual(confirm.input_schema.required, ['entity_id', 'message_id', 'action_index']);
  assert.equal(confirm.input_schema.additionalProperties, false);
  assert.deepEqual(Object.keys(confirm.input_schema.properties).sort(), ['action_index', 'entity_id', 'message_id']);
  assert.equal(confirm.input_schema.properties.action_index.type, 'integer');
  assert.equal(confirm.input_schema.properties.action_index.minimum, 0);
  assert.equal(confirm.input_schema.properties.message_id.maxLength, MCP_CONFIRM_ACTION_MAX_MESSAGE_ID_CHARS);
  // The description states the two-call shape, the write, the audit and the
  // closed set plainly; no custody slogans, no invented doors.
  assert.match(confirm.description, /earlier ask_donna reply/);
  assert.match(confirm.description, /WRITES to the books/);
  assert.match(confirm.description, /same tracked path as the Confirm button/);
  assert.match(confirm.description, /audit trail/);
  assert.match(confirm.description, /only after the owner has clearly confirmed/i);
  assert.match(confirm.description, /never to confirm on their behalf/i);
  assert.match(confirm.description, /Anything other than those two owner actions is refused/);
  assert.doesNotMatch(confirm.description, /never leave|your office|custody/i);
});

test('no tool name carries a mutating verb (plan §5: no post/commit/send/approve names)', () => {
  const forbidden = /post|commit|send|approve|write|create|update|delete|file|pay/i;
  for (const tool of MCP_TOOLS) {
    assert.ok(!forbidden.test(tool.name), `tool name '${tool.name}' looks mutating`);
  }
});

test('the read executor map covers exactly the read tier — no orphan executor, no missing one, no converse or act executor here', () => {
  const registryNames = MCP_READ_TOOLS.map((t) => t.name).sort();
  const executorNames = Object.keys(MCP_TOOL_EXECUTORS).sort();
  assert.deepEqual(executorNames, registryNames);
  assert.ok(!(MCP_ASK_DONNA_TOOL_NAME in MCP_TOOL_EXECUTORS), 'the converse executor lives in mcpAskDonna.js (it persists chat rows)');
  assert.ok(!(MCP_CONFIRM_ACTION_TOOL_NAME in MCP_TOOL_EXECUTORS), 'the act executor lives in mcpConfirmAction.js (it reaches the apply spine)');
});

test('receiptModelIdFor: the converse tier reads Donna’s model id from the result; the read and act tiers record null', () => {
  const ask = findMcpTool(MCP_ASK_DONNA_TOOL_NAME);
  assert.equal(receiptModelIdFor(ask, { model_id: 'claude-x' }), 'claude-x');
  assert.equal(receiptModelIdFor(ask, { model_id: '  ' }), null);
  assert.equal(receiptModelIdFor(ask, {}), null);
  assert.equal(receiptModelIdFor(findMcpTool('close_status'), { model_id: 'claude-x' }), null, 'a read result never names a proposing model');
  // The act tier: the OWNER applies, no model proposes — the model that
  // proposed the action is on the ask_donna receipt and the chat row.
  assert.equal(receiptModelIdFor(findMcpTool(MCP_CONFIRM_ACTION_TOOL_NAME), { model_id: 'claude-x', applied: true }), null);
  assert.deepEqual(resultMetaFor(MCP_ASK_DONNA_TOOL_NAME, { message_id: 'm2', user_message_id: 'm1', actions: [{}, {}], text: 'secret' }), { message_id: 'm2', user_message_id: 'm1', actions: 2 });
  // The confirm receipt summarizes the CONSEQUENCE in ids and flags only.
  assert.deepEqual(
    resultMetaFor(MCP_CONFIRM_ACTION_TOOL_NAME, { message_id: 'm2', action_index: 0, action_type: 'answer_evidence_request', applied: true, evidence_request_status: 'replied', recode: { applied: true }, result: { secret: 'x' } }),
    { message_id: 'm2', action_index: 0, action_type: 'answer_evidence_request', applied: true, evidence_request_status: 'replied', recode_applied: true }
  );
  assert.deepEqual(
    resultMetaFor(MCP_CONFIRM_ACTION_TOOL_NAME, { message_id: 'm2', action_index: 1, action_type: 'record_mileage', applied: false, outcome: 'not_applied', reason: 'text' }),
    { message_id: 'm2', action_index: 1, action_type: 'record_mileage', applied: false, outcome: 'not_applied' }
  );
});

test('the five plan-§5 tools are present by name', () => {
  for (const name of ['entity_list', 'close_status', 'unmatched_items', 'document_status', 'audit_recent']) {
    assert.ok(findMcpTool(name), `missing tool ${name}`);
  }
  assert.equal(findMcpTool('ledger_commit'), null);
});

test('MCP_ENTITY_EXPOSE is auto-forbidden on the config plane (no blanket firm-default exposure)', () => {
  assert.ok(AUTO_FORBIDDEN_FLAGS.has(MCP_ENTITY_EXPOSE_FLAG_KEY));
});

// ── Exposure gate ──────────────────────────────────────────────────────────

const fakeDbDeps = ({ clients = [], stagesByClient = {} } = {}) => ({
  withFirmDbClient: async (fn) =>
    fn({
      query: async (sql) => {
        if (/from clients/.test(sql)) return { rows: clients };
        throw new Error(`unexpected query: ${sql}`);
      }
    }),
  readClientConfigSnapshot: async (_db, { clientId }) => {
    const stage = stagesByClient[clientId];
    return stage ? { [MCP_ENTITY_EXPOSE_FLAG_KEY]: { stage, source: 'manual' } } : {};
  },
  env: {}
});

test('listExposedEntities: no flag row ⇒ not exposed (fail-closed default)', async () => {
  const deps = fakeDbDeps({
    clients: [{ id: 'a', company_name: 'Alpha', status: 'active', profile: {} }]
  });
  const exposed = await listExposedEntities({ firmId: 'f1', deps });
  assert.deepEqual(exposed, []);
});

test('listExposedEntities: only acting stages expose (shadow/dry_run/off do not)', async () => {
  const clients = ['a', 'b', 'c', 'd', 'e'].map((id) => ({
    id, company_name: id.toUpperCase(), status: 'active', profile: { jurisdiction: 'GB' }
  }));
  const deps = fakeDbDeps({
    clients,
    stagesByClient: { a: 'canary', b: 'auto', c: 'shadow', d: 'dry_run', e: 'off' }
  });
  const exposed = await listExposedEntities({ firmId: 'f1', deps });
  assert.deepEqual(exposed.map((e) => e.id), ['a', 'b']);
  assert.equal(exposed[0].jurisdiction, 'GB');
});

test('listExposedEntities: CLIENT_CONFIG_FORCE_DISABLE kills exposure everywhere', async () => {
  const deps = fakeDbDeps({
    clients: [{ id: 'a', company_name: 'Alpha', status: 'active', profile: {} }],
    stagesByClient: { a: 'canary' }
  });
  deps.env = { CLIENT_CONFIG_FORCE_DISABLE: MCP_ENTITY_EXPOSE_FLAG_KEY };
  const exposed = await listExposedEntities({ firmId: 'f1', deps });
  assert.deepEqual(exposed, []);
});

// ── Executors ──────────────────────────────────────────────────────────────

const feedFixture = ({ clientId = 'a', blockers = 2, infoNeeded = 1, confirmable = 1, cleared = 3 } = {}) => {
  const item = (kind, disposition, i, blocksClose) => ({
    kind,
    source_id: `${disposition}-${i}`,
    client_id: clientId,
    transaction_id: `tx-${disposition}-${i}`,
    transaction_date: '2026-08-01',
    amount: -10 * (i + 1),
    currency: 'GBP',
    descriptor: `Item ${disposition} ${i}`,
    counterparty: null,
    reason: null,
    verdict: { disposition, blocks_close: blocksClose }
  });
  return {
    buckets: {
      auto_cleared: Array.from({ length: cleared }, (_, i) => item('reconciliation_match', 'auto_cleared', i, false)),
      confirmable: Array.from({ length: confirmable }, (_, i) => item('reconciliation_match', 'confirmable', i, false)),
      operator_blocker: Array.from({ length: blockers }, (_, i) => item('review_item', 'operator_blocker', i, true)),
      client_info_needed: Array.from({ length: infoNeeded }, (_, i) => item('client_evidence_request', 'client_info_needed', i, false))
    },
    totals: {},
    generated_at: '2026-08-20T00:00:00.000Z'
  };
};

const feedDeps = (feed) => ({
  getAuthorizedFirmSnapshotFromDb: async () => ({
    firm: { id: 'f1' },
    clients: [{ id: 'a', company_name: 'Alpha' }],
    transactions: [],
    documents: [],
    reconciliationMatches: [],
    transactionReviewQueue: [],
    clientEvidenceRequests: []
  }),
  getAskBatchDraftsForFirmFromDb: async () => [],
  buildFirmFeed: () => feed
});

const ENTITIES = [{ id: 'a', name: 'Alpha', jurisdiction: 'GB', accounting_basis: null }];

test('runCloseStatus: totals + blockers from the feed projection, capped and compact', async () => {
  const result = await runCloseStatus({
    firmId: 'f1',
    auth: { type: 'access_token' },
    entities: ENTITIES,
    args: { entity_id: 'a' },
    deps: feedDeps(feedFixture())
  });
  assert.equal(result.entity.id, 'a');
  assert.equal(result.totals.operator_blocker, 2);
  assert.equal(result.totals.client_info_needed, 1);
  assert.equal(result.totals.blocks_close, 2);
  assert.equal(result.open_owner_asks, 1);
  assert.equal(result.blockers.length, 3);
  assert.equal(result.blockers_truncated, false);
  // compact projection, not the raw row
  for (const b of result.blockers) {
    assert.deepEqual(
      Object.keys(b).sort(),
      ['amount', 'blocks_close', 'counterparty', 'currency', 'date', 'descriptor', 'disposition', 'document_id', 'entity_id', 'kind', 'reason', 'transaction_id']
    );
  }
});

test('runCloseStatus: blocker list truncates at the cap and says so', async () => {
  const result = await runCloseStatus({
    firmId: 'f1',
    auth: { type: 'access_token' },
    entities: ENTITIES,
    args: { entity_id: 'a' },
    deps: feedDeps(feedFixture({ blockers: MCP_MAX_BLOCKERS + 10 }))
  });
  assert.equal(result.blockers.length, MCP_MAX_BLOCKERS);
  assert.equal(result.blockers_truncated, true);
});

test('runUnmatchedItems: paginates open (non-auto-cleared) work with bounded page size', async () => {
  const deps = feedDeps(feedFixture({ blockers: 30, infoNeeded: 20, confirmable: 10 }));
  const page1 = await runUnmatchedItems({
    firmId: 'f1', auth: { type: 'access_token' }, entities: ENTITIES,
    args: { entity_id: 'a' }, deps
  });
  assert.equal(page1.total, 60);
  assert.equal(page1.page, 1);
  assert.equal(page1.page_size, MCP_DEFAULT_PAGE_SIZE);
  assert.equal(page1.items.length, MCP_DEFAULT_PAGE_SIZE);
  assert.equal(page1.has_more, true);

  const big = await runUnmatchedItems({
    firmId: 'f1', auth: { type: 'access_token' }, entities: ENTITIES,
    args: { entity_id: 'a', page: 1, page_size: 500 }, deps
  });
  assert.equal(big.page_size, MCP_MAX_PAGE_SIZE, 'page_size must clamp to the cap');

  const last = await runUnmatchedItems({
    firmId: 'f1', auth: { type: 'access_token' }, entities: ENTITIES,
    args: { entity_id: 'a', page: 3, page_size: 25 }, deps
  });
  assert.equal(last.items.length, 10);
  assert.equal(last.has_more, false);
});

test('runDocumentStatus: open requests grouped per exposed entity; scope filter works', async () => {
  const rows = [
    { id: 'r1', client_id: 'a', transaction_id: 'tx1', evidence_type: 'supporting_document', question: 'What was this £120 charge?', first_sent_at: null, last_sent_at: null, send_count: 1, due_at: null, created_at: '2026-08-10' }
  ];
  const deps = {
    withFirmDbClient: async (fn) => fn({ query: async () => ({ rows }) })
  };
  const result = await runDocumentStatus({ firmId: 'f1', entities: ENTITIES, args: {}, deps });
  assert.equal(result.open_requests, 1);
  assert.equal(result.entities.length, 1);
  assert.equal(result.entities[0].requests[0].question, 'What was this £120 charge?');

  const empty = await runDocumentStatus({ firmId: 'f1', entities: [], args: {}, deps });
  assert.deepEqual(empty, { entities: [], open_requests: 0 });
});

test('runAuditRecent: scoped to exposed entities only, limit clamped', async () => {
  let captured = null;
  const deps = {
    withFirmDbClient: async (fn) =>
      fn({
        query: async (sql, params) => {
          captured = { sql, params };
          return { rows: [{ client_id: 'a', actor_type: 'system', actor_id: null, action: 'x', resource_type: null, resource_id: null, created_at: '2026-08-20' }] };
        }
      })
  };
  const result = await runAuditRecent({ firmId: 'f1', entities: ENTITIES, args: { limit: 5000 }, deps });
  assert.equal(result.count, 1);
  assert.deepEqual(captured.params[1], ['a'], 'audit read must be scoped to the exposed set');
  assert.ok(captured.params[2] <= 50, 'limit must clamp');

  const none = await runAuditRecent({ firmId: 'f1', entities: [], args: {}, deps });
  assert.deepEqual(none, { events: [], count: 0 });
});

// ── The receipt ────────────────────────────────────────────────────────────

test('recordMcpToolReceipt: external_model attribution, sanitized args, and failure propagates', async () => {
  let inserted = null;
  const okDeps = {
    withFirmDbClient: async (fn) =>
      fn({ query: async (sql, params) => { inserted = { sql, params }; return { rows: [] }; } })
  };
  const receiptId = await recordMcpToolReceipt({
    firmId: 'f1',
    clientId: 'a',
    tool: 'close_status',
    args: { entity_id: 'a', free_text: 'ignore me; DROP TABLE' },
    resultMeta: { blocks_close: 2 },
    deps: okDeps
  });
  assert.ok(receiptId);
  assert.match(inserted.sql, /insert into audit_events/);
  assert.equal(inserted.params[2], MCP_ACTOR_TYPE);
  assert.equal(inserted.params[3], MCP_ACTOR_ID, 'no surface passed ⇒ the local shim\'s id, byte-identical to before');
  const metadata = JSON.parse(inserted.params[6]);
  assert.equal(metadata.args.entity_id, 'a');
  assert.equal('free_text' in metadata.args, false, 'unknown args must not reach the receipt');
  assert.equal(metadata.surface, 'claude_desktop_mcp');
  assert.equal(metadata.principal, null);
  assert.equal(metadata.model_id, null);

  // A hosted surface: its own actor_id, the authorizing principal, and the
  // (absent, on the read tier) proposing model id — all on the row.
  await recordMcpToolReceipt({
    firmId: 'f1', clientId: 'a', tool: 'close_status', args: { entity_id: 'a' },
    surface: MCP_SURFACES.chatgpt_app,
    principal: { type: 'supabase_user', id: 'user-9' },
    modelId: null,
    deps: okDeps
  });
  assert.equal(inserted.params[3], 'chatgpt_app');
  const hosted = JSON.parse(inserted.params[6]);
  assert.equal(hosted.surface, 'chatgpt_app');
  assert.equal(hosted.transport, 'remote_streamable_http');
  assert.deepEqual(hosted.principal, { type: 'supabase_user', id: 'user-9' });
  assert.equal(hosted.model_id, null);

  // An unregistered surface object never mints a made-up actor: it falls back
  // to the default rather than trusting the caller's string.
  await recordMcpToolReceipt({
    firmId: 'f1', tool: 'entity_list', args: {},
    surface: { id: 'made_up', actor_id: 'made_up' },
    deps: okDeps
  });
  assert.equal(inserted.params[3], MCP_ACTOR_ID);

  await assert.rejects(
    recordMcpToolReceipt({
      firmId: 'f1', tool: 'close_status', args: {},
      deps: { withFirmDbClient: async () => { throw new Error('db down'); } }
    }),
    /db down/,
    'a receipt failure must propagate — no receipt, no data'
  );
});

test('resultMetaFor summarizes counts only', () => {
  assert.deepEqual(resultMetaFor('entity_list', { count: 2 }), { entities: 2 });
  assert.deepEqual(
    resultMetaFor('unmatched_items', { total: 9, page: 2, items: [1, 2] }),
    { total: 9, page: 2, returned: 2 }
  );
  assert.deepEqual(resultMetaFor('nope', {}), {});
});

test('MCP_SURFACES: one actor id per surface, the local shim is the default, principals are compact', () => {
  assert.deepEqual(Object.keys(MCP_SURFACES).sort(), ['chatgpt_app', 'claude_desktop_mcp', 'claude_remote']);
  for (const [key, surface] of Object.entries(MCP_SURFACES)) {
    assert.equal(surface.id, key);
    assert.equal(surface.actor_id, key, 'actor_id equals the surface id — one vocabulary');
    assert.ok(surface.transport && surface.label);
  }
  assert.deepEqual(receiptPrincipalFor({ type: 'supabase_user', userId: 'u1', email: 'a@b.c' }), { type: 'supabase_user', id: 'u1' });
  assert.deepEqual(receiptPrincipalFor({ type: 'access_token' }), { type: 'access_token', id: null });
  assert.equal(receiptPrincipalFor(null), null);
  const serialized = JSON.stringify(receiptPrincipalFor({ type: 'supabase_user', userId: 'u1', email: 'a@b.c' }));
  assert.doesNotMatch(serialized, /a@b\.c/, 'the email never rides the receipt');
});

test('every registry tool carries a title for the hosted listings', () => {
  for (const tool of MCP_TOOLS) assert.ok(typeof tool.title === 'string' && tool.title.length > 0, tool.name);
});


test('the MCP Apps card is data on the registry: close_status and ask_donna name the one ui:// resource; no other tool does', async () => {
  const { MCP_TOOLS_WITH_CARDS, MCP_UI_CARDS_RESOURCE_URI } = await import('./mcpReadSurface.js');
  assert.equal(MCP_UI_CARDS_RESOURCE_URI, 'ui://donna-books/cards');
  assert.deepEqual([...MCP_TOOLS_WITH_CARDS], ['close_status', 'ask_donna']);
  for (const tool of MCP_TOOLS) {
    if (MCP_TOOLS_WITH_CARDS.includes(tool.name)) assert.deepEqual(tool.ui, { resource_uri: MCP_UI_CARDS_RESOURCE_URI }, tool.name);
    else assert.ok(!('ui' in tool), `${tool.name} has no card`);
  }
  // The act tool has no card: the ask card calls it; it renders as text.
  assert.ok(!('ui' in findMcpTool(MCP_CONFIRM_ACTION_TOOL_NAME)));
});
