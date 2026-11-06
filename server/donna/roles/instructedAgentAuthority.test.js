// D7 authority-composition matrix (universal mentions slice 4;
// design-donna-universal-mentions.md §10): when an agent acts on a seat's
// instruction, the compiled action_type authorizes against
// min(rank(instructing), rank(agent)) — and founder-only verbs are refused
// NO MATTER WHO instructs.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  decideInstructedAgentAction,
  agentEffectiveCapabilityClass
} from './roleAuthority.js';
import { CAPABILITY_CLASSES, requiredCapabilityForAction } from '../operatorCapability.js';
import { ROLE_DEFINITIONS } from './roleRegistry.js';

const rank = (c) => CAPABILITY_CLASSES.indexOf(c);

test('agent effective class: operator composes founder; bench role carries its class; unknown fail-closes viewer', () => {
  assert.equal(agentEffectiveCapabilityClass({ agentId: 'donna', roleId: null }), 'founder');
  assert.equal(agentEffectiveCapabilityClass({ agentId: 'Donna ' }), 'founder');
  for (const role of Object.values(ROLE_DEFINITIONS)) {
    assert.equal(
      agentEffectiveCapabilityClass({ agentId: 'clara', roleId: role.id }),
      role.capability_class,
      `role ${role.id} composes at its registry class`
    );
  }
  assert.equal(agentEffectiveCapabilityClass({ agentId: 'clara', roleId: 'no_such_role' }), 'viewer');
  assert.equal(agentEffectiveCapabilityClass({}), 'viewer');
});

test('MATRIX: effective class is min(instructing, agent) for every class pair', () => {
  // answer_evidence_request is routine_categorization -> requires junior.
  const verb = 'answer_evidence_request';
  assert.equal(requiredCapabilityForAction(verb), 'junior');
  for (const instructing of CAPABILITY_CLASSES) {
    for (const agent of CAPABILITY_CLASSES) {
      const d = decideInstructedAgentAction({ actionType: verb, instructingClass: instructing, agentClass: agent });
      const expectedEffective = rank(instructing) <= rank(agent) ? instructing : agent;
      assert.equal(d.effective_class, expectedEffective, `${instructing}×${agent}`);
      assert.equal(d.allowed, rank(expectedEffective) >= rank('junior'), `${instructing}×${agent} allow`);
      // receipts carry both identities' classes
      assert.equal(d.instructing_class, instructing);
      assert.equal(d.agent_class, agent);
    }
  }
});

test('a lower-class seat cannot instruct an agent into an action above the seat\'s own class', () => {
  // reject_match requires reviewer; a junior instructing a reviewer-class
  // agent (collections) must be refused — the agent's class cannot lift the
  // instruction above the seat.
  assert.equal(requiredCapabilityForAction('reject_match'), 'reviewer');
  const refused = decideInstructedAgentAction({
    actionType: 'reject_match', instructingClass: 'junior', agentClass: 'reviewer'
  });
  assert.equal(refused.allowed, false);
  assert.equal(refused.effective_class, 'junior');
  assert.equal(refused.reason, 'requires_reviewer_capability');
  // ...while a senior instructing the same agent passes.
  const allowed = decideInstructedAgentAction({
    actionType: 'reject_match', instructingClass: 'senior', agentClass: 'reviewer'
  });
  assert.equal(allowed.allowed, true);
  assert.equal(allowed.effective_class, 'reviewer');
});

test('an agent never lends its class upward: founder-instructed viewer-agent is still viewer-bound', () => {
  const d = decideInstructedAgentAction({
    actionType: 'apply_category', instructingClass: 'founder', agentClass: 'viewer'
  });
  assert.equal(d.effective_class, 'viewer');
  assert.equal(d.allowed, false);
});

test('FOUNDER-ONLY verbs are refused regardless of instructing seat — founder×founder included', () => {
  for (const verb of ['sync_to_accounting', 'reverse_apply', 'remember_fact', 'approve_role_grant', 'post_inventory_journal', 'recode_decided']) {
    // recode_decided is partner-pinned, not founder — assert only the true founder verbs refuse as founder-only
    const required = requiredCapabilityForAction(verb);
    const d = decideInstructedAgentAction({ actionType: verb, instructingClass: 'founder', agentClass: 'founder' });
    if (required === 'founder') {
      assert.equal(d.allowed, false, verb);
      assert.equal(d.reason, 'founder_only_never_instructable', verb);
    } else {
      // partner-pinned verbs compose normally (founder×founder passes partner)
      assert.equal(d.allowed, true, verb);
    }
  }
});

test('unknown verbs and unknown classes fail closed', () => {
  const unknownVerb = decideInstructedAgentAction({
    actionType: 'no_such_verb', instructingClass: 'founder', agentClass: 'founder'
  });
  assert.equal(unknownVerb.allowed, false);
  assert.equal(unknownVerb.reason, 'founder_only_never_instructable');
  const unknownClass = decideInstructedAgentAction({
    actionType: 'apply_category', instructingClass: 'archduke', agentClass: 'founder'
  });
  assert.equal(unknownClass.effective_class, 'viewer');
  assert.equal(unknownClass.allowed, false);
});
