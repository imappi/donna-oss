// Donna — BizOS Slice 2c-ii: the governed-memory-retrieval shadow SIDECAR.
//
// 2c-i shipped the pure service (`memoryRetrieval.js` → `buildMemoryBundle`,
// registered `memory.retrieve.v2`), UNCALLED. 2c-ii wires it in SHADOW ONLY:
// after an owner portal-chat turn responds, this sidecar runs the service on a
// PRE-RESPONSE CAPTURED SNAPSHOT and stamps metadata-only telemetry beside the
// untouched legacy prompt. Nothing the model saw changes; nothing reads the
// stamp. Live prompt replacement is 2c-iii (its own approved addendum, gated).
//
// Safety contract (the intentCompilerShadow / feedChatProposalShadow posture):
//   - NO-THROW by contract: a retrieval error can never break the owner's turn.
//     Every exit returns a status object for telemetry; failures are warned.
//   - Fires POST-COMMIT, on its OWN connection, AFTER the route has responded —
//     owner latency untouched.
//   - Gated PER CLIENT by MEMORY_RETRIEVAL_V2 through the config plane, both
//     duals envFallback () => false (fully dormant until a DB stage row exists;
//     never an env pair). This flag OBSERVES only, at every stage — acting
//     (prompt replacement) belongs to a later, separately-approved 2c-iii wiring
//     of `clientFlagActs`; it is NOT wired here.
//   - IDEMPOTENT: the deterministic `retrieval_id` (source turn + purpose +
//     service/policy versions + config snapshot) is checked against the existing
//     stamp before the service runs — a redelivered turn or retry never
//     double-retrieves, never double-stamps.
//
// The §17 correctness point: the immutable retrieval REQUEST is captured at the
// prompt-assembly seam (`captureRetrievalRequestSnapshot`, called synchronously
// inside the route while the turn's principals/subjects/clock/legacy set are
// still the ones the prompt used); the post-response sidecar runs the service on
// THAT snapshot — never on whatever is live at review time.
//
// The §9/§22 leak point: the stamp is built SOLELY from the consumer receipt
// (the caller's OWN entitled included / visible_excluded rows) plus the caller's
// own legacy set — NEVER from `privileged_record` (hidden ids, excluded-restricted
// reasons). Those live only server-side. `buildMemoryRetrievalShadowStamp` has no
// access path to them, and `MEMORY_RETRIEVAL_SHADOW_STAMP_KEY` is stripped from
// the owner-facing thread projection (`clientPortalChat.js`).
//
// Deps are injected (withFirmDbClient, the bundle builder, the dep factory) so the
// module unit-tests with a mock connection and no live DB, like the other shadow
// leaves.

import { createHash } from 'node:crypto';
import {
  readClientConfigSnapshot,
  configSnapshotId,
  persistConfigSnapshot
} from './clientConfig.js';
import {
  buildMemoryBundle,
  memoryRetrievalV2Observes,
  getRetrievalPurpose,
  retrievalIdFor,
  MEMORY_RETRIEVAL_SERVICE_VERSION,
  MEMORY_RETRIEVAL_POLICY_VERSION,
  SURFACE_AUDIENCE
} from './memoryRetrieval.js';
import {
  isFirmMemberPrincipal,
  getAllowedClientIdsForPrincipal,
  getAssignmentRoleForPrincipal
} from './firmDb.js';
import { memoriesTablePresent, rowToMemoryRecord } from './memoriesDb.js';
import {
  buildReplayEvidenceRecord,
  buildLegacyCanonicalEvidence,
  resolveSessionId,
  persistMemoryReplayEvidence,
  memoryConfigDigest
} from './memoryReplayEvidence.js';

// The single wired purpose for 2c-ii (§21 decision 1): the owner portal-chat
// context. The two firm purposes are registered in the service but not wired
// until their integrations are imminent.
export const MEMORY_RETRIEVAL_SHADOW_PURPOSE_ID = 'portal_owner_context';
export const MEMORY_RETRIEVAL_SHADOW_CONSUMER_ID = 'clientPortalChatContext';
export const MEMORY_RETRIEVAL_SHADOW_SURFACE = 'portal_chat';
// The metadata-only stamp home on the owner message payload (a temporary,
// migration-free shadow home — the intentCompilerShadow precedent). Stripped from
// the owner-facing thread projection so it is never customer-serialized (§22).
export const MEMORY_RETRIEVAL_SHADOW_STAMP_KEY = 'memory_retrieval_shadow';

// A firm_facts row has no revision history, so its "revision_or_hash" is a stable
// content hash of the fact text — enough to detect a legacy row changing between
// the captured turn and a later review.
const legacyFactHash = (fact) =>
  `ff-${createHash('sha256').update(String(fact ?? '')).digest('hex').slice(0, 24)}`;

// The legacy set the owner prompt actually used, from the SAME firm_facts rows
// fed to buildClientPortalChatContext (id + content hash — no fact text, so the
// stamp carries no free text). Filtered to truthy facts, matching the context
// builder's own filter; the firm_facts retrieval cap (24) always binds before the
// context builder's slice (30), so every retrieved row is one the prompt used.
export const buildLegacyIncluded = (firmFacts = []) =>
  (Array.isArray(firmFacts) ? firmFacts : [])
    .filter((f) => f && f.fact)
    .map((f) => ({ id: f.id ?? null, revision_or_hash: legacyFactHash(f.fact) }));

// ── The pre-response snapshot (§17) ──────────────────────────────────────────
//
// Built synchronously at the prompt-assembly seam. Everything the service needs
// is frozen HERE (principals, resolved audience, resolved subjects, clock, legacy
// set) — config_snapshot_id is the one field resolved later (the config read is a
// per-client gate on the sidecar's own connection, the intentCompilerShadow
// posture; the config plane moves far more slowly than a single turn).
export const captureRetrievalRequestSnapshot = ({
  firmId,
  clientId,
  sourceMessageId,
  ownerPrincipal,
  firmFacts = [],
  occurredAt = new Date(),
  conversationBoundaryMessageId = null
} = {}) => {
  if (!firmId || !clientId || !sourceMessageId || !ownerPrincipal) return null;
  const asOf = (occurredAt instanceof Date ? occurredAt : new Date(occurredAt)).toISOString();
  // The owner acts for their own private + legal-entity context: authenticated ===
  // delegated (the purpose's delegated_is_authenticated_owner resolver). The
  // principal id is the stable identity the ACL resolvers key on.
  const principal = {
    id: ownerPrincipal.principalId ?? ownerPrincipal.id ?? null,
    principal_type: ownerPrincipal.principalType ?? null,
    principal_id: ownerPrincipal.principalId ?? null
  };
  return {
    schema: 'memret.shadow.snapshot.v1',
    source_turn_id: sourceMessageId,
    tenant_id: firmId,
    purpose_id: MEMORY_RETRIEVAL_SHADOW_PURPOSE_ID,
    consumer_capability_id: MEMORY_RETRIEVAL_SHADOW_CONSUMER_ID,
    source_surface: MEMORY_RETRIEVAL_SHADOW_SURFACE,
    authenticated_principal: principal,
    delegated_principal: principal,
    resolved_audience: { audience_class: SURFACE_AUDIENCE[MEMORY_RETRIEVAL_SHADOW_SURFACE] },
    // The conversation the retrieval is linked to IS this legal entity (the
    // purpose's conversation_linked_subjects_only resolver). scope_id is the
    // client / legal-entity id.
    resolved_subject_refs: [{ subject_type: 'legal_entity', subject_id: clientId }],
    conversation_boundary: { up_to_message_id: conversationBoundaryMessageId || sourceMessageId },
    authoritative_as_of: asOf,
    legacy_included: buildLegacyIncluded(firmFacts)
  };
};

// Reconstruct the service invocation (trusted_context + request) from the frozen
// snapshot + the config id resolved on the sidecar connection. Exported so the
// 2c-iii canary seam reconstructs the SAME invocation from the SAME snapshot —
// one formula, never a drifting second copy.
export const invocationFromSnapshot = ({ snapshot, resolvedConfigSnapshotId }) => {
  const reconstruct = (p) => (p ? { id: p.id, principalType: p.principal_type, principalId: p.principal_id } : null);
  const trustedContext = {
    tenant_id: snapshot.tenant_id,
    authenticated_principal: reconstruct(snapshot.authenticated_principal),
    delegated_principal: reconstruct(snapshot.delegated_principal),
    resolved_audience: snapshot.resolved_audience,
    source_surface: snapshot.source_surface,
    consumer_capability_id: snapshot.consumer_capability_id,
    source_event_id: snapshot.source_turn_id,
    conversation_ref: snapshot.conversation_boundary,
    occurred_at: snapshot.authoritative_as_of,
    config_snapshot_id: resolvedConfigSnapshotId
  };
  const request = {
    purpose_id: snapshot.purpose_id,
    subject_refs: snapshot.resolved_subject_refs,
    budget_override: null
  };
  return { trustedContext, request };
};

// ── The metadata-only stamp (§9 / §17 / §22) ─────────────────────────────────
//
// Built ONLY from the consumer receipt (the caller's own entitled rows) + the
// caller's own legacy set. NO privileged_record. NO hidden ids. NO exclusion
// categories beyond the caller-visible `visible_excluded.reason_category`. This
// function is deliberately given `result.consumer_receipt` and never
// `result.privileged_record` — there is no code path here to leak a hidden row.
export const buildMemoryRetrievalShadowStamp = ({ snapshot, result, resolvedConfigSnapshotId, channel = 'client_chat' } = {}) => {
  const receipt = result?.consumer_receipt || {};
  const included = Array.isArray(receipt.included) ? receipt.included : [];
  const visibleExcluded = Array.isArray(receipt.visible_excluded) ? receipt.visible_excluded : [];
  const legacyIncluded = Array.isArray(snapshot?.legacy_included) ? snapshot.legacy_included : [];
  const purpose = getRetrievalPurpose(snapshot?.purpose_id);
  return {
    schema: 'memret.shadow.stamp.v1',
    retrieval_id: result?.privileged_record?.retrieval_id
      ?? retrievalIdFor({ sourceEventId: snapshot?.source_turn_id, purposeId: snapshot?.purpose_id, configSnapshotId: resolvedConfigSnapshotId }),
    purpose_id: snapshot?.purpose_id ?? null,
    purpose_version: purpose?.purpose_version ?? null,
    status: result?.status ?? null,
    failure: result?.failure ?? null,
    bundle_fingerprint: receipt.bundle_fingerprint ?? null,
    service_version: MEMORY_RETRIEVAL_SERVICE_VERSION,
    policy_version: MEMORY_RETRIEVAL_POLICY_VERSION,
    config_snapshot_id: resolvedConfigSnapshotId ?? null,
    as_of: receipt.as_of ?? snapshot?.authoritative_as_of ?? null,
    channel,
    // Both sides, for the §21.4 legacy-equivalence diff — all caller-observable.
    legacy_included: legacyIncluded,
    v2_included: included.map((r) => ({ memory_id: r.memory_id, revision: r.revision, content_hash: r.content_hash })),
    v2_visible_excluded: visibleExcluded.map((r) => ({ memory_id: r.memory_id, revision: r.revision, reason_category: r.reason_category })),
    counts: {
      legacy_included: legacyIncluded.length,
      v2_included: included.length,
      v2_visible_excluded: visibleExcluded.length
    }
  };
};

// ── The real deps (ACL adapter + loaders), bound to the sidecar connection ────
//
// COMPOSE the existing firmDb ACL primitives into the service's acl interface —
// never a forked resolver (§6). tenant_id IS firm_id here. The service re-applies
// ALL governance regardless of what the loader returns (defence in depth), so the
// loader is a coarse tenant + active + permitted-scope prefilter.
export const makeMemoryRetrievalShadowDeps = ({ client, env = process.env } = {}) => ({
  env,
  acl: {
    isFirmMember: (principal) => isFirmMemberPrincipal(principal),
    getAllowedClientIds: ({ tenantId, principal }) => getAllowedClientIdsForPrincipal({ firmId: tenantId, principal }),
    getAssignmentRole: ({ tenantId, clientId, principal }) =>
      getAssignmentRoleForPrincipal({ firmId: tenantId, clientId, principal, dbClient: client })
  },
  loadMemoryRecords: async ({ tenantId, allowedScopeTypes = [] }) => {
    if (!client || !(await memoriesTablePresent(client))) return [];
    const scopes = Array.isArray(allowedScopeTypes) && allowedScopeTypes.length ? allowedScopeTypes : null;
    if (!scopes) return [];
    const result = await client.query(
      `select * from memories
        where tenant_id = $1 and record_state = 'active' and scope_type = any($2::text[])
        order by recorded_at desc nulls last
        limit 200`,
      [tenantId, scopes]
    ).catch(() => ({ rows: [] }));
    return result.rows.map(rowToMemoryRecord);
  },
  // portal_owner_context sets allows_legacy_unknown=false, so the service never
  // calls this for the wired purpose; provided for completeness/future purposes.
  loadLegacyViews: async () => []
});

// ── The sidecar ──────────────────────────────────────────────────────────────
export const onOwnerTurnMemoryShadow = async ({
  firmId,
  clientId,
  snapshot,
  channel = 'client_chat',
  // Slice A (§16): the assistant answer this turn produced (linkage only — the
  // answer TEXT lives on the immutable assistant message; we store id + hash),
  // and the real firm_facts rows for canonical legacy evidence.
  answer = {},
  firmFacts = [],
  env = process.env,
  deps = {},
  warn = (...args) => console.warn(...args)
} = {}) => {
  const d = {
    withFirmDbClient: deps.withFirmDbClient,
    buildBundle: deps.buildBundle || buildMemoryBundle,
    makeDeps: deps.makeDeps || makeMemoryRetrievalShadowDeps
  };
  try {
    if (!firmId || !clientId || !snapshot || !snapshot.source_turn_id) {
      return { status: 'skipped', reason: 'missing_inputs' };
    }
    if (typeof d.withFirmDbClient !== 'function') {
      return { status: 'skipped', reason: 'no_db' };
    }
    return await d.withFirmDbClient(async (client) => {
      // 1. The per-client OBSERVE gate, resolved on this connection.
      const configSnapshot = await readClientConfigSnapshot(client, { firmId, clientId });
      if (!memoryRetrievalV2Observes({ snapshot: configSnapshot, env })) {
        return { status: 'skipped', reason: 'flag_off' };
      }

      // 2. The config receipt: content-addressed insert-once; the pure id survives
      //    a persist soft-fail (re-insertable later, same id).
      const resolvedConfigSnapshotId = (await persistConfigSnapshot(client, { firmId, clientId, snapshot: configSnapshot }))
        || configSnapshotId({ firmId, clientId, snapshot: configSnapshot });

      // 3. Idempotency BEFORE the service runs: the deterministic retrieval_id
      //    (shared formula with buildMemoryBundle) against the existing stamp.
      const retrievalId = retrievalIdFor({
        sourceEventId: snapshot.source_turn_id,
        purposeId: snapshot.purpose_id,
        configSnapshotId: resolvedConfigSnapshotId
      });
      const existing = await client.query(
        `select payload->'${MEMORY_RETRIEVAL_SHADOW_STAMP_KEY}'->>'retrieval_id' as retrieval_id
           from client_chat_messages
          where firm_id = $1 and client_id = $2 and id = $3`,
        [firmId, clientId, snapshot.source_turn_id]
      ).catch(() => ({ rows: [] }));
      if (!existing.rows.length) {
        return { status: 'skipped', reason: 'owner_message_not_found' };
      }
      if (existing.rows[0]?.retrieval_id === retrievalId) {
        return { status: 'deduped', retrievalId };
      }

      // 4. Run the governed service on the CAPTURED snapshot (§17) — never live rows.
      const { trustedContext, request } = invocationFromSnapshot({ snapshot, resolvedConfigSnapshotId });
      const serviceDeps = d.makeDeps({ client, env });
      const result = await d.buildBundle({ trustedContext, request, deps: serviceDeps });

      // 5. Stamp metadata-only telemetry (consumer receipt + legacy set; NEVER the
      //    privileged record). Additive jsonb merge — the temporary shadow home.
      const stamp = buildMemoryRetrievalShadowStamp({ snapshot, result, resolvedConfigSnapshotId, channel });
      await client.query(
        `update client_chat_messages
            set payload = coalesce(payload, '{}'::jsonb) || jsonb_build_object('${MEMORY_RETRIEVAL_SHADOW_STAMP_KEY}', $4::jsonb)
          where firm_id = $1 and client_id = $2 and id = $3`,
        [firmId, clientId, snapshot.source_turn_id, JSON.stringify(stamp)]
      );

      // 6. Slice A (§16) — the IMMUTABLE replay-evidence record: historically-
      //    sufficient evidence for a faithful CUSTOMER-canary replay, from the same
      //    service result (canonical legacy + v2 evidence, the replay envelope, the
      //    per-row authorization decisions the service ALREADY made, and immutable
      //    session/turn/answer linkage). Restricted, append-only, insert-once. This
      //    is a SEPARATE restricted sink; the text-free owner-facing stamp above is
      //    untouched. Best-effort within the no-throw contract — a capture failure
      //    can never break the stamp or the owner turn.
      try {
        const sessionId = await resolveSessionId(client, {
          firmId, clientId, sourceTurnId: snapshot.source_turn_id, asOf: snapshot.authoritative_as_of
        });
        const evidenceRecord = buildReplayEvidenceRecord({
          firmId, clientId, snapshot, result, resolvedConfigSnapshotId,
          configDigest: memoryConfigDigest(configSnapshot),
          answer, sessionId, legacyCanonical: buildLegacyCanonicalEvidence(firmFacts), channel
        });
        await persistMemoryReplayEvidence(client, evidenceRecord);
      } catch (evidenceErr) {
        warn(`[memory-retrieval-shadow] replay-evidence capture failed (no-throw) for ${channel}/${snapshot?.source_turn_id}`, evidenceErr?.message || evidenceErr);
      }

      return {
        status: result?.status === 'refused' ? 'observed_refused' : 'observed',
        retrievalId,
        failure: result?.failure ?? null,
        v2Included: stamp.counts.v2_included,
        legacyIncluded: stamp.counts.legacy_included
      };
    });
  } catch (err) {
    warn(`[memory-retrieval-shadow] sidecar failed (no-throw contract) for ${channel}/${snapshot?.source_turn_id}`, err?.message || err);
    return { status: 'failed', reason: err?.message || 'unknown' };
  }
};
