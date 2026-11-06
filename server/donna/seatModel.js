// Donna — the human-seat model (build 1 of docs/design-donna-seats-roles-access.md).
//
// Pure leaf: zero imports, loads in-sandbox under `node --test` like the other
// contract leaves. Everything here is vocabulary + pure decisions; the DB reads
// and writes live in firmDb.js (principal resolution) and seatsDb.js (lifecycle
// writers). One seat = one human; roles are capability profiles; affiliation is
// a fence, never a fifth role (the matrix stays 4 roles × affiliation — a fifth
// role or a second matrix is a stop-and-report per the build spec).
//
// The seat discriminator is `seat_role` PRESENCE on a firm_collaborators row
// (migration 122): with it, the row is a staff seat — capability class from the
// seat ladder, enforcement unconditional from birth, actor_type 'seat' in the
// audit trail; without it, the row keeps today's semantics exactly (the
// self-serve owner / portal principal). The implicit OWNER seat is a PROJECTION
// over active firm_members and 'owner'-role collaborators — zero migration,
// invisible to existing installs.

// The fixed v1 role set (ICP-symmetric per Kari's 2026-08-27 call: one ladder
// serves a business owner's team and a firm equally). 'owner' never appears in
// firm_collaborators.seat_role — it is the projection role of the two existing
// owner shapes; the three below are the invitable ones.
export const SEAT_ROLES = Object.freeze(['owner', 'partner', 'senior', 'junior']);
export const INVITABLE_SEAT_ROLES = Object.freeze(['partner', 'senior', 'junior']);

export const SEAT_AFFILIATIONS = Object.freeze(['internal', 'external']);

// Lifecycle vocabulary the seat writers confine themselves to (the column
// itself is unconstrained text — legacy collaborator rows predate seats).
export const SEAT_STATUSES = Object.freeze(['invited', 'active', 'suspended']);

// Seat role → capability class on the extended lattice (operatorCapability
// imports THIS map so the ladder has one home). OWNER is founder by
// construction (the projection shapes already resolve founder); the three
// invitable roles map to the three new ranks.
export const SEAT_ROLE_CAPABILITY_CLASS = Object.freeze({
  owner: 'founder',
  partner: 'partner',
  senior: 'senior',
  junior: 'junior'
});

// External chase fence (build spec §4.6): chases go out in the business's
// name, so by default an EXTERNAL seat proposes and an internal seat
// releases. The per-firm toggle is a config-plane flag, born with
// envFallback () => false (the flag rail — default OFF, DB row to enable).
// These verbs mint or deliver a client-facing ask; the fence binds them for
// external seats at the converged gate, and the ask-batch SEND route runs the
// same check. release_pilot_send_containment opens an entity's question
// channel to its client — under white label (Kari, 2026-09-23: the firm keeps
// the client relationship) that is the firm's internal call too.
export const EXTERNAL_SEAT_CHASE_RELEASE_FLAG_KEY = 'EXTERNAL_SEAT_CHASE_RELEASE';
export const CLIENT_FACING_CHASE_VERBS = Object.freeze(new Set([
  'ask_client',
  'draft_evidence_request',
  'resend_ask',
  'release_pilot_send_containment'
]));

// A staff seat is a collaborator row carrying seat_role. Accepts either a raw
// DB row (snake_case) or a resolved principal (camelCase).
export const isSeatRow = (row) => Boolean(row && (row.seat_role || row.seatRole));

export const isExternalSeat = (row) =>
  isSeatRow(row) && (row.affiliation === 'external');

// ── Principal-resolution decision (consumed by getFirmPrincipalForAuth) ──────
//
// Pure: given the matched collaborator row and the clock, decide what the
// resolver must DO before minting a principal. Order matters and is pinned by
// test: expiry beats activation (an invited seat whose engagement window has
// already passed must never activate on first sign-in).
//   { disposition: 'suspend_expired' } — seat past ends_at: suspend + audit
//     (reason 'engagement_expired'), deny this request. Fail-closed the moment
//     the window passes; the receipt makes the lapse loud, never silent.
//   { disposition: 'activate' }        — invited seat on its first
//     authenticated match: flip to active + audit seat.activated, then proceed.
//   { disposition: 'proceed' }         — nothing to do.
export const decideSeatResolution = ({ row = null, now = new Date() } = {}) => {
  if (!isSeatRow(row)) return { disposition: 'proceed' };
  const endsAt = row.ends_at ? new Date(row.ends_at) : null;
  if (endsAt && !Number.isNaN(endsAt.getTime()) && endsAt.getTime() <= now.getTime()) {
    return { disposition: 'suspend_expired' };
  }
  if (row.status === 'invited') return { disposition: 'activate' };
  return { disposition: 'proceed' };
};

// ── Invite validation (consumed by the invite writer + route) ────────────────
//
// The external fences that are VALIDATIONS live here: entity assignment and an
// engagement end date are MANDATORY for external seats — there is no
// all-entities path and no open-ended external engagement, by construction.
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const validateSeatInvite = ({
  name,
  email,
  seatRole,
  affiliation = 'internal',
  clientIds = [],
  endsAt = null,
  now = new Date()
} = {}) => {
  const problem = (code, message) => ({ ok: false, code, message });
  if (!String(name || '').trim()) return problem('name_required', 'A display name is required.');
  if (!EMAIL_SHAPE.test(String(email || '').trim())) {
    return problem('email_invalid', 'A valid email address is required.');
  }
  if (!INVITABLE_SEAT_ROLES.includes(seatRole)) {
    return problem('seat_role_invalid', `Role must be one of: ${INVITABLE_SEAT_ROLES.join(', ')}.`);
  }
  if (!SEAT_AFFILIATIONS.includes(affiliation)) {
    return problem('affiliation_invalid', 'Affiliation must be internal or external.');
  }
  const ids = Array.isArray(clientIds) ? clientIds.filter(Boolean) : [];
  let ends = null;
  if (endsAt != null && endsAt !== '') {
    ends = new Date(endsAt);
    if (Number.isNaN(ends.getTime())) return problem('ends_at_invalid', 'Engagement end date is not a valid date.');
    if (ends.getTime() <= now.getTime()) return problem('ends_at_past', 'Engagement end date must be in the future.');
  }
  if (affiliation === 'external') {
    if (ids.length === 0) {
      return problem('external_requires_entities', 'External seats require at least one assigned entity — no all-entities path exists.');
    }
    if (!ends) {
      return problem('external_requires_end_date', 'External seats require an engagement end date.');
    }
  }
  return {
    ok: true,
    normalized: {
      name: String(name).trim(),
      email: String(email).trim().toLowerCase(),
      seatRole,
      affiliation,
      clientIds: ids,
      endsAt: ends ? ends.toISOString() : null
    }
  };
};

// ── Roster projection (consumed by seatsDb.listFirmSeats) ────────────────────
//
// One seat shape for every source row. Owner seats are projected — the
// firm_members row (desktop) or the 'owner'-role collaborator (cloud
// self-serve) — so a fresh single-user install shows exactly one OWNER seat
// with zero data migration.
export const projectSeat = ({ source, row, clientIds = [] } = {}) => {
  if (!row) return null;
  if (source === 'member') {
    return {
      id: row.id,
      source: 'firm_member',
      name: row.name,
      email: row.email,
      seat_role: 'owner',
      affiliation: 'internal',
      status: row.status === 'active' ? 'active' : row.status,
      client_ids: null, // unrestricted
      starts_at: null,
      ends_at: null,
      invited_at: null,
      activated_at: null,
      suspended_at: null,
      invite_email_status: null,
      invite_email_reason: null,
      invite_email_at: null
    };
  }
  const seatRole = row.seat_role || (row.role === 'owner' ? 'owner' : null);
  if (!seatRole) return null;
  return {
    id: row.id,
    source: 'firm_collaborator',
    name: row.name,
    email: row.email,
    seat_role: seatRole,
    affiliation: row.affiliation || 'internal',
    status: row.status,
    client_ids: clientIds,
    starts_at: row.starts_at || null,
    ends_at: row.ends_at || null,
    invited_at: row.invited_at || null,
    activated_at: row.activated_at || null,
    suspended_at: row.suspended_at || null,
    // The invite-email receipt (migration 125): the notification leg's latest
    // outcome, so a skipped/failed send is visible on the roster, not only in
    // a transient notice. Null on rows invited before the columns existed.
    invite_email_status: row.invite_email_status || null,
    invite_email_reason: row.invite_email_reason || null,
    invite_email_at: row.invite_email_at || null
  };
};
