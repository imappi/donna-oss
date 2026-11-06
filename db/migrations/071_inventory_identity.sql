-- Donna Inventory I1 — product identity, client binding, UOM/package model,
-- aliases/substitutions and default locations. Entity = existing clients row;
-- this schema references clients and does not remodel legal entities.

create table if not exists inventory_units_of_measure (
  id text primary key,
  firm_id text not null references firms(id) on delete cascade,
  client_id text not null references clients(id) on delete cascade,
  code text not null,
  name text not null,
  kind text not null,
  created_at timestamptz not null default now(),
  unique (client_id, code)
);

create table if not exists inventory_uom_conversions (
  id text primary key,
  firm_id text not null references firms(id) on delete cascade,
  client_id text not null references clients(id) on delete cascade,
  from_uom_id text not null references inventory_units_of_measure(id),
  to_uom_id text not null references inventory_units_of_measure(id),
  factor numeric(24, 8) not null check (factor > 0),
  package_label text,
  created_at timestamptz not null default now(),
  unique (client_id, from_uom_id, to_uom_id)
);

create table if not exists inventory_products (
  id text primary key,
  firm_id text not null references firms(id) on delete cascade,
  client_id text not null references clients(id) on delete cascade,
  name text not null,
  classification_path text,
  status text not null default 'active',
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists inventory_items (
  id text primary key,
  firm_id text not null references firms(id) on delete cascade,
  client_id text not null references clients(id) on delete cascade,
  product_id text references inventory_products(id) on delete set null,
  sku text not null,
  name text not null,
  base_uom_id text references inventory_units_of_measure(id),
  status text not null default 'active',
  group_path text,
  reorder_point numeric(24, 8),
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (client_id, sku)
);

create table if not exists inventory_barcodes (
  id text primary key,
  firm_id text not null references firms(id) on delete cascade,
  client_id text not null references clients(id) on delete cascade,
  item_id text not null references inventory_items(id) on delete cascade,
  barcode text not null,
  created_at timestamptz not null default now(),
  unique (client_id, barcode)
);

create table if not exists inventory_supplier_identifiers (
  id text primary key,
  firm_id text not null references firms(id) on delete cascade,
  client_id text not null references clients(id) on delete cascade,
  item_id text not null references inventory_items(id) on delete cascade,
  supplier_id text not null,
  supplier_sku text not null,
  created_at timestamptz not null default now(),
  unique (client_id, supplier_id, supplier_sku)
);

create table if not exists inventory_locations (
  id text primary key,
  firm_id text not null references firms(id) on delete cascade,
  client_id text not null references clients(id) on delete cascade,
  code text not null,
  name text not null,
  is_default boolean not null default false,
  status text not null default 'active',
  created_at timestamptz not null default now(),
  unique (client_id, code)
);
create unique index if not exists inventory_locations_one_default_idx on inventory_locations(client_id) where is_default;

create table if not exists inventory_aliases (
  id text primary key,
  firm_id text not null references firms(id) on delete cascade,
  client_id text not null references clients(id) on delete cascade,
  item_id text not null references inventory_items(id) on delete cascade,
  alias text not null,
  source text not null check (source in ('correction', 'manual')),
  status text not null default 'active' check (status in ('active', 'dismissed')),
  created_at timestamptz not null default now(),
  dismissed_at timestamptz,
  unique (client_id, alias, item_id)
);

create table if not exists inventory_substitutions (
  id text primary key,
  firm_id text not null references firms(id) on delete cascade,
  client_id text not null references clients(id) on delete cascade,
  item_id text not null references inventory_items(id) on delete cascade,
  substitute_item_id text not null references inventory_items(id) on delete cascade,
  status text not null default 'active',
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (client_id, item_id, substitute_item_id)
);
