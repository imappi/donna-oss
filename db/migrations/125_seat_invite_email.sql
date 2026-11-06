-- 125 — Seat invite-email receipt (follow-up to 122_human_seats;
-- docs/design-donna-seats-roles-access.md §3.2).
--
-- The invite email is post-commit best-effort by design (the seat row is the
-- truth; activation is email match, never a token link) — but its OUTCOME
-- lived only in a transient UI notice: a skipped or failed send left no
-- durable trace on the roster and no way to retry from the product. These
-- columns make the notification leg first-class on the seat row itself:
-- the latest outcome (sent / skipped / failed), the reason when it wasn't
-- sent, and when that outcome was recorded. Writers stamp them via
-- recordSeatInviteEmailOutcome (seatsDb.js) with a seat.invite_email audit
-- event in the same transaction as the stamp; the roster projects them and
-- the Team panel renders a Resend affordance off them.
alter table firm_collaborators
  add column if not exists invite_email_status text;
alter table firm_collaborators
  add column if not exists invite_email_reason text;
alter table firm_collaborators
  add column if not exists invite_email_at timestamptz;
