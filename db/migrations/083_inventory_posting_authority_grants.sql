-- Donna Inventory I4·posting — P7 §13: delegated-authority ceilings for inventory posting.
--
-- Per-journal materiality alone is bypassable by a thousand small journals (design §13). This is
-- the AUTHORITY layer for the inventory WRITER — the 040 reconciliation_authority_grants pattern,
-- extended for posting: it authorizes a class of inventory journals to post UNATTENDED, bounded by
-- allowed posting kinds, allowed accounts, a per-journal ceiling, a DAILY aggregate ceiling, a
-- PERIOD aggregate ceiling, currency, a confidence floor, evidence, a validity window, and
-- jurisdiction. The 040 table is match-accept authority (accept_match); this one is POSTING
-- authority (a separate concern with a different scope shape), so it is a sibling table, not a
-- column bolt-on.
--
-- This migration adds ONLY the standing authority record + its lookup index. The pure fail-closed
-- decision is server/donna/inventory/postingAuthority.js (checkInventoryPostingAuthority); the
-- read-only aggregate reader is postingAuthorityDb.js. Wiring the check into the executor post-path
-- is a later isolation-class slice — like P6b's consumption primitive, the authority ships ready
-- and the trigger wires later. The CHECK vocabularies are pinned to the runtime taxonomy
-- (postingLog.js INVENTORY_POSTING_KINDS + postingAuthority.js) by migrations.test.js — no drift.

create table if not exists inventory_posting_authority_grants (
  id text primary key,
  firm_id text not null references firms(id) on delete cascade,
  client_id text not null references clients(id) on delete cascade,

  -- WHAT may post unattended. allowed_posting_kinds / allowed_accounts are fail-closed allow-lists:
  -- an empty array authorizes NOTHING (never a wildcard). The kinds are the postingLog.js taxonomy;
  -- event-class kinds (write_down, private_use) always escalate in code regardless of this list.
  allowed_posting_kinds text[] not null default '{}',
  allowed_accounts      text[] not null default '{}',

  -- The ceilings. A per-journal cap is REQUIRED (no accidental unlimited grant); the aggregate
  -- ceilings are the §13 hardening (nullable = not set on that axis, the per-journal cap still binds).
  per_journal_ceiling     numeric(14, 2) not null check (per_journal_ceiling > 0),
  daily_aggregate_ceiling  numeric(14, 2) check (daily_aggregate_ceiling  is null or daily_aggregate_ceiling  > 0),
  period_aggregate_ceiling numeric(14, 2) check (period_aggregate_ceiling is null or period_aggregate_ceiling > 0),

  currency text not null,
  -- Optional additional gates (nullable = not enforced on that axis).
  confidence_floor numeric check (confidence_floor is null or (confidence_floor >= 0 and confidence_floor <= 1)),
  evidence_required boolean not null default false,
  jurisdiction text,

  -- Provenance + lifecycle (mirror 040). A grant is minted by a human authority; 'system' may
  -- appear only on an audited migration path with an originating human in provenance, never a
  -- runtime self-authorization.
  authorized_by_actor_type text not null,
  authorized_by_actor_id text,
  source text not null check (source in ('operator_one_click', 'accountant_approval', 'learned_from_pattern')),
  provenance jsonb not null default '{}'::jsonb,

  -- proposed = learned/shadow, never auto-active. active = usable. suspended = expired / past
  -- review_after / auto-suspended after a correction. revoked = a governance "no".
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

-- The lookup path: (firm, client, status) then the fail-closed guards in code. Kept lean; the pure
-- check verifies every envelope component even though only status is indexed here.
create index if not exists inventory_posting_authority_grants_lookup_idx
  on inventory_posting_authority_grants(firm_id, client_id, status);

-- ── RLS-native (mirror 040 / 037 / 038) ──────────────────────────────────────
-- A grant is governance data — the server connects as the RLS-exempt owner role; the browser never
-- queries this table. 032's event trigger auto-locks new public tables best-effort (skipped without
-- superuser), so enable RLS inline as belt-and-suspenders. ENABLE (not FORCE) so the owner stays
-- exempt; revoke the Supabase browser roles. Guarded so a dev DB without those roles applies cleanly.
alter table inventory_posting_authority_grants enable row level security;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on inventory_posting_authority_grants from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on inventory_posting_authority_grants from authenticated;
  end if;
end $$;
