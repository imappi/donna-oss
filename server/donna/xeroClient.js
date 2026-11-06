import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import { toLocalIsoDay } from './dates.js';

const XERO_AUTHORIZE_URL = 'https://login.xero.com/identity/connect/authorize';
const XERO_TOKEN_URL = 'https://identity.xero.com/connect/token';
const XERO_CONNECTIONS_URL = 'https://api.xero.com/connections';
const XERO_ACCOUNTING_BASE_URL = 'https://api.xero.com/api.xro/2.0';

const DEFAULT_XERO_SCOPES = [
  'openid',
  'profile',
  'email',
  'offline_access',
  'accounting.settings',
  'accounting.contacts',
  'accounting.banktransactions'
];

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
  envValue('XERO_STATE_SECRET') ||
  envValue('DONNA_ACCESS_TOKEN') ||
  envValue('DATABASE_URL') ||
  envValue('POSTGRES_URL') ||
  'donna-local-xero-state';

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

export const getXeroConfig = () => {
  const scopes = parseScopeList(envValue('XERO_SCOPES')).length
    ? parseScopeList(envValue('XERO_SCOPES'))
    : DEFAULT_XERO_SCOPES;
  return {
    clientId: envValue('XERO_CLIENT_ID'),
    clientSecret: envValue('XERO_CLIENT_SECRET'),
    redirectUri: envValue('XERO_REDIRECT_URI'),
    scopes
  };
};

export const isXeroConfigured = () => {
  const config = getXeroConfig();
  return Boolean(config.clientId && config.clientSecret && config.redirectUri);
};

export const createXeroState = ({
  firmId,
  clientId,
  returnTo = '/firms?tab=accounting',
  redirectUri,
  issuedAt = Date.now(),
  ttlMs = 10 * 60 * 1000
} = {}) => {
  if (!firmId || !clientId) {
    const error = new Error('Firm id and client id are required to start Xero connection.');
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

export const verifyXeroState = (state, { now = Date.now() } = {}) => {
  const [encoded, signature] = String(state || '').split('.');
  if (!encoded || !signature || !safeCompare(hmac(encoded), signature)) {
    const error = new Error('Invalid Xero connection state.');
    error.statusCode = 400;
    throw error;
  }
  const payload = JSON.parse(base64UrlDecode(encoded));
  if (!payload?.firm_id || !payload?.client_id || !payload?.exp || Number(payload.exp) < now) {
    const error = new Error('Expired Xero connection state.');
    error.statusCode = 400;
    throw error;
  }
  return payload;
};

export const buildXeroAuthorizeUrl = ({ state, redirectUri } = {}) => {
  const config = getXeroConfig();
  // Prefer the host-derived callback URL; fall back to the static env so a
  // caller that doesn't thread one through keeps the prior behaviour.
  const callbackUri = redirectUri || config.redirectUri;
  if (!config.clientId || !callbackUri) {
    const error = new Error('Xero OAuth is not configured. Set XERO_CLIENT_ID and XERO_REDIRECT_URI.');
    error.statusCode = 500;
    throw error;
  }
  const url = new URL(XERO_AUTHORIZE_URL);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', config.clientId);
  url.searchParams.set('redirect_uri', callbackUri);
  url.searchParams.set('scope', config.scopes.join(' '));
  url.searchParams.set('state', state);
  return url.toString();
};

// Extract the HUMAN reason from a Xero error payload. Xero validation failures
// (HTTP 400 ValidationException) bury the actual message in
// Elements[].ValidationErrors[].Message while the top level only says
// "A validation exception occurred" — and the old Detail-only extraction
// surfaced NEITHER, so a failed row persisted the useless
// "Xero API request failed." (live receipt: the pilot client's `Conversion Sell SGD
// 30.00` export error was undiagnosable from its stored message, 2026-07-07).
// Pure + exported for tests.
export const xeroErrorMessage = (payload) => {
  if (!payload || typeof payload !== 'object') return '';
  const validationMessages = (Array.isArray(payload.Elements) ? payload.Elements : [])
    .flatMap((element) => (Array.isArray(element?.ValidationErrors) ? element.ValidationErrors : []))
    .map((entry) => String(entry?.Message || '').trim())
    .filter(Boolean);
  if (validationMessages.length) return validationMessages.join('; ');
  return String(payload.Detail || payload.Message || payload.Title || payload.error_description || payload.error || '').trim();
};

// 429 rate-limit pacing (2026-07-07): a full writeback batch fires ~2 Xero calls
// per row (create + History note); ~40 rows in a burst tripped Xero's per-minute
// limit and rows failed with HTTP 429 (live receipt: a pilot client's tx-133/139). A 429
// means the request was NOT applied, so it is always safe to retry — including
// POSTs, which also carry an idempotency key. Respect `Retry-After` (bounded),
// retry a bounded number of times, then surface the error as before. Exported so
// the delay is injectable in tests (no real waiting).
export const XERO_RATE_LIMIT_RETRIES = 3;
const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export const xeroRetryAfterMs = (response) => {
  const raw = response?.headers?.get?.('Retry-After');
  const seconds = Number(raw);
  if (raw != null && Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds, 15) * 1000;
  return 1500;
};

const fetchJson = async (url, options = {}, { retries = XERO_RATE_LIMIT_RETRIES, sleep = defaultSleep } = {}) => {
  for (let attempt = 0; ; attempt += 1) {
    const response = await fetch(url, options);
    const text = await response.text();
    let payload = null;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      payload = { raw: text };
    }
    if (response.ok) return payload;
    if (response.status === 429 && attempt < retries) {
      await sleep(xeroRetryAfterMs(response));
      continue;
    }
    // Always carry the HTTP status in the message — the persisted
    // xero_writeback_error keeps only error.message, so a bare "request
    // failed" loses even the 4xx-vs-5xx class.
    const error = new Error(xeroErrorMessage(payload) || `Xero API request failed (HTTP ${response.status}).`);
    error.statusCode = response.status;
    error.payload = payload;
    throw error;
  }
};

const tokenAuthHeader = () => {
  const config = getXeroConfig();
  if (!config.clientId || !config.clientSecret) {
    const error = new Error('Xero OAuth is not configured. Set XERO_CLIENT_ID and XERO_CLIENT_SECRET.');
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
  tokenType: payload.token_type || 'Bearer',
  scopes: parseScopeList(payload.scope),
  expiresAt: tokenExpiresAt(payload.expires_in || 1800),
  payload
});

export const exchangeXeroCode = async ({ code, redirectUri } = {}) => {
  const config = getXeroConfig();
  if (!code) {
    const error = new Error('Xero callback code is required.');
    error.statusCode = 400;
    throw error;
  }
  const body = new URLSearchParams();
  body.set('grant_type', 'authorization_code');
  body.set('code', code);
  // Must echo the authorize-step redirect_uri (carried in the signed state);
  // fall back to the static env for back-compat.
  body.set('redirect_uri', redirectUri || config.redirectUri);
  const payload = await fetchJson(XERO_TOKEN_URL, {
    method: 'POST',
    headers: {
      Authorization: tokenAuthHeader(),
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body
  });
  return normalizeTokenPayload(payload);
};

export const refreshXeroToken = async ({ refreshToken }) => {
  if (!refreshToken) {
    const error = new Error('Xero refresh token is required.');
    error.statusCode = 400;
    throw error;
  }
  const body = new URLSearchParams();
  body.set('grant_type', 'refresh_token');
  body.set('refresh_token', refreshToken);
  const payload = await fetchJson(XERO_TOKEN_URL, {
    method: 'POST',
    headers: {
      Authorization: tokenAuthHeader(),
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body
  });
  return normalizeTokenPayload(payload);
};

export const shouldRefreshXeroToken = (expiresAt, { now = Date.now(), skewMs = 5 * 60 * 1000 } = {}) => {
  if (!expiresAt) return true;
  const expires = new Date(expiresAt).getTime();
  return !Number.isFinite(expires) || expires - skewMs <= now;
};

export const fetchXeroConnections = async ({ accessToken, signal } = {}) => {
  if (!accessToken) {
    const error = new Error('Xero access token is required.');
    error.statusCode = 400;
    throw error;
  }
  return fetchJson(XERO_CONNECTIONS_URL, {
    headers: { Authorization: `Bearer ${accessToken}` },
    ...(signal ? { signal } : {})
  });
};

// Revoke the app<->org grant at Xero: DELETE /connections/{id} (204 No
// Content; fetchJson tolerates the empty body). This is what makes a Donna
// disconnect / client-delete a true clean slate at Xero — without it the org
// keeps showing as "already connected" to the app after our local rows are
// gone, so a re-upload + reconnect is stuck. `connectionId` is Xero's own
// connection id (the `id` field from GET /connections), NOT our deterministic
// xero_connections.id.
export const deleteXeroConnection = async ({ accessToken, connectionId, signal } = {}) => {
  if (!accessToken) {
    const error = new Error('Xero access token is required.');
    error.statusCode = 400;
    throw error;
  }
  const cleanId = String(connectionId || '').trim();
  if (!cleanId) {
    const error = new Error('Xero connection id is required.');
    error.statusCode = 400;
    throw error;
  }
  return fetchJson(`${XERO_CONNECTIONS_URL}/${encodeURIComponent(cleanId)}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${accessToken}` },
    ...(signal ? { signal } : {})
  });
};

const accountingHeaders = ({ accessToken, tenantId, idempotencyKey } = {}) => {
  if (!accessToken || !tenantId) {
    const error = new Error('Xero access token and tenant id are required.');
    error.statusCode = 400;
    throw error;
  }
  return {
    Authorization: `Bearer ${accessToken}`,
    'xero-tenant-id': tenantId,
    Accept: 'application/json',
    ...(idempotencyKey ? { 'Idempotency-Key': String(idempotencyKey).slice(0, 128) } : {})
  };
};

const fetchAccountingResource = async ({ accessToken, tenantId, path }) => {
  return fetchJson(`${XERO_ACCOUNTING_BASE_URL}${path}`, {
    headers: accountingHeaders({ accessToken, tenantId })
  });
};

export const fetchXeroAccounts = async ({ accessToken, tenantId }) =>
  fetchAccountingResource({ accessToken, tenantId, path: '/Accounts' });

export const fetchXeroContacts = async ({ accessToken, tenantId }) =>
  fetchAccountingResource({ accessToken, tenantId, path: '/Contacts' });

export const fetchXeroBankTransactionsByReference = async ({
  accessToken,
  tenantId,
  reference
} = {}) => {
  const cleanReference = String(reference || '').replaceAll('"', '\\"');
  if (!cleanReference) return { BankTransactions: [] };
  const params = new URLSearchParams({
    where: `Reference=="${cleanReference}"`
  });
  return fetchAccountingResource({
    accessToken,
    tenantId,
    path: `/BankTransactions?${params.toString()}`
  });
};

export const fetchXeroBankTransactionById = async ({
  accessToken,
  tenantId,
  bankTransactionId
} = {}) => {
  const cleanId = String(bankTransactionId || '').trim();
  if (!cleanId) return { BankTransactions: [] };
  return fetchAccountingResource({
    accessToken,
    tenantId,
    path: `/BankTransactions/${encodeURIComponent(cleanId)}`
  });
};

const dateOnly = (value = '') => {
  const text = String(value || '').trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(text)) return text.slice(0, 10);
  // Free text parses to host-local midnight, so the host-local day is the
  // day the text named (audit F-11).
  return toLocalIsoDay(new Date(text));
};

export const fetchXeroBankTransactionsByFingerprint = async ({
  accessToken,
  tenantId,
  bankTransaction = {}
} = {}) => {
  const date = dateOnly(bankTransaction.Date || bankTransaction.DateString);
  const type = String(bankTransaction.Type || '').trim().toUpperCase();
  if (!date || !type) return { BankTransactions: [] };
  const [year, month, day] = date.split('-').map((part) => Number(part));
  const where = [
    `Date==DateTime(${year},${month},${day})`,
    `Type=="${type.replaceAll('"', '\\"')}"`
  ].join('&&');
  const params = new URLSearchParams({ where });
  return fetchAccountingResource({
    accessToken,
    tenantId,
    path: `/BankTransactions?${params.toString()}`
  });
};

export const createXeroBankTransaction = async ({
  accessToken,
  tenantId,
  bankTransaction,
  idempotencyKey
} = {}) => {
  if (!bankTransaction || typeof bankTransaction !== 'object') {
    const error = new Error('Xero bank transaction payload is required.');
    error.statusCode = 400;
    throw error;
  }
  return fetchJson(`${XERO_ACCOUNTING_BASE_URL}/BankTransactions`, {
    method: 'POST',
    headers: {
      ...accountingHeaders({ accessToken, tenantId, idempotencyKey }),
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ BankTransactions: [bankTransaction] })
  });
};

// Void a Donna-posted BankTransaction in Xero (clean-offboarding teardown, G2).
// Xero has no hard-delete for a bank transaction; POSTing the id with
// Status="DELETED" voids it — it survives as a DELETED row, which is excluded
// from the GL and from matchingXeroBankTransactions (so a voided mirror never
// blocks a fresh, legitimate re-post). This is the FIRST live-write teardown
// helper — fetch + create were the only writes before. Best-effort callers
// (clearXeroMirrorForClientBestEffort) pass an 8s abort signal so a slow void
// can never hang a disconnect/delete. See
// docs/xero-writeback-idempotency-across-reset.md (Option B) +
// docs/donna-xero-clean-offboarding.md (G2).
export const voidXeroBankTransaction = async ({
  accessToken,
  tenantId,
  bankTransactionId,
  idempotencyKey,
  signal
} = {}) => {
  const cleanId = String(bankTransactionId || '').trim();
  if (!cleanId) {
    const error = new Error('Xero bank transaction id is required.');
    error.statusCode = 400;
    throw error;
  }
  return fetchJson(`${XERO_ACCOUNTING_BASE_URL}/BankTransactions/${encodeURIComponent(cleanId)}`, {
    method: 'POST',
    headers: {
      ...accountingHeaders({ accessToken, tenantId, idempotencyKey }),
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ BankTransactionID: cleanId, Status: 'DELETED' }),
    ...(signal ? { signal } : {})
  });
};

// G7 (clean-offboarding guarantee) — append a human-readable note to a Donna-
// posted BankTransaction's History & Notes in Xero. PUT .../History with a
// HistoryRecords[].Details record; Xero stores it append-only (immutable),
// authored by the Donna app, so it becomes part of the audit trail the CPA
// inherits — the WHY behind each coded line, not just the numbers. This is audit
// ENRICHMENT, not a correctness write: callers post it best-effort (8s abort) and
// never let a failed note fail a successful posting. See
// docs/donna-xero-clean-offboarding.md (G7).
export const addXeroBankTransactionHistoryNote = async ({
  accessToken,
  tenantId,
  bankTransactionId,
  details,
  signal
} = {}) => {
  const cleanId = String(bankTransactionId || '').trim();
  if (!cleanId) {
    const error = new Error('Xero bank transaction id is required.');
    error.statusCode = 400;
    throw error;
  }
  const note = String(details || '').trim();
  if (!note) {
    const error = new Error('A history note (details) is required.');
    error.statusCode = 400;
    throw error;
  }
  return fetchJson(`${XERO_ACCOUNTING_BASE_URL}/BankTransactions/${encodeURIComponent(cleanId)}/History`, {
    method: 'PUT',
    headers: {
      ...accountingHeaders({ accessToken, tenantId }),
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ HistoryRecords: [{ Details: note.slice(0, 1000) }] }),
    ...(signal ? { signal } : {})
  });
};

export const createXeroAccount = async ({
  accessToken,
  tenantId,
  account,
  idempotencyKey
} = {}) => {
  if (!account || typeof account !== 'object') {
    const error = new Error('Xero account payload is required.');
    error.statusCode = 400;
    throw error;
  }
  return fetchJson(`${XERO_ACCOUNTING_BASE_URL}/Accounts`, {
    method: 'PUT',
    headers: {
      ...accountingHeaders({ accessToken, tenantId, idempotencyKey }),
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(account)
  });
};

export const normalizeXeroConnection = (connection = {}) => ({
  tenantId: connection.tenantId || connection.tenant_id || '',
  tenantName: connection.tenantName || connection.tenant_name || '',
  tenantType: connection.tenantType || connection.tenant_type || '',
  authEventId: connection.authEventId || connection.auth_event_id || '',
  createdDateUtc: connection.createdDateUtc || connection.created_date_utc || null,
  updatedDateUtc: connection.updatedDateUtc || connection.updated_date_utc || null,
  payload: connection
});

export const normalizeXeroAccount = (account = {}) => ({
  xeroAccountId: account.AccountID || account.accountId || account.account_id || account.Code || '',
  code: account.Code || account.code || '',
  name: account.Name || account.name || '',
  type: account.Type || account.type || '',
  status: account.Status || account.status || '',
  taxType: account.TaxType || account.taxType || account.tax_type || '',
  class: account.Class || account.class || '',
  systemAccount: account.SystemAccount || account.systemAccount || account.system_account || '',
  enablePaymentsToAccount: Boolean(account.EnablePaymentsToAccount ?? account.enablePaymentsToAccount),
  showInExpenseClaims: Boolean(account.ShowInExpenseClaims ?? account.showInExpenseClaims),
  payload: account
});

export const normalizeXeroContact = (contact = {}) => ({
  xeroContactId: contact.ContactID || contact.contactId || contact.contact_id || contact.ContactNumber || contact.Name || '',
  contactNumber: contact.ContactNumber || contact.contactNumber || contact.contact_number || '',
  name: contact.Name || contact.name || '',
  emailAddress: contact.EmailAddress || contact.emailAddress || contact.email_address || '',
  isCustomer: Boolean(contact.IsCustomer ?? contact.isCustomer),
  isSupplier: Boolean(contact.IsSupplier ?? contact.isSupplier),
  status: contact.ContactStatus || contact.Status || contact.status || '',
  payload: contact
});
