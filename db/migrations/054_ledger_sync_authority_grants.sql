-- 054 — delegated authority for ledger auto-export (INT-6, ledger-integrations
-- finish plan §2; Kari decision #2, 2026-07-06: the end state for posted-not-
-- exported journals is auto-push under delegated authority).
--
-- The 040 pattern (reconciliation_authority_grants) applied to sync: a grant is
-- a SCOPED, standing, AUTHORITY-minted record that a firm operator has delegated
-- unattended EXPORT of already-posted Donna ledger journals to the client's
-- connected accounting system (Xero / QBO). It is the authority receipt that
-- lets a posted entry reach the SYNCED terminal without resting on a per-batch
-- firm click (two-terminal-states, applied to sync).
--
-- This is the AUTHORITY layer only. A grant decides WHETHER the drain executor
-- may export unattended; it NEVER decides WHAT gets posted — posting, coding,
-- and corrections stay human/authorized upstream. The executor drains through
-- the EXISTING writers (adapter.writebackBatch → writebackXero/Qbo*InDb); no new
-- push path (grammar-is-a-router, INV-1).
--
-- amount_ceiling is OPTIONAL here (unlike 040's required cap): the exported
-- journal was already posted under the ledger's own invariants, so the ceiling
-- is an extra materiality bound, not the primary safety. Time-bounding IS
-- required — enforced in code (mint refuses a grant with neither expires_at nor
-- review_after), not by CHECK, so an audited migration path stays possible.
--
-- A grant dies with its client via the client_id FK cascade (the 039/040/041
-- convention). Auto-suspend on any export correction/reversal mirrors 040's
-- suspend-on-correction semantics (ledgerSyncAuthorityGrants.js).

create table if not exists ledger_sync_authority_grants (
  id text primary key,
  firm_id text not null references firms(id) on delete cascade,
  client_id text not null references clients(id) on delete cascade,
  -- The scope: which connected accounting system this grant covers.
  accounting_system text not null check (accounting_system in ('xero', 'qbo')),
  -- export_posted_journal is the ONLY action — the narrow doctrine carve
  -- (loopExecutionPolicy.js GRANT_GATED_ACTIONS). Never coding, never posting,
  -- never corrections; widening this list is a doctrine change, not a tweak.
  action text not null default 'export_posted_journal' check (action in ('export_posted_journal')),
  -- OPTIONAL materiality ceiling; when set it must be a real positive cap and
  -- code requires a currency to compare against.
  amount_ceiling numeric check (amount_ceiling is null or amount_ceiling > 0),
  currency text,
  -- Runtime mint requires firm_operator/accountant/admin (enforced in code).
  -- 'system' may appear ONLY on an audited migration path with an originating
  -- human authority in provenance — it can never self-authorize at runtime.
  authorized_by_actor_type text not null,
  authorized_by_actor_id text,
  source text not null check (source in ('operator_one_click', 'accountant_approval')),
  provenance jsonb not null default '{}'::jsonb,
  -- proposed = drafted, not yet authority-approved (never executes).
  -- suspended = expired / past review_after / auto-suspended after an export
  -- correction. revoked = a governance "no".
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

-- The findActiveLedgerSyncGrant lookup path: (firm, client, accounting_system)
-- then the fail-closed status/action/window guards in code.
create index if not exists ledger_sync_authority_grants_lookup_idx
  on ledger_sync_authority_grants(firm_id, client_id, accounting_system, status);

-- ── RLS-native (mirror 037/038/040/041/042) ─────────────────────────────────
-- Governance data — the server connects as the RLS-exempt owner role; the
-- browser never queries this table. ENABLE (not FORCE) so the owner stays
-- exempt; revoke the Supabase browser roles entirely. Guarded so a dev DB
-- without those roles still applies cleanly.
alter table ledger_sync_authority_grants enable row level security;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on ledger_sync_authority_grants from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on ledger_sync_authority_grants from authenticated;
  end if;
end $$;
