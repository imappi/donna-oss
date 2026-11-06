alter table transactions add column if not exists external_transaction_id text;
alter table transactions add column if not exists raw_description text;
alter table transactions add column if not exists cleaned_description text;
alter table transactions add column if not exists merchant_id text;
alter table transactions add column if not exists direction text check (direction in ('money_in', 'money_out', 'zero', 'unknown'));
alter table transactions add column if not exists category text;
alter table transactions add column if not exists account_code text;
alter table transactions add column if not exists confidence_score numeric(4, 2);
alter table transactions add column if not exists reconciliation_status text not null default 'pending';
alter table transactions add column if not exists reconciled_at timestamptz;

alter table documents add column if not exists source text;
alter table documents add column if not exists file_url text;
alter table documents add column if not exists vendor_name text;
alter table documents add column if not exists customer_name text;
alter table documents add column if not exists document_date date;
alter table documents add column if not exists due_date date;
alter table documents add column if not exists total_amount numeric(14, 2);
alter table documents add column if not exists currency text;
alter table documents add column if not exists tax_amount numeric(14, 2);
alter table documents add column if not exists reference_number text;
alter table documents add column if not exists payment_status text not null default 'unknown';
alter table documents add column if not exists extraction_confidence numeric(4, 2);

create table if not exists document_lines (
  id text primary key,
  firm_id text not null references firms(id) on delete cascade,
  client_id text not null references clients(id) on delete cascade,
  document_id text not null references documents(id) on delete cascade,
  description text,
  quantity numeric(14, 4),
  unit_price numeric(14, 2),
  amount numeric(14, 2),
  tax_rate numeric(6, 4),
  category text,
  account_code text,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists merchants (
  id text primary key,
  firm_id text not null references firms(id) on delete cascade,
  canonical_name text not null,
  normalized_name text not null,
  default_category text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (firm_id, normalized_name)
);

create table if not exists merchant_aliases (
  id text primary key,
  firm_id text not null references firms(id) on delete cascade,
  merchant_id text not null references merchants(id) on delete cascade,
  alias_text text not null,
  normalized_alias text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (firm_id, normalized_alias)
);

create table if not exists client_rules (
  id text primary key,
  firm_id text not null references firms(id) on delete cascade,
  client_id text not null references clients(id) on delete cascade,
  rule_type text not null,
  merchant_id text references merchants(id) on delete set null,
  pattern_text text,
  category_override text,
  account_code text,
  reconciliation_behavior text,
  notes text,
  created_by text not null default 'system',
  status text not null default 'active',
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists reconciliation_matches (
  id text primary key,
  firm_id text not null references firms(id) on delete cascade,
  client_id text not null references clients(id) on delete cascade,
  bank_transaction_id text not null references transactions(id) on delete cascade,
  matched_object_type text not null,
  matched_object_id text,
  match_amount numeric(14, 2),
  match_confidence numeric(4, 2) not null default 0,
  match_reason text,
  status text not null default 'suggested',
  created_by text not null default 'system',
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (bank_transaction_id, matched_object_type, matched_object_id)
);

create table if not exists transaction_review_queue (
  id text primary key,
  firm_id text not null references firms(id) on delete cascade,
  client_id text not null references clients(id) on delete cascade,
  item_type text not null,
  item_id text not null,
  reason text not null,
  priority text not null default 'normal',
  assigned_to text,
  status text not null default 'open',
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (firm_id, client_id, item_type, item_id, reason)
);

create index if not exists transactions_firm_client_reconciliation_idx on transactions(firm_id, client_id, reconciliation_status);
create index if not exists transactions_firm_client_merchant_idx on transactions(firm_id, client_id, merchant_id);
create index if not exists documents_firm_client_reference_idx on documents(firm_id, client_id, reference_number);
create index if not exists document_lines_firm_document_idx on document_lines(firm_id, document_id);
create index if not exists merchants_firm_normalized_idx on merchants(firm_id, normalized_name);
create index if not exists merchant_aliases_firm_alias_idx on merchant_aliases(firm_id, normalized_alias);
create index if not exists client_rules_firm_client_type_idx on client_rules(firm_id, client_id, rule_type);
create index if not exists reconciliation_matches_firm_client_status_idx on reconciliation_matches(firm_id, client_id, status);
create index if not exists reconciliation_matches_transaction_idx on reconciliation_matches(bank_transaction_id);
create index if not exists transaction_review_queue_firm_client_status_idx on transaction_review_queue(firm_id, client_id, status);
