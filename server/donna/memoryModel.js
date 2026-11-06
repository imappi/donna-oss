// Donna — the memory.v1 record contract (BizOS Slice 2a, D-PA-6 as amended).
//
// The typed/temporal/scoped governed-memory contract
// (design-donna-bizos-slice-2-memory-v2.md §3-§6, revised per Kari's 2026-07-12 review).
// The load-bearing boundaries, verbatim from that review:
//
//   - Memory may record that somebody ASSERTED or EXPERIENCED something. It does not make
//     a preference, policy, instruction, or authority grant effective. (Those are D-PA-5
//     instruction objects with their own contracts.)
//   - Two identities: memory_key is the LOGICAL SLOT (keyed HMAC — opaque, unpredictable);
//     memory_id is ONE immutable assertion/version. Content under a receipted memory_id
//     never changes; a changed value is a NEW memory_id + revision linked `supersedes`.
//   - Tenant, scope, lifecycle owner, subject, and asserting principal are five separate
//     concerns, never inferred from one another. Subjects are stable business-graph entity
//     ids — never names (the "other Alex" bug).
//   - Truth validity (valid_from/until) and data retention (retain_until) are different
//     axes. Assertion confidence and truth confidence are never collapsed.
//   - Document-derived / third-party content cannot become an ACTIVE record without an
//     explicit recorded activation confirmation (quarantine — retrieval demotion does not
//     neutralise prompt injection). Secrets and payment instructions are refused outright.
//
// Pure leaf: node:crypto + MX-1's canonical digest (server/donna/liveRepair/manifestContract.js,
// itself a pure leaf). Storage (migration + writers) is Slice 2b; retrieval is 2c.
//
// DMEM-R1 W2 (2026-09-04) adds the memory.v2 contract BESIDE v1 — the version is a
// FIELD on the record (`schema_version`), never inferred from which fields are
// present. v1 records stay readable and validate exactly as before (byte-identical
// hash + validator); a v2 record additionally carries explicit applicability
// dimensions (value | any | unspecified — an absent dimension is unspecified, never a
// wildcard), a business-effective DATE interval, the evidence set with its
// dependence groups (INV-08), the claim generation (INV-27) and the INV-25
// provenance fields. See the "memory.v2" section at the end of this file.

import { createHmac, createHash, randomUUID } from 'node:crypto';
import { canonicalDigest } from './liveRepair/manifestContract.js';

export const MEMORY_SCHEMA_VERSION = 'memory.v1';
export const MEMORY_SCHEMA_VERSION_V2 = 'memory.v2';
export const MEMORY_SCHEMA_VERSIONS = Object.freeze([MEMORY_SCHEMA_VERSION, MEMORY_SCHEMA_VERSION_V2]);
// What the writers mint by default from W2 on (v1 stays readable; a caller may
// still declare 'memory.v1' explicitly).
export const MEMORY_SCHEMA_VERSION_CURRENT = MEMORY_SCHEMA_VERSION_V2;

// ── Vocabularies (closed per contract version) ───────────────────────────────────

export const MEMORY_KINDS = Object.freeze([
  'assertion',            // someone asserted something about a subject
  'relationship_context', // how entities relate
  'episodic_context',     // something happened / was experienced (a record ABOUT an
                          // instruction is episodic; never an effective instruction)
  'temporal_marker'       // a recurring or dated marker (birthday, renewal month)
]);

export const ASSERTION_ORIGINS = Object.freeze([
  'owner_asserted', 'operator_asserted', 'distilled_from_document', 'third_party_reported'
]);
// Origins that may NEVER mint an active record without an explicit recorded confirmation
// (the §8 quarantine rule).
export const QUARANTINED_ORIGINS = Object.freeze(['distilled_from_document', 'third_party_reported']);

export const RECORD_STATES = Object.freeze(['active', 'dismissed', 'superseded', 'erased']);
export const EPISTEMIC_STATES = Object.freeze(['asserted', 'verified', 'disputed', 'contradicted', 'unknown']);
export const MEMORY_RELATION_TYPES = Object.freeze(['supersedes', 'contradicts', 'confirms', 'duplicates', 'corrects']);

// v1 scopes — household is CUT (an ACL category without an identity model is the wrong
// trade-off; returns in a later contract version); conversation is NOT a memories scope
// (conversation context lives in its own short-lived store, composed at retrieval).
export const MEMORY_SCOPE_TYPES = Object.freeze([
  'user_private', 'organisation', 'legal_entity', 'team', 'project', 'contact_relationship'
]);

export const LIFECYCLE_OWNER_TYPES = Object.freeze(['user', 'organisation', 'legal_entity', 'ephemeral']);

// Two independent sensitivity axes (amendment 16) — product classifications; jurisdiction
// packs map them to legal categories per market.
export const CONFIDENTIALITY_CLASSES = Object.freeze(['internal', 'confidential', 'restricted']);
export const PERSONAL_DATA_CLASSES = Object.freeze(['none', 'personal', 'sensitive_personal']);

export const MEMORY_CONFIDENCES = Object.freeze(['low', 'medium', 'high']);

// The source-of-truth boundary (amendment 9): classification, not a denylist.
export const PREDICATE_CLASSES = Object.freeze([
  'contextual',                        // storable, retrievable as context
  'preference_candidate',              // routed OUT to the preference/instruction contracts
  'authoritative_attribute_reference', // system-of-record state: pointer only, never a value
  'prohibited_secret',                 // refused outright
  'unclassified'                       // storable as context; excluded from consequential
                                       // action parameters absent a registered domain policy
]);

// ── Predicate classification ─────────────────────────────────────────────────────
// A seed registry; domain packs register known predicate schemas + authoritative sources
// (the D-PA-7 extension mechanism). The regex denylist below is DEFENCE IN DEPTH, not the
// boundary — open-domain language defeats any enumeration.

const PREDICATE_REGISTRY = Object.freeze({
  birthday: 'contextual',
  anniversary: 'contextual',
  renewal_month: 'contextual',
  preferred_name: 'preference_candidate',
  communication_preference: 'preference_candidate',
  account_balance: 'authoritative_attribute_reference',
  invoice_status: 'authoritative_attribute_reference',
  stock_level: 'authoritative_attribute_reference',
  payment_status: 'authoritative_attribute_reference',
  bank_account: 'prohibited_secret',
  payment_instruction: 'prohibited_secret',
  credential: 'prohibited_secret',
  api_token: 'prohibited_secret',
  password: 'prohibited_secret'
});

const SECRET_PATTERN = /(password|credential|api[_ ]?key|token|iban|bank[_ ]?account|routing[_ ]?number|card[_ ]?number|payment[_ ]?(instruction|destination))/i;
const AUTHORITATIVE_PATTERN = /(balance|invoice[_ ]?(status|state)|stock[_ ]?level|units[_ ]?(left|on[_ ]?hand)|cash[_ ]?(available|total)|amount[_ ]?(due|owed))/i;

export const classifyPredicate = (predicate = '') => {
  const key = String(predicate || '').trim().toLowerCase();
  if (!key) return 'unclassified';
  if (PREDICATE_REGISTRY[key]) return PREDICATE_REGISTRY[key];
  if (SECRET_PATTERN.test(key)) return 'prohibited_secret';       // defence in depth
  if (AUTHORITATIVE_PATTERN.test(key)) return 'authoritative_attribute_reference';
  return 'unclassified';
};

// ── Identity (amendment 1 + 3) ───────────────────────────────────────────────────

// The LOGICAL SLOT. Keyed HMAC so ids derived from subjects/predicates are not
// predictable; the secret is an env-legitimate secret (MEMORY_KEY_HMAC_SECRET — wired by
// the 2b writers; injected here so the leaf stays pure and tests use a fixed key).
export const buildMemoryKey = ({
  tenantId, lifecycleOwnerType, lifecycleOwnerId,
  scopeType, scopeId, subjectType, subjectId, predicate, hmacSecret
} = {}) => {
  for (const [name, value] of Object.entries({
    tenantId, lifecycleOwnerType, lifecycleOwnerId, scopeType, scopeId, subjectType, subjectId, predicate, hmacSecret
  })) {
    if (typeof value !== 'string' || !value.trim()) throw new Error(`buildMemoryKey requires ${name}`);
  }
  const canonical = [tenantId, lifecycleOwnerType, lifecycleOwnerId, scopeType, scopeId, subjectType, subjectId, predicate.toLowerCase()].join('\u0000');
  return `memk-${createHmac('sha256', hmacSecret).update(canonical).digest('hex')}`;
};

// ONE immutable assertion/version — opaque, never derived from content.
export const newMemoryId = () => `mem-${randomUUID()}`;

// The content fields a receipt pins. EXPLICIT list: adding a field here is a contract
// change (memory.v2), because it changes what receipted hashes cover.
export const CONTENT_HASH_FIELDS = Object.freeze([
  'kind', 'predicate', 'structured_value', 'source_text', 'observed_alias',
  'subject_type', 'subject_id', 'scope_type', 'scope_id', 'valid_from', 'valid_until'
]);

const canonicalize = (node) => {
  if (Array.isArray(node)) return node.map(canonicalize);
  if (node && typeof node === 'object') {
    const out = {};
    for (const key of Object.keys(node).sort()) out[key] = canonicalize(node[key]);
    return out;
  }
  return node;
};

// The v2 receipted content: v1's fields PLUS the explicit applicability and the
// business-effective interval (a narrowed applicability is a different assertion).
export const CONTENT_HASH_FIELDS_V2 = Object.freeze([
  ...CONTENT_HASH_FIELDS, 'applicability', 'effective_from', 'effective_to'
]);

export const contentHashFieldsFor = (schemaVersion) =>
  (schemaVersion === MEMORY_SCHEMA_VERSION_V2 ? CONTENT_HASH_FIELDS_V2 : CONTENT_HASH_FIELDS);

// Version-aware: a v1 record hashes exactly as it always did; a v2 record hashes
// its wider content. The version is READ from the record, never guessed.
export const memoryContentHash = (record = {}) => {
  const content = {};
  for (const field of contentHashFieldsFor(record.schema_version)) content[field] = record[field] ?? null;
  return `memh-${createHash('sha256').update(JSON.stringify(canonicalize(content))).digest('hex')}`;
};

// A value change mints the NEXT immutable version in the same slot: new memory_id,
// revision+1, supersedes link. The prior record's content stays receipt-resolvable.
export const nextMemoryRevision = (prior, changes = {}) => {
  if (!prior?.memory_id || !prior?.memory_key || !Number.isInteger(prior?.revision)) {
    throw new Error('nextMemoryRevision requires a prior record with memory_id, memory_key, revision');
  }
  const next = {
    ...prior,
    ...changes,
    memory_key: prior.memory_key,
    memory_id: newMemoryId(),
    revision: prior.revision + 1,
    supersedes_memory_id: prior.memory_id,
    record_state: 'active'
  };
  next.content_hash = memoryContentHash(next);
  return next;
};

// ── The value union (amendment 6) ────────────────────────────────────────────────

export const VALUE_TYPES = Object.freeze([
  'string', 'local_date', 'anniversary', 'timestamp', 'boolean', 'number', 'amount', 'structured'
]);

const VALUE_VALIDATORS = Object.freeze({
  string: (v) => (typeof v === 'string' && v.trim() ? [] : ['string value must be non-empty']),
  // Deliberately zone-free calendar data.
  local_date: (v) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? [] : ['local_date must be YYYY-MM-DD']),
  // A birthday is a RECURRING month/day — not a truth interval, not necessarily a full date.
  anniversary: (v) =>
    v && typeof v === 'object' && Number.isInteger(v.month) && v.month >= 1 && v.month <= 12
      && Number.isInteger(v.day) && v.day >= 1 && v.day <= 31
      && Object.keys(v).every((k) => ['month', 'day', 'year'].includes(k))
      ? [] : ['anniversary must be { month, day, year? }'],
  // An instant carries its zone explicitly.
  timestamp: (v) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T.*(Z|[+-]\d{2}:\d{2})$/.test(v) ? [] : ['timestamp must be ISO-8601 with an explicit zone']),
  boolean: (v) => (typeof v === 'boolean' ? [] : ['boolean value required']),
  number: (v) => (Number.isFinite(v) ? [] : ['finite number required']),
  amount: (v) =>
    v && typeof v === 'object' && Number.isFinite(v.amount) && typeof v.currency === 'string' && /^[A-Z]{3}$/.test(v.currency)
      ? [] : ['amount must be { amount, currency (ISO-4217) }'],
  structured: (v) => (v && typeof v === 'object' && !Array.isArray(v) ? [] : ['structured value must be an object'])
});

export const validateStructuredValue = (structuredValue, path = 'structured_value') => {
  if (structuredValue === null || structuredValue === undefined) return []; // value is optional; source_text may carry it all
  if (typeof structuredValue !== 'object' || Array.isArray(structuredValue)) return [`${path}: must be { value_type, value }`];
  const { value_type: valueType, value } = structuredValue;
  if (!VALUE_TYPES.includes(valueType)) return [`${path}.value_type: "${valueType}"`];
  const extra = Object.keys(structuredValue).filter((k) => !['value_type', 'value'].includes(k));
  if (extra.length) return [`${path}: unknown fields ${extra.join(', ')} (closed union)`];
  return VALUE_VALIDATORS[valueType](value).map((e) => `${path}: ${e}`);
};

// ── The record validator (the §8 hostile set is refused HERE) ────────────────────

const MEMORY_RECORD_FIELDS = Object.freeze([
  'schema_version', 'memory_key', 'memory_id', 'revision', 'content_hash',
  'tenant_id', 'scope_type', 'scope_id', 'lifecycle_owner_type', 'lifecycle_owner_id',
  'subject_type', 'subject_id', 'observed_alias',
  'kind', 'predicate', 'predicate_class', 'structured_value', 'source_text', 'source_refs',
  'asserted_by_principal_id', 'assertion_origin', 'transport_actor',
  'extraction_model_id', 'extraction_prompt_version', 'validator_version',
  'activation_confirmation',
  'observed_at', 'recorded_at', 'valid_from', 'valid_until',
  'retention_policy_id', 'retain_until', 'review_after', 'last_confirmed_at',
  'assertion_confidence', 'truth_confidence',
  'confidentiality', 'personal_data_class',
  'record_state', 'epistemic_state', 'record_version',
  'supersedes_memory_id', 'erased_at', 'creation_provenance'
]);

const UNRESOLVED_SUBJECT_PATTERN = /^(unknown|unresolved|tbd|\?+|)$/i;

// The v1 validator, byte-identical to the Slice 2a contract. `allowedFields` is
// the closed envelope of the version being validated (v2 widens it).
const validateMemoryRecordV1 = (record = {}, { allowedFields = MEMORY_RECORD_FIELDS, schemaVersion = MEMORY_SCHEMA_VERSION } = {}) => {
  const errors = [];
  const err = (m) => errors.push(m);
  if (!record || typeof record !== 'object') return ['record is not an object'];

  for (const key of Object.keys(record)) {
    if (!allowedFields.includes(key)) err(`unknown field "${key}" (closed envelope)`);
  }
  if (record.schema_version !== schemaVersion) err(`schema_version "${record.schema_version}"`);
  if (typeof record.memory_key !== 'string' || !record.memory_key.startsWith('memk-')) err('memory_key: required (buildMemoryKey)');
  if (typeof record.memory_id !== 'string' || !record.memory_id.startsWith('mem-')) err('memory_id: required (newMemoryId)');
  if (!Number.isInteger(record.revision) || record.revision < 1) err('revision: positive integer required');

  // Five separated identity concerns — every pair explicit, none inferred.
  for (const field of ['tenant_id', 'scope_id', 'lifecycle_owner_id', 'asserted_by_principal_id']) {
    if (typeof record[field] !== 'string' || !record[field].trim()) err(`${field}: required`);
  }
  if (!MEMORY_SCOPE_TYPES.includes(record.scope_type)) err(`scope_type "${record.scope_type}"`);
  if (!LIFECYCLE_OWNER_TYPES.includes(record.lifecycle_owner_type)) err(`lifecycle_owner_type "${record.lifecycle_owner_type}"`);

  // Subjects are business-graph identities, never names; an unresolved reference must not
  // become durable memory (it stays a candidate awaiting bounded clarification).
  if (typeof record.subject_type !== 'string' || !record.subject_type.trim()) err('subject_type: required');
  if (typeof record.subject_id !== 'string' || UNRESOLVED_SUBJECT_PATTERN.test(String(record.subject_id || '').trim())) {
    err('subject_id: a resolved business-graph entity id is required — an unresolved reference stays a candidate');
  }

  if (!MEMORY_KINDS.includes(record.kind)) err(`kind "${record.kind}" is not a memory.v1 kind (preferences/instructions are D-PA-5 objects, not memory)`);
  if (typeof record.predicate !== 'string' || !record.predicate.trim()) err('predicate: required');

  // The source-of-truth boundary.
  const expectedClass = classifyPredicate(record.predicate);
  if (record.predicate_class !== expectedClass) {
    err(`predicate_class "${record.predicate_class}" does not match classification "${expectedClass}" — the class is derived, never declared freely`);
  }
  if (expectedClass === 'prohibited_secret') {
    err(`predicate "${record.predicate}": secrets/payment instructions are prohibited from memory entirely`);
  }
  if (expectedClass === 'preference_candidate') {
    err(`predicate "${record.predicate}": preference candidates route to the preference contract, not memory`);
  }
  if (expectedClass === 'authoritative_attribute_reference') {
    const v = record.structured_value;
    const pointerOnly = v && v.value_type === 'structured' && v.value
      && typeof v.value.authoritative_source_ref === 'string' && v.value.authoritative_source_ref.trim()
      && Object.keys(v.value).length === 1;
    if (!pointerOnly) {
      err(`predicate "${record.predicate}": system-of-record state may be stored only as a pointer ({ authoritative_source_ref }) — never as a value`);
    }
  }

  errors.push(...validateStructuredValue(record.structured_value));
  if (typeof record.source_text !== 'string' || !record.source_text.trim()) err('source_text: required (the words as said)');
  if (!Array.isArray(record.source_refs) || record.source_refs.length === 0) {
    err('source_refs: at least one ref required');
  }

  if (!ASSERTION_ORIGINS.includes(record.assertion_origin)) err(`assertion_origin "${record.assertion_origin}"`);
  if (!RECORD_STATES.includes(record.record_state)) err(`record_state "${record.record_state}"`);
  if (!EPISTEMIC_STATES.includes(record.epistemic_state)) err(`epistemic_state "${record.epistemic_state}"`);

  // The quarantine rule: document-derived / third-party content cannot be ACTIVE without an
  // explicit recorded activation confirmation. Retrieval demotion is not a defence.
  if (record.record_state === 'active' && QUARANTINED_ORIGINS.includes(record.assertion_origin)) {
    const c = record.activation_confirmation;
    const confirmed = c && typeof c === 'object'
      && typeof c.confirmed_by_principal_id === 'string' && c.confirmed_by_principal_id.trim()
      && typeof c.confirmed_at === 'string' && c.confirmed_at.trim()
      && (c.via === 'explicit_confirmation' || c.via === 'trusted_extraction_path');
    if (!confirmed) {
      err(`assertion_origin "${record.assertion_origin}" cannot be active without a recorded activation_confirmation (quarantine — §8)`);
    }
  }

  if (!MEMORY_CONFIDENCES.includes(record.assertion_confidence)) err(`assertion_confidence "${record.assertion_confidence}"`);
  if (record.truth_confidence !== null && !MEMORY_CONFIDENCES.includes(record.truth_confidence)) {
    err(`truth_confidence "${record.truth_confidence}" (null/unknown is honest; inventing one is not)`);
  }
  if (!CONFIDENTIALITY_CLASSES.includes(record.confidentiality)) err(`confidentiality "${record.confidentiality}"`);
  if (!PERSONAL_DATA_CLASSES.includes(record.personal_data_class)) err(`personal_data_class "${record.personal_data_class}"`);

  // Sensitivity floor: a temporal marker about a person is at least `personal`.
  if (record.kind === 'temporal_marker' && record.subject_type === 'contact' && record.personal_data_class === 'none') {
    err('personal_data_class: a temporal_marker about a person is at least "personal" (floor)');
  }
  // user_private scope requires the user lifecycle (deletion rules must match the scope).
  if (record.scope_type === 'user_private' && record.lifecycle_owner_type !== 'user') {
    err('scope_type user_private requires lifecycle_owner_type "user"');
  }

  if (typeof record.observed_at !== 'string' || !record.observed_at) err('observed_at: required');
  if (typeof record.recorded_at !== 'string' || !record.recorded_at) err('recorded_at: required');

  // The receipt pin: content_hash must match the content fields exactly.
  if (record.content_hash !== memoryContentHash(record)) {
    err('content_hash: does not match the record content (receipted content may never drift)');
  }

  return errors;
};

// Dispatch on the DECLARED version: 'memory.v1' → the v1 contract exactly as
// before; 'memory.v2' → v1's checks over the wider envelope plus the v2 checks
// (below); anything else is refused. Absence is not "v1" — it is an error.
export const validateMemoryRecord = (record = {}) => {
  if (!record || typeof record !== 'object') return ['record is not an object'];
  if (record.schema_version === MEMORY_SCHEMA_VERSION_V2) {
    return [
      ...validateMemoryRecordV1(record, { allowedFields: MEMORY_RECORD_FIELDS_V2, schemaVersion: MEMORY_SCHEMA_VERSION_V2 }),
      ...validateMemoryRecordV2Extension(record)
    ];
  }
  return validateMemoryRecordV1(record);
};

// Scenario ids for the memory evaluation suite (registered on the §11 capability pack now;
// the executable scenarios land with 2c's gold suite — same ids).
export const MEMORY_EVAL_SCENARIOS = Object.freeze([
  'memory_stale_review_after',
  'memory_poisoned_quoted_content',
  'memory_conflicting_assertions',
  'memory_ambiguous_subject',
  'memory_erased_exclusion',
  'memory_cross_tenant_isolation'
]);

// ═════════════════════════════════════════════════════════════════════════════
// memory.v2 — DMEM-R1 W2 (docs/design-donna-memory-remediation.md §2.1–§2.5, §4.1;
// docs/plan-2026-09-02-memory-remediation-v1.md "Wave 2"; migrations 141–146).
//
// Everything below is ADDITIVE: none of it changes what a v1 record means or
// hashes to. The digests introduced here (evidence identity, dependence group,
// evidence-set fingerprint, scoped candidate identity, generations digest) are
// MX-1's canonicalDigest (audit §6.1) — never a second digest law.
// ═════════════════════════════════════════════════════════════════════════════

// ── Applicability (doctrine §2.5 / §4.1: "A null applicability field means
// unspecified or not applicable. Any permitted wildcard is an explicit typed value.")
export const APPLICABILITY_VERSION = 'applicability.v1';
export const APPLICABILITY_DIMENSIONS = Object.freeze([
  'jurisdiction', 'account', 'currency', 'party', 'direction', 'document_type', 'external_system', 'purpose'
]);
export const APPLICABILITY_KINDS = Object.freeze(['value', 'any', 'unspecified']);

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// Normalization may standardize representation but never widen: an absent or
// null dimension becomes { kind: 'unspecified' } — NOT 'any'. A bare string is
// shorthand for { kind: 'value', value }. Unknown dimensions are kept out (the
// validator refuses them, so a typo cannot smuggle a dimension in).
export const normalizeApplicability = (input = null) => {
  const source = isPlainObject(input) ? input : {};
  const out = {};
  for (const dimension of APPLICABILITY_DIMENSIONS) {
    const raw = source[dimension];
    if (raw === undefined || raw === null) out[dimension] = { kind: 'unspecified' };
    else if (typeof raw === 'string') out[dimension] = { kind: 'value', value: raw };
    else if (isPlainObject(raw) && raw.kind === 'value') out[dimension] = { kind: 'value', value: raw.value };
    else if (isPlainObject(raw) && raw.kind === 'any') out[dimension] = { kind: 'any' };
    else if (isPlainObject(raw) && raw.kind === 'unspecified') out[dimension] = { kind: 'unspecified' };
    else out[dimension] = raw; // left for the validator to refuse with a precise message
  }
  for (const key of Object.keys(source)) {
    if (!APPLICABILITY_DIMENSIONS.includes(key)) out[key] = source[key]; // refused by the validator
  }
  return out;
};

export const validateApplicability = (applicability, path = 'applicability') => {
  const errors = [];
  if (!isPlainObject(applicability)) return [`${path}: must be an object with every dimension declared (${APPLICABILITY_DIMENSIONS.join(', ')})`];
  for (const key of Object.keys(applicability)) {
    if (!APPLICABILITY_DIMENSIONS.includes(key)) errors.push(`${path}.${key}: unknown dimension (closed set)`);
  }
  for (const dimension of APPLICABILITY_DIMENSIONS) {
    const entry = applicability[dimension];
    if (!isPlainObject(entry)) { errors.push(`${path}.${dimension}: every dimension is declared explicitly ({ kind: value | any | unspecified })`); continue; }
    if (!APPLICABILITY_KINDS.includes(entry.kind)) { errors.push(`${path}.${dimension}.kind: "${entry.kind}"`); continue; }
    const keys = Object.keys(entry).sort().join(',');
    if (entry.kind === 'value') {
      if (keys !== 'kind,value') errors.push(`${path}.${dimension}: a value entry is exactly { kind, value }`);
      if (typeof entry.value !== 'string' || !entry.value.trim()) errors.push(`${path}.${dimension}.value: a non-empty string is required`);
    } else if (keys !== 'kind') {
      errors.push(`${path}.${dimension}: a ${entry.kind} entry carries no value`);
    }
  }
  return errors;
};

// Eligibility (doctrine §2.5 phase 1 — hard filter, never ranking): for each
// dimension, 'any' matches everything; 'value' matches only a context that states
// the same value (a context that does not declare the dimension cannot use a
// dimension-specific claim); 'unspecified' matches only a context that does NOT
// require the dimension — unspecified is never a wildcard.
export const applicabilityMatches = (applicability, context = {}) => {
  const reasons = [];
  const errors = validateApplicability(applicability);
  if (errors.length) return { eligible: false, reasons: errors };
  for (const dimension of APPLICABILITY_DIMENSIONS) {
    const entry = applicability[dimension];
    const required = context?.[dimension];
    if (entry.kind === 'any') continue;
    if (entry.kind === 'value') {
      if (required === undefined || required === null) reasons.push(`${dimension}: claim is specific to "${entry.value}" but the context declares no ${dimension}`);
      else if (String(required) !== entry.value) reasons.push(`${dimension}: claim is specific to "${entry.value}", context requires "${required}"`);
      continue;
    }
    if (required !== undefined && required !== null) reasons.push(`${dimension}: context requires "${required}" but the claim leaves it unspecified (unspecified is not a wildcard)`);
  }
  return { eligible: reasons.length === 0, reasons };
};

// ── Business-effective interval: half-open [effective_from, effective_to), DATE-typed.
const LOCAL_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
export const validateEffectiveInterval = ({ effective_from: from = null, effective_to: to = null } = {}, path = '') => {
  const errors = [];
  const prefix = path ? `${path}.` : '';
  if (from !== null && (typeof from !== 'string' || !LOCAL_DATE_PATTERN.test(from))) errors.push(`${prefix}effective_from: YYYY-MM-DD or null`);
  if (to !== null && (typeof to !== 'string' || !LOCAL_DATE_PATTERN.test(to))) errors.push(`${prefix}effective_to: YYYY-MM-DD or null`);
  if (!errors.length && from !== null && to !== null && !(from < to)) errors.push(`${prefix}effective_from must precede effective_to (half-open [from, to))`);
  return errors;
};

// ── Evidence identity and dependence (doctrine §2.1, INV-08).
export const EVIDENCE_KINDS = Object.freeze(['document', 'message', 'transaction', 'correction', 'registry', 'observation', 'assertion']);
export const CORROBORATION_CLASSES = Object.freeze(['independent', 'repeated']);

// One underlying evidence, identified ONCE: source object identity + version +
// excerpt digest. Reprocessing (a re-OCR, a paraphrase) of the same version is the
// same identity; a new VERSION of the source is new evidence in the SAME
// dependence group (it can never count as independent support).
export const buildEvidenceIdentity = ({ sourceObjectType, sourceObjectId, sourceObjectVersion = null, excerptDigest = null } = {}) => {
  for (const [name, value] of Object.entries({ sourceObjectType, sourceObjectId })) {
    if (typeof value !== 'string' || !value.trim()) throw new Error(`buildEvidenceIdentity requires ${name}`);
  }
  return `evid-${canonicalDigest({
    source_object_type: sourceObjectType,
    source_object_id: sourceObjectId,
    source_object_version: sourceObjectVersion ?? null,
    excerpt_digest: excerptDigest ?? null
  })}`;
};

// The dependence group: version-agnostic identity of the underlying source. Two
// evidence identities in one group are never independent of each other.
export const buildDependenceGroup = ({ sourceObjectType, sourceObjectId } = {}) => {
  for (const [name, value] of Object.entries({ sourceObjectType, sourceObjectId })) {
    if (typeof value !== 'string' || !value.trim()) throw new Error(`buildDependenceGroup requires ${name}`);
  }
  return `evgrp-${canonicalDigest({ source_object_type: sourceObjectType, source_object_id: sourceObjectId })}`;
};

// A v1 `source_refs` entry → the evidence entry it denotes. Known shapes name
// their source object; anything else is an 'observation' identified by the
// digest of the ref itself (deterministic, so a replayed ref converges).
const SOURCE_REF_KEYS = Object.freeze([
  ['document_id', 'document'], ['message_id', 'message'], ['transaction_id', 'transaction'],
  ['correction_id', 'correction'], ['registry_ref', 'registry'], ['assertion_id', 'assertion']
]);

export const evidenceFromSourceRef = (ref = {}) => {
  const source = isPlainObject(ref) ? ref : { value: ref };
  const hit = SOURCE_REF_KEYS.find(([key]) => typeof source[key] === 'string' && source[key].trim());
  const sourceObjectType = hit ? hit[1] : 'observation';
  const sourceObjectId = hit ? source[hit[0]] : canonicalDigest(source);
  const sourceObjectVersion = typeof source.version === 'string' && source.version.trim() ? source.version : null;
  const excerptDigest = typeof source.verbatim_span === 'string' && source.verbatim_span.trim()
    ? canonicalDigest(source.verbatim_span) : null;
  return {
    evidence_id: buildEvidenceIdentity({ sourceObjectType, sourceObjectId, sourceObjectVersion, excerptDigest }),
    dependence_group: buildDependenceGroup({ sourceObjectType, sourceObjectId }),
    evidence_kind: sourceObjectType,
    source_object_type: sourceObjectType,
    source_object_id: sourceObjectId,
    source_object_version: sourceObjectVersion,
    observed_at: typeof source.observed_at === 'string' ? source.observed_at : null
  };
};

export const evidenceFromSourceRefs = (sourceRefs = []) =>
  (Array.isArray(sourceRefs) ? sourceRefs : []).map(evidenceFromSourceRef);

// The independence-preserving fingerprint of an evidence SET: the sorted, unique
// dependence groups. Adding a derivative of an already-present source does not
// change it; adding an independent source does.
export const evidenceSetFingerprint = (evidence = []) => {
  const groups = [...new Set((Array.isArray(evidence) ? evidence : []).map((e) => e?.dependence_group).filter(Boolean))].sort();
  return `evset-${canonicalDigest(groups)}`;
};

// 'independent' when the group is new for the claim, 'repeated' otherwise.
export const classifyCorroboration = ({ knownGroups = new Set(), dependenceGroup } = {}) => {
  if (typeof dependenceGroup !== 'string' || !dependenceGroup) throw new Error('classifyCorroboration requires dependenceGroup');
  const known = knownGroups instanceof Set ? knownGroups : new Set(knownGroups || []);
  return known.has(dependenceGroup) ? 'repeated' : 'independent';
};

export const validateEvidenceEntry = (entry, path = 'evidence[]') => {
  const errors = [];
  if (!isPlainObject(entry)) return [`${path}: must be an object`];
  if (typeof entry.evidence_id !== 'string' || !entry.evidence_id.startsWith('evid-')) errors.push(`${path}.evidence_id: required (buildEvidenceIdentity)`);
  if (typeof entry.dependence_group !== 'string' || !entry.dependence_group.startsWith('evgrp-')) errors.push(`${path}.dependence_group: required (buildDependenceGroup)`);
  if (!EVIDENCE_KINDS.includes(entry.evidence_kind)) errors.push(`${path}.evidence_kind: "${entry.evidence_kind}"`);
  if (entry.corroboration_class !== undefined && entry.corroboration_class !== null && !CORROBORATION_CLASSES.includes(entry.corroboration_class)) {
    errors.push(`${path}.corroboration_class: "${entry.corroboration_class}"`);
  }
  return errors;
};

// ── Generations (INV-27). The generation compared at commit is `claim_generation`;
// nothing here is named just "generation".
export const INITIAL_CLAIM_GENERATION = 1;
export const isClaimGeneration = (value) => Number.isInteger(value) && value >= INITIAL_CLAIM_GENERATION;
export const nextClaimGeneration = (current) => {
  if (!isClaimGeneration(current)) throw new Error(`nextClaimGeneration: "${current}" is not a claim generation`);
  return current + 1;
};
// A decision's "generations used": { memory_id: claim_generation } → one digest.
export const claimGenerationsDigest = (generations = {}) => {
  if (!isPlainObject(generations)) throw new Error('claimGenerationsDigest requires { memory_id: claim_generation }');
  for (const [memoryId, generation] of Object.entries(generations)) {
    if (!isClaimGeneration(generation)) throw new Error(`claimGenerationsDigest: ${memoryId} carries a non-generation "${generation}"`);
  }
  return `clgen-${canonicalDigest(generations)}`;
};

// ── Scoped candidate identity (doctrine §2.2; audit S08/L1-identity substrate).
// Deterministic over tenant, LEGAL ENTITY, subject class, normalized applicability,
// normalized value and the independent evidence set — so the same learning staged
// by two legal entities is two candidates, and a re-observation of the same source
// converges on one. Opaque: the digest, not the parts.
export const buildScopedCandidateIdentity = ({
  tenantId, legalEntityId, subjectClass, applicability = null, normalizedValue = null, evidenceFingerprint = null
} = {}) => {
  for (const [name, value] of Object.entries({ tenantId, legalEntityId, subjectClass })) {
    if (typeof value !== 'string' || !value.trim()) throw new Error(`buildScopedCandidateIdentity requires ${name}`);
  }
  const normalized = normalizeApplicability(applicability);
  const errors = validateApplicability(normalized);
  if (errors.length) throw new Error(`buildScopedCandidateIdentity: ${errors[0]}`);
  return `memcand2-${canonicalDigest({
    tenant_id: tenantId,
    legal_entity_id: legalEntityId,
    subject_class: subjectClass,
    applicability: normalized,
    normalized_value: normalizedValue ?? null,
    evidence_fingerprint: evidenceFingerprint ?? null
  })}`;
};

// ── The v2 record envelope (closed): v1's fields plus the W2 columns of
// migrations 142 / 146. `evidence` is a WRITE-TIME input (the links the writer
// persists into memory_evidence_links); the persisted row carries the
// fingerprint, so a record rebuilt from a row validates without it.
export const MEMORY_RECORD_FIELDS_V2 = Object.freeze([
  ...MEMORY_RECORD_FIELDS,
  'applicability', 'applicability_version', 'effective_from', 'effective_to',
  'evidence', 'evidence_fingerprint', 'claim_generation',
  'source_object_type', 'source_object_id', 'source_object_version', 'source_excerpt',
  'raw_value', 'normalized_value', 'validation_confidence', 'confirmation_history',
  'supersession_reason', 'invalidation_reason', 'consuming_decision_refs', 'promotion_receipt_id'
]);

const validateMemoryRecordV2Extension = (record = {}) => {
  const errors = [];
  const err = (m) => errors.push(m);
  errors.push(...validateApplicability(record.applicability));
  if (record.applicability_version !== APPLICABILITY_VERSION) err(`applicability_version "${record.applicability_version}" (expected ${APPLICABILITY_VERSION})`);
  errors.push(...validateEffectiveInterval({ effective_from: record.effective_from ?? null, effective_to: record.effective_to ?? null }));
  if (record.evidence !== undefined && record.evidence !== null) {
    if (!Array.isArray(record.evidence)) err('evidence: an array of evidence entries');
    else record.evidence.forEach((entry, i) => errors.push(...validateEvidenceEntry(entry, `evidence[${i}]`)));
  }
  if (typeof record.evidence_fingerprint !== 'string' || !record.evidence_fingerprint.startsWith('evset-')) {
    err('evidence_fingerprint: required (evidenceSetFingerprint over the evidence set)');
  } else if (Array.isArray(record.evidence) && record.evidence_fingerprint !== evidenceSetFingerprint(record.evidence)) {
    err('evidence_fingerprint: does not match the evidence set (INV-08: support is receipted, never asserted)');
  }
  if (!isClaimGeneration(record.claim_generation)) err('claim_generation: positive integer required');
  for (const field of ['source_object_type', 'source_object_id', 'source_object_version', 'source_excerpt', 'supersession_reason', 'invalidation_reason', 'promotion_receipt_id']) {
    if (record[field] !== null && record[field] !== undefined && typeof record[field] !== 'string') err(`${field}: string or null`);
  }
  if (record.validation_confidence !== null && record.validation_confidence !== undefined && !MEMORY_CONFIDENCES.includes(record.validation_confidence)) {
    err(`validation_confidence "${record.validation_confidence}" (null = not yet validated; inventing one is not honest)`);
  }
  if (!Array.isArray(record.confirmation_history)) err('confirmation_history: an array (possibly empty)');
  if (!Array.isArray(record.consuming_decision_refs)) err('consuming_decision_refs: an array (possibly empty)');
  return errors;
};

// Complete the v2-only fields of a draft (the writer calls this after the v1
// completion): applicability normalized (never widened), the interval as-is, the
// evidence set derived from source_refs when the caller gave none, the fingerprint,
// the generation, the provenance defaults. Returns the completed record; errors
// surface through validateMemoryRecord.
export const completeMemoryRecordV2Fields = (record = {}) => {
  const out = { ...record };
  out.applicability = normalizeApplicability(out.applicability ?? null);
  out.applicability_version = out.applicability_version ?? APPLICABILITY_VERSION;
  out.effective_from = out.effective_from ?? null;
  out.effective_to = out.effective_to ?? null;
  out.evidence = Array.isArray(out.evidence) && out.evidence.length ? out.evidence : evidenceFromSourceRefs(out.source_refs);
  out.evidence_fingerprint = evidenceSetFingerprint(out.evidence);
  out.claim_generation = out.claim_generation ?? INITIAL_CLAIM_GENERATION;
  for (const field of ['source_object_type', 'source_object_id', 'source_object_version', 'source_excerpt', 'raw_value', 'normalized_value', 'validation_confidence', 'supersession_reason', 'invalidation_reason', 'promotion_receipt_id']) {
    out[field] = out[field] ?? null;
  }
  if (out.source_object_type === null && out.evidence.length === 1) {
    out.source_object_type = out.evidence[0].source_object_type;
    out.source_object_id = out.evidence[0].source_object_id;
    out.source_object_version = out.evidence[0].source_object_version ?? null;
  }
  out.confirmation_history = Array.isArray(out.confirmation_history) ? out.confirmation_history : [];
  out.consuming_decision_refs = Array.isArray(out.consuming_decision_refs) ? out.consuming_decision_refs : [];
  return out;
};
