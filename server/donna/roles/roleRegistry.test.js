// roleRegistry.test.js — S0 of the bench (docs/design-donna-specialist-roles.md §5).
// Pins INV-S2(a)/(c) against the S0 canonical namespace, the safe-default
// emptiness of unaudited action sets, and the RoleAssignment shape law
// (INV-S10 at the data level). Pure in-sandbox `node --test`.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  AI_PROFILES,
  ASSIGNMENT_STATUSES,
  ACTOR_TYPES,
  ROLE_DEFINITIONS,
  canonicalActionNamespace,
  findRoleDefinition,
  validateRoleAssignment,
  validateRoleRegistry
} from './roleRegistry.js';
import { registryVerbs } from '../accountingMutationRegistry.js';
import { OUTBOUND_ACTION_TYPES } from '../outbound/actionGate.js';
import { SURFACE_OPERATION_TYPES } from './roleActionSurface.js';

test('registry validates clean', () => {
  assert.deepEqual(validateRoleRegistry(), []);
});

test('INV-S2(a): every role verb lives inside the canonical namespace', () => {
  const namespace = new Set(canonicalActionNamespace());
  for (const role of ROLE_DEFINITIONS) {
    for (const verb of role.action_set) {
      assert.ok(namespace.has(verb), `${role.id}: '${verb}' outside the namespace`);
    }
  }
});

test('INV-S2(c): the union of role action sets does not widen the namespace', () => {
  const namespace = new Set(canonicalActionNamespace());
  const union = new Set(ROLE_DEFINITIONS.flatMap((role) => role.action_set));
  for (const verb of union) {
    assert.ok(namespace.has(verb), `union verb '${verb}' would widen the namespace`);
  }
  // And the namespace derives ONLY from the known seams — roles never add to
  // it. Since S1 the third seam component is the coverage audit's surface
  // operations (roleActionSurface.js).
  const seams = new Set([...registryVerbs(), ...OUTBOUND_ACTION_TYPES, ...SURFACE_OPERATION_TYPES]);
  assert.deepEqual([...namespace].sort(), [...seams].sort());
});

test('the tax role stays verbless until the S1 coverage audit names its verbs', () => {
  // Deliberate pin: an empty action_set means the role can mutate NOTHING —
  // the safe default. Growing it must edit this test in the same commit, so
  // the growth is a decision, not a drift.
  assert.deepEqual(findRoleDefinition('tax').action_set, []);
});

test('role ids are unique and each default AI profile resolves', () => {
  const ids = ROLE_DEFINITIONS.map((role) => role.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const role of ROLE_DEFINITIONS) {
    assert.ok(AI_PROFILES[role.default_ai_profile], `${role.id}: unresolved AI profile`);
  }
  const personas = Object.values(AI_PROFILES).map((p) => p.persona);
  assert.equal(new Set(personas).size, personas.length, 'persona names must be unique');
});

test('no AI profile picks its own model: model policy stays lane_qualified', () => {
  // Free per-agent model choice is a rejected alternative (§9); models resolve
  // per-lane through the descent ladder's qualified sets.
  for (const [key, profile] of Object.entries(AI_PROFILES)) {
    assert.equal(profile.model_policy, 'lane_qualified', `${key} must not carry its own model choice`);
  }
});

test('a valid assignment passes; the shape law rejects the known violations', () => {
  const valid = {
    role: 'invoicing_collections',
    occupant: 'donna_ai',
    actor_type: 'ai',
    ai_profile: 'clara',
    scope: { client_id: 'client-1' },
    grants: [],
    status: 'proposed'
  };
  assert.deepEqual(validateRoleAssignment(valid), []);

  // Fresh hire with zero grants is the EXPECTED state (INV-S10).
  assert.deepEqual(validateRoleAssignment({ ...valid, status: 'active' }), []);

  // A grant without an authority basis is invalid at the shape level.
  const baseless = validateRoleAssignment({
    ...valid,
    grants: [{ kind: 'standing_send_authority' }]
  });
  assert.ok(baseless.some((p) => p.includes('authority_basis')));

  // With a basis it passes.
  assert.deepEqual(validateRoleAssignment({
    ...valid,
    grants: [{ kind: 'standing_send_authority', authority_basis: 'owner_grant_123' }]
  }), []);

  assert.ok(validateRoleAssignment({ ...valid, role: 'nope' }).length > 0);
  assert.ok(validateRoleAssignment({ ...valid, actor_type: 'bot' }).length > 0);
  assert.ok(validateRoleAssignment({ ...valid, status: 'parked' }).length > 0);

  // Persona belongs to AI occupants only.
  const humanWithPersona = validateRoleAssignment({
    ...valid, actor_type: 'human', occupant: 'collab-mei', ai_profile: 'clara'
  });
  assert.ok(humanWithPersona.some((p) => p.includes('human occupant')));
  assert.deepEqual(validateRoleAssignment({
    ...valid, actor_type: 'human', occupant: 'collab-mei', ai_profile: undefined
  }), []);
});

test('assignment vocabulary is the closed §1 set', () => {
  assert.deepEqual([...ACTOR_TYPES], ['ai', 'human']);
  assert.deepEqual([...ASSIGNMENT_STATUSES], ['proposed', 'active', 'suspended', 'ended']);
});

test('S5: event_interests are REGISTERED loop-event ids, and collections declares its lane events', async () => {
  // The S5 wiring law: an event interest is a trigger id registered in the
  // loop event registry — never an invented name (validateRoleRegistry
  // refuses unregistered ids; 'registry validates clean' above exercises it).
  const { LOOP_EVENT_REGISTRY } = await import('../loopEventRegistry.js');
  for (const role of ROLE_DEFINITIONS) {
    for (const interest of role.event_interests) {
      assert.ok(LOOP_EVENT_REGISTRY[interest], `${role.id}: '${interest}' is not a registered loop event`);
    }
  }
  assert.deepEqual(
    [...findRoleDefinition('invoicing_collections').event_interests].sort(),
    ['role.handed_to_owner', 'role.resumed_from_owner']
  );
  // Verbless / parked lanes declare no interests until their loops exist.
  assert.deepEqual(findRoleDefinition('tax').event_interests, []);
  assert.deepEqual(findRoleDefinition('inventory_purchasing').event_interests, []);
});

test('S4: every AI profile carries a non-empty role_prompt voice', () => {
  // The role_prompt is the occupant's VOICE only — authority lives on the
  // plane, truth in the shared context (INV-S3). It must exist (S4 shipped
  // the personas speaking) and must not smuggle authority words in.
  for (const [key, profile] of Object.entries(AI_PROFILES)) {
    assert.equal(typeof profile.role_prompt, 'string', `${key} has a role_prompt`);
    assert.ok(profile.role_prompt.trim().length > 0, `${key} role_prompt is non-empty`);
    assert.ok(
      !/\b(authoriz|approve|post unattended|without approval)\b/i.test(profile.role_prompt),
      `${key} role_prompt must not claim authority`
    );
  }
});
