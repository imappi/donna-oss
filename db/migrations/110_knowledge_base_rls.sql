-- Donna — K1: close the RLS gap left by 109_knowledge_base.sql.
--
-- WHAT WENT WRONG. 109 created two new public tables (`knowledge_sources`,
-- `knowledge_passages`) and omitted the per-migration RLS block that every
-- other table-creating migration in this tree carries (102, 104, 033/034 …).
-- That is not a stylistic slip. Migration 032's own header states the posture:
--
--   "The PRIMARY guard remains the per-migration RLS block (the 033/034
--    pattern); this trigger is a backstop…"
--   "CREATE EVENT TRIGGER requires superuser. Supabase's migration role is not
--    a superuser, so on the live project the trigger creation is SKIPPED…"
--
-- So on the live project the event-trigger backstop is NOT attached, and 032's
-- §1 static scan only covered tables that existed when 032 ran. A table created
-- by 109 is therefore covered by NOTHING: it is reachable through Supabase's
-- auto-generated PostgREST API via the `anon` / `authenticated` browser roles.
--
-- WHY THIS IS NOT MERELY COSMETIC, even though K1 holds public statutes. The
-- confidentiality loss is small by design — K1 carries no tenant data and its
-- content is published law and official guidance. The INTEGRITY exposure is the
-- real one: these rows GROUND the tax and accounting answers Donna gives an
-- owner with no professional backstop. A writable knowledge corpus is a corpus
-- someone can poison, and a poisoned passage produces exactly the failure the
-- whole K1 design exists to prevent — an answer that sounds authoritative, is
-- acted on, and surfaces months later as a misstated return. Donna would even
-- cite the tampered source, which makes the wrong answer MORE convincing.
--
-- WHY A SEPARATE MIGRATION rather than editing 109. `scripts/vercel-build.js`
-- runs `npm run db:migrate`, so any deploy since 109 merged may already have
-- applied it. An applied version is recorded in `schema_migrations` and never
-- re-runs, so an in-place edit to 109 would silently do nothing on exactly the
-- databases that need fixing. This migration is idempotent and fixes both the
-- already-applied and the fresh case.
--
-- Same RLS-native posture as 032/033/034/102: ENABLE (not FORCE) — the
-- table-owner server role stays exempt and the server's own connection keeps
-- working; REVOKE for defense in depth, role-guarded so a dev DB without the
-- Supabase roles still applies cleanly; and NO `create policy`, because adding
-- one would re-open the very PostgREST path this closes.

alter table knowledge_sources enable row level security;
alter table knowledge_passages enable row level security;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on knowledge_sources from anon;
    revoke all on knowledge_passages from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on knowledge_sources from authenticated;
    revoke all on knowledge_passages from authenticated;
  end if;
end $$;
