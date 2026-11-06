// The donna://app → runtime proxy (plan §1's no-bearer-token-in-renderer
// rail, made concrete): the renderer fetches relative /api/donna/... paths
// on its own origin; main forwards them to the runtime utility process over
// its private Unix socket and attaches the access token HERE — runtime
// credentials never exist in renderer memory, so an XSS bug cannot inherit
// the router. Pure node:http logic, no Electron imports, unit-testable.

import http from 'node:http';

// Requests are buffered both ways: the largest legitimate body is an
// evidence upload, capped server-side at 15MB — same ceiling here so the
// proxy can't be used to balloon memory.
const MAX_PROXY_BODY_BYTES = 16 * 1024 * 1024;

// Hop-by-hop headers must not be forwarded in either direction.
const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade', 'host', 'content-length'
]);

export const filterProxyHeaders = (headers = {}) => {
  const out = {};
  for (const [name, value] of Object.entries(headers)) {
    if (HOP_BY_HOP.has(name.toLowerCase())) continue;
    if (value !== undefined && value !== null) out[name] = value;
  }
  return out;
};

// Forwards one request to the runtime socket. `request` is fetch-API shaped
// (method, url, headers iterable, arrayBuffer()) — exactly what Electron's
// protocol.handle hands over. Returns a fetch-API Response.
export const proxyToRuntime = async ({ request, socketPath, accessToken }) => {
  const url = new URL(request.url);
  let body = null;
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    const buffer = Buffer.from(await request.arrayBuffer());
    if (buffer.length > MAX_PROXY_BODY_BYTES) {
      return new Response(JSON.stringify({ error: 'Request body too large.', code: 'REQUEST_BODY_TOO_LARGE' }), {
        status: 413,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    body = buffer;
  }

  const headers = filterProxyHeaders(Object.fromEntries(request.headers));
  // The injection this module exists for: the renderer never held the token.
  if (accessToken) headers['X-Donna-Access-Token'] = accessToken;

  return new Promise((resolve) => {
    const upstream = http.request(
      {
        socketPath,
        method: request.method,
        path: `${url.pathname}${url.search}`,
        headers
      },
      (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => {
          resolve(new Response(Buffer.concat(chunks), {
            status: response.statusCode,
            headers: filterProxyHeaders(response.headers)
          }));
        });
      }
    );
    upstream.on('error', (error) => {
      // The runtime being down (crash, restart window) is a first-class
      // state, not a hang: surface it as 503 so the SPA's error paths run.
      resolve(new Response(JSON.stringify({
        error: `Donna runtime is not reachable: ${error.message}`,
        code: 'RUNTIME_UNAVAILABLE'
      }), { status: 503, headers: { 'Content-Type': 'application/json' } }));
    });
    if (body) upstream.write(body);
    upstream.end();
  });
};
