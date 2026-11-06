import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';

// QuickBooks Online OAuth/HTTP client — mirrors xeroClient.js. Pure helpers
// (no DB); the firmDb writers persist what these return. Two QBO-specific
// shapes differ from the Xero template:
//   * the realm_id arrives as a callback query param, not from a /connections
//     fetch — so there is no fetchConnections() step (the realm IS the
//     connection). normalizeQboConnection takes the realm_id straight off the
//     callback.
//   * refresh tokens rotate on every refresh and carry their own expiry
//     (x_refresh_token_expires_in) — surfaced as refreshTokenExpiresAt.
//
// The OAuth authorize/token endpoints are identical for sandbox and
// production; only the accounting API base URL differs (getQboApiBaseUrl),
// keyed off QBO_ENVIRONMENT.
const QBO_AUTHORIZE_URL = 'https://appcenter.intuit.com/connect/oauth2';
const QBO_TOKEN_URL = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';
const QBO_API_BASE_SANDBOX = 'https://sandbox-quickbooks.api.intuit.com';
const QBO_API_BASE_PRODUCTION = 'https://quickbooks.api.intuit.com';

// Minimum scope for reference sync + writeback. Kept deliberately small —
// openid/profile/email are only needed if we want an id_token, which the
// connection path does not. Override with QBO_SCOPES (space-separated).
const DEFAULT_QBO_SCOPES = ['com.intuit.quickbooks.accounting'];

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
  envValue('QBO_STATE_SECRET') ||
  envValue('XERO_STATE_SECRET') ||
  envValue('DONNA_ACCESS_TOKEN') ||
  envValue('DATABASE_URL') ||
  envValue('POSTGRES_URL') ||
  'donna-local-qbo-state';

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

export const getQboConfig = () => {
  const scopes = parseScopeList(envValue('QBO_SCOPES')).length
    ? parseScopeList(envValue('QBO_SCOPES'))
    : DEFAULT_QBO_SCOPES;
  return {
    clientId: envValue('QBO_CLIENT_ID'),
    clientSecret: envValue('QBO_CLIENT_SECRET'),
    redirectUri: envValue('QBO_REDIRECT_URI'),
    environment: (envValue('QBO_ENVIRONMENT') || 'sandbox').toLowerCase(),
    scopes
  };
};

export const isQboConfigured = () => {
  const config = getQboConfig();
  return Boolean(config.clientId && config.clientSecret && config.redirectUri);
};

// Sandbox vs production only changes the accounting API host (used by the
// reference-sync / writeback PRs). The OAuth endpoints above are shared.
export const getQboApiBaseUrl = (environment = getQboConfig().environment) =>
  String(environment || '').toLowerCase() === 'production' ? QBO_API_BASE_PRODUCTION : QBO_API_BASE_SANDBOX;

export const createQboState = ({
  firmId,
  clientId,
  returnTo = '/firms?tab=accounting',
  redirectUri,
  issuedAt = Date.now(),
  ttlMs = 10 * 60 * 1000
} = {}) => {
  if (!firmId || !clientId) {
    const error = new Error('Firm id and client id are required to start QuickBooks Online connection.');
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

export const verifyQboState = (state, { now = Date.now() } = {}) => {
  const [encoded, signature] = String(state || '').split('.');
  if (!encoded || !signature || !safeCompare(hmac(encoded), signature)) {
    const error = new Error('Invalid QuickBooks Online connection state.');
    error.statusCode = 400;
    throw error;
  }
  const payload = JSON.parse(base64UrlDecode(encoded));
  if (!payload?.firm_id || !payload?.client_id || !payload?.exp || Number(payload.exp) < now) {
    const error = new Error('Expired QuickBooks Online connection state.');
    error.statusCode = 400;
    throw error;
  }
  return payload;
};

export const buildQboAuthorizeUrl = ({ state, redirectUri } = {}) => {
  const config = getQboConfig();
  // Prefer the host-derived callback URL; fall back to the static env so a
  // caller that doesn't thread one through keeps the prior behaviour.
  const callbackUri = redirectUri || config.redirectUri;
  if (!config.clientId || !callbackUri) {
    const error = new Error('QuickBooks Online OAuth is not configured. Set QBO_CLIENT_ID and QBO_REDIRECT_URI.');
    error.statusCode = 500;
    throw error;
  }
  const url = new URL(QBO_AUTHORIZE_URL);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', config.clientId);
  url.searchParams.set('redirect_uri', callbackUri);
  url.searchParams.set('scope', config.scopes.join(' '));
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
    const error = new Error(payload?.error_description || payload?.error || payload?.Detail || 'QuickBooks Online API request failed.');
    error.statusCode = response.status;
    error.payload = payload;
    throw error;
  }
  return payload;
};

const tokenAuthHeader = () => {
  const config = getQboConfig();
  if (!config.clientId || !config.clientSecret) {
    const error = new Error('QuickBooks Online OAuth is not configured. Set QBO_CLIENT_ID and QBO_CLIENT_SECRET.');
    error.statusCode = 500;
    throw error;
  }
  return `Basic ${Buffer.from(`${config.clientId}:${config.clientSecret}`).toString('base64')}`;
};

const tokenExpiresAt = (expiresInSeconds) => new Date(Date.now() + Number(expiresInSeconds || 0) * 1000).toISOString();

const normalizeTokenPayload = (payload = {}) => ({
  accessToken: payload.access_token || '',
  refreshToken: payload.refresh_token || '',
  idToken: payload.id_token || '',
  tokenType: payload.token_type || 'bearer',
  // QBO token responses omit `scope`; fall back to the requested config scopes
  // so the connection record stores what was actually granted.
  scopes: parseScopeList(payload.scope).length ? parseScopeList(payload.scope) : getQboConfig().scopes,
  expiresAt: tokenExpiresAt(payload.expires_in || 3600),
  refreshTokenExpiresAt: payload.x_refresh_token_expires_in
    ? tokenExpiresAt(payload.x_refresh_token_expires_in)
    : null,
  payload
});

export const exchangeQboCode = async ({ code, redirectUri } = {}) => {
  const config = getQboConfig();
  if (!code) {
    const error = new Error('QuickBooks Online callback code is required.');
    error.statusCode = 400;
    throw error;
  }
  const body = new URLSearchParams();
  body.set('grant_type', 'authorization_code');
  body.set('code', code);
  // Must echo the authorize-step redirect_uri (carried in the signed state);
  // fall back to the static env for back-compat.
  body.set('redirect_uri', redirectUri || config.redirectUri);
  const payload = await fetchJson(QBO_TOKEN_URL, {
    method: 'POST',
    headers: {
      Authorization: tokenAuthHeader(),
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body
  });
  return normalizeTokenPayload(payload);
};

export const refreshQboToken = async ({ refreshToken }) => {
  if (!refreshToken) {
    const error = new Error('QuickBooks Online refresh token is required.');
    error.statusCode = 400;
    throw error;
  }
  const body = new URLSearchParams();
  body.set('grant_type', 'refresh_token');
  body.set('refresh_token', refreshToken);
  const payload = await fetchJson(QBO_TOKEN_URL, {
    method: 'POST',
    headers: {
      Authorization: tokenAuthHeader(),
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body
  });
  // The returned refresh_token is the rotated one — the caller MUST persist it
  // and discard the value it passed in.
  return normalizeTokenPayload(payload);
};

export const shouldRefreshQboToken = (expiresAt, { now = Date.now(), skewMs = 5 * 60 * 1000 } = {}) => {
  if (!expiresAt) return true;
  const expires = new Date(expiresAt).getTime();
  return !Number.isFinite(expires) || expires - skewMs <= now;
};

// QBO returns exactly one realm_id on the OAuth callback (?realmId=...). Unlike
// Xero's GET /connections (which can return several tenants), the realm IS the
// connection — company_name isn't available at callback time (it needs a later
// CompanyInfo fetch), so it starts empty.
export const normalizeQboConnection = (connection = {}) => ({
  realmId: connection.realmId || connection.realm_id || '',
  companyName: connection.companyName || connection.company_name || '',
  payload: connection
});

// ── Reference-data sync (Phase 2.1b) ───────────────────────────────────────
// QBO has no "list" endpoints like Xero's GET /Accounts; everything goes
// through the SQL-ish query endpoint:
//   GET {apiBase}/v3/company/{realmId}/query?query=<sql>&minorversion=<n>
// minorversion pins the response schema so a server-side QBO upgrade can't
// silently change field shapes under us. Pagination is expressed IN the query
// text (STARTPOSITION/MAXRESULTS), max 1000 rows per page; we loop until a
// short page. A typical chart of accounts is well under one page, but the loop
// is correct for the long tail (large vendor/customer lists).
const QBO_MINOR_VERSION = '75';
const QBO_QUERY_PAGE_SIZE = 1000;

export const buildQboQueryUrl = ({ environment, realmId, query, minorVersion = QBO_MINOR_VERSION } = {}) => {
  const cleanRealm = String(realmId || '').trim();
  if (!cleanRealm) {
    const error = new Error('QuickBooks Online realm id is required to query reference data.');
    error.statusCode = 400;
    throw error;
  }
  if (!query) {
    const error = new Error('QuickBooks Online query text is required.');
    error.statusCode = 400;
    throw error;
  }
  // Encode by hand rather than URLSearchParams: the latter encodes spaces as
  // '+', and while QBO tolerates that, '%20' is unambiguous for the SQL-ish
  // query text. encodeURIComponent leaves '*' untouched (QBO needs the literal).
  const params = `query=${encodeURIComponent(query)}&minorversion=${encodeURIComponent(minorVersion)}`;
  return `${getQboApiBaseUrl(environment)}/v3/company/${encodeURIComponent(cleanRealm)}/query?${params}`;
};

// One entity, fully paginated. QBO nests the rows under
// QueryResponse[<Entity>] (e.g. QueryResponse.Account); an empty page omits
// the key entirely, so default to []. Returns the flat row array — the firmDb
// writer maps each through the matching normalize* helper below.
const fetchQboEntity = async ({ accessToken, realmId, environment, entity }) => {
  const rows = [];
  let startPosition = 1;
  // Bounded loop: each page advances startPosition by the page size and stops
  // when QBO returns fewer rows than requested (the last page).
  for (;;) {
    const query = `select * from ${entity} startposition ${startPosition} maxresults ${QBO_QUERY_PAGE_SIZE}`;
    const url = buildQboQueryUrl({ environment, realmId, query });
    const payload = await fetchJson(url, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/json'
      }
    });
    const page = payload?.QueryResponse?.[entity] || [];
    rows.push(...page);
    if (page.length < QBO_QUERY_PAGE_SIZE) break;
    startPosition += QBO_QUERY_PAGE_SIZE;
  }
  return rows;
};

export const fetchQboAccounts = (args) => fetchQboEntity({ ...args, entity: 'Account' });
export const fetchQboClasses = (args) => fetchQboEntity({ ...args, entity: 'Class' });
export const fetchQboVendors = (args) => fetchQboEntity({ ...args, entity: 'Vendor' });
export const fetchQboCustomers = (args) => fetchQboEntity({ ...args, entity: 'Customer' });

// QBO sends Active as a real boolean and balances as numbers, but the helpers
// stay defensive (string 'true'/numeric strings) so a minorversion shift or a
// replayed payload can't throw. Default Active to true — QBO omits it on
// active records under some minorversions.
const toQboBool = (value, fallback = false) => {
  if (value === undefined || value === null) return fallback;
  if (typeof value === 'boolean') return value;
  const text = String(value).trim().toLowerCase();
  if (text === 'true') return true;
  if (text === 'false') return false;
  return fallback;
};

const toQboMoney = (value) => {
  const numeric = Number(value ?? 0);
  return Number.isFinite(numeric) ? Math.round(numeric * 100) / 100 : 0;
};

const qboEmail = (entity = {}) =>
  entity.PrimaryEmailAddr?.Address ||
  entity.primaryEmailAddr?.Address ||
  entity.primary_email_addr?.Address ||
  '';

export const normalizeQboAccount = (account = {}) => ({
  qboAccountId: String(account.Id || account.id || ''),
  name: account.Name || account.name || '',
  fullyQualifiedName: account.FullyQualifiedName || account.fullyQualifiedName || '',
  accountNumber: account.AcctNum || account.acctNum || account.account_number || '',
  accountType: account.AccountType || account.accountType || '',
  accountSubType: account.AccountSubType || account.accountSubType || '',
  classification: account.Classification || account.classification || '',
  currency: account.CurrencyRef?.value || account.currencyRef?.value || '',
  active: toQboBool(account.Active ?? account.active, true),
  currentBalance: toQboMoney(account.CurrentBalance ?? account.currentBalance),
  description: account.Description || account.description || '',
  payload: account
});

export const normalizeQboClass = (klass = {}) => ({
  qboClassId: String(klass.Id || klass.id || ''),
  name: klass.Name || klass.name || '',
  fullyQualifiedName: klass.FullyQualifiedName || klass.fullyQualifiedName || '',
  parentId: klass.ParentRef?.value || klass.parentRef?.value || klass.parent_id || '',
  subClass: toQboBool(klass.SubClass ?? klass.subClass, false),
  active: toQboBool(klass.Active ?? klass.active, true),
  payload: klass
});

export const normalizeQboVendor = (vendor = {}) => ({
  qboVendorId: String(vendor.Id || vendor.id || ''),
  displayName: vendor.DisplayName || vendor.displayName || '',
  companyName: vendor.CompanyName || vendor.companyName || '',
  email: qboEmail(vendor),
  active: toQboBool(vendor.Active ?? vendor.active, true),
  balance: toQboMoney(vendor.Balance ?? vendor.balance),
  vendor1099: toQboBool(vendor.Vendor1099 ?? vendor.vendor1099, false),
  payload: vendor
});

export const normalizeQboCustomer = (customer = {}) => ({
  qboCustomerId: String(customer.Id || customer.id || ''),
  displayName: customer.DisplayName || customer.displayName || '',
  companyName: customer.CompanyName || customer.companyName || '',
  email: qboEmail(customer),
  active: toQboBool(customer.Active ?? customer.active, true),
  balance: toQboMoney(customer.Balance ?? customer.balance),
  taxable: toQboBool(customer.Taxable ?? customer.taxable, false),
  payload: customer
});

// ── Writeback: JournalEntry create / update / read (Phase 2.1c) ─────────────
// Mirrors a Donna ledger journal to a QBO JournalEntry. QBO uses the SAME POST
// endpoint for create and update — presence of Id + SyncToken on the body makes
// it an update. There is no client idempotency key (the caller's
// qbo_journal_mirrors row is the dedup guard).
const qboEntityUrl = ({ environment, realmId, entity, id } = {}) => {
  const cleanRealm = String(realmId || '').trim();
  if (!cleanRealm) {
    const error = new Error('QuickBooks Online realm id is required.');
    error.statusCode = 400;
    throw error;
  }
  const base = `${getQboApiBaseUrl(environment)}/v3/company/${encodeURIComponent(cleanRealm)}/${entity}`;
  const params = `minorversion=${encodeURIComponent(QBO_MINOR_VERSION)}`;
  return id ? `${base}/${encodeURIComponent(id)}?${params}` : `${base}?${params}`;
};

// Create (no Id) or update (Id + SyncToken present) a JournalEntry. Returns the
// raw { JournalEntry, time } payload; normalizeQboJournalEntry extracts the bits
// the mirror table persists.
export const postQboJournalEntry = async ({ accessToken, realmId, environment, journalEntry } = {}) => {
  if (!journalEntry || typeof journalEntry !== 'object') {
    const error = new Error('QuickBooks Online JournalEntry payload is required.');
    error.statusCode = 400;
    throw error;
  }
  return fetchJson(qboEntityUrl({ environment, realmId, entity: 'journalentry' }), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(journalEntry)
  });
};

export const fetchQboJournalEntry = async ({ accessToken, realmId, environment, journalEntryId } = {}) => {
  const cleanId = String(journalEntryId || '').trim();
  if (!cleanId) {
    const error = new Error('QuickBooks Online JournalEntry id is required.');
    error.statusCode = 400;
    throw error;
  }
  return fetchJson(qboEntityUrl({ environment, realmId, entity: 'journalentry', id: cleanId }), {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json'
    }
  });
};

// Pull the mirror-relevant fields out of a JournalEntry response (or a stored
// request payload, by passing { JournalEntry: <body> }). `total` is the sum of
// the debit-side line amounts — a balanced entry's one-sided total, used for
// drift checks in verifyMirror.
export const normalizeQboJournalEntry = (response = {}) => {
  const entry = response?.JournalEntry || response?.journalEntry || response || {};
  const lines = Array.isArray(entry.Line) ? entry.Line : [];
  const postingLines = lines.filter((line) => line?.JournalEntryLineDetail || line?.DetailType === 'JournalEntryLineDetail');
  const total = postingLines.reduce((sum, line) => {
    const posting = String(line?.JournalEntryLineDetail?.PostingType || '').toLowerCase();
    return posting === 'debit' ? sum + toQboMoney(line.Amount) : sum;
  }, 0);
  return {
    id: String(entry.Id || entry.id || ''),
    syncToken: String(entry.SyncToken ?? entry.syncToken ?? ''),
    docNumber: entry.DocNumber || entry.docNumber || '',
    txnDate: entry.TxnDate || entry.txnDate || '',
    privateNote: entry.PrivateNote || entry.privateNote || '',
    lineCount: postingLines.length,
    total: Math.round(total * 100) / 100,
    payload: entry
  };
};
