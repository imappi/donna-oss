-- 133 — RT-09 (audit F-21): the migration-127 dependency fence is scoped to
-- writes Donna did NOT itself admit.
--
-- Migration 127 invalidates a ready entity_readiness_sagas row whenever a
-- load-bearing dependency changes, in the dependency writer's transaction.
-- That fence could not tell a FOREIGN change (an operator editing the
-- client's jurisdiction, staging a flag, minting a grant by hand) from
-- Donna's OWN admitted write: a posting through the shared ledger writer
-- runs under an admission decision pinned to the ready generation, and when
-- it minted a chart account (ledger.account.created_at_posting →
-- ledger_accounts insert → the trigger) it invalidated the very generation
-- that admitted it. Desert Rose, 2026-09-01: seven self-inflicted
-- invalidations, 137 admission blocks, asks and postings starved while every
-- job row showed green. The palette pre-seed (#1962) removed that instance;
-- this migration removes the class.
--
-- The scope is a transaction-local GUC. runtimeReadinessAdmission.js sets
-- `donna.admitted_generation` to the EXACT ready generation digest it
-- admitted (set_config(..., true) — it cannot outlive the transaction and
-- cannot leak to another connection), so every admitted seam gets the scope
-- for free: the ledger post path, both authority chokepoints, the locked ask
-- send, upload signing / registration / parse claim. The invalidator returns
-- early only when that value equals the saga's ready_dependency_digest — a
-- stale digest, an absent setting, or any other connection is foreign and
-- invalidates exactly as before. The scoped write is receipted
-- (entity.readiness.admitted_write_scoped); nothing is silent.
--
-- Trigger functions and trigger definitions from 127 are untouched: they
-- all funnel through this one function.

create or replace function invalidate_entity_readiness_dependency(
  dependency_firm_id text,
  dependency_client_id text,
  dependency_table text,
  dependency_operation text
) returns void
  language plpgsql as $$
declare
  saga entity_readiness_sagas%rowtype;
  invalidation_receipt_id bigint;
  admitted_generation text;
begin
  if dependency_firm_id is null or dependency_client_id is null then
    return;
  end if;

  -- The same key is held by provisioning and by the rare non-transactional
  -- reconciliation lease. This closes the gap between a dependency writer's
  -- row change and its saga invalidation trigger.
  perform pg_advisory_xact_lock(
    hashtextextended('entity-readiness:' || dependency_firm_id || ':' || dependency_client_id, 0)
  );

  select * into saga
    from entity_readiness_sagas
   where firm_id = dependency_firm_id
     and client_id = dependency_client_id
     and state = 'ready'
   for update;
  if not found then
    return;
  end if;

  -- RT-09: a write made UNDER an admission decision must not invalidate the
  -- generation that admitted it. Only the exact digest scopes the fence.
  admitted_generation := coalesce(current_setting('donna.admitted_generation', true), '');
  if admitted_generation <> ''
     and saga.ready_dependency_digest is not null
     and admitted_generation = saga.ready_dependency_digest then
    insert into audit_events
      (firm_id, client_id, actor_type, actor_id, action, resource_type, resource_id, metadata)
    values
      (dependency_firm_id, dependency_client_id, 'system',
       'entityReadinessDependencyFence', 'entity.readiness.admitted_write_scoped',
       'entity_readiness_saga', saga.saga_id,
       jsonb_build_object(
         'contract_version', 'donna.entity-readiness-admitted-write.v1',
         'reason_code', 'admitted_write_scoped',
         'responsible_system', 'donna_readiness',
         'dependency_table', dependency_table,
         'dependency_operation', lower(dependency_operation),
         'ready_dependency_digest', saga.ready_dependency_digest,
         'entity_receipt_ref', jsonb_build_object(
           'store', 'audit_events', 'id', saga.latest_attempt_id
         )
       ));
    return;
  end if;

  insert into audit_events
    (firm_id, client_id, actor_type, actor_id, action, resource_type, resource_id, metadata)
  values
    (dependency_firm_id, dependency_client_id, 'system',
     'entityReadinessDependencyFence', 'entity.readiness.invalidated',
     'entity_readiness_saga', saga.saga_id,
     jsonb_build_object(
       'contract_version', 'donna.entity-readiness-invalidation.v1',
       'reason_code', 'entity_dependency_changed',
       'responsible_system', 'donna_readiness',
       'retryable', saga.attempt_count < saga.max_attempts,
       'dependency_table', dependency_table,
       'dependency_operation', lower(dependency_operation),
       'prior_ready_dependency_digest', saga.ready_dependency_digest,
       'prior_observed_dependency_digest', saga.observed_dependency_digest,
       'prior_entity_receipt_ref', jsonb_build_object(
         'store', 'audit_events', 'id', saga.latest_attempt_id
       ),
       'recovery_route', 'entity_readiness_retry'
     ))
  returning id into invalidation_receipt_id;

  update entity_readiness_sagas
     set state = 'failed',
         observed_dependency_digest = null,
         root_cause_receipt_id = invalidation_receipt_id,
         retry_state = case
           when attempt_count >= max_attempts then 'exhausted'
           else 'scheduled'
         end,
         reason_code = 'entity_dependency_changed',
         responsible_system = 'donna_readiness',
         next_retry_at = case
           when attempt_count >= max_attempts then null
           else now()
         end,
         failed_at = now(),
         updated_at = now()
   where firm_id = dependency_firm_id
     and client_id = dependency_client_id;
end;
$$;

-- RT-09 (audit F-06): host-caused entity failures are budget-free from this
-- migration on (runtimeReadiness.js charges no attempt and schedules no clock
-- when the first failure is a host_* wait reason; the saga rests
-- failed/scheduled with next_retry_at null until the first Host A PASS
-- renewal heals it).
--
-- 126's shape constraint said "a scheduled retry always has a clock". The
-- honest invariant is now "a scheduled retry has a clock OR names the host
-- it is waiting for": a clockless scheduled retry is exactly the host wait,
-- and its reason_code is the host_* code that says so. The unnamed 126
-- constraint is located by its definition (its auto-generated name depends
-- on declaration order) and replaced by a named one.
do $$
declare
  retry_shape record;
begin
  for retry_shape in
    select conname
      from pg_constraint
     where conrelid = 'entity_readiness_sagas'::regclass
       and contype = 'c'
       and pg_get_constraintdef(oid) ilike '%retry_state = ''scheduled''%next_retry_at is not null%'
  loop
    execute format('alter table entity_readiness_sagas drop constraint %I', retry_shape.conname);
  end loop;
end
$$;
alter table entity_readiness_sagas
  add constraint entity_readiness_sagas_scheduled_retry_check
  check (
    (retry_state = 'scheduled' and (next_retry_at is not null or reason_code like 'host\_%'))
    or retry_state <> 'scheduled'
  );

-- Rows the OLD rule charged for the same host outage —
-- including sagas it exhausted after three Retry clicks against a dead host —
-- are restored to the new resting shape here, each with a receipt: a budget
-- burnt by the runtime's own host is not a bounded-retry verdict about the
-- entity. Entity-side failures (every other reason_code) are deliberately NOT
-- rewritten — their exit stays the explicit, receipted reopen (130's posture).
-- The three *_not_pass companions below that Host A v5 no longer mints
-- (source_build, model_routes, spend_meter) appear only on pre-v5 rows.
-- Idempotent: a row already in the resting shape is left alone.
with candidates as (
  select firm_id, client_id, saga_id, reason_code, attempt_count, retry_state, next_retry_at
    from entity_readiness_sagas
   where state = 'failed'
     and reason_code in (
       'host_certificate_missing',
       'host_certificate_version_mismatch',
       'host_certificate_not_pass',
       'host_database_schema_not_pass',
       'host_scheduler_worker_manifest_not_pass',
       'host_evidence_storage_not_pass',
       'host_policy_oracle_artifacts_not_pass',
       'host_config_control_plane_not_pass',
       'host_accounting_adapter_not_pass',
       'host_source_build_not_pass',
       'host_model_routes_not_pass',
       'host_spend_meter_not_pass',
       'host_certificate_digest_missing',
       'host_certificate_digest_mismatch',
       'host_compatibility_contract_version_mismatch',
       'host_compatibility_digest_missing',
       'host_compatibility_digest_mismatch',
       'host_freshness_contract_invalid',
       'host_certificate_not_yet_valid',
       'host_certificate_expired'
     )
     and (attempt_count <> 0 or retry_state <> 'scheduled' or next_retry_at is not null)
   for update
), restored as (
  update entity_readiness_sagas saga
     set attempt_count = 0,
         retry_state = 'scheduled',
         next_retry_at = null,
         updated_at = now()
    from candidates
   where saga.firm_id = candidates.firm_id
     and saga.client_id = candidates.client_id
   returning candidates.firm_id, candidates.client_id, candidates.saga_id, candidates.reason_code,
             candidates.attempt_count as prior_attempt_count,
             candidates.retry_state as prior_retry_state,
             candidates.next_retry_at as prior_next_retry_at
)
insert into audit_events
  (firm_id, client_id, actor_type, actor_id, action, resource_type, resource_id, metadata)
select firm_id, client_id, 'system', 'entityReadinessHostWaitRestore',
       'entity.readiness.host_wait_budget_restored', 'entity_readiness_saga', saga_id,
       jsonb_build_object(
         'contract_version', 'donna.entity-readiness-host-wait-restore.v1',
         'reason_code', reason_code,
         'responsible_system', 'donna_runtime',
         'prior_attempt_count', prior_attempt_count,
         'prior_retry_state', prior_retry_state,
         'prior_next_retry_at', prior_next_retry_at,
         'migration', '133_entity_readiness_admitted_write_scope',
         'recovery_route', 'host_certificate_pass_renewal'
       )
  from restored;
