#!/usr/bin/env node
//
// Repair SUSPENSE-coded transactions that still claim to be mirrored in
// Xero after their BankTransactions were deleted out-of-band (operator
// hand-emptied the Xero account). Live receipt (a pilot client, 2026-07-07): 15
// rows sat at `synced · suspense · settled` — pre-fix pollution whose
// Xero entries are gone, whose Suspense journals still sit posted in
// Donna's ledger, and whose stale `synced` markers both (a) lie about
// the Xero state and (b) keep the rows out of the export candidate set
// forever, so they can never drain to a terminal state.
//
// Repair semantics (golden rule: every row rests either IN XERO or
// OPEN/ON-THE-OWNER — these rows currently rest in neither):
//
//   1. VOID the row's posted Suspense ledger journal
//      (`ledger_journals.status = 'voided'`, `reversed_at` stamped,
//      provenance in payload). The journal was a meaningless
//      `Account: Suspense` posting that should never have existed.
//      Readers already exclude `status = 'voided'` everywhere; this
//      script is the first WRITER of that (schema-sanctioned) state.
//      A `closed` journal is REFUSED, not voided — a period-locked
//      posting needs the dated-adjustment-journal path, never a
//      script-side rewrite (the period-crossing rail).
//   2. Clear the stale Xero mirror markers via the same payload patch
//      the G2 teardown uses (`xeroMirrorClearColumnsPatch`), plus the
//      ledger receipt keys (`ledger_journal_id` / `ledger_status` /
//      `ledger_posted_at`) and the writeback's `review_state:'synced'`
//      stamp — the row returns to UN-SETTLED, i.e. back into the
//      coding lane, where it drains honestly: recode -> settle ->
//      export. Forensic residue (`xero_writeback_payload` /
//      `xero_writeback_response`) is kept, matching G2 semantics.
//   3. Reset column-level `status` / `reconciliation_status` back to
//      'needs_review' ONLY where the writeback stamped them 'synced'.
//   4. One audit event per row with the full prior state (markers,
//      journal id + status, column statuses) — the reversible-diff
//      doctrine: a bad repair-week is "select these rows, restore",
//      not forensics.
//
// Duplicate-safety note: even if a targeted row somehow still existed
// in Xero, a later re-export ADOPTS the existing entry via the
// reference gate (`matched_existing`, firmDb.js writeback path) rather
// than duplicating it. The `--confirm-xero-deleted` attestation is
// therefore belt-and-braces, but it is REQUIRED with --apply and is
// recorded in every audit row.
//
// Scope:
//
//   --firm <firm_id>          required with --apply
//   --client <client_id>      REQUIRED always (per-client repair)
//   --apply                   commit inside one transaction; default
//                             is dry-run with no writes
//   --confirm-xero-deleted    operator attests the targeted Xero
//                             entries were deleted; required with
//                             --apply
//
// Idempotent: a second run finds zero rows (markers cleared).
//
// Pure helpers (candidate filter, repair patch, audit metadata) are
// exported for unit testing.

import { withFirmDbClient, xeroMirrorClearColumnsPatch } from '../server/donna/firmDb.js';
import { codingInputFromTransaction, isSuspenseParkedCoding } from '../server/donna/xeroWriteback.js';

const REPAIR_SOURCE = 'stale_suspense_xero_mirror_repair_v1';
const REPAIR_AUDIT_ACTION = 'transaction.stale_suspense_mirror_repaired';

export const parseArgv = (argv = process.argv.slice(2)) => {
  const out = { apply: false, firmId: 'donna-demo-firm', clientId: null, confirmXeroDeleted: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--apply') out.apply = true;
    else if (a === '--confirm-xero-deleted') out.confirmXeroDeleted = true;
    else if (a === '--firm') { out.firmId = argv[i + 1]; i += 1; }
    else if (a === '--client') { out.clientId = argv[i + 1]; i += 1; }
  }
  return out;
};

const log = (...args) => console.log('[stale-suspense-mirror-repair]', ...args);

// Pure helper exported for tests: the minimal rowToTransactionPayload-
// shaped merge codingInputFromTransaction needs (that mapper is not
// exported from firmDb).
export const transactionShapeForCodingCheck = (row = {}) => ({
  ...(row.payload || {}),
  id: row.id,
  status: row.status,
  category: row.category || row.payload?.category,
  account_code: row.account_code || row.payload?.account_code
});

// Pure helper exported for tests: is this row a repair candidate?
// (a) claims a Xero mirror, (b) rests at Suspense/unknown coding —
// the suspense check delegates to the REAL export-filter helper so the
// script can never drift from the writer's definition of "parked".
export const isRepairCandidate = (row = {}) => {
  const payload = row.payload || {};
  const claimsMirror =
    String(payload.xero_sync_status || '') === 'synced' ||
    String(payload.xero_writeback_status || '') === 'synced' ||
    String(payload.xero_bank_transaction_id || '').trim() !== '';
  if (!claimsMirror) return false;
  return isSuspenseParkedCoding(codingInputFromTransaction(transactionShapeForCodingCheck(row)));
};

// Pure helper exported for tests: the payload patch that un-settles a
// repaired row. Extends the G2 mirror-clear patch with the ledger
// receipt keys and the writeback's review_state stamp, plus repair
// provenance.
export const buildRepairPayloadPatch = ({ clearedAt = new Date().toISOString() } = {}) => ({
  ...xeroMirrorClearColumnsPatch({ clearedAt }),
  ledger_journal_id: null,
  ledger_status: null,
  ledger_posted_at: null,
  review_state: null,
  review_status: null,
  stale_suspense_mirror_repaired_at: clearedAt,
  stale_suspense_mirror_repair_source: REPAIR_SOURCE
});

// Pure helper exported for tests: audit metadata with the full prior
// state so the repair is reversible from history.
export const buildRepairAudit = ({ row = {}, journal = null, confirmXeroDeleted = false } = {}) => {
  const payload = row.payload || {};
  return {
    script: 'repair_stale_suspense_xero_mirror.js',
    source: REPAIR_SOURCE,
    confirm_xero_deleted: Boolean(confirmXeroDeleted),
    prior_state: {
      status: row.status || null,
      reconciliation_status: row.reconciliation_status || null,
      xero_sync_status: payload.xero_sync_status || null,
      xero_writeback_status: payload.xero_writeback_status || null,
      xero_bank_transaction_id: payload.xero_bank_transaction_id || null,
      xero_synced_at: payload.xero_synced_at || null,
      ledger_journal_id: payload.ledger_journal_id || null,
      ledger_status: payload.ledger_status || null,
      review_state: payload.review_state || null,
      journal: journal
        ? { id: journal.id, status: journal.status, journal_date: journal.journal_date, memo: journal.memo || null }
        : null
    },
    changed_at: new Date().toISOString(),
    changed_by: 'system'
  };
};

const run = async () => {
  const args = parseArgv();
  if (!args.clientId) {
    log('ERROR: --client <client_id> is required (per-client repair).');
    process.exitCode = 1;
    return;
  }
  if (args.apply && !args.confirmXeroDeleted) {
    log('ERROR: --apply requires --confirm-xero-deleted (operator attests the Xero entries were deleted).');
    process.exitCode = 1;
    return;
  }
  log(args.apply ? 'APPLY mode — writes commit.' : 'DRY-RUN — no writes.');
  log(`firm=${args.firmId} client=${args.clientId}`);

  await withFirmDbClient(async (client) => {
    // Candidates: rows still claiming a Xero mirror; the suspense filter
    // runs in JS via the real export-filter helper (no SQL drift).
    const result = await client.query(
      `select * from transactions
        where firm_id = $1 and client_id = $2
          and (
            coalesce(payload->>'xero_sync_status', '') = 'synced'
            or coalesce(payload->>'xero_writeback_status', '') = 'synced'
            or coalesce(payload->>'xero_bank_transaction_id', '') <> ''
          )
        order by transaction_date, created_at`,
      [args.firmId, args.clientId]
    );
    const candidates = result.rows.filter(isRepairCandidate);
    log(`${result.rows.length} mirror-claiming rows; ${candidates.length} suspense-parked repair candidates.`);
    if (!candidates.length) {
      log('Nothing to repair.');
      return;
    }

    const plan = [];
    for (const row of candidates) {
      const journalId = String(row.payload?.ledger_journal_id || '').trim();
      let journal = null;
      if (journalId) {
        const jr = await client.query(
          `select id, status, journal_date, memo from ledger_journals
            where firm_id = $1 and client_id = $2 and id = $3
              and source_type = 'transaction' and source_id = $4`,
          [args.firmId, args.clientId, journalId, row.id]
        );
        journal = jr.rows[0] || null;
      }
      const journalAction = !journal
        ? 'none'
        : journal.status === 'posted'
          ? 'void'
          : journal.status === 'closed'
            ? 'REFUSED_closed_period'
            : 'skip_' + journal.status;
      plan.push({ row, journal, journalAction });
      log(
        `  ${row.id} | ${String(row.description || '').slice(0, 48)} | ` +
          `xero_id=${String(row.payload?.xero_bank_transaction_id || '(none)').slice(-10)} | ` +
          `journal=${journal ? `${journal.id.slice(-12)}:${journal.status}` : '(none)'} -> ${journalAction}`
      );
    }

    const refused = plan.filter((p) => p.journalAction === 'REFUSED_closed_period');
    if (refused.length) {
      log(`WARNING: ${refused.length} row(s) have CLOSED-period journals — refused.`);
      log('A period-locked Suspense posting needs a dated adjustment journal, not a script void.');
    }
    const actionable = plan.filter((p) => p.journalAction !== 'REFUSED_closed_period');
    log(`Plan: ${actionable.length} row(s) to repair, ${refused.length} refused.`);
    if (!args.apply) {
      log('Dry-run complete. Re-run with --apply --confirm-xero-deleted to commit.');
      return;
    }

    await client.query('begin');
    try {
      const clearedAt = new Date().toISOString();
      for (const entry of actionable) {
        const { row, journal, journalAction } = entry;
        if (journalAction === 'void') {
          await client.query(
            `update ledger_journals
                set status = 'voided',
                    reversed_at = now(),
                    payload = payload || $4::jsonb,
                    updated_at = now()
              where firm_id = $1 and client_id = $2 and id = $3 and status = 'posted'`,
            [
              args.firmId,
              args.clientId,
              journal.id,
              JSON.stringify({ voided_by: REPAIR_SOURCE, voided_reason: 'stale_suspense_mirror', voided_at: clearedAt })
            ]
          );
        }
        await client.query(
          `update transactions
              set payload = payload || $4::jsonb,
                  status = case when status = 'synced' then 'needs_review' else status end,
                  reconciliation_status = case when reconciliation_status = 'synced' then 'needs_review' else reconciliation_status end,
                  updated_at = now()
            where firm_id = $1 and client_id = $2 and id = $3`,
          [args.firmId, args.clientId, row.id, JSON.stringify(buildRepairPayloadPatch({ clearedAt }))]
        );
        // Audit-as-precondition: inside the transaction — no record, no repair.
        await client.query(
          `insert into audit_events (firm_id, client_id, actor_type, actor_id, action, resource_type, resource_id, metadata)
           values ($1, $2, 'system', 'system', '${REPAIR_AUDIT_ACTION}', 'transaction', $3, $4::jsonb)`,
          [
            args.firmId,
            args.clientId,
            row.id,
            JSON.stringify(buildRepairAudit({ row, journal, confirmXeroDeleted: args.confirmXeroDeleted }))
          ]
        );
      }
      await client.query('commit');
      log(`Committed: ${actionable.length} row(s) repaired (${actionable.filter((p) => p.journalAction === 'void').length} journal(s) voided).`);
    } catch (error) {
      await client.query('rollback');
      throw error;
    }
  });
};

const invokedDirectly = process.argv[1] && process.argv[1].endsWith('repair_stale_suspense_xero_mirror.js');
if (invokedDirectly) {
  run().catch((error) => {
    console.error('[stale-suspense-mirror-repair] FAILED:', error);
    process.exitCode = 1;
  });
}
