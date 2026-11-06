// Donna — BizOS Slice 2c-i: the governed memory RETRIEVAL service
// (executor `buildMemoryBundle`, registered as `memory.retrieve.v2`).
//
// Built strictly to docs/design-donna-bizos-slice-2c-memory-retrieval.md (the
// §0-amended revision). This is the ONE governed-memory read path — a
// COMPOSITION primitive over the transitional stores (`memories` + the
// `firm_facts` one-way view), never a fifth read recipe. It turns an
// authenticated request into a deterministic, prompt-safe, sectional projection
// plus a split receipt, applying every governance rule between.
//
// THE PRINCIPLE, at its sharpest here (CLAUDE.md, donna-llm-trust-strategy.md):
// the strong model does NOT choose eligibility, identity, scope, visibility,
// sensitivity, lifecycle, purpose, audience, time, or whether a memory may be
// USED. Every one of those is decided by deterministic code below. The model's
// only sanctioned role (a later ranker, not in 2c-i) is to re-order an
// already-authorised, already-classified set. A retrieval failure yields NO
// memory context — it NEVER falls back to a laxer path (§12).
//
// The load-bearing boundaries (each machine-checked by the 2c tests):
//   - TRUSTED CONTEXT vs REQUEST (§3): principals, audience, surface, clock and
//     config are built by authenticated server code and cannot be forged by a
//     caller or the model. The `request` carries only purpose_id, RESOLVED
//     subject_refs, and a budget_override that may only LOWER the maximum.
//   - THE PURPOSE REGISTRY (§5): a pure-leaf, versioned, consumer-/resolver-/
//     output-binding registry. A purpose only NARROWS authority (eligibility is
//     always ACL ∩ purpose). Pinned by test like the capability snapshot.
//   - THE SCOPE-RESOLVER MATRIX (§6): every memory.v1 scope resolves through a
//     named resolver OR fails closed (`unsupported_in_retrieval_v1`). No default
//     branch treats an unknown scope as organisation-visible. Role gates
//     CONTENT, not just the use label. Resolvers COMPOSE the injected ACL reads
//     (assertFirmAccess / getAllowedClientIdsForPrincipal /
//     getAssignmentRoleForPrincipal) — never a forked resolver.
//   - THE CORRECTED PIPELINE (§8): ACL → policy → contradiction grouping →
//     USE-DECISION (before ranking) → ranking within each output class →
//     per-section budgets → prompt-safe render → receipts.
//   - PROMPT-SAFE PROJECTION (§7): allowlisted `rendered_value` keyed on value
//     type; raw `source_text` is NEVER surfaced; `deny`/`prohibited` records
//     never appear in the consumer bundle.
//   - SPLIT RECEIPTS (§9): the consumer receipt is computed SOLELY from output
//     the caller is authorised to observe — no `hidden_excluded_count`. Adding
//     or removing an inaccessible row changes nothing observable. Hidden ids and
//     reasons live only in the privileged record.
//
// Deps are INJECTED so the deterministic service invariants are provable without
// a live DB (2c-i ships uncalled — the wiring is 2c-ii). `deps` supplies the raw
// store reads (memories rows + legacy views) and the raw ACL predicates; the
// resolvers/registry/matrix/projection/receipts all live HERE.

import { createHash } from 'node:crypto';

import {
  CONFIDENTIALITY_CLASSES,
  PERSONAL_DATA_CLASSES,
  MEMORY_SCOPE_TYPES,
  MEMORY_CONFIDENCES,
  QUARANTINED_ORIGINS
} from './memoryModel.js';
import { LEGACY_UNSPECIFIED } from './firmFactMemoryView.js';
import { buildMemoryPacket } from './memoryPacket.js';
import { clientFlagObserves, clientFlagActs, AUTO_FORBIDDEN_FLAGS } from './clientConfig.js';

// ── Service versions (pinned into every receipt) ─────────────────────────────
// A change to any of these is a rollout/policy version change — receipts pin
// them so a rendered bundle is reproducible (§14). Meaning/schema changes are a
// NEW capability id (memory.retrieve.v3), never an in-place bump here.
export const MEMORY_RETRIEVAL_SERVICE_VERSION = 'memret.svc.v1';
export const MEMORY_RETRIEVAL_POLICY_VERSION = 'memret.policy.v1';
export const MEMORY_RETRIEVAL_RANKER_VERSION = 'memret.rank.v1';
export const MEMORY_RETRIEVAL_RENDERER_VERSION = 'memret.render.v1';
export const MEMORY_RETRIEVAL_ACL_VERSION = 'memret.acl.v1';

// The born-dark flag (config plane, envFallback () => false — never an env pair;
// CLAUDE.md rail). Wired for OBSERVE in the 2c-ii shadow; clientFlagActs is
// forbidden until the 2c-iii addendum lands. The constant + the observe dual are
// exported now so the 2c-ii seam has one vocabulary to import.
export const MEMORY_RETRIEVAL_V2_FLAG_KEY = 'MEMORY_RETRIEVAL_V2';
export const memoryRetrievalV2Observes = ({ snapshot = null, env = process.env } = {}) =>
  clientFlagObserves({ flagKey: MEMORY_RETRIEVAL_V2_FLAG_KEY, snapshot, envFallback: () => false, env });

// ── The ACTING dual (2c-iii, §J) — born dark, separate from the observe dual ──
//
// `memoryRetrievalV2Observes` drives telemetry (shadow+). This drives LIVE PROMPT
// REPLACEMENT (canary/auto). A `shadow` client sees NO prompt change — only
// canary/auto act (invariant 10c). Same flag key, envFallback () => false, so it
// is fully dormant until a DB stage row exists (never an env pair — CLAUDE.md rail).
//
// §M `auto` guard (defence in depth): `auto` (firm-default, unconditional v2,
// legacy deleted) is a later, separately-approved terminal. The primary control is
// the WRITE guard in clientConfig (`assertStageAllowedForFlag`) — no guarded writer
// will persist an `auto` row for this flag. This READ guard fails closed on top of
// it: a row that somehow reads `auto` (a direct SQL edit bypassing the writer) does
// NOT act. Only `canary` acts for this flag in 2c-iii.
export const memoryRetrievalV2Acts = ({ snapshot = null, env = process.env } = {}) => {
  const row = snapshot && typeof snapshot === 'object' ? snapshot[MEMORY_RETRIEVAL_V2_FLAG_KEY] : null;
  if (row && typeof row === 'object' && row.stage === 'auto' && AUTO_FORBIDDEN_FLAGS.has(MEMORY_RETRIEVAL_V2_FLAG_KEY)) {
    return false;   // §M: `auto` is not an approved terminal for this flag yet — fail closed.
  }
  return clientFlagActs({ flagKey: MEMORY_RETRIEVAL_V2_FLAG_KEY, snapshot, envFallback: () => false, env });
};

// The §12 failure taxonomy. EVERY non-happy outcome maps to one of these and to
// NO-memory context — never a fallback to the legacy path.
export const RETRIEVAL_FAILURES = Object.freeze([
  'invalid_request',
  'unknown_purpose',
  'consumer_not_permitted',
  'principal_unresolved',
  'audience_unresolved',
  'policy_denied',
  'subject_ambiguous',
  'acl_resolution_failed',
  'integrity_failed',
  'service_unavailable'
]);

// ── The purpose registry (§5) — pure leaf, versioned, pinned by test ─────────
//
// Each purpose is the deterministic policy that stops one consumer borrowing
// another's privileges. A purpose only NARROWS: eligibility is ACL ∩ purpose,
// always the intersection. The two firm bookkeeping purposes preserve today's
// firm_facts bookkeeping surface (legacy-unknown + bounded free text under the
// same client access rules — §11 "no regression"); portal_owner_context uses the
// CONSERVATIVE generic ceiling (§5: generic portal does NOT permit
// sensitive_personal, does NOT surface firm practice memory or legacy unknowns).

export const EMPTY_SUBJECT_FALLBACKS = Object.freeze([
  'conversation_linked_subjects_only',
  'current_legal_entity_only',
  'no_subject_specific_memory',
  'refuse_pending_clarification'
]);

export const USE_MODES = Object.freeze([
  'internal_response', 'owner_response', 'external_draft', 'external_action_parameter'
]);

export const AUDIENCE_CLASSES = Object.freeze(['owner', 'firm_operator']);

// Which audience a wired surface actually delivers to (§3 — audience is not a
// claim; it must match the surface's real destination).
export const SURFACE_AUDIENCE = Object.freeze({
  portal_chat: 'owner',
  transaction_chat: 'firm_operator',
  feed_chat: 'firm_operator'
});

const PURPOSE_DEFINITIONS = Object.freeze({
  portal_owner_context: {
    purpose_id: 'portal_owner_context',
    purpose_version: 1,
    decision_policy_version: MEMORY_RETRIEVAL_POLICY_VERSION,
    allowed_consumer_ids: ['clientPortalChatContext'],
    allowed_use_modes: ['owner_response'],
    // The owner sees THEIR business + THEIR private context — never the firm's
    // practice memory (organisation scope is firm-internal).
    allowed_scope_types: ['user_private', 'legal_entity'],
    principal_resolver: 'delegated_is_authenticated_owner',
    audience_resolver: 'owner_surface',
    subject_resolver: 'conversation_linked_subjects_only',
    max_confidentiality: 'confidential',        // NOT restricted (conservative)
    max_personal_data_class: 'personal',        // NOT sensitive_personal (§5)
    permitted_output_sections: ['context_items', 'conflict_markers', 'confirmation_candidates', 'authoritative_read_requirements'],
    external_disclosure_policy: 'none',
    allows_legacy_unknown: false,               // owner chat never carries legacy unknowns
    permits_free_text: false,                   // free text is gated behind a later purpose
    default_budget: { max_records: 12, max_rendered_tokens: 900, max_rendered_bytes: 12000, max_item_tokens: 160 },
    maximum_budget: { max_records: 24, max_rendered_tokens: 1600, max_rendered_bytes: 24000, max_item_tokens: 240 }
  },
  transaction_bookkeeping_context: {
    purpose_id: 'transaction_bookkeeping_context',
    purpose_version: 1,
    decision_policy_version: MEMORY_RETRIEVAL_POLICY_VERSION,
    allowed_consumer_ids: ['transactionChatContext'],
    allowed_use_modes: ['internal_response'],
    allowed_scope_types: ['organisation', 'legal_entity'],
    principal_resolver: 'firm_operator',
    audience_resolver: 'firm_surface',
    subject_resolver: 'current_legal_entity_only',
    max_confidentiality: 'restricted',          // operators may see restricted, role-gated (§6)
    max_personal_data_class: 'personal',
    permitted_output_sections: ['context_items', 'conflict_markers', 'confirmation_candidates', 'authoritative_read_requirements'],
    external_disclosure_policy: 'none',
    allows_legacy_unknown: true,                // preserve today's firm_facts bookkeeping surface (§11)
    permits_free_text: true,                    // legacy facts are free-text sentences; rendered SAFELY (bounded + delimited)
    default_budget: { max_records: 24, max_rendered_tokens: 1400, max_rendered_bytes: 18000, max_item_tokens: 220 },
    maximum_budget: { max_records: 24, max_rendered_tokens: 1800, max_rendered_bytes: 24000, max_item_tokens: 300 }
  },
  feed_bookkeeping_context: {
    purpose_id: 'feed_bookkeeping_context',
    purpose_version: 1,
    decision_policy_version: MEMORY_RETRIEVAL_POLICY_VERSION,
    allowed_consumer_ids: ['feedChatContext'],
    allowed_use_modes: ['internal_response'],
    allowed_scope_types: ['organisation', 'legal_entity'],
    principal_resolver: 'firm_operator',
    audience_resolver: 'firm_surface',
    subject_resolver: 'current_legal_entity_only',
    max_confidentiality: 'restricted',
    max_personal_data_class: 'personal',
    permitted_output_sections: ['context_items', 'conflict_markers', 'confirmation_candidates', 'authoritative_read_requirements'],
    external_disclosure_policy: 'none',
    allows_legacy_unknown: true,
    permits_free_text: true,
    default_budget: { max_records: 24, max_rendered_tokens: 1400, max_rendered_bytes: 18000, max_item_tokens: 220 },
    maximum_budget: { max_records: 24, max_rendered_tokens: 1800, max_rendered_bytes: 24000, max_item_tokens: 300 }
  }
});

const canonicalize = (node) => {
  if (Array.isArray(node)) return node.map(canonicalize);
  if (node && typeof node === 'object') {
    const out = {};
    for (const key of Object.keys(node).sort()) out[key] = canonicalize(node[key]);
    return out;
  }
  return node;
};

const sha = (obj, prefix) => `${prefix}-${createHash('sha256').update(JSON.stringify(canonicalize(obj))).digest('hex')}`;

// The registry fingerprint — pinned by test, so a policy change is reproducible
// like a capability-registry change (amendment 3). Receipts pin
// purpose_id + purpose_version + purpose_registry_fingerprint.
export const purposeRegistryFingerprint = () =>
  sha(Object.values(PURPOSE_DEFINITIONS).map((p) => canonicalize(p)), 'purpreg');

export const getRetrievalPurpose = (purposeId) => PURPOSE_DEFINITIONS[purposeId] || null;
export const listRetrievalPurposeIds = () => Object.keys(PURPOSE_DEFINITIONS);

// The idempotent retrieval id (§16). ONE formula, exported so the shadow sidecar
// (2c-ii) dedupes on the SAME key buildMemoryBundle records — never a second copy
// that could drift. Derived only from the REQUEST (source event, purpose, service/
// policy versions, config snapshot); it carries no memory-row information.
export const retrievalIdFor = ({ sourceEventId = null, purposeId = null, configSnapshotId = null } = {}) =>
  sha({
    source_event_id: sourceEventId,
    purpose_id: purposeId,
    service_version: MEMORY_RETRIEVAL_SERVICE_VERSION,
    policy_version: MEMORY_RETRIEVAL_POLICY_VERSION,
    config_snapshot_id: configSnapshotId
  }, 'retr');

// ── Rank ladders ─────────────────────────────────────────────────────────────

const confidentialityRank = (c) => CONFIDENTIALITY_CLASSES.indexOf(c);   // internal<confidential<restricted
const personalRank = (p) => PERSONAL_DATA_CLASSES.indexOf(p);            // none<personal<sensitive_personal
const confidenceRank = (c) => (c == null ? -1 : MEMORY_CONFIDENCES.indexOf(c));

const SCOPE_SPECIFICITY = Object.freeze({
  user_private: 3, legal_entity: 3, contact_relationship: 2, project: 2, team: 2, organisation: 1
});
const EPISTEMIC_TRUST = Object.freeze({ verified: 4, asserted: 3, unknown: 2, disputed: 1, contradicted: 0 });

// ── Allowlisted renderers (§7) — keyed on the structured value type ──────────
//
// A local_date renders as a date, an amount as a currency string, … Raw
// source_text is NEVER a source here. Free text (`string`) renders ONLY when the
// purpose permits it, and then bounded + delimited + escaped + labelled — never
// interpreted as instructions. `structured` (non-pointer) has no safe v1
// renderer → the record is excluded, not dumped as JSON.
const FREE_TEXT_MAX = 500;
const escapeFreeText = (s) => String(s).replace(/[\x00-\x1f\x7f«»]/g, ' ').slice(0, FREE_TEXT_MAX);

const VALUE_RENDERERS = Object.freeze({
  local_date: (v) => (typeof v === 'string' ? v : null),
  anniversary: (v) => {
    if (!v || typeof v !== 'object' || !Number.isInteger(v.month) || !Number.isInteger(v.day)) return null;
    const mm = String(v.month).padStart(2, '0');
    const dd = String(v.day).padStart(2, '0');
    return Number.isInteger(v.year) ? `${v.year}-${mm}-${dd}` : `--${mm}-${dd}`;
  },
  timestamp: (v) => (typeof v === 'string' ? v : null),
  boolean: (v) => (typeof v === 'boolean' ? (v ? 'true' : 'false') : null),
  number: (v) => (Number.isFinite(v) ? String(v) : null),
  amount: (v) => (v && typeof v === 'object' && Number.isFinite(v.amount) && /^[A-Z]{3}$/.test(v.currency || '')
    ? `${v.amount} ${v.currency}` : null)
});

// Returns { rendered } on success or { unrenderable: reason }. Free text is
// wrapped in explicit data delimiters so a consumer prompt treats it as data.
const renderValue = ({ structuredValue, sourceText, purpose, isLegacy }) => {
  // Legacy firm_facts carry only free-text `source_text` (no structured value).
  if (isLegacy || structuredValue == null) {
    if (!purpose.permits_free_text) return { unrenderable: 'free_text_not_permitted' };
    const text = sourceText;
    if (typeof text !== 'string' || !text.trim()) return { unrenderable: 'no_renderable_value' };
    return { rendered: `«${escapeFreeText(text)}»`, source_trust: isLegacy ? 'legacy' : 'asserted' };
  }
  const { value_type: valueType, value } = structuredValue;
  if (valueType === 'string') {
    if (!purpose.permits_free_text) return { unrenderable: 'free_text_not_permitted' };
    if (typeof value !== 'string' || !value.trim()) return { unrenderable: 'no_renderable_value' };
    return { rendered: `«${escapeFreeText(value)}»`, source_trust: 'asserted' };
  }
  const renderer = VALUE_RENDERERS[valueType];
  if (!renderer) return { unrenderable: 'no_safe_renderer' };
  const rendered = renderer(value);
  if (rendered == null) return { unrenderable: 'no_renderable_value' };
  return { rendered };
};

// ── Default tokenizer (deterministic; receipts pin its id/version — §13) ──────
export const DEFAULT_TOKENIZER = Object.freeze({
  id: 'memret.tok.ws',
  version: '1',
  count: (s) => (typeof s === 'string' && s.trim() ? s.trim().split(/\s+/).length : 0)
});

// ── Record shaping helpers ────────────────────────────────────────────────────

const subjectRefOf = (rec) => `${rec.subject_type}:${rec.subject_id}`;
const refOf = (rec) => ({ memory_id: rec.memory_id, revision: rec.revision, content_hash: rec.content_hash });

const provenanceClassOf = (rec) => {
  if (rec.__legacy) return 'legacy_unknown';
  if (QUARANTINED_ORIGINS.includes(rec.assertion_origin)) return 'quarantined';
  if (rec.assertion_origin === 'operator_asserted') return 'operator';
  return 'owner_asserted';
};

const isLegacyUnknown = (rec) =>
  rec.__legacy
  || rec.confidentiality === LEGACY_UNSPECIFIED
  || rec.personal_data_class === LEGACY_UNSPECIFIED;

// Legacy views arrive without the immutable-record identity fields; give them a
// stable synthetic ref so the receipt can name them without inventing content.
const normalizeLegacyView = (view) => {
  const content_hash = sha({
    fact_id: view.source_fact_id, subject: view.subject_id, text: view.source_text,
    scope: view.scope_type, tenant: view.tenant_id
  }, 'legacyh');
  return {
    ...view,
    __legacy: true,
    memory_id: `legacy:${view.source_fact_id}`,
    revision: 0,
    content_hash,
    predicate_class: 'unclassified',
    assertion_origin: LEGACY_UNSPECIFIED,
    truth_confidence: null,
    valid_from: view.valid_from ?? null,
    valid_until: view.valid_until ?? null,
    review_after: view.review_after ?? null,
    structured_value: view.structured_value ?? null
  };
};

// ── ACL: the scope-resolver matrix (§6) ──────────────────────────────────────
//
// Every scope resolves through a named resolver OR fails closed. Resolvers
// COMPOSE the injected ACL predicates; role gates CONTENT (a viewer with client
// access still lacks `restricted` content). Returns { eligible: true, role } or
// { eligible: false, reason }. A resolver infra error → fail closed (the caller
// maps it to acl_resolution_failed for that record).
const resolveScopeAccess = async ({ record, trustedContext, purpose, acl }) => {
  const scopeType = record.scope_type;
  if (!MEMORY_SCOPE_TYPES.includes(scopeType)) return { eligible: false, reason: 'scope_unknown' };
  if (!purpose.allowed_scope_types.includes(scopeType)) return { eligible: false, reason: 'scope_not_permitted' };

  const principal = trustedContext.delegated_principal;
  const audience = trustedContext.resolved_audience;

  if (scopeType === 'user_private') {
    // Exact owning user, and NO firm operator/reviewer in the audience.
    const ownsSlot = record.lifecycle_owner_type === 'user'
      && String(record.lifecycle_owner_id) === String(principal.id);
    if (!ownsSlot) return { eligible: false, reason: 'user_private_not_owner' };
    if (audience.audience_class !== 'owner') return { eligible: false, reason: 'user_private_operator_audience' };
    return { eligible: true, role: 'owner' };
  }

  if (scopeType === 'organisation') {
    if (acl.isFirmMember(principal)) return { eligible: true, role: 'founder' };
    // A non-member collaborator reaches organisation (firm practice) memory only
    // through an active assignment role; content is role-gated below.
    const role = await acl.getAssignmentRole({ tenantId: trustedContext.tenant_id, clientId: null, principal });
    if (!role) return { eligible: false, reason: 'organisation_no_role' };
    return { eligible: true, role };
  }

  if (scopeType === 'legal_entity') {
    const allowed = await acl.getAllowedClientIds({ tenantId: trustedContext.tenant_id, principal });
    if (allowed !== null && !allowed.includes(record.scope_id)) {
      return { eligible: false, reason: 'legal_entity_no_access' };
    }
    if (acl.isFirmMember(principal) || allowed === null) return { eligible: true, role: 'founder' };
    const role = await acl.getAssignmentRole({ tenantId: trustedContext.tenant_id, clientId: record.scope_id, principal });
    return { eligible: true, role: role || 'viewer' };
  }

  // team / project / contact_relationship — no v1 resolver → fail closed.
  return { eligible: false, reason: 'unsupported_in_retrieval_v1' };
};

// Restricted CONTENT requires more than access: only a founder/firm-member (or
// an explicit non-viewer role) may see it. A viewer is excluded at eligibility.
const roleAdmitsRestricted = (role) => role === 'founder' || role === 'admin' || role === 'manager';

// ── The use-decision matrix (§8) ─────────────────────────────────────────────
//
// Computed for the EXACT purpose + audience + use_mode, AFTER ceilings/ACL have
// excluded ineligible rows and AFTER contradiction grouping. Never stored on the
// memory. Returns one of: 'allow' | 'require_confirmation' |
// 'authoritative_reference' | 'conflict' | { deny: reason }.
const decideUse = ({ record, purpose, conflictedKeys }) => {
  const useMode = purpose.allowed_use_modes[0];               // v1 purposes declare exactly one
  const isExternal = useMode === 'external_draft' || useMode === 'external_action_parameter';
  const isActionParam = useMode === 'external_action_parameter';

  // Contradicted logical slot → marker only, never a value (§10).
  if (conflictedKeys.has(record.memory_key)) return 'conflict';

  // System-of-record state is a pointer, never a value (any use mode).
  if (record.predicate_class === 'authoritative_attribute_reference') {
    return isExternal ? { deny: 'authoritative_reference_not_external' } : 'authoritative_reference';
  }
  // Defence in depth: these must never have been stored, and never surface.
  if (record.predicate_class === 'prohibited_secret') return { deny: 'predicate_prohibited' };
  if (record.predicate_class === 'preference_candidate') return { deny: 'predicate_preference' };

  // v1 sources NO memory-derived action parameters.
  if (isActionParam) return { deny: 'no_memory_action_params_v1' };

  const legacyUnknown = isLegacyUnknown(record);
  if (legacyUnknown) {
    // Legacy-unknown provenance is never promoted to a trusted class, never
    // external, never user_private. Permitted as internal context only when the
    // purpose opts in (§11).
    if (isExternal) return { deny: 'legacy_unknown_not_external' };
    return purpose.allows_legacy_unknown ? 'allow' : { deny: 'legacy_unknown_denied' };
  }

  const quarantined = QUARANTINED_ORIGINS.includes(record.assertion_origin);
  if (quarantined) return isExternal ? { deny: 'quarantined_not_external' } : 'allow';

  // Unverified assertion / low truth confidence → confirmation, never external.
  const unverified = record.epistemic_state === 'asserted';
  const lowConfidence = record.truth_confidence === 'low';
  if (unverified || lowConfidence) {
    return isExternal ? { deny: 'unverified_not_external' } : 'require_confirmation';
  }

  // sensitive_personal is admitted only under an exact-subject explicit-owner
  // purpose (none in v1) — the ceiling already excluded it, this is defence.
  if (record.personal_data_class === 'sensitive_personal') return { deny: 'sensitive_personal_requires_explicit_purpose' };

  if (record.personal_data_class === 'personal' && isExternal) return { deny: 'personal_not_external_without_confirmation' };

  return 'allow';
};

// ── Ranking (§14) — deterministic components + total-ordering tie-break ───────
const rankKey = (record, resolvedSubjectSet) => {
  const subjectMatch = resolvedSubjectSet.has(subjectRefOf(record)) ? 1 : 0;
  const scopeSpecificity = SCOPE_SPECIFICITY[record.scope_type] || 0;
  const trust = (EPISTEMIC_TRUST[record.epistemic_state] ?? 2) * 10 + (confidenceRank(record.truth_confidence) + 1);
  const recency = Date.parse(record.recorded_at || record.observed_at || 0) || 0;
  return { subjectMatch, scopeSpecificity, trust, recency };
};

const compareForRank = (a, b, resolvedSubjectSet) => {
  const ka = rankKey(a, resolvedSubjectSet);
  const kb = rankKey(b, resolvedSubjectSet);
  if (ka.subjectMatch !== kb.subjectMatch) return kb.subjectMatch - ka.subjectMatch;
  if (ka.scopeSpecificity !== kb.scopeSpecificity) return kb.scopeSpecificity - ka.scopeSpecificity;
  if (ka.trust !== kb.trust) return kb.trust - ka.trust;
  if (ka.recency !== kb.recency) return kb.recency - ka.recency;
  // Total-ordering tie-break (§14): (memory_key, revision, memory_id).
  if (a.memory_key !== b.memory_key) return a.memory_key < b.memory_key ? -1 : 1;
  if (a.revision !== b.revision) return b.revision - a.revision;
  return a.memory_id < b.memory_id ? -1 : (a.memory_id > b.memory_id ? 1 : 0);
};

// ── Temporal validity (§8 step 3) ─────────────────────────────────────────────
const temporalState = (record, asOfMs) => {
  const from = record.valid_from ? Date.parse(record.valid_from) : null;
  const until = record.valid_until ? Date.parse(record.valid_until) : null;
  if (from != null && asOfMs < from) return 'not_yet_valid';
  if (until != null && asOfMs >= until) return 'expired';
  const review = record.review_after ? Date.parse(record.review_after) : null;
  if (review != null && asOfMs > review) return 'stale';
  return 'current';
};

// ── Budgets (§13) — applied to the RENDERED projection, per section ──────────
const applyBudget = ({ items, budget, tokenizer, renderText }) => {
  const kept = [];
  const trimmed = [];
  let tokens = 0;
  let bytes = 0;
  for (const item of items) {
    if (kept.length >= budget.max_records) { trimmed.push({ item, reason: 'budget_records' }); continue; }
    const text = renderText(item);
    const itemTokens = tokenizer.count(text);
    const itemBytes = Buffer.byteLength(text, 'utf8');
    if (itemTokens > budget.max_item_tokens) { trimmed.push({ item, reason: 'item_too_large' }); continue; }
    if (tokens + itemTokens > budget.max_rendered_tokens || bytes + itemBytes > budget.max_rendered_bytes) {
      trimmed.push({ item, reason: 'budget_tokens' });
      continue;
    }
    tokens += itemTokens;
    bytes += itemBytes;
    kept.push(item);
  }
  return { kept, trimmed };
};

// ── Request validation (§3) ───────────────────────────────────────────────────
const validateInputs = ({ trustedContext, request, purpose, acl }) => {
  const tc = trustedContext;
  if (!tc || typeof tc !== 'object') return 'invalid_request';
  for (const field of ['tenant_id', 'authenticated_principal', 'delegated_principal', 'resolved_audience', 'source_surface', 'consumer_capability_id', 'source_event_id', 'occurred_at']) {
    if (tc[field] == null) return 'invalid_request';
  }
  if (!request || typeof request !== 'object' || !request.purpose_id) return 'invalid_request';
  if (!purpose) return 'unknown_purpose';

  // A consumer cannot borrow a more privileged purpose.
  if (!purpose.allowed_consumer_ids.includes(tc.consumer_capability_id)) return 'consumer_not_permitted';

  // Principal resolution: the authenticated principal must be able to act on
  // behalf of the delegated principal (a recorded delegation, or self).
  const auth = tc.authenticated_principal;
  const del = tc.delegated_principal;
  if (!auth?.id || !del?.id) return 'principal_unresolved';
  const selfActing = String(auth.id) === String(del.id);
  const delegationOk = selfActing || (Array.isArray(auth.acts_for) && auth.acts_for.map(String).includes(String(del.id)));
  if (!delegationOk) return 'principal_unresolved';
  if (purpose.principal_resolver === 'delegated_is_authenticated_owner' && !selfActing) return 'principal_unresolved';

  // Audience: must match the surface's real destination AND the purpose resolver.
  const aud = tc.resolved_audience;
  if (!aud || !AUDIENCE_CLASSES.includes(aud.audience_class)) return 'audience_unresolved';
  const surfaceAudience = SURFACE_AUDIENCE[tc.source_surface];
  if (!surfaceAudience || surfaceAudience !== aud.audience_class) return 'audience_unresolved';
  if (purpose.audience_resolver === 'owner_surface' && aud.audience_class !== 'owner') return 'audience_unresolved';
  if (purpose.audience_resolver === 'firm_surface' && aud.audience_class !== 'firm_operator') return 'audience_unresolved';

  // Subject refs: RESOLVED typed refs only; an unresolved/ambiguous ref never
  // reaches retrieval (§4) — the caller keeps those as clarification candidates.
  if (request.subject_refs != null) {
    if (!Array.isArray(request.subject_refs)) return 'invalid_request';
    for (const s of request.subject_refs) {
      if (!s || typeof s !== 'object' || !s.subject_type || !s.subject_id) return 'invalid_request';
      if (/^(unknown|unresolved|tbd|\?+)$/i.test(String(s.subject_id).trim())) return 'subject_ambiguous';
    }
  }
  if (!acl || typeof acl.isFirmMember !== 'function' || typeof acl.getAllowedClientIds !== 'function' || typeof acl.getAssignmentRole !== 'function') {
    return 'service_unavailable';
  }
  return null;
};

// A budget_override may only LOWER a registered maximum (§13).
const resolveBudget = (purpose, override) => {
  const base = { ...purpose.default_budget };
  const max = purpose.maximum_budget;
  if (override && typeof override === 'object') {
    for (const key of Object.keys(base)) {
      if (typeof override[key] === 'number' && override[key] >= 0) {
        base[key] = Math.min(override[key], max[key]);
      }
    }
  }
  // Never exceed the registered maximum even from the default.
  for (const key of Object.keys(base)) base[key] = Math.min(base[key], max[key]);
  return base;
};

const emptyBundle = (purpose) => ({
  context_items: [],
  conflict_markers: [],
  confirmation_candidates: [],
  authoritative_read_requirements: []
});

// ── The executor ─────────────────────────────────────────────────────────────
//
// buildMemoryBundle({ trustedContext, request, deps }) → {
//   status: 'ok' | 'refused',
//   failure,                       // one of RETRIEVAL_FAILURES on refusal, else null
//   bundle: { context_items, conflict_markers, confirmation_candidates,
//             authoritative_read_requirements, receipt },
//   consumer_receipt,              // === bundle.receipt (nothing from inaccessible rows)
//   privileged_record              // the security-audit half (hidden ids + reasons + retrieval_id)
// }
//
// A refusal returns an EMPTY bundle + a privileged record carrying the failure —
// NEVER a fallback to a laxer path (§12).
export const buildMemoryBundle = async ({ trustedContext, request, deps = {} } = {}) => {
  const purpose = getRetrievalPurpose(request?.purpose_id);
  const acl = deps.acl;
  const tokenizer = deps.tokenizer || DEFAULT_TOKENIZER;
  const purposeFingerprint = purposeRegistryFingerprint();

  const retrievalId = retrievalIdFor({
    sourceEventId: trustedContext?.source_event_id ?? null,
    purposeId: request?.purpose_id ?? null,
    configSnapshotId: trustedContext?.config_snapshot_id ?? null
  });

  const asOf = trustedContext?.occurred_at ?? null;

  const basePrivileged = () => ({
    retrieval_id: retrievalId,
    purpose_id: request?.purpose_id ?? null,
    purpose_version: purpose?.purpose_version ?? null,
    purpose_registry_fingerprint: purposeFingerprint,
    policy_version: MEMORY_RETRIEVAL_POLICY_VERSION,
    service_version: MEMORY_RETRIEVAL_SERVICE_VERSION,
    acl_version: MEMORY_RETRIEVAL_ACL_VERSION,
    ranker_version: MEMORY_RETRIEVAL_RANKER_VERSION,
    renderer_version: MEMORY_RETRIEVAL_RENDERER_VERSION,
    tokenizer_id: tokenizer.id,
    tokenizer_version: tokenizer.version,
    config_snapshot_id: trustedContext?.config_snapshot_id ?? null,
    as_of: asOf,
    principal: {
      authenticated_id: trustedContext?.authenticated_principal?.id ?? null,
      delegated_id: trustedContext?.delegated_principal?.id ?? null,
      audience_class: trustedContext?.resolved_audience?.audience_class ?? null
    }
  });

  const refuse = (failure) => {
    const bundle = { ...emptyBundle(purpose), receipt: null };
    const consumer_receipt = {
      included: [],
      visible_excluded: [],
      bundle_fingerprint: sha({ empty: true, failure, purpose: request?.purpose_id ?? null }, 'bundle'),
      policy_version: MEMORY_RETRIEVAL_POLICY_VERSION,
      service_version: MEMORY_RETRIEVAL_SERVICE_VERSION,
      as_of: asOf
    };
    bundle.receipt = consumer_receipt;
    return {
      status: 'refused',
      failure,
      bundle,
      consumer_receipt,
      privileged_record: { ...basePrivileged(), failure, included: [], visible_excluded: [], hidden: [], excluded_restricted: [] }
    };
  };

  const invalid = validateInputs({ trustedContext, request, purpose, acl });
  if (invalid) return refuse(invalid);

  // ── Load candidates (both stores) through the injected reads. The service
  // re-applies ALL governance regardless of what the loader filtered — defence
  // in depth (never trust the loader to have gated).
  let memoryRecords = [];
  let legacyViews = [];
  try {
    const loadArgs = {
      tenantId: trustedContext.tenant_id,
      subjectRefs: Array.isArray(request.subject_refs) ? request.subject_refs : [],
      allowedScopeTypes: purpose.allowed_scope_types,
      asOf
    };
    if (typeof deps.loadMemoryRecords === 'function') memoryRecords = (await deps.loadMemoryRecords(loadArgs)) || [];
    if (purpose.allows_legacy_unknown && typeof deps.loadLegacyViews === 'function') {
      legacyViews = (await deps.loadLegacyViews(loadArgs)) || [];
    }
  } catch {
    return refuse('service_unavailable');
  }

  const candidates = [
    ...memoryRecords.map((r) => ({ ...r })),
    ...legacyViews.map((v) => normalizeLegacyView(v))
  ];

  const resolvedSubjectSet = new Set(
    (Array.isArray(request.subject_refs) ? request.subject_refs : []).map((s) => `${s.subject_type}:${s.subject_id}`)
  );
  const asOfMs = asOf ? Date.parse(asOf) : Date.now();
  const emptySubjects = resolvedSubjectSet.size === 0;

  const hidden = [];               // ACL-inaccessible or non-active → PRIVILEGED ONLY, never observable
  const excludedRestricted = [];   // accessible-but-denied (ceiling/use-deny) → PRIVILEGED ONLY (§7)
  const visibleExcluded = [];      // caller-observable exclusions (temporal / budget)
  const allowRecords = [];
  const confirmationRecords = [];
  const authoritativeRecords = [];
  const conflictSlots = new Map(); // subject_ref+predicate → marker

  // Pass 1 — eligibility (ACL + active + scope + subject), then policy. First
  // collect the ACL-eligible + policy-passing set so contradiction grouping (§8
  // step 4) sees only records authorised for THIS caller + purpose (§10).
  const eligible = [];
  for (const record of candidates) {
    // Non-active never surfaces anywhere observable (invariant 2). Treated as
    // hidden (not visible_excluded) so a dismissed/superseded slot's existence
    // does not leak.
    if (record.record_state !== 'active') { hidden.push({ record, reason: `non_active_${record.record_state}` }); continue; }
    if (String(record.tenant_id) !== String(trustedContext.tenant_id)) { hidden.push({ record, reason: 'cross_tenant' }); continue; }

    let access;
    try {
      access = await resolveScopeAccess({ record, trustedContext, purpose, acl });
    } catch {
      hidden.push({ record, reason: 'acl_resolution_failed' });
      continue;
    }
    if (!access.eligible) { hidden.push({ record, reason: access.reason }); continue; }

    // Role gates CONTENT (§6): a firm viewer never sees restricted content. This
    // is a FIRM-scope gate — the owner of a user_private slot is always entitled
    // to their own content there (the purpose sensitivity ceiling limits it
    // instead), so the role gate applies only to organisation / legal_entity.
    if ((record.scope_type === 'organisation' || record.scope_type === 'legal_entity')
      && record.confidentiality === 'restricted' && !roleAdmitsRestricted(access.role)) {
      hidden.push({ record, reason: 'role_restricted_content' });
      continue;
    }

    // Subject membership (§4): resolved refs only; empty subjects → the purpose's
    // declared deterministic fallback, never top-N global.
    const subjectMatches = resolvedSubjectSet.has(subjectRefOf(record));
    if (!subjectMatches) {
      if (!emptySubjects) { hidden.push({ record, reason: 'subject_not_requested' }); continue; }
      const fb = purpose.subject_resolver;
      if (fb === 'no_subject_specific_memory' || fb === 'refuse_pending_clarification') {
        hidden.push({ record, reason: 'empty_subject_no_fallback' });
        continue;
      }
      if (fb === 'current_legal_entity_only' && record.scope_type === 'user_private') {
        hidden.push({ record, reason: 'empty_subject_scope_excluded' });
        continue;
      }
      // conversation_linked_subjects_only with no linked subjects → nothing.
      if (fb === 'conversation_linked_subjects_only') {
        hidden.push({ record, reason: 'no_conversation_linked_subject' });
        continue;
      }
      // current_legal_entity_only: entity-wide memory surfaces without a subject.
    }

    record.__role = access.role;
    eligible.push(record);
  }

  // Pass 2 — temporal + sensitivity + predicate policy (§8 step 3).
  const policyPassed = [];
  for (const record of eligible) {
    // Sensitivity ceilings. Legacy-unknown sensitivity is handled in the use
    // decision (§11), not here — so a legacy row is not double-excluded.
    const legacyUnknown = isLegacyUnknown(record);
    if (!legacyUnknown) {
      if (confidentialityRank(record.confidentiality) > confidentialityRank(purpose.max_confidentiality)) {
        excludedRestricted.push({ record, reason: 'confidentiality_ceiling' });
        continue;
      }
      if (personalRank(record.personal_data_class) > personalRank(purpose.max_personal_data_class)) {
        excludedRestricted.push({ record, reason: 'personal_data_ceiling' });
        continue;
      }
    }

    const t = temporalState(record, asOfMs);
    if (t === 'not_yet_valid' || t === 'expired') {
      visibleExcluded.push({ record, reason: `temporal_${t}` });
      continue;
    }
    record.__stale = t === 'stale';
    policyPassed.push(record);
  }

  // Pass 3 — contradiction grouping on the logical slot (memory_key), built ONLY
  // from records authorised for this caller + purpose (§10). A slot is conflicted
  // when any authorised record in it is contradicted/disputed.
  const conflictedKeys = new Set();
  for (const record of policyPassed) {
    if (record.epistemic_state === 'contradicted' || record.epistemic_state === 'disputed') {
      conflictedKeys.add(record.memory_key);
    }
  }

  // Pass 4 — use decision (BEFORE ranking, §8 step 5).
  for (const record of policyPassed) {
    // A stale-but-valid record needs confirmation regardless of the matrix's
    // other cells (matrix: past review_after → require_confirmation).
    let decision = decideUse({ record, purpose, conflictedKeys });
    if (record.__stale && decision === 'allow') decision = 'require_confirmation';

    if (decision === 'allow') allowRecords.push(record);
    else if (decision === 'require_confirmation') confirmationRecords.push(record);
    else if (decision === 'authoritative_reference') authoritativeRecords.push(record);
    else if (decision === 'conflict') {
      const key = `${subjectRefOf(record)}|${record.predicate}`;
      if (!conflictSlots.has(key)) conflictSlots.set(key, { subject_ref: subjectRefOf(record), predicate: record.predicate, state: 'conflicted' });
    } else if (decision && decision.deny) {
      excludedRestricted.push({ record, reason: decision.deny });
    }
  }

  // Pass 5 — rank within each output class (never across classes, §8 step 6).
  allowRecords.sort((a, b) => compareForRank(a, b, resolvedSubjectSet));
  confirmationRecords.sort((a, b) => compareForRank(a, b, resolvedSubjectSet));
  authoritativeRecords.sort((a, b) => compareForRank(a, b, resolvedSubjectSet));

  // Render allow records; a record with no safe renderer is excluded (privileged
  // — never dumped). Rendering happens before the budget so budgeting measures
  // the RENDERED projection (§13).
  const renderedAllow = [];
  for (const record of allowRecords) {
    const r = renderValue({
      structuredValue: record.structured_value, sourceText: record.source_text,
      purpose, isLegacy: !!record.__legacy
    });
    if (r.unrenderable) { excludedRestricted.push({ record, reason: `unrenderable_${r.unrenderable}` }); continue; }
    renderedAllow.push({
      ref: refOf(record),
      subject_ref: subjectRefOf(record),
      predicate: record.predicate,
      rendered_value: r.rendered,
      value_source_trust: r.source_trust || 'asserted',
      valid_from: record.valid_from ?? null,
      valid_until: record.valid_until ?? null,
      provenance_class: provenanceClassOf(record),
      epistemic_state: record.epistemic_state,
      use_decision: 'allow',
      __record: record
    });
  }

  // Pass 6 — per-section budgets (§13).
  const budget = resolveBudget(purpose, request.budget_override);
  const ctxBudget = applyBudget({
    items: renderedAllow, budget, tokenizer,
    renderText: (it) => `${it.subject_ref} ${it.predicate} ${it.rendered_value}`
  });
  for (const { item, reason } of ctxBudget.trimmed) {
    visibleExcluded.push({ record: item.__record, reason: reason === 'item_too_large' ? 'item_too_large' : 'budget' });
  }

  // Confirmation candidates: METADATA ONLY, no usable value (§7/§8). Own budget.
  const confBudgetSpec = { ...budget, max_rendered_tokens: budget.max_rendered_tokens, max_rendered_bytes: budget.max_rendered_bytes };
  const confItems = confirmationRecords.map((record) => ({
    ref: refOf(record), subject_ref: subjectRefOf(record), predicate: record.predicate,
    reason_code: record.__stale ? 'stale_review_after' : (record.truth_confidence === 'low' ? 'low_truth_confidence' : 'unverified_assertion'),
    __record: record
  }));
  const confBudget = applyBudget({
    items: confItems, budget: confBudgetSpec, tokenizer,
    renderText: (it) => `${it.subject_ref} ${it.predicate} ${it.reason_code}`
  });

  // Authoritative read requirements: pointer only (§7).
  const authItems = [];
  for (const record of authoritativeRecords) {
    const ptr = record.structured_value?.value?.authoritative_source_ref;
    if (typeof ptr !== 'string' || !ptr.trim()) { excludedRestricted.push({ record, reason: 'authoritative_pointer_missing' }); continue; }
    authItems.push({ ref: refOf(record), subject_ref: subjectRefOf(record), predicate: record.predicate, authoritative_source_ref: ptr });
  }

  // Conflict markers: no count, deduped by (subject_ref, predicate) (§10).
  const conflictMarkers = [...conflictSlots.values()]
    .sort((a, b) => (a.subject_ref + a.predicate < b.subject_ref + b.predicate ? -1 : 1));

  // Filter output sections to those the purpose permits.
  const permit = (section, items) => (purpose.permitted_output_sections.includes(section) ? items : []);
  const contextItems = permit('context_items', ctxBudget.kept).map(({ __record, ...rest }) => rest);
  const confirmationCandidates = permit('confirmation_candidates', confBudget.kept).map(({ __record, ...rest }) => rest);
  const authoritativeReadRequirements = permit('authoritative_read_requirements', authItems);
  const finalConflictMarkers = permit('conflict_markers', conflictMarkers);

  // Records dropped purely because their section is not permitted go to privileged.
  if (!purpose.permitted_output_sections.includes('confirmation_candidates')) {
    for (const it of confBudget.kept) excludedRestricted.push({ record: it.__record, reason: 'section_not_permitted' });
  }

  // ── Receipts (§9) ──────────────────────────────────────────────────────────
  const included = contextItems.map((it) => ({ memory_id: it.ref.memory_id, revision: it.ref.revision, content_hash: it.ref.content_hash }));
  const visible_excluded = visibleExcluded.map(({ record, reason }) => ({
    memory_id: record.memory_id, revision: record.revision, reason_category: reason
  }));

  // bundle_fingerprint over the canonical RENDERED output the caller may observe
  // — a hidden row cannot change it; a renderer/use-class change must (§14).
  const bundleFingerprint = sha({
    context_items: contextItems,
    conflict_markers: finalConflictMarkers,
    confirmation_candidates: confirmationCandidates,
    authoritative_read_requirements: authoritativeReadRequirements,
    policy_version: MEMORY_RETRIEVAL_POLICY_VERSION,
    service_version: MEMORY_RETRIEVAL_SERVICE_VERSION,
    ranker_version: MEMORY_RETRIEVAL_RANKER_VERSION,
    renderer_version: MEMORY_RETRIEVAL_RENDERER_VERSION,
    tokenizer: `${tokenizer.id}@${tokenizer.version}`,
    purpose: `${purpose.purpose_id}@${purpose.purpose_version}`,
    purpose_registry_fingerprint: purposeFingerprint,
    as_of: asOf
  }, 'bundle');

  const consumer_receipt = {
    included,
    visible_excluded,
    bundle_fingerprint: bundleFingerprint,
    policy_version: MEMORY_RETRIEVAL_POLICY_VERSION,
    service_version: MEMORY_RETRIEVAL_SERVICE_VERSION,
    as_of: asOf
    // NO hidden_excluded_count — the consumer receipt reveals nothing derived
    // from inaccessible rows (amendment 7).
  };

  const bundle = {
    context_items: contextItems,
    conflict_markers: finalConflictMarkers,
    confirmation_candidates: confirmationCandidates,
    authoritative_read_requirements: authoritativeReadRequirements,
    receipt: consumer_receipt
  };

  // The privileged security-audit record — the ONLY place hidden-row info lives.
  // Content-free (ids/hashes/reasons/classes only; never source_text/value).
  const privileged_record = {
    ...basePrivileged(),
    failure: null,
    included,
    visible_excluded,
    hidden: hidden.map(({ record, reason }) => ({
      memory_id: record.memory_id ?? null, revision: record.revision ?? null,
      content_hash: record.content_hash ?? null, reason_category: reason
    })),
    excluded_restricted: excludedRestricted.map(({ record, reason }) => ({
      memory_id: record.memory_id ?? null, revision: record.revision ?? null,
      content_hash: record.content_hash ?? null, reason_category: reason
    })),
    // Advisory self-report seam (reused, §9) — available id set for downstream
    // used/conflicted arithmetic; never a gate.
    self_report_packet: buildMemoryPacket({ facts: included.map((r) => ({ id: r.memory_id })) })
  };

  return { status: 'ok', failure: null, bundle, consumer_receipt, privileged_record };
};
