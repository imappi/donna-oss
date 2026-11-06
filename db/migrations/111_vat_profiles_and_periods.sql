-- MTD-2: the server-owned local projection of the business's VAT profile and
-- obligations. HMRC wire details are deliberately absent: the corresponding
-- runtime transport remains fail-closed until the endpoint contract is
-- confirmed against the Developer Hub.

create table if not exists vat_customer_profiles (
  id text primary key,
  firm_id text not null references firms(id) on delete cascade,
  client_id text not null references clients(id) on delete cascade,
  vrn text not null,
  effective_registration_date date,
  flat_rate_scheme boolean,
  deregistration_date date,
  hmrc_payload jsonb not null,
  synced_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (firm_id, client_id, vrn)
);

create table if not exists vat_periods (
  id text primary key,
  firm_id text not null references firms(id) on delete cascade,
  client_id text not null references clients(id) on delete cascade,
  vrn text not null,
  -- Opaque authority identifier. Never parse or reconstruct this value.
  period_key text not null,
  start_date date not null,
  end_date date not null,
  due_date date not null,
  received_date date,
  status text not null check (status in ('open', 'fulfilled', 'unknown')),
  hmrc_obligation_payload jsonb not null,
  synced_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists vat_customer_profiles_client_idx
  on vat_customer_profiles (firm_id, client_id, synced_at desc);

create index if not exists vat_periods_client_dates_idx
  on vat_periods (firm_id, client_id, start_date, end_date);

create index if not exists vat_periods_client_period_idx
  on vat_periods (firm_id, client_id, vrn, period_key);

alter table vat_customer_profiles enable row level security;
alter table vat_periods enable row level security;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on vat_customer_profiles from anon;
    revoke all on vat_periods from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on vat_customer_profiles from authenticated;
    revoke all on vat_periods from authenticated;
  end if;
end $$;
