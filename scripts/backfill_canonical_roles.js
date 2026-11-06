#!/usr/bin/env node
//
// Backfill ledger_accounts.canonical_role (Donna CoA architecture slice 2,
// migration 035) for rows that predate the column.
//
// Why it exists: migration 035 adds canonical_role nullable with NO SQL backfill
// on purpose — the name -> role map (SEED_NAME_ROLES) lives only in
// server/donna/accountRoles.js, and mirroring it in the migration would create a
// second, drifting source of truth. This script reads roleForSeedName directly,
// so there is exactly ONE map.
//
// What it does NOT do: it does not GUESS a role for unknown (model-proposed)
// business names. roleForSeedName returns null for those, and we leave the row
// null — a later slice has the strong model resolve them. It also never
// OVERWRITES an existing canonical_role (planCanonicalRoleBackfill skips rows that
// already have one), so a re-run is idempotent and human/model-set roles survive.
//
// Scope:
//
//   --firm  <firm_id>     defaults to donna-demo-firm
//   --client <client_id>  optional; restricts the pass to one client
//                         (default: all clients under the firm)
//   --apply               commits; default is dry-run (no writes)

import { withFirmDbClient } from '../server/donna/firmDb.js';
import { roleForSeedName } from '../server/donna/accountRoles.js';

export const parseArgv = (argv = process.argv.slice(2)) => {
  const out = { apply: false, firmId: 'donna-demo-firm', clientId: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--apply') out.apply = true;
    else if (a === '--firm') { out.firmId = argv[i + 1]; i += 1; }
    else if (a === '--client') { out.clientId = argv[i + 1]; i += 1; }
  }
  return out;
};

// Pure helper exported for tests. Given ledger_accounts rows, returns the
// { id, canonical_role } updates to apply: rows that have NO role yet AND whose
// name resolves to one of Donna's known seed roles. Rows with an existing role,
// or whose name the strong model must resolve later, are left untouched.
export const planCanonicalRoleBackfill = (accounts) => {
  if (!Array.isArray(accounts)) return [];
  const updates = [];
  for (const account of accounts) {
    if (account.canonical_role) continue; // never overwrite an existing role
    const role = roleForSeedName(account.name || account.account_name);
    if (role) updates.push({ id: account.id, canonical_role: role });
  }
  return updates;
};

const log = (...args) => console.log('[canonical-role-backfill]', ...args);

const main = async () => {
  const args = parseArgv();
  const mode = args.apply ? 'APPLY' : 'DRY-RUN';
  log(`mode=${mode} firm=${args.firmId} client=${args.clientId || '(all)'}`);

  await withFirmDbClient(async (client) => {
    const clientFilterClause = args.clientId ? 'and client_id = $2' : '';
    const params = args.clientId ? [args.firmId, args.clientId] : [args.firmId];
    const accountsResult = await client.query(
      `select id, name, canonical_role
         from ledger_accounts
        where firm_id = $1 ${clientFilterClause}
          and canonical_role is null`,
      params
    );

    const updates = planCanonicalRoleBackfill(accountsResult.rows);
    log(`scanned=${accountsResult.rows.length} resolvable=${updates.length} (rows already roled or model-only are skipped)`);

    if (args.apply) {
      for (const update of updates) {
        await client.query(
          `update ledger_accounts
              set canonical_role = $2, updated_at = now()
            where id = $1 and canonical_role is null`,
          [update.id, update.canonical_role]
        );
        log(`set ${update.canonical_role} on ${update.id}`);
      }
      log(`done: updated=${updates.length} (mode=${mode})`);
    } else {
      for (const update of updates) {
        log(`would set ${update.canonical_role} on ${update.id} (dry-run)`);
      }
      log(`done: would-update=${updates.length} (mode=${mode}); re-run with --apply to commit.`);
    }
  });
};

const isDirectInvocation = import.meta.url === `file://${process.argv[1]}`;
if (isDirectInvocation) {
  main().then(
    () => process.exit(0),
    (err) => {
      console.error('[canonical-role-backfill] FAILED', err);
      process.exit(1);
    }
  );
}
