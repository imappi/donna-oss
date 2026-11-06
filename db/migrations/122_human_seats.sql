-- 122 — Human seats (build 1 of docs/design-donna-seats-roles-access.md).
--
-- A SEAT is a licensed human identity: one seat = one human, with a role
-- that is a capability profile (OWNER / PARTNER / SENIOR / JUNIOR) and an
-- affiliation fence (internal / external). Seats land on the EXISTING
-- principal substrate, never a parallel one (the build spec's stop-and-
-- report rule):
--
--   - The implicit OWNER seat is a PROJECTION, not a row: active
--     `firm_members` (desktop-minted owners) and `firm_collaborators` with
--     role 'owner' and no seat_role (cloud self-serve owners) already ARE
--     the owner seat, and resolve to founder class unchanged. Zero data
--     migration; existing installs see no behavior change.
--   - PARTNER / SENIOR / JUNIOR seats are `firm_collaborators` rows with
--     the columns below. The table was BUILT for scoped humans (it has
--     carried starts_at/ends_at/vendor_company/nda_signed_at since 001);
--     what it lacked was the role ladder and the lifecycle timestamps.
--
-- seat_role doubles as the seat-principal discriminator: a collaborator
-- row WITH seat_role is a staff seat (capability class from the seat
-- ladder, enforcement unconditional from birth, actor_type 'seat' in the
-- audit trail); a row WITHOUT seat_role keeps today's semantics exactly
-- (the self-serve owner / portal principal — actor_type 'client' at the
-- attribution sites). That presence-check is what keeps a staff seat from
-- ever masquerading as a portal client or inheriting member god-mode
-- (amendment 5 in the build spec).
--
-- Entity access is NOT here: it stays on `client_assignments`
-- (assignment_kind 'capability', time-bounded), enforced where it always
-- was — assertFirmAccess. Materiality bounds are code defaults in the pure
-- seat-authority module (Kari 2026-08-03: numbers stay code defaults), so
-- no numeric-config table is minted either.
--
-- Lifecycle: invited → active (first authenticated match — the existing
-- email-match + user_id backfill path — audited seat.activated) →
-- suspended (owner action, or engagement expiry: ends_at passing suspends
-- fail-closed at principal resolution and is receipted seat.suspended /
-- engagement_expired, never a silent lapse). `status` stays an
-- unconstrained text column (001 shipped it without a CHECK and legacy
-- rows may carry values beyond the seat vocabulary); the seat writers
-- confine themselves to 'invited' / 'active' / 'suspended'.

alter table firm_collaborators
  add column if not exists seat_role text;
alter table firm_collaborators
  drop constraint if exists firm_collaborators_seat_role_check;
alter table firm_collaborators
  add constraint firm_collaborators_seat_role_check
  check (seat_role is null or seat_role in ('partner', 'senior', 'junior'));

-- External seats hold a NORMAL role with identical capabilities within it;
-- affiliation adds fencing (mandatory entities + end date, no exports, no
-- portfolio views, chase release behind the firm toggle), never a fifth
-- role or a second matrix.
alter table firm_collaborators
  add column if not exists affiliation text not null default 'internal';
alter table firm_collaborators
  drop constraint if exists firm_collaborators_affiliation_check;
alter table firm_collaborators
  add constraint firm_collaborators_affiliation_check
  check (affiliation in ('internal', 'external'));

alter table firm_collaborators
  add column if not exists invited_at timestamptz;
alter table firm_collaborators
  add column if not exists activated_at timestamptz;
alter table firm_collaborators
  add column if not exists suspended_at timestamptz;
alter table firm_collaborators
  add column if not exists suspended_reason text;
