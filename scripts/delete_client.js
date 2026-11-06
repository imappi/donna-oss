#!/usr/bin/env node
//
// Hard-delete ONE client and ALL of its data from a firm — the cascade delete
// + firm_facts purge + audit event, via the SAME audited path the product uses
// (deleteClientInDb). Dry-run by DEFAULT; deletes nothing until --apply.
//
// Motivating case (§E.4 / a pilot client's migration): after firm-scope isolation shipped
// and the pilot client moved off `donna-demo-firm` to `donna-production`, the demo
// clients (`honeybee-hills-apiary`, `alex-morgan-personal`) still sit under
// `donna-demo-firm`. The §E.4 guard 409s the demo firm in production, so they
// are dead weight that must be removed.
//
// ─────────────────────────────────────────────────────────────────────────────
// Why this over raw SQL or the firm-wide reset:
// ─────────────────────────────────────────────────────────────────────────────
//   • `reset_firm_fresh_onboarding.js` wipes an ENTIRE firm (every client under
//     it, preserving only firms/members/collaborators). This is SURGICAL — one
//     client at a time.
//   • `deleteClientInDb` is the exact path the product's
//     `DELETE /api/donna/firms/clients/<id>` route runs: a single
//     `delete from clients` (every client-keyed table is declared
//     `client_id ... on delete cascade`, so the cascade removes transactions,
//     documents, ledger_*, reconciliation_*, xero_*, queue_items, … in one
//     shot) PLUS `purgeFirmFactsForDeletedClient` (hard-deletes the facts this
//     client minted, so a re-upload re-teaches cleanly — see CLAUDE.md "Firm
//     memory dies with its client") PLUS a `client.delete` audit event, all in
//     ONE transaction.
//   • That HTTP route is blocked in production by the §E.4 demo-firm guard
//     (`assertFirmScopeAllowed` 409s `donna-demo-firm` unless
//     DONNA_ALLOW_DEMO_FIRM=true). This script runs LOCALLY against the pooler
//     and calls `deleteClientInDb` directly — that function does NOT call
//     `assertFirmAccess` — so it can clean the demo firm without flipping the
//     prod guard on.
//
// ─────────────────────────────────────────────────────────────────────────────
// Scope / flags (paste-safe — no angle brackets in real commands):
// ─────────────────────────────────────────────────────────────────────────────
//   --client <client_id>   REQUIRED. The single client to delete.
//   --firm <firm_id>       REQUIRED. The firm the client lives under. There is
//                          NO implicit default — deletion is destructive, so the
//                          target firm must be named explicitly.
//   --apply                actually delete. Default is a dry-run that only
//                          COUNTS what would be removed.
//   --void-xero-mirror     also VOID the client's untouched Donna BankTransaction
//                          mirrors in the live Xero org (G6-guarded) before the
//                          cascade, so a reset re-upload posts clean (the "zero
//                          orphans after a reset" proof). Off by default: the
//                          mirror clear is then DB-side only (books handed over).
//                          Only meaningful with --apply and XERO_* configured.
//
// Idempotent: a second --apply run finds no client row and deletes nothing.
// Pre-flight refuses if the client has no row under --firm (wrong firm/client,
// or already deleted), so a typo can't silently no-op as "success".
//
// Examples:
//   node scripts/delete_client.js --client honeybee-hills-apiary --firm donna-demo-firm
//   node scripts/delete_client.js --client honeybee-hills-apiary --firm donna-demo-firm --apply
//   node scripts/delete_client.js --client alex-morgan-personal  --firm donna-demo-firm --apply
//
// Pure helpers (parseArgv, validateOptions) are exported for unit testing; the
// SQL builders are reused from migrate_client_to_firm.js (single source of truth
// for the catalog discovery + count shapes). The DB-touching count/delete run
// against the live DB — dry-run before any --apply.

import { withFirmDbClient, deleteClientInDb } from '../server/donna/firmDb.js';
import {
  buildClientsCount,
  buildCountForTable,
  buildFirmFactsCount,
  discoverClientScopedTables
} from './migrate_client_to_firm.js';

export const parseArgv = (argv = process.argv.slice(2)) => {
  const out = { apply: false, client: null, firm: null, voidXeroMirror: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--apply') out.apply = true;
    else if (a === '--void-xero-mirror') out.voidXeroMirror = true;
    else if (a === '--client') { out.client = argv[i + 1]; i += 1; }
    else if (a === '--firm') { out.firm = argv[i + 1]; i += 1; }
  }
  return out;
};

// Pure. Throw on an argument combination that can't yield a safe deletion.
// --firm is mandatory ON PURPOSE: defaulting it to DEFAULT_FIRM_ID would make a
// fat-fingered command hard-delete a client from the wrong (likely default)
// firm. Returns the validated options unchanged.
export const validateOptions = (opts) => {
  if (!opts.client) throw new Error('--client <client_id> is required.');
  if (!opts.firm) {
    throw new Error('--firm <firm_id> is required (no implicit default — deletion is destructive and must name its firm).');
  }
  return opts;
};

const log = (...args) => console.log('[delete-client]', ...args);
const exec = (db, { sql, params }) => db.query(sql, params);
const countRows = async (db, builder) => Number((await exec(db, builder)).rows[0]?.n || 0);

const runScript = async (argv) => {
  const opts = validateOptions(parseArgv(argv));
  const { apply, client: clientId, firm, voidXeroMirror } = opts;
  log(`client=${clientId} firm=${firm} mode=${apply ? 'APPLY (hard delete)' : 'dry-run'}${voidXeroMirror ? ' +void-xero-mirror' : ''}`);

  // 1) Preview (read-only). Counts the clients row + the firm-scoped client
  //    tables + the client-scoped firm_facts. Held in its own short-lived pool
  //    client so the delete below runs in a fresh connection (no nesting).
  const underFirm = await withFirmDbClient(async (db) => {
    const present = await countRows(db, buildClientsCount({ from: firm, client: clientId }));
    if (present === 0) return 0;

    const tables = await discoverClientScopedTables(db);
    log(`\n— rows that would be removed (client=${clientId}, firm=${firm}) —`);
    log(`  clients: ${present}`);
    let total = present;
    for (const table of tables) {
      const n = await countRows(db, buildCountForTable({ table, from: firm, client: clientId }));
      if (n > 0) {
        total += n;
        log(`  ${table}: ${n}`);
      }
    }
    const factCount = await countRows(db, buildFirmFactsCount({ from: firm, client: clientId }));
    log(`  firm_facts (client-scoped, purged): ${factCount}`);
    total += factCount;
    log(`\n  TOTAL (firm-scoped tables, indicative): ${total} row(s)`);
    log('  NOTE: the cascade also removes client-keyed rows in tables that have no firm_id');
    log('  column; the counts above are indicative of volume, not an exhaustive manifest.');
    return present;
  });

  if (underFirm === 0) {
    log(`\nClient "${clientId}" has no row under firm "${firm}". Nothing to delete (already gone, or wrong --firm/--client).`);
    return;
  }

  if (!apply) {
    log('\nDry run complete. Re-run with --apply to HARD DELETE this client and all of its data.');
    return;
  }

  // 2) Delete via the audited product path (cascade + firm_facts purge + audit,
  //    in its own transaction). deleteClientInDb also best-effort clears the Xero
  //    BankTransaction mirror + revokes the Xero grant for this client FIRST
  //    (when XERO_* is configured), so the org stops showing as "already
  //    connected" and no mirrored BankTransactions are orphaned after the rows go.
  //    --void-xero-mirror VOIDS the untouched Donna mirrors in the org (G6-
  //    guarded) so a reset re-upload posts clean — the empirical "zero orphans
  //    after a reset" proof of the clean-offboarding guarantee. Without it, the
  //    mirror clear is DB-side only (safe; the org BankTransactions are left in
  //    place / handed over).
  log(`\n— deleting (cascade + firm_facts purge + audit, one transaction; best-effort Xero mirror ${voidXeroMirror ? 'VOID' : 'DB-clear'} + grant revoke first) —`);
  await deleteClientInDb({ firmId: firm, clientId, clearXeroMirrorAtProvider: voidXeroMirror });

  // 3) Verify the clients row is gone — the cascade is FK-driven, so an absent
  //    clients row means the dependent rows went with it.
  const remaining = await withFirmDbClient((db) => countRows(db, buildClientsCount({ from: firm, client: clientId })));
  if (remaining !== 0) {
    throw new Error(`Post-delete check failed: client "${clientId}" still has ${remaining} row(s) under "${firm}".`);
  }
  log(`\nDeleted client "${clientId}" and its data from firm "${firm}". clients row verified gone.`);
  log('Re-run the dry-run to confirm 0 remaining, or move on to the next demo client.');
};

const invokedAsScript = import.meta.url === `file://${process.argv[1]}`;
if (invokedAsScript) {
  runScript().catch((err) => {
    console.error('[delete-client] failed:', err?.message || err);
    process.exit(1);
  });
}
