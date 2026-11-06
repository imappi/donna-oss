-- QuickBooks Online connection storage (Phase 2.1a: OAuth + token storage).
--
-- Parallel to xero_connections (003) rather than a generalised
-- accounting_connections table: the rename/consolidation is deferred to a
-- later PR once both the Xero and QBO paths are live and validated. Mirrors
-- the Xero shape one-for-one with two QBO-specific differences:
--   * realm_id replaces tenant_id — QBO returns exactly one realm_id as a
--     query param on the OAuth callback (?realmId=...); it IS the connection,
--     so there is no GET /connections fan-out like Xero has.
--   * refresh_token_expires_at — QBO refresh tokens expire (~100 days) AND
--     rotate on every refresh (each refresh issues a new refresh_token and
--     invalidates the prior one). Xero refresh tokens do neither, so the
--     column has no Xero equivalent.
create table if not exists qbo_connections (
  id text primary key,
  firm_id text not null references firms(id) on delete cascade,
  client_id text not null references clients(id) on delete cascade,
  realm_id text not null,
  company_name text,
  status text not null default 'connected' check (status in ('connected', 'disconnected', 'expired', 'error')),
  scopes text[] not null default '{}',
  access_token text,
  refresh_token text,
  id_token text,
  token_type text,
  expires_at timestamptz,
  refresh_token_expires_at timestamptz,
  connected_at timestamptz not null default now(),
  last_synced_at timestamptz,
  last_error text,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (firm_id, client_id, realm_id)
);

create index if not exists qbo_connections_firm_client_idx on qbo_connections(firm_id, client_id, status);
