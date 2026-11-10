-- 171 — An owner's account-deletion request (the phone app's Delete account
-- page, POST /me/deletion-request; App Store 5.1.1(v)).
--
-- This table RECORDS a request. It deletes nothing and grants or revokes
-- nothing: books, documents, the owner principal, its client_assignments and
-- the owner's sign-in are untouched by the writer
-- (server/donna/mobile/mobileDeletionRequest.js). What is deleted, when and
-- by whom is a policy decision that has not been made yet; until it is, a row
-- here stays 'recorded'.
--
-- One row per owner IDENTITY (identity_key: the identity provider's user id,
-- or `email:<address>` for an identity that has no user id), not per business
-- or per firm: the owner asked once, for their account. `scope` is the
-- snapshot of what the request covers at the moment it was made — per firm,
-- the firm's name, the owner principal in that firm and the businesses
-- (client ids). `message` is the server-written statement the owner was shown;
-- a repeat request returns this row unchanged (idempotent).
--
-- Deliberately NO foreign key to firms or clients: a deletion request is the
-- record a later deletion is carried out against, so it must survive the
-- firm-side client delete (db/clients.js deleteClientInDb cascades every
-- per-client row). Each firm the request covers gets an audit_events row
-- (resource_type 'owner_deletion_request') in the same transaction.
--
-- status is a closed vocabulary. Only 'recorded' is written today; the other
-- values are reserved for the decided policy's writers.

create table if not exists owner_deletion_requests (
  id text primary key,
  identity_key text not null,
  user_id text,
  email text,
  status text not null default 'recorded'
    check (status in ('recorded', 'acknowledged', 'completed', 'withdrawn')),
  firm_ids text[] not null,
  client_ids text[] not null,
  scope jsonb not null,
  language text not null check (language in ('fi', 'en')),
  message text not null,
  requested_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (cardinality(firm_ids) > 0 and cardinality(client_ids) > 0)
);

create unique index if not exists owner_deletion_requests_identity_uniq
  on owner_deletion_requests(identity_key);
create index if not exists owner_deletion_requests_firm_ids_idx
  on owner_deletion_requests using gin (firm_ids);

-- Rows carry an owner's email and the businesses they own: server-side only,
-- never browser-readable (mirror 163/166's guarded block).
alter table owner_deletion_requests enable row level security;
do $$ begin
  if exists (select 1 from pg_roles where rolname='anon') then
    revoke all on owner_deletion_requests from anon;
  end if;
  if exists (select 1 from pg_roles where rolname='authenticated') then
    revoke all on owner_deletion_requests from authenticated;
  end if;
  if exists (select 1 from pg_roles where rolname='service_role') then
    grant select, insert, update, delete on owner_deletion_requests to service_role;
  end if;
end $$;
