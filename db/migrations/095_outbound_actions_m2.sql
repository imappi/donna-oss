-- 095 — Outbound actions M2: issuance on the pipeline + D4 pay-links + the D6
-- authority-grant generalization. docs/design-donna-outbound-actions-execution-plan.md
-- §1 M2, D4, D6.
--
-- Three concerns, one milestone:
--
-- 1. action_authority_grants — the D6 generalization of the 040 grant engine:
--    ONE scoped/ceilinged/auto-suspend-on-correction grant table with a DOMAIN
--    column instead of a fourth per-domain copy. The outbound executor's
--    authority-resolution seam consumes domain='outbound' rows (per
--    counterparty × action type — the earned-auto path the D4 settlement
--    signal unlocks); the three existing copies (040 reconciliation, 054
--    ledger-sync, 083 inventory) may migrate onto it LATER, optionally — their
--    domains are in the CHECK now so that migration is a data move, not a
--    schema change. DORMANT at runtime today: no surface mints rows yet, and
--    every OUTBOUND_* 'auto' terminal stays in AUTO_FORBIDDEN_FLAGS until
--    Kari's D1 call is recorded.
--
-- 2. outbound_payment_links — D4: a Stripe payment link per receivable anchor
--    (parsed document or issued invoice), created on the CLIENT's connected
--    Stripe account (profile.stripe_account_id — the client's own money rail,
--    never the platform billing account). The link is both the US collection
--    lever (it replaces the profile.payment_instructions seam in reminders)
--    and the DETERMINISTIC settlement signal: the signature-verified webhook
--    marks it settled, which the paid-truth guard reads as 'settled' — the
--    US replacement for the viitenumero.
--
-- 3. outbound_payment_link_events — append-only webhook receipts; the UNIQUE
--    provider_event_id makes webhook processing idempotent (Stripe re-drives
--    deliveries).
--
-- Plus: outbound_metrics_daily gains first-class issuance counters
-- (invoices_issued, quotes_sent) — instrumentation moves with the milestone.
--
-- Everything dies with its client via FK cascade (090/091 convention). RLS.

create table if not exists action_authority_grants (
  id text primary key,
  firm_id text not null references firms(id) on delete cascade,
  client_id text not null references clients(id) on delete cascade,
  -- The D6 domain scope. 'outbound' is live in M2; the legacy per-domain
  -- copies keep their own tables until deliberately migrated.
  domain text not null
    check (domain in ('outbound', 'reconciliation', 'ledger_sync', 'inventory')),
  -- The domain's action verb (outbound: the closed outbound action_type).
  action_type text not null,
  scope_kind text not null
    check (scope_kind in ('counterparty', 'merchant', 'account_pair')),
  scope_key text not null,
  -- Required ceiling — never an accidental unlimited grant (040 discipline).
  amount_ceiling numeric not null check (amount_ceiling > 0),
  currency text not null,
  -- Self-service doctrine (2026-07-23): the OWNER is the only human who can
  -- grant Donna standing authority over their book. 'system' only on the
  -- audited migration path with provenance.originating_authority.
  authorized_by_actor_type text not null,
  authorized_by_actor_id text,
  source text not null
    check (source in ('owner_approval', 'learned_from_pattern', 'migration')),
  provenance jsonb not null default '{}'::jsonb,
  status text not null default 'proposed'
    check (status in ('proposed', 'active', 'suspended', 'revoked')),
  use_count integer not null default 0,
  correction_count integer not null default 0,
  last_used_at timestamptz,
  valid_from timestamptz not null default now(),
  expires_at timestamptz,
  review_after timestamptz,
  revoked_by_actor_id text,
  revoked_reason text,
  policy_version text,
  model text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists action_authority_grants_lookup_idx
  on action_authority_grants(firm_id, client_id, domain, action_type, scope_key, status);

create table if not exists outbound_payment_links (
  id text primary key,
  firm_id text not null references firms(id) on delete cascade,
  client_id text not null references clients(id) on delete cascade,
  -- Anchors mirror receivable_cases: parsed sales invoices and issued invoices.
  anchor_type text not null
    check (anchor_type in ('document', 'issued_invoice')),
  anchor_id text not null,
  provider text not null default 'stripe'
    check (provider in ('stripe')),
  -- The CLIENT's connected Stripe account the link was created on.
  provider_account_id text,
  provider_link_id text,
  provider_price_id text,
  url text not null,
  amount numeric not null check (amount > 0),
  currency text not null,
  status text not null default 'active'
    check (status in ('active', 'settled', 'deactivated')),
  settled_amount numeric,
  settled_at timestamptz,
  settlement_event_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- One link per anchor per provider: re-ensuring is an idempotent no-op.
create unique index if not exists outbound_payment_links_anchor_idx
  on outbound_payment_links(firm_id, client_id, anchor_type, anchor_id, provider);
create index if not exists outbound_payment_links_provider_link_idx
  on outbound_payment_links(provider, provider_link_id);

create table if not exists outbound_payment_link_events (
  id text primary key,
  firm_id text not null references firms(id) on delete cascade,
  client_id text not null references clients(id) on delete cascade,
  link_id text not null references outbound_payment_links(id) on delete cascade,
  -- Idempotency: Stripe re-drives deliveries; one event row per provider event.
  provider_event_id text not null,
  event_type text not null,
  amount numeric,
  currency text,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create unique index if not exists outbound_payment_link_events_event_idx
  on outbound_payment_link_events(provider_event_id);
create index if not exists outbound_payment_link_events_link_idx
  on outbound_payment_link_events(link_id);

-- §3 instrumentation follows the milestone: first-class issuance counters.
alter table outbound_metrics_daily
  add column if not exists invoices_issued integer not null default 0;
alter table outbound_metrics_daily
  add column if not exists quotes_sent integer not null default 0;

-- ── RLS-native (mirror 090/091) ──────────────────────────────────────────────
alter table action_authority_grants enable row level security;
alter table outbound_payment_links enable row level security;
alter table outbound_payment_link_events enable row level security;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on action_authority_grants, outbound_payment_links, outbound_payment_link_events from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on action_authority_grants, outbound_payment_links, outbound_payment_link_events from authenticated;
  end if;
end $$;
