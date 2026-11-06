-- Async document parsing — schema scaffold (PR 1 of 4).
--
-- See docs/async-parsing-plan.md for the full design. This migration only
-- lands the columns, constraints, and indexes. Behaviour is unchanged:
-- /documents/sync continues to write parse_status='completed' inline, so
-- every existing and newly synced doc reads as fully parsed.
--
-- Backfill assumption: every documents row that exists today was parsed
-- synchronously by the legacy /documents/sync path, so backfilling to
-- 'completed' is safe and accurate.

-- Lifecycle status. Added nullable first so the backfill can run before
-- the NOT NULL + DEFAULT 'pending' tightens the column. Post-async, any
-- new insert that forgets to set the column must NOT silently become
-- 'completed'; the legacy /documents/sync endpoint sets it explicitly.
alter table documents
  add column if not exists parse_status text;

update documents
set parse_status = 'completed'
where parse_status is null;

alter table documents
  alter column parse_status set not null,
  alter column parse_status set default 'pending';

alter table documents
  drop constraint if exists documents_parse_status_valid;

alter table documents
  add constraint documents_parse_status_valid check (parse_status in (
    'pending', 'processing', 'completed', 'failed', 'skipped', 'duplicate_pending'
  ));

-- Run lifecycle, progress, error, summary.
alter table documents
  add column if not exists parse_run_id uuid,
  add column if not exists parse_attempts int not null default 0,
  add column if not exists parse_enqueued_at timestamptz,
  add column if not exists parse_event_sent_at timestamptz,
  add column if not exists parse_started_at timestamptz,
  add column if not exists parse_heartbeat_at timestamptz,
  add column if not exists parse_completed_at timestamptz,
  add column if not exists parse_stage text,
  add column if not exists parse_progress_current int,
  add column if not exists parse_progress_total int,
  add column if not exists parse_error jsonb,
  add column if not exists parse_summary jsonb;

alter table documents
  drop constraint if exists documents_parse_stage_valid;

alter table documents
  add constraint documents_parse_stage_valid check (
    parse_stage is null
    or parse_stage in ('fetching', 'extracting', 'writing', 'enriching', 'finalizing')
  );

alter table documents
  drop constraint if exists documents_parse_progress_valid;

alter table documents
  add constraint documents_parse_progress_valid check (
    parse_progress_current is null
    or parse_progress_total is null
    or (
      parse_progress_current >= 0
      and parse_progress_total > 0
      and parse_progress_current <= parse_progress_total
    )
  );

-- Storage location, duplicates, idempotency.
-- duplicate_of is a logical reference (no FK) because resolver semantics
-- handle delete behaviour explicitly. text matches the documents.id type
-- used throughout the schema.
-- account_fingerprint = hash(bank_name_normalized || iban_last4 || currency);
-- used by post-extraction duplicate detection for bank statements.
-- checksum_sha256 = byte-level hash of the uploaded file; used by
-- /register byte-match duplicate detection in PR 2.
alter table documents
  add column if not exists storage_bucket text,
  add column if not exists storage_object_key text,
  add column if not exists checksum_sha256 text,
  add column if not exists duplicate_of text,
  add column if not exists account_fingerprint text;

-- Dashboard / console queries for in-flight, failed, or duplicate-pending docs.
create index if not exists documents_firm_client_parse_status_idx
  on documents (firm_id, client_id, parse_status)
  where parse_status in ('pending', 'processing', 'failed', 'duplicate_pending');

-- /register idempotency lookup (re-PUT of the same storage object should
-- return the existing row, not create a phantom duplicate).
create unique index if not exists documents_storage_object_unique
  on documents (firm_id, client_id, storage_object_key)
  where storage_object_key is not null;

-- Byte-hash duplicate lookup at /register.
create index if not exists documents_firm_client_checksum_idx
  on documents (firm_id, client_id, checksum_sha256)
  where checksum_sha256 is not null;

-- Statement period-overlap duplicate lookup at parse-complete.
create index if not exists documents_firm_client_account_idx
  on documents (firm_id, client_id, account_fingerprint)
  where account_fingerprint is not null;

-- Stuck-job cron.
create index if not exists documents_processing_heartbeat_idx
  on documents (parse_heartbeat_at)
  where parse_status = 'processing';

-- Duplicate resolver navigation.
create index if not exists documents_duplicate_of_idx
  on documents (duplicate_of)
  where duplicate_of is not null;

-- Outbox sweeper.
create index if not exists documents_pending_outbox_idx
  on documents (parse_enqueued_at)
  where parse_status = 'pending' and parse_event_sent_at is null;
