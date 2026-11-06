import test from 'node:test';
import assert from 'node:assert/strict';

import { createApiSeamPool, requestDonnaApi } from './testSupport/apiSeamHarness.js';

const TOKEN = 'gb-coverage-sweep';
const auth = { authorization: `Bearer ${TOKEN}` };

const setFirmEnv = () => {
  process.env.DONNA_ACCESS_TOKEN = TOKEN;
  process.env.DATABASE_URL = 'postgres://seam.invalid/donna';
};

await test('W5 filing-facts capture route runs the profile UPDATE and selects the gb deep-merge branch', async () => {
  setFirmEnv();
  const pool = createApiSeamPool([
    [/select jurisdiction, profile from clients/, { rows: [{ jurisdiction: 'GB', profile: { jurisdiction: 'gb' } }], rowCount: 1 }],
    [/update clients\s+set profile = case/, { rows: [{ id: 'gb-1' }], rowCount: 1 }],
    [/insert into audit_events/, { rows: [{ id: 'audit-1' }], rowCount: 1 }]
  ]);
  const patch = {
    gb: {
      vat_stagger: 2,
      accounting_period_end: '2026-12-31',
      confirmation_review_period_end: '2026-07-31'
    }
  };
  const response = await requestDonnaApi({
    method: 'POST',
    url: '/api/donna/firms/clients/gb-1/profile',
    headers: { ...auth, 'content-type': 'application/json' },
    body: { firm_id: 'donna-demo-firm', profile_patch: patch },
    pool
  });

  assert.equal(response.statusCode, 200, response.body);
  const writes = pool.matching(/update clients\s+set profile = case/);
  assert.equal(writes.length, 1, 'the portal profile write reached updateClientProfileInDb');
  assert.match(writes[0].sql, /jsonb_set\(coalesce\(profile/);
  assert.match(writes[0].sql, /coalesce\(profile->'gb'/);
  assert.deepEqual(JSON.parse(writes[0].params[2]), patch);
  assert.equal(writes[0].params[3], true, 'a gb object takes the deep-merge branch');
  assert.equal(pool.matching(/insert into audit_events/).length, 1, 'the profile mutation audit ran');
});

await test('W5 filing-facts capture route preserves the whole-key gb: null clear contract', async () => {
  setFirmEnv();
  const pool = createApiSeamPool([
    [/update clients\s+set profile = case/, { rows: [{ id: 'gb-1' }], rowCount: 1 }],
    [/insert into audit_events/, { rows: [{ id: 'audit-2' }], rowCount: 1 }]
  ]);
  const response = await requestDonnaApi({
    method: 'POST',
    url: '/api/donna/firms/clients/gb-1/profile',
    headers: { ...auth, 'content-type': 'application/json' },
    body: { firm_id: 'donna-demo-firm', profile_patch: { gb: null } },
    pool
  });

  assert.equal(response.statusCode, 200, response.body);
  const [write] = pool.matching(/update clients\s+set profile = case/);
  assert.ok(write, 'the clear reached the profile UPDATE');
  assert.deepEqual(JSON.parse(write.params[2]), { gb: null });
  assert.equal(write.params[3], false, 'gb: null takes the shallow whole-key clear branch');
  assert.equal(pool.matching(/insert into audit_events/).length, 1, 'the clear audit ran');
});

await test('GB self-provision route mints the default chart through the real seeder', async () => {
  setFirmEnv();
  process.env.SUPABASE_URL = 'https://auth.seam.invalid';
  process.env.SUPABASE_ANON_KEY = 'seam-anon';
  process.env.DONNA_AUTH_ALLOWED_EMAILS = 'staff@example.com';
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    assert.equal(url, 'https://auth.seam.invalid/auth/v1/user');
    return { ok: true, json: async () => ({ id: 'owner-gb', email: 'owner-gb@example.com' }) };
  };
  const pool = createApiSeamPool([
    [/insert into clients \(/, ({ params }) => ({ rows: [{ id: params[0], firm_id: params[1] }], rowCount: 1 })],
    [/insert into firm_collaborators/, { rows: [{ id: 'owner-collaborator' }], rowCount: 1 }]
  ]);
  try {
    const response = await requestDonnaApi({
      method: 'POST',
      url: '/api/donna/firms/self-provision',
      headers: { authorization: 'Bearer owner-jwt', 'content-type': 'application/json' },
      body: { company_name: 'Coverage Ltd', jurisdiction: 'GB', entity_type: 'ltd' },
      pool
    });
    assert.equal(response.statusCode, 201, response.body);
    assert.equal(pool.matching(/select 1 from ledger_accounts/).length, 1, 'seedGbDefaultChartIfEmpty checked for an existing chart');
    assert.equal(pool.matching(/insert into ledger_accounts/).length, 24, 'the GB default chart seeder inserted its current pack');
    assert.ok(pool.matching(/insert into ledger_accounts/).some(({ params }) => params[7] === 'liability.sales_tax_payable'));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

await test('GB VAT route pins the current named missing-period verdict for an unregistered client', async () => {
  setFirmEnv();
  const pool = createApiSeamPool([
    [/select jurisdiction from clients/, { rows: [{ jurisdiction: 'GB', profile: { vat_registration: { status: 'not_registered' } } }], rowCount: 1 }],
    [/select profile from clients/, { rows: [{ profile: { vat_registration: { status: 'not_registered' } } }], rowCount: 1 }],
    [/from vat_periods/, { rows: [], rowCount: 0 }]
  ]);
  const response = await requestDonnaApi({
    url: '/api/donna/firms/reports/gb-vat-return?firm_id=donna-demo-firm&client_id=gb-unregistered&period=missing',
    headers: auth,
    pool
  });

  assert.equal(response.statusCode, 422, response.body);
  // The period refusal outranks the registration verdict: registration is
  // resolved at the period's boundary dates, so without a period there is
  // nothing to resolve against.
  assert.equal(response.json.code, 'GB_VAT_PERIOD_NOT_ESTABLISHED');
  assert.equal(pool.matching(/select jurisdiction from clients/).length, 1, 'the jurisdiction gate ran');
  assert.equal(pool.matching(/from vat_periods/).length, 1, 'the persisted-period read ran');
  assert.equal(pool.matching(/from ledger_lines ll/).length, 0, 'the refusal stopped before ledger aggregation');
});

await test('owner portal-link lane returns the full bound binding-state envelope', async () => {
  setFirmEnv();
  const pool = createApiSeamPool([
    [/from client_whatsapp_bindings/, { rows: [{ id: 'binding-1', phone_e164: '+447700900123', created_at: '2026-08-01T10:00:00.000Z' }], rowCount: 1 }],
    [/from client_capability_config/, { rows: [{ flag_key: 'OWNER_PORTAL_LINK', stage: 'canary', source: 'test', client_id: 'gb-1' }], rowCount: 1 }]
  ]);
  const response = await requestDonnaApi({
    url: '/api/donna/firms/whatsapp/binding-state?firm_id=donna-demo-firm&client_id=gb-1', headers: auth, pool
  });

  assert.equal(response.statusCode, 200, response.body);
  assert.deepEqual(response.json, {
    channel_acts: false,
    binding: { id: 'binding-1', created_at: '2026-08-01T10:00:00.000Z', masked_phone: '••••0123' }
  });
  assert.equal(pool.matching(/from client_whatsapp_bindings/).length, 1, 'the binding read ran');
  assert.equal(pool.matching(/from client_capability_config/).length, 1, 'the config-plane read ran');
});

await test('owner portal-link lane returns the full unbound binding-state envelope', async () => {
  setFirmEnv();
  const pool = createApiSeamPool();
  const response = await requestDonnaApi({
    url: '/api/donna/firms/whatsapp/binding-state?firm_id=donna-demo-firm&client_id=gb-unbound', headers: auth, pool
  });

  assert.equal(response.statusCode, 200, response.body);
  assert.deepEqual(response.json, { channel_acts: false, binding: null });
  assert.equal(pool.matching(/from client_whatsapp_bindings/).length, 1, 'the empty binding read ran');
  assert.equal(pool.matching(/from client_capability_config/).length, 1, 'the dark config-plane read ran');
});
