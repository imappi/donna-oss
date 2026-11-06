create table if not exists close_archives (
  id text primary key,
  firm_id text not null references firms(id) on delete cascade,
  client_id text not null references clients(id) on delete cascade,
  period_start date not null,
  period_end date not null,
  status text not null default 'generated',
  schema_version text not null,
  manifest_checksum text not null,
  manifest jsonb not null default '{}'::jsonb,
  generated_by text,
  generated_at timestamptz not null default now(),
  storage_status text not null default 'not_configured',
  storage_destination text,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (firm_id, client_id, period_start, period_end, manifest_checksum)
);

create index if not exists close_archives_firm_client_period_idx
  on close_archives(firm_id, client_id, period_start, period_end);
