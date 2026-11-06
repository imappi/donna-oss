-- 069 — Finland FI-15 G-8: credit notes (hyvityslasku) on issued invoices. ADDITIVE.
--
-- A credit note IS an issued_invoices row (D-G8-1,
-- docs/design-donna-finland-fi15-g8-credit-notes.md): same per-client sequential
-- numbering series, same closed three-state lifecycle, same conversation
-- machinery. This migration only teaches the table which rows are credit notes
-- and which original invoice each one credits.
--
-- kind is a closed CHECK enum; existing rows default to 'invoice' untouched.
-- credits_invoice_id self-references the ORIGINAL issued invoice (kind
-- 'invoice', status 'issued' — enforced by the writers; the credit cap
-- (sum of issued credits <= original total) is re-checked inside the draft
-- transaction, D-G8-3). Payment/credited state is NEVER stored — it computes
-- at read time (D-G8-6), so no further columns.

alter table issued_invoices add column if not exists kind text not null default 'invoice'
  check (kind in ('invoice', 'credit_note'));

alter table issued_invoices add column if not exists credits_invoice_id text
  references issued_invoices(id) on delete restrict;

-- Fast "credits of this original" lookups (cap checks + the settlement read).
create index if not exists issued_invoices_credits_idx
  on issued_invoices(firm_id, client_id, credits_invoice_id)
  where credits_invoice_id is not null;
