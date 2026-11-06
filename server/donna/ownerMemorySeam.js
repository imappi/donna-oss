// Donna — BizOS Slice 2c-iii (sub-PR 7): the CANARY SEAM (§D). The one place the
// owner turn decides its memory mode and, for a canaried client, feeds the governed
// v2 section into the prompt in place of the legacy firm_facts paste.
//
// It composes the sub-PR 1-6 leaves into the §D flow:
//   resolve mode (§G) → fence history (§F) → inline bounded v2 retrieval (§J) →
//   classify + render (§E1/§E2) → assert no cross-mode leak (§C) → hand the seam
//   result to the route.
//
// Load-bearing properties:
//   - DARK by construction: with no `canary` stage row (every real client),
//     `resolveMemoryMode` returns `legacy` and the seam returns the base context +
//     full history UNCHANGED — the prompt is byte-identical (invariant 10c).
//   - NO automatic legacy fallback at canary (§D, invariant 10): once mode is `v2`,
//     a retrieval failure yields an empty/unavailable memory section, NEVER the
//     legacy paste. The seam is internally no-throw for a resolved mode — a render
//     error fails closed to `unavailable`, not to legacy.
//   - Two controls, not one (§G): `suspended` withholds BOTH v2 and legacy;
//     `legacy` (incl. force-disable) is the operational rollback.
//   - The history fence (§F) applies in ALL modes off the active epoch — a
//     post-rollback legacy turn is fenced against lingering v2-era facts too.
//
// The seam runs on a db client (inside withFirmDbClient) so its config read + epoch
// read + retrieval share one connection. It returns a plain result the route acts
// on; it does not call the model or write telemetry (the route owns those).

import { buildMemoryBundle, memoryRetrievalV2Observes } from './memoryRetrieval.js';
import { readClientConfigSnapshot, configSnapshotId } from './clientConfig.js';
import {
  makeMemoryRetrievalShadowDeps,
  invocationFromSnapshot,
  MEMORY_RETRIEVAL_SHADOW_PURPOSE_ID
} from './memoryRetrievalShadow.js';
import {
  resolveMemoryMode,
  securitySuspendedByEnv,
  buildSecuritySuspensionAuditEvent
} from './memoryContextMode.js';
import {
  getActiveMemoryHistoryEpoch,
  buildHistoryForMemoryEpoch
} from './memoryHistoryEpoch.js';
import {
  buildMemoryBundleWithDeadline,
  resolveCanaryDeadlineMs,
  sharedMemoryRetrievalBreaker,
  shouldRunLegacyEvalSidecar
} from './memoryRetrievalDeadline.js';
import {
  classifyAndRenderV2,
  renderOwnerMemoryPromptBlock,
  OWNER_MEMORY_FACT_DISCIPLINE
} from './ownerMemoryRender.js';
import {
  legacyMemoryContext,
  v2MemoryContext,
  composeOwnerPromptContext,
  assertNoCrossModeMemoryLeak
} from './ownerMemoryContext.js';

// The §N-C activation tuple for the portal owner surface. The lever persists the
// full tuple; here audience/purpose are pinned (2c-iii is portal-owner only, §L-6).
export const OWNER_MEMORY_AUDIENCE = 'owner';
export const OWNER_MEMORY_PURPOSE = MEMORY_RETRIEVAL_SHADOW_PURPOSE_ID;   // 'portal_owner_context'

// The system-prompt appendix for a v2 turn: the narrowed fact-discipline (§E4) +
// the prompt-safe memory block (§E2/§E3). null for legacy → byte-identical prompt.
const systemPromptExtraFor = (memoryContext) =>
  `${OWNER_MEMORY_FACT_DISCIPLINE}\n\n${renderOwnerMemoryPromptBlock(memoryContext)}`;

// buildOwnerTurnMemory({...}) → {
//   mode, promptContext, promptHistory, systemPromptExtra, shortCircuit,
//   memoryContext, auditEvents, telemetry
// }
//
// `shortCircuit` is non-null ONLY for a `blocked` status (integrity / identity):
// the route returns a controlled memory-unavailable response WITHOUT calling the
// model (§D). Every other status proceeds; `unavailable`/`suspended` proceed with a
// no-data controlled note (answer general questions, assert no stored facts).
export const buildOwnerTurnMemory = async ({
  client,
  firmId,
  clientId,
  baseContext,
  history = [],
  snapshot,
  env = process.env,
  deps = {}
} = {}) => {
  const d = {
    buildBundle: deps.buildBundle || buildMemoryBundle,
    makeDeps: deps.makeDeps || makeMemoryRetrievalShadowDeps,
    readConfig: deps.readConfig || readClientConfigSnapshot,
    getEpoch: deps.getEpoch || getActiveMemoryHistoryEpoch,
    withDeadline: deps.withDeadline || buildMemoryBundleWithDeadline,
    breaker: deps.breaker || sharedMemoryRetrievalBreaker,
    deadlineMs: deps.deadlineMs != null ? deps.deadlineMs : resolveCanaryDeadlineMs({ env }),
    now: deps.now
  };
  const audience = OWNER_MEMORY_AUDIENCE;
  const purpose = OWNER_MEMORY_PURPOSE;
  const legacyKnownFacts = baseContext?.known_facts ?? null;

  // 1. Config snapshot (soft-fail → {} → legacy). Read ONCE into the decision — a
  //    mid-request flag flip never mixes modes (§G in-flight semantics, test 7).
  let configSnapshot = {};
  try { configSnapshot = (await d.readConfig(client, { firmId, clientId })) || {}; } catch { configSnapshot = {}; }
  const mode = resolveMemoryMode({ configSnapshot, env });

  // 2. History fence (§F) — off the active epoch, in EVERY mode. No epoch → full
  //    history (byte-identical legacy for an un-canaried client).
  let epoch = null;
  try { epoch = await d.getEpoch(client, { firmId, clientId, audience, purpose }); } catch { epoch = null; }
  const fenced = buildHistoryForMemoryEpoch({ history, epoch });
  const promptHistory = fenced.messages;

  const baseTelemetry = {
    mode,
    fenced: fenced.fenced,
    history_excluded: fenced.excluded_count,
    epoch_seq: fenced.epoch_seq,
    config_snapshot_id: configSnapshotId({ firmId, clientId, snapshot: configSnapshot }),
    observes: memoryRetrievalV2Observes({ snapshot: configSnapshot, env })
  };

  // ── LEGACY — the base context + full history, UNCHANGED (byte-identical) ──────
  if (mode === 'legacy') {
    return {
      mode,
      promptContext: baseContext,
      promptHistory,
      systemPromptExtra: null,
      shortCircuit: null,
      memoryContext: legacyMemoryContext({ knownFacts: legacyKnownFacts }),
      auditEvents: [],
      telemetry: baseTelemetry
    };
  }

  // ── V2 / SUSPENDED — governed memory replaces the legacy paste ───────────────
  const auditEvents = [];
  let memoryContext;

  if (mode === 'suspended') {
    // Withhold BOTH v2 and legacy — controlled no-memory (§G/§N-A). Proceed with a
    // no-data note (answer general questions; assert no stored facts). Audited HERE
    // on the seam's own connection (the clientConfig / memoryHistoryEpoch pattern):
    // route-level audit_events inserts are forbidden — this is not a chat-apply
    // event, so it does not belong on the chatApplySpine.
    memoryContext = v2MemoryContext({ status: 'unavailable', public_reason: 'service_error', as_of: null });
    const suspendAudit = buildSecuritySuspensionAuditEvent({
      firmId, clientId,
      source: securitySuspendedByEnv(env) ? 'env' : 'config',
      retrievalId: baseTelemetry.config_snapshot_id,
      purposeId: purpose
    });
    auditEvents.push(suspendAudit);
    try {
      await client.query(
        `insert into audit_events (firm_id, client_id, actor_type, action, resource_type, resource_id, metadata)
         values ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
        [suspendAudit.firm_id, suspendAudit.client_id, suspendAudit.actor_type, suspendAudit.action, suspendAudit.resource_type, suspendAudit.resource_id, JSON.stringify(suspendAudit.metadata)]
      );
    } catch { /* best-effort — an audit write must never block the owner turn */ }
  } else {
    // v2 — inline, bounded, cancellable retrieval on the CAPTURED snapshot (§J).
    // Fail closed to `unavailable` on any unexpected error — NEVER legacy (§D).
    try {
      const resolvedConfigSnapshotId = baseTelemetry.config_snapshot_id;
      const { trustedContext, request } = invocationFromSnapshot({ snapshot, resolvedConfigSnapshotId });
      const serviceDeps = d.makeDeps({ client, env });
      const outcome = await d.withDeadline({
        invocation: { trustedContext, request },
        deps: serviceDeps,
        deadlineMs: d.deadlineMs,
        buildBundle: d.buildBundle,
        breaker: d.breaker,
        ...(d.now ? { now: d.now } : {})
      });
      memoryContext = classifyAndRenderV2(outcome);
    } catch {
      memoryContext = v2MemoryContext({ status: 'unavailable', public_reason: 'service_error', as_of: null });
    }
  }

  const telemetry = {
    ...baseTelemetry,
    status: memoryContext.status,
    public_reason: memoryContext.public_reason,
    incomplete: memoryContext.incomplete,
    recorded_fact_count: memoryContext.recorded_facts.length,
    conflict_count: memoryContext.conflicts.length,
    legacy_eval_sidecar: shouldRunLegacyEvalSidecar({ retrievalId: baseTelemetry.config_snapshot_id, sampleRate: 1 })
  };

  // The legacy paste is NEVER fed at v2/suspended — strip it from the context.
  const promptContext = { ...baseContext, known_facts: null };

  // `blocked` → controlled memory-unavailable response, no model call (§D).
  if (memoryContext.status === 'blocked') {
    return {
      mode, promptContext, promptHistory,
      systemPromptExtra: null,
      shortCircuit: { public_reason: memoryContext.public_reason },
      memoryContext, auditEvents, telemetry
    };
  }

  // Defence in depth (§C): assert the model-bound context carries the v2 arm only,
  // no legacy leak. Runs over the composed {known_facts:null, memory} envelope.
  const leakEnvelope = composeOwnerPromptContext({ baseContext: promptContext, memoryContext });
  assertNoCrossModeMemoryLeak(leakEnvelope, 'v2');

  return {
    mode,
    promptContext,
    promptHistory,
    systemPromptExtra: systemPromptExtraFor(memoryContext),
    shortCircuit: null,
    memoryContext,
    auditEvents,
    telemetry
  };
};

// The controlled memory-unavailable message for a `blocked` short-circuit (§D). A
// calm owner-facing line — no internal reason leaked (public_reason is telemetry).
export const controlledMemoryUnavailableText = () =>
  "I can't safely reach your saved details right now, so I don't want to guess. "
  + 'Please try again in a moment — everything else still works.';
