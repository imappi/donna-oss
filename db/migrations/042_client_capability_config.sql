-- Config control plane — Phase 0A (docs/donna-config-control-plane-phase-0A-impl.md +
-- docs/donna-self-awareness-plan.md §6). The DB-backed, audited, per-CLIENT feature-flag
-- store that replaces the ~14 env canaries (RECONCILIATION_*_CLIENTS) one flag at a time.
--
-- A flag is NOT binary — it is a STAGE (off | dry_run | shadow | canary | auto), folding
-- the trust ramp into the config primitive itself. 'off' is the fail-closed default;
-- empty enrollment = ∅ (invariant #3) — a client with no row never broadens scope.
--
-- CLIENT-scoped on purpose (Fork 1): the firm-scoped loop-tier model in firms.metadata
-- (loopExecutionGate.js) stays where it is; this table is the canaries' own home because
-- they gate per CLIENT (Honeybee is a client under donna-production), not per firm.
--
-- A config row dies with its client via the client_id FK cascade — the sibling
-- reconciliation_authority_grants (040) / reconciliation_evaluations (039) convention: a
-- deleted/reset client gets a genuine clean slate, no stale config inherited.

create table if not exists client_capability_config (
  id text primary key,
  firm_id text not null references firms(id) on delete cascade,
  -- client_id NULL = a firm-wide DEFAULT row for this flag (the cohort/default source);
  -- non-null = a client-specific row, which overrides the firm-wide default at read time.
  client_id text references clients(id) on delete cascade,
  flag_key text not null,
  -- flag-as-stage. The CHECK vocabulary is pinned to clientConfig.js CONFIG_STAGES
  -- (migrations.test.js keeps them in lockstep). off/dry_run/shadow do NOT take the live
  -- action; canary/auto do (clientConfig.stageActs).
  stage text not null default 'off' check (stage in ('off', 'dry_run', 'shadow', 'canary', 'auto')),
  -- provenance of the setting (for the audit/precedence story). emergency_override may
  -- only ever force a flag OFF — enforced in clientConfig.setClientFlagStage, never here.
  source text not null default 'manual' check (source in ('default', 'cohort', 'manual', 'emergency_override')),
  reason text,
  set_by_actor_type text not null default 'system',
  set_by_actor_id text,
  valid_from timestamptz not null default now(),
  valid_to timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- At most one ACTIVE (valid_to null) row per (firm, client, flag), and per firm-wide
-- default. Two partial uniques because client_id null must be allowed for the default row.
create unique index if not exists client_capability_config_client_flag_uniq
  on client_capability_config(firm_id, client_id, flag_key)
  where valid_to is null and client_id is not null;
create unique index if not exists client_capability_config_firm_flag_uniq
  on client_capability_config(firm_id, flag_key)
  where valid_to is null and client_id is null;
-- The read path: (firm, client, flag) active-row lookup (readClientConfigSnapshot).
create index if not exists client_capability_config_lookup_idx
  on client_capability_config(firm_id, client_id, flag_key, valid_to);

-- ── RLS-native (mirror 037 / 038 / 040 / 041) ────────────────────────────────────────
-- Config is governance data — the server connects as the RLS-exempt owner role; the
-- browser never queries this table. ENABLE (not FORCE) so the owner stays exempt; revoke
-- the Supabase browser roles entirely. Guarded so a dev DB without those roles still
-- applies cleanly.
alter table client_capability_config enable row level security;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on client_capability_config from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on client_capability_config from authenticated;
  end if;
end $$;
