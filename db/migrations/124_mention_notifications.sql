-- 124 — Per-principal mention notifications (universal mentions slice 4;
-- docs/design-donna-universal-mentions.md §7, D10).
--
-- The ONLY new store the mentions build mints, and it is DELIVERY STATE, not
-- memory and not a work queue: "did this named human see this event yet."
-- The work itself keeps living where it always lived — a mention/assign is a
-- comment row on the artifact's chat thread (123) with its audit receipt, a
-- seat ask is a client_evidence_requests row (122). A lost notification row
-- can therefore hide nothing load-bearing: the Mentions lane reads OPEN SEAT
-- ASKS live from client_evidence_requests (addressee columns) and uses this
-- table only for the mention/assign lane entries and unread state. The
-- in-tree precedent is the owner_notified_at notified-once stamp (102),
-- promoted to a row per (principal, event) because a firm has many
-- principals and one column cannot carry N read cursors.
--
-- Principals are the EXISTING substrate vocabulary (firm_member /
-- firm_collaborator) — never agents: an agent is notified by nothing (the
-- runtime picks its asks up from the store of record), and an
-- agent-addressed row here would be the forbidden agent-resting-state with
-- extra steps.
--
-- Rows die with their client via FK cascade (the 093+ house pattern):
-- notification state about a book is not survivable memory.

create table if not exists mention_notifications (
  id text primary key,
  firm_id text not null,
  client_id text not null references clients(id) on delete cascade,
  principal_type text not null check (principal_type in ('firm_member', 'firm_collaborator')),
  principal_id text not null,
  kind text not null check (kind in ('mention', 'assign', 'ask', 'ask_answered', 'agent_escalation')),
  artifact_type text not null check (artifact_type in ('transaction', 'document')),
  artifact_id text not null,
  -- Who triggered it (chatApplyActorId vocabulary; 'donna'/agent ids for
  -- runtime-produced kinds) + the display the lane renders.
  actor_id text,
  actor_display text,
  excerpt text,
  -- The event refs: the comment row and/or the ask this notification points
  -- at. Plain columns, no FK — chat rows live in four sibling tables.
  message_id text,
  ask_id text,
  read_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists mention_notifications_unread_idx
  on mention_notifications (firm_id, principal_type, principal_id, created_at desc)
  where read_at is null;
create index if not exists mention_notifications_principal_idx
  on mention_notifications (firm_id, principal_type, principal_id, created_at desc);
create index if not exists mention_notifications_client_idx
  on mention_notifications (firm_id, client_id);

-- RLS — server-only table (the routes reach it through the pooled service
-- role; the lane is always self-scoped in SQL); browser roles get nothing.
-- ENABLE + guarded revoke, never FORCE (the 037/042/100/114/116 house
-- pattern).
alter table mention_notifications enable row level security;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on mention_notifications from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on mention_notifications from authenticated;
  end if;
end $$;
