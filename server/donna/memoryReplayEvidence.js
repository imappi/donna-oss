// Donna — BizOS Slice 2c-iii (Slice A): the IMMUTABLE replay-evidence capture
// (design-donna-bizos-slice-2c-iii-replay-producer.md §16, DECIDED Kari 2026-07-13).
//
// The customer-canary producer needs historically-sufficient evidence that the
// 2c-ii metadata stamp cannot hold (the stamp is text-free and lives on a mutable
// owner message). This module builds an IMMUTABLE, restricted, append-only record
// from data the shadow sidecar already has + the service RESULT it already computes:
//
//   - canonical LEGACY evidence: from the real firm_facts rows at the seam
//     (firm_facts is free-text, so id + rendered text + content-hash matching the
//     shadow stamp's legacyFactHash — no triple to extract);
//   - canonical V2 evidence: from result.bundle.context_items (rendered included
//     facts) + consumer_receipt.visible_excluded + privileged excluded/hidden;
//   - per-row AUTHORIZATION receipts: the decision the SERVICE ALREADY MADE at
//     shadow time (included → allow; hidden / excluded_restricted → deny + reason).
//     NEVER a re-resolution against today's ACL;
//   - the full replay ENVELOPE (principal + audience/role snapshot, purpose,
//     subjects, conversation boundary, version manifest, config digest);
//   - immutable session / turn / answer linkage.
//
// Sensitive → the restricted store ONLY. Pure builders (no DB, no model) so this
// unit-tests with fixtures; the two DB helpers take an injected connection.

import { createHash } from 'node:crypto';
import {
  MEMORY_RETRIEVAL_SERVICE_VERSION,
  MEMORY_RETRIEVAL_POLICY_VERSION,
  MEMORY_RETRIEVAL_RANKER_VERSION,
  MEMORY_RETRIEVAL_RENDERER_VERSION,
  MEMORY_RETRIEVAL_ACL_VERSION,
  purposeRegistryFingerprint
} from './memoryRetrieval.js';

export const MEMORY_REPLAY_EVIDENCE_SCHEMA = 'memret.replay.evidence.v1';
export const MEMORY_REPLAY_FINGERPRINT_ALGO_VERSION = 'memret.fp.v1';
export const MEMORY_REPLAY_EVIDENCE_TABLE = 'memory_replay_evidence';

// Idle gap that starts a NEW portal-chat session, resolved + STORED at capture
// (decision b): a stored session id, never a replay-time gap heuristic.
export const SESSION_IDLE_THRESHOLD_MS = 30 * 60 * 1000;

const sha = (value) =>
  `sha256:${createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value ?? null)).digest('hex')}`;

// Matches memoryRetrievalShadow.legacyFactHash exactly, so the producer can
// cross-check the captured legacy text against the shadow-time stamp hash.
const legacyFactHash = (fact) =>
  `ff-${createHash('sha256').update(String(fact ?? '')).digest('hex').slice(0, 24)}`;

// A content digest of the resolved config snapshot — binds the EXACT config
// contents, not only the content-addressed id.
export const memoryConfigDigest = (configSnapshot) => sha(configSnapshot ?? null);

// One row per (turn, purpose, config, version manifest). A version bump mints a
// distinct evidence_id, so a re-run under new versions is a new row, never an
// overwrite (append-only).
export const evidenceIdFor = ({ sourceTurnId = null, purposeId = null, configSnapshotId = null } = {}) =>
  `mre-${createHash('sha256')
    .update(JSON.stringify([sourceTurnId, purposeId, configSnapshotId, MEMORY_RETRIEVAL_SERVICE_VERSION, MEMORY_RETRIEVAL_RENDERER_VERSION]))
    .digest('hex')
    .slice(0, 40)}`;

// ── Canonical legacy evidence (from the firm_facts rows at the seam) ──────────
export const buildLegacyCanonicalEvidence = (firmFacts = []) =>
  (Array.isArray(firmFacts) ? firmFacts : [])
    .filter((f) => f && f.fact)
    .map((f) => ({
      id: f.id ?? null,
      scope: f.scope ?? null,
      subject: f.subject ?? null,
      rendered_text: f.fact,
      content_hash: legacyFactHash(f.fact),
      confidence: f.confidence ?? null
    }));

// ── Canonical v2 evidence (from the service RESULT) ──────────────────────────
export const buildV2CanonicalEvidence = (result = {}) => {
  const items = Array.isArray(result?.bundle?.context_items) ? result.bundle.context_items : [];
  const included = items.map((it) => ({
    memory_id: it.ref?.memory_id ?? null,
    revision: it.ref?.revision ?? null,
    content_hash: it.ref?.content_hash ?? null,
    subject_ref: it.subject_ref ?? null,
    predicate: it.predicate ?? null,
    rendered_value: it.rendered_value ?? null,
    epistemic_state: it.epistemic_state ?? null,
    value_source_trust: it.value_source_trust ?? null,
    provenance_class: it.provenance_class ?? null,
    valid_from: it.valid_from ?? null,
    valid_until: it.valid_until ?? null
  }));
  const priv = result?.privileged_record || {};
  const visibleExcluded = (Array.isArray(result?.consumer_receipt?.visible_excluded) ? result.consumer_receipt.visible_excluded : [])
    .map((r) => ({ memory_id: r.memory_id ?? null, revision: r.revision ?? null, reason_category: r.reason_category ?? null }));
  const restrictedExcluded = (Array.isArray(priv.excluded_restricted) ? priv.excluded_restricted : [])
    .map((r) => ({ memory_id: r.memory_id ?? null, revision: r.revision ?? null, content_hash: r.content_hash ?? null, reason_category: r.reason_category ?? null }));
  const hidden = (Array.isArray(priv.hidden) ? priv.hidden : [])
    .map((r) => ({ memory_id: r.memory_id ?? null, revision: r.revision ?? null, content_hash: r.content_hash ?? null, reason_category: r.reason_category ?? null }));
  return { included, visible_excluded: visibleExcluded, restricted_excluded: restrictedExcluded, hidden };
};

// ── Per-row authorization receipts (the service's OWN shadow-time decisions) ──
export const buildAuthorizationReceipts = (result = {}) => {
  const priv = result?.privileged_record || {};
  const principal = priv.principal || {};
  const base = {
    authenticated_id: principal.authenticated_id ?? null,
    delegated_id: principal.delegated_id ?? null,
    audience_class: principal.audience_class ?? null,
    purpose_id: priv.purpose_id ?? null
  };
  const allow = (Array.isArray(priv.included) ? priv.included : [])
    .map((r) => ({ memory_id: r.memory_id ?? null, revision: r.revision ?? null, decision: 'allow', ...base }));
  const deny = [
    ...(Array.isArray(priv.hidden) ? priv.hidden : []),
    ...(Array.isArray(priv.excluded_restricted) ? priv.excluded_restricted : [])
  ].map((r) => ({ memory_id: r.memory_id ?? null, revision: r.revision ?? null, decision: 'deny', reason_category: r.reason_category ?? null, ...base }));
  return { allow, deny };
};

// ── The full immutable record ─────────────────────────────────────────────────
export const buildReplayEvidenceRecord = ({
  firmId, clientId, snapshot = {}, result = {}, resolvedConfigSnapshotId = null,
  configDigest = null, answer = {}, sessionId = null, legacyCanonical = [], channel = 'client_chat'
} = {}) => {
  const priv = result?.privileged_record || {};
  const receipt = result?.consumer_receipt || {};
  const envelope = {
    principal: {
      id: snapshot?.authenticated_principal?.id ?? null,
      principal_type: snapshot?.authenticated_principal?.principal_type ?? null,
      delegated_id: snapshot?.delegated_principal?.id ?? null,
      // Role/entitlement snapshot: the audience class the service RESOLVED for this
      // principal at shadow time.
      audience_class: priv.principal?.audience_class ?? snapshot?.resolved_audience?.audience_class ?? null
    },
    resolved_audience: snapshot?.resolved_audience ?? null,
    purpose_id: snapshot?.purpose_id ?? null,
    purpose_version: priv.purpose_version ?? null,
    resolved_subject_refs: Array.isArray(snapshot?.resolved_subject_refs) ? snapshot.resolved_subject_refs : [],
    conversation_boundary: snapshot?.conversation_boundary ?? null,
    source_surface: snapshot?.source_surface ?? null
  };
  const versionManifest = {
    service_version: MEMORY_RETRIEVAL_SERVICE_VERSION,
    policy_version: MEMORY_RETRIEVAL_POLICY_VERSION,
    ranker_version: MEMORY_RETRIEVAL_RANKER_VERSION,
    renderer_version: MEMORY_RETRIEVAL_RENDERER_VERSION,
    acl_version: MEMORY_RETRIEVAL_ACL_VERSION,
    fingerprint_algo_version: MEMORY_REPLAY_FINGERPRINT_ALGO_VERSION,
    purpose_registry_fingerprint: purposeRegistryFingerprint()
  };
  const body = {
    schema: MEMORY_REPLAY_EVIDENCE_SCHEMA,
    evidence_id: evidenceIdFor({ sourceTurnId: snapshot?.source_turn_id, purposeId: snapshot?.purpose_id, configSnapshotId: resolvedConfigSnapshotId }),
    firm_id: firmId ?? null,
    client_id: clientId ?? null,
    session_id: sessionId ?? null,
    channel,
    linkage: {
      source_turn_message_id: snapshot?.source_turn_id ?? null,
      answer_message_id: answer?.messageId ?? null,
      answer_content_hash: answer?.contentHash ?? (answer?.content != null ? sha(answer.content) : null),
      answer_model_id: answer?.modelId ?? null,
      answer_model_version: answer?.modelVersion ?? null
    },
    as_of: receipt.as_of ?? snapshot?.authoritative_as_of ?? null,
    config_snapshot_id: resolvedConfigSnapshotId ?? null,
    config_digest: configDigest,
    version_manifest: versionManifest,
    envelope,
    status: result?.status ?? null,
    failure: result?.failure ?? null,
    bundle_fingerprint: receipt.bundle_fingerprint ?? null,
    retrieval_id: priv.retrieval_id ?? null,
    legacy_canonical: Array.isArray(legacyCanonical) ? legacyCanonical : [],
    v2_canonical: buildV2CanonicalEvidence(result),
    authorization_receipts: buildAuthorizationReceipts(result)
  };
  return { ...body, record_hash: sha(body) };
};

// ── Session resolution (decision b) — resolve + STORE at capture ──────────────
//
// Reads the most recent prior evidence row for the tuple (the append-only store is
// stable). Within the idle threshold → continue that session; otherwise (or no
// prior) → a fresh, deterministic session id anchored on this turn. Never a
// replay-time recomputation: the id is written into THIS row.
export const freshSessionId = ({ firmId, clientId, sourceTurnId } = {}) =>
  `sess-${createHash('sha256').update(JSON.stringify([firmId ?? null, clientId ?? null, sourceTurnId ?? null])).digest('hex').slice(0, 32)}`;

export const resolveSessionId = async (client, { firmId, clientId, sourceTurnId, asOf } = {}) => {
  const fresh = freshSessionId({ firmId, clientId, sourceTurnId });
  const asOfMs = asOf ? Date.parse(asOf) : NaN;
  if (!client || !firmId || !clientId || !Number.isFinite(asOfMs)) return fresh;
  const prior = await client.query(
    `select session_id, as_of from ${MEMORY_REPLAY_EVIDENCE_TABLE}
      where firm_id = $1 and client_id = $2 and as_of < $3
      order by as_of desc
      limit 1`,
    [firmId, clientId, asOf]
  ).catch(() => ({ rows: [] }));
  const row = prior.rows?.[0];
  if (!row?.session_id) return fresh;
  const priorMs = row.as_of ? Date.parse(row.as_of) : NaN;
  if (Number.isFinite(priorMs) && (asOfMs - priorMs) <= SESSION_IDLE_THRESHOLD_MS) return row.session_id;
  return fresh;
};

// ── Persist (insert-once; append-only) ────────────────────────────────────────
export const persistMemoryReplayEvidence = async (client, record) => {
  if (!client || !record?.evidence_id) return { persisted: false, reason: 'no_record' };
  const result = await client.query(
    `insert into ${MEMORY_REPLAY_EVIDENCE_TABLE}
       (evidence_id, firm_id, client_id, session_id, source_turn_message_id,
        answer_message_id, as_of, bundle_fingerprint, record_hash, evidence)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)
     on conflict (evidence_id) do nothing
     returning evidence_id`,
    [
      record.evidence_id, record.firm_id, record.client_id, record.session_id,
      record.linkage?.source_turn_message_id ?? null, record.linkage?.answer_message_id ?? null,
      record.as_of, record.bundle_fingerprint, record.record_hash, JSON.stringify(record)
    ]
  );
  return { persisted: !!result.rows?.length, evidenceId: record.evidence_id };
};
