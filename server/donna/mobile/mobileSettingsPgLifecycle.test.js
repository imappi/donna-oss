// The Settings resource end to end on real PostgreSQL, through the real
// runtime server, the real mobile router and the real firm routes (appliance
// harness). A Finnish owner reads defaults, saves notification switches, sees
// only their own verified phone number, declares a VAT period through the
// client-profile writer, reads persisted financial years, and is refused a
// VAT-period change once a return has been filed on the period in force. A UK
// owner reads the period from the HMRC stagger and cannot declare one.
// Refusals: no token, a staff identity, another business's entity. Every
// response is checked against the pinned contract. All identities, companies
// and phone numbers are synthetic.
import assert from 'node:assert/strict';
import test from 'node:test';

import { applianceHarnessSkipReason, bootApplianceForTest } from '../testSupport/applianceHarness.js';
import { withFirmDbClient } from '../firmDb.js';
import { provisionEntityReadiness } from '../runtimeReadiness.js';
import { selfProvisionClientWorkspace } from '../selfProvisionDb.js';
import { verokausiCadenceForProfile } from '../finland/alvReturn.js';
import { responseSchemaFor, validateAgainst } from './contractSchema.js';
import { __resetMobileSignInLimiterForTests, MOBILE_API_PATH_PREFIX } from './mobileApi.js';

const IDP = 'https://idp.settings-fixture.invalid';
const IDENTITIES = {
  owner: { id: 'user-settings-owner', email: 'owner@settings-fixture.example', password: 'owner-pass' },
  neighbour: { id: 'user-settings-neighbour', email: 'neighbour@settings-fixture.example', password: 'neighbour-pass' },
  ukOwner: { id: 'user-settings-uk', email: 'uk@settings-fixture.example', password: 'uk-pass' },
  seat: { id: 'user-settings-seat', email: 'seat@settings-fixture.example', password: 'seat-pass' }
};

// The identity provider at the wire (password grant, /user, logout), with a
// direct mint so a staff identity can hold a live token for the refusal check.
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

const conform = (method, response, status = 200) => {
  assert.equal(response.status, status, response.text);
  const schema = responseSchemaFor('/entities/{entityId}/settings', method, status);
  assert.ok(schema, `${method} settings → ${status} is a contract response`);
  assert.deepEqual(validateAgainst(response.json, schema), [], `${method} settings → ${status} conforms`);
  return response.json;
};
const conformError = (response, status, code) => {
  assert.equal(response.status, status, response.text);
  assert.deepEqual(validateAgainst(response.json, { $ref: '#/components/schemas/ApiError' }), []);
  if (code) assert.equal(response.json.code, code, response.text);
};

test('real PG: an owner reads and saves Settings through the mobile adapter, and history is never rewritten', {
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
  const clientId = await provision('owner', 'Kuusikko Paja Oy', 'FI', 'fi-oy');
  const neighbourClientId = await provision('neighbour', 'Rantakivi Korjaamo Oy', 'FI', 'fi-oy');
  const ukClientId = await provision('ukOwner', 'Larkspur Joinery Ltd', 'GB', 'gb-ltd');
  delete process.env.DONNA_DEFAULT_FIRM_ID;
  const collaboratorOf = async (key) => (await appliance.query(
    'select id from firm_collaborators where firm_id = $1 and lower(email) = $2', [firmId, IDENTITIES[key].email])).rows[0].id;
  const ownerPrincipalId = await collaboratorOf('owner');
  const neighbourPrincipalId = await collaboratorOf('neighbour');
  await appliance.query(
    `insert into firm_collaborators (id, firm_id, user_id, email, name, role, status, access_level, seat_role)
     values ('collab-settings-seat', $1, $2, $3, 'Fixture seat', 'bookkeeper', 'active', 'client_scoped', 'junior')`,
    [firmId, IDENTITIES.seat.id, IDENTITIES.seat.email]
  );

  const api = ({ method = 'GET', path, token, body }) => appliance.api.request({
    method, path: `${MOBILE_API_PATH_PREFIX}${path}`, body, headers: token ? { authorization: `Bearer ${token}` } : {}
  });
  const signIn = async (key) => {
    const response = await api({ method: 'POST', path: '/auth/sessions', body: { email: IDENTITIES[key].email, password: IDENTITIES[key].password } });
    assert.equal(response.status, 200, response.text);
    return response.json.access_token;
  };
  const token = await signIn('owner');
  const settingsPath = `/entities/${clientId}/settings`;
  const auditCount = async (action) => Number((await appliance.query(
    'select count(*)::int as n from audit_events where firm_id = $1 and client_id = $2 and action = $3', [firmId, clientId, action])).rows[0].n);
  const profileOf = async (id) => (await appliance.query('select profile from clients where firm_id = $1 and id = $2', [firmId, id])).rows[0].profile || {};

  // ── Refusals ────────────────────────────────────────────────────────────
  await t.test('no token is 401; a staff identity is 403; another business is 404 for read and write', async () => {
    conformError(await api({ path: settingsPath }), 401, 'AUTH_REQUIRED');
    conformError(await api({ method: 'POST', path: settingsPath, body: { type: 'set_vat_period', vat_period: 'month' } }), 401, 'AUTH_REQUIRED');
    const seatToken = idp.mint('seat').access_token;
    conformError(await api({ path: settingsPath, token: seatToken }), 403, 'MOBILE_OWNER_ONLY');
    conformError(await api({ method: 'POST', path: settingsPath, token: seatToken, body: { type: 'set_vat_period', vat_period: 'month' } }), 403, 'MOBILE_OWNER_ONLY');
    conformError(await api({ path: settingsPath, token: appliance.accessToken }), 401, 'AUTH_REQUIRED');
    const foreign = `/entities/${neighbourClientId}/settings`;
    conformError(await api({ path: foreign, token }), 404, 'NOT_FOUND');
    conformError(await api({ method: 'POST', path: foreign, token, body: { type: 'set_vat_period', vat_period: 'year' } }), 404, 'NOT_FOUND');
    conformError(await api({ method: 'POST', path: foreign, token,
      body: { type: 'set_notifications', notifications: { needs_you: false, due_dates: false, monthly_summary: false, every_receipt: false } } }), 404, 'NOT_FOUND');
    assert.equal((await profileOf(neighbourClientId)).verokausi, undefined, 'the neighbour’s book is untouched');
    assert.equal((await appliance.query('select count(*)::int as n from mobile_notification_preferences where client_id = $1', [neighbourClientId])).rows[0].n, 0);
  });

  // ── First read: nothing recorded ────────────────────────────────────────
  const first = conform('GET', await api({ path: settingsPath, token }));
  assert.equal(first.source, 'backend');
  assert.equal(first.vat_period, null, 'no verokausi recorded: unknown, not the monthly default');
  assert.deepEqual(first.notifications, { needs_you: true, due_dates: true, monthly_summary: false, every_receipt: false }, 'the product default');
  assert.equal(first.notification_delivery, 'not_configured');
  assert.equal(first.phone_number, null);

  // ── Bad shapes are 400 ──────────────────────────────────────────────────
  conformError(await api({ method: 'POST', path: settingsPath, token, body: { type: 'set_vat_period', vat_period: 'weekly' } }), 400, 'SETTINGS_INVALID');
  conformError(await api({ method: 'POST', path: settingsPath, token, body: { type: 'set_notifications', notifications: { needs_you: true } } }), 400, 'SETTINGS_INVALID');

  // ── Phone: only the owner's own verified WhatsApp/SMS number ────────────
  await appliance.query(
    `insert into client_whatsapp_bindings (id, firm_id, client_id, collaborator_id, phone_e164, phone_hash, verified_set_by, opted_in_set_by, channel)
     values ('wab-settings-tg', $1, $2, $3, '700000001', 'hash-tg', 'fixture', 'fixture', 'telegram')`,
    [firmId, clientId, ownerPrincipalId]
  );
  await appliance.query(
    `insert into client_whatsapp_bindings (id, firm_id, client_id, collaborator_id, phone_e164, phone_hash, verified_set_by, opted_in_set_by, channel)
     values ('wab-settings-other', $1, $2, 'collab-settings-seat', '+358000000999', 'hash-other', 'fixture', 'fixture', 'whatsapp')`,
    [firmId, clientId]
  );
  assert.equal(conform('GET', await api({ path: settingsPath, token })).phone_number, null, 'a chat id and a colleague’s number are not the owner’s phone');
  await appliance.query(
    `insert into client_whatsapp_bindings (id, firm_id, client_id, collaborator_id, phone_e164, phone_hash, verified_set_by, opted_in_set_by, channel)
     values ('wab-settings-own', $1, $2, $3, '+358000000123', 'hash-own', 'fixture', 'fixture', 'sms')`,
    [firmId, clientId, ownerPrincipalId]
  );
  assert.equal(conform('GET', await api({ path: settingsPath, token })).phone_number, '+358000000123');
  await appliance.query("update client_whatsapp_bindings set revoked_at = now() where id = 'wab-settings-own'");
  assert.equal(conform('GET', await api({ path: settingsPath, token })).phone_number, null, 'a revoked binding is not shown');

  // ── Notifications: the owner's own store, receipted ─────────────────────
  const prefs = { needs_you: false, due_dates: true, monthly_summary: true, every_receipt: false };
  const saved = conform('POST', await api({ method: 'POST', path: settingsPath, token, body: { type: 'set_notifications', notifications: prefs } }));
  assert.deepEqual(saved.settings.notifications, prefs);
  assert.deepEqual(saved.receipt.changes, [{ target: 'notifications', applied: true, error: null }]);
  assert.equal(saved.receipt.audit_event_ids.length, 1);
  const prefAudit = (await appliance.query('select actor_type, actor_id, action, metadata from audit_events where id = $1::bigint', [saved.receipt.audit_event_ids[0]])).rows[0];
  assert.equal(prefAudit.action, 'mobile.notification_preferences.update');
  assert.equal(prefAudit.actor_type, 'owner');
  assert.equal(prefAudit.actor_id, ownerPrincipalId, 'attributed to the acting owner');
  assert.deepEqual(prefAudit.metadata.after, prefs);
  assert.deepEqual(conform('GET', await api({ path: settingsPath, token })).notifications, prefs, 'persisted');
  const again = conform('POST', await api({ method: 'POST', path: settingsPath, token, body: { type: 'set_notifications', notifications: prefs } }));
  assert.deepEqual(again.receipt.changes, [{ target: 'notifications', applied: false, error: null }]);
  assert.deepEqual(again.receipt.audit_event_ids, [], 'a repeat writes nothing');
  assert.equal(await auditCount('mobile.notification_preferences.update'), 1);
  // Per owner: the neighbour signing in to their own book still sees the default.
  const neighbourToken = await signIn('neighbour');
  assert.deepEqual(conform('GET', await api({ path: `/entities/${neighbourClientId}/settings`, token: neighbourToken })).notifications,
    { needs_you: true, due_dates: true, monthly_summary: false, every_receipt: false });
  assert.equal((await appliance.query('select count(*)::int as n from mobile_notification_preferences where principal_id = $1', [neighbourPrincipalId])).rows[0].n, 0);

  // ── VAT period: declared through the client-profile writer ──────────────
  const beforeProfileAudits = await auditCount('client.profile.update');
  const declared = conform('POST', await api({ method: 'POST', path: settingsPath, token, body: { type: 'set_vat_period', vat_period: 'quarter' } }));
  assert.equal(declared.settings.vat_period, 'quarter');
  assert.deepEqual(declared.receipt.changes, [{ target: 'vat_period', applied: true, error: null }]);
  assert.equal(declared.receipt.audit_event_ids.length, 1);
  assert.equal(await auditCount('client.profile.update'), beforeProfileAudits + 1);
  const vatAudit = (await appliance.query('select action, actor_id, resource_id, metadata from audit_events where id = $1::bigint', [declared.receipt.audit_event_ids[0]])).rows[0];
  assert.equal(vatAudit.action, 'client.profile.update', 'the profile writer’s own receipt');
  assert.equal(vatAudit.actor_id, ownerPrincipalId);
  assert.equal(vatAudit.resource_id, clientId);
  assert.ok(vatAudit.metadata.keys.includes('verokausi'));
  const profile = await profileOf(clientId);
  assert.equal(profile.verokausi, 'quarter');
  assert.equal(verokausiCadenceForProfile(profile), 'quarter', 'the ALV engine now reads the declared cadence');
  assert.deepEqual(conform('POST', await api({ method: 'POST', path: settingsPath, token, body: { type: 'set_vat_period', vat_period: 'quarter' } })).receipt.audit_event_ids, [],
    'the same declaration again writes nothing');
  assert.equal(await auditCount('client.profile.update'), beforeProfileAudits + 1);

  // With no return prepared yet, the owner may correct the declaration.
  for (const vatPeriod of ['year', 'quarter']) {
    const corrected = conform('POST', await api({ method: 'POST', path: settingsPath, token, body: { type: 'set_vat_period', vat_period: vatPeriod } }));
    assert.equal(corrected.settings.vat_period, vatPeriod);
    assert.equal(corrected.receipt.audit_event_ids.length, 1);
  }
  assert.equal(await auditCount('client.profile.update'), beforeProfileAudits + 3);

  // ── Financial year: the persisted fiscal_years rows ─────────────────────
  await appliance.query('delete from fiscal_years where firm_id = $1 and client_id = $2', [firmId, clientId]);
  await appliance.query("update clients set incorporation_date = '2024-04-01' where firm_id = $1 and id = $2", [firmId, clientId]);
  const year = new Date().getUTCFullYear();
  await appliance.query(
    `insert into fiscal_years (id, firm_id, client_id, label, starts_on, ends_on, status)
     values ('fy-settings-1', $1, $2, '2024', '2024-04-01', '2024-12-31', 'closed'),
            ('fy-settings-prev', $1, $2, $3, $4::date, $5::date, 'closing'),
            ('fy-settings-cur', $1, $2, $6, $7::date, $8::date, 'open')`,
    [firmId, clientId, String(year - 1), `${year - 1}-01-01`, `${year - 1}-12-31`, String(year), `${year}-01-01`, `${year}-12-31`]
  );
  const withYears = conform('GET', await api({ path: settingsPath, token }));
  assert.deepEqual(withYears.financial_year, {
    current: `1 Jan ${year}–31 Dec ${year}`,
    first: '1 Apr 2024–31 Dec 2024',
    statements: `1 Jan ${year - 1}–31 Dec ${year - 1}: being closed`
  });
  const finnish = (await appliance.api.request({ path: `${MOBILE_API_PATH_PREFIX}${settingsPath}`,
    headers: { authorization: `Bearer ${token}`, 'accept-language': 'fi-FI' } })).json;
  assert.equal(finnish.financial_year.current, `1.1.${year}–31.12.${year}`);

  // ── History guard: a filed return on the cadence in force ───────────────
  await appliance.query(
    `insert into alv_returns (id, firm_id, client_id, period_key, period_type, starts_on, ends_on, status, filed_at)
     values ('alv-settings-filed', $1, $2, $3, 'quarter', $4::date, $5::date, 'filed', now())`,
    [firmId, clientId, `${year}-Q1`, `${year}-01-01`, `${year}-03-31`]
  );
  const auditsBeforeRefusal = await auditCount('client.profile.update');
  conformError(await api({ method: 'POST', path: settingsPath, token, body: { type: 'set_vat_period', vat_period: 'month' } }), 409, 'VAT_PERIOD_IN_USE');
  assert.equal((await profileOf(clientId)).verokausi, 'quarter', 'the period in force is unchanged');
  assert.equal(await auditCount('client.profile.update'), auditsBeforeRefusal, 'a refusal writes nothing');
  assert.equal(conform('POST', await api({ method: 'POST', path: settingsPath, token, body: { type: 'set_vat_period', vat_period: 'quarter' } })).settings.vat_period, 'quarter');

  // ── UK: the period is the HMRC stagger; the phone cannot declare it ─────
  const ukToken = await signIn('ukOwner');
  const ukPath = `/entities/${ukClientId}/settings`;
  assert.equal(conform('GET', await api({ path: ukPath, token: ukToken })).vat_period, null);
  conformError(await api({ method: 'POST', path: ukPath, token: ukToken, body: { type: 'set_vat_period', vat_period: 'quarter' } }), 409, 'VAT_PERIOD_FROM_HMRC_STAGGER');
  await appliance.query(`update clients set profile = jsonb_set(coalesce(profile, '{}'::jsonb), '{gb}', '{"vat_stagger": 2}'::jsonb) where firm_id = $1 and id = $2`, [firmId, ukClientId]);
  assert.equal(conform('GET', await api({ path: ukPath, token: ukToken })).vat_period, 'quarter');
  assert.deepEqual(conform('POST', await api({ method: 'POST', path: ukPath, token: ukToken, body: { type: 'set_vat_period', vat_period: 'quarter' } })).receipt.changes,
    [{ target: 'vat_period', applied: false, error: null }]);
  conformError(await api({ method: 'POST', path: ukPath, token: ukToken, body: { type: 'set_vat_period', vat_period: 'month' } }), 409, 'VAT_PERIOD_FROM_HMRC_STAGGER');
  assert.equal((await profileOf(ukClientId)).verokausi, undefined, 'no Finnish key lands on a UK book');
});
