// oauthRedirect — pure-parser tests.
//
// The OAuth redirect landing is the one auth path that cannot be
// exercised in the dev container (no prod egress, no Supabase keys), so
// the hash/query parsing is pinned here before it ever sees a deploy.

import assert from 'node:assert/strict';

import { parseOAuthRedirect, stripOAuthParamsFromSearch } from './oauthRedirect.js';

let passed = 0;
let failed = 0;

const test = async (name, fn) => {
  try {
    await fn();
    passed += 1;
    console.log(`  ok  ${name}`);
  } catch (err) {
    failed += 1;
    console.error(`  FAIL ${name}`);
    console.error(`       ${err?.stack || err?.message || err}`);
  }
};

console.log('oauthRedirect (GoTrue redirect parsing):');

// ─── session captures ────────────────────────────────────────────────────

await test('implicit-flow hash → session with all fields', () => {
  const out = parseOAuthRedirect({
    hash: '#access_token=at-123&refresh_token=rt-456&expires_in=3600&token_type=bearer',
    search: ''
  });
  assert.equal(out.type, 'session');
  assert.equal(out.session.access_token, 'at-123');
  assert.equal(out.session.refresh_token, 'rt-456');
  assert.equal(out.session.expires_in, 3600);
  assert.equal(out.session.user, null);
});

await test('hash without leading # parses the same', () => {
  const out = parseOAuthRedirect({ hash: 'access_token=at-123&refresh_token=rt-456' });
  assert.equal(out.type, 'session');
  assert.equal(out.session.access_token, 'at-123');
});

await test('missing/garbage expires_in → null, not NaN', () => {
  assert.equal(
    parseOAuthRedirect({ hash: '#access_token=at&refresh_token=rt' }).session.expires_in,
    null
  );
  assert.equal(
    parseOAuthRedirect({ hash: '#access_token=at&expires_in=soon' }).session.expires_in,
    null
  );
});

await test('recovery link → session flagged recovery:true', () => {
  const out = parseOAuthRedirect({
    hash: '#access_token=at-123&refresh_token=rt-456&expires_in=3600&type=recovery'
  });
  assert.equal(out.type, 'session');
  assert.equal(out.recovery, true);
});

await test('ordinary session → recovery:false', () => {
  const out = parseOAuthRedirect({ hash: '#access_token=at&refresh_token=rt&type=signup' });
  assert.equal(out.recovery, false);
});

// ─── error captures ──────────────────────────────────────────────────────

await test('error in hash → message with + decoded to spaces', () => {
  const out = parseOAuthRedirect({
    hash: '#error=server_error&error_description=Database+error+saving+new+user'
  });
  assert.equal(out.type, 'error');
  assert.equal(out.message, 'Database error saving new user');
});

await test('error in query string (no hash) → message', () => {
  const out = parseOAuthRedirect({
    hash: '',
    search: '?error=access_denied&error_description=User+declined+consent'
  });
  assert.equal(out.type, 'error');
  assert.equal(out.message, 'User declined consent');
});

await test('error code alone (no description) → code as message', () => {
  const out = parseOAuthRedirect({ search: '?error=access_denied' });
  assert.equal(out.type, 'error');
  assert.equal(out.message, 'access_denied');
});

await test('expired recovery link → error with error_code surfaced', () => {
  const out = parseOAuthRedirect({
    hash: '#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired'
  });
  assert.equal(out.type, 'error');
  assert.equal(out.code, 'otp_expired');
  assert.equal(out.message, 'Email link is invalid or has expired');
});

// ─── non-OAuth URLs pass through ─────────────────────────────────────────

await test('plain anchor hash → null (must not strip #documents-style anchors)', () => {
  assert.equal(parseOAuthRedirect({ hash: '#documents' }), null);
});

await test('app query params only → null', () => {
  assert.equal(parseOAuthRedirect({ search: '?entity=client-1&tab=documents' }), null);
});

await test('empty inputs → null', () => {
  assert.equal(parseOAuthRedirect({}), null);
  assert.equal(parseOAuthRedirect(), null);
});

// ─── stripOAuthParamsFromSearch ──────────────────────────────────────────

await test('strip removes GoTrue error params, preserves app params', () => {
  assert.equal(
    stripOAuthParamsFromSearch('?entity=client-1&error=server_error&error_code=500&error_description=boom&tab=documents'),
    '?entity=client-1&tab=documents'
  );
});

await test('strip on error-only search → empty string', () => {
  assert.equal(stripOAuthParamsFromSearch('?error=access_denied&error_description=nope'), '');
});

await test('strip on empty search → empty string', () => {
  assert.equal(stripOAuthParamsFromSearch(''), '');
});

console.log(`\noauthRedirect (GoTrue redirect parsing): ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
