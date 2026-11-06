-- Config control plane — Phase 0A.3 (docs/donna-config-control-plane-phase-0A-impl.md §4
-- + docs/donna-self-awareness-plan.md §6: "Enrollment is by cohort … so new test clients
-- inherit via membership — not env edits and not an ambiguous default"). The cohort layer
-- that sits BETWEEN the firm-wide default and a client-specific row in client_capability_config
-- (042): a client's effective stage for a flag is resolved at READ time as
--   client-specific (042, client_id set)  >  cohort (here, via membership)  >  firm default (042, client_id null).
--
-- Read-time (not materialised) ON PURPOSE: a new client added to a cohort inherits the
-- cohort's enrolled flags at its very next config read — no re-minting, no per-client copy
-- to keep in sync. This is what "inherit via membership" means and what solves the
-- 4-new-test-clients problem without an ambiguous global default. Empty enrollment = ∅
-- (invariant #3): a client in no cohort, or a cohort with no flag row, broadens nothing.
--
-- 042 is deliberately UNTOUCHED — these two tables live beside it so the dormant 0A.1
-- substrate stays exactly as shipped, and clientConfig.readClientConfigSnapshot reads the
-- cohort layer with an INDEPENDENT soft-fail (a DB that has 042 but not yet 043 keeps its
-- 042 rows working; the cohort layer just resolves empty).
--
-- Both tables FK-cascade to firms (+ clients, for membership): a cohort row dies with its
-- firm, a membership dies with its client — the 040/041/042 convention (a deleted/reset
-- client gets a genuine clean slate, no stale enrollment inherited).

-- ── cohort_capability_config — the cohort-level flag stage ────────────────────────────
-- Mirrors client_capability_config (042) exactly, but keyed by cohort_key instead of a
-- client_id: "every client in cohort C runs flag F at stage S." source defaults to 'cohort'
-- (the provenance the per-client snapshot reports when a stage came from the cohort layer).
create table if not exists cohort_capability_config (
  id text primary key,
  firm_id text not null references firms(id) on delete cascade,
  cohort_key text not null,
  flag_key text not null,
  -- flag-as-stage. Same CHECK vocabulary as 042, pinned to clientConfig.js CONFIG_STAGES
  -- (migrations.test.js keeps them in lockstep). off/dry_run/shadow do NOT act; canary/auto do.
  stage text not null default 'off' check (stage in ('off', 'dry_run', 'shadow', 'canary', 'auto')),
  -- provenance. 'cohort' is the natural default here; emergency_override may only force a
  -- flag OFF — enforced in clientConfig.setCohortFlagStage, never here.
  source text not null default 'cohort' check (source in ('default', 'cohort', 'manual', 'emergency_override')),
  reason text,
  set_by_actor_type text not null default 'system',
  set_by_actor_id text,
  valid_from timestamptz not null default now(),
  valid_to timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- At most one ACTIVE row per (firm, cohort, flag).
create unique index if not exists cohort_capability_config_cohort_flag_uniq
  on cohort_capability_config(firm_id, cohort_key, flag_key)
  where valid_to is null;
-- The read path: cohort rows for a flag, active-only.
create index if not exists cohort_capability_config_lookup_idx
  on cohort_capability_config(firm_id, cohort_key, flag_key, valid_to);

-- ── client_cohort_members — the membership edge ──────────────────────────────────────
-- A client belongs to a cohort. client_id is NOT NULL (a membership is always a specific
-- client) and cascades on delete. The read path joins this to cohort_capability_config to
-- resolve the cohort layer for a given client.
create table if not exists client_cohort_members (
  id text primary key,
  firm_id text not null references firms(id) on delete cascade,
  cohort_key text not null,
  client_id text not null references clients(id) on delete cascade,
  reason text,
  set_by_actor_type text not null default 'system',
  set_by_actor_id text,
  valid_from timestamptz not null default now(),
  valid_to timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- At most one ACTIVE membership per (firm, cohort, client).
create unique index if not exists client_cohort_members_active_uniq
  on client_cohort_members(firm_id, cohort_key, client_id)
  where valid_to is null;
-- The read path: "which cohorts is this client in?" — active-only.
create index if not exists client_cohort_members_client_idx
  on client_cohort_members(firm_id, client_id, valid_to);

-- ── RLS-native (mirror 040 / 041 / 042) ──────────────────────────────────────────────
-- Governance data — the server connects as the RLS-exempt owner role; the browser never
-- queries these tables. ENABLE (not FORCE) so the owner stays exempt; revoke the Supabase
-- browser roles entirely. Guarded so a dev DB without those roles still applies cleanly.
alter table cohort_capability_config enable row level security;
alter table client_cohort_members enable row level security;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on cohort_capability_config from anon;
    revoke all on client_cohort_members from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on cohort_capability_config from authenticated;
    revoke all on client_cohort_members from authenticated;
  end if;
end $$;
