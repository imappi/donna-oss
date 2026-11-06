-- Physical inventory correctness: terminal backorders retain an explicit zero
-- remainder; scope serialization in db.js protects absent projection rows.
-- History is preserved. Existing physical operations are never rewritten.
alter table inventory_backorders drop constraint if exists inventory_backorders_quantity_check;
alter table inventory_backorders add constraint inventory_backorders_quantity_check
  check (quantity >= 0 and (quantity > 0 or state in ('filled', 'cancelled')));

create unique index if not exists inventory_operations_one_reversal_idx
  on inventory_operations (reverses_operation_id)
  where operation_type = 'reversal' and reverses_operation_id is not null;
create unique index if not exists inventory_count_sessions_one_open_scope_idx
  on inventory_count_sessions (client_id, scope) where state = 'open';

-- A backorder is owed at the location where the reservation was requested.
-- Legacy unlocated backorders remain attributable to the default location.
alter table inventory_backorders add column if not exists location_id text references inventory_locations(id);
create index if not exists inventory_backorders_open_location_idx
  on inventory_backorders(client_id, item_id, location_id) where state in ('open', 'partially_filled');

-- Explicit short-close retires only this line's unreceived expectation.
alter table inventory_purchase_order_lines add column if not exists closed_short boolean not null default false;
