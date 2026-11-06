// MCP HTTP handler — enforcement-funnel tests (docs/design-donna-mcp-surface.md §4).
//
// Load-bearing properties:
//   - unauthenticated caller ⇒ 403 (the surface refuses where the rest of the
//     firm API would degrade open on a token-less boot);
//   - unknown tool ⇒ 404; a non-exposed entity answers EXACTLY like a
//     nonexistent one (no existence leak);
//   - the receipt is a precondition: receipt failure ⇒ 500 and the result is
//     not served; on success the response carries the receipt id;
//   - argument shape is enforced (unknown keys rejected).

import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';

import { MCP_ALL_TOOL_EXECUTORS, handleMcpApiRequest, invokeMcpTool, listMcpToolsPayload, mcpFailureFromError } from './mcpApi.js';
import { MCP_ASK_DONNA_MAX_MESSAGE_CHARS, MCP_SURFACES, MCP_TOOLS } from './mcpReadSurface.js';

const makeRes = () => {
  const res = {
    statusCode: 0,
    headers: {},
    body: null,
    setHeader(k, v) { this.headers[k] = v; },
    end(payload) { this.body = payload ? JSON.parse(payload) : null; }
  };
  return res;
};

const makeReq = ({ method = 'POST', body = null, donnaAuth = { type: 'access_token' } } = {}) => {
  const raw = body == null ? '' : JSON.stringify(body);
  const req = Readable.from(raw ? [Buffer.from(raw)] : []);
  req.method = method;
  req.headers = {};
  if (donnaAuth) req.donnaAuth = donnaAuth;
  return req;
};

const urlFor = (path) => new URL(path, 'http://localhost');

const baseDeps = (overrides = {}) => ({
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
    ask_donna: async ({ args, surface, access }) => ({
      entity: { id: args.entity_id },
      message_id: 'msg-2',
      user_message_id: 'msg-1',
      text: `Donna answered on ${surface.id} for ${access?.principal?.unrestricted ? 'staff' : 'owner'}`,
      actions: [{ index: 0, type: 'answer_evidence_request', summary: 's', requires_confirmation: true }],
      model_id: 'claude-donna-test'
    }),
    confirm_action: async ({ args, surface, access }) => ({
      entity: { id: args.entity_id },
      message_id: args.message_id,
      action_index: args.action_index,
      action_type: 'answer_evidence_request',
      surface: surface.id,
      applied: true,
      result: { evidence_request_id: 'ask-1', evidence_request_status: 'replied', recode: { applied: true } },
      evidence_request_status: 'replied',
      recode: { applied: true },
      principal_kind: access?.principal?.unrestricted ? 'staff' : 'owner'
    })
  },
  executorDeps: {},
  ...overrides
});

test('unauthenticated caller is refused with 403 (fail-closed, unlike the token-less default)', async () => {
  const res = makeRes();
  await handleMcpApiRequest(
    makeReq({ method: 'GET', donnaAuth: null }),
    res,
    urlFor('/api/donna/mcp/v1/tools'),
    baseDeps()
  );
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.code, 'MCP_AUTH_REQUIRED');
});

test('GET /v1/tools (the local shim) returns the closed READ registry — byte-identical: five tools, all read tier', async () => {
  const res = makeRes();
  await handleMcpApiRequest(makeReq({ method: 'GET' }), res, urlFor('/api/donna/mcp/v1/tools'), baseDeps());
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.tools.length, 5);
  assert.ok(res.body.tools.every((t) => t.tier === 'read'));
  assert.equal(res.body.server.surface, 'read_only_v1');
  assert.ok(!res.body.tools.some((t) => t.name === 'ask_donna'), 'the desktop shim never lists ask_donna');
});

test('unknown tool ⇒ 404 UNKNOWN_TOOL', async () => {
  const res = makeRes();
  await handleMcpApiRequest(
    makeReq({ body: { tool: 'ledger_commit', arguments: {} } }),
    res,
    urlFor('/api/donna/mcp/v1/call'),
    baseDeps()
  );
  assert.equal(res.statusCode, 404);
  assert.equal(res.body.code, 'UNKNOWN_TOOL');
});

test('unknown argument keys are rejected', async () => {
  const res = makeRes();
  await handleMcpApiRequest(
    makeReq({ body: { tool: 'close_status', arguments: { entity_id: 'a', sql: 'drop table' } } }),
    res,
    urlFor('/api/donna/mcp/v1/call'),
    baseDeps()
  );
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.code, 'INVALID_ARGUMENTS');
});

test('a non-exposed entity answers exactly like a nonexistent one', async () => {
  const deps = baseDeps();
  const resMissing = makeRes();
  await handleMcpApiRequest(
    makeReq({ body: { tool: 'close_status', arguments: { entity_id: 'no-such-entity' } } }),
    resMissing,
    urlFor('/api/donna/mcp/v1/call'),
    deps
  );
  const resUnexposed = makeRes();
  await handleMcpApiRequest(
    makeReq({ body: { tool: 'close_status', arguments: { entity_id: 'real-but-unexposed' } } }),
    resUnexposed,
    urlFor('/api/donna/mcp/v1/call'),
    deps
  );
  assert.equal(resMissing.statusCode, 404);
  assert.equal(resUnexposed.statusCode, 404);
  assert.equal(resMissing.body.code, resUnexposed.body.code);
  assert.equal(
    resMissing.body.error.replace('no-such-entity', 'X'),
    resUnexposed.body.error.replace('real-but-unexposed', 'X'),
    'error text must not distinguish existence from non-exposure'
  );
});

test('happy path: executes, receipts, and returns the receipt id', async () => {
  let receipted = null;
  const deps = baseDeps({
    recordMcpToolReceipt: async (input) => { receipted = input; return 'receipt-42'; }
  });
  const res = makeRes();
  await handleMcpApiRequest(
    makeReq({ body: { tool: 'close_status', arguments: { entity_id: 'a' } } }),
    res,
    urlFor('/api/donna/mcp/v1/call'),
    deps
  );
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.receipt_id, 'receipt-42');
  assert.equal(res.body.result.entity.id, 'a');
  assert.equal(receipted.tool, 'close_status');
  assert.equal(receipted.clientId, 'a');
});

test('receipt failure ⇒ 500 and the result is NOT served (audit-as-precondition)', async () => {
  const deps = baseDeps({
    recordMcpToolReceipt: async () => { throw new Error('audit insert failed'); }
  });
  const res = makeRes();
  await handleMcpApiRequest(
    makeReq({ body: { tool: 'close_status', arguments: { entity_id: 'a' } } }),
    res,
    urlFor('/api/donna/mcp/v1/call'),
    deps
  );
  assert.equal(res.statusCode, 500);
  assert.equal(res.body.ok, false);
  assert.equal(res.body.result, undefined, 'no data may leave on a failed receipt');
});

test('firm-access denial maps to 403', async () => {
  const deps = baseDeps({
    assertFirmAccess: async () => {
      const err = new Error('You do not have access to client a.');
      err.statusCode = 403;
      throw err;
    }
  });
  const res = makeRes();
  await handleMcpApiRequest(
    makeReq({ body: { tool: 'close_status', arguments: { entity_id: 'a' } } }),
    res,
    urlFor('/api/donna/mcp/v1/call'),
    deps
  );
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.code, 'ACCESS_DENIED');
});

test('database not configured ⇒ 503', async () => {
  const res = makeRes();
  await handleMcpApiRequest(
    makeReq({ method: 'GET' }),
    res,
    urlFor('/api/donna/mcp/v1/tools'),
    baseDeps({ isFirmDatabaseConfigured: () => false })
  );
  assert.equal(res.statusCode, 503);
});

test('missing required entity_id ⇒ 400', async () => {
  const res = makeRes();
  await handleMcpApiRequest(
    makeReq({ body: { tool: 'unmatched_items', arguments: {} } }),
    res,
    urlFor('/api/donna/mcp/v1/call'),
    baseDeps()
  );
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.code, 'INVALID_ARGUMENTS');
});

// ── The transport-agnostic core ────────────────────────────────────────────

test('invokeMcpTool: the local route and a hosted surface run the SAME chain; the surface reaches the receipt', async () => {
  let receipted = null;
  const deps = baseDeps({ recordMcpToolReceipt: async (input) => { receipted = input; return 'r'; } });
  const local = await invokeMcpTool({ auth: { type: 'access_token' }, toolName: 'close_status', rawArgs: { entity_id: 'a' }, deps });
  assert.equal(local.status, 200);
  assert.equal(receipted.surface, MCP_SURFACES.claude_desktop_mcp, 'no surface ⇒ the local shim');
  assert.deepEqual(receipted.principal, { type: 'access_token', id: null });

  const hosted = await invokeMcpTool({
    auth: { type: 'supabase_user', userId: 'u-1', email: 'o@x.y' },
    toolName: 'close_status', rawArgs: { entity_id: 'a' },
    surface: MCP_SURFACES.claude_remote, deps
  });
  assert.equal(hosted.status, 200);
  assert.equal(hosted.body.receipt_id, 'r');
  assert.equal(receipted.surface, MCP_SURFACES.claude_remote);
  assert.deepEqual(receipted.principal, { type: 'supabase_user', id: 'u-1' });
  assert.equal(receipted.modelId, null);
});

test('invokeMcpTool refuses an unregistered surface before touching anything', async () => {
  let touched = 0;
  const deps = baseDeps({ listExposedEntities: async () => { touched += 1; return []; } });
  const out = await invokeMcpTool({ auth: { type: 'access_token' }, toolName: 'entity_list', rawArgs: {}, surface: { id: 'nope' }, deps });
  assert.equal(out.status, 500);
  assert.equal(out.body.code, 'MCP_SURFACE_UNKNOWN');
  assert.equal(touched, 0);
  const none = await invokeMcpTool({ auth: null, toolName: 'entity_list', rawArgs: {}, deps });
  assert.equal(none.status, 403);
  assert.equal(none.body.code, 'MCP_AUTH_REQUIRED');
});

test('listMcpToolsPayload is the one registry every transport lists from, filtered to the calling surface', () => {
  const local = listMcpToolsPayload();
  assert.equal(local.tools.length, 5);
  assert.ok(local.tools.every((t) => t.tier === 'read'));
  assert.equal(local.server.surface, 'read_only_v1');
  for (const surface of [MCP_SURFACES.chatgpt_app, MCP_SURFACES.claude_remote]) {
    const hosted = listMcpToolsPayload({ surface });
    assert.deepEqual(hosted.tools.map((t) => t.name), MCP_TOOLS.map((t) => t.name), `${surface.id} lists the whole registry`);
    assert.equal(hosted.server.surface, 'owner_chat_v1');
    assert.equal(hosted.tools.find((t) => t.name === 'ask_donna').tier, 'converse');
  }
  assert.deepEqual(listMcpToolsPayload({ surface: { id: 'nope' } }).tools, []);
});

test('the composed executor map covers exactly the registry — no orphan executor, no missing one', () => {
  assert.deepEqual(Object.keys(MCP_ALL_TOOL_EXECUTORS).sort(), MCP_TOOLS.map((t) => t.name).sort());
});

// ── The converse tier through the funnel ───────────────────────────────────

const askArgs = { entity_id: 'a', message: 'Is the Shopify invoice paid?' };

test('ask_donna on a hosted surface runs the whole chain: access → consent → executor (with access + surface) → receipt with Donna’s model id', async () => {
  let receipted = null;
  let accessCalls = [];
  const deps = baseDeps({
    assertFirmAccess: async (input) => { accessCalls.push(input); return { principal: { unrestricted: false, principalType: 'firm_collaborator' }, allowedClientIds: ['a'] }; },
    recordMcpToolReceipt: async (input) => { receipted = input; return 'receipt-ask'; }
  });
  const auth = { type: 'supabase_user', userId: 'user-9' };
  const outcome = await invokeMcpTool({ auth, toolName: 'ask_donna', rawArgs: askArgs, surface: MCP_SURFACES.chatgpt_app, deps });
  assert.equal(outcome.status, 200, JSON.stringify(outcome.body));
  assert.equal(outcome.body.receipt_id, 'receipt-ask');
  assert.equal(outcome.body.result.text, 'Donna answered on chatgpt_app for owner');
  assert.equal(outcome.body.result.actions[0].requires_confirmation, true);
  assert.deepEqual(accessCalls[0].clientIds, [], 'access resolves the principal; the entity is checked against its assigned set');
  assert.equal(receipted.tool, 'ask_donna');
  assert.equal(receipted.clientId, 'a');
  assert.equal(receipted.surface, MCP_SURFACES.chatgpt_app);
  assert.deepEqual(receipted.principal, { type: 'supabase_user', id: 'user-9' });
  assert.equal(receipted.modelId, 'claude-donna-test', 'Donna’s own model id, from the engine’s result, rides the receipt');
  assert.deepEqual(receipted.args, askArgs, 'the funnel hands the receipt writer the validated args (it echoes only a length for the message)');
});

test('ask_donna is NOT served on the desktop surface (the local shim’s behaviour is unchanged)', async () => {
  const outcome = await invokeMcpTool({ auth: { type: 'access_token' }, toolName: 'ask_donna', rawArgs: askArgs, surface: MCP_SURFACES.claude_desktop_mcp, deps: baseDeps() });
  assert.equal(outcome.status, 404);
  assert.equal(outcome.body.code, 'TOOL_NOT_ON_SURFACE');
  const res = makeRes();
  await handleMcpApiRequest(makeReq({ body: { tool: 'ask_donna', arguments: askArgs } }), res, urlFor('/api/donna/mcp/v1/call'), baseDeps());
  assert.equal(res.statusCode, 404);
  assert.equal(res.body.code, 'TOOL_NOT_ON_SURFACE');
});

test('ask_donna arguments are shape-checked: message required, a string, non-blank, bounded; unknown keys (thread_id) rejected', async () => {
  const deps = baseDeps();
  const call = (rawArgs) => invokeMcpTool({ auth: { type: 'access_token' }, toolName: 'ask_donna', rawArgs, surface: MCP_SURFACES.claude_remote, deps });
  for (const [rawArgs, why] of [
    [{ entity_id: 'a' }, 'missing message'],
    [{ entity_id: 'a', message: '' }, 'empty message'],
    [{ entity_id: 'a', message: '   ' }, 'blank message'],
    [{ entity_id: 'a', message: 42 }, 'non-string message'],
    [{ entity_id: 'a', message: 'x'.repeat(MCP_ASK_DONNA_MAX_MESSAGE_CHARS + 1) }, 'oversize message'],
    [{ entity_id: 'a', message: 'hi', thread_id: 't' }, 'unknown key thread_id'],
    [{ message: 'hi' }, 'missing entity_id']
  ]) {
    const outcome = await call(rawArgs);
    assert.equal(outcome.status, 400, why);
    assert.equal(outcome.body.code, 'INVALID_ARGUMENTS', why);
  }
  const ok = await call({ entity_id: 'a', message: 'x'.repeat(MCP_ASK_DONNA_MAX_MESSAGE_CHARS) });
  assert.equal(ok.status, 200);
});

test('ask_donna: a non-exposed entity answers exactly like a nonexistent one (no existence leak on the converse tier)', async () => {
  const deps = baseDeps();
  const call = (entity_id) => invokeMcpTool({ auth: { type: 'access_token' }, toolName: 'ask_donna', rawArgs: { entity_id, message: 'hi' }, surface: MCP_SURFACES.chatgpt_app, deps });
  const missing = await call('no-such-entity');
  const unexposed = await call('real-but-unexposed');
  assert.equal(missing.status, 404);
  assert.equal(unexposed.status, 404);
  assert.equal(missing.body.code, 'ENTITY_NOT_FOUND');
  assert.equal(missing.body.error.replace('no-such-entity', 'X'), unexposed.body.error.replace('real-but-unexposed', 'X'));
});

test('ask_donna: receipt failure ⇒ the answer is NOT served (audit-as-precondition on the converse tier too)', async () => {
  const deps = baseDeps({ recordMcpToolReceipt: async () => { throw new Error('audit insert failed'); } });
  await assert.rejects(
    invokeMcpTool({ auth: { type: 'access_token' }, toolName: 'ask_donna', rawArgs: askArgs, surface: MCP_SURFACES.chatgpt_app, deps }),
    /audit insert failed/
  );
});

// ── The act tier through the funnel ────────────────────────────────────────

const confirmArgs = { entity_id: 'a', message_id: 'clchat-a-assistant-1', action_index: 0 };

test('confirm_action on a hosted surface runs the whole chain: access → consent → executor (with access + surface) → receipt with surface, principal and a NULL model id', async () => {
  let receipted = null;
  const accessCalls = [];
  const deps = baseDeps({
    assertFirmAccess: async (input) => { accessCalls.push(input); return { principal: { unrestricted: false, principalType: 'firm_collaborator' }, allowedClientIds: ['a'] }; },
    recordMcpToolReceipt: async (input) => { receipted = input; return 'receipt-confirm'; }
  });
  const auth = { type: 'supabase_user', userId: 'user-9' };
  const outcome = await invokeMcpTool({ auth, toolName: 'confirm_action', rawArgs: confirmArgs, surface: MCP_SURFACES.claude_remote, deps });
  assert.equal(outcome.status, 200, JSON.stringify(outcome.body));
  assert.equal(outcome.body.receipt_id, 'receipt-confirm');
  assert.equal(outcome.body.result.applied, true);
  assert.equal(outcome.body.result.surface, 'claude_remote');
  assert.equal(outcome.body.result.principal_kind, 'owner');
  assert.deepEqual(accessCalls[0].clientIds, [], 'access resolves the principal; the entity is checked against its assigned set before anything runs');
  assert.equal(receipted.tool, 'confirm_action');
  assert.equal(receipted.clientId, 'a');
  assert.equal(receipted.surface, MCP_SURFACES.claude_remote);
  assert.deepEqual(receipted.principal, { type: 'supabase_user', id: 'user-9' });
  assert.equal(receipted.modelId, null, 'the owner applies; no model proposes on the act tier');
  assert.deepEqual(receipted.args, confirmArgs);
  assert.deepEqual(receipted.resultMeta, { message_id: 'clchat-a-assistant-1', action_index: 0, action_type: 'answer_evidence_request', applied: true, evidence_request_status: 'replied', recode_applied: true });
});

test('confirm_action is NOT served on the desktop surface (the local shim’s listing and behaviour are unchanged)', async () => {
  const outcome = await invokeMcpTool({ auth: { type: 'access_token' }, toolName: 'confirm_action', rawArgs: confirmArgs, surface: MCP_SURFACES.claude_desktop_mcp, deps: baseDeps() });
  assert.equal(outcome.status, 404);
  assert.equal(outcome.body.code, 'TOOL_NOT_ON_SURFACE');
  const res = makeRes();
  await handleMcpApiRequest(makeReq({ body: { tool: 'confirm_action', arguments: confirmArgs } }), res, urlFor('/api/donna/mcp/v1/call'), baseDeps());
  assert.equal(res.statusCode, 404);
  assert.equal(res.body.code, 'TOOL_NOT_ON_SURFACE');
  const listing = listMcpToolsPayload({ surface: MCP_SURFACES.claude_desktop_mcp });
  assert.ok(!listing.tools.some((t) => t.name === 'confirm_action'));
  assert.equal(listing.server.surface, 'read_only_v1');
});

test('confirm_action arguments are shape-checked: all three required; action_index a real non-negative integer; message_id bounded; unknown keys rejected', async () => {
  const cases = [
    [{ entity_id: 'a', message_id: 'm' }, /missing required argument 'action_index'/],
    [{ entity_id: 'a', action_index: 0 }, /missing required argument 'message_id'/],
    [{ message_id: 'm', action_index: 0 }, /missing required argument 'entity_id'/],
    [{ entity_id: 'a', message_id: 'm', action_index: '0' }, /action_index must be an integer/],
    [{ entity_id: 'a', message_id: 'm', action_index: 1.5 }, /action_index must be an integer/],
    [{ entity_id: 'a', message_id: 'm', action_index: -1 }, /action_index must be at least 0/],
    [{ entity_id: 'a', message_id: 'x'.repeat(201), action_index: 0 }, /message_id exceeds 200 characters/],
    [{ entity_id: 'a', message_id: 'm', action_index: 0, reply_text: 'tampered' }, /unknown argument 'reply_text'/],
    [{ entity_id: 'a', message_id: 'm', action_index: 0, action_type: 'post' }, /unknown argument 'action_type'/]
  ];
  for (const [rawArgs, expected] of cases) {
    const outcome = await invokeMcpTool({ auth: { type: 'access_token' }, toolName: 'confirm_action', rawArgs, surface: MCP_SURFACES.chatgpt_app, deps: baseDeps() });
    assert.equal(outcome.status, 400, JSON.stringify(rawArgs));
    assert.equal(outcome.body.code, 'INVALID_ARGUMENTS');
    assert.match(outcome.body.error, expected);
  }
  // The read tools' integer guard is unchanged (page must be an integer).
  const page = await invokeMcpTool({ auth: { type: 'access_token' }, toolName: 'unmatched_items', rawArgs: { entity_id: 'a', page: '2' }, surface: MCP_SURFACES.chatgpt_app, deps: baseDeps() });
  assert.equal(page.status, 400);
  assert.match(page.body.error, /page must be an integer/);
});

test('confirm_action: a non-exposed entity answers exactly like a nonexistent one (no existence leak on the act tier)', async () => {
  const deps = baseDeps({ listExposedEntities: async () => [{ id: 'a', name: 'Alpha' }] });
  const missing = await invokeMcpTool({ auth: { type: 'access_token' }, toolName: 'confirm_action', rawArgs: { ...confirmArgs, entity_id: 'zzz' }, surface: MCP_SURFACES.chatgpt_app, deps });
  const unexposed = await invokeMcpTool({ auth: { type: 'access_token' }, toolName: 'confirm_action', rawArgs: { ...confirmArgs, entity_id: 'b' }, surface: MCP_SURFACES.chatgpt_app, deps });
  assert.equal(missing.status, 404);
  assert.equal(unexposed.status, 404);
  assert.deepEqual(missing.body, { ...unexposed.body, error: missing.body.error });
  assert.equal(missing.body.code, 'ENTITY_NOT_FOUND');
});

test('confirm_action: receipt failure ⇒ the consequence is NOT served (audit-as-precondition on the act tier too)', async () => {
  const deps = baseDeps({ recordMcpToolReceipt: async () => { throw new Error('audit down'); } });
  await assert.rejects(
    invokeMcpTool({ auth: { type: 'access_token' }, toolName: 'confirm_action', rawArgs: confirmArgs, surface: MCP_SURFACES.chatgpt_app, deps }),
    /audit down/
  );
});

test('confirm_action: a coded refusal from the executor keeps its code and status through mcpFailureFromError', () => {
  for (const [code, statusCode] of [['CONFIRM_TARGET_NOT_FOUND', 404], ['ACTION_TYPE_NOT_CONFIRMABLE', 400], ['ACTION_NOT_PROPOSED', 409], ['CONFIRM_APPLY_FAILED', 500]]) {
    const outcome = mcpFailureFromError(Object.assign(new Error('refused'), { statusCode, code }));
    assert.equal(outcome.status, statusCode);
    assert.equal(outcome.body.code, code);
  }
  // Every 403 on this surface reads as ACCESS_DENIED (the funnel's standing
  // rule: a denial reads the same on every door) — the owner capability
  // gate's refusal included.
  const denied = mcpFailureFromError(Object.assign(new Error('Capability denied.'), { statusCode: 403, code: 'ACTION_NOT_PERMITTED' }));
  assert.deepEqual(denied, { status: 403, body: { ok: false, code: 'ACCESS_DENIED', error: 'Access denied.' } });
});

test('mcpFailureFromError keeps a coded refusal (the executor’s 502, the billing gate’s 402); anything else is MCP_INTERNAL', () => {
  assert.deepEqual(mcpFailureFromError(Object.assign(new Error('Donna could not answer'), { statusCode: 502, code: 'DONNA_CHAT_UNAVAILABLE' })),
    { status: 502, body: { ok: false, code: 'DONNA_CHAT_UNAVAILABLE', error: 'Donna could not answer' } });
  assert.deepEqual(mcpFailureFromError(Object.assign(new Error('inactive plan'), { statusCode: 402, code: 'CLIENT_NOT_ENTITLED' })),
    { status: 402, body: { ok: false, code: 'CLIENT_NOT_ENTITLED', error: 'inactive plan' } });
  assert.equal(mcpFailureFromError(Object.assign(new Error('Access denied'), { statusCode: 403 })).body.code, 'ACCESS_DENIED');
  assert.equal(mcpFailureFromError(Object.assign(new Error('duplicate key'), { code: '23505' })).body.code, 'MCP_INTERNAL', 'a pg error code is not a refusal code');
  assert.equal(mcpFailureFromError(Object.assign(new Error('x'), { statusCode: 200, code: 'WEIRD' })).body.code, 'MCP_INTERNAL');
  assert.equal(mcpFailureFromError(new Error('boom')).status, 500);
});

// ── Owner scoping: a client-scoped principal sees only its own exposed entities ──

const TWO_OWNERS = async () => [
  { id: 'a', name: 'Alpha', jurisdiction: 'GB', accounting_basis: null },
  { id: 'b', name: 'Bravo (another owner)', jurisdiction: 'US', accounting_basis: null }
];
const ownerOfA = async () => ({ principal: { unrestricted: false, principalType: 'firm_collaborator' }, allowedClientIds: ['a'] });

test('a client-scoped owner lists only its own exposed entities, never another owner\'s', async () => {
  let seen = null;
  const deps = baseDeps({
    assertFirmAccess: ownerOfA,
    listExposedEntities: TWO_OWNERS,
    executors: { ...baseDeps().executors, entity_list: async ({ entities }) => { seen = entities; return { entities, count: entities.length }; } }
  });
  const outcome = await invokeMcpTool({ auth: { type: 'supabase_user', userId: 'user-9' }, toolName: 'entity_list', rawArgs: {}, surface: MCP_SURFACES.chatgpt_app, deps });
  assert.equal(outcome.status, 200);
  assert.deepEqual(seen.map((e) => e.id), ['a']);
  assert.doesNotMatch(JSON.stringify(outcome.body), /Bravo/);
});

test('the all-entities defaults (document_status, audit_recent without entity_id) are held to the owner\'s own entities', async () => {
  for (const toolName of ['document_status', 'audit_recent']) {
    let scope = null;
    const deps = baseDeps({
      assertFirmAccess: ownerOfA,
      listExposedEntities: TWO_OWNERS,
      executors: { ...baseDeps().executors, [toolName]: async ({ entities }) => { scope = entities.map((e) => e.id); return { entities: [], events: [], count: 0, open_requests: 0 }; } }
    });
    const outcome = await invokeMcpTool({ auth: { type: 'supabase_user', userId: 'user-9' }, toolName, rawArgs: {}, surface: MCP_SURFACES.chatgpt_app, deps });
    assert.equal(outcome.status, 200, toolName);
    assert.deepEqual(scope, ['a'], toolName);
  }
});

test('another owner\'s exposed entity answers ENTITY_NOT_FOUND, exactly like a nonexistent one (no existence leak), and nothing runs', async () => {
  for (const [toolName, rawArgs] of [
    ['close_status', { entity_id: 'b' }],
    ['ask_donna', { entity_id: 'b', message: 'hi' }],
    ['confirm_action', { entity_id: 'b', message_id: 'm', action_index: 0 }],
    ['close_status', { entity_id: 'does-not-exist' }]
  ]) {
    let ran = false;
    let receipted = false;
    const deps = baseDeps({
      assertFirmAccess: ownerOfA,
      listExposedEntities: TWO_OWNERS,
      recordMcpToolReceipt: async () => { receipted = true; return 'r'; },
      executors: { ...baseDeps().executors, [toolName]: async () => { ran = true; return {}; } }
    });
    const outcome = await invokeMcpTool({ auth: { type: 'supabase_user', userId: 'user-9' }, toolName, rawArgs, surface: MCP_SURFACES.chatgpt_app, deps });
    assert.equal(outcome.status, 404, `${toolName} ${rawArgs.entity_id}`);
    assert.equal(outcome.body.code, 'ENTITY_NOT_FOUND');
    assert.equal(ran, false);
    assert.equal(receipted, false);
  }
});

test('an unrestricted principal (firm member, access token) still sees every exposed entity in its firm', async () => {
  let seen = null;
  const deps = baseDeps({
    listExposedEntities: TWO_OWNERS,
    executors: { ...baseDeps().executors, entity_list: async ({ entities }) => { seen = entities; return { entities, count: entities.length }; } }
  });
  const outcome = await invokeMcpTool({ auth: { type: 'access_token' }, toolName: 'entity_list', rawArgs: {}, surface: MCP_SURFACES.chatgpt_app, deps });
  assert.equal(outcome.status, 200);
  assert.deepEqual(seen.map((e) => e.id), ['a', 'b']);
});
