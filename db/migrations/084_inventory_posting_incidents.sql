-- Donna Inventory I4·posting — P7 §12: the durable incident/escalation record (D-POST-14).
--
-- "An engineering-incident waiter opens an ACTUAL incident record (not a log line) with an owning
-- path", and an EXHAUSTED integration retry "ESCALATES to a named human queue — it never retries
-- forever silently" (design §12, D-POST-14). This table is where both land: the durable ops home
-- for the waiter-drain planner's open_incident / escalate dispositions (postingWaiters.js). Without
-- it those dispositions are labels, not records — a non-human waiter could still dead-end silently.
--
-- This is a NEW OPS table (not the ledger, not the attempts log): it records who owns a stuck
-- posting and where its resolution stands. Nothing here posts, mutates the attempts log, or touches
-- the heads projection — the waiter head stays open (drainable) until a later attempt supersedes
-- it; re-draining simply no-ops against the natural key below.
--
-- Idempotent natural key: at most ONE unresolved incident per (firm, client, operation, kind,
-- incident_kind, reason). Re-running the drain writer while an incident is open/acknowledged
-- dedupes; once RESOLVED, a recurrence legitimately opens a NEW incident row (the prior one stays
-- as history). Closed lifecycle: open → acknowledged → resolved — resolved is terminal and requires
-- a resolving actor + timestamp (nothing silently disappears; two-terminal-states applied to ops).
--
-- The incident_kind / status CHECK vocabularies are pinned to
-- server/donna/inventory/postingIncidents.js by migrations.test.js — no drift. reason_code,
-- waiter_type, posting_kind, and target_queue are deliberately NOT CHECKed here: reason_code
-- follows the default-blocker doctrine (a new typed refusal must not need a migration), and
-- posting_kind / waiter_type are provenance already CHECK-enforced at the attempts log — a second
-- CHECK here would have to be recreated in lockstep with every future kind migration (082 pattern)
-- for no added safety.

create table if not exists inventory_posting_incidents (
  id                bigserial primary key,
  firm_id           text not null references firms(id) on delete cascade,
  client_id         text not null references clients(id) on delete cascade,

  -- WHICH stuck posting this incident is about (the waiter head's identity).
  operation_id      text not null,
  posting_kind      text not null,

  -- WHY the record exists: an engineering-incident waiter, or an integration retry that exhausted
  -- its bounded backoff schedule (§12 D-POST-14).
  incident_kind     text not null check (incident_kind in ('engineering_incident', 'retry_exhausted')),
  reason_code       text,
  -- The re-testable condition the waiter was waiting on (the attempts row's next_action).
  condition         text,
  -- Provenance: the waiter_type on the attempt that produced this incident.
  waiter_type       text,
  -- The OWNING PATH — the named queue obligated to move this (engineering / integration_operator).
  target_queue      text not null,
  -- For retry_exhausted: how far the bounded schedule got before escalating.
  retries_used      integer check (retries_used is null or retries_used >= 0),
  retries_max       integer check (retries_max is null or retries_max >= 0),
  -- The attempt row that was the waiter head when the incident opened (provenance, not identity).
  source_attempt_id bigint references inventory_posting_attempts(id) on delete set null,

  -- Lifecycle: open → acknowledged → resolved. Resolved is TERMINAL and must carry its actor +
  -- timestamp (belt-and-suspenders with the writer's guarded transition).
  status            text not null default 'open' check (status in ('open', 'acknowledged', 'resolved')),
  opened_by_actor_id       text not null,
  acknowledged_by_actor_id text,
  acknowledged_at          timestamptz,
  resolved_by_actor_id     text,
  resolved_at              timestamptz,
  resolution_note          text,
  detail            jsonb not null default '{}'::jsonb,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  check (status <> 'resolved' or (resolved_by_actor_id is not null and resolved_at is not null))
);

-- The idempotency guard: one UNRESOLVED incident per (operation, kind, incident_kind, reason) —
-- partial, so a resolved incident frees the key for a genuine recurrence. reason_code is nullable;
-- coalesce keeps null-reason incidents deduping too.
create unique index if not exists inventory_posting_incidents_natural_idx
  on inventory_posting_incidents (firm_id, client_id, operation_id, posting_kind, incident_kind, coalesce(reason_code, ''))
  where status in ('open', 'acknowledged');

-- The ops-queue read path: open incidents by owning queue.
create index if not exists inventory_posting_incidents_queue_idx
  on inventory_posting_incidents (firm_id, client_id, status, target_queue);

-- ── RLS-native (mirror 083 / 040 / 037) ─────────────────────────────────────
-- Ops/governance data — the server connects as the RLS-exempt owner role; the browser never
-- queries this table. ENABLE (not FORCE) so the owner stays exempt; revoke the Supabase browser
-- roles, guarded so a dev DB without those roles applies cleanly.
alter table inventory_posting_incidents enable row level security;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on inventory_posting_incidents from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on inventory_posting_incidents from authenticated;
  end if;
end $$;
