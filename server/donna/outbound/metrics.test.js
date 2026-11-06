// Outbound metrics (M1, §3). Mock-pg harness. Pins:
//   - executed receipts drive reminders_sent / actions_executed /
//     minutes_saved (declared constants); cancels/refusals and failures
//     count separately;
//   - approval taps come from the action rows' approved_at stamps;
//   - collected_after_chase sums only cases settled AFTER a sent step
//     (current_step >= 1) — the conservative §3 attribution;
//   - false_chase_candidates = already_settled cancels on step > 1 (the
//     documented upper bound);
//   - a zero-activity day writes NO row (absence IS the zero);
//   - absent tables degrade to zeros, never a throw;
//   - the rollup upserts on (firm, client, metric_date).

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  MINUTES_SAVED_PER_ACTION, computeOutboundMetricsForDay,
  hasOutboundActivity, rollupOutboundMetricsForClient
} from './metrics.js';

const FIRM = 'firm-1';
const CLIENT = 'client-1';
const DAY = '2026-07-23';

const makeMockClient = (handlers = []) => {
  const calls = [];
  return {
    calls,
    query: async (sql, params) => {
      calls.push({ sql: String(sql), params });
      const text = String(sql).replace(/\s+/g, ' ').trim().toLowerCase();
      for (const h of handlers) {
        if (text.includes(h.match)) {
          if (h.throw) throw h.throw;
          const rows = typeof h.rows === 'function' ? h.rows({ sql: text, params }) : (h.rows || []);
          return { rows, rowCount: rows.length };
        }
      }
      return { rows: [], rowCount: 0 };
    }
  };
};

const activeDayClient = (extra = []) => makeMockClient([
  ...extra,
  { match: 'from outbound_action_receipts r join outbound_actions a', rows: [{ n: 1 }] },
  { match: 'from outbound_action_receipts', rows: [
    { action_type: 'send_receivable_reminder', outcome: 'sent', reason: null, n: 3 },
    { action_type: 'send_receivable_reminder', outcome: 'cancelled', reason: 'already_settled', n: 2 },
    { action_type: 'send_receivable_reminder', outcome: 'failed', reason: 'resend 500', n: 1 }
  ] },
  { match: 'from outbound_actions where firm_id', rows: [{ n: 4 }] },
  { match: 'from receivable_cases', rows: [{
    opened: 2, settled: 2, collected_after_chase: '1250', avg_days_late: '31.5'
  }] },
  { match: 'insert into outbound_metrics_daily', rows: [] }
]);

test('receipts, taps, and case state compose into the §3 metric row', async () => {
  const client = activeDayClient();
  const metrics = await computeOutboundMetricsForDay(client, { firmId: FIRM, clientId: CLIENT, day: DAY });
  assert.equal(metrics.metric_date, DAY);
  assert.equal(metrics.reminders_sent, 3);
  assert.equal(metrics.actions_executed, 3);
  assert.equal(metrics.minutes_saved, 3 * MINUTES_SAVED_PER_ACTION.send_receivable_reminder);
  assert.equal(metrics.cancels, 2);
  assert.equal(metrics.failures, 1);
  assert.equal(metrics.approval_taps, 4);
  assert.equal(metrics.cases_opened, 2);
  assert.equal(metrics.cases_settled, 2);
  assert.equal(metrics.collected_after_chase_amount, 1250);
  assert.equal(metrics.false_chase_candidates, 1);
  assert.equal(metrics.avg_days_late_at_settlement, 31.5);
  assert.equal(metrics.detail.by_action_type.send_receivable_reminder.sent, 3);
  assert.equal(hasOutboundActivity(metrics), true);
});

test('a zero-activity day writes no row; an active day upserts', async () => {
  const quiet = makeMockClient([]);
  const quietResult = await rollupOutboundMetricsForClient(quiet, { firmId: FIRM, clientId: CLIENT, day: DAY });
  assert.equal(quietResult.written, false);
  assert.ok(!quiet.calls.some((c) => c.sql.includes('insert into outbound_metrics_daily')));

  const active = activeDayClient();
  const activeResult = await rollupOutboundMetricsForClient(active, { firmId: FIRM, clientId: CLIENT, day: DAY });
  assert.equal(activeResult.written, true);
  const upsert = active.calls.find((c) => c.sql.includes('insert into outbound_metrics_daily'));
  assert.ok(upsert.sql.includes('on conflict (firm_id, client_id, metric_date) do update'));
  assert.ok(upsert.params.includes(DAY));
});

test('absent tables degrade to zeros, never a throw; a bad day input throws', async () => {
  const absent = makeMockClient([
    { match: 'from outbound_action_receipts', throw: Object.assign(new Error('missing'), { code: '42P01' }) }
  ]);
  const metrics = await computeOutboundMetricsForDay(absent, { firmId: FIRM, clientId: CLIENT, day: DAY });
  assert.equal(hasOutboundActivity(metrics), false);
  await assert.rejects(
    () => computeOutboundMetricsForDay(absent, { firmId: FIRM, clientId: CLIENT, day: 'nonsense' }),
    /bad day/
  );
});

test('the declared minutes constants cover every action type', async () => {
  const { OUTBOUND_ACTION_TYPES } = await import('./actionGate.js');
  for (const actionType of OUTBOUND_ACTION_TYPES) {
    assert.ok(Number(MINUTES_SAVED_PER_ACTION[actionType]) > 0, `minutes constant declared for ${actionType}`);
  }
});
