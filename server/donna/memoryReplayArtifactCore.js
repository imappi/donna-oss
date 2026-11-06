// Donna — BizOS 2c-iii producer: the PURE artifact core
// (design-donna-bizos-slice-2c-iii-replay-producer.md §4, §6, §10, §11).
//
// No DB, no model, no clock. The CLI (build_memory_replay_artifact.js) reads the
// memory_replay_evidence rows + re-runs buildMemoryBundle (twice) and hands the
// fingerprints here; this module owns:
//   - envelope validation (is the recorded evidence replayable at all);
//   - the replay-outcome taxonomy (the review's §4 correction — a fingerprint diff is
//     NOT nondeterminism unless the same inputs replay differently twice);
//   - turn-level diff PRE-pairing (coarse, deterministic; the model refines §6);
//   - metrics with STRICT eligibility (only `exact` + memory-bearing count; §10);
//   - artifact assembly to the gate/lever contract (§17: generated_at/expires_at +
//     durable_approvals, NEVER live attestations).

import { createHash } from 'node:crypto';

export const MEMORY_REPLAY_ARTIFACT_SCHEMA = 'memret.replay.artifact.v1';

// ── Envelope validation ──────────────────────────────────────────────────────
// The recorded evidence must carry everything a faithful historical replay needs.
export const REQUIRED_ENVELOPE_PATHS = Object.freeze([
  'linkage.source_turn_message_id', 'as_of', 'config_snapshot_id', 'config_digest',
  'version_manifest', 'bundle_fingerprint', 'envelope.purpose_id',
  'envelope.resolved_subject_refs', 'authorization_receipts'
]);

const getPath = (obj, path) => path.split('.').reduce((o, k) => (o == null ? o : o[k]), obj);

export const validateEvidenceEnvelope = (record) => {
  const reasons = [];
  if (!record || typeof record !== 'object') return { ok: false, reasons: ['not_an_object'] };
  if (record.schema !== 'memret.replay.evidence.v1') reasons.push('wrong_schema');
  for (const p of REQUIRED_ENVELOPE_PATHS) {
    const v = getPath(record, p);
    if (v == null) reasons.push(`missing:${p}`);
  }
  // An answer link is required for the reliance judgment (ambiguous answers are
  // rejected upstream; here we require the id to be present).
  if (!getPath(record, 'linkage.answer_message_id')) reasons.push('missing:linkage.answer_message_id');
  return { ok: reasons.length === 0, reasons };
};

// ── Replay-outcome taxonomy (§4) ─────────────────────────────────────────────
export const REPLAY_OUTCOMES = Object.freeze([
  'exact', 'nondeterministic', 'input_drift', 'version_or_config_drift', 'unreproducible', 'invalid_record'
]);

// Only `exact` counts toward the gate thresholds. The distinctions:
//   A != B                                   → nondeterministic (a service bug)
//   A == B, versions/config differ            → version_or_config_drift
//   A == B, recorded inputs not all present   → input_drift
//   A == B, all match, fp != recorded         → unreproducible
//   A == B == recorded                        → exact
export const classifyReplayOutcome = ({
  recordedFingerprint = null,
  replayA = null,
  replayB = null,
  recordedInputsPresent = true,
  versionsMatch = true,
  configMatch = true,
  envelopeValid = true
} = {}) => {
  if (!envelopeValid) return 'invalid_record';
  if (replayA == null || replayB == null) return 'invalid_record';
  if (replayA !== replayB) return 'nondeterministic';
  if (!versionsMatch || !configMatch) return 'version_or_config_drift';
  if (!recordedInputsPresent) return 'input_drift';
  if (recordedFingerprint != null && replayA === recordedFingerprint) return 'exact';
  return 'unreproducible';
};

// ── Turn-level diff PRE-pairing (§6) ─────────────────────────────────────────
// Legacy is free-text (subject + rendered_text); v2 is structured (subject_ref,
// predicate, rendered_value). True semantic pairing is the model's job — here we do a
// COARSE deterministic candidate pairing by a normalized subject key so the model
// sees candidate pairs (not isolated items), and emit the leftover adds/drops.
// Subject-plus-predicate is a comparison GROUP, never identity (§7) — a value change
// stays a paired drop+add / matched-changed for the model, never silently "the same".
const normSubject = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '');
const legacySubjectKey = (f) => normSubject(f.subject);
const v2SubjectKey = (f) => normSubject(String(f.subject_ref ?? '').split(':').pop());

export const pairAndDiff = ({ legacyCanonical = [], v2Canonical = {} } = {}) => {
  const legacy = Array.isArray(legacyCanonical) ? legacyCanonical : [];
  const v2 = Array.isArray(v2Canonical?.included) ? v2Canonical.included : [];
  const items = [];
  const usedV2 = new Set();

  for (const lf of legacy) {
    const key = legacySubjectKey(lf);
    const candIdx = v2.findIndex((vf, i) => !usedV2.has(i) && v2SubjectKey(vf) === key);
    if (candIdx >= 0) {
      usedV2.add(candIdx);
      const vf = v2[candIdx];
      items.push({
        kind: 'matched', subject_key: key,
        legacy: { id: lf.id, rendered_text: lf.rendered_text, content_hash: lf.content_hash },
        v2: { memory_id: vf.memory_id, predicate: vf.predicate, rendered_value: vf.rendered_value },
        rendered_changed: String(lf.rendered_text ?? '') !== String(vf.rendered_value ?? '')
      });
    } else {
      items.push({ kind: 'drop', subject_key: key, legacy: { id: lf.id, rendered_text: lf.rendered_text, content_hash: lf.content_hash } });
    }
  }
  v2.forEach((vf, i) => {
    if (usedV2.has(i)) return;
    items.push({ kind: 'add', subject_key: v2SubjectKey(vf), v2: { memory_id: vf.memory_id, predicate: vf.predicate, rendered_value: vf.rendered_value } });
  });
  return { items };
};

// A turn is "memory-bearing" if either side contributed a fact (an empty↔empty turn
// is not evidence for a memory canary — §10).
export const isMemoryBearing = ({ legacyCanonical = [], v2Canonical = {} } = {}) =>
  (Array.isArray(legacyCanonical) && legacyCanonical.length > 0) ||
  (Array.isArray(v2Canonical?.included) && v2Canonical.included.length > 0);

// ── Metrics (§10) — strict eligibility + gate-read stage counts ──────────────
// perTurn: [{ turnId, outcome, sessionId, asOf, memoryBearing, diffBearing,
//             ambiguousAnswer, classificationFailure }]. dayCount is UTC (explicit).
export const computeMetrics = (perTurn = []) => {
  const rows = Array.isArray(perTurn) ? perTurn : [];
  // Dedupe by canonical turn id (a redelivered/retried turn counts once).
  const seen = new Set();
  const deduped = rows.filter((r) => {
    if (!r?.turnId || seen.has(r.turnId)) return false;
    seen.add(r.turnId);
    return true;
  });
  const count = (pred) => deduped.filter(pred).length;
  const eligible = deduped.filter((r) => r.outcome === 'exact' && r.memoryBearing && !r.ambiguousAnswer && !r.classificationFailure);
  const sessions = new Set(eligible.map((r) => r.sessionId).filter(Boolean));
  const days = new Set(eligible.map((r) => (r.asOf ? r.asOf.slice(0, 10) : null)).filter(Boolean)); // UTC calendar day
  const total = deduped.length;
  return {
    realTurnCount: eligible.length,
    sessionCount: sessions.size,
    dayCount: days.size,
    counts: {
      total,
      exact: count((r) => r.outcome === 'exact'),
      nondeterministic: count((r) => r.outcome === 'nondeterministic'),
      input_drift: count((r) => r.outcome === 'input_drift'),
      version_or_config_drift: count((r) => r.outcome === 'version_or_config_drift'),
      unreproducible: count((r) => r.outcome === 'unreproducible'),
      invalid_record: count((r) => r.outcome === 'invalid_record'),
      zero_memory: count((r) => !r.memoryBearing),
      diff_bearing: count((r) => r.diffBearing),
      ambiguous_answer: count((r) => r.ambiguousAnswer),
      classification_failure: count((r) => r.classificationFailure)
    },
    coverage_ratio: total > 0 ? eligible.length / total : 0
  };
};

// ── Artifact assembly (the gate/lever contract) ──────────────────────────────
export const computeArtifactManifestHash = ({ tuple, metrics, diffItems, inputRevisionSet, freshness }) =>
  `manifest-${createHash('sha256').update(JSON.stringify({ tuple, metrics, diffItems, inputRevisionSet, freshness })).digest('hex')}`;

export const assembleArtifact = ({
  tuple, binding, metrics, diffItems = [], inputRevisionSet = [],
  internalEntity = false, durableApprovals = {}, freshness = {},
  syntheticSuite = null, aclIntegrityFailureCount = 0, sentinelFoundInPayload = false,
  provenance = {}
} = {}) => {
  const artifactMetrics = {
    realTurnCount: metrics?.realTurnCount ?? 0,
    sessionCount: metrics?.sessionCount ?? 0,
    dayCount: metrics?.dayCount ?? 0,
    syntheticSuite,
    aclIntegrityFailureCount,
    sentinelFoundInPayload
  };
  return {
    schema: MEMORY_REPLAY_ARTIFACT_SCHEMA,
    tuple,
    binding,
    internal_entity: !!internalEntity,
    input_revision_set: inputRevisionSet,
    // §17 freshness — binding-covered artifact fields; the lever's clock decides.
    generated_at: freshness?.generated_at ?? null,
    expires_at: freshness?.expires_at ?? null,
    metrics: artifactMetrics,
    diff_items: diffItems,
    // §17 — durable approvals travel with the artifact; live attestations do NOT.
    durable_approvals: durableApprovals,
    // Not gate-read — the audit a human needs to trust the green (stage counts, drift
    // ledger, classifier model ids, the sentinel, the manifest hash).
    provenance: {
      ...provenance,
      manifest_hash: computeArtifactManifestHash({ tuple, metrics: artifactMetrics, diffItems, inputRevisionSet, freshness })
    }
  };
};
