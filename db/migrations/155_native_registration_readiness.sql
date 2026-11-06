-- SG-3C3: registration is a dependency only of an existing current-life native
-- birth. Preserve the same invalidator, lock order and non-native predicate.
-- No global recertification, reseed, capability or tax-authority change.
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
     and old.profile->'email' is not distinct from new.profile->'email'
     and (
       (old.profile->'gst_registration' is not distinct from new.profile->'gst_registration'
        and old.profile->'gst_registration_revision' is not distinct from new.profile->'gst_registration_revision')
       or not exists (
         select 1 from audit_events birth
          where birth.firm_id=new.firm_id and birth.client_id=new.id
            and birth.action='ledger.chart.palette_seeded'
            and birth.metadata->>'birth_contract'='sg_pte_native.v1'
            and birth.metadata->'client_life'->>'created_at'=to_char(new.created_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
            and birth.id>coalesce((select max(deletion.id) from audit_events deletion
              where deletion.firm_id=new.firm_id and deletion.client_id=new.id and deletion.action='client.delete'),0)
       )
     ) then
    return new;
  end if;
  perform invalidate_entity_readiness_dependency(new.firm_id, new.id, tg_table_name, tg_op);
  return new;
end;
$$;
