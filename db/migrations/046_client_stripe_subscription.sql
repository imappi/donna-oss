-- Stripe subscription billing — Phase 0 (beta launch).
--
-- The DFY product is a per-client subscription (founder-led DFY US bookkeeping
-- at ~$99/mo — CLAUDE.md GOAL rail). The subscription gates CLIENT PORTAL
-- access: a business owner must hold an active (or trialing) subscription to
-- keep using the documents-intake portal.
--
-- One subscription per client, no history needed at this stage, so the fields
-- live as columns ON `clients` rather than a separate table (sibling of the
-- `profile`/`status` columns in 001_firm_core.sql). The Stripe objects are the
-- source of truth; these columns are the locally-rendered MIRROR, written ONLY
-- by the signature-verified webhook (server/donna/stripeBilling.js) — never a
-- UI-layer inference (CLAUDE.md "render the persisted verdict" rail).
--
-- A subscription dies with its client via the existing clients row (no FK to
-- add): a deleted/reset client gets a genuine clean slate, consistent with the
-- 042/040 "config dies with its client" convention. The Stripe customer object
-- itself is NOT purged here — that is a Stripe-side concern.

alter table clients add column if not exists stripe_customer_id text;
alter table clients add column if not exists stripe_subscription_id text;
-- Mirrors the Stripe subscription.status vocabulary verbatim (trialing | active
-- | past_due | canceled | unpaid | incomplete | incomplete_expired | paused).
-- NULL = this client has never started a subscription. We deliberately do NOT
-- CHECK-constrain it: Stripe owns this vocabulary and may extend it, and a
-- mirror must not reject a status its source emits.
alter table clients add column if not exists subscription_status text;
-- End of the current paid/trial period — the access cliff. The gate treats a
-- client as entitled while status is active/trialing; this column lets the gate
-- (and support) see when an unpaid/canceled subscription actually lapses.
alter table clients add column if not exists subscription_current_period_end timestamptz;
-- When the mirror was last written by a webhook event — the freshness receipt.
alter table clients add column if not exists subscription_updated_at timestamptz;

-- A Stripe customer maps to at most one client. Partial unique (only when the
-- column is populated) so the existing rows with NULL stay legal and a webhook
-- can't cross-wire one customer onto two clients.
create unique index if not exists clients_stripe_customer_uniq
  on clients(stripe_customer_id)
  where stripe_customer_id is not null;
