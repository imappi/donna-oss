-- 205 — The record that a book was given RECORDED model outputs.
--
-- The zero-key demo (`npm run demo:fi`, scripts/demo_fi.mjs) answers every
-- model call of the Kampaamo Kultalanka Oy month from committed recordings
-- (server/donna/providerReplay.js). Each start of that demo writes one row
-- here BEFORE the runtime starts, and it is the stored record behind every
-- "Demo: recorded model outputs" notice: the health route reads it, and the
-- web app shows the notice on every screen while a row exists. A row is never
-- updated or deleted by the runtime: the books it describes keep the
-- replayed answers, so the notice stays true for as long as the book does.
-- `scope_firm_id` / `scope_client_id` name the demo book the replay was
-- scoped to; they are not ownership columns (the row is written before the
-- company exists, and must not read as that company's residue). Owner:
-- server/donna/providerReplaySession.js. Nothing outside the demo
-- writes this table; a normal book has no row and shows no notice.

create table if not exists provider_replay_sessions (
  id text primary key,
  started_at timestamptz not null default now(),
  pack text not null,
  scope_firm_id text not null,
  scope_client_id text not null,
  recordings_digest text not null,
  recordings_recorded_at text,
  recorded_models jsonb not null default '{}'::jsonb,
  recorded_answers integer not null check (recorded_answers >= 0)
);

create index if not exists provider_replay_sessions_started_idx
  on provider_replay_sessions(started_at desc);

-- Receipt rows: server-side only, never browser-readable (mirror 170/171).
alter table provider_replay_sessions enable row level security;
do $$ begin
  if exists (select 1 from pg_roles where rolname='anon') then
    revoke all on provider_replay_sessions from anon;
  end if;
  if exists (select 1 from pg_roles where rolname='authenticated') then
    revoke all on provider_replay_sessions from authenticated;
  end if;
  if exists (select 1 from pg_roles where rolname='service_role') then
    grant select, insert on provider_replay_sessions to service_role;
  end if;
end $$;
