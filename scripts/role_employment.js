// The employment-contract lever (S2 of docs/design-donna-specialist-roles.md §5)
// — hire/end a bench role and approve/revoke its standing grants, through the
// audited writers in server/donna/roles/roleEmployment.js. This is the operator
// surface until the S3 roster UI wires the same calls; it is the OWNER's pen
// (actor_type 'owner'), and every act is receipted (role.hired / role.ended /
// role.grant_approved / role.grant_revoked).
//
// INV-S10 in one sentence: `hire` stages the observe/propose/ask envelope and
// mints NOTHING; `approve-grant` is the separate, explicit act that delegates
// standing authority — ceilinged, scoped, time-bounded.
//
// SAFETY: dry-run by DEFAULT (prints the plan, writes nothing). Pass --apply
// to commit. Each apply runs in ONE transaction (write + receipts together).
//
// USAGE:
//   node scripts/role_employment.js hire --role invoicing_collections --client <id>            # dry-run
//   node scripts/role_employment.js hire --role invoicing_collections --client <id> --apply
//   node scripts/role_employment.js end  --role invoicing_collections --client <id> --reason 'pause' --apply
//   node scripts/role_employment.js approve-grant --role invoicing_collections --client <id> \
//     --shape standing_send_authority --action send_receivable_reminder \
//     --scope-key <party-id> --ceiling 500 --currency GBP --apply        # review-after defaults to 90 days
//   node scripts/role_employment.js revoke-grant --grant <grant-id> --client <id> --reason 'too broad' --apply

import { withFirmDbClient, getFirmDatabaseUrl } from '../server/donna/firmDb.js';
import { readClientConfigSnapshot } from '../server/donna/clientConfig.js';
import { findRoleDefinition, ROLE_DEFINITIONS } from '../server/donna/roles/roleRegistry.js';
import {
  compileRoleEnvelope, hireRole, endRoleAssignment, approveRoleGrant, revokeRoleGrant
} from '../server/donna/roles/roleEmployment.js';

const DEFAULT_FIRM = 'donna-production';
const DEFAULT_ACTOR = 'kari@books.example';
const DEFAULT_REVIEW_AFTER_DAYS = 90;

export const MODES = Object.freeze(['hire', 'end', 'approve-grant', 'revoke-grant']);

export const parseArgv = (argv = process.argv.slice(2)) => {
  const out = {
    mode: MODES.includes(argv[0]) ? argv[0] : null,
    apply: false,
    firmId: DEFAULT_FIRM,
    clientId: null,
    roleId: null,
    reason: null,
    actorId: DEFAULT_ACTOR,
    shape: null,
    action: null,
    scopeKind: 'counterparty',
    scopeKey: null,
    ceiling: null,
    currency: null,
    expires: null,
    reviewAfterDays: DEFAULT_REVIEW_AFTER_DAYS,
    grantId: null
  };
  for (let i = out.mode ? 1 : 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--apply') out.apply = true;
    else if (a === '--firm') { out.firmId = argv[i + 1]; i += 1; }
    else if (a === '--client') { out.clientId = argv[i + 1]; i += 1; }
    else if (a === '--role') { out.roleId = argv[i + 1]; i += 1; }
    else if (a === '--reason') { out.reason = argv[i + 1]; i += 1; }
    else if (a === '--actor') { out.actorId = argv[i + 1]; i += 1; }
    else if (a === '--shape') { out.shape = argv[i + 1]; i += 1; }
    else if (a === '--action') { out.action = argv[i + 1]; i += 1; }
    else if (a === '--scope-kind') { out.scopeKind = argv[i + 1]; i += 1; }
    else if (a === '--scope-key') { out.scopeKey = argv[i + 1]; i += 1; }
    else if (a === '--ceiling') { out.ceiling = Number(argv[i + 1]); i += 1; }
    else if (a === '--currency') { out.currency = argv[i + 1]; i += 1; }
    else if (a === '--expires') { out.expires = argv[i + 1]; i += 1; }
    else if (a === '--review-after-days') { out.reviewAfterDays = Number(argv[i + 1]); i += 1; }
    else if (a === '--grant') { out.grantId = argv[i + 1]; i += 1; }
  }
  return out;
};

const log = (...args) => console.log('[role-employment]', ...args);

const inTransaction = async (fn) => withFirmDbClient(async (client) => {
  await client.query('begin');
  try {
    const out = await fn(client);
    await client.query('commit');
    return out;
  } catch (error) {
    await client.query('rollback');
    throw error;
  }
});

export const run = async (opts) => {
  if (!opts.mode) {
    log(`REFUSED: first arg must be one of ${MODES.join(' | ')}`);
    return { applied: false };
  }
  if (!opts.clientId) {
    log('REFUSED: --client is required (employment is client-scoped)');
    return { applied: false };
  }
  const base = { firmId: opts.firmId, clientId: opts.clientId, actorType: 'owner', actorId: opts.actorId, reason: opts.reason };

  if (opts.mode === 'hire' || opts.mode === 'end') {
    const role = findRoleDefinition(opts.roleId);
    if (!role) {
      log(`REFUSED: --role must be one of ${ROLE_DEFINITIONS.map((r) => r.id).join(' | ')}`);
      return { applied: false };
    }
    if (opts.mode === 'hire') {
      const envelope = await withFirmDbClient(async (client) => compileRoleEnvelope({
        role, snapshot: await readClientConfigSnapshot(client, { firmId: opts.firmId, clientId: opts.clientId })
      }));
      log(`hire plan for '${role.id}' (${role.title}) on ${opts.clientId}:`);
      for (const f of envelope.flags) {
        log(`  ${f.flag_key}: ${f.from ?? '(unset)'} → ${f.to} [${f.action}]`);
      }
      log(`  grant shapes offered (NOT minted — INV-S10): ${envelope.grant_shapes_offered.map((g) => g.kind).join(', ') || 'none'}`);
      if (!opts.apply) { log('DRY-RUN — no write. Re-run with --apply to commit.'); return { applied: false, envelope }; }
      const out = await inTransaction((client) => hireRole(client, { ...base, roleId: role.id }));
      log('APPLIED:', JSON.stringify(out));
      return { applied: true, out };
    }
    log(`end plan: end the active '${role.id}' assignment on ${opts.clientId} (flags/grants are NOT auto-lowered; the receipt lists them).`);
    if (!opts.apply) { log('DRY-RUN — no write. Re-run with --apply to commit.'); return { applied: false }; }
    const out = await inTransaction((client) => endRoleAssignment(client, { ...base, roleId: role.id }));
    log('APPLIED:', JSON.stringify(out));
    return { applied: true, out };
  }

  if (opts.mode === 'approve-grant') {
    const expiresAt = opts.expires || null;
    const reviewAfter = expiresAt ? null : new Date(Date.now() + opts.reviewAfterDays * 86400000).toISOString();
    log(`approve plan: role '${opts.roleId}' shape '${opts.shape}' action '${opts.action}' scope ${opts.scopeKind}:${opts.scopeKey}`);
    log(`  ceiling ${opts.ceiling} ${opts.currency}; ${expiresAt ? `expires ${expiresAt}` : `review after ${reviewAfter}`}`);
    if (!opts.apply) { log('DRY-RUN — no write. Re-run with --apply to commit.'); return { applied: false }; }
    const out = await inTransaction((client) => approveRoleGrant(client, {
      ...base,
      roleId: opts.roleId,
      grantShape: opts.shape,
      actionType: opts.action,
      scopeKind: opts.scopeKind,
      scopeKey: opts.scopeKey,
      amountCeiling: opts.ceiling,
      currency: opts.currency,
      expiresAt,
      reviewAfter
    }));
    log('APPLIED:', JSON.stringify(out));
    return { applied: true, out };
  }

  // revoke-grant
  log(`revoke plan: grant '${opts.grantId}' on ${opts.clientId}`);
  if (!opts.apply) { log('DRY-RUN — no write. Re-run with --apply to commit.'); return { applied: false }; }
  const out = await inTransaction((client) => revokeRoleGrant(client, { ...base, grantId: opts.grantId }));
  log('APPLIED:', JSON.stringify(out));
  return { applied: true, out };
};

// Only connect/run when invoked directly (importing for tests never touches the DB).
const invokedDirectly = process.argv[1] && process.argv[1].endsWith('role_employment.js');
if (invokedDirectly) {
  const opts = parseArgv();
  if (!getFirmDatabaseUrl()) {
    log('REFUSED: no firm database configured (set DATABASE_URL).');
    process.exit(1);
  }
  run(opts)
    .then(() => process.exit(0))
    .catch((err) => {
      log('ERROR:', err?.message || err);
      process.exit(1);
    });
}
