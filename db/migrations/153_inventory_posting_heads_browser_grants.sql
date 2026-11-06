-- The posting-heads projection is server-only, like its source table.
-- A default-definer view can expose rows even when the source has RLS and
-- no browser grants. Do not alter its owner, definition or server grants.
-- PUBLIC is included because its grants are inherited by both browser roles.
revoke all privileges on table public.inventory_posting_heads from public;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all privileges on table public.inventory_posting_heads from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all privileges on table public.inventory_posting_heads from authenticated;
  end if;
end
$$;
