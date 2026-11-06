-- Donna Loops — the goal layer (uplift Step 2: make the goal first-class).
--
-- 033 gave the Loops a thorough STATE MACHINE (cases, events, links, blockers,
-- inbox/outbox) but no first-class GOAL: a case knows its status, never what it
-- is trying to achieve or how we will know it is done. This migration adds the
-- missing objects, exactly as specified in docs/loops-architecture-uplift-design.md
-- §10 (Step 2) + §13 (the Codex review hardening), and persists what
-- server/donna/loopGoal.js (the goal runtime proof, merged in #522) computes:
--
--   loop_goal_specs              content-addressed resolved GoalSpec snapshots
--                                (§13.5 — replay must pin spec CONTENT, not a
--                                label that may resolve differently later)
--   loop_runs                    one bounded wake/evaluation of a case (§5),
--                                APPEND-ONLY receipt with a budget + stop_reason
--   loop_goal_reports            the persisted verdict of the loop (§4.2) —
--                                the generalization of a reconciliation_evaluations
--                                verdict; APPEND-ONLY; rendered by READING, never
--                                re-judged at render (INV-13 / "render the verdict")
--   bookkeeping_case_dependencies  the typed composition graph (§6.2), ONE
--                                canonical direction (parent → child)
--   + bookkeeping_cases.case_version            optimistic single-flight (INV-16)
--   + bookkeeping_cases.latest_goal_report_id   a POINTER/CACHE only (§13.3)
--
-- This is the structural form of the trust-the-strong-LLM principle (design §8):
-- a model judgment becomes a persisted, versioned report; a human correction
-- becomes a superseding report / waived criterion; "delete the scaffolding when
-- the model gets stronger" becomes an evaluator_version bump. The CHECK
-- vocabularies below are the SAME sets loopGoal.js exports (GOAL_STATUSES,
-- EVALUATOR_TYPES, STOP_REASONS) — migrations.test.js pins them in lockstep so
-- the schema and the runtime can never drift apart.
--
-- ISOLATION CONTRACT (design §10): new tables + additive nullable/defaulted
-- columns ONLY. This migration touches NONE of the in-flight Phase 7.2 fixed
-- points (loopsShadowProducers.js / reconciliationLlmCore.js / firmDb.js /
-- documentsInbox.js / donna-financials-panel.jsx / serve.* / bankLineDisposition*),
-- so it can land before or after 7.2 without collision (steps 3–5, which DO edit
-- those files, wait for 7.2).
--
-- client_id is a plain column (NOT a clients FK), the 033 / firm_facts pattern:
-- the delete cascade from clients does not reach these rows, so an explicit
-- client-delete purge (server/donna/loopGoalStore.js → purgeLoopGoalsForDeletedClient,
-- to be folded into caseManager's purgeLoopsShadowForDeletedClient in a later
-- step) is load-bearing — firm memory dies with its client (CLAUDE.md rail).

-- ── 1. loop_goal_specs — content-addressed resolved GoalSpec snapshots ───────
-- GLOBAL + content-addressed on purpose (§13.5): the hash IS the key, so the
-- SAME product spec content de-dupes to ONE row shared across firms; a firm
-- tuning thresholds changes the content → a new hash → a new row. Which spec a
-- given case used is recorded on the CASE (a case stores its goal_spec_hash at
-- instantiation), not here. The hash is loopGoal.computeGoalSpecHash (sha256 hex).
create table if not exists loop_goal_specs (
  goal_spec_hash text primary key,
  goal_key       text not null,
  goal_version   text not null,
  evaluator_type text not null default 'deterministic'
                   check (evaluator_type in ('deterministic', 'model_assisted', 'human_authorized')),
  description    text,
  spec           jsonb not null,
  created_at     timestamptz not null default now()
);

-- ── 2. loop_runs — one bounded wake (§5); APPEND-ONLY budget + stop reason ───
-- INV-15: every bounded run has an execution budget and a persisted stop_reason.
-- Idempotency (§13.4): an event-caused run is unique on (case_id, trigger_event_id)
-- so a retried/redelivered inbox event never duplicates a run receipt.
create table if not exists loop_runs (
  id                          text primary key,
  firm_id                     text not null references firms(id) on delete cascade,
  client_id                   text not null,
  case_id                     text not null references bookkeeping_cases(id) on delete cascade,
  trigger_event_id            text,
  input_snapshot_id           text,
  output_snapshot_id          text,
  model_calls                 integer not null default 0,
  tool_calls                  integer not null default 0,
  estimated_cost              numeric,
  elapsed_ms                  integer,
  progress_fingerprint_before text,
  progress_fingerprint_after  text,
  stop_reason                 text not null
                                check (stop_reason in (
                                  'goal_met', 'waiting', 'authority_required',
                                  'budget_exhausted', 'no_progress', 'failed', 'superseded'
                                )),
  evaluator_version           text,           -- the model id IS the receipt
  created_at                  timestamptz not null default now()
);

-- One run per (case, triggering event). Partial so manual/runless wakes with no
-- trigger event are not all collapsed onto a single null key.
create unique index if not exists loop_runs_case_trigger_uidx
  on loop_runs (case_id, trigger_event_id)
  where trigger_event_id is not null;

create index if not exists loop_runs_case_idx
  on loop_runs (case_id, created_at);
create index if not exists loop_runs_firm_client_idx
  on loop_runs (firm_id, client_id);

-- ── 3. loop_goal_reports — the persisted verdict of the loop; APPEND-ONLY ────
-- The direct generalization of reconciliation_evaluations: status ∈ GOAL_STATUSES,
-- evaluator_type ∈ EVALUATOR_TYPES, carries evaluator_version (the receipt). It is
-- a SEPARATE table (so "all cases with goal_status = unmet" is one query) WITH a
-- MANDATORY event pointer (§13.2): event_id is NOT NULL and FKs
-- bookkeeping_case_events, so every report is reachable from the single append-only
-- audit stream. A correction/waiver/regression never mutates a prior report — it
-- writes a NEW report whose supersedes_report_id points back (INV-17 / §13.1).
create table if not exists loop_goal_reports (
  id                         text primary key,
  firm_id                    text not null references firms(id) on delete cascade,
  client_id                  text not null,
  case_id                    text not null references bookkeeping_cases(id) on delete cascade,
  loop_run_id                text references loop_runs(id) on delete cascade,
  event_id                   text not null references bookkeeping_case_events(id) on delete cascade,
  goal_spec_hash             text references loop_goal_specs(goal_spec_hash),
  goal_key                   text not null,
  goal_version               text not null,
  status                     text not null
                               check (status in ('met', 'unmet', 'indeterminate', 'waived', 'impossible')),
  evaluator_type             text not null default 'deterministic'
                               check (evaluator_type in ('deterministic', 'model_assisted', 'human_authorized')),
  evaluator_version          text,
  evaluated_from_snapshot_id text,
  criteria                   jsonb not null default '[]'::jsonb,
  next_unmet_conditions      jsonb not null default '[]'::jsonb,
  progress_fingerprint       text,
  supersedes_report_id       text references loop_goal_reports(id),
  source                     text not null default 'evaluation'
                               check (source in ('evaluation', 'correction', 'regression')),
  created_at                 timestamptz not null default now()
);

-- One report per run (§13.4) — the run is the unit of evaluation. Partial so
-- runless/backfilled reports (no loop_run_id) are not collapsed together.
create unique index if not exists loop_goal_reports_run_uidx
  on loop_goal_reports (loop_run_id)
  where loop_run_id is not null;

create index if not exists loop_goal_reports_case_idx
  on loop_goal_reports (case_id, created_at desc);
create index if not exists loop_goal_reports_firm_client_status_idx
  on loop_goal_reports (firm_id, client_id, status);

-- ── 4. bookkeeping_case_dependencies — the typed composition graph (§6.2) ────
-- Store ONE canonical direction only (parent → child); derive inverses
-- (blocked_by / unblocks / parent_of) through read helpers, NEVER as independent
-- rows — otherwise the graph can contradict itself. The enum holds only the
-- canonical verbs; a CHECK pins the direction and forbids self-dependency.
create table if not exists bookkeeping_case_dependencies (
  id                text primary key,
  firm_id           text not null references firms(id) on delete cascade,
  client_id         text not null,
  parent_case_id    text not null references bookkeeping_cases(id) on delete cascade,
  child_case_id     text not null references bookkeeping_cases(id) on delete cascade,
  relationship_type text not null
                      check (relationship_type in (
                        'blocks', 'spawned_from', 'satisfies',
                        'aggregates', 'supersedes', 'child_of'
                      )),
  created_event_id  text,
  resolved_event_id text,
  resolved_at       timestamptz,
  created_at        timestamptz not null default now(),
  check (parent_case_id <> child_case_id),
  unique (parent_case_id, child_case_id, relationship_type)
);

create index if not exists bookkeeping_case_dependencies_parent_idx
  on bookkeeping_case_dependencies (parent_case_id, relationship_type);
create index if not exists bookkeeping_case_dependencies_child_idx
  on bookkeeping_case_dependencies (child_case_id, relationship_type);

-- ── 5. bookkeeping_cases — additive: single-flight version + verdict pointer ──
-- case_version: optimistic concurrency for per-case single-flight (INV-16) — only
-- one run may reason over a given case version at a time.
alter table bookkeeping_cases
  add column if not exists case_version integer not null default 1;

-- latest_goal_report_id: a POINTER/CACHE only (§13.3), mirroring the existing
-- latest_snapshot_id / latest_model_decision_id (plain text, NO FK). The terminal-
-- state read (Step 4) derives from the APPEND-ONLY loop_goal_reports, NEVER from
-- this pointer — that is the structural kill for the #315 "render the cache over
-- the verdict" bug class. Left here deliberately unconstrained so it can only ever
-- be a convenience, never a source of truth a surface is tempted to trust.
alter table bookkeeping_cases
  add column if not exists latest_goal_report_id text;

-- ── 6. APPEND-ONLY enforcement (§13.1 / INV-17) ──────────────────────────────
-- 033 left a TODO for DB-level no-UPDATE/DELETE on the audit log; goal reports
-- drive UI (and later autonomy), so they get that enforcement HERE. A correction
-- never destructively mutates a prior model/human receipt — it appends a
-- superseding row. UPDATE is forbidden outright. DELETE is forbidden too, EXCEPT
-- under the explicit client-delete purge (firm memory dies with its client — the
-- plain client_id column means the clients-cascade misses these rows, so the
-- purge must hard-delete): the purge sets `donna.allow_append_only_purge = 'on'`
-- for its transaction, and only then may a DELETE pass.
create or replace function loop_goal_append_only_guard() returns trigger
  language plpgsql as $$
begin
  if tg_op = 'DELETE'
     and coalesce(current_setting('donna.allow_append_only_purge', true), '') = 'on' then
    return old;  -- the one sanctioned removal: client-delete purge (rail #5)
  end if;
  raise exception
    'append-only: % on % is forbidden (INV-17); corrections supersede, never mutate', tg_op, tg_table_name
    using errcode = 'restrict_violation';
end;
$$;

drop trigger if exists loop_runs_append_only on loop_runs;
create trigger loop_runs_append_only
  before update or delete on loop_runs
  for each row execute function loop_goal_append_only_guard();

drop trigger if exists loop_goal_reports_append_only on loop_goal_reports;
create trigger loop_goal_reports_append_only
  before update or delete on loop_goal_reports
  for each row execute function loop_goal_append_only_guard();

-- ── RLS-native (mirror 033) ──────────────────────────────────────────────────
-- The server connects as the table-owner role (RLS-exempt); the browser never
-- queries these tables. ENABLE (not FORCE) so the owner stays exempt; revoke the
-- Supabase anon/authenticated roles entirely. Guarded so a dev DB without those
-- roles still applies cleanly.
alter table loop_goal_specs               enable row level security;
alter table loop_runs                     enable row level security;
alter table loop_goal_reports             enable row level security;
alter table bookkeeping_case_dependencies enable row level security;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on loop_goal_specs, loop_runs, loop_goal_reports,
      bookkeeping_case_dependencies from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on loop_goal_specs, loop_runs, loop_goal_reports,
      bookkeeping_case_dependencies from authenticated;
  end if;
end $$;
