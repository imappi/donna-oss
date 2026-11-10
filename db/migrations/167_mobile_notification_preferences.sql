-- 167 — The phone app's notification preferences, per owner and business.
--
-- The four switches on the app's Notifications page (needs_you, due_dates,
-- monthly_summary, every_receipt) are the owner's own choice about what Donna
-- may tell them on the phone. No existing Donna store holds a per-owner,
-- per-client preference: firm_collaborators carries identity and access,
-- client_assignments carries grants, and clients.profile is the business's
-- facts (shared by everyone on the book). This table is that one store; its
-- only writer is server/donna/mobile/mobileSettingsDb.js, which commits each
-- change with its audit_events row in the same transaction.
--
-- A row exists only once the owner has saved a choice. No row means "nothing
-- chosen yet"; the adapter then shows the product default and says so.
-- Nothing reads these rows to send anything: no push sender exists yet.
--
-- principal_id is the owner's firm_collaborators id. The row dies with the
-- client, the firm or the collaborator (FK cascade), like every other
-- per-client row.

create table if not exists mobile_notification_preferences (
  firm_id text not null references firms(id) on delete cascade,
  client_id text not null references clients(id) on delete cascade,
  principal_id text not null references firm_collaborators(id) on delete cascade,
  needs_you boolean not null,
  due_dates boolean not null,
  monthly_summary boolean not null,
  every_receipt boolean not null,
  updated_by text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (firm_id, client_id, principal_id)
);

create index if not exists mobile_notification_preferences_principal_idx
  on mobile_notification_preferences(firm_id, principal_id);

-- Server-side only, never browser-readable (mirror 163's guarded block).
alter table mobile_notification_preferences enable row level security;
do $$ begin
  if exists (select 1 from pg_roles where rolname='anon') then
    revoke all on mobile_notification_preferences from anon;
  end if;
  if exists (select 1 from pg_roles where rolname='authenticated') then
    revoke all on mobile_notification_preferences from authenticated;
  end if;
  if exists (select 1 from pg_roles where rolname='service_role') then
    grant select, insert, update, delete on mobile_notification_preferences to service_role;
  end if;
end $$;
