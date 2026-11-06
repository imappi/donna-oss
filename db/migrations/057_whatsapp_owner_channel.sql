create table if not exists client_whatsapp_bind_tokens (
  token_hash text primary key,
  firm_id text not null references firms(id) on delete cascade,
  client_id text not null references clients(id) on delete cascade,
  collaborator_id text references firm_collaborators(id) on delete set null,
  created_by text not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  redeemed_at timestamptz,
  redeemed_phone_e164 text,
  revoked_at timestamptz,
  revoked_by text
);

create index if not exists client_whatsapp_bind_tokens_client_idx
  on client_whatsapp_bind_tokens(firm_id, client_id, expires_at desc);

create table if not exists client_whatsapp_bindings (
  id text primary key,
  firm_id text not null references firms(id) on delete cascade,
  client_id text not null references clients(id) on delete cascade,
  collaborator_id text references firm_collaborators(id) on delete set null,
  phone_e164 text not null,
  phone_hash text not null,
  verified_at timestamptz not null default now(),
  verified_set_by text not null,
  opted_in_at timestamptz not null default now(),
  opted_in_set_by text not null,
  revoked_at timestamptz,
  revoked_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (firm_id, client_id, collaborator_id, phone_hash)
);

create index if not exists client_whatsapp_bindings_client_active_idx
  on client_whatsapp_bindings(firm_id, client_id)
  where revoked_at is null;

create index if not exists client_whatsapp_bindings_phone_active_idx
  on client_whatsapp_bindings(phone_hash)
  where revoked_at is null;

create table if not exists message_delivery_ledger (
  id text primary key,
  message_id text not null,
  channel text not null,
  provider text not null,
  ask_id text references client_evidence_requests(id) on delete set null,
  client_id text references clients(id) on delete cascade,
  recipient_phone_hash text,
  template_name text,
  sent_at timestamptz,
  delivered_at timestamptz,
  read_at timestamptz,
  failed_at timestamptz,
  failure_reason text,
  fallback_triggered_at timestamptz,
  inbound_reply_id text,
  resolved_request_id text references client_evidence_requests(id) on delete set null,
  provider_payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (provider, message_id)
);

create index if not exists message_delivery_ledger_client_idx
  on message_delivery_ledger(client_id, created_at desc);

create index if not exists message_delivery_ledger_ask_idx
  on message_delivery_ledger(ask_id, created_at desc);


alter table client_whatsapp_bind_tokens enable row level security;
alter table client_whatsapp_bindings enable row level security;
alter table message_delivery_ledger enable row level security;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on client_whatsapp_bind_tokens from anon;
    revoke all on client_whatsapp_bindings from anon;
    revoke all on message_delivery_ledger from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on client_whatsapp_bind_tokens from authenticated;
    revoke all on client_whatsapp_bindings from authenticated;
    revoke all on message_delivery_ledger from authenticated;
  end if;
end $$;
