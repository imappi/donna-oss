// Convergence clocks — the two DAILY Inngest crons the 2026-07-06 clock
// decisions need (docs/design-2026-07-06-loop-clock-decisions-twin-aging.md
// §§1, 3, 4; Kari's dated answers 2026-07-06).
//
// 1. convergence-metrics-daily — makes the Q5 daily capture REAL. The Slice-J
//    sampler (`parse-cron?task=convergence_snapshot`) only ran when a console/
//    API path fired; this cron calls the SAME recorder for every firm every
//    day, enriched with the Q5 ask-clock sample (asks_sent_7d + open-ask age
//    percentiles, computeAskClockMetrics) merged into the SAME migration-049
//    blob — no new table. Read-only over persisted verdicts; upsert per
//    (firm, client, UTC day), so a same-day manual run and the cron converge
//    on one row.
//
// 2. ask-clock-sweeps-daily — the tick for the per-client convergence clocks:
//    - twin-aging (3d): sweepTwinAgingAskDraftRequests — when aged ambiguous
//      twins exist and RECONCILIATION_TWIN_AGING_ASK acts, request a fresh
//      ask-batch draft through the EXISTING outbox lane (the flag-gated draft
//      gather then feeds the twins to the drafter; the send lane mints).
//    - material-confirm recovery: the same sweep re-requests a draft whenever
//      an ungated held match still needs its owner confirmation, including
//      after a prior draft request exhausted retries.
//    - re-ask cadence (7d/14d → escalate): runAskReaskSweep — nudge overdue
//      open asks, escalate the owner-unresponsive ones to the firm.
//    Both sweeps are plane-flag-gated per client (fail-closed, envFallback
//    false), so registering this cron is INERT until a stage row exists —
//    the careful-canary discipline (mirrors bankLineDisposition's posture).
//
// Daily resolution is deliberate: the clocks are 3/7/14 DAYS — an hourly
// sweep would only burn config reads. Cron knobs are tuning only
// (CONVERGENCE_METRICS_CRON / ASK_CLOCK_SWEEP_CRON); the BEHAVIOUR gates live
// on the config plane.

import { inngest } from './client.js';
import {
  queryFirmDb, withFirmDbClient, getFirmSnapshotFromDb, listFirmIdsInDb
} from '../firmDb.js';
import {
  recordConvergenceMetricsSnapshot, computeAskClockMetrics
} from '../convergenceMetricSnapshots.js';
import { sweepTwinAgingAskDraftRequests } from '../reconciliationTwinAging.js';
import { sweepPhysicalReviewAsks } from '../inventory/physicalReconciliationAsks.js';
import { runAskReaskSweep } from '../askReaskCadence.js';
import { resolveFirmSuspension } from '../loopExecutionGate.js';
import { runWithEntityReadinessWorkerAdmission } from '../runtimeReadinessAdmission.js';

const CONVERGENCE_METRICS_CRON = process.env.CONVERGENCE_METRICS_CRON || '0 4 * * *';
const ASK_CLOCK_SWEEP_CRON = process.env.ASK_CLOCK_SWEEP_CRON || '30 4 * * *';

const findFirms = async () => {
  const result = await queryFirmDb('select id, metadata from firms', []);
  return (result.rows || [])
    .map((row) => ({ id: row.id, metadata: row.metadata }))
    .filter((f) => Boolean(f.id));
};

const findClientsForFirm = async (firmId) => {
  const result = await queryFirmDb('select id from clients where firm_id = $1', [firmId]);
  return (result.rows || []).map((row) => row.id).filter(Boolean);
};

// The daily Q5 sample: per firm, aggregate the persisted convergence verdicts
// (the snapshot's by_client blob) + the ask-clock read, and record one row per
// client per UTC day. Per-firm try/catch — one failing book never blocks the
// others' sample.
export const runConvergenceMetricsDaily = async ({ logger, firmId: onlyFirmId = null } = {}) => {
  const log = logger || console;
  const summary = { firms: 0, clients_recorded: 0, errors: [] };
  let firmIds = [];
  try {
    firmIds = await listFirmIdsInDb();
    if (onlyFirmId) firmIds = firmIds.filter(id => id === onlyFirmId);
  } catch (err) {
    log.error?.('convergence-metrics-daily: firm enumeration failed', { error: err?.message });
    summary.errors.push({ stage: 'enumeration', message: err?.message || String(err) });
    return summary;
  }
  for (const firmId of firmIds) {
    try {
      const snap = await getFirmSnapshotFromDb({ firmId });
      const byClient = snap?.convergenceMetrics?.by_client || {};
      const recorded = await withFirmDbClient(async (client) => {
        const askClocksByClient = {};
        for (const clientId of Object.keys(byClient)) {
          if (!clientId || clientId === '__unknown__') continue;
          const clocks = await computeAskClockMetrics({ client, firmId, clientId });
          if (clocks) askClocksByClient[clientId] = clocks;
        }
        return recordConvergenceMetricsSnapshot({ client, firmId, byClient, askClocksByClient });
      });
      summary.firms += 1;
      summary.clients_recorded += recorded?.recorded || 0;
    } catch (err) {
      log.warn?.('convergence-metrics-daily: firm sample failed', {
        firm_id: firmId, error: err?.message
      });
      summary.errors.push({ firm_id: firmId, message: err?.message || String(err) });
    }
  }
  return summary;
};

// The daily clock tick: per client, run the twin-aging draft-request sweep
// and the re-ask cadence sweep. Both flag-gated internally (a client with no
// stage row costs two config reads and does nothing). Per-client try/catch —
// one poisoned book never stalls the rest.
export const runAskClockSweeps = async ({ logger } = {}) => {
  const log = logger || console;
  const summary = {
    firms_evaluated: 0,
    firms_suspended: 0,
    clients_evaluated: 0,
    twin_groups: 0,
    held_match_groups: 0,
    twin_draft_requests: 0,
    reask_nudged: 0,
    reask_escalated: 0,
    errors: []
  };
  let firms = [];
  try {
    firms = await findFirms();
  } catch (err) {
    log.error?.('ask-clock-sweeps: firm enumeration failed', { error: err?.message });
    summary.errors.push({ stage: 'enumeration', message: err?.message || String(err) });
    return summary;
  }
  for (const firmRec of firms) {
    const firmId = firmRec.id;
    // A firm-level loop suspension pauses the clocks for that firm (mirrors
    // the disposition cron) — never couples to the loop tier.
    if (resolveFirmSuspension({ firmMetadata: firmRec.metadata })) {
      summary.firms_suspended += 1;
      continue;
    }
    summary.firms_evaluated += 1;
    let clientIds = [];
    try {
      clientIds = await findClientsForFirm(firmId);
    } catch (err) {
      log.warn?.('ask-clock-sweeps: client enumeration failed', { firm_id: firmId, error: err?.message });
      summary.errors.push({ firm_id: firmId, message: err?.message || String(err) });
      continue;
    }
    for (const clientId of clientIds) {
      try {
        await withFirmDbClient(async (client) => runWithEntityReadinessWorkerAdmission({
          client,
          firmId,
          clientId,
          work: async () => {
          const twin = await sweepTwinAgingAskDraftRequests({ client, firmId, clientId });
          summary.twin_groups += twin?.groups || 0;
          summary.held_match_groups += twin?.held_groups || 0;
          summary.twin_draft_requests += twin?.enqueued || 0;
          await sweepPhysicalReviewAsks({ client, firmId, clientId });
          const reask = await runAskReaskSweep({ client, firmId, clientId });
          summary.reask_nudged += reask?.nudged || 0;
          summary.reask_escalated += reask?.escalated || 0;
          summary.clients_evaluated += 1;
          }
        }));
      } catch (err) {
        log.warn?.('ask-clock-sweeps: per-client sweep failed', {
          firm_id: firmId, client_id: clientId, error: err?.message
        });
        summary.errors.push({ firm_id: firmId, client_id: clientId, message: err?.message || String(err) });
      }
    }
  }
  return summary;
};

export const convergenceMetricsDailyFunction = inngest.createFunction(
  {
    id: 'convergence-metrics-daily',
    name: 'Convergence metrics — daily Q5 sample',
    concurrency: { limit: 1 },
    retries: 0,
    triggers: [{ cron: CONVERGENCE_METRICS_CRON }, { event: 'donna/host.readiness.requested' }]
  },
  async ({ step, logger, event }) => {
    const firmId = event.name === 'donna/host.readiness.requested' ? event.data?.firm_id : null;
    if (event.name === 'donna/host.readiness.requested' && !firmId) throw new Error('Scoped readiness event requires a firm.');
    return step.run('sample', () => runConvergenceMetricsDaily({ logger, firmId }));
  }
);

export const askClockSweepsFunction = inngest.createFunction(
  {
    id: 'ask-clock-sweeps-daily',
    name: 'Ask clocks — daily twin-aging + re-ask sweeps',
    concurrency: { limit: 1 },
    retries: 0,
    triggers: [{ cron: ASK_CLOCK_SWEEP_CRON }]
  },
  async ({ step, logger }) => {
    return step.run('sweep', () => runAskClockSweeps({ logger }));
  }
);

export const convergenceClocksFunctions = [
  convergenceMetricsDailyFunction,
  askClockSweepsFunction
];
