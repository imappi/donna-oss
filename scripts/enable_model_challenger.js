// Stage the shadow-challenger flag (MODEL_CHALLENGER, descent ladder Q2) for a
// single Donna-operated pilot (firm, client), via the config control plane
// (migration 042 client_capability_config) — NOT raw SQL.
//
// DECIDED (Kari, 2026-08-12, spec §9 amendments): stage `shadow` for exactly ONE
// Donna-operated pilot (firm, client) on the pilot lane — bank_line_disposition
// since Q6a (2026-08-13); the original bank_line_classification lane was
// retired with its env-dark auto-explain sweep in RT-14 (2026-09-02) —
// retaining the lane's 100% sampling (the registry fraction — this script never
// touches sampling). The flag gates on stageObserves (shadow / canary / auto all
// OBSERVE; off / dry_run do not — the LOOPS_SHADOW_RISK_CONTEXT precedent):
// challenger dispatch is observe-only BY CONSTRUCTION, so there is no acting
// stage to graduate to; `shadow` is the honest resting stage for a pilot.
//
// EXACTLY-ONE-PILOT GUARD: applying a shadow/canary/auto stage while ANOTHER
// (firm, client) already holds an observing stage is REFUSED unless
// --allow-additional is passed — the 2026-08-12 call stages ONE pilot, and a
// second concurrent pilot both doubles R&D spend against the 10M/month fleet
// envelope and muddies the gap table's single-candidate window.
//
// BLAST RADIUS: evidence-only. A staged client's bank-line disposition sweep
// additionally fires the challenger post-commit (fire-and-forget, no-throw,
// fail-closed on the env four: OPENAI_COMPATIBLE_API_KEY / _BASE_URL / _MODEL /
// MODEL_CHALLENGER_CAP_TOKENS). No deciding path changes; challenger output
// never mints memory, asks, proposals, or postings (boundary-test pinned).
//
// SAFETY: dry-run by DEFAULT (reads + prints the plan + env readiness, writes
// nothing). Pass --apply to commit. ROLLBACK: re-run with `--stage off --apply`
// — challenger dispatch stops immediately for the client; receipts already
// written stay (they are records, not behaviour).
//
// USAGE:
//   node scripts/enable_model_challenger.js                          # dry-run (default pilot, shadow)
//   DATABASE_URL='…pooler…' node scripts/enable_model_challenger.js --apply
//   … --firm <id> --client <id> --apply                              # name the pilot pair
//   … --stage off --apply                                            # rollback to dormant

import { withFirmDbClient, getFirmDatabaseUrl } from '../server/donna/firmDb.js';
import { setClientFlagStage, CONFIG_STAGES, stageObserves } from '../server/donna/clientConfig.js';
import { MODEL_CHALLENGER_FLAG_KEY } from '../server/donna/modelChallenger.js';
import { bankLineDispositionChallengerConfigured, BANK_LINE_DISPOSITION_CHALLENGER_LANE } from '../server/donna/bankLineDispositionChallenger.js';
import { getLane } from '../server/donna/modelLanes.js';

const DEFAULTS = Object.freeze({
  firmId: 'donna-production',
  clientId: 'honeybee-hills-apiary-llc',
  stage: 'shadow'
});

export const parseArgv = (argv = process.argv.slice(2)) => {
  const out = { apply: false, allowAdditional: false, ...DEFAULTS, reason: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--apply') out.apply = true;
    else if (a === '--allow-additional') out.allowAdditional = true;
    else if (a === '--firm') { out.firmId = argv[i + 1]; i += 1; }
    else if (a === '--client') { out.clientId = argv[i + 1]; i += 1; }
    else if (a === '--stage') { out.stage = argv[i + 1]; i += 1; }
    else if (a === '--reason') { out.reason = argv[i + 1]; i += 1; }
  }
  return out;
};

// Pure plan builder (exported, unit-tested without a live DB). Fail-closed on
// an invalid stage, a missing client (per-client canary discipline — never a
// firm-wide default row), or a SECOND concurrent observing pilot.
export const buildChallengerStagePlan = ({
  firmId,
  clientId,
  stage,
  currentStage = null,
  otherObservingPilots = [],
  allowAdditional = false
} = {}) => {
  const errors = [];
  if (!firmId) errors.push('missing firmId');
  if (!clientId) errors.push('missing clientId (staged per client — the canary discipline, no firm-wide default)');
  if (!CONFIG_STAGES.includes(stage)) errors.push(`invalid stage '${stage}' (expected one of ${CONFIG_STAGES.join('|')})`);
  const valid = CONFIG_STAGES.includes(stage);
  const willObserve = valid ? stageObserves(stage) : false;
  if (willObserve && otherObservingPilots.length && !allowAdditional) {
    errors.push(
      `another pilot already observes (${otherObservingPilots.map((p) => `${p.firm_id}/${p.client_id}@${p.stage}`).join(', ')}) — `
      + 'the 2026-08-12 call stages exactly ONE pilot; pass --allow-additional only with a new dated decision'
    );
  }
  return {
    ok: errors.length === 0,
    errors,
    firmId,
    clientId,
    flagKey: MODEL_CHALLENGER_FLAG_KEY,
    from: currentStage,
    to: stage,
    willChange: currentStage !== stage,
    willObserve
  };
};

const log = (...args) => console.log('[enable-model-challenger]', ...args);

const readCurrentStage = async (client, { firmId, clientId }) => {
  const result = await client.query(
    `select stage from client_capability_config
      where firm_id = $1 and flag_key = $2 and valid_to is null
        and client_id is not distinct from $3`,
    [firmId, MODEL_CHALLENGER_FLAG_KEY, clientId]
  );
  return result.rows[0]?.stage ?? null;
};

// Every OTHER (firm, client) currently holding an observing stage for this
// flag — the exactly-one-pilot guard's evidence.
const readOtherObservingPilots = async (client, { firmId, clientId }) => {
  const result = await client.query(
    `select firm_id, client_id, stage from client_capability_config
      where flag_key = $1 and valid_to is null
        and stage in ('shadow', 'canary', 'auto')`,
    [MODEL_CHALLENGER_FLAG_KEY]
  );
  return (result.rows || []).filter(
    (row) => !(row.firm_id === firmId && row.client_id === clientId)
  );
};

export const run = async (opts) => {
  const { current, others } = await withFirmDbClient(async (client) => ({
    current: await readCurrentStage(client, opts),
    others: await readOtherObservingPilots(client, opts)
  }));
  const plan = buildChallengerStagePlan({
    ...opts,
    currentStage: current,
    otherObservingPilots: others
  });
  log(`flag=${plan.flagKey} firm=${plan.firmId} client=${plan.clientId}`);
  log(`current stage: ${plan.from ?? '(none — ∅, dormant)'} → target stage: ${plan.to}`);

  // Env readiness — printed evidence, part of the receipt. The stage row and
  // the env four are independent gates; dispatch needs BOTH.
  const envReady = bankLineDispositionChallengerConfigured(process.env);
  const lane = getLane(BANK_LINE_DISPOSITION_CHALLENGER_LANE);
  log(`lane=${BANK_LINE_DISPOSITION_CHALLENGER_LANE} sampling=${lane?.challenger?.sampling?.fraction ?? '?'} (registry — this script never changes it)`);
  log(envReady
    ? 'env: challenger endpoint CONFIGURED (key + base URL + candidate model + cap all present)'
    : 'env: challenger endpoint NOT configured — staging still applies, but dispatch stays dark until OPENAI_COMPATIBLE_API_KEY / _BASE_URL / _MODEL and MODEL_CHALLENGER_CAP_TOKENS are set (check the boot receipt line)');

  if (!plan.ok) {
    log('REFUSED:', plan.errors.join('; '));
    return { applied: false, plan };
  }
  if (plan.willObserve) {
    log('this stage OBSERVES: sampled bank-line auto-explain cases are re-run against the challenger post-commit — evidence + receipt only, decisions untouched.');
  } else {
    log('this stage is fully dormant (off/dry_run): no challenger dispatch for this client.');
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
    reason: opts.reason || `challenger pilot staged via enable_model_challenger (${plan.from ?? 'none'}→${plan.to}; §9 decisions 2026-08-12)`,
    actorType: 'system'
  }));
  log('APPLIED:', JSON.stringify(result));
  log('VERIFY: after the next bank-line disposition sweep for this client, `select count(*) from model_challenger_runs` grows and GET /model-lanes shows runs on bank_line_disposition.');
  return { applied: true, plan, result };
};

// Only connect/run when invoked directly (so importing for tests never touches the DB).
const invokedDirectly = process.argv[1] && process.argv[1].endsWith('enable_model_challenger.js');
if (invokedDirectly) {
  const opts = parseArgv();
  const dbUrl = getFirmDatabaseUrl();
  if (!dbUrl) {
    console.error(
      '[enable-model-challenger] FAILED: no database URL.\n'
      + '  Set DATABASE_URL (or POSTGRES_URL / SUPABASE_DB_URL) to the Supabase POOLER string —\n'
      + '  host aws-0-<region>.pooler.supabase.com, port 6543, username postgres.<projectref>.\n'
      + '  The direct host (db.<ref>.supabase.co, IPv6) and the API host (<ref>.supabase.co) will time out.'
    );
    process.exit(1);
  }
  run(opts)
    .then((r) => process.exit(r.applied || !opts.apply ? 0 : 1))
    .catch((err) => { console.error('[enable-model-challenger] FAILED', err); process.exit(1); });
}
