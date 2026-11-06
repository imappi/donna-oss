-- Read-only, schema-only cloud readiness input. Export the single JSON cell.
-- No customer rows or credentials are selected. This is evidence, not a PASS.
with app_relations as (
  select c.* from pg_class c join pg_namespace n on n.oid=c.relnamespace
  where n.nspname='public' and c.relkind in ('r','p','v','m','S','c','f')
    and not exists(select 1 from pg_depend d where d.classid='pg_class'::regclass and d.objid=c.oid and d.deptype='e')
), items as (
  select 'relation'::text kind,c.relname::text name,jsonb_build_object(
    'kind',c.relkind,'rls',c.relrowsecurity,'force_rls',c.relforcerowsecurity,
    'options',c.reloptions,'persistence',c.relpersistence,
    'partition_key',case when c.relkind='p' then pg_get_partkeydef(c.oid) end,
    'partition_bound',pg_get_expr(c.relpartbound,c.oid),
    'view',case when c.relkind in ('v','m') then pg_get_viewdef(c.oid,false) end) definition
  from app_relations c
  union all
  select 'column',c.relname||'.'||a.attname,jsonb_build_object(
    'position',a.attnum,'type',format_type(a.atttypid,a.atttypmod),'not_null',a.attnotnull,
    'identity',a.attidentity,'generated',a.attgenerated,'default',pg_get_expr(d.adbin,d.adrelid),
    'collation',case when a.attcollation<>0 then a.attcollation::regcollation::text end)
  from app_relations c join pg_attribute a on a.attrelid=c.oid and a.attnum>0 and not a.attisdropped
  left join pg_attrdef d on d.adrelid=c.oid and d.adnum=a.attnum
  union all
  select 'column_grant',c.relname||'.'||a.attname||'.'||case when g.grantee=0 then 'PUBLIC' else pg_get_userbyid(g.grantee) end||'.'||g.privilege_type,
    jsonb_build_object('grantable',g.is_grantable,'grantor',pg_get_userbyid(g.grantor),
      'grantee',case when g.grantee=0 then 'PUBLIC' else pg_get_userbyid(g.grantee) end,'privilege',g.privilege_type,'object',c.relname||'.'||a.attname)
  from app_relations c join pg_attribute a on a.attrelid=c.oid and a.attnum>0 and not a.attisdropped
  cross join lateral aclexplode(a.attacl) g
  union all
  select 'constraint',c.relname||'.'||k.conname,jsonb_build_object('type',k.contype,
    'validated',k.convalidated,'definition',pg_get_constraintdef(k.oid,false))
  from app_relations c join pg_constraint k on k.conrelid=c.oid
  union all
  select 'index',c.relname||'.'||ic.relname,jsonb_build_object('definition',pg_get_indexdef(i.indexrelid),
    'valid',i.indisvalid,'ready',i.indisready,'unique',i.indisunique)
  from app_relations c join pg_index i on i.indrelid=c.oid join pg_class ic on ic.oid=i.indexrelid
  union all
  select 'trigger',c.relname||'.'||t.tgname,jsonb_build_object('definition',pg_get_triggerdef(t.oid,false),'enabled',t.tgenabled)
  from app_relations c join pg_trigger t on t.tgrelid=c.oid where not t.tgisinternal
  union all
  select 'rule',c.relname||'.'||r.rulename,jsonb_build_object('definition',pg_get_ruledef(r.oid,false),'enabled',r.ev_enabled)
  from app_relations c join pg_rewrite r on r.ev_class=c.oid where r.rulename <> '_RETURN'
  union all
  select 'function',p.oid::regprocedure::text,jsonb_build_object('definition',pg_get_functiondef(p.oid),
    'security_definer',p.prosecdef,'return_type',format_type(p.prorettype,null),'config',p.proconfig,'owner',pg_get_userbyid(p.proowner))
  from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='public' and p.prokind in ('f','p')
    and not exists(select 1 from pg_depend d where d.classid='pg_proc'::regclass and d.objid=p.oid and d.deptype='e')
  union all
  select 'policy',c.relname||'.'||p.polname,jsonb_build_object('command',p.polcmd,'permissive',p.polpermissive,
    'roles',(select jsonb_agg(case when r=0 then 'PUBLIC' else pg_get_userbyid(r) end order by r) from unnest(p.polroles) r),
    'using',pg_get_expr(p.polqual,p.polrelid),'check',pg_get_expr(p.polwithcheck,p.polrelid))
  from app_relations c join pg_policy p on p.polrelid=c.oid
  union all
  select 'grant',c.relname||'.'||case when g.grantee=0 then 'PUBLIC' else pg_get_userbyid(g.grantee) end||'.'||g.privilege_type,
    jsonb_build_object('grantable',g.is_grantable,'grantor',pg_get_userbyid(g.grantor),
      'grantee',case when g.grantee=0 then 'PUBLIC' else pg_get_userbyid(g.grantee) end,'privilege',g.privilege_type,'object',c.relname)
  from app_relations c cross join lateral aclexplode(coalesce(c.relacl,acldefault(case when c.relkind='S' then 'S'::"char" else 'r'::"char" end,c.relowner))) g
  union all
  select 'function_grant',p.oid::regprocedure::text||'.'||case when g.grantee=0 then 'PUBLIC' else pg_get_userbyid(g.grantee) end||'.'||g.privilege_type,
    jsonb_build_object('grantable',g.is_grantable,'grantor',pg_get_userbyid(g.grantor),
      'grantee',case when g.grantee=0 then 'PUBLIC' else pg_get_userbyid(g.grantee) end,'privilege',g.privilege_type,'object',p.oid::regprocedure::text)
  from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  cross join lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) g
  where n.nspname='public' and not exists(select 1 from pg_depend d where d.classid='pg_proc'::regclass and d.objid=p.oid and d.deptype='e')
  union all
  select 'sequence',c.relname,jsonb_build_object('type',format_type(s.seqtypid,null),'start',s.seqstart::text,'increment',s.seqincrement::text,
    'min',s.seqmin::text,'max',s.seqmax::text,'cache',s.seqcache::text,'cycle',s.seqcycle)
  from app_relations c join pg_sequence s on s.seqrelid=c.oid
  union all
  select 'enum',t.typname,jsonb_build_object('labels',jsonb_agg(e.enumlabel order by e.enumsortorder))
  from pg_type t join pg_namespace n on n.oid=t.typnamespace join pg_enum e on e.enumtypid=t.oid
  where n.nspname='public' group by t.typname
  union all
  select 'domain',t.typname,jsonb_build_object('base_type',format_type(t.typbasetype,t.typtypmod),
    'not_null',t.typnotnull,'default',t.typdefault,
    'constraints',(select jsonb_agg(pg_get_constraintdef(k.oid,false) order by k.conname) from pg_constraint k where k.contypid=t.oid))
  from pg_type t join pg_namespace n on n.oid=t.typnamespace where n.nspname='public' and t.typtype='d'
  union all
  select 'extension',e.extname,jsonb_build_object('version',e.extversion,'schema',n.nspname)
  from pg_extension e join pg_namespace n on n.oid=e.extnamespace
  union all
  -- No public object can disappear merely by becoming an extension member.
  select 'public_extension_member',i.type||':'||i.identity,jsonb_build_object('extension',e.extname,'object_type',i.type,'identity',i.identity)
  from pg_depend d join pg_extension e on e.oid=d.refobjid
  cross join lateral pg_identify_object(d.classid,d.objid,d.objsubid) i
  where d.refclassid='pg_extension'::regclass and d.deptype='e' and i.schema='public'
  union all
  select 'event_trigger',e.evtname,jsonb_build_object('event',e.evtevent,'enabled',e.evtenabled,
    'tags',e.evttags,'function',e.evtfoid::regprocedure::text,'owner',pg_get_userbyid(e.evtowner))
  from pg_event_trigger e join pg_proc p on p.oid=e.evtfoid join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='public'
  union all
  select 'schema_grant',case when g.grantee=0 then 'PUBLIC' else pg_get_userbyid(g.grantee) end||'.'||g.privilege_type,
    jsonb_build_object('grantable',g.is_grantable,'grantor',pg_get_userbyid(g.grantor),
      'grantee',case when g.grantee=0 then 'PUBLIC' else pg_get_userbyid(g.grantee) end,'privilege',g.privilege_type,'object','public')
  from pg_namespace n cross join lateral aclexplode(coalesce(n.nspacl,acldefault('n',n.nspowner))) g
  where n.nspname='public'
)
select jsonb_build_object('version','donna.cloud-schema-catalog.v3','observed_at',clock_timestamp(),
  'server_version_num',current_setting('server_version_num')::integer,
  'database_name',current_database(),
  'browser_roles',(select jsonb_agg(jsonb_build_object('name',b.rolname,'superuser',b.rolsuper,
    'bypass_rls',b.rolbypassrls,'create_role',b.rolcreaterole,'create_database',b.rolcreatedb,
    'memberships',coalesce((select jsonb_agg(r.rolname order by r.rolname) from pg_roles r
      where r.oid<>b.oid and pg_has_role(b.oid,r.oid,'MEMBER')),'[]'::jsonb),
    'privileged_membership',exists(select 1 from pg_roles r where (r.rolsuper or r.rolbypassrls or r.rolcreaterole)
      and pg_has_role(b.oid,r.oid,'MEMBER'))) order by b.rolname) from pg_roles b where b.rolname in ('anon','authenticated')),
  'migrations',(select jsonb_agg(version order by version) from schema_migrations),
  'storage_security',(select jsonb_agg(jsonb_build_object('name',c.relname,'kind',c.relkind,
    'rls',c.relrowsecurity,'force_rls',c.relforcerowsecurity,
    'browser_owner',exists(select 1 from pg_roles b where b.rolname in ('anon','authenticated') and pg_has_role(b.oid,c.relowner,'MEMBER')),
    'policies',coalesce((select jsonb_agg(jsonb_build_object('name',p.polname,'command',p.polcmd,'permissive',p.polpermissive,
      'roles',(select jsonb_agg(role_name order by role_name) from (select case when r=0 then 'PUBLIC' else pg_get_userbyid(r) end role_name from unnest(p.polroles) r) names),
      'using',pg_get_expr(p.polqual,p.polrelid),'check',pg_get_expr(p.polwithcheck,p.polrelid)) order by p.polname)
      from pg_policy p where p.polrelid=c.oid),'[]'::jsonb)) order by c.relname)
    from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='storage' and c.relname in ('objects','buckets')),
  'private_storage',(select jsonb_agg(jsonb_build_object('id',id,'public',public) order by id) from storage.buckets where id='donna-evidence'),
  'objects',(select jsonb_agg(jsonb_build_object('kind',kind,'name',name,'definition',definition) order by kind,name) from items)
) as cloud_schema_catalog;
