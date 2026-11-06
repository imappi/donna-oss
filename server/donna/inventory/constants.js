// Donna Inventory substrate (I1+I2) — closed vocabularies and the config-plane
// gate key for the global inventory kernel. The kernel stores physical and
// commercial truth only; accounting/ledger books are intentionally out of scope.

export const INVENTORY_CORE_FLAG_KEY = 'INVENTORY_CORE';

// The I4·posting ledger-accounting capability flag (design §18). Config-plane key
// (clientFlagActs, envFallback:()=>false) — NEVER an env pair. Stays DARK until
// P5–P7 land together; P5 wires the read. Named here as data so the writer and the
// capability-enablement flow reference one identifier.
export const INVENTORY_ACCOUNTING_FLAG_KEY = 'INVENTORY_ACCOUNTING';

export const INVENTORY_OPERATION_TYPES = Object.freeze([
  'opening_balance',
  'receipt',
  'shipment',
  'count_correction',
  'quarantine',
  'release_quarantine',
  'owner_private_use',
  'reversal'
]);

export const INVENTORY_REFUSAL_REASONS = Object.freeze([
  'flag_disabled',
  'invalid_command',
  'invalid_money',
  'invalid_quantity',
  'unknown_item',
  'unknown_location',
  'undefined_uom_conversion',
  'negative_stock_unauthorised',
  'idempotency_conflict',
  'duplicate_open_count_session',
  'invalid_state_transition',
  'not_found',
  'alias_limit_exceeded',
  'exact_match_precedes_alias',
  'unbounded_read_refused',
  'audit_required',
  'db_error',
  'over_reservation',
  'over_allocation',
  'ship_exceeds_allocation',
  'commitment_not_found',
  'invalid_reversal',
  'reversal_requires_commitment_resolution',
  'stale_reversal'
]);

export const INVENTORY_ANOMALY_TYPES = Object.freeze([
  'negative_observed_count',
  'count_variance',
  'over_receipt',
  'short_receipt',
  'expired_reservation',
  'below_reorder',
  'stale_count',
  'overdue_purchase_order'
]);

export const PURCHASE_ORDER_STATES = Object.freeze([
  'proposal',
  'approved',
  'ordered',
  'acknowledged',
  'partially_received',
  'fully_received',
  'cancelled'
]);

export const SALES_ORDER_STATES = Object.freeze([
  'order',
  'reserved',
  'allocated',
  'picked',
  'partially_shipped',
  'shipped',
  'backordered',
  'cancelled'
]);

export const RESERVATION_STATES = Object.freeze(['active', 'expired', 'released', 'fulfilled']);
export const ALLOCATION_STATES = Object.freeze(['active', 'picked', 'shipped', 'released']);
export const BACKORDER_STATES = Object.freeze(['open', 'partially_filled', 'filled', 'cancelled']);
export const COUNT_SESSION_STATES = Object.freeze(['open', 'closed', 'cancelled']);
export const ALIAS_STATUSES = Object.freeze(['active', 'dismissed']);
export const ALIAS_SOURCES = Object.freeze(['correction', 'manual']);
export const AVAILABILITY_STATES = Object.freeze([
  'on_hand',
  'reserved',
  'allocated',
  'quarantined',
  'available',
  'inbound',
  'backordered'
]);

export const MAX_ALIAS_PER_ITEM = 25;
export const DEFAULT_PAGE_LIMIT = 100;
export const MAX_PAGE_LIMIT = 500;
