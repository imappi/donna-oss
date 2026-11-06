// Donna MCPB shim core — unit tests.
//
// Load-bearing properties:
//   - the shim is pure translation: tools/list mirrors what Donna serves,
//     tools/call forwards verbatim and renders Donna's answer — no logic;
//   - NO endpoint file (Donna not installed / not running) ⇒ tools/list falls
//     back to the static mirror and tools/call answers from the LABELED demo
//     fixtures; an endpoint that exists but refuses the connection stays a
//     friendly isError text (never demo, never a hang, never a protocol
//     error);
//   - endpoint discovery honors overrides first and the platform userData
//     path contract shared with desktop/lib/mcpEndpointFile.mjs;
//   - ndjson framing survives partial chunks and malformed lines.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  endpointFileCandidates,
  readEndpoint,
  handleMcpMessage,
  splitNdjson,
  toMcpTool,
  STATIC_TOOL_MIRROR
} from './shimCore.mjs';
import { DEMO_ENTITY_ID } from './demoFixtures.mjs';

test('endpointFileCandidates: overrides first, then the platform userData path', () => {
  const darwin = endpointFileCandidates({
    platform: 'darwin',
    env: { DONNA_MCP_ENDPOINT_FILE: '/override/file.json', DONNA_DESKTOP_DATA_DIR: '/custom/data' },
    home: '/Users/kari'
  });
  assert.equal(darwin[0], '/override/file.json');
  assert.match(darwin[1], /custom[/\\]data/);
  assert.match(darwin[2], /Library[/\\]Application Support[/\\]Donna[/\\]runtime[/\\]mcp-endpoint\.json$/);

  const linux = endpointFileCandidates({ platform: 'linux', env: {}, home: '/home/kari' });
  assert.match(linux[0], /\.config[/\\]Donna/);
});

test('readEndpoint: first parseable candidate with socket+token wins; none ⇒ null', () => {
  const files = {
    '/a': 'not json',
    '/b': JSON.stringify({ socket_path: '/sock', token: 't1', api_prefix: '/api/donna/mcp' })
  };
  const fsImpl = {
    readFileSync: (p) => {
      if (p in files) return files[p];
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    }
  };
  const endpoint = readEndpoint({
    fsImpl,
    platform: 'linux',
    env: { DONNA_MCP_ENDPOINT_FILE: '/a', DONNA_DESKTOP_DATA_DIR: '/nope' },
    home: '/home/x'
  });
  assert.equal(endpoint, null, 'malformed override + missing candidates ⇒ null');

  const endpoint2 = readEndpoint({
    fsImpl,
    platform: 'linux',
    env: { DONNA_MCP_ENDPOINT_FILE: '/b' },
    home: '/home/x'
  });
  assert.deepEqual(endpoint2, { socketPath: '/sock', token: 't1', apiPrefix: '/api/donna/mcp' });
});

test('initialize / ping / unknown method follow JSON-RPC', async () => {
  const ctx = { getEndpoint: () => null, httpImpl: null };
  const init = await handleMcpMessage(
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } },
    ctx
  );
  assert.equal(init.result.protocolVersion, '2025-06-18');
  assert.equal(init.result.serverInfo.name, 'donna-books');
  assert.deepEqual(init.result.capabilities, { tools: {} });

  const ping = await handleMcpMessage({ jsonrpc: '2.0', id: 2, method: 'ping' }, ctx);
  assert.deepEqual(ping.result, {});

  const note = await handleMcpMessage({ jsonrpc: '2.0', method: 'notifications/initialized' }, ctx);
  assert.equal(note, null);

  const unknown = await handleMcpMessage({ jsonrpc: '2.0', id: 3, method: 'resources/list' }, ctx);
  assert.equal(unknown.error.code, -32601);
});

const fakeHttp = (routes) => ({
  request: (options, onResponse) => {
    const listeners = {};
    const chunks = [];
    return {
      on: () => {},
      write: (data) => chunks.push(data),
      end: () => {
        const handler = routes[`${options.method || 'GET'} ${options.path}`];
        const { status, body } = handler
          ? handler({ options, body: chunks.join('') })
          : { status: 404, body: {} };
        const response = {
          statusCode: status,
          on: (event, fn) => { listeners[event] = fn; }
        };
        onResponse(response);
        queueMicrotask(() => {
          listeners.data?.(Buffer.from(JSON.stringify(body)));
          listeners.end?.();
        });
      }
    };
  }
});

const ENDPOINT = { socketPath: '/sock', token: 'tok', apiPrefix: '/api/donna/mcp' };

test('tools/list: serves Donna\'s registry with read-only annotations; static mirror when down', async () => {
  const ctx = {
    getEndpoint: () => ENDPOINT,
    httpImpl: fakeHttp({
      'GET /api/donna/mcp/v1/tools': () => ({
        status: 200,
        body: { ok: true, tools: [{ name: 'entity_list', description: 'd', input_schema: { type: 'object' } }] }
      })
    })
  };
  const live = await handleMcpMessage({ jsonrpc: '2.0', id: 4, method: 'tools/list' }, ctx);
  assert.equal(live.result.tools.length, 1);
  assert.equal(live.result.tools[0].annotations.readOnlyHint, true);
  assert.equal(live.result.tools[0].annotations.destructiveHint, false);

  const down = await handleMcpMessage(
    { jsonrpc: '2.0', id: 5, method: 'tools/list' },
    { getEndpoint: () => null, httpImpl: null }
  );
  assert.equal(down.result.tools.length, STATIC_TOOL_MIRROR.length);
});

test('tools/call: forwards verbatim, renders Donna\'s result; refusals and downtime are isError text', async () => {
  let forwarded = null;
  const ctx = {
    getEndpoint: () => ENDPOINT,
    httpImpl: fakeHttp({
      'POST /api/donna/mcp/v1/call': ({ body, options }) => {
        forwarded = { body: JSON.parse(body), token: options.headers['x-donna-access-token'] };
        return { status: 200, body: { ok: true, tool: 'close_status', receipt_id: 'r1', result: { totals: { blocks_close: 2 } } } };
      }
    })
  };
  const okCall = await handleMcpMessage(
    { jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'close_status', arguments: { entity_id: 'a' } } },
    ctx
  );
  assert.deepEqual(forwarded.body, { tool: 'close_status', arguments: { entity_id: 'a' } });
  assert.equal(forwarded.token, 'tok');
  assert.equal(okCall.result.isError, undefined);
  assert.match(okCall.result.content[0].text, /blocks_close/);
  assert.doesNotMatch(okCall.result.content[0].text, /DEMO DATA/, 'a live Donna answer is never demo-labeled');

  const refusingCtx = {
    getEndpoint: () => ENDPOINT,
    httpImpl: fakeHttp({
      'POST /api/donna/mcp/v1/call': () => ({ status: 404, body: { ok: false, code: 'ENTITY_NOT_FOUND', error: 'No exposed entity.' } })
    })
  };
  const refused = await handleMcpMessage(
    { jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'close_status', arguments: { entity_id: 'x' } } },
    refusingCtx
  );
  assert.equal(refused.result.isError, true);
  assert.match(refused.result.content[0].text, /ENTITY_NOT_FOUND/);

  // Endpoint EXISTS but the connection dies (stale file, Donna crashed):
  // a plain error — never the demo, which could mask a real outage mid-close.
  const erroringHttp = {
    request: (options, onResponse) => {
      void onResponse;
      const listeners = {};
      return {
        on: (event, fn) => { listeners[event] = fn; },
        write: () => {},
        end: () => queueMicrotask(() => listeners.error?.(new Error('ECONNREFUSED')))
      };
    }
  };
  const downCall = await handleMcpMessage(
    { jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'entity_list' } },
    { getEndpoint: () => ENDPOINT, httpImpl: erroringHttp }
  );
  assert.equal(downCall.result.isError, true);
  assert.match(downCall.result.content[0].text, /not reachable/);
  assert.doesNotMatch(downCall.result.content[0].text, /DEMO DATA/);
});

test('tools/call with NO endpoint file: labeled demo fixtures, never a live-looking answer', async () => {
  const ctx = { getEndpoint: () => null, httpImpl: null };

  // The funnel moment: entity_list → close_status answers with blockers.
  const list = await handleMcpMessage(
    { jsonrpc: '2.0', id: 20, method: 'tools/call', params: { name: 'entity_list' } },
    ctx
  );
  assert.equal(list.result.isError, undefined, 'demo answers are results, not errors');
  assert.match(list.result.content[0].text, /"demo": true/);
  assert.match(list.result.content[0].text, /DEMO DATA — nothing here is real/);
  assert.match(list.result.content[0].text, /\(demo\)/, 'the sample company is labeled in its name');

  const close = await handleMcpMessage(
    { jsonrpc: '2.0', id: 21, method: 'tools/call', params: { name: 'close_status', arguments: { entity_id: DEMO_ENTITY_ID } } },
    ctx
  );
  assert.match(close.result.content[0].text, /"demo": true/);
  assert.match(close.result.content[0].text, /blocks_close/);
  assert.match(close.result.content[0].text, /"open_owner_asks": 2/);

  // Every remaining tool is demo-labeled too.
  for (const [id, name] of [[22, 'unmatched_items'], [23, 'document_status'], [24, 'audit_recent']]) {
    const reply = await handleMcpMessage(
      { jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: name === 'unmatched_items' ? { entity_id: DEMO_ENTITY_ID } : {} } },
      ctx
    );
    assert.equal(reply.result.isError, undefined, `${name} demo answer is a result`);
    assert.match(reply.result.content[0].text, /"demo": true/, `${name} carries the demo flag`);
    assert.match(reply.result.content[0].text, /DEMO DATA/, `${name} carries the demo notice`);
  }

  // A non-demo entity id in demo mode: honest not-found naming the demo.
  const wrongEntity = await handleMcpMessage(
    { jsonrpc: '2.0', id: 25, method: 'tools/call', params: { name: 'close_status', arguments: { entity_id: 'real-co' } } },
    ctx
  );
  assert.equal(wrongEntity.result.isError, true);
  assert.match(wrongEntity.result.content[0].text, /demo data/);
  assert.match(wrongEntity.result.content[0].text, /Donna is not running/);

  // Unknown tool stays unknown — demo mode adds no tool surface.
  const unknownTool = await handleMcpMessage(
    { jsonrpc: '2.0', id: 26, method: 'tools/call', params: { name: 'ledger_commit' } },
    ctx
  );
  assert.equal(unknownTool.result.isError, true);
  assert.match(unknownTool.result.content[0].text, /Unknown tool/);
});

test('splitNdjson: partial chunks and malformed lines', () => {
  const first = splitNdjson('{"a":1}\n{"b":');
  assert.deepEqual(first.messages, [{ a: 1 }]);
  assert.equal(first.rest, '{"b":');
  const second = splitNdjson(`${first.rest}2}\nnot json\n\n{"c":3}\n`);
  assert.deepEqual(second.messages, [{ b: 2 }, { c: 3 }]);
  assert.equal(second.rest, '');
});

test('toMcpTool maps input_schema → inputSchema 1:1', () => {
  const mapped = toMcpTool({ name: 'x', description: 'd', input_schema: { type: 'object', properties: {} } });
  assert.deepEqual(mapped.inputSchema, { type: 'object', properties: {} });
  assert.equal(mapped.annotations.readOnlyHint, true);
});
