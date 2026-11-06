// Donna MCP surface — THE enforcement funnel every MCP transport calls
// (docs/design-donna-mcp-surface.md §4: Claude Desktop → thin MCPB shim →
// THIS authenticated local API → capability/actor/audit → governed reads;
// docs/design-donna-chatgpt-app-build-brief.md §4.1: the hosted remote
// adapter is a translation layer over THIS SAME funnel).
//
// Two callers, one chain:
//   - handleMcpApiRequest — the local HTTP routes the MCPB shim calls,
//     mounted by api.js under /api/donna/mcp (inside isProtectedDonnaPath, so
//     requireDonnaAccess runs first):
//       GET  /api/donna/mcp/v1/tools  — the tool registry (the shim renders
//                                       this list 1:1, no logic of its own).
//       POST /api/donna/mcp/v1/call   — { tool, arguments } → invokeMcpTool.
//   - invokeMcpTool — the transport-agnostic core: (auth, tool, arguments,
//     surface) → { status, body }. mcpRemoteAdapter.js (JSON-RPC over
//     Streamable HTTP) calls it directly; it adds no enforcement of its own
//     and bypasses none. If a transport ever needs a policy branch, that
//     branch belongs HERE, not in the transport.
//
// Enforcement order in invokeMcpTool (each step fail-closed):
//   1. authenticated caller REQUIRED — req.donnaAuth must be set. The rest
//      of the firm API degrades open when no DONNA_ACCESS_TOKEN is
//      configured; this surface serves an external model, so it refuses
//      instead (MCP_AUTH_REQUIRED).
//   2. tool must exist in MCP_TOOLS, carry a tier in MCP_TIERS ('read';
//      'converse' for ask_donna — persists a chat turn, changes no book
//      state; 'act' for confirm_action — the owner's confirmation of one
//      persisted proposal through the chat-apply spine) and be listed on the
//      CALLING surface (`surfaces`): the local shim never reaches ask_donna
//      or confirm_action, so its listing and its behaviour stay
//      byte-identical. The defense-in-depth re-check of the registry.
//   3. arguments are shape-checked (unknown keys rejected, strings bounded —
//      an untrusted caller's payload is never forwarded loosely).
//   4. the exposed-entity set is resolved (MCP_ENTITY_EXPOSE acting per
//      client); a required/named entity that is NOT exposed returns the
//      SAME error as one that does not exist (ENTITY_NOT_FOUND) — the
//      surface must not leak which clients exist unexposed.
//   5. the executor runs (a read projection; the ask_donna chat turn —
//      mcpAskDonna.js, which applies nothing; or the confirm_action apply —
//      mcpConfirmAction.js, which reaches the chat-apply spine and nothing
//      else), then the audit receipt is written (recordMcpToolReceipt,
//      audit-as-precondition; on the converse tier it carries Donna's own
//      model id read from the engine's result, null on the other tiers) —
//      only then does the result leave the process. Receipt failure ⇒ 500,
//      no data.
//
// Prompt-injection posture: tool RESULTS can carry hostile text (invoice
// memos, counterparty names). That is the model host's sandbox problem —
// this layer's job is that no inbound call can reach an UNSTAGED mutation
// (no tool maps to a writer; ask_donna's proposals need the owner's
// confirmation; confirm_action applies one persisted proposal only through
// the same spine gates the portal's Confirm card passes — K-mcp-1,
// surface-wide) and every call is attributed + receipted.

import {
  DEFAULT_FIRM_ID,
  assertFirmAccess,
  isFirmDatabaseConfigured
} from '../firmDb.js';
import {
  DEFAULT_MCP_SURFACE,
  MCP_SURFACES,
  MCP_TIERS,
  MCP_TOOLS,
  MCP_TOOL_EXECUTORS,
  MCP_MAX_RESULT_CHARS,
  findMcpTool,
  listExposedEntities,
  mcpToolsForSurface,
  receiptModelIdFor,
  receiptPrincipalFor,
  recordMcpToolReceipt,
  resultMetaFor
} from './mcpReadSurface.js';
import { MCP_CONVERSE_TOOL_EXECUTORS } from './mcpAskDonna.js';
import { MCP_ACT_TOOL_EXECUTORS } from './mcpConfirmAction.js';

// The composed executor map — the read projections plus the one converse
// executor plus the one act executor. mcpApi.test.js pins that it covers
// exactly the registry.
export const MCP_ALL_TOOL_EXECUTORS = Object.freeze({
  ...MCP_TOOL_EXECUTORS,
  ...MCP_CONVERSE_TOOL_EXECUTORS,
  ...MCP_ACT_TOOL_EXECUTORS
});

export const MCP_MAX_BODY_BYTES = 64 * 1024;
const MAX_BODY_BYTES = MCP_MAX_BODY_BYTES;

const sendJson = (res, statusCode, payload) => {
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(payload));
};

const sendError = (res, statusCode, code, message) =>
  sendJson(res, statusCode, { ok: false, code, error: message });

export const readJsonBody = (req) =>
  new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0;
    req.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > MAX_BODY_BYTES) {
        reject(Object.assign(new Error('Request body too large.'), { code: 'BODY_TOO_LARGE' }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        reject(Object.assign(new Error('Invalid JSON body.'), { code: 'INVALID_JSON' }));
      }
    });
    req.on('error', reject);
  });

// Light argument validation against the tool's declared schema subset we
// actually use: known keys only, scalar types, bounded strings. (Full
// JSON-schema validation would be overkill for a handful of scalar params;
// unknown keys and unbounded free text are the attack surface and they are
// rejected.)
const validateArgs = (tool, args) => {
  if (args == null) return { ok: true, args: {} };
  if (typeof args !== 'object' || Array.isArray(args)) {
    return { ok: false, error: 'arguments must be an object' };
  }
  const properties = tool.input_schema?.properties || {};
  const allowed = new Set(Object.keys(properties));
  for (const key of Object.keys(args)) {
    if (!allowed.has(key)) return { ok: false, error: `unknown argument '${key}'` };
  }
  for (const key of tool.input_schema?.required || []) {
    if (args[key] == null || args[key] === '') return { ok: false, error: `missing required argument '${key}'` };
  }
  if ('entity_id' in args && args.entity_id != null && typeof args.entity_id !== 'string') {
    return { ok: false, error: 'entity_id must be a string' };
  }
  for (const [key, spec] of Object.entries(properties)) {
    if (spec?.type !== 'string' || !(key in args) || args[key] == null) continue;
    if (typeof args[key] !== 'string') return { ok: false, error: `${key} must be a string` };
    if (Number.isInteger(spec.minLength) && args[key].trim().length < spec.minLength) {
      return { ok: false, error: `${key} must not be empty` };
    }
    if (Number.isInteger(spec.maxLength) && args[key].length > spec.maxLength) {
      return { ok: false, error: `${key} exceeds ${spec.maxLength} characters` };
    }
  }
  // Integer arguments (page, page_size, limit, action_index): a real
  // integer, never a numeric string, and never below the schema's minimum —
  // a negative or fractional index must not reach an executor.
  for (const [key, spec] of Object.entries(properties)) {
    if (spec?.type !== 'integer' || !(key in args) || args[key] == null) continue;
    if (!Number.isInteger(args[key])) return { ok: false, error: `${key} must be an integer` };
    if (Number.isInteger(spec.minimum) && args[key] < spec.minimum) {
      return { ok: false, error: `${key} must be at least ${spec.minimum}` };
    }
  }
  return { ok: true, args };
};

const funnelDeps = (deps = {}) => ({
  listExposedEntities,
  recordMcpToolReceipt,
  assertFirmAccess,
  isFirmDatabaseConfigured,
  executors: MCP_ALL_TOOL_EXECUTORS,
  executorDeps: {},
  ...deps
});

const failure = (status, code, error) => ({ status, body: { ok: false, code, error } });

// The registry payload every transport lists from (the shim's GET /v1/tools
// body; the remote adapter's tools/list source). One registry, filtered to
// the CALLING surface (a listing fact carried on each entry, never a
// per-transport addition): the local shim's default listing is the five read
// tools, byte-identical to before; the hosted surfaces add ask_donna.
export const listMcpToolsPayload = ({ surface = DEFAULT_MCP_SURFACE } = {}) => {
  const tools = mcpToolsForSurface(surface?.id);
  const readOnly = tools.every((tool) => tool.tier === MCP_TIERS.read);
  return {
    ok: true,
    server: { name: 'donna-books', surface: readOnly ? 'read_only_v1' : 'owner_chat_v1' },
    tools
  };
};

// The transport-agnostic funnel. Returns { status, body } shaped exactly like
// the local HTTP route's response (ok/code/error or ok/tool/receipt_id/result)
// so handleMcpApiRequest is a one-line send and the remote adapter a pure
// JSON-RPC translation. Throws nothing on refusal — every refusal is a
// status+code; only an unexpected failure escapes (mapped by the callers).
export const invokeMcpTool = async ({
  auth,
  firmId = DEFAULT_FIRM_ID,
  toolName,
  rawArgs,
  surface = DEFAULT_MCP_SURFACE,
  deps = {}
} = {}) => {
  const d = funnelDeps(deps);

  // Step 1 — authenticated caller required, fail-closed (see header).
  if (!auth) {
    return failure(
      403, 'MCP_AUTH_REQUIRED',
      'The MCP surface requires an authenticated caller. Configure DONNA_ACCESS_TOKEN and pass it on every request.'
    );
  }
  if (!d.isFirmDatabaseConfigured()) {
    return failure(503, 'DB_NOT_CONFIGURED', 'Firm database is not configured.');
  }
  // A surface is attribution, never authority: an unknown surface id is a
  // programming error in a transport, refused rather than receipted under a
  // made-up actor.
  const resolvedSurface = surface && MCP_SURFACES[surface.id] ? surface : null;
  if (!resolvedSurface) {
    return failure(500, 'MCP_SURFACE_UNKNOWN', 'The calling transport named no known MCP surface.');
  }

  // Step 2 — closed registry: a known tier, listed on the calling surface.
  const tool = findMcpTool(String(toolName || ''));
  if (!tool) {
    return failure(404, 'UNKNOWN_TOOL', `Unknown tool '${String(toolName || '')}'.`);
  }
  if (!Object.values(MCP_TIERS).includes(tool.tier)) {
    // Unreachable while the registry carries only MCP_TIERS values; kept so
    // a future registry mistake fails closed instead of executing.
    return failure(403, 'TOOL_NOT_PERMITTED', 'Only registry-tier tools (read, converse, act) are served on this surface.');
  }
  if (!Array.isArray(tool.surfaces) || !tool.surfaces.includes(resolvedSurface.id)) {
    return failure(404, 'TOOL_NOT_ON_SURFACE', `Tool '${tool.name}' is not served on the ${resolvedSurface.id} surface.`);
  }

  // Step 3 — argument shape.
  const validated = validateArgs(tool, rawArgs);
  if (!validated.ok) {
    return failure(400, 'INVALID_ARGUMENTS', validated.error);
  }
  const args = validated.args;

  // Standard firm-access chain (parity with every other route): an
  // access-token caller passes; a client-scoped principal resolves to the
  // set of clients it is assigned. The entity itself is checked against
  // that set below, so another owner's id answers ENTITY_NOT_FOUND exactly
  // like a nonexistent one (no existence leak through ACCESS_DENIED).
  const access = await d.assertFirmAccess({ firmId, auth, clientIds: [] });

  // Step 4 — the consent gate, held to the caller's own clients. The exposed
  // set is firm-wide (one firm hosts every self-serve owner); a client-scoped
  // principal sees ONLY the exposed entities it is assigned, on every tool,
  // including the ones that default to "all exposed" without an entity_id.
  const exposed = await d.listExposedEntities({ firmId, deps: d.executorDeps });
  const assigned = Array.isArray(access?.allowedClientIds) ? new Set(access.allowedClientIds) : null;
  const entities = assigned ? exposed.filter((e) => assigned.has(e.id)) : exposed;
  if (tool.entity_scoped !== 'none' && args.entity_id) {
    if (!entities.some((e) => e.id === args.entity_id)) {
      // Same answer for "does not exist" and "exists, not exposed".
      return failure(404, 'ENTITY_NOT_FOUND', `No exposed entity '${args.entity_id}'.`);
    }
  }

  // Step 5 — execute, receipt, respond (in that order). A coded refusal an
  // executor throws (ENTITY_NOT_FOUND, the act tier's CONFIRM_* codes, the
  // converse tier's DONNA_CHAT_UNAVAILABLE) escapes to the caller's
  // mcpFailureFromError and is rendered with its code; nothing is receipted
  // for a refused call, exactly as before — the receipt records what was
  // served.
  const executor = d.executors[tool.name];
  if (typeof executor !== 'function') {
    return failure(500, 'MCP_EXECUTOR_MISSING', `No executor is wired for tool '${tool.name}'.`);
  }
  const result = await executor({
    firmId,
    auth,
    access,
    entities,
    args,
    surface: resolvedSurface,
    deps: d.executorDeps
  });

  const serialized = JSON.stringify(result);
  if (serialized.length > MCP_MAX_RESULT_CHARS) {
    return failure(
      500, 'RESULT_TOO_LARGE',
      'Result exceeded the response cap; narrow the query (pagination or a single entity).'
    );
  }

  const receiptId = await d.recordMcpToolReceipt({
    firmId,
    clientId: args.entity_id || null,
    tool: tool.name,
    args,
    resultMeta: resultMetaFor(tool.name, result),
    surface: resolvedSurface,
    principal: receiptPrincipalFor(auth),
    // Donna's own model id on the converse tier (from the engine's result
    // for THIS turn), null on the read tier.
    modelId: receiptModelIdFor(tool, result),
    deps: d.executorDeps
  });

  return { status: 200, body: { ok: true, tool: tool.name, receipt_id: receiptId, result } };
};

// Map an escaped error to the funnel's refusal shape. Shared by both
// transports so a firm-access denial reads the same on every door. An error
// that names its own HTTP status AND a refusal code (the ask_donna executor's
// DONNA_CHAT_UNAVAILABLE, the confirm_action executor's CONFIRM_* /
// ACTION_* codes, the billing gate's CLIENT_NOT_ENTITLED) keeps both;
// anything else is an internal failure.
export const mcpFailureFromError = (error) => {
  if (error?.statusCode === 403 || /access denied/i.test(String(error?.message || ''))) {
    return failure(403, 'ACCESS_DENIED', 'Access denied.');
  }
  if (Number.isInteger(error?.statusCode) && error.statusCode >= 400 && error.statusCode < 600
    && typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]+$/.test(error.code)) {
    return failure(error.statusCode, error.code, error.message || 'Refused.');
  }
  return failure(500, 'MCP_INTERNAL', error?.message || 'Internal error.');
};

export const handleMcpApiRequest = async (req, res, requestUrl, deps = {}) => {
  const d = funnelDeps(deps);

  try {
    // Step 1 — authenticated caller required, fail-closed (see header).
    if (!req.donnaAuth) {
      sendError(
        res, 403, 'MCP_AUTH_REQUIRED',
        'The MCP surface requires an authenticated caller. Configure DONNA_ACCESS_TOKEN and pass it on every request.'
      );
      return;
    }

    if (!d.isFirmDatabaseConfigured()) {
      sendError(res, 503, 'DB_NOT_CONFIGURED', 'Firm database is not configured.');
      return;
    }

    const firmId = requestUrl.searchParams.get('firm_id') || DEFAULT_FIRM_ID;

    if (requestUrl.pathname === '/api/donna/mcp/v1/tools' && req.method === 'GET') {
      // The local shim's surface: the read tier only, byte-identical listing.
      sendJson(res, 200, listMcpToolsPayload({ surface: DEFAULT_MCP_SURFACE }));
      return;
    }

    if (requestUrl.pathname === '/api/donna/mcp/v1/call' && req.method === 'POST') {
      let body;
      try {
        body = await readJsonBody(req);
      } catch (error) {
        sendError(res, 400, error.code || 'BAD_REQUEST', error.message);
        return;
      }

      const outcome = await invokeMcpTool({
        auth: req.donnaAuth,
        firmId,
        toolName: body?.tool,
        rawArgs: body?.arguments,
        surface: DEFAULT_MCP_SURFACE,
        deps: d
      });
      sendJson(res, outcome.status, outcome.body);
      return;
    }

    sendError(res, 404, 'NOT_FOUND', 'Donna MCP route not found.');
  } catch (error) {
    const outcome = mcpFailureFromError(error);
    sendJson(res, outcome.status, outcome.body);
  }
};
