-- 126 — Gate 1B.1 persisted runtime readiness (observe-only).
--
-- Two mutable plane-S projections answer the current question quickly:
--   * runtime_host_readiness: one row for this desktop runtime host;
--   * entity_readiness_sagas: one stable saga per firm/client.
--
-- Entity attempts use the existing append-only audit_events substrate. Host
-- attempts cannot: audit_events.firm_id is deliberately NOT NULL, while Host A
-- must certify a virgin desktop before the first firm exists. The narrowly
-- global runtime_host_readiness_attempts table is therefore the immutable host
-- receipt trail; its database trigger refuses UPDATE/DELETE. It carries no
-- tenant or client data and is not a second product audit system.

create table if not exists runtime_host_readiness_attempts (
  id bigserial primary key,
  host_id text not null,
  attempt_sequence integer not null check (attempt_sequence > 0),
  event_type text not null check (event_type in ('boot', 'renewal', 'retry')),
  status text not null check (status in ('PASS', 'FAIL', 'INCOMPLETE')),
  certificate_version text not null,
  compatibility_digest text,
  receipt_digest text not null,
  reason_code text,
  responsible_system text not null,
  certificate jsonb not null,
  observed_at timestamptz not null,
  created_at timestamptz not null default now(),
  unique (host_id, attempt_sequence),
  unique (receipt_digest)
);

create index if not exists runtime_host_readiness_attempts_host_created_idx
  on runtime_host_readiness_attempts (host_id, created_at desc, id desc);

create table if not exists runtime_host_readiness (
  host_id text primary key,
  status text not null check (status in ('PASS', 'FAIL', 'INCOMPLETE')),
  certificate_version text not null,
  runtime_host text not null,
  build_commit_sha text,
  build_dirty boolean,
  compatibility_digest text,
  receipt_digest text not null,
  latest_attempt_id bigint not null references runtime_host_readiness_attempts(id),
  attempt_count integer not null check (attempt_count > 0),
  reason_code text,
  responsible_system text not null,
  minted_at timestamptz not null,
  checked_at timestamptz not null,
  renew_after timestamptz not null,
  valid_until timestamptz not null,
  updated_at timestamptz not null default now()
);

create table if not exists entity_readiness_sagas (
  firm_id text not null references firms(id) on delete cascade,
  client_id text not null references clients(id) on delete cascade,
  saga_id text not null,
  idempotency_key text not null,
  state text not null check (state in ('provisioning', 'ready', 'failed')),
  admitted_profile_id text not null,
  certificate_version text not null,
  manifest_version text not null,
  ready_dependency_digest text,
  observed_dependency_digest text,
  host_compatibility_digest text,
  latest_attempt_id bigint not null references audit_events(id),
  root_cause_receipt_id bigint references audit_events(id),
  attempt_count integer not null check (attempt_count > 0),
  max_attempts integer not null check (max_attempts > 0),
  retry_state text not null check (retry_state in ('idle', 'scheduled', 'exhausted')),
  reason_code text,
  responsible_system text not null,
  next_retry_at timestamptz,
  ready_at timestamptz,
  failed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (firm_id, client_id),
  unique (saga_id),
  unique (idempotency_key),
  check ((state = 'ready' and ready_dependency_digest is not null) or state <> 'ready'),
  check ((retry_state = 'scheduled' and next_retry_at is not null) or retry_state <> 'scheduled')
);

create index if not exists entity_readiness_sagas_firm_state_idx
  on entity_readiness_sagas (firm_id, state, updated_at desc);

create or replace function runtime_host_readiness_attempts_append_only_guard() returns trigger
  language plpgsql as $$
begin
  raise exception
    'runtime_host_readiness_attempts is append-only; % is forbidden', tg_op
    using errcode = 'restrict_violation';
end;
$$;

drop trigger if exists runtime_host_readiness_attempts_append_only on runtime_host_readiness_attempts;
create trigger runtime_host_readiness_attempts_append_only
  before update or delete on runtime_host_readiness_attempts
  for each row execute function runtime_host_readiness_attempts_append_only_guard();

-- Server-only state/receipt tables. The pooled owner role remains exempt; no
-- browser policy is created. ENABLE + guarded revoke, never FORCE.
alter table runtime_host_readiness_attempts enable row level security;
alter table runtime_host_readiness enable row level security;
alter table entity_readiness_sagas enable row level security;

do $$
declare
  table_name text;
begin
  foreach table_name in array array[
    'runtime_host_readiness_attempts',
    'runtime_host_readiness',
    'entity_readiness_sagas'
  ] loop
    if exists (select 1 from pg_roles where rolname = 'anon') then
      execute format('revoke all on %I from anon', table_name);
    end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then
      execute format('revoke all on %I from authenticated', table_name);
    end if;
  end loop;
end $$;
