-- Donna Inventory I4·posting — P3 persistence (design §11, D-POST-8/13/14).
--
-- The state THIS layer legitimately owns (INV-1 permits a new writer for genuinely
-- new state): the append-only posting-attempt event log, the rebuildable latest-basis
-- HEADS projection over it, the journal-group links, the many-to-many allocations, and
-- the valuation-allowance register. The LEDGER write itself still routes through the ONE
-- shared primitive via the P5 gateway — these tables are the audit/lifecycle spine
-- AROUND that write, never a second accounting backend.
--
-- Append-only (D-POST-8): inventory_posting_attempts rows are NEVER updated — a new
-- attempt SUPERSEDES a prior one (supersedes_attempt_id), and the absence of an
-- updated_at column is the signal. "Current state" is the inventory_posting_heads VIEW
-- (latest attempt per operation+kind), rebuildable purely from the log — never a source
-- of truth. Prior POSTED journals stay immutable history: a later delta at a new
-- posting_basis_version posts NEW journals and moves the HEAD, but never deactivates or
-- touches the earlier journals.
--
-- Uniqueness (D-POST-8 redline): exactly ONE successful application per
-- (operation_id, posting_kind, posting_basis_version) — enforced by a PARTIAL unique
-- index over the successful outcomes only; superseded / failed / refused attempts coexist
-- freely in the log. Value-neutral ops persist outcome='no_journal_required' (D-POST-14)
-- — a recorded terminal, never an untracked gap.
--
-- CHECK vocabularies (posting_kind / outcome / waiter_type / relationship / allowance
-- status) are pinned to server/donna/inventory/postingLog.js by migrations.test.js so
-- the column and the runtime can never drift. reason_code is deliberately NOT a CHECK
-- (the default-blocker doctrine — a new typed refusal must not need a migration).

-- ── 1. inventory_posting_attempts — the append-only event log ─────────────────
create table if not exists inventory_posting_attempts (
  id                    bigserial primary key,
  firm_id               text not null references firms(id) on delete cascade,
  client_id             text not null references clients(id) on delete cascade,
  -- Operations are referenced by their stable business/valuation identity (the kernel's
  -- operation_id), NOT the physical inventory_operations surrogate PK — the posting log
  -- is decoupled from that table's key. Not a FK for that reason.
  operation_id          text not null,
  posting_kind          text not null check (posting_kind in (
                          'receipt','matched_supplier_bill','landed_cost','shipment_cogs',
                          'customer_return','supplier_return','count_adjustment','write_down',
                          'reversal','private_use','value_neutral')),
  -- The monotonic valuation-basis version per (operation, kind). A backdated receipt,
  -- landed cost, or provisional→actual settlement bumps this; each version posts its own
  -- NEW delta journals and supersedes the prior HEAD (never mutates prior journals).
  posting_basis_version integer not null default 1,
  valuation_run_id      text not null,
  -- The dry-run proposal hash compared at execute (§9 step 4) — a stale proposal refuses.
  proposal_hash         text,
  outcome               text not null check (outcome in (
                          'posted','no_journal_required','proposed','refused',
                          'blocked_locked_period','integration_wait','superseded','incident')),
  -- Typed refusal / blocker reason — NOT a CHECK (default-blocker doctrine).
  reason_code           text,
  -- Waiter routing (§12) — nullable: a successful terminal has no waiter.
  waiter_type           text check (waiter_type in (
                          'owner','accountant_operator','integration_system_retry',
                          'integration_operator','engineering_incident','product_compliance')),
  waiter_id             text,
  next_action           text,
  -- The executable retry schedule for a non-human waiter (§12 D-POST-14).
  retry_after           timestamptz,
  -- Groups a reversal + its downstream delta journals (§5-G) — links the journals table.
  journal_group_id      text,
  -- References to the canonical receipt + audit + authority grant (§13/§15). Nullable —
  -- a refused/blocked attempt may carry no receipt.
  apply_receipt_id      text references apply_receipts(id) on delete set null,
  audit_event_id        bigint references audit_events(id) on delete set null,
  authority_grant_id    text,
  actor_id              text not null,
  created_at            timestamptz not null default now(),
  supersedes_attempt_id bigint references inventory_posting_attempts(id) on delete set null
);

-- Exactly one SUCCESSFUL APPLICATION per (operation, kind, basis_version). Partial over
-- the successful outcomes only — superseded/failed/refused rows are unconstrained.
create unique index if not exists inventory_posting_attempts_success_idx
  on inventory_posting_attempts (operation_id, posting_kind, posting_basis_version)
  where outcome in ('posted','no_journal_required');

create index if not exists inventory_posting_attempts_head_idx
  on inventory_posting_attempts (firm_id, client_id, operation_id, posting_kind, created_at desc, id desc);
create index if not exists inventory_posting_attempts_waiter_idx
  on inventory_posting_attempts (firm_id, client_id, waiter_type, retry_after)
  where waiter_type is not null;
create index if not exists inventory_posting_attempts_group_idx
  on inventory_posting_attempts (journal_group_id);

-- ── 2. inventory_posting_heads — the rebuildable latest-basis projection ───────
-- A plain VIEW (always live, never a stored source of truth): the latest attempt per
-- (firm, client, operation, posting_kind). Supersede chains point forward, so the newest
-- row IS the head. Rebuildable purely from the append-only log (D-POST-8).
create or replace view inventory_posting_heads as
select distinct on (firm_id, client_id, operation_id, posting_kind)
  id as attempt_id, firm_id, client_id, operation_id, posting_kind, posting_basis_version,
  valuation_run_id, outcome, reason_code, waiter_type, waiter_id, next_action, retry_after,
  journal_group_id, apply_receipt_id, audit_event_id, authority_grant_id, actor_id, created_at
from inventory_posting_attempts
order by firm_id, client_id, operation_id, posting_kind, created_at desc, id desc;

-- ── 3. inventory_posting_journals — attempt ↔ ledger-journal group links ───────
-- One attempt ↔ many journals (reversal groups, delta adjustments); one journal ↔ many
-- operations (later batches). The LEDGER journal is written through the P5 gateway; this
-- only records the linkage + its role in the group.
create table if not exists inventory_posting_journals (
  id                 bigserial primary key,
  firm_id            text not null references firms(id) on delete cascade,
  client_id          text not null references clients(id) on delete cascade,
  posting_attempt_id bigint not null references inventory_posting_attempts(id) on delete cascade,
  ledger_journal_id  text not null references ledger_journals(id) on delete cascade,
  relationship       text not null check (relationship in ('primary','reversal','delta_adjustment')),
  journal_group_id   text,
  created_at         timestamptz not null default now(),
  unique (posting_attempt_id, ledger_journal_id)
);

create index if not exists inventory_posting_journals_journal_idx
  on inventory_posting_journals (ledger_journal_id);

-- ── 4. inventory_journal_allocations — the many-to-many traceability spine ─────
-- N receipts ↔ M bills ↔ K journal lines (§3/§7), each link carrying its allocated
-- amount + quantity and the valuation_run_id that priced it. Required from v1 for partial
-- receipt↔bill matches and one-bill-many-receipts (not only for later batching).
create table if not exists inventory_journal_allocations (
  id                 bigserial primary key,
  firm_id            text not null references firms(id) on delete cascade,
  client_id          text not null references clients(id) on delete cascade,
  operation_id       text not null,
  ledger_journal_id  text not null references ledger_journals(id) on delete cascade,
  ledger_line_id     text references ledger_lines(id) on delete cascade,
  posting_attempt_id bigint references inventory_posting_attempts(id) on delete cascade,
  allocated_amount   numeric(24, 8) not null,
  allocated_currency char(3) not null,
  allocated_quantity numeric(24, 8),
  valuation_run_id   text not null,
  created_at         timestamptz not null default now()
);

create index if not exists inventory_journal_allocations_operation_idx
  on inventory_journal_allocations (firm_id, client_id, operation_id);
create index if not exists inventory_journal_allocations_journal_idx
  on inventory_journal_allocations (ledger_journal_id);

-- ── 5. inventory_valuation_allowances — the write-down allowance register ──────
-- Each write-down is an allowance LOT bound to specific SKU/group stock (§5-F). Carries
-- the NRV evidence + reviewer (§14), the maximum reversible amount (market-recovery cap,
-- IAS 2), and the consumed amount — the allowance is RELEASED/CONSUMED on derecognition
-- (§5-F redline), so it never strands against stock that has left inventory. The §16
-- allowance-integrity reconciliation asserts the balance ties only to still-on-hand
-- written-down stock. Not append-only: consumed_amount/status move over the lot's life
-- (a register), while the attempts log records each mutating event.
create table if not exists inventory_valuation_allowances (
  id                    bigserial primary key,
  firm_id               text not null references firms(id) on delete cascade,
  client_id             text not null references clients(id) on delete cascade,
  -- Scope: an item (SKU) OR a tightly-related product group — never the whole pool (§5-F).
  scope_item_id         text,
  scope_group           text,
  valuation_date        date not null,
  allowance_amount      numeric(24, 8) not null,
  currency              char(3) not null,
  -- The market-recovery reversal cap (≤ original write-down). Consumption on
  -- derecognition is separate and NOT subject to this cap (§5-F).
  max_reversible_amount numeric(24, 8) not null,
  consumed_amount       numeric(24, 8) not null default 0,
  status                text not null default 'active'
                          check (status in ('active','released','reversed')),
  nrv_evidence          jsonb not null default '{}'::jsonb,
  reviewer              text not null,
  posting_attempt_id    bigint references inventory_posting_attempts(id) on delete set null,
  valuation_run_id      text,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  check (consumed_amount >= 0 and consumed_amount <= allowance_amount),
  check (max_reversible_amount >= 0 and max_reversible_amount <= allowance_amount),
  check (scope_item_id is not null or scope_group is not null)
);

create index if not exists inventory_valuation_allowances_scope_idx
  on inventory_valuation_allowances (firm_id, client_id, scope_item_id, status);
