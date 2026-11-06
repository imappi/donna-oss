// INT-4 — failure + drift onto the case spine (docs/donna-ledger-integrations-finish-plan.md
// §2 INT-4; Kari decision #3, 2026-07-06: drift surfaces as a firm case, never
// auto-remediated). Two-terminal-states applied to sync: a failed/drifted export
// must not rest as a silent payload flag — it becomes a 'sync' case (migration
// 053) with an external_sync_failed / external_sync_pending blocker owned by
// external_connector, whose one-click fix path is the EXISTING retry verb
// (/xero|qbo/writeback-transaction re-run, /xero|qbo/mirror-retry). Resolution on
// a successful re-export / clean verify terminalizes the case (markCaseResolved).
//
// This module ASSEMBLES the existing spine (caseManager.js) — no new tables, no
// second spine (the L1 "NOT a new spine" guard). It does not import firmDb (no
// cycle): every entry point takes a live pg `client` handed in by the caller.
//
// Gate: LEDGER_SYNC_CASES on the config control plane (clientFlagActs /
// clientFlagObserves, migrations 042/043), envFallback: () => false — born on
// the plane, no env pair. Stages: shadow = log what WOULD be minted (no writes);
// canary/auto = mint. RESOLUTION is deliberately NOT flag-gated: it only touches
// cases that already exist, and a flag flipped off must never strand an open
// sync case (that would be the two-terminal violation this slice closes).
//
// Best-effort BY CONTRACT (the loopsShadowProducers runShadow posture): every
// entry point runs in its own mini-transaction and swallows its own errors — a
// case-spine hiccup can NEVER mask the original push error or break a verify.

import {
  openOrFindCase, openBlocker, resolveBlocker, linkObject, buildCaseId,
  loopsTablesPresent, markCaseResolved, reopenCase, LOOP_TERMINAL_STATUSES
} from './caseManager.js';
import { clientFlagActs, clientFlagObserves, readClientConfigSnapshot } from './clientConfig.js';

export const LEDGER_SYNC_CASES_FLAG_KEY = 'LEDGER_SYNC_CASES';

const SYSTEM_LABELS = { xero: 'Xero', qbo: 'QuickBooks', procountor: 'Procountor' };
const systemLabel = (accountingSystem) =>
  SYSTEM_LABELS[String(accountingSystem || '').toLowerCase()] || 'the accounting system';

// The sync-case anchor: the transaction when the export is transaction-sourced
// (both connectors' common path), else the ledger journal (QBO adjustment
// journals). Deterministic, so repeat failures upsert ONE case per object.
export const syncCaseAnchor = ({ transactionId = null, journalId = null } = {}) => {
  if (transactionId) return { type: 'transaction', id: String(transactionId) };
  if (journalId) return { type: 'ledger_journal', id: String(journalId) };
  return null;
};

const runBestEffort = async (client, work) => {
  if (!client) return null;
  let began = false;
  try {
    if (!(await loopsTablesPresent(client))) return null;
    await client.query('begin');
    began = true;
    const result = await work();
    await client.query('commit');
    return result;
  } catch (error) {
    if (began) {
      try { await client.query('rollback'); } catch { /* best-effort */ }
    }
    try {
      console.warn(`[ledger-sync-cases] swallowed error: ${error?.message || error}`);
    } catch { /* never throw from the logger */ }
    return null;
  }
};

const readFlagModes = async (client, { firmId, clientId }) => {
  const snapshot = await readClientConfigSnapshot(client, { firmId, clientId });
  return {
    acts: clientFlagActs({ flagKey: LEDGER_SYNC_CASES_FLAG_KEY, snapshot, envFallback: () => false }),
    observes: clientFlagObserves({ flagKey: LEDGER_SYNC_CASES_FLAG_KEY, snapshot, envFallback: () => false })
  };
};

// Open (or find) the sync case for an anchor and put `blockerType` on it.
// Reopens a terminal case first — a NEW failure after a resolved one must not
// hide behind the old terminal verdict (rebuildCaseStatus §1).
const mintSyncBlocker = async ({
  client, firmId, clientId, anchor, blockerType, title, summary, reason
}) => {
  const kase = await openOrFindCase({
    client, firmId, clientId, caseType: 'sync',
    primaryObject: anchor, title, summary
  });
  if (!kase) return null;
  if (!kase.created && LOOP_TERMINAL_STATUSES.includes(kase.status)) {
    await reopenCase({ client, firmId, clientId, caseId: kase.id, reason: 'new external sync signal' });
  }
  await linkObject({
    client, firmId, clientId, caseId: kase.id,
    objectType: anchor.type, objectId: anchor.id, role: 'external_sync'
  });
  const blocker = await openBlocker({
    client, firmId, clientId, caseId: kase.id,
    blockerType, ownerType: 'external_connector',
    objectType: anchor.type, objectId: anchor.id,
    reason
  });
  return { caseId: kase.id, blockerId: blocker?.id || null, status: blocker?.status || null };
};

// Push failure ⇒ external_sync_failed (case parks at 'blocked' — HARD_FAIL).
// Called best-effort from the connector writeback catch blocks, BEFORE the
// original error is rethrown; it must never throw and never mask that error.
export const recordExternalSyncFailure = async ({
  client, firmId, clientId, accountingSystem,
  transactionId = null, journalId = null,
  errorMessage = null, errorCode = null, source = null
} = {}) => {
  const anchor = syncCaseAnchor({ transactionId, journalId });
  if (!firmId || !clientId || !anchor) return null;
  return runBestEffort(client, async () => {
    const { acts, observes } = await readFlagModes(client, { firmId, clientId });
    if (!acts && !observes) return { mode: 'off' };
    const label = systemLabel(accountingSystem);
    const reason = [
      `${label} export failed`,
      errorCode ? `[${errorCode}]` : null,
      errorMessage || null,
      `Fix path: retry the export (${source || 'writeback'}); reconnect if the connection expired.`
    ].filter(Boolean).join(' — ');
    if (!acts) {
      console.log(
        `[ledger-sync-cases] shadow: would open external_sync_failed for ${anchor.type} ${anchor.id} ` +
        `(firm ${firmId}, client ${clientId}, ${label}): ${errorMessage || errorCode || 'unknown error'}`
      );
      return { mode: 'shadow' };
    }
    const minted = await mintSyncBlocker({
      client, firmId, clientId, anchor,
      blockerType: 'external_sync_failed',
      title: `${label} export failed — ${anchor.type} ${anchor.id}`,
      summary: `A posted entry could not be exported to ${label}. Donna retries via the existing writeback/mirror-retry verbs; the blocker resolves on the first successful export.`,
      reason
    });
    return minted ? { mode: 'minted', ...minted } : null;
  });
};

// Mirror-verify drift/missing ⇒ external_sync_pending (soft wait —
// 'waiting_system'). The existing mirror-retry is the one-click fix path.
export const recordExternalSyncDrift = async ({
  client, firmId, clientId, accountingSystem,
  transactionId = null, journalId = null,
  verificationStatus = null, detail = null
} = {}) => {
  const anchor = syncCaseAnchor({ transactionId, journalId });
  if (!firmId || !clientId || !anchor) return null;
  return runBestEffort(client, async () => {
    const { acts, observes } = await readFlagModes(client, { firmId, clientId });
    if (!acts && !observes) return { mode: 'off' };
    const label = systemLabel(accountingSystem);
    const what = verificationStatus === 'mirror_missing' ? 'is missing from' : 'has drifted in';
    const reason = [
      `Mirror verification: the exported entry ${what} ${label}`,
      detail || null,
      'Fix path: mirror-retry re-exports it; Donna ledger remains the source of truth.'
    ].filter(Boolean).join(' — ');
    if (!acts) {
      console.log(
        `[ledger-sync-cases] shadow: would open external_sync_pending (${verificationStatus}) for ` +
        `${anchor.type} ${anchor.id} (firm ${firmId}, client ${clientId}, ${label})`
      );
      return { mode: 'shadow' };
    }
    const minted = await mintSyncBlocker({
      client, firmId, clientId, anchor,
      blockerType: 'external_sync_pending',
      title: `${label} mirror ${verificationStatus === 'mirror_missing' ? 'missing' : 'drift'} — ${anchor.type} ${anchor.id}`,
      summary: `Mirror verification found the exported entry ${what} ${label}. Mirror-retry is the fix path; the blocker resolves on the next clean verify.`,
      reason
    });
    return minted ? { mode: 'minted', ...minted } : null;
  });
};

// Successful export / clean verify ⇒ resolve the sync case's open blockers and,
// when none remain, terminalize it (markCaseResolved). NOT flag-gated (see
// header); no-ops when no sync case exists for the anchor.
export const resolveExternalSyncCase = async ({
  client, firmId, clientId,
  transactionId = null, journalId = null,
  blockerTypes = ['external_sync_failed', 'external_sync_pending'],
  reason = 'External sync succeeded.'
} = {}) => {
  if (!firmId || !clientId) return null;
  const anchors = [
    syncCaseAnchor({ transactionId }),
    syncCaseAnchor({ journalId })
  ].filter(Boolean);
  if (!anchors.length) return null;
  return runBestEffort(client, async () => {
    let resolvedBlockers = 0;
    let resolvedCases = 0;
    for (const anchor of anchors) {
      const caseId = buildCaseId({
        firmId, clientId, caseType: 'sync',
        primaryObjectType: anchor.type, primaryObjectId: anchor.id
      });
      if (!caseId) continue;
      const kase = await client.query(
        `select id, status from bookkeeping_cases where id = $1 limit 1`, [caseId]
      );
      if (!kase.rows[0]) continue;
      const open = await client.query(
        `select id from bookkeeping_case_blockers
          where case_id = $1 and status = 'open' and blocker_type = any($2::text[])
          order by created_at asc`,
        [caseId, blockerTypes]
      );
      for (const b of open.rows) {
        const r = await resolveBlocker({ client, blockerId: b.id, reason });
        if (r.resolved) resolvedBlockers += 1;
      }
      const remaining = await client.query(
        `select 1 from bookkeeping_case_blockers where case_id = $1 and status = 'open' limit 1`,
        [caseId]
      );
      if (!remaining.rows[0] && !LOOP_TERMINAL_STATUSES.includes(kase.rows[0].status)) {
        const done = await markCaseResolved({ client, firmId, clientId, caseId, reason });
        if (done) resolvedCases += 1;
      }
    }
    return { resolvedBlockers, resolvedCases };
  });
};

// Mirror-verification batch → the case spine. `entries` carry the per-object
// verify verdicts ({ transactionId?, journalId?, status, detail? }):
//   mirror_missing / mirror_drift → external_sync_pending blocker (flag-gated),
//   mirror_ok → resolve any open external_sync_pending (ungated),
//   mirror_error → nothing (a fetch error is not a drift verdict — the
//     connection-health surface owns it; INT-1).
export const applyMirrorVerificationToSyncCases = async ({
  client, firmId, clientId, accountingSystem, entries = []
} = {}) => {
  if (!firmId || !clientId || !Array.isArray(entries) || entries.length === 0) return null;
  const summary = { minted: 0, shadow: 0, resolved: 0 };
  for (const entry of entries) {
    if (!entry) continue;
    if (entry.status === 'mirror_missing' || entry.status === 'mirror_drift') {
      const r = await recordExternalSyncDrift({
        client, firmId, clientId, accountingSystem,
        transactionId: entry.transactionId || null,
        journalId: entry.journalId || null,
        verificationStatus: entry.status,
        detail: entry.detail || null
      });
      if (r?.mode === 'minted') summary.minted += 1;
      if (r?.mode === 'shadow') summary.shadow += 1;
    } else if (entry.status === 'mirror_ok') {
      const r = await resolveExternalSyncCase({
        client, firmId, clientId,
        transactionId: entry.transactionId || null,
        journalId: entry.journalId || null,
        blockerTypes: ['external_sync_pending'],
        reason: 'Mirror verification passed.'
      });
      if (r?.resolvedBlockers) summary.resolved += r.resolvedBlockers;
    }
  }
  return summary;
};
