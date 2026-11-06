import test from 'node:test';
import assert from 'node:assert/strict';

import { createApiSeamPool, requestDonnaApi } from './testSupport/apiSeamHarness.js';

const TOKEN = 'telegram-refusal-lanes';
const tokenAuth = { authorization: `Bearer ${TOKEN}` };
const ownerAuth = { authorization: 'Bearer owner-jwt' };
const ENV_KEYS = ['DONNA_ACCESS_TOKEN', 'DATABASE_URL', 'SUPABASE_URL', 'SUPABASE_ANON_KEY', 'DONNA_AUTH_ALLOWED_EMAILS'];

const preserveEnv = () => Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
const restoreEnv = (prior) => {
  for (const [key, value] of Object.entries(prior)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
};
const setBaseEnv = () => {
  process.env.DONNA_ACCESS_TOKEN = TOKEN;
  process.env.DATABASE_URL = 'postgres://seam.invalid/donna';
  process.env.SUPABASE_URL = 'https://auth.seam.invalid';
  process.env.SUPABASE_ANON_KEY = 'seam-anon';
  process.env.DONNA_AUTH_ALLOWED_EMAILS = 'staff@example.com';
};
const deniedPool = () => createApiSeamPool([
  [/from firm_members/, { rows: [], rowCount: 0 }],
  [/from firm_collaborators/, { rows: [{ id: 'owner-1', email: 'owner@example.com', user_id: 'user-owner', status: 'active' }], rowCount: 1 }],
  [/from client_assignments/, { rows: [{ client_id: 'other-client' }], rowCount: 1 }]
]);
const deniedResponse = {
  error: 'You do not have access to client target-client.',
  code: 'FIRM_ACCESS_DENIED'
};

await test('GET telegram/binding-state: missing client_id returns 400 before reads', async () => {
  const prior = preserveEnv();
  try {
    setBaseEnv();
    const pool = createApiSeamPool();
    const response = await requestDonnaApi({ url: '/api/donna/firms/telegram/binding-state?firm_id=firm-1', headers: tokenAuth, pool });
    assert.equal(response.statusCode, 400);
    assert.deepEqual(response.json, { error: 'client_id is required.' });
    assert.equal(pool.matching(/select|insert|update|delete/i).length, 0, 'parameter refusal precedes DB access');
  } finally { restoreEnv(prior); }
});

await test('GET telegram/binding-state: missing database env returns 503 before reads', async () => {
  const prior = preserveEnv();
  try {
    setBaseEnv();
    delete process.env.DATABASE_URL;
    const pool = createApiSeamPool();
    const response = await requestDonnaApi({ url: '/api/donna/firms/telegram/binding-state?client_id=target-client', headers: tokenAuth, pool });
    assert.equal(response.statusCode, 503);
    assert.deepEqual(response.json, { error: 'Firm database is not configured.' });
    assert.equal(pool.matching(/select|insert|update|delete/i).length, 0, 'environment refusal precedes DB access');
  } finally { restoreEnv(prior); }
});

await test('GET telegram/binding-state: unauthorized request returns 401 with no DB reads', async () => {
  const prior = preserveEnv();
  try {
    setBaseEnv();
    const pool = createApiSeamPool();
    const response = await requestDonnaApi({ url: '/api/donna/firms/telegram/binding-state?client_id=target-client', pool });
    assert.equal(response.statusCode, 401);
    assert.deepEqual(response.json, { error: 'Access token required.', code: 'AUTH_REQUIRED' });
    assert.equal(pool.matching(/select|insert|update|delete/i).length, 0, 'auth refusal precedes DB access');
  } finally { restoreEnv(prior); }
});

for (const [name, method, url, body, forbidden] of [
  ['GET telegram/binding-state', 'GET', '/api/donna/firms/telegram/binding-state?firm_id=firm-1&client_id=target-client', undefined, /coalesce\(channel, 'whatsapp'\)|from client_capability_config/],
  ['POST telegram/connect-token', 'POST', '/api/donna/firms/telegram/connect-token', { firm_id: 'firm-1', client_id: 'target-client' }, /insert into client_whatsapp_bind_tokens/],
  ['POST telegram/bindings/revoke', 'POST', '/api/donna/firms/telegram/bindings/revoke', { firm_id: 'firm-1', client_id: 'target-client', binding_id: 'tgb-1' }, /update client_whatsapp_bindings|insert into audit_events/]
]) {
  await test(`${name}: cross-client access denial precedes route reads and writes`, async () => {
    const prior = preserveEnv();
    const realFetch = globalThis.fetch;
    try {
      setBaseEnv();
      globalThis.fetch = async () => ({ ok: true, json: async () => ({ id: 'user-owner', email: 'owner@example.com' }) });
      const pool = deniedPool();
      const response = await requestDonnaApi({ method, url, headers: { ...ownerAuth, ...(body ? { 'content-type': 'application/json' } : {}) }, body, pool });
      assert.equal(response.statusCode, 403);
      assert.deepEqual(response.json, deniedResponse);
      assert.ok(pool.matching(/from client_assignments/).length >= 1, 'the access query ran');
      assert.equal(pool.matching(forbidden).length, 0, 'access refusal precedes route reads and writes');
    } finally {
      globalThis.fetch = realFetch;
      restoreEnv(prior);
    }
  });
}

for (const [name, url, body, write] of [
  ['POST telegram/connect-token', '/api/donna/firms/telegram/connect-token', { client_id: 'target-client' }, /insert into client_whatsapp_bind_tokens/],
  ['POST telegram/bindings/revoke', '/api/donna/firms/telegram/bindings/revoke', { client_id: 'target-client', binding_id: 'tgb-1' }, /update client_whatsapp_bindings|insert into audit_events/]
]) {
  await test(`${name}: missing database env returns 503 before writes`, async () => {
    const prior = preserveEnv();
    try {
      setBaseEnv();
      delete process.env.DATABASE_URL;
      const pool = createApiSeamPool();
      const response = await requestDonnaApi({ method: 'POST', url, headers: { ...tokenAuth, 'content-type': 'application/json' }, body, pool });
      assert.equal(response.statusCode, 503);
      assert.deepEqual(response.json, { error: 'Firm database is not configured.' });
      assert.equal(pool.matching(write).length, 0, 'environment refusal precedes the write');
    } finally { restoreEnv(prior); }
  });

  await test(`${name}: unauthorized request returns 401 with zero writes`, async () => {
    const prior = preserveEnv();
    try {
      setBaseEnv();
      const pool = createApiSeamPool();
      const response = await requestDonnaApi({ method: 'POST', url, headers: { 'content-type': 'application/json' }, body, pool });
      assert.equal(response.statusCode, 401);
      assert.deepEqual(response.json, { error: 'Access token required.', code: 'AUTH_REQUIRED' });
      assert.equal(pool.matching(write).length, 0, 'auth refusal precedes the write');
    } finally { restoreEnv(prior); }
  });
}

await test('POST telegram/bindings/revoke: missing params return 400 before writes', async () => {
  const prior = preserveEnv();
  try {
    setBaseEnv();
    const pool = createApiSeamPool();
    const response = await requestDonnaApi({
      method: 'POST', url: '/api/donna/firms/telegram/bindings/revoke',
      headers: { ...tokenAuth, 'content-type': 'application/json' }, body: { client_id: 'target-client' }, pool
    });
    assert.equal(response.statusCode, 400);
    assert.deepEqual(response.json, { error: 'client_id and binding_id are required.' });
    assert.equal(pool.matching(/update client_whatsapp_bindings|insert into audit_events/).length, 0, 'parameter refusal precedes writes');
  } finally { restoreEnv(prior); }
});
