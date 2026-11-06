-- Phase 8e: Contract obligations table.
-- Stores structured obligation records extracted from contract documents.
-- Each obligation represents an expected future financial event (payment,
-- deposit, fee, etc.) derived from the contract terms — NOT an actual
-- posted transaction.

create table if not exists document_obligations (
  id text primary key,
  firm_id text not null references firms(id) on delete cascade,
  client_id text not null references clients(id) on delete cascade,
  document_id text not null references documents(id) on delete cascade,

  obligation_type text not null,
  payer text,
  payee text,
  payer_role text,
  payee_role text,

  amount numeric(14, 2),
  currency text,

  frequency text,
  start_date date,
  end_date date,
  due_day int check (due_day is null or (due_day >= 1 and due_day <= 31)),

  escalation_clause text,
  tax_clause text,

  confidence numeric(4, 2),
  source_evidence jsonb default '{}'::jsonb,

  payload jsonb not null default '{}'::jsonb,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists document_obligations_firm_client_doc_idx
  on document_obligations (firm_id, client_id, document_id);
create index if not exists document_obligations_dates_idx
  on document_obligations (start_date, end_date)
  where end_date is not null;
