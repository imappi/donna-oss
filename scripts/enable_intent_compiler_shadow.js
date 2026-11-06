// Stage the intent-compiler SHADOW sidecar (BizOS Slice 1c — intentCompilerShadow.js) for a
// single client, via the config control plane (migration 042 client_capability_config) —
// NOT raw SQL.
//
// CONTEXT: `INTENT_COMPILER_SHADOW` is fully DORMANT by default (both gate duals fall back
// to false — a new live behaviour lands off; never an env pair). Stage semantics:
//   shadow / canary / auto — OBSERVE: after each owner portal-chat message is persisted,
//                   the strong model compiles it into proposed intent objects and the
//                   validated intent_compile_result is STAMPED on the owner message's
//                   payload (payload.intent_compile). Telemetry only — this flag never
//                   acts at ANY stage; live effect belongs to a later, born-dark
//                   INTENT_OBJECT_ROUTING flag (the split is deliberate: an observational
//                   flag's stages must never acquire side effects in a later release).
//   off / dry_run — fully dormant: no model call, no stamp.
//
// BLAST RADIUS: one additional model call per owner chat message for the staged client,
// fired AFTER the route has responded (owner latency untouched), no-throw, own connection.
// No mutation path changes; nothing reads the stamp yet.
//
// GATE BEFORE BROAD SHADOW: one staged client proves plumbing; enabling beyond it requires
// a gold-set run at thresholds (scripts/run_intent_compiler_goldset.js — addendum §8).
//
// SAFETY: dry-run by DEFAULT (reads + prints the plan, writes nothing). Pass --apply to
// commit. ROLLBACK: re-run with `--stage off --apply` — fully dormant again immediately;
// existing stamps are records, not behaviour. CLIENT_CONFIG_FORCE_DISABLE=INTENT_COMPILER_SHADOW
// kills it fleet-wide.
//
// USAGE:
//   node scripts/enable_intent_compiler_shadow.js                   # dry-run (Honeybee, shadow)
//   DATABASE_URL='…pooler…' node scripts/enable_intent_compiler_shadow.js --apply
//   … --stage off --apply                                           # rollback to dormant

import { withFirmDbClient, getFirmDatabaseUrl } from '../server/donna/firmDb.js';
import { setClientFlagStage, CONFIG_STAGES, stageObserves } from '../server/donna/clientConfig.js';
import { INTENT_COMPILER_SHADOW_FLAG_KEY } from '../server/donna/intentCompiler.js';

const DEFAULTS = Object.freeze({
  firmId: 'donna-production',
  clientId: 'honeybee-hills-apiary-llc',
  stage: 'shadow'
});

export const parseArgv = (argv = process.argv.slice(2)) => {
  const out = { apply: false, ...DEFAULTS, reason: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--apply') out.apply = true;
    else if (a === '--firm') { out.firmId = argv[i + 1]; i += 1; }
    else if (a === '--client') { out.clientId = argv[i + 1]; i += 1; }
    else if (a === '--stage') { out.stage = argv[i + 1]; i += 1; }
    else if (a === '--reason') { out.reason = argv[i + 1]; i += 1; }
  }
  return out;
};

// Pure plan builder (exported, unit-tested without a live DB). Fail-closed on an invalid
// stage or a missing client — staged per client on purpose (the canary discipline), never
// as a firm-wide default row. There is deliberately no willAct: this flag NEVER acts.
export const buildIntentCompilerShadowPlan = ({ firmId, clientId, stage, currentStage = null } = {}) => {
  const errors = [];
  if (!firmId) errors.push('missing firmId');
  if (!clientId) errors.push('missing clientId (staged per client — the canary discipline, no firm-wide default)');
  if (!CONFIG_STAGES.includes(stage)) errors.push(`invalid stage '${stage}' (expected one of ${CONFIG_STAGES.join('|')})`);
  const valid = CONFIG_STAGES.includes(stage);
  return {
    ok: errors.length === 0,
    errors,
    firmId,
    clientId,
    flagKey: INTENT_COMPILER_SHADOW_FLAG_KEY,
    from: currentStage,
    to: stage,
    willChange: currentStage !== stage,
    willObserve: valid ? stageObserves(stage) : false // compile + stamp; never more
  };
};

const log = (...args) => console.log('[enable-intent-compiler-shadow]', ...args);

const readCurrentStage = async (client, { firmId, clientId }) => {
  const result = await client.query(
    `select stage from client_capability_config
      where firm_id = $1 and flag_key = $2 and valid_to is null
        and client_id is not distinct from $3`,
    [firmId, INTENT_COMPILER_SHADOW_FLAG_KEY, clientId]
  );
  return result.rows[0]?.stage ?? null;
};

export const run = async (opts) => {
  const current = await withFirmDbClient((client) => readCurrentStage(client, opts));
  const plan = buildIntentCompilerShadowPlan({ ...opts, currentStage: current });
  log(`flag=${plan.flagKey} firm=${plan.firmId} client=${plan.clientId}`);
  log(`current stage: ${plan.from ?? '(none — ∅, dormant)'} → target stage: ${plan.to}`);
  if (!plan.ok) {
    log('REFUSED:', plan.errors.join('; '));
    return { applied: false, plan };
  }
  if (plan.willObserve) {
    log('this stage OBSERVES: each owner chat message compiles to proposed intent objects, stamped on the owner message payload (intent_compile). Telemetry only — nothing acts on the objects.');
  } else {
    log('this stage is fully dormant (off/dry_run): no compile, no stamp.');
  }
  if (!plan.willChange) log('NOTE: target stage equals current stage — re-applying records a fresh audited row.');
  if (!opts.apply) {
    log('DRY-RUN — no write. Re-run with --apply to commit.');
    return { applied: false, plan };
  }
  const result = await withFirmDbClient((client) => setClientFlagStage(client, {
    firmId: plan.firmId,
    clientId: plan.clientId,
    flagKey: plan.flagKey,
    stage: plan.to,
    source: 'manual',
    reason: opts.reason || `intent-compiler shadow staged via enable_intent_compiler_shadow (${plan.from ?? 'none'}→${plan.to})`,
    actorType: 'system'
  }));
  log('APPLIED:', JSON.stringify(result));
  log('VERIFY: send a portal-chat message as this client\'s owner and check the USER message payload for intent_compile (compile_id, objects, model_id).');
  return { applied: true, plan, result };
};

// Only connect/run when invoked directly (so importing for tests never touches the DB).
const invokedDirectly = process.argv[1] && process.argv[1].endsWith('enable_intent_compiler_shadow.js');
if (invokedDirectly) {
  const opts = parseArgv();
  const dbUrl = getFirmDatabaseUrl();
  if (!dbUrl) {
    console.error(
      '[enable-intent-compiler-shadow] FAILED: no database URL.\n'
      + '  Set DATABASE_URL (or POSTGRES_URL / SUPABASE_DB_URL) to the Supabase POOLER string —\n'
      + '  host aws-0-<region>.pooler.supabase.com, port 6543, username postgres.<projectref>.\n'
      + '  The direct host (db.<ref>.supabase.co, IPv6) and the API host (<ref>.supabase.co) will time out.'
    );
    process.exit(1);
  }
  run(opts)
    .then((r) => process.exit(r.applied || !opts.apply ? 0 : 1))
    .catch((err) => { console.error('[enable-intent-compiler-shadow] FAILED', err); process.exit(1); });
}
