-- Marketing waitlist — the unfit path of the purchase-flow qualification gate.
--
-- A signed-out visitor who doesn't qualify (sells inventory, restaurant, >1,000
-- tx/mo, or "something else") never reaches a card form. The qualification gate
-- captures their email here, tagged with the disqualifying reason, so the
-- not-yet-fit demand is segmentable later instead of lost. This is lead data,
-- not firm/client data — it is firm-agnostic and pre-account.

create table if not exists marketing_waitlist (
  id text primary key,
  email text not null,
  -- Why they were disqualified: inventory | restaurant | volume | other.
  -- Kept as free text (no CHECK) so a new gate reason can't reject a capture;
  -- the writer normalizes to the known set.
  reason text not null default 'other',
  -- Light provenance for de-dup / debugging, no PII beyond the email itself.
  source text not null default 'qualification_gate',
  created_at timestamptz not null default now()
);

-- One active row per email — re-submitting updates the reason/timestamp rather
-- than piling duplicates (the writer upserts on this).
create unique index if not exists marketing_waitlist_email_uniq
  on marketing_waitlist(lower(email));

-- ── RLS-native (mirror 042) ──────────────────────────────────────────────────
-- Lead data is server-owned; the browser never queries it. ENABLE (not FORCE)
-- so the RLS-exempt owner role the server connects as stays exempt; revoke the
-- Supabase browser roles. Guarded so a dev DB without those roles applies clean.
alter table marketing_waitlist enable row level security;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on marketing_waitlist from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on marketing_waitlist from authenticated;
  end if;
end $$;
