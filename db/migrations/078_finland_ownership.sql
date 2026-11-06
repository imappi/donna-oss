-- 078 — FI-13 slice 13.0A-2: the Oy ownership model (D-FI13-14). ADDITIVE.
--
-- "Ownership is a real, effective-dated data model" — not a single percentage
-- field on the client. The pilot ENVELOPE is narrow (exactly one Finnish-resident
-- natural-person 100 % shareholder, D-FI13-13), but the MODEL is the real thing,
-- because ownership FEEDS everything downstream: YEL applicability (D-FI13-7),
-- 6B shareholder reporting, dividend-recipient classification, osakaslaina
-- (shareholder-loan) detection, mathematical value, loss/ownership-change effects,
-- AML beneficial ownership, and related-party detection.
--
-- Pragmatic effective-dated CORE (Kari, 2026-07-12): the tables the pilot's
-- consumers actually read — shareholders, share classes, effective-dated
-- shareholdings, and an APPEND-ONLY ownership-event log — with voting / family /
-- beneficial-owner / indirect ownership as fields or lightweight structure and
-- documented extension points, NOT eight half-empty tables no consumer reads yet.
--
-- Effective-dating is the load-bearing property: a shareholding carries
-- valid_from / valid_until, and an ownership CHANGE is a new EVENT that closes the
-- prior holdings and opens new ones — never an in-place mutation. That is what
-- makes "no ownership change during the pilot ⇒ escalate + re-qualify"
-- (D-FI13-13) a fact the model can see, and what lets a historical cap table be
-- reconstructed as-of any date.
--
-- AML / PII posture (the AML workstream is a HARD counsel gate, §8 — NOT settled
-- here): this schema deliberately stores NO raw national identifiers. A
-- shareholder's `identifier_ref` is a REFERENCE (a pointer to a verified
-- document / an external token), never a hetu or Y-tunnus value. Beneficial
-- ownership is DERIVED for the pilot (a natural-person direct owner over the
-- threshold is the beneficial owner) and full AML BO modelling is left to the
-- counsel-gated workstream, not baked into columns before counsel opines.
--
-- Everything dies with its client via the client_id FK cascade
-- (firm-memory-dies-with-its-client; the 040 / 063 / 076 convention). RLS-native.

-- A party that can hold shares in the Oy — a natural person or a legal entity.
create table if not exists finland_shareholders (
  id text primary key,
  firm_id text not null references firms(id) on delete cascade,
  client_id text not null references clients(id) on delete cascade,
  -- natural_person vs legal_entity — drives dividend classification, YEL,
  -- beneficial-owner derivation. Pinned to ownership.js OWNERSHIP_PARTY_TYPES.
  party_type text not null check (party_type in ('natural_person', 'legal_entity')),
  display_name text not null,
  -- ISO-3166-1 alpha-2 residency (e.g. 'FI'); is_finnish_resident is stored for
  -- query even though derivable, the way scopeDrift stores derived signals.
  residency_country text,
  is_finnish_resident boolean,
  -- A REFERENCE to a verified identity (document pointer / external token) — NEVER
  -- a raw hetu / Y-tunnus (AML/PII posture, see header).
  identifier_ref text,
  -- Extension point for family aggregation (YEL / osakaslaina count family
  -- ownership): a shared free-form group ref, NOT a separate FamilyRelationship
  -- table until a consumer needs it. Null in the single-owner pilot.
  family_group_ref text,
  detail jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists finland_shareholders_client_idx
  on finland_shareholders(firm_id, client_id);

-- A class of shares. The pilot has exactly one ('ordinary'); the model supports
-- more. votes_per_share carries voting rights as a FIELD (1:1 in the pilot)
-- rather than a separate VotingRights table.
create table if not exists finland_share_classes (
  id text primary key,
  firm_id text not null references firms(id) on delete cascade,
  client_id text not null references clients(id) on delete cascade,
  class_name text not null,
  votes_per_share numeric not null default 1,
  detail jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (firm_id, client_id, class_name)
);

-- APPEND-ONLY ownership-event log. Every change to the cap table is an event
-- (incorporation, issuance, transfer, redemption, reclassification, correction).
-- The event is the reason a set of shareholdings opened/closed on effective_date;
-- history is never rewritten in place. Pinned to ownership.js OWNERSHIP_EVENT_TYPES.
create table if not exists finland_ownership_events (
  id text primary key,
  firm_id text not null references firms(id) on delete cascade,
  client_id text not null references clients(id) on delete cascade,
  event_type text not null check (event_type in (
    'incorporation', 'issuance', 'transfer', 'redemption', 'reclassification', 'correction'
  )),
  effective_date date not null,
  -- 'system' may record a detection; a human is recorded when the event is an
  -- authorised ownership decision.
  actor_type text not null,
  actor_id text,
  detail jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists finland_ownership_events_client_idx
  on finland_ownership_events(firm_id, client_id, effective_date);

-- Effective-dated holding: a shareholder holds N shares of a class from valid_from
-- until valid_until (NULL = still current). A holding active on date D satisfies
-- valid_from <= D and (valid_until is null or D < valid_until). ownership_event_id
-- links the holding to the event that opened it.
create table if not exists finland_shareholdings (
  id text primary key,
  firm_id text not null references firms(id) on delete cascade,
  client_id text not null references clients(id) on delete cascade,
  shareholder_id text not null references finland_shareholders(id) on delete cascade,
  share_class_id text not null references finland_share_classes(id) on delete cascade,
  share_count numeric not null,
  valid_from date not null,
  valid_until date,
  ownership_event_id text references finland_ownership_events(id),
  detail jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- The as-of lookup: a client's holdings by effective window.
create index if not exists finland_shareholdings_asof_idx
  on finland_shareholdings(firm_id, client_id, valid_from, valid_until);

-- ── RLS-native (mirror 040 / 063 / 076) ──────────────────────────────────────
-- Governance data: the server connects as the RLS-exempt owner role; the browser
-- never queries these tables. ENABLE (not FORCE) so the owner stays exempt;
-- revoke the Supabase browser roles. Guarded so a dev DB without those roles
-- still applies cleanly.
alter table finland_shareholders enable row level security;
alter table finland_share_classes enable row level security;
alter table finland_ownership_events enable row level security;
alter table finland_shareholdings enable row level security;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on finland_shareholders from anon;
    revoke all on finland_share_classes from anon;
    revoke all on finland_ownership_events from anon;
    revoke all on finland_shareholdings from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on finland_shareholders from authenticated;
    revoke all on finland_share_classes from authenticated;
    revoke all on finland_ownership_events from authenticated;
    revoke all on finland_shareholdings from authenticated;
  end if;
end $$;
