-- Donna Inventory F3 — additive indexes for the commercial-commitment
-- lifecycle writers. The 073 commitment tables remain the source of truth;
-- these indexes only bound same-line and same-item lifecycle reads.

create index if not exists inventory_reservations_sales_order_line_idx
  on inventory_reservations(client_id, sales_order_line_id, state, created_at, id);

create index if not exists inventory_allocations_sales_order_line_idx
  on inventory_allocations(client_id, sales_order_line_id, state, created_at, id);

create index if not exists inventory_backorders_item_state_idx
  on inventory_backorders(client_id, item_id, state, created_at, id);

create index if not exists inventory_purchase_order_lines_po_item_idx
  on inventory_purchase_order_lines(client_id, purchase_order_id, item_id);
