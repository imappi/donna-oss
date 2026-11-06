// Donna owner-agent runtime bridge — first durable staging slice.
//
// This is intentionally NOT an agent backend and NOT an accounting executor. It reuses the
// existing intent compiler as interpretation-only, then (only behind the born-dark
// INTENT_OBJECT_ROUTING config-plane acting flag) stages each validated proposed intent object
// as an immutable proposal_card. Future execution must resolve these staged candidates through
// existing capability/mutation registries and named writers; this module writes no ledger rows
// and calls no accounting mutation writer.

import { createHash } from 'node:crypto';

import { clientFlagActs } from './clientConfig.js';
import {
  getOwnerIntentProposalCardForPreflight,
  persistProposalCard,
  recordOwnerIntentPreflightReport
} from './proposalStore.js';
import { stageMemoryCandidate } from './memoryCandidates.js';
import { findCapability } from './capabilityRegistry.js';
import { findMutationEntry } from './accountingMutationRegistry.js';
import { INTENT_OBJECT_KINDS } from './intentObjects.js';

export const INTENT_OBJECT_ROUTING_FLAG_KEY = 'INTENT_OBJECT_ROUTING';

export const intentObjectRoutingActs = ({ snapshot = null, env = process.env } = {}) =>
  clientFlagActs({
    flagKey: INTENT_OBJECT_ROUTING_FLAG_KEY,
    snapshot,
    envFallback: () => false,
    env
  });

const sha = (value) => createHash('sha256').update(String(value || '')).digest('hex');

export const ownerIntentProposalId = ({ compileId, localId } = {}) =>
  `owner_intent_${sha(`${compileId || ''}:${localId || ''}`).slice(0, 40)}`;

const triageSourceForKind = (kind) => {
  if (kind === 'memory' || kind === 'preference') return 'memory_candidate';
  if (kind === 'policy' || kind === 'authority_grant' || kind === 'automation' || kind === 'workflow') return 'policy_request';
  if (kind === 'goal' || kind === 'commitment' || kind === 'task') return 'question';
  return 'unsupported';
};

const confidenceFromParse = (value) => ['low', 'medium', 'high'].includes(value) ? value : 'medium';

export const buildOwnerIntentProposalCard = ({ compileResult, intentObject } = {}) => {
  if (!compileResult?.compile_id || !intentObject?.local_id) return null;
  const proposalId = ownerIntentProposalId({ compileId: compileResult.compile_id, localId: intentObject.local_id });
  const warnings = [];
  if (Array.isArray(intentObject.candidate_capabilities) && intentObject.candidate_capabilities.length) {
    warnings.push('candidate capabilities are advisory; planner selection is a later slice');
  }
  if (intentObject.kind === 'authority_grant') {
    warnings.push('compiled authority_grant is a request only; no authority is effective from this card');
  }
  return {
    proposal_id: proposalId,
    type: 'owner_intent_candidate',
    triage_source: triageSourceForKind(intentObject.kind),
    plan_id: null,
    targets: [`${compileResult.compile_id}:${intentObject.local_id}`],
    blast_radius: {
      transactions: 0,
      documents: 0,
      decided_rows: 0,
      client_visible: true,
      unattended_future_behavior: false
    },
    writer: null,
    reversibility: null,
    before_after: [],
    before_after_total: 0,
    checks: {
      status: 'requires_review',
      checks: [{
        name: 'owner_intent_staging_only',
        status: 'requires_review',
        detail: 'Validated intent object staged only; no accounting mutation or authority materialization is executed.'
      }]
    },
    preconditions: [],
    review_mode: 'client_confirmation',
    detail: {
      contract_version: compileResult.contract_version,
      compile_id: compileResult.compile_id,
      source_message_id: compileResult.source_message_id,
      object: intentObject,
      clarification_requests: compileResult.clarification_requests || [],
      unmet_capability_needs: (compileResult.unmet_capability_needs || [])
        .filter((need) => need?.local_id === intentObject.local_id),
      linked_homes: {
        source_message: { table: 'client_chat_messages', id: compileResult.source_message_id },
        proposal_card: { table: 'proposal_cards', id: proposalId }
      }
    },
    warnings
  };
};


export const buildOwnerIntentMemoryCandidate = ({
  firmId,
  clientId,
  compileResult,
  intentObject,
  actorId = null,
  observedAt = null
} = {}) => {
  if (!firmId || !clientId || !compileResult?.compile_id || !intentObject?.local_id) return null;
  const sourceText = String(intentObject?.payload?.statement || intentObject?.summary || '').trim();
  if (!sourceText) return null;
  const base = {
    source: 'owner_intent_compile',
    subject: intentObject.summary || sourceText,
    fact: sourceText,
    confidence: confidenceFromParse(intentObject.parse_confidence),
    provenance: {
      compile_id: compileResult.compile_id,
      source_message_id: compileResult.source_message_id,
      local_id: intentObject.local_id,
      intent_kind: intentObject.kind,
      proposal_id: ownerIntentProposalId({ compileId: compileResult.compile_id, localId: intentObject.local_id })
    },
    model: compileResult.model_id || null
  };

  if (intentObject.kind === 'memory') {
    // Owner-asserted memories can be staged as governed memory.v1 candidates, but still do
    // not become active memory here. Promotion later calls saveMemory, re-validates the
    // record, and is gated by MEMORY_MODEL_V2.
    if (!actorId || !observedAt) return null;
    const predicate = String(intentObject?.payload?.predicate || 'owner_assertion').trim() || 'owner_assertion';
    return {
      ...base,
      candidateType: 'fact',
      targetContract: 'memory',
      contractPayload: {
        lifecycle_owner_type: 'legal_entity',
        lifecycle_owner_id: clientId,
        scope_type: 'legal_entity',
        scope_id: clientId,
        subject_type: 'legal_entity',
        subject_id: clientId,
        observed_alias: null,
        kind: 'assertion',
        predicate,
        structured_value: null,
        source_text: sourceText,
        source_refs: intentObject.source_refs || [],
        asserted_by_principal_id: actorId,
        assertion_origin: 'owner_asserted',
        transport_actor: { channel: compileResult.channel || 'client_chat', source_message_id: compileResult.source_message_id },
        extraction_model_id: compileResult.model_id || null,
        extraction_prompt_version: compileResult.prompt_version || null,
        validator_version: compileResult.validator_version || null,
        activation_confirmation: null,
        observed_at: observedAt,
        valid_from: null,
        valid_until: null,
        retention_policy_id: null,
        retain_until: null,
        review_after: null,
        last_confirmed_at: null,
        assertion_confidence: confidenceFromParse(intentObject.parse_confidence),
        confidentiality: 'confidential',
        personal_data_class: 'none'
      }
    };
  }

  if (intentObject.kind === 'preference') {
    // Preferences are explicitly routed OUT of memory.v1. The candidate is durable and
    // reviewable, but promoteMemoryCandidate refuses targetContract='preference' until the
    // preference contract exists.
    return {
      ...base,
      candidateType: 'policy',
      targetContract: 'preference',
      contractPayload: {
        contract_version: compileResult.contract_version,
        kind: intentObject.kind,
        payload: intentObject.payload,
        summary: intentObject.summary,
        source_refs: intentObject.source_refs || []
      }
    };
  }

  return null;
};

export const stageIntentCompileResult = async ({
  client,
  firmId,
  clientId,
  compileResult,
  snapshot = null,
  env = process.env,
  persistCard = persistProposalCard,
  stageMemoryCandidateFn = stageMemoryCandidate,
  actorId = null,
  observedAt = null
} = {}) => {
  if (!client || !firmId || !clientId || !compileResult?.compile_id) return { status: 'skipped', reason: 'missing_inputs' };
  if (!intentObjectRoutingActs({ snapshot, env })) return { status: 'skipped', reason: 'flag_off' };
  const objects = Array.isArray(compileResult.objects) ? compileResult.objects : [];
  const staged = [];
  for (const intentObject of objects) {
    const card = buildOwnerIntentProposalCard({ compileResult, intentObject });
    if (!card) continue;
    const persisted = await persistCard({
      client,
      firmId,
      clientId,
      card,
      objectType: 'proposed_intent_object',
      snapshotId: compileResult.config_snapshot_id || null,
      triggerEventId: compileResult.source_message_id || null,
      modelName: compileResult.model_id || null,
      promptVersion: compileResult.prompt_version || null,
      operatorWords: null
    });
    const memoryCandidate = buildOwnerIntentMemoryCandidate({
      firmId, clientId, compileResult, intentObject, actorId, observedAt
    });
    const stagedMemory = memoryCandidate
      ? await stageMemoryCandidateFn({ client, firmId, clientId, ...memoryCandidate })
      : null;
    staged.push({
      local_id: intentObject.local_id,
      proposal_id: card.proposal_id,
      created: !!persisted?.created,
      memory_candidate_id: stagedMemory?.id || null
    });
  }
  return { status: 'staged', stagedCount: staged.length, staged };
};

const uniqueStrings = (values = []) => [...new Set(values.map((value) => String(value || '').trim()).filter(Boolean))];

const checkStatusForOwnerIntentPreflight = (status) => {
  if (status === 'requires_confirmation') return 'requires_review';
  if (status === 'blocked' || status === 'refused') return 'requires_review';
  return ['pass', 'warning', 'requires_review', 'fail'].includes(status) ? status : 'requires_review';
};

export const buildOwnerIntentConsequenceDiffContract = ({ object = null, selectedMutation = null } = {}) => ({
  status: 'not_computed',
  before_after: [],
  computed_by: null,
  required_before_apply: true,
  target_writer: selectedMutation?.writer || null,
  target_verb: selectedMutation?.verb || null,
  input_basis: {
    source: 'accept_time_preflight',
    staged_object_kind: object?.kind || null,
    staged_before_after_trusted: false
  },
  reason: selectedMutation
    ? 'A registered writer route was identified, but no read-only consequence-diff adapter supports it yet.'
    : 'No registered writer route was identified; staged before_after is not trusted as a consequence diff.'
});

const ownerIntentDiffTargetId = ({ object = null, selectedMutation = null } = {}) =>
  `owner_intent_diff:${selectedMutation?.verb || 'unknown'}:${sha(`${object?.local_id || ''}:${object?.summary || ''}`).slice(0, 24)}`;

export const buildOwnerIntentReadOnlyConsequenceDiff = ({ object = null, selectedMutation = null } = {}) => {
  const base = buildOwnerIntentConsequenceDiffContract({ object, selectedMutation });
  if (!selectedMutation || selectedMutation.verb !== 'ask_client' || selectedMutation.writer !== 'createClientEvidenceRequestInDb') {
    return base;
  }

  const summary = String(object?.summary || object?.payload?.question || object?.payload?.statement || '').trim();
  if (!summary) {
    return {
      ...base,
      reason: 'The ask_client adapter needs a non-empty owner-intent summary before it can compute a read-only diff.',
      blockers: [{ code: 'ask_client_diff_missing_summary', detail: 'No owner-intent summary is available for the ask_client diff adapter.' }]
    };
  }

  const target = ownerIntentDiffTargetId({ object, selectedMutation });
  return {
    ...base,
    status: 'computed',
    computed_by: 'owner_intent_preflight_adapter.ask_client.v1',
    before_after: [{
      target,
      before: null,
      after: {
        kind: 'draft_owner_ask',
        summary,
        source_intent_local_id: object?.local_id || null,
        source_refs: Array.isArray(object?.source_refs) ? object.source_refs : [],
        writer: selectedMutation.writer,
        verb: selectedMutation.verb,
        execution_state: 'not_executed'
      }
    }],
    input_basis: {
      ...base.input_basis,
      adapter: 'ask_client.v1',
      staged_before_after_trusted: false
    },
    reason: 'Read-only ask_client preflight computed what Donna would prepare; no owner ask was created or sent.'
  };
};

export const buildOwnerIntentAuthorityEnvelope = ({
  actor = null,
  requiredCapabilities = [],
  selectedMutation = null,
  consequenceDiff = null
} = {}) => {
  const writeCapabilities = (Array.isArray(requiredCapabilities) ? requiredCapabilities : [])
    .filter((capability) => capability?.access === 'write');
  const grantRequirements = uniqueStrings(writeCapabilities.map((capability) => capability.grant_required || 'none'));
  const requiredCapabilityClasses = uniqueStrings(writeCapabilities.map((capability) => capability.required_capability_class));
  const blockers = [];

  if (!actor?.actor_id || actor.unknown) {
    blockers.push({ code: 'authority_actor_unknown', detail: 'A durable owner actor is required before Donna can attach authority to an apply request.' });
  }
  if (!selectedMutation) {
    blockers.push({ code: 'authority_mutation_route_missing', detail: 'Authority cannot be evaluated until a registered mutation route is selected.' });
  }
  if (consequenceDiff?.status !== 'computed') {
    blockers.push({ code: 'authority_consequence_diff_missing', detail: 'Owner confirmation cannot authorize an apply without a fresh computed consequence diff.' });
  }
  if (grantRequirements.includes('scoped_grant')) {
    blockers.push({ code: 'scoped_authority_grant_missing', detail: 'This capability requires a scoped authority grant; this slice does not materialize grants.' });
  }

  return {
    status: blockers.length ? 'blocked' : 'owner_confirmation_required',
    owner_confirmation_sufficient: blockers.length === 0 && !grantRequirements.includes('scoped_grant'),
    requires_additional_authority: blockers.length > 0 || grantRequirements.includes('scoped_grant'),
    actor: actor ? {
      actor_id: actor.actor_id || null,
      actor_type: actor.actor_type || 'owner',
      basis: actor.basis || null,
      unknown: Boolean(actor.unknown)
    } : null,
    selected_mutation: selectedMutation ? {
      verb: selectedMutation.verb,
      writer: selectedMutation.writer,
      autonomy_class: selectedMutation.autonomy_class || null
    } : null,
    required_capabilities: writeCapabilities.map((capability) => ({
      capability: capability.capability,
      grant_required: capability.grant_required || 'none',
      required_capability_class: capability.required_capability_class || null,
      risk_class: capability.risk_class || null,
      side_effect_class: capability.side_effect_class || null
    })),
    grant_requirements: grantRequirements.length ? grantRequirements : ['none'],
    required_capability_classes: requiredCapabilityClasses,
    materialized_grant_id: null,
    blockers,
    receipt_basis: {
      authority_source: 'owner_accept_time_confirmation_pending',
      model_id_committed: false
    }
  };
};


export const buildOwnerIntentExecutionGate = ({
  applyPlan = null,
  consequenceDiff = null,
  authorityEnvelope = null,
  actorAttribution = null
} = {}) => {
  const selectedMutation = applyPlan?.selected_mutation || authorityEnvelope?.selected_mutation || null;
  return {
    status: 'blocked',
    enabled: false,
    writer_invoked: false,
    apply_receipt_required: true,
    apply_receipt_persisted: false,
    authority_materialized: false,
    selected_mutation: selectedMutation ? {
      verb: selectedMutation.verb || null,
      writer: selectedMutation.writer || null,
      autonomy_class: selectedMutation.autonomy_class || selectedMutation.autonomyClass || null
    } : null,
    selected_writer: selectedMutation?.writer || null,
    consequence_diff_status: consequenceDiff?.status || null,
    authority_status: authorityEnvelope?.status || null,
    actor: actorAttribution ? {
      actor_id: actorAttribution.actor_id || null,
      actor_type: actorAttribution.actor_type || 'owner',
      basis: actorAttribution.basis || null,
      unknown: Boolean(actorAttribution.unknown)
    } : null,
    reasons: [{
      code: 'apply_executor_not_enabled',
      detail: 'Owner-intent apply executor is not enabled in this slice; no mutation writer is invoked.'
    }, {
      code: 'apply_receipt_bridge_missing',
      detail: 'Owner-intent apply requires an apply receipt bridge before execution can be enabled.'
    }, {
      code: 'authority_materialization_not_enabled',
      detail: 'Owner-intent apply cannot materialize authority grants in this slice.'
    }]
  };
};

export const buildOwnerIntentApplyPlan = ({
  object = null,
  requiredCapabilities = [],
  findMutationEntryFn = findMutationEntry
} = {}) => {
  const blockers = [];
  const candidates = [];
  const writeCapabilities = (Array.isArray(requiredCapabilities) ? requiredCapabilities : [])
    .filter((capability) => capability?.access === 'write');

  for (const capability of writeCapabilities) {
    if (capability.domain !== 'finance') {
      blockers.push({
        code: 'non_accounting_capability_not_executable',
        capability: capability.capability,
        detail: `Capability "${capability.capability}" is not an accounting mutation route for owner-intent accept.`
      });
      continue;
    }
    const mutation = findMutationEntryFn(capability.verb);
    if (!mutation || mutation.writer !== capability.executor) {
      blockers.push({
        code: 'mutation_route_not_registered',
        capability: capability.capability,
        detail: `Capability "${capability.capability}" does not resolve to a registered accounting mutation writer.`
      });
      continue;
    }
    candidates.push({
      capability: capability.capability,
      verb: mutation.verb,
      writer: mutation.writer,
      autonomy_class: mutation.autonomyClass,
      convergence_impact: Array.isArray(mutation.convergenceImpact) ? [...mutation.convergenceImpact] : [],
      reversibility: mutation.reversibility || null,
      preflight_today: mutation.preflightToday || null,
      execution_receipt: mutation.emitsApplyReceipt || null,
      audit_record: mutation.emitsAudit || null
    });
  }

  if (!writeCapabilities.length) {
    blockers.push({
      code: 'no_write_capability',
      detail: 'The staged intent object does not name a registered write capability Donna can plan against.'
    });
  }
  if (!candidates.length) {
    blockers.push({
      code: 'no_supported_mutation_route',
      detail: 'No existing named accounting mutation route is available for this owner-intent object.'
    });
  }

  const selected = candidates[0] || null;
  const consequenceDiff = buildOwnerIntentReadOnlyConsequenceDiff({ object, selectedMutation: selected });
  if (Array.isArray(consequenceDiff.blockers)) blockers.push(...consequenceDiff.blockers);
  return {
    status: blockers.length ? 'blocked' : 'planned',
    object_kind: object?.kind || null,
    selected_mutation: selected,
    candidate_mutations: candidates,
    blockers,
    consequence_diff: consequenceDiff,
    execution: {
      enabled: false,
      reason: 'Owner-intent apply planning is read-only in this slice; no writer is invoked.'
    }
  };
};

export const buildOwnerIntentAcceptPreflight = ({
  card,
  actor = null,
  findCapabilityFn = findCapability,
  findMutationEntryFn = findMutationEntry,
  now = null
} = {}) => {
  const blockers = [];
  const requiredCapabilities = [];
  const detail = card?.detail && typeof card.detail === 'object' ? card.detail : {};
  const object = detail.object && typeof detail.object === 'object' ? detail.object : null;

  if (!card) blockers.push({ code: 'proposal_not_found', detail: 'Owner-intent proposal card was not found for this client.' });
  if (card && card.proposal_type !== 'owner_intent_candidate') {
    blockers.push({ code: 'wrong_proposal_type', detail: 'Only owner_intent_candidate proposal cards can be prepared here.' });
  }
  if (card && card.status !== 'proposed') {
    blockers.push({ code: 'proposal_not_reviewable', detail: `Proposal is ${card.status || 'not proposed'}.` });
  }
  if (!object) {
    blockers.push({ code: 'intent_object_missing', detail: 'The staged proposal does not carry a validated intent object.' });
  } else if (!INTENT_OBJECT_KINDS.includes(object.kind)) {
    blockers.push({ code: 'unsupported_intent_kind', detail: `Intent kind "${object.kind || 'unknown'}" is not registered for intent_compile.v1.` });
  }

  const candidateCapabilities = uniqueStrings(object?.candidate_capabilities || []);
  const unmetCapabilities = uniqueStrings((detail.unmet_capability_needs || []).map((need) => need?.capability));
  for (const capabilityId of uniqueStrings([...candidateCapabilities, ...unmetCapabilities])) {
    const entry = findCapabilityFn(capabilityId);
    if (entry) {
      requiredCapabilities.push({
        capability: capabilityId,
        domain: entry.domain || null,
        verb: entry.verb || null,
        executor: entry.executor || null,
        access: entry.access || null,
        side_effect_class: entry.side_effect_class || null,
        risk_class: entry.risk_class || null,
        dry_run: entry.dry_run || null,
        execution_receipt: entry.execution_receipt || null,
        preflight: entry.preflight || null,
        grant_required: entry.authority_requirements?.grant_required || null,
        required_capability_class: entry.authority_requirements?.required_capability_class || null,
        autonomy_class: entry.authority_requirements?.autonomy_class || null
      });
    } else {
      blockers.push({ code: 'unsupported_capability', capability: capabilityId, detail: `Capability "${capabilityId}" is not registered.` });
    }
  }

  if (!actor?.actor_id || actor.unknown) {
    blockers.push({ code: 'actor_unknown', detail: 'Owner actor is explicitly unknown; apply requires durable owner attribution.' });
  }
  const applyPlan = buildOwnerIntentApplyPlan({ object, requiredCapabilities, findMutationEntryFn });
  const authorityEnvelope = buildOwnerIntentAuthorityEnvelope({
    actor,
    requiredCapabilities,
    selectedMutation: applyPlan.selected_mutation,
    consequenceDiff: applyPlan.consequence_diff
  });
  blockers.push(...applyPlan.blockers);
  if (applyPlan.consequence_diff.status !== 'computed') {
    blockers.push({
      code: 'consequence_diff_not_computed',
      detail: 'Accept/apply requires a fresh writer-specific consequence diff; staged before_after is not trusted.'
    });
  }
  if (authorityEnvelope.status === 'blocked') {
    blockers.push({
      code: 'authority_envelope_blocked',
      detail: 'Accept/apply requires a complete authority envelope; no authority grant is materialized in this slice.',
      authority_blockers: authorityEnvelope.blockers
    });
  }
  const executionGate = buildOwnerIntentExecutionGate({
    applyPlan,
    consequenceDiff: applyPlan.consequence_diff,
    authorityEnvelope,
    actorAttribution: actor
  });
  blockers.push(...executionGate.reasons.filter((reason) => reason.code === 'apply_executor_not_enabled'));

  const status = blockers.length ? 'blocked' : 'requires_confirmation';
  return {
    status,
    prepared_at: now || null,
    proposal_id: card?.id || null,
    object_kind: object?.kind || null,
    required_capabilities: requiredCapabilities,
    blockers,
    authority: {
      ...authorityEnvelope,
      reason: applyPlan.selected_mutation
        ? 'Owner confirmation alone is not enough until the selected writer route has a real consequence diff and authority envelope.'
        : 'No authority or mutation may be materialized until accept-time planning/preflight resolves a supported writer route.'
    },
    consequence_diff: applyPlan.consequence_diff,
    apply_plan: applyPlan,
    execution_gate: executionGate,
    actor: actor ? {
      actor_id: actor.actor_id || null,
      actor_type: actor.actor_type || 'owner',
      basis: actor.basis || null,
      unknown: Boolean(actor.unknown)
    } : null
  };
};

export const prepareOwnerIntentProposalPreflight = async ({
  client,
  firmId,
  clientId,
  proposalId,
  actor = null,
  getCard = getOwnerIntentProposalCardForPreflight,
  recordReport = recordOwnerIntentPreflightReport,
  findCapabilityFn = findCapability,
  findMutationEntryFn = findMutationEntry,
  now = null
} = {}) => {
  if (!client || !firmId || !clientId || !proposalId) {
    return { status: 'refused', reason: 'missing_inputs', statusCode: 400 };
  }
  const card = await getCard({ client, firmId, clientId, proposalId });
  const preflight = buildOwnerIntentAcceptPreflight({ card, actor, findCapabilityFn, findMutationEntryFn, now });
  if (!card) return { status: 'refused', reason: 'proposal_not_found', statusCode: 404, preflight };
  const checkStatus = checkStatusForOwnerIntentPreflight(preflight.status);
  const report = {
    status: checkStatus,
    checks: [{
      name: 'owner_intent_accept_preflight',
      status: checkStatus,
      detail: preflight.blockers.length
        ? 'Owner-intent proposal cannot be applied without resolving blockers.'
        : 'Owner-intent proposal is ready for owner confirmation in a later apply slice.',
      blockers: preflight.blockers,
      required_capabilities: preflight.required_capabilities,
      authority: preflight.authority,
      consequence_diff: preflight.consequence_diff,
      apply_plan: preflight.apply_plan,
      execution_gate: preflight.execution_gate,
      actor: preflight.actor
    }]
  };
  await recordReport({ client, firmId, clientId, proposalId, report });
  return { status: preflight.status, preflight };
};

export const attemptOwnerIntentProposalAccept = async ({
  client,
  firmId,
  clientId,
  proposalId,
  actor = null,
  getCard = getOwnerIntentProposalCardForPreflight,
  recordReport = recordOwnerIntentPreflightReport,
  findCapabilityFn = findCapability,
  findMutationEntryFn = findMutationEntry,
  now = null
} = {}) => {
  if (!client || !firmId || !clientId || !proposalId) {
    return { status: 'refused', reason: 'missing_inputs', statusCode: 400 };
  }
  const card = await getCard({ client, firmId, clientId, proposalId });
  const preflight = buildOwnerIntentAcceptPreflight({ card, actor, findCapabilityFn, findMutationEntryFn, now });
  if (!card) return { status: 'refused', reason: 'proposal_not_found', statusCode: 404, preflight };
  const blocked = preflight.blockers.length > 0 || preflight.consequence_diff?.status !== 'computed';
  const status = blocked ? 'blocked' : 'refused';
  const checkStatus = checkStatusForOwnerIntentPreflight(preflight.status);
  const report = {
    status: checkStatus,
    checks: [{
      name: 'owner_intent_accept_preflight',
      status: checkStatus,
      detail: 'Owner requested apply; Donna re-ran fresh preflight before considering execution.',
      blockers: preflight.blockers,
      required_capabilities: preflight.required_capabilities,
      authority: preflight.authority,
      consequence_diff: preflight.consequence_diff,
      apply_plan: preflight.apply_plan,
      execution_gate: preflight.execution_gate,
      actor: preflight.actor
    }, {
      name: 'owner_intent_accept_refused',
      status: 'requires_review',
      detail: blocked
        ? 'Owner apply request refused because blockers or missing consequence diff remain; no mutation was executed.'
        : 'Owner apply request refused because the apply executor is not enabled in this slice.',
      reason: blocked ? 'preflight_blocked' : 'apply_not_enabled',
      actor: preflight.actor
    }]
  };
  await recordReport({ client, firmId, clientId, proposalId, report });
  return {
    status,
    reason: blocked ? 'preflight_blocked' : 'apply_not_enabled',
    statusCode: 409,
    preflight
  };
};
