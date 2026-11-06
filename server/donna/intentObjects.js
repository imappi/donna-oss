// Donna — the proposed-intent-object contract (BizOS Slice 1b, D-PA-5 as amended).
//
// The typed objects an owner instruction compiles into (design-donna-personal-agent.md §3b,
// contract pinned in design-donna-bizos-slice-1-intent-capability.md §5-§6). Three boundary
// rules from Kari's 2026-07-12 review are load-bearing here:
//
//   1. These are PROPOSALS, not effective business objects. The compiler emits candidates;
//      a later deterministic materializer validates and creates the authoritative object.
//      A compiled authority_grant is ALWAYS a grant request — it cannot become an effective
//      grant without deterministic identity binding, delegator-authority validation, and any
//      required confirmation (this validator refuses a payload that claims effectiveness).
//   2. Interpretation must not masquerade as planning. candidate_capabilities are ADVISORY:
//      registered ids are retained, unknown ids are DISCARDED and recorded as unmet
//      capability needs — never stored, never grounds for rejecting the candidate. An
//      unsupported request still compiles; Donna must understand needs she cannot execute.
//   3. The trust boundary (design §12), concretely: the model proposes kind/payload/links;
//      deterministic code refuses unknown kinds, dangling links, closed-envelope violations,
//      and any model-computed time arithmetic — relative time is a STRUCTURED offset the
//      runtime resolves against authoritative clock/timezone data, never a model-resolved
//      instant.
//
// The taxonomy is closed PER CONTRACT VERSION (intent_compile.v1 → nine kinds), not closed
// forever: a future kind requires intent_compile.v2 with migration rules + re-baselined
// evaluations. Validation supports PARTIAL SUCCESS: one malformed candidate never destroys
// the valid ones — rejections land per-candidate on the compile result.
//
// Pure leaf: imports only the capability registry (itself a pure leaf) + node:crypto.

import { createHash } from 'node:crypto';

import { isRegisteredCapability as registryHasCapability } from './capabilityRegistry.js';

export const INTENT_COMPILE_CONTRACT_VERSION = 'intent_compile.v1';

// The nine kinds (D-PA-5 as amended — `commitment` is Donna's accountable promise to
// deliver an outcome; the automation that triggers it is the mechanism, not the promise).
// External communication and business-system mutation are NOT kinds — they are tasks or
// workflow steps the PLANNER resolves to capabilities.
export const INTENT_OBJECT_KINDS = Object.freeze([
  'memory',          // an assertion retained for later contextual use
  'preference',      // a soft default that may be overridden
  'policy',          // an enforceable rule or constraint
  'goal',            // an ongoing desired business state
  'commitment',      // an accountable promise Donna has accepted
  'task',            // a finite desired outcome
  'automation',      // a persistent trigger + conditions that initiate work
  'workflow',        // a reusable multi-step procedure definition
  'authority_grant'  // a proposed delegation of permission — always a REQUEST
]);

export const INTENT_LINK_RELS = Object.freeze([
  'reminds_about', 'fulfills', 'scheduled_by', 'delivers', 'supersedes', 'depends_on'
]);

// The compiler's confidence in its INTERPRETATION — advisory, never a gate the model grants
// itself, and it says nothing about whether the asserted fact is objectively true (the
// design §4 two-confidences distinction; truth confidence belongs to the memory model).
export const PARSE_CONFIDENCES = Object.freeze(['low', 'medium', 'high']);

export const COMPILE_FAILURE_CATEGORIES = Object.freeze([
  null, 'model_error', 'schema_invalid', 'timeout', 'budget_exceeded'
]);

// ── time_spec: the structured-time rule ──────────────────────────────────────────
// Either the OWNER said an absolute time (kept verbatim as calendar data + timezone) or a
// relative one (kept as offset + anchor). A relative spec carrying a resolved instant is the
// exact violation this shape exists to refuse — that resolution is the runtime's job.

export const TIME_SPEC_TYPES = Object.freeze(['absolute', 'relative']);
export const TIME_OFFSET_UNITS = Object.freeze(['minutes', 'hours', 'days', 'weeks', 'months']);

const ABSOLUTE_INSTANT_FIELDS = ['iso_datetime', 'iso_date', 'resolved_at', 'timestamp', 'epoch_ms'];

export const validateTimeSpec = (spec, path = 'time_spec') => {
  const errors = [];
  if (!spec || typeof spec !== 'object') return [`${path}: not an object`];
  if (spec.type === 'absolute') {
    if (typeof spec.iso_date !== 'string' && typeof spec.iso_datetime !== 'string') {
      errors.push(`${path}: absolute spec needs iso_date or iso_datetime`);
    }
  } else if (spec.type === 'relative') {
    if (!Number.isFinite(spec.offset_amount) || spec.offset_amount <= 0) {
      errors.push(`${path}: relative spec needs a positive offset_amount`);
    }
    if (!TIME_OFFSET_UNITS.includes(spec.offset_unit)) {
      errors.push(`${path}: offset_unit "${spec.offset_unit}"`);
    }
    if (typeof spec.anchor !== 'string' || !spec.anchor) {
      errors.push(`${path}: relative spec needs an anchor (a local_id or a named authoritative anchor)`);
    }
    for (const field of ABSOLUTE_INSTANT_FIELDS) {
      if (field in spec) {
        errors.push(`${path}: relative spec carries a resolved instant ("${field}") — time arithmetic belongs to the runtime, never the model`);
      }
    }
  } else {
    errors.push(`${path}: type "${spec.type}"`);
  }
  return errors;
};

// ── Per-kind payload requirements (v1 — minimal but real) ────────────────────────
// One required text field per kind plus shape rules for known structured members. The kind
// payloads DEEPEN with their real homes (Slice 2 memory model, Slice 3 workflow runtime);
// this v1 floor exists so a candidate is never a vaguely-typed blob.

const requireText = (payload, field, kind) =>
  typeof payload?.[field] === 'string' && payload[field].trim()
    ? []
    : [`payload.${field}: ${kind} requires a non-empty "${field}"`];

const KIND_PAYLOAD_VALIDATORS = Object.freeze({
  memory: (p) => requireText(p, 'statement', 'memory'),
  preference: (p) => requireText(p, 'statement', 'preference'),
  policy: (p) => requireText(p, 'statement', 'policy'),
  goal: (p) => requireText(p, 'desired_state', 'goal'),
  commitment: (p) => requireText(p, 'promise', 'commitment'),
  task: (p) => requireText(p, 'outcome', 'task'),
  automation: (p) => {
    const errors = requireText(p, 'action_summary', 'automation');
    if (!p?.trigger || typeof p.trigger !== 'object') {
      errors.push('payload.trigger: automation requires a trigger object');
    } else if (p.trigger.time_spec) {
      errors.push(...validateTimeSpec(p.trigger.time_spec, 'payload.trigger.time_spec'));
    } else if (typeof p.trigger.condition !== 'string' || !p.trigger.condition.trim()) {
      errors.push('payload.trigger: needs a time_spec or a condition');
    }
    return errors;
  },
  workflow: (p) =>
    Array.isArray(p?.steps) && p.steps.length > 0
      ? []
      : ['payload.steps: workflow requires a non-empty steps array'],
  authority_grant: (p) => {
    const errors = requireText(p, 'requested_scope', 'authority_grant');
    // The grant-request rule, enforced structurally: a compiled grant may never claim to be
    // in effect. Effectiveness is minted only by the deterministic materializer after
    // identity binding + delegator validation + confirmation.
    for (const field of ['effective', 'granted', 'active', 'approved']) {
      if (field in (p || {})) {
        errors.push(`payload.${field}: a compiled authority_grant is always a grant REQUEST — it cannot claim effectiveness`);
      }
    }
    return errors;
  }
});

// Shared optional member: a top-level payload.time_spec is validated wherever present.
const validatePayload = (kind, payload) => {
  if (!payload || typeof payload !== 'object') return ['payload: not an object'];
  const errors = KIND_PAYLOAD_VALIDATORS[kind](payload);
  if ('time_spec' in payload) errors.push(...validateTimeSpec(payload.time_spec, 'payload.time_spec'));
  return errors;
};

// ── proposed_intent_object validation ────────────────────────────────────────────

const OBJECT_FIELDS = Object.freeze([
  'local_id', 'kind', 'summary', 'payload', 'links',
  'candidate_capabilities', 'source_refs', 'parse_confidence'
]);

// One candidate → { errors, sanitized, unmetCapabilityNeeds }. `sanitized` (present only
// when errors is empty) is the candidate with unknown capability ids REMOVED — they are
// recorded as unmet needs, never stored (rule 2 above) and never a rejection reason.
export const validateProposedIntentObject = (
  obj,
  { isRegisteredCapability = registryHasCapability } = {}
) => {
  const errors = [];
  const unmetCapabilityNeeds = [];
  if (!obj || typeof obj !== 'object') return { errors: ['candidate is not an object'], sanitized: null, unmetCapabilityNeeds };

  for (const key of Object.keys(obj)) {
    if (!OBJECT_FIELDS.includes(key)) errors.push(`unknown field "${key}" (closed envelope)`);
  }
  if (typeof obj.local_id !== 'string' || !obj.local_id.trim()) errors.push('local_id: required');
  if (!INTENT_OBJECT_KINDS.includes(obj.kind)) errors.push(`kind "${obj.kind}" is not in ${INTENT_COMPILE_CONTRACT_VERSION}`);
  if (typeof obj.summary !== 'string' || !obj.summary.trim()) errors.push('summary: required');

  if (INTENT_OBJECT_KINDS.includes(obj.kind)) errors.push(...validatePayload(obj.kind, obj.payload));

  const links = obj.links ?? [];
  if (!Array.isArray(links)) {
    errors.push('links: must be an array');
  } else {
    for (const link of links) {
      if (!link || typeof link !== 'object' || !INTENT_LINK_RELS.includes(link.rel) || typeof link.local_id !== 'string') {
        errors.push(`links: bad link ${JSON.stringify(link)} (rel ∈ ${INTENT_LINK_RELS.join('/')}, local_id required)`);
      }
    }
  }

  if (!Array.isArray(obj.source_refs) || obj.source_refs.length === 0) {
    errors.push('source_refs: at least one { message_id, verbatim_span } required');
  } else {
    for (const ref of obj.source_refs) {
      if (!ref || typeof ref.message_id !== 'string' || typeof ref.verbatim_span !== 'string') {
        errors.push('source_refs: each ref needs message_id + verbatim_span');
      }
    }
  }

  if (!PARSE_CONFIDENCES.includes(obj.parse_confidence)) {
    errors.push(`parse_confidence "${obj.parse_confidence}"`);
  }

  // Advisory capability ids: retained when registered, discarded-and-recorded when not.
  let retainedCapabilities = [];
  const rawCapabilities = obj.candidate_capabilities ?? [];
  if (!Array.isArray(rawCapabilities)) {
    errors.push('candidate_capabilities: must be an array when present');
  } else {
    for (const id of rawCapabilities) {
      if (typeof id !== 'string' || !id) continue;
      if (isRegisteredCapability(id)) retainedCapabilities.push(id);
      else unmetCapabilityNeeds.push({ local_id: obj.local_id, capability: id });
    }
  }

  if (errors.length) return { errors, sanitized: null, unmetCapabilityNeeds };
  return {
    errors: [],
    sanitized: Object.freeze({ ...obj, links, candidate_capabilities: Object.freeze(retainedCapabilities) }),
    unmetCapabilityNeeds
  };
};

// ── intent_compile_result validation (partial success) ───────────────────────────

export const RESULT_FIELDS = Object.freeze([
  'contract_version', 'compile_id', 'source_message_id', 'objects',
  'clarification_requests', 'unsupported_spans', 'unmet_capability_needs',
  'validation_warnings', 'model_id', 'prompt_version', 'validator_version',
  'registry_fingerprint', 'config_snapshot_id', 'token_usage', 'latency_ms',
  'failure_category',
  // M3 — the llmCall envelope's telemetry (sizes, counts, the typed execution
  // ref, and the SERVED model id). Deliberately ADDITIVE and OPTIONAL, with no
  // contract_version bump: `contract_version` participates in `compile_id`, so
  // bumping it would recompute every id and defeat the dedup this lane runs on,
  // and it exists to force that recompute when what the MODEL must produce
  // changes. This is measurement OF the call, not part of the compile.
  //
  // Note `model_id` above is the REQUESTED model; `telemetry.model` is the one
  // the API actually served, with `model_source` making a fallback visible.
  // That is the OPENAI_MODEL=gpt-5.4-nano incident, on this lane, in the data.
  'telemetry'
]);

export const INTENT_VALIDATOR_VERSION = 'intent_validator.v1';

// Raw model output → the validated half of the compile result. PARTIAL SUCCESS: valid
// candidates land in `objects`, each malformed one in `validation_warnings` with its
// reasons; a link to a local_id that is missing OR itself rejected is dangling (the target
// cannot be materialized, so the edge is unsound). Duplicated local_ids reject the later
// occurrence. Unknown capability ids aggregate into `unmet_capability_needs`.
export const validateCompiledObjects = (
  candidates,
  { isRegisteredCapability = registryHasCapability } = {}
) => {
  const list = Array.isArray(candidates) ? candidates : [];
  const perCandidate = [];
  const seenIds = new Set();
  for (const candidate of list) {
    const verdict = validateProposedIntentObject(candidate, { isRegisteredCapability });
    const localId = typeof candidate?.local_id === 'string' ? candidate.local_id : null;
    if (verdict.errors.length === 0 && localId) {
      if (seenIds.has(localId)) {
        perCandidate.push({ candidate, errors: [`local_id "${localId}" duplicates an earlier candidate`], sanitized: null, unmetCapabilityNeeds: [] });
        continue;
      }
      seenIds.add(localId);
    }
    perCandidate.push({ candidate, ...verdict });
  }

  const validationWarnings = [];
  const unmetCapabilityNeeds = [];
  for (const verdict of perCandidate) {
    unmetCapabilityNeeds.push(...verdict.unmetCapabilityNeeds);
    if (!verdict.sanitized) {
      validationWarnings.push({
        local_id: verdict.candidate?.local_id ?? null,
        kind: verdict.candidate?.kind ?? null,
        errors: verdict.errors
      });
    }
  }
  // Link resolution runs to a FIXPOINT: rejecting an object with a dangling link (missing
  // target, rejected target, or a self-link) can strand objects that linked TO it, so the
  // sweep repeats until stable — an accepted object's links always land on other accepted
  // objects, never on a warning.
  let accepted = perCandidate.filter((v) => v.sanitized).map((v) => v.sanitized);
  for (;;) {
    const acceptedIds = new Set(accepted.map((o) => o.local_id));
    const stranded = accepted.filter((o) =>
      o.links.some((l) => !acceptedIds.has(l.local_id) || l.local_id === o.local_id)
    );
    if (!stranded.length) break;
    for (const o of stranded) {
      const acceptedIdsNow = new Set(accepted.map((x) => x.local_id));
      validationWarnings.push({
        local_id: o.local_id,
        kind: o.kind,
        errors: o.links
          .filter((l) => !acceptedIdsNow.has(l.local_id) || l.local_id === o.local_id)
          .map((l) => `dangling link ${l.rel} → "${l.local_id}"`)
      });
    }
    const strandedIds = new Set(stranded.map((o) => o.local_id));
    accepted = accepted.filter((o) => !strandedIds.has(o.local_id));
  }
  return { objects: Object.freeze(accepted), validationWarnings, unmetCapabilityNeeds };
};

// Deterministic compile idempotency key (addendum §7): a retry of the same owner message
// under the same contract/prompt/model/registry updates or deduplicates the SAME compile
// attempt — never double-records. Content-addressed like configSnapshotId.
export const intentCompileId = ({
  sourceMessageId, contractVersion = INTENT_COMPILE_CONTRACT_VERSION,
  promptVersion, modelId, registryFingerprint
} = {}) => {
  if (!sourceMessageId || !promptVersion || !modelId || !registryFingerprint) {
    throw new Error('intentCompileId requires sourceMessageId, promptVersion, modelId, registryFingerprint');
  }
  const canonical = JSON.stringify({
    source_message_id: sourceMessageId,
    contract_version: contractVersion,
    prompt_version: promptVersion,
    model_id: modelId,
    registry_fingerprint: registryFingerprint
  });
  return `ic-${createHash('sha256').update(canonical).digest('hex')}`;
};

// Result-level validation: the envelope 1c persists. Clarifications live at RESULT level,
// each linked to the local_ids it affects (design §10's bounded clarification — never a
// dead-end nudge); an affected id must reference a local_id from this compile (accepted or
// rejected — a clarification about a rejected candidate is legitimate).
export const validateIntentCompileResult = (result) => {
  const errors = [];
  if (!result || typeof result !== 'object') return ['result is not an object'];
  for (const key of Object.keys(result)) {
    if (!RESULT_FIELDS.includes(key)) errors.push(`unknown field "${key}" (closed envelope)`);
  }
  if (result.contract_version !== INTENT_COMPILE_CONTRACT_VERSION) {
    errors.push(`contract_version "${result.contract_version}" (expected ${INTENT_COMPILE_CONTRACT_VERSION})`);
  }
  if (typeof result.compile_id !== 'string' || !/^ic-[0-9a-f]{64}$/.test(result.compile_id)) {
    errors.push('compile_id: must be the deterministic ic-<sha256> key');
  }
  if (typeof result.source_message_id !== 'string' || !result.source_message_id) {
    errors.push('source_message_id: required');
  }
  if (!Array.isArray(result.objects)) errors.push('objects: must be an array');
  if (!Array.isArray(result.validation_warnings)) errors.push('validation_warnings: must be an array');
  if (!Array.isArray(result.unsupported_spans)) errors.push('unsupported_spans: must be an array');
  if (!Array.isArray(result.unmet_capability_needs)) errors.push('unmet_capability_needs: must be an array');
  for (const field of ['model_id', 'prompt_version', 'validator_version', 'registry_fingerprint']) {
    if (typeof result[field] !== 'string' || !result[field]) errors.push(`${field}: required (the receipt is reconstructible or it is not a receipt)`);
  }
  if (!COMPILE_FAILURE_CATEGORIES.includes(result.failure_category ?? null)) {
    errors.push(`failure_category "${result.failure_category}"`);
  }
  const knownIds = new Set([
    ...(Array.isArray(result.objects) ? result.objects.map((o) => o?.local_id) : []),
    ...(Array.isArray(result.validation_warnings) ? result.validation_warnings.map((w) => w?.local_id) : [])
  ]);
  const clarifications = result.clarification_requests ?? [];
  if (!Array.isArray(clarifications)) {
    errors.push('clarification_requests: must be an array');
  } else {
    for (const c of clarifications) {
      if (!c || typeof c.question !== 'string' || !c.question.trim() || !Array.isArray(c.affected_local_ids)) {
        errors.push('clarification_requests: each needs a question + affected_local_ids');
        continue;
      }
      for (const id of c.affected_local_ids) {
        if (!knownIds.has(id)) errors.push(`clarification_requests: affected id "${id}" is not from this compile`);
      }
    }
  }
  return errors;
};
