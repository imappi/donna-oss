import assert from 'node:assert/strict';
import test from 'node:test';

process.env.HMRC_CLIENT_ID = 'hmrc-client';
process.env.HMRC_CLIENT_SECRET = 'hmrc-secret';
process.env.HMRC_REDIRECT_URI = 'https://example.test/api/donna/firms/hmrc/callback';
process.env.HMRC_STATE_SECRET = 'hmrc-state-secret';
process.env.HMRC_TOKEN_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

import {
  buildHmrcAuthorizeUrl,
  createHmrcState,
  decryptHmrcToken,
  encryptHmrcToken,
  getHmrcApiBaseUrl,
  getHmrcAuthorizeBaseUrl,
  hmrcCorrelationIdFromHeaders,
  normalizeHmrcTokenPayload,
  refreshHmrcToken,
  isHmrcInvalidGrantError,
  shouldRefreshHmrcToken,
  verifyHmrcState
} from './taxAuthorities/hmrcClient.js';

const redirectUri = 'https://branch.example/api/donna/firms/hmrc/callback';

test('HMRC endpoints default to sandbox and switch to production with HMRC_ENVIRONMENT', () => {
  process.env.HMRC_ENVIRONMENT = 'sandbox';
  assert.equal(getHmrcApiBaseUrl(), 'https://test-api.service.hmrc.gov.uk');
  assert.equal(getHmrcAuthorizeBaseUrl(), 'https://test-www.tax.service.gov.uk/oauth/authorize');
  process.env.HMRC_ENVIRONMENT = 'production';
  assert.equal(getHmrcApiBaseUrl(), 'https://api.service.hmrc.gov.uk');
  assert.equal(getHmrcAuthorizeBaseUrl(), 'https://www.tax.service.gov.uk/oauth/authorize');
  process.env.HMRC_ENVIRONMENT = 'sandbox';
});

test('HMRC state signs firm/client/nonce/exp/redirect_uri and forbids agent user type', () => {
  const state = createHmrcState({ firmId: 'firm-1', clientId: 'client-1', redirectUri, hmrcUserType: 'organisation', issuedAt: 1000, ttlMs: 60_000 });
  const payload = verifyHmrcState(state, { now: 2000 });
  assert.equal(payload.firm_id, 'firm-1');
  assert.equal(payload.client_id, 'client-1');
  assert.equal(payload.redirect_uri, redirectUri);
  assert.equal(payload.hmrc_user_type, 'organisation');
  assert.ok(payload.nonce);
  assert.throws(() => createHmrcState({ firmId: 'firm-1', clientId: 'client-1', hmrcUserType: 'agent' }), /individual or organisation/);
  assert.throws(() => verifyHmrcState(`${state}x`, { now: 2000 }), /Invalid HMRC/);
  assert.throws(() => verifyHmrcState(state, { now: 100_000 }), /Expired HMRC/);
});

test('HMRC authorize URL uses verified VAT scopes and host-derived redirect_uri', () => {
  const state = createHmrcState({ firmId: 'firm-1', clientId: 'client-1', redirectUri });
  const url = new URL(buildHmrcAuthorizeUrl({ state, redirectUri }));
  assert.equal(url.origin + url.pathname, 'https://test-www.tax.service.gov.uk/oauth/authorize');
  assert.equal(url.searchParams.get('response_type'), 'code');
  assert.equal(url.searchParams.get('client_id'), 'hmrc-client');
  assert.equal(url.searchParams.get('redirect_uri'), redirectUri);
  assert.equal(url.searchParams.get('scope'), 'read:vat write:vat');
  assert.equal(url.searchParams.get('state'), state);
});

test('HMRC token encryption round-trips and does not store plaintext', () => {
  const cipher = encryptHmrcToken('secret-refresh-token');
  assert.notEqual(cipher, 'secret-refresh-token');
  assert.match(cipher, /^v1:/);
  assert.equal(decryptHmrcToken(cipher), 'secret-refresh-token');
});

test('HMRC refresh posts form body and preserves rotated refresh token', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async (url, options) => {
    assert.equal(url, 'https://test-api.service.hmrc.gov.uk/oauth/token');
    assert.equal(options.method, 'POST');
    assert.equal(options.headers['Content-Type'], 'application/x-www-form-urlencoded');
    const body = new URLSearchParams(String(options.body));
    assert.equal(body.get('grant_type'), 'refresh_token');
    assert.equal(body.get('refresh_token'), 'old-refresh');
    assert.equal(body.get('client_id'), 'hmrc-client');
    assert.equal(body.get('client_secret'), 'hmrc-secret');
    return new Response(JSON.stringify({
      access_token: 'fresh-access',
      refresh_token: 'rotated-refresh',
      token_type: 'bearer',
      expires_in: 14400,
      scope: 'read:vat write:vat'
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  const token = await refreshHmrcToken({ refreshToken: 'old-refresh' });
  assert.equal(token.accessToken, 'fresh-access');
  assert.equal(token.refreshToken, 'rotated-refresh');
  assert.deepEqual(token.scopes, ['read:vat', 'write:vat']);
});

test('HMRC token normalization and refresh skew', () => {
  const token = normalizeHmrcTokenPayload({ access_token: 'a', refresh_token: 'r', expires_in: 14400, scope: 'read:vat write:vat' });
  assert.equal(token.accessToken, 'a');
  assert.equal(token.refreshToken, 'r');
  assert.deepEqual(token.scopes, ['read:vat', 'write:vat']);
  assert.equal(shouldRefreshHmrcToken(new Date(Date.now() + 60_000).toISOString()), true);
  assert.equal(shouldRefreshHmrcToken(new Date(Date.now() + 60 * 60_000).toISOString()), false);
});

test('HMRC correlation header helper uses the VAT API response header name', () => {
  const headers = new Headers({ 'X-CorrelationId': 'c75f40a6-a3df-4429-a697-471eeec46435' });
  assert.equal(hmrcCorrelationIdFromHeaders(headers), 'c75f40a6-a3df-4429-a697-471eeec46435');
});

test('HMRC invalid_grant classifier is payload-based', () => {
  assert.equal(isHmrcInvalidGrantError({ payload: { error: 'invalid_grant' } }), true);
  assert.equal(isHmrcInvalidGrantError({ payload: { error: 'server_error' } }), false);
});
