-- Per-close billing offer + one-off entitlement window (beta launch).
--
-- Migration 046 mirrored a flat monthly SUBSCRIPTION. The purchase flow now
-- sells one product priced PER CLOSE by volume band, bought as months the
-- customer picks: one_month / catch_up (one-off payments) or recurring (a
-- subscription). See src/lib/pricing.js (single source of truth) and CLAUDE.md
-- GOAL rail.
--
-- Two things 046 can't express:
--   1. A one-off payment (one_month / catch_up) has NO Stripe subscription, so
--      subscription_status stays null forever and the 046 gate would lock the
--      paying customer out. access_paid_through is the one-off entitlement cliff:
--      the gate treats the client as entitled while now() < access_paid_through.
--   2. Which band/kind the client bought, so the portal gate can re-price a
--      lapsed plan at the client's own band instead of a flat tier.
--
-- The Stripe objects remain the source of truth; these columns are the
-- locally-rendered MIRROR, written ONLY by the signature-verified webhook
-- (server/donna/stripeBilling.js) — never a UI-layer inference (CLAUDE.md
-- "render the persisted verdict" rail). They die with the client row, same as
-- the 046 columns (no FK to add).

-- one_month | catch_up | recurring (the kind last purchased). NULL = never bought.
alter table clients add column if not exists billing_kind text;
-- The pricing.js band id (lt200 | 200-500 | 500-1k) the purchase was priced at.
alter table clients add column if not exists billing_band_id text;
-- Access cliff for a ONE-OFF payment. The gate entitles the portal while
-- now() < access_paid_through. NULL for recurring clients (their access is
-- governed by subscription_status, which Stripe keeps current). One period per
-- month bought (catch_up buys several), anchored on the Stripe session time.
alter table clients add column if not exists access_paid_through timestamptz;
