-- Config control plane → decision ledger bridge — Phase 0B.1
-- (docs/donna-self-awareness-plan.md §4 "config_snapshot_id" + the 0B substrate audit,
-- docs/session-handoff-2026-06-27-0B-decision-ledger-substrate-audit.md).
--
-- THE BRIDGE: a decision receipt must be able to point at the config snapshot that drove
-- it ("which config produced this verdict?"). 0A built the per-client config plane
-- (client_capability_config, 042) but a decision could not yet reference the resolved
-- config it ran under. This pins that link.
--
-- config_snapshots is CONTENT-ADDRESSED and IMMUTABLE: the id is a hash of the resolved
-- stage map (clientConfig.configSnapshotId), NAMESPACED by (firm, client) so an id never
-- spans tenants (cross-tenant snapshot sharing = 0). Writes are insert-once
-- (on conflict do nothing): an identical config for the same client re-resolves to the same
-- id and adds no row; a config CHANGE produces a NEW id and a NEW row, never rewriting a
-- past one (§4 "a later config change creates a new snapshot and never retroactively
-- rewrites a past receipt"). CLAUDE.md "Keep" layer — system-correctness plumbing, no LLM.

create table if not exists config_snapshots (
  id         text primary key,                 -- cfg-<sha256(firm ∥ client ∥ canonical map)>
  firm_id    text references firms(id) on delete cascade,
  client_id  text references clients(id) on delete cascade,
  snapshot   jsonb not null,                   -- the canonical resolved { flag_key: { stage, source } } map
  created_at timestamptz not null default now()
);

-- The read path: "all snapshots ever seen for this client", newest first.
create index if not exists config_snapshots_firm_client_idx
  on config_snapshots(firm_id, client_id, created_at desc);

-- The decision-receipt link. Nullable: a decision recorded without a resolvable snapshot
-- (or on a pre-bridge code path) carries null — byte-identical to pre-0B.1.
alter table llm_decisions add column if not exists config_snapshot_id text;

-- ── RLS-native (mirror 040 / 041 / 042) ───────────────────────────────────────────────
-- Governance/audit data — the server connects as the RLS-exempt owner role; the browser
-- never queries this table. ENABLE (not FORCE) so the owner stays exempt; revoke the
-- Supabase browser roles. Guarded so a dev DB without those roles still applies cleanly.
alter table config_snapshots enable row level security;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on config_snapshots from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on config_snapshots from authenticated;
  end if;
end $$;
