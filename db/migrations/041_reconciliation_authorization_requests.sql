-- The bounded `awaiting_authorization` transition — Slice 3 of the #5 design:
-- docs/proposal-2026-06-23-delegated-authority-material-matches.md (§4, §6, §13).
--
-- A row here is a FIRM-FACING authorization ask for a single MATERIALITY-HELD
-- reconciliation match — a match the strong model + the A–E gate stack
-- authorized on EVERYTHING except the materiality ceiling (Gate E), for which NO
-- covering grant (migration 040) exists yet. It is the persisted representation
-- of the bounded, SLA-measured `awaiting_authorization` transition (proposal
-- §4): NOT a third resting state, but the durable signal that a held line is
-- waiting on an AUTHORITY (firm operator / accountant) to either confirm it once
-- or authorize future matches like it (proposal §6).
--
-- WHY A ROW, NOT A NEW match.status: reconciliation_matches.status is compared
-- in many WHERE/IF sites and carries no CHECK constraint; overloading it with a
-- new value is broad and risky. The match stays `suggested`; the OPEN request
-- row IS the `awaiting_authorization` state. Downstream surfaces (the Slice-5
-- metric + chip) read this row, not a status flip — "render the persisted
-- verdict" (CLAUDE.md), one home for the SLA clock + the decline cooldown.
--
-- This is the GOVERNANCE/EVIDENCE boundary (proposal §3, §5): the ask is
-- firm-facing (an authority governs autonomy), distinct from the owner-facing
-- client_evidence_requests (009) / client_ask_batches (029) pipeline. It dies
-- with its client via the client_id FK cascade, and with its match via the
-- match_id FK cascade — the migration 039/040 "dies with its client" convention.

create table if not exists reconciliation_authorization_requests (
  id text primary key,
  firm_id text not null references firms(id) on delete cascade,
  client_id text not null references clients(id) on delete cascade,
  -- The held bank line + the specific match it settles. match_id FKs the match
  -- (cascade) so a deleted/superseded match takes its ask with it; the producer
  -- only ever creates a request AFTER the match row is persisted.
  bank_transaction_id text not null,
  match_id text not null references reconciliation_matches(id) on delete cascade,
  matched_object_type text not null,
  matched_object_id text not null,
  -- Forward-compat discriminator if other firm-facing governance asks are added.
  requirement_key text not null default 'material_match_authority',
  -- open      = the bounded transition (awaiting the authority).
  -- confirmed = authority confirmed THIS line once (no standing grant; §6).
  -- granted   = authority authorized future matches like it (a grant minted; §6).
  -- declined  = authority said no; cooldown_until throttles re-asking (§13).
  -- superseded= housekeeping (the match left 'suggested' by another path).
  status text not null default 'open'
    check (status in ('open', 'confirmed', 'granted', 'declined', 'superseded')),
  -- Context for the ask + the §13 idempotency/coverage checks. Required ceiling
  -- mirrors the grant table — never an ask on a zero/garbage amount.
  match_amount numeric not null check (match_amount > 0),
  currency text not null,
  -- Slice 4 classification (null in Slice 3 — pattern-level cooldown that
  -- suppresses OTHER identical lines needs scope_key, which Slice 4 derives).
  archetype text,
  scope_key text,
  -- The bounded-transition SLA deadline (proposal §4). Stamped at creation; the
  -- Slice-5 metric reads it to separate an in-flight ask from an SLA breach.
  sla_due_at timestamptz,
  -- Set on decline (proposal §13): the producer will not re-open the ask until
  -- this passes, so a deliberate "no" does not manufacture a standing queue.
  cooldown_until timestamptz,
  reopened_count integer not null default 0,
  -- Governance audit of the resolving authority (like a firm_fact dismiss).
  decided_by_actor_type text,
  decided_by_actor_id text,
  decided_at timestamptz,
  decline_reason text,
  -- Minting match snapshot (confidence, gates, second-best, materiality ceiling)
  -- + the deploy-vintage model id receipt (CLAUDE.md "the model id is the receipt").
  provenance jsonb not null default '{}'::jsonb,
  model text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Idempotency + the §13 dedupe lookup: one OPEN ask per (firm, client, line,
-- requirement). Also the Slice-5 metric scan (open vs SLA-breached).
create index if not exists reconciliation_authorization_requests_line_idx
  on reconciliation_authorization_requests(firm_id, client_id, bank_transaction_id, status);
create index if not exists reconciliation_authorization_requests_sla_idx
  on reconciliation_authorization_requests(firm_id, client_id, status, sla_due_at);

-- ── RLS-native (mirror 037 / 038 / 040) ──────────────────────────────────────
-- Governance data: the server connects as the RLS-exempt owner role; the browser
-- never queries this table directly. 032's event trigger auto-locks new public
-- tables, but it is best-effort (skipped without superuser), so enable RLS inline
-- as belt-and-suspenders. ENABLE (not FORCE) so the owner stays exempt; revoke the
-- Supabase browser roles. Guarded so a dev DB without those roles still applies.
alter table reconciliation_authorization_requests enable row level security;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on reconciliation_authorization_requests from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on reconciliation_authorization_requests from authenticated;
  end if;
end $$;
