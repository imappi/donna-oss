// Mint a ledger-sync authority grant — the INT-6 FOUNDER ACTION (ledger-
// integrations finish plan §2 INT-6a; Kari decision #2, 2026-07-06). A grant
// is the delegated-authority receipt that lets the auto-export drain
// (inngest/ledgerAutoExport.js) push ALREADY-POSTED Donna journals to the
// client's connected accounting system unattended. It writes through the
// audited store writer (mintLedgerSyncGrant: authority boundary, mandatory
// time bound, ceiling/currency pairing, audit-on-insert), never raw SQL.
//
// ⚠ SCOPE. The grant authorizes EXPORT of already-posted journals ONLY (the
// loopExecutionPolicy GRANT_GATED_ACTIONS carve) — never coding, never
// posting, never corrections. Nothing exports until BOTH are true: this grant
// is live AND the client's LEDGER_AUTO_EXPORT config-plane flag acts (canary/
// auto; stage it with setClientFlagStage — Honeybee-first). The executor also
// refuses autonomy unless LEDGER_SYNC_CASES acts for the client (the failure
// surface must exist first).
//
// SAFETY: dry-run by DEFAULT (prints the plan, writes nothing). Pass --apply
// to commit. Time-bounding is REQUIRED (--expires or --review-after; default
// review-after is 90 days out). ROLLBACK: any export correction/reversal
// auto-suspends the grant; to stop deliberately, set LEDGER_AUTO_EXPORT off
// (or CLIENT_CONFIG_FORCE_DISABLE) — the flag kills the drain even while the
// grant is live — and/or re-run with --revoke.
//
// USAGE:
//   node scripts/mint_ledger_sync_authority_grant.js --client honeybee-hills-apiary-llc --system qbo            # dry-run
//   DATABASE_URL='…pooler…' node scripts/mint_ledger_sync_authority_grant.js --client … --system qbo --apply
//   … --ceiling 500 --currency USD --apply                # optional materiality ceiling
//   … --expires 2026-10-01T00:00:00Z --apply              # explicit expiry instead of review-after
//   … --revoke --reason 'governance no' --apply           # revoke the standing grant

import { withFirmDbClient, getFirmDatabaseUrl } from '../server/donna/firmDb.js';
import {
  LEDGER_SYNC_GRANT_SYSTEMS,
  buildLedgerSyncGrantId,
  mintLedgerSyncGrant
} from '../server/donna/ledgerSyncAuthorityGrants.js';

const DEFAULTS = Object.freeze({
  firmId: 'donna-production',
  clientId: null,
  system: null,
  ceiling: null,
  currency: null,
  expires: null,
  reviewAfterDays: 90,
  actorId: 'kari@books.example',
  revoke: false,
  reason: null
});

export const parseArgv = (argv = process.argv.slice(2)) => {
  const out = { apply: false, ...DEFAULTS };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--apply') out.apply = true;
    else if (a === '--revoke') out.revoke = true;
    else if (a === '--firm') { out.firmId = argv[i + 1]; i += 1; }
    else if (a === '--client') { out.clientId = argv[i + 1]; i += 1; }
    else if (a === '--system') { out.system = argv[i + 1]; i += 1; }
    else if (a === '--ceiling') { out.ceiling = Number(argv[i + 1]); i += 1; }
    else if (a === '--currency') { out.currency = argv[i + 1]; i += 1; }
    else if (a === '--expires') { out.expires = argv[i + 1]; i += 1; }
    else if (a === '--review-after-days') { out.reviewAfterDays = Number(argv[i + 1]); i += 1; }
    else if (a === '--actor') { out.actorId = argv[i + 1]; i += 1; }
    else if (a === '--reason') { out.reason = argv[i + 1]; i += 1; }
  }
  return out;
};

// Pure plan builder (exported, unit-tested without a live DB). Fail-closed:
// a missing client/system, an unknown system, a malformed ceiling/expiry, or
// a ceiling without a currency is REFUSED before any write.
export const buildMintPlan = ({
  firmId, clientId, system, ceiling = null, currency = null,
  expires = null, reviewAfterDays = 90, revoke = false
} = {}) => {
  const errors = [];
  if (!firmId) errors.push('missing firmId');
  if (!clientId) errors.push('missing clientId (a grant is client-scoped, never firm-wide)');
  const normalizedSystem = String(system || '').trim().toLowerCase();
  if (!LEDGER_SYNC_GRANT_SYSTEMS.includes(normalizedSystem)) {
    errors.push(`--system must be one of ${LEDGER_SYNC_GRANT_SYSTEMS.join('|')}`);
  }
  if (ceiling != null && (!Number.isFinite(Number(ceiling)) || Number(ceiling) <= 0)) {
    errors.push('--ceiling must be a positive number');
  }
  if (ceiling != null && !String(currency || '').trim()) {
    errors.push('--ceiling requires --currency (the cap must be comparable)');
  }
  let expiresAt = null;
  if (expires != null) {
    const ms = new Date(expires).getTime();
    if (!Number.isFinite(ms)) errors.push('--expires must be a valid timestamp');
    else expiresAt = new Date(ms).toISOString();
  }
  // Computed for the revoke path too: the store's mandatory time bound applies
  // to every upsert, and a review_after on a revoked row is inert.
  let reviewAfter = null;
  if (!expiresAt) {
    const days = Number(reviewAfterDays);
    if (!Number.isFinite(days) || days <= 0) errors.push('--review-after-days must be a positive number');
    else reviewAfter = new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
  }
  const grantId = errors.length === 0
    ? buildLedgerSyncGrantId({ firmId, clientId, accountingSystem: normalizedSystem, action: 'export_posted_journal' })
    : null;
  return {
    ok: errors.length === 0,
    errors,
    firmId,
    clientId,
    system: normalizedSystem,
    grantId,
    revoke: Boolean(revoke),
    status: revoke ? 'revoked' : 'active',
    ceiling: ceiling == null ? null : Number(ceiling),
    currency: currency ? String(currency).trim().toUpperCase() : null,
    expiresAt,
    reviewAfter
  };
};

const log = (...args) => console.log('[mint-ledger-sync-grant]', ...args);

export const run = async (opts) => {
  const plan = buildMintPlan(opts);
  log(`firm=${plan.firmId} client=${plan.clientId} system=${plan.system || '(none)'}`);
  if (!plan.ok) {
    log('REFUSED:', plan.errors.join('; '));
    return { applied: false, plan };
  }
  log(`grant id: ${plan.grantId}`);
  log(`status: ${plan.status}${plan.revoke ? ' (revoking the standing grant)' : ''}`);
  log(`ceiling: ${plan.ceiling == null ? '(none — bounded by time + scope only)' : `${plan.ceiling} ${plan.currency}`}`);
  log(`time bound: ${plan.expiresAt ? `expires ${plan.expiresAt}` : `review after ${plan.reviewAfter}`}`);
  if (!plan.revoke) {
    log('⚠ once LEDGER_AUTO_EXPORT acts for this client (canary/auto) the nightly drain exports');
    log('  posted-not-exported journals unattended under this grant, receipted per export.');
  }
  if (!opts.apply) {
    log('DRY-RUN — no write. Re-run with --apply to commit.');
    return { applied: false, plan };
  }
  const result = await withFirmDbClient((client) => mintLedgerSyncGrant({
    client,
    firmId: plan.firmId,
    clientId: plan.clientId,
    accountingSystem: plan.system,
    amountCeiling: plan.ceiling,
    currency: plan.currency,
    authorizedByActorType: 'firm_operator',
    authorizedByActorId: opts.actorId || DEFAULTS.actorId,
    source: 'operator_one_click',
    provenance: { minted_via: 'mint_ledger_sync_authority_grant', reason: opts.reason || null },
    status: plan.status,
    expiresAt: plan.expiresAt,
    reviewAfter: plan.reviewAfter
  }));
  if (!result) {
    log('REFUSED by the store writer (authority/time-bound/ceiling guard) — nothing written.');
    return { applied: false, plan };
  }
  log('APPLIED:', JSON.stringify(result));
  log('NEXT: stage LEDGER_SYNC_CASES then LEDGER_AUTO_EXPORT for this client (shadow→canary) via setClientFlagStage;');
  log('      watch the ledger-auto-export sweep summary and the auto_exported receipts in audit_events.');
  return { applied: true, plan, result };
};

// Only connect/run when invoked directly (so importing for tests never touches the DB).
const invokedDirectly = process.argv[1] && process.argv[1].endsWith('mint_ledger_sync_authority_grant.js');
if (invokedDirectly) {
  const opts = parseArgv();
  const dbUrl = getFirmDatabaseUrl();
  if (!dbUrl) {
    console.error(
      '[mint-ledger-sync-grant] FAILED: no database URL.\n'
      + '  Set DATABASE_URL (or POSTGRES_URL / SUPABASE_DB_URL) to the Supabase POOLER string —\n'
      + '  host aws-0-<region>.pooler.supabase.com, port 6543, username postgres.<projectref>.\n'
      + '  The direct host (db.<ref>.supabase.co, IPv6) and the API host (<ref>.supabase.co) will time out.'
    );
    process.exit(1);
  }
  run(opts)
    .then((r) => process.exit(r.applied || !opts.apply ? 0 : 1))
    .catch((err) => { console.error('[mint-ledger-sync-grant] FAILED', err); process.exit(1); });
}
