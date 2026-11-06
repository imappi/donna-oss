-- 098: structured bank-line payment reference (G12 — outbound-actions plan,
-- approved lane: post-parse enricher, Kari 2026-07-24).
--
-- Bank lines carry a payment reference only as free text (description /
-- raw_description / payload.source_line), so all reference matching for
-- issued-invoice settlement is substring-based. This migration gives the
-- validated reference a SCHEME-NEUTRAL structured home:
--
--   structured_reference            the captured, scheme-validated reference
--                                   (FI: viitenumero check digit) — written
--                                   ONLY by the outbound/referenceCapture.js
--                                   sweep on an unambiguous single-candidate
--                                   hit; never guessed, never backfilled from
--                                   a substring match.
--   structured_reference_checked_at sweep idempotence marker: stamped when a
--                                   line has been examined (captured or not),
--                                   so no line is rescanned. Null = not yet
--                                   examined. A future smarter capture pass
--                                   may null it to re-examine.
--
-- The columns are country-agnostic; WHICH validator applies is pack data
-- (packs/<cc> reference.scheme) resolved by the capture module's scheme
-- registry. A pack with scheme 'none' (the US) never writes here — the sweep
-- exits before touching this table (America-first: zero US behavior change).
--
-- Additive only; no existing column or row is touched. Consumers degrade
-- gracefully pre-migration (readers treat the column as absent; the capture
-- sweep soft-skips on 42703).

alter table transactions add column if not exists structured_reference text;
alter table transactions add column if not exists structured_reference_checked_at timestamptz;

-- The sweep's work queue: unexamined money-in lines per client.
create index if not exists idx_transactions_reference_capture
  on transactions (firm_id, client_id)
  where structured_reference_checked_at is null and money_in > 0;

-- Reference lookups (settlement reads per client; future AR surfaces).
create index if not exists idx_transactions_structured_reference
  on transactions (firm_id, client_id, structured_reference)
  where structured_reference is not null;
