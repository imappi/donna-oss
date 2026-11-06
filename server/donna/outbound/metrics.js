// Outbound metrics (M1, execution plan §3 — instrumentation lands WITH the
// milestone, not after). Everything computes from pipeline receipts
// (outbound_action_receipts), action state, and receivable-case state — the
// same rows the audit story already stands on. No side-channel counters.
//
// Attribution honesty (§3, verbatim requirement): a payment landing after a
// reminder is NOT proof the reminder caused it — collected_after_chase_amount
// is reported as "collected after chase", never "because of chase".
// false_chase_candidates is an UPPER BOUND (already_settled cancels arriving
// after at least one sent step); it becomes a real false-chase count only
// with owner confirmation or the D4 deterministic settlement signal.
//
// minutes_saved: executed actions × the DECLARED constants below — surface
// them in any report footnote; changing one is a product decision, not a
// tuning tweak.
//
// Keep-layer posture: deterministic SQL aggregation. No LLM.

import { randomUUID } from 'node:crypto';

import { gatherEarnedAutoStates, cleanSendTargetFor } from './earnedAutoLadder.js';

export const MINUTES_SAVED_PER_ACTION = Object.freeze({
  send_receivable_reminder: 6,
  issue_invoice: 8,
  send_quote: 8,
  send_payable_notice: 3
});

const missingTables = (error) => error?.code === '42P01' || error?.code === '42703';

const dayBounds = (day) => {
  const d = String(day).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) throw new Error(`computeOutboundMetrics: bad day '${day}'`);
  return { start: `${d}T00:00:00Z`, end: `${d}T24:00:00Z`, day: d };
};

// Compute one client's metrics for one UTC day. Read-only; soft-fails to
// zeros when the outbound tables are absent.
export const computeOutboundMetricsForDay = async (client, { firmId, clientId, day }) => {
  const { start, end, day: metricDate } = dayBounds(day);
  const zero = {
    metric_date: metricDate, reminders_sent: 0, actions_executed: 0,
    invoices_issued: 0, quotes_sent: 0,
    approval_taps: 0, cancels: 0, failures: 0,
    cases_opened: 0, cases_settled: 0,
    collected_after_chase_amount: 0, false_chase_candidates: 0,
    minutes_saved: 0, avg_days_late_at_settlement: null, detail: {}
  };

  let receipts;
  try {
    receipts = await client.query(
      `select r.action_type, r.outcome, r.reason,
              coalesce(a.cadence_step, 1) as cadence_step, count(*)::int as n
         from outbound_action_receipts r
         left join outbound_actions a on a.id = r.action_id
        where r.firm_id = $1 and r.client_id = $2
          and r.created_at >= $3::timestamptz and r.created_at < $4::timestamptz
        group by r.action_type, r.outcome, r.reason, coalesce(a.cadence_step, 1)`,
      [firmId, clientId, start, end]
    ).then((r) => r.rows);
  } catch (error) {
    if (missingTables(error)) return zero;
    throw error;
  }

  const out = { ...zero, detail: { by_action_type: {} } };
  for (const row of receipts) {
    const byType = out.detail.by_action_type[row.action_type]
      || (out.detail.by_action_type[row.action_type] = { sent: 0, cancelled: 0, refused: 0, failed: 0 });
    byType[row.outcome] = (byType[row.outcome] || 0) + row.n;
    if (row.outcome === 'sent') {
      out.actions_executed += row.n;
      out.minutes_saved += row.n * (MINUTES_SAVED_PER_ACTION[row.action_type] || 0);
      if (row.action_type === 'send_receivable_reminder') out.reminders_sent += row.n;
      // M2 issuance counters: every executed issue is a real invoice
      // (recurring periods included); quotes_sent counts the step-1 SEND
      // only — follow-ups are chases on the same quote, not new quotes.
      if (row.action_type === 'issue_invoice') out.invoices_issued += row.n;
      if (row.action_type === 'send_quote' && Number(row.cadence_step) <= 1) out.quotes_sent += row.n;
    } else if (row.outcome === 'cancelled' || row.outcome === 'refused') {
      out.cancels += row.n;
    } else if (row.outcome === 'failed') {
      out.failures += row.n;
    }
  }

  // Owner approval taps: the approved_at stamp on the action row (the
  // audit_events mirror exists too; the action row is the cheaper read).
  out.approval_taps = await client.query(
    `select count(*)::int as n from outbound_actions
      where firm_id = $1 and client_id = $2
        and approved_at >= $3::timestamptz and approved_at < $4::timestamptz`,
    [firmId, clientId, start, end]
  ).then((r) => r.rows[0]?.n || 0).catch((error) => {
    if (missingTables(error)) return 0;
    throw error;
  });

  // False-chase candidates: already_settled cancels on a cadence step AFTER
  // one already sent (upper bound — see header).
  out.false_chase_candidates = await client.query(
    `select count(*)::int as n
       from outbound_action_receipts r
       join outbound_actions a on a.id = r.action_id
      where r.firm_id = $1 and r.client_id = $2
        and r.created_at >= $3::timestamptz and r.created_at < $4::timestamptz
        and r.outcome = 'cancelled' and r.reason like '%already_settled%'
        and coalesce(a.cadence_step, 0) > 1`,
    [firmId, clientId, start, end]
  ).then((r) => r.rows[0]?.n || 0).catch((error) => {
    if (missingTables(error)) return 0;
    throw error;
  });

  try {
    const cases = await client.query(
      `select
         count(*) filter (where created_at >= $3::timestamptz and created_at < $4::timestamptz)::int as opened,
         count(*) filter (where settled_at >= $3::timestamptz and settled_at < $4::timestamptz)::int as settled,
         coalesce(sum(amount) filter (
           where settled_at >= $3::timestamptz and settled_at < $4::timestamptz and current_step >= 1
         ), 0) as collected_after_chase,
         avg((settled_at::date - due_date)) filter (
           where settled_at >= $3::timestamptz and settled_at < $4::timestamptz and due_date is not null
         ) as avg_days_late
       from receivable_cases
      where firm_id = $1 and client_id = $2`,
      [firmId, clientId, start, end]
    ).then((r) => r.rows[0] || {});
    out.cases_opened = cases.opened || 0;
    out.cases_settled = cases.settled || 0;
    out.collected_after_chase_amount = Number(cases.collected_after_chase) || 0;
    out.avg_days_late_at_settlement = cases.avg_days_late == null ? null : Number(cases.avg_days_late);
  } catch (error) {
    if (!missingTables(error)) throw error;
  }

  // §3 guard-rail metric: approval-to-auto graduation state per client ×
  // action type (the D1 earned-auto ladder). A state snapshot as of compute
  // time, keyed into the detail jsonb — Kari's glanceable read on where each
  // client sits on the ladder.
  try {
    const ladders = await gatherEarnedAutoStates(client, { firmId, clientId });
    if (ladders.length) {
      out.detail.earned_auto = {};
      for (const row of ladders) {
        out.detail.earned_auto[row.action_type] = {
          state: row.state,
          clean_streak: Number(row.clean_streak) || 0,
          total_clean: Number(row.total_clean) || 0,
          corrections: Number(row.corrections_count) || 0,
          target: cleanSendTargetFor(row)
        };
      }
    }
  } catch (error) {
    if (!missingTables(error)) throw error;
  }

  // reply_if_wrong v2: owner email replies classified in the window, by
  // terminal status — marked_wrong feeds the correction picture, needs_owner
  // feeds the owner-interruption rate (a decider metric).
  try {
    const replies = await client.query(
      `select status, count(*)::int as n
         from outbound_owner_replies
        where firm_id = $1 and client_id = $2
          and classified_at >= $3 and classified_at < $4
        group by status`,
      [firmId, clientId, start, end]
    ).then((r) => r.rows);
    if (replies.length) {
      out.detail.owner_replies = {};
      for (const row of replies) out.detail.owner_replies[row.status] = row.n;
    }
  } catch (error) {
    if (!missingTables(error)) throw error;
  }

  return out;
};

export const hasOutboundActivity = (metrics) =>
  Boolean(metrics && (
    metrics.actions_executed || metrics.approval_taps || metrics.cancels
    || metrics.failures || metrics.cases_opened || metrics.cases_settled
  ));

// Compute + upsert one client-day. Skips the write when the day had zero
// activity (an all-zero row per client per day is noise, and the absence of
// a row IS the zero). Returns { computed, written }.
export const rollupOutboundMetricsForClient = async (client, { firmId, clientId, day }) => {
  const metrics = await computeOutboundMetricsForDay(client, { firmId, clientId, day });
  if (!hasOutboundActivity(metrics)) return { computed: metrics, written: false };
  try {
    await client.query(
      `insert into outbound_metrics_daily
         (id, firm_id, client_id, metric_date, reminders_sent, actions_executed,
          invoices_issued, quotes_sent,
          approval_taps, cancels, failures, cases_opened, cases_settled,
          collected_after_chase_amount, false_chase_candidates, minutes_saved,
          avg_days_late_at_settlement, detail, computed_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18::jsonb, now())
       on conflict (firm_id, client_id, metric_date) do update set
         reminders_sent = excluded.reminders_sent,
         actions_executed = excluded.actions_executed,
         invoices_issued = excluded.invoices_issued,
         quotes_sent = excluded.quotes_sent,
         approval_taps = excluded.approval_taps,
         cancels = excluded.cancels,
         failures = excluded.failures,
         cases_opened = excluded.cases_opened,
         cases_settled = excluded.cases_settled,
         collected_after_chase_amount = excluded.collected_after_chase_amount,
         false_chase_candidates = excluded.false_chase_candidates,
         minutes_saved = excluded.minutes_saved,
         avg_days_late_at_settlement = excluded.avg_days_late_at_settlement,
         detail = excluded.detail,
         computed_at = now()`,
      [randomUUID(), firmId, clientId, metrics.metric_date,
        metrics.reminders_sent, metrics.actions_executed,
        metrics.invoices_issued, metrics.quotes_sent,
        metrics.approval_taps,
        metrics.cancels, metrics.failures, metrics.cases_opened, metrics.cases_settled,
        metrics.collected_after_chase_amount, metrics.false_chase_candidates,
        metrics.minutes_saved, metrics.avg_days_late_at_settlement,
        JSON.stringify(metrics.detail || {})]
    );
  } catch (error) {
    if (missingTables(error)) return { computed: metrics, written: false };
    throw error;
  }
  return { computed: metrics, written: true };
};
