// System-browser preview for the desktop client's portal.
//
// The Electron renderer cannot hand a donna:// URL to Safari/Chrome, and the
// local runtime intentionally listens on a private Unix socket. This small
// loopback server preserves both boundaries: it serves the same built SPA,
// proxies /api through the existing token-injecting socket proxy, and admits a
// browser only after a one-time unguessable activation URL sets a SameSite
// session cookie. The access token never reaches the browser or renderer.

import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile } from 'node:fs/promises';

import { proxyToRuntime } from './apiProxy.mjs';
import { resolveStaticFile } from './staticFiles.mjs';

const SESSION_COOKIE = 'donna_portal_preview_session';
const ACTIVATION_PREFIX = '/__donna_portal_preview__/';
const PREVIEW_META = '<meta name="donna-portal-preview" content="desktop">';

const cookiesFor = (header = '') => new Map(
  String(header)
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const split = part.indexOf('=');
      return split < 0 ? [part, ''] : [part.slice(0, split), part.slice(split + 1)];
    })
);

const readBody = async (request) => {
  if (request.method === 'GET' || request.method === 'HEAD') return undefined;
  const chunks = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
};

const writeFetchResponse = async (response, outgoing) => {
  outgoing.statusCode = response.status;
  response.headers.forEach((value, name) => outgoing.setHeader(name, value));
  if (outgoing.req?.method === 'HEAD') {
    outgoing.end();
    return;
  }
  outgoing.end(Buffer.from(await response.arrayBuffer()));
};

const servesStateChangingRequest = (method = 'GET') => !['GET', 'HEAD', 'OPTIONS'].includes(method);

export const portalPreviewActivationPath = ({ token, clientId } = {}) => {
  const safeToken = String(token || '').trim();
  const safeClientId = String(clientId || '').trim();
  if (!safeToken || !safeClientId) return null;
  return `${ACTIVATION_PREFIX}${encodeURIComponent(safeToken)}/client/${encodeURIComponent(safeClientId)}`;
};

export const createPortalPreviewServer = async ({
  distRoot,
  socketPath,
  accessToken,
  contentSecurityPolicy,
  sessionToken = randomBytes(32).toString('base64url')
} = {}) => {
  if (!distRoot || !socketPath || !accessToken || !sessionToken) {
    throw new Error('Portal preview needs distRoot, socketPath, accessToken, and a session token.');
  }

  let origin = '';
  const encodedToken = encodeURIComponent(sessionToken);
  const activationRoot = `${ACTIVATION_PREFIX}${encodedToken}/client/`;

  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url || '/', origin || 'http://127.0.0.1');

      if (request.method === 'GET' && url.pathname.startsWith(activationRoot)) {
        const encodedClientId = url.pathname.slice(activationRoot.length);
        if (!encodedClientId || encodedClientId.includes('/')) {
          response.writeHead(404).end('Not found');
          return;
        }
        response.writeHead(302, {
          Location: `/client/${encodedClientId}`,
          'Cache-Control': 'no-store',
          'Referrer-Policy': 'no-referrer',
          'Set-Cookie': `${SESSION_COOKIE}=${encodeURIComponent(sessionToken)}; HttpOnly; SameSite=Strict; Path=/`
        });
        response.end();
        return;
      }

      const cookies = cookiesFor(request.headers.cookie);
      if (cookies.get(SESSION_COOKIE) !== encodeURIComponent(sessionToken)) {
        response.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
        response.end('Open this preview from Donna.');
        return;
      }

      if (url.pathname.startsWith('/api/')) {
        // Cookies are host-scoped rather than port-scoped. Refuse a write from
        // any other loopback origin even if the browser happened to attach the
        // preview cookie to it.
        if (servesStateChangingRequest(request.method) && request.headers.origin !== origin) {
          response.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
          response.end('Cross-origin portal request refused.');
          return;
        }
        const body = await readBody(request);
        const proxied = await proxyToRuntime({
          request: new Request(url, {
            method: request.method,
            headers: request.headers,
            ...(body === undefined ? {} : { body })
          }),
          socketPath,
          accessToken
        });
        await writeFetchResponse(proxied, response);
        return;
      }

      const resolved = resolveStaticFile(distRoot, url.pathname);
      if (!resolved) {
        response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        response.end('Not found');
        return;
      }
      response.statusCode = 200;
      response.setHeader('Content-Type', resolved.contentType);
      response.setHeader('Cache-Control', 'no-store');
      if (resolved.contentType.startsWith('text/html') && contentSecurityPolicy) {
        response.setHeader('Content-Security-Policy', contentSecurityPolicy);
      }
      if (resolved.contentType.startsWith('text/html')) {
        const html = await readFile(resolved.filePath, 'utf8');
        response.end(html.includes('</head>')
          ? html.replace('</head>', `${PREVIEW_META}</head>`)
          : `${PREVIEW_META}${html}`);
        return;
      }
      createReadStream(resolved.filePath).pipe(response);
    } catch (error) {
      response.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
      response.end(`Portal preview failed: ${error.message}`);
    }
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  origin = `http://127.0.0.1:${address.port}`;

  return {
    origin,
    urlForClient: (clientId) => {
      const path = portalPreviewActivationPath({ token: sessionToken, clientId });
      return path ? `${origin}${path}` : null;
    },
    stop: () => new Promise((resolve) => server.close(resolve))
  };
};
