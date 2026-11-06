-- F-24 (2026-09-29): the audit_events (firm_id, resource_id, action, id) index
-- is created FIRST, before any trigger or backfill in this file, so the marker
-- probe every statement trigger below runs is index-served from the first row.
-- It is the same idempotent statement as migration 157 (which remains as a
-- no-op). Runbook: on a large hosted audit_events, run by hand BEFORE deploying
--   create index concurrently if not exists audit_events_firm_resource_action_idx
--     on audit_events (firm_id, resource_id, action, id);
-- (outside a transaction); this statement then no-ops. Migration 158 owns the
-- native-review backfill (client-scoped, idempotent); this file mints nothing.
create index if not exists audit_events_firm_resource_action_idx
  on audit_events (firm_id, resource_id, action, id);

-- C4a: dependency invalidation only. Existing convergence_marks and the JS
-- projector remain the owners. A retained marker requests verified rereading;
-- this SQL never grants processing scope, posting authority or completion.
-- Measured PG17 plan without this non-unique lookup scanned 2,004 unrelated
-- marks for each of 1,001 targets. This only indexes this helper's own source.
create index if not exists convergence_marks_native_source_xid
  on convergence_marks(firm_id,client_id,marked_xid,target_type,target_id)
  where source='native_review_source';

create or replace function native_review_source_projection(kind text, row_value jsonb)
returns jsonb language sql immutable as $$
  select case when kind = 'transactions' then
    (row_value - array['convergence_state','convergence_reason','convergence_as_of','updated_at',
      'coding_state','category','account_code','account_name','tax_type','tax_treatment'])
    || jsonb_build_object('payload', case when jsonb_typeof(row_value->'payload')='object' then (row_value->'payload') - array[
      'review_scope','ai_suggestion','ai_suggestion_status','native_choice','native_source',
      'accepted_coding_policy','coding_policy','coding_evidence','coding_correction_required',
      'ledger_post_refusal','posting_recovery','account_id','account_code','account_name',
      'account_label','category','tax_type','tax_treatment','xero_tax_type','xero_account_code']
      else row_value->'payload' end)
    else row_value - array['convergence_state','convergence_reason','convergence_as_of','updated_at'] end
$$;

create or replace function mark_native_review_sources(affected jsonb)
returns void language sql volatile as $$
  with scopes as materialized (
    select firm_id, client_id, bool_or(old_marker) old_marker
    from jsonb_to_recordset(affected) as s(firm_id text,client_id text,old_marker boolean)
    where firm_id is not null and client_id is not null group by firm_id,client_id
  ), eligible as materialized (
    select s.firm_id,s.client_id from scopes s
    join clients c on c.firm_id=s.firm_id and c.id=s.client_id
    where s.old_marker or exists (
      select 1 from audit_events a where a.firm_id=s.firm_id and a.resource_id=s.client_id
        and a.id > coalesce((select max(d.id) from audit_events d
          where d.firm_id=s.firm_id and d.resource_id=s.client_id and d.action='client.delete'),0)
        and ((a.action='ledger.chart.palette_seeded' and a.metadata ? 'birth_contract')
          or (a.action='client.create' and a.metadata ? 'native_chart_birth'))
    ) or exists (select 1 from ledger_accounts a where a.firm_id=s.firm_id
      and a.client_id=s.client_id and a.payload ? 'birth_contract')
  ), existing as materialized (
    select m.firm_id,m.client_id,m.target_id from convergence_marks m
      join scopes s on s.firm_id=m.firm_id and s.client_id=m.client_id
    where m.source='native_review_source' and m.target_type='transaction'
      and m.marked_xid=pg_current_xact_id()
  )
  insert into convergence_marks(firm_id,client_id,target_type,target_id,source,marked_xid)
    select t.firm_id,t.client_id,'transaction',t.id,'native_review_source',pg_current_xact_id()
    from eligible e join transactions t on t.firm_id=e.firm_id and t.client_id=e.client_id
    where not exists (select 1 from existing m where m.firm_id=t.firm_id
      and m.client_id=t.client_id and m.target_id=t.id)
$$;

-- A transition table is scanned once per statement. Distinct scopes are
-- materialized before target fan-out; imports do not scan N targets M times.
create or replace function native_review_source_statement()
returns trigger language plpgsql as $$
declare changed_sql text; affected jsonb;
begin
  if TG_OP='INSERT' then
    changed_sql := 'select to_jsonb(n) row_value from native_new n';
  elsif TG_OP='DELETE' then
    changed_sql := 'select to_jsonb(o) row_value from native_old o';
  else
    changed_sql := format($q$
      with changed as materialized (
        select to_jsonb(o) old_row,to_jsonb(n) new_row from native_old o
        full join native_new n on n.id=o.id
        where native_review_source_projection(%L,to_jsonb(o)) is distinct from
          native_review_source_projection(%L,to_jsonb(n))
      ) select old_row row_value from changed where old_row is not null
        union all select new_row from changed where new_row is not null$q$,TG_TABLE_NAME,TG_TABLE_NAME);
  end if;
  execute format($q$
    with changed as materialized (%s), relevant as materialized (
      select row_value from changed where %L <> 'audit_events'
        or row_value->>'action' in ('client.create','client.delete','ledger.chart.palette_seeded')
    ), scopes as (
      select row_value->>'firm_id' firm_id,
        case when %L='clients' then row_value->>'id' else row_value->>'client_id' end client_id,
        (%L='ledger_accounts' and coalesce(row_value->'payload' ? 'birth_contract',false))
          or (%L='audit_events' and (coalesce(row_value->'metadata' ? 'birth_contract',false)
            or coalesce(row_value->'metadata' ? 'native_chart_birth',false))) old_marker
      from relevant
      union all
      select c.firm_id,c.id,false from relevant r join clients c
        on %L='documents' and c.firm_id=r.row_value->>'firm_id'
        and c.profile->'gst_registration'->>'source_document_id'=r.row_value->>'id'
    ) select coalesce(jsonb_agg(to_jsonb(s)),'[]'::jsonb) from
      (select firm_id,client_id,bool_or(old_marker) old_marker from scopes group by firm_id,client_id) s$q$,
    changed_sql,TG_TABLE_NAME,TG_TABLE_NAME,TG_TABLE_NAME,TG_TABLE_NAME,TG_TABLE_NAME)
    into affected;
  if jsonb_array_length(affected)>0 then perform mark_native_review_sources(affected); end if;
  return null;
end $$;

do $$ declare table_name text;
begin
  foreach table_name in array array['clients','transactions','documents','document_lines',
    'reconciliation_matches','document_obligations','ledger_journals','client_evidence_requests',
    'ledger_accounts','audit_events'] loop
    execute format('drop trigger if exists native_review_insert on %I',table_name);
    execute format('drop trigger if exists native_review_update on %I',table_name);
    execute format('drop trigger if exists native_review_delete on %I',table_name);
    execute format('create trigger native_review_insert after insert on %I referencing new table as native_new for each statement execute function native_review_source_statement()',table_name);
    execute format('create trigger native_review_update after update on %I referencing old table as native_old new table as native_new for each statement execute function native_review_source_statement()',table_name);
    execute format('create trigger native_review_delete after delete on %I referencing old table as native_old for each statement execute function native_review_source_statement()',table_name);
  end loop;
end $$;

-- (F-24) The one-mark-per-transaction backfill that stood here moved to migration 158,
-- which replaces the mark function and mints ONE client-scoped mark per native client.
