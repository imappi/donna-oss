#!/usr/bin/env node
//
// Move ONE client's books from a source firm to a destination firm by
// repointing `firm_id`. The motivating case: a pilot client was connected and
// written-back under `donna-demo-firm` (the DEFAULT_FIRM_ID), and §E.4 makes
// the demo firm a production hard-fail — so the client's data must live under a real
// firm. See CLAUDE.md "Firm memory dies with its client" and the §E.4 isolation
// rail.
//
// ─────────────────────────────────────────────────────────────────────────────
// READ FIRST — prefer a clean re-onboard when you can.
// ─────────────────────────────────────────────────────────────────────────────
// An in-place `firm_id` rewrite is the RISKY path. The firm-scoped LEARNING
// tables (firm_facts, merchants, merchant_aliases) are SHARED across all of the
// source firm's clients, so a single client's slice is entangled with the demo
// firm's other books. The lower-risk, rail-aligned path is usually:
//
//   1. Create the destination firm + its firm_members (operators).
//   2. Create the client fresh under it (createClientInDb / the firms UI).
//   3. Re-upload the statements/documents; let the pipeline re-parse,
//      re-reconcile, re-code. Facts re-teach cleanly (they are client-keyed).
//   4. Set DONNA_DEFAULT_FIRM_ID=<destination firm> in prod and delete the
//      stale demo-firm copy of the client.
//
// The client was recently reset and carries a small book + a single validated
// write-back, so a re-onboard is cheap. Use THIS script only when you must
// preserve the exact existing rows (ledger history, audit trail, the live
// xero_connections row) in place.
//
// ─────────────────────────────────────────────────────────────────────────────
// What this script DOES (in one transaction under --apply):
// ─────────────────────────────────────────────────────────────────────────────
//   • Repoints `clients.firm_id` for the client row (matched by id).
//   • Repoints `firm_id` for EVERY table that has both a `firm_id` and a
//     `client_id` column (discovered live from information_schema, so it can't
//     drift as migrations add tables), scoped `WHERE client_id=<client> AND
//     firm_id=<from>`. That is the ~36 client-scoped tables: documents,
//     transactions, ledger_*, close_*, reconciliation_*, xero_*, qbo_*,
//     document_*, client_*, audit_events, etc.
//   • Repoints CLIENT-SCOPED firm_facts (provenance->>'client_id' = client).
//   • COPIES the source firm's active firm_members to the destination firm
//     (idempotent; on conflict do nothing) so the new firm is accessible.
//
// All intra-client foreign keys (transactions→documents, ledger_lines→journals,
// reconciliation_matches→…) key on ids, NOT firm_id, so they survive the
// repoint untouched. No composite (firm_id, client_id) FK exists, so update
// order is FK-irrelevant; the destination firm just has to exist first.
//
// What this script DOES NOT migrate (printed as a NOT-MIGRATED warning):
//   • Shared firm catalog: merchants, merchant_aliases (firm-wide, no client_id).
//   • Non-client-scoped firm_facts (firm / jurisdiction / merchant scope) —
//     these were learned across the firm's clients; decide per-fact.
//   • firm_collaborators rows (firm-level; their client_assignments ARE
//     repointed, but the collaborator row itself stays under <from> — review if
//     a collaborator needs access to the destination firm).
//
// Scope / flags:
//   --client <client_id>   REQUIRED. The single client to move.
//   --from <firm_id>       source firm. Default: donna-demo-firm.
//   --to <firm_id>         REQUIRED for --apply. Destination firm (must already
//                          exist in `firms` and must differ from --from).
//   --no-copy-members      skip copying active firm_members to the destination.
//   --no-firm-facts        skip repointing client-scoped firm_facts.
//   --apply                commit inside a transaction; default is a dry-run
//                          that only COUNTS what would move.
//
// Idempotent: a second --apply run moves 0 rows (nothing left under <from> for
// the client). Pre-flight refuses if the destination firm is missing, the
// client is not under <from>, or --from === --to.
//
// Pure helpers (argv parsing, validation, the SQL builders, the table-name
// guard) are exported for unit testing; the DB-touching discovery/count/apply
// run against the live DB in dry-run mode before any --apply.

import { withFirmDbClient } from '../server/donna/firmDb.js';

const DEFAULT_FROM_FIRM = 'donna-demo-firm';

// Firm-scoped tables (firm_id, NO client_id) that this script handles
// explicitly or deliberately leaves alone. Documented here so the gap is
// visible, not silent.
export const FIRM_SCOPED_TABLES = {
  handled: ['clients', 'firm_facts', 'firm_members'],
  not_migrated: ['merchants', 'merchant_aliases', 'firm_collaborators']
};

export const parseArgv = (argv = process.argv.slice(2)) => {
  const out = {
    apply: false,
    client: null,
    from: DEFAULT_FROM_FIRM,
    to: null,
    copyMembers: true,
    includeFirmFacts: true
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--apply') out.apply = true;
    else if (a === '--no-copy-members') out.copyMembers = false;
    else if (a === '--no-firm-facts') out.includeFirmFacts = false;
    else if (a === '--client') { out.client = argv[i + 1]; i += 1; }
    else if (a === '--from') { out.from = argv[i + 1]; i += 1; }
    else if (a === '--to') { out.to = argv[i + 1]; i += 1; }
  }
  return out;
};

// Pure. Throw on an argument combination that can't yield a safe migration.
// Returns the validated options unchanged. `requireDestination` is false for a
// dry-run (you can preview a move before you've created the destination firm).
export const validateOptions = (opts, { requireDestination = opts.apply } = {}) => {
  if (!opts.client) throw new Error('--client <client_id> is required.');
  if (requireDestination && !opts.to) throw new Error('--to <firm_id> is required to apply the migration.');
  if (opts.to && opts.to === opts.from) {
    throw new Error(`--from and --to are the same firm (${opts.from}); nothing to move.`);
  }
  return opts;
};

// Postgres identifiers can't be parameterized, so table names from the catalog
// are validated against a strict pattern before interpolation. Belt-and-braces:
// the names already come from information_schema, never user input.
const SAFE_IDENTIFIER = /^[a-z_][a-z0-9_]*$/;
export const assertSafeTableName = (name) => {
  if (!SAFE_IDENTIFIER.test(String(name || ''))) {
    throw new Error(`Unsafe table identifier from catalog: ${JSON.stringify(name)}`);
  }
  return name;
};

// Pure SQL builders (exported for tests). Each returns { sql, params }.

// Discover every table carrying BOTH firm_id and client_id — the client-scoped
// set we repoint uniformly. `clients` (firm_id only) and `firm_facts` (firm_id
// only) are handled separately and never appear here.
export const buildClientScopedTableDiscovery = () => ({
  sql: `select c.table_name
          from information_schema.columns c
         where c.table_schema = 'public'
           and c.column_name = 'firm_id'
           and exists (
             select 1 from information_schema.columns c2
              where c2.table_schema = 'public'
                and c2.table_name = c.table_name
                and c2.column_name = 'client_id'
           )
         order by c.table_name`,
  params: []
});

export const buildCountForTable = ({ table, from, client }) => ({
  sql: `select count(*)::int as n from ${assertSafeTableName(table)} where client_id = $1 and firm_id = $2`,
  params: [client, from]
});

export const buildRepointForTable = ({ table, from, to, client }) => ({
  sql: `update ${assertSafeTableName(table)} set firm_id = $1 where client_id = $2 and firm_id = $3`,
  params: [to, client, from]
});

export const buildClientsCount = ({ from, client }) => ({
  sql: 'select count(*)::int as n from clients where id = $1 and firm_id = $2',
  params: [client, from]
});

export const buildClientsRepoint = ({ from, to, client }) => ({
  sql: 'update clients set firm_id = $1, updated_at = now() where id = $2 and firm_id = $3',
  params: [to, client, from]
});

export const buildFirmFactsCount = ({ from, client }) => ({
  sql: `select count(*)::int as n from firm_facts
         where firm_id = $1 and provenance->>'client_id' = $2`,
  params: [from, client]
});

export const buildFirmFactsRepoint = ({ from, to, client }) => ({
  sql: `update firm_facts set firm_id = $1, updated_at = now()
         where firm_id = $2 and provenance->>'client_id' = $3`,
  params: [to, from, client]
});

// Copy the source firm's ACTIVE members to the destination so the new firm is
// reachable. Deterministic id (firm + email hash) + on-conflict keep this
// idempotent and collision-free against the unique (firm_id, email).
export const buildMemberCopy = ({ from, to }) => ({
  sql: `insert into firm_members
          (id, firm_id, user_id, email, name, role, status, access_level, metadata, created_at, updated_at)
        select $1 || '::' || md5(lower(email)), $1, user_id, email, name, role, status, access_level, metadata, now(), now()
          from firm_members
         where firm_id = $2 and status = 'active'
        on conflict (firm_id, email) do nothing`,
  params: [to, from]
});

export const buildDestinationFirmExists = (to) => ({
  sql: 'select 1 from firms where id = $1',
  params: [to]
});

const log = (...args) => console.log('[migrate-client-to-firm]', ...args);

// DB helpers ------------------------------------------------------------------

// Run a { sql, params } builder result against a pg client.
const exec = (db, { sql, params }) => db.query(sql, params);

export const discoverClientScopedTables = async (client) => {
  const { sql, params } = buildClientScopedTableDiscovery();
  const result = await client.query(sql, params);
  return result.rows.map((r) => assertSafeTableName(r.table_name));
};

const countRows = async (client, builder) => {
  const result = await exec(client, builder);
  return Number(result.rows[0]?.n || 0);
};

const runScript = async (argv) => {
  const opts = validateOptions(parseArgv(argv), { requireDestination: false });
  const { apply, client: clientId, from, to, copyMembers, includeFirmFacts } = opts;
  log(`client=${clientId} from=${from} to=${to || '(unset)'} mode=${apply ? 'APPLY' : 'dry-run'}`);
  if (apply) validateOptions(opts, { requireDestination: true });

  await withFirmDbClient(async (db) => {
    // Pre-flight: the client must live under <from>. Row counts are all about
    // the SOURCE, so a dry-run preview does NOT need the destination to exist —
    // we only warn there, and hard-fail on the missing destination at --apply
    // (the repoint can't target a firm that isn't in `firms`).
    const underFrom = await countRows(db, buildClientsCount({ from, client: clientId }));
    if (underFrom === 0) {
      log(`\nClient "${clientId}" has no row under firm "${from}". Nothing to migrate (already moved, or wrong --from/--client).`);
      return;
    }
    let destinationExists = true;
    if (to) {
      const exists = await exec(db, buildDestinationFirmExists(to));
      destinationExists = exists.rows.length > 0;
      if (!destinationExists && apply) {
        throw new Error(`Destination firm "${to}" does not exist in \`firms\`. Create it first (it must exist before the repoint).`);
      }
    }

    const tables = await discoverClientScopedTables(db);
    log(`\nDiscovered ${tables.length} client-scoped table(s) (firm_id + client_id).`);

    // Count what would move, per table.
    let totalRows = underFrom; // the clients row itself
    log(`\n— rows to move (client=${clientId}, from=${from}) —`);
    log(`  clients: ${underFrom}`);
    for (const table of tables) {
      const n = await countRows(db, buildCountForTable({ table, from, client: clientId }));
      if (n > 0) {
        totalRows += n;
        log(`  ${table}: ${n}`);
      }
    }
    let factCount = 0;
    if (includeFirmFacts) {
      factCount = await countRows(db, buildFirmFactsCount({ from, client: clientId }));
      log(`  firm_facts (client-scoped): ${factCount}`);
      totalRows += factCount;
    }
    log(`\n  TOTAL rows to repoint: ${totalRows}`);

    log(`\n— NOT migrated (review manually) —`);
    log(`  shared catalog: ${FIRM_SCOPED_TABLES.not_migrated.join(', ')}`);
    log(`  non-client-scoped firm_facts (firm/jurisdiction/merchant scope)`);
    if (copyMembers) log(`\n  members: active firm_members from "${from}" will be COPIED to "${to || '<to>'}"`);
    else log(`\n  members: NOT copied (--no-copy-members) — the destination firm may be inaccessible`);

    if (!apply) {
      if (to && !destinationExists) {
        log(`\n  NOTE: destination firm "${to}" does not exist yet — create the \`firms\` row before --apply.`);
      }
      log(`\nDry run complete. Re-run with --to <firm_id> --apply to commit.`);
      return;
    }

    log(`\n— applying (transaction) —`);
    await db.query('begin');
    try {
      await exec(db, buildClientsRepoint({ from, to, client: clientId }));
      for (const table of tables) {
        await exec(db, buildRepointForTable({ table, from, to, client: clientId }));
      }
      if (includeFirmFacts) {
        await exec(db, buildFirmFactsRepoint({ from, to, client: clientId }));
      }
      if (copyMembers) {
        await exec(db, buildMemberCopy({ from, to }));
      }

      // Verify: nothing for the client must remain under <from>.
      const remaining = await countRows(db, buildClientsCount({ from, client: clientId }));
      let remainingChild = 0;
      for (const table of tables) {
        remainingChild += await countRows(db, buildCountForTable({ table, from, client: clientId }));
      }
      if (remaining !== 0 || remainingChild !== 0) {
        throw new Error(`Post-migration check failed: ${remaining} client row(s) + ${remainingChild} child row(s) still under "${from}". Rolling back.`);
      }

      await db.query('commit');
      log(`\nMigration committed. Repointed ${totalRows} row(s) for client "${clientId}" to firm "${to}".`);
      log(`\nNext steps:`);
      log(`  1. Set DONNA_DEFAULT_FIRM_ID=${to} in the production env (applies to deploys created AFTER the change).`);
      log(`  2. Spot-check the firms snapshot for "${to}" and the live xero_connections row.`);
      log(`  3. Review the NOT-migrated items above (shared catalog, firm-scoped facts, collaborators).`);
    } catch (err) {
      await db.query('rollback').catch(() => {});
      throw err;
    }
  });
};

const invokedAsScript = import.meta.url === `file://${process.argv[1]}`;
if (invokedAsScript) {
  runScript().catch((err) => {
    console.error('[migrate-client-to-firm] failed:', err?.message || err);
    process.exit(1);
  });
}
