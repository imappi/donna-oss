-- Transaction chat messages. Per-(firm, client, transaction) chat thread
-- persisted server-side so reopening a transaction artifact resumes the
-- conversation. Mirrors document_chat_messages (migration 015) but keyed
-- on a transaction instead of a document.
--
-- The chat is the unified case-file surface for a transaction: AI
-- rationale, category suggestion, Apply-to-Xero, Ask client, remember-
-- merchant rule — all expressed as proposed actions in payload.actions
-- and applied through the apply route once the firm reviews them.
--
-- Defensive note: the first attempt at this migration (PR 131) used
--   transaction_id text not null references transactions(id) on delete cascade
-- and the production deploy failed at db:migrate. The migration is
-- structurally identical to 015 (which works) apart from that FK
-- target, so this iteration drops the FK and keeps transaction_id as
-- a plain text column. Orphan rows are tolerable here (chat history
-- for a deleted transaction has no consumer) and a follow-up can
-- re-add the FK once we know what was wrong on the production schema.

create table if not exists transaction_chat_messages (
  id text primary key,
  firm_id text not null references firms(id) on delete cascade,
  client_id text not null references clients(id) on delete cascade,
  transaction_id text not null,
  role text not null check (role in ('user', 'assistant', 'system')),
  content text not null,
  payload jsonb not null default '{}'::jsonb,
  -- LLM provenance — null for user/system messages. Pinned so a thread
  -- can be replayed or attributed if a downstream model change alters
  -- the action grammar.
  model text,
  model_version text,
  -- Distinguishes a firm-typed message from a system-injected one
  -- (e.g. transaction re-categorised by a rule, Xero writeback
  -- failure). Both can have role='user' or role='system' semantically.
  actor_type text not null default 'firm'
    check (actor_type in ('firm', 'system', 'llm')),
  created_at timestamptz not null default now()
);

create index if not exists transaction_chat_messages_transaction_idx
  on transaction_chat_messages(firm_id, client_id, transaction_id, created_at);

create index if not exists transaction_chat_messages_recent_idx
  on transaction_chat_messages(firm_id, transaction_id, created_at desc);
