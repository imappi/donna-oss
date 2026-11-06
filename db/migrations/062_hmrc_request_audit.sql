-- 062 — HMRC request audit spine (MTD-1A fraud-prevention header audit).
-- Stores only the verified header-set version and a SHA-256 hash of the
-- canonical fraud-prevention headers; never stores raw sensitive header values.

create table if not exists hmrc_request_audit (
  id text primary key,
  firm_id text not null references firms(id) on delete cascade,
  client_id text not null references clients(id) on delete cascade,
  hmrc_connection_id text references hmrc_connections(id) on delete set null,
  hmrc_endpoint text not null,
  http_method text not null,
  request_purpose text not null,
  fraud_header_set_version text not null,
  fraud_header_hash text not null,
  hmrc_correlation_id text,
  response_status integer,
  response_error_code text,
  created_at timestamptz not null default now()
);

create index if not exists hmrc_request_audit_firm_client_created_idx
  on hmrc_request_audit(firm_id, client_id, created_at desc);

create index if not exists hmrc_request_audit_connection_created_idx
  on hmrc_request_audit(hmrc_connection_id, created_at desc);

alter table hmrc_request_audit enable row level security;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on hmrc_request_audit from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on hmrc_request_audit from authenticated;
  end if;
end $$;
