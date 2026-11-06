import test from 'node:test';
import assert from 'node:assert/strict';

import {
  INTENT_OBJECT_ROUTING_FLAG_KEY,
  attemptOwnerIntentProposalAccept,
  buildOwnerIntentApplyPlan,
  buildOwnerIntentAuthorityEnvelope,
  buildOwnerIntentConsequenceDiffContract,
  buildOwnerIntentExecutionGate,
  buildOwnerIntentReadOnlyConsequenceDiff,
  intentObjectRoutingActs,
  buildOwnerIntentAcceptPreflight,
  buildOwnerIntentMemoryCandidate,
  buildOwnerIntentProposalCard,
  prepareOwnerIntentProposalPreflight,
  stageIntentCompileResult
} from './ownerIntentRuntime.js';
import { ownerActorAttribution } from './ownerActorAttribution.js';

const compileResult = {
  compile_id: 'ic-123',
  contract_version: 'intent_compile.v1',
  source_message_id: 'msg-1',
  model_id: 'model-test',
  prompt_version: 'prompt.v1',
  config_snapshot_id: 'cfg-1',
  clarification_requests: [],
  unmet_capability_needs: [{ local_id: 'o1', capability: 'unknown.do.v1' }],
  objects: [{
    local_id: 'o1',
    kind: 'authority_grant',
    summary: 'Let Donna post small bills',
    payload: { requested_scope: 'post supplier bills under 50 EUR' },
    links: [],
    candidate_capabilities: [],
    source_refs: [{ message_id: 'msg-1', verbatim_span: 'post small bills' }],
    parse_confidence: 'high'
  }]
};

test('INTENT_OBJECT_ROUTING is born-dark on the config plane', () => {
  assert.equal(INTENT_OBJECT_ROUTING_FLAG_KEY, 'INTENT_OBJECT_ROUTING');
  assert.equal(intentObjectRoutingActs({ snapshot: null, env: {} }), false);
  assert.equal(intentObjectRoutingActs({ snapshot: { INTENT_OBJECT_ROUTING: { stage: 'shadow' } }, env: {} }), false);
  assert.equal(intentObjectRoutingActs({ snapshot: { INTENT_OBJECT_ROUTING: { stage: 'canary' } }, env: {} }), true);
  assert.equal(intentObjectRoutingActs({ snapshot: { INTENT_OBJECT_ROUTING: { stage: 'auto' } }, env: { CLIENT_CONFIG_FORCE_DISABLE: 'INTENT_OBJECT_ROUTING' } }), false);
});

test('buildOwnerIntentProposalCard stages the candidate without an executor writer', () => {
  const card = buildOwnerIntentProposalCard({ compileResult, intentObject: compileResult.objects[0] });
  assert.equal(card.type, 'owner_intent_candidate');
  assert.equal(card.triage_source, 'policy_request');
  assert.equal(card.writer, null);
  assert.equal(card.review_mode, 'client_confirmation');
  assert.equal(card.checks.status, 'requires_review');
  assert.equal(card.blast_radius.decided_rows, 0);
  assert.equal(card.blast_radius.unattended_future_behavior, false);
  assert.equal(card.detail.source_message_id, 'msg-1');
  assert.equal(card.detail.object.kind, 'authority_grant');
  assert.equal(card.detail.linked_homes.source_message.table, 'client_chat_messages');
});

test('memory intent builds a governed memory candidate payload linked to the source message', () => {
  const candidate = buildOwnerIntentMemoryCandidate({
    firmId: 'f',
    clientId: 'c',
    compileResult,
    intentObject: { ...compileResult.objects[0], kind: 'memory', payload: { statement: 'Alex birthday is July 14', predicate: 'birthday' } },
    actorId: 'owner@example.com',
    observedAt: '2026-07-14T12:00:00.000Z'
  });
  assert.equal(candidate.targetContract, 'memory');
  assert.equal(candidate.contractPayload.lifecycle_owner_type, 'legal_entity');
  assert.equal(candidate.contractPayload.lifecycle_owner_id, 'c');
  assert.equal(candidate.contractPayload.asserted_by_principal_id, 'owner@example.com');
  assert.equal(candidate.contractPayload.assertion_origin, 'owner_asserted');
  assert.equal(candidate.contractPayload.observed_at, '2026-07-14T12:00:00.000Z');
  assert.equal(candidate.provenance.source_message_id, 'msg-1');
});

test('preference intent routes out as a preference-targeted candidate, not memory', () => {
  const candidate = buildOwnerIntentMemoryCandidate({
    firmId: 'f', clientId: 'c', compileResult,
    intentObject: { ...compileResult.objects[0], kind: 'preference', payload: { statement: 'Call me Alex' } }
  });
  assert.equal(candidate.targetContract, 'preference');
  assert.equal(candidate.candidateType, 'policy');
});

test('stageIntentCompileResult persists proposal cards and memory candidates only when the acting flag acts', async () => {
  const calls = [];
  const memoryCalls = [];
  const persistCard = async (args) => { calls.push(args); return { created: true }; };
  const stageMemoryCandidateFn = async (args) => { memoryCalls.push(args); return { id: 'memcand-1' }; };
  const off = await stageIntentCompileResult({
    client: {}, firmId: 'f', clientId: 'c', compileResult,
    snapshot: { INTENT_OBJECT_ROUTING: { stage: 'shadow' } }, env: {}, persistCard, stageMemoryCandidateFn,
    actorId: 'owner@example.com', observedAt: '2026-07-14T12:00:00.000Z'
  });
  assert.deepEqual(off, { status: 'skipped', reason: 'flag_off' });
  assert.equal(calls.length, 0);
  assert.equal(memoryCalls.length, 0);

  const on = await stageIntentCompileResult({
    client: {}, firmId: 'f', clientId: 'c',
    compileResult: {
      ...compileResult,
      objects: [{ ...compileResult.objects[0], kind: 'memory', payload: { statement: 'Alex birthday is July 14', predicate: 'birthday' } }]
    },
    snapshot: { INTENT_OBJECT_ROUTING: { stage: 'canary' } }, env: {}, persistCard, stageMemoryCandidateFn,
    actorId: 'owner@example.com', observedAt: '2026-07-14T12:00:00.000Z'
  });
  assert.equal(on.status, 'staged');
  assert.equal(on.stagedCount, 1);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].objectType, 'proposed_intent_object');
  assert.equal(calls[0].snapshotId, 'cfg-1');
  assert.equal(calls[0].modelName, 'model-test');
  assert.equal(calls[0].card.writer, null);
  assert.equal(memoryCalls.length, 1);
  assert.equal(memoryCalls[0].targetContract, 'memory');
  assert.equal(on.staged[0].memory_candidate_id, 'memcand-1');
});

test('ownerActorAttribution prefers stable ids and records unknown explicitly', () => {
  assert.deepEqual(
    ownerActorAttribution({ principal: { collaborator: { id: 'collab-1' }, email: 'owner@example.com' } }),
    { actor_id: 'collab-1', actor_type: 'owner', basis: 'collaborator_id', unknown: false }
  );
  assert.deepEqual(
    ownerActorAttribution({ principal: { email: 'owner@example.com' }, auth: { email: 'fallback@example.com' } }),
    { actor_id: null, actor_type: 'owner', basis: 'unknown', unknown: true }
  );
});


test('consequence diff contract refuses to trust staged before_after data', () => {
  const contract = buildOwnerIntentConsequenceDiffContract({
    object: { kind: 'task' },
    selectedMutation: { verb: 'ask_client', writer: 'createClientEvidenceRequestInDb' }
  });
  assert.equal(contract.status, 'not_computed');
  assert.equal(contract.required_before_apply, true);
  assert.equal(contract.input_basis.source, 'accept_time_preflight');
  assert.equal(contract.input_basis.staged_before_after_trusted, false);
  assert.equal(contract.target_writer, 'createClientEvidenceRequestInDb');
  assert.deepEqual(contract.before_after, []);
});


test('ask_client read-only adapter computes a consequence diff without creating an ask', () => {
  const diff = buildOwnerIntentReadOnlyConsequenceDiff({
    object: { local_id: 'o-ask', kind: 'task', summary: 'Ask me for the missing June receipt.', source_refs: [{ message_id: 'm1' }] },
    selectedMutation: { verb: 'ask_client', writer: 'createClientEvidenceRequestInDb' }
  });
  assert.equal(diff.status, 'computed');
  assert.equal(diff.computed_by, 'owner_intent_preflight_adapter.ask_client.v1');
  assert.equal(diff.input_basis.staged_before_after_trusted, false);
  assert.equal(diff.before_after.length, 1);
  assert.equal(diff.before_after[0].before, null);
  assert.equal(diff.before_after[0].after.kind, 'draft_owner_ask');
  assert.equal(diff.before_after[0].after.execution_state, 'not_executed');
});

test('authority envelope requires durable actor, mutation route, and computed consequence diff', () => {
  const blocked = buildOwnerIntentAuthorityEnvelope({
    actor: { actor_id: null, actor_type: 'owner', basis: 'unknown', unknown: true },
    requiredCapabilities: [{ capability: 'finance.ask_client.v1', access: 'write', grant_required: 'none', required_capability_class: 'operator', risk_class: 'medium' }],
    selectedMutation: { verb: 'ask_client', writer: 'createClientEvidenceRequestInDb', autonomy_class: 'owner_ask' },
    consequenceDiff: { status: 'not_computed' }
  });
  assert.equal(blocked.status, 'blocked');
  assert.equal(blocked.owner_confirmation_sufficient, false);
  assert.equal(blocked.materialized_grant_id, null);
  assert.ok(blocked.blockers.some((b) => b.code === 'authority_actor_unknown'));
  assert.ok(blocked.blockers.some((b) => b.code === 'authority_consequence_diff_missing'));

  const ready = buildOwnerIntentAuthorityEnvelope({
    actor: { actor_id: 'collab-1', actor_type: 'owner', basis: 'collaborator_id', unknown: false },
    requiredCapabilities: [{ capability: 'finance.ask_client.v1', access: 'write', grant_required: 'none', required_capability_class: 'operator', risk_class: 'medium' }],
    selectedMutation: { verb: 'ask_client', writer: 'createClientEvidenceRequestInDb', autonomy_class: 'owner_ask' },
    consequenceDiff: { status: 'computed' }
  });
  assert.equal(ready.status, 'owner_confirmation_required');
  assert.equal(ready.owner_confirmation_sufficient, true);
  assert.deepEqual(ready.blockers, []);
});

test('buildOwnerIntentApplyPlan selects only existing registry-backed writer routes', () => {
  const plan = buildOwnerIntentApplyPlan({
    object: { kind: 'task', summary: 'Ask the owner for evidence' },
    requiredCapabilities: [{
      capability: 'finance.ask_client.v1',
      domain: 'finance',
      verb: 'ask_client',
      executor: 'createClientEvidenceRequestInDb',
      access: 'write'
    }],
    findMutationEntryFn: (verb) => verb === 'ask_client'
      ? {
          verb: 'ask_client',
          writer: 'createClientEvidenceRequestInDb',
          autonomyClass: 'owner_ask',
          convergenceImpact: ['on_owner'],
          reversibility: null,
          preflightToday: 'shadow_feed',
          emitsApplyReceipt: 'shadow_feed',
          emitsAudit: 'yes'
        }
      : null
  });
  assert.equal(plan.status, 'planned');
  assert.equal(plan.selected_mutation.verb, 'ask_client');
  assert.equal(plan.selected_mutation.writer, 'createClientEvidenceRequestInDb');
  assert.equal(plan.execution.enabled, false);
  assert.equal(plan.consequence_diff.status, 'computed');
  assert.equal(plan.consequence_diff.computed_by, 'owner_intent_preflight_adapter.ask_client.v1');
});

test('buildOwnerIntentApplyPlan refuses unsupported or non-accounting routes', () => {
  const plan = buildOwnerIntentApplyPlan({
    object: { kind: 'memory', summary: 'Remember preference' },
    requiredCapabilities: [{
      capability: 'memory.remember.v1',
      domain: 'memory',
      verb: 'remember',
      executor: 'saveMemory',
      access: 'write'
    }]
  });
  assert.equal(plan.status, 'blocked');
  assert.ok(plan.blockers.some((b) => b.code === 'non_accounting_capability_not_executable'));
  assert.ok(plan.blockers.some((b) => b.code === 'no_supported_mutation_route'));
});


test('buildOwnerIntentExecutionGate is blocked and records no execution side effects', () => {
  const gate = buildOwnerIntentExecutionGate({
    applyPlan: {
      selected_mutation: { verb: 'ask_client', writer: 'createClientEvidenceRequestInDb', autonomy_class: 'owner_ask' }
    },
    consequenceDiff: { status: 'computed' },
    authorityEnvelope: { status: 'owner_confirmation_required' },
    actorAttribution: { actor_id: 'collab-1', actor_type: 'owner', basis: 'collaborator_id', unknown: false }
  });
  assert.equal(gate.status, 'blocked');
  assert.equal(gate.enabled, false);
  assert.equal(gate.writer_invoked, false);
  assert.equal(gate.apply_receipt_required, true);
  assert.equal(gate.apply_receipt_persisted, false);
  assert.equal(gate.authority_materialized, false);
  assert.equal(gate.selected_mutation.verb, 'ask_client');
  assert.equal(gate.selected_writer, 'createClientEvidenceRequestInDb');
  assert.ok(gate.reasons.some((reason) => reason.code === 'apply_executor_not_enabled'));
});

test('buildOwnerIntentAcceptPreflight re-validates staged object and plans without executing', () => {
  const preflight = buildOwnerIntentAcceptPreflight({
    card: {
      id: 'owner_intent_123',
      proposal_type: 'owner_intent_candidate',
      status: 'proposed',
      detail: {
        object: { kind: 'task', summary: 'Pay the bill', candidate_capabilities: ['finance.ask_client.v1'] },
        unmet_capability_needs: [{ capability: 'missing.capability.v1' }]
      }
    },
    actor: { actor_id: 'collab-1', actor_type: 'owner', basis: 'collaborator_id', unknown: false },
    findCapabilityFn: (id) => id === 'finance.ask_client.v1'
      ? {
          capability: id,
          domain: 'finance',
          verb: 'ask_client',
          executor: 'createClientEvidenceRequestInDb',
          access: 'write',
          side_effect_class: 'client_visible',
          risk_class: 'medium',
          dry_run: 'unsupported',
          execution_receipt: 'shadow_feed',
          preflight: 'shadow_feed',
          authority_requirements: { grant_required: 'none', required_capability_class: 'operator', autonomy_class: 'owner_ask' }
        }
      : null,
    findMutationEntryFn: (verb) => verb === 'ask_client'
      ? { verb, writer: 'createClientEvidenceRequestInDb', autonomyClass: 'owner_ask', convergenceImpact: ['on_owner'], preflightToday: 'shadow_feed', emitsApplyReceipt: 'shadow_feed', emitsAudit: 'yes' }
      : null,
    now: '2026-07-14T12:00:00.000Z'
  });
  assert.equal(preflight.status, 'blocked');
  assert.equal(preflight.consequence_diff.status, 'computed');
  assert.equal(preflight.required_capabilities[0].capability, 'finance.ask_client.v1');
  assert.equal(preflight.apply_plan.selected_mutation.verb, 'ask_client');
  assert.equal(preflight.apply_plan.execution.enabled, false);
  assert.equal(preflight.execution_gate.status, 'blocked');
  assert.equal(preflight.execution_gate.enabled, false);
  assert.equal(preflight.execution_gate.writer_invoked, false);
  assert.equal(preflight.execution_gate.apply_receipt_persisted, false);
  assert.equal(preflight.execution_gate.authority_materialized, false);
  assert.equal(preflight.execution_gate.selected_writer, 'createClientEvidenceRequestInDb');
  assert.equal(preflight.authority.status, 'owner_confirmation_required');
  assert.equal(preflight.authority.owner_confirmation_sufficient, true);
  assert.equal(preflight.authority.materialized_grant_id, null);
  assert.ok(!preflight.authority.blockers.some((b) => b.code === 'authority_consequence_diff_missing'));
  assert.ok(!preflight.blockers.some((b) => b.code === 'authority_envelope_blocked'));
  assert.ok(preflight.blockers.some((b) => b.code === 'unsupported_capability' && b.capability === 'missing.capability.v1'));
  assert.ok(!preflight.blockers.some((b) => b.code === 'consequence_diff_not_computed'));
  assert.ok(preflight.blockers.some((b) => b.code === 'apply_executor_not_enabled'));
});

test('prepareOwnerIntentProposalPreflight re-reads and persists a visible check report without writer calls', async () => {
  const calls = [];
  const result = await prepareOwnerIntentProposalPreflight({
    client: {},
    firmId: 'f',
    clientId: 'c',
    proposalId: 'owner_intent_123',
    actor: { actor_id: 'collab-1', actor_type: 'owner', basis: 'collaborator_id', unknown: false },
    getCard: async (args) => {
      calls.push(['getCard', args]);
      return {
        id: 'owner_intent_123',
        proposal_type: 'owner_intent_candidate',
        status: 'proposed',
        detail: { object: { kind: 'memory', summary: 'Remember VAT preference' } }
      };
    },
    recordReport: async (args) => {
      calls.push(['recordReport', args]);
      return { proposal_id: args.proposalId, status: args.report.status };
    },
    findCapabilityFn: () => null
  });
  assert.equal(result.status, 'blocked');
  assert.equal(calls[0][0], 'getCard');
  assert.equal(calls[1][0], 'recordReport');
  assert.equal(calls[1][1].report.checks[0].name, 'owner_intent_accept_preflight');
  assert.equal(calls[1][1].report.checks[0].execution_gate.enabled, false);
  assert.equal(calls[1][1].report.checks[0].execution_gate.writer_invoked, false);
  assert.ok(calls[1][1].report.checks[0].execution_gate.reasons.some((reason) => reason.code === 'apply_executor_not_enabled'));
  assert.ok(result.preflight.blockers.some((b) => b.code === 'no_write_capability'));
  assert.ok(result.preflight.blockers.some((b) => b.code === 'apply_executor_not_enabled'));
});

test('attemptOwnerIntentProposalAccept refuses visibly after fresh preflight without writer calls', async () => {
  const calls = [];
  const result = await attemptOwnerIntentProposalAccept({
    client: {},
    firmId: 'f',
    clientId: 'c',
    proposalId: 'owner_intent_123',
    actor: { actor_id: null, actor_type: 'owner', basis: 'unknown', unknown: true },
    getCard: async (args) => {
      calls.push(['getCard', args]);
      return {
        id: 'owner_intent_123',
        proposal_type: 'owner_intent_candidate',
        status: 'proposed',
        detail: { object: { kind: 'task', summary: 'Pay supplier' } }
      };
    },
    recordReport: async (args) => {
      calls.push(['recordReport', args]);
      return { proposal_id: args.proposalId, status: args.report.status };
    },
    findCapabilityFn: () => null,
    now: '2026-07-14T12:00:00.000Z'
  });
  assert.equal(result.status, 'blocked');
  assert.equal(result.reason, 'preflight_blocked');
  assert.equal(result.statusCode, 409);
  assert.equal(calls[0][0], 'getCard');
  assert.equal(calls[1][0], 'recordReport');
  assert.equal(calls[1][1].report.status, 'requires_review');
  assert.equal(calls[1][1].report.checks[0].execution_gate.apply_receipt_persisted, false);
  assert.equal(calls[1][1].report.checks[0].execution_gate.authority_materialized, false);
  assert.deepEqual(calls[1][1].report.checks.map((check) => check.name), [
    'owner_intent_accept_preflight',
    'owner_intent_accept_refused'
  ]);
  assert.ok(result.preflight.blockers.some((b) => b.code === 'actor_unknown'));
  assert.ok(result.preflight.blockers.some((b) => b.code === 'no_write_capability'));
  assert.ok(result.preflight.blockers.some((b) => b.code === 'apply_executor_not_enabled'));
});
