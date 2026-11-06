// roleAuthority.test.js — S1 of the bench (docs/design-donna-specialist-roles.md
// §5): the ONE converged role/authority decision (INV-S2) and its staged
// enforcement postures. Pure in-sandbox `node --test`.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  SPECIALIST_ROLE_FLAG_KEY,
  decideRoleAction,
  gateRoleSurfaceOperation,
  roleForActionIdentity,
  specialistRoleGateMode,
  recordRoleWouldBlock
} from './roleAuthority.js';
import { authorizeActionType } from '../operatorCapability.js';
import { findRoleDefinition } from './roleRegistry.js';

test('the flag key is the config-plane name (never an env pair)', () => {
  assert.equal(SPECIALIST_ROLE_FLAG_KEY, 'SPECIALIST_ROLE_ENFORCE');
});

test('with no role, the decision reduces byte-identically to the capability verdict (the chat seam today)', () => {
  for (const [actionType, capabilityClass] of [
    ['apply_category', 'reviewer'],
    ['sync_to_accounting', 'reviewer'],
    ['sync_to_accounting', 'founder'],
    ['reverse_apply', 'reviewer'],
    ['drop_all_tables', 'founder']
  ]) {
    const converged = decideRoleAction({ actionType, roleId: null, capabilityClass });
    const capability = authorizeActionType({ actionType, capabilityClass });
    assert.equal(converged.allowed, capability.allowed, `${actionType}/${capabilityClass}`);
    assert.deepEqual(converged.capability, capability);
    assert.equal(converged.role_allowed, null, 'leash not applicable without a role');
  }
});

test('role leash: an identity inside the action_set passes; outside denies with a named reason', () => {
  const pass = decideRoleAction({ actionType: 'issue_invoice', roleId: 'invoicing_collections' });
  assert.equal(pass.allowed, true);
  assert.equal(pass.role_allowed, true);
  assert.deepEqual(pass.reasons, []);
  // The role's own capability_class is the effective class when none is passed.
  assert.equal(pass.capability.capability_class, findRoleDefinition('invoicing_collections').capability_class);

  const deny = decideRoleAction({ actionType: 'send_payable_notice', roleId: 'invoicing_collections' });
  assert.equal(deny.allowed, false);
  assert.equal(deny.role_allowed, false);
  assert.ok(deny.reasons.includes('outside_role_action_set'));
});

test('role leash fail-closes on an unknown role and on a non-canonical identity', () => {
  const unknownRole = decideRoleAction({ actionType: 'issue_invoice', roleId: 'gremlin' });
  assert.equal(unknownRole.allowed, false);
  assert.ok(unknownRole.reasons.includes('unknown_role'));

  const unknownVerb = decideRoleAction({ actionType: 'not_a_verb', roleId: 'invoicing_collections' });
  assert.equal(unknownVerb.allowed, false);
  assert.equal(unknownVerb.in_namespace, false);
  assert.ok(unknownVerb.reasons.includes('outside_canonical_namespace'));
});

test('the capability dimension binds the occupant too: a role class below the verb requirement denies', () => {
  // graduate_earned_auto is founder-only; even if a (hypothetical) reviewer
  // context tried it, the capability half of the ONE decision refuses.
  const denied = decideRoleAction({ actionType: 'graduate_earned_auto', roleId: null, capabilityClass: 'reviewer' });
  assert.equal(denied.allowed, false);
  assert.ok(denied.reasons.includes('requires_founder_capability'));
});

test('attribution derives from the unique action_set claim; unclaimed identities are Donna core', () => {
  assert.equal(roleForActionIdentity('issue_invoice'), 'invoicing_collections');
  assert.equal(roleForActionIdentity('send_receivable_reminder'), 'invoicing_collections');
  assert.equal(roleForActionIdentity('create_pay_link'), 'invoicing_collections');
  assert.equal(roleForActionIdentity('record_reply_correction'), 'invoicing_collections');
  assert.equal(roleForActionIdentity('post_inventory_journal'), 'inventory_purchasing');
  // AP is deliberately nobody's role; authority promotion may never be claimed.
  assert.equal(roleForActionIdentity('send_payable_notice'), null);
  assert.equal(roleForActionIdentity('graduate_earned_auto'), null);
  assert.equal(roleForActionIdentity('reverse_apply'), null);
});

test('gate mode: off/dry_run are off; shadow observes; canary/auto act; envFallback is false (born dormant)', () => {
  const snap = (stage) => ({ [SPECIALIST_ROLE_FLAG_KEY]: { stage, source: 'test' } });
  assert.equal(specialistRoleGateMode({ snapshot: null, env: {} }), 'off');
  assert.equal(specialistRoleGateMode({ snapshot: {}, env: {} }), 'off');
  assert.equal(specialistRoleGateMode({ snapshot: snap('off'), env: {} }), 'off');
  assert.equal(specialistRoleGateMode({ snapshot: snap('dry_run'), env: {} }), 'off');
  assert.equal(specialistRoleGateMode({ snapshot: snap('shadow'), env: {} }), 'shadow');
  assert.equal(specialistRoleGateMode({ snapshot: snap('canary'), env: {} }), 'act');
  assert.equal(specialistRoleGateMode({ snapshot: snap('auto'), env: {} }), 'act');
  // The kill switch may only ever force OFF.
  assert.equal(specialistRoleGateMode({
    snapshot: snap('canary'), env: { CLIENT_CONFIG_FORCE_DISABLE: SPECIALIST_ROLE_FLAG_KEY }
  }), 'off');
});

test('gateRoleSurfaceOperation: allowed proceeds silently; the unclaimed identities stay on Donna core', async () => {
  const snap = (stage) => ({ [SPECIALIST_ROLE_FLAG_KEY]: { stage, source: 'test' } });
  const warnings = [];
  const logger = { warn: (...args) => warnings.push(args.join(' ')) };
  const queries = [];
  const query = async (sql, params) => { queries.push({ sql, params }); return { rows: [] }; };

  // The whole audited surface passes today: zero logging, zero queries even
  // at an acting stage — this is exactly the audit's success criterion.
  for (const actionType of [
    'create_pay_link', 'record_reply_correction', 'capture_structured_reference',
    'graduate_earned_auto', 'send_payable_notice'
  ]) {
    const ok = await gateRoleSurfaceOperation({
      actionType, snapshot: snap('canary'), env: {},
      seam: 'outbound_sweep', firmId: 'f', clientId: 'c', logger, query
    });
    assert.equal(ok.proceed, true, actionType);
    assert.equal(ok.wouldBlock, false, actionType);
  }
  assert.equal(warnings.length, 0);
  assert.equal(queries.length, 0);
});

test('gateRoleSurfaceOperation denial postures: act refuses; shadow logs + receipts; off logs only', async () => {
  const snap = (stage) => ({ [SPECIALIST_ROLE_FLAG_KEY]: { stage, source: 'test' } });
  const denyFn = () => ({
    action_type: 'create_pay_link', role_id: 'invoicing_collections',
    allowed: false, role_allowed: false, reasons: ['outside_role_action_set']
  });
  const run = async (snapshot) => {
    const warnings = [];
    const queries = [];
    const result = await gateRoleSurfaceOperation({
      actionType: 'create_pay_link', snapshot, env: {}, seam: 'outbound_sweep',
      firmId: 'f', clientId: 'c',
      logger: { warn: (...args) => warnings.push(args.join(' ')) },
      query: async (sql, params) => { queries.push({ sql, params }); return { rows: [] }; },
      decisionFn: denyFn
    });
    return { result, warnings, queries };
  };

  const acting = await run(snap('canary'));
  assert.equal(acting.result.proceed, false, 'an acting stage refuses');
  assert.equal(acting.queries.length, 0);

  const shadow = await run(snap('shadow'));
  assert.equal(shadow.result.proceed, true);
  assert.equal(shadow.result.wouldBlock, true);
  assert.equal(shadow.warnings.length, 1, 'shadow logs the would-block');
  assert.equal(shadow.queries.length, 1, 'shadow receipts the would-block');
  assert.ok(shadow.queries[0].sql.includes('specialist_role.would_block'));
  assert.ok(shadow.queries[0].params[3].includes('outside_role_action_set'));

  const off = await run({});
  assert.equal(off.result.proceed, true);
  assert.equal(off.result.wouldBlock, true);
  assert.equal(off.warnings.length, 1, 'off still logs the would-block');
  assert.equal(off.queries.length, 0, 'off writes no receipt');
});

test('recordRoleWouldBlock is best-effort: a failing insert warns and returns false, never throws', async () => {
  const warnings = [];
  const result = await recordRoleWouldBlock({
    query: async () => { throw new Error('db down'); },
    firmId: 'f', clientId: 'c', seam: 'chat_apply',
    decision: { action_type: 'issue_invoice', reasons: [] },
    warn: (...args) => warnings.push(args.join(' '))
  });
  assert.equal(result, false);
  assert.equal(warnings.length, 1);
  // And a missing query fn is a silent no-op false, not a throw.
  assert.equal(await recordRoleWouldBlock({ firmId: 'f', decision: {} }), false);
});
