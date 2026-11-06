import test from 'node:test';
import assert from 'node:assert/strict';

import { createApiSeamPool, requestDonnaApi } from './testSupport/apiSeamHarness.js';

const saved = Object.fromEntries(['DONNA_ACCESS_TOKEN', 'DATABASE_URL', 'SUPABASE_URL', 'SUPABASE_ANON_KEY', 'DONNA_AUTH_ALLOWED_EMAILS'].map((key) => [key, process.env[key]]));
process.env.DONNA_ACCESS_TOKEN = 'shared-token';
process.env.DATABASE_URL = 'postgres://seam.invalid/donna';
process.env.SUPABASE_URL = 'https://auth.seam.invalid';
process.env.SUPABASE_ANON_KEY = 'seam-anon';
process.env.DONNA_AUTH_ALLOWED_EMAILS = 'staff@example.com';
const realFetch = globalThis.fetch;

const provision = async ({ email, body }) => {
  process.env.DONNA_ACCESS_TOKEN = 'shared-token';
  process.env.DATABASE_URL = 'postgres://seam.invalid/donna';
  process.env.SUPABASE_URL = 'https://auth.seam.invalid';
  process.env.SUPABASE_ANON_KEY = 'seam-anon';
  process.env.DONNA_AUTH_ALLOWED_EMAILS = 'staff@example.com';
  globalThis.fetch = async (url) => {
    assert.equal(url, 'https://auth.seam.invalid/auth/v1/user');
    return { ok: true, json: async () => ({ id: `user-${email}`, email }) };
  };
  const pool = createApiSeamPool([
    [/insert into clients \(/, ({ params }) => ({ rows: [{ id: params[0], firm_id: params[1] }], rowCount: 1 })],
    [/insert into firm_collaborators/, { rows: [{ id: `collab-${email}` }], rowCount: 1 }]
  ]);
  const response = await requestDonnaApi({
    method: 'POST', url: '/api/donna/firms/self-provision',
    headers: { authorization: 'Bearer owner-supabase-jwt', 'content-type': 'application/json' },
    body: { company_name: 'Route Seam Ltd', ...body }, pool
  });
  return { response, pool };
};

const clientInsert = (pool) => pool.matching(/insert into clients \(/)[0];
const chartInserts = (pool) => pool.matching(/insert into ledger_accounts/);

await test('self-provision route canonicalizes a GB Ltd and seeds the GB role chart transactionally', async () => {
  const { response, pool } = await provision({
    email: 'ltd@example.com',
    body: { jurisdiction: 'GB', entity_type: 'ltd', incorporation_date: '2026-07-01' }
  });
  assert.equal(response.statusCode, 201, response.body);
  assert.equal(response.json.created, true);
  const insert = clientInsert(pool);
  assert.ok(insert, 'the real client INSERT ran');
  assert.equal(insert.params[4], 'gb-ltd');
  assert.equal(insert.params[5], '2026-07-01');
  // §5b(a): born 'none', never NULL — a NULL accounting_system falls through to
  // the Xero builder on the posting path and the portal reports all zeros.
  assert.equal(JSON.parse(insert.params[8]).accounting_system, 'none');
  const chart = chartInserts(pool);
  assert.equal(chart.length, 24);
  assert.ok(chart.some(({ params }) => params[3] === '2220' && params[7] === 'liability.sales_tax_payable'));
  assert.ok(pool.matching(/^begin$/).length >= 3, 'create, chart seed, and owner bind used checked-out transactions');
});

await test('self-provision route gives a GB sole trader owner capital at 2000', async () => {
  const { response, pool } = await provision({
    email: 'sole@example.com',
    body: { jurisdiction: 'GB', entity_type: 'sole_trader' }
  });
  assert.equal(response.statusCode, 201, response.body);
  assert.equal(clientInsert(pool).params[4], 'gb-sole-trader');
  const capital = chartInserts(pool).find(({ params }) => params[3] === '2000');
  assert.ok(capital);
  assert.equal(capital.params[7], 'equity.owner_capital');
  assert.notEqual(capital.params[7], 'equity.retained_earnings');
});

await test('self-provision route leaves the FI insert set unchanged and seeds no GB chart', async () => {
  const { response, pool } = await provision({
    email: 'fi@example.com',
    body: { jurisdiction: 'FI', entity_type: 'fi-oy', incorporation_date: '2026-01-02' }
  });
  assert.equal(response.statusCode, 201, response.body);
  const insert = clientInsert(pool);
  assert.deepEqual(insert.params.slice(2, 8), [
    'Route Seam Ltd', null, 'fi-oy', '2026-01-02', null, null
  ]);
  assert.equal(insert.params[10], 'FI');
  assert.equal(chartInserts(pool).length, 0);
});

await test('self-provision route refuses a declared out-of-scope jurisdiction by name, before any write', async () => {
  const { response, pool } = await provision({
    email: 'us@example.com',
    body: { jurisdiction: 'US' }
  });
  assert.equal(response.statusCode, 409, response.body);
  assert.equal(response.json.code, 'PROVISION_JURISDICTION_UNSUPPORTED');
  assert.ok(response.json.error, 'the refusal carries a human-readable message');
  assert.equal(clientInsert(pool), undefined, 'no client row was written');
});

test.after(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  globalThis.fetch = realFetch;
});
