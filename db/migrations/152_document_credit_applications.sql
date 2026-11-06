-- RT-27 — credit notes in the AR matcher's context (2026-09-12).
--
-- A customer credit note (documents.payment_status = 'credit_note', same
-- customer as the invoice) settles part of an invoice WITHOUT a bank line.
-- Before this table the tree had no home for "this credit reduced that
-- invoice by this much": the invoice's sum-based payment_status counted bank
-- matches only, so an invoice 2 008,00 − credit 376,50 = bank 1 631,50 rested
-- 'suggested' on every run and the credit note rested on the owner (the
-- Kampaamo Aroma line, orchestrator-12 §3).
--
-- One row per (credit note, invoice) APPLICATION at a stated amount — the
-- persisted answer to "exactly which credits were applied, to which invoice,
-- for what amount". The runtime validates identity, scope, currency, remaining
-- availability and linkage BEFORE it writes, under a FOR UPDATE lock on the
-- credit-note document row, so a repeated delivery or a concurrent settlement
-- cannot consume a credit twice: the partial unique index below admits one
-- live application per pair, and the credit's remaining availability is
-- re-read under the lock on every write.
--
-- 'reversed' keeps the history when a human rejects the settlement that
-- carried the application (the credit becomes available again); a reversed
-- row is never re-activated — a re-application inserts a fresh row.
--
-- This is NOT an accounting backend: no ledger row is written here. The
-- settlement journal stays the bank line's (the named posting writer), and an
-- uploaded credit note is never journaled on its own (the Finnish cash line
-- recognises revenue net of the credit — see the RT-27 handoff).

create table if not exists document_credit_applications (
  id text primary key,
  firm_id text not null references firms(id) on delete cascade,
  client_id text not null references clients(id) on delete cascade,
  credit_document_id text not null references documents(id) on delete cascade,
  invoice_document_id text not null references documents(id) on delete cascade,
  amount numeric(14, 2) not null,
  currency text,
  status text not null default 'applied',
  settlement_match_id text references reconciliation_matches(id) on delete set null,
  applied_by text not null default 'system',
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  reversed_at timestamptz,
  constraint document_credit_applications_amount_positive check (amount > 0),
  constraint document_credit_applications_status_valid check (status in ('applied', 'reversed')),
  constraint document_credit_applications_distinct_documents check (credit_document_id <> invoice_document_id)
);

-- One LIVE application per (credit note, invoice): the redelivery guard.
create unique index if not exists document_credit_applications_live_pair_uidx
  on document_credit_applications (credit_document_id, invoice_document_id)
  where status = 'applied';

create index if not exists document_credit_applications_invoice_idx
  on document_credit_applications (firm_id, invoice_document_id)
  where status = 'applied';

create index if not exists document_credit_applications_credit_idx
  on document_credit_applications (firm_id, credit_document_id)
  where status = 'applied';

create index if not exists document_credit_applications_match_idx
  on document_credit_applications (settlement_match_id)
  where settlement_match_id is not null;

-- ── RLS-native (the 085 posture) ─────────────────────────────────────────────
alter table document_credit_applications enable row level security;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on document_credit_applications from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on document_credit_applications from authenticated;
  end if;
end $$;
