import test from 'node:test';
import assert from 'node:assert/strict';

import { createApiSeamPool, requestDonnaApi } from './testSupport/apiSeamHarness.js';

const TOKEN = 'gb-sweep-5';
const tokenAuth = { authorization: `Bearer ${TOKEN}` };
const ownerAuth = { authorization: 'Bearer owner-jwt' };

const setBaseEnv = () => {
  process.env.DONNA_ACCESS_TOKEN = TOKEN;
  process.env.DATABASE_URL = 'postgres://seam.invalid/donna';
  process.env.SUPABASE_URL = 'https://auth.seam.invalid';
  process.env.SUPABASE_ANON_KEY = 'seam-anon';
  process.env.DONNA_AUTH_ALLOWED_EMAILS = 'staff@example.com';
  delete process.env.STRIPE_SECRET_KEY;
};

const ownerPool = (extra = []) => createApiSeamPool([
  [/from firm_members/, { rows: [], rowCount: 0 }],
  [/from firm_collaborators/, { rows: [{ id: 'owner-1', email: 'owner@example.com', user_id: 'user-owner', status: 'active' }], rowCount: 1 }],
  [/from client_assignments/, { rows: [{ client_id: 'gb-1' }], rowCount: 1 }],
  ...extra
]);

const withOwnerIdentity = async (run) => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ id: 'user-owner', email: 'owner@example.com' }) });
  try { return await run(); } finally { globalThis.fetch = realFetch; }
};

const assertNoMutation = (pool, message) => {
  assert.equal(pool.matching(/\b(?:insert|update|delete)\b/i).length, 0, message);
};

await test('coverage sweep 5: hmrc connect returns the current owner OAuth envelope without a DB write', async () => {
  setBaseEnv();
  process.env.HMRC_CLIENT_ID = 'hmrc-client';
  process.env.HMRC_CLIENT_SECRET = 'hmrc-secret';
  process.env.HMRC_REDIRECT_URI = 'https://app.example.test/api/donna/firms/hmrc/callback';
  process.env.HMRC_STATE_SECRET = 'hmrc-state-secret';
  const clientQuery = /select id from clients where firm_id = \$1 and id = \$2 and status/;
  const configQuery = /from client_capability_config/;
  const pool = ownerPool([
    [clientQuery, { rows: [{ id: 'gb-1' }], rowCount: 1 }],
    [configQuery, { rows: [{ flag_key: 'HMRC_MTD_VAT', stage: 'canary', source: 'seam', client_id: 'gb-1' }], rowCount: 1 }]
  ]);
  const response = await withOwnerIdentity(() => requestDonnaApi({
    url: '/api/donna/firms/hmrc/connect?firm_id=firm-1&client_id=gb-1&return_to=%2Fclient%2Ftax&hmrc_user_type=organisation',
    headers: { ...ownerAuth, host: 'app.example.test' }, pool
  }));
  assert.equal(response.statusCode, 200, response.body);
  assert.match(response.json.authorizeUrl, /^https:\/\/test-www\.tax\.service\.gov\.uk\/oauth\/authorize\?/);
  assert.equal(typeof response.json.state, 'string');
  assert.deepEqual(response.json.scopes, ['read:vat', 'write:vat']);
  assert.deepEqual(response.json.access, { principal_type: 'firm_collaborator' });
  assert.equal(pool.matching(clientQuery).length, 1, 'the client existence read ran');
  assert.equal(pool.matching(configQuery).length, 1, 'the HMRC config-plane gate ran');
  assertNoMutation(pool, 'starting OAuth mints nothing');
});

await test('coverage sweep 5: hmrc connect missing client_id is the current 400 and mints nothing', async () => {
  setBaseEnv();
  process.env.HMRC_CLIENT_ID = 'hmrc-client';
  process.env.HMRC_CLIENT_SECRET = 'hmrc-secret';
  process.env.HMRC_REDIRECT_URI = 'https://app.example.test/api/donna/firms/hmrc/callback';
  const pool = ownerPool();
  const response = await withOwnerIdentity(() => requestDonnaApi({ url: '/api/donna/firms/hmrc/connect?firm_id=firm-1', headers: { ...ownerAuth, host: 'app.example.test' }, pool }));
  assert.equal(response.statusCode, 400);
  assert.deepEqual(response.json, { error: 'Client id is required to connect HMRC.' });
  assertNoMutation(pool, 'missing client id mints nothing');
});

await test('coverage sweep 5: hmrc connect missing OAuth env is the current 500 before client or config reads', async () => {
  setBaseEnv();
  delete process.env.HMRC_CLIENT_ID;
  delete process.env.HMRC_CLIENT_SECRET;
  delete process.env.HMRC_REDIRECT_URI;
  const pool = ownerPool();
  const response = await withOwnerIdentity(() => requestDonnaApi({ url: '/api/donna/firms/hmrc/connect?firm_id=firm-1&client_id=gb-1', headers: { ...ownerAuth, host: 'app.example.test' }, pool }));
  assert.equal(response.statusCode, 500);
  assert.deepEqual(response.json, { error: 'HMRC OAuth is not configured. Set HMRC_CLIENT_ID, HMRC_CLIENT_SECRET, and HMRC_REDIRECT_URI.' });
  assert.equal(pool.matching(/select id from clients/).length, 0);
  assert.equal(pool.matching(/from client_capability_config/).length, 0);
  assertNoMutation(pool, 'missing HMRC env mints nothing');
});

await test('coverage sweep 5: hmrc connect rejects an operator token before HMRC reads or writes', async () => {
  setBaseEnv();
  const pool = createApiSeamPool();
  const response = await requestDonnaApi({ url: '/api/donna/firms/hmrc/connect?firm_id=firm-1&client_id=gb-1', headers: tokenAuth, pool });
  assert.equal(response.statusCode, 403);
  assert.deepEqual(response.json, { code: 'HMRC_OWNER_GRANT_REQUIRED', error: 'HMRC must be connected by the business owner from the client portal.' });
  assert.equal(pool.queries.length, 0, 'owner-only refusal precedes HMRC DB work');
});

await test('coverage sweep 5: hmrc connect missing database env returns 503 and mints nothing', async () => {
  setBaseEnv();
  delete process.env.DATABASE_URL;
  const pool = createApiSeamPool();
  const response = await requestDonnaApi({ url: '/api/donna/firms/hmrc/connect?firm_id=firm-1&client_id=gb-1', headers: tokenAuth, pool });
  assert.equal(response.statusCode, 503);
  assert.deepEqual(response.json, { error: 'Firm database is not configured.' });
  assert.equal(pool.queries.length, 0, 'environment refusal precedes DB access');
});

await test('coverage sweep 5: whatsapp connect-token mints once and returns the current sender envelope', async () => {
  setBaseEnv();
  process.env.WHATSAPP_SENDER_NUMBER_E164 = '+447700900321';
  const tokenWrite = /insert into client_whatsapp_bind_tokens/;
  const auditWrite = /insert into audit_events/;
  const pool = createApiSeamPool([
    [tokenWrite, { rows: [{ token_hash: 'stored-hash' }], rowCount: 1 }],
    [auditWrite, { rows: [], rowCount: 1 }]
  ]);
  const response = await requestDonnaApi({ method: 'POST', url: '/api/donna/firms/whatsapp/connect-token', headers: { ...tokenAuth, 'content-type': 'application/json' }, body: { firm_id: 'firm-1', client_id: 'gb-1' }, pool });
  assert.equal(response.statusCode, 201, response.body);
  assert.match(response.json.expires_at, /^\d{4}-\d\d-\d\dT/);
  assert.match(response.json.prefilled_text, /^connect [A-Za-z0-9_-]{32}$/);
  assert.equal(response.json.wa_me_url, `https://wa.me/447700900321?text=${encodeURIComponent(response.json.prefilled_text)}`);
  assert.equal(pool.matching(tokenWrite).length, 1, 'exactly one bind token was minted');
  assert.equal(pool.matching(auditWrite).length, 1, 'the mint receipt was written');
});

for (const [name, route, body, expected] of [
  ['connect-token', '/api/donna/firms/whatsapp/connect-token', {}, { error: 'client_id is required.' }],
  ['bindings revoke', '/api/donna/firms/whatsapp/bindings/revoke', { client_id: 'gb-1' }, { error: 'client_id and binding_id are required.' }]
]) {
  await test(`coverage sweep 5: whatsapp ${name} missing params refuse before DB writes and mint nothing`, async () => {
    setBaseEnv();
    const pool = createApiSeamPool();
    const response = await requestDonnaApi({ method: 'POST', url: route, headers: { ...tokenAuth, 'content-type': 'application/json' }, body, pool });
    assert.equal(response.statusCode, 400);
    assert.deepEqual(response.json, expected);
    assert.equal(pool.queries.length, 0, 'parameter refusal precedes DB access');
  });
}

for (const [name, route, body] of [
  ['connect-token', '/api/donna/firms/whatsapp/connect-token', { client_id: 'gb-1' }],
  ['bindings revoke', '/api/donna/firms/whatsapp/bindings/revoke', { client_id: 'gb-1', binding_id: 'wab-1' }]
]) {
  await test(`coverage sweep 5: whatsapp ${name} missing database env returns 503 and mints nothing`, async () => {
    setBaseEnv();
    delete process.env.DATABASE_URL;
    const pool = createApiSeamPool();
    const response = await requestDonnaApi({ method: 'POST', url: route, headers: { ...tokenAuth, 'content-type': 'application/json' }, body, pool });
    assert.equal(response.statusCode, 503);
    assert.deepEqual(response.json, { error: 'Firm database is not configured.' });
    assert.equal(pool.queries.length, 0, 'environment refusal precedes DB access');
  });
}

for (const [name, route, body] of [
  ['connect-token', '/api/donna/firms/whatsapp/connect-token', { client_id: 'gb-1' }],
  ['bindings revoke', '/api/donna/firms/whatsapp/bindings/revoke', { client_id: 'gb-1', binding_id: 'wab-1' }]
]) {
  await test(`coverage sweep 5: whatsapp ${name} unauthorized request returns 401 and mints nothing`, async () => {
    setBaseEnv();
    const pool = createApiSeamPool();
    const response = await requestDonnaApi({ method: 'POST', url: route, headers: { 'content-type': 'application/json' }, body, pool });
    assert.equal(response.statusCode, 401);
    assert.deepEqual(response.json, { error: 'Access token required.', code: 'AUTH_REQUIRED' });
    assert.equal(pool.queries.length, 0, 'auth refusal precedes DB access');
  });
}

await test('coverage sweep 5: whatsapp bindings revoke returns the persisted binding and receipts the write', async () => {
  setBaseEnv();
  const bindingWrite = /update client_whatsapp_bindings set revoked_at/;
  const auditWrite = /insert into audit_events/;
  const binding = { id: 'wab-1', client_id: 'gb-1', revoked_at: '2026-08-02T12:00:00Z', revoked_by: 'access-token' };
  const pool = createApiSeamPool([
    [bindingWrite, { rows: [binding], rowCount: 1 }],
    [auditWrite, { rows: [], rowCount: 1 }]
  ]);
  const response = await requestDonnaApi({ method: 'POST', url: '/api/donna/firms/whatsapp/bindings/revoke', headers: { ...tokenAuth, 'content-type': 'application/json' }, body: { firm_id: 'firm-1', client_id: 'gb-1', binding_id: 'wab-1' }, pool });
  assert.equal(response.statusCode, 200, response.body);
  assert.deepEqual(response.json, { revoked: true, binding });
  assert.equal(pool.matching(bindingWrite).length, 1, 'the binding revoke ran once');
  assert.equal(pool.matching(auditWrite).length, 1, 'the revoke receipt ran once');
});
