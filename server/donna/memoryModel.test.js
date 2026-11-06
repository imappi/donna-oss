// Tests for the memory.v1 record contract (BizOS Slice 2a) — the identity split, the
// discriminated value union, predicate classification, and the §8 hostile write set the
// validator must refuse: secret predicates, preference smuggling, authoritative values,
// quarantined origins activating silently, unresolved subjects, scope/lifecycle mismatch,
// sensitivity floor violations, content-hash drift.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  MEMORY_SCHEMA_VERSION,
  MEMORY_KINDS,
  MEMORY_SCOPE_TYPES,
  LIFECYCLE_OWNER_TYPES,
  ASSERTION_ORIGINS,
  RECORD_STATES,
  EPISTEMIC_STATES,
  MEMORY_RELATION_TYPES,
  CONFIDENTIALITY_CLASSES,
  PERSONAL_DATA_CLASSES,
  PREDICATE_CLASSES,
  MEMORY_EVAL_SCENARIOS,
  classifyPredicate,
  buildMemoryKey,
  newMemoryId,
  memoryContentHash,
  nextMemoryRevision,
  validateStructuredValue,
  validateMemoryRecord
} from './memoryModel.js';

const KEY_ARGS = Object.freeze({
  tenantId: 'firm-1', lifecycleOwnerType: 'user', lifecycleOwnerId: 'user-kari',
  scopeType: 'user_private', scopeId: 'user-kari', subjectType: 'contact',
  subjectId: 'contact-42', predicate: 'birthday', hmacSecret: 'test-secret'
});

const validRecord = (overrides = {}) => {
  const base = {
    schema_version: MEMORY_SCHEMA_VERSION,
    memory_key: buildMemoryKey(KEY_ARGS),
    memory_id: newMemoryId(),
    revision: 1,
    tenant_id: 'firm-1',
    scope_type: 'user_private',
    scope_id: 'user-kari',
    lifecycle_owner_type: 'user',
    lifecycle_owner_id: 'user-kari',
    subject_type: 'contact',
    subject_id: 'contact-42',
    observed_alias: 'Alex Chen',
    kind: 'temporal_marker',
    predicate: 'birthday',
    predicate_class: 'contextual',
    structured_value: { value_type: 'anniversary', value: { month: 7, day: 14 } },
    source_text: "Alex's birthday is 14 July",
    source_refs: [{ message_id: 'm1', verbatim_span: "Alex's birthday is 14 July" }],
    asserted_by_principal_id: 'kari@books.example',
    assertion_origin: 'owner_asserted',
    transport_actor: null,
    extraction_model_id: 'claude-opus-4-8',
    extraction_prompt_version: 'intent_compiler_prompt.v1',
    validator_version: 'memory.v1',
    activation_confirmation: null,
    observed_at: '2026-07-12T10:00:00Z',
    recorded_at: '2026-07-12T10:00:01Z',
    valid_from: null,
    valid_until: null,
    retention_policy_id: null,
    retain_until: null,
    review_after: null,
    last_confirmed_at: null,
    assertion_confidence: 'high',
    truth_confidence: null,
    confidentiality: 'confidential',
    personal_data_class: 'personal',
    record_state: 'active',
    epistemic_state: 'asserted',
    record_version: 1,
    supersedes_memory_id: null,
    erased_at: null,
    creation_provenance: {}
  };
  const merged = { ...base, ...overrides };
  merged.content_hash = memoryContentHash(merged);
  return merged;
};

test('vocabulary pins: no preference/instruction kinds, no household/conversation scopes', () => {
  assert.deepEqual([...MEMORY_KINDS], ['assertion', 'relationship_context', 'episodic_context', 'temporal_marker']);
  for (const removed of ['preference', 'instruction_note', 'correction']) {
    assert.ok(!MEMORY_KINDS.includes(removed), `kind "${removed}" must not be memory`);
  }
  assert.ok(!MEMORY_SCOPE_TYPES.includes('household'), 'household is cut from v1');
  assert.ok(!MEMORY_SCOPE_TYPES.includes('conversation'), 'conversation context is not a memories scope');
  assert.deepEqual([...LIFECYCLE_OWNER_TYPES], ['user', 'organisation', 'legal_entity', 'ephemeral']);
  assert.ok(MEMORY_RELATION_TYPES.includes('contradicts') && MEMORY_RELATION_TYPES.includes('supersedes'));
  assert.equal(CONFIDENTIALITY_CLASSES.length, 3);
  assert.equal(PERSONAL_DATA_CLASSES.length, 3);
  assert.ok(ASSERTION_ORIGINS.includes('third_party_reported') && RECORD_STATES.includes('erased') && EPISTEMIC_STATES.includes('contradicted'));
  assert.ok(PREDICATE_CLASSES.includes('prohibited_secret'));
  assert.ok(MEMORY_EVAL_SCENARIOS.length >= 6);
});

test('memory_key: deterministic, keyed (unpredictable without the secret), all parts required', () => {
  const k1 = buildMemoryKey(KEY_ARGS);
  assert.equal(k1, buildMemoryKey({ ...KEY_ARGS }));
  assert.match(k1, /^memk-[0-9a-f]{64}$/);
  assert.notEqual(k1, buildMemoryKey({ ...KEY_ARGS, hmacSecret: 'other-secret' }));
  assert.notEqual(k1, buildMemoryKey({ ...KEY_ARGS, subjectId: 'contact-43' }));
  assert.throws(() => buildMemoryKey({ ...KEY_ARGS, tenantId: '' }), /tenantId/);
});

test('a valid owner-asserted record passes the full contract', () => {
  assert.deepEqual(validateMemoryRecord(validRecord()), []);
});

test('identity split: a value change mints a NEW memory_id; the receipted prior content survives', () => {
  const prior = validRecord();
  const next = nextMemoryRevision(prior, {
    structured_value: { value_type: 'anniversary', value: { month: 7, day: 15 } },
    source_text: "Correction: Alex's birthday is 15 July"
  });
  assert.equal(next.memory_key, prior.memory_key, 'same logical slot');
  assert.notEqual(next.memory_id, prior.memory_id, 'a new immutable record');
  assert.equal(next.revision, 2);
  assert.equal(next.supersedes_memory_id, prior.memory_id);
  assert.notEqual(next.content_hash, prior.content_hash);
  // The prior record is untouched — an old receipt (memory_id + revision + content_hash)
  // still resolves to the old content.
  assert.equal(prior.content_hash, memoryContentHash(prior));
  assert.deepEqual(validateMemoryRecord(next), []);
});

test('content-hash drift is refused (receipted content may never change under an id)', () => {
  const tampered = { ...validRecord(), source_text: 'quietly different words' };
  assert.ok(validateMemoryRecord(tampered).some((e) => e.includes('content_hash')));
});

test('hostile: secret and preference predicates are refused; the class is derived, never declared', () => {
  const secret = validRecord({ predicate: 'bank_account', predicate_class: 'prohibited_secret', structured_value: null });
  assert.ok(validateMemoryRecord(secret).some((e) => e.includes('prohibited from memory entirely')));
  // Defence in depth: an unlisted secret-shaped predicate classifies by pattern.
  assert.equal(classifyPredicate('supplier iban'), 'prohibited_secret');
  assert.equal(classifyPredicate('card number backup'), 'prohibited_secret');

  const pref = validRecord({ predicate: 'preferred_name', predicate_class: 'preference_candidate', structured_value: null });
  assert.ok(validateMemoryRecord(pref).some((e) => e.includes('preference contract')));

  const laundered = validRecord({ predicate: 'bank_account', predicate_class: 'contextual', structured_value: null });
  assert.ok(validateMemoryRecord(laundered).some((e) => e.includes('does not match classification')));
});

test('hostile: authoritative attributes store pointers only, never values', () => {
  assert.equal(classifyPredicate('account_balance'), 'authoritative_attribute_reference');
  assert.equal(classifyPredicate('cash available today'), 'authoritative_attribute_reference');
  const withValue = validRecord({
    predicate: 'account_balance',
    predicate_class: 'authoritative_attribute_reference',
    structured_value: { value_type: 'amount', value: { amount: 12000, currency: 'EUR' } }
  });
  assert.ok(validateMemoryRecord(withValue).some((e) => e.includes('pointer')));
  const pointer = validRecord({
    predicate: 'account_balance',
    predicate_class: 'authoritative_attribute_reference',
    structured_value: { value_type: 'structured', value: { authoritative_source_ref: 'ledger:account:1910' } }
  });
  assert.deepEqual(validateMemoryRecord(pointer), []);
});

test('hostile: quarantined origins cannot be active without a recorded activation confirmation', () => {
  for (const origin of ['distilled_from_document', 'third_party_reported']) {
    const silent = validRecord({ assertion_origin: origin, transport_actor: 'kari@books.example' });
    assert.ok(
      validateMemoryRecord(silent).some((e) => e.includes('quarantine')),
      `${origin} must not activate silently (an owner forwarding it is transport, not assertion)`
    );
    const confirmed = validRecord({
      assertion_origin: origin,
      transport_actor: 'kari@books.example',
      activation_confirmation: { confirmed_by_principal_id: 'kari@books.example', confirmed_at: '2026-07-12T11:00:00Z', via: 'explicit_confirmation' }
    });
    assert.deepEqual(validateMemoryRecord(confirmed), []);
  }
});

test('hostile: unresolved subjects, scope/lifecycle mismatch, sensitivity floor, invented truth', () => {
  assert.ok(validateMemoryRecord(validRecord({ subject_id: 'unknown' })).some((e) => e.includes('candidate')));
  assert.ok(validateMemoryRecord(validRecord({ subject_id: '???' })).some((e) => e.includes('candidate')));
  assert.ok(validateMemoryRecord(validRecord({ lifecycle_owner_type: 'organisation' }))
    .some((e) => e.includes('user_private requires lifecycle_owner_type "user"')));
  assert.ok(validateMemoryRecord(validRecord({ personal_data_class: 'none' }))
    .some((e) => e.includes('floor')));
  assert.ok(validateMemoryRecord(validRecord({ truth_confidence: 'certain' }))
    .some((e) => e.includes('truth_confidence')));
  assert.ok(validateMemoryRecord({ ...validRecord(), execute_now: true })
    .some((e) => e.includes('closed envelope')));
});

test('the value union is closed and calendar-honest', () => {
  assert.deepEqual(validateStructuredValue({ value_type: 'anniversary', value: { month: 7, day: 14 } }), []);
  assert.ok(validateStructuredValue({ value_type: 'anniversary', value: { month: 13, day: 1 } }).length > 0);
  assert.deepEqual(validateStructuredValue({ value_type: 'local_date', value: '2026-08-01' }), []);
  assert.ok(validateStructuredValue({ value_type: 'timestamp', value: '2026-08-01T09:00:00' }).length > 0, 'an instant without a zone is refused');
  assert.deepEqual(validateStructuredValue({ value_type: 'timestamp', value: '2026-08-01T09:00:00+03:00' }), []);
  assert.ok(validateStructuredValue({ value_type: 'amount', value: { amount: 10, currency: 'euros' } }).length > 0);
  assert.ok(validateStructuredValue({ value_type: 'vibes', value: 'x' }).length > 0);
  assert.ok(validateStructuredValue({ value_type: 'string', value: 'x', extra: true }).length > 0, 'closed union');
  assert.deepEqual(validateStructuredValue(null), [], 'value is optional — source_text may carry it all');
});

test('classifyPredicate: registry, patterns, and honest unclassified', () => {
  assert.equal(classifyPredicate('birthday'), 'contextual');
  assert.equal(classifyPredicate('invoice_status'), 'authoritative_attribute_reference');
  assert.equal(classifyPredicate('units left in warehouse'), 'authoritative_attribute_reference');
  assert.equal(classifyPredicate('communication_preference'), 'preference_candidate');
  assert.equal(classifyPredicate('favourite_meeting_cafe'), 'unclassified');
});

// ═══════════════════════════════════════════════════════════════════════════════
// DMEM-R1 W2 — the memory.v2 contract beside v1 (the version is a field).
// ═══════════════════════════════════════════════════════════════════════════════

import {
  MEMORY_SCHEMA_VERSION_V2,
  MEMORY_SCHEMA_VERSIONS,
  MEMORY_SCHEMA_VERSION_CURRENT,
  APPLICABILITY_DIMENSIONS,
  APPLICABILITY_VERSION,
  CONTENT_HASH_FIELDS,
  CONTENT_HASH_FIELDS_V2,
  MEMORY_RECORD_FIELDS_V2,
  normalizeApplicability,
  validateApplicability,
  applicabilityMatches,
  validateEffectiveInterval,
  buildEvidenceIdentity,
  buildDependenceGroup,
  evidenceFromSourceRefs,
  evidenceSetFingerprint,
  classifyCorroboration,
  claimGenerationsDigest,
  nextClaimGeneration,
  buildScopedCandidateIdentity,
  completeMemoryRecordV2Fields
} from './memoryModel.js';

const validV2Record = (overrides = {}) => {
  const base = completeMemoryRecordV2Fields({ ...validRecord(), schema_version: MEMORY_SCHEMA_VERSION_V2, ...overrides });
  base.content_hash = memoryContentHash(base);
  return base;
};

test('v2: the version is a declared field — v1 validates as before, v2 validates its extension, anything else is refused', () => {
  assert.deepEqual([...MEMORY_SCHEMA_VERSIONS], ['memory.v1', 'memory.v2']);
  assert.equal(MEMORY_SCHEMA_VERSION_CURRENT, MEMORY_SCHEMA_VERSION_V2);
  assert.deepEqual(validateMemoryRecord(validRecord()), [], 'a v1 record is untouched');
  assert.deepEqual(validateMemoryRecord(validV2Record()), []);
  const undeclared = { ...validRecord() };
  delete undeclared.schema_version;
  assert.ok(validateMemoryRecord(undeclared).some((e) => /schema_version/.test(e)), 'absence is not v1');
  assert.ok(validateMemoryRecord({ ...validRecord(), schema_version: 'memory.v3' }).some((e) => /schema_version/.test(e)));
  // A v2 field on a v1 record is outside v1's closed envelope.
  assert.ok(validateMemoryRecord({ ...validRecord(), applicability: normalizeApplicability() }).some((e) => /unknown field "applicability"/.test(e)));
});

test('v2: the content hash covers applicability + the effective interval, and v1 hashes are byte-identical to before', () => {
  assert.deepEqual([...CONTENT_HASH_FIELDS_V2], [...CONTENT_HASH_FIELDS, 'applicability', 'effective_from', 'effective_to']);
  const v1 = validRecord();
  assert.equal(memoryContentHash(v1), memoryContentHash({ ...v1, applicability: normalizeApplicability({ jurisdiction: 'GB' }) }), 'a v1 hash ignores v2 fields');
  const v2 = validV2Record();
  const narrowed = validV2Record({ applicability: { jurisdiction: 'GB' } });
  assert.notEqual(v2.content_hash, narrowed.content_hash, 'a narrowed applicability is a different assertion');
  assert.ok(MEMORY_RECORD_FIELDS_V2.includes('claim_generation') && MEMORY_RECORD_FIELDS_V2.includes('evidence_fingerprint'));
});

test('applicability: every dimension explicit; absent is unspecified (never any); a bare string is a value; unknown dimensions refused', () => {
  const normalized = normalizeApplicability({ jurisdiction: 'GB', currency: { kind: 'any' } });
  for (const dimension of APPLICABILITY_DIMENSIONS) assert.ok(normalized[dimension], `${dimension} declared`);
  assert.deepEqual(normalized.jurisdiction, { kind: 'value', value: 'GB' });
  assert.deepEqual(normalized.currency, { kind: 'any' });
  assert.deepEqual(normalized.party, { kind: 'unspecified' });
  assert.deepEqual(validateApplicability(normalized), []);
  assert.ok(validateApplicability(normalizeApplicability({ vibes: 'x' })).some((e) => /unknown dimension/.test(e)));
  assert.ok(validateApplicability({ ...normalized, jurisdiction: { kind: 'value' } }).some((e) => /value: a non-empty string/.test(e)));
  assert.ok(validateApplicability({ ...normalized, jurisdiction: { kind: 'any', value: 'GB' } }).some((e) => /carries no value/.test(e)));
  assert.ok(validateApplicability({ ...normalized, jurisdiction: null }).some((e) => /declared explicitly/.test(e)));
  assert.equal(APPLICABILITY_VERSION, 'applicability.v1');
});

test('applicability eligibility: value must match, any matches all, unspecified is NOT a wildcard (fails a context that requires the dimension)', () => {
  const claim = normalizeApplicability({ jurisdiction: 'GB', currency: { kind: 'any' } });
  assert.equal(applicabilityMatches(claim, { jurisdiction: 'GB', currency: 'EUR' }).eligible, true);
  assert.equal(applicabilityMatches(claim, { jurisdiction: 'FI', currency: 'EUR' }).eligible, false, 'wrong value');
  assert.equal(applicabilityMatches(claim, { currency: 'EUR' }).eligible, false, 'a GB-specific claim needs a context that declares GB');
  assert.equal(applicabilityMatches(claim, { jurisdiction: 'GB', party: 'acme' }).eligible, false, 'unspecified party is not a wildcard for a party-requiring context');
  const reasons = applicabilityMatches(claim, { jurisdiction: 'GB', party: 'acme' }).reasons;
  assert.ok(reasons.some((r) => /unspecified is not a wildcard/.test(r)));
  assert.equal(applicabilityMatches(claim, { jurisdiction: 'GB' }).eligible, true, 'a context that does not require party is fine');
});

test('effective interval: half-open DATE interval, from < to, YYYY-MM-DD only', () => {
  assert.deepEqual(validateEffectiveInterval({ effective_from: '2026-01-01', effective_to: '2026-07-01' }), []);
  assert.deepEqual(validateEffectiveInterval({ effective_from: null, effective_to: null }), []);
  assert.ok(validateEffectiveInterval({ effective_from: '2026-07-01', effective_to: '2026-07-01' }).length > 0, 'empty interval refused');
  assert.ok(validateEffectiveInterval({ effective_from: '2026-07-01T00:00:00Z', effective_to: null }).length > 0, 'an instant is not a business date');
});

test('evidence identity (INV-08): one identity per source version, one dependence group per source; derivatives never gain independence', () => {
  const v1 = buildEvidenceIdentity({ sourceObjectType: 'document', sourceObjectId: 'doc-1', sourceObjectVersion: '1' });
  const v2 = buildEvidenceIdentity({ sourceObjectType: 'document', sourceObjectId: 'doc-1', sourceObjectVersion: '2' });
  assert.match(v1, /^evid-[0-9a-f]{64}$/);
  assert.notEqual(v1, v2, 'a new source version is new evidence');
  assert.equal(buildDependenceGroup({ sourceObjectType: 'document', sourceObjectId: 'doc-1' }), buildDependenceGroup({ sourceObjectType: 'document', sourceObjectId: 'doc-1' }));
  assert.throws(() => buildEvidenceIdentity({ sourceObjectType: 'document' }), /requires sourceObjectId/);
  const evidence = evidenceFromSourceRefs([{ document_id: 'doc-1', verbatim_span: 'Acme' }, { document_id: 'doc-1' }, { transaction_id: 'tx-9' }, { free: 'form' }]);
  assert.equal(evidence.length, 4);
  assert.equal(evidence[0].evidence_kind, 'document');
  assert.equal(evidence[0].dependence_group, evidence[1].dependence_group, 'a paraphrase / excerpt of one document shares the group');
  assert.notEqual(evidence[0].evidence_id, evidence[1].evidence_id, 'but is its own identity');
  assert.equal(evidence[2].evidence_kind, 'transaction');
  assert.equal(evidence[3].evidence_kind, 'observation');
  assert.equal(evidenceFromSourceRefs([{ free: 'form' }])[0].evidence_id, evidence[3].evidence_id, 'deterministic over the ref');
  const fingerprint = evidenceSetFingerprint(evidence);
  assert.match(fingerprint, /^evset-/);
  assert.equal(evidenceSetFingerprint([evidence[0], evidence[2], evidence[3]]), fingerprint, 'a derivative adds nothing to the set fingerprint');
  assert.notEqual(evidenceSetFingerprint([evidence[0]]), fingerprint, 'an independent source changes it');
  assert.equal(classifyCorroboration({ knownGroups: new Set([evidence[0].dependence_group]), dependenceGroup: evidence[1].dependence_group }), 'repeated');
  assert.equal(classifyCorroboration({ knownGroups: new Set([evidence[0].dependence_group]), dependenceGroup: evidence[2].dependence_group }), 'independent');
});

test('generations: claim_generation is a positive integer that only advances; a decision digests the generations it used', () => {
  assert.equal(nextClaimGeneration(1), 2);
  assert.throws(() => nextClaimGeneration(0), /not a claim generation/);
  assert.match(claimGenerationsDigest({ 'mem-a': 1, 'mem-b': 3 }), /^clgen-[0-9a-f]{64}$/);
  assert.equal(claimGenerationsDigest({ 'mem-b': 3, 'mem-a': 1 }), claimGenerationsDigest({ 'mem-a': 1, 'mem-b': 3 }), 'key order does not matter');
  assert.throws(() => claimGenerationsDigest({ 'mem-a': 'x' }), /non-generation/);
  assert.ok(validateMemoryRecord(validV2Record({ claim_generation: 0 })).some((e) => /claim_generation/.test(e)));
});

test('scoped candidate identity: deterministic, opaque, and DIFFERENT across legal entities for the same learning (the S08 identity substrate)', () => {
  const args = { tenantId: 'firm-1', legalEntityId: 'client-a', subjectClass: 'merchant_category', applicability: { jurisdiction: 'GB' }, normalizedValue: { pattern: 'acme', account: '6400' }, evidenceFingerprint: 'evset-x' };
  const a = buildScopedCandidateIdentity(args);
  assert.match(a, /^memcand2-[0-9a-f]{64}$/);
  assert.equal(a, buildScopedCandidateIdentity({ ...args }));
  assert.notEqual(a, buildScopedCandidateIdentity({ ...args, legalEntityId: 'client-b' }), 'the legal entity is part of the identity');
  assert.notEqual(a, buildScopedCandidateIdentity({ ...args, applicability: { jurisdiction: 'FI' } }));
  assert.equal(a, buildScopedCandidateIdentity({ ...args, applicability: { jurisdiction: { kind: 'value', value: 'GB' } } }), 'normalized applicability');
  assert.throws(() => buildScopedCandidateIdentity({ ...args, legalEntityId: '' }), /requires legalEntityId/);
});

test('v2 hostile set: a fingerprint that does not match the evidence, a stale-looking generation, an invented validation confidence are refused', () => {
  const forged = { ...validV2Record(), evidence_fingerprint: 'evset-forged' };
  assert.ok(validateMemoryRecord(forged).some((e) => /evidence_fingerprint: does not match/.test(e)));
  assert.ok(validateMemoryRecord(validV2Record({ validation_confidence: 'certain' })).some((e) => /validation_confidence/.test(e)));
  assert.ok(validateMemoryRecord(validV2Record({ effective_from: '2026-09-01', effective_to: '2026-01-01' })).some((e) => /effective_from must precede/.test(e)));
  assert.ok(validateMemoryRecord({ ...validV2Record(), applicability: { jurisdiction: { kind: 'any' } } }).some((e) => /declared explicitly/.test(e)), 'partial applicability is refused, never filled with wildcards');
});
