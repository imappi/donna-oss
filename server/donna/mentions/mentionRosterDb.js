// Donna — universal @mentions: the per-artifact roster read (build 2 slice 3,
// docs/design-donna-universal-mentions.md §3).
//
// ONE query path assembles who is mentionable on a client's artifacts, from
// the substrates that already exist — never a parallel actor store (D1):
//
//   humans — active firm_members (unrestricted: they can reach every book),
//            plus active firm_collaborators whose ACTIVE capability
//            client_assignment covers THIS client, time-bounded exactly the
//            way assertFirmAccess bounds access (getAllowedClientIdsForPrincipal's
//            predicate, inverted to "who covers this client").
//   agents — the client's HIRED bench (roleRoster.listSpecialistAssignments;
//            the pure core filters to live ai_occupant rows), plus the
//            always-present operator.
//
// Eligibility here IS the entity-isolation boundary for typeahead and
// mention validation (defense layer 1); notification fan-out re-checks with
// the same predicate (layer 2); and mention-write validation refuses refs
// outside this roster (layer 3, mentionResolution.validateMentionRefs).

import { queryFirmDb } from '../firmDb.js';
import { listSpecialistAssignments } from '../roles/roleRoster.js';
import { buildMentionRoster } from './mentionResolution.js';

// Human principals eligible on this client, in the roster's input shape.
// firmId is REQUIRED here (no DEFAULT_FIRM_ID fallback): the roster is an
// eligibility boundary, and a defaulted firm on a mis-wired call would be a
// cross-firm leak, not a convenience.
export const listEligibleHumanPrincipals = async ({ firmId, clientId, dbClient = null } = {}) => {
  if (!firmId || !clientId) return [];
  const run = dbClient
    ? (sql, params) => dbClient.query(sql, params)
    : (sql, params) => queryFirmDb(sql, params);
  const [members, collaborators] = await Promise.all([
    run(
      `select id, name, email from firm_members
        where firm_id = $1 and status = 'active'
        order by name`,
      [firmId]
    ),
    // status = 'active' keeps invited/suspended seats un-mentionable (a seat
    // activates on its first sign-in, not on the invite); the ends_at guard
    // mirrors decideSeatResolution's fail-closed expiry — an engagement past
    // its window is not mentionable even before the lazy suspension flip
    // lands. seat_role/affiliation ride along so the typeahead can render
    // role labels and the mandatory External badge (seats spec §4.5).
    run(
      `select fc.id, fc.name, fc.email, fc.role, fc.seat_role, fc.affiliation
         from firm_collaborators fc
        where fc.firm_id = $1
          and fc.status = 'active'
          and (fc.ends_at is null or fc.ends_at > now())
          and exists (
            select 1 from client_assignments ca
             where ca.firm_id = fc.firm_id
               and ca.client_id = $2
               and ca.principal_type = 'firm_collaborator'
               and ca.principal_id = fc.id
               and ca.assignment_kind = 'capability'
               and (ca.starts_at is null or ca.starts_at <= now())
               and (ca.ends_at is null or ca.ends_at > now())
          )
        order by fc.name`,
      [firmId, clientId]
    )
  ]);
  return [
    // A firm member IS the implicit owner seat (seatModel.projectSeat's law).
    ...(members.rows || []).map((row) => ({
      principal_type: 'firm_member',
      principal_id: row.id,
      display: row.name || null,
      email: row.email || null,
      seat_role: 'owner',
      affiliation: 'internal'
    })),
    ...(collaborators.rows || []).map((row) => ({
      principal_type: 'firm_collaborator',
      principal_id: row.id,
      display: row.name || null,
      email: row.email || null,
      // A row without seat_role is the self-serve owner / portal principal —
      // projected 'owner' when its role says so, else left null (legacy
      // collaborator; still mentionable, no ladder label to show).
      seat_role: row.seat_role || (row.role === 'owner' ? 'owner' : null),
      affiliation: row.affiliation || 'internal'
    }))
  ];
};

// The full per-artifact roster: eligible humans + the client's live bench +
// the operator. `dbClient` rides through so a route inside a transaction can
// reuse its connection; roleRoster's read requires one, so the plain path
// borrows a query-shaped shim.
export const buildMentionRosterForClient = async ({ firmId, clientId, dbClient = null, now = null } = {}) => {
  if (!firmId || !clientId) return [];
  const rosterClient = dbClient || { query: (sql, params) => queryFirmDb(sql, params) };
  const [humanPrincipals, specialistAssignments] = await Promise.all([
    listEligibleHumanPrincipals({ firmId, clientId, dbClient }),
    listSpecialistAssignments(rosterClient, { firmId, clientId })
  ]);
  return buildMentionRoster({ humanPrincipals, specialistAssignments, now });
};
