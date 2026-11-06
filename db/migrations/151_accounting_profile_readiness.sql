-- U01-S1: separate accounting view and cash/accrual declarations. Key presence
-- is certificate-bearing: explicit null must not revive a legacy/default fact.
-- Same existing invalidator, advisory key and append-only audit receipt.
create or replace function invalidate_entity_readiness_from_client() returns trigger
  language plpgsql as $$
begin
  if old.jurisdiction is not distinct from new.jurisdiction
     and old.entity_type is not distinct from new.entity_type
     and old.status is not distinct from new.status
     and old.uen is not distinct from new.uen
     and old.profile->'jurisdiction' is not distinct from new.profile->'jurisdiction'
     and old.profile->'entityType' is not distinct from new.profile->'entityType'
     and old.profile->'accounting_system' is not distinct from new.profile->'accounting_system'
     and old.profile->'accounting_view' is not distinct from new.profile->'accounting_view'
     and old.profile->'accountingView' is not distinct from new.profile->'accountingView'
     and old.profile->'accountingBasis' is not distinct from new.profile->'accountingBasis'
     and old.profile->'accounting_basis' is not distinct from new.profile->'accounting_basis'
     and old.profile->'bookBasis' is not distinct from new.profile->'bookBasis'
     and old.profile->'accountingCurrency' is not distinct from new.profile->'accountingCurrency'
     and old.profile->'baseCurrency' is not distinct from new.profile->'baseCurrency'
     and old.profile->'defaultCurrency' is not distinct from new.profile->'defaultCurrency'
     and old.profile->'default_currency' is not distinct from new.profile->'default_currency'
     and old.profile->'currency' is not distinct from new.profile->'currency'
     and old.profile->'email' is not distinct from new.profile->'email' then
    return new;
  end if;
  perform invalidate_entity_readiness_dependency(new.firm_id, new.id, tg_table_name, tg_op);
  return new;
end;
$$;

-- Old certificates did not bind the method or explicit view. Re-observe through
-- the existing bounded recovery consumer; never rewrite a receipt or grant.
do $$
declare target record;
begin
  for target in select firm_id, client_id from entity_readiness_sagas
    where state = 'ready' and certificate_version <> 'donna.entity-certificate-b.v3'
    order by firm_id, client_id
  loop
    perform invalidate_entity_readiness_dependency(target.firm_id, target.client_id,
      'accounting_profile_contract', 'UPDATE');
  end loop;
end;
$$;
