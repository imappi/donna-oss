// Ledger mirror-verify — scheduled sweep (INT-4c, ledger-integrations finish
// plan §2). Drift must be found by SCHEDULE, not by accident: for every client
// with a connected accounting system, run the EXISTING mirror verification
// (verifyXeroMirrorInDb / verifyQboMirrorInDb). Read-then-verify only — the
// verify functions fetch the remote entry and compare; they NEVER mutate the
// remote ledger (Kari decision #3: no auto-remediation; Donna ledger is the
// source of truth). Their INT-4b hook is what surfaces drift/missing as
// external_sync_pending cases (shadow-logs or mints per the LEDGER_SYNC_CASES
// config-plane stage), so this sweep carries no minting logic of its own.
//
// Per-client gate: the sweep runs only where LEDGER_SYNC_CASES OBSERVES
// (shadow / canary / auto) — the flag that owns the case surface also owns the
// schedule that feeds it; off/dry_run clients cost zero remote calls. No env
// pair (flags are born on the plane); LEDGER_MIRROR_VERIFY_CRON is a tuning
// knob only, and CLIENT_CONFIG_FORCE_DISABLE kills the sweep through the flag.
//
// Per-client failures (expired connection, connector not configured) are
// caught and logged so one bad client never breaks the batch — connection
// health is INT-1's surface, not this sweep's.

import { inngest } from './client.js';
import { queryFirmDb, withFirmDbClient, verifyXeroMirrorInDb, verifyQboMirrorInDb } from '../firmDb.js';
import { clientFlagObserves, readClientConfigSnapshot } from '../clientConfig.js';
import { LEDGER_SYNC_CASES_FLAG_KEY } from '../ledgerSyncCases.js';

const MIRROR_VERIFY_CRON = process.env.LEDGER_MIRROR_VERIFY_CRON || '47 3 * * *';

// Per-client verify breadth (tuning knobs; the verify functions clamp anyway).
const XERO_VERIFY_LIMIT = Number(process.env.LEDGER_MIRROR_VERIFY_XERO_LIMIT || 50);
const QBO_VERIFY_LIMIT = Number(process.env.LEDGER_MIRROR_VERIFY_QBO_LIMIT || 25);

// Clients whose CHOSEN system has a connected row. The client's
// profile.accounting_system decides which connector verifies (a client can
// carry stale rows in the other table from a past switch). Unset coalesces
// to 'none' — the legacy 'xero' default is retired (migration 120 stamped
// all real rows; a residual un-stamped client is not a mirror candidate).
const findVerifiableClients = async () => {
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

const clientObservesSyncCases = async ({ firmId, clientId }) =>
  withFirmDbClient(async (client) => {
    const snapshot = await readClientConfigSnapshot(client, { firmId, clientId });
    return clientFlagObserves({
      flagKey: LEDGER_SYNC_CASES_FLAG_KEY, snapshot, envFallback: () => false
    });
  });

export const runLedgerMirrorVerifySweep = async ({ logger, deps = {} } = {}) => {
  const log = logger || console;
  const verifyXero = deps.verifyXero || verifyXeroMirrorInDb;
  const verifyQbo = deps.verifyQbo || verifyQboMirrorInDb;
  const listClients = deps.listClients || findVerifiableClients;
  const observes = deps.observes || clientObservesSyncCases;

  const summary = {
    clients_scanned: 0,
    clients_skipped_flag_off: 0,
    clients_verified: 0,
    mirror_ok: 0,
    mirror_missing: 0,
    mirror_drift: 0,
    mirror_error: 0,
    errors: []
  };

  let candidates = [];
  try {
    candidates = await listClients();
  } catch (err) {
    log.error?.('ledger-mirror-verify: client enumeration failed', { error: err?.message });
    summary.errors.push({ stage: 'enumeration', message: err?.message || String(err) });
    return summary;
  }

  for (const row of candidates) {
    const firmId = row.firm_id;
    const clientId = row.client_id;
    summary.clients_scanned += 1;
    try {
      if (!(await observes({ firmId, clientId }))) {
        summary.clients_skipped_flag_off += 1;
        continue;
      }
      const isQbo = row.accounting_system === 'qbo';
      const result = isQbo
        ? await verifyQbo({ firmId, clientId, limit: QBO_VERIFY_LIMIT })
        : await verifyXero({ firmId, clientId, limit: XERO_VERIFY_LIMIT });
      const counts = isQbo
        ? result?.qbo_mirror_verification?.counts || {}
        : result?.xero_mirror_verification?.counts || {};
      summary.clients_verified += 1;
      summary.mirror_ok += counts.ok ?? counts.mirror_ok ?? 0;
      summary.mirror_missing += counts.missing ?? counts.mirror_missing ?? 0;
      summary.mirror_drift += counts.drift ?? counts.mirror_drift ?? 0;
      summary.mirror_error += counts.errors ?? counts.mirror_error ?? 0;
    } catch (err) {
      log.warn?.('ledger-mirror-verify: per-client verify failed', {
        firm_id: firmId, client_id: clientId, error: err?.message
      });
      summary.errors.push({ firm_id: firmId, client_id: clientId, message: err?.message || String(err) });
    }
  }

  return summary;
};

export const ledgerMirrorVerifyFunction = inngest.createFunction(
  {
    id: 'ledger-mirror-verify',
    name: 'Ledger mirror-verify — scheduled drift sweep',
    concurrency: { limit: 1 },
    retries: 0,
    triggers: [{ cron: MIRROR_VERIFY_CRON }]
  },
  async ({ step, logger }) => {
    return step.run('sweep', () => runLedgerMirrorVerifySweep({ logger }));
  }
);

export const ledgerMirrorVerifyFunctions = [ledgerMirrorVerifyFunction];
