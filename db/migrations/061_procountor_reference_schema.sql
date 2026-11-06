-- Procountor reference-data schema — corrected to the LIVE API field shapes.
--
-- Migration 055 created procountor_accounts/_dimensions/_vendors/_customers with
-- QBO-template PLACEHOLDER columns and a note that a corrective migration was
-- expected once the real payloads were seen. They were seen on 2026-07-08
-- against the live PTS API (company cid 16266): GET /api/coa, /api/dimensions,
-- /api/businesspartners, /api/bankaccounts. This migration reshapes the tables
-- to those shapes. Nothing wrote the 055 reference tables (only
-- procountor_connections is live), so DROP+CREATE loses no data.
--
-- Observed divergences from the QBO placeholders:
--   * /api/coa returns {ledgerAccounts:[{ledgerAccountCode,name,active,
--     translations:[{languageCode,translation}]}]}. The ledgerAccountCode IS the
--     identifier (there is no separate id), and there is NO type/subType/
--     classification/currency/balance/description. fi/en/sv names via translations.
--   * /api/businesspartners returns ONE list ({results:[{id,name,type,...}]}) with
--     a type enum (CUSTOMER|SUPPLIER|PERSON), NOT the split vendor/customer feeds
--     the placeholders assumed. Replaces procountor_vendors + procountor_customers.
--   * /api/bankaccounts had NO placeholder table at all in 055 — added here.
--   * /api/dimensions returned [] on a pilot client (none configured), so the item shape is
--     UNVALIDATED — the table stays minimal (id/name/active + raw payload) and a
--     later corrective migration follows once a live sample with dimensions exists.

-- ── Chart of accounts (GET /api/coa) ──────────────────────────────────────
drop table if exists procountor_accounts cascade;
create table procountor_accounts (
  id text primary key,
  connection_id text not null references procountor_connections(id) on delete cascade,
  firm_id text not null references firms(id) on delete cascade,
  client_id text not null references clients(id) on delete cascade,
  ledger_account_code text not null,
  name text,
  name_en text,
  name_sv text,
  active boolean not null default true,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (connection_id, ledger_account_code)
);
create index if not exists procountor_accounts_connection_code_idx on procountor_accounts(connection_id, ledger_account_code);

-- ── Dimensions (GET /api/dimensions) — shape UNVALIDATED, kept minimal ─────
drop table if exists procountor_dimensions cascade;
create table procountor_dimensions (
  id text primary key,
  connection_id text not null references procountor_connections(id) on delete cascade,
  firm_id text not null references firms(id) on delete cascade,
  client_id text not null references clients(id) on delete cascade,
  procountor_dimension_id text not null,
  name text,
  active boolean not null default true,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (connection_id, procountor_dimension_id)
);
create index if not exists procountor_dimensions_connection_name_idx on procountor_dimensions(connection_id, name);

-- ── Business partners (GET /api/businesspartners) — one table, type enum ───
drop table if exists procountor_vendors cascade;
drop table if exists procountor_customers cascade;
create table procountor_business_partners (
  id text primary key,
  connection_id text not null references procountor_connections(id) on delete cascade,
  firm_id text not null references firms(id) on delete cascade,
  client_id text not null references clients(id) on delete cascade,
  procountor_partner_id text not null,
  name text,
  partner_type text,
  email text,
  active boolean not null default true,
  version text,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (connection_id, procountor_partner_id)
);
create index if not exists procountor_business_partners_conn_type_idx on procountor_business_partners(connection_id, partner_type);
create index if not exists procountor_business_partners_conn_name_idx on procountor_business_partners(connection_id, name);

-- ── Bank accounts (GET /api/bankaccounts) — new table ──────────────────────
create table if not exists procountor_bank_accounts (
  id text primary key,
  connection_id text not null references procountor_connections(id) on delete cascade,
  firm_id text not null references firms(id) on delete cascade,
  client_id text not null references clients(id) on delete cascade,
  procountor_bank_account_id text not null,
  account_number text,
  iban text,
  bic text,
  bank_name text,
  currency text,
  default_for_invoice boolean not null default false,
  default_for_payment boolean not null default false,
  status text,
  order_no integer,
  version text,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (connection_id, procountor_bank_account_id)
);
create index if not exists procountor_bank_accounts_connection_order_idx on procountor_bank_accounts(connection_id, order_no);
