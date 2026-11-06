-- Descent-ladder model-policy feed, persisted half (spec:
-- docs/design-donna-qwen-descent-ladder.md §5.4, slice Q6c — the model lab).
--
-- One row = "for this (firm[, client]), this LANE's deciding model is X".
-- ABSENCE of an active row = the lane's strong default decides (fail-closed:
-- an empty table changes nothing anywhere). client_id NULL = a firm-wide
-- row; a client-specific row overrides it at read time (the 042 pattern).
--
-- BASIS is the honesty column: 'promotion' rows ride a signed gate verdict
-- (spec §5.2 — none exist yet); 'experiment' rows ride a dated Kari call on
-- a lab book (the 2026-08-16 Honeybee model-lab call). Either way the
-- deciding_model must sit inside the lane's qualified set at write time —
-- the store enforces it, so this table can never widen model choice beyond
-- the feed (no free picker, re-confirmed twice).
--
-- Append-only-with-closure: setting a policy CLOSES the prior active row
-- (valid_to) and inserts a new one, so the history of who decided what,
-- when, on what basis, is the audit trail — plus an audit_events row in the
-- same transaction (audit-as-precondition in the store).

create table if not exists model_lane_policy (
  id text primary key,
  firm_id text not null references firms(id) on delete cascade,
  -- NULL = firm-wide policy for the lane; non-null = client-specific override.
  client_id text references clients(id) on delete cascade,
  lane text not null,
  deciding_model text not null,
  basis text not null default 'experiment' check (basis in ('experiment', 'promotion')),
  reason text,
  set_by_actor_type text not null default 'system',
  set_by_actor_id text,
  valid_from timestamptz not null default now(),
  valid_to timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- At most one ACTIVE (valid_to null) row per (firm, client, lane), and per
-- firm-wide default — two partial uniques because client_id null must be
-- allowed for the firm-wide row (the 042 pattern).
create unique index if not exists model_lane_policy_client_lane_active_uniq
  on model_lane_policy(firm_id, client_id, lane)
  where valid_to is null and client_id is not null;
create unique index if not exists model_lane_policy_firm_lane_active_uniq
  on model_lane_policy(firm_id, lane)
  where valid_to is null and client_id is null;

create index if not exists model_lane_policy_lane_idx
  on model_lane_policy(firm_id, lane, valid_from);

-- RLS — server-only table (read/written through the pooled service role);
-- browser roles get nothing. ENABLE + guarded revoke, never FORCE (the
-- 037/042/100/114/116 house pattern).
alter table model_lane_policy enable row level security;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on model_lane_policy from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on model_lane_policy from authenticated;
  end if;
end $$;
