-- Deleted-client decision receipts: retained, redacted and de-linked.
--
-- Policy: docs/donna-data-lifecycle-policy.md §4/§7. Tier-1 structured
-- receipts remain firm-level audit evidence, while Tier-2/Tier-3 prose is
-- destroyed on client deletion. A retained receipt must not keep the plain
-- client_id of a deleted client: deterministic client ids are reused on
-- recreate, and that stale link makes the new Entity B birth proof see the
-- prior generation as live residue.
--
-- The de-link is a one-way, stamped, transaction-authorized transition. It
-- does not widen the ordinary annotation allow-list and cannot edit any
-- prediction field. The named client-delete writer sets the transaction-local
-- GUC only after both prose columns have been destroyed.

alter table llm_decisions
  alter column client_id drop not null;

alter table llm_decisions
  add column if not exists client_detached_at timestamptz;

create index if not exists idx_llm_decisions_client_detached
  on llm_decisions (firm_id, client_detached_at)
  where client_id is null and client_detached_at is not null;

create or replace function llm_decisions_freeze_prediction()
returns trigger as $$
declare
  allowed constant text[] := array[
    'human_outcome', 'human_outcome_at', 'reversal_metadata',
    'louis_verdict', 'louis_evaluated_at', 'resolved_at'
  ];
  raw_redaction constant boolean :=
        old.llm_raw_response is not null
    and new.llm_raw_response is null
    and old.llm_raw_response_redacted_at is null
    and new.llm_raw_response_redacted_at is not null;
  reasoning_redaction constant boolean :=
        old.llm_reasoning is not null
    and new.llm_reasoning is null
    and old.llm_reasoning_redacted_at is null
    and new.llm_reasoning_redacted_at is not null;
  client_detachment constant boolean :=
        old.client_id is not null
    and new.client_id is null
    and old.client_detached_at is null
    and new.client_detached_at is not null
    and new.llm_reasoning is null
    and new.llm_raw_response is null
    and coalesce(current_setting('donna.allow_llm_decision_client_detachment', true), '') = 'on';
  exempt text[];
begin
  exempt := allowed;
  if raw_redaction then
    exempt := exempt || array['llm_raw_response', 'llm_raw_response_redacted_at'];
  end if;
  if reasoning_redaction then
    exempt := exempt || array['llm_reasoning', 'llm_reasoning_redacted_at'];
  end if;
  if client_detachment then
    exempt := exempt || array['client_id', 'client_detached_at'];
  end if;

  if (to_jsonb(old) - exempt) is distinct from (to_jsonb(new) - exempt) then
    raise exception
      'llm_decisions is append-only (§4): prediction columns are frozen. Only annotation columns, stamped prose destruction, and the transaction-authorized stamped client de-link may change. Record a correction as a NEW superseding receipt linked via previous_decision_id.'
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$ language plpgsql;

drop trigger if exists llm_decisions_freeze_prediction_trg on llm_decisions;
create trigger llm_decisions_freeze_prediction_trg
  before update on llm_decisions
  for each row
  execute function llm_decisions_freeze_prediction();

-- Heal rows already left in the interim redacted-but-linked posture. A row is
-- prior-generation evidence when its client no longer exists, or when its
-- receipt predates the current recreated client row with the same deterministic
-- id. Current-generation rows remain linked.
update llm_decisions d
   set llm_reasoning = null,
       llm_reasoning_redacted_at = now()
 where d.client_id is not null
   and d.llm_reasoning is not null
   and d.llm_reasoning_redacted_at is null
   and (
     not exists (
       select 1 from clients c
        where c.firm_id = d.firm_id and c.id = d.client_id
     )
     or exists (
       select 1 from clients c
        where c.firm_id = d.firm_id and c.id = d.client_id
          and (d.created_at is null or d.created_at < c.created_at)
     )
   );

update llm_decisions d
   set llm_raw_response = null,
       llm_raw_response_redacted_at = now()
 where d.client_id is not null
   and d.llm_raw_response is not null
   and d.llm_raw_response_redacted_at is null
   and (
     not exists (
       select 1 from clients c
        where c.firm_id = d.firm_id and c.id = d.client_id
     )
     or exists (
       select 1 from clients c
        where c.firm_id = d.firm_id and c.id = d.client_id
          and (d.created_at is null or d.created_at < c.created_at)
     )
   );

select set_config('donna.allow_llm_decision_client_detachment', 'on', true);

update llm_decisions d
   set client_id = null,
       client_detached_at = now()
 where d.client_id is not null
   and d.client_detached_at is null
   and d.llm_reasoning is null
   and d.llm_raw_response is null
   and (
     not exists (
       select 1 from clients c
        where c.firm_id = d.firm_id and c.id = d.client_id
     )
     or exists (
       select 1 from clients c
        where c.firm_id = d.firm_id and c.id = d.client_id
          and (d.created_at is null or d.created_at < c.created_at)
     )
   );

-- Receipt the rows that actually completed the stamped transition, not the
-- candidate estimate. now()/transaction_timestamp() is stable for the whole
-- migration transaction, and client_detached_at was null on every row when the
-- column was added above.
insert into audit_events
  (firm_id, client_id, actor_type, actor_id, action, resource_type, resource_id, metadata)
select d.firm_id,
       null,
       'system',
       'migration129LlmDecisionDetachment',
       'llm_decision.client_detachment_backfill',
       'llm_decisions',
       d.firm_id,
       jsonb_build_object(
         'contract_version', 'donna.llm-decision-client-detachment.v1',
         'detached_receipts', count(*)::integer,
         'authority_basis', 'migration_129_existing_deleted_or_recreated_client_collision'
       )
  from llm_decisions d
 where d.client_id is null
   and d.client_detached_at = transaction_timestamp()
 group by d.firm_id;
