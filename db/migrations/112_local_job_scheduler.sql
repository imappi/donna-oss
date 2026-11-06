-- Desktop M1 — the local durable job scheduler's tables (technical plan §4).
-- On desktop these replace Inngest Cloud + Vercel crons as the substrate for
-- scheduled work: the dispatcher enqueues one row per due cron tick and runs
-- the SAME handlers the cloud serves. In cloud deployments the tables are
-- inert (nothing enqueues). Semantics carried from the plan verbatim:
-- at-least-once with expiring leases, abandoned-job recovery, dedupe keys,
-- exponential retry, poison-job dead-lettering, handler_version recorded so
-- an update never reinterprets an old job invisibly.

create table if not exists local_jobs (
  id bigint generated always as identity primary key,
  function_id text not null,
  handler_version text not null default '1',
  payload jsonb not null default '{}'::jsonb,
  dedupe_key text,
  run_at timestamptz not null default now(),
  attempt_count integer not null default 0,
  max_attempts integer not null default 1,
  -- pending/running are transitions; succeeded/dead/cancelled are the only
  -- resting states (two-terminal-states, applied to the job table).
  status text not null default 'pending'
    check (status in ('pending', 'running', 'succeeded', 'dead', 'cancelled')),
  locked_by text,
  locked_at timestamptz,
  lease_expires_at timestamptz,
  last_error text,
  result jsonb,
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  cancelled_at timestamptz
);

-- One ACTIVE job per dedupe key: a catch-up re-enqueue of the same cron tick
-- lands on this and no-ops, while history rows (succeeded/dead) keep the key.
create unique index if not exists local_jobs_dedupe_active_idx
  on local_jobs (dedupe_key)
  where dedupe_key is not null and status in ('pending', 'running');

create index if not exists local_jobs_claim_idx
  on local_jobs (status, run_at);

-- Step memoization for the durable step shim: keyed by job id + step key, so
-- a retried attempt skips completed steps (Inngest's step.run semantics).
-- Rows survive retries by design and die with their job.
create table if not exists local_job_steps (
  job_id bigint not null references local_jobs(id) on delete cascade,
  step_key text not null,
  result jsonb,
  completed_at timestamptz not null default now(),
  primary key (job_id, step_key)
);

-- Last enqueued tick per cron function: bounded catch-up after sleep enqueues
-- at most the LATEST missed tick, never the unbounded backlog (plan §4/§9).
create table if not exists local_job_cron_state (
  function_id text primary key,
  last_enqueued_tick timestamptz,
  updated_at timestamptz not null default now()
);

-- Server-only tables: RLS on with no policies (deny-all for browser roles;
-- the service connection is unaffected). On desktop the local principal owns
-- the database and the Supabase roles simply don't exist.
alter table local_jobs enable row level security;
alter table local_job_steps enable row level security;
alter table local_job_cron_state enable row level security;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on local_jobs from anon;
    revoke all on local_job_steps from anon;
    revoke all on local_job_cron_state from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on local_jobs from authenticated;
    revoke all on local_job_steps from authenticated;
    revoke all on local_job_cron_state from authenticated;
  end if;
end $$;
