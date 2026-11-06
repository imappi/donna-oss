// The nightly convergence drift receipt (RT-13,
// docs/plan-2026-09-01-runtime-refactor-slices.md §5; audit F-14).
//
// The persisted convergence verdict (transactions / documents
// .convergence_state, migration 137) is written by the ONE derivation in
// reconcileConvergenceState.js from inside every writer's transaction. This
// function is the check that the write-through is COMPLETE: once a night, per
// firm, it re-derives every row from its current inputs and compares the
// result with the column. Drift is a coverage bug — an input table with no
// mark trigger, a settle that could not run — and is REPORTED, never
// repaired: the receipt (`convergence.drift_checked`, an audit_events row per
// firm with the counts, the transitions, a bounded sample, and the unsettled
// marks) is what an operator reads; rewriting the column here would hide the
// very bug the check exists to surface. Read-only over the projection's
// inputs; the only write is the receipt.
//
// Desktop manifest entry: `convergence-drift-nightly` (kind 'desktop-cron',
// no cloud counterpart — the appliance is the only place the column is
// load-bearing today; handlerManifest.js).

import { listFirmIdsInDb, withFirmDbClient } from './firmDb.js';
import { recomputeConvergenceDrift } from './reconcileConvergenceState.js';

export const CONVERGENCE_DRIFT_FUNCTION_ID = 'convergence-drift-nightly';
export const CONVERGENCE_DRIFT_AUDIT_ACTION = 'convergence.drift_checked';
export const CONVERGENCE_DRIFT_CONTRACT_VERSION = 'donna.convergence-drift.v1';

const writeReceipt = (client, { firmId, report }) => client.query(
  `insert into audit_events (firm_id, client_id, actor_type, actor_id, action, resource_type, resource_id, metadata)
   values ($1, null, 'system', 'convergenceDriftCheck', $2, 'firm', $1, $3::jsonb)`,
  [firmId, CONVERGENCE_DRIFT_AUDIT_ACTION, JSON.stringify({ contract_version: CONVERGENCE_DRIFT_CONTRACT_VERSION, ...report })]
);

// One firm: recompute, receipt, return the report. Exported for the fixture
// and for an operator-run check (`node -e` on the appliance).
export const checkConvergenceDriftForFirm = async ({ client, firmId, sampleLimit = 50 } = {}) => {
  const report = await recomputeConvergenceDrift(client, { firmId, sampleLimit });
  if (!report) return null;
  await writeReceipt(client, { firmId, report });
  return report;
};

export const runConvergenceDriftCheck = async ({ logger, listFirmIds = listFirmIdsInDb, withClient = withFirmDbClient } = {}) => {
  const log = logger || console;
  const summary = { firms: 0, rows_checked: 0, drift_count: 0, unsettled_marks: 0, never_derived: 0, drifted_firms: [], errors: [] };
  let firmIds = [];
  try {
    firmIds = await listFirmIds();
  } catch (error) {
    log.error?.(`${CONVERGENCE_DRIFT_FUNCTION_ID}: firm enumeration failed`, { error: error?.message || String(error) });
    summary.errors.push({ stage: 'enumeration', message: error?.message || String(error) });
    return summary;
  }
  for (const firmId of firmIds) {
    try {
      const report = await withClient((client) => checkConvergenceDriftForFirm({ client, firmId }));
      if (!report) continue;
      summary.firms += 1;
      summary.rows_checked += report.rows_checked;
      summary.drift_count += report.drift_count;
      summary.unsettled_marks += report.unsettled_marks;
      summary.never_derived += report.never_derived;
      if (report.drift_count > 0 || report.unsettled_marks > 0) {
        summary.drifted_firms.push({ firm_id: firmId, drift_count: report.drift_count, unsettled_marks: report.unsettled_marks, by_transition: report.drift_by_transition });
        log.warn?.(`${CONVERGENCE_DRIFT_FUNCTION_ID}: persisted convergence state drifted from the derivation — receipted, NOT rewritten`, {
          firm_id: firmId, drift_count: report.drift_count, unsettled_marks: report.unsettled_marks, by_transition: report.drift_by_transition
        });
      }
    } catch (error) {
      log.warn?.(`${CONVERGENCE_DRIFT_FUNCTION_ID}: firm check failed`, { firm_id: firmId, error: error?.message || String(error) });
      summary.errors.push({ firm_id: firmId, message: error?.message || String(error) });
    }
  }
  return summary;
};

export const convergenceDriftNightlyEntry = () => ({
  functionId: CONVERGENCE_DRIFT_FUNCTION_ID,
  kind: 'desktop-cron',
  cron: process.env.CONVERGENCE_DRIFT_CRON || '20 4 * * *',
  maxAttempts: 1,
  concurrency: 1,
  leaseMs: 15 * 60_000,
  timeoutMs: 10 * 60_000,
  handlerVersion: '1',
  run: ({ step, logger }) => step.run('check', () => runConvergenceDriftCheck({ logger }))
});
