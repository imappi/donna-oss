// Enable the operator capability layer's ENFORCEMENT for a single client (canary), via
// the config control plane (migration 042 client_capability_config) — NOT raw SQL.
//
// CONTEXT (CLAUDE.md pod-safety #3): PR #729 landed the per-action capability gate
// (reviewer ≠ founder — operatorCapability.js + firmDb.assertActionCapability) wired into
// the transaction-chat and document-chat apply dispatch. It is DORMANT by default
// (envFallback () => false): the verdict is computed but a disallowed action only 403s
// once `OPERATOR_CAPABILITY_ENFORCE` is staged to a stage that ACTS (canary/auto) for the
// client. This script flips ONE client's stage — Honeybee-first, the doctrine's canary
// discipline. It writes through the audited `setClientFlagStage` writer (history-preserving
// close-then-insert + an audit_events row), so the change is reconstructable and reversible.
//
// BLAST RADIUS (deliberately small): enforcement only ever affects a principal whose
// resolved capability class is BELOW the action's required class — i.e. a scoped
// collaborator invoking a founder-only verb (sync_to_accounting / remember_* /
// recode_decided / reverse_apply) or an unassigned collaborator invoking any mutation.
// An unrestricted firm member is ALWAYS 'founder' class (operatorCapability.js), so
// flipping this can never lock the founder out of their own book. Fail-open on infra
// error: an unreadable flag never enforces, and a capability-read failure never takes
// down a live apply (assertActionCapability).
//
// SAFETY: dry-run by DEFAULT (reads + prints the plan, writes nothing). Pass --apply to
// commit. ROLLBACK: re-run with `--stage off` --apply — the gate goes dormant again
// immediately; nothing already applied is undone by this (enforcement is a pre-write
// refusal, never a mutation).
//
// SUGGESTED PRE-FLIP CHECK (the #729 handoff's recipe): run a dry-run
// `POST /operator/reverse` on the client and skim the plan, then observe a few
// collaborator applies at the dormant stage before flipping to canary.
//
// USAGE:
//   node scripts/enable_operator_capability_enforce.js                   # dry-run (Honeybee, canary)
//   DATABASE_URL='…pooler…' node scripts/enable_operator_capability_enforce.js --apply
//   … --stage shadow --apply                                             # stage without enforcing
//   … --stage off --apply                                                # rollback to dormant

import { withFirmDbClient, getFirmDatabaseUrl } from '../server/donna/firmDb.js';
import { setClientFlagStage, CONFIG_STAGES, stageActs } from '../server/donna/clientConfig.js';
import { OPERATOR_CAPABILITY_FLAG_KEY } from '../server/donna/operatorCapability.js';

const DEFAULTS = Object.freeze({
  firmId: 'donna-production',
  clientId: 'honeybee-hills-apiary-llc',
  stage: 'canary'
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

// Pure plan builder (exported, unit-tested without a live DB). Validates the request and
// describes the transition + whether the target stage ACTS (turns enforcement on).
// Fail-closed: an invalid stage or a missing client is rejected — this flag is staged
// per client on purpose (the canary discipline), never as a firm-wide default row.
export const buildEnforcementPlan = ({ firmId, clientId, stage, currentStage = null } = {}) => {
  const errors = [];
  if (!firmId) errors.push('missing firmId');
  if (!clientId) errors.push('missing clientId (stage enforcement per client — the canary discipline, no firm-wide default)');
  if (!CONFIG_STAGES.includes(stage)) errors.push(`invalid stage '${stage}' (expected one of ${CONFIG_STAGES.join('|')})`);
  const willAct = CONFIG_STAGES.includes(stage) ? stageActs(stage) : false;
  return {
    ok: errors.length === 0,
    errors,
    firmId,
    clientId,
    flagKey: OPERATOR_CAPABILITY_FLAG_KEY,
    from: currentStage,
    to: stage,
    willChange: currentStage !== stage,
    willAct                                    // true ⇒ this stage ENFORCES (canary/auto): disallowed actions 403
  };
};

const log = (...args) => console.log('[enable-operator-capability-enforce]', ...args);

const readCurrentStage = async (client, { firmId, clientId }) => {
  const result = await client.query(
    `select stage from client_capability_config
      where firm_id = $1 and flag_key = $2 and valid_to is null
        and client_id is not distinct from $3`,
    [firmId, OPERATOR_CAPABILITY_FLAG_KEY, clientId]
  );
  return result.rows[0]?.stage ?? null;
};

export const run = async (opts) => {
  const current = await withFirmDbClient((client) => readCurrentStage(client, opts));
  const plan = buildEnforcementPlan({ ...opts, currentStage: current });
  log(`flag=${plan.flagKey} firm=${plan.firmId} client=${plan.clientId}`);
  log(`current stage: ${plan.from ?? '(none — ∅, dormant)'} → target stage: ${plan.to}`);
  if (!plan.ok) {
    log('REFUSED:', plan.errors.join('; '));
    return { applied: false, plan };
  }
  if (plan.willAct) {
    log('⚠ this stage ENFORCES: a principal below an action\'s required capability class gets a 403 on apply for this client.');
    log('  (founder/member principals are never affected — they always resolve to founder class.)');
  } else {
    log('this stage does NOT enforce (off/dry_run/shadow): the gate stays dormant — verdicts computed, nothing blocked.');
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
    reason: opts.reason || `capability-enforce canary turn-on via enable_operator_capability_enforce (${plan.from ?? 'none'}→${plan.to})`,
    actorType: 'system'
  }));
  log('APPLIED:', JSON.stringify(result));
  log('VERIFY: exercise a collaborator apply on this client (a founder-only verb should 403; a reviewer verb should pass), and confirm founder applies are untouched.');
  return { applied: true, plan, result };
};

// Only connect/run when invoked directly (so importing for tests never touches the DB).
const invokedDirectly = process.argv[1] && process.argv[1].endsWith('enable_operator_capability_enforce.js');
if (invokedDirectly) {
  const opts = parseArgv();
  const dbUrl = getFirmDatabaseUrl();
  if (!dbUrl) {
    console.error(
      '[enable-operator-capability-enforce] FAILED: no database URL.\n'
      + '  Set DATABASE_URL (or POSTGRES_URL / SUPABASE_DB_URL) to the Supabase POOLER string —\n'
      + '  host aws-0-<region>.pooler.supabase.com, port 6543, username postgres.<projectref>.\n'
      + '  The direct host (db.<ref>.supabase.co, IPv6) and the API host (<ref>.supabase.co) will time out.'
    );
    process.exit(1);
  }
  run(opts)
    .then((r) => process.exit(r.applied || !opts.apply ? 0 : 1))
    .catch((err) => { console.error('[enable-operator-capability-enforce] FAILED', err); process.exit(1); });
}
