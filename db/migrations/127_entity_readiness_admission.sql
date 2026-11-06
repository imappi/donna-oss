-- 127 — Gate 1B.2 dependency invalidation for enforced entity admission.
--
-- The admission reader locks entity_readiness_sagas before an irreversible
-- mutation. These triggers update that same row whenever a load-bearing Entity
-- B dependency changes. PostgreSQL therefore supplies the TOCTOU boundary:
-- either the mutation pins the ready generation first, or this invalidation
-- commits first and the mutation refuses. The change is also receipted in the
-- existing append-only audit_events trail so recovery is visible and resumable.
--
-- ENTITY_READINESS_ADMISSION itself is an admitted extension, not part of the
-- entity dependency digest. Staging the fence must not invalidate the entity it
-- is about to protect.

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

create or replace function invalidate_entity_readiness_from_client() returns trigger
  language plpgsql as $$
begin
  if old.jurisdiction is not distinct from new.jurisdiction
     and old.entity_type is not distinct from new.entity_type
     and old.status is not distinct from new.status
     and old.uen is not distinct from new.uen
     and old.profile->>'jurisdiction' is not distinct from new.profile->>'jurisdiction'
     and old.profile->>'entityType' is not distinct from new.profile->>'entityType'
     and old.profile->>'accounting_system' is not distinct from new.profile->>'accounting_system'
     and old.profile->>'accounting_basis' is not distinct from new.profile->>'accounting_basis'
     and old.profile->>'bookBasis' is not distinct from new.profile->>'bookBasis'
     and old.profile->>'currency' is not distinct from new.profile->>'currency'
     and old.profile->>'email' is not distinct from new.profile->>'email' then
    return new;
  end if;
  perform invalidate_entity_readiness_dependency(new.firm_id, new.id, tg_table_name, tg_op);
  return new;
end;
$$;

drop trigger if exists clients_invalidate_entity_readiness on clients;
create trigger clients_invalidate_entity_readiness
  after update on clients
  for each row execute function invalidate_entity_readiness_from_client();

create or replace function invalidate_entity_readiness_from_client_row() returns trigger
  language plpgsql as $$
declare
  dependency_row record;
  old_row jsonb;
  new_row jsonb;
  projected_keys text[];
  old_projection jsonb;
  new_projection jsonb;
begin
  -- PostgreSQL fires an UPDATE OF trigger when a named column appears in the
  -- statement even if its value is unchanged. Journal account upserts and
  -- idempotent grant/config writers rely on that shape. Compare only the
  -- certificate-bearing projection so a no-op write does not churn a ready
  -- generation, while a genuine chart/authority/assignment change still
  -- invalidates in the writer's transaction.
  if tg_op = 'UPDATE' then
    old_row := to_jsonb(old);
    new_row := to_jsonb(new);
    projected_keys := case tg_table_name
      when 'client_assignments' then array[
        'firm_id', 'client_id', 'principal_type', 'principal_id', 'role',
        'access_level', 'status'
      ]
      when 'ledger_accounts' then array[
        'firm_id', 'client_id', 'code', 'name', 'account_type',
        'normal_balance', 'canonical_role'
      ]
      when 'reconciliation_authority_grants' then array[
        'firm_id', 'client_id', 'scope_kind', 'scope_key', 'archetype',
        'action', 'amount_ceiling', 'currency', 'status', 'source'
      ]
      when 'action_authority_grants' then array[
        'firm_id', 'client_id', 'domain', 'action_type', 'scope_kind',
        'scope_key', 'amount_ceiling', 'currency', 'status', 'source'
      ]
      else array[]::text[]
    end;
    select jsonb_object_agg(key, old_row->key order by key)
      into old_projection
      from unnest(projected_keys) as key;
    select jsonb_object_agg(key, new_row->key order by key)
      into new_projection
      from unnest(projected_keys) as key;
    if old_projection is not distinct from new_projection then
      return new;
    end if;
  end if;
  if tg_op = 'UPDATE'
     and (old.firm_id is distinct from new.firm_id
       or old.client_id is distinct from new.client_id) then
    perform invalidate_entity_readiness_dependency(
      old.firm_id, old.client_id, tg_table_name, tg_op
    );
  end if;
  if tg_op = 'DELETE' then dependency_row := old; else dependency_row := new; end if;
  perform invalidate_entity_readiness_dependency(
    dependency_row.firm_id, dependency_row.client_id, tg_table_name, tg_op
  );
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

drop trigger if exists client_assignments_invalidate_entity_readiness on client_assignments;
create trigger client_assignments_invalidate_entity_readiness
  after insert or delete or update of firm_id, client_id, principal_type, principal_id,
    role, access_level, status
  on client_assignments
  for each row execute function invalidate_entity_readiness_from_client_row();

drop trigger if exists ledger_accounts_invalidate_entity_readiness on ledger_accounts;
create trigger ledger_accounts_invalidate_entity_readiness
  after insert or delete or update of firm_id, client_id, code, name, account_type,
    normal_balance, canonical_role
  on ledger_accounts
  for each row execute function invalidate_entity_readiness_from_client_row();

create or replace function invalidate_entity_readiness_from_capability() returns trigger
  language plpgsql as $$
declare
  dependency_row record;
begin
  if tg_op = 'UPDATE'
     and old.firm_id is not distinct from new.firm_id
     and old.client_id is not distinct from new.client_id
     and old.flag_key is not distinct from new.flag_key
     and old.stage is not distinct from new.stage
     and old.source is not distinct from new.source
     and old.reason is not distinct from new.reason
     and old.valid_to is not distinct from new.valid_to then
    return new;
  end if;
  if tg_op = 'UPDATE' then
    if old.client_id is not null
       and old.flag_key <> 'ENTITY_READINESS_ADMISSION'
       and (old.firm_id is distinct from new.firm_id
         or old.client_id is distinct from new.client_id
         or new.flag_key = 'ENTITY_READINESS_ADMISSION') then
      perform invalidate_entity_readiness_dependency(
        old.firm_id, old.client_id, tg_table_name, tg_op
      );
    end if;
    if new.client_id is not null
       and new.flag_key <> 'ENTITY_READINESS_ADMISSION' then
      perform invalidate_entity_readiness_dependency(
        new.firm_id, new.client_id, tg_table_name, tg_op
      );
    end if;
    return new;
  end if;
  if tg_op = 'DELETE' then dependency_row := old; else dependency_row := new; end if;
  if dependency_row.client_id is null
     or dependency_row.flag_key = 'ENTITY_READINESS_ADMISSION' then
    if tg_op = 'DELETE' then return old; end if;
    return new;
  end if;
  perform invalidate_entity_readiness_dependency(
    dependency_row.firm_id, dependency_row.client_id, tg_table_name, tg_op
  );
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

drop trigger if exists client_capability_config_invalidate_entity_readiness on client_capability_config;
create trigger client_capability_config_invalidate_entity_readiness
  after insert or delete or update of firm_id, client_id, flag_key, stage, source, reason, valid_to
  on client_capability_config
  for each row execute function invalidate_entity_readiness_from_capability();

drop trigger if exists reconciliation_grants_invalidate_entity_readiness on reconciliation_authority_grants;
create trigger reconciliation_grants_invalidate_entity_readiness
  after insert or delete or update of firm_id, client_id, scope_kind, scope_key,
    archetype, action, amount_ceiling, currency, status, source
  on reconciliation_authority_grants
  for each row execute function invalidate_entity_readiness_from_client_row();

drop trigger if exists action_grants_invalidate_entity_readiness on action_authority_grants;
create trigger action_grants_invalidate_entity_readiness
  after insert or delete or update of firm_id, client_id, domain, action_type,
    scope_kind, scope_key, amount_ceiling, currency, status, source
  on action_authority_grants
  for each row execute function invalidate_entity_readiness_from_client_row();

-- Actor existence/status is part of Entity B even though the actor projection
-- itself comes from the immutable creation receipt. Target only sagas whose
-- creation principal is the changed actor; unrelated firm members do not churn
-- every entity generation.
create or replace function invalidate_entity_readiness_for_actor(
  dependency_firm_id text,
  dependency_actor_type text,
  dependency_actor_id text,
  dependency_table text,
  dependency_operation text
) returns void
  language plpgsql as $$
declare
  entity record;
begin
  if dependency_actor_id is null or dependency_actor_id = '' then
    return;
  end if;
  for entity in
    select distinct saga.firm_id, saga.client_id
      from entity_readiness_sagas saga
      join audit_events creation
        on creation.firm_id = saga.firm_id
       and creation.resource_id = saga.client_id
       and creation.action = 'client.create'
     where saga.firm_id = dependency_firm_id
       and creation.actor_type = dependency_actor_type
       and creation.actor_id = dependency_actor_id
  loop
    perform invalidate_entity_readiness_dependency(
      entity.firm_id, entity.client_id, dependency_table, dependency_operation
    );
  end loop;
end;
$$;

create or replace function invalidate_entity_readiness_from_member() returns trigger
  language plpgsql as $$
declare
  dependency_row record;
begin
  if tg_op = 'UPDATE'
     and old.firm_id is not distinct from new.firm_id
     and old.id is not distinct from new.id
     and old.status is not distinct from new.status then
    return new;
  end if;
  if tg_op = 'UPDATE'
     and (old.firm_id is distinct from new.firm_id
       or old.id is distinct from new.id) then
    perform invalidate_entity_readiness_for_actor(
      old.firm_id, 'firm_member', old.id, tg_table_name, tg_op
    );
  end if;
  if tg_op = 'DELETE' then dependency_row := old; else dependency_row := new; end if;
  perform invalidate_entity_readiness_for_actor(
    dependency_row.firm_id, 'firm_member', dependency_row.id, tg_table_name, tg_op
  );
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

drop trigger if exists firm_members_invalidate_entity_readiness on firm_members;
create trigger firm_members_invalidate_entity_readiness
  after insert or delete or update of firm_id, id, status on firm_members
  for each row execute function invalidate_entity_readiness_from_member();

create or replace function invalidate_entity_readiness_from_collaborator() returns trigger
  language plpgsql as $$
declare
  dependency_row record;
begin
  if tg_op = 'UPDATE'
     and old.firm_id is not distinct from new.firm_id
     and old.user_id is not distinct from new.user_id
     and old.role is not distinct from new.role
     and old.status is not distinct from new.status then
    return new;
  end if;
  if tg_op = 'UPDATE'
     and (old.firm_id is distinct from new.firm_id
       or old.user_id is distinct from new.user_id) then
    perform invalidate_entity_readiness_for_actor(
      old.firm_id, 'supabase_user', old.user_id, tg_table_name, tg_op
    );
  end if;
  if tg_op = 'DELETE' then dependency_row := old; else dependency_row := new; end if;
  perform invalidate_entity_readiness_for_actor(
    dependency_row.firm_id, 'supabase_user', dependency_row.user_id, tg_table_name, tg_op
  );
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

drop trigger if exists firm_collaborators_invalidate_entity_readiness on firm_collaborators;
create trigger firm_collaborators_invalidate_entity_readiness
  after insert or delete or update of firm_id, user_id, role, status on firm_collaborators
  for each row execute function invalidate_entity_readiness_from_collaborator();
