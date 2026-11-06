-- Delegated authority for material reconciliation matches — Slice 1 of the #5
-- design: docs/proposal-2026-06-23-delegated-authority-material-matches.md.
--
-- A grant is a SCOPED, standing, AUTHORITY-minted record that a firm
-- operator / accountant has delegated unattended auto-accept for a class of
-- MATERIAL reconciliation matches — a match the strong model + the A–E gate
-- stack already authorized on EVERYTHING except the materiality ceiling
-- (Gate E). It is the authority receipt that lets a material match
-- auto-reconcile honestly instead of resting on a per-line firm click (the
-- two-terminal-states first principle, CLAUDE.md).
--
-- This is the AUTHORITY layer only. A grant decides WHETHER the model's match
-- executes unattended; it NEVER re-decides WHICH line settles what. The lookup
-- (findActiveAuthorityGrant) may bypass Gate E and nothing else — see the
-- proposal §1/§9 invariant and reconciliationAuthorityGrants.js.
--
-- A grant dies with its client via the client_id FK cascade — the sibling
-- reconciliation_matches / reconciliation_evaluations convention (migration
-- 039). That is a cleaner realization of "a grant's life ends with its
-- minting client" than the firm_facts provenance-purge, which only exists
-- because firm_facts cannot FK to a single client.

create table if not exists reconciliation_authority_grants (
  id text primary key,
  firm_id text not null references firms(id) on delete cascade,
  client_id text not null references clients(id) on delete cascade,
  -- The archetype-specific relationship scope (proposal §7). scope_key carries
  -- ALL mandatory components for the archetype (lean schema, NOT lean
  -- enforcement — the lookup verifies every component even when packed here).
  scope_kind text not null check (scope_kind in ('merchant', 'counterparty', 'account_pair')),
  scope_key text not null,
  archetype text not null check (archetype in ('recurring_rent_lease', 'verified_card_payment', 'internal_transfer')),
  -- accept_match auto-accepts the match (terminal 1). accept_and_post exists
  -- for forward-compat ONLY — V1 fails it closed at runtime (no posting
  -- authority), per loopExecutionPolicy V1_FORBIDDEN_ACTIONS.
  action text not null default 'accept_match' check (action in ('accept_match', 'accept_and_post')),
  -- REQUIRED per-grant cap — no accidental unlimited grant.
  amount_ceiling numeric not null check (amount_ceiling > 0),
  currency text not null,
  -- Runtime mint requires firm_operator/accountant/admin (enforced in code).
  -- 'system' may appear ONLY on an audited migration path with an originating
  -- human authority in provenance — it can never self-authorize at runtime.
  authorized_by_actor_type text not null,
  authorized_by_actor_id text,
  source text not null check (source in ('operator_one_click', 'accountant_approval', 'learned_from_pattern')),
  provenance jsonb not null default '{}'::jsonb,
  -- proposed = a learned/shadow grant not yet authority-approved (never
  -- auto-active). suspended = expired / past review_after / auto-suspended
  -- after a correction. revoked = a governance "no".
  status text not null default 'proposed' check (status in ('proposed', 'active', 'suspended', 'revoked')),
  revoked_by_actor_id text,
  revoked_reason text,
  valid_from timestamptz not null default now(),
  expires_at timestamptz,
  review_after timestamptz,
  use_count integer not null default 0,
  correction_count integer not null default 0,
  last_used_at timestamptz,
  policy_version text,
  model text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- The findActiveAuthorityGrant lookup path: (firm, client, archetype, scope_key)
-- then the fail-closed status/action/amount/date guards in code.
create index if not exists reconciliation_authority_grants_lookup_idx
  on reconciliation_authority_grants(firm_id, client_id, archetype, scope_key, status);

-- ── RLS-native (mirror 037 / 038) ────────────────────────────────────────────
-- A grant is governance data — the server connects as the RLS-exempt owner role;
-- the browser never queries this table. 032's event trigger auto-locks new public
-- tables, but it is best-effort (skipped without superuser), so enable RLS inline
-- as belt-and-suspenders — the post-032 convention for a newly created table.
-- ENABLE (not FORCE) so the owner stays exempt; revoke the Supabase browser roles
-- entirely. Guarded so a dev DB without those roles still applies cleanly.
alter table reconciliation_authority_grants enable row level security;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on reconciliation_authority_grants from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on reconciliation_authority_grants from authenticated;
  end if;
end $$;
