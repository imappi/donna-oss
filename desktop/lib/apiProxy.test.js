// apiProxy — the main-process proxy that carries donna://app /api requests
// to the runtime's Unix socket. Load-bearing: the access token is attached
// main-side (the no-token-in-renderer rail), a renderer-supplied token
// header cannot override it, hop-by-hop headers are stripped, bodies round-
// trip, and a dead runtime socket is a 503 — not a hang.

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { filterProxyHeaders, proxyToRuntime } from './apiProxy.mjs';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'donna-proxy-test-'));
const socketPath = path.join(tmp, 'api.sock');

// A stub runtime that echoes what it received.
const seen = [];
const server = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    seen.push({
      method: req.method,
      url: req.url,
      token: req.headers['x-donna-access-token'],
      contentType: req.headers['content-type'],
      body: Buffer.concat(chunks).toString('utf8')
    });
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Connection', 'keep-alive');
    res.end(JSON.stringify({ echoed: true }));
  });
});
await new Promise((resolve) => server.listen(socketPath, resolve));
test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
  rmSync(tmp, { recursive: true, force: true });
});

// fetch-API-shaped request stand-in (what protocol.handle provides).
const fakeRequest = ({ method = 'GET', url, headers = {}, body = null }) => ({
  method,
  url,
  headers: new Map(Object.entries(headers)),
  arrayBuffer: async () => (body ? Buffer.from(body) : Buffer.alloc(0))
});

test('GET is forwarded with the injected token; renderer cannot override it', async () => {
  const response = await proxyToRuntime({
    request: fakeRequest({
      url: 'donna://app/api/donna/firms/health?x=1',
      headers: { 'x-donna-access-token': 'renderer-forged' }
    }),
    socketPath,
    accessToken: 'main-held-token'
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { echoed: true });
  const last = seen.at(-1);
  assert.equal(last.url, '/api/donna/firms/health?x=1');
  assert.equal(last.token, 'main-held-token', 'main-side token wins over any renderer header');
});

test('POST bodies and content type round-trip', async () => {
  const response = await proxyToRuntime({
    request: fakeRequest({
      method: 'POST',
      url: 'donna://app/api/donna/firms/feed',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ hello: 'runtime' })
    }),
    socketPath,
    accessToken: 't'
  });
  assert.equal(response.status, 200);
  const last = seen.at(-1);
  assert.equal(last.method, 'POST');
  assert.equal(last.contentType, 'application/json');
  assert.equal(last.body, JSON.stringify({ hello: 'runtime' }));
});

test('hop-by-hop headers are stripped both ways', async () => {
  assert.deepEqual(
    filterProxyHeaders({ Connection: 'keep-alive', 'content-length': '5', 'X-Keep': 'yes', host: 'app' }),
    { 'X-Keep': 'yes' }
  );
  const response = await proxyToRuntime({
    request: fakeRequest({ url: 'donna://app/api/donna/firms/health' }),
    socketPath,
    accessToken: 't'
  });
  assert.equal(response.headers.get('connection'), null, 'upstream Connection header not forwarded');
});

test('a dead runtime socket is a 503 RUNTIME_UNAVAILABLE, not a hang', async () => {
  const response = await proxyToRuntime({
    request: fakeRequest({ url: 'donna://app/api/donna/firms/health' }),
    socketPath: path.join(tmp, 'not-listening.sock'),
    accessToken: 't'
  });
  assert.equal(response.status, 503);
  const body = await response.json();
  assert.equal(body.code, 'RUNTIME_UNAVAILABLE');
});

test('oversized bodies are refused with 413 before they reach the socket', async () => {
  const big = Buffer.alloc(16 * 1024 * 1024 + 1);
  const response = await proxyToRuntime({
    request: fakeRequest({ method: 'PUT', url: 'donna://app/api/donna/evidence-local?token=x', body: big }),
    socketPath,
    accessToken: 't'
  });
  assert.equal(response.status, 413);
});
