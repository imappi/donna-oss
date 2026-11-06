-- 076 — FI-13 slice 13.0b: the StatutoryBlocker store (D-FI13-2 v2/v3). ADDITIVE.
--
-- The two-terminal-states first principle (CLAUDE.md), applied to statutory
-- obligations: a typed 409 refusal alone is a TRANSIENT response resting on
-- nobody — a violation. Every statutory refusal must MINT durable work that
-- rests on a NAMED party until resolved. This is that store.
--
-- A statutory_blocker is a persisted, append-only-audited obstruction to a
-- Finnish statutory operation (an Oy reaching a lane built for the toiminimi,
-- missing payroll evidence blocking a close, an unclassified 6B condition, …).
-- It carries: WHO it rests on (assigned_to), HOW BAD (severity), HOW to clear
-- it (resolution_path), and — for judgment-carrying blockers — WHAT EVIDENCE
-- is required before it can be resolved (evidence_ref, enforced in code). The
-- companion statutory_blocker_events table is the APPEND-ONLY trail: mint,
-- re-raise, acknowledge, resolve, reassign — never an in-place rewrite of
-- history.
--
-- Guards act on ENTITY TYPE alone, NOT behind a FINLAND_OY flag: refusing wrong
-- statutory output must never be flag-off-able (D-FI13-2). A blocker therefore
-- has no capability-flag column — its existence is a fact about the book, not a
-- rollout stage.
--
-- A blocker dies with its client via the client_id FK cascade — the sibling
-- reconciliation_authority_grants / fiscal_years convention (migrations 040 /
-- 063). period_id / close_attempt_id are free-form nullable refs, NOT FKs: a
-- blocker may be client-scoped (no period) or attach to a fiscal year, close
-- period, or tax year without coupling this table to any one period substrate.
-- See docs/design-donna-finland-fi13-osakeyhtio.md (D-FI13-2).

create table if not exists statutory_blockers (
  id text primary key,
  firm_id text not null references firms(id) on delete cascade,
  client_id text not null references clients(id) on delete cascade,
  -- NULLABLE: client-scoped blockers exist (an Oy identification blocks EVERY
  -- statutory surface, not one period). When set, a free-form ref to a fiscal
  -- year / close period / tax year — deliberately not FK'd (see header).
  period_id text,
  -- The statutory surface that raised it, e.g. 'finland_annual_return'.
  surface text not null,
  -- WHY — a free-form code (NOT a CHECK): the condition enumeration can never be
  -- complete and must not need to be (the C7 default-blocker doctrine). Known
  -- codes are documented in statutoryBlocker.js; unknown ones are legal here.
  reason_code text not null,
  -- HOW BAD. legal_violation = producing the artifact would break statute (the
  -- entity-unsupported refusal). review_required = a human must decide before
  -- close/submission. informational = surfaced, resolvable without evidence.
  severity text not null check (severity in ('legal_violation', 'review_required', 'informational')),
  -- WHO it rests on. The design's named parties (D-FI13-2). A blocker is never
  -- in firm-side limbo AND never rests on nobody: it always names a human.
  assigned_to text not null check (assigned_to in ('firm', 'client', 'accountant', 'auditor', 'counsel')),
  -- open → acknowledged → resolved. A re-raised resolved blocker returns to open
  -- (the obligation is un-met again) — handled in code, recorded as an event.
  status text not null default 'open' check (status in ('open', 'acknowledged', 'resolved')),
  due_date date,
  -- Owner/firm-facing copy for HOW to clear it (bilingual copy rides `detail`).
  resolution_path text,
  -- Required to resolve a legal_violation / review_required blocker (enforced in
  -- statutoryBlocker.js — resolution without evidence is impossible for a
  -- judgment-carrying blocker, D-FI13-2). informational may resolve without it.
  evidence_ref text,
  -- A blocker can be gated on another (e.g. close blocked until payroll blocker
  -- clears). Self-reference; nullable.
  blocked_by_blocker_id text references statutory_blockers(id),
  close_attempt_id text,
  -- The legal form at refusal time — a receipt (the model-id-is-the-receipt
  -- discipline applied to entity safety).
  entity_type text,
  -- Bilingual copy (message / message_fi), source error code, and any extra
  -- structured context. Never load-bearing for a CHECK.
  detail jsonb not null default '{}'::jsonb,
  acknowledged_by text,
  acknowledged_at timestamptz,
  resolved_by text,
  resolved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- The open-work lookup: a client's live blockers by surface + status. Feeds the
-- close checklist, the owner action queue, and the firm queue (D-FI13-2).
create index if not exists statutory_blockers_open_idx
  on statutory_blockers(firm_id, client_id, status, surface);

-- APPEND-ONLY event trail. Every state transition of a blocker records an
-- immutable row here — mint / re_raise / acknowledged / resolved / reassigned /
-- severity_changed / evidence_attached. History is never rewritten in place.
create table if not exists statutory_blocker_events (
  id bigserial primary key,
  blocker_id text not null references statutory_blockers(id) on delete cascade,
  firm_id text not null references firms(id) on delete cascade,
  client_id text not null references clients(id) on delete cascade,
  event_type text not null check (event_type in (
    'minted', 're_raised', 'acknowledged', 'resolved', 'reassigned',
    'severity_changed', 'evidence_attached'
  )),
  -- 'system' legitimately mints a blocker (the runtime DETECTING a statutory
  -- obstruction and ASSIGNING it to a human is exactly right — unlike an
  -- authority grant, a blocker is not a self-authorization). A human actor is
  -- recorded on acknowledge/resolve/reassign.
  actor_type text not null,
  actor_id text,
  reason text,
  detail jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists statutory_blocker_events_blocker_idx
  on statutory_blocker_events(blocker_id, created_at);

-- ── RLS-native (mirror 040 / 063) ────────────────────────────────────────────
-- Governance data: the server connects as the RLS-exempt owner role; the browser
-- never queries these tables. ENABLE (not FORCE) so the owner stays exempt;
-- revoke the Supabase browser roles. Guarded so a dev DB without those roles
-- still applies cleanly.
alter table statutory_blockers enable row level security;
alter table statutory_blocker_events enable row level security;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on statutory_blockers from anon;
    revoke all on statutory_blocker_events from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on statutory_blockers from authenticated;
    revoke all on statutory_blocker_events from authenticated;
  end if;
end $$;
