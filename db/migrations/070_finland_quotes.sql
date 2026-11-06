-- 070 — Finland C-1: issued quotes (tarjous). ADDITIVE.
--
-- A quote is NOT an issued_invoices row (D-C1-1,
-- docs/design-donna-finland-c1-quote-send.md): it must not consume the
-- laskunumero series (FI-5 discipline — issued_invoice_counters is shared by
-- invoices and credit notes, and issued_invoices' unique(firm_id, client_id,
-- invoice_number) spans all kinds), it books nothing (no AR columns), and its
-- closed lifecycle is its own. Separate table + separate per-client counter.
--
-- Lifecycle (two-terminal-states):
--   • draft_pending_confirmation — ON THE OWNER: an open invoice_issuance ask
--     (quote phase) always accompanies it;
--   • sent — terminal-with-receipt: transmit receipt + authority basis + actor
--     + model id; the quote now rests with the CUSTOMER (acceptance/decline are
--     subsequent owner-initiated motions);
--   • converted — terminal-with-receipt: converted_invoice_id, flipped in the
--     converting invoice's issue transaction;
--   • declined / cancelled — terminal-with-receipt: the owner's explicit
--     negative (or a superseding draft), audited with reason.
-- Expiry is NEVER stored (valid_until is data; "expired" computes at read time).

create table if not exists issued_quotes (
  id text primary key,
  firm_id text not null references firms(id) on delete cascade,
  client_id text not null references clients(id) on delete cascade,
  quote_number integer not null,
  status text not null default 'draft_pending_confirmation'
    check (status in ('draft_pending_confirmation', 'sent', 'converted',
                      'declined', 'cancelled')),
  -- The persisted draft verdict: quote model + PDF projection inputs + the
  -- intake model id. The confirm summary renders THIS; the owner's "kyllä"
  -- acts on THIS, never a re-inference.
  draft jsonb not null default '{}'::jsonb,
  buyer_name text,
  buyer_email text,
  valid_until date,
  transmit_receipt jsonb,
  authority_basis jsonb,
  sent_at timestamptz,
  converted_invoice_id text references issued_invoices(id) on delete restrict,
  converted_at timestamptz,
  declined_at timestamptz,
  decline_reason text,
  cancelled_at timestamptz,
  cancel_reason text,
  created_by text,
  sent_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (firm_id, client_id, quote_number)
);

create index if not exists issued_quotes_client_status_idx
  on issued_quotes(firm_id, client_id, status);

create table if not exists issued_quote_counters (
  firm_id text not null references firms(id) on delete cascade,
  client_id text not null references clients(id) on delete cascade,
  next_quote_no integer not null default 1,
  primary key (firm_id, client_id)
);
