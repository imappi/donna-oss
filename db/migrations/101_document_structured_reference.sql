-- 101: structured payment reference for PARSED sales invoices (G12's
-- invoice-side sibling — outbound-actions plan; closes M3's named honest
-- line: a parsed FI sales invoice's documents.reference_number is the
-- INVOICE number, not the viite, so its chase rested on the owner as
-- missing_reference_number).
--
-- Mirrors 098 (the bank-line side) on documents:
--
--   structured_reference            the captured, scheme-validated payment
--                                   reference (FI: viitenumero check digit) —
--                                   written ONLY by the
--                                   outbound/referenceCapture.js document
--                                   sweep on an unambiguous single-candidate
--                                   hit from the parsed payload's reference
--                                   values; never guessed, never backfilled
--                                   from the invoice number.
--   structured_reference_checked_at sweep idempotence marker: stamped when a
--                                   document has been examined (captured or
--                                   not), so no document is rescanned. Null =
--                                   not yet examined. A future smarter
--                                   capture pass may null it to re-examine.
--
-- The columns are country-agnostic; WHICH validator applies is pack data
-- (packs/<cc> reference.scheme) resolved by the capture module's scheme
-- registry. A pack with scheme 'none' (the US) never writes here — the sweep
-- exits before touching this table (America-first: zero US behavior change).
--
-- Additive only; no existing column or row is touched. Consumers degrade
-- gracefully pre-migration (the receivable detector retries its reads without
-- the column on 42703; the capture sweep soft-skips).

alter table documents add column if not exists structured_reference text;
alter table documents add column if not exists structured_reference_checked_at timestamptz;

-- The sweep's work queue: unexamined parse-completed sales invoices per client.
create index if not exists idx_documents_reference_capture
  on documents (firm_id, client_id)
  where structured_reference_checked_at is null and document_type = 'sales_invoice';

-- Reference lookups (chase-mint coalesce reads per client; future AR surfaces).
create index if not exists idx_documents_structured_reference
  on documents (firm_id, client_id, structured_reference)
  where structured_reference is not null;
