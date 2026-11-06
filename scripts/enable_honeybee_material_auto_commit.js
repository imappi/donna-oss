// Enable delegated material-match auto-commit for a single client (canary), via the
// config control plane (migration 042 client_capability_config) — NOT raw SQL.
//
// CONTEXT (CLAUDE.md): material reconciliation matches reach the AUTO-RECONCILED terminal
// via the matcher's already-live, fail-closed, config-staged seam — applyDelegatedAuthority
// (grant-backed) and applyMaterialAutoFyi (no-grant firm policy), wired in all five family
// orchestrators (e.g. salesInvoiceReconciliationLlm.js). Those seams are INERT in prod
// (canaries off). This script flips ONE client's flag stage to a stage that ACTS
// (canary/auto), turning the existing seam on for that client — Honeybee-first, the
// doctrine's canary discipline. It writes through the audited `setClientFlagStage` writer
// (history-preserving close-then-insert + an audit_events row), so the change is
// reconstructable and reversible.
//
// ⚠ BLAST RADIUS. The default flag RECONCILIATION_MATERIAL_AUTO_FYI is the NO-GRANT lever:
// once it acts, EVERY confident material match for this client (gates A–D pass, held ONLY
// by the materiality ceiling — delegationGateProof) auto-reconciles and FYIs the owner. It
// is bounded by the strong A–D gate proof and is fail-closed, but it is NOT scoped to one
// merchant. The SCOPED alternative is RECONCILIATION_DELEGATED_AUTHORITY (--flag), which
// only auto-accepts matches covered by an explicit minted grant (a per-scope amount_ceiling)
// — narrower, but it requires a grant to exist first (mintAuthorityGrant). Choose
// deliberately.
//
// SAFETY: dry-run by DEFAULT (reads + prints the plan, writes nothing). Pass --apply to
// commit. ROLLBACK: re-run with `--stage off` --apply (or set the flag's emergency override
// off) — the seam goes inert again immediately; nothing already auto-reconciled is undone
// by this (a correction reverses an individual match and auto-suspends its grant).
//
// USAGE:
//   node scripts/enable_honeybee_material_auto_commit.js                  # dry-run (Honeybee, material-auto-fyi, canary)
//   DATABASE_URL='…pooler…' node scripts/enable_honeybee_material_auto_commit.js --apply
//   … --flag RECONCILIATION_DELEGATED_AUTHORITY --apply                   # the scoped (grant-backed) lever instead
//   … --stage off --apply                                                 # rollback to inert

import { withFirmDbClient, getFirmDatabaseUrl } from '../server/donna/firmDb.js';
import { setClientFlagStage, CONFIG_STAGES, stageActs } from '../server/donna/clientConfig.js';
import {
  DELEGATED_AUTHORITY_FLAG_KEY,
  MATERIAL_AUTO_FYI_FLAG_KEY
} from '../server/donna/reconciliationLlmCore.js';

const DEFAULTS = Object.freeze({
  firmId: 'donna-production',
  clientId: 'honeybee-hills-apiary-llc',
  flagKey: MATERIAL_AUTO_FYI_FLAG_KEY,
  stage: 'canary'
});

const KNOWN_AUTO_COMMIT_FLAGS = Object.freeze([DELEGATED_AUTHORITY_FLAG_KEY, MATERIAL_AUTO_FYI_FLAG_KEY]);

export const parseArgv = (argv = process.argv.slice(2)) => {
  const out = { apply: false, ...DEFAULTS, reason: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--apply') out.apply = true;
    else if (a === '--firm') { out.firmId = argv[i + 1]; i += 1; }
    else if (a === '--client') { out.clientId = argv[i + 1]; i += 1; }
    else if (a === '--flag') { out.flagKey = argv[i + 1]; i += 1; }
    else if (a === '--stage') { out.stage = argv[i + 1]; i += 1; }
    else if (a === '--reason') { out.reason = argv[i + 1]; i += 1; }
  }
  return out;
};

// Pure plan builder (exported, unit-tested without a live DB). Validates the request and
// describes the transition + whether the target stage ACTS (turns the seam on). Fail-closed:
// an invalid stage or a non-auto-commit flag is rejected so the script can't silently flip
// the wrong thing live.
export const buildEnablementPlan = ({ firmId, clientId, flagKey, stage, currentStage = null } = {}) => {
  const errors = [];
  if (!firmId) errors.push('missing firmId');
  if (!clientId) errors.push('missing clientId (refuse a firm-wide default for an auto-commit flag)');
  if (!flagKey) errors.push('missing flagKey');
  if (!CONFIG_STAGES.includes(stage)) errors.push(`invalid stage '${stage}' (expected one of ${CONFIG_STAGES.join('|')})`);
  if (flagKey && !KNOWN_AUTO_COMMIT_FLAGS.includes(flagKey)) {
    errors.push(`flag '${flagKey}' is not a known auto-commit flag (${KNOWN_AUTO_COMMIT_FLAGS.join(', ')})`);
  }
  const willAct = CONFIG_STAGES.includes(stage) ? stageActs(stage) : false;
  return {
    ok: errors.length === 0,
    errors,
    firmId,
    clientId,
    flagKey,
    from: currentStage,
    to: stage,
    willChange: currentStage !== stage,
    willAct,                                  // true ⇒ this stage turns the seam ON (canary/auto)
    grantRequired: flagKey === DELEGATED_AUTHORITY_FLAG_KEY  // scoped lever needs a covering grant to do anything
  };
};

const log = (...args) => console.log('[enable-material-auto-commit]', ...args);

const readCurrentStage = async (client, { firmId, clientId, flagKey }) => {
  const result = await client.query(
    `select stage from client_capability_config
      where firm_id = $1 and flag_key = $2 and valid_to is null
        and client_id is not distinct from $3`,
    [firmId, clientId, flagKey]
  );
  return result.rows[0]?.stage ?? null;
};

export const run = async (opts) => {
  const current = await withFirmDbClient((client) => readCurrentStage(client, opts));
  const plan = buildEnablementPlan({ ...opts, currentStage: current });
  log(`flag=${plan.flagKey} firm=${plan.firmId} client=${plan.clientId}`);
  log(`current stage: ${plan.from ?? '(none — ∅, fail-closed)'} → target stage: ${plan.to}`);
  if (!plan.ok) {
    log('REFUSED:', plan.errors.join('; '));
    return { applied: false, plan };
  }
  if (plan.willAct) {
    log('⚠ this stage ACTS: the matcher seam turns ON for this client.');
    if (plan.grantRequired) {
      log('  (delegated-authority lever: only matches covered by an ACTIVE minted grant auto-accept; mint one first or nothing changes.)');
    } else {
      log('  (material-auto-fyi lever: EVERY confident material match — A–D pass, held only by materiality — auto-reconciles + FYIs the owner.)');
    }
  } else {
    log('this stage does NOT act (off/dry_run/shadow): the seam stays inert.');
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
    reason: opts.reason || `honeybee canary turn-on via enable_honeybee_material_auto_commit (${plan.from ?? 'none'}→${plan.to})`,
    actorType: 'system'
  }));
  log('APPLIED:', JSON.stringify(result));
  log('VERIFY: watch Honeybee reconcile feed for material matches flipping to auto_matched with a material_auto_fyi / delegated_authority receipt, and confirm the owner FYI dispatches.');
  return { applied: true, plan, result };
};

// Only connect/run when invoked directly (so importing for tests never touches the DB).
const invokedDirectly = process.argv[1] && process.argv[1].endsWith('enable_honeybee_material_auto_commit.js');
if (invokedDirectly) {
  const opts = parseArgv();
  const dbUrl = getFirmDatabaseUrl();
  if (!dbUrl) {
    console.error(
      '[enable-material-auto-commit] FAILED: no database URL.\n'
      + '  Set DATABASE_URL (or POSTGRES_URL / SUPABASE_DB_URL) to the Supabase POOLER string —\n'
      + '  host aws-0-<region>.pooler.supabase.com, port 6543, username postgres.<projectref>.\n'
      + '  The direct host (db.<ref>.supabase.co, IPv6) and the API host (<ref>.supabase.co) will time out.'
    );
    process.exit(1);
  }
  run(opts)
    .then((r) => process.exit(r.applied || !opts.apply ? 0 : 1))
    .catch((err) => { console.error('[enable-material-auto-commit] FAILED', err); process.exit(1); });
}
