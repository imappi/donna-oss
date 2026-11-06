// Ledger auto-export — the INT-6 drain executor (ledger-integrations finish
// plan §2 INT-6; Kari decision #2, 2026-07-06: auto-push under delegated
// authority). For every client whose LEDGER_AUTO_EXPORT flag acts AND who
// holds a LIVE ledger_sync_authority_grant (migration 054, founder-minted,
// time-bounded, auto-suspended on export correction), drain the posted-not-
// exported journals through the EXISTING writers via the adapter layer
// (adapter.writebackBatch → writebackXero/QboTransactionsBatchInDb) — the
// grammar-is-a-router invariant: no new push path, no second accounting
// backend. This module contains ZERO connector logic of its own.
//
// The doctrine gate is LOAD-BEARING, not decorative: every client run routes
// through loopExecutionPolicy.decideExecution with requestedAction
// 'posted_journal_export' (the INT-6 GRANT_GATED_ACTIONS carve). No live
// grant → 'requires_authority_grant' → nothing exports, at any flag stage.
// Grant + shadow stage → 'tier_too_low' → log what WOULD export, zero writes,
// zero remote calls. Grant + canary/auto → export, then mirror-verify chained
// IMMEDIATELY (adapter.verifyMirror): an export isn't "done" until the mirror
// check passes or its INT-4b hook opens a drift case. Every attempted export
// writes a receipt (actor_type 'authority_grant', actor_id = grant id —
// ledgerSyncAuthorityGrants.writeLedgerAutoExportReceipts), and the writers'
// own INT-3/INT-4 audit + failure-case hooks run unchanged underneath (the
// grant id rides their actorId).
//
// Fail-closed preconditions, in order, per client:
//   1. LEDGER_AUTO_EXPORT acts (config plane, envFallback false — born on the
//      plane, no env pair; CLIENT_CONFIG_FORCE_DISABLE kills it).
//   2. LEDGER_SYNC_CASES acts for the same client — the failure surface must
//      exist BEFORE autonomy: "failure of any invariant falls back to a firm
//      case, never a silent skip" requires the case spine minting for real.
//   3. A live grant (findActiveLedgerSyncGrant — status/window/correction
//      guards all fail closed).
//   4. The connection pre-flight (getFresh*ConnectionForSync). A named
//      *_CONNECTION_EXPIRED error skips the client WITHOUT minting sync-
//      failure cases — connection death is INT-1's surface (the connection-
//      honesty operator card), not a per-journal export failure.
// Anything the guards exclude (no grant, over-ceiling, non-transaction QBO
// journals) stays VISIBLE on the operator card's pending_export_count with
// its one-click batch export — the pre-INT-6 terminal, never a silent drop —
// and every exclusion is counted in the sweep summary (no silent caps).
//
// The doctrine, verbatim (plan §2 INT-6): "export-of-an-already-posted-journal
// under a live grant ONLY — never coding, never posting, never corrections."
// The drain queries below enforce "already-posted" at the executor: Xero
// candidates must satisfy the POSTED payload flags (ledger_journal_id /
// ledger_status / review_state posted|closed), which is deliberately NARROWER
// than the manual batch writer's approved/accepted candidate set; QBO
// candidates are status='posted' journals without a synced mirror.

import { inngest } from './client.js';
import {
  queryFirmDb,
  withFirmDbClient,
  getFreshXeroConnectionForSync,
  getFreshQboConnectionForSync
} from '../firmDb.js';
import { getAccountingSystemAdapter } from '../accountingSystems/index.js';
import { clientFlagActs, clientFlagObserves, readClientConfigSnapshot } from '../clientConfig.js';
import { LEDGER_SYNC_CASES_FLAG_KEY } from '../ledgerSyncCases.js';
import {
  LEDGER_AUTO_EXPORT_FLAG_KEY,
  findActiveLedgerSyncGrant,
  ledgerSyncGrantCoversAmount,
  writeLedgerAutoExportReceipts
} from '../ledgerSyncAuthorityGrants.js';
import { decideExecution } from '../loopExecutionPolicy.js';

// Tuning knobs only (cron cadence + per-client drain breadth) — the BEHAVIOUR
// gate is the config-plane flag, never env.
const AUTO_EXPORT_CRON = process.env.LEDGER_AUTO_EXPORT_CRON || '23 4 * * *';
const XERO_EXPORT_LIMIT = Number(process.env.LEDGER_AUTO_EXPORT_XERO_LIMIT || 25);
const QBO_EXPORT_LIMIT = Number(process.env.LEDGER_AUTO_EXPORT_QBO_LIMIT || 25);
const MIRROR_VERIFY_LIMIT = Number(process.env.LEDGER_AUTO_EXPORT_VERIFY_LIMIT || 25);

const CONNECTION_EXPIRED_CODES = new Set(['XERO_CONNECTION_EXPIRED', 'QBO_CONNECTION_EXPIRED']);

// Clients whose CHOSEN system has a connected row — same enumeration as the
// mirror-verify sweep (the client's profile.accounting_system decides which
// connector; stale rows in the other table are ignored). Unset coalesces to
// 'none' — the legacy 'xero' default is retired (migration 120 stamped all
// real rows; a residual un-stamped client must not be swept into an
// external export lane it never chose).
const findExportableClients = async () => {
  const result = await queryFirmDb(
    `select c.firm_id, c.id as client_id,
            lower(coalesce(c.profile->>'accounting_system', 'none')) as accounting_system
       from clients c
      where c.status <> 'deleted'
        and (
          (lower(coalesce(c.profile->>'accounting_system', 'none')) = 'qbo'
            and exists (select 1 from qbo_connections q
                         where q.firm_id = c.firm_id and q.client_id = c.id
                           and q.status = 'connected'))
          or
          (lower(coalesce(c.profile->>'accounting_system', 'none')) = 'xero'
            and exists (select 1 from xero_connections x
                         where x.firm_id = c.firm_id and x.client_id = c.id
                           and x.status = 'connected'))
        )
      order by c.firm_id, c.id`,
    []
  );
  return result.rows || [];
};

const roundAmount = (value) => {
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
};

// Xero drain: POSTED-to-Donna-ledger transactions not yet synced to Xero —
// the SQL twin of the snapshot's pending_export_count payload-flag scan
// (isTransactionPostedToDonnaLedger && !isTransactionSyncedToXero), enforcing
// the "already-posted" doctrine bound at the executor.
const drainXeroCandidates = async ({ firmId, clientId, limit }) => {
  const result = await queryFirmDb(
    `select id, payload
       from transactions
      where firm_id = $1 and client_id = $2
        and (
          coalesce(payload->>'ledger_journal_id', '') <> ''
          or payload->>'ledger_status' in ('posted', 'closed')
          or coding_state in ('posted', 'closed')
        )
        and coalesce(payload->>'xero_sync_status', '') <> 'synced'
        and coalesce(payload->>'xero_writeback_status', '') <> 'synced'
        and coalesce(payload->>'xero_bank_transaction_id', '') = ''
        and coalesce(payload->>'xero_synced_at', '') = ''
        and coalesce(payload->>'synced_at', '') = ''
      order by transaction_date nulls last, created_at
      limit $3`,
    [firmId, clientId, limit]
  );
  return (result.rows || []).map((row) => {
    const p = row.payload || {};
    return {
      transactionId: row.id,
      journalId: null,
      amount: roundAmount(p.ledger_amount || p.money_in || p.money_out || p.amount || 0),
      currency: p.currency || null,
      exportable: true
    };
  });
};

// QBO drain: posted journals with no synced mirror (the pending_export_count
// candidate set), with per-journal amounts (debit-leg sum) for the ceiling
// check. Non-transaction-sourced journals (adjustments) are surfaced but
// marked unscoped — the batch writer's explicit-id lane is transaction-
// sourced only, so they stay on the operator card (counted, never silent).
const drainQboCandidates = async ({ firmId, clientId, limit }) => {
  const result = await queryFirmDb(
    `select j.id as journal_id, j.source_type, j.source_id, j.currency,
            coalesce(sum(l.debit), 0)::numeric as amount
       from ledger_journals j
       left join qbo_journal_mirrors m on m.journal_id = j.id and m.status = 'synced'
       left join ledger_lines l on l.journal_id = j.id
      where j.firm_id = $1 and j.client_id = $2 and j.status = 'posted' and m.id is null
      group by j.id, j.source_type, j.source_id, j.currency
      order by min(j.journal_date) asc, min(j.created_at) asc
      limit $3`,
    [firmId, clientId, limit]
  );
  return (result.rows || []).map((row) => ({
    transactionId: row.source_type === 'transaction' ? row.source_id : null,
    journalId: row.journal_id,
    amount: roundAmount(row.amount),
    currency: row.currency || null,
    exportable: row.source_type === 'transaction'
  }));
};

const readClientFlags = async ({ firmId, clientId }) =>
  withFirmDbClient(async (client) => {
    const snapshot = await readClientConfigSnapshot(client, { firmId, clientId });
    const autoExportStage = snapshot?.[LEDGER_AUTO_EXPORT_FLAG_KEY]?.stage || null;
    return {
      stage: autoExportStage,
      acts: clientFlagActs({ flagKey: LEDGER_AUTO_EXPORT_FLAG_KEY, snapshot, envFallback: () => false }),
      observes: clientFlagObserves({ flagKey: LEDGER_AUTO_EXPORT_FLAG_KEY, snapshot, envFallback: () => false }),
      syncCasesAct: clientFlagActs({ flagKey: LEDGER_SYNC_CASES_FLAG_KEY, snapshot, envFallback: () => false })
    };
  });

const findGrant = async ({ firmId, clientId, accountingSystem }) =>
  withFirmDbClient((client) =>
    findActiveLedgerSyncGrant({ client, firmId, clientId, accountingSystem })
  );

// Connection pre-flight: refresh/validate BEFORE draining so a dead connection
// skips the client in one call instead of failing N per-item writes (and never
// mints per-journal sync-failure cases for what is really connection death).
const preflightConnection = async ({ firmId, clientId, accountingSystem }) =>
  withFirmDbClient((client) =>
    accountingSystem === 'qbo'
      ? getFreshQboConnectionForSync({ client, firmId, clientId })
      : getFreshXeroConnectionForSync({ client, firmId, clientId })
  );

const writeReceipts = async (args) =>
  withFirmDbClient((client) => writeLedgerAutoExportReceipts({ client, ...args }));

export const runLedgerAutoExportSweep = async ({ logger, deps = {} } = {}) => {
  const log = logger || console;
  const listClients = deps.listClients || findExportableClients;
  const readFlags = deps.readFlags || readClientFlags;
  const lookupGrant = deps.findGrant || findGrant;
  const drainXero = deps.drainXero || drainXeroCandidates;
  const drainQbo = deps.drainQbo || drainQboCandidates;
  const preflight = deps.preflight || preflightConnection;
  const resolveAdapter = deps.resolveAdapter || getAccountingSystemAdapter;
  const persistReceipts = deps.writeReceipts || writeReceipts;
  const decide = deps.decideExecution || decideExecution;

  const summary = {
    clients_scanned: 0,
    clients_skipped_flag_off: 0,
    clients_skipped_no_case_surface: 0,
    clients_no_grant: 0,
    clients_nothing_pending: 0,
    clients_shadow: 0,
    clients_exported: 0,
    connection_expired: 0,
    exported: 0,
    export_errors: 0,
    skipped_over_ceiling: 0,
    skipped_unscoped_journals: 0,
    mirror_verify_ran: 0,
    receipts_written: 0,
    errors: []
  };

  let candidates = [];
  try {
    candidates = await listClients();
  } catch (err) {
    log.error?.('ledger-auto-export: client enumeration failed', { error: err?.message });
    summary.errors.push({ stage: 'enumeration', message: err?.message || String(err) });
    return summary;
  }

  for (const row of candidates) {
    const firmId = row.firm_id;
    const clientId = row.client_id;
    const accountingSystem = row.accounting_system === 'qbo' ? 'qbo' : 'xero';
    summary.clients_scanned += 1;
    try {
      const flags = await readFlags({ firmId, clientId });
      if (!flags.acts && !flags.observes) {
        summary.clients_skipped_flag_off += 1;
        continue;
      }
      // Precondition 2: no autonomy without the failure surface live. Shadow
      // (observe-only) may proceed — it takes no action a case would catch.
      if (flags.acts && !flags.syncCasesAct) {
        summary.clients_skipped_no_case_surface += 1;
        log.warn?.('ledger-auto-export: LEDGER_AUTO_EXPORT acts but LEDGER_SYNC_CASES does not — refusing autonomy without the case surface', {
          firm_id: firmId, client_id: clientId
        });
        continue;
      }

      const grant = await lookupGrant({ firmId, clientId, accountingSystem });
      const tier = flags.acts ? (flags.stage === 'auto' ? 'active' : 'canary') : 'shadow';
      const decision = decide({
        tier,
        requestedAction: 'posted_journal_export',
        authorityGrants: grant ? ['posted_journal_export'] : [],
        loopKey: 'ledger_auto_export'
      });

      if (decision.actionBlockedReason === 'requires_authority_grant') {
        summary.clients_no_grant += 1;
        log.info?.('ledger-auto-export: no live sync authority grant — nothing exports', {
          firm_id: firmId, client_id: clientId, accounting_system: accountingSystem, stage: flags.stage
        });
        continue;
      }

      const drained = accountingSystem === 'qbo'
        ? await drainQbo({ firmId, clientId, limit: QBO_EXPORT_LIMIT })
        : await drainXero({ firmId, clientId, limit: XERO_EXPORT_LIMIT });
      if (!drained.length) {
        summary.clients_nothing_pending += 1;
        continue;
      }

      // Grant-scope filter, per journal: over-ceiling and unscoped (QBO
      // adjustment) entries stay on the operator card — counted, not silent.
      const eligible = [];
      for (const item of drained) {
        if (!item.exportable) {
          summary.skipped_unscoped_journals += 1;
          continue;
        }
        if (!ledgerSyncGrantCoversAmount(grant, { amount: item.amount, currency: item.currency })) {
          summary.skipped_over_ceiling += 1;
          continue;
        }
        eligible.push(item);
      }

      if (!decision.actionAllowed) {
        // Shadow with a live grant: log what WOULD export, change nothing.
        summary.clients_shadow += 1;
        log.info?.('ledger-auto-export: shadow — would export under grant', {
          firm_id: firmId,
          client_id: clientId,
          accounting_system: accountingSystem,
          grant_id: grant.id,
          would_export: eligible.map((i) => i.transactionId || i.journalId),
          blocked_reason: decision.actionBlockedReason
        });
        continue;
      }

      if (!eligible.length) {
        summary.clients_nothing_pending += 1;
        continue;
      }

      // Connection pre-flight (precondition 4) — a named EXPIRED error is
      // INT-1's surface, never a per-journal failure case.
      try {
        await preflight({ firmId, clientId, accountingSystem });
      } catch (connErr) {
        if (CONNECTION_EXPIRED_CODES.has(connErr?.code)) {
          summary.connection_expired += 1;
          log.warn?.('ledger-auto-export: connection expired — skipping client (INT-1 surface)', {
            firm_id: firmId, client_id: clientId, accounting_system: accountingSystem
          });
          continue;
        }
        throw connErr;
      }

      // The export — EXISTING writers only, via the adapter verb. The grant id
      // rides actorId into the writers' own INT-3 receipts; their INT-4 hooks
      // mint per-journal failure cases exactly as a manual batch would.
      const adapter = resolveAdapter(accountingSystem);
      const transactionIds = eligible.map((i) => i.transactionId).filter(Boolean);
      let batch;
      try {
        batch = await adapter.writebackBatch({
          firmId, clientId, transactionIds, dryRun: false, actorId: grant.id
        });
      } catch (batchErr) {
        if (CONNECTION_EXPIRED_CODES.has(batchErr?.code)) {
          summary.connection_expired += 1;
          continue;
        }
        throw batchErr;
      }
      const results = (accountingSystem === 'qbo'
        ? batch?.qbo_writeback_batch?.results
        : batch?.xero_writeback_batch?.results) || [];

      const byTransactionId = new Map(eligible.filter((i) => i.transactionId).map((i) => [String(i.transactionId), i]));
      const items = results.map((r) => {
        const source = byTransactionId.get(String(r.transaction_id || '')) || {};
        return {
          transactionId: r.transaction_id || source.transactionId || null,
          journalId: r.journal_id || source.journalId || null,
          status: r.status === 'synced' ? 'synced' : 'error',
          error: r.error || null,
          errorCode: r.error_code || null,
          amount: source.amount ?? null,
          currency: source.currency ?? null
        };
      });
      const syncedCount = items.filter((i) => i.status === 'synced').length;
      const errorCount = items.length - syncedCount;
      summary.exported += syncedCount;
      summary.export_errors += errorCount;
      if (syncedCount || errorCount) summary.clients_exported += 1;

      // Mirror-verify chained IMMEDIATELY: the export isn't "done" until the
      // mirror check passes or its INT-4b hook opens a drift case.
      let mirrorVerifyCounts = null;
      if (syncedCount > 0) {
        try {
          const verify = await adapter.verifyMirror({ firmId, clientId, limit: MIRROR_VERIFY_LIMIT });
          mirrorVerifyCounts = (accountingSystem === 'qbo'
            ? verify?.qbo_mirror_verification?.counts
            : verify?.xero_mirror_verification?.counts) || null;
          summary.mirror_verify_ran += 1;
        } catch (verifyErr) {
          summary.errors.push({
            firm_id: firmId, client_id: clientId, stage: 'mirror_verify',
            message: verifyErr?.message || String(verifyErr)
          });
          log.warn?.('ledger-auto-export: chained mirror-verify failed — nightly sweep will re-check', {
            firm_id: firmId, client_id: clientId, error: verifyErr?.message
          });
        }
      }

      const receiptResult = await persistReceipts({
        firmId, clientId, grant, accountingSystem,
        flagStage: flags.stage, items, mirrorVerifyCounts
      });
      summary.receipts_written += receiptResult?.receipts || 0;
      if ((receiptResult?.receipts || 0) < items.length) {
        summary.errors.push({
          firm_id: firmId, client_id: clientId, stage: 'receipts',
          message: `wrote ${receiptResult?.receipts || 0}/${items.length} receipts`
        });
      }
    } catch (err) {
      log.warn?.('ledger-auto-export: per-client sweep failed', {
        firm_id: firmId, client_id: clientId, error: err?.message
      });
      summary.errors.push({ firm_id: firmId, client_id: clientId, message: err?.message || String(err) });
    }
  }

  return summary;
};

export const ledgerAutoExportFunction = inngest.createFunction(
  {
    id: 'ledger-auto-export',
    name: 'Ledger auto-export — delegated-authority drain (INT-6)',
    concurrency: { limit: 1 },
    retries: 0,
    triggers: [{ cron: AUTO_EXPORT_CRON }]
  },
  async ({ step, logger }) => {
    return step.run('sweep', () => runLedgerAutoExportSweep({ logger }));
  }
);

export const ledgerAutoExportFunctions = [ledgerAutoExportFunction];
