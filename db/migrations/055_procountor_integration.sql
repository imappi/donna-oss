-- Procountor connector storage (capability trial; not GA).
-- Mirrors QBO migrations 024/025/026 in TABLE SHAPE (connection, reference
-- data, sync runs, journal mirrors). The column names below are scaffolding
-- carried over from the QBO template — Procountor's REAL field mapping
-- (ledger accounts, dimensions, business partners; dev.procountor.com) gets
-- validated in the live trial before any verb writes these tables, and this
-- schema is expected to be corrected then. Only procountor_connections is
-- written today (the OAuth connect path).

-- Procountor connection storage (Phase 2.1a: OAuth + token storage).
--
-- Parallel to xero_connections (003) rather than a generalised
-- accounting_connections table: the rename/consolidation is deferred to a
-- later PR once both the Xero and Procountor paths are live and validated. Mirrors
-- the Xero shape one-for-one with two Procountor-specific differences:
--   * company_id replaces tenant_id — the connected Procountor company is
--     identified from the OAuth callback (exact query-param name is a runbook
--     question); it IS the connection, no /connections fan-out like Xero.
create table if not exists procountor_connections (
  id text primary key,
  firm_id text not null references firms(id) on delete cascade,
  client_id text not null references clients(id) on delete cascade,
  company_id text not null,
  organization_name text,
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
  unique (firm_id, client_id, company_id)
);

create index if not exists procountor_connections_firm_client_idx on procountor_connections(firm_id, client_id, status);


-- Procountor reference-data storage (Phase 2.1b: reference sync).
--
-- Parallel to the Xero reference tables (003) rather than a generalised
-- accounting_reference store — same deferral as 024 (procountor_connections): the
-- rename/consolidation to accounting_* tables waits until both the Xero and
-- Procountor paths are fully live. Each table mirrors the Xero shape's intent
-- (connection-scoped upsert target, firm/client denormalised for the
-- snapshot read, raw payload jsonb for anything the columns don't capture)
-- with placeholder column names inherited from the QBO template (AccountType/
-- AccountSubType/Classification etc. are QBO's CoA vocabulary, NOT Procountor's
-- — Procountor models a CoA of ledger accounts, tracking DIMENSIONS, and
-- business partners). These tables are written by NOTHING until the live trial
-- validates the real field mapping; expect a corrective migration then.
create table if not exists procountor_accounts (
  id text primary key,
  connection_id text not null references procountor_connections(id) on delete cascade,
  firm_id text not null references firms(id) on delete cascade,
  client_id text not null references clients(id) on delete cascade,
  procountor_account_id text not null,
  name text,
  fully_qualified_name text,
  account_number text,
  account_type text,
  account_sub_type text,
  classification text,
  currency text,
  active boolean not null default true,
  current_balance numeric not null default 0,
  description text,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (connection_id, procountor_account_id)
);

create table if not exists procountor_dimensions (
  id text primary key,
  connection_id text not null references procountor_connections(id) on delete cascade,
  firm_id text not null references firms(id) on delete cascade,
  client_id text not null references clients(id) on delete cascade,
  procountor_dimension_id text not null,
  name text,
  fully_qualified_name text,
  parent_id text,
  sub_class boolean not null default false,
  active boolean not null default true,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (connection_id, procountor_dimension_id)
);

create table if not exists procountor_vendors (
  id text primary key,
  connection_id text not null references procountor_connections(id) on delete cascade,
  firm_id text not null references firms(id) on delete cascade,
  client_id text not null references clients(id) on delete cascade,
  procountor_vendor_id text not null,
  display_name text,
  organization_name text,
  email text,
  active boolean not null default true,
  balance numeric not null default 0,
  vendor_1099 boolean not null default false,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (connection_id, procountor_vendor_id)
);

create table if not exists procountor_customers (
  id text primary key,
  connection_id text not null references procountor_connections(id) on delete cascade,
  firm_id text not null references firms(id) on delete cascade,
  client_id text not null references clients(id) on delete cascade,
  procountor_customer_id text not null,
  display_name text,
  organization_name text,
  email text,
  active boolean not null default true,
  balance numeric not null default 0,
  taxable boolean not null default false,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (connection_id, procountor_customer_id)
);

create table if not exists procountor_sync_runs (
  id text primary key,
  connection_id text references procountor_connections(id) on delete cascade,
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

create index if not exists procountor_accounts_connection_number_idx on procountor_accounts(connection_id, account_number);
create index if not exists procountor_dimensions_connection_name_idx on procountor_dimensions(connection_id, name);
create index if not exists procountor_vendors_connection_name_idx on procountor_vendors(connection_id, display_name);
create index if not exists procountor_customers_connection_name_idx on procountor_customers(connection_id, display_name);
create index if not exists procountor_sync_runs_connection_started_idx on procountor_sync_runs(connection_id, started_at desc);


-- Procountor journal-mirror tracking (Phase 2.1c: ledger writeback).
--
-- Writeback (NOT yet wired — scaffolded until live validation) will mirror a
-- posted Donna ledger_journal to a Procountor journal, line-for-line. The
-- unique (connection_id, journal_id) row is the idempotency guard that makes a
-- re-sync an UPDATE rather than a duplicate create — the same role
-- qbo_journal_mirrors plays (026). sync_token is a QBO-template placeholder;
-- whether Procountor has an equivalent concurrency token is a runbook question.
--
-- source_type / source_id are denormalised from the journal so retry/verify can
-- filter by the originating transaction without joining ledger_journals.
create table if not exists procountor_journal_mirrors (
  id text primary key,
  connection_id text references procountor_connections(id) on delete cascade,
  firm_id text not null references firms(id) on delete cascade,
  client_id text not null references clients(id) on delete cascade,
  journal_id text not null references ledger_journals(id) on delete cascade,
  procountor_journal_entry_id text,
  sync_token text,
  doc_number text,
  status text not null default 'running' check (status in ('running', 'synced', 'error', 'stale')),
  source_type text,
  source_id text,
  posted_at timestamptz,
  verified_at timestamptz,
  last_error text,
  request_payload jsonb not null default '{}'::jsonb,
  response_payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (connection_id, journal_id)
);

create index if not exists procountor_journal_mirrors_firm_client_status_idx on procountor_journal_mirrors(firm_id, client_id, status);
create index if not exists procountor_journal_mirrors_source_idx on procountor_journal_mirrors(firm_id, client_id, source_type, source_id);
create index if not exists procountor_journal_mirrors_journal_idx on procountor_journal_mirrors(journal_id);


