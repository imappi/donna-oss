-- 065 — Finland FI-10: issued-invoice lifecycle (issuance UX). ADDITIVE.
--
-- First-class persistence for invoices Donna issues from the owner's WhatsApp
-- instruction ("laskuta …"). The lifecycle is a CLOSED enum whose resting states
-- obey two-terminal-states:
--   • draft_pending_confirmation — ON THE OWNER: an open invoice_issuance ask
--     (client_evidence_requests) always accompanies it;
--   • issued — terminal-with-receipt: transmit receipt + AR journal id (or the
--     recorded cash-basis skip) + authority basis + audit event;
--   • cancelled — terminal-with-receipt: the owner's explicit negative (or a
--     superseding draft), audited.
-- No transient state is persistable. Design: docs/design-donna-finland-fi10-issuance-ux.md.
--
-- Invoice numbers are per-client sequential via issued_invoice_counters, allocated
-- atomically (insert … on conflict … do update … returning) inside the draft
-- transaction. Cancelled drafts may leave numbering gaps — normal business
-- practice; the gap-free statutory chain is the tosite number (migration 064),
-- not the invoice number.

create table if not exists issued_invoices (
  id text primary key,
  firm_id text not null references firms(id) on delete cascade,
  client_id text not null references clients(id) on delete cascade,
  invoice_number integer not null,
  status text not null default 'draft_pending_confirmation'
    check (status in ('draft_pending_confirmation', 'issued', 'cancelled')),
  -- The persisted draft verdict: the buildInvoice result + the finvoice/envelope
  -- inputs + the intake model id. The confirm summary renders THIS (render-the-
  -- persisted-verdict); the owner's "kyllä" acts on THIS, never a re-inference.
  draft jsonb not null default '{}'::jsonb,
  buyer_name text,
  buyer_email text,
  -- Issue receipts (null until issued):
  ar_journal_id text,
  cash_basis_skip boolean not null default false,
  transmit_receipt jsonb,
  authority_basis jsonb,
  issued_at timestamptz,
  cancelled_at timestamptz,
  cancel_reason text,
  created_by text,
  issued_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (firm_id, client_id, invoice_number)
);

create index if not exists issued_invoices_client_status_idx
  on issued_invoices(firm_id, client_id, status);

create table if not exists issued_invoice_counters (
  firm_id text not null references firms(id) on delete cascade,
  client_id text not null references clients(id) on delete cascade,
  next_invoice_no integer not null default 1,
  primary key (firm_id, client_id)
);
