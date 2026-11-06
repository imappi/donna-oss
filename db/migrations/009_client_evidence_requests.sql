create table if not exists client_evidence_requests (
  id text primary key,
  firm_id text not null references firms(id) on delete cascade,
  client_id text not null references clients(id) on delete cascade,
  transaction_id text references transactions(id) on delete set null,
  review_item_id text references transaction_review_queue(id) on delete set null,
  status text not null default 'open'
    check (status in ('draft', 'open', 'replied', 'resolved', 'cancelled')),
  evidence_type text not null default 'supporting_document',
  question text not null,
  request_payload jsonb not null default '{}'::jsonb,
  response_payload jsonb not null default '{}'::jsonb,
  first_sent_at timestamptz,
  last_sent_at timestamptz,
  send_count integer not null default 0,
  due_at timestamptz,
  responded_at timestamptz,
  resolved_at timestamptz,
  created_by text,
  resolved_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists client_evidence_requests_firm_client_status_idx
  on client_evidence_requests(firm_id, client_id, status);

create index if not exists client_evidence_requests_transaction_idx
  on client_evidence_requests(firm_id, transaction_id, status);

create index if not exists client_evidence_requests_review_item_idx
  on client_evidence_requests(firm_id, review_item_id, status);
