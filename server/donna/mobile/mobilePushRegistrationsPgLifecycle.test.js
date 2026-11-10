// Phone-app device registrations (migration 170) end to end on real
// PostgreSQL, through the real runtime server and the mobile router
// (appliance harness, as mobileApiPgLifecycle.test.js): an owner who owns
// books in two firms registers a device (one registration, one row per owner
// principal), registers it again (same id, nothing written), hands the device
// to another owner (the old registration ends), removes a registration, and
// loses registrations exactly when the firm removes their access, deletes the
// client, or deletes the collaborator row. Refusals: no token, a staff seat, a
// firm member, a malformed token, someone else's registration id. Every
// response is checked against the pinned contract; no receipt, log line or
// error body carries the device token. All identities, companies and tokens
// are synthetic.
import assert from 'node:assert/strict';
import test from 'node:test';

import { applianceHarnessSkipReason, bootApplianceForTest } from '../testSupport/applianceHarness.js';
import { withFirmDbClient } from '../firmDb.js';
import { provisionEntityReadiness } from '../runtimeReadiness.js';
import { selfProvisionClientWorkspace } from '../selfProvisionDb.js';
import { responseSchemaFor, validateAgainst } from './contractSchema.js';
import { __resetMobileSignInLimiterForTests, MOBILE_API_PATH_PREFIX } from './mobileApi.js';
import { pushTokenSha256 } from './mobilePushRegistrations.js';

const IDP = 'https://idp.push-fixture.invalid';
const IDENTITIES = {
  owner: { id: 'user-push-owner', email: 'owner@push-fixture.example', password: 'owner-pass' },
  neighbour: { id: 'user-push-neighbour', email: 'neighbour@push-fixture.example', password: 'neighbour-pass' },
  seat: { id: 'user-push-seat', email: 'seat@push-fixture.example', password: 'seat-pass' },
  member: { id: 'user-push-member', email: 'member@push-fixture.example', password: 'member-pass' }
};
// Synthetic Expo-shaped tokens (not issued by any push service).
const TOKEN = (label) => `ExponentPushToken[fixture${label.padEnd(16, 'x')}]`;

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
    if (url.pathname === '/auth/v1/logout') {
      live.delete(bearer);
      return new Response(null, { status: 204 });
    }
    return json({ error: 'unexpected' }, 404);
  };
  return { restore: () => { globalThis.fetch = realFetch; } };
};

const conform = (pathTemplate, method, response) => {
  const schema = responseSchemaFor(pathTemplate, method, response.status);
  assert.ok(schema, `${method} ${pathTemplate} → ${response.status} is a contract response: ${response.text.slice(0, 300)}`);
  assert.deepEqual(validateAgainst(response.json, schema), [], `${method} ${pathTemplate} → ${response.status} conforms`);
  return response.json;
};
const conformError = (response, status, code) => {
  assert.equal(response.status, status, response.text);
  assert.deepEqual(validateAgainst(response.json, { $ref: '#/components/schemas/ApiError' }), []);
  if (code) assert.equal(response.json.code, code);
};

test('real PG: device registrations are stored, idempotent, moved, removed, and end with the access they serve', {
  skip: applianceHarnessSkipReason(), timeout: 600_000
}, async (t) => {
  const idp = installIdentityProvider();
  __resetMobileSignInLimiterForTests();
  const appliance = await bootApplianceForTest({
    env: { SUPABASE_URL: IDP, SUPABASE_ANON_KEY: 'fixture-anon', SUPABASE_PUBLISHABLE_KEY: '', DONNA_AUTH_ALLOWED_EMAILS: '', DONNA_MOBILE_API: '' }
  });
  t.after(async () => { await appliance.stop(); idp.restore(); });
  const { firmId } = appliance;
  const logStart = appliance.logs.length;

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
  const clientId = await provision('owner', 'Kestrel Print Studio Ltd');
  const neighbourClientId = await provision('neighbour', 'Harbour Lantern Repairs Ltd');
  delete process.env.DONNA_DEFAULT_FIRM_ID;
  const ownerCollab = (await appliance.query('select id from firm_collaborators where firm_id = $1 and lower(email) = $2',
    [firmId, IDENTITIES.owner.email])).rows[0].id;
  const neighbourCollab = (await appliance.query('select id from firm_collaborators where firm_id = $1 and lower(email) = $2',
    [firmId, IDENTITIES.neighbour.email])).rows[0].id;
  await appliance.query(
    `insert into firm_collaborators (id, firm_id, user_id, email, name, role, status, access_level, seat_role)
     values ('collab-push-seat', $1, $2, $3, 'Fixture seat', 'bookkeeper', 'active', 'client_scoped', 'junior')`,
    [firmId, IDENTITIES.seat.id, IDENTITIES.seat.email]
  );
  await appliance.query(
    `insert into firm_members (id, firm_id, user_id, email, name, role, status, access_level)
     values ('member-push', $1, $2, $3, 'Fixture member', 'member', 'active', 'staff')`,
    [firmId, IDENTITIES.member.id, IDENTITIES.member.email]
  );
  // The same owner identity also owns a business in a second firm: a second,
  // firm-scoped non-seat owner principal with its own current assignment.
  const secondFirmId = `${firmId}-second`;
  const secondClientId = `${secondFirmId}-client-1`;
  const secondCollab = 'collab-push-owner-second';
  await appliance.query(`insert into firms (id, name, slug) values ($1, 'Second Fixture Firm', $1)`, [secondFirmId]);
  await appliance.query(`insert into clients (id, firm_id, company_name) values ($1, $2, 'Alder Tide Joinery Oy')`, [secondClientId, secondFirmId]);
  await appliance.query(
    `insert into firm_collaborators (id, firm_id, user_id, email, name, role, status, access_level)
     values ($1, $2, $3, $4, 'Fixture owner', 'owner', 'active', 'client_scoped')`,
    [secondCollab, secondFirmId, IDENTITIES.owner.id, IDENTITIES.owner.email]
  );
  await appliance.query(
    `insert into client_assignments (id, firm_id, client_id, principal_type, principal_id, assignment_kind, status)
     values ('assign-push-second', $1, $2, 'firm_collaborator', $3, 'capability', 'active')`,
    [secondFirmId, secondClientId, secondCollab]
  );
  t.after(() => appliance.query('delete from firms where id = $1', [secondFirmId]).catch(() => {}));

  const api = ({ method = 'GET', path, token, body, prefix = MOBILE_API_PATH_PREFIX }) => appliance.api.request({
    method, path: `${prefix}${path}`, body, headers: token ? { authorization: `Bearer ${token}` } : {}
  });
  const signIn = async (key) => {
    const response = await api({ method: 'POST', path: '/auth/sessions', body: { email: IDENTITIES[key].email, password: IDENTITIES[key].password } });
    return response;
  };
  const register = (token, body) => api({ method: 'POST', path: '/notifications/registrations', token, body });
  const unregister = (token, id) => api({ method: 'DELETE', path: `/notifications/registrations/${encodeURIComponent(id)}`, token });
  const rows = (sql, params) => appliance.query(sql, params).then((result) => result.rows);
  const regRows = (registrationId) => rows(
    'select firm_id, collaborator_id, platform, locale, token_sha256 from mobile_push_registrations where registration_id = $1 order by firm_id',
    [registrationId]);
  const audits = (action) => rows(
    `select firm_id, actor_type, actor_id, resource_id, metadata from audit_events
      where action = $1 and firm_id = any($2::text[]) order by id`, [action, [firmId, secondFirmId]]);

  const ownerSession = conform('/auth/sessions', 'POST', await signIn('owner'));
  assert.deepEqual(ownerSession.entities.map((entity) => entity.id).sort(), [clientId, secondClientId].sort(), 'owner of books in two firms');
  const owner = ownerSession.access_token;
  const neighbour = conform('/auth/sessions', 'POST', await signIn('neighbour')).access_token;

  // ── Refusals before anything is stored ──────────────────────────────────
  conformError(await register(null, { platform: 'ios', expo_push_token: TOKEN('a') }), 401, 'AUTH_REQUIRED');
  conformError(await unregister(null, 'mpr_00000000-0000-4000-8000-000000000000'), 401, 'AUTH_REQUIRED');
  const seatSignIn = await signIn('seat');
  conformError(seatSignIn, 403, 'MOBILE_OWNER_ONLY');
  conformError(await signIn('member'), 403, 'MOBILE_OWNER_ONLY');
  // A staff identity holding a live provider token is refused on the route itself.
  const staffToken = (await fetch(`${IDP}/auth/v1/token?grant_type=password`, {
    method: 'POST', body: JSON.stringify({ email: IDENTITIES.seat.email, password: IDENTITIES.seat.password })
  }).then((r) => r.json())).access_token;
  conformError(await register(staffToken, { platform: 'ios', expo_push_token: TOKEN('staff') }), 403, 'MOBILE_OWNER_ONLY');
  const memberToken = (await fetch(`${IDP}/auth/v1/token?grant_type=password`, {
    method: 'POST', body: JSON.stringify({ email: IDENTITIES.member.email, password: IDENTITIES.member.password })
  }).then((r) => r.json())).access_token;
  conformError(await register(memberToken, { platform: 'android', expo_push_token: TOKEN('member') }), 403, 'MOBILE_OWNER_ONLY');
  // The shared admin token is never a mobile identity.
  conformError(await register(appliance.accessToken, { platform: 'ios', expo_push_token: TOKEN('admin') }), 401);
  for (const bad of [
    { platform: 'ios', expo_push_token: 'not-a-token-at-all' },
    { platform: 'ios', expo_push_token: 'ExponentPushToken[short]' },
    { platform: 'ios', expo_push_token: `${TOKEN('a')}; drop table` },
    { platform: 'web', expo_push_token: TOKEN('a') },
    { platform: 'ios', expo_push_token: TOKEN('a'), locale: 'sv' },
    { platform: 'ios' }
  ]) {
    const refused = await register(owner, bad);
    conformError(refused, 400, 'REGISTRATION_INVALID');
    if (bad.expo_push_token) assert.ok(!refused.text.includes(bad.expo_push_token), 'the error never echoes the token');
  }
  assert.equal((await rows('select count(*)::int as n from mobile_push_registrations')).at(0).n, 0, 'refusals store nothing');

  // ── Register: one id, one row per owner principal ──────────────────────
  const tokenA = TOKEN('a');
  const first = conform('/notifications/registrations', 'POST', await register(owner, { platform: 'ios', expo_push_token: tokenA, locale: 'fi' }));
  assert.equal((await register(owner, { platform: 'ios', expo_push_token: tokenA, locale: 'fi' })).status, 201);
  assert.match(first.id, /^mpr_/);
  assert.deepEqual((await regRows(first.id)).map((row) => [row.firm_id, row.collaborator_id, row.platform, row.locale]), [
    [firmId, ownerCollab, 'ios', 'fi'], [secondFirmId, secondCollab, 'ios', 'fi']
  ].sort((a, b) => a[0].localeCompare(b[0])));
  let registered = await audits('mobile_push_registration.registered');
  assert.equal(registered.length, 2, 'one receipt per firm, in the registering transaction');
  for (const receipt of registered) {
    assert.equal(receipt.actor_type, 'firm_collaborator');
    assert.equal(receipt.actor_id, receipt.firm_id === firmId ? ownerCollab : secondCollab, 'attributed to the acting owner in that firm');
    assert.equal(receipt.resource_id, first.id);
    assert.equal(receipt.metadata.token_ref, pushTokenSha256(tokenA).slice(0, 12));
    assert.equal(receipt.metadata.created, true);
  }

  // Again, unchanged: the same id and nothing written.
  const again = conform('/notifications/registrations', 'POST', await register(owner, { platform: 'ios', expo_push_token: tokenA, locale: 'fi' }));
  assert.equal(again.id, first.id, 'idempotent on (identity, token)');
  assert.equal((await audits('mobile_push_registration.registered')).length, 2, 'an unchanged registration writes nothing');
  // Again with a new locale: the same id, updated, receipted.
  assert.equal(conform('/notifications/registrations', 'POST', await register(owner, { platform: 'ios', expo_push_token: tokenA, locale: 'en' })).id, first.id);
  assert.deepEqual((await regRows(first.id)).map((row) => row.locale), ['en', 'en']);
  registered = await audits('mobile_push_registration.registered');
  assert.equal(registered.length, 4);
  assert.ok(registered.slice(2).every((receipt) => receipt.metadata.created === false && receipt.metadata.locale === 'en'));

  // ── Someone else's id is 404; malformed ids are 404 ─────────────────────
  conformError(await unregister(neighbour, first.id), 404, 'NOT_FOUND');
  conformError(await unregister(owner, 'mpr_00000000-0000-4000-8000-000000000000'), 404, 'NOT_FOUND');
  conformError(await unregister(owner, 'not-a-registration'), 404, 'NOT_FOUND');
  conformError(await unregister(owner, '%E0%A4%A'), 404, 'NOT_FOUND');
  assert.equal((await regRows(first.id)).length, 2, 'a refused removal removes nothing');

  // ── The device moves to another owner: the old registration ends ───────
  const moved = conform('/notifications/registrations', 'POST', await register(neighbour, { platform: 'ios', expo_push_token: tokenA }));
  assert.notEqual(moved.id, first.id);
  assert.deepEqual(await regRows(first.id), [], 'the old owner keeps nothing');
  assert.deepEqual((await regRows(moved.id)).map((row) => [row.firm_id, row.collaborator_id]), [[firmId, neighbourCollab]]);
  const ended = await audits('mobile_push_registration.ended');
  assert.deepEqual(ended.map((row) => [row.firm_id, row.resource_id, row.metadata.reason]).sort(), [
    [firmId, first.id, 'token_moved_to_another_registration'], [secondFirmId, first.id, 'token_moved_to_another_registration']
  ].sort());
  assert.deepEqual(ended.find((row) => row.firm_id === firmId).actor_id, neighbourCollab, 'same firm: the acting owner');
  assert.deepEqual([ended.find((row) => row.firm_id === secondFirmId).actor_type, ended.find((row) => row.firm_id === secondFirmId).actor_id],
    ['system', 'mobile_push_registration'], 'another firm\'s trail never names this firm\'s principal');
  // The previous owner's stale id is gone for them too.
  conformError(await unregister(owner, first.id), 404, 'NOT_FOUND');

  // ── Removal ─────────────────────────────────────────────────────────────
  const tokenB = TOKEN('b');
  const b = conform('/notifications/registrations', 'POST', await register(owner, { platform: 'android', expo_push_token: tokenB }));
  conformError(await unregister(neighbour, b.id), 404, 'NOT_FOUND');
  const removed = await unregister(owner, b.id);
  assert.equal(removed.status, 204, removed.text);
  assert.equal(removed.text, '');
  assert.deepEqual(await regRows(b.id), []);
  const removedReceipts = await audits('mobile_push_registration.removed');
  assert.deepEqual(removedReceipts.map((row) => [row.firm_id, row.actor_id, row.resource_id]).sort(), [
    [firmId, ownerCollab, b.id], [secondFirmId, secondCollab, b.id]
  ].sort());
  conformError(await unregister(owner, b.id), 404, 'NOT_FOUND');

  // ── The firm removes the owner's access to their client ────────────────
  const memberCall = (method, path, body) => appliance.api.request({
    method, path: `/api/donna/firms${path}`, body, headers: { authorization: `Bearer ${memberToken}` }
  });
  const c = conform('/notifications/registrations', 'POST', await register(owner, { platform: 'ios', expo_push_token: TOKEN('c') }));
  assert.equal((await regRows(c.id)).length, 2);
  const removal = await memberCall('POST', '/owner-access/remove', { firm_id: firmId, client_id: clientId });
  assert.equal(removal.status, 200, removal.text);
  assert.deepEqual((await regRows(c.id)).map((row) => row.firm_id), [secondFirmId],
    'the firm that removed access keeps no registration; the other firm\'s stands');
  const accessRemoved = (await audits('client_owner.access_removed')).at(-1);
  assert.deepEqual(accessRemoved.metadata.push_registrations_ended, [{ registration_id: c.id, collaborator_id: ownerCollab }],
    'the removal writer receipts the registrations it ended');
  // The owner still signs in (second firm) and the registration still answers.
  const stillOwner = conform('/auth/sessions', 'POST', await signIn('owner'));
  assert.deepEqual(stillOwner.entities.map((entity) => entity.id), [secondClientId]);
  assert.equal(conform('/notifications/registrations', 'POST', await register(stillOwner.access_token, { platform: 'ios', expo_push_token: TOKEN('c') })).id, c.id);

  // ── The firm deletes a client: its only owner's registration ends ───────
  assert.deepEqual((await regRows(moved.id)).map((row) => row.collaborator_id), [neighbourCollab]);
  const deleted = await memberCall('DELETE', `/clients/${encodeURIComponent(neighbourClientId)}?firm_id=${encodeURIComponent(firmId)}`);
  assert.equal(deleted.status, 200, deleted.text);
  assert.deepEqual(await regRows(moved.id), [], 'a deleted client\'s owner keeps no registration');
  const clientDelete = (await rows(`select metadata from audit_events where firm_id = $1 and action = 'client.delete' and resource_id = $2`,
    [firmId, neighbourClientId])).at(-1);
  assert.deepEqual(clientDelete.metadata.push_registrations_ended, [{ registration_id: moved.id, collaborator_id: neighbourCollab }]);
  assert.ok((await rows('select 1 from firm_collaborators where id = $1', [neighbourCollab])).length, 'the collaborator row itself outlived the client');

  // ── The collaborator row goes: its registration rows go with it ─────────
  await appliance.query('delete from firm_collaborators where id = $1', [secondCollab]);
  assert.deepEqual(await regRows(c.id), [], 'FK cascade');

  // ── Kill switch ─────────────────────────────────────────────────────────
  process.env.DONNA_MOBILE_API = 'off';
  try {
    conformError(await register(owner, { platform: 'ios', expo_push_token: TOKEN('d') }), 503, 'MOBILE_API_DISABLED');
  } finally {
    process.env.DONNA_MOBILE_API = '';
  }

  // ── The token is in the registration row and nowhere else ──────────────
  for (const token of [tokenA, tokenB, TOKEN('c')]) {
    const leaked = await rows(`select count(*)::int as n from audit_events where firm_id = any($1::text[]) and metadata::text like '%' || $2 || '%'`,
      [[firmId, secondFirmId], token.slice(18, 30)]);
    assert.equal(leaked[0].n, 0, 'no audit row carries the token');
    assert.ok(!appliance.logs.slice(logStart).some((line) => String(line).includes(token)), 'no log line carries the token');
  }
});
