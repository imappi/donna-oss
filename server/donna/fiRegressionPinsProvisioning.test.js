import test from 'node:test';
import assert from 'node:assert/strict';

import { createApiSeamPool, requestDonnaApi } from './testSupport/apiSeamHarness.js';

const setProvisionEnv = () => {
  process.env.DONNA_ACCESS_TOKEN = 'fi-regression-provision-pin';
  process.env.DATABASE_URL = 'postgres://seam.invalid/donna';
  process.env.SUPABASE_URL = 'https://auth.seam.invalid';
  process.env.SUPABASE_ANON_KEY = 'seam-anon';
  process.env.DONNA_AUTH_ALLOWED_EMAILS = 'staff@example.com';
};

await test('FI self-provision preserves its full response, client seed, and empty chart byte-for-byte', async () => {
  setProvisionEnv();
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    assert.equal(url, 'https://auth.seam.invalid/auth/v1/user');
    return { ok: true, json: async () => ({ id: 'user-fi-pin', email: 'fi-pin@example.com' }) };
  };
  try {
    const pool = createApiSeamPool([
      [/insert into clients \(/, ({ params }) => ({ rows: [{ id: params[0], firm_id: params[1] }], rowCount: 1 })],
      [/insert into firm_collaborators/, { rows: [{ id: 'collab-fi-pin' }], rowCount: 1 }]
    ]);
    const response = await requestDonnaApi({
      method: 'POST',
      url: '/api/donna/firms/self-provision',
      headers: { authorization: 'Bearer owner-supabase-jwt', 'content-type': 'application/json' },
      body: {
        company_name: 'Pinned FI Oy', jurisdiction: 'FI', entity_type: 'fi-oy', incorporation_date: '2026-01-02'
      },
      pool
    });
    const clientInsert = pool.matching(/insert into clients \(/);
    const chartInserts = pool.matching(/insert into ledger_accounts/);

    assert.deepEqual(response, {
      statusCode: 201,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ client_id: 'client-self-b67dc412fd3657379d2cf5ec', created: true }),
      json: { client_id: 'client-self-b67dc412fd3657379d2cf5ec', created: true }
    });
    assert.equal(clientInsert.length, 1, 'the client seed query ran');
    assert.deepEqual(clientInsert[0].params.slice(2, 11), [
      'Pinned FI Oy', null, 'fi-oy', '2026-01-02', null, null,
      JSON.stringify({
        id: 'client-self-b67dc412fd3657379d2cf5ec', companyName: 'Pinned FI Oy', email: 'fi-pin@example.com',
        jurisdiction: 'FI', entityType: 'fi-oy', incorporationDate: '2026-01-02', billing_band_id: null,
        services_engaged: ['bank_reconciliation', 'sales_invoicing', 'bills_and_expenses'],
        accounting_system: 'none'
      }),
      ['Pinned FI Oy'], 'FI'
    ]);
    assert.deepEqual(chartInserts, [], 'current FI self-provision chart is intentionally pinned as no seeded accounts');
  } finally {
    globalThis.fetch = realFetch;
  }
});

await test('absent-jurisdiction self-provision preserves its full neutral envelope and empty chart', async () => {
  setProvisionEnv();
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ id: 'user-absent-pin', email: 'absent-pin@example.com' }) });
  try {
    const pool = createApiSeamPool([
      [/insert into clients \(/, ({ params }) => ({ rows: [{ id: params[0], firm_id: params[1] }], rowCount: 1 })],
      [/insert into firm_collaborators/, { rows: [{ id: 'collab-absent-pin' }], rowCount: 1 }]
    ]);
    const response = await requestDonnaApi({
      method: 'POST', url: '/api/donna/firms/self-provision',
      headers: { authorization: 'Bearer owner-supabase-jwt', 'content-type': 'application/json' },
      body: { company_name: 'Pinned Neutral Client' }, pool
    });
    const clientInsert = pool.matching(/insert into clients \(/);
    assert.deepEqual(response, {
      statusCode: 201, headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ client_id: 'client-self-e51f5b185d49c61e3f89c1ba', created: true }),
      json: { client_id: 'client-self-e51f5b185d49c61e3f89c1ba', created: true }
    });
    assert.equal(clientInsert.length, 1, 'the neutral client seed query ran');
    assert.deepEqual(clientInsert[0].params.slice(4, 11), [null, null, null, null,
      JSON.stringify({
        id: 'client-self-e51f5b185d49c61e3f89c1ba', companyName: 'Pinned Neutral Client', email: 'absent-pin@example.com',
        jurisdiction: null, entityType: null, incorporationDate: null, billing_band_id: null,
        services_engaged: ['bank_reconciliation', 'sales_invoicing', 'bills_and_expenses'],
        accounting_system: 'none'
      }), ['Pinned Neutral Client'], null]);
    assert.deepEqual(pool.matching(/insert into ledger_accounts/), []);
  } finally {
    globalThis.fetch = realFetch;
  }
});
