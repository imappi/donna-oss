-- Migration 032 — lock down public-schema table access (RLS-native).
--
-- Closes the Supabase Security Advisor `rls_disabled_in_public` finding. Every
-- table in the `public` schema is reachable through Supabase's auto-generated
-- PostgREST API via the browser roles `anon` / `authenticated` unless RLS is
-- enabled. Donna's browser uses Supabase for Auth + Storage ONLY — it never
-- queries application tables through PostgREST (there are zero supabase-js
-- `.from(...)` calls in src/); all firm/client/accounting data flows through
-- the server's owner connection (DATABASE_URL), which is RLS-exempt. So the
-- correct posture is a blanket lockdown with NO browser data policies.
--
-- Same RLS-native posture as 033/034:
--   * ENABLE (not FORCE) row level security — the table-owner server role stays
--     exempt; the browser roles get nothing back.
--   * REVOKE ALL ... FROM anon, authenticated — defense in depth (PostgREST
--     can't even see the table), role-guarded so a dev DB without those roles
--     still applies cleanly.
--   * NO `create policy` for anon/authenticated — adding one would re-open the
--     very API path this migration closes.
--
-- DYNAMIC, not a frozen table list. §1 scans pg_class / pg_namespace at apply
-- time, so it covers whatever public tables exist when it runs — robust against
-- migration-order churn:
--   * On a FRESH db it sorts before 033/034, so it locks 001–031 and the §2
--     event trigger backstops 033/034 as they create their tables.
--   * On the EXISTING prod db (033/034 already applied), the scan simply
--     includes them and `enable row level security` is idempotent.
-- Either way the union is covered.
--
-- This migration adds no columns and no server module reads it; it is pure
-- Keep-layer security scaffolding (a correctness invariant), not intelligence.

-- ── 1. Lock down every EXISTING public table (dynamic scan) ─────────────────
do $$
declare
  rel record;
  has_anon boolean := exists (select 1 from pg_roles where rolname = 'anon');
  has_auth boolean := exists (select 1 from pg_roles where rolname = 'authenticated');
begin
  for rel in
    select c.oid::regclass as ident
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relkind in ('r', 'p')          -- ordinary + partitioned tables only
    order by c.oid
  loop
    begin
      execute format('alter table %s enable row level security', rel.ident);
      if has_anon then
        execute format('revoke all on %s from anon', rel.ident);
      end if;
      if has_auth then
        execute format('revoke all on %s from authenticated', rel.ident);
      end if;
    exception when others then
      -- A public table this migration role does not own (e.g. an extension's
      -- spatial_ref_sys) must NOT sink the lockdown of every other table.
      raise notice '032: skipped %: %', rel.ident, sqlerrm;
    end;
  end loop;

  -- Sequences are reachable through the same generated API; pull them too.
  begin
    if has_anon then
      execute 'revoke all on all sequences in schema public from anon';
    end if;
    if has_auth then
      execute 'revoke all on all sequences in schema public from authenticated';
    end if;
  exception when others then
    raise notice '032: sequence revoke skipped: %', sqlerrm;
  end;
end $$;

-- ── 2. Future-guard: auto-lock any NEW public table (best-effort backstop) ──
-- The PRIMARY guard remains the per-migration RLS block (the 033/034 pattern);
-- this trigger is a backstop so a future `create table public.x` that forgets
-- its RLS block can't silently re-open the PostgREST path.
--
-- Caveat: CREATE EVENT TRIGGER requires superuser. Supabase's migration role
-- is not a superuser, so on the live project the trigger creation is SKIPPED
-- (the DO block below catches the privilege error and raises a NOTICE). The §1
-- static lockdown still applies, and the per-migration RLS convention keeps new
-- tables covered — the security posture holds either way. Re-attach the trigger
-- by hand (as a superuser) if you want the backstop live on prod.
create or replace function donna_lock_down_new_public_table()
  returns event_trigger
  language plpgsql
  security definer
  set search_path = pg_catalog, pg_temp
as $fn$
declare
  obj record;
  has_anon boolean := exists (select 1 from pg_roles where rolname = 'anon');
  has_auth boolean := exists (select 1 from pg_roles where rolname = 'authenticated');
begin
  for obj in
    select object_identity
    from pg_event_trigger_ddl_commands()
    where command_tag in ('CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO')
      and schema_name = 'public'
      and object_type = 'table'
  loop
    begin
      execute format('alter table %s enable row level security', obj.object_identity);
      if has_anon then
        execute format('revoke all on %s from anon', obj.object_identity);
      end if;
      if has_auth then
        execute format('revoke all on %s from authenticated', obj.object_identity);
      end if;
    exception when others then
      -- Never block a legitimate CREATE: a table this trigger can't own is
      -- logged and skipped, not failed.
      raise notice 'donna_lock_down_new_public_table skipped %: %', obj.object_identity, sqlerrm;
    end;
  end loop;
end;
$fn$;

-- The future-guard must not be browser/API-invokable.
revoke all on function donna_lock_down_new_public_table() from public;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on function donna_lock_down_new_public_table() from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on function donna_lock_down_new_public_table() from authenticated;
  end if;
end $$;

-- Attach the backstop where privileges allow; skip cleanly where they don't, so
-- the §1 lockdown above can never fail to apply because of the trigger.
do $$
begin
  execute 'drop event trigger if exists donna_lock_down_new_public_table_trg';
  execute $et$
    create event trigger donna_lock_down_new_public_table_trg
      on ddl_command_end
      when tag in ('CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO')
      execute function donna_lock_down_new_public_table()
  $et$;
exception
  when insufficient_privilege then
    raise notice '032: event trigger not created (needs superuser); §1 static lockdown + the per-migration RLS convention still cover the schema.';
  when others then
    raise notice '032: event trigger not created (%); §1 static lockdown still applied.', sqlerrm;
end $$;
