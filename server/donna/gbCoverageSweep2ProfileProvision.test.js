import test from 'node:test';
import assert from 'node:assert/strict';

import { createApiSeamPool, requestDonnaApi } from './testSupport/apiSeamHarness.js';

const TOKEN = 'gb-coverage-sweep-2-profile';
const auth = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' };
const setEnv = () => {
  process.env.DONNA_ACCESS_TOKEN = TOKEN;
  process.env.DATABASE_URL = 'postgres://seam.invalid/donna';
  delete process.env.STRIPE_SECRET_KEY;
};

const profilePost = async ({ profilePatch, jurisdiction = 'GB' }) => {
  setEnv();
  const pool = createApiSeamPool([
    [/update clients\s+set profile/, { rows: [{ id: 'client-1' }], rowCount: 1 }],
    [/select jurisdiction, profile from clients/, { rows: [{ jurisdiction, profile: {} }], rowCount: 1 }]
  ]);
  const response = await requestDonnaApi({
    method: 'POST', url: '/api/donna/firms/clients/client-1/profile', headers: auth,
    body: { profile_patch: profilePatch }, pool
  });
  return { response, pool };
};

for (const [label, profilePatch, code] of [
  ['bad stagger', { gb: { vat_stagger: 4 } }, 'GB_VAT_STAGGER_INVALID'],
  ['malformed accounting period end', { gb: { accounting_period_end: '2026-02-30' } }, 'GB_FILING_DATE_INVALID'],
  ['malformed confirmation review end', { gb: { confirmation_review_period_end: '31/07/2026' } }, 'GB_FILING_DATE_INVALID']
]) {
  await test(`coverage sweep: profile write rejects ${label} with its current 400`, async () => {
    const { response, pool } = await profilePost({ profilePatch });
    assert.equal(response.statusCode, 400, response.body);
    assert.match(response.json.error, new RegExp(code));
    assert.equal(pool.matching(/update clients\s+set profile/).length, 0, 'validation must precede the write');
  });
}

await test('F-8C-NON-GB-PROFILE: country registry refuses GB filing facts for an FI client', async () => {
  const { response, pool } = await profilePost({ profilePatch: { gb: { vat_stagger: 2 } }, jurisdiction: 'FI' });
  assert.equal(response.statusCode, 400, response.body);
  assert.equal(response.json.code, 'profile_field_unsupported');
  assert.equal(pool.matching(/update clients\s+set profile/).length, 0);
  assert.equal(pool.matching(/insert into audit_events/).length, 0);
});

const provision = async ({ email, jurisdiction, entityType }) => {
  setEnv();
  process.env.SUPABASE_URL = 'https://auth.seam.invalid';
  process.env.SUPABASE_ANON_KEY = 'anon';
  process.env.DONNA_AUTH_ALLOWED_EMAILS = 'staff@example.com';
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ id: `user-${email}`, email }) });
  const pool = createApiSeamPool([
    [/insert into clients \(/, ({ params }) => ({ rows: [{ id: params[0], firm_id: params[1] }], rowCount: 1 })],
    [/insert into firm_collaborators/, { rows: [{ id: `collab-${email}` }], rowCount: 1 }]
  ]);
  const response = await requestDonnaApi({
    method: 'POST', url: '/api/donna/firms/self-provision',
    headers: { authorization: 'Bearer owner-jwt', 'content-type': 'application/json' },
    body: { company_name: 'Coverage Co', jurisdiction, entity_type: entityType }, pool
  });
  return { response, pool };
};

await test('coverage sweep: FI entity vocabulary is normalized, preserved, and receives no GB chart seed', async () => {
  const { response, pool } = await provision({ email: 'fi@example.com', jurisdiction: 'FI', entityType: 'Fi_Toiminimi' });
  assert.equal(response.statusCode, 201, response.body);
  assert.equal(pool.matching(/insert into clients \(/)[0].params[4], 'fi-toiminimi');
  assert.equal(pool.matching(/insert into ledger_accounts/).length, 0);
});

// Was "a non-GB entity is normalized but receives no GB chart seed" — written
// before the provision gate enforced the launch scope. SG is out of the
// self-serve set, so the honest pin is now the named refusal before any write;
// the non-GB normalization pin lives on the FI case above.
await test('coverage sweep: an out-of-scope jurisdiction refuses by name at the provision gate', async () => {
  const { response, pool } = await provision({ email: 'sg@example.com', jurisdiction: 'SG', entityType: 'Private_Limited' });
  assert.equal(response.statusCode, 409, response.body);
  assert.equal(response.json.code, 'PROVISION_JURISDICTION_UNSUPPORTED');
  assert.equal(pool.matching(/insert into clients \(/).length, 0);
});
