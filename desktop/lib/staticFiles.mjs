// Static-file resolution for the donna://app origin — the built Vite SPA
// served from dist/ by the protocol handler in main. Pure logic, no Electron
// imports, so it unit-tests under plain node.
//
// Rules: paths resolve strictly INSIDE the dist root (a traversal attempt
// resolves to null, never an error page leaking path info); anything without
// a file extension falls back to index.html (SPA client routing — /firms is
// a route, not a file); unknown extensions download as octet-stream.

import { existsSync, statSync } from 'node:fs';
import path from 'node:path';

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.map': 'application/json',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json'
};

export const contentTypeFor = (filePath) =>
  CONTENT_TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream';

// Maps a URL pathname onto a file inside distRoot. Returns
// { filePath, contentType } or null when the path escapes the root or the
// resolved file doesn't exist.
export const resolveStaticFile = (distRoot, urlPathname) => {
  const root = path.resolve(distRoot);
  let decoded;
  try {
    decoded = decodeURIComponent(String(urlPathname || '/'));
  } catch {
    return null;
  }
  const hasExtension = Boolean(path.extname(decoded));
  const relative = hasExtension ? decoded.replace(/^\/+/, '') : 'index.html';
  const filePath = path.resolve(root, relative);
  if (filePath !== root && !filePath.startsWith(`${root}${path.sep}`)) return null;
  if (!existsSync(filePath) || !statSync(filePath).isFile()) {
    // A missing asset 404s; a missing extensionless route already fell back
    // to index.html above, so this is a genuinely absent file.
    return null;
  }
  return { filePath, contentType: contentTypeFor(filePath) };
};
