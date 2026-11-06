// Stage the operational self-knowledge context pack (server/donna/selfKnowledge.js)
// for a single client, via the config control plane (migration 042
// client_capability_config) — NOT raw SQL.
//
// CONTEXT: both flags are born OFF on the plane (rollout-flags rail: envFallback
// false, never an env pair) and this lever is the only sanctioned way to stage
// them:
//   SELF_KNOWLEDGE_CONTEXT — canary/auto ACT: the versioned self-knowledge block
//     (identity + surfaces + per-client capability states + limits) is appended
//     to the owner-channel and portal-chat system prompt, and its version +
//     fingerprint ride every prompt receipt. off/dry_run/shadow: no block,
//     byte-identical prompt.
//   OWNER_PORTAL_LINK — canary/auto ACT: on a bound owner channel the model may
//     propose share_portal_link; the runtime resolves the real portal deep link
//     (/client/<id>#list) deterministically and sends it, receipted. The prompt
//     instruction for the action rides the self-knowledge block, so this flag
//     without SELF_KNOWLEDGE_CONTEXT is inert for the chat action. The flag
//     ALSO arms the deterministic sensitive-ask portal fallback (firmDb.js
//     deliverSensitiveAskPortalNotice): an ask blocked as
//     'sensitive_ask_portal_only' additionally sends the owner a safe "this
//     needs your portal" notice + deep link instead of silence (no model, no
//     question content on the channel; needs only this flag).
//
// BLAST RADIUS: prompt-context injection + owner-directed link sends (one per
// explicit owner request, plus one safe notice per blocked sensitive ask), for
// the staged client only. Delivery-ledger + audit receipts per send. No
// third-party sends. ROLLBACK: re-run with `--stage off --apply` — dormant
// immediately. CLIENT_CONFIG_FORCE_DISABLE=SELF_KNOWLEDGE_CONTEXT,OWNER_PORTAL_LINK
// kills both fleet-wide.
//
// SAFETY: dry-run by DEFAULT (prints the plan, writes nothing). Pass --apply to
// commit.
//
// USAGE:
//   node scripts/enable_self_knowledge_context.js                    # dry-run (Honeybee, canary, both flags)
//   DATABASE_URL='…pooler…' node scripts/enable_self_knowledge_context.js --apply
//   … --no-portal-link --apply                                       # context pack only
//   … --stage off --apply                                            # rollback to dormant

import { withFirmDbClient, getFirmDatabaseUrl } from '../server/donna/firmDb.js';
import { setClientFlagStage, CONFIG_STAGES, stageActs } from '../server/donna/clientConfig.js';
import { SELF_KNOWLEDGE_FLAG_KEY, OWNER_PORTAL_LINK_FLAG_KEY } from '../server/donna/selfKnowledge.js';

const DEFAULTS = Object.freeze({
  firmId: 'donna-production',
  clientId: 'honeybee-hills-apiary-llc',
  stage: 'canary',
  portalLink: true
});

export const parseArgv = (argv = process.argv.slice(2)) => {
  const out = { apply: false, ...DEFAULTS, reason: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--apply') out.apply = true;
    else if (a === '--no-portal-link') out.portalLink = false;
    else if (a === '--firm') { out.firmId = argv[i + 1]; i += 1; }
    else if (a === '--client') { out.clientId = argv[i + 1]; i += 1; }
    else if (a === '--stage') { out.stage = argv[i + 1]; i += 1; }
    else if (a === '--reason') { out.reason = argv[i + 1]; i += 1; }
  }
  return out;
};

// Pure plan builder (exported, unit-tested without a live DB). Fail-closed on an
// invalid stage or a missing client — staged per client on purpose (the canary
// discipline), never as a firm-wide default row from this lever.
export const buildSelfKnowledgePlan = ({ firmId, clientId, stage, portalLink = true, currentStages = {} } = {}) => {
  const errors = [];
  if (!firmId) errors.push('missing firmId');
  if (!clientId) errors.push('missing clientId (staged per client — the canary discipline, no firm-wide default)');
  if (!CONFIG_STAGES.includes(stage)) errors.push(`invalid stage '${stage}' (expected one of ${CONFIG_STAGES.join('|')})`);
  const valid = CONFIG_STAGES.includes(stage);
  const flagKeys = portalLink ? [SELF_KNOWLEDGE_FLAG_KEY, OWNER_PORTAL_LINK_FLAG_KEY] : [SELF_KNOWLEDGE_FLAG_KEY];
  return {
    ok: errors.length === 0,
    errors,
    firmId,
    clientId,
    flagKeys,
    from: flagKeys.map((key) => currentStages[key] ?? null),
    to: stage,
    willAct: valid ? stageActs(stage) : false
  };
};

const log = (...args) => console.log('[enable-self-knowledge]', ...args);

const readCurrentStages = async (client, { firmId, clientId }) => {
  const result = await client.query(
    `select flag_key, stage from client_capability_config
      where firm_id = $1 and flag_key = any($2::text[]) and valid_to is null
        and client_id is not distinct from $3`,
    [firmId, [SELF_KNOWLEDGE_FLAG_KEY, OWNER_PORTAL_LINK_FLAG_KEY], clientId]
  );
  const stages = {};
  for (const row of result.rows) stages[row.flag_key] = row.stage;
  return stages;
};

export const run = async (opts) => {
  const currentStages = await withFirmDbClient((client) => readCurrentStages(client, opts));
  const plan = buildSelfKnowledgePlan({ ...opts, currentStages });
  log(`firm=${plan.firmId} client=${plan.clientId} flags=${plan.flagKeys.join(',')}`);
  plan.flagKeys.forEach((key, i) => log(`  ${key}: ${plan.from[i] ?? '(none — ∅, dormant)'} → ${plan.to}`));
  if (!plan.ok) {
    log('REFUSED:', plan.errors.join('; '));
    return { applied: false, plan };
  }
  if (plan.willAct) {
    log('this stage ACTS: the self-knowledge block joins the owner prompt (version on every receipt); share_portal_link resolves and sends the real portal deep link on the owner channel.');
  } else {
    log('this stage does NOT act: no block, no action — byte-identical behaviour.');
  }
  if (!opts.apply) {
    log('DRY-RUN — no write. Re-run with --apply to commit.');
    return { applied: false, plan };
  }
  const results = [];
  for (const flagKey of plan.flagKeys) {
    const result = await withFirmDbClient((client) => setClientFlagStage(client, {
      firmId: plan.firmId,
      clientId: plan.clientId,
      flagKey,
      stage: plan.to,
      source: 'manual',
      reason: opts.reason || `self-knowledge staged via enable_self_knowledge_context (${currentStages[flagKey] ?? 'none'}→${plan.to})`,
      actorType: 'system'
    }));
    results.push(result);
    log('APPLIED:', JSON.stringify(result));
  }
  log('VERIFY: send "share me a link to the client portal" from the bound owner channel; expect a one-line self-description + the /client/<id>#list link (or the named no-base-URL instruction), and self_knowledge on the assistant message payload.');
  return { applied: true, plan, results };
};

// Only connect/run when invoked directly (so importing for tests never touches the DB).
const invokedDirectly = process.argv[1] && process.argv[1].endsWith('enable_self_knowledge_context.js');
if (invokedDirectly) {
  const opts = parseArgv();
  const dbUrl = getFirmDatabaseUrl();
  if (!dbUrl) {
    console.error(
      '[enable-self-knowledge] FAILED: no database URL.\n'
      + '  Set DATABASE_URL (or POSTGRES_URL / SUPABASE_DB_URL) to the Supabase POOLER string —\n'
      + '  host aws-0-<region>.pooler.supabase.com, port 6543, username postgres.<projectref>.'
    );
    process.exit(1);
  }
  run(opts)
    .then((r) => process.exit(r.applied || !opts.apply ? 0 : 1))
    .catch((err) => { console.error('[enable-self-knowledge] FAILED', err); process.exit(1); });
}
