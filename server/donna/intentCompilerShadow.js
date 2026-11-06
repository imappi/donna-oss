// Donna — the intent-compiler shadow SIDECAR (BizOS Slice 1c, addendum §7).
//
// THE one normalized owner-message seam. Live portal/WhatsApp behaviour continues through
// the existing ingress and chat-apply paths, byte-identical — this module observes: after an
// owner message is persisted (post-commit), it compiles the instruction into proposed intent
// objects and stamps the validated intent_compile_result onto the OWNER message's payload.
// The stamp is a TEMPORARY, migration-free shadow-analysis home (explicitly NOT the future
// authoritative object store — the materializer slice brings the real home); the compile is
// keyed to the owner message via source_message_id + the deterministic compile_id.
//
// Safety contract (the feedChatProposalShadow posture):
//   - NO-THROW by contract: a compiler error can never break the owner's turn. Every exit
//     returns a status object for telemetry; failures are warned, never raised.
//   - Fires POST-COMMIT, on its OWN connection, AFTER the route has responded — the owner's
//     latency is untouched.
//   - Gated PER CLIENT by INTENT_COMPILER_SHADOW through the config plane, envFallback
//     () => false on BOTH duals (fully dormant until a DB stage row exists; never an env
//     pair). This flag controls model invocation + telemetry ONLY — at every stage,
//     including canary/auto. Acting belongs to a later, born-dark INTENT_OBJECT_ROUTING.
//   - IDEMPOTENT: the deterministic compile_id (owner message + contract + prompt + model +
//     registry fingerprint) is checked against the existing stamp before the model is
//     called — a redelivered turn or retry never double-compiles, never double-records.
//
// Deps are injected (withFirmDbClient, the compile call) so the module unit-tests with a
// mock connection and no live API, like the other shadow leaves.

import { readClientConfigSnapshot, clientFlagObserves, configSnapshotId, persistConfigSnapshot } from './clientConfig.js';
import { stageIntentCompileResult } from './ownerIntentRuntime.js';
import { capabilityRegistryFingerprint } from './capabilityRegistry.js';
import { intentCompileId, INTENT_COMPILE_CONTRACT_VERSION } from './intentObjects.js';
import {
  INTENT_COMPILER_SHADOW_FLAG_KEY,
  INTENT_COMPILER_PROMPT_VERSION,
  intentCompilerModelId,
  compileOwnerInstruction,
  assembleIntentCompileResult
} from './intentCompiler.js';

// Per-client observe gate. envFallback is () => false BY DESIGN — new live behaviour lands
// fully dormant (the OPERATOR_CAPABILITY_ENFORCE precedent); only a config-plane stage row
// (shadow/canary/auto observe) turns the sidecar on, and CLIENT_CONFIG_FORCE_DISABLE kills
// it fleet-wide.
export const intentCompilerShadowObserves = ({ snapshot = null, env = process.env } = {}) =>
  clientFlagObserves({
    flagKey: INTENT_COMPILER_SHADOW_FLAG_KEY,
    snapshot,
    envFallback: () => false,
    env
  });

// The seam. Call it from any owner-message ingress (portal chat now; the WhatsApp inbound
// handler calls this SAME function when its activation follows — one integration, never
// two). `history` is the prior thread (for pronoun/reference resolution); `channel` names
// the ingress for telemetry only.
export const onOwnerMessagePersisted = async ({
  firmId,
  clientId,
  channel = 'client_chat',
  sourceMessageId,
  ownerText,
  ownerActorId = null,
  sourceMessageCreatedAt = null,
  history = [],
  env = process.env,
  deps = {},
  warn = (...args) => console.warn(...args)
} = {}) => {
  const d = {
    withFirmDbClient: deps.withFirmDbClient,
    compile: deps.compile || compileOwnerInstruction,
    stageIntentCompileResult: deps.stageIntentCompileResult || stageIntentCompileResult
  };
  try {
    if (!firmId || !clientId || !sourceMessageId || typeof ownerText !== 'string' || !ownerText.trim()) {
      return { status: 'skipped', reason: 'missing_inputs' };
    }
    if (typeof d.withFirmDbClient !== 'function') {
      return { status: 'skipped', reason: 'no_db' };
    }
    return await d.withFirmDbClient(async (client) => {
      // 1. The per-client gate, resolved on this connection.
      const snapshot = await readClientConfigSnapshot(client, { firmId, clientId });
      if (!intentCompilerShadowObserves({ snapshot, env })) {
        return { status: 'skipped', reason: 'flag_off' };
      }

      // 2. Idempotency BEFORE the model call: the deterministic key against the existing
      //    stamp. Same message + contract + prompt + model + registry ⇒ same compile_id ⇒
      //    dedupe; any of them changed ⇒ a fresh compile updates the stamp.
      const registryFingerprint = capabilityRegistryFingerprint();
      const modelId = intentCompilerModelId(env);
      const compileId = intentCompileId({
        sourceMessageId,
        contractVersion: INTENT_COMPILE_CONTRACT_VERSION,
        promptVersion: INTENT_COMPILER_PROMPT_VERSION,
        modelId,
        registryFingerprint
      });
      const existing = await client.query(
        `select payload->'intent_compile'->>'compile_id' as compile_id, created_at
           from client_chat_messages
          where firm_id = $1 and client_id = $2 and id = $3`,
        [firmId, clientId, sourceMessageId]
      ).catch(() => ({ rows: [] }));
      if (!existing.rows.length) {
        return { status: 'skipped', reason: 'owner_message_not_found' };
      }
      if (existing.rows[0]?.compile_id === compileId) {
        return { status: 'deduped', compileId };
      }

      // 3. The config receipt: content-addressed insert-once; the pure id survives a
      //    persist soft-fail (the row is re-insertable later, same id).
      const snapshotId = (await persistConfigSnapshot(client, { firmId, clientId, snapshot }))
        || configSnapshotId({ firmId, clientId, snapshot });

      // 4. Compile (the one model call) + deterministic assembly. A failed call still
      //    yields a well-formed empty-objects result with failure_category set — the
      //    shadow record is never a naked absence.
      const compiled = await d.compile({
        ownerMessage: ownerText,
        sourceMessageId,
        history,
        env
      });
      const result = assembleIntentCompileResult({
        compiled,
        sourceMessageId,
        registryFingerprint,
        configSnapshotId: snapshotId
      });

      // 5. Stamp the OWNER message payload (additive jsonb merge — the temporary shadow
      //    home). channel rides the stamp for telemetry.
      const stampedResult = { ...result, channel };
      await client.query(
        `update client_chat_messages
            set payload = coalesce(payload, '{}'::jsonb) || jsonb_build_object('intent_compile', $4::jsonb)
          where firm_id = $1 and client_id = $2 and id = $3`,
        [firmId, clientId, sourceMessageId, JSON.stringify(stampedResult)]
      );

      // 6. Optional first runtime bridge: stage validated candidates as immutable proposal
      //    cards only when the separate ACTING flag is canary/auto. Shadow/canary for the
      //    compiler alone never executes this, and the bridge itself still executes no
      //    accounting mutations.
      const observedAt = sourceMessageCreatedAt || existing.rows[0]?.created_at?.toISOString?.() || existing.rows[0]?.created_at || null;
      const staging = await d.stageIntentCompileResult({
        client, firmId, clientId, compileResult: stampedResult, snapshot, env,
        actorId: ownerActorId, observedAt
      });
      return {
        status: result.failure_category ? 'compiled_failed' : 'compiled',
        compileId,
        objectCount: result.objects.length,
        warningCount: result.validation_warnings.length,
        unmetNeedCount: result.unmet_capability_needs.length,
        staging
      };
    });
  } catch (err) {
    warn(`[intent-compiler-shadow] sidecar failed (no-throw contract) for ${channel}/${sourceMessageId}`, err?.message || err);
    return { status: 'failed', reason: err?.message || 'unknown' };
  }
};
