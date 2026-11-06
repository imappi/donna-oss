// Expose ONE client (entity) to the Claude Desktop MCP surface — the
// per-entity consent write, via the config control plane (migration 042
// client_capability_config), NOT raw SQL.
//
// CONTEXT (docs/design-donna-mcp-surface.md §2): enabling MCP is an explicit
// per-entity data-routing decision, off by default. Claude (Anthropic's
// cloud) RECEIVES this entity's data inside tool results once exposed — the
// operator makes that call per entity. The PRIMARY consent path is now the
// settings "Claude access" screen (slice 2 — mcp/mcpConsent.js, owner-
// attributed); this script stays as the headless/ops fallback. Both write
// through the audited `setClientFlagStage` writer (history-preserving
// close-then-insert + an audit_events row), so the grant is reconstructable
// and revocable.
//
// SHAPE OF THE GRANT (enforced, not advisory): MCP_ENTITY_EXPOSE is in
// AUTO_FORBIDDEN_FLAGS (clientConfig.js) — a firm-default 'auto' blanket row
// is refused by the writer itself; the sanctioned shape is one
// client-specific row at 'canary' per consenting entity. No row ⇒ not
// exposed; CLIENT_CONFIG_FORCE_DISABLE kills the surface everywhere.
//
// NOTE the client-reset rail (CLAUDE.md "the authority plane rides the same
// cascade"): deleting/resetting a client takes this row with it — fail-closed
// and receipted. Re-exposing after a reset is a NEW consent, run this again.
//
// SAFETY: dry-run by DEFAULT (reads + prints the plan, writes nothing). Pass
// --apply to commit. ROLLBACK: re-run with `--stage off --apply` — the entity
// disappears from the MCP surface immediately (entity_list, and every
// entity-scoped call 404s).
//
// USAGE:
//   node scripts/enable_mcp_entity_expose.js --client <id>                # dry-run (canary)
//   DATABASE_URL='…' node scripts/enable_mcp_entity_expose.js --client <id> --apply
//   … --client <id> --stage off --apply                                  # revoke
//   … --firm donna-demo-firm --client <id> --apply                       # appliance default firm

import { withFirmDbClient, getFirmDatabaseUrl } from '../server/donna/firmDb.js';
import { setClientFlagStage, CONFIG_STAGES, stageActs } from '../server/donna/clientConfig.js';
import { MCP_ENTITY_EXPOSE_FLAG_KEY } from '../server/donna/mcp/mcpReadSurface.js';

const DEFAULTS = Object.freeze({
  firmId: 'donna-demo-firm',
  clientId: null, // no default: a data-exposure grant must NAME its entity
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

// Pure plan builder (exported, unit-tested without a live DB). Fail-closed:
// a missing client is rejected — consent names its entity, never defaults.
export const buildExposurePlan = ({ firmId, clientId, stage, currentStage = null } = {}) => {
  const errors = [];
  if (!firmId) errors.push('missing firmId');
  if (!clientId) errors.push('missing clientId (--client <id> — a data-exposure grant must name its entity)');
  if (!CONFIG_STAGES.includes(stage)) errors.push(`invalid stage '${stage}' (expected one of ${CONFIG_STAGES.join('|')})`);
  if (stage === 'auto') errors.push("stage 'auto' is refused for MCP_ENTITY_EXPOSE (AUTO_FORBIDDEN_FLAGS) — consent is per entity at 'canary'");
  const willExpose = CONFIG_STAGES.includes(stage) ? stageActs(stage) : false;
  return {
    ok: errors.length === 0,
    errors,
    firmId,
    clientId,
    flagKey: MCP_ENTITY_EXPOSE_FLAG_KEY,
    from: currentStage,
    to: stage,
    willChange: currentStage !== stage,
    willExpose // true ⇒ this entity becomes visible to Claude via the MCP surface
  };
};

const log = (...args) => console.log('[enable-mcp-entity-expose]', ...args);

const readCurrentStage = async (client, { firmId, clientId }) => {
  const result = await client.query(
    `select stage from client_capability_config
      where firm_id = $1 and flag_key = $2 and valid_to is null
        and client_id is not distinct from $3`,
    [firmId, MCP_ENTITY_EXPOSE_FLAG_KEY, clientId]
  );
  return result.rows[0]?.stage ?? null;
};

export const run = async (opts) => {
  const current = opts.clientId
    ? await withFirmDbClient((client) => readCurrentStage(client, opts))
    : null;
  const plan = buildExposurePlan({ ...opts, currentStage: current });
  log(`flag=${plan.flagKey} firm=${plan.firmId} client=${plan.clientId ?? '(none)'}`);
  log(`current stage: ${plan.from ?? '(none — ∅, not exposed)'} → target stage: ${plan.to}`);
  if (!plan.ok) {
    log('REFUSED:', plan.errors.join('; '));
    return { applied: false, plan };
  }
  if (plan.willExpose) {
    log('⚠ this stage EXPOSES the entity: Claude may receive this entity\'s data in tool results.');
    log('  (Donna still enforces read-only + receipts; disable anytime with --stage off --apply.)');
  } else {
    log('this stage does NOT expose (off/dry_run/shadow): the entity stays invisible to the MCP surface.');
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
    reason: opts.reason || `per-entity MCP exposure consent via enable_mcp_entity_expose (${plan.from ?? 'none'}→${plan.to})`,
    actorType: 'system'
  }));
  log('APPLIED:', JSON.stringify(result));
  log('VERIFY: GET /api/donna/mcp/v1/tools, then call entity_list — the entity should now appear (or be gone, after a revoke).');
  return { applied: true, plan, result };
};

// Only connect/run when invoked directly (so importing for tests never touches the DB).
const invokedDirectly = process.argv[1] && process.argv[1].endsWith('enable_mcp_entity_expose.js');
if (invokedDirectly) {
  if (!getFirmDatabaseUrl()) {
    log('DATABASE_URL is not configured — aborting.');
    process.exit(1);
  }
  run(parseArgv())
    .then((outcome) => process.exit(outcome.applied || !outcome.plan || outcome.plan.ok ? 0 : 1))
    .catch((error) => {
      log('FAILED:', error?.message || error);
      process.exit(1);
    });
}
