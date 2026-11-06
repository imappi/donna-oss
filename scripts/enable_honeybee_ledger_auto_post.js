// Enable the LEDGER_AUTO_POST canary for one client through the config control
// plane and optionally run the sweep to clear the accepted-but-unposted backlog
// (the "Ready to post" residue). Kari's 2026-08-06 call
// (docs/design-donna-ledger-auto-post.md): auto-reconciled must TERMINATE with
// the journal posted — this flips one client's stage row and re-drives the
// existing staged writer, never a new posting path.
//
// The flag was BORN on the control plane: there is no env pair and the env
// fallback is a constant false, so this stage row is the only way it turns on.
// Internal Donna ledger only — the sweep itself refuses external accounting
// systems regardless of stage.
//
// SAFETY: dry-run by default. Pass --apply to write the stage row; pass
// --run-sweep to execute the backlog sweep after the row is applied. Rollback:
// re-run with --stage off --apply. A dry-run never writes and never sweeps.
//
// USAGE:
//   node scripts/enable_honeybee_ledger_auto_post.js
//   DATABASE_URL='…' node scripts/enable_honeybee_ledger_auto_post.js --apply --run-sweep
//   node scripts/enable_honeybee_ledger_auto_post.js --stage off --apply

import { withFirmDbClient, getFirmDatabaseUrl } from '../server/donna/firmDb.js';
import { setClientFlagStage, readClientConfigSnapshot, CONFIG_STAGES, stageActs } from '../server/donna/clientConfig.js';
import { LEDGER_AUTO_POST_FLAG_KEY, sweepLedgerAutoPost } from '../server/donna/ledgerAutoPost.js';

const DEFAULTS = Object.freeze({
  firmId: 'donna-production',
  clientId: 'honeybee-hills-apiary-llc',
  stage: 'canary'
});

export const parseArgv = (argv = process.argv.slice(2)) => {
  const out = { apply: false, runSweep: false, ...DEFAULTS, reason: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--apply') out.apply = true;
    else if (a === '--run-sweep') out.runSweep = true;
    else if (a === '--firm') { out.firmId = argv[i + 1]; i += 1; }
    else if (a === '--client') { out.clientId = argv[i + 1]; i += 1; }
    else if (a === '--stage') { out.stage = argv[i + 1]; i += 1; }
    else if (a === '--reason') { out.reason = argv[i + 1]; i += 1; }
  }
  return out;
};

export const buildLedgerAutoPostEnablementPlan = ({ firmId, clientId, stage, currentStage = null, runSweep = false } = {}) => {
  const errors = [];
  if (!firmId) errors.push('missing firmId');
  if (!clientId) errors.push('missing clientId (refuse a firm-wide auto-post flip)');
  if (!CONFIG_STAGES.includes(stage)) errors.push(`invalid stage '${stage}' (expected one of ${CONFIG_STAGES.join('|')})`);
  const willAct = CONFIG_STAGES.includes(stage) ? stageActs(stage) : false;
  return {
    ok: errors.length === 0,
    errors,
    firmId,
    clientId,
    flagKey: LEDGER_AUTO_POST_FLAG_KEY,
    from: currentStage,
    to: stage,
    willAct,
    runSweep: Boolean(runSweep),
    willClearBacklog: Boolean(runSweep && willAct)
  };
};

const log = (...args) => console.log('[enable-ledger-auto-post]', ...args);

export const run = async (opts) => {
  const current = await withFirmDbClient((client) =>
    readClientConfigSnapshot(client, { firmId: opts.firmId, clientId: opts.clientId })
  ).catch(() => ({}));
  const currentStage = current?.[LEDGER_AUTO_POST_FLAG_KEY]?.stage || null;
  const plan = buildLedgerAutoPostEnablementPlan({ ...opts, currentStage });
  log(`flag=${plan.flagKey} firm=${plan.firmId} client=${plan.clientId}`);
  log(`stage: ${plan.from || '(none — fail-closed)'} -> ${plan.to} (acts=${plan.willAct})`);
  if (!plan.ok) {
    log('REFUSED:', plan.errors.join('; '));
    return { applied: false, swept: false, plan };
  }
  if (plan.runSweep && !plan.willAct) log('NOTE: --run-sweep requested but target stage does not act; no sweep will run.');
  if (!opts.apply) {
    log('DRY RUN — no write and no sweep. Re-run with --apply to stage the flag.');
    return { applied: false, swept: false, plan };
  }
  const result = await withFirmDbClient((client) => setClientFlagStage(client, {
    firmId: plan.firmId,
    clientId: plan.clientId,
    flagKey: plan.flagKey,
    stage: plan.to,
    source: 'manual',
    reason: opts.reason || `auto-reconciled terminates posted — Kari 2026-08-06 (${plan.from || 'none'}→${plan.to})`,
    actorType: 'system'
  }));
  log('APPLIED:', JSON.stringify(result));
  let sweep = null;
  if (plan.willClearBacklog) {
    const snapshot = await withFirmDbClient((client) =>
      readClientConfigSnapshot(client, { firmId: plan.firmId, clientId: plan.clientId })
    ).catch(() => null);
    sweep = await sweepLedgerAutoPost({ firmId: plan.firmId, clientId: plan.clientId, configSnapshot: snapshot });
    log('SWEEP:', JSON.stringify(sweep));
  }
  return { applied: true, swept: Boolean(sweep), plan, result, sweep };
};

if (import.meta.url === `file://${process.argv[1]}`) {
  const opts = parseArgv();
  if (!getFirmDatabaseUrl()) {
    console.error('[enable-ledger-auto-post] FAILED: no database URL. Set DATABASE_URL / POSTGRES_URL / SUPABASE_DB_URL.');
    process.exit(1);
  }
  run(opts)
    .then((r) => process.exit(r.applied || !opts.apply ? 0 : 1))
    .catch((err) => { console.error('[enable-ledger-auto-post] FAILED', err); process.exit(1); });
}
