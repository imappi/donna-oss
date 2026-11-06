-- Donna Loops — the case-level suspension source (uplift Step 6 completion).
--
-- Step 6 (#542) shipped the execution gate: decideLoopExecution resolves a firm's
-- tier + a FIRM-level suspension from firms.metadata and decides via the pure
-- loopExecutionPolicy. The pure policy ALSO honours a CASE-level suspension
-- (decideExecution.caseSuspension -> 'case_suspended'), but bookkeeping_cases had
-- NO source for it, so the worker passed null — a forward-compatible hook with
-- nothing behind it (design §10 Step 6, handoff 2026-06-20). This migration is that
-- source: an APPEND-ONLY governance log of the three case-autonomy actions a human
-- authority may take, read back into the gate by
-- server/donna/caseSuspension.readActiveCaseSuspension.
--
--   bookkeeping_case_suspensions  one pause / resume / cancel action on a case,
--                                 APPEND-ONLY (INV-17) with its actor receipt
--
-- VOCABULARY (pinned to caseSuspension.CASE_SUSPENSION_ACTIONS by migrations.test.js
-- in lockstep, so the schema and the runtime can never drift):
--   pause   -> SUSPEND          a resumable kill switch — the wake stops until lifted
--   resume  -> LIFT             clears the suspension — the wake resumes next trigger
--   cancel  -> TERMINAL CLOSURE the case's autonomy is closed for good (irreversible)
-- The reader reports the LATEST action's effect: pause/cancel -> an active
-- suspension the gate blocks on (paused = HOLD, cancelled = terminal DROP, which the
-- Step 7 dispatcher tells apart at dispatch-time re-gate); resume / no rows -> not
-- suspended. A correction never mutates a prior action — a resume/cancel SUPERSEDES
-- a pause by being the newer row (the "supersede, never mutate" rail, INV-17).
--
-- GOVERNANCE (design §13.6 / Phase 0 §3g): only an AUTHORITY may suspend/resume/
-- cancel — authorized_by_actor_type is pinned to loopExecutionPolicy.AUTHORITY_ACTOR_TYPES.
-- An OWNER (e.g. a `client`) may supply evidence but can never govern a case's
-- autonomy. Each row carries its actor receipt (the model id / human word is the
-- receipt).
--
-- CLAUDE.md "Keep"-layer: a system-correctness control (who may act, how far) — no
-- LLM, no verdict. ISOLATION: one new table + a trigger reusing 037's generic guard;
-- it touches no other table's columns. INERT in prod until a row is written.
--
-- client_id is a plain column (NOT a clients FK), the 033 / firm_facts pattern: the
-- clients delete-cascade does not reach these rows, so the explicit client-delete
-- purge (caseSuspension.purgeCaseSuspensionsForDeletedClient, folded into
-- caseManager.purgeLoopsShadowForDeletedClient) is load-bearing — firm memory dies
-- with its client (CLAUDE.md rail #5), suspensions included.

-- ── bookkeeping_case_suspensions — the append-only suspension action log ──────
create table if not exists bookkeeping_case_suspensions (
  id                       text primary key,
  firm_id                  text not null references firms(id) on delete cascade,
  client_id                text not null,
  case_id                  text not null references bookkeeping_cases(id) on delete cascade,
  action                   text not null
                             check (action in ('pause', 'resume', 'cancel')),
  reason                   text,
  -- the actor receipt: only an AUTHORITY may govern autonomy (§13.6). Pinned to
  -- loopExecutionPolicy.AUTHORITY_ACTOR_TYPES — an owner (client) is rejected.
  authorized_by_actor_type text not null
                             check (authorized_by_actor_type in (
                               'firm_operator', 'accountant', 'admin', 'system'
                             )),
  authorized_by_actor_id   text,
  authority_level          text,
  -- an OPTIONAL pointer into the single append-only audit stream for callers that
  -- thread one (the suspension log is itself self-auditing via the actor receipt
  -- columns, so unlike a GoalReport's §13.2 MANDATORY pointer this is nullable).
  event_id                 text references bookkeeping_case_events(id),
  created_at               timestamptz not null default now()
);

-- The reader keys on (firm_id, client_id, case_id) ordered by recency — the latest
-- action decides the effective state.
create index if not exists bookkeeping_case_suspensions_case_idx
  on bookkeeping_case_suspensions (case_id, created_at desc);
-- The client-delete purge keys on (firm_id, client_id).
create index if not exists bookkeeping_case_suspensions_firm_client_idx
  on bookkeeping_case_suspensions (firm_id, client_id);

-- ── APPEND-ONLY enforcement (§13.1 / INV-17) ─────────────────────────────────
-- A suspension action is a governance receipt: a resume/cancel appends a NEW row
-- that supersedes a prior pause; it never UPDATEs or DELETEs one. Reuse 037's
-- generic guard function (loop_goal_append_only_guard — it keys off tg_op /
-- tg_table_name, so it is table-agnostic). 037 always precedes 038 (migrations run
-- in numeric order), so the function is present. DELETE is forbidden too, EXCEPT
-- under the client-delete purge: the purge sets `donna.allow_append_only_purge =
-- 'on'` for its transaction (the plain client_id column means the clients cascade
-- misses these rows, so the purge must hard-delete) and only then may a DELETE pass.
drop trigger if exists bookkeeping_case_suspensions_append_only on bookkeeping_case_suspensions;
create trigger bookkeeping_case_suspensions_append_only
  before update or delete on bookkeeping_case_suspensions
  for each row execute function loop_goal_append_only_guard();

-- ── RLS-native (mirror 033 / 037) ────────────────────────────────────────────
-- The server connects as the table-owner role (RLS-exempt); the browser never
-- queries this table. ENABLE (not FORCE) so the owner stays exempt; revoke the
-- Supabase anon/authenticated roles entirely. Guarded so a dev DB without those
-- roles still applies cleanly.
alter table bookkeeping_case_suspensions enable row level security;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on bookkeeping_case_suspensions from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on bookkeeping_case_suspensions from authenticated;
  end if;
end $$;
