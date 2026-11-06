// Donna — the memory.*.v1 domain pack (BizOS Slice 2a, addendum §11).
//
// Six capabilities registered DARK and uncalled — no routing change; the executors are the
// Slice-2b writers / 2c retrieval service, named here as contracts so they can never become
// an informal parallel API (Kari amendment 17). Because these are NEW capabilities, NONE
// uses a legacy exemption: closed schemas, declared idempotency, named execution verifiers,
// live receipts + preflight (the validator IS the write preflight), and eval scenario ids
// from the memory suite are all present at registration. The Slice-1 lint enforces this —
// a gap on any of these entries fails capabilityRegistry.test.js by name.
//
// Pure leaf: imports only memoryModel.js (the scenario ids + vocabulary the schemas cite).

import { MEMORY_EVAL_SCENARIOS, MEMORY_SCOPE_TYPES, MEMORY_KINDS } from './memoryModel.js';

const closed = (properties, required = Object.keys(properties)) => ({
  type: 'object',
  additionalProperties: false,
  required,
  properties
});

const S = Object.freeze({
  id: { type: 'string' },
  text: { type: 'string' },
  scope: { type: 'string', enum: [...MEMORY_SCOPE_TYPES] },
  kind: { type: 'string', enum: [...MEMORY_KINDS] },
  object: { type: 'object' }
});

// The persisted-write result every writer returns (and the receipt pins).
const WRITE_RESULT_SCHEMA = closed({
  memory_key: S.id,
  memory_id: S.id,
  revision: { type: 'integer' },
  content_hash: S.id,
  record_state: S.text
});

const writeCapability = ({ verb, summaryInput, executor, verifier, scenarios, riskClass = 'medium', reversibility = 'reversible_via_adjustment' }) => ({
  capability: `memory.${verb}.v1`,
  domain: 'memory',
  verb,
  version: 1,
  input_schema: summaryInput,
  output_schema: WRITE_RESULT_SCHEMA,
  schema_status: 'declared',
  access: 'write',
  side_effect_class: 'governed_memory',
  risk_class: riskClass,
  reversibility,
  dry_run: 'supported',            // pinned 2b contract: every writer takes dryRun
  idempotency: 'natural_key',      // the memory_key slot + content_hash upsert discipline
  authority_requirements: {
    autonomy_class: 'memory',      // memory mints are forbidden autonomously (registry vocab)
    required_capability_class: 'founder',
    grant_required: 'none'         // enforcement wiring is D-PA-9's slice; records reality
  },
  legacy_entrypoint_bindings: { surfaces: [] }, // no chat surface routes here yet
  executor,
  execution_verifier: verifier,
  audit_record: 'yes',             // atomic audit+mutation (addendum §6) — from birth
  execution_receipt: 'live',
  preflight: 'live',               // validateMemoryRecord gates every write
  preflight_alternative: null,
  eval_scenarios: scenarios
});

export const memoryCapabilityPack = () => Object.freeze([
  // memory.retrieve.v2 — the governed retrieval service (Slice 2c-i). The dark,
  // never-executed memory.retrieve.v1 is RETIRED (not edited in place): both its
  // input (now the trusted_context / request split) and its output (now the
  // prompt-safe SECTIONAL projection) changed, which is a NEW capability id +
  // registry fingerprint, never a silent mutation of a pinned contract
  // (design §5/§7, amendment 5). Regenerate the snapshot in the same commit.
  {
    capability: 'memory.retrieve.v2',
    domain: 'memory',
    verb: 'retrieve',
    version: 2,
    input_schema: closed({
      // Server-authenticated context — never a caller/model claim (§3).
      trusted_context: closed({
        tenant_id: S.id,
        authenticated_principal: S.object,   // who actually asked (resolved)
        delegated_principal: S.object,        // whose authority + private context applies
        resolved_audience: S.object,          // who will actually SEE the output surface
        source_surface: S.text,
        consumer_capability_id: S.id,         // DERIVED from the calling executor, not claimed
        source_event_id: S.id,
        conversation_ref: S.text,
        occurred_at: S.text,                  // the authoritative clock (normal as_of)
        config_snapshot_id: S.id
      }, ['tenant_id', 'authenticated_principal', 'delegated_principal', 'resolved_audience', 'source_surface', 'consumer_capability_id', 'source_event_id', 'occurred_at']),
      // The only caller-chosen inputs (§3).
      request: closed({
        purpose_id: S.id,                     // closed + registered — never caller prose (§5)
        subject_refs: { type: 'array', items: closed({ subject_type: S.text, subject_id: S.id }) },
        budget_override: S.object             // may only LOWER the registered maximum (§13)
      }, ['purpose_id'])
    }),
    output_schema: closed({
      // The prompt-safe SECTIONAL projection (§7) + the CONSUMER receipt (§9);
      // the privileged security-audit record is split OUT (never in this output).
      context_items: { type: 'array', items: S.object },
      conflict_markers: { type: 'array', items: S.object },
      confirmation_candidates: { type: 'array', items: S.object },
      authoritative_read_requirements: { type: 'array', items: S.object },
      receipt: S.object
    }),
    schema_status: 'declared',
    access: 'read',
    // A sensitive-memory read is NOT the least dangerous surface (§16): its
    // confidentiality impact can rival a write. side_effect_class stays 'none'
    // (no business-state mutation); the privileged-audit + shadow stamp are
    // control-plane effects, explicitly excluded from it. Risk is classified by
    // DATA-ACCESS, not side effects: restricted + high.
    side_effect_class: 'none',
    risk_class: 'high',
    data_access_class: 'restricted',
    reversibility: null,
    dry_run: 'unsupported',          // a read IS its own preview
    // The retrieval_id = H(source_event_id, purpose_id, service_version,
    // policy_version, config_snapshot_id) makes the control-plane audit write
    // idempotent — a retry never duplicates an audit row (§16).
    idempotency: 'natural_key',
    authority_requirements: {
      autonomy_class: 'workflow',    // loops may retrieve context autonomously; ACL guards content
      required_capability_class: 'viewer',
      grant_required: 'none'
    },
    legacy_entrypoint_bindings: { surfaces: [] }, // 2c-i is uncalled; wiring is 2c-ii
    executor: 'buildMemoryBundle',
    execution_verifier: null,
    audit_record: 'yes',             // the privileged security-audit half of the split receipt
    execution_receipt: 'live',
    preflight: 'none',
    // risk ≥ high with dry_run unsupported needs a named deterministic
    // alternative: the read projection IS a deterministic, side-effect-free
    // preview (the same rendered bundle + receipt a live read returns).
    preflight_alternative: 'deterministic_read_projection',
    eval_scenarios: [...MEMORY_EVAL_SCENARIOS]
  },
  writeCapability({
    verb: 'remember',
    summaryInput: closed({
      record: S.object               // a memory.v1 draft — validateMemoryRecord is the preflight
    }),
    executor: 'saveMemory',
    verifier: 'verifyMemoryRecordPersisted',
    scenarios: ['memory_poisoned_quoted_content', 'memory_ambiguous_subject', 'memory_cross_tenant_isolation']
  }),
  writeCapability({
    verb: 'correct',
    summaryInput: closed({
      prior_memory_id: S.id,
      changes: S.object
    }),
    executor: 'supersedeMemory',
    verifier: 'verifyMemoryRecordPersisted',
    scenarios: ['memory_conflicting_assertions', 'memory_stale_review_after']
  }),
  writeCapability({
    verb: 'dismiss',
    summaryInput: closed({
      memory_id: S.id,
      reason: S.text
    }),
    executor: 'dismissMemory',
    verifier: 'verifyMemoryRecordState',
    scenarios: ['memory_erased_exclusion']
  }),
  writeCapability({
    verb: 'erase',
    summaryInput: closed({
      lifecycle_owner_type: S.text,
      lifecycle_owner_id: S.id,
      memory_ids: { type: 'array', items: S.id }
    }),
    executor: 'eraseUserMemories',
    verifier: 'verifyMemoryErased',
    scenarios: ['memory_erased_exclusion', 'memory_cross_tenant_isolation'],
    riskClass: 'high',
    // Scrub-in-place is one-way by design. The reversibility vocabulary (operatorContract)
    // has no internal-irreversible class — null + this note rather than mislabelling it
    // 'irreversible_external'; revisit the vocabulary at its next version.
    reversibility: null
  }),
  writeCapability({
    verb: 'supersede',
    summaryInput: closed({
      prior_memory_id: S.id,
      record: S.object
    }),
    executor: 'supersedeMemory',
    verifier: 'verifyMemoryRecordPersisted',
    scenarios: ['memory_conflicting_assertions']
  })
]);
