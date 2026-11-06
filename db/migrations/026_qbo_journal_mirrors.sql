-- QuickBooks Online journal-mirror tracking (Phase 2.1c: ledger writeback).
--
-- Writeback mirrors a posted Donna ledger_journal (double-entry) to a QBO
-- JournalEntry, line-for-line. This table is the per-journal mirror ledger AND
-- the idempotency guard: QBO has no Idempotency-Key header (unlike Xero), so the
-- unique (connection_id, journal_id) row — storing the returned JournalEntry Id
-- + SyncToken — is what makes a re-sync an UPDATE (sparse:false, Id+SyncToken)
-- rather than a duplicate create.
--
-- source_type / source_id are denormalised from the journal so retry/verify can
-- filter by the originating transaction without joining ledger_journals.
create table if not exists qbo_journal_mirrors (
  id text primary key,
  connection_id text references qbo_connections(id) on delete cascade,
  firm_id text not null references firms(id) on delete cascade,
  client_id text not null references clients(id) on delete cascade,
  journal_id text not null references ledger_journals(id) on delete cascade,
  qbo_journal_entry_id text,
  sync_token text,
  doc_number text,
  status text not null default 'running' check (status in ('running', 'synced', 'error', 'stale')),
  source_type text,
  source_id text,
  posted_at timestamptz,
  verified_at timestamptz,
  last_error text,
  request_payload jsonb not null default '{}'::jsonb,
  response_payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (connection_id, journal_id)
);

create index if not exists qbo_journal_mirrors_firm_client_status_idx on qbo_journal_mirrors(firm_id, client_id, status);
create index if not exists qbo_journal_mirrors_source_idx on qbo_journal_mirrors(firm_id, client_id, source_type, source_id);
create index if not exists qbo_journal_mirrors_journal_idx on qbo_journal_mirrors(journal_id);
