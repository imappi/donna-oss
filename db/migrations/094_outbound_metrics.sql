-- 094 — Outbound metrics daily rollup (M1, execution plan §3: captured from
-- customer #1, not retrofitted). One row per (client, UTC day), computed by
-- the outbound-metrics-rollup cron from PIPELINE RECEIPTS + case state —
-- never from a side channel; if a number here can't be traced to a receipt
-- or a case row, it doesn't belong here.
--
-- Attribution honesty (§3): collected_after_chase_amount is money that
-- settled AFTER at least one reminder went out — reported as "collected
-- after chase", never "collected because of chase". false_chase_candidates
-- is an UPPER-BOUND candidate set (already_settled cancels after a sent
-- step) that needs owner confirmation to become a true false-chase count —
-- the honest guard-rail metric until the D4 settlement signal gives the US
-- lane deterministic paid timestamps. minutes_saved multiplies executed
-- actions by the DECLARED per-action-type constants in outbound/metrics.js
-- (visible in any report footnote).

create table if not exists outbound_metrics_daily (
  id text primary key,
  firm_id text not null references firms(id) on delete cascade,
  client_id text not null references clients(id) on delete cascade,
  metric_date date not null,
  reminders_sent integer not null default 0,
  actions_executed integer not null default 0,
  approval_taps integer not null default 0,
  cancels integer not null default 0,
  failures integer not null default 0,
  cases_opened integer not null default 0,
  cases_settled integer not null default 0,
  collected_after_chase_amount numeric not null default 0,
  false_chase_candidates integer not null default 0,
  minutes_saved integer not null default 0,
  avg_days_late_at_settlement numeric,
  detail jsonb not null default '{}'::jsonb,
  computed_at timestamptz not null default now()
);

create unique index if not exists outbound_metrics_daily_key_idx
  on outbound_metrics_daily(firm_id, client_id, metric_date);

-- ── RLS-native (mirror 090–093) ──────────────────────────────────────────────
alter table outbound_metrics_daily enable row level security;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on outbound_metrics_daily from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on outbound_metrics_daily from authenticated;
  end if;
end $$;
