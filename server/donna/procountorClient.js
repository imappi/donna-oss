import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';

// Procountor OAuth/HTTP client — connection lifecycle ONLY (capability trial).
// Pure helpers (no DB); the firmDb writers persist what these return.
//
// Endpoint facts, per Procountor's official docs
// (https://dev.procountor.com/api-authentication/):
//   * interactive authorization (authorization code flow) sends the user to
//     `<base>/login?response_type=code&client_id=…&redirect_uri=…&state=…`
//     — note `/login`, NOT an `/oauth/authorize` path, and NO scope parameter.
//   * the token endpoint is `<base>/api/oauth/token`
//     (application/x-www-form-urlencoded).
//   * production base is https://api.procountor.com; the test environment is a
//     full separate platform at https://pts-procountor.pubdev.azure.procountor.com
//     (dev.procountor.com/general-information/), so the OAuth endpoints are
//     keyed by PROCOUNTOR_ENVIRONMENT — they are NOT shared across environments.
//   * Procountor also offers an M2M flow (client_credentials + per-company
//     api_key; dev.procountor.com/m2m-authentication/) — NOT used here; the
//     interactive flow above is what the connect button drives.
//
// UNVALIDATED AGAINST THE LIVE API: no live Procountor credentials existed when
// this was written. The runbook (docs/procountor-live-writeback-runbook.md) is
// where these shapes get validated; expect field-level corrections there
// before anything beyond connect is wired.
// Procountor has TWO hosts per environment, and they are NOT interchangeable:
//   * the API host, which serves the OAuth endpoints (`/login`, `/api/oauth/
//     token`) and every REST call — production `api.procountor.com`, PTS
//     `pts-api.procountor.com` (per the docs' "API servers" Environments table;
//     the same api↔pts-api mapping as production, confirmed 2026-07-08);
//   * the UI host, where a human logs into the Procountor web app — production
//     `secure.procountor.com`, PTS `pts-secure.procountor.com`.
// The API host is the one we need. Pointing the base at the UI host silently
// breaks OAuth: `pts-secure.procountor.com/login` is the WEB-APP login, which
// ignores the OAuth query and drops the user on the Procountor dashboard
// (#!NAV_FRONT_PAGE) instead of returning a code (observed 2026-07-08). Two
// earlier defaults were wrong: `pts-procountor.pubdev.azure.procountor.com` (the
// old PTS, now dead — does not resolve) and `pts-secure.procountor.com` (the UI
// host). The value below is the documented PTS API host. PROCOUNTOR_API_BASE_URL
// still overrides it with no code deploy if Procountor ever moves the API host.
const PROCOUNTOR_API_BASE_TEST = 'https://pts-api.procountor.com';
const PROCOUNTOR_API_BASE_PRODUCTION = 'https://api.procountor.com';

// Procountor's documented authorize URL carries NO scope parameter; the scope
// list stays empty unless PROCOUNTOR_SCOPES (space-separated) explicitly sets
// one — never invent scopes the provider doesn't document.
const DEFAULT_PROCOUNTOR_SCOPES = [];

let dotEnvCache = null;

const readDotEnv = () => {
  if (dotEnvCache) return dotEnvCache;
  const vars = {};
  try {
    const envPath = resolvePath(process.cwd(), '.env');
    if (existsSync(envPath)) {
      for (const line of readFileSync(envPath, 'utf8').split('\n')) {
        const match = line.match(/^(\w+)=(.*)$/);
        if (match) vars[match[1]] = match[2].trim().replace(/^['"]|['"]$/g, '');
      }
    }
  } catch {
    // Best-effort dotenv fallback for local development.
  }
  dotEnvCache = vars;
  return vars;
};

const envValue = (key) => process.env[key] || readDotEnv()[key] || '';

const base64UrlEncode = (input) => Buffer.from(input).toString('base64url');
const base64UrlDecode = (input) => Buffer.from(String(input || ''), 'base64url').toString('utf8');

const getStateSecret = () =>
  envValue('PROCOUNTOR_STATE_SECRET') ||
  envValue('XERO_STATE_SECRET') ||
  envValue('DONNA_ACCESS_TOKEN') ||
  envValue('DATABASE_URL') ||
  envValue('POSTGRES_URL') ||
  'donna-local-procountor-state';

const hmac = (value) => createHmac('sha256', getStateSecret()).update(value).digest('base64url');

const safeCompare = (left = '', right = '') => {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
};

const parseScopeList = (scopeText = '') =>
  String(scopeText || '')
    .split(/\s+/)
    .map((scope) => scope.trim())
    .filter(Boolean);

export const getProcountorConfig = () => {
  const scopes = parseScopeList(envValue('PROCOUNTOR_SCOPES')).length
    ? parseScopeList(envValue('PROCOUNTOR_SCOPES'))
    : DEFAULT_PROCOUNTOR_SCOPES;
  // Trim the credentials: a client_secret pasted into an env var with a trailing
  // newline/space is silently rejected by Procountor's token endpoint as
  // "Client authentication failed" (invalid_client) — indistinguishable from a
  // genuinely wrong secret. process.env values are NOT trimmed (unlike the
  // dotenv fallback), so a paste-whitespace slip would otherwise be invisible.
  return {
    clientId: envValue('PROCOUNTOR_CLIENT_ID').trim(),
    clientSecret: envValue('PROCOUNTOR_CLIENT_SECRET').trim(),
    redirectUri: envValue('PROCOUNTOR_REDIRECT_URI').trim(),
    environment: (envValue('PROCOUNTOR_ENVIRONMENT') || 'test').trim().toLowerCase(),
    scopes
  };
};

export const isProcountorConfigured = () => {
  const config = getProcountorConfig();
  return Boolean(config.clientId && config.clientSecret && config.redirectUri);
};

// The environment keys EVERYTHING — API host and OAuth endpoints alike (the
// test environment is a full separate platform). Unset defaults to test:
// an unconfigured deploy must never touch production books.
export const getProcountorApiBaseUrl = (environment = getProcountorConfig().environment) => {
  // An explicit base-URL pin wins over the environment-keyed default — the PTS
  // host is infrastructure Procountor moves under us, and a host move must not
  // need a code change. Trailing slashes trimmed so `${base}/login` is clean.
  const override = envValue('PROCOUNTOR_API_BASE_URL');
  if (override) return override.replace(/\/+$/, '');
  return String(environment || '').toLowerCase() === 'production' ? PROCOUNTOR_API_BASE_PRODUCTION : PROCOUNTOR_API_BASE_TEST;
};

// dev.procountor.com/api-authentication/: authorize = <base>/login,
// token = <base>/api/oauth/token.
const procountorAuthorizeUrl = (environment) => `${getProcountorApiBaseUrl(environment)}/login`;
const procountorTokenUrl = (environment) => `${getProcountorApiBaseUrl(environment)}/api/oauth/token`;

export const createProcountorState = ({
  firmId,
  clientId,
  returnTo = '/firms?tab=accounting',
  redirectUri,
  issuedAt = Date.now(),
  // 30 min, deliberately longer than the Xero/QBO 10 min: Procountor's
  // interactive login is slower — two-factor via the Procountor Avain app plus a
  // company-selection dialog, and the PTS is sluggish — so a 10-min state TTL
  // expired mid-login ("Expired Procountor connection state", observed live). The
  // state is single-connect, HMAC-signed, and nonce-bearing, so a longer window
  // costs little. (Procountor's own auth `code` still expires 5 min after login;
  // that freshness is independent of this round-trip TTL.)
  ttlMs = 30 * 60 * 1000
} = {}) => {
  if (!firmId || !clientId) {
    const error = new Error('Firm id and client id are required to start Procountor connection.');
    error.statusCode = 400;
    throw error;
  }
  // The host-derived callback URL is embedded in the SIGNED state so the
  // callback handler reuses the exact redirect_uri the authorize step sent
  // (OAuth requires the two to match), tamper-proof against a swapped query.
  const payload = {
    firm_id: firmId,
    client_id: clientId,
    return_to: returnTo,
    ...(redirectUri ? { redirect_uri: redirectUri } : {}),
    nonce: randomBytes(12).toString('base64url'),
    exp: issuedAt + ttlMs
  };
  const encoded = base64UrlEncode(JSON.stringify(payload));
  return `${encoded}.${hmac(encoded)}`;
};

export const verifyProcountorState = (state, { now = Date.now() } = {}) => {
  const [encoded, signature] = String(state || '').split('.');
  if (!encoded || !signature || !safeCompare(hmac(encoded), signature)) {
    const error = new Error('Invalid Procountor connection state.');
    error.statusCode = 400;
    throw error;
  }
  const payload = JSON.parse(base64UrlDecode(encoded));
  if (!payload?.firm_id || !payload?.client_id || !payload?.exp || Number(payload.exp) < now) {
    const error = new Error('Expired Procountor connection state.');
    error.statusCode = 400;
    throw error;
  }
  return payload;
};

// Procountor associates EXACTLY ONE redirect URI with an API client (the email
// grant: "ilmoitathan haluamasi redirect URIn" — singular), unlike Xero/QBO
// whose dev portals register a LIST. So host-derivation — which sends each
// deployment's own callback and is correct for a multi-URI provider — is WRONG
// here: Procountor only ever redirects the login `code` to the single
// registered URI, so a connect started from any other host (e.g. a Vercel
// preview) never gets redirected back. Always send the configured, registered
// PROCOUNTOR_REDIRECT_URI; fall back to the host-derived value only when the env
// is unset (local/dev).
export const resolveProcountorRedirectUri = (hostDerivedRedirectUri) =>
  getProcountorConfig().redirectUri || hostDerivedRedirectUri || '';

export const buildProcountorAuthorizeUrl = ({ state, redirectUri } = {}) => {
  const config = getProcountorConfig();
  // Prefer the host-derived callback URL; fall back to the static env so a
  // caller that doesn't thread one through keeps the prior behaviour.
  const callbackUri = redirectUri || config.redirectUri;
  if (!config.clientId || !callbackUri) {
    const error = new Error('Procountor OAuth is not configured. Set PROCOUNTOR_CLIENT_ID and PROCOUNTOR_REDIRECT_URI.');
    error.statusCode = 500;
    throw error;
  }
  const url = new URL(procountorAuthorizeUrl(config.environment));
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', config.clientId);
  url.searchParams.set('redirect_uri', callbackUri);
  // The documented authorize URL has no scope param; only send one when an
  // operator explicitly configured PROCOUNTOR_SCOPES.
  if (config.scopes.length) url.searchParams.set('scope', config.scopes.join(' '));
  url.searchParams.set('state', state);
  return url.toString();
};

const fetchJson = async (url, options = {}) => {
  const response = await fetch(url, options);
  const text = await response.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = { raw: text };
  }
  if (!response.ok) {
    // Surface the OAuth error CODE alongside the description so a rejection is
    // diagnosable end-to-end (the callback renders error.message): e.g.
    // "Client authentication failed (invalid_client)" vs an invalid_grant.
    // Carry the HTTP status too so a bare description keeps its 4xx-vs-5xx class.
    const description = payload?.error_description || payload?.Detail || payload?.error || 'Procountor API request failed.';
    const code = payload?.error && payload?.error_description ? ` (${payload.error})` : '';
    const error = new Error(`${description}${code} [HTTP ${response.status}]`);
    error.statusCode = response.status;
    error.payload = payload;
    throw error;
  }
  return payload;
};

// Procountor's token endpoint (dev.procountor.com/api-authentication/) documents
// client_id + client_secret as application/x-www-form-urlencoded FORM FIELDS on
// every grant (authorization_code, refresh_token, client_credentials) — it does
// NOT document HTTP Basic. An earlier draft sent Basic (the Xero/QBO idiom); it
// was never validated against live creds, and Procountor's published contract is
// form-body, so a Basic-only exchange risks `invalid_client`. We follow the docs:
// stamp the credentials into the body, send no Authorization header. (If a live
// runbook run ever shows Procountor prefers Basic, flip this back — but the docs
// are the contract until then.)
const applyProcountorClientCredentials = (body) => {
  const config = getProcountorConfig();
  if (!config.clientId || !config.clientSecret) {
    const error = new Error('Procountor OAuth is not configured. Set PROCOUNTOR_CLIENT_ID and PROCOUNTOR_CLIENT_SECRET.');
    error.statusCode = 500;
    throw error;
  }
  body.set('client_id', config.clientId);
  body.set('client_secret', config.clientSecret);
  return body;
};

const tokenExpiresAt = (expiresInSeconds) => new Date(Date.now() + Number(expiresInSeconds || 0) * 1000).toISOString();

// Tolerant of optional fields — the exact token-response shape is validated in
// the live runbook (docs say: access token ~3600s; a refresh_token is issued
// alongside it). x_refresh_token_expires_in is read defensively in case the
// provider sends one; nothing downstream depends on it.
const normalizeTokenPayload = (payload = {}) => ({
  accessToken: payload.access_token || '',
  refreshToken: payload.refresh_token || '',
  idToken: payload.id_token || '',
  tokenType: payload.token_type || 'bearer',
  scopes: parseScopeList(payload.scope).length ? parseScopeList(payload.scope) : getProcountorConfig().scopes,
  expiresAt: tokenExpiresAt(payload.expires_in || 3600),
  refreshTokenExpiresAt: payload.x_refresh_token_expires_in
    ? tokenExpiresAt(payload.x_refresh_token_expires_in)
    : null,
  payload
});

export const exchangeProcountorCode = async ({ code, redirectUri } = {}) => {
  const config = getProcountorConfig();
  if (!code) {
    const error = new Error('Procountor callback code is required.');
    error.statusCode = 400;
    throw error;
  }
  const body = new URLSearchParams();
  body.set('grant_type', 'authorization_code');
  body.set('code', code);
  // Must echo the authorize-step redirect_uri (carried in the signed state);
  // fall back to the static env for back-compat.
  body.set('redirect_uri', redirectUri || config.redirectUri);
  applyProcountorClientCredentials(body);
  const payload = await fetchJson(procountorTokenUrl(config.environment), {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body
  });
  return normalizeTokenPayload(payload);
};

export const refreshProcountorToken = async ({ refreshToken }) => {
  if (!refreshToken) {
    const error = new Error('Procountor refresh token is required.');
    error.statusCode = 400;
    throw error;
  }
  const body = new URLSearchParams();
  body.set('grant_type', 'refresh_token');
  body.set('refresh_token', refreshToken);
  applyProcountorClientCredentials(body);
  const payload = await fetchJson(procountorTokenUrl(getProcountorConfig().environment), {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body
  });
  // If the provider rotates the refresh_token, the caller persists the returned
  // one (getFreshProcountorConnectionForSync already coalesces) — whether
  // Procountor rotates is a runbook question, so handle both.
  return normalizeTokenPayload(payload);
};

// M2M (Client Credentials) — mint a 1-hour access token from a long-lived API
// key (dev.procountor.com/m2m-authentication/). This is the grant Procountor
// provisions our client for; the interactive authorization_code grant returns
// unauthorized_client. Procountor requires the (registered) redirect_uri as a
// param even though M2M has no browser redirect. There is no refresh_token in
// this flow — re-call this with the same api_key when the token expires. The
// api_key and the returned access token are both JWTs carrying the company `cid`.
export const exchangeProcountorApiKey = async ({ apiKey, redirectUri } = {}) => {
  const config = getProcountorConfig();
  const cleanApiKey = String(apiKey || '').trim();
  if (!cleanApiKey) {
    const error = new Error('Procountor API key is required.');
    error.statusCode = 400;
    throw error;
  }
  const body = new URLSearchParams();
  body.set('grant_type', 'client_credentials');
  body.set('redirect_uri', redirectUri || config.redirectUri);
  body.set('api_key', cleanApiKey);
  applyProcountorClientCredentials(body);
  const payload = await fetchJson(procountorTokenUrl(config.environment), {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body
  });
  return normalizeTokenPayload(payload);
};

export const shouldRefreshProcountorToken = (expiresAt, { now = Date.now(), skewMs = 5 * 60 * 1000 } = {}) => {
  if (!expiresAt) return true;
  const expires = new Date(expiresAt).getTime();
  return !Number.isFinite(expires) || expires - skewMs <= now;
};

// The company identifier is read off the OAuth callback query (the exact param
// name is a runbook question — the callback route tries companyId/company_id/
// company). The organization name isn't available at callback time; it starts
// empty and can be filled by a later company-info fetch.
export const normalizeProcountorConnection = (connection = {}) => ({
  companyId: connection.companyId || connection.company_id || connection.company || '',
  organizationName: connection.organizationName || connection.organization_name || connection.companyName || connection.company_name || '',
  payload: connection
});

// Procountor's authorization-code callback returns ONLY code/state/expires_in —
// it does NOT carry a company id (dev.procountor.com/api-authentication/). The
// company the user selected during login is carried inside the access token: a
// JWT whose `cid` claim IS the company id (and `sub` the user id). Decode the
// claims WITHOUT verifying the signature — the token came straight from the
// authenticated token exchange over TLS, so it is trusted for reading our own
// company id; we never treat these claims as an authorization decision. Returns
// {} for an opaque (non-JWT) token so the caller falls back cleanly.
export const decodeProcountorTokenClaims = (accessToken = '') => {
  const parts = String(accessToken || '').split('.');
  if (parts.length < 2 || !parts[1]) return {};
  try {
    const claims = JSON.parse(base64UrlDecode(parts[1]));
    return claims && typeof claims === 'object' ? claims : {};
  } catch {
    return {};
  }
};

// Resolve the connected company id: prefer an explicit callback param (future-
// proofing / the M2M api_key flow, which binds a company up front) but fall back
// to the token's `cid` claim, which is the documented source for the auth-code
// flow. Returns { companyId, claims } — companyId is '' when neither yields one,
// which the caller surfaces as a hard error rather than writing a company-less
// connection row.
export const resolveProcountorCompanyId = ({ companyId, accessToken } = {}) => {
  const claims = decodeProcountorTokenClaims(accessToken);
  const explicit = String(companyId || '').trim();
  const fromToken = String(claims.cid ?? claims.companyId ?? claims.company_id ?? '').trim();
  return { companyId: explicit || fromToken, claims };
};

// ── Reference-data reads (verb 2.1b) ───────────────────────────────────────
// REST resources live at `<apiBase>/api/<resource>` and take the M2M access
// token as a Bearer. The field shapes the normalizers below assume were
// VALIDATED against the live PTS API on 2026-07-08 (company cid 16266) — see
// db/migrations/061 for the matching schema. fetchJson (above) already surfaces
// coded Procountor errors and carries the HTTP status.
const procountorResourceUrl = (environment, path) =>
  `${getProcountorApiBaseUrl(environment)}/api/${String(path || '').replace(/^\/+/, '')}`;

export const fetchProcountorResource = async ({ accessToken, environment, path, query } = {}) => {
  if (!accessToken) {
    const error = new Error('Procountor access token is required to read reference data.');
    error.statusCode = 401;
    throw error;
  }
  const url = new URL(procountorResourceUrl(environment, path));
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
    }
  }
  return fetchJson(url.toString(), {
    method: 'GET',
    headers: { Accept: 'application/json', Authorization: `Bearer ${accessToken}` }
  });
};

// Procountor paginates list endpoints (businesspartners, bankaccounts) as
// {results:[…], meta:{pageNumber,pageSize,resultCount}}. Walk pages until the
// collected count reaches resultCount, an empty/short page signals the end, or
// the maxPages backstop trips (guards a meta that never converges). coa and
// dimensions are NOT paginated (coa → {ledgerAccounts}, dimensions → bare
// array), so their callers read a single response directly.
export const fetchProcountorPagedResults = async ({
  accessToken,
  environment,
  path,
  pageSize = 100,
  maxPages = 500
} = {}) => {
  const all = [];
  for (let pageNumber = 0; pageNumber < maxPages; pageNumber += 1) {
    const payload = await fetchProcountorResource({
      accessToken,
      environment,
      path,
      query: { pageNumber, pageSize }
    });
    const results = Array.isArray(payload?.results) ? payload.results : [];
    all.push(...results);
    if (results.length === 0) break;
    const total = Number(payload?.meta?.resultCount);
    if (Number.isFinite(total) && all.length >= total) break;
    const effectivePageSize = Number(payload?.meta?.pageSize) || pageSize;
    if (results.length < effectivePageSize) break;
  }
  return all;
};

const procountorTranslation = (translations, languageCode) =>
  (Array.isArray(translations) ? translations : []).find((entry) => entry?.languageCode === languageCode)?.translation || '';

// GET /api/coa → {ledgerAccounts:[{ledgerAccountCode,name,active,translations}]}.
// The code IS the identifier; en/sv names come off the translations array.
export const normalizeProcountorLedgerAccount = (account = {}) => ({
  ledgerAccountCode: String(account.ledgerAccountCode ?? '').trim(),
  name: account.name || '',
  nameEn: procountorTranslation(account.translations, 'en'),
  nameSv: procountorTranslation(account.translations, 'sv'),
  active: account.active !== false,
  payload: account
});

// GET /api/dimensions → bare array (empty on a pilot client). Item shape UNVALIDATED —
// key on id, fall back to name; carry the raw item so nothing is lost.
export const normalizeProcountorDimension = (dimension = {}) => ({
  dimensionId: String(dimension.id ?? dimension.dimensionId ?? dimension.name ?? '').trim(),
  name: dimension.name || '',
  active: dimension.active !== false,
  payload: dimension
});

// GET /api/businesspartners → {results:[{id,name,type,registryInfo:{active},
// version,…}]}. type ∈ CUSTOMER|SUPPLIER|PERSON. Email is not top-level on the
// observed sample; pull it best-effort from the nested shapes the docs describe.
export const normalizeProcountorBusinessPartner = (partner = {}) => ({
  partnerId: String(partner.id ?? '').trim(),
  name: partner.name || '',
  partnerType: partner.type || '',
  email: partner.invoicingInfo?.email || partner.email || partner.contactPersons?.[0]?.email || '',
  active: partner.registryInfo?.active !== false,
  version: partner.version || '',
  payload: partner
});

// GET /api/bankaccounts → {results:[{id,accountNumber,iban,bic,bankName,
// currency,defaultForInvoice,defaultForPayment,status,orderNo,version}]}.
export const normalizeProcountorBankAccount = (bankAccount = {}) => ({
  bankAccountId: String(bankAccount.id ?? '').trim(),
  accountNumber: bankAccount.accountNumber || '',
  iban: bankAccount.iban || '',
  bic: bankAccount.bic || '',
  bankName: bankAccount.bankName || '',
  currency: bankAccount.currency || '',
  defaultForInvoice: Boolean(bankAccount.defaultForInvoice),
  defaultForPayment: Boolean(bankAccount.defaultForPayment),
  status: bankAccount.status || '',
  orderNo: Number.isFinite(Number(bankAccount.orderNo)) ? Number(bankAccount.orderNo) : null,
  version: bankAccount.version || '',
  payload: bankAccount
});

// ── Ledger-receipt writeback (verb 2.1c) ───────────────────────────────────
// POST /api/ledgerreceipts creates a JOURNAL ledger receipt; PUT
// /api/ledgerreceipts/{id} updates one (the body must echo `version`, an
// optimistic-concurrency token). Both take the M2M access token as a Bearer and
// application/json. Shapes validated against the live PTS API 2026-07-09 — a
// created JOURNAL lands status UNFINISHED (a draft the firm verifies in
// Procountor; there is no API endpoint to verify a journal, so writeback stops
// at the draft — see docs/procountor-live-writeback-runbook.md §"Step 0e").
const procountorLedgerReceiptUrl = (environment, receiptId) => {
  const base = `${getProcountorApiBaseUrl(environment)}/api/ledgerreceipts`;
  return receiptId ? `${base}/${encodeURIComponent(String(receiptId))}` : base;
};

export const postProcountorLedgerReceipt = async ({ accessToken, environment, ledgerReceipt } = {}) => {
  if (!accessToken) {
    const error = new Error('Procountor access token is required to write a ledger receipt.');
    error.statusCode = 401;
    throw error;
  }
  if (!ledgerReceipt || typeof ledgerReceipt !== 'object') {
    const error = new Error('Procountor ledger receipt payload is required.');
    error.statusCode = 400;
    throw error;
  }
  return fetchJson(procountorLedgerReceiptUrl(environment), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(ledgerReceipt)
  });
};

export const updateProcountorLedgerReceipt = async ({ accessToken, environment, receiptId, ledgerReceipt } = {}) => {
  const cleanId = String(receiptId || '').trim();
  if (!cleanId) {
    const error = new Error('Procountor ledger receipt id is required for an update.');
    error.statusCode = 400;
    throw error;
  }
  return fetchJson(procountorLedgerReceiptUrl(environment, cleanId), {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(ledgerReceipt || {})
  });
};

export const fetchProcountorLedgerReceipt = async ({ accessToken, environment, receiptId } = {}) => {
  const cleanId = String(receiptId || '').trim();
  if (!cleanId) {
    const error = new Error('Procountor ledger receipt id is required.');
    error.statusCode = 400;
    throw error;
  }
  return fetchProcountorResource({ accessToken, environment, path: `ledgerreceipts/${cleanId}` });
};

// Pull the mirror-relevant fields out of a ledger-receipt response (or a stored
// request payload). `total` is the sum of the POSITIVE accountingValues (the
// debit side) — a balanced receipt's one-sided total, used for drift checks in
// verifyMirror (parity with normalizeQboJournalEntry's debit-side total).
export const normalizeProcountorLedgerReceipt = (response = {}) => {
  const receipt = response?.ledgerReceipt || response?.ledger_receipt || response || {};
  const transactions = Array.isArray(receipt.transactions) ? receipt.transactions : [];
  const total = transactions.reduce((sum, tx) => {
    const value = Number(tx?.accountingValue || 0);
    return value > 0 ? sum + value : sum;
  }, 0);
  return {
    id: String(receipt.id ?? receipt.receiptId ?? ''),
    version: receipt.version || '',
    status: receipt.status || '',
    receiptNumber: receipt.receiptNumber ?? null,
    name: receipt.name || '',
    receiptDate: receipt.receiptDate || '',
    lineCount: transactions.length,
    total: Math.round(total * 100) / 100,
    payload: receipt
  };
};
