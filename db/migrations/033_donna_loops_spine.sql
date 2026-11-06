-- Donna Loops — Phase 1 shadow spine + at-least-once inbox/outbox.
--
-- A Donna Loop is a bounded, event-driven bookkeeping case: it wakes on a
-- domain event, reads persisted state, records WORKFLOW state, and sleeps. It
-- does NOT keep thinking. These six tables are the Keep-layer substrate
-- (persistence, idempotency, append-only audit, normalized links/blockers).
-- Phase 1 is SHADOW-only: rows are written behind the LOOPS_SHADOW flag; no
-- reads drive UI, no LLM, no external calls, no accounting writes.
--
-- Vocabulary is the canonical reconciled set from
-- docs/donna-loops-phase-0-contract.md (case status §3a, blocker/owner §3g/§3h,
-- link roles §4). The status CHECK constraints make those Phase-0 decisions
-- migration-hard here.
--
-- Migration number: 033. 032 is the public-schema RLS lockdown (now in the
-- repo); these tables are RLS-native anyway, so they slot cleanly whether or
-- not the lockdown lands first.
--
-- client_id is a plain column (NOT a clients FK), the firm_facts pattern: the
-- delete cascade from clients does not reach these rows, so the explicit
-- purgeLoopsShadowForDeletedClient (caseManager.js, called inside the
-- client-delete transaction) is load-bearing.

-- ── 1. bookkeeping_cases — the spine (lean; relations live in companions) ──
create table if not exists bookkeeping_cases (
  id                       text primary key,
  firm_id                  text not null references firms(id) on delete cascade,
  client_id                text not null,
  case_type                text not null
                             check (case_type in ('evidence', 'coding', 'reconciliation', 'upload')),
  status                   text not null default 'open'
                             check (status in (
                               'open', 'waiting_client', 'waiting_firm', 'waiting_accountant',
                               'waiting_policy', 'waiting_system', 'blocked', 'resolved',
                               'superseded', 'unsupported', 'engineering_escalated', 'abandoned'
                             )),
  title                    text,
  summary                  text,
  primary_object_type      text,
  primary_object_id        text,
  priority                 text not null default 'normal',
  risk_level               text not null default 'normal',
  opened_event_id          text,
  latest_snapshot_id       text,
  latest_model_decision_id text,
  due_at                   timestamptz,
  last_activity_at         timestamptz not null default now(),
  terminal_state           text,
  closed_reason            text,
  closed_at                timestamptz,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now()
);

-- DB-level case idempotency: one case per (firm, client, type, primary object).
-- Mandatory — application-level find-or-create is not enough because workers
-- race. Partial so cases with no primary object are not collapsed together.
create unique index if not exists bookkeeping_cases_primary_object_uidx
  on bookkeeping_cases (firm_id, client_id, case_type, primary_object_type, primary_object_id)
  where primary_object_type is not null and primary_object_id is not null;

create index if not exists bookkeeping_cases_client_status_idx
  on bookkeeping_cases (client_id, status);
create index if not exists bookkeeping_cases_client_type_object_idx
  on bookkeeping_cases (client_id, case_type, primary_object_type, primary_object_id);

-- ── 2. bookkeeping_case_events — append-only; status is a projection of it ──
-- APPEND-ONLY: enforced in caseManager (no update/delete helpers). TODO: add a
-- DB-level no-UPDATE/DELETE rule before any user-facing UI or apply/action path
-- depends on this log as the audit source of truth.
create table if not exists bookkeeping_case_events (
  id               text primary key,
  firm_id          text not null references firms(id) on delete cascade,
  client_id        text not null,
  case_id          text not null references bookkeeping_cases(id) on delete cascade,
  event_type       text not null,
  actor_type       text not null
                     check (actor_type in ('client', 'firm', 'accountant', 'system', 'engineer', 'external_connector')),
  actor_id         text,
  trigger_event_id text,
  object_type      text,
  object_id        text,
  snapshot_id      text,
  proposal_id      text,
  receipt_id       text,
  payload          jsonb not null default '{}'::jsonb,
  model_name       text,
  prompt_version   text,
  created_at       timestamptz not null default now()
);

create index if not exists bookkeeping_case_events_case_idx
  on bookkeeping_case_events (case_id, created_at);

-- ── 3. bookkeeping_case_links — normalized object<->case relations ──────────
create table if not exists bookkeeping_case_links (
  id             text primary key,
  firm_id        text not null references firms(id) on delete cascade,
  client_id      text not null,
  case_id        text not null references bookkeeping_cases(id) on delete cascade,
  object_type    text not null,
  object_id      text not null,
  role           text not null
                   check (role in (
                     'primary', 'evidence', 'candidate_match', 'blocking_transaction',
                     'blocking_document', 'client_reply', 'proposal', 'receipt',
                     'memory_candidate', 'external_sync', 'monthly_close', 'related_case'
                   )),
  object_version text,
  created_at     timestamptz not null default now(),
  unique (case_id, object_type, object_id, role)
);

create index if not exists bookkeeping_case_links_object_idx
  on bookkeeping_case_links (object_type, object_id);
create index if not exists bookkeeping_case_links_case_idx
  on bookkeeping_case_links (case_id);

-- ── 4. bookkeeping_case_blockers — normalized, queryable by owner/type ──────
create table if not exists bookkeeping_case_blockers (
  id                  text primary key,
  firm_id             text not null references firms(id) on delete cascade,
  client_id           text not null,
  case_id             text not null references bookkeeping_cases(id) on delete cascade,
  blocker_type        text not null
                        check (blocker_type in (
                          'missing_client_answer', 'missing_document', 'missing_bank_statement',
                          'parse_pending', 'parse_failed', 'parse_stale', 'unclear_category',
                          'unclear_match', 'conflicting_memory', 'accountant_judgment_required',
                          'firm_approval_required', 'external_sync_pending', 'external_sync_failed',
                          'unsupported_connector_capability', 'engineering_investigation_required'
                        )),
  owner_type          text not null
                        check (owner_type in ('client', 'firm', 'accountant', 'system', 'engineer', 'external_connector')),
  status              text not null default 'open'
                        check (status in ('open', 'resolved', 'superseded', 'cancelled')),
  object_type         text,
  object_id           text,
  reason              text,
  due_at              timestamptz,
  created_event_id    text,
  resolved_at         timestamptz,
  resolution_event_id text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create index if not exists bookkeeping_case_blockers_owner_idx
  on bookkeeping_case_blockers (client_id, owner_type, status);
create index if not exists bookkeeping_case_blockers_case_idx
  on bookkeeping_case_blockers (case_id);

-- ── 5. loop_event_inbox — at-least-once dedupe (INV-6) ──────────────────────
create table if not exists loop_event_inbox (
  id                     text primary key,
  firm_id                text not null references firms(id) on delete cascade,
  client_id              text not null,
  source                 text not null,
  source_event_id        text not null,
  event_type             text not null,
  object_type            text,
  object_id              text,
  payload_hash           text not null,
  payload                jsonb not null default '{}'::jsonb,
  status                 text not null default 'pending'
                           check (status in ('pending', 'processing', 'processed', 'failed', 'ignored')),
  attempts               integer not null default 0,
  last_error             jsonb,
  first_seen_at          timestamptz not null default now(),
  processing_started_at  timestamptz,
  processing_deadline_at timestamptz,
  locked_by              text,
  processed_at           timestamptz,
  unique (source, source_event_id)
);

create index if not exists loop_event_inbox_status_idx
  on loop_event_inbox (status);
create index if not exists loop_event_inbox_firm_client_idx
  on loop_event_inbox (firm_id, client_id);

-- ── 6. loop_event_outbox — post-commit side effects (INV-8) ─────────────────
-- Phase 1 NEVER marks a row 'dispatched': that status is reserved for a real
-- side effect, which only later phases emit. No dispatcher ships here.
create table if not exists loop_event_outbox (
  id            text primary key,
  firm_id       text not null references firms(id) on delete cascade,
  client_id     text not null,
  event_type    text not null,
  object_type   text,
  object_id     text,
  payload       jsonb not null default '{}'::jsonb,
  status        text not null default 'pending'
                  check (status in ('pending', 'dispatching', 'dispatched', 'failed', 'cancelled')),
  attempts      integer not null default 0,
  last_error    jsonb,
  created_at    timestamptz not null default now(),
  dispatched_at timestamptz
);

create index if not exists loop_event_outbox_status_idx
  on loop_event_outbox (status);
create index if not exists loop_event_outbox_firm_client_idx
  on loop_event_outbox (firm_id, client_id);

-- ── RLS-native ──────────────────────────────────────────────────────────────
-- The server connects as the table-owner role (DATABASE_URL), which is
-- RLS-exempt; the browser never queries these tables (Supabase Auth/Storage
-- only). ENABLE (not FORCE) so the owner stays exempt; revoke the Supabase
-- anon/authenticated roles entirely. Guarded so a dev DB without those roles
-- still applies cleanly.
alter table bookkeeping_cases          enable row level security;
alter table bookkeeping_case_events    enable row level security;
alter table bookkeeping_case_links     enable row level security;
alter table bookkeeping_case_blockers  enable row level security;
alter table loop_event_inbox           enable row level security;
alter table loop_event_outbox          enable row level security;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on bookkeeping_cases, bookkeeping_case_events, bookkeeping_case_links,
      bookkeeping_case_blockers, loop_event_inbox, loop_event_outbox from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on bookkeeping_cases, bookkeeping_case_events, bookkeeping_case_links,
      bookkeeping_case_blockers, loop_event_inbox, loop_event_outbox from authenticated;
  end if;
end $$;
