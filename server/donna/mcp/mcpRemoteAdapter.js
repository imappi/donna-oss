// Donna hosted MCP endpoint — the remote transport adapter
// (docs/design-donna-chatgpt-app-build-brief.md §4.1: "thin protocol
// adapter, fat existing funnel"; slice-0 findings in §8 of the same doc).
//
// THE ADAPTER RULE, enforced by construction: this file translates between
// MCP JSON-RPC over Streamable HTTP and the ONE enforcement funnel in
// mcpApi.js (invokeMcpTool). It contains NO accounting logic, NO policy
// logic, NO authorization DECISION (it asks api.js to resolve the bearer and
// hands the result to the funnel), NO database access, and imports NO writer.
// mcpRemoteAdapter.test.js pins the import list. If this file ever needs a
// policy branch, scope has leaked — put the branch in the funnel.
//
// Paths (rewritten to the donna router in vercel.json; the desktop host
// fences them CLOUD_ONLY — a Unix socket has no chat host behind it):
//
//   POST /api/donna/mcp/remote/chatgpt   live, surface chatgpt_app
//   POST /api/donna/mcp/remote/claude    live, surface claude_remote
//   POST /api/donna/mcp/demo[/chatgpt|/claude]
//                                        anonymous demo — Harbor Lane fixtures
//                                        (read tools) + canned ask_donna
//                                        answers + a confirm_action that
//                                        applies nothing; never a model call
//   GET  /api/donna/mcp/oauth-protected-resource/api/donna/mcp/remote/<surface>
//                                        RFC 9728 metadata. Named in the 401
//                                        WWW-Authenticate challenge (which
//                                        both chat hosts follow) because
//                                        Vercel does not rewrite /.well-known
//                                        (brief §8 F4).
//
// Live vs demo are SEPARATE URLs on purpose (brief §8 F1): both chat hosts
// start their OAuth flow only from a 401 on the MCP URL, so one URL cannot
// both serve anonymous demo answers (200) and trigger sign-in (401). Demo
// never mixes with live: the demo path touches no database, no auth and no
// receipt; the live path never consults the fixtures — a live refusal is an
// error, never demo.
//
// MCP Apps (slice 4, mcpAppCards.js — SEP-1865 revision 2026-01-26): the
// resource methods (resources/list, resources/read, resources/templates/list)
// serve ONLY the one bundled `ui://` card resource — static HTML, no data,
// no policy, no funnel call, no receipt (there is nothing to receipt: the
// bundle carries no book content). close_status and ask_donna list
// `_meta.ui.resourceUri` so a host that declared the extension renders the
// card; every other host keeps the text block. The card's Confirm button
// arrives here as an ordinary tools/call of confirm_action, through the
// funnel like any other call.
//
// Transport posture — DUAL-ERA Streamable HTTP, stateless either way:
//   - modern (2026-07-28): every request carries its protocol version and
//     client capabilities in params._meta; the version, method and tool name
//     are mirrored into MCP-Protocol-Version / Mcp-Method / Mcp-Name headers
//     which this server validates; server/discover is implemented; results
//     carry resultType and serverInfo in _meta. No sessions, no GET stream.
//   - legacy (2025-03-26 … 2025-11-25): an `initialize` request selects the
//     handshake era; each POST is still independent (no Mcp-Session-Id is
//     minted; a client's session header is ignored); GET and DELETE answer
//     405 as those revisions allow; JSON-RPC batches are refused.

import {
  MCP_ASK_DONNA_TOOL_NAME,
  MCP_CONFIRM_ACTION_TOOL_NAME,
  MCP_SURFACES,
  findMcpTool
} from './mcpReadSurface.js';
import {
  invokeMcpTool,
  listMcpToolsPayload,
  mcpFailureFromError,
  readJsonBody
} from './mcpApi.js';
import { hostSupportsMcpUi, listMcpUiResources, mcpUiToolMeta, readMcpUiResource } from './mcpAppCards.js';
import { resolveRequestFirmId } from '../requestFirm.js';
import { DEMO_ENTITY_ID, demoResultFor } from '../../../desktop/mcpb/server/demoFixtures.mjs';
import { demoAskDonnaResultFor, demoConfirmActionResultFor } from '../../../desktop/mcpb/server/demoAskDonna.mjs';

export const MCP_REMOTE_SERVER_NAME = 'donna-books';
export const MCP_REMOTE_SERVER_VERSION = '0.5.0';

// Protocol revisions this adapter implements, newest first. Modern = the
// per-request-metadata era; legacy = the initialize-handshake era. A legacy
// client asking for a version outside the list is answered with the newest
// legacy one (it then accepts or disconnects, per that era's negotiation);
// a modern client gets UnsupportedProtocolVersionError naming the list.
export const MCP_MODERN_PROTOCOL_VERSIONS = Object.freeze(['2026-07-28']);
export const MCP_LEGACY_PROTOCOL_VERSIONS = Object.freeze(['2025-11-25', '2025-06-18', '2025-03-26']);
export const MCP_SUPPORTED_PROTOCOL_VERSIONS = Object.freeze([
  ...MCP_MODERN_PROTOCOL_VERSIONS,
  ...MCP_LEGACY_PROTOCOL_VERSIONS
]);

export const MCP_REMOTE_PATH_PREFIX = '/api/donna/mcp/remote';
export const MCP_DEMO_PATH_PREFIX = '/api/donna/mcp/demo';
export const MCP_PROTECTED_RESOURCE_PATH_PREFIX = '/api/donna/mcp/oauth-protected-resource';

// The reserved _meta keys of the modern era (2026-07-28 basic/index §_meta).
const META_PROTOCOL_VERSION = 'io.modelcontextprotocol/protocolVersion';
const META_CLIENT_INFO = 'io.modelcontextprotocol/clientInfo';
const META_CLIENT_CAPABILITIES = 'io.modelcontextprotocol/clientCapabilities';
const META_SERVER_INFO = 'io.modelcontextprotocol/serverInfo';

// Modern-era JSON-RPC error codes (2026-07-28 basic/index §error codes).
const ERR_HEADER_MISMATCH = -32020;
const ERR_UNSUPPORTED_PROTOCOL_VERSION = -32022;
// Resource not found (server/resources: -32002).
const ERR_RESOURCE_NOT_FOUND = -32002;

// What this server declares: tools, and the resource list/read the MCP Apps
// card bundle rides on. No subscriptions, no list-changed notifications
// (stateless).
const SERVER_CAPABILITIES = Object.freeze({
  tools: Object.freeze({ listChanged: false }),
  resources: Object.freeze({ subscribe: false, listChanged: false })
});

// URL segment → surface. The registered URL IS the attribution: a chat host
// is registered against one of these paths and every receipt names it.
export const MCP_REMOTE_SURFACE_BY_SEGMENT = Object.freeze({
  chatgpt: MCP_SURFACES.chatgpt_app,
  claude: MCP_SURFACES.claude_remote
});

// Hosted demo copy (bridge register — states plainly where results go; no
// custody slogans; points at the real consent path). The FIXTURES are the
// shim's, imported, never copied; only this notice is the hosted surface's
// own, because the shim's notice names the desktop app as the way in.
export const MCP_DEMO_NOTICE_HOSTED =
  'DEMO DATA — nothing here is real. This is Donna’s public demo endpoint, '
  + 'answering from a sample company, Harbor Lane Coffee Ltd. Nothing here is '
  + 'your data and nothing you ask changes any books. To reach real books, sign '
  + 'in to Donna, expose a business under Settings → AI chat access, and connect '
  + 'the authenticated Donna endpoint with your Donna account. Tool results are '
  + 'sent to the chat provider you are using.';

export const MCP_REMOTE_INSTRUCTIONS_LIVE =
  'Donna runs the books for the businesses their owners have exposed to this '
  + 'chat surface. The read tools show close status, blockers, outstanding '
  + 'documents and Donna’s recent activity. ask_donna sends the owner’s message '
  + 'to Donna, who answers from the books with her own model; the message and '
  + 'her reply are saved to the owner’s chat thread in Donna, and any action she '
  + 'proposes is NOT applied by that call. confirm_action applies ONE proposed '
  + 'action on the owner’s explicit say-so: their answer to one of Donna’s open '
  + 'questions, or a mileage entry, through the same tracked path as the Confirm '
  + 'button in their Donna portal; nothing else can be confirmed from here, and '
  + 'nothing here posts, approves, files or sends anything else. Every call is '
  + 'written to Donna’s audit trail, naming this chat as the door. Tool results '
  + 'are sent to the chat provider you are using.';

export const MCP_REMOTE_INSTRUCTIONS_DEMO =
  'This is Donna’s public DEMO endpoint: every answer comes from a labeled '
  + 'sample company (Harbor Lane Coffee Ltd) and nothing here is real or '
  + 'changes any books. The read tools show close status, blockers, outstanding '
  + 'documents and Donna’s recent activity; ask_donna answers a small set of '
  + 'demo questions about the sample company from canned text, with no model '
  + 'call; confirm_action shows the shape of confirming a demo proposal and '
  + 'records nothing. Tool results are sent to the chat provider you are using.';

// ── Path classification ────────────────────────────────────────────────────

const stripPrefix = (pathname, prefix) => {
  if (pathname === prefix) return '';
  if (pathname.startsWith(`${prefix}/`)) return pathname.slice(prefix.length + 1);
  return null;
};

// { mode: 'live' | 'demo' | 'protected_resource', segment, surface, mcpPath }
// or null when the path is not this adapter's.
export const classifyMcpRemotePath = (pathname) => {
  const live = stripPrefix(pathname, MCP_REMOTE_PATH_PREFIX);
  if (live != null) {
    return { mode: 'live', segment: live, surface: MCP_REMOTE_SURFACE_BY_SEGMENT[live] || null, mcpPath: pathname };
  }
  const demo = stripPrefix(pathname, MCP_DEMO_PATH_PREFIX);
  if (demo != null) {
    return { mode: 'demo', segment: demo, surface: demo ? MCP_REMOTE_SURFACE_BY_SEGMENT[demo] || null : null, mcpPath: pathname };
  }
  const prm = stripPrefix(pathname, MCP_PROTECTED_RESOURCE_PATH_PREFIX);
  if (prm != null) return { mode: 'protected_resource', resourcePath: prm ? `/${prm}` : '', mcpPath: pathname };
  return null;
};

export const isMcpRemotePath = (pathname) => classifyMcpRemotePath(pathname) != null;

// ── HTTP helpers ───────────────────────────────────────────────────────────

const sendJson = (res, statusCode, payload, headers = {}) => {
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json');
  for (const [key, value] of Object.entries(headers)) res.setHeader(key, value);
  res.end(JSON.stringify(payload));
};

const sendEmpty = (res, statusCode, headers = {}) => {
  res.statusCode = statusCode;
  for (const [key, value] of Object.entries(headers)) res.setHeader(key, value);
  res.end();
};

const headerValue = (req, name) => {
  const raw = req.headers?.[name.toLowerCase()];
  if (Array.isArray(raw)) return String(raw[0] ?? '');
  return raw == null ? '' : String(raw);
};

// Base64 sentinel decoding for Mcp-Name (2026-07-28 transport §value encoding).
const decodeHeaderValue = (value) => {
  const match = /^=\?base64\?(.*)\?=$/.exec(value);
  if (!match) return value;
  try {
    return Buffer.from(match[1], 'base64').toString('utf8');
  } catch {
    return value;
  }
};

const rpcError = (id, code, message, data) => ({
  jsonrpc: '2.0',
  id: id === undefined ? null : id,
  error: { code, message, ...(data !== undefined ? { data } : {}) }
});

const serverInfoFor = (mode) => ({
  name: mode === 'demo' ? `${MCP_REMOTE_SERVER_NAME}-demo` : MCP_REMOTE_SERVER_NAME,
  version: MCP_REMOTE_SERVER_VERSION
});

const instructionsFor = (mode) => (mode === 'demo' ? MCP_REMOTE_INSTRUCTIONS_DEMO : MCP_REMOTE_INSTRUCTIONS_LIVE);

// A result in the shape the caller's era expects: modern results carry
// resultType + serverInfo in _meta; legacy results are the bare object.
const eraResult = (era, mode, result) =>
  era === 'modern'
    ? { resultType: 'complete', ...result, _meta: { ...(result._meta || {}), [META_SERVER_INFO]: serverInfoFor(mode) } }
    : result;

const textResult = (text, { isError = false, structured = null } = {}) => ({
  content: [{ type: 'text', text }],
  ...(structured ? { structuredContent: structured } : {}),
  ...(isError ? { isError: true } : {})
});

// Registry tool → MCP tool (1:1). Annotations are COPIED from the registry
// entry (mcpReadSurface.js decides them as data: the read tier is read-only
// and idempotent; ask_donna is neither, because it appends to the owner's
// thread). Both chat hosts key their per-call confirmation on readOnlyHint
// (brief §8 F2/F3), so the copy must be honest; the funnel refuses anyway if
// an annotation ever lied. `title` is required by Claude's review criteria
// (brief §8 F2). `_meta.ui` (the card) is copied from the registry's `ui`
// data when the listing is for a host that renders MCP Apps (`ui: true`);
// a text-only listing carries no `_meta`.
export const toRemoteMcpTool = (tool, { ui = true } = {}) => {
  const uiMeta = ui ? mcpUiToolMeta(tool) : null;
  return {
    name: tool.name,
    ...(tool.title ? { title: tool.title } : {}),
    description: tool.description,
    inputSchema: tool.input_schema,
    annotations: {
      ...(tool.title ? { title: tool.title } : {}),
      ...tool.annotations
    },
    ...(uiMeta ? { _meta: uiMeta } : {})
  };
};

// The surface an un-segmented demo URL lists for. Both hosted surfaces carry
// the same tool set (pinned in mcpRemoteAdapter.test.js); ChatGPT leads the
// distribution (CLAUDE.md, 2026-09-14), so its listing is the demo's.
export const MCP_DEMO_LISTING_SURFACE = MCP_SURFACES.chatgpt_app;

const legacyNegotiatedVersion = (requested) => {
  const version = String(requested || '');
  return MCP_LEGACY_PROTOCOL_VERSIONS.includes(version) ? version : MCP_LEGACY_PROTOCOL_VERSIONS[0];
};

const DEMO_NOT_FOUND_TEXT = (entityId) =>
  `No entity '${String(entityId || '')}' here. This is Donna’s public demo endpoint, so only the `
  + `sample company ('${DEMO_ENTITY_ID}', demo data) is available. Connect the authenticated `
  + 'Donna endpoint with your Donna account to reach real books.';

// ── The two content sources ────────────────────────────────────────────────

// Live: the funnel. Every refusal the funnel returns becomes an isError tool
// result naming the code — a refused tool call is a tool outcome the model
// should read, not a transport failure (the shim translates the same way).
const liveToolCall = async ({ auth, firmId, surface, params, deps }) => {
  let outcome;
  try {
    outcome = await deps.invokeMcpTool({
      auth,
      firmId,
      toolName: params?.name,
      rawArgs: params?.arguments,
      surface,
      deps: deps.funnelDeps
    });
  } catch (error) {
    outcome = deps.mcpFailureFromError(error);
  }
  if (outcome.status === 200 && outcome.body?.ok) {
    return textResult(JSON.stringify(outcome.body.result, null, 2), { structured: outcome.body.result });
  }
  const code = outcome.body?.code || `HTTP_${outcome.status}`;
  const message = outcome.body?.error || 'Donna refused the call.';
  return textResult(`Donna refused this call (${code}): ${message}`, { isError: true });
};

// Demo: the shim's fixtures (read tools), the canned Harbor Lane answer set
// (ask_donna) and the applies-nothing confirmation (confirm_action) — both
// from demoAskDonna.mjs, content beside the fixtures — hosted notice, no
// model, no DB, no receipt. Content routing by tool name only; no policy.
const demoContentFor = ({ toolName, args, deps }) => {
  if (toolName === MCP_ASK_DONNA_TOOL_NAME) return deps.demoAskDonnaResultFor(args);
  if (toolName === MCP_CONFIRM_ACTION_TOOL_NAME) return deps.demoConfirmActionResultFor(args);
  return deps.demoResultFor(toolName, args);
};

const demoToolCall = ({ params, deps }) => {
  const toolName = String(params?.name || '');
  // The demo lists exactly the hosted registry — a demo answer for a tool the
  // real surface does not carry would be a fiction about the product.
  if (!findMcpTool(toolName)) return textResult(`Unknown tool '${toolName}'.`, { isError: true });
  const demo = demoContentFor({ toolName, args: params?.arguments || {}, deps });
  if (!demo) return textResult(`Unknown tool '${toolName}'.`, { isError: true });
  if (demo.notFound) return textResult(DEMO_NOT_FOUND_TEXT(params?.arguments?.entity_id), { isError: true });
  const result = { ...demo.result, demo: true, demo_notice: MCP_DEMO_NOTICE_HOSTED };
  return textResult(JSON.stringify(result, null, 2), { structured: result });
};

// ── Era detection + modern-era validation ──────────────────────────────────

// A modern request declares its version in params._meta (the header mirrors
// it). Anything else — an `initialize`, or a request with no per-request
// metadata — is served under legacy semantics.
const detectEra = (message, req) => {
  const metaVersion = message?.params?._meta?.[META_PROTOCOL_VERSION];
  if (typeof metaVersion === 'string') return 'modern';
  const headerVersion = headerValue(req, 'MCP-Protocol-Version');
  if (MCP_MODERN_PROTOCOL_VERSIONS.includes(headerVersion) && message?.method !== 'initialize') return 'modern';
  return 'legacy';
};

// Returns null when the modern request is valid, else { status, payload }.
const validateModernRequest = (message, req) => {
  const { id, method, params } = message;
  const meta = params?._meta || {};
  const version = meta[META_PROTOCOL_VERSION];
  const headerVersion = headerValue(req, 'MCP-Protocol-Version');
  if (typeof version !== 'string' || !meta[META_CLIENT_CAPABILITIES] || typeof meta[META_CLIENT_CAPABILITIES] !== 'object') {
    return { status: 400, payload: rpcError(id, -32602, `Invalid params: ${META_PROTOCOL_VERSION} and ${META_CLIENT_CAPABILITIES} are required in _meta.`) };
  }
  if (!headerVersion) {
    return { status: 400, payload: rpcError(id, ERR_HEADER_MISMATCH, 'Header mismatch: MCP-Protocol-Version header is missing.') };
  }
  if (headerVersion !== version) {
    return { status: 400, payload: rpcError(id, ERR_HEADER_MISMATCH, `Header mismatch: MCP-Protocol-Version header value '${headerVersion}' does not match body value '${version}'.`) };
  }
  if (!MCP_MODERN_PROTOCOL_VERSIONS.includes(version)) {
    return {
      status: 400,
      payload: rpcError(id, ERR_UNSUPPORTED_PROTOCOL_VERSION, 'Unsupported protocol version', {
        supported: [...MCP_SUPPORTED_PROTOCOL_VERSIONS],
        requested: version
      })
    };
  }
  const mcpMethod = headerValue(req, 'Mcp-Method');
  if (!mcpMethod) {
    return { status: 400, payload: rpcError(id, ERR_HEADER_MISMATCH, 'Header mismatch: Mcp-Method header is missing.') };
  }
  if (mcpMethod !== method) {
    return { status: 400, payload: rpcError(id, ERR_HEADER_MISMATCH, `Header mismatch: Mcp-Method header value '${mcpMethod}' does not match body value '${method}'.`) };
  }
  if (method === 'tools/call') {
    const mcpName = decodeHeaderValue(headerValue(req, 'Mcp-Name'));
    if (!mcpName) {
      return { status: 400, payload: rpcError(id, ERR_HEADER_MISMATCH, 'Header mismatch: Mcp-Name header is missing.') };
    }
    if (mcpName !== String(params?.name ?? '')) {
      return { status: 400, payload: rpcError(id, ERR_HEADER_MISMATCH, `Header mismatch: Mcp-Name header value '${mcpName}' does not match body value '${String(params?.name ?? '')}'.`) };
    }
  }
  return null;
};

// ── JSON-RPC dispatch ──────────────────────────────────────────────────────

// Returns { status, payload | null }. A null payload ⇒ 202 with no body (a
// notification or a client-sent response — nothing to answer).
const dispatchMessage = async (message, ctx) => {
  if (!message || typeof message !== 'object' || Array.isArray(message)) {
    return { status: 400, payload: rpcError(null, -32600, 'Invalid Request: expected a single JSON-RPC 2.0 object (batches are not supported).') };
  }
  if (message.jsonrpc !== '2.0') {
    return { status: 400, payload: rpcError(message.id, -32600, 'Invalid Request: jsonrpc must be "2.0".') };
  }
  const { id, method, params } = message;
  const hasId = id !== undefined && id !== null;
  if (typeof method !== 'string') {
    // A JSON-RPC response from the client (we never send requests) — accept.
    return { status: 202, payload: null };
  }
  if (!hasId) return { status: 202, payload: null };

  const era = ctx.era;
  const reply = (result) => ({ status: 200, payload: { jsonrpc: '2.0', id, result: eraResult(era, ctx.mode, result) } });

  if (era === 'modern') {
    const invalid = validateModernRequest(message, ctx.req);
    if (invalid) return invalid;
  }

  switch (method) {
    case 'initialize':
      // Legacy handshake. (A modern client never sends it; if one did with
      // modern _meta it is simply an unknown method to that era.)
      if (era === 'modern') return { status: 404, payload: rpcError(id, -32601, 'Method not found: initialize (this server speaks 2026-07-28 statelessly; use server/discover).') };
      return reply({
        protocolVersion: legacyNegotiatedVersion(params?.protocolVersion),
        capabilities: SERVER_CAPABILITIES,
        serverInfo: serverInfoFor(ctx.mode),
        instructions: instructionsFor(ctx.mode)
      });
    case 'server/discover':
      if (era === 'legacy') return { status: 200, payload: rpcError(id, -32601, 'Method not found: server/discover') };
      return reply({
        supportedVersions: [...MCP_SUPPORTED_PROTOCOL_VERSIONS],
        capabilities: SERVER_CAPABILITIES,
        instructions: instructionsFor(ctx.mode),
        ttlMs: 300_000,
        cacheScope: 'public'
      });
    case 'ping':
      return reply({});
    case 'tools/list': {
      // The card metadata is listed for a host that renders MCP Apps. The
      // modern era says so per request (clientCapabilities in _meta); the
      // legacy era said so on initialize, which a stateless server cannot
      // remember, so the legacy listing carries it and a host without the
      // extension keeps the text block (the spec's text-only fallback).
      const ui = era === 'modern' ? hostSupportsMcpUi(params?._meta?.[META_CLIENT_CAPABILITIES]) : true;
      return reply({
        tools: ctx.deps.listMcpToolsPayload({ surface: ctx.surface || MCP_DEMO_LISTING_SURFACE }).tools.map((tool) => toRemoteMcpTool(tool, { ui })),
        ...(era === 'modern' ? { ttlMs: 300_000, cacheScope: 'public' } : {})
      });
    }
    // The MCP Apps card bundle — the ONLY resource this server has. Static
    // content: no funnel, no DB, no auth decision, no receipt (the live path
    // still resolved its principal before dispatch; the demo path serves the
    // same bundle anonymously, exactly like its fixtures).
    case 'resources/list':
      return reply(listMcpUiResources({ surface: ctx.surface || MCP_DEMO_LISTING_SURFACE, serverUrl: ctx.serverUrl }));
    case 'resources/templates/list':
      return reply({ resourceTemplates: [] });
    case 'resources/read': {
      if (!params || typeof params.uri !== 'string') {
        return { status: era === 'modern' ? 400 : 200, payload: rpcError(id, -32602, 'Invalid params: resources/read requires a uri.') };
      }
      const resource = readMcpUiResource({ uri: params.uri, surface: ctx.surface || MCP_DEMO_LISTING_SURFACE, serverUrl: ctx.serverUrl });
      if (!resource) return { status: 200, payload: rpcError(id, ERR_RESOURCE_NOT_FOUND, 'Resource not found', { uri: params.uri }) };
      return reply(resource);
    }
    case 'tools/call': {
      if (!params || typeof params.name !== 'string') {
        return { status: era === 'modern' ? 400 : 200, payload: rpcError(id, -32602, 'Invalid params: tools/call requires a tool name.') };
      }
      const result = ctx.mode === 'demo'
        ? demoToolCall({ params, deps: ctx.deps })
        : await liveToolCall({ auth: ctx.auth, firmId: ctx.firmId, surface: ctx.surface, params, deps: ctx.deps });
      ctx.deps.log({
        surface: ctx.surface?.id || 'unregistered',
        mode: ctx.mode,
        era,
        tool: params.name,
        ok: !result.isError,
        principal_type: ctx.auth?.type || null,
        client: params?._meta?.[META_CLIENT_INFO]?.name || null
      });
      return reply(result);
    }
    default:
      return { status: era === 'modern' ? 404 : 200, payload: rpcError(id, -32601, `Method not found: ${method}`) };
  }
};

// ── The handler ────────────────────────────────────────────────────────────

const defaultLog = (fields) => {
  try {
    console.info(`[mcp-remote] ${JSON.stringify(fields)}`);
  } catch {
    // logging is never load-bearing
  }
};

const resolveOrigin = (req, deps) => {
  const fromDeps = typeof deps.publicOrigin === 'function' ? deps.publicOrigin(req) : '';
  if (fromDeps) return String(fromDeps).replace(/\/+$/, '');
  const proto = String(req.headers?.['x-forwarded-proto'] || 'https').split(',')[0].trim();
  const host = String(req.headers?.['x-forwarded-host'] || req.headers?.host || '').split(',')[0].trim();
  return host ? `${proto}://${host}` : '';
};

const hasBearer = (req) => /^Bearer\s+\S+/i.test(String(req.headers?.authorization || ''))
  || Boolean(String(req.headers?.['x-donna-access-token'] || '').trim());

// RFC 9728 protected-resource metadata for one live surface. The
// authorization server is configuration (MCP_REMOTE_OAUTH_ISSUER — the
// issuer URL the chat host will register against; for Supabase's OAuth 2.1
// server that is `https://<ref>.supabase.co/auth/v1`); unset ⇒ 503, never
// a guessed issuer.
const protectedResourceMetadata = ({ origin, mcpPath, env }) => {
  const issuer = String(env.MCP_REMOTE_OAUTH_ISSUER || '').trim().replace(/\/+$/, '');
  if (!issuer) return null;
  const scopes = String(env.MCP_REMOTE_OAUTH_SCOPES || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return {
    resource: `${origin}${mcpPath}`,
    authorization_servers: [issuer],
    bearer_methods_supported: ['header'],
    ...(scopes.length ? { scopes_supported: scopes } : {}),
    resource_name: 'Donna',
    resource_documentation: `${origin}/claude`
  };
};

export const protectedResourceMetadataUrl = ({ origin, mcpPath }) =>
  `${origin}${MCP_PROTECTED_RESOURCE_PATH_PREFIX}${mcpPath}`;

export const handleMcpRemoteRequest = async (req, res, requestUrl, deps = {}) => {
  const d = {
    resolveAuth: null,           // (req) => auth | null — api.js supplies the real resolver
    invokeMcpTool,
    mcpFailureFromError,
    listMcpToolsPayload,
    demoResultFor,
    demoAskDonnaResultFor,
    demoConfirmActionResultFor,
    funnelDeps: {},
    publicOrigin: null,
    env: process.env,
    log: defaultLog,
    ...deps
  };

  const route = classifyMcpRemotePath(requestUrl.pathname);
  if (!route) {
    sendJson(res, 404, { ok: false, code: 'NOT_FOUND', error: 'Donna MCP route not found.' });
    return;
  }

  try {
    // RFC 9728 metadata — public by definition (it tells a client where to
    // sign in), one document per live surface path.
    if (route.mode === 'protected_resource') {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        sendJson(res, 405, { ok: false, code: 'METHOD_NOT_ALLOWED', error: 'GET only.' }, { Allow: 'GET' });
        return;
      }
      const target = classifyMcpRemotePath(route.resourcePath);
      if (!target || target.mode !== 'live' || !target.surface) {
        sendJson(res, 404, {
          ok: false,
          code: 'PROTECTED_RESOURCE_UNKNOWN',
          error: 'No such protected resource. Donna’s MCP resources are the per-surface paths under /api/donna/mcp/remote/.',
          resources: Object.keys(MCP_REMOTE_SURFACE_BY_SEGMENT).map((segment) => `${MCP_REMOTE_PATH_PREFIX}/${segment}`)
        });
        return;
      }
      const origin = resolveOrigin(req, d);
      const metadata = origin ? protectedResourceMetadata({ origin, mcpPath: target.mcpPath, env: d.env }) : null;
      if (!metadata) {
        sendJson(res, 503, { ok: false, code: 'MCP_OAUTH_NOT_CONFIGURED', error: 'The hosted MCP endpoint has no authorization server configured.' });
        return;
      }
      sendJson(res, 200, metadata, { 'Cache-Control': 'public, max-age=300' });
      return;
    }

    if (!route.surface && (route.mode === 'live' || route.segment)) {
      sendJson(res, 404, { ok: false, code: 'MCP_SURFACE_UNKNOWN', error: `No MCP surface '${route.segment}'.` });
      return;
    }

    // Streamable HTTP: POST carries JSON-RPC. GET would open the legacy
    // server-initiated stream this adapter never uses; DELETE ends a session
    // this adapter never opens. Both eras allow 405 here.
    if (req.method !== 'POST') {
      sendJson(res, 405, { ok: false, code: 'METHOD_NOT_ALLOWED', error: 'This MCP endpoint accepts JSON-RPC over POST only.' }, { Allow: 'POST' });
      return;
    }

    let auth = null;
    if (route.mode === 'live') {
      // Auth is RESOLVED by api.js (the same chain every firm route uses) and
      // DECIDED by the funnel; this adapter only turns "no principal" into
      // the 401 challenge the chat hosts need to start their sign-in flow.
      if (typeof d.resolveAuth !== 'function') {
        sendJson(res, 500, { ok: false, code: 'MCP_AUTH_RESOLVER_MISSING', error: 'The hosted MCP endpoint is mounted without an auth resolver.' });
        return;
      }
      auth = await d.resolveAuth(req);
      if (!auth) {
        const origin = resolveOrigin(req, d);
        const metadataUrl = protectedResourceMetadataUrl({ origin, mcpPath: route.mcpPath });
        const challenge = hasBearer(req)
          ? `Bearer error="invalid_token", error_description="The token was not accepted by Donna.", resource_metadata="${metadataUrl}"`
          : `Bearer resource_metadata="${metadataUrl}"`;
        sendJson(
          res, 401,
          { ok: false, code: 'AUTH_REQUIRED', error: 'Sign in to Donna to use this connector.' },
          { 'WWW-Authenticate': challenge }
        );
        return;
      }
    }

    let message;
    try {
      message = await readJsonBody(req);
    } catch (error) {
      const status = error?.code === 'BODY_TOO_LARGE' ? 413 : 400;
      sendJson(res, status, rpcError(null, -32700, error?.message || 'Parse error.'));
      return;
    }

    // The URL this request arrived on (origin + MCP path): what the chat host
    // registered, and what the card resource's Claude sandbox domain hashes.
    const requestOrigin = resolveOrigin(req, d);
    const ctx = {
      mode: route.mode,
      surface: route.surface,
      era: detectEra(message, req),
      req,
      auth,
      // The ONE request firm resolver (requestFirm.js): the authenticated
      // principal's firm, else the deployment default. The JSON-RPC body is
      // never consulted; a firm is not something a chat host names.
      firmId: auth ? resolveRequestFirmId({ auth }) : null,
      serverUrl: requestOrigin ? `${requestOrigin}${route.mcpPath}` : null,
      deps: d
    };
    const { status, payload } = await dispatchMessage(message, ctx);
    if (payload == null) {
      sendEmpty(res, status);
      return;
    }
    sendJson(res, status, payload);
  } catch (error) {
    sendJson(res, 500, rpcError(null, -32603, error?.message || 'Internal error.'));
  }
};
