-- Donna Inventory I2 — structured count sessions. Counts are bulk-capable
-- sessions with incremental lines; closing creates count_correction operations
-- through the command layer, never a one-call overwrite.

create table if not exists inventory_count_sessions (
  id bigserial primary key,
  firm_id text not null references firms(id) on delete cascade,
  client_id text not null references clients(id) on delete cascade,
  scope jsonb not null,
  state text not null default 'open' check (state in ('open','closed','cancelled')),
  idempotency_key text not null unique,
  actor_id text not null,
  opened_at timestamptz not null default now(),
  closed_at timestamptz
);

create table if not exists inventory_count_lines (
  id bigserial primary key,
  firm_id text not null references firms(id) on delete cascade,
  client_id text not null references clients(id) on delete cascade,
  count_session_id bigint not null references inventory_count_sessions(id) on delete cascade,
  item_id text not null references inventory_items(id),
  location_id text not null references inventory_locations(id),
  counted_quantity numeric(24, 8) not null,
  uom_id text references inventory_units_of_measure(id),
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (count_session_id, item_id, location_id)
);

create index if not exists inventory_count_sessions_open_idx on inventory_count_sessions(client_id, state);
