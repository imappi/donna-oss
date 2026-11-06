-- F-23 / F-24 / F-25 (2026-09-29): native-review dependency marks become
-- CLIENT-scoped, de-duplicated across unsettled rows, and non-native clients
-- stop paying for them. mark_native_review_sources stays the single owner.
--
-- Measured on a 10,000-transaction native client (PG16): one document insert
-- minted 10,000 transaction marks (91 ms) and a second minted 10,000 more (dedupe
-- was per-xid only); settling one 500-mark page took 19.7 s because every mark
-- re-read a 65-row transaction window and a 65-row document window. The
-- PERSISTED verdict never reads those windows: deriveConvergenceState consumes
-- only processingScope.enforced / reason_code, which are client-level facts
-- (lineage, registration chain, chart contract). Row-level inputs are already
-- marked by the 137 triggers for every client. So:
--   * scope events (clients, ledger_accounts, audit birth/delete rows, the
--     registration source document) mint ONE 'native_review_scope' mark: the
--     settle re-derives the client's rows verdict-only;
--   * every other source change mints ONE 'native_review_source' mark: it keeps
--     the projection honestly "pending" until settled and derives nothing;
--   * a mark is skipped while an unsettled one of the same client and strength
--     is visible (no unique index: an ON CONFLICT would make concurrent writers
--     of one client wait for each other's commit).
-- The statement trigger now discovers the statement's distinct (firm, client)
-- scopes from the raw transition tables and returns before any to_jsonb /
-- projection work unless one of them is native (F-25).
--
-- DEPLOY RUNBOOK (safe whether or not 155-157 already ran; idempotent):
--  1. audit_events is large on the hosted DB: BEFORE deploying, run by hand
--       create index concurrently if not exists audit_events_firm_resource_action_idx
--         on audit_events (firm_id, resource_id, action, id);
--     (outside a transaction). This file and 156/157 then no-op that statement.
--  2. If 156 already ran with its old backfill, convergence_marks may hold
--     millions of per-transaction 'native_review_source' rows. This file
--     converts them to one client mark each and deletes them (row locks only,
--     never blocks writers). To keep the migration short, delete them by hand
--     first, in batches:
--       delete from convergence_marks where id in (select id from convergence_marks
--         where source='native_review_source' and target_type='transaction' limit 50000);
--     repeat until 0 rows; the migration then only creates the client marks.
--  3. The only ACCESS EXCLUSIVE step is the constraint swap on convergence_marks
--     (a few ms once the table is small); it runs under lock_timeout 5s and, if it
--     cannot get the lock, fails the deploy cleanly for a retry.
-- ROLLBACK: functions/triggers are create-or-replace; restore 156's bodies from
-- git and delete from convergence_marks where target_type='client'.

set local lock_timeout = '5s';

create index if not exists audit_events_firm_resource_action_idx
  on audit_events (firm_id, resource_id, action, id);

-- Registration source document join used by the documents trigger.
create index if not exists clients_gst_registration_source_document_idx
  on clients (firm_id, (profile->'gst_registration'->>'source_document_id'))
  where profile->'gst_registration'->>'source_document_id' is not null;

-- 1. Convert legacy per-transaction native marks (row locks only).
create temporary table native_legacy_clients on commit drop as
  select distinct firm_id, client_id from convergence_marks
   where source = 'native_review_source' and target_type = 'transaction' and client_id is not null;
delete from convergence_marks where source = 'native_review_source' and target_type = 'transaction';

-- 2. Admit the client target type (table is small now).
alter table convergence_marks drop constraint if exists convergence_marks_target_type_check;
alter table convergence_marks add constraint convergence_marks_target_type_check
  check (target_type in ('transaction', 'document', 'client'));

create index if not exists convergence_marks_client_scope_idx
  on convergence_marks (firm_id, client_id, source) where target_type = 'client';

-- Collapse any duplicate unsettled client marks (idempotent re-runs).
delete from convergence_marks m using (
  select id, row_number() over (partition by firm_id, client_id, source order by id) rn
    from convergence_marks where target_type = 'client'
) d where m.id = d.id and d.rn > 1;

insert into convergence_marks (firm_id, client_id, target_type, target_id, source)
  select l.firm_id, l.client_id, 'client', l.client_id, 'native_review_scope' from native_legacy_clients l
   where not exists (select 1 from convergence_marks m where m.firm_id = l.firm_id and m.client_id = l.client_id
     and m.target_type = 'client' and m.source = 'native_review_scope');

-- 3. The single owner.
create or replace function native_review_eligible_scopes(affected jsonb)
returns table(firm_id text, client_id text, scope boolean) language sql stable as $$
  with scopes as materialized (
    select s.firm_id, s.client_id, bool_or(coalesce(s.old_marker,false)) old_marker, bool_or(coalesce(s.scope,false)) scope
    from jsonb_to_recordset(affected) as s(firm_id text,client_id text,old_marker boolean,scope boolean)
    where s.firm_id is not null and s.client_id is not null group by s.firm_id,s.client_id
  )
  select s.firm_id, s.client_id, s.scope from scopes s
  join clients c on c.firm_id=s.firm_id and c.id=s.client_id
  where s.old_marker or exists (
    select 1 from audit_events a where a.firm_id=s.firm_id and a.resource_id=s.client_id
      and a.id > coalesce((select max(d.id) from audit_events d
        where d.firm_id=s.firm_id and d.resource_id=s.client_id and d.action='client.delete'),0)
      and ((a.action='ledger.chart.palette_seeded' and a.metadata ? 'birth_contract')
        or (a.action='client.create' and a.metadata ? 'native_chart_birth'))
  ) or exists (select 1 from ledger_accounts a where a.firm_id=s.firm_id
    and a.client_id=s.client_id and a.payload ? 'birth_contract')
$$;

create or replace function mark_native_review_sources(affected jsonb)
returns void language sql volatile as $$
  insert into convergence_marks(firm_id,client_id,target_type,target_id,source,marked_xid)
    select e.firm_id,e.client_id,'client',e.client_id,
      case when e.scope then 'native_review_scope' else 'native_review_source' end, pg_current_xact_id()
    from native_review_eligible_scopes(affected) e
    -- A client with no transactions owes nothing to re-derive (the old fan-out
    -- minted zero marks for it too): a freshly born native book carries no
    -- mark, which the birth residue proof relies on.
    where exists (select 1 from transactions t where t.firm_id=e.firm_id and t.client_id=e.client_id)
      and not exists (select 1 from convergence_marks m
      where m.firm_id=e.firm_id and m.client_id=e.client_id and m.target_type='client'
        and (m.source='native_review_scope' or (not e.scope and m.source='native_review_source')))
    order by e.firm_id,e.client_id
$$;

-- SQL text that yields the statement's distinct affected scopes as jsonb.
-- Only column references: no row is converted to jsonb here.
create or replace function native_review_scopes_sql(tbl text, src text)
returns text language plpgsql immutable as $$
declare
  cid text := case when tbl='clients' then 'id' else 'client_id' end;
  marker text := case tbl
    when 'ledger_accounts' then $m$coalesce(payload ? 'birth_contract',false)$m$
    when 'audit_events' then $m$(coalesce(metadata ? 'birth_contract',false) or coalesce(metadata ? 'native_chart_birth',false))$m$
    else 'false' end;
  keep text := case when tbl='audit_events'
    then $m$action in ('client.create','client.delete','ledger.chart.palette_seeded')$m$ else 'true' end;
  scope_table text := (tbl in ('clients','ledger_accounts','audit_events'))::text;
  registration text := case when tbl='documents' then $m$
    union all
    select c.firm_id,c.id,false,true from (select distinct firm_id,id from r) d
      join clients c on c.firm_id=d.firm_id and c.profile->'gst_registration'->>'source_document_id'=d.id$m$ else '' end;
begin
  return format($q$
    with r as materialized (%s)
    select coalesce(jsonb_agg(jsonb_build_object('firm_id',firm_id,'client_id',client_id,
      'old_marker',old_marker,'scope',scope)),'[]'::jsonb)
    from (select firm_id,client_id,bool_or(old_marker) old_marker,bool_or(scope) scope from (
      select firm_id,%I client_id,%s old_marker,%s scope from r
        where %s and firm_id is not null and %I is not null
      %s) s group by firm_id,client_id) g$q$, src, cid, marker, scope_table, keep, cid, registration);
end $$;

create or replace function native_review_source_statement()
returns trigger language plpgsql as $$
declare affected jsonb; eligible jsonb;
begin
  execute native_review_scopes_sql(TG_TABLE_NAME, case TG_OP
    when 'INSERT' then 'select * from native_new' when 'DELETE' then 'select * from native_old'
    else 'select * from native_old union all select * from native_new' end) into affected;
  if jsonb_array_length(affected)=0 then return null; end if;
  -- F-25: a statement that touches no native client stops here, before any
  -- to_jsonb / projection comparison.
  select coalesce(jsonb_agg(to_jsonb(e)),'[]'::jsonb) into eligible from native_review_eligible_scopes(affected) e;
  if jsonb_array_length(eligible)=0 then return null; end if;
  if TG_OP='UPDATE' then
    execute native_review_scopes_sql(TG_TABLE_NAME, format($q$
      with changed as materialized (
        select coalesce(o.id,n.id) id from native_old o full join native_new n on n.id=o.id
        where native_review_source_projection(%L,to_jsonb(o)) is distinct from
          native_review_source_projection(%L,to_jsonb(n)))
      select * from native_old where id in (select id from changed)
      union all select * from native_new where id in (select id from changed)$q$,TG_TABLE_NAME,TG_TABLE_NAME)) into affected;
    if jsonb_array_length(affected)=0 then return null; end if;
  end if;
  perform mark_native_review_sources(affected);
  return null;
end $$;

-- 4. Idempotent backfill: one scope mark per native client (skipped where an
-- unsettled scope mark exists, so a re-run mints nothing).
select mark_native_review_sources(coalesce(jsonb_agg(jsonb_build_object(
  'firm_id',firm_id,'client_id',id,'old_marker',false,'scope',true)),'[]'::jsonb)) from clients;
