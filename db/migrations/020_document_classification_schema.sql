-- Document classification schema — PR 2 of the classifier work.
--
-- Three concerns, one migration:
--
--   1. Client identity for direction inference. `clients.legal_names`
--      stores the canonical legal name + trading names / aliases so
--      the document router can tell "the firm paid X" from "X paid
--      the firm." Convention: legal_names[1] is canonical, the rest
--      are trading names or aliases. `company_name` stays as the UI
--      display name.
--
--   2. Direction column on documents. `documents.direction` carries
--      the AP/AR/internal classification once the router (or a
--      backfill from existing document_type) lands. Decouples the
--      semantic axis from the type vocabulary — a contract has no
--      direction; a receipt and a supplier_bill have the same
--      direction; future types don't force every matcher to grow an
--      IN-list.
--
--   3. CHECK constraint on document_type. Closes the door on typo'd
--      free-text values arriving via the upload API or the router.
--      The migration introspects the existing data before building
--      the allowed-list so it never rejects a row that's already in
--      production. The new type `issued_receipt` is added
--      unconditionally — that's the new vocabulary this PR
--      introduces (a receipt the firm ISSUED, AR direction, lands in
--      the sales_invoice matcher pipeline).
--
-- Re-run safety: every alter is `if not exists` / `if exists` and the
-- backfills are scoped to default values, so this migration is
-- idempotent.

-- ── 1. clients.legal_names ───────────────────────────────────────────

alter table clients
  add column if not exists legal_names text[] not null default '{}'::text[];

-- Seed canonical legal_name from company_name for clients that haven't
-- been touched yet. Doesn't overwrite rows where a real legal_names
-- array is already present — keeps the script idempotent.
update clients
set legal_names = array[company_name]
where (legal_names is null or legal_names = '{}'::text[])
  and company_name is not null
  and company_name <> '';

-- ── 2. documents.direction ───────────────────────────────────────────

alter table documents
  add column if not exists direction text not null default 'unknown';

alter table documents
  drop constraint if exists documents_direction_valid;

alter table documents
  add constraint documents_direction_valid check (
    direction in ('incoming', 'outgoing', 'internal', 'unknown')
  );

-- Backfill direction from current document_type. WHERE clause limits
-- to rows still on the default so a future writer that explicitly
-- sets direction to e.g. 'incoming' on an upload won't get overwritten
-- by a re-run.
update documents
set direction = case
  when document_type in ('receipt', 'supplier_bill') then 'outgoing'
  when document_type in ('sales_invoice', 'issued_receipt') then 'incoming'
  when document_type = 'bank_statement' then 'internal'
  else 'unknown'
end
where direction = 'unknown';

-- ── 3. documents.document_type CHECK constraint ──────────────────────
--
-- Built dynamically so the union of (existing distinct values) +
-- {issued_receipt} survives the migration regardless of what the
-- production data zoo looks like. RAISE NOTICE prints the discovered
-- list so the deploy log carries the artifact.

do $$
declare
  existing_types text[];
  allowed_types text[];
  constraint_sql text;
begin
  select coalesce(array_agg(distinct document_type), array[]::text[])
    into existing_types
    from documents
   where document_type is not null;

  raise notice
    'documents.document_type pre-migration distinct values: %',
    existing_types;

  -- Union with the known new types this PR introduces. ARRAY DISTINCT
  -- via a subquery — Postgres doesn't have a native array-distinct
  -- operator.
  select array_agg(distinct t)
    into allowed_types
    from unnest(
      existing_types || array['issued_receipt', 'unknown']::text[]
    ) as t
   where t is not null;

  raise notice
    'documents.document_type CHECK allowed values: %',
    allowed_types;

  execute 'alter table documents drop constraint if exists documents_document_type_valid';

  constraint_sql := format(
    'alter table documents add constraint documents_document_type_valid check (document_type = any(%L::text[])) not valid',
    allowed_types
  );
  execute constraint_sql;

  -- Validate now — every existing row is in `allowed_types` by
  -- construction, so VALIDATE is a fast pass.
  execute 'alter table documents validate constraint documents_document_type_valid';
end $$;

-- ── 4. Index for matcher routing on direction ────────────────────────
-- Lets the AR/AP matchers' candidate SELECTs filter by direction
-- without a sequential scan once the matchers start consulting it.
create index if not exists documents_firm_client_direction_idx
  on documents (firm_id, client_id, direction)
  where direction in ('incoming', 'outgoing');
