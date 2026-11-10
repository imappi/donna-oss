// POST /me/deletion-request end to end on real PostgreSQL, through the real
// runtime server and the mobile router (appliance harness), the way
// mobileApiPgLifecycle.test.js drives the adapter. Two owners exactly as
// self-signup creates them (one English, one Finnish book), a staff seat and a
// firm member in the same firm. Proves: the refusals (no token, staff, the
// shared access token), the recorded request and its per-firm audit row in
// the same transaction, the repeat and the concurrent repeat returning the
// original, both languages, the firm's name from firms.name, and that no
// book, document, principal, assignment or sign-in changed. Every response is
// checked against the pinned contract. All identities and companies are
// synthetic.
import assert from 'node:assert/strict';
import test from 'node:test';

import { applianceHarnessSkipReason, bootApplianceForTest } from '../testSupport/applianceHarness.js';
import { withFirmDbClient } from '../firmDb.js';
import { provisionEntityReadiness } from '../runtimeReadiness.js';
import { selfProvisionClientWorkspace } from '../selfProvisionDb.js';
import { responseSchemaFor, validateAgainst } from './contractSchema.js';
import { __resetMobileSignInLimiterForTests, MOBILE_API_PATH_PREFIX } from './mobileApi.js';

const IDP = 'https://idp.deletion-fixture.invalid';
const FIRM_NAME = 'Fixture Ledger Oy';
const IDENTITIES = {
  owner: { id: 'user-deletion-owner', email: 'owner@deletion-fixture.example', password: 'owner-pass' },
  finn: { id: 'user-deletion-finn', email: 'finn@deletion-fixture.example', password: 'finn-pass' },
  seat: { id: 'user-deletion-seat', email: 'seat@deletion-fixture.example', password: 'seat-pass' },
  member: { id: 'user-deletion-member', email: 'member@deletion-fixture.example', password: 'member-pass' }
};

// The identity provider at the wire (as mobileApiPgLifecycle.test.js), plus
// `issue` — a live token for any identity without going through sign-in, so a
// staff identity can reach the endpoint itself rather than stop at sign-in.
const installIdentityProvider = () => {
  const realFetch = globalThis.fetch;
  const live = new Map();
  const revoked = [];
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
      revoked.push(bearer);
      live.delete(bearer);
      return new Response(null, { status: 204 });
    }
    return json({ error: 'unexpected' }, 404);
  };
  return { revoked, issue: (key) => mint(key).access_token, restore: () => { globalThis.fetch = realFetch; } };
};

const conform = (response) => {
  const schema = responseSchemaFor('/me/deletion-request', 'POST', response.status);
  assert.ok(schema, `POST /me/deletion-request → ${response.status} is a contract response: ${response.text.slice(0, 300)}`);
  assert.deepEqual(validateAgainst(response.json, schema), [], 'conforms');
  return response.json;
};
const conformError = (response, status, code) => {
  assert.equal(response.status, status, response.text);
  assert.deepEqual(validateAgainst(response.json, { $ref: '#/components/schemas/ApiError' }), []);
  assert.equal(response.json.code, code);
};

// Everything the request must not touch: the books, the documents, the
// principals and their access. Static statements, one per table.
const UNTOUCHED = [
  ['clients', 'select md5(coalesce(string_agg(to_jsonb(t)::text, \'|\' order by t.id), \'\')) h, count(*)::int n from clients t'],
  ['documents', 'select md5(coalesce(string_agg(to_jsonb(t)::text, \'|\' order by t.id), \'\')) h, count(*)::int n from documents t'],
  ['transactions', 'select md5(coalesce(string_agg(to_jsonb(t)::text, \'|\' order by t.id), \'\')) h, count(*)::int n from transactions t'],
  ['ledger_accounts', 'select md5(coalesce(string_agg(to_jsonb(t)::text, \'|\' order by to_jsonb(t)::text), \'\')) h, count(*)::int n from ledger_accounts t'],
  ['ledger_journals', 'select md5(coalesce(string_agg(to_jsonb(t)::text, \'|\' order by to_jsonb(t)::text), \'\')) h, count(*)::int n from ledger_journals t'],
  ['ledger_lines', 'select md5(coalesce(string_agg(to_jsonb(t)::text, \'|\' order by to_jsonb(t)::text), \'\')) h, count(*)::int n from ledger_lines t'],
  ['close_archives', 'select md5(coalesce(string_agg(to_jsonb(t)::text, \'|\' order by to_jsonb(t)::text), \'\')) h, count(*)::int n from close_archives t'],
  ['firm_collaborators', 'select md5(coalesce(string_agg(to_jsonb(t)::text, \'|\' order by t.id), \'\')) h, count(*)::int n from firm_collaborators t'],
  ['firm_members', 'select md5(coalesce(string_agg(to_jsonb(t)::text, \'|\' order by t.id), \'\')) h, count(*)::int n from firm_members t'],
  ['client_assignments', 'select md5(coalesce(string_agg(to_jsonb(t)::text, \'|\' order by t.id), \'\')) h, count(*)::int n from client_assignments t']
];

test('real PG: an owner records an account-deletion request; nothing is deleted or changed', {
  skip: applianceHarnessSkipReason(), timeout: 600_000
}, async (t) => {
  const idp = installIdentityProvider();
  __resetMobileSignInLimiterForTests();
  const appliance = await bootApplianceForTest({
    firm: { name: FIRM_NAME },
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
  const clientId = await provision('owner', 'Kestrel Print Studio Ltd');
  const finnClientId = await provision('finn', 'Lumikko Kehys Oy');
  delete process.env.DONNA_DEFAULT_FIRM_ID;
  // The second book is Finnish and its owner chose Finnish (the profile
  // fields ownerLanguage.js reads; the jurisdiction the retention rule reads).
  await appliance.query(
    `update clients set jurisdiction = 'FI', profile = profile || '{"locale": "fi-FI", "jurisdiction": "FI"}'::jsonb
      where firm_id = $1 and id = $2`,
    [firmId, finnClientId]
  );
  await appliance.query(
    `insert into firm_collaborators (id, firm_id, user_id, email, name, role, status, access_level, seat_role)
     values ('collab-deletion-seat', $1, $2, $3, 'Fixture seat', 'bookkeeper', 'active', 'client_scoped', 'junior')`,
    [firmId, IDENTITIES.seat.id, IDENTITIES.seat.email]
  );
  await appliance.query(
    `insert into firm_members (id, firm_id, user_id, email, name, role, status, access_level)
     values ('member-deletion', $1, $2, $3, 'Fixture member', 'member', 'active', 'staff')`,
    [firmId, IDENTITIES.member.id, IDENTITIES.member.email]
  );
  // A document on the owner's book, so "no document changed" is about a row.
  await appliance.query(
    `insert into documents (id, firm_id, client_id, filename, document_type, status)
     values ('doc-deletion-fixture', $1, $2, 'receipt-fixture.pdf', 'receipt', 'needs_review')`,
    [firmId, clientId]
  );
  // The runtime's scheduled convergence sweep stamps a new document's verdict
  // (reconcileConvergenceState.js). Run the scheduler once so that lands
  // before the baseline and the comparison below is about this endpoint alone.
  await appliance.tick();
  assert.ok((await appliance.query("select convergence_as_of from documents where id = 'doc-deletion-fixture'")).rows[0].convergence_as_of,
    'the seeded document was converged before the baseline');
  const ownerPrincipal = (await appliance.query('select id from firm_collaborators where firm_id = $1 and user_id = $2', [firmId, IDENTITIES.owner.id])).rows[0].id;

  const api = ({ method = 'GET', path, token }) => appliance.api.request({
    method, path: `${MOBILE_API_PATH_PREFIX}${path}`, headers: token ? { authorization: `Bearer ${token}` } : {}
  });
  const signIn = (key) => appliance.api.request({ method: 'POST', path: `${MOBILE_API_PATH_PREFIX}/auth/sessions`,
    body: { email: IDENTITIES[key].email, password: IDENTITIES[key].password } });
  const signedIn = async (key) => {
    const response = await signIn(key);
    assert.equal(response.status, 200, response.text);
    assert.deepEqual(validateAgainst(response.json, responseSchemaFor('/auth/sessions', 'POST', 200)), []);
    return response.json;
  };
  const requestDeletion = (token) => api({ method: 'POST', path: '/me/deletion-request', token });
  const snapshot = async () => {
    const out = {};
    for (const [table, sql] of UNTOUCHED) out[table] = (await appliance.query(sql)).rows[0];
    return out;
  };
  const requestRows = () => appliance.query('select * from owner_deletion_requests order by requested_at').then((r) => r.rows);
  const auditRows = () => appliance.query(
    "select actor_type, actor_id, action, resource_id, client_id, metadata from audit_events where resource_type = 'owner_deletion_request' order by id"
  ).then((r) => r.rows);

  const ownerToken = (await signedIn('owner')).access_token;
  const finnToken = (await signedIn('finn')).access_token;
  const before = await snapshot();
  assert.ok(before.documents.n >= 1 && before.ledger_accounts.n >= 1 && before.clients.n >= 2 && before.firm_collaborators.n >= 3 && before.client_assignments.n >= 2, JSON.stringify(before));

  await t.test('refusals: no token, an expired token, the shared access token and staff identities write nothing', async () => {
    conformError(await requestDeletion(null), 401, 'AUTH_REQUIRED');
    conformError(await requestDeletion('access-nobody-0'), 401, 'AUTH_REQUIRED');
    conformError(await requestDeletion(appliance.accessToken), 401, 'AUTH_REQUIRED');
    conformError(await requestDeletion(idp.issue('seat')), 403, 'MOBILE_OWNER_ONLY');
    conformError(await requestDeletion(idp.issue('member')), 403, 'MOBILE_OWNER_ONLY');
    assert.deepEqual(await requestRows(), []);
    assert.deepEqual(await auditRows(), []);
  });

  let original;
  await t.test('the request is recorded once, with its audit row, and the message tells the truth (English)', async () => {
    original = conform(await requestDeletion(ownerToken));
    const [row] = await requestRows();
    assert.equal(row.identity_key, IDENTITIES.owner.id);
    assert.equal(row.status, 'recorded');
    assert.deepEqual(row.firm_ids, [firmId]);
    assert.deepEqual(row.client_ids, [clientId]);
    assert.equal(row.language, 'en');
    assert.equal(row.scope[0].firm_name, FIRM_NAME);
    assert.equal(row.scope[0].principal_id, ownerPrincipal);
    assert.equal(new Date(row.requested_at).toISOString(), original.requested_at);
    assert.equal(row.message, original.message);
    assert.match(original.message, /^Your request to delete your Donna account was recorded on \d{1,2} [A-Z][a-z]+ \d{4} at \d{2}:\d{2} UTC\./);
    assert.match(original.message, /books of Kestrel Print Studio Ltd\./);
    assert.match(original.message, /Nothing has been deleted/);
    assert.match(original.message, new RegExp(`Your accounting firm, ${FIRM_NAME}, handles the request\\.`));
    assert.match(original.message, /Donna has not passed your request on to the firm automatically/);
    assert.match(original.message, /cannot be deleted before that period ends\.$/, 'a GB book: no Finnish periods');
    const audits = await auditRows();
    assert.equal(audits.length, 1);
    assert.deepEqual({ ...audits[0], metadata: undefined }, {
      actor_type: 'firm_collaborator', actor_id: ownerPrincipal, action: 'owner_deletion_request.recorded',
      resource_id: row.id, client_id: null, metadata: undefined
    });
    assert.deepEqual(audits[0].metadata.client_ids, [clientId]);
    assert.equal(audits[0].metadata.firm_notified, false);
  });

  await t.test('a repeat returns the original request and writes nothing', async () => {
    const again = conform(await requestDeletion(ownerToken));
    assert.deepEqual(again, original);
    assert.equal((await requestRows()).length, 1);
    assert.equal((await auditRows()).length, 1);
  });

  await t.test('concurrent first requests (Finnish) collapse onto one row and one audit row', async () => {
    const [a, b] = await Promise.all([requestDeletion(finnToken), requestDeletion(finnToken)]);
    const first = conform(a);
    assert.deepEqual(conform(b), first);
    const rows = (await requestRows()).filter((row) => row.identity_key === IDENTITIES.finn.id);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].language, 'fi');
    assert.equal((await auditRows()).filter((row) => row.resource_id === rows[0].id).length, 1);
    assert.match(first.message, /^Pyyntösi poistaa Donna-tilisi kirjattiin \d{1,2}\.\d{1,2}\.\d{4} klo \d{2}\.\d{2} \(UTC\)\./);
    assert.match(first.message, /yrityksen Lumikko Kehys Oy kirjanpitoa/);
    assert.match(first.message, new RegExp(`Pyynnön käsittelee tilitoimistosi ${FIRM_NAME}\\.`));
    assert.match(first.message, /Donna ei ole välittänyt pyyntöä tilitoimistolle automaattisesti/);
    assert.match(first.message, /Suomessa kirjanpitokirjat on säilytettävä 10 vuotta tilikauden päättymisestä ja tositteet 6 vuotta/);
  });

  await t.test('no book, document, principal or assignment changed; the owners still sign in and see their books', async () => {
    const after = await snapshot();
    for (const [table] of UNTOUCHED) assert.deepEqual(after[table], before[table], `${table} unchanged`);
    const session = await signedIn('owner');
    assert.deepEqual(session.entities.map((entity) => entity.id), [clientId]);
    const me = await api({ path: '/me', token: ownerToken });
    assert.equal(me.status, 200, me.text);
    assert.deepEqual(idp.revoked.filter((token) => token === ownerToken || token === finnToken), [], 'no owner session was revoked');
  });
});
