#!/usr/bin/env node
//
// Repair transactions that carry `reconciliation_status='reconciled'`
// (or `auto_reconciled`) but have NO corresponding row in
// `reconciliation_matches` with `bank_transaction_id = tx.id` AND
// `status IN ('confirmed', 'auto_matched')`. Those are orphans: the
// match record that justified the reconciled state is gone, but the
// transaction state never got unwound.
//
// Three known ways the orphan state arrives:
//
//   1. A confirmed `reconciliation_matches` row was deleted (via
//      document delete, replace, or duplicate-mark) without the
//      symmetric unwind that this PR adds to the four deletion sites.
//      Future deletions can't reintroduce this — the
//      __unwindTransactionMatchesForDocumentWithClient helper now runs
//      synchronously alongside every such delete.
//
//   2. `scripts/promote_matches.js` stamps `reconciliation_status` and
//      writes `{reconciliation_status, support_status}` to payload
//      without writing `reconciliation_match_object_id`. Txns from
//      that path can't be found by the document-scoped helper — they
//      need this broader orphan-detection pass. Discovered during the
//      honeybee-hills-apiary 15-NO-MATCH investigation (June 2026).
//
//   3. The match row SURVIVED its document's deletion (the
//      duplicate-replace and /documents/sync replacement paths
//      deleted docs without deleting their match rows until the June
//      2026 Honeybee reupload investigation). A dangling
//      confirmed/auto_matched row shields its transaction from
//      detection shape 1/2 AND keeps suppressing the bank line for
//      every future matcher run. This script now runs a
//      dangling-match phase first: delete match rows whose
//      matched_object_id no longer exists in documents, then repair
//      the transactions they were shielding — one run, both layers.
//
// Repair semantics:
//
//   - Find transactions where reconciliation_status IN ('reconciled',
//     'auto_reconciled') AND no row in reconciliation_matches has
//     bank_transaction_id = tx.id AND status IN ('confirmed',
//     'auto_matched').
//   - Reset reconciliation_status -> 'needs_review'
//   - Clear reconciled_at
//   - Strip the four reconciliation_match_* keys from payload
//     (symmetric inverse of the confirm path at firmDb.js:2762-2779)
//   - Write an audit event per repaired row with the prior state
//     (reconciliation_status, reconciled_at, the payload keys that
//     were stripped) so the original intent is recoverable from
//     history.
//
// Scope:
//
//   --firm  <firm_id>     required when --apply is set; defaults to
//                         donna-demo-firm
//   --client <client_id>  optional; restricts the pass to one client
//   --apply               commits inside a transaction; default is
//                         dry-run with no writes
//
// Idempotent: a second run finds zero rows.
//
// Pure helpers (orphan detection SQL params, repair payload shape,
// audit metadata) are exported for unit testing.

import { withFirmDbClient } from '../server/donna/firmDb.js';

const PAYLOAD_KEYS_STRIPPED = [
  'reconciliation_match_id',
  'reconciliation_match_type',
  'reconciliation_match_object_id',
  'reconciliation_status'
];

const REPAIR_SOURCE = 'orphaned_reconciled_transaction_repair_v1';

const parseArgv = (argv = process.argv.slice(2)) => {
  const out = { apply: false, firmId: 'donna-demo-firm', clientId: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--apply') out.apply = true;
    else if (a === '--firm') { out.firmId = argv[i + 1]; i += 1; }
    else if (a === '--client') { out.clientId = argv[i + 1]; i += 1; }
  }
  return out;
};

const log = (...args) => console.log('[orphan-tx-repair]', ...args);

const formatIsoDate = (value) => {
  if (value == null) return '(none)';
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return '(invalid)';
    return value.toISOString().slice(0, 19).replace('T', ' ');
  }
  return String(value).slice(0, 19).replace('T', ' ');
};

// Pure helper exported for tests. Builds the audit metadata block we
// stamp per repaired row. Mirrors the prior-state snapshot pattern
// used by repair_dangling_duplicate_pointers.js.
export const buildRepairAudit = (row) => ({
  script: 'repair_orphaned_reconciled_transactions.js',
  source: REPAIR_SOURCE,
  prior_state: {
    reconciliation_status: row.reconciliation_status,
    reconciled_at: row.reconciled_at instanceof Date
      ? row.reconciled_at.toISOString()
      : row.reconciled_at || null,
    payload_keys_stripped: PAYLOAD_KEYS_STRIPPED.filter((k) =>
      row.payload && Object.prototype.hasOwnProperty.call(row.payload, k)
    )
  },
  changed_at: new Date().toISOString(),
  changed_by: 'system'
});

// Pure helper exported for tests. Returns the SQL fragment used to
// strip the four reconciliation_match_* keys from a transaction
// payload (symmetric inverse of the confirm path's payload write at
// firmDb.js:2762-2779).
export const payloadStripFragment = () =>
  PAYLOAD_KEYS_STRIPPED.map((k) => `- '${k}'`).join('\n              ');

// Pure helper exported for tests. Audit metadata for a deleted
// dangling match row — mirrors buildRepairAudit's prior-state
// snapshot so the original match is recoverable from history.
export const buildDanglingMatchAudit = (row) => ({
  script: 'repair_orphaned_reconciled_transactions.js',
  source: REPAIR_SOURCE,
  prior_state: {
    status: row.status,
    bank_transaction_id: row.bank_transaction_id,
    matched_object_type: row.matched_object_type,
    matched_object_id: row.matched_object_id,
    match_amount: row.match_amount ?? null,
    match_confidence: row.match_confidence ?? null
  },
  reason: 'matched_object_id no longer exists in documents',
  changed_at: new Date().toISOString(),
  changed_by: 'system'
});

// Orphan shape 3: match rows pointing at deleted documents. Any
// status qualifies — a dangling row is meaningless without its doc,
// and confirmed/auto rows actively suppress their bank line.
export const detectDanglingMatches = async (client, { firmId, clientId }) => {
  const params = [firmId];
  let clientFilter = '';
  if (clientId) {
    params.push(clientId);
    clientFilter = ' and rm.client_id = $2';
  }
  const result = await client.query(
    `select rm.id, rm.firm_id, rm.client_id, rm.bank_transaction_id,
            rm.matched_object_type, rm.matched_object_id, rm.status,
            rm.match_amount, rm.match_confidence
       from reconciliation_matches rm
      where rm.firm_id = $1${clientFilter}
        and not exists (
          select 1 from documents d where d.id = rm.matched_object_id
        )
      order by rm.id`,
    params
  );
  return result.rows;
};

// Orphan shapes 1 + 2 + the transactions shielded by shape 3: a
// confirmed/auto match row only counts as justification when its
// document still exists — a dangling row (deleted doc) must not
// shield its transaction from repair. The dangling rows themselves
// are deleted by the phase above before this repair applies.
export const detectOrphans = async (client, { firmId, clientId }) => {
  const params = [firmId];
  let clientFilter = '';
  if (clientId) {
    params.push(clientId);
    clientFilter = ' and t.client_id = $2';
  }
  const result = await client.query(
    `select t.id, t.firm_id, t.client_id, t.transaction_date,
            t.description, t.money_out, t.money_in,
            t.reconciliation_status, t.reconciled_at, t.payload
       from transactions t
      where t.firm_id = $1${clientFilter}
        and t.reconciliation_status in ('reconciled', 'auto_reconciled')
        and not exists (
          select 1 from reconciliation_matches rm
           where rm.firm_id = t.firm_id
             and rm.bank_transaction_id = t.id
             and rm.status in ('confirmed', 'auto_matched')
             and exists (
               select 1 from documents d where d.id = rm.matched_object_id
             )
        )
      order by t.transaction_date, t.id`,
    params
  );
  return result.rows;
};

const applyDanglingDelete = async (client, row) => {
  const deleted = await client.query(
    `delete from reconciliation_matches
      where firm_id = $1 and id = $2
      returning id`,
    [row.firm_id, row.id]
  );
  if (!deleted.rows.length) return false;
  await client.query(
    `insert into audit_events
       (firm_id, client_id, actor_type, action, resource_type, resource_id, metadata)
     values ($1, $2, 'system', 'reconciliation_match.dangling_deleted', 'reconciliation_match', $3, $4::jsonb)`,
    [row.firm_id, row.client_id, row.id, JSON.stringify(buildDanglingMatchAudit(row))]
  );
  return true;
};

const applyRepair = async (client, row) => {
  const updated = await client.query(
    `update transactions
        set reconciliation_status = 'needs_review',
            reconciled_at = null,
            payload = payload
              ${payloadStripFragment()},
            updated_at = now()
      where firm_id = $1
        and id = $2
        and reconciliation_status in ('reconciled', 'auto_reconciled')
      returning id`,
    [row.firm_id, row.id]
  );
  if (!updated.rows.length) return false;
  await client.query(
    `insert into audit_events
       (firm_id, client_id, actor_type, action, resource_type, resource_id, metadata)
     values ($1, $2, 'system', 'transaction.orphaned_reconciled_repaired', 'transaction', $3, $4::jsonb)`,
    [row.firm_id, row.client_id, row.id, JSON.stringify(buildRepairAudit(row))]
  );
  return true;
};

const runScript = async (argv) => {
  const { apply, firmId, clientId } = parseArgv(argv);
  log(`firm=${firmId} client=${clientId || '(all)'} mode=${apply ? 'APPLY' : 'dry-run'}`);

  await withFirmDbClient(async (client) => {
    const danglingMatches = await detectDanglingMatches(client, { firmId, clientId });
    const orphans = await detectOrphans(client, { firmId, clientId });

    if (!danglingMatches.length && !orphans.length) {
      log(`\nNo dangling matches or orphaned reconciled transactions found. Exiting.`);
      return;
    }

    if (danglingMatches.length) {
      log(`\n— ${danglingMatches.length} dangling match row(s) (document deleted) —`);
      for (const row of danglingMatches) {
        log(`  ${row.id}`);
        log(`    status:      ${row.status} → CHANGE: deleted`);
        log(`    bank tx:     ${row.bank_transaction_id}`);
        log(`    pointed at:  ${row.matched_object_type} ${row.matched_object_id} (gone)`);
      }
    }

    if (orphans.length) {
      log(`\n— ${orphans.length} orphaned reconciled transaction(s) —`);
      for (const row of orphans) {
        log(`  ${row.id}`);
        log(`    date:        ${formatIsoDate(row.transaction_date)}`);
        log(`    description: ${row.description}`);
        const amount = row.money_out != null && Number(row.money_out) > 0
          ? `out ${row.money_out}`
          : `in ${row.money_in}`;
        log(`    amount:      ${amount}`);
        log(`    status:      ${row.reconciliation_status} → CHANGE: needs_review`);
        log(`    reconciled_at: ${formatIsoDate(row.reconciled_at)} → CHANGE: null`);
      }
    }

    if (!apply) {
      log(`\nDry run complete. Re-run with --apply to commit.`);
      return;
    }

    log(`\n— applying —`);
    await client.query('begin');
    try {
      let matchesDeleted = 0;
      for (const row of danglingMatches) {
        if (await applyDanglingDelete(client, row)) matchesDeleted += 1;
      }
      let repaired = 0;
      for (const row of orphans) {
        if (await applyRepair(client, row)) repaired += 1;
      }
      await client.query('commit');
      log(`\nDeleted ${matchesDeleted} dangling match row(s); repaired ${repaired} transaction(s).`);
      log(`\nNext step: hit the reconcile cron for the affected client(s)`);
      log(`so the now-needs_review transactions get re-evaluated against`);
      log(`current candidate documents:`);
      log(`  curl -i -H "Authorization: Bearer $CRON_SECRET" \\`);
      log(`    "https://books-app.example/api/donna/firms/documents/parse-cron?task=reconcile&client_id=${clientId || '<client_id>'}"`);
    } catch (err) {
      await client.query('rollback').catch(() => {});
      throw err;
    }
  });
};

const invokedAsScript = import.meta.url === `file://${process.argv[1]}`;
if (invokedAsScript) {
  runScript().catch((err) => {
    console.error('[orphan-tx-repair] failed:', err?.message || err);
    process.exit(1);
  });
}

// Exported for unit testing.
export { parseArgv, PAYLOAD_KEYS_STRIPPED };
