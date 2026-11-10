-- 170 — Phone-app device registrations for notifications.
--
-- The phone app registers its Expo push token when the owner turns
-- notifications on and removes the registration when they turn them off
-- (POST / DELETE /notifications/registrations on the mobile adapter). This
-- table STORES registrations only: nothing here sends, and no notification
-- service is called. Owner: server/donna/mobile/mobilePushRegistrations.js.
--
-- One registration (the contract's `id`, `registration_id` here) is one
-- device token of one signed-in owner identity. It has one row per owner
-- principal that identity held when it registered — a `firm_collaborators`
-- row is firm-scoped, so an identity that owns books in two firms has two
-- rows under one registration id. Each row is tied to its collaborator row by
-- foreign key: when the collaborator goes, its row goes. Rows whose principal
-- no longer has a current client assignment are removed by the access writers
-- (removeClientOwnerAccessInDb, deleteClientInDb) in their own transaction.
--
-- The device token is personal data and is what a sender would deliver with.
-- It is stored here and nowhere else: receipts carry `token_sha256` prefixes
-- only. Server-side only, never browser-readable (mirror 163/166).

create table if not exists mobile_push_registrations (
  id text primary key,
  registration_id text not null,
  firm_id text not null references firms(id) on delete cascade,
  collaborator_id text not null references firm_collaborators(id) on delete cascade,
  platform text not null check (platform in ('ios', 'android')),
  expo_push_token text not null,
  token_sha256 text not null,
  locale text check (locale is null or locale in ('en', 'fi')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- One row per firm under a registration, and a device token at most once per
-- firm (a token that turns up under another owner moves; it is never shared).
create unique index if not exists mobile_push_registrations_registration_firm_uniq
  on mobile_push_registrations(registration_id, firm_id);
create unique index if not exists mobile_push_registrations_firm_token_uniq
  on mobile_push_registrations(firm_id, token_sha256);
create index if not exists mobile_push_registrations_token_idx
  on mobile_push_registrations(token_sha256);
create index if not exists mobile_push_registrations_collaborator_idx
  on mobile_push_registrations(firm_id, collaborator_id);

alter table mobile_push_registrations enable row level security;
do $$ begin
  if exists (select 1 from pg_roles where rolname='anon') then
    revoke all on mobile_push_registrations from anon;
  end if;
  if exists (select 1 from pg_roles where rolname='authenticated') then
    revoke all on mobile_push_registrations from authenticated;
  end if;
  if exists (select 1 from pg_roles where rolname='service_role') then
    grant select, insert, update, delete on mobile_push_registrations to service_role;
  end if;
end $$;
