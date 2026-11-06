-- Delegation metadata over the existing count session, never another stock owner.
create unique index if not exists inventory_count_sessions_tenant_id
  on inventory_count_sessions(firm_id,client_id,id);
-- The hosted catalog restores keys before foreign keys and ordinary indexes.
-- Declare this candidate key explicitly so the task FK survives that restore.
do $$ begin
  if not exists(select 1 from pg_constraint where conrelid='public.inventory_count_sessions'::regclass
    and conname='inventory_count_sessions_tenant_id') then
    alter table inventory_count_sessions add constraint inventory_count_sessions_tenant_id
      unique using index inventory_count_sessions_tenant_id;
  end if;
end $$;
create table if not exists inventory_capture_tasks (
  id uuid primary key,
  firm_id text not null,
  client_id text not null,
  count_session_id bigint not null,
  name text not null check(length(name) between 1 and 120),
  principal_type text not null check(principal_type in ('firm_member','firm_collaborator')),
  principal_id text not null,
  principal_user_id text not null,
  principal_created_at timestamptz not null,
  created_by_type text not null,
  created_by_id text not null,
  idempotency_key text not null,
  input_hash text not null,
  invitation_hash text unique,
  invitation_expires_at timestamptz,
  invitation_used_at timestamptz,
  invitation_key text,
  credential_hash text unique,
  credential_expires_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  foreign key(firm_id,client_id,count_session_id)
    references inventory_count_sessions(firm_id,client_id,id) on delete cascade,
  unique(firm_id,client_id,idempotency_key)
);
create unique index if not exists inventory_capture_tasks_active_session
  on inventory_capture_tasks(count_session_id) where revoked_at is null;
alter table inventory_capture_tasks enable row level security;
-- Service-only, following existing inventory tables; no browser table access.
do $$ begin
  if exists(select 1 from pg_roles where rolname='anon') then
    revoke all on inventory_capture_tasks from anon;
  end if;
  if exists(select 1 from pg_roles where rolname='authenticated') then
    revoke all on inventory_capture_tasks from authenticated;
  end if;
  if exists(select 1 from pg_roles where rolname='service_role') then
    grant all on inventory_capture_tasks to service_role;
  end if;
end $$;
