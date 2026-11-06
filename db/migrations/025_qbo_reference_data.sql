-- QuickBooks Online reference-data storage (Phase 2.1b: reference sync).
--
-- Parallel to the Xero reference tables (003) rather than a generalised
-- accounting_reference store — same deferral as 024 (qbo_connections): the
-- rename/consolidation to accounting_* tables waits until both the Xero and
-- QBO paths are fully live. Each table mirrors the Xero shape's intent
-- (connection-scoped upsert target, firm/client denormalised for the
-- snapshot read, raw payload jsonb for anything the columns don't capture)
-- but carries QBO's field names instead of Xero's:
--   * QBO ids are the entity `Id` (a string), unique per realm.
--   * QBO's single Contact split into Vendor + Customer — so two tables here
--     where Xero has one xero_contacts. Pulled now (not deferred to writeback)
--     because writeback's supplier/customer matching will want them seeded.
--   * Accounts carry AccountType/AccountSubType/Classification (QBO's CoA
--     vocabulary) rather than Xero's Type/Class/TaxType.
--   * Classes are QBO's tracking dimension (no Xero equivalent in 003).
create table if not exists qbo_accounts (
  id text primary key,
  connection_id text not null references qbo_connections(id) on delete cascade,
  firm_id text not null references firms(id) on delete cascade,
  client_id text not null references clients(id) on delete cascade,
  qbo_account_id text not null,
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
  unique (connection_id, qbo_account_id)
);

create table if not exists qbo_classes (
  id text primary key,
  connection_id text not null references qbo_connections(id) on delete cascade,
  firm_id text not null references firms(id) on delete cascade,
  client_id text not null references clients(id) on delete cascade,
  qbo_class_id text not null,
  name text,
  fully_qualified_name text,
  parent_id text,
  sub_class boolean not null default false,
  active boolean not null default true,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (connection_id, qbo_class_id)
);

create table if not exists qbo_vendors (
  id text primary key,
  connection_id text not null references qbo_connections(id) on delete cascade,
  firm_id text not null references firms(id) on delete cascade,
  client_id text not null references clients(id) on delete cascade,
  qbo_vendor_id text not null,
  display_name text,
  company_name text,
  email text,
  active boolean not null default true,
  balance numeric not null default 0,
  vendor_1099 boolean not null default false,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (connection_id, qbo_vendor_id)
);

create table if not exists qbo_customers (
  id text primary key,
  connection_id text not null references qbo_connections(id) on delete cascade,
  firm_id text not null references firms(id) on delete cascade,
  client_id text not null references clients(id) on delete cascade,
  qbo_customer_id text not null,
  display_name text,
  company_name text,
  email text,
  active boolean not null default true,
  balance numeric not null default 0,
  taxable boolean not null default false,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (connection_id, qbo_customer_id)
);

create table if not exists qbo_sync_runs (
  id text primary key,
  connection_id text references qbo_connections(id) on delete cascade,
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

create index if not exists qbo_accounts_connection_number_idx on qbo_accounts(connection_id, account_number);
create index if not exists qbo_classes_connection_name_idx on qbo_classes(connection_id, name);
create index if not exists qbo_vendors_connection_name_idx on qbo_vendors(connection_id, display_name);
create index if not exists qbo_customers_connection_name_idx on qbo_customers(connection_id, display_name);
create index if not exists qbo_sync_runs_connection_started_idx on qbo_sync_runs(connection_id, started_at desc);
