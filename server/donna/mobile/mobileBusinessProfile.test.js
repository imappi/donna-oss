// DB-free tests for the owner's business profile (PUT …/onboarding/profile):
// the contract's request rules enforced on the server, the stored facts
// projected as a conforming BusinessProfile / Entity, and the handler's result
// and receipt against the pinned contract. All values are synthetic. The
// PostgreSQL lifecycle is mobileBusinessProfilePgLifecycle.test.js.
import assert from 'node:assert/strict';
import test from 'node:test';

import { responseSchemaFor, validateAgainst } from './contractSchema.js';
import { confirmBusinessProfile } from './mobileBusinessProfile.js';
import { isEmptyFacts, parseProfileConfirmation, projectBusinessProfile, sameFacts } from './mobileBusinessProfileFacts.js';
import { projectEntity } from './mobileProjection.js';

const component = (name) => ({ $ref: `#/components/schemas/${name}` });
const ok = (value, schema, label) => assert.deepEqual(validateAgainst(value, schema), [], label);

const valid = (overrides = {}) => ({
  owner_name: 'Fixture Owner',
  business_name: 'Fixture Tiling Oy',
  description: 'Bathroom tiling for homes.',
  operating_area: 'Fixture region',
  profession: 'Tiler',
  billing_basis: 'Hourly, 55 EUR per hour plus materials',
  experience: '',
  business_address: 'Fixture street 1',
  people_involved: ['A helper on big jobs', ' '],
  payment_methods: ['Bank transfer'],
  spending_categories: ['Tools', 'Van'],
  confirmed_exact_fields: ['owner_name', 'business_name'],
  ...overrides
});

const refused = (body, code = 'PROFILE_INVALID') => assert.throws(() => parseProfileConfirmation(body), (error) => {
  assert.equal(error.statusCode, 400);
  assert.equal(error.code, code);
  return true;
});

test('a valid confirmation parses to trimmed facts; empty optional facts and blank list entries are absent', () => {
  const parsed = parseProfileConfirmation(valid({ owner_name: '  Fixture Owner ', stray_key: 'ignored' }));
  assert.equal(parsed.ownerName, 'Fixture Owner');
  assert.equal(parsed.businessName, 'Fixture Tiling Oy');
  assert.deepEqual(parsed.facts, {
    description: 'Bathroom tiling for homes.',
    operating_area: 'Fixture region',
    profession: 'Tiler',
    billing_basis: 'Hourly, 55 EUR per hour plus materials',
    business_address: 'Fixture street 1',
    people_involved: ['A helper on big jobs'],
    payment_methods: ['Bank transfer'],
    spending_categories: ['Tools', 'Van']
  });
  assert.ok(!('experience' in parsed.facts), 'an empty optional fact is not stored as ""');
  assert.ok(!('stray_key' in parsed.facts) && !('business_name' in parsed.facts), 'identity names are not profile facts');
  ok(projectBusinessProfile(parsed.facts), component('BusinessProfile'), 'facts project to a BusinessProfile');
});

test('the request schema is enforced on the server: required keys, types, lengths, list bounds', () => {
  for (const key of ['owner_name', 'business_name', 'description', 'operating_area', 'people_involved', 'payment_methods', 'spending_categories', 'confirmed_exact_fields']) {
    const body = valid();
    delete body[key];
    refused(body);
  }
  refused(null);
  refused([]);
  refused(valid({ owner_name: '' }));
  refused(valid({ owner_name: '   ' }));
  refused(valid({ business_name: '' }));
  refused(valid({ owner_name: 'x'.repeat(121) }));
  refused(valid({ business_name: 'x'.repeat(161) }));
  refused(valid({ description: 'x'.repeat(601) }));
  refused(valid({ operating_area: 'x'.repeat(241) }));
  for (const key of ['profession', 'billing_basis', 'experience', 'business_address']) {
    refused(valid({ [key]: 'x'.repeat(241) }));
    refused(valid({ [key]: 7 }));
  }
  refused(valid({ description: 5 }));
  refused(valid({ people_involved: 'Someone' }));
  refused(valid({ payment_methods: Array.from({ length: 21 }, (_, i) => `m${i}`) }));
  refused(valid({ spending_categories: ['x'.repeat(121)] }));
  refused(valid({ spending_categories: [3] }));
  // Code points, not UTF-16 units, as JSON Schema counts: 120 emoji are fine.
  assert.equal(parseProfileConfirmation(valid({ owner_name: '😀'.repeat(120) })).ownerName.length, 240);
  assert.doesNotThrow(() => parseProfileConfirmation(valid({ description: 'x'.repeat(600) })));
});

test('both exact identity fields must be explicitly confirmed', () => {
  refused(valid({ confirmed_exact_fields: [] }), 'PROFILE_EXACT_CONFIRMATION_REQUIRED');
  refused(valid({ confirmed_exact_fields: ['owner_name'] }), 'PROFILE_EXACT_CONFIRMATION_REQUIRED');
  refused(valid({ confirmed_exact_fields: ['business_name'] }), 'PROFILE_EXACT_CONFIRMATION_REQUIRED');
  refused(valid({ confirmed_exact_fields: ['owner_name', 'business_name', 'owner_name'] }));
  refused(valid({ confirmed_exact_fields: ['owner_name', 'business_name', 'description'] }));
  refused(valid({ confirmed_exact_fields: 'owner_name,business_name' }));
});

test('stored facts project defensively; nothing declared is null', () => {
  assert.equal(projectBusinessProfile(null), null);
  assert.equal(projectBusinessProfile([]), null);
  const projected = projectBusinessProfile({ description: 4, profession: '', billing_basis: 'Fixed price', people_involved: ['A', 2], unknown: 'x' });
  assert.deepEqual(projected, {
    description: '', operating_area: '', billing_basis: 'Fixed price',
    people_involved: ['A'], payment_methods: [], spending_categories: []
  });
  ok(projected, component('BusinessProfile'));
  assert.ok(sameFacts({ operating_area: 'A', description: 'B' }, { description: 'B', operating_area: 'A', experience: '' }));
  assert.ok(!sameFacts({ description: 'B' }, { description: 'C' }));
  assert.ok(isEmptyFacts(parseProfileConfirmation(valid({ description: '', operating_area: '', profession: '', billing_basis: '', business_address: '',
    people_involved: [' '], payment_methods: [], spending_categories: [] })).facts));
  assert.ok(!isEmptyFacts({ spending_categories: ['Tools'] }));
});

test('Entity carries business_profile from the persisted facts and null before any declaration', () => {
  const row = { id: 'client-fixture', company_name: 'Fixture Tiling Oy', entity_type: 'fi-oy', jurisdiction: 'FI', profile_currency: 'EUR' };
  const before = projectEntity(row);
  assert.equal(before.business_profile, null);
  ok(before, component('Entity'));
  const after = projectEntity({ ...row, business_profile_facts: parseProfileConfirmation(valid()).facts });
  assert.equal(after.business_profile.profession, 'Tiler');
  assert.equal(after.display_name, 'Fixture Tiling Oy');
  ok(after, component('Entity'));
});

test('the handler returns the contract result with a receipt naming the audit rows the writer committed', async () => {
  const ctx = {
    firmId: 'firm-fixture', clientId: 'client-fixture',
    principal: { principalType: 'firm_collaborator', principalId: 'collab-fixture', role: 'owner' },
    auth: { type: 'supabase_user', userId: 'user-fixture', email: 'owner@fixture.example' },
    identity: { userId: 'user-fixture', email: 'owner@fixture.example' }
  };
  const calls = [];
  const declare = async (args) => {
    calls.push(args);
    return { ownerChanged: true, factsChanged: true, revision: 1,
      auditRows: [{ id: '41', created_at: new Date('2026-11-10T09:00:00Z') }, { id: '42', created_at: new Date('2026-11-10T09:00:00Z') }] };
  };
  const read = async () => [{ id: 'client-fixture', company_name: 'Fixture Tiling Oy', jurisdiction: 'FI',
    business_profile_facts: calls[0].facts }];
  const result = await confirmBusinessProfile(ctx, valid(), { declare, read });
  ok(result, responseSchemaFor('/entities/{entityId}/onboarding/profile', 'PUT', 200), 'the 200 body conforms');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].principal, ctx.principal, 'the writer acts as the resolved owner principal');
  assert.equal(calls[0].auth, ctx.auth);
  assert.equal(result.principal.display_name, 'Fixture Owner');
  assert.equal(result.principal.email, 'owner@fixture.example');
  assert.deepEqual(result.receipt.audit_event_ids, ['41', '42']);
  assert.deepEqual(result.receipt.changes, [
    { target: 'principal:collab-fixture', applied: true, error: null },
    { target: 'entity:client-fixture', applied: true, error: null }
  ]);
  assert.deepEqual(result.receipt.actor, { type: 'owner', terminal: 'mobile' });

  const unchanged = await confirmBusinessProfile(ctx, valid(), {
    declare: async () => ({ ownerChanged: false, factsChanged: false, revision: 1, auditRows: [] }), read
  });
  ok(unchanged, responseSchemaFor('/entities/{entityId}/onboarding/profile', 'PUT', 200));
  assert.deepEqual(unchanged.receipt.audit_event_ids, [], 'nothing applied, nothing receipted');
  assert.ok(unchanged.receipt.changes.every((change) => change.applied === false));

  // An invalid body never reaches the writer.
  await assert.rejects(confirmBusinessProfile(ctx, valid({ confirmed_exact_fields: [] }), {
    declare: async () => assert.fail('the writer must not run'), read
  }), { code: 'PROFILE_EXACT_CONFIRMATION_REQUIRED' });
});
