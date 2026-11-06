import { createHash } from 'node:crypto';

export const HMRC_FRAUD_PREVENTION_CONNECTION_METHOD = 'WEB_APP_VIA_SERVER';
export const HMRC_FRAUD_PREVENTION_HEADER_SET_VERSION = 'hmrc-fph-v3.3-web-app-via-server-2025-01-27';

export const HMRC_WEB_APP_VIA_SERVER_REQUIRED_HEADERS = Object.freeze([
  'Gov-Client-Connection-Method',
  'Gov-Client-Browser-JS-User-Agent',
  'Gov-Client-Device-ID',
  'Gov-Client-Multi-Factor',
  'Gov-Client-Public-IP',
  'Gov-Client-Public-IP-Timestamp',
  'Gov-Client-Public-Port',
  'Gov-Client-Screens',
  'Gov-Client-Timezone',
  'Gov-Client-User-IDs',
  'Gov-Client-Window-Size',
  'Gov-Vendor-Forwarded',
  'Gov-Vendor-License-IDs',
  'Gov-Vendor-Product-Name',
  'Gov-Vendor-Public-IP',
  'Gov-Vendor-Version'
]);

const percentEncode = (value) => encodeURIComponent(String(value ?? ''));
const isPresent = (value) => value !== undefined && value !== null && String(value).trim() !== '';
const isoWithMillis = (value) => {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? '' : date.toISOString();
};

const kv = (entries = {}) => Object.entries(entries)
  .filter(([, value]) => isPresent(value))
  .map(([key, value]) => `${percentEncode(key)}=${percentEncode(value)}`)
  .join('&');

const listOfKv = (items = []) => items.map(kv).filter(Boolean).join(',');

export const formatHmrcMultiFactor = (factors = []) => listOfKv(factors.map((factor) => ({
  type: factor.type,
  timestamp: factor.timestamp,
  'unique-reference': factor.uniqueReference ?? factor['unique-reference']
})));

export const formatHmrcScreens = (screens = []) => listOfKv(screens.map((screen) => ({
  width: screen.width,
  height: screen.height,
  'scaling-factor': screen.scalingFactor ?? screen['scaling-factor'],
  'colour-depth': screen.colourDepth ?? screen['colour-depth']
})));

export const formatHmrcForwarded = (hops = []) => listOfKv(hops.map((hop) => ({ by: hop.by, for: hop.for })));

export const canonicalizeHmrcFraudPreventionHeaders = (headers = {}) => Object.keys(headers)
  .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()) || a.localeCompare(b))
  .filter((key) => isPresent(headers[key]))
  .map((key) => `${key.toLowerCase()}:${String(headers[key])}`)
  .join('\n');

export const hashHmrcFraudPreventionHeaders = (headers = {}) =>
  createHash('sha256').update(canonicalizeHmrcFraudPreventionHeaders(headers)).digest('hex');

export const getMissingHmrcFraudPreventionHeaders = (headers = {}) =>
  HMRC_WEB_APP_VIA_SERVER_REQUIRED_HEADERS.filter((header) => !isPresent(headers[header]));

export const assertHmrcFraudPreventionHeadersReady = ({ headers = {}, production = true } = {}) => {
  const missing = getMissingHmrcFraudPreventionHeaders(headers);
  const warnings = [];
  if (missing.length && production) {
    const error = new Error(`Missing HMRC fraud-prevention headers: ${missing.join(', ')}`);
    error.code = 'HMRC_FRAUD_PREVENTION_HEADERS_MISSING';
    error.statusCode = 500;
    error.missing = missing;
    error.warnings = warnings;
    throw error;
  }
  return { ready: missing.length === 0, missing, warnings };
};

export const buildHmrcFraudPreventionHeaders = ({
  connectionMethod = HMRC_FRAUD_PREVENTION_CONNECTION_METHOD,
  client = {},
  request = {},
  vendor = {},
  now = new Date()
} = {}) => {
  const headers = {
    'Gov-Client-Connection-Method': connectionMethod,
    'Gov-Client-Browser-JS-User-Agent': client.browserJsUserAgent,
    'Gov-Client-Device-ID': client.deviceId,
    'Gov-Client-Multi-Factor': client.multiFactor ? formatHmrcMultiFactor(client.multiFactor) : client.multiFactorRaw,
    'Gov-Client-Public-IP': request.clientPublicIp,
    'Gov-Client-Public-IP-Timestamp': request.clientPublicIpTimestamp ? isoWithMillis(request.clientPublicIpTimestamp) : isoWithMillis(now),
    'Gov-Client-Public-Port': request.clientPublicPort,
    'Gov-Client-Screens': client.screens ? formatHmrcScreens(client.screens) : client.screensRaw,
    'Gov-Client-Timezone': client.timezone,
    'Gov-Client-User-IDs': client.userIds ? kv(client.userIds) : client.userIdsRaw,
    'Gov-Client-Window-Size': client.windowSize ? kv({ width: client.windowSize.width, height: client.windowSize.height }) : client.windowSizeRaw,
    'Gov-Vendor-Forwarded': vendor.forwarded ? formatHmrcForwarded(vendor.forwarded) : vendor.forwardedRaw,
    'Gov-Vendor-License-IDs': vendor.licenseIds ? kv(vendor.licenseIds) : vendor.licenseIdsRaw,
    'Gov-Vendor-Product-Name': isPresent(vendor.productName) ? percentEncode(vendor.productName) : vendor.productNameRaw,
    'Gov-Vendor-Public-IP': vendor.publicIp,
    'Gov-Vendor-Version': vendor.version ? kv(vendor.version) : vendor.versionRaw
  };
  const compactHeaders = Object.fromEntries(Object.entries(headers).filter(([, value]) => isPresent(value)));
  const missing = getMissingHmrcFraudPreventionHeaders(compactHeaders);
  const warnings = connectionMethod === HMRC_FRAUD_PREVENTION_CONNECTION_METHOD ? [] : [`Unsupported HMRC fraud-prevention connection method: ${connectionMethod}`];
  return { headers: compactHeaders, version: HMRC_FRAUD_PREVENTION_HEADER_SET_VERSION, missing, warnings };
};

export const validateHmrcFraudPreventionHeadersWithHmrc = async ({ accessToken, headers = {}, fetchImpl = fetch } = {}) => {
  if (!accessToken) throw new Error('HMRC access token is required to validate fraud-prevention headers.');
  const response = await fetchImpl('https://test-api.service.hmrc.gov.uk/test/fraud-prevention-headers/validate', {
    method: 'GET',
    headers: {
      Accept: 'application/vnd.hmrc.1.0+json',
      Authorization: `Bearer ${accessToken}`,
      ...headers
    }
  });
  return response.json();
};
