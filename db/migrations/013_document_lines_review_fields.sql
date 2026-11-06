-- PR 2 of docs/invoice-receipt-parsing-plan.md. The `document_lines`
-- table (from 002_transaction_intelligence.sql) is missing first-class
-- fields for the review/coding workflow. Burying them in `payload`
-- makes the review UI and audit trail harder, and PR 3's re-parse
-- merge needs `fingerprint` as a queryable column.

alter table document_lines
  add column if not exists line_no int,
  add column if not exists fingerprint text,
  add column if not exists coding_confidence numeric(4, 2),
  add column if not exists coding_source text,
  add column if not exists review_status text not null default 'needs_review';

create index if not exists document_lines_firm_client_review_idx
  on document_lines (firm_id, client_id, review_status);
create index if not exists document_lines_document_fingerprint_idx
  on document_lines (document_id, fingerprint);
