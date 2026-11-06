-- Donna firm billing is a platform mirror, not workspace entitlement. Purchases
-- can precede a firm; linking is manual and deletion only detaches that link.
create table if not exists firm_subscriptions (
  stripe_subscription_id text primary key,
  stripe_customer_id text not null,
  status text not null,
  current_period_end timestamptz,
  price_lookup_key text,
  locale text,
  customer_email text,
  firm_name text,
  tax_ids jsonb not null default '[]'::jsonb check (jsonb_typeof(tax_ids) = 'array'),
  firm_id text references firms(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists firm_subscriptions_customer_idx on firm_subscriptions(stripe_customer_id);
create index if not exists firm_subscriptions_firm_idx on firm_subscriptions(firm_id) where firm_id is not null;

-- Kari approved this one exception (2026-10-16). No fake tenant, and no general
-- platform-audit lane: every other audit event still requires a real firm.
alter table audit_events alter column firm_id drop not null;
do $$ begin
  if not exists (select 1 from pg_constraint where conrelid='audit_events'::regclass
    and conname='audit_events_firm_or_stripe_subscription') then
    alter table audit_events add constraint audit_events_firm_or_stripe_subscription check (
      firm_id is not null or (
        client_id is null
        and action = 'billing.firm_subscription_mirrored'
        and resource_type = 'firm_subscription'
        and resource_id ~ '^sub_[A-Za-z0-9_]+$'
        and actor_type = 'stripe'
        and actor_id ~ '^evt_[A-Za-z0-9_]+$'
        and actor_id = metadata->>'stripe_event_id'
        and metadata->>'offer' = 'donna_firm_monthly'
        and metadata->>'authority_basis' = 'stripe_webhook_signature'
        and jsonb_typeof(metadata->'livemode') = 'boolean'
        and metadata->>'event_type' in ('checkout.session.completed',
          'customer.subscription.created', 'customer.subscription.updated', 'customer.subscription.deleted')
      ) is true
    );
  end if;
end $$;
create unique index if not exists audit_events_firm_billing_event_uniq
  on audit_events ((metadata->>'stripe_event_id'))
  where action = 'billing.firm_subscription_mirrored';
create index if not exists audit_events_firm_billing_subscription_idx
  on audit_events(resource_id, id desc)
  where action = 'billing.firm_subscription_mirrored';

-- These records include billing PII. No browser access, even before linking.
alter table firm_subscriptions enable row level security;
do $$ begin
  if exists (select 1 from pg_roles where rolname='anon') then
    revoke all on firm_subscriptions from anon;
  end if;
  if exists (select 1 from pg_roles where rolname='authenticated') then
    revoke all on firm_subscriptions from authenticated;
  end if;
  if exists (select 1 from pg_roles where rolname='service_role') then
    grant select, insert, update, delete on firm_subscriptions to service_role;
  end if;
end $$;
