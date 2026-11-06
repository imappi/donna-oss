create table if not exists xero_connections (
  id text primary key,
  firm_id text not null references firms(id) on delete cascade,
  client_id text not null references clients(id) on delete cascade,
  tenant_id text not null,
  tenant_name text,
  tenant_type text,
  auth_event_id text,
  status text not null default 'connected' check (status in ('connected', 'disconnected', 'expired', 'error')),
  scopes text[] not null default '{}',
  access_token text,
  refresh_token text,
  id_token text,
  token_type text,
  expires_at timestamptz,
  connected_at timestamptz not null default now(),
  last_synced_at timestamptz,
  last_error text,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (firm_id, client_id, tenant_id)
);

create table if not exists xero_accounts (
  id text primary key,
  connection_id text not null references xero_connections(id) on delete cascade,
  firm_id text not null references firms(id) on delete cascade,
  client_id text not null references clients(id) on delete cascade,
  xero_account_id text not null,
  code text,
  name text,
  type text,
  status text,
  tax_type text,
  class text,
  system_account text,
  enable_payments_to_account boolean not null default false,
  show_in_expense_claims boolean not null default false,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (connection_id, xero_account_id)
);

create table if not exists xero_contacts (
  id text primary key,
  connection_id text not null references xero_connections(id) on delete cascade,
  firm_id text not null references firms(id) on delete cascade,
  client_id text not null references clients(id) on delete cascade,
  xero_contact_id text not null,
  contact_number text,
  name text,
  email_address text,
  is_customer boolean not null default false,
  is_supplier boolean not null default false,
  status text,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (connection_id, xero_contact_id)
);

create table if not exists xero_sync_runs (
  id text primary key,
  connection_id text references xero_connections(id) on delete cascade,
  firm_id text not null references firms(id) on delete cascade,
  client_id text not null references clients(id) on delete cascade,
  sync_type text not null,
  status text not null default 'running' check (status in ('running', 'completed', 'failed')),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  counts jsonb not null default '{}'::jsonb,
  error text,
  payload jsonb not null default '{}'::jsonb
);

create index if not exists xero_connections_firm_client_idx on xero_connections(firm_id, client_id, status);
create index if not exists xero_accounts_connection_code_idx on xero_accounts(connection_id, code);
create index if not exists xero_contacts_connection_name_idx on xero_contacts(connection_id, name);
create index if not exists xero_sync_runs_connection_started_idx on xero_sync_runs(connection_id, started_at desc);

