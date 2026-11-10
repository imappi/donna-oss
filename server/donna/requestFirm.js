// The ONE firm resolver for request-scoped route code (RT-03, audit F-03).
//
// Two resolvers used to coexist and disagreed on the appliance:
//   - resolveConfiguredDefaultFirmId() reads the ENVIRONMENT only and, with
//     nothing configured, answers 'donna-demo-firm' forever;
//   - DEFAULT_FIRM_ID is the LIVE binding the desktop boot (and the first-run
//     mint) re-points to the sole minted firm (`firm-<slug>`).
// A route that reached for the env resolver — or a literal — scoped a real
// firm's evidence keys and readiness admission to the demo tenant while the
// rest of the request ran under the real firm. This module is the only door
// request-scoped code may use:
//
//   explicit firm on the request (body, then query, then the authenticated
//   principal) → else firmDb.getDefaultFirmId(): a configured
//   DONNA_DEFAULT_FIRM_ID when one is set, otherwise the live binding.
//
// Never the env-only resolver (boot/config code keeps that, deliberately),
// never a literal. assertFirmAccess still guards the resolved value; this only
// decides WHICH firm a request is about.

import { getDefaultFirmId, queryFirmDb } from './firmDb.js';

const clean = (value) => String(value ?? '').trim();

const readQuery = (query, key) => {
  if (!query) return '';
  if (typeof query.get === 'function') return clean(query.get(key));
  return clean(query[key]);
};

export const resolveRequestFirmId = ({ body = null, query = null, auth = null } = {}) =>
  clean(body?.firm_id ?? body?.firmId)
  || readQuery(query, 'firm_id')
  || clean(auth?.firmId ?? auth?.firm_id)
  || getDefaultFirmId();

// A verified member may use the console without supplying firm_id. Membership
// selects the default; the existing per-route access checks still authorize
// every explicit target. Never pick one of several memberships. Database
// membership is the authority here (a self-provisioned firm's administrator
// is not on any staff allowlist); an invited/active collaborator with no
// membership resolves to its single firm the same way, so an invitee reaches
// the firm that invited them rather than the deployment default. Business-
// owner collaborators (no seat role) keep the deployment default as before.
export const resolveAuthenticatedMemberFirm = async ({ auth, queryFn = queryFirmDb }) => {
  const userId = clean(auth?.userId);
  const email = clean(auth?.email).toLowerCase();
  if (auth?.type !== 'supabase_user' || (!userId && !email)) return { firmId: null, ambiguous: false };
  const result = await queryFn(`select distinct firm_id from firm_members
    where status = 'active' and (
      ($1 <> '' and user_id = $1)
      or (user_id is null and $2 <> '' and lower(email) = $2)
    ) order by firm_id limit 2`, [userId, email]);
  if (result.rows.length) return { firmId: result.rows.length === 1 ? result.rows[0].firm_id : null, ambiguous: result.rows.length > 1 };
  // Seats (seat_role set) first, unchanged. A business-owner collaborator in
  // the deployment default firm keeps its prior default-firm resolution
  // byte-identical — its strict owner-revalidation body must not acquire a
  // boundary-injected firm_id. An owner a NON-default firm invited into its
  // client portal (clientOwnerInvitesDb.js) resolves to that one firm; the
  // acceptance guarantees it is the identity's only principal, and anything
  // ambiguous (owner rows in several firms, or one in the default firm) keeps
  // the prior behaviour. assertFirmAccess still authorizes every request.
  const collaborator = await queryFn(`select distinct firm_id, (seat_role is null) as owner from firm_collaborators
    where ((seat_role is not null and status in ('active', 'invited'))
      or (seat_role is null and role = 'owner' and status = 'active')) and (
      ($1 <> '' and user_id = $1)
      or ($2 <> '' and lower(email) = $2)
    ) order by firm_id limit 6`, [userId, email]);
  const seatFirms = collaborator.rows.filter((row) => row.owner !== true);
  // Several collaborator firms keep the prior behavior (the deployment default
  // plus per-route access checks) rather than refusing the sign-in outright.
  if (seatFirms.length) return { firmId: seatFirms.length === 1 ? seatFirms[0].firm_id : null, ambiguous: false };
  const ownerFirms = collaborator.rows.filter((row) => row.owner === true);
  const soleOwnerFirm = ownerFirms.length === 1 && ownerFirms[0].firm_id !== getDefaultFirmId() ? ownerFirms[0].firm_id : null;
  return { firmId: soleOwnerFirm, ambiguous: false };
};
