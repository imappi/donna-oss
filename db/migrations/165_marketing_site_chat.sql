-- Donna on books.example (Kari, 2026-10-21): the public website chat where Donna,
-- Donna's AI, answers accounting firms and other visitors. Every turn is a
-- receipted row: what the visitor asked, what Donna answered, which model
-- served it (response-proven) and under which prompt version, and whether she
-- offered the handover to Kari. A visitor's "ping Kari" is recorded on the
-- conversation with the address it was sent from and the send result.
--
-- Firm-agnostic (047's line): prospect conversation data, no firm/client FK,
-- never joined into books surfaces. The visitor's IP is stored only as a
-- salted daily hash, for the rate limit.

create table if not exists marketing_site_chat_conversation (
  id text primary key,
  lang text not null check (lang in ('fi', 'en')),
  first_page text,
  origin text,
  ip_hash text,
  -- The visitor's request for Kari to reply (null until they ask).
  ping_email text,
  ping_name text,
  pinged_at timestamptz,
  ping_sent_to text,
  ping_error text,
  created_at timestamptz not null default now(),
  last_message_at timestamptz not null default now()
);

create index if not exists marketing_site_chat_conversation_recent_idx
  on marketing_site_chat_conversation(last_message_at desc);

create table if not exists marketing_site_chat_message (
  id text primary key,
  conversation_id text not null references marketing_site_chat_conversation(id) on delete cascade,
  role text not null check (role in ('visitor', 'donna')),
  content text not null,
  page text,
  ip_hash text,
  -- Donna's turns only: the response-proven model id, prompt version and
  -- whether she offered the handover to Kari.
  model text,
  prompt_version text,
  handoff boolean not null default false,
  created_at timestamptz not null default now()
);

create index if not exists marketing_site_chat_message_conversation_idx
  on marketing_site_chat_message(conversation_id, created_at);

create index if not exists marketing_site_chat_message_rate_idx
  on marketing_site_chat_message(ip_hash, created_at desc)
  where role = 'visitor';

-- ── RLS-native (mirror 050/051/096) ─────────────────────────────────────────
alter table marketing_site_chat_conversation enable row level security;
alter table marketing_site_chat_message enable row level security;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on marketing_site_chat_conversation from anon;
    revoke all on marketing_site_chat_message from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on marketing_site_chat_conversation from authenticated;
    revoke all on marketing_site_chat_message from authenticated;
  end if;
end $$;
