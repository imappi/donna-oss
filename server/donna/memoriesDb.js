// Donna — BizOS Slice 2b: the governed writers over the `memories` store
// (design-donna-bizos-slice-2-memory-v2.md §6 + §8, directionally approved with
// pinned gates; migration 085).
//
// These are the named executors the memory capability pack (Slice 2a) registered
// DARK: saveMemory (memory.remember.v1), supersedeMemory (memory.correct.v1 /
// memory.supersede.v1), dismissMemory (memory.dismiss.v1), eraseUserMemories
// (memory.erase.v1), plus the named execution verifiers. Nothing routes here yet —
// the writers exist so the pack's contracts resolve and the discipline is testable
// before any live use.
//
// The load-bearing rules (each machine-checked by memoriesDb.test.js):
//   - DARK BEHIND MEMORY_MODEL_V2 (config-plane flag, both duals envFallback
//     () => false — never an env pair). Every writer refuses `flag_off` unless a
//     DB stage row acts for the tenant/client; CLIENT_CONFIG_FORCE_DISABLE kills
//     it fleet-wide. Verifiers and the lifecycle purge are NOT gated — verifying
//     and lifecycle death are invariants, not rollout behaviour.
//   - ATOMIC AUDIT + MUTATION: one transaction, both or neither (amendment 15 —
//     audit-as-precondition as same-transaction commit; the mint-gap lesson).
//     Writers own begin/commit/rollback by default; a caller already inside a
//     transaction passes manageTransaction: false and owns the boundary.
//   - PREFLIGHT IS LIVE: validateMemoryRecord gates every write (the pack's
//     preflight contract); a refused record produces NO row and NO audit event.
//   - NATURAL-KEY IDEMPOTENCY (§3): an identical re-assertion of the active slot
//     appends evidence (last_confirmed_at + an audit row), never a duplicate row
//     and never a content change under a receipted memory_id. Different content
//     against an active slot is a CONFLICT directing to correct/supersede — no
//     silent overwrite. An erased slot is never re-minted (anti-resurrection);
//     a dismissed slot is a human "no" that a re-assertion does not override.
//   - SCRUB-IN-PLACE ERASURE (§6): one operation — content columns → null,
//     record_state → erased, erased_at → now(). The id/key/lifecycle metadata
//     remain (the slot stays occupied; receipts stay resolvable). No tombstone
//     row, no hard delete in the general path.
//   - AUDIT METADATA IS CONTENT-FREE: ids, hashes, classes, states — never
//     source_text / structured_value / observed_alias (§10 invariant 3 applies
//     to ordinary logs from birth).
//   - MEMORY_KEY_HMAC_SECRET is the env-legitimate secret behind buildMemoryKey.
//     Absent secret ⇒ a key cannot be minted ⇒ the write refuses (fail closed).
//
// Timestamps are normalized to UTC-millisecond ISO at draft completion, BEFORE
// hashing — so a contract record rebuilt from a timestamptz round trip
// (Date.toISOString()) reproduces the exact content_hash. Without this, a
// supersede recomputing the prior hash from the row would drift on timezone
// representation.
//
// Lifecycle death vs erasure: eraseUserMemories is the governed user-facing
// operation (scrub, slot kept). purgeMemoriesForDeletedLegalEntity is the
// lifecycle-death path (hard delete, in the client-delete transaction — the
// firm_facts clean-slate posture: the entity is gone, the slot is freed).

import {
  MEMORY_SCHEMA_VERSION,
  MEMORY_SCHEMA_VERSION_V2,
  MEMORY_SCHEMA_VERSION_CURRENT,
  MEMORY_SCHEMA_VERSIONS,
  LIFECYCLE_OWNER_TYPES,
  MEMORY_RELATION_TYPES,
  INITIAL_CLAIM_GENERATION,
  classifyPredicate,
  buildMemoryKey,
  newMemoryId,
  memoryContentHash,
  nextMemoryRevision,
  validateMemoryRecord,
  completeMemoryRecordV2Fields,
  evidenceFromSourceRefs,
  classifyCorroboration
} from './memoryModel.js';
import { readClientConfigSnapshot, clientFlagActs, clientFlagObserves, clientFlagPosture, FLAG_POSTURES } from './clientConfig.js';
import { toIsoDay } from './dates.js';

export const MEMORY_MODEL_V2_FLAG_KEY = 'MEMORY_MODEL_V2';

// Per-client act gate. envFallback is () => false BY DESIGN (born on the config
// control plane, fully dormant until a DB stage row exists).
export const memoryModelV2Acts = ({ snapshot = null, env = process.env } = {}) =>
  clientFlagActs({ flagKey: MEMORY_MODEL_V2_FLAG_KEY, snapshot, envFallback: () => false, env });

// ── The plane key's postures (DMEM-R1 W2) ────────────────────────────────────
// off / shadow / canary / authoritative, and the explicit KILL through
// CLIENT_CONFIG_FORCE_DISABLE — ONE resolver (clientFlagPosture is a projection
// of the same row + kill switch clientFlagActs / clientFlagObserves read; audit
// §4.3 fence, doctrine INV-26: never a second resolver). `authoritative` is the
// `auto` stage, which the plane refuses to persist for this key until W6A's
// cutover (AUTO_FORBIDDEN_FLAGS) — so on this tree the posture can only ever be
// kill / off / shadow / canary through the audited writer.
export const MEMORY_MODEL_V2_POSTURES = FLAG_POSTURES;
export const memoryModelV2Posture = ({ snapshot = null, env = process.env } = {}) =>
  clientFlagPosture({ flagKey: MEMORY_MODEL_V2_FLAG_KEY, snapshot, envFallback: () => false, env });
export const memoryModelV2Observes = ({ snapshot = null, env = process.env } = {}) =>
  clientFlagObserves({ flagKey: MEMORY_MODEL_V2_FLAG_KEY, snapshot, envFallback: () => false, env });

// Read the posture for one (firm, client) through the plane's own snapshot reader
// — the manifest's dark memory workers call this before doing nothing.
export const readMemoryModelV2PostureForClient = async ({ client, firmId, clientId = null, env = process.env } = {}) => {
  if (!client || !firmId) return 'off';
  const snapshot = await readClientConfigSnapshot(client, { firmId, clientId });
  return memoryModelV2Posture({ snapshot, env });
};

// Migration 147's delivery-state law is armed per transaction through this GUC
// (the 133 pattern: set_config(..., true) — transaction-local, never leaks). The
// law itself lives in the database; this is the ONE place that arms it, and it
// arms it only when the plane acts for the client — so a kill / off / shadow
// posture leaves every ask writer byte-identical. W6A's cutover deletes the GUC
// test and this helper together.
export const DELIVERY_STATE_CONSTRAINTS_GUC = 'donna.delivery_state_constraints';
export const armDeliveryStateConstraints = async (client, { snapshot = null, env = process.env } = {}) => {
  if (!client) return { armed: false, posture: 'off' };
  const posture = memoryModelV2Posture({ snapshot, env });
  if (posture !== 'canary' && posture !== 'authoritative') return { armed: false, posture };
  await client.query('select set_config($1, $2, true)', [DELIVERY_STATE_CONSTRAINTS_GUC, 'enforce']);
  return { armed: true, posture };
};

// Transaction-safe presence probe (the memoryCandidatesTablePresent posture): a
// pre-085 deploy degrades to a clean skip, never a 42P01 abort.
export const memoriesTablePresent = async (client) => {
  if (!client) return false;
  const present = await client.query("select to_regclass('public.memories') as present");
  return Boolean(present.rows[0]?.present);
};

// ── Internal plumbing ─────────────────────────────────────────────────────────

const JSONB_FIELDS = new Set([
  'structured_value', 'source_refs', 'activation_confirmation', 'creation_provenance',
  // memory.v2 (migrations 142 / 146)
  'applicability', 'raw_value', 'normalized_value', 'confirmation_history', 'consuming_decision_refs'
]);

// Insert column order — the migration-085 row, identity → content → provenance →
// time → confidence/sensitivity → state.
const MEMORY_ROW_COLUMNS = Object.freeze([
  'memory_id', 'memory_key', 'revision', 'content_hash', 'schema_version',
  'tenant_id', 'scope_type', 'scope_id', 'lifecycle_owner_type', 'lifecycle_owner_id',
  'owner_user_id', 'owner_organisation_id', 'owner_client_id', 'owner_ephemeral_ref',
  'subject_type', 'subject_id', 'observed_alias',
  'kind', 'predicate', 'predicate_class', 'structured_value', 'source_text', 'source_refs',
  'asserted_by_principal_id', 'assertion_origin', 'transport_actor',
  'extraction_model_id', 'extraction_prompt_version', 'validator_version', 'activation_confirmation',
  'observed_at', 'recorded_at', 'valid_from', 'valid_until',
  'retention_policy_id', 'retain_until', 'review_after', 'last_confirmed_at',
  'assertion_confidence', 'truth_confidence', 'confidentiality', 'personal_data_class',
  'record_state', 'epistemic_state', 'record_version', 'supersedes_memory_id',
  'erased_at', 'creation_provenance',
  // memory.v2 (migrations 142 / 146) — null on a v1 row, required on a v2 row.
  'applicability', 'applicability_version', 'effective_from', 'effective_to',
  'evidence_fingerprint', 'claim_generation',
  'source_object_type', 'source_object_id', 'source_object_version', 'source_excerpt',
  'raw_value', 'normalized_value', 'validation_confidence', 'confirmation_history',
  'supersession_reason', 'invalidation_reason', 'consuming_decision_refs', 'promotion_receipt_id'
]);

// The v2-only storage columns: absent from a v1 record's closed envelope when a
// row is rebuilt (rowToMemoryRecord), so a v1 row validates exactly as before.
const V2_ONLY_COLUMNS = new Set([
  'applicability', 'applicability_version', 'effective_from', 'effective_to',
  'evidence_fingerprint', 'claim_generation',
  'source_object_type', 'source_object_id', 'source_object_version', 'source_excerpt',
  'raw_value', 'normalized_value', 'validation_confidence', 'confirmation_history',
  'supersession_reason', 'invalidation_reason', 'consuming_decision_refs', 'promotion_receipt_id'
]);
const DATE_COLUMNS = new Set(['effective_from', 'effective_to']);

// Exactly one typed lifecycle root, matching the owner type (the migration CHECK).
const lifecycleRootColumns = (record) => ({
  owner_user_id: record.lifecycle_owner_type === 'user' ? record.lifecycle_owner_id : null,
  owner_organisation_id: record.lifecycle_owner_type === 'organisation' ? record.lifecycle_owner_id : null,
  owner_client_id: record.lifecycle_owner_type === 'legal_entity' ? record.lifecycle_owner_id : null,
  owner_ephemeral_ref: record.lifecycle_owner_type === 'ephemeral' ? record.lifecycle_owner_id : null
});

// The config-plane client for the flag read: a legal_entity-rooted memory is a
// client behaviour; everything else resolves at the firm default.
const flagClientIdFor = (lifecycleOwnerType, lifecycleOwnerId) =>
  lifecycleOwnerType === 'legal_entity' ? lifecycleOwnerId : null;

const resolveActs = async (client, { tenantId, clientId, configSnapshot, env }) => {
  const snapshot = configSnapshot
    ?? await readClientConfigSnapshot(client, { firmId: tenantId, clientId });
  return memoryModelV2Acts({ snapshot, env });
};

const runAtomic = async (client, manageTransaction, fn) => {
  if (!manageTransaction) return fn();
  await client.query('begin');
  try {
    const out = await fn();
    await client.query('commit');
    return out;
  } catch (err) {
    await client.query('rollback');
    throw err;
  }
};

// The persisted-write result the capability receipt pins (the pack's closed
// output schema: exactly these five fields).
const writeResult = (r) => ({
  memory_key: r.memory_key,
  memory_id: r.memory_id,
  revision: Number(r.revision),
  content_hash: r.content_hash,
  record_state: r.record_state
});

const refusal = (errors) => ({ status: 'refused', errors: [].concat(errors), write: null });

// Content-free audit, same transaction as the mutation it records.
const auditMemoryEvent = async (client, { tenantId, clientId = null, actor = {}, action, resourceId, metadata = {} }) => {
  await client.query(
    `insert into audit_events (firm_id, client_id, actor_type, actor_id, action, resource_type, resource_id, metadata)
     values ($1, $2, $3, $4, $5, 'memory', $6, $7::jsonb)`,
    [tenantId, clientId, actor.type || 'system', actor.id || null, action, resourceId, JSON.stringify(metadata)]
  );
};

const insertMemoryRow = async (client, record) => {
  const row = { ...record, ...lifecycleRootColumns(record) };
  const values = MEMORY_ROW_COLUMNS.map((col) => {
    const v = row[col] ?? null;
    return JSONB_FIELDS.has(col) && v !== null ? JSON.stringify(v) : v;
  });
  const placeholders = MEMORY_ROW_COLUMNS.map((col, i) => (JSONB_FIELDS.has(col) ? `$${i + 1}::jsonb` : `$${i + 1}`));
  await client.query(
    `insert into memories (${MEMORY_ROW_COLUMNS.join(', ')})
     values (${placeholders.join(', ')})`,
    values
  );
};

// Timestamptz-bound fields, normalized to UTC-ms ISO so DB round trips reproduce
// the exact strings that were hashed (see header).
const TIMESTAMP_FIELDS = Object.freeze([
  'observed_at', 'recorded_at', 'valid_from', 'valid_until',
  'retain_until', 'review_after', 'last_confirmed_at', 'erased_at'
]);

const toUtcIso = (value) => {
  if (value === null || value === undefined) return null;
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) throw new Error('not a valid timestamp');
  return d.toISOString();
};

const normalizeTimestamps = (record, errors) => {
  for (const field of TIMESTAMP_FIELDS) {
    if (record[field] === undefined) continue;
    try {
      record[field] = toUtcIso(record[field]);
    } catch {
      errors.push(`${field}: not a valid timestamp`);
    }
  }
};

// Rebuild the contract-shaped record from a memories row (Date → UTC-ms ISO,
// identical to the write-side normalization, so recomputed hashes match).
export const rowToMemoryRecord = (row = {}) => {
  const record = {};
  const isV2 = row.schema_version === MEMORY_SCHEMA_VERSION_V2;
  for (const col of MEMORY_ROW_COLUMNS) {
    if (col.startsWith('owner_')) continue; // typed roots are storage, not contract
    if (!isV2 && V2_ONLY_COLUMNS.has(col)) continue; // a v1 row keeps its v1 envelope
    const v = row[col];
    if (DATE_COLUMNS.has(col)) record[col] = v === null || v === undefined ? null : toIsoDay(v);
    else record[col] = v instanceof Date ? v.toISOString() : (v ?? null);
  }
  record.revision = Number(record.revision);
  record.record_version = Number(record.record_version);
  if (isV2) {
    record.claim_generation = Number(record.claim_generation ?? INITIAL_CLAIM_GENERATION);
    record.confirmation_history = Array.isArray(record.confirmation_history) ? record.confirmation_history : [];
    record.consuming_decision_refs = Array.isArray(record.consuming_decision_refs) ? record.consuming_decision_refs : [];
  }
  // The contract's closed envelope: optional fields stay, but drop storage nulls
  // that the validator treats as "absent" anyway is unnecessary — nulls are fine.
  return record;
};

// ── Draft completion (exported: the promote gate + tests build drafts here) ──
//
// Completes a memory.v1 draft into a validatable revision-1 record: derives
// predicate_class (never declared freely), normalizes timestamps, mints
// memory_id, and mints memory_key via the keyed HMAC when absent (refusing,
// fail-closed, when MEMORY_KEY_HMAC_SECRET is not configured). Returns
// { record, errors } — errors here are completion refusals, before the
// validator runs.
export const completeMemoryRecordDraft = ({ record = {}, env = process.env, now = new Date() } = {}) => {
  const errors = [];
  // The version is a FIELD: a draft that declares one keeps it; an undeclared
  // draft is minted under the current contract (memory.v2 from DMEM-R1 W2).
  const completed = { schema_version: MEMORY_SCHEMA_VERSION_CURRENT, ...record };
  if (!MEMORY_SCHEMA_VERSIONS.includes(completed.schema_version)) {
    errors.push(`schema_version "${completed.schema_version}" is not a memory contract version (${MEMORY_SCHEMA_VERSIONS.join(', ')})`);
  }

  completed.predicate_class = classifyPredicate(completed.predicate);
  completed.record_state = completed.record_state ?? 'active';
  completed.epistemic_state = completed.epistemic_state ?? 'asserted';
  completed.truth_confidence = completed.truth_confidence ?? null;
  completed.revision = completed.revision ?? 1;
  completed.record_version = completed.record_version ?? 1;
  completed.recorded_at = completed.recorded_at ?? now.toISOString();
  completed.creation_provenance = completed.creation_provenance ?? {};
  normalizeTimestamps(completed, errors);

  if (!completed.memory_id) completed.memory_id = newMemoryId();
  if (!completed.memory_key) {
    const hmacSecret = env?.MEMORY_KEY_HMAC_SECRET;
    if (!hmacSecret) {
      errors.push('memory_key: MEMORY_KEY_HMAC_SECRET is not configured — a logical slot cannot be minted (fail closed)');
    } else {
      try {
        completed.memory_key = buildMemoryKey({
          tenantId: completed.tenant_id,
          lifecycleOwnerType: completed.lifecycle_owner_type,
          lifecycleOwnerId: completed.lifecycle_owner_id,
          scopeType: completed.scope_type,
          scopeId: completed.scope_id,
          subjectType: completed.subject_type,
          subjectId: completed.subject_id,
          predicate: completed.predicate,
          hmacSecret
        });
      } catch (err) {
        errors.push(`memory_key: ${err.message}`);
      }
    }
  }
  if (completed.schema_version === MEMORY_SCHEMA_VERSION_V2) {
    Object.assign(completed, completeMemoryRecordV2Fields(completed));
  }
  completed.content_hash = memoryContentHash(completed);
  return { record: completed, errors };
};

// ── Evidence links (memory_evidence_links, migration 142; INV-08) ─────────────
// The evidence set a record carries (its `evidence` write-time field, or the set
// derived from its source_refs for a v1 record) becomes link rows. The
// corroboration class is decided HERE from the claim's known dependence groups:
// 'independent' when the group is new for the claim, 'repeated' otherwise.
const evidenceSetOf = (record) =>
  (Array.isArray(record?.evidence) && record.evidence.length ? record.evidence : evidenceFromSourceRefs(record?.source_refs));

export const listMemoryEvidenceLinks = async ({ client, tenantId, memoryId } = {}) => {
  if (!client || !tenantId || !memoryId) return [];
  const res = await client.query(
    `select evidence_id, dependence_group, corroboration_class, evidence_kind, source_object_type, source_object_id, source_object_version, observed_at, recorded_at
       from memory_evidence_links where tenant_id = $1 and memory_id = $2 order by id`,
    [tenantId, memoryId]
  );
  return res.rows || [];
};

// Insert the links that are new for the claim; returns what was added and how it
// was classified. Idempotent on (memory_id, evidence_id).
const insertEvidenceLinks = async (client, { tenantId, memoryId, evidence = [], actor = {} }) => {
  const existing = await listMemoryEvidenceLinks({ client, tenantId, memoryId });
  const knownIds = new Set(existing.map((l) => l.evidence_id));
  const knownGroups = new Set(existing.map((l) => l.dependence_group));
  const added = [];
  for (const entry of evidence) {
    if (!entry?.evidence_id || knownIds.has(entry.evidence_id)) continue;
    const corroborationClass = classifyCorroboration({ knownGroups, dependenceGroup: entry.dependence_group });
    const inserted = await client.query(
      `insert into memory_evidence_links
         (tenant_id, memory_id, evidence_id, evidence_kind, source_object_type, source_object_id, source_object_version,
          dependence_group, corroboration_class, observed_at, recorded_by_principal_id)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       on conflict (memory_id, evidence_id) do nothing
       returning evidence_id`,
      [tenantId, memoryId, entry.evidence_id, entry.evidence_kind, entry.source_object_type ?? null, entry.source_object_id ?? null,
        entry.source_object_version ?? null, entry.dependence_group, corroborationClass, entry.observed_at ?? null, actor.id || null]
    );
    if (!inserted.rows.length) continue;
    knownIds.add(entry.evidence_id);
    knownGroups.add(entry.dependence_group);
    added.push({ evidence_id: entry.evidence_id, dependence_group: entry.dependence_group, corroboration_class: corroborationClass });
  }
  return { added, independent: added.filter((a) => a.corroboration_class === 'independent').length };
};

// ── saveMemory — memory.remember.v1 ──────────────────────────────────────────
export const saveMemory = async ({
  client, tenantId, record, actor = {}, dryRun = false,
  configSnapshot = null, env = process.env, manageTransaction = true
} = {}) => {
  if (!client || !tenantId || !record || typeof record !== 'object') {
    return refusal('saveMemory requires client, tenantId, record');
  }
  if (!(await memoriesTablePresent(client))) return { status: 'skipped_table_absent', write: null };
  if (record.tenant_id && record.tenant_id !== tenantId) {
    return refusal(`tenant_id "${record.tenant_id}" does not match the authenticated tenant — cross-tenant writes are refused`);
  }

  const { record: completed, errors: completionErrors } = completeMemoryRecordDraft({
    record: { ...record, tenant_id: tenantId }, env
  });

  const acts = await resolveActs(client, {
    tenantId,
    clientId: flagClientIdFor(completed.lifecycle_owner_type, completed.lifecycle_owner_id),
    configSnapshot, env
  });
  if (!acts) return { status: 'flag_off', write: null };

  if (completionErrors.length) return refusal(completionErrors);
  const errors = validateMemoryRecord(completed);
  if (errors.length) return refusal(errors);

  return runAtomic(client, manageTransaction, async () => {
    // The slot head decides the natural-key path. Locked so a concurrent write
    // serializes; the (memory_key, revision) unique index is the backstop.
    const head = await client.query(
      `select memory_id, memory_key, revision, content_hash, record_state
         from memories
        where memory_key = $1 and tenant_id = $2
        order by revision desc
        limit 1
        for update`,
      [completed.memory_key, tenantId]
    );
    const h = head.rows[0];
    if (h) {
      if (h.record_state === 'erased') {
        return refusal('memory_key slot is erased — an erased slot is never silently re-minted (§6 anti-resurrection)');
      }
      if (h.record_state === 'dismissed') {
        return refusal('memory_key slot is dismissed — a human "no" is not overridden by a re-assertion');
      }
      if (h.record_state === 'active' && h.content_hash === completed.content_hash) {
        // Identical re-assertion: append EVIDENCE, never alter receipted content —
        // and (DMEM-R1 W2, INV-08) only INDEPENDENT evidence is confirmation
        // freshness. The same source again (a re-OCR, a paraphrase, a replayed
        // ref) links as 'repeated' and leaves last_confirmed_at untouched; a new
        // dependence group links as 'independent' and refreshes it.
        if (dryRun) return { status: 'dry_run', effect: 'reassert', write: writeResult(h) };
        const links = await insertEvidenceLinks(client, { tenantId, memoryId: h.memory_id, evidence: evidenceSetOf(completed), actor });
        const corroboration = links.independent > 0 ? 'independent' : 'repeated';
        if (links.independent > 0) {
          await client.query(
            `update memories set last_confirmed_at = now(), updated_at = now() where memory_id = $1`,
            [h.memory_id]
          );
        }
        await auditMemoryEvent(client, {
          tenantId,
          clientId: flagClientIdFor(completed.lifecycle_owner_type, completed.lifecycle_owner_id),
          actor,
          action: 'memory.record_reasserted',
          resourceId: h.memory_id,
          metadata: {
            memory_key: h.memory_key, revision: Number(h.revision), content_hash: h.content_hash,
            assertion_origin: completed.assertion_origin, predicate: completed.predicate,
            corroboration, evidence_added: links.added.length, independent_evidence_added: links.independent
          }
        });
        return { status: 'reasserted', corroboration, evidence_added: links.added.length, write: writeResult(h) };
      }
      if (h.record_state === 'active') {
        return { status: 'conflict', errors: ['memory_key slot holds different active content — use memory.correct/memory.supersede, never a silent overwrite'], write: null };
      }
      // A superseded head without an active successor is a broken slot invariant.
      return refusal(`memory_key head is '${h.record_state}' without an active successor — inconsistent slot, refusing to write`);
    }

    if (dryRun) return { status: 'dry_run', effect: 'persist', write: writeResult(completed) };
    await insertMemoryRow(client, completed);
    const links = await insertEvidenceLinks(client, { tenantId, memoryId: completed.memory_id, evidence: evidenceSetOf(completed), actor });
    await auditMemoryEvent(client, {
      tenantId,
      clientId: flagClientIdFor(completed.lifecycle_owner_type, completed.lifecycle_owner_id),
      actor,
      action: 'memory.record_saved',
      resourceId: completed.memory_id,
      metadata: {
        memory_key: completed.memory_key, revision: completed.revision,
        content_hash: completed.content_hash, kind: completed.kind,
        predicate: completed.predicate, predicate_class: completed.predicate_class,
        assertion_origin: completed.assertion_origin,
        scope_type: completed.scope_type,
        lifecycle_owner_type: completed.lifecycle_owner_type,
        lifecycle_owner_id: completed.lifecycle_owner_id,
        schema_version: completed.schema_version,
        evidence_fingerprint: completed.evidence_fingerprint ?? null,
        evidence_linked: links.added.length, independent_evidence: links.independent
      }
    });
    return { status: 'persisted', evidence_linked: links.added.length, write: writeResult(completed) };
  });
};

// ── supersedeMemory — memory.correct.v1 / memory.supersede.v1 ────────────────
//
// A changed value in an occupied slot: mints the NEXT immutable version
// (new memory_id, revision+1), flips the prior to `superseded`, records the
// `supersedes` edge — all one transaction. The slot's identity fields (tenant,
// scope, lifecycle, subject, predicate) are FROZEN: changing them changes the
// memory_key, which is a different slot — a new saveMemory, not a supersede.
const SUPERSEDE_FROZEN_FIELDS = Object.freeze([
  'schema_version', 'memory_key', 'memory_id', 'revision', 'content_hash',
  'tenant_id', 'scope_type', 'scope_id', 'lifecycle_owner_type', 'lifecycle_owner_id',
  'subject_type', 'subject_id', 'predicate', 'predicate_class',
  'record_state', 'supersedes_memory_id', 'erased_at',
  // memory.v2: derived, never asserted by a caller.
  'applicability_version', 'evidence_fingerprint', 'claim_generation'
]);

export const supersedeMemory = async ({
  client, tenantId, priorMemoryId, changes = {}, actor = {}, dryRun = false,
  configSnapshot = null, env = process.env, manageTransaction = true
} = {}) => {
  if (!client || !tenantId || !priorMemoryId) {
    return refusal('supersedeMemory requires client, tenantId, priorMemoryId');
  }
  if (!(await memoriesTablePresent(client))) return { status: 'skipped_table_absent', write: null };
  const frozen = Object.keys(changes || {}).filter((k) => SUPERSEDE_FROZEN_FIELDS.includes(k));
  if (frozen.length) {
    return refusal(`changes may not touch slot identity/state fields: ${frozen.join(', ')} (a different slot is a new saveMemory)`);
  }

  return runAtomic(client, manageTransaction, async () => {
    const res = await client.query(
      `select * from memories where memory_id = $1 and tenant_id = $2 limit 1 for update`,
      [priorMemoryId, tenantId]
    );
    const priorRow = res.rows[0];
    if (!priorRow) return { status: 'not_found', write: null };

    const acts = await resolveActs(client, {
      tenantId,
      clientId: flagClientIdFor(priorRow.lifecycle_owner_type, priorRow.lifecycle_owner_id),
      configSnapshot, env
    });
    if (!acts) return { status: 'flag_off', write: null };

    if (priorRow.record_state !== 'active') {
      return refusal(`only the active head may be superseded — record_state is '${priorRow.record_state}'`);
    }

    const prior = rowToMemoryRecord(priorRow);
    const normalizedChanges = { ...changes };
    const changeErrors = [];
    normalizeTimestamps(normalizedChanges, changeErrors);
    if (changeErrors.length) return refusal(changeErrors);

    let next = nextMemoryRevision(prior, normalizedChanges);
    next.recorded_at = new Date().toISOString();
    // A new version is a fresh assertion: it does not inherit the prior's
    // disputed/contradicted standing unless the caller states it.
    if (!('epistemic_state' in normalizedChanges)) next.epistemic_state = 'asserted';
    if (next.schema_version === MEMORY_SCHEMA_VERSION_V2) {
      // A successor is a fresh revision: its own evidence set (the changes', or
      // derived from its source_refs), its own generation, its own histories.
      next.evidence = Array.isArray(normalizedChanges.evidence) && normalizedChanges.evidence.length
        ? normalizedChanges.evidence : evidenceFromSourceRefs(next.source_refs);
      next.claim_generation = INITIAL_CLAIM_GENERATION;
      // The source-object provenance follows the successor's OWN evidence (refilled
      // by completeMemoryRecordV2Fields when it is a single source), never the prior's.
      for (const field of ['source_object_type', 'source_object_id', 'source_object_version']) {
        if (!(field in normalizedChanges)) next[field] = null;
      }
      if (!('confirmation_history' in normalizedChanges)) next.confirmation_history = [];
      if (!('consuming_decision_refs' in normalizedChanges)) next.consuming_decision_refs = [];
      if (!('promotion_receipt_id' in normalizedChanges)) next.promotion_receipt_id = null;
      next = completeMemoryRecordV2Fields(next);
    }
    next.content_hash = memoryContentHash(next);
    const errors = validateMemoryRecord(next);
    if (errors.length) return refusal(errors);

    if (dryRun) return { status: 'dry_run', effect: 'supersede', write: writeResult(next) };

    // Flip the prior BEFORE inserting the new head: migration 085's
    // memories_one_active_per_key partial unique index is IMMEDIATE, so two
    // active rows in one slot — even transiently inside this transaction —
    // are a constraint violation. Flipping first also lets the rowCount
    // guard act as the stale-head refusal (nothing has been written yet,
    // so refusing here commits nothing).
    const flipped = await client.query(
      `update memories set record_state = 'superseded', updated_at = now()
        where memory_id = $1 and record_state = 'active'`,
      [priorMemoryId]
    );
    if (flipped.rowCount !== 1) {
      return refusal(`prior ${priorMemoryId} is no longer the active head (superseded concurrently) — re-read the slot and retry against the current head`);
    }
    await insertMemoryRow(client, next);
    const links = await insertEvidenceLinks(client, { tenantId, memoryId: next.memory_id, evidence: evidenceSetOf(next), actor });
    await client.query(
      `insert into memory_relations (tenant_id, source_memory_id, relation, target_memory_id, created_by)
       values ($1, $2, 'supersedes', $3, $4)
       on conflict do nothing`,
      [tenantId, next.memory_id, priorMemoryId, actor.id || null]
    );
    await auditMemoryEvent(client, {
      tenantId,
      clientId: flagClientIdFor(next.lifecycle_owner_type, next.lifecycle_owner_id),
      actor,
      action: 'memory.record_superseded',
      resourceId: next.memory_id,
      metadata: {
        memory_key: next.memory_key,
        prior_memory_id: priorMemoryId, prior_revision: prior.revision, prior_content_hash: prior.content_hash,
        revision: next.revision, content_hash: next.content_hash,
        changed_fields: Object.keys(normalizedChanges),
        schema_version: next.schema_version, evidence_linked: links.added.length
      }
    });
    return { status: 'superseded', evidence_linked: links.added.length, write: writeResult(next) };
  });
};

// ── dismissMemory — memory.dismiss.v1 ────────────────────────────────────────
// The governance "no": the record stays (audit trail of a human decision), its
// slot stays occupied, and a re-assertion does not resurrect it.
export const dismissMemory = async ({
  client, tenantId, memoryId, reason = null, actor = {}, dryRun = false,
  configSnapshot = null, env = process.env, manageTransaction = true
} = {}) => {
  if (!client || !tenantId || !memoryId) {
    return refusal('dismissMemory requires client, tenantId, memoryId');
  }
  if (!(await memoriesTablePresent(client))) return { status: 'skipped_table_absent', write: null };

  return runAtomic(client, manageTransaction, async () => {
    const res = await client.query(
      `select memory_id, memory_key, revision, content_hash, record_state,
              lifecycle_owner_type, lifecycle_owner_id
         from memories where memory_id = $1 and tenant_id = $2 limit 1 for update`,
      [memoryId, tenantId]
    );
    const row = res.rows[0];
    if (!row) return { status: 'not_found', write: null };

    const acts = await resolveActs(client, {
      tenantId,
      clientId: flagClientIdFor(row.lifecycle_owner_type, row.lifecycle_owner_id),
      configSnapshot, env
    });
    if (!acts) return { status: 'flag_off', write: null };

    if (row.record_state === 'dismissed') return { status: 'already_dismissed', write: writeResult(row) };
    if (row.record_state !== 'active') {
      return refusal(`only an active record may be dismissed — record_state is '${row.record_state}'`);
    }
    if (dryRun) return { status: 'dry_run', effect: 'dismiss', write: { ...writeResult(row), record_state: 'dismissed' } };

    await client.query(
      `update memories set record_state = 'dismissed', updated_at = now() where memory_id = $1`,
      [memoryId]
    );
    await auditMemoryEvent(client, {
      tenantId,
      clientId: flagClientIdFor(row.lifecycle_owner_type, row.lifecycle_owner_id),
      actor,
      action: 'memory.record_dismissed',
      resourceId: memoryId,
      metadata: { memory_key: row.memory_key, revision: Number(row.revision), reason }
    });
    return { status: 'dismissed', write: { ...writeResult(row), record_state: 'dismissed' } };
  });
};

// ── eraseUserMemories — memory.erase.v1 ──────────────────────────────────────
//
// Scrub-in-place across a lifecycle root (optionally narrowed to memory_ids):
// ONE operation — content → null, record_state → erased, erased_at → now().
// Ids/keys/lifecycle metadata remain (anti-resurrection + receipt continuity).
// Idempotent: already-erased rows are skipped, requested ids that matched
// nothing are reported, never guessed at. One audit row records the batch
// (ids + count — no content). The registered output schema pins the per-record
// write result; the batch returns one such result per erased record.
export const eraseUserMemories = async ({
  client, tenantId, lifecycleOwnerType, lifecycleOwnerId, memoryIds = null,
  reason = null, actor = {}, dryRun = false,
  configSnapshot = null, env = process.env, manageTransaction = true
} = {}) => {
  if (!client || !tenantId || !lifecycleOwnerId || !LIFECYCLE_OWNER_TYPES.includes(lifecycleOwnerType)) {
    return refusal('eraseUserMemories requires client, tenantId, a valid lifecycleOwnerType, lifecycleOwnerId');
  }
  if (memoryIds !== null && (!Array.isArray(memoryIds) || memoryIds.length === 0)) {
    return refusal('memoryIds must be null (the whole lifecycle root) or a non-empty array');
  }
  if (!(await memoriesTablePresent(client))) return { status: 'skipped_table_absent', writes: [] };

  const acts = await resolveActs(client, {
    tenantId,
    clientId: flagClientIdFor(lifecycleOwnerType, lifecycleOwnerId),
    configSnapshot, env
  });
  if (!acts) return { status: 'flag_off', writes: [] };

  return runAtomic(client, manageTransaction, async () => {
    const params = [tenantId, lifecycleOwnerType, lifecycleOwnerId];
    let idFilter = '';
    if (memoryIds) {
      params.push(memoryIds);
      idFilter = ` and memory_id = any($${params.length})`;
    }
    if (dryRun) {
      const would = await client.query(
        `select memory_id, memory_key, revision, content_hash
           from memories
          where tenant_id = $1 and lifecycle_owner_type = $2 and lifecycle_owner_id = $3
            and record_state <> 'erased'${idFilter}`,
        params
      );
      return {
        status: 'dry_run', effect: 'erase',
        count: would.rows.length,
        writes: would.rows.map((r) => ({ ...writeResult(r), record_state: 'erased' }))
      };
    }
    const scrubbed = await client.query(
      `update memories
          set structured_value = null, source_text = null, source_refs = null,
              observed_alias = null, record_state = 'erased', erased_at = now(), updated_at = now()
        where tenant_id = $1 and lifecycle_owner_type = $2 and lifecycle_owner_id = $3
          and record_state <> 'erased'${idFilter}
        returning memory_id, memory_key, revision, content_hash, record_state`,
      params
    );
    const writes = scrubbed.rows.map(writeResult);
    const erasedIds = new Set(writes.map((w) => w.memory_id));
    const unmatchedIds = memoryIds ? memoryIds.filter((id) => !erasedIds.has(id)) : [];
    await auditMemoryEvent(client, {
      tenantId,
      clientId: flagClientIdFor(lifecycleOwnerType, lifecycleOwnerId),
      actor,
      action: 'memory.records_erased',
      resourceId: `${lifecycleOwnerType}:${lifecycleOwnerId}`,
      metadata: {
        lifecycle_owner_type: lifecycleOwnerType, lifecycle_owner_id: lifecycleOwnerId,
        count: writes.length, memory_ids: writes.map((w) => w.memory_id),
        unmatched_ids: unmatchedIds, reason
      }
    });
    return { status: 'erased', count: writes.length, writes, unmatched_ids: unmatchedIds };
  });
};

// ── linkMemoryRelation — the many-to-many edge writer (§4 amendment 7) ───────
// `contradicts` also flips BOTH records' epistemic_state to 'contradicted' (the
// state axis that governs the 2c use class) — a recorded contradiction that
// nothing reflects in epistemic_state would be a silent conflict.
export const linkMemoryRelation = async ({
  client, tenantId, sourceMemoryId, relation, targetMemoryId, actor = {},
  configSnapshot = null, env = process.env, manageTransaction = true
} = {}) => {
  if (!client || !tenantId || !sourceMemoryId || !targetMemoryId) {
    return refusal('linkMemoryRelation requires client, tenantId, sourceMemoryId, targetMemoryId');
  }
  if (!MEMORY_RELATION_TYPES.includes(relation)) return refusal(`relation "${relation}" is not in the memory.v1 vocabulary`);
  if (sourceMemoryId === targetMemoryId) return refusal('a record cannot relate to itself');
  if (!(await memoriesTablePresent(client))) return { status: 'skipped_table_absent' };

  return runAtomic(client, manageTransaction, async () => {
    const rows = await client.query(
      `select memory_id, lifecycle_owner_type, lifecycle_owner_id, record_state
         from memories where tenant_id = $1 and memory_id = any($2)`,
      [tenantId, [sourceMemoryId, targetMemoryId]]
    );
    if (rows.rows.length !== 2) return { status: 'not_found' };
    const source = rows.rows.find((r) => r.memory_id === sourceMemoryId);

    const acts = await resolveActs(client, {
      tenantId,
      clientId: flagClientIdFor(source.lifecycle_owner_type, source.lifecycle_owner_id),
      configSnapshot, env
    });
    if (!acts) return { status: 'flag_off' };

    const inserted = await client.query(
      `insert into memory_relations (tenant_id, source_memory_id, relation, target_memory_id, created_by)
       values ($1, $2, $3, $4, $5)
       on conflict do nothing
       returning source_memory_id`,
      [tenantId, sourceMemoryId, relation, targetMemoryId, actor.id || null]
    );
    if (!inserted.rows.length) return { status: 'already_linked' };
    if (relation === 'contradicts') {
      await client.query(
        `update memories set epistemic_state = 'contradicted', updated_at = now()
          where tenant_id = $1 and memory_id = any($2) and record_state <> 'erased'`,
        [tenantId, [sourceMemoryId, targetMemoryId]]
      );
    }
    await auditMemoryEvent(client, {
      tenantId,
      clientId: flagClientIdFor(source.lifecycle_owner_type, source.lifecycle_owner_id),
      actor,
      action: 'memory.relation_linked',
      resourceId: sourceMemoryId,
      metadata: { relation, target_memory_id: targetMemoryId }
    });
    return { status: 'linked', relation };
  });
};

// ── Execution verifiers (the pack's named verifiers; read-only, ungated) ─────

export const verifyMemoryRecordPersisted = async ({ client, tenantId, memoryId, expectedContentHash = null } = {}) => {
  if (!client || !tenantId || !memoryId) return { verified: false, reason: 'missing_inputs' };
  if (!(await memoriesTablePresent(client))) return { verified: false, reason: 'table_absent' };
  const res = await client.query(
    `select memory_id, memory_key, revision, content_hash, record_state
       from memories where memory_id = $1 and tenant_id = $2 limit 1`,
    [memoryId, tenantId]
  );
  const row = res.rows[0];
  if (!row) return { verified: false, reason: 'not_found' };
  if (expectedContentHash && row.content_hash !== expectedContentHash) {
    return { verified: false, reason: 'content_hash_mismatch', write: writeResult(row) };
  }
  return { verified: true, write: writeResult(row) };
};

export const verifyMemoryRecordState = async ({ client, tenantId, memoryId, expectedState } = {}) => {
  if (!client || !tenantId || !memoryId || !expectedState) return { verified: false, reason: 'missing_inputs' };
  if (!(await memoriesTablePresent(client))) return { verified: false, reason: 'table_absent' };
  const res = await client.query(
    `select memory_id, memory_key, revision, content_hash, record_state
       from memories where memory_id = $1 and tenant_id = $2 limit 1`,
    [memoryId, tenantId]
  );
  const row = res.rows[0];
  if (!row) return { verified: false, reason: 'not_found' };
  return { verified: row.record_state === expectedState, record_state: row.record_state, write: writeResult(row) };
};

// Verified = every targeted record is state 'erased' AND its content columns are
// actually null (the scrub happened, not just the state flip).
export const verifyMemoryErased = async ({ client, tenantId, lifecycleOwnerType, lifecycleOwnerId, memoryIds = null } = {}) => {
  if (!client || !tenantId || !lifecycleOwnerId || !LIFECYCLE_OWNER_TYPES.includes(lifecycleOwnerType)) {
    return { verified: false, reason: 'missing_inputs' };
  }
  if (!(await memoriesTablePresent(client))) return { verified: false, reason: 'table_absent' };
  const params = [tenantId, lifecycleOwnerType, lifecycleOwnerId];
  let idFilter = '';
  if (memoryIds) {
    params.push(memoryIds);
    idFilter = ` and memory_id = any($${params.length})`;
  }
  const res = await client.query(
    `select count(*)::int as remaining
       from memories
      where tenant_id = $1 and lifecycle_owner_type = $2 and lifecycle_owner_id = $3${idFilter}
        and (record_state <> 'erased'
             or structured_value is not null or source_text is not null
             or source_refs is not null or observed_alias is not null)`,
    params
  );
  const remaining = res.rows[0]?.remaining ?? 0;
  return { verified: remaining === 0, remaining };
};

// ── Lifecycle death (NOT the governed erase path) ────────────────────────────
// A legal-entity memory dies with its legal entity (§6): hard delete inside the
// client-delete transaction — the firm_facts clean-slate posture (the entity is
// gone; the slot is freed so a recreated entity re-teaches instead of inheriting).
// Relations cascade via FK. Presence-guarded; never gated by the rollout flag
// (lifecycle correctness is an invariant, not rollout behaviour).
export const purgeMemoriesForDeletedLegalEntity = async ({ client, firmId, clientId } = {}) => {
  if (!client || !firmId || !clientId) return { deleted: 0 };
  if (!(await memoriesTablePresent(client))) return { deleted: 0 };
  const res = await client.query(
    `delete from memories
      where tenant_id = $1 and lifecycle_owner_type = 'legal_entity' and lifecycle_owner_id = $2`,
    [firmId, clientId]
  );
  return { deleted: res.rowCount || 0 };
};
