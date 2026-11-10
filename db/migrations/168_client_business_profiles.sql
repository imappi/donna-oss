-- 168 — Owner-declared business profile (the phone app's Business page).
--
-- The facts an owner states about how their business works — description,
-- operating area, profession, billing basis, experience, business address,
-- people involved, payment methods, spending categories — as the owner
-- confirmed them on screen. One current row per client.
--
-- Why a table of its own and not a key in clients.profile:
--   - clients.profile is written by the generic profile patch route
--     (POST /clients/:id/profile, any key), so a key there would have a
--     second writer. The mobile contract makes PUT …/onboarding/profile the
--     only writer of these facts; here the only writer is
--     server/donna/mobile/mobileBusinessProfile.js.
--   - Any change to clients.profile changes the Finnish cloud-pilot
--     owner-adoption admission digest (existingOwnerRevalidation.js), so an
--     edited description would re-gate admission of the books.
--   - Model-facing readers spread clients.profile into prompt context. These
--     facts are owner-declared context and are read by no posting, coding or
--     statutory reader; nothing outside the mobile projection reads this table.
--
-- Nothing here is legal identity: no business id, legal name, legal form or
-- registered address (that is the business register, a separate writer).
--
-- Each write is receipted by an audit_events row in the same transaction
-- ('client.business_profile.declared'), attributed to the declaring owner and
-- carrying the previous and the new facts, so a change can be reversed from the
-- receipt. `revision` counts confirmed declarations.

create table if not exists client_business_profiles (
  firm_id text not null references firms(id) on delete cascade,
  client_id text not null references clients(id) on delete cascade,
  facts jsonb not null,
  revision integer not null default 1 check (revision >= 1),
  declared_by_type text not null,
  declared_by_id text not null,
  declared_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (firm_id, client_id),
  check (jsonb_typeof(facts) = 'object')
);

-- Owner-declared facts are tenant data: server-side only, never
-- browser-readable (mirror 163's guarded block).
alter table client_business_profiles enable row level security;
do $$ begin
  if exists (select 1 from pg_roles where rolname='anon') then
    revoke all on client_business_profiles from anon;
  end if;
  if exists (select 1 from pg_roles where rolname='authenticated') then
    revoke all on client_business_profiles from authenticated;
  end if;
  if exists (select 1 from pg_roles where rolname='service_role') then
    grant select, insert, update, delete on client_business_profiles to service_role;
  end if;
end $$;
