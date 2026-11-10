// The business register (Settings → Business → Register) end to end on real
// PostgreSQL, through the real runtime server, the real mobile router and the
// real firm profile route: an owner of a Finnish book reads the setup, enters
// their Business ID, legal name and form by hand, answers the stage question
// and puts the suggestion off; every write lands through the existing profile
// writer with its audit row as the receipt. Refusals: no token, a staff token,
// another business's entity, a register candidate that is not current,
// replacing an associated Business ID (including two phones racing), a
// non-Finnish book, and the lookup this server cannot perform. Every response
// is checked against the pinned contract. All identities, companies and
// Business IDs are synthetic (the IDs are low-numbered, check-digit-valid
// values outside any issued range).
import assert from 'node:assert/strict';
import test from 'node:test';

import { applianceHarnessSkipReason, bootApplianceForTest } from '../testSupport/applianceHarness.js';
import { withFirmDbClient } from '../firmDb.js';
import { provisionEntityReadiness } from '../runtimeReadiness.js';
import { selfProvisionClientWorkspace } from '../selfProvisionDb.js';
import { responseSchemaFor, validateAgainst } from './contractSchema.js';
import { __resetMobileSignInLimiterForTests, MOBILE_API_PATH_PREFIX } from './mobileApi.js';

const IDP = 'https://idp.mobile-register-fixture.invalid';
const IDENTITIES = {
  owner: { id: 'user-register-owner', email: 'owner@register-fixture.example', password: 'owner-pass' },
  neighbour: { id: 'user-register-neighbour', email: 'neighbour@register-fixture.example', password: 'neighbour-pass' },
  uk: { id: 'user-register-uk', email: 'uk@register-fixture.example', password: 'uk-pass' },
  seat: { id: 'user-register-seat', email: 'seat@register-fixture.example', password: 'seat-pass' }
};
const BUSINESS_ID = '0000001-9';
const OTHER_BUSINESS_ID = '0000002-7';

// The identity provider at the wire, plus a direct mint (a staff token the
// sign-in route would never hand out, to prove the entity routes refuse it).
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
  return { mint, restore: () => { globalThis.fetch = realFetch; } };
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
  if (code) assert.equal(response.json.code, code, response.text);
};

test('real PG: an owner confirms their business register details through the mobile adapter', {
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
  const provision = async (key, companyName, jurisdiction, entityType) => {
    const result = await selfProvisionClientWorkspace({ auth: { userId: IDENTITIES[key].id, email: IDENTITIES[key].email },
      companyName, jurisdiction, entityType });
    assert.ok(result.clientId, JSON.stringify(result));
    await provisionEntityReadiness({ withFirmDbClientFn: withFirmDbClient, firmId, clientId: result.clientId,
      creationPath: 'self_provision', lifecycle: 'cold_create', compatibilityScope: 'birth_residue_proof',
      initiatingPrincipal: { actor_type: 'supabase_user', actor_id: IDENTITIES[key].id },
      authorityBasis: { source: 'authenticated_self_provision_route', principal_id: IDENTITIES[key].id } });
    return result.clientId;
  };
  const clientId = await provision('owner', 'Aurora Kettle Works', 'FI', 'fi-toiminimi');
  const neighbourClientId = await provision('neighbour', 'Pohjoistuuli Repairs', 'FI', 'fi-toiminimi');
  const ukClientId = await provision('uk', 'Kestrel Ledger Studio Ltd', 'GB', 'gb-ltd');
  delete process.env.DONNA_DEFAULT_FIRM_ID;
  await appliance.query(
    `insert into firm_collaborators (id, firm_id, user_id, email, name, role, status, access_level, seat_role)
     values ('collab-register-seat', $1, $2, $3, 'Fixture seat', 'bookkeeper', 'active', 'client_scoped', 'junior')`,
    [firmId, IDENTITIES.seat.id, IDENTITIES.seat.email]
  );
  const clientRow = async (id) => (await appliance.query(
    'select company_name, entity_type, jurisdiction, profile from clients where firm_id = $1 and id = $2', [firmId, id])).rows[0];
  const before = await clientRow(clientId);

  const api = ({ method = 'GET', path, token, body }) => appliance.api.request({
    method, path: `${MOBILE_API_PATH_PREFIX}${path}`, body, headers: token ? { authorization: `Bearer ${token}` } : {}
  });
  const signIn = async (key) => conform('/auth/sessions', 'POST',
    await api({ method: 'POST', path: '/auth/sessions', body: { email: IDENTITIES[key].email, password: IDENTITIES[key].password } }));
  const session = await signIn('owner');
  const token = session.access_token;
  const setupPath = `/entities/${clientId}/business-setup`;
  const post = (body, as = token, path = setupPath) => api({ method: 'POST', path, token: as, body });
  const confirmManual = (overrides = {}) => ({ type: 'confirm_manual', business_id: BUSINESS_ID, legal_name: 'Aurora Kettle Works Tmi', legal_form: 'sole_trader', ...overrides });

  // ── Initial state ───────────────────────────────────────────────────────
  const initial = conform('/entities/{entityId}/business-setup', 'GET', await api({ path: setupPath, token }));
  assert.deepEqual(initial, {
    identity: null, business_stage: null, suggestion_dismissed: false, suggestion_available: false,
    prior_record_ids: [], next_step: 'identify_business',
    capabilities: { receipt_capture: 'available', tax_preparation: 'not_configured', external_actions: 'not_authorized' }
  });

  // ── Refusals before anything is written ─────────────────────────────────
  await t.test('no token is 401; a staff token is refused; another business is 404', async () => {
    conformError(await api({ path: setupPath }), 401, 'AUTH_REQUIRED');
    conformError(await post(confirmManual(), null), 401, 'AUTH_REQUIRED');
    const staff = idp.mint('seat').access_token;
    conformError(await api({ path: setupPath, token: staff }), 403, 'MOBILE_OWNER_ONLY');
    conformError(await post(confirmManual(), staff), 403, 'MOBILE_OWNER_ONLY');
    conformError(await api({ path: `/entities/${neighbourClientId}/business-setup`, token }), 404, 'NOT_FOUND');
    conformError(await post(confirmManual(), token, `/entities/${neighbourClientId}/business-setup`), 404, 'NOT_FOUND');
    conformError(await post({ business_id: BUSINESS_ID }, token, `/entities/${neighbourClientId}/business-setup/lookup`), 404, 'NOT_FOUND');
  });
  await t.test('malformed actions are 400 and change nothing', async () => {
    conformError(await post({ type: 'confirm_everything' }), 400, 'SETUP_ACTION_INVALID');
    conformError(await post(confirmManual({ business_id: '0000001-8' })), 400, 'BUSINESS_ID_INVALID');
    conformError(await post(confirmManual({ legal_name: '  ' })), 400, 'BUSINESS_DETAILS_INVALID');
    conformError(await post(confirmManual({ legal_form: 'oy' })), 400, 'BUSINESS_DETAILS_INVALID');
    conformError(await post({ type: 'set_stage', business_stage: 'old' }), 400, 'BUSINESS_STAGE_INVALID');
    conformError(await post({ type: 'confirm_registry' }), 400, 'CANDIDATE_ID_REQUIRED');
  });
  await t.test('lookup is not available on this server, and says so', async () => {
    conformError(await post({ business_id: BUSINESS_ID }, token, `${setupPath}/lookup`), 501, 'NOT_IMPLEMENTED');
  });
  await t.test('a register candidate that is not current is the contract’s 409', async () => {
    conformError(await post({ type: 'confirm_registry', candidate_id: 'cand-expired-or-foreign' }), 409, 'REGISTRY_CANDIDATE_EXPIRED');
  });
  assert.deepEqual((await clientRow(clientId)).profile, before.profile, 'no refusal wrote anything');

  // ── Confirm by hand ─────────────────────────────────────────────────────
  const auditBefore = (await appliance.query('select coalesce(max(id), 0)::bigint as id from audit_events where firm_id = $1', [firmId])).rows[0].id;
  const confirmed = conform('/entities/{entityId}/business-setup', 'POST', await post(confirmManual({ business_id: '00000019' })));
  assert.deepEqual(confirmed.setup.identity, {
    business_id: BUSINESS_ID, legal_name: 'Aurora Kettle Works Tmi', legal_form: 'sole_trader', legal_form_code: null,
    registered_address: '', source: 'owner', fetched_at: null, authority_verified: false
  });
  assert.equal(confirmed.setup.next_step, 'business_stage');
  assert.equal(confirmed.receipt.actor.type, 'owner');
  assert.equal(confirmed.receipt.audit_event_ids.length, 1, JSON.stringify(confirmed.receipt));
  const audit = (await appliance.query('select id::text, action, actor_id, client_id, metadata from audit_events where firm_id = $1 and id > $2 order by id',
    [firmId, auditBefore])).rows;
  const profileAudit = audit.filter((row) => row.action === 'client.profile.update');
  assert.equal(profileAudit.length, 1, JSON.stringify(audit));
  assert.equal(profileAudit[0].id, confirmed.receipt.audit_event_ids[0], 'the receipt is the writer’s own audit row');
  assert.equal(profileAudit[0].client_id, clientId);
  assert.equal(profileAudit[0].actor_id, session.principal.id, 'attributed to the acting owner');
  const after = await clientRow(clientId);
  assert.equal(after.profile.businessId, BUSINESS_ID, 'the Y-tunnus lands where the invoice seller context reads it');
  assert.equal(after.profile.legalName, 'Aurora Kettle Works Tmi');
  assert.equal(after.company_name, before.company_name, 'the owner-edited business name is not overwritten');
  assert.equal(after.entity_type, before.entity_type, 'the statutory legal-form axis is untouched');
  assert.equal(after.jurisdiction, before.jurisdiction);
  assert.equal(after.profile.business_register.confirmed_by, session.principal.id);

  // The same Business ID again (a corrected name) is a confirmation, not a replacement.
  const corrected = conform('/entities/{entityId}/business-setup', 'POST', await post(confirmManual({ legal_name: 'Aurora Kettle Works' })));
  assert.equal(corrected.setup.identity.legal_name, 'Aurora Kettle Works');
  await t.test('an associated Business ID cannot be replaced', async () => {
    conformError(await post(confirmManual({ business_id: OTHER_BUSINESS_ID })), 409, 'BUSINESS_ID_LOCKED');
    assert.equal((await clientRow(clientId)).profile.businessId, BUSINESS_ID);
  });

  // ── Stage, first receipt, defer ─────────────────────────────────────────
  const staged = conform('/entities/{entityId}/business-setup', 'POST', await post({ type: 'set_stage', business_stage: 'existing' }));
  assert.equal(staged.setup.business_stage, 'existing');
  assert.equal(staged.setup.next_step, 'first_receipt', 'never sends the owner to background records this server cannot keep');
  const deferred = conform('/entities/{entityId}/business-setup', 'POST', await post({ type: 'defer' }));
  assert.equal(deferred.setup.suggestion_dismissed, true);
  assert.equal(deferred.setup.business_stage, 'existing', 'defer keeps the answers');
  assert.equal(deferred.setup.identity.business_id, BUSINESS_ID);
  await appliance.query(
    `insert into documents (id, firm_id, client_id, filename, document_type, uploaded_at, payload)
     values ('register-fixture-doc', $1, $2, 'receipt.pdf', 'unknown', now(), '{}'::jsonb)`, [firmId, clientId]);
  const withDocument = conform('/entities/{entityId}/business-setup', 'GET', await api({ path: setupPath, token }));
  assert.equal(withDocument.suggestion_available, true);
  assert.equal(withDocument.next_step, 'done');
  assert.equal(withDocument.suggestion_dismissed, true);

  // ── A Business ID the firm recorded is associated too ───────────────────
  await t.test('two phones racing to confirm different IDs: exactly one wins', async () => {
    const neighbour = (await signIn('neighbour')).access_token;
    const path = `/entities/${neighbourClientId}/business-setup`;
    const raced = await Promise.all([BUSINESS_ID, OTHER_BUSINESS_ID].map((id) => post(confirmManual({ business_id: id, legal_name: 'Pohjoistuuli Repairs' }), neighbour, path)));
    const statuses = raced.map((response) => response.status).sort();
    assert.deepEqual(statuses, [200, 409], raced.map((response) => response.text).join('\n'));
    const winner = raced.find((response) => response.status === 200);
    conform('/entities/{entityId}/business-setup', 'POST', winner);
    conformError(raced.find((response) => response.status === 409), 409, 'BUSINESS_ID_LOCKED');
    assert.equal((await clientRow(neighbourClientId)).profile.businessId, winner.json.setup.identity.business_id);
  });
  await t.test('a Business ID recorded elsewhere is not served as confirmed, but still cannot be replaced', async () => {
    const uk = (await signIn('uk')).access_token;
    const path = `/entities/${ukClientId}/business-setup`;
    conformError(await post(confirmManual(), uk, path), 400, 'BUSINESS_REGISTER_FINLAND_ONLY');
    const ukStage = conform('/entities/{entityId}/business-setup', 'POST', await post({ type: 'set_stage', business_stage: 'new' }, uk, path));
    assert.equal(ukStage.setup.identity, null);
    await appliance.query(`update clients set jurisdiction = 'FI', profile = profile || '{"businessId":"0000002-7"}'::jsonb where firm_id = $1 and id = $2`, [firmId, ukClientId]);
    const recorded = conform('/entities/{entityId}/business-setup', 'GET', await api({ path, token: uk }));
    assert.equal(recorded.identity, null);
    assert.equal(recorded.next_step, 'identify_business');
    conformError(await post(confirmManual(), uk, path), 409, 'BUSINESS_ID_LOCKED');
    const owned = conform('/entities/{entityId}/business-setup', 'POST', await post(confirmManual({ business_id: OTHER_BUSINESS_ID }), uk, path));
    assert.equal(owned.setup.identity.business_id, OTHER_BUSINESS_ID, 'the owner may confirm the ID already on file');
  });
});
