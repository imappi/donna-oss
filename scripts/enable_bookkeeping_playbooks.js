// Stage the L2 bookkeeping playbook retrieval (Slice I — bookkeepingPlaybooks.js) for a
// single client, via the config control plane (migration 042 client_capability_config) —
// NOT raw SQL.
//
// CONTEXT: `BOOKKEEPING_PLAYBOOK_RETRIEVAL` (plan §7) is fully DORMANT by default (both
// gate duals fall back to false — a new live behaviour lands off). Stage semantics:
//   shadow        — observe-only sizing: playbook selection runs on every transaction-chat
//                   turn and the would-fire match is STAMPED on the assistant message
//                   payload (`playbooks_matched`); the prompt is untouched. "How often
//                   would this fire" before it acts.
//   canary / auto — ACTS: matched playbooks are injected into the chat prompt's workspace
//                   context (they GUIDE the model's proposals — never bypass checks or
//                   authority) and stamped (`playbooks_injected`); the shadow apply
//                   receipt's `playbooks_used` renders that persisted stamp.
//
// BLAST RADIUS: prompt context only. Injection adds curated guidance to the transaction
// chat's workspace context for RECOGNIZED patterns (stripe payouts first); every
// deterministic check, the capability gate, and the authority envelope refuse exactly as
// without it. No mutation path changes. Fail-open direction is CLOSED: an unreadable
// flag or config-read failure means no injection.
//
// SAFETY: dry-run by DEFAULT (reads + prints the plan, writes nothing). Pass --apply to
// commit. ROLLBACK: re-run with `--stage off --apply` — fully dormant again immediately;
// nothing persisted is undone by this (stamps and receipts are records, not behaviour).
//
// USAGE:
//   node scripts/enable_bookkeeping_playbooks.js                    # dry-run (Honeybee, shadow)
//   DATABASE_URL='…pooler…' node scripts/enable_bookkeeping_playbooks.js --apply
//   … --stage canary --apply                                        # inject into the prompt
//   … --stage off --apply                                           # rollback to dormant

import { withFirmDbClient, getFirmDatabaseUrl } from '../server/donna/firmDb.js';
import { setClientFlagStage, CONFIG_STAGES, stageActs, stageObserves } from '../server/donna/clientConfig.js';
import { BOOKKEEPING_PLAYBOOK_FLAG_KEY } from '../server/donna/bookkeepingPlaybooks.js';

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

// Pure plan builder (exported, unit-tested without a live DB). Same shape as the
// capability-enforce lever: fail-closed on an invalid stage or a missing client —
// this flag is staged per client on purpose (the canary discipline), never as a
// firm-wide default row.
export const buildPlaybookStagePlan = ({ firmId, clientId, stage, currentStage = null } = {}) => {
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
    flagKey: BOOKKEEPING_PLAYBOOK_FLAG_KEY,
    from: currentStage,
    to: stage,
    willChange: currentStage !== stage,
    willObserve: valid ? stageObserves(stage) : false, // selection runs + would-fire stamp
    willAct: valid ? stageActs(stage) : false          // matched playbooks injected into the prompt
  };
};

const log = (...args) => console.log('[enable-bookkeeping-playbooks]', ...args);

const readCurrentStage = async (client, { firmId, clientId }) => {
  const result = await client.query(
    `select stage from client_capability_config
      where firm_id = $1 and flag_key = $2 and valid_to is null
        and client_id is not distinct from $3`,
    [firmId, BOOKKEEPING_PLAYBOOK_FLAG_KEY, clientId]
  );
  return result.rows[0]?.stage ?? null;
};

export const run = async (opts) => {
  const current = await withFirmDbClient((client) => readCurrentStage(client, opts));
  const plan = buildPlaybookStagePlan({ ...opts, currentStage: current });
  log(`flag=${plan.flagKey} firm=${plan.firmId} client=${plan.clientId}`);
  log(`current stage: ${plan.from ?? '(none — ∅, dormant)'} → target stage: ${plan.to}`);
  if (!plan.ok) {
    log('REFUSED:', plan.errors.join('; '));
    return { applied: false, plan };
  }
  if (plan.willAct) {
    log('⚠ this stage ACTS: matched playbooks are INJECTED into the transaction-chat prompt for this client (guides proposals — checks and authority unchanged).');
  } else if (plan.willObserve) {
    log('this stage OBSERVES only: selection runs and stamps playbooks_matched on the message payload; the prompt is untouched.');
  } else {
    log('this stage is fully dormant (off/dry_run): no selection, no stamp, no injection.');
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
    reason: opts.reason || `playbook retrieval staged via enable_bookkeeping_playbooks (${plan.from ?? 'none'}→${plan.to})`,
    actorType: 'system'
  }));
  log('APPLIED:', JSON.stringify(result));
  log('VERIFY: send a transaction-chat message on a Stripe-descriptor line for this client and check the assistant message payload for playbooks_matched (shadow) / playbooks_injected (canary).');
  return { applied: true, plan, result };
};

// Only connect/run when invoked directly (so importing for tests never touches the DB).
const invokedDirectly = process.argv[1] && process.argv[1].endsWith('enable_bookkeeping_playbooks.js');
if (invokedDirectly) {
  const opts = parseArgv();
  const dbUrl = getFirmDatabaseUrl();
  if (!dbUrl) {
    console.error(
      '[enable-bookkeeping-playbooks] FAILED: no database URL.\n'
      + '  Set DATABASE_URL (or POSTGRES_URL / SUPABASE_DB_URL) to the Supabase POOLER string —\n'
      + '  host aws-0-<region>.pooler.supabase.com, port 6543, username postgres.<projectref>.\n'
      + '  The direct host (db.<ref>.supabase.co, IPv6) and the API host (<ref>.supabase.co) will time out.'
    );
    process.exit(1);
  }
  run(opts)
    .then((r) => process.exit(r.applied || !opts.apply ? 0 : 1))
    .catch((err) => { console.error('[enable-bookkeeping-playbooks] FAILED', err); process.exit(1); });
}
