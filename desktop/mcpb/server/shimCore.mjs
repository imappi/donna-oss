// Donna MCPB shim — CORE logic (docs/design-donna-mcp-surface.md §4).
//
// THE THIN-SHIM RULE, enforced by construction: this file contains NO
// accounting logic, NO policy logic, NO authorization logic, and NO database
// access. It translates between two wire formats:
//
//   Claude Desktop  ⟷  MCP JSON-RPC over stdio (index.mjs owns the pipe)
//   Donna           ⟷  the authenticated local HTTP API over the unix
//                      socket named in the endpoint handshake file
//
// Every decision — which entities are visible, what a tool may read, whether
// a call is receipted — is Donna's (server/donna/mcp/*). If this file ever
// needs its own logic beyond translation, scope has leaked: stop.
//
// One sanctioned CONTENT exception (Kari, 2026-08-20; design doc §8 item 2):
// when NO endpoint file exists (Donna not installed / not running), tools/call
// answers from demoFixtures.mjs — a clearly labeled sample company so a
// directory browser can try the extension before connecting anything. Demo
// data never mixes with a live Donna: an existing endpoint always forwards,
// and a failed connection to a live endpoint stays an error, never demo.
//
// Endpoint discovery: desktop/lib/mcpEndpointFile.mjs writes
// <dataDir>/runtime/mcp-endpoint.json at boot; dataDir is Electron's
// userData for app name 'Donna' (main.mjs app.setName), overridable with
// DONNA_DESKTOP_DATA_DIR. The candidates below mirror that contract — keep
// the two files in lockstep.

import http from 'node:http';
import path from 'node:path';

import { DEMO_ENTITY_ID, demoResultFor } from './demoFixtures.mjs';

export const SHIM_NAME = 'donna-books';
export const SHIM_VERSION = '0.2.1';
export const DEFAULT_PROTOCOL_VERSION = '2025-06-18';
export const API_PREFIX = '/api/donna/mcp';

// ── Endpoint discovery ─────────────────────────────────────────────────────

export const endpointFileCandidates = ({
  platform = process.platform,
  env = process.env,
  home = env.HOME || env.USERPROFILE || ''
} = {}) => {
  const candidates = [];
  const push = (dataDir) => {
    if (dataDir) candidates.push(path.join(dataDir, 'runtime', 'mcp-endpoint.json'));
  };
  // Explicit overrides first: the endpoint file itself, then the data dir.
  if (env.DONNA_MCP_ENDPOINT_FILE) candidates.push(env.DONNA_MCP_ENDPOINT_FILE);
  push(env.DONNA_DESKTOP_DATA_DIR);
  if (platform === 'darwin') {
    push(path.join(home, 'Library', 'Application Support', 'Donna'));
  } else if (platform === 'win32') {
    push(env.APPDATA ? path.join(env.APPDATA, 'Donna') : null);
  } else {
    push(env.XDG_CONFIG_HOME ? path.join(env.XDG_CONFIG_HOME, 'Donna') : null);
    push(path.join(home, '.config', 'Donna'));
  }
  return candidates;
};

export const readEndpoint = ({ fsImpl, platform, env, home } = {}) => {
  for (const candidate of endpointFileCandidates({ platform, env, home })) {
    try {
      const parsed = JSON.parse(fsImpl.readFileSync(candidate, 'utf8'));
      if (parsed?.socket_path && parsed?.token) {
        return {
          socketPath: parsed.socket_path,
          token: parsed.token,
          apiPrefix: parsed.api_prefix || API_PREFIX
        };
      }
    } catch {
      // missing/unreadable candidate — try the next
    }
  }
  return null;
};

// ── Donna HTTP client (unix socket) ────────────────────────────────────────

export const donnaRequest = ({ endpoint, method = 'GET', apiPath, body = null, httpImpl = http }) =>
  new Promise((resolve, reject) => {
    const payload = body == null ? null : JSON.stringify(body);
    const request = httpImpl.request(
      {
        socketPath: endpoint.socketPath,
        method,
        path: apiPath,
        headers: {
          'x-donna-access-token': endpoint.token,
          ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {})
        }
      },
      (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          try {
            resolve({ status: response.statusCode, json: text ? JSON.parse(text) : null });
          } catch {
            resolve({ status: response.statusCode, json: null, text });
          }
        });
      }
    );
    request.on('error', reject);
    if (payload) request.write(payload);
    request.end();
  });

// ── Tool mapping (1:1, no additions) ───────────────────────────────────────

// Static mirror of the registry's names/descriptions, used ONLY when Donna is
// not running so Claude Desktop still lists the tools instead of showing a
// broken extension. server/donna/mcp/mcpReadSurface.js is authoritative — a
// live tools/list always comes from Donna; this mirror carries no schemas
// beyond the entity_id/paging scalars and must never grow logic.
export const STATIC_TOOL_MIRROR = Object.freeze([
  { name: 'entity_list', description: 'List the businesses this Donna installation exposes to Claude, with a close-status summary for each.', input_schema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'close_status', description: 'Close/reconcile state for one entity: bucket counts, close blockers, open owner questions.', input_schema: { type: 'object', properties: { entity_id: { type: 'string' } }, required: ['entity_id'], additionalProperties: false } },
  { name: 'unmatched_items', description: 'Unresolved transactions and documents for one entity, paginated.', input_schema: { type: 'object', properties: { entity_id: { type: 'string' }, page: { type: 'integer' }, page_size: { type: 'integer' } }, required: ['entity_id'], additionalProperties: false } },
  { name: 'document_status', description: 'Outstanding document/evidence requests, per entity or across all exposed entities.', input_schema: { type: 'object', properties: { entity_id: { type: 'string' } }, additionalProperties: false } },
  { name: 'audit_recent', description: 'Recent Donna actions from the audit trail, per entity or across all exposed entities.', input_schema: { type: 'object', properties: { entity_id: { type: 'string' }, limit: { type: 'integer' } }, additionalProperties: false } }
]);

export const toMcpTool = (tool) => ({
  name: tool.name,
  description: tool.description,
  inputSchema: tool.input_schema,
  // Read-only annotations — true for every Donna tool by construction
  // (the server registry has no other tier).
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: false
  }
});

const textResult = (text, { isError = false } = {}) => ({
  content: [{ type: 'text', text }],
  ...(isError ? { isError: true } : {})
});

const NOT_RUNNING_TEXT =
  'Donna is not reachable. Open the Donna desktop app on this machine, then try again. '
  + '(If Donna is running, MCP access may not be enabled — entities are exposed one by one inside Donna.)';

const DEMO_NOT_FOUND_TEXT = (entityId) =>
  `No entity '${entityId}' here. Donna is not running on this machine, so only the bundled `
  + `sample company ('${DEMO_ENTITY_ID}', demo data) is available. Open the Donna desktop app `
  + 'to reach real books.';

// Demo mode (no endpoint file at all): answer from the labeled fixtures.
const demoCallResult = (toolName, args) => {
  const demo = demoResultFor(toolName, args);
  if (!demo) return textResult(`Unknown tool '${String(toolName || '')}'.`, { isError: true });
  if (demo.notFound) return textResult(DEMO_NOT_FOUND_TEXT(args?.entity_id), { isError: true });
  return textResult(JSON.stringify(demo.result, null, 2));
};

// ── MCP message handling ───────────────────────────────────────────────────

// Returns a JSON-RPC response object, or null for notifications. ctx carries
// { getEndpoint, httpImpl } so tests can stub both.
export const handleMcpMessage = async (message, ctx) => {
  if (!message || message.jsonrpc !== '2.0') return null;
  const { id, method, params } = message;
  const isRequest = id !== undefined && id !== null;

  const reply = (result) => ({ jsonrpc: '2.0', id, result });
  const replyError = (code, msg) => ({ jsonrpc: '2.0', id, error: { code, message: msg } });

  if (method === 'initialize') {
    return reply({
      protocolVersion: params?.protocolVersion || DEFAULT_PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: { name: SHIM_NAME, version: SHIM_VERSION }
    });
  }
  if (method === 'notifications/initialized') return null;
  if (method === 'ping') return reply({});

  if (method === 'tools/list') {
    const endpoint = ctx.getEndpoint();
    if (endpoint) {
      try {
        const response = await donnaRequest({
          endpoint,
          apiPath: `${endpoint.apiPrefix}/v1/tools`,
          httpImpl: ctx.httpImpl
        });
        if (response.status === 200 && Array.isArray(response.json?.tools)) {
          return reply({ tools: response.json.tools.map(toMcpTool) });
        }
      } catch {
        // fall through to the static mirror
      }
    }
    return reply({ tools: STATIC_TOOL_MIRROR.map(toMcpTool) });
  }

  if (method === 'tools/call') {
    const toolName = params?.name;
    const endpoint = ctx.getEndpoint();
    if (!endpoint) return reply(demoCallResult(toolName, params?.arguments || {}));
    try {
      const response = await donnaRequest({
        endpoint,
        method: 'POST',
        apiPath: `${endpoint.apiPrefix}/v1/call`,
        body: { tool: toolName, arguments: params?.arguments || {} },
        httpImpl: ctx.httpImpl
      });
      if (response.status === 200 && response.json?.ok) {
        return reply(textResult(JSON.stringify(response.json.result, null, 2)));
      }
      const code = response.json?.code || `HTTP_${response.status}`;
      const errorText = response.json?.error || 'Donna refused the call.';
      return reply(textResult(`Donna refused this call (${code}): ${errorText}`, { isError: true }));
    } catch {
      return reply(textResult(NOT_RUNNING_TEXT, { isError: true }));
    }
  }

  if (isRequest) return replyError(-32601, `Method not found: ${method}`);
  return null;
};

// Newline-delimited JSON framing: feed raw chunks in, get parsed messages
// out. Returns { messages, rest } so the caller keeps the partial tail.
export const splitNdjson = (buffer) => {
  const messages = [];
  let rest = buffer;
  for (;;) {
    const idx = rest.indexOf('\n');
    if (idx === -1) break;
    const line = rest.slice(0, idx).trim();
    rest = rest.slice(idx + 1);
    if (!line) continue;
    try {
      messages.push(JSON.parse(line));
    } catch {
      // A malformed line is dropped; the stream keeps going.
    }
  }
  return { messages, rest };
};
