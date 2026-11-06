create table if not exists ledger_accounts (
  id text primary key,
  firm_id text not null references firms(id) on delete cascade,
  client_id text not null references clients(id) on delete cascade,
  code text,
  name text not null,
  account_type text not null default 'unknown',
  normal_balance text not null default 'debit' check (normal_balance in ('debit', 'credit')),
  currency text,
  tax_type text,
  xero_account_id text,
  status text not null default 'active' check (status in ('active', 'archived')),
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (firm_id, client_id, code)
);

create table if not exists ledger_journals (
  id text primary key,
  firm_id text not null references firms(id) on delete cascade,
  client_id text not null references clients(id) on delete cascade,
  source_type text not null,
  source_id text not null,
  journal_date date not null,
  currency text not null,
  status text not null default 'posted' check (status in ('draft', 'posted', 'voided', 'closed')),
  memo text,
  posted_at timestamptz,
  closed_at timestamptz,
  reversed_at timestamptz,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (firm_id, client_id, source_type, source_id)
);

create table if not exists ledger_lines (
  id text primary key,
  journal_id text not null references ledger_journals(id) on delete cascade,
  firm_id text not null references firms(id) on delete cascade,
  client_id text not null references clients(id) on delete cascade,
  account_id text not null references ledger_accounts(id) on delete restrict,
  account_code text,
  account_name text,
  line_no integer not null,
  direction text not null check (direction in ('debit', 'credit')),
  debit numeric(14, 2) not null default 0,
  credit numeric(14, 2) not null default 0,
  amount numeric(14, 2) not null,
  currency text not null,
  tax_type text,
  counterparty text,
  memo text,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (journal_id, line_no)
);

create table if not exists close_periods (
  id text primary key,
  firm_id text not null references firms(id) on delete cascade,
  client_id text not null references clients(id) on delete cascade,
  period_start date not null,
  period_end date not null,
  status text not null default 'open' check (status in ('open', 'reviewing', 'closed', 'locked')),
  closed_by text,
  closed_at timestamptz,
  locked_at timestamptz,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (firm_id, client_id, period_start, period_end)
);

create table if not exists close_checks (
  id text primary key,
  close_period_id text not null references close_periods(id) on delete cascade,
  firm_id text not null references firms(id) on delete cascade,
  client_id text not null references clients(id) on delete cascade,
  check_type text not null,
  status text not null default 'open' check (status in ('open', 'passed', 'warning', 'blocked', 'waived')),
  summary text,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (close_period_id, check_type)
);

create index if not exists ledger_accounts_firm_client_idx on ledger_accounts(firm_id, client_id, status);
create index if not exists ledger_journals_firm_client_date_idx on ledger_journals(firm_id, client_id, journal_date);
create index if not exists ledger_journals_source_idx on ledger_journals(firm_id, client_id, source_type, source_id);
create index if not exists ledger_lines_firm_client_account_idx on ledger_lines(firm_id, client_id, account_id);
create index if not exists close_periods_firm_client_status_idx on close_periods(firm_id, client_id, status);
create index if not exists close_checks_period_status_idx on close_checks(close_period_id, status);
