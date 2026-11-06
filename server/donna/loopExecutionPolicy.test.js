// Tests for the Loops execution gate — graduation tiers + firm/case suspension
// (goal-first uplift, design §10 Step 6 / §13.8). Pure / node --test only — no DB,
// no Inngest, no LLM. Covers the monotone tier ladder, the action-taxonomy gate,
// the firm/case suspension kill switch, and the single-step graduation rule.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  EXECUTION_TIERS,
  tierRank,
  tierAtLeast,
  RUN_ACTIONS,
  V1_FORBIDDEN_ACTIONS,
  GRANT_GATED_ACTIONS,
  resolveAutonomy,
  AUTHORITY_ACTOR_TYPES,
  isAuthority,
  SUSPENSION_SCOPES,
  buildSuspension,
  decideExecution,
  decideGraduation,
  nextTier
} from './loopExecutionPolicy.js';

// ---- the tier ladder ------------------------------------------------------

test('EXECUTION_TIERS is the monotone off<shadow<canary<active ladder', () => {
  assert.deepEqual(EXECUTION_TIERS, ['off', 'shadow', 'canary', 'active']);
  assert.equal(tierRank('off'), 0);
  assert.equal(tierRank('active'), 3);
});

test('tierAtLeast compares by rank; unknown tier throws', () => {
  assert.equal(tierAtLeast('active', 'shadow'), true);
  assert.equal(tierAtLeast('shadow', 'shadow'), true);
  assert.equal(tierAtLeast('off', 'shadow'), false);
  assert.throws(() => tierRank('bogus'), /unknown execution tier/);
  assert.throws(() => tierAtLeast('shadow', 'bogus'), /unknown execution tier/);
});

// ---- the action taxonomy --------------------------------------------------

test('RUN_ACTIONS and V1_FORBIDDEN_ACTIONS are disjoint', () => {
  for (const a of V1_FORBIDDEN_ACTIONS) assert.equal(RUN_ACTIONS.includes(a), false);
  assert.ok(RUN_ACTIONS.includes('goal_report_only'));
  assert.ok(V1_FORBIDDEN_ACTIONS.includes('accounting_state_mutation'));
});

test('resolveAutonomy: each tier maps to its level + action set', () => {
  assert.deepEqual(resolveAutonomy('off'), { level: 'none', allowedActions: [] });

  const shadow = resolveAutonomy('shadow');
  assert.equal(shadow.level, 'shadow');
  assert.deepEqual(shadow.allowedActions, ['goal_report_only', 'noop_escalation']);

  // canary and active share the same capability — canary is a scope, not a power.
  assert.deepEqual(resolveAutonomy('canary'), resolveAutonomy('active'));
  assert.equal(resolveAutonomy('active').level, 'autonomous');
  assert.deepEqual(resolveAutonomy('active').allowedActions, RUN_ACTIONS);
});

test('resolveAutonomy returns fresh arrays (no shared mutable state)', () => {
  const a = resolveAutonomy('active');
  a.allowedActions.push('tampered');
  assert.equal(resolveAutonomy('active').allowedActions.includes('tampered'), false);
});

// ---- suspension construction ----------------------------------------------

test('isAuthority knows the authority vocabulary; an owner is not an authority', () => {
  assert.deepEqual(AUTHORITY_ACTOR_TYPES, ['firm_operator', 'accountant', 'admin', 'system']);
  assert.equal(isAuthority('firm_operator'), true);
  assert.equal(isAuthority('client'), false);
  assert.equal(isAuthority(undefined), false);
});

test('buildSuspension: an authority can suspend; the receipt is frozen', () => {
  const s = buildSuspension({ scope: 'firm', reason: 'billing lapsed', actorType: 'admin', actorId: 'u1' });
  assert.equal(s.scope, 'firm');
  assert.equal(s.authorizedByActorType, 'admin');
  assert.equal(s.authorizedByActorId, 'u1');
  assert.throws(() => { s.reason = 'mutated'; }, TypeError); // frozen
  assert.deepEqual(SUSPENSION_SCOPES, ['firm', 'case']);
});

test('buildSuspension: rejects an owner, a bad scope, and a missing reason', () => {
  assert.throws(() => buildSuspension({ scope: 'firm', reason: 'x', actorType: 'client' }), /authority required/);
  assert.throws(() => buildSuspension({ scope: 'planet', reason: 'x', actorType: 'admin' }), /scope must be one of/);
  assert.throws(() => buildSuspension({ scope: 'case', actorType: 'admin' }), /reason is required/);
});

// ---- decideExecution: the gate --------------------------------------------

test('decideExecution: tier off (the default) blocks the run', () => {
  const d = decideExecution();
  assert.equal(d.allowed, false);
  assert.equal(d.blockedReason, 'tier_off');
  assert.equal(d.autonomyLevel, 'none');
  assert.deepEqual(d.allowedActions, []);
});

test('decideExecution: shadow runs observe-only; active runs autonomous', () => {
  const shadow = decideExecution({ tier: 'shadow' });
  assert.equal(shadow.allowed, true);
  assert.equal(shadow.autonomyLevel, 'shadow');
  assert.deepEqual(shadow.allowedActions, ['goal_report_only', 'noop_escalation']);

  const active = decideExecution({ tier: 'active' });
  assert.equal(active.allowed, true);
  assert.equal(active.autonomyLevel, 'autonomous');
  assert.deepEqual(active.allowedActions, RUN_ACTIONS);
});

test('decideExecution: a firm suspension overrides even an active tier', () => {
  const susp = buildSuspension({ scope: 'firm', reason: 'paused', actorType: 'firm_operator' });
  const d = decideExecution({ tier: 'active', firmSuspension: susp });
  assert.equal(d.allowed, false);
  assert.equal(d.blockedReason, 'firm_suspended');
  assert.equal(d.suspension, susp);
  assert.equal(d.autonomyLevel, 'none');
});

test('decideExecution: a case suspension blocks; firm wins when both are set', () => {
  const caseS = buildSuspension({ scope: 'case', reason: 'under review', actorType: 'accountant' });
  const d = decideExecution({ tier: 'active', caseSuspension: caseS });
  assert.equal(d.blockedReason, 'case_suspended');

  const firmS = buildSuspension({ scope: 'firm', reason: 'firm off', actorType: 'admin' });
  const both = decideExecution({ tier: 'active', firmSuspension: firmS, caseSuspension: caseS });
  assert.equal(both.blockedReason, 'firm_suspended'); // broadest fact wins
  assert.equal(both.suspension, firmS);
});

test('decideExecution: a bare boolean is accepted as a kill switch', () => {
  const d = decideExecution({ tier: 'active', firmSuspension: true });
  assert.equal(d.allowed, false);
  assert.equal(d.blockedReason, 'firm_suspended');
  assert.equal(d.suspension.reason, 'suspended');
});

test('decideExecution: a workflow action needs at least an autonomous tier', () => {
  const inShadow = decideExecution({ tier: 'shadow', requestedAction: 'workflow_mutation' });
  assert.equal(inShadow.allowed, true);            // the run itself may execute
  assert.equal(inShadow.actionAllowed, false);     // but not THIS action
  assert.equal(inShadow.actionBlockedReason, 'tier_too_low');

  const inActive = decideExecution({ tier: 'active', requestedAction: 'workflow_mutation' });
  assert.equal(inActive.actionAllowed, true);
  assert.equal(inActive.actionBlockedReason, null);

  // goal_report_only is allowed even in shadow.
  assert.equal(decideExecution({ tier: 'shadow', requestedAction: 'goal_report_only' }).actionAllowed, true);
});

test('decideExecution: a V1-forbidden action is never autonomous, even at active', () => {
  for (const action of V1_FORBIDDEN_ACTIONS) {
    const d = decideExecution({ tier: 'active', requestedAction: action });
    assert.equal(d.actionAllowed, false);
    assert.equal(d.actionBlockedReason, 'requires_human_authority');
  }
});

test('decideExecution: a requested action under suspension reports the block reason', () => {
  const d = decideExecution({ tier: 'active', firmSuspension: true, requestedAction: 'goal_report_only' });
  assert.equal(d.actionAllowed, false);
  assert.equal(d.actionBlockedReason, 'firm_suspended');
});

test('decideExecution: an unknown action throws (no silent pass)', () => {
  assert.throws(() => decideExecution({ tier: 'active', requestedAction: 'rm_rf' }), /unknown action/);
});

// ---- human-authorized V1-forbidden actions (the `human_authorized` criterion) ----

test('decideExecution: an explicit human authorization unlocks a forbidden action at canary+', () => {
  for (const tier of ['canary', 'active']) {
    const d = decideExecution({
      tier, requestedAction: 'client_visible_message',
      humanAuthorizations: ['client_visible_message']
    });
    assert.equal(d.actionAllowed, true, `${tier} should permit an authorized forbidden action`);
    assert.equal(d.actionBlockedReason, null);
    assert.equal(d.humanAuthorized, true);
    assert.deepEqual(d.humanAuthorizations, ['client_visible_message']);
  }
});

test('decideExecution: an authorization does NOT act at shadow — observe-only stands (tier_too_low)', () => {
  const d = decideExecution({
    tier: 'shadow', requestedAction: 'client_visible_message',
    humanAuthorizations: ['client_visible_message']
  });
  assert.equal(d.allowed, true);          // the run may execute
  assert.equal(d.actionAllowed, false);   // but a client-visible send does not, at shadow
  assert.equal(d.actionBlockedReason, 'tier_too_low');
  assert.equal(d.humanAuthorized, true);  // the authorization is present, the tier isn't
});

test('decideExecution: WITHOUT the authorization a forbidden action stays forbidden at every tier', () => {
  // Default (no humanAuthorizations) is unchanged — the back-compat invariant.
  const d = decideExecution({ tier: 'active', requestedAction: 'client_visible_message' });
  assert.equal(d.actionAllowed, false);
  assert.equal(d.actionBlockedReason, 'requires_human_authority');
  assert.equal(d.humanAuthorized, undefined);
  // Authorizing a DIFFERENT forbidden action doesn't unlock this one.
  const other = decideExecution({
    tier: 'active', requestedAction: 'client_visible_message',
    humanAuthorizations: ['accounting_state_mutation']
  });
  assert.equal(other.actionAllowed, false);
  assert.equal(other.actionBlockedReason, 'requires_human_authority');
});

test('decideExecution: a firm suspension overrides even an authorized forbidden action', () => {
  const d = decideExecution({
    tier: 'active', firmSuspension: true, requestedAction: 'client_visible_message',
    humanAuthorizations: ['client_visible_message']
  });
  assert.equal(d.allowed, false);
  assert.equal(d.actionAllowed, false);
  assert.equal(d.actionBlockedReason, 'firm_suspended'); // the kill switch wins
});

test('decideExecution: humanAuthorizations is normalized — junk and non-forbidden keys are dropped', () => {
  const d = decideExecution({
    tier: 'active',
    humanAuthorizations: ['client_visible_message', 'workflow_mutation', 'rm_rf', 42, null]
  });
  // only the real V1-forbidden key survives into the receipt
  assert.deepEqual(d.humanAuthorizations, ['client_visible_message']);
});

// ---- decideGraduation: legal tier transitions -----------------------------

test('decideGraduation: an authority may graduate up one rung', () => {
  const d = decideGraduation({ from: 'off', to: 'shadow', actorType: 'admin', actorId: 'op1' });
  assert.equal(d.allowed, true);
  assert.equal(d.direction, 'up');
  assert.equal(d.reason, 'graduated');
  assert.deepEqual(d.actor, { actorType: 'admin', actorId: 'op1' });
});

test('decideGraduation: skipping a rung is rejected', () => {
  const d = decideGraduation({ from: 'off', to: 'active', actorType: 'admin' });
  assert.equal(d.allowed, false);
  assert.equal(d.reason, 'must_graduate_one_step');
});

test('decideGraduation: a drop is always legal; straight to off is an emergency stop', () => {
  const emergency = decideGraduation({ from: 'active', to: 'off', actorType: 'firm_operator' });
  assert.equal(emergency.allowed, true);
  assert.equal(emergency.direction, 'down');
  assert.equal(emergency.reason, 'emergency_stop');

  const step = decideGraduation({ from: 'canary', to: 'shadow', actorType: 'admin' });
  assert.equal(step.allowed, true);
  assert.equal(step.reason, 'de_graduation');
});

test('decideGraduation: a no-op and a non-authority are both refused', () => {
  assert.equal(decideGraduation({ from: 'shadow', to: 'shadow', actorType: 'admin' }).reason, 'no_change');

  const byClient = decideGraduation({ from: 'off', to: 'shadow', actorType: 'client' });
  assert.equal(byClient.allowed, false);
  assert.equal(byClient.reason, 'authority_required');
  assert.equal(byClient.direction, 'up'); // direction is reported even when refused
});

test('decideGraduation: unknown tiers throw', () => {
  assert.throws(() => decideGraduation({ from: 'bogus', to: 'shadow', actorType: 'admin' }), /unknown execution tier/);
});

test('nextTier walks the ladder and clamps at the top', () => {
  assert.equal(nextTier('off'), 'shadow');
  assert.equal(nextTier('shadow'), 'canary');
  assert.equal(nextTier('canary'), 'active');
  assert.equal(nextTier('active'), 'active'); // clamped
});

// ---- the INT-6 doctrine carve (grant-gated actions) ------------------------
// Plan §2 INT-6 (approved via PR #800): "export-of-an-already-posted-journal
// under a live grant ONLY — never coding, never posting, never corrections."

test('GRANT_GATED_ACTIONS is disjoint from RUN_ACTIONS and V1_FORBIDDEN_ACTIONS', () => {
  for (const a of GRANT_GATED_ACTIONS) {
    assert.equal(RUN_ACTIONS.includes(a), false, 'graduation must never unlock a grant-gated action');
    assert.equal(V1_FORBIDDEN_ACTIONS.includes(a), false, 'the carve is a NEW narrower key, not a loosened forbidden one');
  }
  assert.deepEqual(GRANT_GATED_ACTIONS, ['posted_journal_export'], 'widening this list is a doctrine change');
});

test('accounting_state_mutation stays forbidden at every tier — the carve does not loosen it', () => {
  for (const tier of ['shadow', 'canary', 'active']) {
    const d = decideExecution({ tier, requestedAction: 'accounting_state_mutation' });
    assert.equal(d.actionAllowed, false, `still forbidden at ${tier}`);
    assert.equal(d.actionBlockedReason, 'requires_human_authority');
  }
});

test('posted_journal_export without a live grant is refused at EVERY tier', () => {
  for (const tier of ['shadow', 'canary', 'active']) {
    const d = decideExecution({ tier, requestedAction: 'posted_journal_export' });
    assert.equal(d.actionAllowed, false);
    assert.equal(d.actionBlockedReason, 'requires_authority_grant');
  }
});

test('posted_journal_export with a live grant acts ONLY at an autonomous tier', () => {
  const shadow = decideExecution({
    tier: 'shadow', requestedAction: 'posted_journal_export', authorityGrants: ['posted_journal_export']
  });
  assert.equal(shadow.actionAllowed, false, 'shadow observes what WOULD export, never exports');
  assert.equal(shadow.actionBlockedReason, 'tier_too_low');
  assert.equal(shadow.grantAuthorized, true, 'the receipt still shows the grant covered it');

  for (const tier of ['canary', 'active']) {
    const d = decideExecution({
      tier, requestedAction: 'posted_journal_export', authorityGrants: ['posted_journal_export']
    });
    assert.equal(d.actionAllowed, true);
    assert.equal(d.grantAuthorized, true, 'the grant is the deciding factor, auditable in the receipt');
    assert.deepEqual(d.authorityGrants, ['posted_journal_export'], 'the decision receipt carries the grant set');
  }
});

test('humanAuthorizations can NEVER unlock a grant-gated action, and a grant can NEVER unlock a forbidden one', () => {
  const viaHuman = decideExecution({
    tier: 'active', requestedAction: 'posted_journal_export',
    humanAuthorizations: ['posted_journal_export'] // wrong mechanism — filtered out
  });
  assert.equal(viaHuman.actionAllowed, false);
  assert.equal(viaHuman.actionBlockedReason, 'requires_authority_grant');

  const viaGrant = decideExecution({
    tier: 'active', requestedAction: 'accounting_state_mutation',
    authorityGrants: ['accounting_state_mutation'] // wrong mechanism — filtered out
  });
  assert.equal(viaGrant.actionAllowed, false);
  assert.equal(viaGrant.actionBlockedReason, 'requires_human_authority');
  assert.deepEqual(viaGrant.authorityGrants, [], 'a non-grant-gated key never survives normalization');
});

test('a suspension outranks a grant: suspended firm blocks posted_journal_export', () => {
  const d = decideExecution({
    tier: 'active',
    firmSuspension: buildSuspension({ scope: 'firm', reason: 'stop', actorType: 'admin' }),
    requestedAction: 'posted_journal_export',
    authorityGrants: ['posted_journal_export']
  });
  assert.equal(d.actionAllowed, false);
  assert.equal(d.actionBlockedReason, 'firm_suspended');
});
