// Outbound metrics — the daily rollup cron (M1, execution plan §3). Computes
// the PREVIOUS UTC day's outbound_metrics_daily row per client from pipeline
// receipts + case state (outbound/metrics.js owns the arithmetic; this cron
// is only the clock — the outboundActionsDue posture: suspension-aware,
// per-client try/catch, zero-activity days write nothing).
//
// 02:10 UTC: safely after the day it summarizes, before anyone reads a
// dashboard. Cron knob is tuning only (env-legitimate).

import { inngest } from './client.js';
import { queryFirmDb, withFirmDbClient } from '../firmDb.js';
import { rollupOutboundMetricsForClient } from '../outbound/metrics.js';
import { resolveFirmSuspension } from '../loopExecutionGate.js';
import { toUtcIsoDay } from '../dates.js';

const OUTBOUND_METRICS_ROLLUP_CRON = process.env.OUTBOUND_METRICS_ROLLUP_CRON || '10 2 * * *';

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

// UTC on purpose: the metric day is a UTC day by contract (outbound/metrics.js
// bounds it at T00:00:00Z..T24:00:00Z), never the host-local day.
export const previousUtcDay = (now = Date.now()) => toUtcIsoDay(now - 86400000);

export const runOutboundMetricsRollup = async ({ logger, day = null, now = Date.now() } = {}) => {
  const log = logger || console;
  const metricDay = day || previousUtcDay(now);
  const summary = {
    day: metricDay,
    firms_evaluated: 0,
    firms_suspended: 0,
    clients_evaluated: 0,
    rows_written: 0,
    errors: []
  };
  let firms = [];
  try {
    firms = await findFirms();
  } catch (err) {
    log.error?.('outbound-metrics-rollup: firm enumeration failed', { error: err?.message });
    summary.errors.push({ stage: 'enumeration', message: err?.message || String(err) });
    return summary;
  }
  for (const firmRec of firms) {
    const firmId = firmRec.id;
    if (resolveFirmSuspension({ firmMetadata: firmRec.metadata })) {
      summary.firms_suspended += 1;
      continue;
    }
    summary.firms_evaluated += 1;
    let clientIds = [];
    try {
      clientIds = await findClientsForFirm(firmId);
    } catch (err) {
      log.warn?.('outbound-metrics-rollup: client enumeration failed', { firm_id: firmId, error: err?.message });
      summary.errors.push({ firm_id: firmId, message: err?.message || String(err) });
      continue;
    }
    for (const clientId of clientIds) {
      try {
        await withFirmDbClient(async (client) => {
          const { written } = await rollupOutboundMetricsForClient(client, {
            firmId, clientId, day: metricDay
          });
          summary.clients_evaluated += 1;
          if (written) summary.rows_written += 1;
        });
      } catch (err) {
        log.warn?.('outbound-metrics-rollup: per-client rollup failed', {
          firm_id: firmId, client_id: clientId, error: err?.message
        });
        summary.errors.push({ firm_id: firmId, client_id: clientId, message: err?.message || String(err) });
      }
    }
  }
  return summary;
};

export const outboundMetricsRollupFunction = inngest.createFunction(
  {
    id: 'outbound-metrics-rollup',
    name: 'Outbound actions — daily metrics rollup',
    concurrency: { limit: 1 },
    retries: 0,
    triggers: [{ cron: OUTBOUND_METRICS_ROLLUP_CRON }]
  },
  async ({ step, logger }) => {
    return step.run('rollup', () => runOutboundMetricsRollup({ logger }));
  }
);

export const outboundMetricsRollupFunctions = [outboundMetricsRollupFunction];
