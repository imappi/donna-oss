// OAuth callback origin derivation — the host the provider should redirect
// back to is taken from the SERVING request, not a static *_REDIRECT_URI env
// that can rot to a dead/renamed deployment. (The DEPLOYMENT_NOT_FOUND
// fingerprint: a Vercel alias detaches, the SPA shell still loads from edge
// cache, but `/api/*` — including the OAuth callback — hits a dead deployment,
// so the round-trip 404s while "connect" appears to have worked.) Deriving
// from the request keeps the callback on whatever deployment the operator
// actually loaded.
//
// Two guards stop a forged Host from hijacking the callback (and with it the
// short-lived authorization `code`):
//   1. spoof guard — if `x-forwarded-host` is present it MUST agree with the
//      routed `Host`; a forwarded host that disagrees is refused, never
//      silently trusted.
//   2. allow-list — DONNA_OAUTH_ALLOWED_ORIGINS plus the configured provider
//      redirect origins and the Vercel-injected deployment hosts. When that
//      set is non-empty the derived origin must be a member or connect fails
//      loud (instead of emitting an authorize URL with an unsafe callback). An
//      empty set (nothing configured) stays permissive, preserving the prior
//      single-deployment behaviour.
//
// Pure + dependency-free so it unit-tests under plain `node --test`; api.js is
// the only caller and threads the result into the signed OAuth state.

export class OAuthCallbackOriginError extends Error {
  constructor(message, details) {
    super(message);
    this.name = 'OAuthCallbackOriginError';
    // 400: the request itself can't yield a trustworthy callback host. The
    // api.js top-level handler surfaces statusCode / code / details verbatim.
    this.statusCode = 400;
    this.code = 'OAUTH_CALLBACK_ORIGIN_REJECTED';
    if (details) this.details = details;
  }
}

// Node lower-cases header names but a header can still arrive as an array
// (repeated header) — take the first value.
const firstHeader = (value) => (Array.isArray(value) ? value[0] : value);

const normalizeHost = (value) => String(value || '').trim().toLowerCase();

// `proto://host[:port]`, lowercased, no trailing slash — '' when unparseable.
// A bare host (no scheme) is treated as https so env values like
// `books-app.example` (Vercel injects bare hosts) normalize cleanly.
const toOrigin = (value) => {
  const text = String(value || '').trim();
  if (!text) return '';
  try {
    return new URL(text.includes('://') ? text : `https://${text}`).origin.toLowerCase();
  } catch {
    return '';
  }
};

const isLocalHost = (host) => /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(host);

// Build the allow-list from explicit config + the configured provider redirect
// origins + the Vercel-injected deployment hosts. Deduped, lowercased origins.
// An empty result means "nothing configured" and the caller treats it as
// permissive.
export const collectAllowedOAuthOrigins = (env = process.env) => {
  const origins = new Set();
  const add = (value) => {
    const origin = toOrigin(value);
    if (origin) origins.add(origin);
  };
  for (const part of String(env.DONNA_OAUTH_ALLOWED_ORIGINS || '').split(',')) add(part);
  // The configured callbacks are valid serving origins by definition.
  add(env.XERO_REDIRECT_URI);
  add(env.QBO_REDIRECT_URI);
  add(env.PROCOUNTOR_REDIRECT_URI);
  add(env.HMRC_REDIRECT_URI);
  // Vercel sets these to bare hosts (no scheme) on every deployment.
  for (const key of ['VERCEL_PROJECT_PRODUCTION_URL', 'VERCEL_BRANCH_URL', 'VERCEL_URL']) {
    add(env[key]);
  }
  return origins;
};

// Resolve the origin the OAuth provider must redirect back to for THIS request.
// Throws OAuthCallbackOriginError (400) when the host can't be trusted.
export const resolveOAuthCallbackOrigin = (req, { env = process.env } = {}) => {
  const headers = req?.headers || {};
  const host = normalizeHost(firstHeader(headers.host));
  const forwardedHost = normalizeHost(firstHeader(headers['x-forwarded-host']));

  if (!host && !forwardedHost) {
    throw new OAuthCallbackOriginError('Cannot determine the OAuth callback host: the request has no Host header.');
  }
  // Spoof guard: a forwarded host that disagrees with the routed Host is
  // refused — the proxied header is never allowed to silently win.
  if (forwardedHost && host && forwardedHost !== host) {
    throw new OAuthCallbackOriginError(
      'OAuth callback host mismatch: x-forwarded-host does not agree with the Host header.',
      { host, forwarded_host: forwardedHost }
    );
  }
  const servingHost = host || forwardedHost;
  const forwardedProto = String(firstHeader(headers['x-forwarded-proto']) || '')
    .split(',')[0]
    .trim()
    .toLowerCase();
  // Vercel always sets x-forwarded-proto=https; local dev over plain http has
  // no proxy header, so default localhost to http and everything else to https.
  const proto = forwardedProto || (isLocalHost(servingHost) ? 'http' : 'https');
  const origin = toOrigin(`${proto}://${servingHost}`);
  if (!origin) {
    throw new OAuthCallbackOriginError('OAuth callback host is not a valid origin.', { host: servingHost });
  }

  const allowed = collectAllowedOAuthOrigins(env);
  if (allowed.size > 0 && !allowed.has(origin)) {
    throw new OAuthCallbackOriginError(
      `OAuth callback origin ${origin} is not allow-listed. Add it to DONNA_OAUTH_ALLOWED_ORIGINS.`,
      { origin, allowed: [...allowed] }
    );
  }
  return origin;
};

// The full provider callback URL for a connector ('xero' | 'qbo' | 'procountor' | 'hmrc'). Must match
// the path Vercel rewrites to /api/donna/firms/<system>/callback AND the URL
// registered in the provider's redirect-URI allow-list.
export const buildOAuthCallbackUrl = ({ origin, system } = {}) => {
  const cleanOrigin = toOrigin(origin);
  const cleanSystem = String(system || '').trim().toLowerCase();
  if (!cleanOrigin) {
    throw new OAuthCallbackOriginError('A valid origin is required to build the OAuth callback URL.');
  }
  if (cleanSystem !== 'xero' && cleanSystem !== 'qbo' && cleanSystem !== 'procountor' && cleanSystem !== 'hmrc') {
    throw new OAuthCallbackOriginError(`Unsupported OAuth connector "${system}".`, { system });
  }
  return `${cleanOrigin}/api/donna/firms/${cleanSystem}/callback`;
};
