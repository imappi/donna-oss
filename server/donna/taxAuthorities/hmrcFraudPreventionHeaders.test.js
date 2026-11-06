import test from 'node:test';
import assert from 'node:assert/strict';

import { buildHmrcRequestHeaders } from './hmrcClient.js';
import {
  assertHmrcFraudPreventionHeadersReady,
  buildHmrcFraudPreventionHeaders,
  canonicalizeHmrcFraudPreventionHeaders,
  hashHmrcFraudPreventionHeaders,
  validateHmrcFraudPreventionHeadersWithHmrc
} from './hmrcFraudPreventionHeaders.js';

const completeInput = () => ({
  client: {
    browserJsUserAgent: 'Mozilla/5.0 DonnaTest',
    deviceId: 'beec798b-b366-47fa-b1f8-92cede14a1ce',
    multiFactor: [{ type: 'AUTH_CODE', timestamp: '2026-07-09T10:00Z', uniqueReference: 'abc 123' }],
    screens: [{ width: 1920, height: 1080, scalingFactor: 1.25, colourDepth: 24 }],
    timezone: 'UTC+00:00',
    userIds: { 'Donna Portal': 'alice@example.com' },
    windowSize: { width: 1256, height: 803 }
  },
  request: {
    clientPublicIp: '198.51.100.0',
    clientPublicIpTimestamp: '2026-07-09T10:01:02.003Z',
    clientPublicPort: 12345
  },
  vendor: {
    forwarded: [{ by: '203.0.113.6', for: '198.51.100.0' }],
    licenseIds: { Donna: '8D7963490527D33716835EE7C195516D5E562E03B224E9B359836466EE40CDE1' },
    productName: 'Donna Portal',
    publicIp: '203.0.113.6',
    version: { Donna: '1.2.3' }
  },
  now: new Date('2026-07-09T10:01:02.003Z')
});

test('builds the verified WEB_APP_VIA_SERVER header set and reports readiness', () => {
  const result = buildHmrcFraudPreventionHeaders(completeInput());
  assert.equal(result.version, 'hmrc-fph-v3.3-web-app-via-server-2025-01-27');
  assert.deepEqual(result.missing, []);
  assert.equal(result.headers['Gov-Client-Connection-Method'], 'WEB_APP_VIA_SERVER');
  assert.equal(result.headers['Gov-Client-Public-IP-Timestamp'], '2026-07-09T10:01:02.003Z');
});

test('percent-encodes values without encoding key-value separators', () => {
  const { headers } = buildHmrcFraudPreventionHeaders(completeInput());
  assert.equal(headers['Gov-Client-User-IDs'], 'Donna%20Portal=alice%40example.com');
  assert.equal(headers['Gov-Vendor-Product-Name'], 'Donna%20Portal');
  assert.equal(headers['Gov-Client-Multi-Factor'], 'type=AUTH_CODE&timestamp=2026-07-09T10%3A00Z&unique-reference=abc%20123');
  assert.equal(headers['Gov-Client-Screens'], 'width=1920&height=1080&scaling-factor=1.25&colour-depth=24');
});

test('canonicalization and hashing are stable regardless of input key order', () => {
  const one = { 'Gov-Vendor-Version': 'Donna=1.2.3', 'Gov-Client-Connection-Method': 'WEB_APP_VIA_SERVER' };
  const two = { 'Gov-Client-Connection-Method': 'WEB_APP_VIA_SERVER', 'Gov-Vendor-Version': 'Donna=1.2.3' };
  assert.equal(canonicalizeHmrcFraudPreventionHeaders(one), 'gov-client-connection-method:WEB_APP_VIA_SERVER\ngov-vendor-version:Donna=1.2.3');
  assert.equal(hashHmrcFraudPreventionHeaders(one), hashHmrcFraudPreventionHeaders(two));
  assert.match(hashHmrcFraudPreventionHeaders(one), /^[a-f0-9]{64}$/);
});

test('fail-closed assertion throws on production-bound calls with missing metadata', () => {
  const { headers, missing } = buildHmrcFraudPreventionHeaders({ client: {}, request: {}, vendor: {}, now: new Date('2026-07-09T00:00:00.000Z') });
  assert.ok(missing.includes('Gov-Client-Browser-JS-User-Agent'));
  assert.throws(() => assertHmrcFraudPreventionHeadersReady({ headers, production: true }), /Missing HMRC fraud-prevention headers/);
  assert.equal(assertHmrcFraudPreventionHeadersReady({ headers, production: false }).ready, false);
});

test('hmrcClient request-header seam injects fraud headers without call-site hand-rolling', () => {
  const { headers } = buildHmrcFraudPreventionHeaders(completeInput());
  const requestHeaders = buildHmrcRequestHeaders({ accessToken: 'token-123', fraudHeaders: headers });
  assert.equal(requestHeaders.Authorization, 'Bearer token-123');
  assert.equal(requestHeaders['Gov-Client-Connection-Method'], 'WEB_APP_VIA_SERVER');
});

test('sandbox validator helper sends the documented request shape with stubbed fetch', async () => {
  let seen;
  const payload = await validateHmrcFraudPreventionHeadersWithHmrc({
    accessToken: 'token-123',
    headers: { 'Gov-Client-Connection-Method': 'WEB_APP_VIA_SERVER' },
    fetchImpl: async (url, options) => {
      seen = { url, options };
      return { json: async () => ({ code: 'VALID_HEADERS' }) };
    }
  });
  assert.equal(seen.url, 'https://test-api.service.hmrc.gov.uk/test/fraud-prevention-headers/validate');
  assert.equal(seen.options.method, 'GET');
  assert.equal(seen.options.headers.Accept, 'application/vnd.hmrc.1.0+json');
  assert.equal(seen.options.headers.Authorization, 'Bearer token-123');
  assert.equal(payload.code, 'VALID_HEADERS');
});
