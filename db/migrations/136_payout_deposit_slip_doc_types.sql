-- Add `payout_statement` and `deposit_slip` to the documents.document_type
-- CHECK vocabulary (RT-18, docs/plan-2026-09-01-runtime-refactor-slices.md;
-- audit F-04 part 2 / F-23). Same idempotent rebuild shape as migrations
-- 021 and 023 — drop the prior CHECK, rebuild the allowed-list as
-- (existing distinct types ∪ hardcoded code vocabulary), VALIDATE it.
--
-- Why two new types. A `payout_statement` is a processor / POS /
-- delivery-platform settlement report: gross customer sales, refunds and
-- fees deducted, ONE net amount transferred to the firm's bank account,
-- with a payout reference and a settlement period. A `deposit_slip` is a
-- cash / cheque deposit at a branch, counter or ATM: the components
-- deposited and one total that lands as a money_in bank line. Both are
-- the firm's own revenue arriving — direction incoming — and neither was a
-- document family before this migration: the router classified payouts as
-- payment_confirmation/ar (issued_receipt) or, for filenames the FE regex
-- missed, left them `unknown`, so the generic extractor invented totals
-- (Deliveroo 308 vs 2,150) and no matcher family read them (Desert Rose:
-- 26 of 41 documents typed unknown, ~28 redundant owner asks, revenue
-- booked net). Naming the family lets the perception layer read the
-- settlement breakdown honestly and lets the payout matcher match the NET
-- against the money_in line.
--
-- Same DO-block shape as 023. Idempotent — every step is `if exists` /
-- `drop … if exists` / a CHECK rebuild that survives any superset of
-- already-allowed values.

do $$
declare
  existing_types text[];
  code_vocabulary constant text[] := array[
    'bank_statement',
    'chart_of_accounts',
    'contract',
    'deposit_slip',
    'financing',
    'issued_receipt',
    'payment_account_statement',
    'payment_confirmation',
    'payout_statement',
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
    'documents.document_type pre-136 distinct values: %',
    existing_types;

  select array_agg(distinct t)
    into allowed_types
    from unnest(existing_types || code_vocabulary) as t
   where t is not null;

  raise notice
    'documents.document_type post-136 CHECK allowed values: %',
    allowed_types;

  execute 'alter table documents drop constraint if exists documents_document_type_valid';

  constraint_sql := format(
    'alter table documents add constraint documents_document_type_valid check (document_type = any(%L::text[])) not valid',
    allowed_types
  );
  execute constraint_sql;

  execute 'alter table documents validate constraint documents_document_type_valid';
end $$;
