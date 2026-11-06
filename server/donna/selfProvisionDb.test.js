// Self-serve provisioning — unit coverage for the orchestration (auth guard,
// idempotency, deterministic ids). The raw SQL writes need a live DB and are
// exercised by integration; here we inject stubs for the DB-touching helpers so
// we pin only the decision logic.

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  resolveProvisionIdentity,
  selfProvisionClientWorkspace,
  needsCoreServicesHeal,
  ownerRowIsAdoptable,
  ProvisionFirmScopeError,
  ProvisionPrincipalConflictError,
  normalizeProvisionJurisdiction,
  normalizeProvisionEntityType,
  assertProvisionJurisdictionSupported,
  seedGbDefaultChartIfEmpty
} from './selfProvisionDb.js';

const ownerAuth = { type: 'supabase_user', email: 'Owner@Example.com', userId: 'user-1' };
const noEmailAuth = { type: 'access_token' };

// Capturing stubs for the DB-touching deps.
const makeDeps = ({ existing = null, bindableError = null } = {}) => {
  const calls = { findOwned: 0, createClient: 0, bindOwner: 0, applyName: 0, applyCoreServices: 0, applyDefaultAccountingSystem: 0, assertBindable: 0, seedGbChart: 0 };
  let lastCreateProfile = null;
  let lastApplyNameArgs = null;
  let lastApplyCoreServicesArgs = null;
  let lastCreateArgs = null;
  let lastBindOwnerArgs = null;
  let lastFindOwnedArgs = null;
  const scopeChecked = [];
  return {
    calls,
    scopeChecked,
    get lastCreateProfile() { return lastCreateProfile; },
    get lastApplyNameArgs() { return lastApplyNameArgs; },
    get lastApplyCoreServicesArgs() { return lastApplyCoreServicesArgs; },
    get lastCreateArgs() { return lastCreateArgs; },
    get lastBindOwnerArgs() { return lastBindOwnerArgs; },
    get lastFindOwnedArgs() { return lastFindOwnedArgs; },
    scopeCheck: (id) => { scopeChecked.push(id); },
    // The deployment's configured firm. Provisioning resolves the target from
    // configuration and refuses a caller-supplied firm_id that differs.
    resolveDefaultFirmId: () => 'firm-donna',
    assertBindable: async () => {
      calls.assertBindable += 1;
      if (bindableError) throw bindableError;
    },
    findOwned: async (args) => { calls.findOwned += 1; lastFindOwnedArgs = args; return existing; },
    createClient: async (args = {}) => { calls.createClient += 1; lastCreateProfile = args.profile; lastCreateArgs = args; },
    bindOwner: async (args) => { calls.bindOwner += 1; lastBindOwnerArgs = args; },
    applyName: async (args) => { calls.applyName += 1; lastApplyNameArgs = args; return false; },
    applyCoreServices: async (args) => { calls.applyCoreServices += 1; lastApplyCoreServicesArgs = args; return false; },
    applyDefaultAccountingSystem: async () => { calls.applyDefaultAccountingSystem += 1; return false; },
    seedGbChart: async () => { calls.seedGbChart += 1; return { seeded: true, count: 24 }; }
  };
};

test('resolveProvisionIdentity: lowercases/trims email and extracts userId', () => {
  assert.deepEqual(resolveProvisionIdentity({ email: '  Owner@Example.COM ', userId: 'u1' }), {
    email: 'owner@example.com',
    userId: 'u1'
  });
  assert.deepEqual(resolveProvisionIdentity({}), { email: '', userId: '' });
  assert.deepEqual(resolveProvisionIdentity(null), { email: '', userId: '' });
});

test('selfProvisionClientWorkspace: auth with no email is rejected 401 (no DB work)', async () => {
  const deps = makeDeps();
  await assert.rejects(
    selfProvisionClientWorkspace({ auth: noEmailAuth, deps }),
    (err) => err.statusCode === 401 && err.code === 'PROVISION_AUTH_REQUIRED'
  );
  assert.equal(deps.calls.findOwned, 0);
  assert.equal(deps.calls.createClient, 0);
});

test('selfProvisionClientWorkspace: auth with no stable user id is rejected before DB work', async () => {
  const deps = makeDeps();
  await assert.rejects(
    selfProvisionClientWorkspace({ auth: { type: 'supabase_user', email: 'owner@example.com' }, deps }),
    (err) => err.statusCode === 401 && err.code === 'PROVISION_AUTH_REQUIRED'
  );
  assert.equal(deps.calls.findOwned, 0);
  assert.equal(deps.calls.createClient, 0);
});

test('selfProvisionClientWorkspace: an existing owner gets their workspace back, nothing created', async () => {
  const deps = makeDeps({ existing: 'client-self-abc' });
  const result = await selfProvisionClientWorkspace({ auth: ownerAuth, deps });
  assert.deepEqual(result, { clientId: 'client-self-abc', created: false });
  assert.equal(deps.calls.createClient, 0);
  assert.equal(deps.calls.bindOwner, 0);
});

test('selfProvisionClientWorkspace: a returning owner’s signup name is applied to the existing workspace', async () => {
  const deps = makeDeps({ existing: 'client-self-abc' });
  const result = await selfProvisionClientWorkspace({ auth: ownerAuth, companyName: 'Santa Barbers', deps });
  assert.deepEqual(result, { clientId: 'client-self-abc', created: false });
  assert.equal(deps.calls.createClient, 0);
  assert.equal(deps.calls.applyName, 1);
  assert.equal(deps.lastApplyNameArgs.clientId, 'client-self-abc');
  assert.equal(deps.lastApplyNameArgs.companyName, 'Santa Barbers');
});

test('selfProvisionClientWorkspace: a returning owner’s services are healed to the core intake (the bank-only bug)', async () => {
  const deps = makeDeps({ existing: 'client-self-abc' });
  await selfProvisionClientWorkspace({ auth: ownerAuth, companyName: 'Santa Barbers', deps });
  // The existing path must heal services_engaged, not only the name — a workspace
  // seeded bank-only by the pre-#679 self-serve create otherwise stays 1 tile.
  assert.equal(deps.calls.applyCoreServices, 1);
  assert.equal(deps.lastApplyCoreServicesArgs.clientId, 'client-self-abc');
  assert.equal(deps.lastApplyCoreServicesArgs.companyName, 'Santa Barbers');
  // Still the idempotent path — nothing re-created.
  assert.equal(deps.calls.createClient, 0);
});

test('needsCoreServicesHeal: heals only the incomplete legacy shapes, never a richer scope', () => {
  // Incomplete legacy shapes → heal.
  assert.equal(needsCoreServicesHeal(undefined), true); // key absent
  assert.equal(needsCoreServicesHeal(null), true); // explicit null
  assert.equal(needsCoreServicesHeal([]), true); // unscoped placeholder
  assert.equal(needsCoreServicesHeal(['bank_reconciliation']), true); // old self-serve seed
  // Already-complete or firm-set scopes → leave untouched.
  assert.equal(needsCoreServicesHeal(['bank_reconciliation', 'sales_invoicing', 'bills_and_expenses']), false);
  assert.equal(needsCoreServicesHeal(['sales_invoicing']), false);
  assert.equal(needsCoreServicesHeal(['bank_reconciliation', 'payroll']), false);
  assert.equal(needsCoreServicesHeal('bank_reconciliation'), false); // non-array junk
});

test('selfProvisionClientWorkspace: a new self-serve client is auto-scoped to the core bookkeeping intake', async () => {
  const deps = makeDeps({ existing: null });
  await selfProvisionClientWorkspace({ auth: ownerAuth, companyName: 'Santa Barbers', deps });
  assert.equal(deps.calls.createClient, 1);
  assert.deepEqual(
    deps.lastCreateProfile.services_engaged,
    ['bank_reconciliation', 'sales_invoicing', 'bills_and_expenses']
  );
  assert.equal(deps.lastCreateProfile.companyName, 'Santa Barbers');
});

test('selfProvisionClientWorkspace: a new self-serve client is born accounting_system none, never NULL (§5b(a))', async () => {
  const deps = makeDeps({ existing: null });
  await selfProvisionClientWorkspace({ auth: ownerAuth, companyName: 'Santa Barbers', deps });
  assert.equal(deps.lastCreateProfile.accounting_system, 'none');
});

test('selfProvisionClientWorkspace: a returning funnel signup heals a missing accounting_system', async () => {
  const deps = makeDeps({ existing: 'client-self-abc' });
  await selfProvisionClientWorkspace({ auth: ownerAuth, companyName: 'Santa Barbers', deps });
  assert.equal(deps.calls.applyDefaultAccountingSystem, 1);
  assert.equal(deps.calls.createClient, 0);
});

test('selfProvisionClientWorkspace: a valid jurisdiction is normalized and persisted for a new client', async () => {
  const deps = makeDeps({ existing: null });
  await selfProvisionClientWorkspace({ auth: ownerAuth, jurisdiction: ' gb ', deps });
  assert.equal(deps.lastCreateProfile.jurisdiction, 'GB');
});

test('GB signup persists canonical entity type and incorporation date, then seeds the existing chart pack', async () => {
  const deps = makeDeps({ existing: null });
  await selfProvisionClientWorkspace({ auth: ownerAuth, jurisdiction: 'GB', entityType: 'ltd', incorporationDate: '2026-07-01', deps });
  assert.equal(deps.lastCreateProfile.entityType, 'gb-ltd');
  assert.equal(deps.lastCreateProfile.incorporationDate, '2026-07-01');
  assert.equal(deps.calls.seedGbChart, 1);
});

test('GB signup refuses unknown entity types by name; FI provisioning remains unchanged', async () => {
  await assert.rejects(
    selfProvisionClientWorkspace({ auth: ownerAuth, jurisdiction: 'GB', entityType: 'partnership', deps: makeDeps() }),
    (error) => error.code === 'PROVISION_GB_ENTITY_TYPE_INVALID'
  );
  const fi = makeDeps();
  await selfProvisionClientWorkspace({ auth: ownerAuth, jurisdiction: 'FI', entityType: 'fi-oy', deps: fi });
  assert.equal(fi.lastCreateProfile.entityType, 'fi-oy');
  assert.equal(fi.calls.seedGbChart, 0);
});

test('canonical GB entity vocabulary accepts both signup labels', () => {
  assert.equal(normalizeProvisionEntityType({ jurisdiction: 'GB', entityType: 'sole_trader' }), 'gb-sole-trader');
  assert.equal(normalizeProvisionEntityType({ jurisdiction: 'GB', entityType: 'gb-ltd' }), 'gb-ltd');
  assert.equal(normalizeProvisionEntityType({ jurisdiction: 'GB', entityType: 'Limited company' }), 'gb-ltd');
  assert.equal(normalizeProvisionEntityType({ jurisdiction: 'US', entityType: 'Limited liability company' }), 'us-llc');
});

test('GB chart seeder persists the existing pack with roles once and leaves an existing chart byte-identical', async () => {
  const inserts = [];
  let hasChart = false;
  const dbClient = { query: async (sql, params = []) => {
    if (/select 1 from ledger_accounts/.test(sql)) return { rows: hasChart ? [{ '?column?': 1 }] : [] };
    if (/insert into ledger_accounts/.test(sql)) { inserts.push(params); return { rows: [] }; }
    return { rows: [] };
  } };
  const first = await seedGbDefaultChartIfEmpty({ firmId: 'f', clientId: 'c', dbClient });
  assert.equal(first.seeded, true);
  assert.equal(inserts.length, 24);
  assert.ok(inserts.some((params) => params[3] === '2220' && params[7] === 'liability.sales_tax_payable'));
  hasChart = true;
  const before = structuredClone(inserts);
  const second = await seedGbDefaultChartIfEmpty({ firmId: 'f', clientId: 'c', dbClient });
  assert.deepEqual(second, { seeded: false, count: 0 });
  assert.deepEqual(inserts, before);
});

test('a provisioned gb-sole-trader receives drawings and no corporation-tax account', async () => {
  const inserts = [];
  const dbClient = { query: async (sql, params = []) => {
    if (/select 1 from ledger_accounts/.test(sql)) return { rows: [] };
    if (/insert into ledger_accounts/.test(sql)) inserts.push(params);
    return { rows: [] };
  } };
  await seedGbDefaultChartIfEmpty({ firmId: 'f', clientId: 'sole', entityType: 'gb-sole-trader', dbClient });
  assert.ok(inserts.some((params) => params[4] === 'Owner drawings' && params[7] === 'equity.owner_drawings'));
  assert.ok(!inserts.some((params) => params[4] === 'Corporation tax payable'));
});

test('normalizeProvisionJurisdiction: malformed country codes are refused', () => {
  assert.throws(
    () => normalizeProvisionJurisdiction('GBR'),
    (error) => error.statusCode === 400 && error.code === 'PROVISION_JURISDICTION_INVALID'
  );
});

test('assertProvisionJurisdictionSupported: launch scope passes, out-of-scope refuses by name, null passes through', () => {
  assert.equal(assertProvisionJurisdictionSupported('GB'), 'GB');
  assert.equal(assertProvisionJurisdictionSupported('FI'), 'FI');
  assert.equal(assertProvisionJurisdictionSupported(null), null);
  for (const jurisdiction of ['US', 'SG', 'DE']) {
    assert.throws(
      () => assertProvisionJurisdictionSupported(jurisdiction),
      (error) => error.statusCode === 409 && error.code === 'PROVISION_JURISDICTION_UNSUPPORTED'
    );
  }
});

test('selfProvisionClientWorkspace: a declared out-of-scope jurisdiction refuses before any DB work', async () => {
  const deps = makeDeps({ existing: null });
  await assert.rejects(
    selfProvisionClientWorkspace({ auth: ownerAuth, jurisdiction: 'us', deps }),
    (error) => error.statusCode === 409 && error.code === 'PROVISION_JURISDICTION_UNSUPPORTED'
  );
  assert.equal(deps.calls.findOwned, 0);
  assert.equal(deps.calls.createClient, 0);
});

test('selfProvisionClientWorkspace: no declared jurisdiction still provisions (the cross-device no-stash path)', async () => {
  const deps = makeDeps({ existing: null });
  const result = await selfProvisionClientWorkspace({ auth: ownerAuth, jurisdiction: null, deps });
  assert.equal(result.created, true);
  assert.equal(deps.lastCreateProfile.jurisdiction, null);
});

test('selfProvisionClientWorkspace: an existing firm-set jurisdiction is never overwritten', async () => {
  const deps = makeDeps({ existing: 'client-self-abc' });
  await selfProvisionClientWorkspace({ auth: ownerAuth, jurisdiction: 'FI', deps });
  assert.equal(deps.calls.createClient, 0);
  assert.equal(deps.lastApplyNameArgs.jurisdiction, undefined);
  assert.equal(deps.lastApplyCoreServicesArgs.jurisdiction, undefined);
});

test('selfProvisionClientWorkspace: a new owner is created and bound, created=true', async () => {
  const deps = makeDeps({ existing: null });
  const result = await selfProvisionClientWorkspace({ auth: ownerAuth, deps });
  assert.equal(result.created, true);
  assert.match(result.clientId, /^client-self-[0-9a-f]{24}$/);
  assert.equal(deps.calls.createClient, 1);
  assert.equal(deps.calls.bindOwner, 1);
  assert.deepEqual(deps.lastCreateArgs.creationPrincipal, {
    principalType: 'supabase_user',
    principalId: 'user-1',
    authoritySource: 'authenticated_self_provision_route'
  });
});

test('selfProvisionClientWorkspace: the client id is deterministic from (firm, email) — idempotent on retry', async () => {
  const a = await selfProvisionClientWorkspace({ auth: ownerAuth, deps: makeDeps({ existing: null }) });
  const b = await selfProvisionClientWorkspace({
    auth: { ...ownerAuth, email: 'owner@example.com' },
    deps: makeDeps({ existing: null })
  });
  assert.equal(a.clientId, b.clientId);
});

// ─── F-4: this bootstrap endpoint must not be a firm-binding or privilege
//         tool ────────────────────────────────────────────────────────────
//
// /self-provision and /provision-workspace are deliberately reachable without
// a membership check (a new owner has none). That made the request body the
// only thing naming a firm, and the sole guard — assertFirmScopeAllowed — is a
// demo-firm isolation check that returns true for every real firm id, not an
// authorization check. Both routes funnel through
// selfProvisionClientWorkspace, so these pin the fix at the one chokepoint.

test('F-4: a caller-supplied firm_id that is not the configured firm is refused, with no DB work', async () => {
  const deps = makeDeps({ existing: null });
  await assert.rejects(
    selfProvisionClientWorkspace({ firmId: 'firm-victim', auth: ownerAuth, deps }),
    (err) =>
      err instanceof ProvisionFirmScopeError &&
      err.statusCode === 403 &&
      err.code === 'PROVISION_FIRM_NOT_ALLOWED'
  );
  // Refused before ANYTHING touches the victim firm — no probe, no client, no bind.
  assert.equal(deps.calls.findOwned, 0);
  assert.equal(deps.calls.createClient, 0);
  assert.equal(deps.calls.bindOwner, 0);
  assert.equal(deps.calls.assertBindable, 0);
});

test('F-4: a firm_id equal to the configured firm is accepted (the funnel keeps working)', async () => {
  const deps = makeDeps({ existing: null });
  const result = await selfProvisionClientWorkspace({ firmId: 'firm-donna', auth: ownerAuth, deps });
  assert.equal(result.created, true);
  assert.equal(deps.calls.createClient, 1);
});

test('F-4: an absent firm_id resolves to the configured firm, threaded into every write', async () => {
  const deps = makeDeps({ existing: null });
  await selfProvisionClientWorkspace({ auth: ownerAuth, deps });
  // Every downstream call gets the RESOLVED firm — a null would silently mint
  // different deterministic ids than the configured firm's.
  assert.equal(deps.lastFindOwnedArgs.firmId, 'firm-donna');
  assert.equal(deps.lastCreateArgs.firmId, 'firm-donna');
  assert.equal(deps.lastBindOwnerArgs.firmId, 'firm-donna');
});

test('F-4: the demo-firm guard runs on the RESOLVED firm, not the caller-supplied one', async () => {
  // Naming an arbitrary firm id used to route around assertFirmScopeAllowed's
  // production demo-firm refusal, because the guard was handed the caller's
  // value. It is now handed a value the caller cannot influence.
  const deps = makeDeps({ existing: null });
  await selfProvisionClientWorkspace({ auth: ownerAuth, deps });
  assert.deepEqual(deps.scopeChecked, ['firm-donna']);
});

test('F-4: a conflicting principal is refused BEFORE the client row is created (no orphan)', async () => {
  const deps = makeDeps({
    existing: null,
    bindableError: new ProvisionPrincipalConflictError('owner@example.com')
  });
  await assert.rejects(
    selfProvisionClientWorkspace({ auth: ownerAuth, deps }),
    (err) => err.statusCode === 409 && err.code === 'PROVISION_PRINCIPAL_CONFLICT'
  );
  assert.equal(deps.calls.assertBindable, 1);
  // Ordering is the point: a refusal after createClient would leave a durable,
  // inaccessible orphan client (the F-35 failure mode).
  assert.equal(deps.calls.createClient, 0);
  assert.equal(deps.calls.bindOwner, 0);
});

// ownerRowIsAdoptable is the whole privilege boundary for the collaborator
// upsert. The old `on conflict do update set role = excluded.role,
// status = 'active'` answered "always adoptable", which turned a
// membership-free endpoint into a privilege grant.
test('F-4: ownerRowIsAdoptable — a clean insert and this owner’s own row are adoptable', () => {
  const own = { id: 'c1', role: 'owner', status: 'active', access_level: 'client_scoped' };
  assert.equal(ownerRowIsAdoptable(null, { userId: 'user-1' }), true, 'no row → clean insert');
  assert.equal(
    ownerRowIsAdoptable({ ...own, user_id: null }, { userId: 'user-1' }), true,
    'an unbound owner row is the ordinary invite / first-login claim'
  );
  assert.equal(
    ownerRowIsAdoptable({ ...own, user_id: 'user-1' }, { userId: 'user-1' }), true,
    'the same identity re-provisioning must still converge (retry idempotency)'
  );
});

test('F-4: ownerRowIsAdoptable — refuses every escalation shape', () => {
  const base = { id: 'c1', role: 'owner', status: 'active', access_level: 'client_scoped', user_id: null };
  assert.equal(
    ownerRowIsAdoptable({ ...base, role: 'bookkeeper' }, { userId: 'user-1' }), false,
    'a limited collaborator must never be elevated to owner'
  );
  assert.equal(
    ownerRowIsAdoptable({ ...base, status: 'suspended' }, { userId: 'user-1' }), false,
    'a suspended principal must never be reactivated by hitting signup'
  );
  assert.equal(
    ownerRowIsAdoptable({ ...base, status: 'inactive' }, { userId: 'user-1' }), false,
    'any non-active status is a deliberate administrative state'
  );
  assert.equal(
    ownerRowIsAdoptable({ ...base, access_level: 'unrestricted' }, { userId: 'user-1' }), false,
    'scope must never widen through this path'
  );
  assert.equal(
    ownerRowIsAdoptable({ ...base, user_id: 'someone-else' }, { userId: 'user-1' }), false,
    "a row bound to another identity is not this caller's to claim"
  );
  // The auth lookup matches a collaborator by user_id OR email, so adopting a
  // row bound to a different user_id would leave BOTH identities resolving it.
  assert.equal(
    ownerRowIsAdoptable({ ...base, user_id: 'someone-else' }, { userId: '' }), false,
    'an anonymous claim of a bound row is refused too'
  );
});
