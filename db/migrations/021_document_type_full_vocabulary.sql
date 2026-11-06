-- Widen the documents.document_type CHECK to cover the full code
-- vocabulary, not just the values that happened to be in the table when
-- migration 020 ran.
--
-- Migration 020 built the allowed-list dynamically from
-- `SELECT DISTINCT document_type FROM documents ∪ {issued_receipt,
-- unknown}`. That was safe for everything already in the live data, but
-- it omitted every legitimate code value that hadn't been emitted yet:
-- `contract`, `payroll_cpf`, `financing`, `xero_setup`,
-- `chart_of_accounts`, `statutory_record`, `payment_confirmation`.
-- The FE classifier (`classifyDocumentFile` at src/lib/firmDocuments.js)
-- routinely stamps these at upload time, so the very next non-financial
-- upload from a client other than Alex would 500 on INSERT.
--
-- The fix is to union the same dynamic-discovery set with the FULL
-- hardcoded code vocabulary. Discovery keeps us safe if a future code
-- path emits a type we forgot to list here; the hardcoded list keeps us
-- safe against the inverse — a legitimate code output that hasn't
-- landed in the table yet.
--
-- Same DO-block shape as 020. Idempotent — every step is `if exists` /
-- `drop … if exists` / a CHECK rebuild that survives any superset of
-- already-allowed values.

do $$
declare
  existing_types text[];
  code_vocabulary constant text[] := array[
    'bank_statement',
    'chart_of_accounts',
    'contract',
    'financing',
    'issued_receipt',
    'payment_confirmation',
    'payroll_cpf',
    'receipt',
    'sales_invoice',
    'statutory_record',
    'supplier_bill',
    'unknown',
    'xero_setup'
  ];
  allowed_types text[];
  constraint_sql text;
begin
  select coalesce(array_agg(distinct document_type), array[]::text[])
    into existing_types
    from documents
   where document_type is not null;

  raise notice
    'documents.document_type pre-021 distinct values: %',
    existing_types;

  -- Union existing-distinct with the hardcoded code vocabulary. The
  -- existing-distinct half is a safety net for any value that's already
  -- in production but absent from the hardcoded list (shouldn't happen
  -- after this migration ships, but cheap insurance against future
  -- drift).
  select array_agg(distinct t)
    into allowed_types
    from unnest(existing_types || code_vocabulary) as t
   where t is not null;

  raise notice
    'documents.document_type post-021 CHECK allowed values: %',
    allowed_types;

  execute 'alter table documents drop constraint if exists documents_document_type_valid';

  constraint_sql := format(
    'alter table documents add constraint documents_document_type_valid check (document_type = any(%L::text[])) not valid',
    allowed_types
  );
  execute constraint_sql;

  -- VALIDATE is a fast pass: every existing row's document_type is in
  -- `existing_types`, which is a subset of `allowed_types` by
  -- construction.
  execute 'alter table documents validate constraint documents_document_type_valid';
end $$;
