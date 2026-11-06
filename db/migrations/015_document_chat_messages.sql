-- PR 27 — document chat messages. Per-(firm, client, document) chat thread
-- persisted server-side so reopening an artifact resumes the conversation.
-- Each row is one message (user or assistant). Assistant messages carry
-- the LLM's structured `proposed_actions` array in `payload.actions`; the
-- action grammar covers six v1 action types plus a `future` slot for
-- types the firm can see but cannot apply yet (PRs 28+).
--
-- Future migrations will extend this with action_status / applied_at /
-- result fields once the Apply path is wired (PR 28).

create table if not exists document_chat_messages (
  id text primary key,
  firm_id text not null references firms(id) on delete cascade,
  client_id text not null references clients(id) on delete cascade,
  document_id text not null references documents(id) on delete cascade,
  role text not null check (role in ('user', 'assistant', 'system')),
  content text not null,
  payload jsonb not null default '{}'::jsonb,
  -- LLM provenance — null for user/system messages. Pinned so we can
  -- replay or attribute a thread post-hoc if a downstream model change
  -- alters the action grammar.
  model text,
  model_version text,
  -- `actor_type` lets us distinguish a firm-typed message from a
  -- system-injected one (e.g. document re-extracted, transaction
  -- linked) — both have role='user' or role='system' semantically.
  actor_type text not null default 'firm'
    check (actor_type in ('firm', 'system', 'llm')),
  created_at timestamptz not null default now()
);

create index if not exists document_chat_messages_document_idx
  on document_chat_messages(firm_id, client_id, document_id, created_at);

create index if not exists document_chat_messages_recent_idx
  on document_chat_messages(firm_id, document_id, created_at desc);
