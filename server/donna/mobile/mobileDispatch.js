// In-process dispatch into the EXISTING firm API route handler.
//
// Why dispatch instead of calling DB writers directly: Donna's firm routes are
// not thin. /evidence/requests/:id/resolve decides between the topic-turn lane
// and a terminal reply, runs the structured-reply adapter's authorize step,
// checks entitlement and threads the reply into the transaction chat;
// /documents/register enqueues the parse run and stamps the outbox receipt.
// Re-implementing any of that here would make a second owner of the same
// behaviour. So every mobile read and write is the web route itself, run with
// the same verified identity the web request would carry (req.donnaAuth), and
// the adapter only translates the request in and projects the response out.
//
// The forwarded request never carries the caller's raw headers or body: the
// adapter builds the body from the contract's closed request shape, so nothing
// the phone sends reaches a route except the fields mapped here.
//
// `channel` rides on the in-process request object (req.donnaChannel), beside
// req.donnaAuth: an HTTP client cannot set it, so a web request never claims
// it. Routes copy it into the owner writers' audit metadata, attribution only.
import { Readable } from 'node:stream';

class CapturedResponse {
  constructor(onEnd) {
    this.statusCode = 200;
    this.headers = new Map();
    this.chunks = [];
    this.headersSent = false;
    this.writableEnded = false;
    this.onEnd = onEnd;
  }
  setHeader(name, value) { this.headers.set(String(name).toLowerCase(), value); }
  getHeader(name) { return this.headers.get(String(name).toLowerCase()); }
  hasHeader(name) { return this.headers.has(String(name).toLowerCase()); }
  removeHeader(name) { this.headers.delete(String(name).toLowerCase()); }
  writeHead(status, headers = {}) {
    this.statusCode = status;
    for (const [name, value] of Object.entries(headers || {})) this.setHeader(name, value);
    this.headersSent = true;
    return this;
  }
  write(chunk) {
    if (chunk != null) this.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
    this.headersSent = true;
    return true;
  }
  end(chunk) {
    if (this.writableEnded) return this;
    if (chunk != null && typeof chunk !== 'function') this.write(chunk);
    this.writableEnded = true;
    this.headersSent = true;
    this.onEnd(this);
    return this;
  }
}

// Run one firm route (path relative to /api/donna/firms) as the given verified
// identity. Resolves { status, body } where body is the parsed JSON (or null).
export const createFirmRouteDispatcher = ({ firmHandler, auth, forwardHeaders = {}, channel = null }) => {
  if (typeof firmHandler !== 'function') throw new Error('mobile dispatch: the firm route handler was not injected.');
  return async ({ method = 'GET', path, query = null, body = undefined }) => {
    const url = new URL(path, 'http://internal');
    for (const [key, value] of Object.entries(query || {})) {
      if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
    }
    const encoded = body === undefined ? '' : JSON.stringify(body);
    const req = Readable.from(encoded ? [Buffer.from(encoded)] : []);
    req.method = method;
    req.url = `${url.pathname}${url.search}`;
    req.headers = {
      ...forwardHeaders,
      'content-type': 'application/json',
      'content-length': String(Buffer.byteLength(encoded))
    };
    req.donnaAuth = auth;
    if (channel) req.donnaChannel = channel;
    const done = new Promise((resolve) => {
      const res = new CapturedResponse((captured) => resolve(captured));
      Promise.resolve(firmHandler(req, res)).catch((error) => {
        if (!res.writableEnded) {
          res.statusCode = error?.statusCode || 500;
          res.end(JSON.stringify({ error: error?.message || 'Route failed.', code: error?.code || 'ROUTE_FAILED' }));
        }
      });
    });
    const captured = await done;
    const text = Buffer.concat(captured.chunks).toString('utf8');
    let parsed = null;
    try { parsed = text ? JSON.parse(text) : null; } catch { parsed = null; }
    return { status: captured.statusCode, body: parsed };
  };
};
