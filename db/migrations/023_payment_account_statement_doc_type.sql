-- Add `payment_account_statement` to documents.document_type CHECK
-- vocabulary. Same idempotent rebuild shape as migration 021 — drop the
-- prior CHECK, rebuild the allowed-list as
-- (existing distinct types ∪ hardcoded code vocabulary), VALIDATE it.
--
-- Why a new type. A `payment_account_statement` is an aggregating
-- artifact from a payment-account provider (credit/charge cards like
-- Amex, payment platforms like Stripe / PayPal, fuel cards, expense
-- platforms). The pattern is "many underlying merchant charges +
-- one settlement payment from a bank account." Today these were being
-- mis-routed to `supplier_bill` with vendor=<provider>, which is a
-- bookkeeping lie: the firm did not buy a service from Amex. The
-- statement is settled by a single ACH off the bank account; the
-- underlying merchant charges are separately codable expenses.
-- Promoting the type lets the perception layer (router + extractor)
-- name the artifact honestly and lets the matcher (Stage 2) match the
-- statement total against the settlement ACH instead of looking for a
-- bill-shaped one-to-one.
--
-- Same DO-block shape as 021. Idempotent — every step is `if exists` /
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
    'payment_account_statement',
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
    'documents.document_type pre-023 distinct values: %',
    existing_types;

  select array_agg(distinct t)
    into allowed_types
    from unnest(existing_types || code_vocabulary) as t
   where t is not null;

  raise notice
    'documents.document_type post-023 CHECK allowed values: %',
    allowed_types;

  execute 'alter table documents drop constraint if exists documents_document_type_valid';

  constraint_sql := format(
    'alter table documents add constraint documents_document_type_valid check (document_type = any(%L::text[])) not valid',
    allowed_types
  );
  execute constraint_sql;

  execute 'alter table documents validate constraint documents_document_type_valid';
end $$;
