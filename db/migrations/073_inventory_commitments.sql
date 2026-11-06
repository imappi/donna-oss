-- Donna Inventory I2 — commercial commitments. POs/SOs/reservations/
-- allocations/backorders are promises and expectations, not physical movement.
-- Receipts and shipments remain inventory_operations rows.

create table if not exists inventory_purchase_orders (
  id bigserial primary key,
  firm_id text not null references firms(id) on delete cascade,
  client_id text not null references clients(id) on delete cascade,
  supplier_id text not null,
  state text not null check (state in ('proposal','approved','ordered','acknowledged','partially_received','fully_received','cancelled')),
  idempotency_key text not null unique,
  actor_id text not null,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists inventory_purchase_order_lines (
  id bigserial primary key,
  firm_id text not null references firms(id) on delete cascade,
  client_id text not null references clients(id) on delete cascade,
  purchase_order_id bigint not null references inventory_purchase_orders(id) on delete cascade,
  item_id text not null references inventory_items(id),
  quantity_ordered numeric(24, 8) not null check (quantity_ordered > 0),
  quantity_received numeric(24, 8) not null default 0,
  uom_id text references inventory_units_of_measure(id),
  expected_unit_cost_amount numeric(24, 8),
  expected_unit_cost_currency char(3),
  check ((expected_unit_cost_amount is null and expected_unit_cost_currency is null) or (expected_unit_cost_amount is not null and expected_unit_cost_currency is not null))
);

create table if not exists inventory_supplier_acknowledgements (
  id bigserial primary key,
  firm_id text not null references firms(id) on delete cascade,
  client_id text not null references clients(id) on delete cascade,
  purchase_order_id bigint not null references inventory_purchase_orders(id) on delete cascade,
  acknowledged_at timestamptz not null,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists inventory_sales_orders (
  id bigserial primary key,
  firm_id text not null references firms(id) on delete cascade,
  client_id text not null references clients(id) on delete cascade,
  customer_ref text not null,
  state text not null check (state in ('order','reserved','allocated','picked','partially_shipped','shipped','backordered','cancelled')),
  idempotency_key text not null unique,
  actor_id text not null,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists inventory_sales_order_lines (
  id bigserial primary key,
  firm_id text not null references firms(id) on delete cascade,
  client_id text not null references clients(id) on delete cascade,
  sales_order_id bigint not null references inventory_sales_orders(id) on delete cascade,
  item_id text not null references inventory_items(id),
  quantity_ordered numeric(24, 8) not null check (quantity_ordered > 0),
  quantity_reserved numeric(24, 8) not null default 0,
  quantity_allocated numeric(24, 8) not null default 0,
  quantity_shipped numeric(24, 8) not null default 0,
  uom_id text references inventory_units_of_measure(id)
);

create table if not exists inventory_reservations (
  id bigserial primary key,
  firm_id text not null references firms(id) on delete cascade,
  client_id text not null references clients(id) on delete cascade,
  sales_order_line_id bigint not null references inventory_sales_order_lines(id) on delete cascade,
  item_id text not null references inventory_items(id),
  location_id text not null references inventory_locations(id),
  quantity numeric(24, 8) not null check (quantity > 0),
  state text not null default 'active' check (state in ('active','expired','released','fulfilled')),
  expires_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists inventory_allocations (
  id bigserial primary key,
  firm_id text not null references firms(id) on delete cascade,
  client_id text not null references clients(id) on delete cascade,
  sales_order_line_id bigint not null references inventory_sales_order_lines(id) on delete cascade,
  item_id text not null references inventory_items(id),
  location_id text not null references inventory_locations(id),
  quantity numeric(24, 8) not null check (quantity > 0),
  state text not null default 'active' check (state in ('active','picked','shipped','released')),
  created_at timestamptz not null default now()
);

create table if not exists inventory_backorders (
  id bigserial primary key,
  firm_id text not null references firms(id) on delete cascade,
  client_id text not null references clients(id) on delete cascade,
  sales_order_line_id bigint not null references inventory_sales_order_lines(id) on delete cascade,
  item_id text not null references inventory_items(id),
  quantity numeric(24, 8) not null check (quantity > 0),
  state text not null default 'open' check (state in ('open','partially_filled','filled','cancelled')),
  created_at timestamptz not null default now()
);
