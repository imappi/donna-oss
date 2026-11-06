// Stage the governed-memory-retrieval flag (BizOS 2c — MEMORY_RETRIEVAL_V2) for a
// single client, via the config control plane (migration 042
// client_capability_config) — NOT raw SQL.
//
// CONTEXT: `MEMORY_RETRIEVAL_V2` is fully DORMANT by default (both gate duals fall
// back to false — a new live behaviour lands off; never an env pair). Stages:
//   shadow — OBSERVE (2c-ii): after each owner portal-chat turn the governed
//            retrieval runs on the pre-response snapshot and stamps metadata-only
//            telemetry. The legacy prompt is untouched.
//   canary — ACT (2c-iii): the LIVE owner prompt is built from the governed v2
//            bundle in place of the legacy firm_facts paste, for this one client.
//            HARD-GATED (§H/§L): a GREEN, commit-bound replay artifact AND the
//            operational preconditions. Opens a memory-history epoch (§F).
//   off / dry_run — fully dormant: no service call, no stamp, no replacement.
//
// §M GUARD — `auto` (unconditional v2, legacy DELETED) is a SEPARATE later terminal
// and is ALWAYS refused here (the config plane also rejects an auto row for this
// flag through any writer).
//
// SAFETY: dry-run by DEFAULT. Pass --apply to commit. ROLLBACK: `--stage shadow
// --apply` (keeps the comparison running, §G) — instant, per client; opens a
// legacy epoch so v2-era history is fenced out of the legacy prompt too.
// CLIENT_CONFIG_FORCE_DISABLE=MEMORY_RETRIEVAL_V2 restores legacy fleet-wide;
// MEMORY_CONTEXT_SECURITY_SUSPEND withholds ALL memory (§G).
//
// USAGE:
//   node scripts/enable_memory_retrieval_shadow.js                          # dry-run (Honeybee, shadow)
//   … --stage shadow --apply                                                # 2c-ii observe
//   … --stage canary --replay-artifact ./artifact.json --commit <sha> \       # 2c-iii live (gated)
//       --attest noActiveIncident --attest dashboardHealthy --on-call-owner <id> --apply
//   … --stage shadow --apply                                                # rollback from canary
//
// §17 — the canary preconditions are THREE groups by lifetime: (1) replay evidence =
// the GATE (green + commit-bound + FRESH; freshness is the lever's clock over the
// artifact's generated_at/expires_at, never an operator attestation); (2) DURABLE
// approvals travel with the artifact (durable_approvals); (3) LIVE launch state is
// attested at invocation (--attest / --on-call-owner) and written to a SEPARATE
// immutable launch receipt — never copied back into the replay artifact.

import { readFileSync } from 'node:fs';
import { withFirmDbClient, getFirmDatabaseUrl } from '../server/donna/firmDb.js';
import { setClientFlagStage, CONFIG_STAGES, stageObserves, stageActs, configSnapshotId, readClientConfigSnapshot } from '../server/donna/clientConfig.js';
import { MEMORY_RETRIEVAL_V2_FLAG_KEY } from '../server/donna/memoryRetrieval.js';
import { OWNER_MEMORY_AUDIENCE, OWNER_MEMORY_PURPOSE } from '../server/donna/ownerMemorySeam.js';
import { enterMemoryHistoryEpoch } from '../server/donna/memoryHistoryEpoch.js';
import {
  buildReplayBinding,
  evaluateReplayGate,
  buildActivationRecord,
  buildCanaryLaunchReceipt
} from '../server/donna/memoryRetrievalReplayGate.js';

const DEFAULTS = Object.freeze({
  firmId: 'donna-production',
  clientId: 'honeybee-hills-apiary-llc',
  stage: 'shadow'
});

export const parseArgv = (argv = process.argv.slice(2)) => {
  const out = { apply: false, ...DEFAULTS, reason: null, replayArtifactPath: null, commitSha: null, attests: [], onCallOwner: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--apply') out.apply = true;
    else if (a === '--firm') { out.firmId = argv[i + 1]; i += 1; }
    else if (a === '--client') { out.clientId = argv[i + 1]; i += 1; }
    else if (a === '--stage') { out.stage = argv[i + 1]; i += 1; }
    else if (a === '--reason') { out.reason = argv[i + 1]; i += 1; }
    else if (a === '--replay-artifact') { out.replayArtifactPath = argv[i + 1]; i += 1; }
    else if (a === '--commit') { out.commitSha = argv[i + 1]; i += 1; }
    // §17 — LIVE launch attestations at invocation (never baked into the artifact).
    else if (a === '--attest') { out.attests.push(argv[i + 1]); i += 1; }
    else if (a === '--on-call-owner') { out.onCallOwner = argv[i + 1]; i += 1; }
  }
  return out;
};

// §17 — the operational preconditions, split into their THREE distinct groups by
// lifetime. The replay-evidence group is the GATE (green + commit-bound + fresh;
// freshness is lever-clocked over the artifact's own generated_at/expires_at, NOT
// an operator attestation, and `replayArtifactBound` is DERIVED from the binding).
// The other two groups:

// Durable approvals — static receipts that may travel WITH the artifact.
export const DURABLE_APPROVALS = Object.freeze(['rollbackTested', 'targetPrincipalIncluded', 'customerAgreement']);
// Live launch state — attested at INVOCATION (--attest / --on-call-owner), written
// to a SEPARATE immutable launch receipt, NEVER copied back into the artifact.
export const LIVE_ATTESTATIONS = Object.freeze(['noActiveIncident', 'dashboardHealthy']);

export const evaluateDurableApprovals = (approvals = {}) => {
  const missing = DURABLE_APPROVALS.filter((k) => !approvals?.[k]);
  return { ok: missing.length === 0, missing };
};

// onCallOwner is an IDENTITY (presence = attested); the rest are boolean attests.
export const evaluateLiveAttestations = ({ attests = [], onCallOwner = null } = {}) => {
  const set = new Set(Array.isArray(attests) ? attests : []);
  const missing = LIVE_ATTESTATIONS.filter((k) => !set.has(k));
  if (!onCallOwner) missing.push('onCallOwner');
  return { ok: missing.length === 0, missing };
};

// Pure: turn a loaded replay artifact + the candidate deploy's commit/config into a
// gate result. currentBinding is rebuilt from the DEPLOYED versions so a version /
// commit / config change auto-invalidates the artifact (§H, test 14).
export const buildCanaryGateFromArtifact = ({ artifact, commitSha, configSnapshotId: cfgId, now = null } = {}) => {
  if (!artifact || typeof artifact !== 'object') {
    return { passed: false, failures: ['no replay artifact loaded'] };
  }
  const tuple = artifact.tuple || {};
  const currentBinding = buildReplayBinding({
    commitSha,
    configSnapshotId: cfgId,
    clientId: tuple.client_id,
    audience: tuple.audience,
    purpose: tuple.purpose,
    inputRevisionSet: artifact.input_revision_set || []
  });
  return evaluateReplayGate({
    ...(artifact.metrics || {}),
    diffItems: artifact.diff_items || [],
    artifact,
    currentBinding,
    now, // §17 — the lever's trusted clock decides freshness.
    internalEntity: !!artifact.internal_entity
  });
};

// Pure plan builder (exported, unit-tested without a live DB). Fail-closed on an
// invalid stage, a missing client, the `auto` terminal (§M), OR — for `canary` —
// the absence of a GREEN replay gate (§H) and the operational preconditions (§L).
export const buildMemoryRetrievalShadowPlan = ({
  firmId, clientId, stage, currentStage = null, gate = null, durableApprovals = null, liveAttestations = null
} = {}) => {
  const errors = [];
  if (!firmId) errors.push('missing firmId');
  if (!clientId) errors.push('missing clientId (staged per client — the canary discipline, no firm-wide default)');
  const validStage = CONFIG_STAGES.includes(stage);
  if (!validStage) {
    errors.push(`invalid stage '${stage}' (expected one of ${CONFIG_STAGES.join('|')})`);
  } else if (stage === 'auto') {
    errors.push("stage 'auto' is REFUSED — the auto terminal (unconditional v2, legacy deleted) is a separate later slice (§M). 2c-iii stages at most 'canary'.");
  } else if (stage === 'canary') {
    // §17 — the THREE groups, all required. (1) Replay evidence = the gate (green +
    // commit-bound + fresh). (2) Durable approvals. (3) Live launch attestations.
    if (!gate || gate.passed !== true) {
      errors.push(`stage 'canary' requires a GREEN, commit-bound, unexpired replay gate (§H/§17)${gate?.failures?.length ? ` — ${gate.failures.join('; ')}` : ' — no green gate supplied'}`);
    }
    if (!durableApprovals || durableApprovals.ok !== true) {
      errors.push(`stage 'canary' requires the durable approval receipts (§17)${durableApprovals?.missing?.length ? ` — missing: ${durableApprovals.missing.join(', ')}` : ''}`);
    }
    if (!liveAttestations || liveAttestations.ok !== true) {
      errors.push(`stage 'canary' requires the live launch attestations at invocation (§17, --attest/--on-call-owner)${liveAttestations?.missing?.length ? ` — missing: ${liveAttestations.missing.join(', ')}` : ''}`);
    }
  }
  const permitted = validStage && errors.length === 0;
  const transitionsToLegacy = currentStage === 'canary' && (stage === 'shadow' || stage === 'off' || stage === 'dry_run');
  return {
    ok: errors.length === 0,
    errors,
    firmId,
    clientId,
    flagKey: MEMORY_RETRIEVAL_V2_FLAG_KEY,
    from: currentStage,
    to: stage,
    willChange: currentStage !== stage,
    willObserve: permitted ? stageObserves(stage) : false,
    willAct: permitted ? stageActs(stage) : false,
    // §F — a mode transition opens a new memory-history epoch (both directions).
    opensEpoch: permitted && stageActs(stage) ? 'v2' : (permitted && transitionsToLegacy ? 'legacy' : null),
    audience: OWNER_MEMORY_AUDIENCE,
    purpose: OWNER_MEMORY_PURPOSE
  };
};

const log = (...args) => console.log('[enable-memory-retrieval]', ...args);

const readCurrentStage = async (client, { firmId, clientId }) => {
  const result = await client.query(
    `select stage from client_capability_config
      where firm_id = $1 and flag_key = $2 and valid_to is null
        and client_id is not distinct from $3`,
    [firmId, MEMORY_RETRIEVAL_V2_FLAG_KEY, clientId]
  );
  return result.rows[0]?.stage ?? null;
};

const loadReplayArtifact = (path) => {
  if (!path) return null;
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch (err) { log('replay artifact unreadable:', err?.message || err); return null; }
};

export const run = async (opts) => {
  // The lever's TRUSTED clock (§17) — a plain script, so Date is available here (this
  // is not a workflow). Used for gate freshness + the launch receipt attestation time.
  const now = opts.now || new Date().toISOString();
  // For a canary target, resolve the THREE §17 groups from the artifact + CLI + the
  // live config snapshot BEFORE building the plan (so the plan refuses fail-closed).
  let gate = null;
  let durableApprovals = null;
  let liveAttestations = null;
  let binding = null;
  let loadedArtifact = null;
  if (opts.stage === 'canary') {
    loadedArtifact = loadReplayArtifact(opts.replayArtifactPath);
    const cfg = await withFirmDbClient((client) => readClientConfigSnapshot(client, { firmId: opts.firmId, clientId: opts.clientId })).catch(() => ({}));
    const cfgId = configSnapshotId({ firmId: opts.firmId, clientId: opts.clientId, snapshot: cfg });
    gate = buildCanaryGateFromArtifact({ artifact: loadedArtifact, commitSha: opts.commitSha, configSnapshotId: cfgId, now });
    // Durable approvals travel with the artifact; live attestations come from the CLI.
    durableApprovals = evaluateDurableApprovals(loadedArtifact?.durable_approvals || {});
    liveAttestations = evaluateLiveAttestations({ attests: opts.attests, onCallOwner: opts.onCallOwner });
    if (loadedArtifact) {
      binding = buildReplayBinding({
        commitSha: opts.commitSha, configSnapshotId: cfgId,
        clientId: opts.clientId, audience: OWNER_MEMORY_AUDIENCE, purpose: OWNER_MEMORY_PURPOSE,
        inputRevisionSet: loadedArtifact.input_revision_set || []
      });
    }
  }

  const current = await withFirmDbClient((client) => readCurrentStage(client, opts));
  const plan = buildMemoryRetrievalShadowPlan({ ...opts, currentStage: current, gate, durableApprovals, liveAttestations });
  log(`flag=${plan.flagKey} firm=${plan.firmId} client=${plan.clientId} tuple=(${plan.audience}×${plan.purpose})`);
  log(`current stage: ${plan.from ?? '(none — ∅, dormant)'} → target stage: ${plan.to}`);
  if (!plan.ok) {
    log('REFUSED:', plan.errors.join('; '));
    return { applied: false, plan };
  }
  if (plan.willAct) log('this stage ACTS: the LIVE owner prompt is built from the governed v2 bundle in place of the legacy paste, fail-closed (no automatic legacy fallback). A new v2 history epoch is opened.');
  else if (plan.willObserve) log('this stage OBSERVES: metadata-only shadow stamp; the legacy prompt is untouched.');
  else log('this stage is fully dormant (off/dry_run): no retrieval, no stamp, no replacement.');
  if (plan.opensEpoch === 'legacy') log('ROLLBACK: opening a legacy history epoch so v2-era turns are fenced out of the legacy prompt (§F).');
  if (!plan.willChange) log('NOTE: target stage equals current stage — re-applying records a fresh audited row.');
  if (!opts.apply) {
    log('DRY-RUN — no write. Re-run with --apply to commit.');
    return { applied: false, plan };
  }

  const result = await withFirmDbClient(async (client) => {
    // §F — open the memory-history epoch on the mode transition (both directions).
    if (plan.opensEpoch) {
      await enterMemoryHistoryEpoch(client, {
        firmId: plan.firmId, clientId: plan.clientId, audience: plan.audience, purpose: plan.purpose,
        modeEntered: plan.opensEpoch, reason: opts.reason || `stage ${plan.from ?? 'none'}→${plan.to}`, actorType: 'system'
      });
    }
    const staged = await setClientFlagStage(client, {
      firmId: plan.firmId, clientId: plan.clientId, flagKey: plan.flagKey, stage: plan.to,
      source: 'manual', reason: opts.reason || `memory-retrieval staged via lever (${plan.from ?? 'none'}→${plan.to})`, actorType: 'system'
    });
    // §N-C — persist the FULL-tuple activation record for a canary (audit home).
    if (plan.willAct) {
      const rec = buildActivationRecord({ firmId: plan.firmId, clientId: plan.clientId, audience: plan.audience, purpose: plan.purpose, binding, gate, reason: opts.reason });
      await client.query(
        `insert into audit_events (firm_id, client_id, actor_type, action, resource_type, resource_id, metadata)
         values ($1, $2, 'system', 'memory_context.canary_activated', 'memory_context', $3, $4::jsonb)`,
        [plan.firmId, plan.clientId, plan.flagKey, JSON.stringify(rec)]
      );
      // §17 — the LIVE launch state is written to its OWN immutable receipt (the live
      // group has a different lifetime than the replay evidence — it is NOT copied
      // back into the artifact). Bound to the exact artifact by digest.
      const launch = buildCanaryLaunchReceipt({
        firmId: plan.firmId, clientId: plan.clientId, audience: plan.audience, purpose: plan.purpose,
        artifact: loadedArtifact,
        liveAttestations: Object.fromEntries((opts.attests || []).map((k) => [k, true])),
        onCallOwner: opts.onCallOwner, attestedAt: now, reason: opts.reason
      });
      await client.query(
        `insert into audit_events (firm_id, client_id, actor_type, action, resource_type, resource_id, metadata)
         values ($1, $2, 'system', 'memory_context.canary_launch_attested', 'memory_context', $3, $4::jsonb)`,
        [plan.firmId, plan.clientId, plan.flagKey, JSON.stringify(launch)]
      );
    }
    return staged;
  });
  log('APPLIED:', JSON.stringify(result));
  return { applied: true, plan, result };
};

// Only connect/run when invoked directly (so importing for tests never touches the DB).
const invokedDirectly = process.argv[1] && process.argv[1].endsWith('enable_memory_retrieval_shadow.js');
if (invokedDirectly) {
  const opts = parseArgv();
  const dbUrl = getFirmDatabaseUrl();
  if (!dbUrl) {
    console.error(
      '[enable-memory-retrieval] FAILED: no database URL.\n'
      + '  Set DATABASE_URL (or POSTGRES_URL / SUPABASE_DB_URL) to the Supabase POOLER string —\n'
      + '  host aws-0-<region>.pooler.supabase.com, port 6543, username postgres.<projectref>.'
    );
    process.exit(1);
  }
  run(opts)
    .then((r) => process.exit(r.applied || !opts.apply ? 0 : 1))
    .catch((err) => { console.error('[enable-memory-retrieval] FAILED', err); process.exit(1); });
}
