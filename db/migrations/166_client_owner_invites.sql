-- 166 — Firm-to-owner portal invites.
--
-- A firm invites its client's business owner into THAT client's portal. The
-- invite is a pending grant bound to (firm, client, email); accepting it binds
-- the signed-in person as the client's owner principal on the EXISTING
-- substrate — a `firm_collaborators` row without seat_role (role 'owner') plus
-- a `client_assignments` capability row for the one client — through the same
-- owner binder self-signup uses (selfProvisionDb.js). This table is the invite
-- lifecycle only; it never grants access by itself.
--
-- The token is never stored: `token_hash` is sha256 of the random link token,
-- so a database read does not yield a usable link. Single use is the status
-- flip pending → accepted under a row lock; expiry is `expires_at`. A resend
-- rotates the hash (the earlier link stops working) and renews the expiry.
--
-- At most one pending invite per client (the partial unique index). Rows are
-- never deleted by the writers: revoked / accepted / removed invites stay as
-- the history the audit trail points at, and die with their client via the
-- FK cascade like every other per-client row.

create table if not exists client_owner_invites (
  id text primary key,
  firm_id text not null references firms(id) on delete cascade,
  client_id text not null references clients(id) on delete cascade,
  email text not null,
  name text not null,
  language text check (language is null or language in ('fi', 'en')),
  token_hash text not null,
  status text not null default 'pending'
    check (status in ('pending', 'accepted', 'revoked', 'removed')),
  expires_at timestamptz not null,
  invited_by_type text not null,
  invited_by_id text not null,
  accepted_at timestamptz,
  accepted_user_id text,
  collaborator_id text,
  revoked_at timestamptz,
  revoked_by_id text,
  removed_at timestamptz,
  removed_by_id text,
  invite_email_status text,
  invite_email_reason text,
  invite_email_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists client_owner_invites_token_hash_uniq
  on client_owner_invites(token_hash);
create unique index if not exists client_owner_invites_one_pending_per_client
  on client_owner_invites(firm_id, client_id) where status = 'pending';
create index if not exists client_owner_invites_firm_client_idx
  on client_owner_invites(firm_id, client_id, created_at desc);
create index if not exists client_owner_invites_collaborator_idx
  on client_owner_invites(firm_id, collaborator_id) where collaborator_id is not null;
