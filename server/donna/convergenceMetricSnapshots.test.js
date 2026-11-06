// Donna — convergence metric snapshots (Slice J trend) unit tests. Load-bearing
// properties:
//   - the daily key is deterministic → the sampler upserts within a day (one row
//     per client per day, last reading wins)
//   - the '__unknown__' bucket and malformed metrics are NEVER persisted (a trend
//     is per-book)
//   - summarizeConvergenceTrend is PURE and reports the escalation-rate (and
//     violation-rate) direction over a chronological series
//   - the client-delete purge hard-deletes by (firm, client)
//   - a pre-049 deploy degrades to a clean no-op, never an aborting 42P01

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  convergenceSnapshotTablePresent,
  buildSnapshotId,
  recordConvergenceMetricsSnapshot,
  loadConvergenceMetricTrend,
  summarizeConvergenceTrend,
  purgeConvergenceMetricSnapshotsForDeletedClient
} from './convergenceMetricSnapshots.js';

const makeMockClient = (responders = [], { tablesPresent = true } = {}) => {
  const calls = [];
  const queue = [...responders];
  return {
    calls,
    query: async (sql, params) => {
      calls.push({ sql: String(sql), params });
      const text = String(sql).toLowerCase();
      if (text.includes('to_regclass')) {
        return { rows: [{ present: tablesPresent ? 'convergence_metric_snapshots' : null }] };
      }
      const idx = queue.findIndex((r) => text.includes(r.match));
      if (idx !== -1) {
        const [r] = queue.splice(idx, 1);
        if (r.throw) throw r.throw;
        return { rows: r.rows || [], rowCount: r.rowCount ?? (r.rows || []).length };
      }
      return { rows: [], rowCount: 0 };
    }
  };
};

const metric = (over = {}) => ({
  auto_reconciled: 8, on_owner: 1, hanging: 1, total: 10, converged: false,
  hanging_by_reason: { matched_pending_authority_no_grant: 1 },
  authority_misses: 1, prompts_per_100: 10, hanging_per_100: 10, ...over
});

// ── buildSnapshotId ────────────────────────────────────────────────────────

test('buildSnapshotId: deterministic cms:<firm>:<client>:<date> key', () => {
  assert.equal(
    buildSnapshotId('donna-production', 'honeybee-hills-apiary-llc', '2026-06-30'),
    'cms:donna-production:honeybee-hills-apiary-llc:2026-06-30'
  );
});

// ── presence guard ─────────────────────────────────────────────────────────

test('convergenceSnapshotTablePresent: true when to_regclass resolves, false pre-049', async () => {
  assert.equal(await convergenceSnapshotTablePresent(makeMockClient()), true);
  assert.equal(await convergenceSnapshotTablePresent(makeMockClient([], { tablesPresent: false })), false);
});

// ── recordConvergenceMetricsSnapshot ───────────────────────────────────────

test('record: one upsert per client, deterministic id, last-write-wins', async () => {
  const c = makeMockClient([
    { match: 'insert into convergence_metric_snapshots', rows: [] },
    { match: 'insert into convergence_metric_snapshots', rows: [] }
  ]);
  const out = await recordConvergenceMetricsSnapshot({
    client: c, firmId: 'firm-1', capturedDate: '2026-06-30',
    byClient: { 'client-a': metric(), 'client-b': metric({ prompts_per_100: 0 }) }
  });
  assert.equal(out.recorded, 2);
  assert.equal(out.skipped, 0);
  assert.equal(out.date, '2026-06-30');
  const inserts = c.calls.filter((q) => /insert into convergence_metric_snapshots/.test(q.sql));
  assert.equal(inserts.length, 2);
  assert.match(inserts[0].sql, /on conflict \(id\) do update set metric = excluded\.metric/);
  assert.equal(inserts[0].params[0], 'cms:firm-1:client-a:2026-06-30');
  assert.equal(inserts[0].params[1], 'firm-1');
  assert.equal(inserts[0].params[2], 'client-a');
  assert.equal(inserts[0].params[3], '2026-06-30');
  // metric is JSON-serialized
  assert.equal(typeof inserts[0].params[4], 'string');
  assert.deepEqual(JSON.parse(inserts[0].params[4]).authority_misses, 1);
});

test('record: never persists the __unknown__ bucket or malformed metrics', async () => {
  const c = makeMockClient([{ match: 'insert into convergence_metric_snapshots', rows: [] }]);
  const out = await recordConvergenceMetricsSnapshot({
    client: c, firmId: 'firm-1', capturedDate: '2026-06-30',
    byClient: { __unknown__: metric(), 'client-a': metric(), 'client-b': null, '': metric() }
  });
  assert.equal(out.recorded, 1, 'only client-a persists');
  assert.equal(out.skipped, 3, '__unknown__, null metric, empty key skipped');
  const inserts = c.calls.filter((q) => /insert into convergence_metric_snapshots/.test(q.sql));
  assert.equal(inserts.length, 1);
  assert.equal(inserts[0].params[2], 'client-a');
});

test('record: pre-049 deploy → clean no-op (no insert attempted)', async () => {
  const c = makeMockClient([], { tablesPresent: false });
  const out = await recordConvergenceMetricsSnapshot({
    client: c, firmId: 'firm-1', byClient: { 'client-a': metric() }
  });
  assert.equal(out.recorded, 0);
  assert.equal(c.calls.some((q) => /insert into/.test(q.sql)), false);
});

test('record: missing client/firm → empty no-op', async () => {
  assert.deepEqual(
    (await recordConvergenceMetricsSnapshot({ client: null, firmId: 'f', byClient: {} })).recorded, 0
  );
  assert.deepEqual(
    (await recordConvergenceMetricsSnapshot({ client: makeMockClient(), firmId: null })).recorded, 0
  );
});

// ── loadConvergenceMetricTrend ─────────────────────────────────────────────

test('load: reads the client series chronologically, normalizes Date → ISO day', async () => {
  const c = makeMockClient([{
    match: 'from convergence_metric_snapshots',
    rows: [
      { captured_date: new Date(2026, 5, 28), metric: metric({ prompts_per_100: 20 }), captured_at: 'a' }, // the pg `date` shape: local midnight
      { captured_date: '2026-06-30', metric: metric({ prompts_per_100: 10 }), captured_at: 'b' }
    ]
  }]);
  const series = await loadConvergenceMetricTrend({ client: c, firmId: 'firm-1', clientId: 'client-a' });
  assert.equal(series.length, 2);
  assert.equal(series[0].captured_date, '2026-06-28');
  assert.equal(series[1].captured_date, '2026-06-30');
  const q = c.calls.find((x) => /from convergence_metric_snapshots/.test(x.sql));
  assert.match(q.sql, /order by captured_date asc/);
  assert.equal(q.params[0], 'firm-1');
  assert.equal(q.params[1], 'client-a');
});

test('load: pre-049 / missing args → empty array', async () => {
  assert.deepEqual(await loadConvergenceMetricTrend({ client: makeMockClient([], { tablesPresent: false }), firmId: 'f', clientId: 'c' }), []);
  assert.deepEqual(await loadConvergenceMetricTrend({ client: null, firmId: 'f', clientId: 'c' }), []);
});

// ── summarizeConvergenceTrend (PURE) ───────────────────────────────────────

test('trend: empty series → flat zero summary', () => {
  const t = summarizeConvergenceTrend([]);
  assert.equal(t.points, 0);
  assert.equal(t.prompts_trend, 'flat');
  assert.equal(t.hanging_trend, 'flat');
  assert.equal(t.first, null);
  assert.equal(t.latest, null);
  assert.equal(t.converged, null);
});

test('trend: falling escalation rate over the window → improving', () => {
  const t = summarizeConvergenceTrend([
    { captured_date: '2026-06-01', metric: metric({ prompts_per_100: 30, hanging_per_100: 20 }) },
    { captured_date: '2026-06-15', metric: metric({ prompts_per_100: 18, hanging_per_100: 12 }) },
    { captured_date: '2026-06-30', metric: metric({ prompts_per_100: 10, hanging_per_100: 0, converged: true }) }
  ]);
  assert.equal(t.points, 3);
  assert.equal(t.first.prompts_per_100, 30);
  assert.equal(t.latest.prompts_per_100, 10);
  assert.equal(t.prompts_per_100_delta, -20);
  assert.equal(t.hanging_per_100_delta, -20);
  assert.equal(t.prompts_trend, 'improving');
  assert.equal(t.hanging_trend, 'improving');
  assert.equal(t.converged, true);
});

test('trend: rising escalation rate → worsening; flat → flat', () => {
  const worse = summarizeConvergenceTrend([
    { captured_date: '2026-06-01', metric: metric({ prompts_per_100: 5 }) },
    { captured_date: '2026-06-30', metric: metric({ prompts_per_100: 25 }) }
  ]);
  assert.equal(worse.prompts_per_100_delta, 20);
  assert.equal(worse.prompts_trend, 'worsening');

  const flat = summarizeConvergenceTrend([
    { captured_date: '2026-06-01', metric: metric({ prompts_per_100: 12 }) },
    { captured_date: '2026-06-30', metric: metric({ prompts_per_100: 12 }) }
  ]);
  assert.equal(flat.prompts_per_100_delta, 0);
  assert.equal(flat.prompts_trend, 'flat');
});

test('trend: tolerates missing/non-numeric rate fields (treats as 0), skips metric-less points', () => {
  const t = summarizeConvergenceTrend([
    null,
    { captured_date: '2026-06-01', metric: {} },
    { captured_date: '2026-06-30', metric: { prompts_per_100: 'x', hanging_per_100: 7 } }
  ]);
  assert.equal(t.points, 2);
  assert.equal(t.first.prompts_per_100, 0);
  assert.equal(t.latest.prompts_per_100, 0);
  assert.equal(t.hanging_per_100_delta, 7);
  assert.equal(t.hanging_trend, 'worsening');
});

// ── purge ──────────────────────────────────────────────────────────────────

test('purge: hard-deletes by (firm, client), returns count', async () => {
  const c = makeMockClient([{ match: 'delete from convergence_metric_snapshots', rowCount: 4 }]);
  const out = await purgeConvergenceMetricSnapshotsForDeletedClient({ client: c, firmId: 'firm-1', clientId: 'client-a' });
  assert.equal(out.snapshots, 4);
  const del = c.calls.find((q) => /delete from convergence_metric_snapshots/.test(q.sql));
  assert.equal(del.params[0], 'firm-1');
  assert.equal(del.params[1], 'client-a');
});

test('purge: pre-049 / missing args → clean no-op', async () => {
  assert.deepEqual(
    await purgeConvergenceMetricSnapshotsForDeletedClient({ client: makeMockClient([], { tablesPresent: false }), firmId: 'f', clientId: 'c' }),
    { snapshots: 0 }
  );
  assert.deepEqual(
    await purgeConvergenceMetricSnapshotsForDeletedClient({ client: null, firmId: 'f', clientId: 'c' }),
    { snapshots: 0 }
  );
});

// ── Q5 — the ask-clock half of the daily sample (design 2026-07-06 §4) ────────

import { computeAskClockMetrics, percentileOf } from './convergenceMetricSnapshots.js';

test('percentileOf interpolates percentile_cont-style over a sorted array', () => {
  assert.equal(percentileOf([], 0.5), null);
  assert.equal(percentileOf([4], 0.9), 4);
  assert.equal(percentileOf([1, 3], 0.5), 2);
  assert.equal(percentileOf([0, 10, 20, 30, 40], 0.9), 36);
});

test('computeAskClockMetrics samples asks_sent_7d + open-ask age percentiles in days', async () => {
  const NOW = new Date('2026-07-07T00:00:00Z').getTime();
  const openRow = (daysAgo, escalated = '') => ({
    status: 'open',
    first_sent_at: new Date(NOW - daysAgo * 86400000).toISOString(),
    created_at: new Date(NOW - daysAgo * 86400000).toISOString(),
    escalated
  });
  const client = {
    query: async (sql) => {
      if (String(sql).includes('asks_sent_7d')) return { rows: [{ asks_sent_7d: '3' }] };
      return { rows: [openRow(21, '{"at":"x"}'), openRow(5), openRow(1)] };
    }
  };
  const clocks = await computeAskClockMetrics({ client, firmId: 'firm-1', clientId: 'client-1', now: NOW });
  assert.deepEqual(clocks, {
    asks_sent_7d: 3,
    open_asks: 3,
    escalated_open: 1,
    open_ask_age_days: { p50: 5, p90: 17.8, max: 21 }
  });
  // Soft-fail: a throwing read yields null, never breaks the sampler.
  const broken = { query: async () => { throw new Error('boom'); } };
  assert.equal(await computeAskClockMetrics({ client: broken, firmId: 'f', clientId: 'c' }), null);
});

test('recordConvergenceMetricsSnapshot merges ask_clocks into the persisted blob (same 049 row)', async () => {
  const inserted = [];
  const client = {
    query: async (sql, params) => {
      if (String(sql).includes('to_regclass')) return { rows: [{ present: 'x' }] };
      if (String(sql).includes('insert into convergence_metric_snapshots')) inserted.push(params);
      return { rows: [] };
    }
  };
  const clocks = { asks_sent_7d: 2, open_asks: 1, escalated_open: 0, open_ask_age_days: { p50: 3, p90: 9, max: 12 } };
  const summary = await recordConvergenceMetricsSnapshot({
    client,
    firmId: 'firm-1',
    byClient: { 'client-1': { prompts_per_100: 10, hanging_per_100: 0 }, 'client-2': { prompts_per_100: 5 } },
    askClocksByClient: { 'client-1': clocks },
    capturedDate: '2026-07-07'
  });
  assert.equal(summary.recorded, 2);
  const blob1 = JSON.parse(inserted.find((p) => p[2] === 'client-1')[4]);
  assert.deepEqual(blob1.ask_clocks, clocks, 'ask_clocks rides the same blob');
  assert.equal(blob1.prompts_per_100, 10, 'the base metric is untouched');
  const blob2 = JSON.parse(inserted.find((p) => p[2] === 'client-2')[4]);
  assert.equal(blob2.ask_clocks, undefined, 'no clocks → blob byte-identical');
});

test('summarizeConvergenceTrend surfaces ask_clocks on first/latest (null for pre-Q5 samples)', () => {
  const series = [
    { captured_date: '2026-07-01', metric: { prompts_per_100: 12, hanging_per_100: 3 } },
    { captured_date: '2026-07-07', metric: { prompts_per_100: 9, hanging_per_100: 0, ask_clocks: { asks_sent_7d: 2, open_ask_age_days: { p50: 3, p90: 9, max: 12 } } } }
  ];
  const trend = summarizeConvergenceTrend(series);
  assert.equal(trend.first.ask_clocks, null, 'pre-Q5 sample renders honestly as null');
  assert.equal(trend.latest.ask_clocks.asks_sent_7d, 2);
  assert.equal(trend.latest.ask_clocks.open_ask_age_days.p90, 9);
  assert.equal(trend.prompts_trend, 'improving', 'the continuity metrics still compute');
});
