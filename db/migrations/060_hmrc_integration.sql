-- HMRC MTD VAT connection storage (MTD-1: sandbox OAuth shell + token storage).
--
-- HMRC is a statutory filing adapter, NOT an accounting-system mirror. The
-- OAuth grant is owned by the business owner through the client portal, not by
-- the firm and not by an Agent Services Account. This table is therefore
-- client-owned: every row belongs to exactly one client and the supported HMRC
-- account types are deliberately limited to individual|organisation.
--
-- Tokens are encrypted by application code before they enter these columns
-- (AES-256-GCM under HMRC_TOKEN_KEY). Xero/QBO plaintext token precedent is not
-- reused for HMRC.

create table if not exists hmrc_connections (
  id text primary key,
  firm_id text not null references firms(id) on delete cascade,
  client_id text not null references clients(id) on delete cascade,
  hmrc_user_type text not null check (hmrc_user_type in ('individual', 'organisation')),
  vrn text,
  status text not null default 'active' check (status in ('active', 'expired', 'revoked', 'error')),
  scopes text[] not null default '{}',
  access_token_encrypted text,
  refresh_token_encrypted text,
  token_type text,
  expires_at timestamptz,
  grant_created_at timestamptz not null default now(),
  last_synced_at timestamptz,
  last_error text,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (firm_id, client_id)
);

create index if not exists hmrc_connections_firm_client_idx
  on hmrc_connections(firm_id, client_id, status);

-- RLS-native (mirrors 054): the server connects as the RLS-exempt owner role;
-- the browser never queries this token table directly. ENABLE (not FORCE) so
-- the owner stays exempt; revoke Supabase browser roles when they exist.
alter table hmrc_connections enable row level security;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on hmrc_connections from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on hmrc_connections from authenticated;
  end if;
end $$;
