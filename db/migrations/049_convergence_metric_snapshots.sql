-- Donna — convergence metric snapshots (Slice J, the time-series trend).
--
-- WHY THIS TABLE EXISTS. Slice J's convergence metric
-- (server/donna/reconcileConvergenceState.js convergenceMetricsForFeed →
-- { overall, by_client }) is recomputed FRESH on every getFirmSnapshotFromDb
-- and persisted NOWHERE — so the two-terminal-states verdict is observable
-- only at the current instant. CLAUDE.md's GOAL names the decider metric as
-- "the escalation rate AND ITS TREND … at what customer count does the
-- exception queue stop draining to zero each week." A trend needs a persisted
-- series; this table is that series.
--
-- It is NOT a decision receipt and NOT a case verdict, so it does NOT belong in
-- the append-only loop_goal_reports / loop_runs surface (those are case+event
-- scoped, with mandatory case_id/event_id FKs). It is a periodic AGGREGATE
-- sample — one row per (firm, client, UTC day) — written by the daily
-- `parse-cron?task=convergence_snapshot` sampler (server/donna/api.js). The
-- daily key bounds growth and gives a clean daily trend; the sampler upserts
-- (last reading of the day wins), so this is plain "Keep"-layer metrics
-- plumbing (CLAUDE.md) — no LLM, no re-inference. The stored `metric` blob is
-- the persisted per-row convergence verdicts the snapshot already aggregated;
-- the trend reader RENDERS it, never re-derives convergence (CLAUDE.md "render
-- the persisted verdict, not the legacy layer").
--
-- client_id is a plain column (NOT a clients FK), the 033 / 037 / firm_facts
-- pattern: the clients-delete cascade does not reach these rows, so an explicit
-- client-delete purge (convergenceMetricSnapshots.purgeConvergenceMetricSnapshotsForDeletedClient,
-- wired into firmDb's client delete) is load-bearing — firm memory dies with
-- its client (CLAUDE.md rail).

-- ── convergence_metric_snapshots — one row per (firm, client, day) ───────────
-- id is the deterministic daily key `cms:<firm>:<client>:<YYYY-MM-DD>` so the
-- sampler upserts on conflict (id) — a second run on the same day overwrites
-- with the later reading rather than appending a duplicate. metric holds the
-- whole convergenceMetrics blob (counts + rates + hanging_by_reason) so the
-- trend reader never re-aggregates.
create table if not exists convergence_metric_snapshots (
  id            text primary key,
  firm_id       text not null references firms(id) on delete cascade,
  client_id     text not null,
  captured_date date not null,
  metric        jsonb not null,
  captured_at   timestamptz not null default now()
);

-- The read path: "this client's series, oldest→newest, over the last N days".
create index if not exists convergence_metric_snapshots_firm_client_date_idx
  on convergence_metric_snapshots (firm_id, client_id, captured_date desc);

-- ── RLS-native (mirror 037 / 044) ────────────────────────────────────────────
-- The server connects as the table-owner role (RLS-exempt); the browser never
-- queries this table. ENABLE (not FORCE) so the owner stays exempt; revoke the
-- Supabase anon/authenticated roles entirely. Guarded so a dev DB without those
-- roles still applies cleanly.
alter table convergence_metric_snapshots enable row level security;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on convergence_metric_snapshots from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on convergence_metric_snapshots from authenticated;
  end if;
end $$;
