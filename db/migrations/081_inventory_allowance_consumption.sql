-- Donna Inventory I4·posting — P6b: allowance derecognition-consumption (design §5-F/§16).
--
-- The write-down allowance register (080) is a valuation OVERLAY bound to specific SKU/group
-- stock. §5-F's redline: when that stock is DERECOGNIZED (sold, scrapped, damaged/wasted), the
-- bound allowance must be RELEASED/CONSUMED in the SAME event, so it never strands against
-- stock that no longer exists (the §16 allowance-integrity engine asserts exactly this). P6a
-- built the read-side engine that SURFACES a strand; P6b builds the WRITE side that prevents
-- one — the register writer (a write-down now persists its lot) and the release POST (routed
-- through the P5 executor/gateway, never a new backend).
--
-- Two additions, both additive and backward-compatible:
--
--   1. A BOUND QUANTITY on the allowance lot. Consumption is proportional to the quantity
--      derecognized (release = outstanding × qty / remaining_quantity), so the lot must carry
--      how much stock it was bound to (bound_quantity, set at write-down) and how much is still
--      bound (remaining_quantity, decremented as stock leaves). Nullable so an already-persisted
--      lot (none exist yet — 080's register had no writer) is never broken; the writer sets both.
--
--   2. The 'allowance_release' posting_kind. A release POSTS a journal (DR allowance / CR
--      cost_of_sales|count_variance) through the P5 executor, recorded as its own attempt +
--      journal-group delta_adjustment — so it is a first-class, queryable, audited posting kind,
--      not a mislabeled write-down. The CHECK is pinned to postingLog.js INVENTORY_POSTING_KINDS
--      by migrations.test.js (across 080 + this file), so the column and the runtime never drift.

-- ── 1. bound quantity on the allowance register ───────────────────────────────
alter table inventory_valuation_allowances add column if not exists bound_quantity     numeric(24, 8);
alter table inventory_valuation_allowances add column if not exists remaining_quantity numeric(24, 8);

-- remaining_quantity walks down from bound_quantity as stock is derecognized; it never goes
-- negative and never exceeds what was bound (consumption caps qty at the remaining bound qty).
alter table inventory_valuation_allowances drop constraint if exists inventory_valuation_allowances_remaining_qty_check;
alter table inventory_valuation_allowances add  constraint inventory_valuation_allowances_remaining_qty_check
  check (remaining_quantity is null or (remaining_quantity >= 0 and (bound_quantity is null or remaining_quantity <= bound_quantity)));

-- Active lots are looked up by scope during derecognition (FIFO by valuation_date); a partial
-- index over the still-consumable lots keeps that read cheap.
create index if not exists inventory_valuation_allowances_active_scope_idx
  on inventory_valuation_allowances (firm_id, client_id, scope_item_id, scope_group, valuation_date)
  where status = 'active';

-- ── 2. the 'allowance_release' posting_kind ───────────────────────────────────
-- Recreate the posting_kind CHECK with the release kind added. The constraint name is the
-- Postgres-default inline name from 080 (<table>_<column>_check). Drop-if-exists keeps this
-- idempotent and re-runnable (migrations are auto-discovered + re-applied).
alter table inventory_posting_attempts drop constraint if exists inventory_posting_attempts_posting_kind_check;
alter table inventory_posting_attempts add  constraint inventory_posting_attempts_posting_kind_check
  check (posting_kind in (
    'receipt','matched_supplier_bill','landed_cost','shipment_cogs',
    'customer_return','supplier_return','count_adjustment','write_down',
    'reversal','private_use','value_neutral','allowance_release'));
