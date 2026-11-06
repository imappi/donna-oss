-- Donna Inventory I4·posting — P6c: FX retranslation of open GRNI at close (design §10/§16).
--
-- Open foreign-currency GRNI is a MONETARY liability (IAS 21): at period-end its functional-
-- currency carrying value is retranslated from the rate it was booked at to the CLOSING rate, and
-- the unrealized FX movement on the still-open liability posts to the FX gain/loss line. P6a built
-- the read-side §16 GRNI engine that COMPUTES the retranslation delta and surfaces it as an
-- `obligation`; P6c builds the WRITE side — the retranslation POST routed through the P5 executor/
-- gateway (DR/CR liability.grni vs expense.fx), recorded as its own attempt + journal-group
-- delta_adjustment, never a new backend (INV-1).
--
-- One addition, additive and backward-compatible: the 'grni_retranslation' posting_kind. It POSTS
-- a journal through the P5 executor, so it is a first-class, queryable, audited posting kind (not a
-- mislabeled adjustment). The CHECK is pinned to postingLog.js INVENTORY_POSTING_KINDS by
-- migrations.test.js across 080 ∪ 081 ∪ this file, so the column and the runtime never drift.
--
-- No new columns: retranslation posts through the existing inventory_posting_attempts /
-- inventory_posting_journals / ledger_journals substrate. A missing close rate is NOT a schema
-- state — it is a bounded integration_system_retry waiter recorded on an attempt row (§10/§12),
-- so nothing new is persisted here beyond the kind vocabulary.

-- ── the 'grni_retranslation' posting_kind ─────────────────────────────────────
-- Recreate the posting_kind CHECK with the retranslation kind added. The constraint name is the
-- Postgres-default inline name from 080 (<table>_<column>_check); 081 already recreated it once
-- (adding 'allowance_release'). Drop-if-exists keeps this idempotent and re-runnable (migrations
-- are auto-discovered + re-applied); this file supersedes 081's recreation and must therefore
-- carry every prior kind plus the new one.
alter table inventory_posting_attempts drop constraint if exists inventory_posting_attempts_posting_kind_check;
alter table inventory_posting_attempts add  constraint inventory_posting_attempts_posting_kind_check
  check (posting_kind in (
    'receipt','matched_supplier_bill','landed_cost','shipment_cogs',
    'customer_return','supplier_return','count_adjustment','write_down',
    'reversal','private_use','value_neutral','allowance_release','grni_retranslation'));
