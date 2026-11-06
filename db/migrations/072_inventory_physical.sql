-- Donna Inventory I1 — append-only physical operation ledger, cost FACTS on
-- operations, rebuildable level/availability projections, anomalies and
-- idempotent command receipts. No ledger/journal/accounting writes live here.

create table if not exists inventory_command_receipts (
  id bigserial primary key,
  firm_id text not null references firms(id) on delete cascade,
  client_id text not null references clients(id) on delete cascade,
  idempotency_key text not null unique,
  intent text not null,
  receipt jsonb not null,
  created_at timestamptz not null default now()
);

create table if not exists inventory_operations (
  id bigserial primary key,
  firm_id text not null references firms(id) on delete cascade,
  client_id text not null references clients(id) on delete cascade,
  item_id text not null references inventory_items(id),
  location_id text not null references inventory_locations(id),
  operation_type text not null check (operation_type in ('opening_balance','receipt','shipment','count_correction','quarantine','release_quarantine','owner_private_use','reversal')),
  quantity numeric(24, 8) not null,
  uom_id text references inventory_units_of_measure(id),
  occurred_at timestamptz not null,
  idempotency_key text not null unique,
  reverses_operation_id bigint references inventory_operations(id),
  reference_type text,
  reference_id text,
  unit_cost_amount numeric(24, 8),
  unit_cost_currency char(3),
  provisional_cost boolean not null default false,
  actor_id text not null,
  authority_basis text,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  check ((unit_cost_amount is null and unit_cost_currency is null) or (unit_cost_amount is not null and unit_cost_currency is not null))
);

create table if not exists inventory_item_levels (
  firm_id text not null references firms(id) on delete cascade,
  client_id text not null references clients(id) on delete cascade,
  item_id text not null references inventory_items(id),
  location_id text not null references inventory_locations(id),
  on_hand numeric(24, 8) not null default 0,
  reserved numeric(24, 8) not null default 0,
  allocated numeric(24, 8) not null default 0,
  quarantined numeric(24, 8) not null default 0,
  available numeric(24, 8) not null default 0,
  inbound numeric(24, 8) not null default 0,
  backordered numeric(24, 8) not null default 0,
  last_operation_id bigint references inventory_operations(id),
  updated_at timestamptz not null default now(),
  primary key (client_id, item_id, location_id)
);

create table if not exists inventory_anomalies (
  id bigserial primary key,
  firm_id text not null references firms(id) on delete cascade,
  client_id text not null references clients(id) on delete cascade,
  item_id text references inventory_items(id),
  location_id text references inventory_locations(id),
  anomaly_type text not null check (anomaly_type in ('negative_observed_count','count_variance','over_receipt','short_receipt','expired_reservation','below_reorder','stale_count','overdue_purchase_order')),
  status text not null default 'open',
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists inventory_operations_client_item_idx on inventory_operations(client_id, item_id, location_id, occurred_at, id);
create index if not exists inventory_anomalies_client_status_idx on inventory_anomalies(client_id, status, created_at);
