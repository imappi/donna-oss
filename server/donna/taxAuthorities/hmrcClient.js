import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';

const HMRC_AUTH_SANDBOX = 'https://test-www.tax.service.gov.uk/oauth/authorize';
const HMRC_AUTH_PRODUCTION = 'https://www.tax.service.gov.uk/oauth/authorize';
const HMRC_API_SANDBOX = 'https://test-api.service.hmrc.gov.uk';
const HMRC_API_PRODUCTION = 'https://api.service.hmrc.gov.uk';

export const HMRC_VAT_ACCEPT_HEADER = 'application/vnd.hmrc.1.0+json';
export const HMRC_CORRELATION_ID_HEADER = 'X-CorrelationId';
export const DEFAULT_HMRC_SCOPES = Object.freeze(['read:vat', 'write:vat']);

let dotEnvCache = null;

const readDotEnv = () => {
  if (dotEnvCache) return dotEnvCache;
  const vars = {};
  try {
    const envPath = resolvePath(process.cwd(), '.env');
    if (existsSync(envPath)) {
      for (const line of readFileSync(envPath, 'utf8').split('\n')) {
        const match = line.match(/^(\w+)=(.*)$/);
        if (match) vars[match[1]] = match[2].trim().replace(/^["']|["']$/g, '');
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

const parseScopeList = (scopeText = '') =>
  String(scopeText || '')
    .split(/\s+/)
    .map((scope) => scope.trim())
    .filter(Boolean);

const getStateSecret = () =>
  envValue('HMRC_STATE_SECRET') ||
  envValue('DONNA_ACCESS_TOKEN') ||
  envValue('DATABASE_URL') ||
  envValue('POSTGRES_URL') ||
  'donna-local-hmrc-state';

const hmac = (value) => createHmac('sha256', getStateSecret()).update(value).digest('base64url');

const safeCompare = (left = '', right = '') => {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
};

const normalizeEnvironment = (value = '') => String(value || '').trim().toLowerCase() === 'production' ? 'production' : 'sandbox';

export const getHmrcConfig = () => {
  const scopes = parseScopeList(envValue('HMRC_SCOPES')).length
    ? parseScopeList(envValue('HMRC_SCOPES'))
    : [...DEFAULT_HMRC_SCOPES];
  const environment = normalizeEnvironment(envValue('HMRC_ENVIRONMENT') || 'sandbox');
  return {
    clientId: envValue('HMRC_CLIENT_ID'),
    clientSecret: envValue('HMRC_CLIENT_SECRET'),
    redirectUri: envValue('HMRC_REDIRECT_URI'),
    environment,
    scopes
  };
};

export const getHmrcApiBaseUrl = (environment = getHmrcConfig().environment) =>
  normalizeEnvironment(environment) === 'production' ? HMRC_API_PRODUCTION : HMRC_API_SANDBOX;

export const getHmrcAuthorizeBaseUrl = (environment = getHmrcConfig().environment) =>
  normalizeEnvironment(environment) === 'production' ? HMRC_AUTH_PRODUCTION : HMRC_AUTH_SANDBOX;

export const isHmrcConfigured = () => {
  const config = getHmrcConfig();
  return Boolean(config.clientId && config.clientSecret && config.redirectUri);
};

export const requireHmrcConfigured = () => {
  if (!isHmrcConfigured()) {
    const error = new Error('HMRC OAuth is not configured. Set HMRC_CLIENT_ID, HMRC_CLIENT_SECRET, and HMRC_REDIRECT_URI.');
    error.statusCode = 500;
    throw error;
  }
};

export const createHmrcState = ({
  firmId,
  clientId,
  returnTo = '/client',
  redirectUri,
  hmrcUserType = 'organisation',
  issuedAt = Date.now(),
  ttlMs = 10 * 60 * 1000
} = {}) => {
  if (!firmId || !clientId) {
    const error = new Error('Firm id and client id are required to start HMRC connection.');
    error.statusCode = 400;
    throw error;
  }
  const cleanUserType = String(hmrcUserType || 'organisation').toLowerCase();
  if (!['individual', 'organisation'].includes(cleanUserType)) {
    const error = new Error('HMRC user type must be individual or organisation.');
    error.statusCode = 400;
    throw error;
  }
  const payload = {
    firm_id: firmId,
    client_id: clientId,
    hmrc_user_type: cleanUserType,
    return_to: returnTo,
    ...(redirectUri ? { redirect_uri: redirectUri } : {}),
    nonce: randomBytes(12).toString('base64url'),
    exp: issuedAt + ttlMs
  };
  const encoded = base64UrlEncode(JSON.stringify(payload));
  return `${encoded}.${hmac(encoded)}`;
};

export const verifyHmrcState = (state, { now = Date.now() } = {}) => {
  const [encoded, signature] = String(state || '').split('.');
  if (!encoded || !signature || !safeCompare(hmac(encoded), signature)) {
    const error = new Error('Invalid HMRC connection state.');
    error.statusCode = 400;
    throw error;
  }
  const payload = JSON.parse(base64UrlDecode(encoded));
  if (!payload?.firm_id || !payload?.client_id || !payload?.exp || Number(payload.exp) < now) {
    const error = new Error('Expired HMRC connection state.');
    error.statusCode = 400;
    throw error;
  }
  if (!['individual', 'organisation'].includes(String(payload.hmrc_user_type || ''))) {
    const error = new Error('Invalid HMRC user type in connection state.');
    error.statusCode = 400;
    throw error;
  }
  return payload;
};

export const buildHmrcAuthorizeUrl = ({ state, redirectUri } = {}) => {
  const config = getHmrcConfig();
  const callbackUri = redirectUri || config.redirectUri;
  if (!config.clientId || !callbackUri) {
    const error = new Error('HMRC OAuth is not configured. Set HMRC_CLIENT_ID and HMRC_REDIRECT_URI.');
    error.statusCode = 500;
    throw error;
  }
  const url = new URL(getHmrcAuthorizeBaseUrl(config.environment));
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', config.clientId);
  url.searchParams.set('scope', config.scopes.join(' '));
  url.searchParams.set('state', state);
  url.searchParams.set('redirect_uri', callbackUri);
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
    const error = new Error(payload?.error_description || payload?.error || `HMRC API request failed (HTTP ${response.status}).`);
    error.statusCode = response.status;
    error.payload = payload;
    error.hmrcErrorCode = payload?.error || payload?.code || '';
    throw error;
  }
  return payload;
};

const tokenEndpointUrl = () => `${getHmrcApiBaseUrl(getHmrcConfig().environment)}/oauth/token`;

const tokenBody = (entries = {}) => {
  const config = getHmrcConfig();
  if (!config.clientId || !config.clientSecret) {
    const error = new Error('HMRC OAuth is not configured. Set HMRC_CLIENT_ID and HMRC_CLIENT_SECRET.');
    error.statusCode = 500;
    throw error;
  }
  const body = new URLSearchParams();
  body.set('client_secret', config.clientSecret);
  body.set('client_id', config.clientId);
  for (const [key, value] of Object.entries(entries)) body.set(key, value);
  return body;
};

const tokenExpiresAt = (expiresInSeconds) => new Date(Date.now() + Number(expiresInSeconds || 0) * 1000).toISOString();

export const normalizeHmrcTokenPayload = (payload = {}) => ({
  accessToken: payload.access_token || '',
  refreshToken: payload.refresh_token || '',
  tokenType: payload.token_type || 'bearer',
  scopes: parseScopeList(payload.scope).length ? parseScopeList(payload.scope) : getHmrcConfig().scopes,
  expiresAt: tokenExpiresAt(payload.expires_in || 14400),
  payload
});

export const exchangeHmrcCode = async ({ code, redirectUri } = {}) => {
  const config = getHmrcConfig();
  if (!code) {
    const error = new Error('HMRC callback code is required.');
    error.statusCode = 400;
    throw error;
  }
  const payload = await fetchJson(tokenEndpointUrl(), {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: tokenBody({
      grant_type: 'authorization_code',
      redirect_uri: redirectUri || config.redirectUri,
      code
    })
  });
  return normalizeHmrcTokenPayload(payload);
};

export const refreshHmrcToken = async ({ refreshToken } = {}) => {
  if (!refreshToken) {
    const error = new Error('HMRC refresh token is required.');
    error.statusCode = 400;
    throw error;
  }
  const payload = await fetchJson(tokenEndpointUrl(), {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: tokenBody({ grant_type: 'refresh_token', refresh_token: refreshToken })
  });
  return normalizeHmrcTokenPayload(payload);
};

export const shouldRefreshHmrcToken = (expiresAt, { now = Date.now(), skewMs = 5 * 60 * 1000 } = {}) => {
  if (!expiresAt) return true;
  const expires = new Date(expiresAt).getTime();
  return !Number.isFinite(expires) || expires - skewMs <= now;
};

const keyFromEnv = () => envValue('HMRC_TOKEN_KEY');

const normalizeEncryptionKey = (raw) => {
  const value = String(raw || '').trim();
  if (!value) return null;
  if (/^[A-Za-z0-9_-]{43,44}$/.test(value)) {
    const decoded = Buffer.from(value, 'base64url');
    if (decoded.length === 32) return decoded;
  }
  if (/^[A-Za-z0-9+/=]{44}$/.test(value)) {
    const decoded = Buffer.from(value, 'base64');
    if (decoded.length === 32) return decoded;
  }
  if (/^[0-9a-f]{64}$/i.test(value)) return Buffer.from(value, 'hex');
  return createHash('sha256').update(value).digest();
};

const encryptionKey = () => {
  const key = normalizeEncryptionKey(keyFromEnv());
  if (!key) {
    const error = new Error('HMRC token encryption key is not configured. Set HMRC_TOKEN_KEY before connecting HMRC.');
    error.statusCode = 500;
    error.code = 'HMRC_TOKEN_KEY_REQUIRED';
    throw error;
  }
  return key;
};

export const encryptHmrcToken = (plainText) => {
  const value = String(plainText || '');
  if (!value) return '';
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString('base64url')}:${tag.toString('base64url')}:${encrypted.toString('base64url')}`;
};

export const decryptHmrcToken = (cipherText) => {
  const value = String(cipherText || '');
  if (!value) return '';
  const [version, ivText, tagText, encryptedText] = value.split(':');
  if (version !== 'v1' || !ivText || !tagText || !encryptedText) {
    const error = new Error('HMRC token ciphertext is not in a supported format.');
    error.statusCode = 500;
    throw error;
  }
  const decipher = createDecipheriv('aes-256-gcm', encryptionKey(), Buffer.from(ivText, 'base64url'));
  decipher.setAuthTag(Buffer.from(tagText, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(encryptedText, 'base64url')), decipher.final()]).toString('utf8');
};

export const isHmrcInvalidGrantError = (error) =>
  String(error?.hmrcErrorCode || error?.payload?.error || '').toLowerCase() === 'invalid_grant';

export const hmrcCorrelationIdFromHeaders = (headers) =>
  headers?.get?.(HMRC_CORRELATION_ID_HEADER) ||
  headers?.get?.('X-CorrelationID') ||
  headers?.get?.('x-correlationid') ||
  '';

export const buildHmrcRequestHeaders = ({ accessToken, accept = HMRC_VAT_ACCEPT_HEADER, fraudHeaders = {} } = {}) => ({
  Accept: accept,
  ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
  ...fraudHeaders
});
