#!/usr/bin/env node
// Serve the built web app (dist/) on a loopback port and pass every /api/
// request through, unchanged, to the local runtime started by
// scripts/desktop-boot.mjs (README.md, "Run Donna locally").
//
// The browser and the API then share one origin, which the web app needs
// (it calls /api/donna/... relative to the page). This server adds nothing
// to a request: no token, no header, no cookie. The browser signs in with
// the runtime's access token on the app's own sign-in screen, and the
// runtime checks it as it checks every request.
//
//   node scripts/local_web.mjs
//
// Env (all optional):
//   DONNA_LOCAL_WEB_PORT  web port (default 5173)
//   DONNA_DESKTOP_PORT    runtime port to forward /api/ to (default 8787)
//   DONNA_LOCAL_WEB_HOST  web listen address (default 127.0.0.1, loopback
//                         only). docker-compose.yml sets 0.0.0.0 inside the
//                         web container and publishes the port on the host's
//                         loopback only. /api/ is always forwarded to
//                         127.0.0.1, where the runtime listens.

import { createReadStream, existsSync, statSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const CONTENT_TYPES = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.wasm': 'application/wasm',
  '.map': 'application/json; charset=utf-8'
});

// The file under distDir that a URL path names, or null when it names none
// (then the app's index.html answers, so client-side routes like /firms
// load). A path that escapes distDir is never served.
export const resolveStaticFile = (distDir, urlPath) => {
  let decoded;
  try {
    decoded = decodeURIComponent(String(urlPath || '/').split('?')[0]);
  } catch {
    return null;
  }
  if (decoded.includes('\0')) return null;
  const root = path.resolve(distDir);
  const candidate = path.resolve(root, `.${path.posix.normalize(`/${decoded}`)}`);
  if (candidate !== root && !candidate.startsWith(`${root}${path.sep}`)) return null;
  try {
    return statSync(candidate).isFile() ? candidate : null;
  } catch {
    return null;
  }
};

export const isApiPath = (urlPath) => /^\/api(\/|$)/.test(String(urlPath || ''));

export const createLocalWebServer = ({ distDir, runtimePort, runtimeHost = '127.0.0.1' }) => {
  const indexFile = path.join(distDir, 'index.html');

  const forward = (req, res) => {
    const upstream = http.request(
      {
        host: runtimeHost,
        port: runtimePort,
        method: req.method,
        path: req.url,
        headers: { ...req.headers, host: `${runtimeHost}:${runtimePort}` }
      },
      (upstreamRes) => {
        res.writeHead(upstreamRes.statusCode || 502, upstreamRes.headers);
        upstreamRes.pipe(res);
      }
    );
    upstream.on('error', () => {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        code: 'LOCAL_RUNTIME_UNREACHABLE',
        error: `The Donna runtime is not answering on ${runtimeHost}:${runtimePort}. Start it with \`npm run local:runtime\`.`
      }));
    });
    req.pipe(upstream);
  };

  const serveFile = (res, file, status = 200) => {
    const type = CONTENT_TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream';
    res.writeHead(status, {
      'Content-Type': type,
      'Cache-Control': file === indexFile ? 'no-cache' : 'public, max-age=3600'
    });
    createReadStream(file).pipe(res);
  };

  return http.createServer((req, res) => {
    const urlPath = String(req.url || '/').split('?')[0];
    if (isApiPath(urlPath)) {
      forward(req, res);
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Method not allowed.');
      return;
    }
    const file = resolveStaticFile(distDir, urlPath);
    if (file) {
      serveFile(res, file);
      return;
    }
    // A missing asset is a 404, not the app shell.
    if (/\.[a-z0-9]+$/i.test(urlPath)) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not found.');
      return;
    }
    serveFile(res, indexFile);
  });
};

const isDirectRun = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;

if (isDirectRun) {
  const distDir = path.join(ROOT, 'dist');
  if (!existsSync(path.join(distDir, 'index.html'))) {
    console.error('[local-web] dist/index.html is missing. Run `npm run build` first.');
    process.exit(1);
  }
  const webPort = Number(process.env.DONNA_LOCAL_WEB_PORT || 5173);
  const runtimePort = Number(process.env.DONNA_DESKTOP_PORT || 8787);
  const listenHost = process.env.DONNA_LOCAL_WEB_HOST || '127.0.0.1';
  const server = createLocalWebServer({ distDir, runtimePort });
  server.on('error', (error) => {
    console.error(`[local-web] could not listen on ${listenHost}:${webPort}: ${error.message}`);
    process.exit(1);
  });
  server.listen(webPort, listenHost, () => {
    const bound = listenHost === '127.0.0.1' ? '' : `; listening on ${listenHost}:${webPort}`;
    console.log(`[local-web] Donna web app on http://127.0.0.1:${webPort}/firms (API forwarded to 127.0.0.1:${runtimePort}${bound})`);
  });
  const stop = () => server.close(() => process.exit(0));
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
