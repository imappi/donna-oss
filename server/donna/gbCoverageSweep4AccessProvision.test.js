import test from 'node:test';
import assert from 'node:assert/strict';

import { createApiSeamPool, requestDonnaApi } from './testSupport/apiSeamHarness.js';

const setEnv = () => {
  process.env.DONNA_ACCESS_TOKEN = 'gb-sweep-4';
  process.env.DATABASE_URL = 'postgres://seam.invalid/donna';
  process.env.SUPABASE_URL = 'https://auth.seam.invalid';
  process.env.SUPABASE_ANON_KEY = 'seam-anon';
  process.env.DONNA_AUTH_ALLOWED_EMAILS = 'staff@example.com';
};

const ownerAuth = { authorization: 'Bearer owner-jwt' };
const deniedPool = () => createApiSeamPool([
  [/from firm_members/, { rows: [], rowCount: 0 }],
  [/from firm_collaborators/, { rows: [{ id: 'owner-1', email: 'owner@example.com', user_id: 'user-owner', status: 'active' }], rowCount: 1 }],
  [/from client_assignments/, { rows: [{ client_id: 'other-client' }], rowCount: 1 }]
]);

for (const route of ['gb-vat-return', 'gb-statutory', 'gb-ltd-close']) {
  await test(`coverage sweep 4: ${route} denies cross-client access before report reads and GET mints nothing`, async () => {
    setEnv();
    const realFetch = globalThis.fetch;
    globalThis.fetch = async () => ({ ok: true, json: async () => ({ id: 'user-owner', email: 'owner@example.com' }) });
    try {
      const pool = deniedPool();
      const response = await requestDonnaApi({
        url: `/api/donna/firms/reports/${route}?firm_id=firm-1&client_id=target-client`, headers: ownerAuth, pool
      });
      assert.deepEqual(response, {
        statusCode: 403,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ error: 'You do not have access to client target-client.', code: 'FIRM_ACCESS_DENIED' }),
        json: { error: 'You do not have access to client target-client.', code: 'FIRM_ACCESS_DENIED' }
      });
      assert.ok(pool.matching(/from client_assignments/).length >= 1, 'the client access query ran');
      assert.equal(pool.matching(/select jurisdiction/).length, 0, 'access refusal preceded client reads');
      assert.equal(pool.matching(/from client_capability_config/).length, 0, 'access refusal preceded config reads');
      assert.equal(pool.matching(/from ledger_|join ledger_/).length, 0, 'access refusal preceded ledger reads');
      assert.equal(pool.matching(/insert|update|delete/).length, 0, 'the refused GET minted nothing');
    } finally { globalThis.fetch = realFetch; }
  });
}

await test('coverage sweep 4: profile write denies cross-client access before entitlement and UPDATE', async () => {
  setEnv();
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ id: 'user-owner', email: 'owner@example.com' }) });
  try {
    const pool = deniedPool();
    const response = await requestDonnaApi({
      method: 'POST', url: '/api/donna/firms/clients/target-client/profile',
      headers: { ...ownerAuth, 'content-type': 'application/json' },
      body: { firm_id: 'firm-1', profile_patch: { gb: { vat_stagger: 1 } } }, pool
    });
    assert.deepEqual(response, {
      statusCode: 403, headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ error: 'You do not have access to client target-client.', code: 'FIRM_ACCESS_DENIED' }),
      json: { error: 'You do not have access to client target-client.', code: 'FIRM_ACCESS_DENIED' }
    });
    assert.ok(pool.matching(/from client_assignments/).length >= 1);
    assert.equal(pool.matching(/from client_subscriptions/).length, 0, 'access refusal preceded entitlement reads');
    assert.equal(pool.matching(/update clients/).length, 0, 'access refusal preceded the profile write');
  } finally { globalThis.fetch = realFetch; }
});

await test('coverage sweep 4: binding-state missing client_id returns its complete 400 before reads', async () => {
  setEnv();
  const pool = createApiSeamPool();
  const response = await requestDonnaApi({
    url: '/api/donna/firms/whatsapp/binding-state?firm_id=firm-1',
    headers: { authorization: 'Bearer gb-sweep-4' }, pool
  });
  assert.deepEqual(response, {
    statusCode: 400, headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ error: 'client_id is required.' }), json: { error: 'client_id is required.' }
  });
  assert.equal(pool.queries.length, 0, 'missing input refused before client, config, or binding reads');
});

await test('coverage sweep 4: returning owner preserves created false and does not mint a client or chart', async () => {
  setEnv();
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ id: 'returning-user', email: 'returning@example.com' }) });
  try {
    const pool = createApiSeamPool([
      [/from firm_collaborators fc/, { rows: [{ client_id: 'existing-gb-client' }], rowCount: 1 }]
    ]);
    const response = await requestDonnaApi({
      method: 'POST', url: '/api/donna/firms/self-provision',
      headers: { ...ownerAuth, 'content-type': 'application/json' }, body: {}, pool
    });
    assert.deepEqual(response, {
      statusCode: 200, headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ client_id: 'existing-gb-client', created: false }),
      json: { client_id: 'existing-gb-client', created: false }
    });
    assert.equal(pool.matching(/from firm_collaborators fc/).length, 1, 'owned-workspace lookup ran');
    assert.equal(pool.matching(/insert into clients/).length, 0);
    assert.equal(pool.matching(/insert into ledger_accounts/).length, 0);
  } finally { globalThis.fetch = realFetch; }
});
