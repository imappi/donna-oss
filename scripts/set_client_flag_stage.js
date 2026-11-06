// Generic, audited stage lever for the config control plane — THE tool for
// executing flag graduations (CLAUDE.md "rollout flags are born on the config
// control plane"; census + batches in docs/donna-flag-graduation-census.md).
//
// Stages one flag for one client (a canary row) or as the firm-wide default
// (the "global on" rung of the graduation ladder) through setClientFlagStage,
// so every change closes the prior row (history preserved) and writes an
// audit_events row (no silent config change) — the two properties a raw
// console INSERT skips.
//
// Usage (dry-run by default; nothing is written without --apply):
//   node scripts/set_client_flag_stage.js --flag CODING_AUTO_POST --client honeybee-hills-apiary-llc --stage canary --reason "graduation act 1" --apply
//   node scripts/set_client_flag_stage.js --flag CODING_AUTO_POST --firm-default --stage auto --reason "graduated global" --apply
//   node scripts/set_client_flag_stage.js --flag CODING_AUTO_POST --client honeybee-hills-apiary-llc --stage off --apply   # rollback
//
// Guard rails:
//   - exactly one of --client / --firm-default (a firm-wide row is the
//     deliberate "global on" act, never an accident of omission);
//   - stage must be one of the CONFIG_STAGES vocabulary (off|dry_run|shadow|
//     canary|auto), fail-closed otherwise;
//   - NARROW-only legacy flags (no env allowlist ⇒ TRUE, e.g.
//     RECONCILIATION_AUTO_MATCH_POLICY) are called out in the census — for
//     those, deleting env vars is the risky act, not this row; the lever
//     itself is safe either way because a DB row always narrows to its stage.

import { withFirmDbClient, getFirmDatabaseUrl } from '../server/donna/firmDb.js';
import { setClientFlagStage, CONFIG_STAGES, stageActs, stageObserves } from '../server/donna/clientConfig.js';

const DEFAULT_FIRM = 'donna-production';

export const parseArgv = (argv = process.argv.slice(2)) => {
  const out = {
    apply: false,
    firmId: DEFAULT_FIRM,
    clientId: null,
    firmDefault: false,
    flagKey: null,
    stage: null,
    reason: null
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--apply') out.apply = true;
    else if (a === '--firm-default') out.firmDefault = true;
    else if (a === '--firm') { out.firmId = argv[i + 1]; i += 1; }
    else if (a === '--client') { out.clientId = argv[i + 1]; i += 1; }
    else if (a === '--flag') { out.flagKey = argv[i + 1]; i += 1; }
    else if (a === '--stage') { out.stage = argv[i + 1]; i += 1; }
    else if (a === '--reason') { out.reason = argv[i + 1]; i += 1; }
  }
  return out;
};

// Pure plan builder (exported, unit-tested without a live DB).
export const buildFlagStagePlan = ({
  firmId, clientId = null, firmDefault = false, flagKey, stage, currentStage = null
} = {}) => {
  const errors = [];
  if (!firmId) errors.push('missing firmId');
  if (!flagKey || !String(flagKey).trim()) errors.push('missing --flag');
  if (!CONFIG_STAGES.includes(stage)) {
    errors.push(`invalid stage '${stage}' (expected one of ${CONFIG_STAGES.join('|')})`);
  }
  const hasClient = Boolean(clientId && String(clientId).trim());
  if (hasClient && firmDefault) {
    errors.push('--client and --firm-default are mutually exclusive');
  }
  if (!hasClient && !firmDefault) {
    errors.push('pick a scope: --client <id> for a canary row, or --firm-default for the firm-wide default (the deliberate "global on" act)');
  }
  const valid = CONFIG_STAGES.includes(stage);
  return {
    ok: errors.length === 0,
    errors,
    firmId,
    clientId: hasClient ? clientId : null,
    firmDefault: !hasClient && firmDefault,
    flagKey: flagKey ? String(flagKey).trim() : null,
    from: currentStage,
    to: stage,
    willChange: currentStage !== stage,
    willObserve: valid ? stageObserves(stage) : false,
    willAct: valid ? stageActs(stage) : false
  };
};

const log = (...args) => console.log('[set-client-flag-stage]', ...args);

const readCurrentStage = async (client, { firmId, clientId, flagKey }) => {
  const result = await client.query(
    `select stage from client_capability_config
      where firm_id = $1 and flag_key = $2 and valid_to is null
        and client_id is not distinct from $3`,
    [firmId, flagKey, clientId]
  );
  return result.rows[0]?.stage ?? null;
};

export const run = async (opts) => {
  const scope = { firmId: opts.firmId, clientId: opts.clientId || null, flagKey: opts.flagKey };
  const current = opts.flagKey
    ? await withFirmDbClient((client) => readCurrentStage(client, scope))
    : null;
  const plan = buildFlagStagePlan({ ...opts, currentStage: current });
  log(`flag=${plan.flagKey} firm=${plan.firmId} scope=${plan.firmDefault ? 'FIRM-DEFAULT (all clients without an own/cohort row)' : `client ${plan.clientId}`}`);
  log(`current stage: ${plan.from ?? '(none — ∅, env fallback in force)'} → target stage: ${plan.to}`);
  if (!plan.ok) {
    log('REFUSED:', plan.errors.join('; '));
    return { applied: false, plan };
  }
  if (plan.willAct) {
    log(`⚠ this stage ACTS for ${plan.firmDefault ? 'EVERY client of the firm (that has no more-specific row)' : 'this client'}.`);
  } else if (plan.willObserve) {
    log('this stage OBSERVES only (shadow): no live action.');
  } else {
    log('this stage is dormant (off/dry_run): the flag refuses for this scope — note a DB row OVERRIDES an open env canary (DB wins).');
  }
  if (!plan.willChange) log('NOTE: target equals current — re-applying records a fresh audited row.');
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
    reason: opts.reason || `staged via set_client_flag_stage (${plan.from ?? 'none'}→${plan.to})`,
    actorType: 'system'
  }));
  log('APPLIED:', JSON.stringify(result));
  log('VERIFY: select flag_key, client_id, stage, reason from client_capability_config where firm_id = $firm and flag_key = $flag and valid_to is null;');
  return { applied: true, plan, result };
};

// Only connect/run when invoked directly (importing for tests never touches the DB).
const invokedDirectly = process.argv[1] && process.argv[1].endsWith('set_client_flag_stage.js');
if (invokedDirectly) {
  const opts = parseArgv();
  if (!getFirmDatabaseUrl()) {
    log('REFUSED: no firm database configured (set DATABASE_URL).');
    process.exit(1);
  }
  run(opts)
    .then((out) => process.exit(out.applied || !opts.apply ? 0 : 1))
    .catch((err) => {
      log('ERROR:', err?.message || err);
      process.exit(1);
    });
}
