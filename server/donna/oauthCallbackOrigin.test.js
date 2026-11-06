import assert from 'node:assert/strict';
import test from 'node:test';

import {
  resolveOAuthCallbackOrigin,
  collectAllowedOAuthOrigins,
  buildOAuthCallbackUrl,
  OAuthCallbackOriginError
} from './oauthCallbackOrigin.js';

const reqWith = (headers) => ({ headers });

await test('derives an https origin from Host when no allow-list is configured', () => {
  assert.equal(
    resolveOAuthCallbackOrigin(reqWith({ host: 'books-app.example' }), { env: {} }),
    'https://books-app.example'
  );
});

await test('honours x-forwarded-proto', () => {
  assert.equal(
    resolveOAuthCallbackOrigin(
      reqWith({ host: 'books-app.example', 'x-forwarded-proto': 'https' }),
      { env: {} }
    ),
    'https://books-app.example'
  );
  // Chained proxies can send a comma list; the first hop's scheme wins.
  assert.equal(
    resolveOAuthCallbackOrigin(
      reqWith({ host: 'books-app.example', 'x-forwarded-proto': 'https,http' }),
      { env: {} }
    ),
    'https://books-app.example'
  );
});

await test('localhost defaults to http when no proxy proto header is present', () => {
  assert.equal(
    resolveOAuthCallbackOrigin(reqWith({ host: 'localhost:3000' }), { env: {} }),
    'http://localhost:3000'
  );
});

await test('a forwarded host that AGREES with Host is accepted', () => {
  assert.equal(
    resolveOAuthCallbackOrigin(
      reqWith({ host: 'app.example.com', 'x-forwarded-host': 'app.example.com', 'x-forwarded-proto': 'https' }),
      { env: {} }
    ),
    'https://app.example.com'
  );
});

await test('a spoofed forwarded host (disagrees with Host) is refused', () => {
  assert.throws(
    () =>
      resolveOAuthCallbackOrigin(
        reqWith({ host: 'books-app.example', 'x-forwarded-host': 'evil.example.com' }),
        { env: {} }
      ),
    (err) => {
      assert.ok(err instanceof OAuthCallbackOriginError);
      assert.equal(err.statusCode, 400);
      assert.equal(err.code, 'OAUTH_CALLBACK_ORIGIN_REJECTED');
      assert.equal(err.details.host, 'books-app.example');
      assert.equal(err.details.forwarded_host, 'evil.example.com');
      return true;
    }
  );
});

await test('a request with no Host header is refused', () => {
  assert.throws(() => resolveOAuthCallbackOrigin(reqWith({}), { env: {} }), OAuthCallbackOriginError);
});

await test('allow-list: the derived origin must be a member when the list is non-empty', () => {
  const env = { DONNA_OAUTH_ALLOWED_ORIGINS: 'https://books-app.example' };
  assert.equal(
    resolveOAuthCallbackOrigin(
      reqWith({ host: 'books-app.example', 'x-forwarded-proto': 'https' }),
      { env }
    ),
    'https://books-app.example'
  );
  assert.throws(
    () =>
      resolveOAuthCallbackOrigin(
        reqWith({ host: 'preview-xyz.vercel.app', 'x-forwarded-proto': 'https' }),
        { env }
      ),
    (err) => {
      assert.ok(err instanceof OAuthCallbackOriginError);
      assert.equal(err.details.origin, 'https://preview-xyz.vercel.app');
      assert.deepEqual(err.details.allowed, ['https://books-app.example']);
      return true;
    }
  );
});

await test('the configured provider redirect origin seeds the allow-list', () => {
  // Even WITHOUT DONNA_OAUTH_ALLOWED_ORIGINS, a stale XERO_REDIRECT_URI makes
  // the allow-list non-empty, so loading a different live deployment fails
  // loud (the misconfiguration is surfaced, not silently followed).
  const env = { XERO_REDIRECT_URI: 'https://dead-deployment.vercel.app/api/donna/firms/xero/callback' };
  assert.equal(
    resolveOAuthCallbackOrigin(
      reqWith({ host: 'dead-deployment.vercel.app', 'x-forwarded-proto': 'https' }),
      { env }
    ),
    'https://dead-deployment.vercel.app'
  );
  assert.throws(
    () =>
      resolveOAuthCallbackOrigin(
        reqWith({ host: 'live-deployment.vercel.app', 'x-forwarded-proto': 'https' }),
        { env }
      ),
    OAuthCallbackOriginError
  );
});

await test('collectAllowedOAuthOrigins gathers explicit + provider + Vercel origins (deduped)', () => {
  const origins = collectAllowedOAuthOrigins({
    DONNA_OAUTH_ALLOWED_ORIGINS: 'https://a.example.com, https://b.example.com',
    XERO_REDIRECT_URI: 'https://c.example.com/api/donna/firms/xero/callback',
    QBO_REDIRECT_URI: 'https://c.example.com/api/donna/firms/qbo/callback',
    HMRC_REDIRECT_URI: 'https://hmrc.example.com/api/donna/firms/hmrc/callback',
    VERCEL_URL: 'd.vercel.app',
    VERCEL_PROJECT_PRODUCTION_URL: 'books-app.example'
  });
  assert.deepEqual(
    [...origins].sort(),
    [
      'https://a.example.com',
      'https://b.example.com',
      'https://c.example.com',
      'https://d.vercel.app',
      'https://hmrc.example.com',
      'https://books-app.example'
    ].sort()
  );
});

await test('an empty env yields an empty (permissive) allow-list', () => {
  assert.equal(collectAllowedOAuthOrigins({}).size, 0);
});

await test('buildOAuthCallbackUrl returns the system-specific rewrite path', () => {
  assert.equal(
    buildOAuthCallbackUrl({ origin: 'https://books-app.example', system: 'xero' }),
    'https://books-app.example/api/donna/firms/xero/callback'
  );
  assert.equal(
    buildOAuthCallbackUrl({ origin: 'https://books-app.example', system: 'qbo' }),
    'https://books-app.example/api/donna/firms/qbo/callback'
  );
  assert.equal(
    buildOAuthCallbackUrl({ origin: 'https://books-app.example', system: 'hmrc' }),
    'https://books-app.example/api/donna/firms/hmrc/callback'
  );
  assert.throws(() => buildOAuthCallbackUrl({ origin: 'https://x.example.com', system: 'sage' }), OAuthCallbackOriginError);
  assert.throws(() => buildOAuthCallbackUrl({ origin: '', system: 'xero' }), OAuthCallbackOriginError);
});
