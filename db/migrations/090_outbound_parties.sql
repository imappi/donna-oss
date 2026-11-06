-- 090 — Outbound actions M0.2 (G1, the root of the Phase-1 dependency graph):
-- the counterparty entity store. docs/design-donna-outbound-actions-execution-plan.md
-- §1 M0.2; gap analysis §1 ("no entity model at all" — per-invoice buyer
-- snapshots, read-only platform mirrors, and merchant patterns, none joined).
--
-- Shape: client_parties is the IDENTITY row (one per counterparty of one
-- client's business); party_channels and party_attributes carry the
-- effective-dated life around it (the finland_shareholders 078 pattern:
-- identity rows + effective-dated holdings + append-only history — a change
-- closes the prior row and opens a new one, never an in-place mutation).
-- Denormalized current values (preferred_language, payment_terms_days,
-- do_not_contact) live on client_parties for cheap reads; party_attributes is
-- the history of who set them, from what source, effective when.
--
-- Resolution doctrine (trust-the-strong-LLM applied to identity): backfill and
-- extraction PROPOSE; deterministic identity (same business id) may enrich;
-- two parties with CONFLICTING business ids are NEVER auto-merged — a merge
-- across them is refused at the writer (partyStore.js applyPartyMerge). Fuzzy
-- matches rest in party_merge_suggestions as 'proposed' until confirmed —
-- two-terminal-states: a suggestion rests only as proposed (a pending owner
-- surface, G9/D12) or terminal (confirmed with receipt / rejected / superseded).
--
-- Everything dies with its client via the client_id FK cascade (the 040 / 063 /
-- 076 / 089 convention — firm memory dies with its client). RLS-native.

create table if not exists client_parties (
  id text primary key,
  firm_id text not null references firms(id) on delete cascade,
  client_id text not null references clients(id) on delete cascade,
  display_name text not null,
  -- Conservative normalization (lowercase, collapsed whitespace, stripped
  -- punctuation — NO legal-suffix stripping: two legal entities must never
  -- collapse by name cosmetics). Pinned to partyStore.normalizePartyName.
  normalized_name text not null,
  is_customer boolean not null default false,
  is_supplier boolean not null default false,
  -- Registration / VAT / EIN / Y-tunnus etc. The scheme names the register so
  -- values from different registers never compare equal by accident.
  business_id text,
  business_id_scheme text,
  country text,
  -- Per-entity language (A7): a two-letter code the pack render resolves
  -- against its supported set; null falls back to the pack default.
  preferred_language text,
  payment_terms_days integer,
  -- Counterparty-level "never contact" — checked at action mint AND send
  -- (A3 suppression; distinct from the address-level suppression list).
  do_not_contact boolean not null default false,
  status text not null default 'active'
    check (status in ('active', 'merged', 'archived')),
  merged_into_party_id text,
  -- Where this identity first came from (writer-normalized; no CHECK — a new
  -- backfill source must never reject an identity write).
  source text not null default 'manual',
  provenance jsonb not null default '{}'::jsonb,
  detail jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists client_parties_client_idx
  on client_parties(firm_id, client_id, status);
create index if not exists client_parties_name_idx
  on client_parties(firm_id, client_id, normalized_name);
create index if not exists client_parties_business_id_idx
  on client_parties(firm_id, client_id, business_id)
  where business_id is not null;

-- Effective-dated contact channels. A channel change closes the prior row
-- (valid_until) and opens a new one; the active set is valid_until is null.
create table if not exists party_channels (
  id text primary key,
  firm_id text not null references firms(id) on delete cascade,
  client_id text not null references clients(id) on delete cascade,
  party_id text not null references client_parties(id) on delete cascade,
  channel_kind text not null
    check (channel_kind in ('email', 'phone', 'sms', 'whatsapp', 'postal', 'einvoice_address')),
  channel_value text not null,
  normalized_value text not null,
  is_primary boolean not null default false,
  verified_at timestamptz,
  valid_from timestamptz not null default now(),
  valid_until timestamptz,
  source text not null default 'manual',
  detail jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists party_channels_party_idx
  on party_channels(party_id, channel_kind);
-- One ACTIVE row per (party, kind, normalized value) — re-adding the same
-- address is idempotent at the writer; history rows keep their closed windows.
create unique index if not exists party_channels_active_value_idx
  on party_channels(party_id, channel_kind, normalized_value)
  where valid_until is null;
create index if not exists party_channels_value_idx
  on party_channels(firm_id, client_id, channel_kind, normalized_value)
  where valid_until is null;

-- Append-only attribute history (payment terms, language, do-not-contact,
-- and future per-entity facts). The CURRENT value is denormalized onto
-- client_parties by the one writer (partyStore.setPartyAttribute) in the same
-- transaction that closes the prior history row.
create table if not exists party_attributes (
  id text primary key,
  firm_id text not null references firms(id) on delete cascade,
  client_id text not null references clients(id) on delete cascade,
  party_id text not null references client_parties(id) on delete cascade,
  attribute text not null,
  value jsonb not null,
  valid_from timestamptz not null default now(),
  valid_until timestamptz,
  source text not null default 'manual',
  set_by_actor_type text not null default 'system',
  set_by_actor_id text,
  created_at timestamptz not null default now()
);

create index if not exists party_attributes_party_idx
  on party_attributes(party_id, attribute);
create unique index if not exists party_attributes_active_idx
  on party_attributes(party_id, attribute)
  where valid_until is null;

-- Suggest-and-confirm merge lane. The model (or a deterministic near-match)
-- PROPOSES; a human-confirmed merge executes through applyPartyMerge, which
-- refuses conflicting business ids unconditionally.
create table if not exists party_merge_suggestions (
  id text primary key,
  firm_id text not null references firms(id) on delete cascade,
  client_id text not null references clients(id) on delete cascade,
  source_party_id text not null references client_parties(id) on delete cascade,
  target_party_id text not null references client_parties(id) on delete cascade,
  reason text not null,
  evidence jsonb not null default '{}'::jsonb,
  status text not null default 'proposed'
    check (status in ('proposed', 'confirmed', 'rejected', 'superseded')),
  decided_by_actor_type text,
  decided_by_actor_id text,
  decided_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists party_merge_suggestions_client_idx
  on party_merge_suggestions(firm_id, client_id, status);
-- One live suggestion per ordered pair.
create unique index if not exists party_merge_suggestions_pair_idx
  on party_merge_suggestions(source_party_id, target_party_id)
  where status = 'proposed';

-- ── RLS-native (mirror 078 / 040) ────────────────────────────────────────────
-- Server-owned data; the browser never queries these tables. ENABLE (not
-- FORCE) so the RLS-exempt owner role stays exempt; revoke the Supabase
-- browser roles. Guarded so a dev DB without those roles applies cleanly.
alter table client_parties enable row level security;
alter table party_channels enable row level security;
alter table party_attributes enable row level security;
alter table party_merge_suggestions enable row level security;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on client_parties, party_channels, party_attributes, party_merge_suggestions from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on client_parties, party_channels, party_attributes, party_merge_suggestions from authenticated;
  end if;
end $$;
