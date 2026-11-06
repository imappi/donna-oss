// Re-stage a re-created client's authority plane FROM its purge receipt —
// the deliberate, loud counterpart to the fail-closed cascade.
//
// Client deletion takes the authority plane with it BY DESIGN (a reset must
// never silently re-arm authority — CLAUDE.md, 2026-08-06), and the delete
// transaction receipts what died (`client.authority_plane_purged`,
// authorityPlaneReceipt.js). What kept happening in practice (four sightings
// by 2026-08-25): the client is re-created, the operator forgets which manual
// canaries the old book carried, and the loss presents as unrelated product
// bugs. This script turns the receipt back into staging — explicitly,
// operator-invoked, audited per flag through setClientFlagStage — instead of
// widening DESKTOP_CLIENT_FLAG_SEEDS, which would re-arm authority silently
// on every reset (the exact thing the rail forbids).
//
// What it re-stages: FLAG rows only, and only the operator-staged ones
// (source != 'default' — baseline seeds re-appear on their own at
// create/boot). Grants (reconciliation_authority_grants,
// action_authority_grants) and specialist role assignments are PRINTED as a
// checklist, never auto-recreated: they carry ceilings, scopes and time
// bounds, and mechanically reviving them risks re-arming stale authority —
// re-run their own enable scripts deliberately.
//
// Usage (dry-run by default; nothing is written without --apply):
//   node scripts/restage_authority_from_purge_receipt.js --firm donna-demo-firm --client honeybee-hills-apiary-llc
//   node scripts/restage_authority_from_purge_receipt.js --firm donna-demo-firm --client honeybee-hills-apiary-llc --apply
//   # receipt under a different (old) client id, or a specific receipt:
//   ... --from-client <old-client-id> / --receipt <audit_events id>

import { withFirmDbClient, getFirmDatabaseUrl } from '../server/donna/firmDb.js';
import { setClientFlagStage } from '../server/donna/clientConfig.js';
import { AUTHORITY_PLANE_PURGE_AUDIT_ACTION } from '../server/donna/authorityPlaneReceipt.js';

const DEFAULT_FIRM = 'donna-production';

export const parseArgv = (argv = process.argv.slice(2)) => {
  const out = {
    apply: false,
    firmId: DEFAULT_FIRM,
    clientId: null,
    fromClientId: null,
    receiptId: null,
    reason: null
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--apply') out.apply = true;
    else if (a === '--firm') { out.firmId = argv[i + 1]; i += 1; }
    else if (a === '--client') { out.clientId = argv[i + 1]; i += 1; }
    else if (a === '--from-client') { out.fromClientId = argv[i + 1]; i += 1; }
    else if (a === '--receipt') { out.receiptId = argv[i + 1]; i += 1; }
    else if (a === '--reason') { out.reason = argv[i + 1]; i += 1; }
  }
  if (!out.fromClientId) out.fromClientId = out.clientId;
  return out;
};

// Pure plan builder (exported, unit-tested without a live DB).
// receipt: { id, metadata } — the purge audit row. currentStages: map of
// flag_key -> live stage on the TARGET client (null when none).
export const buildRestagePlan = ({ receipt = null, clientExists = false, currentStages = {} } = {}) => {
  const errors = [];
  if (!receipt) errors.push('no purge receipt found — nothing to re-stage from');
  if (!clientExists) errors.push('target client does not exist — create it first (this script stages, it never creates)');
  const metadata = receipt?.metadata || {};
  const flags = Array.isArray(metadata.flags) ? metadata.flags : [];
  const staged = flags.filter((f) => f && f.source !== 'default');
  const seeds = flags.filter((f) => f && f.source === 'default');
  const restage = staged.map((f) => ({
    flagKey: f.flag_key,
    stage: f.stage,
    originalSource: f.source,
    originalReason: f.reason || null,
    currentStage: currentStages[f.flag_key] ?? null,
    alreadyStaged: (currentStages[f.flag_key] ?? null) === f.stage
  }));
  return {
    ok: errors.length === 0,
    errors,
    receiptId: receipt?.id ?? null,
    restage,
    seedsInReceipt: seeds.map((f) => f.flag_key),
    // Checklist only — never auto-recreated (authority with ceilings/scopes).
    grants: Array.isArray(metadata.grants) ? metadata.grants : [],
    actionGrants: Array.isArray(metadata.action_grants) ? metadata.action_grants : [],
    roleAssignments: Array.isArray(metadata.role_assignments) ? metadata.role_assignments : []
  };
};

const log = (...args) => console.log('[restage-authority]', ...args);

const readLatestPurgeReceipt = async (client, { firmId, fromClientId, receiptId }) => {
  const result = receiptId
    ? await client.query(
        `select id, created_at, metadata from audit_events
          where firm_id = $1 and action = $2 and id = $3`,
        [firmId, AUTHORITY_PLANE_PURGE_AUDIT_ACTION, receiptId]
      )
    : await client.query(
        `select id, created_at, metadata from audit_events
          where firm_id = $1 and action = $2 and resource_id = $3
          order by created_at desc limit 1`,
        [firmId, AUTHORITY_PLANE_PURGE_AUDIT_ACTION, fromClientId]
      );
  return result.rows[0] || null;
};

const readTargetState = async (client, { firmId, clientId }) => {
  const clientRes = await client.query(
    'select id from clients where firm_id = $1 and id = $2',
    [firmId, clientId]
  );
  const stagesRes = await client.query(
    `select flag_key, stage from client_capability_config
      where firm_id = $1 and client_id = $2 and valid_to is null`,
    [firmId, clientId]
  );
  const currentStages = {};
  for (const row of stagesRes.rows) currentStages[row.flag_key] = row.stage;
  return { clientExists: Boolean(clientRes.rows.length), currentStages };
};

export const run = async (opts) => {
  if (!opts.clientId) {
    log('REFUSED: --client <id> is required (the re-created client to stage onto).');
    return { applied: false, plan: null };
  }
  const { receipt, target } = await withFirmDbClient(async (client) => ({
    receipt: await readLatestPurgeReceipt(client, opts),
    target: await readTargetState(client, opts)
  }));
  const plan = buildRestagePlan({ receipt, ...target });
  if (receipt) log(`receipt ${receipt.id} (${receipt.created_at}) for client ${opts.fromClientId}`);
  if (!plan.ok) {
    log('REFUSED:', plan.errors.join('; '));
    return { applied: false, plan };
  }
  if (!plan.restage.length) {
    log('receipt carries baseline seeds only — nothing operator-staged to restore.');
  }
  for (const row of plan.restage) {
    log(`flag ${row.flagKey}: receipt stage ${row.stage} (was ${row.originalSource}${row.originalReason ? `, "${row.originalReason}"` : ''}) — current ${row.currentStage ?? '∅'}${row.alreadyStaged ? ' [already staged — skip]' : ''}`);
  }
  if (plan.seedsInReceipt.length) log(`seed rows in receipt (re-appear on their own, not restaged): ${plan.seedsInReceipt.join(', ')}`);
  const grantCount = plan.grants.length + plan.actionGrants.length;
  if (grantCount) {
    log(`CHECKLIST — ${grantCount} grant(s) died with the client and are NOT auto-recreated (re-run their enable scripts deliberately):`);
    for (const g of plan.grants) log(`  grant ${g.id}: ${g.archetype || g.action || '?'} scope=${g.scope_kind}:${g.scope_key} ceiling=${g.amount_ceiling ?? '∅'} status=${g.status}`);
    for (const g of plan.actionGrants) log(`  action-grant ${g.id}: ${g.domain}/${g.action_type} scope=${g.scope_kind}:${g.scope_key} ceiling=${g.amount_ceiling ?? '∅'} status=${g.status}`);
  }
  if (plan.roleAssignments.length) {
    log(`CHECKLIST — bench un-hired with the client (re-hire deliberately): ${plan.roleAssignments.map((r) => r.role).join(', ')}`);
  }
  const toApply = plan.restage.filter((row) => !row.alreadyStaged);
  if (!opts.apply) {
    log(`DRY-RUN — no write. ${toApply.length} flag row(s) would be restaged. Re-run with --apply to commit.`);
    return { applied: false, plan };
  }
  const results = [];
  for (const row of toApply) {
    const result = await withFirmDbClient((client) => setClientFlagStage(client, {
      firmId: opts.firmId,
      clientId: opts.clientId,
      flagKey: row.flagKey,
      stage: row.stage,
      source: 'manual',
      reason: opts.reason || `restaged from purge receipt ${plan.receiptId}${row.originalReason ? ` (original: ${row.originalReason})` : ''}`,
      actorType: 'system'
    }));
    results.push({ flagKey: row.flagKey, stage: row.stage, result });
    log(`APPLIED: ${row.flagKey} → ${row.stage}`);
  }
  log(`done — ${results.length} flag row(s) restaged, ${plan.restage.length - toApply.length} already staged, grants/bench left to their own scripts.`);
  return { applied: true, plan, results };
};

// Only connect/run when invoked directly (importing for tests never touches the DB).
const invokedDirectly = process.argv[1] && process.argv[1].endsWith('restage_authority_from_purge_receipt.js');
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
