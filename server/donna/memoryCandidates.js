// Donna Loops — Phase 6: the memory-candidate staging front for firm_facts.
//
// A memory_candidate is the auditable, human-reviewable record of a piece of
// firm knowledge BEFORE it is trusted unattended. It is the governance gate in
// front of firm_facts (Layer 2 memory, firmFacts.js / migration 030):
//   - stageMemoryCandidate           — idempotent upsert of one candidate
//   - listMemoryCandidatesForClient  — read projection (governance surface)
//   - backfillMemoryCandidatesFromFacts — reconstruct the ledger from the
//        firm_facts a client already minted (renders the persisted fact verdict,
//        rail #1; idempotent, dry-run-default, gated on the ONE posture below)
//   - purgeMemoryCandidatesForDeletedClient — client-delete purge (rail #5)
//
// DMEM-R1 W1 (2026-09-04, docs/design-donna-memory-remediation.md INV-01/02/05/12;
// audit F-04 / F-10): the candidate feature has ONE resolved posture — the
// MEMORY_CANDIDATES plane key (client_capability_config, clientFlagActs /
// clientFlagObserves, envFallback () => false). Producers stage while it
// OBSERVES (shadow and up); the governance routes, the UI and the backfill ACT
// only while it ACTS (canary / auto); an unknown combination fails closed to
// 'off'. The three private LOOPS_SHADOW reads (this module, api.js twice) are
// gone — the loop workers keep their own LOOPS_TIER master, which is not this
// feature's posture. promote / dismiss fail closed without firm + legal entity +
// candidate id + `expected_version` (migration141's integer candidate_version).
// A re-stage or concurrent decision refuses the stale action; every change
// appends an event atomically, even when the timestamps are identical. A candidate
// can never be STAGED `promoted`: `promoted` is written only by the promotion
// transaction that minted the durable revision (doctrine §2.3).
//
// No LLM, no external calls, no accounting writes. candidate_type ∈
// fact·example·policy·playbook_gap (contract §4). A 'fact' candidate carries
// firm_facts-shaped content so a later promote maps 1:1 onto saveFirmFact. This
// module imports nothing from the case spine (no cycle): callers compose case
// links via caseManager.

import crypto from 'node:crypto';

import { saveFirmFact, dismissFirmFact } from './firmFacts.js';
import { factIsJurisdictionKnowledge } from './operatorMemoryPolicy.js';
import { saveMemory, dismissMemory } from './memoriesDb.js';
import { QUARANTINED_ORIGINS, buildScopedCandidateIdentity, normalizeApplicability, evidenceFromSourceRefs, evidenceSetFingerprint } from './memoryModel.js';
import { clientFlagActs, clientFlagObserves, readClientConfigSnapshot } from './clientConfig.js';

export const MEMORY_CANDIDATE_TYPES = ['fact', 'example', 'policy', 'playbook_gap'];
export const MEMORY_CANDIDATE_STATUSES = ['suggested', 'promoted', 'dismissed', 'conflicted'];
export const MEMORY_FACT_SCOPES = ['merchant', 'client', 'jurisdiction', 'firm'];
export const MEMORY_CONFIDENCES = ['low', 'medium', 'high'];
// BizOS Slice 2b (memory-v2 addendum §8 amendment 18): which contract a promote
// mints into. promoteMemoryCandidate stays the ONE governed staging transition —
// the target routes it. 'firm_fact' is the legacy path, byte-identical.
// 'preference' / 'policy' are REFUSED at promote until their D-PA-5 contracts
// exist (a routed-out candidate must never silently become memory or a fact).
export const MEMORY_CANDIDATE_TARGET_CONTRACTS = ['firm_fact', 'memory', 'preference', 'policy'];

const MAX_SUBJECT_LENGTH = 120;
const MAX_FACT_LENGTH = 300;
const MAX_LIST = 200;

// ── the ONE posture (W1, F-10 / N-05) ─────────────────────────────────────
export const MEMORY_CANDIDATES_FLAG_KEY = 'MEMORY_CANDIDATES';
export const MEMORY_CANDIDATE_POSTURES = Object.freeze(['off', 'observe', 'act']);

// Pure: a config snapshot → the posture. `act` requires the flag to act AND
// observe (canary / auto); `observe` is the shadow stage; anything else — a
// missing row, an unknown stage, a force-disable, or the impossible
// acts-without-observes combination — is `off` (fail closed). No env fallback:
// the key is born on the plane, so without a row the feature is dark.
export const memoryCandidatesPostureFromSnapshot = ({ snapshot = null, env = process.env } = {}) => {
  const acts = clientFlagActs({ flagKey: MEMORY_CANDIDATES_FLAG_KEY, snapshot, envFallback: () => false, env });
  const observes = clientFlagObserves({ flagKey: MEMORY_CANDIDATES_FLAG_KEY, snapshot, envFallback: () => false, env });
  if (acts && observes) return 'act';
  if (observes && !acts) return 'observe';
  return 'off';
};

// The one resolver every producer, route, UI read model and backfill uses.
// Returns { posture, stage, source } — stage/source are the resolved plane row
// (null when absent) so a receipt can name the basis.
export const resolveMemoryCandidatesPosture = async ({ client, firmId, clientId, env = process.env } = {}) => {
  if (!client || !firmId || !clientId) return { posture: 'off', stage: null, source: null };
  const snapshot = await readClientConfigSnapshot(client, { firmId, clientId }).catch(() => ({}));
  const row = snapshot && typeof snapshot === 'object' ? snapshot[MEMORY_CANDIDATES_FLAG_KEY] : null;
  return {
    posture: memoryCandidatesPostureFromSnapshot({ snapshot, env }),
    stage: row?.stage ?? null,
    source: row?.source ?? null
  };
};

export const memoryCandidatesProducerMayStage = (posture) => posture === 'observe' || posture === 'act';
export const memoryCandidatesGovernanceMayAct = (posture) => posture === 'act';

// Integer revisions are the governance token. Database timestamps are not versions:
// now() is constant inside a transaction and the driver truncates microseconds.
export const memoryCandidateVersionToken = (row) =>
  Number.isSafeInteger(row?.candidate_version) && row.candidate_version > 0 ? row.candidate_version : null;

const normalizeExpectedVersion = (value) => {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  if (!/^[1-9][0-9]*$/.test(String(value))) return null;
  const version = Number(value);
  return Number.isSafeInteger(version) ? version : null;
};

const candidateOwnerConflict = ({ clientId, provenance = {}, contractPayload = null }) => {
  for (const owner of [provenance?.client_id, provenance?.entity_client_id]) {
    if (owner && String(owner) !== String(clientId)) return true;
  }
  if (contractPayload) {
    if (contractPayload.lifecycle_owner_type !== 'legal_entity'
        || String(contractPayload.lifecycle_owner_id || '') !== String(clientId)) return true;
    if (contractPayload.scope_type !== 'legal_entity'
        || String(contractPayload.scope_id || '') !== String(clientId)) return true;
  }
  return false;
};

const slug = (value) => String(value || '')
  .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'x';

// Legacy ID reconstruction ONLY, for preserving a same-owner historical row.
// New acquisitions use buildScopedCandidateIdentity below; this hash is not owner-safe.
// targetContract joins the hash only when non-legacy, so every pre-2b id stays
// byte-identical (re-stages keep upserting their existing rows).
export const buildMemoryCandidateId = ({ firmId, candidateType = 'fact', scope = '', subject = '', fact = '', targetContract = 'firm_fact' } = {}) => {
  const components = [firmId, candidateType, scope || '', subject || '', fact || ''];
  if (targetContract && targetContract !== 'firm_fact') components.push(targetContract);
  const hash = crypto.createHash('sha256')
    .update(components.join('|'))
    .digest('hex').slice(0, 16);
  return ['memcand', slug(candidateType), slug(subject), hash].join('-');
};

// to_regclass returns null (never throws) for a missing relation, so this is a
// transaction-safe presence check: a 033/034/035-but-not-036 deploy degrades to
// a no-op instead of aborting the surrounding transaction with 42P01.
export const memoryCandidatesTablePresent = async (client) => {
  if (!client) return false;
  const present = await client.query("select to_regclass('public.memory_candidates') as present");
  return Boolean(present.rows[0]?.present);
};

// Idempotent stage. On conflict it merges provenance + pointers + version but NEVER
// overwrites `status`: a human decision (dismissed/promoted) is set by the
// explicit transition path, never silently flipped back by a re-stage. The current
// migration141 substrate is required; no fallback to the unscoped legacy writer.
export const stageMemoryCandidate = async ({
  client, firmId, clientId, candidateType = 'fact', status = 'suggested',
  source, scope = null, subject = null, fact = null, confidence = 'medium',
  provenance = {}, model = null, mintedFactId = null, caseId = null,
  targetContract = 'firm_fact', contractPayload = null
} = {}) => {
  if (!client || !firmId || !clientId || !source) return null;
  if (!MEMORY_CANDIDATE_TYPES.includes(candidateType)) return null;
  if (!MEMORY_CANDIDATE_STATUSES.includes(status)) return null;
  // W1 (INV-01 / doctrine §2.3): `promoted` is never a STAGED status — only the
  // promotion transaction below writes it, after the durable revision committed.
  // A producer that reaches here with 'promoted' is refused (null), never coerced.
  if (status === 'promoted') return null;
  if (!MEMORY_CANDIDATE_TARGET_CONTRACTS.includes(targetContract)) return null;
  if (!(await memoryCandidatesTablePresent(client))) return null;
  const cleanScope = scope && MEMORY_FACT_SCOPES.includes(scope) ? scope : null;
  let cleanSubject = subject ? String(subject).slice(0, MAX_SUBJECT_LENGTH) : null;
  let cleanFact = fact ? String(fact).slice(0, MAX_FACT_LENGTH) : null;
  const cleanConfidence = MEMORY_CONFIDENCES.includes(confidence) ? confidence : 'medium';
  if (targetContract === 'firm_fact') {
    // A firm_fact-targeted 'fact' candidate is meaningless without firm_facts-shaped content.
    if (candidateType === 'fact' && (!cleanScope || !cleanSubject || !cleanFact)) return null;
  } else {
    // A v2-targeted candidate carries its FULL contract shape in contract_payload
    // (§8 amendment 18 — the versioned payload 036's flat columns can't hold);
    // subject/fact become display projections for the governance list.
    if (!contractPayload || typeof contractPayload !== 'object') return null;
    if (targetContract === 'memory') {
      if (typeof contractPayload.predicate !== 'string' || !contractPayload.predicate.trim()) return null;
      if (typeof contractPayload.source_text !== 'string' || !contractPayload.source_text.trim()) return null;
      cleanSubject = cleanSubject
        || String(contractPayload.observed_alias || contractPayload.subject_id || '').slice(0, MAX_SUBJECT_LENGTH) || null;
      cleanFact = cleanFact || String(contractPayload.source_text).slice(0, MAX_FACT_LENGTH) || null;
    }
  }
  if (candidateOwnerConflict({ clientId, provenance, contractPayload })) return null;
  const legacyId = buildMemoryCandidateId({
    firmId, candidateType, scope: cleanScope || '', subject: cleanSubject || '', fact: cleanFact || '', targetContract
  });
  const applicability = normalizeApplicability(contractPayload?.applicability || provenance?.applicability || null);
  const sourceRefs = contractPayload?.source_refs || provenance?.source_refs
    || (['document_id', 'message_id', 'transaction_id', 'correction_id', 'assertion_id', 'firm_fact_id']
      .some((key) => provenance?.[key]) ? [provenance] : []);
  const evidence = evidenceFromSourceRefs(sourceRefs);
  // Missing historical evidence stays unknown; never invent a source receipt.
  const fingerprint = evidence.length ? evidenceSetFingerprint(evidence) : null;
  const subjectClass = `${targetContract}:${candidateType}:${cleanScope || contractPayload?.subject_type || 'unspecified'}`;
  const normalizedValue = contractPayload
    ? { kind: contractPayload.kind, subject: contractPayload.subject_id, predicate: contractPayload.predicate, value: contractPayload.structured_value,
        source_text: contractPayload.source_text, effective_from: contractPayload.effective_from || null,
        effective_to: contractPayload.effective_to || null }
    : { scope: cleanScope, subject: cleanSubject, fact: cleanFact };
  const identity = buildScopedCandidateIdentity({ tenantId: firmId, legalEntityId: clientId,
    subjectClass, applicability, normalizedValue, evidenceFingerprint: fingerprint });
  const origin = contractPayload?.assertion_origin || provenance?.assertion_origin || (provenance?.distilled ? 'model_inferred' : null);
  const principal = contractPayload?.asserted_by_principal_id || provenance?.asserted_by_principal_id || null;
  // One statement: staging callers often run after their domain transaction. The
  // candidate and its event must still commit together. Existing same-owner legacy
  // IDs and human status survive; another client's old ID is never an upsert target.
  const params = [legacyId, firmId, clientId, candidateType, status, source, cleanScope, cleanSubject, cleanFact,
      cleanConfidence, JSON.stringify({ ...provenance, client_id: clientId }), model, mintedFactId, caseId,
      targetContract, contractPayload ? JSON.stringify(contractPayload) : null, identity, subjectClass,
      JSON.stringify(applicability), JSON.stringify(normalizedValue), fingerprint,
      evidence.length === 1 ? evidence[0].dependence_group : null, origin, principal];
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const result = await client.query(
    `with existing as (
       select id from memory_candidates
        where firm_id = $2 and client_id = $3
          and (scoped_identity = $17 or (id = $1 and scoped_identity is null))
        order by (scoped_identity is not null) desc limit 1
     ), updated as (
       update memory_candidates set
         minted_fact_id = coalesce($13, memory_candidates.minted_fact_id),
         case_id = coalesce($14, memory_candidates.case_id),
         provenance = memory_candidates.provenance || $11::jsonb,
         scoped_identity = $17, subject_class = $18,
         applicability = $19::jsonb, normalized_value = $20::jsonb,
         evidence_fingerprint = $21, dependence_group = $22,
         origin = coalesce(memory_candidates.origin, $23),
         asserted_by_principal_id = coalesce(memory_candidates.asserted_by_principal_id, $24),
         candidate_version = memory_candidates.candidate_version + 1, updated_at = now()
       where id = (select id from existing) and firm_id = $2 and client_id = $3
         and (scoped_identity is null or scoped_identity = $17)
         and (scoped_identity is not null or contract_payload is not distinct from $16::jsonb)
         and (contract_payload is null or (contract_payload->>'lifecycle_owner_type' = 'legal_entity'
              and contract_payload->>'lifecycle_owner_id' = $3
              and contract_payload->>'scope_type' = 'legal_entity'
              and contract_payload->>'scope_id' = $3))
         and (provenance->>'client_id' is null or provenance->>'client_id' = $3)
         and (provenance->>'entity_client_id' is null or provenance->>'entity_client_id' = $3)
       returning *, false as inserted
     ), inserted as (
       insert into memory_candidates
         (id, firm_id, client_id, candidate_type, status, source, scope, subject, fact,
          confidence, provenance, model, minted_fact_id, case_id, target_contract, contract_payload,
          scoped_identity, subject_class, applicability, normalized_value, evidence_fingerprint,
          dependence_group, origin, asserted_by_principal_id, candidate_version, created_at, updated_at)
       select $17, $2, $3, $4, $5, $6, $7, $8, $9,
              $10, $11::jsonb, $12, $13, $14, $15, $16::jsonb, $17, $18, $19::jsonb, $20::jsonb,
              $21, $22, $23, $24, 1, now(), now()
        where not exists (select 1 from existing)
       on conflict do nothing
       returning *, true as inserted
     ), staged as (
       select * from updated union all select * from inserted
     ), event as (
       insert into memory_candidate_events
         (firm_id, client_id, candidate_id, event_seq, event_type, from_status, to_status,
          candidate_version, actor_type, actor_id, payload)
       select firm_id, client_id, id, candidate_version,
              case when inserted then 'staged' else 'version_bumped' end,
              case when inserted then null else status end, status, candidate_version,
              case when $24::text is null then 'system' else 'principal' end, $24,
              jsonb_build_object('scoped_identity', scoped_identity, 'evidence_fingerprint', evidence_fingerprint)
         from staged returning candidate_id
     ) select staged.id, staged.inserted, staged.status, staged.candidate_version, false as retry
         from staged join event on event.candidate_id = staged.id
       union all
       select null, false, null, null, true
        where not exists (select 1 from staged) and not exists (select 1 from existing)`, params
    );
    const row = result.rows[0];
    if (row?.retry) continue; // concurrent insert was invisible to this statement's snapshot
    return row ? { id: row.id, inserted: Boolean(row.inserted), status: row.status,
      version: memoryCandidateVersionToken(row) } : null;
  }
  const error = new Error('Memory candidate changed repeatedly during staging.');
  error.code = 'MEMORY_CANDIDATE_STAGE_CONFLICT';
  throw error;
};

// True when the firm already holds a DIFFERENT active fact about the same
// (scope, subject) — the candidate contradicts standing memory and should be
// surfaced 'conflicted' for a human to reconcile, not silently stacked. The
// just-minted fact (identical text) is excluded by `fact <> $4`. The caller
// passes the already-canonical subject (saveFirmFact canonicalizes on write).
export const detectActiveFactConflict = async ({ client, firmId, clientId, scope, subject, fact } = {}) => {
  if (!client || !firmId || !clientId || !scope || !subject || !fact) return false;
  const res = await client.query(
    `select 1 from firm_facts
      where firm_id = $1 and scope = $2 and subject = $3 and status = 'active' and fact <> $4
        and provenance->>'client_id' = $5
        and (provenance->>'entity_client_id' is null or provenance->>'entity_client_id' = $5)
      limit 1`,
    [firmId, scope, subject, fact, clientId]
  ).catch(() => ({ rows: [] }));
  return res.rows.length > 0;
};

// Promote a candidate — the flag-gated human "yes", and the ONE governed staging
// transition (memory-v2 addendum §8 amendment 18). Routes on target_contract:
//   - 'firm_fact' (legacy, default): mints via saveFirmFact, byte-identical to
//     the pre-2b behaviour.
//   - 'memory': mints into the memories store via saveMemory (memoriesDb.js,
//     dark behind MEMORY_MODEL_V2). The promotion IS the recorded activation
//     confirmation for quarantined origins (§8): a distilled/third-party payload
//     activates here with `explicit_confirmation` naming the deciding human —
//     which is why decidedBy is REQUIRED on that path.
//   - 'preference' / 'policy': REFUSED — those D-PA-5 contracts don't exist yet;
//     a routed-out candidate must never silently become memory or a fact.
// Idempotent: an already-promoted candidate is a no-op; a dismissed candidate is
// NOT overridden (a human "no" wins — promote can't silently undo it).
// Presence-guarded. A refused/flag-off memory mint leaves the candidate resting
// UNDECIDED (still suggested/conflicted — on a human), never half-promoted.
//
// W1 fail-closed contract (F-04, INV-05 / INV-12): the caller names the firm,
// the LEGAL ENTITY (clientId), the candidate id AND the `expected_version` it
// read (memoryCandidateVersionToken). The row must belong to that entity and
// still carry that version at the act, or the decision is refused with a named
// reason — a candidate another entity staged, or one that changed under the
// human, is never acted on.
const governanceScopeRefusal = ({ client, firmId, clientId, candidateId, expectedVersion }) => {
  if (!client || !firmId || !candidateId) return 'missing_identity';
  if (!clientId) return 'missing_legal_entity';
  if (normalizeExpectedVersion(expectedVersion) === null) return 'missing_expected_version';
  return null;
};

const readCandidateForGovernance = async (client, { firmId, clientId, candidateId, expectedVersion }) => {
  const row = await client.query(
    `select * from memory_candidates where firm_id = $1 and id = $2 limit 1 for update`,
    [firmId, candidateId]
  );
  const cand = row.rows[0];
  if (!cand) return { cand: null, refused: 'not_found' };
  if (String(cand.client_id || '') !== String(clientId)) return { cand: null, refused: 'legal_entity_mismatch' };
  if (candidateOwnerConflict({ clientId, provenance: cand.provenance, contractPayload: cand.contract_payload })) {
    return { cand: null, refused: 'candidate_owner_conflict' };
  }
  const targetRefusal = await candidateTargetOwnerConflict(client, { cand, firmId, clientId });
  if (targetRefusal) return { cand: null, refused: targetRefusal };
  const current = memoryCandidateVersionToken(cand);
  if (current !== normalizeExpectedVersion(expectedVersion)) {
    return { cand: null, refused: 'version_mismatch', currentVersion: current };
  }
  return { cand, refused: null };
};

// The row lock acquired by governance remains held through the caller's transaction.
const recordCandidateTransition = (client, cand, status, principal) => client.query(
  `insert into memory_candidate_events
     (firm_id, client_id, candidate_id, event_seq, event_type, from_status, to_status,
      candidate_version, actor_type, actor_id, payload)
   values ($1, $2, $3, $4, $5, $6, $5, $4, 'principal', $7, '{}'::jsonb)`,
  [cand.firm_id, cand.client_id, cand.id, cand.candidate_version + 1, status, cand.status, principal]
);

const candidateTargetOwnerConflict = async (client, { cand, firmId, clientId }) => {
  if (cand.minted_fact_id) {
    const row = (await client.query('select firm_id, provenance from firm_facts where id = $1', [cand.minted_fact_id])).rows[0];
    if (!row || row.firm_id !== firmId || row.provenance?.client_id !== clientId
        || (row.provenance?.entity_client_id && row.provenance.entity_client_id !== clientId)) return 'minted_target_owner_conflict';
  }
  if (cand.minted_memory_id) {
    const row = (await client.query('select tenant_id, lifecycle_owner_type, lifecycle_owner_id, scope_type, scope_id from memories where memory_id = $1', [cand.minted_memory_id])).rows[0];
    if (!row || row.tenant_id !== firmId || row.lifecycle_owner_type !== 'legal_entity'
        || row.lifecycle_owner_id !== clientId || row.scope_type !== 'legal_entity'
        || row.scope_id !== clientId) return 'minted_target_owner_conflict';
  }
  return null;
};

export const promoteMemoryCandidate = async ({
  client, firmId, clientId = null, candidateId, expectedVersion = null, decidedBy = null,
  saveFirmFactFn = saveFirmFact, saveMemoryFn = saveMemory,
  configSnapshot = null, env = process.env
} = {}) => {
  const scopeRefusal = governanceScopeRefusal({ client, firmId, clientId, candidateId, expectedVersion });
  if (scopeRefusal) return { promoted: false, refused: scopeRefusal };
  if (!(await memoryCandidatesTablePresent(client))) return { promoted: false };
  const { cand, refused, currentVersion } = await readCandidateForGovernance(client, { firmId, clientId, candidateId, expectedVersion });
  if (refused) return { promoted: false, refused, ...(currentVersion ? { current_version: currentVersion } : {}) };
  if (cand.status === 'dismissed') return { promoted: false }; // a human "no" is not overridden
  const targetContract = cand.target_contract || 'firm_fact';
  const version = memoryCandidateVersionToken(cand);

  if (targetContract === 'preference' || targetContract === 'policy') {
    return { promoted: false, routedOut: targetContract };
  }

  if (targetContract === 'memory') {
    if (cand.status === 'promoted' && cand.minted_memory_id) {
      return { promoted: true, memoryId: cand.minted_memory_id, already: true, version };
    }
    if (!decidedBy || decidedBy === 'system') return { promoted: false, refused: 'missing_principal' };
    const payload = cand.contract_payload;
    if (!payload || typeof payload !== 'object') return { promoted: false, reason: 'missing_contract_payload' };
    const record = { ...payload };
    if (QUARANTINED_ORIGINS.includes(record.assertion_origin) && !record.activation_confirmation) {
      if (!decidedBy) return { promoted: false, reason: 'quarantined_origin_requires_decided_by' };
      record.activation_confirmation = {
        via: 'explicit_confirmation',
        confirmed_by_principal_id: decidedBy,
        confirmed_at: new Date().toISOString()
      };
    }
    record.creation_provenance = {
      ...(record.creation_provenance || {}),
      promoted_from_candidate: cand.id,
      decided_by: decidedBy || null
    };
    // manageTransaction: false — promote's caller owns the transaction boundary,
    // so the saveMemory audit+mutation and the candidate transition commit (or
    // fail) together.
    const saved = await saveMemoryFn({
      client, tenantId: firmId, record,
      actor: { type: 'firm', id: decidedBy },
      configSnapshot, env, manageTransaction: false
    });
    if (saved?.status !== 'persisted' && saved?.status !== 'reasserted') {
      return { promoted: false, reason: saved?.status || 'save_failed', errors: saved?.errors || null };
    }
    const memoryId = saved.write.memory_id;
    const flipped = await client.query(
      `update memory_candidates
         set status = 'promoted', minted_memory_id = coalesce($3, minted_memory_id),
             decided_at = now(), decided_by = $4, candidate_version = candidate_version + 1, updated_at = now()
       where firm_id = $1 and id = $2 and client_id = $5 and status <> 'dismissed'
         and candidate_version = $6::integer
       returning id`,
      [firmId, candidateId, memoryId, decidedBy, clientId, version]
    );
    // The compare-and-set lost (a concurrent re-stage or decision): the memory
    // write above rides the caller's transaction, so throwing rolls it back
    // with the candidate untouched — never a minted memory behind a candidate
    // that still reads suggested.
    if (!flipped.rows.length) {
      const error = new Error('Memory candidate changed before the promotion could commit.');
      error.code = 'MEMORY_CANDIDATE_VERSION_CONFLICT';
      error.statusCode = 409;
      throw error;
    }
    await recordCandidateTransition(client, cand, 'promoted', decidedBy);
    return { promoted: true, memoryId, write: saved.write, version: version + 1 };
  }

  if (cand.status === 'promoted' && cand.minted_fact_id) {
    return { promoted: true, factId: cand.minted_fact_id, already: true, version };
  }
  if (!decidedBy || decidedBy === 'system') return { promoted: false, refused: 'missing_principal' };
  if (cand.candidate_type !== 'fact' || !cand.scope || !cand.subject || !cand.fact) return { promoted: false, refused: 'unsupported_candidate' };
  // FIK-0b follow-up (plan-2026-09-22 §8.4): a jurisdiction-scope candidate is
  // general tax/accounting knowledge, never company memory. One staged before
  // the distiller stopped proposing them (or reconstructed by the backfill from a
  // legacy row) rests undecided and is refused here, never minted active.
  if (factIsJurisdictionKnowledge({ fact_scope: cand.scope })) return { promoted: false, refused: 'jurisdiction_knowledge' };
  let factId = cand.minted_fact_id || null;
  if (cand.candidate_type === 'fact' && cand.scope && cand.subject && cand.fact) {
    const saved = await saveFirmFactFn({
      client, firmId, expectedClientId: clientId, actorId: decidedBy, scope: cand.scope, subject: cand.subject, fact: cand.fact,
      confidence: cand.confidence || 'medium',
      // The already-validated candidate owner is authoritative; provenance
      // can describe evidence but cannot redirect the target of a user's action.
      provenance: {
        ...(cand.provenance || {}),
        client_id: cand.client_id,
        promoted_from_candidate: cand.id,
        decided_by: decidedBy || null
      },
      model: 'memory_candidate_promote',
      // W1: the promotion IS the explicit teaching action (INV-03) — the one
      // path besides the remember_fact verb that may activate a fact.
      teach: 'explicit'
    });
    if (!saved?.id || saved?.status !== 'active') return { promoted: false, refused: saved?.refused || 'fact_not_active' };
    factId = saved.id;
  }
  const flipped = await client.query(
    `update memory_candidates
       set status = 'promoted', minted_fact_id = coalesce($3, minted_fact_id),
           decided_at = now(), decided_by = $4, candidate_version = candidate_version + 1, updated_at = now()
     where firm_id = $1 and id = $2 and client_id = $5 and status <> 'dismissed'
       and candidate_version = $6::integer
     returning id`,
    [firmId, candidateId, factId, decidedBy, clientId, version]
  );
  if (!flipped.rows.length) {
    const error = new Error('Memory candidate changed before the promotion could commit.');
    error.code = 'MEMORY_CANDIDATE_VERSION_CONFLICT';
    error.statusCode = 409;
    throw error;
  }
  await recordCandidateTransition(client, cand, 'promoted', decidedBy);
  return { promoted: true, factId, version: version + 1 };
};

// Dismiss a candidate — the human "no". Marks it dismissed + records the
// decision, and (by default) cascades to dismiss what it minted — the firm_fact
// OR the memories record (Slice 2b) — so the rejected learning stops influencing
// context. Idempotent (already-dismissed → no-op). Presence-guarded.
// dismissFirmFact / dismissMemory are injectable for tests. The minted_memory_id
// read soft-fails on a pre-085 schema (no v2 column ⇒ no v2 cascade to run).
export const dismissMemoryCandidate = async ({
  client, firmId, clientId = null, candidateId, expectedVersion = null, decidedBy = null, cascadeToFact = true,
  dismissFirmFactFn = dismissFirmFact, dismissMemoryFn = null,
  configSnapshot = null, env = process.env
} = {}) => {
  const scopeRefusal = governanceScopeRefusal({ client, firmId, clientId, candidateId, expectedVersion });
  if (scopeRefusal) return { dismissed: false, refused: scopeRefusal };
  if (!(await memoryCandidatesTablePresent(client))) return { dismissed: false };
  const { cand, refused, currentVersion } = await readCandidateForGovernance(client, { firmId, clientId, candidateId, expectedVersion });
  if (refused) return { dismissed: false, refused, ...(currentVersion ? { current_version: currentVersion } : {}) };
  if (cand.status === 'dismissed') return { dismissed: false };
  if (!decidedBy || decidedBy === 'system') return { dismissed: false, refused: 'missing_principal' };
  const updated = await client.query(
    `update memory_candidates
       set status = 'dismissed', decided_at = now(), decided_by = $3, candidate_version = candidate_version + 1, updated_at = now()
     where firm_id = $1 and id = $2 and client_id = $4 and status <> 'dismissed'
       and candidate_version = $5::integer
     returning minted_fact_id`,
    [firmId, candidateId, decidedBy, clientId, memoryCandidateVersionToken(cand)]
  );
  const row = updated.rows[0];
  if (!row) return { dismissed: false };
  if (cascadeToFact && row.minted_fact_id) {
    await dismissFirmFactFn({ client, firmId, factId: row.minted_fact_id,
      expectedClientId: clientId, actorId: decidedBy, source: 'memory_candidate_dismissal' });
  }
  let mintedMemoryId = null;
  let memoryDismissStatus = null;
  if (cascadeToFact) {
    mintedMemoryId = cand.minted_memory_id || null;
    if (mintedMemoryId) {
      const dismissFn = dismissMemoryFn || dismissMemory;
      const out = await dismissFn({
        client, tenantId: firmId, memoryId: mintedMemoryId,
        reason: `candidate_dismissed:${candidateId}`,
        actor: { type: 'firm', id: decidedBy },
        configSnapshot, env, manageTransaction: false
      });
      memoryDismissStatus = out?.status || null;
      if (!['dismissed', 'already_dismissed'].includes(memoryDismissStatus)) {
        const error = new Error('The linked memory could not be dismissed; candidate transition must roll back.');
        error.code = 'MEMORY_CANDIDATE_DISMISS_REFUSED';
        throw error;
      }
    }
  }
  await recordCandidateTransition(client, cand, 'dismissed', decidedBy);
  return { dismissed: true, factId: row.minted_fact_id || null, memoryId: mintedMemoryId, memoryDismissStatus, version: cand.candidate_version + 1 };
};

// Governance read: a client's candidates (optionally one status), newest first,
// bounded. Soft-fails to [] on a pre-036 deploy (same posture as listFirmFacts).
export const listMemoryCandidatesForClient = async ({
  client, firmId, clientId, status = null, limit = MAX_LIST
} = {}) => {
  if (!client || !firmId || !clientId) return [];
  if (status != null && !MEMORY_CANDIDATE_STATUSES.includes(status)) return [];
  const bounded = Math.min(Math.max(Number(limit) || MAX_LIST, 1), MAX_LIST);
  const conditions = ['firm_id = $1', 'client_id = $2'];
  const params = [firmId, clientId];
  if (status) { params.push(status); conditions.push(`status = $${params.length}`); }
  params.push(bounded);
  const result = await client.query(
    `select id, client_id, candidate_type, status, source, scope, subject, fact, confidence,
            minted_fact_id, case_id, created_at, updated_at, candidate_version
       from memory_candidates
      where ${conditions.join(' and ')}
      order by created_at desc
      limit $${params.length}`,
    params
  ).catch((error) => {
    if (error?.code === '42P01' || error?.code === '42703') return { rows: [] };
    throw error;
  });
  // `version` is the token a governance action must echo back (W1 CAS).
  return result.rows.map((row) => ({ ...row, version: memoryCandidateVersionToken(row) }));
};

// The standing active fact(s) a candidate contradicts: same (scope, subject),
// status 'active', different text (the just-minted/identical fact is excluded by
// `fact <> $4` when provided). Renders the PERSISTED fact verdict (rail #1) so a
// 'conflicted' candidate can show the human exactly what it disagrees with rather
// than re-deriving the conflict. Soft-fails to [] on a pre-030/036 deploy.
export const listConflictingActiveFacts = async ({ client, firmId, clientId, scope, subject, fact = null, limit = 5 } = {}) => {
  if (!client || !firmId || !clientId || !scope || !subject) return [];
  const bounded = Math.min(Math.max(Number(limit) || 5, 1), 20);
  const res = await client.query(
    `select id, scope, subject, fact, confidence, model, updated_at
       from firm_facts
      where firm_id = $1 and scope = $2 and subject = $3 and status = 'active'
        and ($4::text is null or fact <> $4)
        and provenance->>'client_id' = $6
        and (provenance->>'entity_client_id' is null or provenance->>'entity_client_id' = $6)
      order by updated_at desc
      limit $5`,
    [firmId, scope, subject, fact || null, bounded, clientId]
  ).catch((error) => {
    if (error?.code === '42P01' || error?.code === '42703') return { rows: [] };
    throw error;
  });
  return res.rows;
};

// Governance read + conflict enrichment: list a client's candidates (as
// listMemoryCandidatesForClient) and, for each 'conflicted' one, attach
// `conflicts_with` — the standing active fact(s) it contradicts — so the resolve
// UI can surface the disagreement (the conflicted-is-first-class contract). The
// non-conflicted candidates are returned untouched.
export const listMemoryCandidatesWithConflicts = async ({
  client, firmId, clientId, status = null, limit = MAX_LIST
} = {}) => {
  const candidates = await listMemoryCandidatesForClient({ client, firmId, clientId, status, limit });
  for (const cand of candidates) {
    if (cand.status === 'conflicted' && cand.scope && cand.subject) {
      cand.conflicts_with = await listConflictingActiveFacts({
        client, firmId, clientId, scope: cand.scope, subject: cand.subject, fact: cand.fact
      });
    }
  }
  return candidates;
};

// Reconstruct the candidate ledger from the firm_facts a client already minted:
// one 'fact' candidate per fact. Idempotent (deterministic id +
// no-status-overwrite on-conflict), dryRun by default, and — W1 — gated on the
// ONE posture: the backfill is a governance ACTION, so it runs only while
// MEMORY_CANDIDATES acts for the client (posture 'act'; `skipped: -1` otherwise,
// with the resolved posture in the summary). A legacy ACTIVE fact stages
// `suggested` with `minted_fact_id` pointing at the row and
// `provenance.legacy_active_fact: true` — it was activated before the front
// gate existed and has no promotion receipt, so the ledger says "active by
// legacy mint, governance pending", never "promoted" (INV-01 / §2.3). A
// dismissed fact stages `dismissed` (a dismissal IS a governance decision).
export const backfillMemoryCandidatesFromFacts = async ({
  client, firmId, clientId, dryRun = true, limit = 500, env = process.env
} = {}) => {
  const summary = { scanned: 0, staged: 0, existing: 0, skipped: 0, errors: 0, dry_run: Boolean(dryRun), posture: 'off' };
  if (!client || !firmId || !clientId) return summary;
  const { posture } = await resolveMemoryCandidatesPosture({ client, firmId, clientId, env });
  summary.posture = posture;
  if (!memoryCandidatesGovernanceMayAct(posture)) { summary.skipped = -1; return summary; }
  if (!(await memoryCandidatesTablePresent(client))) { summary.skipped = -1; return summary; }
  const bounded = Math.min(Math.max(Number(limit) || 500, 1), 2000);
  const facts = await client.query(
    `select id, scope, subject, fact, confidence, status, provenance, model
       from firm_facts
      where firm_id = $1 and provenance->>'client_id' = $2
      order by updated_at asc
      limit $3`,
    [firmId, clientId, bounded]
  ).catch(() => ({ rows: [] }));
  summary.scanned = facts.rows.length;
  if (dryRun) { summary.skipped = summary.scanned; return summary; }
  for (const f of facts.rows) {
    try {
      const status = f.status === 'dismissed' ? 'dismissed' : 'suggested';
      const res = await stageMemoryCandidate({
        client, firmId, clientId, candidateType: 'fact', status,
        source: 'firm_fact_backfill', scope: f.scope, subject: f.subject, fact: f.fact,
        confidence: f.confidence,
        provenance: {
          ...(f.provenance || {}),
          firm_fact_id: f.id,
          ...(f.status === 'active' ? { legacy_active_fact: true } : {})
        },
        model: f.model, mintedFactId: f.id
      });
      if (res?.inserted) summary.staged += 1; else if (res) summary.existing += 1;
    } catch { summary.errors += 1; }
  }
  return summary;
};

// Client-delete purge (rail #5 — firm memory dies with its client, candidates
// included). client_id has no clients FK, so the cascade misses these rows; this
// explicit hard-delete, run inside the client-delete transaction (folded into
// purgeLoopsShadowForDeletedClient), is load-bearing. Table-presence guarded so a
// pre-036 deploy never blocks a client deletion.
export const purgeMemoryCandidatesForDeletedClient = async ({ client, firmId, clientId } = {}) => {
  if (!client || !firmId || !clientId) return { deleted: 0 };
  if (!(await memoryCandidatesTablePresent(client))) return { deleted: 0 };
  const res = await client.query(
    `delete from memory_candidates where firm_id = $1 and client_id = $2`,
    [firmId, clientId]
  );
  return { deleted: res.rowCount || 0 };
};
