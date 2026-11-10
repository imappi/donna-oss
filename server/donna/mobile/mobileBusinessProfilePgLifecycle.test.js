// PUT /entities/{entityId}/onboarding/profile end to end on real PostgreSQL,
// through the real runtime server and the mobile router (appliance harness):
// an owner confirms their business facts, the facts land in their one home
// with the audit receipt in the same transaction (previous and new value,
// attributed to the owner), /me and refresh serve Entity.business_profile, a
// repeat is a receipted no-op, and a changed business name is refused without
// touching what invoices read. Refusals: no token, a staff identity, another
// business's entity, a missing confirmation. Every response is checked
// against the pinned contract. All identities and companies are synthetic.
import assert from 'node:assert/strict';
import test from 'node:test';

import { applianceHarnessSkipReason, bootApplianceForTest } from '../testSupport/applianceHarness.js';
import { withFirmDbClient } from '../firmDb.js';
import { sellerContextFromClientRow } from '../finland/invoiceIssuance.js';
import { provisionEntityReadiness } from '../runtimeReadiness.js';
import { selfProvisionClientWorkspace } from '../selfProvisionDb.js';
import { responseSchemaFor, validateAgainst } from './contractSchema.js';
import { __resetMobileSignInLimiterForTests, MOBILE_API_PATH_PREFIX } from './mobileApi.js';

const IDP = 'https://idp.profile-fixture.invalid';
const IDENTITIES = {
  owner: { id: 'user-profile-owner', email: 'owner@profile-fixture.example', password: 'owner-pass' },
  neighbour: { id: 'user-profile-neighbour', email: 'neighbour@profile-fixture.example', password: 'neighbour-pass' },
  seat: { id: 'user-profile-seat', email: 'seat@profile-fixture.example', password: 'seat-pass' },
  member: { id: 'user-profile-member', email: 'member@profile-fixture.example', password: 'member-pass' }
};

// The identity provider at the wire (same shape as mobileApiPgLifecycle's),
// plus a direct mint so a staff identity can hold a live token.
const installIdentityProvider = () => {
  const realFetch = globalThis.fetch;
  const live = new Map();
  let seq = 0;
  const mint = (key) => {
    seq += 1;
    const access = `access-${key}-${seq}`;
    live.set(access, key);
    return { access_token: access, refresh_token: `refresh-${key}-${seq}`, expires_in: 3600, token_type: 'bearer' };
  };
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    if (url.origin !== IDP) return realFetch(input, init);
    const bearer = String(init.headers?.Authorization || '').replace(/^Bearer\s+/i, '');
    if (url.pathname === '/auth/v1/user') {
      const key = live.get(bearer);
      return key ? json({ id: IDENTITIES[key].id, email: IDENTITIES[key].email }) : json({ msg: 'invalid JWT' }, 401);
    }
    if (url.pathname === '/auth/v1/token' && url.searchParams.get('grant_type') === 'password') {
      const body = JSON.parse(init.body);
      const key = Object.keys(IDENTITIES).find((name) => IDENTITIES[name].email === body.email && IDENTITIES[name].password === body.password);
      return key ? json(mint(key)) : json({ error: 'invalid_grant' }, 400);
    }
    if (url.pathname === '/auth/v1/token' && url.searchParams.get('grant_type') === 'refresh_token') {
      const body = JSON.parse(init.body);
      const key = Object.keys(IDENTITIES).find((name) => String(body.refresh_token).startsWith(`refresh-${name}-`));
      return key ? json(mint(key)) : json({ error: 'invalid_grant' }, 400);
    }
    if (url.pathname === '/auth/v1/logout') {
      live.delete(bearer);
      return new Response(null, { status: 204 });
    }
    return json({ error: 'unexpected' }, 404);
  };
  return { mint, restore: () => { globalThis.fetch = realFetch; } };
};

const PUT_PATH = '/entities/{entityId}/onboarding/profile';
const conform = (pathTemplate, method, response) => {
  const schema = responseSchemaFor(pathTemplate, method, response.status);
  assert.ok(schema, `${method} ${pathTemplate} → ${response.status} is a contract response: ${response.text.slice(0, 300)}`);
  assert.deepEqual(validateAgainst(response.json, schema), [], `${method} ${pathTemplate} → ${response.status} conforms`);
  return response.json;
};
const conformError = (response, status, code) => {
  assert.equal(response.status, status, response.text);
  assert.ok(responseSchemaFor(PUT_PATH, 'PUT', status) || status >= 500 || status === 403, `${status} is declared or a shared refusal`);
  assert.deepEqual(validateAgainst(response.json, { $ref: '#/components/schemas/ApiError' }), []);
  if (code) assert.equal(response.json.code, code);
};

test('real PG: an owner confirms their business facts through the mobile adapter', {
  skip: applianceHarnessSkipReason(), timeout: 600_000
}, async (t) => {
  const idp = installIdentityProvider();
  __resetMobileSignInLimiterForTests();
  const appliance = await bootApplianceForTest({
    env: { SUPABASE_URL: IDP, SUPABASE_ANON_KEY: 'fixture-anon', SUPABASE_PUBLISHABLE_KEY: '', DONNA_AUTH_ALLOWED_EMAILS: '', DONNA_MOBILE_API: '' }
  });
  t.after(async () => { await appliance.stop(); idp.restore(); });
  const { firmId } = appliance;
  process.env.DONNA_DEFAULT_FIRM_ID = firmId;
  const provision = async (key, companyName) => {
    const result = await selfProvisionClientWorkspace({ auth: { userId: IDENTITIES[key].id, email: IDENTITIES[key].email },
      companyName, jurisdiction: 'GB', entityType: 'gb-ltd' });
    assert.ok(result.clientId, JSON.stringify(result));
    await provisionEntityReadiness({ withFirmDbClientFn: withFirmDbClient, firmId, clientId: result.clientId,
      creationPath: 'self_provision', lifecycle: 'cold_create', compatibilityScope: 'birth_residue_proof',
      initiatingPrincipal: { actor_type: 'supabase_user', actor_id: IDENTITIES[key].id },
      authorityBasis: { source: 'authenticated_self_provision_route', principal_id: IDENTITIES[key].id } });
    return result.clientId;
  };
  const clientId = await provision('owner', 'Fixture Tiling Ltd');
  const neighbourClientId = await provision('neighbour', 'Fixture Lantern Repairs Ltd');
  delete process.env.DONNA_DEFAULT_FIRM_ID;
  await appliance.query("update firm_collaborators set name = 'Fixture Owner' where firm_id = $1 and lower(email) = $2", [firmId, IDENTITIES.owner.email]);
  await appliance.query(
    `insert into firm_collaborators (id, firm_id, user_id, email, name, role, status, access_level, seat_role)
     values ('collab-profile-seat', $1, $2, $3, 'Fixture seat', 'bookkeeper', 'active', 'client_scoped', 'junior')`,
    [firmId, IDENTITIES.seat.id, IDENTITIES.seat.email]
  );
  await appliance.query(
    `insert into firm_members (id, firm_id, user_id, email, name, role, status, access_level)
     values ('member-profile', $1, $2, $3, 'Fixture member', 'member', 'active', 'staff')`,
    [firmId, IDENTITIES.member.id, IDENTITIES.member.email]
  );

  const api = ({ method = 'GET', path, token, body }) => appliance.api.request({
    method, path: `${MOBILE_API_PATH_PREFIX}${path}`, body, headers: token ? { authorization: `Bearer ${token}` } : {}
  });
  const session = conform('/auth/sessions', 'POST', await api({ method: 'POST', path: '/auth/sessions',
    body: { email: IDENTITIES.owner.email, password: IDENTITIES.owner.password } }));
  const token = session.access_token;
  const [entity] = session.entities;
  assert.equal(entity.id, clientId);
  assert.equal(entity.business_profile, null, 'nothing declared yet: null, not an invented profile');
  const ownerPrincipalId = session.principal.id;

  // What the phone's Business page sends: what is on screen + the confirmation.
  const body = (overrides = {}) => ({
    owner_name: session.principal.display_name,
    business_name: entity.display_name,
    description: '',
    operating_area: '',
    people_involved: [],
    payment_methods: [],
    spending_categories: [],
    confirmed_exact_fields: ['owner_name', 'business_name'],
    ...overrides
  });
  const put = (payload, entityId = clientId, bearer = token) =>
    api({ method: 'PUT', path: `/entities/${encodeURIComponent(entityId)}/onboarding/profile`, token: bearer, body: payload });
  const auditCount = async () => (await appliance.query(
    "select count(*)::int n from audit_events where firm_id = $1 and action in ('client.business_profile.declared', 'owner.name.declared')", [firmId]
  )).rows[0].n;
  const invoiceSellerName = async (id) => sellerContextFromClientRow((await appliance.query(
    'select company_name, profile from clients where firm_id = $1 and id = $2', [firmId, id])).rows[0]).name;

  // ── Refusals ────────────────────────────────────────────────────────────
  await t.test('no token is 401', async () => {
    conformError(await put(body(), clientId, ''), 401, 'AUTH_REQUIRED');
    conformError(await put(body(), clientId, appliance.accessToken), 401, 'AUTH_REQUIRED');
  });
  await t.test('a staff identity with a live token is refused', async () => {
    for (const key of ['seat', 'member']) conformError(await put(body(), clientId, idp.mint(key).access_token), 403, 'MOBILE_OWNER_ONLY');
  });
  await t.test('another business’s entity is not found', async () => {
    conformError(await put(body({ business_name: 'Fixture Lantern Repairs Ltd' }), neighbourClientId), 404, 'NOT_FOUND');
    conformError(await put(body(), 'no-such-client'), 404, 'NOT_FOUND');
  });
  await t.test('the contract’s request rules are enforced on the server', async () => {
    conformError(await put(body({ confirmed_exact_fields: ['owner_name'] })), 400, 'PROFILE_EXACT_CONFIRMATION_REQUIRED');
    conformError(await put(body({ owner_name: '' })), 400, 'PROFILE_INVALID');
    conformError(await put(body({ description: 'x'.repeat(601) })), 400, 'PROFILE_INVALID');
    const partial = body();
    delete partial.people_involved;
    conformError(await put(partial), 400, 'PROFILE_INVALID');
  });
  assert.equal(await auditCount(), 0, 'no refusal wrote anything');
  assert.equal((await appliance.query('select count(*)::int n from client_business_profiles')).rows[0].n, 0);

  // ── A first confirmation stating no fact declares no profile ────────────
  const nameOnly = conform(PUT_PATH, 'PUT', await put(body({ owner_name: 'Fixture Owner-First' })));
  assert.deepEqual(nameOnly.receipt.changes.map((change) => change.applied), [true, false]);
  assert.equal(nameOnly.entity.business_profile, null, 'empty on-screen values are not a declaration');
  assert.equal((await appliance.query('select count(*)::int n from client_business_profiles')).rows[0].n, 0);
  conform(PUT_PATH, 'PUT', await put(body({ owner_name: 'Fixture Owner' })));

  // ── The owner confirms ──────────────────────────────────────────────────
  const facts = {
    description: 'Bathroom and kitchen tiling for homes.',
    operating_area: 'Fixture county',
    profession: 'Tiler',
    billing_basis: 'Hourly, 40 GBP per hour plus materials',
    business_address: '1 Fixture Lane',
    people_involved: ['A helper on large jobs'],
    payment_methods: ['Bank transfer', 'Card'],
    spending_categories: ['Tools', 'Van']
  };
  const clientRowBefore = (await appliance.query('select company_name, profile from clients where id = $1', [clientId])).rows[0];
  const saved = conform(PUT_PATH, 'PUT', await put(body({ ...facts, owner_name: 'Fixture Owner-Renamed', experience: '' })));
  assert.equal(saved.principal.display_name, 'Fixture Owner-Renamed');
  assert.equal(saved.principal.id, ownerPrincipalId);
  assert.equal(saved.entity.display_name, 'Fixture Tiling Ltd', 'the business name is untouched');
  assert.deepEqual(saved.entity.business_profile, facts, 'exactly the stated facts; the empty experience is absent');
  assert.deepEqual(saved.receipt.changes.map((change) => change.applied), [true, true]);
  assert.equal(saved.receipt.audit_event_ids.length, 2);
  assert.deepEqual(saved.receipt.actor, { type: 'owner', terminal: 'mobile' });

  // The receipt rows are the writer's own, attributed to the owner, with the
  // previous value so the change can be reversed.
  const receipts = (await appliance.query(
    `select id::text id, client_id, actor_type, actor_id, action, resource_type, resource_id, metadata
       from audit_events where id = any($1::bigint[]) order by id`, [saved.receipt.audit_event_ids]
  )).rows;
  assert.deepEqual(receipts.map((row) => [row.action, row.actor_type, row.actor_id, row.client_id]), [
    ['owner.name.declared', 'firm_collaborator', ownerPrincipalId, clientId],
    ['client.business_profile.declared', 'firm_collaborator', ownerPrincipalId, clientId]
  ]);
  assert.deepEqual(receipts[0].metadata.previous, { name: 'Fixture Owner' });
  assert.deepEqual(receipts[0].metadata.next, { name: 'Fixture Owner-Renamed' });
  assert.equal(receipts[1].metadata.previous, null);
  assert.deepEqual(receipts[1].metadata.next, facts);
  assert.equal(receipts[1].metadata.terminal, 'mobile');
  assert.deepEqual(receipts[1].metadata.confirmed_exact_fields, ['owner_name', 'business_name']);
  const row = (await appliance.query('select facts, revision, declared_by_type, declared_by_id from client_business_profiles where firm_id = $1 and client_id = $2', [firmId, clientId])).rows[0];
  assert.deepEqual(row.facts, facts);
  assert.equal(row.revision, 1);
  assert.deepEqual([row.declared_by_type, row.declared_by_id], ['firm_collaborator', ownerPrincipalId]);
  assert.equal((await appliance.query('select name from firm_collaborators where id = $1', [ownerPrincipalId])).rows[0].name, 'Fixture Owner-Renamed');
  // Nothing outside the declared homes moved: the client row's name and
  // profile (what invoices, archives and prompts read) are as they were.
  const clientRow = (await appliance.query('select company_name, profile from clients where id = $1', [clientId])).rows[0];
  assert.deepEqual(clientRow, clientRowBefore, 'clients.company_name and clients.profile are untouched');
  assert.equal(clientRow.company_name, 'Fixture Tiling Ltd');
  assert.equal(await invoiceSellerName(clientId), 'Fixture Tiling Ltd');

  // ── The session responses serve it ──────────────────────────────────────
  const me = conform('/me', 'GET', await api({ path: '/me', token }));
  assert.deepEqual(me.entities[0].business_profile, facts);
  assert.equal(me.principal.display_name, 'Fixture Owner-Renamed');
  const refreshed = conform('/auth/sessions/refresh', 'POST', await api({ method: 'POST', path: '/auth/sessions/refresh', body: { refresh_token: session.refresh_token } }));
  assert.deepEqual(refreshed.entities[0].business_profile, facts);
  const neighbourSession = conform('/auth/sessions', 'POST', await api({ method: 'POST', path: '/auth/sessions',
    body: { email: IDENTITIES.neighbour.email, password: IDENTITIES.neighbour.password } }));
  assert.equal(neighbourSession.entities[0].business_profile, null, 'one owner’s facts never reach another business');

  // ── A repeat is a receipted no-op; an edit is a new revision ────────────
  const before = await auditCount();
  const again = conform(PUT_PATH, 'PUT', await put(body({ ...facts, owner_name: 'Fixture Owner-Renamed' })));
  assert.deepEqual(again.receipt.changes.map((change) => change.applied), [false, false]);
  assert.deepEqual(again.receipt.audit_event_ids, []);
  assert.equal(await auditCount(), before);
  const edited = conform(PUT_PATH, 'PUT', await put(body({ ...facts, owner_name: 'Fixture Owner-Renamed', operating_area: 'Fixture county and the coast' })));
  assert.deepEqual(edited.receipt.changes.map((change) => change.applied), [false, true]);
  assert.equal(edited.entity.business_profile.operating_area, 'Fixture county and the coast');
  const editReceipt = (await appliance.query('select metadata from audit_events where id = $1', [edited.receipt.audit_event_ids[0]])).rows[0].metadata;
  assert.deepEqual(editReceipt.previous, facts, 'the previous facts ride the receipt');
  assert.equal(editReceipt.revision, 2);

  // ── Overlapping saves serialize: both answer, the last one wins ─────────
  const racing = await Promise.all(['Fixture county', 'Fixture county and the coast'].map((area) =>
    put(body({ ...facts, owner_name: 'Fixture Owner-Renamed', operating_area: area }))));
  for (const response of racing) conform(PUT_PATH, 'PUT', response);
  const settled = (await appliance.query('select facts, revision from client_business_profiles where client_id = $1', [clientId])).rows[0];
  assert.ok(['Fixture county', 'Fixture county and the coast'].includes(settled.facts.operating_area));
  assert.equal(settled.revision, 2 + racing.filter((response) => response.json.receipt.changes[1].applied).length);

  // ── A business-name change is refused; nothing is saved ─────────────────
  const beforeRename = await auditCount();
  conformError(await put(body({ ...facts, owner_name: 'Someone Else', business_name: 'Fixture Trading Name' })), 400, 'BUSINESS_NAME_CHANGE_NOT_AVAILABLE');
  assert.equal(await auditCount(), beforeRename);
  assert.equal((await appliance.query('select company_name from clients where id = $1', [clientId])).rows[0].company_name, 'Fixture Tiling Ltd');
  assert.equal((await appliance.query('select name from firm_collaborators where id = $1', [ownerPrincipalId])).rows[0].name, 'Fixture Owner-Renamed',
    'the refusal is atomic: the owner name in the same request is not saved either');
  assert.equal(await invoiceSellerName(clientId), 'Fixture Tiling Ltd');

  // ── One owner, books in two firms, a different name in each ────────────
  // The contract has one principal name. /me shows the name on the
  // collaborator row the owner most recently declared a name on, in whichever
  // firm; each firm keeps its own row. The second firm sorts after the first.
  const secondFirmId = 'zz-mobile-second-firm';
  await appliance.query("insert into firms (id, name, slug) values ($1, 'Synthetic second firm', $1)", [secondFirmId]);
  process.env.DONNA_DEFAULT_FIRM_ID = secondFirmId;
  const secondClient = await selfProvisionClientWorkspace({ auth: { userId: IDENTITIES.owner.id, email: IDENTITIES.owner.email },
    companyName: 'Fixture Glazing Ltd', jurisdiction: 'GB', entityType: 'gb-ltd' });
  delete process.env.DONNA_DEFAULT_FIRM_ID;
  assert.ok(secondClient.clientId, JSON.stringify(secondClient));
  await provisionEntityReadiness({ withFirmDbClientFn: withFirmDbClient, firmId: secondFirmId, clientId: secondClient.clientId,
    creationPath: 'self_provision', lifecycle: 'cold_create', compatibilityScope: 'birth_residue_proof',
    initiatingPrincipal: { actor_type: 'supabase_user', actor_id: IDENTITIES.owner.id },
    authorityBasis: { source: 'authenticated_self_provision_route', principal_id: IDENTITIES.owner.id } });
  const twoFirms = conform('/me', 'GET', await api({ path: '/me', token }));
  assert.deepEqual(twoFirms.entities.map((row) => row.id).sort(), [clientId, secondClient.clientId].sort());
  assert.equal(twoFirms.principal.display_name, 'Fixture Owner-Renamed', 'the name last declared, in the first firm');
  const secondEntity = twoFirms.entities.find((row) => row.id === secondClient.clientId);
  const secondPut = (overrides) => api({ method: 'PUT', path: `/entities/${secondClient.clientId}/onboarding/profile`, token,
    body: body({ business_name: secondEntity.display_name, ...overrides }) });
  const secondSaved = conform(PUT_PATH, 'PUT', await secondPut({ owner_name: 'Fixture Owner-Second' }));
  assert.equal(secondSaved.principal.display_name, 'Fixture Owner-Second');
  const afterSecond = conform('/me', 'GET', await api({ path: '/me', token }));
  assert.equal(afterSecond.principal.display_name, 'Fixture Owner-Second', 'a name edited in the second firm shows');
  assert.equal((await appliance.query('select name from firm_collaborators where id = $1', [ownerPrincipalId])).rows[0].name, 'Fixture Owner-Renamed',
    'the first firm’s row is not rewritten');
  conform(PUT_PATH, 'PUT', await put(body({ ...facts, owner_name: 'Fixture Owner-Again' })));
  assert.equal(conform('/me', 'GET', await api({ path: '/me', token })).principal.display_name, 'Fixture Owner-Again',
    'the latest declaration wins, whichever firm it was made in');

  // The kill switch still covers this endpoint.
  process.env.DONNA_MOBILE_API = 'off';
  try {
    conformError(await put(body()), 503, 'MOBILE_API_DISABLED');
  } finally {
    delete process.env.DONNA_MOBILE_API;
  }
});
