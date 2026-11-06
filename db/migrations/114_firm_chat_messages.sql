-- Firm-level chat threads — the Inbox cross-venture mass-command chat
-- (UI slice 3, 2026-08-05). Sibling of transaction_chat_messages: that
-- table's client_id carries a hard FK to clients (016), so a thread that
-- spans ventures cannot live there under a sentinel client. `thread` is a
-- sentinel key ('__firm_feed__' for the Inbox chat); future firm-level
-- threads join under their own sentinels, mirroring the
-- VIRTUAL_CHAT_THREAD_IDS pattern on the per-client table.
--
-- The action grammar stored in payload is the SAME closed feed-chat enum —
-- each action additionally carries the client_id it compiles to; the apply
-- route dispatches per action through the same per-client writers.

create table if not exists firm_chat_messages (
  id text primary key,
  firm_id text not null references firms(id) on delete cascade,
  thread text not null,
  role text not null check (role in ('user', 'assistant', 'system')),
  content text not null,
  payload jsonb not null default '{}'::jsonb,
  -- LLM provenance — null for user/system messages (the model-id-is-part-
  -- of-the-receipt rail).
  model text,
  model_version text,
  actor_type text not null default 'firm',
  created_at timestamptz not null default now()
);

create index if not exists firm_chat_messages_thread_idx
  on firm_chat_messages(firm_id, thread, created_at);

-- RLS — server-only table (the API reaches it through the pooled service
-- role); browser roles get nothing. ENABLE + guarded revoke, never FORCE
-- (the 037/042/100 house pattern).
alter table firm_chat_messages enable row level security;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on firm_chat_messages from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on firm_chat_messages from authenticated;
  end if;
end $$;
