import test from 'node:test';
import assert from 'node:assert/strict';

import { createApiSeamPool, requestDonnaApi } from './testSupport/apiSeamHarness.js';

const TOKEN = 'fiscal-period-refusals';
const tokenAuth = { authorization: `Bearer ${TOKEN}` };
const ownerAuth = { authorization: 'Bearer owner-jwt' };
const ROUTE = '/api/donna/firms/clients/target-client/fiscal-periods';

const withEnv = async (changes, run) => {
  const keys = ['DONNA_ACCESS_TOKEN', 'DATABASE_URL', 'SUPABASE_URL', 'SUPABASE_ANON_KEY', 'DONNA_AUTH_ALLOWED_EMAILS', 'STRIPE_SECRET_KEY'];
  const prior = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  try {
    process.env.DONNA_ACCESS_TOKEN = TOKEN;
    process.env.DATABASE_URL = 'postgres://seam.invalid/donna';
    process.env.SUPABASE_URL = 'https://auth.seam.invalid';
    process.env.SUPABASE_ANON_KEY = 'seam-anon';
    process.env.DONNA_AUTH_ALLOWED_EMAILS = 'staff@example.com';
    delete process.env.STRIPE_SECRET_KEY;
    for (const [key, value] of Object.entries(changes)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    return await run();
  } finally {
    for (const key of keys) {
      if (prior[key] === undefined) delete process.env[key]; else process.env[key] = prior[key];
    }
  }
};

const withOwnerIdentity = async (run) => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ id: 'user-owner', email: 'owner@example.com' }) });
  try { return await run(); } finally { globalThis.fetch = realFetch; }
};

const deniedPool = () => createApiSeamPool([
  [/from firm_members/, { rows: [], rowCount: 0 }],
  [/from firm_collaborators/, { rows: [{ id: 'owner-1', email: 'owner@example.com', user_id: 'user-owner', status: 'active' }], rowCount: 1 }],
  [/from client_assignments/, { rows: [{ client_id: 'other-client' }], rowCount: 1 }]
]);

await test('GET fiscal-periods refusal: missing database env returns 503 before period reads', async () => withEnv({ DATABASE_URL: undefined }, async () => {
  const pool = createApiSeamPool();
  const response = await requestDonnaApi({ url: ROUTE, headers: tokenAuth, pool });
  assert.equal(response.statusCode, 503);
  assert.deepEqual(response.json, { error: 'Firm database is not configured.' });
  assert.equal(pool.matching(/from fiscal_years/).length, 0);
}));

await test('GET fiscal-periods refusal: unauthorized request returns 401 before period reads', async () => withEnv({}, async () => {
  const pool = createApiSeamPool();
  const response = await requestDonnaApi({ url: ROUTE, pool });
  assert.equal(response.statusCode, 401);
  assert.deepEqual(response.json, { error: 'Access token required.', code: 'AUTH_REQUIRED' });
  assert.equal(pool.matching(/from fiscal_years/).length, 0);
}));

await test('GET fiscal-periods refusal: cross-client access is denied before period reads', async () => withEnv({}, () => withOwnerIdentity(async () => {
  const pool = deniedPool();
  const response = await requestDonnaApi({ url: `${ROUTE}?firm_id=firm-1`, headers: ownerAuth, pool });
  assert.equal(response.statusCode, 403);
  assert.deepEqual(response.json, { error: 'You do not have access to client target-client.', code: 'FIRM_ACCESS_DENIED' });
  assert.equal(pool.matching(/from fiscal_years/).length, 0);
})));

await test('POST fiscal-periods refusal: missing database env returns 503 before writes', async () => withEnv({ DATABASE_URL: undefined }, async () => {
  const pool = createApiSeamPool();
  const response = await requestDonnaApi({ method: 'POST', url: ROUTE, headers: tokenAuth, body: { starts_on: '2026-01-01', ends_on: '2026-12-31' }, pool });
  assert.equal(response.statusCode, 503);
  assert.deepEqual(response.json, { error: 'Firm database is not configured.' });
  assert.equal(pool.matching(/\b(?:insert|update|delete)\b/i).length, 0);
}));

await test('POST fiscal-periods refusal: unauthorized request returns 401 before writes', async () => withEnv({}, async () => {
  const pool = createApiSeamPool();
  const response = await requestDonnaApi({ method: 'POST', url: ROUTE, body: { starts_on: '2026-01-01', ends_on: '2026-12-31' }, pool });
  assert.equal(response.statusCode, 401);
  assert.deepEqual(response.json, { error: 'Access token required.', code: 'AUTH_REQUIRED' });
  assert.equal(pool.matching(/\b(?:insert|update|delete)\b/i).length, 0);
}));

await test('POST fiscal-periods refusal: cross-client access is denied before entitlement and writes', async () => withEnv({ STRIPE_SECRET_KEY: 'sk_test_seam' }, () => withOwnerIdentity(async () => {
  const pool = deniedPool();
  const response = await requestDonnaApi({ method: 'POST', url: ROUTE, headers: ownerAuth, body: { firm_id: 'firm-1', starts_on: '2026-01-01', ends_on: '2026-12-31' }, pool });
  assert.equal(response.statusCode, 403);
  assert.deepEqual(response.json, { error: 'You do not have access to client target-client.', code: 'FIRM_ACCESS_DENIED' });
  assert.equal(pool.matching(/stripe_subscription_status|stripe_one_time_kind/).length, 0);
  assert.equal(pool.matching(/\b(?:insert|update|delete)\b/i).length, 0);
})));

for (const [name, body] of [
  ['missing ends_on', { starts_on: '2026-01-01' }],
  ['non-string ends_on', { starts_on: '2026-01-01', ends_on: 20261231 }]
]) {
  await test(`POST fiscal-periods refusal: ${name} returns the writer's named label refusal before writes`, async () => withEnv({}, async () => {
    const pool = createApiSeamPool([
      [/select id from clients where firm_id/, { rows: [{ id: 'target-client' }], rowCount: 1 }],
      [/from client_capability_config/, { rows: [{ flag_key: 'FISCAL_PERIOD_INTAKE', stage: 'canary', source: 'test', client_id: 'target-client' }], rowCount: 1 }],
      [/select jurisdiction, entity_type, profile from clients/, { rows: [{ jurisdiction: 'GB', entity_type: 'gb-ltd' }], rowCount: 1 }]
    ]);
    const response = await requestDonnaApi({ method: 'POST', url: ROUTE, headers: tokenAuth, body, pool });
    assert.equal(response.statusCode, 400, response.body);
    assert.deepEqual(response.json, { error: 'A fiscal period requires a label.', code: 'FISCAL_PERIOD_LABEL_REQUIRED' });
    assert.equal(pool.matching(/insert into fiscal_years|insert into audit_events/).length, 0);
  }));
}

await test('POST fiscal-periods refusal: an inactive owner plan returns the entitlement refusal before writes', async () => withEnv({ STRIPE_SECRET_KEY: 'sk_test_seam' }, () => withOwnerIdentity(async () => {
  const pool = createApiSeamPool([
    [/from firm_members/, { rows: [], rowCount: 0 }],
    [/from firm_collaborators/, { rows: [{ id: 'owner-1', email: 'owner@example.com', user_id: 'user-owner', status: 'active' }], rowCount: 1 }],
    [/from client_assignments/, { rows: [{ client_id: 'target-client' }], rowCount: 1 }],
    [/subscription_status/, { rows: [{ id: 'target-client', firm_id: 'firm-1', subscription_status: null, access_paid_through: null }], rowCount: 1 }]
  ]);
  const response = await requestDonnaApi({ method: 'POST', url: ROUTE, headers: ownerAuth, body: { firm_id: 'firm-1', starts_on: '2026-01-01', ends_on: '2026-12-31' }, pool });
  assert.equal(response.statusCode, 402, response.body);
  assert.deepEqual(response.json, { error: 'This plan is inactive. Start a plan to continue.', code: 'CLIENT_NOT_ENTITLED' });
  assert.equal(pool.matching(/subscription_status/).length, 1);
  assert.equal(pool.matching(/\b(?:insert|update|delete)\b/i).length, 0);
})));
