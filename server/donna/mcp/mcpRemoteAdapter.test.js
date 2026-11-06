// Hosted MCP endpoint — adapter tests (docs/design-donna-chatgpt-app-build-brief.md §5 slice 1).
//
// Load-bearing properties:
//   - the adapter is a TRANSLATION over the funnel: every live tools/call runs
//     invokeMcpTool (this file uses the REAL funnel with stubbed reads), so
//     the receipt-as-precondition, the no-existence-leak and the closed
//     registry hold on the remote path exactly as on the local one;
//   - auth fails closed: no principal ⇒ 401 with the RFC 9728 challenge; the
//     adapter never decides auth itself;
//   - demo and live never mix: the demo path touches no DB/auth/receipt and
//     every answer is demo-labeled; the live path never serves a fixture;
//   - the adapter reaches only registry tools and imports no writer (source pin);
//   - both protocol eras are served: legacy `initialize` (2025-03-26 … 11-25)
//     and modern per-request `_meta` (2026-07-28) with header validation.

import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve as resolvePath } from 'node:path';

import {
  MCP_DEMO_NOTICE_HOSTED,
  MCP_LEGACY_PROTOCOL_VERSIONS,
  MCP_REMOTE_INSTRUCTIONS_DEMO,
  MCP_REMOTE_INSTRUCTIONS_LIVE,
  MCP_SUPPORTED_PROTOCOL_VERSIONS,
  classifyMcpRemotePath,
  handleMcpRemoteRequest,
  isMcpRemotePath,
  toRemoteMcpTool
} from './mcpRemoteAdapter.js';
import { MCP_SURFACES, MCP_TOOLS, MCP_ACTOR_ID, MCP_READ_TOOLS, MCP_TOOLS_WITH_CARDS, MCP_UI_CARDS_RESOURCE_URI } from './mcpReadSurface.js';
import { MCP_UI_EXTENSION_ID, MCP_UI_MIME_TYPE, claudeMcpAppDomainFor } from './mcpAppCards.js';
import { MCP_APP_CARDS_HTML } from './mcpAppCardsHtml.js';
import { DEMO_ENTITY_ID } from '../../../desktop/mcpb/server/demoFixtures.mjs';
import { DEMO_ASK_DONNA_CONFIRM_VIA } from '../../../desktop/mcpb/server/demoAskDonna.mjs';

const here = dirname(fileURLToPath(import.meta.url));

// ── Harness ────────────────────────────────────────────────────────────────

const makeRes = () => ({
  statusCode: 0,
  headers: {},
  raw: null,
  setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
  end(payload) { this.raw = payload == null ? '' : String(payload); },
  get body() { return this.raw ? JSON.parse(this.raw) : null; }
});

const makeReq = ({ method = 'POST', path, body = null, headers = {} } = {}) => {
  const raw = body == null ? '' : (typeof body === 'string' ? body : JSON.stringify(body));
  const req = Readable.from(raw ? [Buffer.from(raw)] : []);
  req.method = method;
  req.headers = { host: 'donna.example', 'x-forwarded-proto': 'https', ...headers };
  req.url = path;
  return req;
};

const urlFor = (path) => new URL(path, 'http://localhost');

const LIVE_CHATGPT = '/api/donna/mcp/remote/chatgpt';
const LIVE_CLAUDE = '/api/donna/mcp/remote/claude';
const DEMO = '/api/donna/mcp/demo';

const rpc = (id, method, params) => ({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) });

// The funnel's injectable reads (same shape as mcpApi.test.js) — the adapter
// passes them straight through as funnelDeps.
const funnelDeps = (overrides = {}) => ({
  isFirmDatabaseConfigured: () => true,
  assertFirmAccess: async () => ({ principal: { unrestricted: true }, allowedClientIds: null }),
  listExposedEntities: async () => [{ id: 'a', name: 'Alpha', jurisdiction: 'GB', accounting_basis: null }],
  recordMcpToolReceipt: async () => 'receipt-1',
  executors: {
    entity_list: async ({ entities }) => ({ entities, count: entities.length }),
    close_status: async ({ args }) => ({ entity: { id: args.entity_id }, totals: { blocks_close: 0 }, blockers: [] }),
    unmatched_items: async () => ({ total: 0, page: 1, items: [] }),
    document_status: async () => ({ entities: [], open_requests: 0 }),
    audit_recent: async () => ({ events: [], count: 0 }),
    ask_donna: async ({ args, surface }) => ({
      entity: { id: args.entity_id, name: 'Alpha' },
      message_id: 'msg-2',
      user_message_id: 'msg-1',
      surface: surface.id,
      applied: false,
      text: 'Not fully. One receipt is still missing; confirm the answer in your Donna portal.',
      actions: [{ index: 0, type: 'answer_evidence_request', summary: 's', evidence_request_id: 'ask-1', requires_confirmation: true }],
      model_id: 'claude-donna-test'
    }),
    confirm_action: async ({ args, surface }) => ({
      entity: { id: args.entity_id, name: 'Alpha' },
      message_id: args.message_id,
      action_index: args.action_index,
      action_type: 'answer_evidence_request',
      surface: surface.id,
      applied: true,
      result: { evidence_request_id: 'ask-1', evidence_request_status: 'replied', recode: { applied: true } },
      evidence_request_status: 'replied',
      recode: { applied: true }
    })
  },
  executorDeps: {},
  ...overrides
});

const OWNER_AUTH = { type: 'supabase_user', userId: 'user-9', email: 'owner@example.test', staff: false };

const baseDeps = (overrides = {}) => ({
  resolveAuth: async () => OWNER_AUTH,
  funnelDeps: funnelDeps(),
  env: { MCP_REMOTE_OAUTH_ISSUER: 'https://ref.supabase.co/auth/v1' },
  log: () => {},
  ...overrides
});

const call = async ({ method = 'POST', path, body, headers, deps }) => {
  const res = makeRes();
  await handleMcpRemoteRequest(makeReq({ method, path, body, headers }), res, urlFor(path), deps);
  return res;
};

const MODERN_META = {
  'io.modelcontextprotocol/protocolVersion': '2026-07-28',
  'io.modelcontextprotocol/clientInfo': { name: 'TestHost', version: '1.0.0' },
  'io.modelcontextprotocol/clientCapabilities': {}
};
const modernHeaders = (method, name) => ({
  'mcp-protocol-version': '2026-07-28',
  'mcp-method': method,
  ...(name ? { 'mcp-name': name } : {})
});

// ── Paths and surfaces ─────────────────────────────────────────────────────

test('paths classify into live surfaces, demo, and protected-resource metadata', () => {
  assert.equal(classifyMcpRemotePath(LIVE_CHATGPT).surface, MCP_SURFACES.chatgpt_app);
  assert.equal(classifyMcpRemotePath(LIVE_CLAUDE).surface, MCP_SURFACES.claude_remote);
  assert.equal(classifyMcpRemotePath('/api/donna/mcp/remote/other').surface, null);
  assert.equal(classifyMcpRemotePath(DEMO).mode, 'demo');
  assert.equal(classifyMcpRemotePath(`${DEMO}/claude`).surface, MCP_SURFACES.claude_remote);
  assert.equal(classifyMcpRemotePath('/api/donna/mcp/oauth-protected-resource/api/donna/mcp/remote/chatgpt').mode, 'protected_resource');
  // The LOCAL shim route is not this adapter's.
  assert.equal(isMcpRemotePath('/api/donna/mcp/v1/tools'), false);
  assert.equal(isMcpRemotePath('/api/donna/mcp/v1/call'), false);
  assert.equal(isMcpRemotePath('/api/donna/firms/snapshot'), false);
});

test('the per-surface actor ids are distinct from the local shim and from each other', () => {
  const ids = new Set(Object.values(MCP_SURFACES).map((s) => s.actor_id));
  assert.equal(ids.size, Object.keys(MCP_SURFACES).length);
  assert.notEqual(MCP_SURFACES.chatgpt_app.actor_id, MCP_ACTOR_ID);
  assert.notEqual(MCP_SURFACES.claude_remote.actor_id, MCP_ACTOR_ID);
  assert.equal(MCP_ACTOR_ID, 'claude_desktop_mcp', 'the local shim keeps its id');
});

test('an unknown surface segment is 404, live or demo', async () => {
  for (const path of ['/api/donna/mcp/remote/bing', '/api/donna/mcp/demo/bing']) {
    const res = await call({ path, body: rpc(1, 'ping'), deps: baseDeps() });
    assert.equal(res.statusCode, 404, path);
    assert.equal(res.body.code, 'MCP_SURFACE_UNKNOWN');
  }
});

// ── Auth fails closed ──────────────────────────────────────────────────────

test('live without a principal ⇒ 401 with the RFC 9728 resource_metadata challenge', async () => {
  let resolverCalled = 0;
  const res = await call({
    path: LIVE_CHATGPT,
    body: rpc(1, 'initialize', { protocolVersion: '2025-06-18' }),
    deps: baseDeps({ resolveAuth: async () => { resolverCalled += 1; return null; } })
  });
  assert.equal(resolverCalled, 1, 'auth is resolved by the injected resolver, never decided locally');
  assert.equal(res.statusCode, 401);
  assert.equal(res.body.code, 'AUTH_REQUIRED');
  assert.equal(
    res.headers['www-authenticate'],
    'Bearer resource_metadata="https://donna.example/api/donna/mcp/oauth-protected-resource/api/donna/mcp/remote/chatgpt"'
  );
  assert.equal(res.raw.includes('demo'), false, 'a live refusal is never demo');
});

test('a rejected bearer ⇒ 401 invalid_token, still with the challenge', async () => {
  const res = await call({
    path: LIVE_CLAUDE,
    headers: { authorization: 'Bearer nope' },
    body: rpc(1, 'ping'),
    deps: baseDeps({ resolveAuth: async () => null })
  });
  assert.equal(res.statusCode, 401);
  assert.match(res.headers['www-authenticate'], /^Bearer error="invalid_token"/);
  assert.match(res.headers['www-authenticate'], /resource_metadata="https:\/\/donna\.example\/api\/donna\/mcp\/oauth-protected-resource\/api\/donna\/mcp\/remote\/claude"/);
});

test('mounted without an auth resolver the live path refuses (never open)', async () => {
  const res = await call({ path: LIVE_CHATGPT, body: rpc(1, 'ping'), deps: baseDeps({ resolveAuth: null }) });
  assert.equal(res.statusCode, 500);
  assert.equal(res.body.code, 'MCP_AUTH_RESOLVER_MISSING');
});

test('PUBLIC_APP_URL wins over forwarded headers for the challenge and metadata URLs', async () => {
  const res = await call({
    path: LIVE_CHATGPT,
    body: rpc(1, 'ping'),
    deps: baseDeps({ resolveAuth: async () => null, publicOrigin: () => 'https://app.donna.test/' })
  });
  assert.match(res.headers['www-authenticate'], /resource_metadata="https:\/\/app\.donna\.test\/api\/donna\/mcp\/oauth-protected-resource\/api\/donna\/mcp\/remote\/chatgpt"/);
});

// ── Transport mechanics ────────────────────────────────────────────────────

test('GET and DELETE answer 405; batches, non-JSON and oversize bodies are refused', async () => {
  for (const method of ['GET', 'DELETE']) {
    const res = await call({ method, path: LIVE_CHATGPT, deps: baseDeps() });
    assert.equal(res.statusCode, 405, method);
    assert.equal(res.headers.allow, 'POST');
  }
  const batch = await call({ path: LIVE_CHATGPT, body: [rpc(1, 'ping'), rpc(2, 'ping')], deps: baseDeps() });
  assert.equal(batch.statusCode, 400);
  assert.equal(batch.body.error.code, -32600);
  const junk = await call({ path: LIVE_CHATGPT, body: '{not json', deps: baseDeps() });
  assert.equal(junk.statusCode, 400);
  assert.equal(junk.body.error.code, -32700);
  const huge = await call({ path: DEMO, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping', pad: 'x'.repeat(70_000) }), deps: baseDeps() });
  assert.equal(huge.statusCode, 413);
});

test('a notification is accepted with 202 and no body', async () => {
  const res = await call({ path: LIVE_CHATGPT, body: { jsonrpc: '2.0', method: 'notifications/initialized' }, deps: baseDeps() });
  assert.equal(res.statusCode, 202);
  assert.equal(res.raw, '');
});

// ── Legacy era (initialize handshake) ──────────────────────────────────────

test('legacy initialize echoes a supported version, negotiates unknown ones down, and names the surface honestly', async () => {
  const echo = await call({ path: LIVE_CHATGPT, body: rpc(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'ChatGPT' } }), deps: baseDeps() });
  assert.equal(echo.statusCode, 200);
  assert.equal(echo.body.result.protocolVersion, '2025-06-18');
  assert.equal(echo.body.result.serverInfo.name, 'donna-books');
  assert.equal(echo.body.result.instructions, MCP_REMOTE_INSTRUCTIONS_LIVE);
  assert.equal('resultType' in echo.body.result, false, 'legacy results carry no modern fields');

  const down = await call({ path: LIVE_CHATGPT, body: rpc(2, 'initialize', { protocolVersion: '1900-01-01' }), deps: baseDeps() });
  assert.equal(down.body.result.protocolVersion, MCP_LEGACY_PROTOCOL_VERSIONS[0]);

  const modernOnly = await call({ path: LIVE_CHATGPT, body: rpc(3, 'server/discover'), deps: baseDeps() });
  assert.equal(modernOnly.body.error.code, -32601, 'server/discover is a modern-era method');
});

test('tools/list is the hosted registry 1:1 with honest annotations and titles, on both surfaces and both eras', async () => {
  const listings = [
    await call({ path: LIVE_CHATGPT, body: rpc(1, 'tools/list'), deps: baseDeps() }),
    await call({ path: LIVE_CLAUDE, body: rpc(1, 'tools/list'), deps: baseDeps() }),
    await call({ path: LIVE_CHATGPT, body: rpc(1, 'tools/list', { _meta: MODERN_META }), headers: modernHeaders('tools/list'), deps: baseDeps() })
  ];
  for (const res of listings) {
    assert.equal(res.statusCode, 200);
    const tools = res.body.result.tools;
    assert.deepEqual(tools.map((t) => t.name), MCP_TOOLS.map((t) => t.name), 'both hosted surfaces list the same set, ask_donna included');
    for (const tool of tools) {
      assert.ok(tool.title, `${tool.name} carries a title`);
      assert.equal(tool.annotations.destructiveHint, false);
      assert.equal(tool.annotations.openWorldHint, false);
      assert.equal(tool.inputSchema.additionalProperties, false);
      const registry = MCP_TOOLS.find((t) => t.name === tool.name);
      assert.equal(tool.annotations.readOnlyHint, registry.tier === 'read', `${tool.name}: readOnlyHint is the tier, honestly`);
      assert.equal(tool.annotations.idempotentHint, registry.tier === 'read');
    }
    const ask = tools.find((t) => t.name === 'ask_donna');
    assert.equal(ask.annotations.readOnlyHint, false, 'ask_donna persists a message: both hosts key their confirmation on this being absent/false');
    assert.equal(ask.annotations.destructiveHint, false);
    assert.deepEqual(ask.inputSchema.required, ['entity_id', 'message']);
    // The write tool: listed on both hosted surfaces, both eras, with
    // readOnlyHint false (the hosts' confirmation prompt keys on it — brief
    // §8 F2/F3), never destructive, and a title (Claude's review criteria).
    const confirm = tools.find((t) => t.name === 'confirm_action');
    assert.ok(confirm, 'confirm_action is listed');
    assert.equal(confirm.annotations.readOnlyHint, false);
    assert.equal(confirm.annotations.destructiveHint, false);
    assert.equal(confirm.annotations.idempotentHint, false);
    assert.equal(confirm.annotations.title, 'Confirm a proposed action');
    assert.deepEqual(confirm.inputSchema.required, ['entity_id', 'message_id', 'action_index']);
    for (const read of MCP_READ_TOOLS) assert.equal(tools.find((t) => t.name === read.name).annotations.readOnlyHint, true);
  }
  assert.deepEqual(Object.keys(toRemoteMcpTool(MCP_TOOLS[0])).sort(), ['annotations', 'description', 'inputSchema', 'name', 'title']);
});

// ── MCP Apps (slice 4): the card resource and the tool metadata ────────────

test('tools/list carries _meta.ui.resourceUri on close_status and ask_donna only: always in the legacy era, in the modern era only when the host declared the extension', async () => {
  const legacy = await call({ path: LIVE_CHATGPT, body: rpc(1, 'tools/list'), deps: baseDeps() });
  const withExt = await call({
    path: LIVE_CLAUDE,
    body: rpc(1, 'tools/list', { _meta: { ...MODERN_META, 'io.modelcontextprotocol/clientCapabilities': { extensions: { [MCP_UI_EXTENSION_ID]: { mimeTypes: [MCP_UI_MIME_TYPE] } } } } }),
    headers: modernHeaders('tools/list'),
    deps: baseDeps()
  });
  for (const res of [legacy, withExt]) {
    for (const tool of res.body.result.tools) {
      if (MCP_TOOLS_WITH_CARDS.includes(tool.name)) {
        assert.equal(tool._meta.ui.resourceUri, MCP_UI_CARDS_RESOURCE_URI, tool.name);
        assert.equal(tool._meta['ui/resourceUri'], MCP_UI_CARDS_RESOURCE_URI, `${tool.name}: the SDK's legacy flat key too`);
      } else {
        assert.ok(!('_meta' in tool), `${tool.name} carries no _meta`);
      }
    }
  }
  // A modern host WITHOUT the extension lists text-only tools (the spec's fallback).
  const without = await call({ path: LIVE_CLAUDE, body: rpc(1, 'tools/list', { _meta: MODERN_META }), headers: modernHeaders('tools/list'), deps: baseDeps() });
  for (const tool of without.body.result.tools) assert.ok(!('_meta' in tool), `${tool.name}: no card for a text-only host`);
  // The demo lists the same metadata (same cards over fixtures).
  const demo = await call({ path: DEMO, body: rpc(1, 'tools/list'), deps: baseDeps({ funnelDeps: poisonedFunnel() }) });
  assert.equal(demo.body.result.tools.find((t) => t.name === 'close_status')._meta.ui.resourceUri, MCP_UI_CARDS_RESOURCE_URI);
  // Capabilities declare resources (no subscribe, no listChanged) beside tools, both eras.
  const init = await call({ path: LIVE_CHATGPT, body: rpc(1, 'initialize', { protocolVersion: '2025-06-18' }), deps: baseDeps() });
  assert.deepEqual(init.body.result.capabilities, { tools: { listChanged: false }, resources: { subscribe: false, listChanged: false } });
  const discover = await call({ path: LIVE_CHATGPT, body: rpc(1, 'server/discover', { _meta: MODERN_META }), headers: modernHeaders('server/discover'), deps: baseDeps() });
  assert.deepEqual(discover.body.result.capabilities, { tools: { listChanged: false }, resources: { subscribe: false, listChanged: false } });
});

test('resources/list and resources/read serve ONLY the bundled ui:// card resource: static content, never the funnel, no receipt; Claude’s domain hashes the request’s own URL on the Claude surface only', async () => {
  let funnelCalls = 0;
  let receipts = 0;
  const deps = baseDeps({
    publicOrigin: () => 'https://app.donna.test',
    invokeMcpTool: async () => { funnelCalls += 1; throw new Error('the funnel must not be reached by a resource method'); },
    funnelDeps: funnelDeps({ recordMcpToolReceipt: async () => { receipts += 1; return 'r'; } })
  });
  for (const [path, era] of [[LIVE_CLAUDE, 'legacy'], [LIVE_CHATGPT, 'legacy'], [LIVE_CLAUDE, 'modern'], [DEMO, 'legacy'], [`${DEMO}/claude`, 'legacy']]) {
    const modern = era === 'modern';
    const list = await call({ path, body: rpc(1, 'resources/list', modern ? { _meta: MODERN_META } : undefined), headers: modern ? modernHeaders('resources/list') : {}, deps });
    assert.equal(list.statusCode, 200, `${path} ${era}`);
    const resources = list.body.result.resources;
    assert.equal(resources.length, 1, 'exactly one resource');
    assert.equal(resources[0].uri, MCP_UI_CARDS_RESOURCE_URI);
    assert.equal(resources[0].mimeType, MCP_UI_MIME_TYPE);
    assert.deepEqual(resources[0]._meta.ui.csp, { connectDomains: [], resourceDomains: [], frameDomains: [], baseUriDomains: [] });
    const expectedDomain = path.endsWith('/claude') ? claudeMcpAppDomainFor(`https://app.donna.test${path}`) : undefined;
    assert.equal(resources[0]._meta.ui.domain, expectedDomain, `${path}: the domain hashes exactly the URL the host registered, Claude surface only`);
    if (modern) assert.equal(list.body.result.resultType, 'complete');
    const read = await call({ path, body: rpc(2, 'resources/read', { uri: MCP_UI_CARDS_RESOURCE_URI, ...(modern ? { _meta: MODERN_META } : {}) }), headers: modern ? modernHeaders('resources/read') : {}, deps });
    assert.equal(read.statusCode, 200);
    const [content] = read.body.result.contents;
    assert.equal(content.uri, MCP_UI_CARDS_RESOURCE_URI);
    assert.equal(content.mimeType, MCP_UI_MIME_TYPE);
    assert.equal(content.text, MCP_APP_CARDS_HTML, 'the bundle, byte for byte, on every path');
    assert.equal(content._meta.ui.domain, expectedDomain);
    // Nothing else is ever served through the resource path.
    for (const uri of ['ui://donna-books/other', 'file:///etc/passwd', 'https://app.donna.test/api/donna/firms/snapshot', 'ui://']) {
      const other = await call({ path, body: rpc(3, 'resources/read', { uri }), deps });
      assert.equal(other.statusCode, 200);
      assert.equal(other.body.error.code, -32002, `${uri} is not found`);
      assert.equal(other.body.result, undefined);
    }
    const noUri = await call({ path, body: rpc(4, 'resources/read', {}), deps });
    assert.equal(noUri.body.error.code, -32602);
    const templates = await call({ path, body: rpc(5, 'resources/templates/list'), deps });
    assert.deepEqual(templates.body.result.resourceTemplates, []);
  }
  assert.equal(funnelCalls, 0, 'a resource method never reaches the funnel');
  assert.equal(receipts, 0, 'a resource read carries no book content and writes no receipt');
  // Without a resolvable origin there is no domain (never a guessed host).
  const bare = await call({ path: LIVE_CLAUDE, body: rpc(1, 'resources/list'), deps: baseDeps({ publicOrigin: () => '' }) });
  // (the test request still carries host + x-forwarded-proto headers, so the
  // forwarded origin resolves; strip them to see the no-origin case)
  assert.ok(bare.body.result.resources[0]._meta.ui.domain, 'forwarded headers resolve an origin');
  const res = makeRes();
  const req = makeReq({ path: LIVE_CLAUDE, body: rpc(1, 'resources/list') });
  req.headers = {};
  await handleMcpRemoteRequest(req, res, urlFor(LIVE_CLAUDE), baseDeps({ publicOrigin: () => '' }));
  assert.ok(!('domain' in res.body.result.resources[0]._meta.ui), 'no origin, no domain');
  // The live path still refuses an unauthenticated resource read (401 with the challenge).
  const anon = await call({ path: LIVE_CLAUDE, body: rpc(1, 'resources/read', { uri: MCP_UI_CARDS_RESOURCE_URI }), deps: baseDeps({ resolveAuth: async () => null }) });
  assert.equal(anon.statusCode, 401);
});

test('live ask_donna runs the funnel: surface + principal + Donna’s model id reach the receipt; proposals return requires_confirmation, nothing applied', async () => {
  let receipted = null;
  const deps = baseDeps({
    funnelDeps: funnelDeps({
      recordMcpToolReceipt: async (input) => { receipted = input; return 'receipt-ask'; }
    })
  });
  const res = await call({ path: LIVE_CLAUDE, body: rpc(9, 'tools/call', { name: 'ask_donna', arguments: { entity_id: 'a', message: 'Is the Shopify invoice paid?' } }), deps });
  assert.equal(res.statusCode, 200);
  const result = res.body.result;
  assert.equal(result.isError, undefined);
  assert.equal(result.structuredContent.message_id, 'msg-2');
  assert.equal(result.structuredContent.applied, false);
  assert.equal(result.structuredContent.actions[0].requires_confirmation, true);
  assert.equal(result.structuredContent.surface, 'claude_remote');
  assert.doesNotMatch(result.content[0].text, /DEMO DATA/);
  assert.equal(receipted.tool, 'ask_donna');
  assert.equal(receipted.surface, MCP_SURFACES.claude_remote);
  assert.deepEqual(receipted.principal, { type: 'supabase_user', id: 'user-9' });
  assert.equal(receipted.modelId, 'claude-donna-test', 'Donna’s own model id on the receipt');
  // A coded refusal from the executor reads as a tool outcome with its code.
  const refusing = baseDeps({
    funnelDeps: funnelDeps({
      executors: { ...funnelDeps().executors, ask_donna: async () => { throw Object.assign(new Error('Donna could not answer right now'), { statusCode: 502, code: 'DONNA_CHAT_UNAVAILABLE' }); } }
    })
  });
  const refused = await call({ path: LIVE_CLAUDE, body: rpc(10, 'tools/call', { name: 'ask_donna', arguments: { entity_id: 'a', message: 'hi' } }), deps: refusing });
  assert.equal(refused.body.result.isError, true);
  assert.match(refused.body.result.content[0].text, /DONNA_CHAT_UNAVAILABLE/);
});

test('live confirm_action runs the funnel: surface + principal reach the receipt with a NULL model id; the consequence returns; a refusal is an isError outcome naming the code', async () => {
  let receipted = null;
  const deps = baseDeps({
    funnelDeps: funnelDeps({
      recordMcpToolReceipt: async (input) => { receipted = input; return 'receipt-confirm'; }
    })
  });
  const args = { entity_id: 'a', message_id: 'clchat-a-assistant-1', action_index: 0 };
  const res = await call({ path: LIVE_CHATGPT, body: rpc(11, 'tools/call', { name: 'confirm_action', arguments: args }), deps });
  assert.equal(res.statusCode, 200);
  const result = res.body.result;
  assert.equal(result.isError, undefined);
  assert.equal(result.structuredContent.applied, true);
  assert.equal(result.structuredContent.evidence_request_status, 'replied');
  assert.equal(result.structuredContent.surface, 'chatgpt_app');
  assert.doesNotMatch(result.content[0].text, /DEMO DATA/);
  assert.equal(receipted.tool, 'confirm_action');
  assert.equal(receipted.surface, MCP_SURFACES.chatgpt_app);
  assert.deepEqual(receipted.principal, { type: 'supabase_user', id: 'user-9' });
  assert.equal(receipted.modelId, null, 'the owner applies; no model id on the act-tier receipt');
  // Refusals read as tool outcomes with their code (the model relays them).
  for (const [code, statusCode] of [['ACTION_TYPE_NOT_CONFIRMABLE', 400], ['CONFIRM_TARGET_NOT_FOUND', 404], ['ACTION_NOT_PROPOSED', 409]]) {
    const refusing = baseDeps({
      funnelDeps: funnelDeps({
        executors: { ...funnelDeps().executors, confirm_action: async () => { throw Object.assign(new Error('Donna refused'), { statusCode, code }); } }
      })
    });
    const refused = await call({ path: LIVE_CLAUDE, body: rpc(12, 'tools/call', { name: 'confirm_action', arguments: args }), deps: refusing });
    assert.equal(refused.statusCode, 200, 'a refused tool call is a tool outcome, not a transport failure');
    assert.equal(refused.body.result.isError, true);
    assert.match(refused.body.result.content[0].text, new RegExp(code));
  }
  // The modern era carries it too, with the mirrored headers.
  const modern = await call({
    path: LIVE_CLAUDE,
    body: rpc(13, 'tools/call', { name: 'confirm_action', arguments: args, _meta: MODERN_META }),
    headers: modernHeaders('tools/call', 'confirm_action'),
    deps
  });
  assert.equal(modern.statusCode, 200);
  assert.equal(modern.body.result.resultType, 'complete');
  assert.equal(modern.body.result.structuredContent.applied, true);
});

test('live tools/call runs the funnel: surface + principal reach the receipt, result returns as text + structuredContent', async () => {
  let receipted = null;
  const deps = baseDeps({
    funnelDeps: funnelDeps({
      recordMcpToolReceipt: async (input) => { receipted = input; return 'receipt-42'; }
    })
  });
  const res = await call({ path: LIVE_CHATGPT, body: rpc(7, 'tools/call', { name: 'close_status', arguments: { entity_id: 'a' } }), deps });
  assert.equal(res.statusCode, 200);
  const result = res.body.result;
  assert.equal(result.isError, undefined);
  assert.equal(result.structuredContent.entity.id, 'a');
  assert.match(result.content[0].text, /"id": "a"/);
  assert.doesNotMatch(result.content[0].text, /DEMO DATA/, 'a live answer is never demo-labeled');
  assert.equal(receipted.surface, MCP_SURFACES.chatgpt_app, 'the receipt names the surface the call came through');
  assert.deepEqual(receipted.principal, { type: 'supabase_user', id: 'user-9' });
  assert.equal(receipted.modelId, null, 'the read tier has no proposing model');
  assert.equal(receipted.tool, 'close_status');
  assert.equal(receipted.clientId, 'a');

  const claude = await call({ path: LIVE_CLAUDE, body: rpc(8, 'tools/call', { name: 'entity_list', arguments: {} }), deps });
  assert.equal(claude.statusCode, 200);
  assert.equal(receipted.surface, MCP_SURFACES.claude_remote);
});

test('receipt failure ⇒ the result is NOT served (audit-as-precondition holds on the remote path)', async () => {
  const deps = baseDeps({
    funnelDeps: funnelDeps({ recordMcpToolReceipt: async () => { throw new Error('audit insert failed'); } })
  });
  const res = await call({ path: LIVE_CHATGPT, body: rpc(1, 'tools/call', { name: 'close_status', arguments: { entity_id: 'a' } }), deps });
  assert.equal(res.statusCode, 200, 'a refused tool call is a tool outcome, not a transport failure');
  const result = res.body.result;
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent, undefined, 'no data may leave on a failed receipt');
  assert.match(result.content[0].text, /MCP_INTERNAL/);
  assert.doesNotMatch(result.content[0].text, /"id": "a"/);
});

test('a non-exposed entity answers exactly like a nonexistent one on the remote path', async () => {
  const deps = baseDeps();
  const missing = await call({ path: LIVE_CHATGPT, body: rpc(1, 'tools/call', { name: 'close_status', arguments: { entity_id: 'no-such-entity' } }), deps });
  const unexposed = await call({ path: LIVE_CHATGPT, body: rpc(2, 'tools/call', { name: 'close_status', arguments: { entity_id: 'real-but-unexposed' } }), deps });
  assert.equal(missing.body.result.isError, true);
  assert.equal(unexposed.body.result.isError, true);
  assert.equal(
    missing.body.result.content[0].text.replace('no-such-entity', 'X'),
    unexposed.body.result.content[0].text.replace('real-but-unexposed', 'X')
  );
});

test('the adapter reaches only registry tools: unknown names are refused by the funnel, arguments are shape-checked', async () => {
  const deps = baseDeps();
  for (const name of ['ledger_commit', 'recategorize', 'answer_evidence_request', 'admin_chat', '']) {
    const res = await call({ path: LIVE_CHATGPT, body: rpc(1, 'tools/call', { name, arguments: {} }), deps });
    assert.equal(res.body.result?.isError ?? true, true, `${name || '<empty>'} is not a tool`);
  }
  const injected = await call({ path: LIVE_CHATGPT, body: rpc(1, 'tools/call', { name: 'close_status', arguments: { entity_id: 'a', sql: 'drop table' } }), deps });
  assert.equal(injected.body.result.isError, true);
  assert.match(injected.body.result.content[0].text, /INVALID_ARGUMENTS/);
  const noName = await call({ path: LIVE_CHATGPT, body: rpc(1, 'tools/call', { arguments: {} }), deps });
  assert.equal(noName.body.error.code, -32602);
});

test('firm-access denial reads as ACCESS_DENIED on the remote path', async () => {
  const deps = baseDeps({
    funnelDeps: funnelDeps({
      assertFirmAccess: async () => { const err = new Error('You do not have access to client a.'); err.statusCode = 403; throw err; }
    })
  });
  const res = await call({ path: LIVE_CHATGPT, body: rpc(1, 'tools/call', { name: 'close_status', arguments: { entity_id: 'a' } }), deps });
  assert.equal(res.body.result.isError, true);
  assert.match(res.body.result.content[0].text, /ACCESS_DENIED/);
});

// ── Modern era (2026-07-28 per-request metadata) ───────────────────────────

test('server/discover answers the modern era with supported versions and serverInfo in _meta', async () => {
  const res = await call({
    path: LIVE_CHATGPT,
    headers: modernHeaders('server/discover'),
    body: rpc('d-1', 'server/discover', { _meta: MODERN_META }),
    deps: baseDeps()
  });
  assert.equal(res.statusCode, 200);
  const result = res.body.result;
  assert.equal(result.resultType, 'complete');
  assert.deepEqual(result.supportedVersions, [...MCP_SUPPORTED_PROTOCOL_VERSIONS]);
  assert.ok(result.supportedVersions.includes('2026-07-28'));
  assert.ok(result.supportedVersions.includes('2025-06-18'));
  assert.equal(result._meta['io.modelcontextprotocol/serverInfo'].name, 'donna-books');
  assert.equal(result.instructions, MCP_REMOTE_INSTRUCTIONS_LIVE);
});

test('modern tools/call validates the mirrored headers and returns a resultType-complete result', async () => {
  const deps = baseDeps();
  const ok = await call({
    path: LIVE_CHATGPT,
    headers: modernHeaders('tools/call', 'close_status'),
    body: rpc(1, 'tools/call', { name: 'close_status', arguments: { entity_id: 'a' }, _meta: MODERN_META }),
    deps
  });
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.body.result.resultType, 'complete');
  assert.equal(ok.body.result.structuredContent.entity.id, 'a');
  assert.equal(ok.body.result._meta['io.modelcontextprotocol/serverInfo'].name, 'donna-books');

  const b64 = await call({
    path: LIVE_CHATGPT,
    headers: modernHeaders('tools/call', `=?base64?${Buffer.from('close_status').toString('base64')}?=`),
    body: rpc(1, 'tools/call', { name: 'close_status', arguments: { entity_id: 'a' }, _meta: MODERN_META }),
    deps
  });
  assert.equal(b64.statusCode, 200, 'the Base64 sentinel form of Mcp-Name is decoded before comparison');

  const missingMethod = await call({
    path: LIVE_CHATGPT,
    headers: { 'mcp-protocol-version': '2026-07-28' },
    body: rpc(1, 'tools/list', { _meta: MODERN_META }),
    deps
  });
  assert.equal(missingMethod.statusCode, 400);
  assert.equal(missingMethod.body.error.code, -32020);

  const nameMismatch = await call({
    path: LIVE_CHATGPT,
    headers: modernHeaders('tools/call', 'entity_list'),
    body: rpc(1, 'tools/call', { name: 'close_status', arguments: { entity_id: 'a' }, _meta: MODERN_META }),
    deps
  });
  assert.equal(nameMismatch.statusCode, 400);
  assert.equal(nameMismatch.body.error.code, -32020);

  const versionMismatch = await call({
    path: LIVE_CHATGPT,
    headers: { ...modernHeaders('ping'), 'mcp-protocol-version': '2025-11-25' },
    body: rpc(1, 'ping', { _meta: MODERN_META }),
    deps
  });
  assert.equal(versionMismatch.statusCode, 400);
  assert.equal(versionMismatch.body.error.code, -32020);

  const unsupported = await call({
    path: LIVE_CHATGPT,
    headers: { ...modernHeaders('ping'), 'mcp-protocol-version': '2099-01-01' },
    body: rpc(1, 'ping', { _meta: { ...MODERN_META, 'io.modelcontextprotocol/protocolVersion': '2099-01-01' } }),
    deps
  });
  assert.equal(unsupported.statusCode, 400);
  assert.equal(unsupported.body.error.code, -32022);
  assert.deepEqual(unsupported.body.error.data.supported, [...MCP_SUPPORTED_PROTOCOL_VERSIONS]);
  assert.equal(unsupported.body.error.data.requested, '2099-01-01');

  const noCaps = await call({
    path: LIVE_CHATGPT,
    headers: modernHeaders('ping'),
    body: rpc(1, 'ping', { _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28' } }),
    deps
  });
  assert.equal(noCaps.statusCode, 400);
  assert.equal(noCaps.body.error.code, -32602);

  // (resources/list is served since slice 4; prompts/list is the unknown one.)
  const unknown = await call({
    path: LIVE_CHATGPT,
    headers: modernHeaders('prompts/list'),
    body: rpc(1, 'prompts/list', { _meta: MODERN_META }),
    deps
  });
  assert.equal(unknown.statusCode, 404);
  assert.equal(unknown.body.error.code, -32601);
});

// ── Demo mode ──────────────────────────────────────────────────────────────

// Key parity with the real executors (the same list demoFixtures.test.js pins
// for the shim) — the hosted demo behaves like the product.
const RESULT_KEYS = {
  entity_list: ['entities', 'count'],
  close_status: ['entity', 'totals', 'open_owner_asks', 'blockers', 'blockers_truncated', 'generated_at'],
  unmatched_items: ['entity', 'total', 'page', 'page_size', 'has_more', 'items'],
  document_status: ['entities', 'open_requests'],
  audit_recent: ['events', 'count']
};

const poisonedFunnel = () => funnelDeps({
  isFirmDatabaseConfigured: () => { throw new Error('demo must not touch the database'); },
  listExposedEntities: async () => { throw new Error('demo must not resolve entities'); },
  recordMcpToolReceipt: async () => { throw new Error('demo must not write receipts'); }
});

test('demo answers every read tool from the fixtures, labeled, with the hosted notice — no auth, no DB, no receipt', async () => {
  let resolverCalled = 0;
  const deps = baseDeps({
    resolveAuth: async () => { resolverCalled += 1; return OWNER_AUTH; },
    funnelDeps: poisonedFunnel()
  });
  for (const tool of MCP_READ_TOOLS) {
    const args = tool.entity_scoped === 'required' ? { entity_id: DEMO_ENTITY_ID } : {};
    const res = await call({ path: DEMO, headers: { authorization: 'Bearer real-looking' }, body: rpc(1, 'tools/call', { name: tool.name, arguments: args }), deps });
    assert.equal(res.statusCode, 200, tool.name);
    const result = res.body.result;
    assert.equal(result.isError, undefined, `${tool.name} demo answer is a result`);
    assert.equal(result.structuredContent.demo, true);
    assert.equal(result.structuredContent.demo_notice, MCP_DEMO_NOTICE_HOSTED);
    assert.match(result.content[0].text, /DEMO DATA/);
    for (const key of RESULT_KEYS[tool.name]) {
      assert.ok(key in result.structuredContent, `${tool.name} demo result carries '${key}' like the real executor`);
    }
  }
  assert.equal(resolverCalled, 0, 'the demo path never consults auth, even when a bearer is sent');
});

test('demo: wrong entity is an honest not-found naming the demo; unknown tools stay unknown; identity says demo', async () => {
  const deps = baseDeps({ funnelDeps: poisonedFunnel() });
  const wrong = await call({ path: `${DEMO}/chatgpt`, body: rpc(1, 'tools/call', { name: 'close_status', arguments: { entity_id: 'a' } }), deps });
  assert.equal(wrong.body.result.isError, true);
  assert.match(wrong.body.result.content[0].text, /demo/i);
  const unknown = await call({ path: DEMO, body: rpc(1, 'tools/call', { name: 'admin_chat', arguments: {} }), deps });
  assert.equal(unknown.body.result.isError, true);
  const init = await call({ path: DEMO, body: rpc(1, 'initialize', { protocolVersion: '2025-06-18' }), deps });
  assert.equal(init.body.result.serverInfo.name, 'donna-books-demo');
  assert.equal(init.body.result.instructions, MCP_REMOTE_INSTRUCTIONS_DEMO);
  const list = await call({ path: DEMO, body: rpc(1, 'tools/list'), deps });
  assert.deepEqual(list.body.result.tools.map((t) => t.name), MCP_TOOLS.map((t) => t.name), 'the demo lists exactly the hosted registry');
});

test('demo ask_donna answers from the canned Harbor Lane set: no model, no auth, no DB, no receipt; labeled; proposals never applied', async () => {
  let resolverCalled = 0;
  const deps = baseDeps({
    resolveAuth: async () => { resolverCalled += 1; return OWNER_AUTH; },
    funnelDeps: poisonedFunnel()
  });
  const asked = await call({ path: DEMO, headers: { authorization: 'Bearer real-looking' }, body: rpc(1, 'tools/call', { name: 'ask_donna', arguments: { entity_id: DEMO_ENTITY_ID, message: 'What is blocking the close?' } }), deps });
  assert.equal(asked.statusCode, 200);
  const result = asked.body.result;
  assert.equal(result.isError, undefined);
  assert.equal(result.structuredContent.demo, true);
  assert.equal(result.structuredContent.demo_notice, MCP_DEMO_NOTICE_HOSTED, 'the hosted notice replaces the shim’s');
  assert.equal(result.structuredContent.model_id, null, 'no model answered');
  assert.equal(result.structuredContent.matched_question, 'blocking');
  assert.match(result.structuredContent.text, /126 items/);
  assert.match(result.content[0].text, /DEMO DATA/);
  assert.equal(resolverCalled, 0);

  const answered = await call({ path: `${DEMO}/claude`, body: rpc(2, 'tools/call', { name: 'ask_donna', arguments: { entity_id: DEMO_ENTITY_ID, message: 'The Amazon purchase on 18 July was a milk frother for the shop.' } }), deps });
  const proposal = answered.body.result.structuredContent;
  assert.equal(proposal.actions.length, 1);
  assert.equal(proposal.actions[0].requires_confirmation, true);
  assert.equal(proposal.applied, false);
  assert.deepEqual(proposal.confirm_via, DEMO_ASK_DONNA_CONFIRM_VIA);

  const outside = await call({ path: DEMO, body: rpc(3, 'tools/call', { name: 'ask_donna', arguments: { entity_id: DEMO_ENTITY_ID, message: 'What is my VAT position?' } }), deps });
  assert.equal(outside.body.result.structuredContent.matched_question, 'fallback');
  assert.equal(outside.body.result.structuredContent.model_id, null);

  const wrong = await call({ path: DEMO, body: rpc(4, 'tools/call', { name: 'ask_donna', arguments: { entity_id: 'a', message: 'hi' } }), deps });
  assert.equal(wrong.body.result.isError, true);
  assert.match(wrong.body.result.content[0].text, /demo/i);
});

test('demo confirm_action applies nothing: no auth, no DB, no receipt, no model; labeled; applied false with the demo outcome', async () => {
  let resolverCalled = 0;
  const deps = baseDeps({
    resolveAuth: async () => { resolverCalled += 1; return OWNER_AUTH; },
    funnelDeps: poisonedFunnel()
  });
  // Walk the two-call shape end to end on the demo: propose, then confirm.
  const proposed = await call({ path: DEMO, body: rpc(1, 'tools/call', { name: 'ask_donna', arguments: { entity_id: DEMO_ENTITY_ID, message: 'The Amazon purchase on 18 July was a milk frother for the shop.' } }), deps });
  const proposal = proposed.body.result.structuredContent;
  assert.equal(proposal.confirm_via.tool, 'confirm_action');
  const confirmed = await call({ path: `${DEMO}/chatgpt`, headers: { authorization: 'Bearer real-looking' }, body: rpc(2, 'tools/call', { name: 'confirm_action', arguments: { entity_id: DEMO_ENTITY_ID, message_id: proposal.message_id, action_index: proposal.actions[0].index } }), deps });
  assert.equal(confirmed.statusCode, 200);
  const result = confirmed.body.result;
  assert.equal(result.isError, undefined);
  assert.equal(result.structuredContent.demo, true);
  assert.equal(result.structuredContent.demo_notice, MCP_DEMO_NOTICE_HOSTED);
  assert.equal(result.structuredContent.applied, false);
  assert.equal(result.structuredContent.outcome, 'demo_not_applied');
  assert.equal(result.structuredContent.action_type, 'answer_evidence_request');
  assert.equal(result.structuredContent.model_id, null);
  assert.match(result.structuredContent.text, /nothing was recorded/i);
  assert.match(result.content[0].text, /DEMO DATA/);
  assert.equal(resolverCalled, 0, 'the demo path never consults auth');
  // A wrong entity is the honest not-found naming the demo; an unknown
  // proposal is still applied: false, never an invented success.
  const wrong = await call({ path: DEMO, body: rpc(3, 'tools/call', { name: 'confirm_action', arguments: { entity_id: 'a', message_id: 'x', action_index: 0 } }), deps });
  assert.equal(wrong.body.result.isError, true);
  assert.match(wrong.body.result.content[0].text, /demo/i);
  const unknown = await call({ path: DEMO, body: rpc(4, 'tools/call', { name: 'confirm_action', arguments: { entity_id: DEMO_ENTITY_ID, message_id: 'demo-msg-nope', action_index: 0 } }), deps });
  assert.equal(unknown.body.result.structuredContent.applied, false);
  assert.equal(unknown.body.result.structuredContent.action_type, null);
  assert.match(unknown.body.result.structuredContent.text, /no demo proposal/i);
});

test('the instructions name confirm_action honestly on both modes: one owner action on the owner’s say-so, the same tracked path, audited, nothing else', () => {
  assert.match(MCP_REMOTE_INSTRUCTIONS_LIVE, /confirm_action applies ONE proposed action on the owner’s explicit say-so/);
  assert.match(MCP_REMOTE_INSTRUCTIONS_LIVE, /same tracked path as the Confirm button/);
  assert.match(MCP_REMOTE_INSTRUCTIONS_LIVE, /nothing else can be confirmed from here/);
  assert.match(MCP_REMOTE_INSTRUCTIONS_LIVE, /naming this chat as the door/);
  assert.match(MCP_REMOTE_INSTRUCTIONS_DEMO, /confirm_action shows the shape of confirming a demo proposal and records nothing/);
});

test('the hosted demo notice is honest bridge-register copy', () => {
  assert.match(MCP_DEMO_NOTICE_HOSTED, /nothing here is real/i);
  assert.match(MCP_DEMO_NOTICE_HOSTED, /demo endpoint/i);
  assert.match(MCP_DEMO_NOTICE_HOSTED, /Settings → AI chat access/, 'points at the real consent path (the label since slice 4)');
  assert.match(MCP_DEMO_NOTICE_HOSTED, /sent to the chat provider/i, 'states plainly where tool results go');
  assert.doesNotMatch(MCP_DEMO_NOTICE_HOSTED, /desktop app|not running on this machine/i, 'hosted copy does not send people to the desktop app');
  for (const copy of [MCP_DEMO_NOTICE_HOSTED, MCP_REMOTE_INSTRUCTIONS_LIVE, MCP_REMOTE_INSTRUCTIONS_DEMO]) {
    assert.doesNotMatch(copy, /never leaves?|stays? on (this|your) (machine|office)|100% private/i, 'no custody slogans');
    assert.doesNotMatch(copy, /[$£€]\s?\d|\d+\s?(\/|per\s)(mo|month|year|yr)/i, 'no prices');
  }
  assert.match(MCP_REMOTE_INSTRUCTIONS_LIVE, /nothing here posts, approves, files or sends/);
});

// ── Protected-resource metadata ────────────────────────────────────────────

test('protected-resource metadata is served per live surface, from configuration, and refuses unknown resources', async () => {
  const path = '/api/donna/mcp/oauth-protected-resource/api/donna/mcp/remote/chatgpt';
  const ok = await call({ method: 'GET', path, deps: baseDeps({ env: { MCP_REMOTE_OAUTH_ISSUER: 'https://ref.supabase.co/auth/v1/', MCP_REMOTE_OAUTH_SCOPES: 'openid, email' } }) });
  assert.equal(ok.statusCode, 200);
  assert.deepEqual(ok.body, {
    resource: 'https://donna.example/api/donna/mcp/remote/chatgpt',
    authorization_servers: ['https://ref.supabase.co/auth/v1'],
    bearer_methods_supported: ['header'],
    scopes_supported: ['openid', 'email'],
    resource_name: 'Donna',
    resource_documentation: 'https://donna.example/claude'
  });

  const unconfigured = await call({ method: 'GET', path, deps: baseDeps({ env: {} }) });
  assert.equal(unconfigured.statusCode, 503);
  assert.equal(unconfigured.body.code, 'MCP_OAUTH_NOT_CONFIGURED');

  const unknown = await call({ method: 'GET', path: '/api/donna/mcp/oauth-protected-resource/api/donna/mcp/demo', deps: baseDeps() });
  assert.equal(unknown.statusCode, 404, 'the demo is not a protected resource');
  const root = await call({ method: 'GET', path: '/api/donna/mcp/oauth-protected-resource', deps: baseDeps() });
  assert.equal(root.statusCode, 404);
  assert.ok(root.body.resources.includes('/api/donna/mcp/remote/chatgpt'));

  const post = await call({ method: 'POST', path, body: {}, deps: baseDeps() });
  assert.equal(post.statusCode, 405);
});

// ── Source pin: the adapter imports no writer and no policy ────────────────

test('the adapter imports only the funnel, the registry, the request firm resolver, the card bundle module and the two demo content files', () => {
  const source = readFileSync(resolvePath(here, 'mcpRemoteAdapter.js'), 'utf8');
  const imports = [...source.matchAll(/from '([^']+)'/g)].map((m) => m[1]).sort();
  assert.deepEqual(imports, [
    '../../../desktop/mcpb/server/demoAskDonna.mjs',
    '../../../desktop/mcpb/server/demoFixtures.mjs',
    '../requestFirm.js',
    './mcpApi.js',
    // Slice 4: the MCP Apps card bundle — static content, no data, no policy
    // (mcpAppCards.test.js pins ITS import list to the html + the registry).
    './mcpAppCards.js',
    './mcpReadSurface.js'
  ]);
  // The converse tier's engine and writers are reached ONLY through the funnel.
  assert.doesNotMatch(source, /clientPortalChat|clientPortalTurn|mcpAskDonna|generateClientPortalChatReply/);
  // No policy vocabulary either: the words that would mean a branch leaked in.
  assert.doesNotMatch(source, /clientFlagActs|setClientFlagStage|withFirmDbClient|chatApplySpine|proposalStore|ledger/);
  assert.match(source, /import \{ resolveRequestFirmId \} from '\.\.\/requestFirm\.js'/, 'the one request firm resolver is imported for the firm id only');
  assert.doesNotMatch(source, /DEFAULT_FIRM_ID/, 'never the literal default firm: an owner in another firm must reach its own');
});

// ── Firm resolution: the principal's firm, never the literal default ───────

test('a live call runs the funnel under the authenticated principal\'s firm', async () => {
  const firms = [];
  const deps = baseDeps({
    resolveAuth: async () => ({ ...OWNER_AUTH, firmId: 'firm-acme' }),
    funnelDeps: funnelDeps({
      assertFirmAccess: async ({ firmId }) => { firms.push(firmId); return { principal: { unrestricted: true }, allowedClientIds: null }; },
      listExposedEntities: async ({ firmId }) => { firms.push(firmId); return [{ id: 'a', name: 'Alpha' }]; }
    })
  });
  const res = await call({ path: LIVE_CHATGPT, body: rpc(1, 'tools/call', { name: 'entity_list', arguments: {} }), deps });
  assert.equal(res.statusCode, 200, res.raw);
  assert.deepEqual(firms, ['firm-acme', 'firm-acme']);
});
