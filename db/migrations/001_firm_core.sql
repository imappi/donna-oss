create table if not exists schema_migrations (
  version text primary key,
  applied_at timestamptz not null default now()
);

create table if not exists firms (
  id text primary key,
  name text not null,
  slug text not null unique,
  jurisdiction text,
  default_currency text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists firm_members (
  id text primary key,
  firm_id text not null references firms(id) on delete cascade,
  user_id text,
  email text not null,
  name text not null,
  role text not null default 'member',
  status text not null default 'active',
  access_level text not null default 'staff',
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (firm_id, email)
);

create table if not exists firm_collaborators (
  id text primary key,
  firm_id text not null references firms(id) on delete cascade,
  user_id text,
  email text not null,
  name text not null,
  vendor_company text,
  country text,
  role text not null default 'bookkeeper',
  status text not null default 'active',
  access_level text not null default 'client_scoped',
  starts_at timestamptz,
  ends_at timestamptz,
  nda_signed_at timestamptz,
  data_processing_agreement_id text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (firm_id, email)
);

create table if not exists clients (
  id text primary key,
  firm_id text not null references firms(id) on delete cascade,
  company_name text not null,
  uen text,
  entity_type text,
  incorporation_date text,
  stage text,
  next_deadline text,
  status text not null default 'active',
  profile jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (firm_id, id)
);

create table if not exists client_assignments (
  id text primary key,
  firm_id text not null references firms(id) on delete cascade,
  client_id text not null references clients(id) on delete cascade,
  principal_type text not null check (principal_type in ('firm_member', 'firm_collaborator')),
  principal_id text not null,
  role text not null default 'viewer',
  access_level text not null default 'client_scoped',
  starts_at timestamptz,
  ends_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (client_id, principal_type, principal_id)
);

create table if not exists documents (
  id text primary key,
  firm_id text not null references firms(id) on delete cascade,
  client_id text not null references clients(id) on delete cascade,
  filename text not null,
  document_type text not null default 'unknown',
  status text not null default 'received',
  uploaded_at timestamptz,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists transactions (
  id text primary key,
  firm_id text not null references firms(id) on delete cascade,
  client_id text not null references clients(id) on delete cascade,
  document_id text references documents(id) on delete set null,
  transaction_date date,
  description text,
  money_in numeric(14, 2) not null default 0,
  money_out numeric(14, 2) not null default 0,
  currency text,
  status text not null default 'needs_review',
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists accounting_rules (
  id text primary key,
  firm_id text not null references firms(id) on delete cascade,
  client_id text references clients(id) on delete cascade,
  status text not null default 'suggested',
  trigger_hash text,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists queue_items (
  id text primary key,
  firm_id text not null references firms(id) on delete cascade,
  client_id text references clients(id) on delete cascade,
  queue_label text,
  status text not null default 'open',
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists history_items (
  id text primary key,
  firm_id text not null references firms(id) on delete cascade,
  client_id text references clients(id) on delete cascade,
  payload jsonb not null default '{}'::jsonb,
  happened_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists audit_events (
  id bigserial primary key,
  firm_id text not null references firms(id) on delete cascade,
  client_id text references clients(id) on delete set null,
  actor_type text,
  actor_id text,
  action text not null,
  resource_type text,
  resource_id text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists firm_members_firm_id_idx on firm_members(firm_id);
create index if not exists firm_collaborators_firm_id_idx on firm_collaborators(firm_id);
create index if not exists clients_firm_id_idx on clients(firm_id);
create index if not exists client_assignments_firm_client_idx on client_assignments(firm_id, client_id);
create index if not exists documents_firm_client_idx on documents(firm_id, client_id);
create index if not exists transactions_firm_client_date_idx on transactions(firm_id, client_id, transaction_date);
create index if not exists accounting_rules_firm_client_idx on accounting_rules(firm_id, client_id);
create index if not exists queue_items_firm_client_status_idx on queue_items(firm_id, client_id, status);
create index if not exists history_items_firm_client_idx on history_items(firm_id, client_id);
create index if not exists audit_events_firm_client_created_idx on audit_events(firm_id, client_id, created_at);
