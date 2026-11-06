// Donna — convergence metric snapshots: the Slice J time-series TREND.
//
// Slice J's convergence metric (reconcileConvergenceState.convergenceMetricsForFeed
// → { overall, by_client }) is recomputed fresh on every firm-snapshot load and
// persisted nowhere, so the two-terminal-states verdict is only ever observable
// at the current instant. CLAUDE.md's GOAL names the decider as "the escalation
// rate AND ITS TREND … at what customer count does the exception queue stop
// draining to zero each week." A trend needs a persisted series — this module
// writes/reads it (table: convergence_metric_snapshots, migration 049).
//
// It RECORDS the already-computed per-client convergenceMetrics blob — it never
// re-derives convergence (the FE/BE projection owns that verdict; we only sample
// it over time). Render the persisted verdict, not the legacy layer (CLAUDE.md).
// Patterned on loopGoalStore.js / memoryCandidates.js: an injected `client`, a
// to_regclass presence guard so a pre-049 deploy degrades to a clean no-op, and
// a softFail that swallows only 42P01/42703 (missing relation/column).
//
// This is plain "Keep"-layer metrics plumbing — no LLM, no re-inference. The
// daily key (id = cms:<firm>:<client>:<UTC-day>) makes the sampler idempotent
// within a day (last reading wins) and bounds growth to one row per client per
// day.
import { toIsoDay, toUtcIsoDay } from './dates.js';

// to_regclass returns null (never throws) for a missing relation → a 048-but-not-049
// deploy degrades to a no-op instead of aborting the surrounding transaction with
// 42P01.
export const convergenceSnapshotTablePresent = async (client) => {
  if (!client) return false;
  const present = await client.query(
    "select to_regclass('public.convergence_metric_snapshots') as present"
  );
  return Boolean(present.rows[0]?.present);
};

const softFail = (error) => {
  if (error?.code === '42P01' || error?.code === '42703') return { rows: [], rowCount: 0 };
  throw error;
};

// The UTC day bucket. Server-side code (not a workflow script), so new Date() is
// available. UTC on purpose: it keeps the daily key stable regardless of where
// the cron fires (the host zone must not move the bucket).
const todayUtc = () => toUtcIsoDay(new Date());

// The deterministic daily key. firm/client ids are slugs and the date is ISO, so
// the colon-join is unambiguous; on conflict (id) is the upsert seam.
export const buildSnapshotId = (firmId, clientId, capturedDate) =>
  `cms:${firmId}:${clientId}:${capturedDate}`;

const normalizeDate = (value) => {
  if (value instanceof Date) return toIsoDay(value); // a pg `date`: local midnight
  return String(value);
};

// PURE — percentile_cont-style linear interpolation over a sorted ascending
// numeric array. Exported for the Q5 sample below and its test.
export const percentileOf = (sortedAsc, q) => {
  if (!Array.isArray(sortedAsc) || !sortedAsc.length) return null;
  const idx = q * (sortedAsc.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sortedAsc[lo];
  return sortedAsc[lo] + (idx - lo) * (sortedAsc[hi] - sortedAsc[lo]);
};

// Q5 (design 2026-07-06 §4; Kari's dated answer: asks-sent-per-week + open-ask
// age percentiles, persisted daily per client) — the ask-clock half of the
// daily sample, computed at snapshot time straight off client_evidence_requests
// (the F9 probe SQL generalized). Pure read; soft-fails to null so a metric
// enrichment failure never blocks the base sample. Ages are DAYS (1 decimal)
// since the ask was first sent (falling back to created_at), over the
// still-outstanding population (draft/open — the on_owner statuses).
// Percentiles are interpolated in JS over the bounded open set (a per-client
// open-ask population is small by construction — the two-terminal principle
// drives it to zero) rather than WITHIN GROUP SQL the writer linter can't read.
export const computeAskClockMetrics = async ({ client, firmId, clientId, now = Date.now() } = {}) => {
  if (!client || !firmId || !clientId) return null;
  const nowIso = new Date(now).toISOString();
  const sentRes = await client.query(
    `select count(*) as asks_sent_7d
       from client_evidence_requests
      where firm_id = $1 and client_id = $2
        and first_sent_at >= $3::timestamptz - interval '7 days'`,
    [firmId, clientId, nowIso]
  ).catch(() => null);
  if (!sentRes) return null;
  const openRes = await client.query(
    `select status, first_sent_at, created_at,
            coalesce(request_payload->>'escalated_to_firm', '') as escalated
       from client_evidence_requests
      where firm_id = $1 and client_id = $2
        and status in ('draft', 'open')
      order by coalesce(first_sent_at, created_at) asc
      limit 1000`,
    [firmId, clientId]
  ).catch(() => null);
  if (!openRes) return null;
  const nowMs = new Date(now).getTime();
  const ages = [];
  let escalatedOpen = 0;
  for (const row of openRes.rows || []) {
    const anchor = row.first_sent_at || row.created_at;
    const t = anchor ? new Date(anchor).getTime() : NaN;
    if (Number.isFinite(t)) ages.push(Math.max(0, (nowMs - t) / 86400000));
    if (row.status === 'open' && row.escalated) escalatedOpen += 1;
  }
  ages.sort((a, b) => a - b);
  const round1 = (v) => (v == null ? null : Math.round(v * 10) / 10);
  return {
    asks_sent_7d: Number(sentRes.rows?.[0]?.asks_sent_7d || 0),
    open_asks: (openRes.rows || []).length,
    escalated_open: escalatedOpen,
    open_ask_age_days: {
      p50: round1(percentileOf(ages, 0.5)),
      p90: round1(percentileOf(ages, 0.9)),
      max: round1(ages.length ? ages[ages.length - 1] : null)
    }
  };
};

// Persist one row per client for the day from a convergenceMetricsForFeed
// `by_client` map. The '__unknown__' bucket (unattributable rows) is NEVER
// persisted — a trend is per-book, and an un-scoped bucket would muddy it.
// Upserts (last reading of the day wins). Returns { recorded, skipped, date }.
// `askClocksByClient` (optional) merges each client's Q5 ask-clock sample
// (computeAskClockMetrics output) into the persisted blob under `ask_clocks`
// — same row, no new table (design §4: extend the migration-049 substrate).
export const recordConvergenceMetricsSnapshot = async ({
  client, firmId, byClient = {}, askClocksByClient = {}, capturedDate = null
} = {}) => {
  const date = capturedDate || todayUtc();
  const summary = { recorded: 0, skipped: 0, date };
  if (!client || !firmId) return summary;
  if (!(await convergenceSnapshotTablePresent(client))) return summary;
  for (const [clientId, metric] of Object.entries(byClient || {})) {
    if (!clientId || clientId === '__unknown__' || !metric || typeof metric !== 'object') {
      summary.skipped += 1;
      continue;
    }
    const askClocks = askClocksByClient && typeof askClocksByClient === 'object'
      ? askClocksByClient[clientId]
      : null;
    const blob = askClocks ? { ...metric, ask_clocks: askClocks } : metric;
    const id = buildSnapshotId(firmId, clientId, date);
    await client.query(
      `insert into convergence_metric_snapshots (id, firm_id, client_id, captured_date, metric)
       values ($1, $2, $3, $4, $5)
       on conflict (id) do update set metric = excluded.metric, captured_at = now()`,
      [id, firmId, clientId, date, JSON.stringify(blob)]
    ).catch(softFail);
    summary.recorded += 1;
  }
  return summary;
};

// Read a client's series, oldest→newest, over the last `sinceDays` days (so a
// caller can compute the trend in chronological order). Capped defensively.
// Returns [{ captured_date, metric, captured_at }].
export const loadConvergenceMetricTrend = async ({
  client, firmId, clientId, sinceDays = 90, limit = 365
} = {}) => {
  if (!client || !firmId || !clientId) return [];
  if (!(await convergenceSnapshotTablePresent(client))) return [];
  const days = Number.isFinite(Number(sinceDays)) && Number(sinceDays) > 0
    ? Math.floor(Number(sinceDays)) : 90;
  const cap = Number.isFinite(Number(limit)) && Number(limit) > 0
    ? Math.min(Math.floor(Number(limit)), 1000) : 365;
  const result = await client.query(
    `select captured_date, metric, captured_at
       from convergence_metric_snapshots
      where firm_id = $1 and client_id = $2
        and captured_date >= (current_date - ($3::int))
      order by captured_date asc
      limit $4`,
    [firmId, clientId, days, cap]
  ).catch(softFail);
  return (result.rows || []).map((r) => ({
    captured_date: normalizeDate(r.captured_date),
    metric: r.metric,
    captured_at: r.captured_at
  }));
};

// PURE — the analytical payoff. Given a chronological series (oldest→newest, the
// loadConvergenceMetricTrend order), summarize the TREND of the two decider
// rates: prompts_per_100 (the escalation rate — CLAUDE.md's "ONE metric") and
// hanging_per_100 (the two-terminal-states violation rate). 'improving' means the
// rate fell over the window, 'worsening' means it rose, 'flat' means no change /
// too few points. No DB, no LLM — operates on the persisted blobs only.
export const summarizeConvergenceTrend = (series = []) => {
  const points = (Array.isArray(series) ? series : [])
    .filter((s) => s && s.metric && typeof s.metric === 'object')
    .map((s) => ({ date: s.captured_date, m: s.metric }));
  if (!points.length) {
    return {
      points: 0, first: null, latest: null,
      prompts_per_100_delta: 0, hanging_per_100_delta: 0,
      prompts_trend: 'flat', hanging_trend: 'flat', converged: null
    };
  }
  const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  const first = points[0];
  const latest = points[points.length - 1];
  const round1 = (n) => Math.round(n * 10) / 10;
  const delta = (sel) => round1(num(sel(latest.m)) - num(sel(first.m)));
  const dir = (d) => (d < 0 ? 'improving' : d > 0 ? 'worsening' : 'flat');
  const pDelta = delta((m) => m.prompts_per_100);
  const hDelta = delta((m) => m.hanging_per_100);
  // Q5 (Kari, 2026-07-06): the trend surface LEADS with asks/week + open-ask
  // age percentiles; prompts_per_100 stays for continuity. ask_clocks is null
  // for pre-Q5 samples — renderers must tolerate the gap, never re-infer it.
  const askClocksOf = (m) => (m.ask_clocks && typeof m.ask_clocks === 'object' ? m.ask_clocks : null);
  return {
    points: points.length,
    first: {
      date: first.date,
      prompts_per_100: num(first.m.prompts_per_100),
      hanging_per_100: num(first.m.hanging_per_100),
      ask_clocks: askClocksOf(first.m)
    },
    latest: {
      date: latest.date,
      prompts_per_100: num(latest.m.prompts_per_100),
      hanging_per_100: num(latest.m.hanging_per_100),
      ask_clocks: askClocksOf(latest.m)
    },
    prompts_per_100_delta: pDelta,
    hanging_per_100_delta: hDelta,
    prompts_trend: dir(pDelta),
    hanging_trend: dir(hDelta),
    converged: Boolean(latest.m.converged)
  };
};

// Client-delete purge (CLAUDE.md "firm memory dies with its client"). The plain
// client_id column means the clients-delete cascade misses these rows, so this
// explicit hard-delete — run INSIDE the client-delete transaction — is
// load-bearing. This table is NOT append-only-trigger-guarded (it is metrics
// plumbing, not an audit verdict), so no escape hatch is needed. Presence-guarded
// so a pre-049 deploy never blocks a client deletion.
export const purgeConvergenceMetricSnapshotsForDeletedClient = async ({
  client, firmId, clientId
} = {}) => {
  const summary = { snapshots: 0 };
  if (!client || !firmId || !clientId) return summary;
  if (!(await convergenceSnapshotTablePresent(client))) return summary;
  const res = await client.query(
    'delete from convergence_metric_snapshots where firm_id = $1 and client_id = $2',
    [firmId, clientId]
  ).catch(softFail);
  summary.snapshots = res.rowCount || 0;
  return summary;
};
