-- Client-portal chat messages — the business OWNER's conversation with
-- Donna inside the client portal (the owner-facing sibling of the firm
-- console's transaction/feed/document chats). One thread per
-- (firm, client): the portal is a single-column owner surface, so the
-- thread is client-general, not anchored to a transaction or document.
--
-- Deliberately its OWN table rather than another sentinel in
-- transaction_chat_messages (the '__feed__' pattern):
--   1. actor attribution — the owner is actor_type 'client', a value the
--      015/016 check constraints do not admit; widening those constraints
--      would blur who speaks on the FIRM surfaces, and actor attribution
--      is a day-one requirement for every owner-originated row
--      (docs/design-donna-client-portal-chat.md §constraint 4);
--   2. tenancy — the portal read/write endpoint touches ONLY this table,
--      so a thread-key bug can never leak a firm-side conversation to an
--      owner (the firm threads live in different tables entirely).
--
-- Columns mirror 015/016 so the two chat stacks stay structurally
-- interchangeable: proposed actions (Slice 2+) will live in
-- payload.actions exactly as the firm chats do, and the chatApplySpine
-- gates them by reading the PERSISTED message.

create table if not exists client_chat_messages (
  id text primary key,
  firm_id text not null references firms(id) on delete cascade,
  client_id text not null references clients(id) on delete cascade,
  role text not null check (role in ('user', 'assistant', 'system')),
  content text not null,
  payload jsonb not null default '{}'::jsonb,
  -- LLM provenance — null for user/system messages. The model id is part
  -- of the receipt (CLAUDE.md rail): read quality off this column, never
  -- off code defaults.
  model text,
  model_version text,
  -- Who actually spoke/acted: 'client' = the business owner (a
  -- client-scoped collaborator), 'firm' = a firm member writing into the
  -- owner's thread (future firm-console surface), 'llm' = Donna's
  -- assistant turns, 'system' = pipeline-injected notices.
  actor_type text not null default 'client'
    check (actor_type in ('client', 'firm', 'system', 'llm')),
  created_at timestamptz not null default now()
);

create index if not exists client_chat_messages_thread_idx
  on client_chat_messages(firm_id, client_id, created_at);
