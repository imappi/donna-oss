// server/donna/db/authority.js — plane A — principals, seats, entity access, the action-capability gate, the snapshot access filter, and the operator reverse spine (its memory leg routes to plane M's governed retire writers).
//
// RT-17 (2026-09-02): extracted from server/donna/firmDb.js as a pure move. Every public
// symbol keeps its old import path through firmDb.js, which re-exports it; helpers another
// plane needs are exported here and NOT re-exported by firmDb.js. Zero behaviour change.

// `dismissFirmFact` (G2 PR-14): the reverse executor's memory leg routes a minted
// fact to the SAME governed tombstone writer the forget_fact verb uses (INV-1).
import { dismissFirmFact } from '../firmFacts.js';
import { clientFlagActs, readClientConfigSnapshot } from '../clientConfig.js';
import { isDesktopHostEnv } from '../desktop/hostPlaneSeed.js';
import { loadReversibleProposalCards } from '../proposalStore.js';
import { applicableReverseEntries, matchReverseKeyForRow, planReverseForCard, reverseLegForWriter, summarizeReversePlan } from '../reverseExecutor.js';
import { OPERATOR_CAPABILITY_FLAG_KEY, resolveCapabilityClass } from '../operatorCapability.js';
import { CLIENT_FACING_CHASE_VERBS, decideSeatResolution, EXTERNAL_SEAT_CHASE_RELEASE_FLAG_KEY, INVITABLE_SEAT_ROLES } from '../seatModel.js';
import { decideSeatAuthority, resolveActionAmountMinor } from '../seatAuthority.js';
import { decideRoleAction, logSpecialistRoleWouldBlock, recordRoleWouldBlock, specialistRoleGateMode } from '../roles/roleAuthority.js';
import { mergeConvergenceMetrics } from '../reconcileConvergenceState.js';

import { queryFirmDb, withFirmDbClient } from './pool.js';
import { assertFirmScopeAllowed, DEFAULT_FIRM_ID } from './clients.js';
import { updateClientRuleStatusInDb } from './memory.js';
import { reviewCaseLegacyLabel, updateTransactionReviewItemInDb } from './coding.js';
import { updateReconciliationMatchInDb } from './reconcile.js';
import { cancelClientEvidenceRequestInDb } from './asks.js';
import { getFirmSnapshotFromDb } from './snapshot.js';

const normalizeEmail = (email = '') => String(email || '').trim().toLowerCase();

const forbidden = (message = 'You do not have access to this firm data.') => {
  const error = new Error(message);
  error.statusCode = 403;
  error.code = 'FIRM_ACCESS_DENIED';
  return error;
};

export const isFirmMemberPrincipal = (principal) =>
  principal?.principalType === 'access_token' || principal?.principalType === 'firm_member';

// ── Seat lifecycle at the principal-resolution seam (build spec §3.1/§4) ─────
//
// Two lazy transitions, both decided by the pure seatModel.decideSeatResolution
// and both receipted in the SAME transaction as the status flip
// (audit-as-precondition — a seat can never change lifecycle state silently):
//
//   - engagement expiry: a seat whose ends_at has passed is suspended
//     fail-closed the moment it next authenticates (and by the roster sweep in
//     seatsDb.js), with `seat.suspended` / reason 'engagement_expired'. Access
//     is denied for the current request REGARDLESS of whether the flip commits
//     — the deny rides the decision, not the write.
//   - invite activation: an invited seat's first authenticated match flips it
//     active (`seat.activated`, actor the seat itself) and backfills user_id —
//     the same email-match + backfill mechanism collaborators always used. If
//     the activation transaction fails the request is DENIED (the seat stays
//     invited and retries next request); it never proceeds un-receipted.
const __suspendExpiredSeatCollaborator = async ({ firmId, collaborator }) => {
  try {
    return await withFirmDbClient(async (client) => {
      try {
        await client.query('begin');
        const updated = await client.query(
          `update firm_collaborators
              set status = 'suspended', suspended_at = now(),
                  suspended_reason = 'engagement_expired', updated_at = now()
            where id = $1 and status <> 'suspended'
            returning id`,
          [collaborator.id]
        );
        if (updated.rows.length > 0) {
          await client.query(
            `insert into audit_events (firm_id, client_id, actor_type, actor_id, action, resource_type, resource_id, metadata)
             values ($1, null, 'system', 'system', 'seat.suspended', 'seat', $2, $3::jsonb)`,
            [firmId, collaborator.id, JSON.stringify({
              reason: 'engagement_expired',
              seat_role: collaborator.seat_role,
              affiliation: collaborator.affiliation || 'internal',
              email: collaborator.email,
              ends_at: collaborator.ends_at || null
            })]
          );
        }
        await client.query('commit');
        return true;
      } catch (error) {
        await client.query('rollback').catch(() => {});
        throw error;
      }
    });
  } catch (error) {
    console.warn(`[seats] expiry suspension failed for seat ${collaborator?.id}; access denied, flip retries next request`, error?.message || error);
    return false;
  }
};

const __activateInvitedSeatCollaborator = async ({ firmId, collaborator, userId = '' }) => {
  try {
    return await withFirmDbClient(async (client) => {
      try {
        await client.query('begin');
        const updated = await client.query(
          `update firm_collaborators
              set status = 'active', activated_at = now(),
                  user_id = coalesce(nullif($2, ''), user_id), updated_at = now()
            where id = $1 and status = 'invited'
            returning user_id`,
          [collaborator.id, userId || '']
        );
        if (updated.rows.length > 0) {
          await client.query(
            `insert into audit_events (firm_id, client_id, actor_type, actor_id, action, resource_type, resource_id, metadata)
             values ($1, null, 'seat', $2, 'seat.activated', 'seat', $3, $4::jsonb)`,
            [firmId, collaborator.email, collaborator.id, JSON.stringify({
              seat_role: collaborator.seat_role,
              affiliation: collaborator.affiliation || 'internal'
            })]
          );
        }
        await client.query('commit');
        return { activated: true, userIdAfter: updated.rows[0]?.user_id ?? collaborator.user_id };
      } catch (error) {
        await client.query('rollback').catch(() => {});
        throw error;
      }
    });
  } catch (error) {
    console.warn(`[seats] invite activation failed for seat ${collaborator?.id}; access denied, retries next request`, error?.message || error);
    return { activated: false };
  }
};

export const getFirmPrincipalForAuth = async ({ firmId = DEFAULT_FIRM_ID, auth } = {}) => {
  if (auth?.type === 'access_token') {
    return {
      principalType: 'access_token',
      principalId: 'access-token',
      role: 'admin',
      accessLevel: 'owner',
      email: null,
      unrestricted: true
    };
  }

  const email = normalizeEmail(auth?.email);
  const userId = auth?.userId || '';
  if (!email && !userId) return null;

  const memberResult = await queryFirmDb(
    `select *
     from firm_members
     where firm_id = $1
       and status = 'active'
       and (
         ($2 <> '' and user_id = $2)
         or ($3 <> '' and lower(email) = $3)
       )
     order by user_id nulls last
     limit 1`,
    [firmId, userId, email]
  );
  const member = memberResult.rows[0];
  if (member) {
    if (userId && !member.user_id) {
      await queryFirmDb('update firm_members set user_id = $1, updated_at = now() where id = $2', [userId, member.id]);
      member.user_id = userId;
    }
    return {
      principalType: 'firm_member',
      principalId: member.id,
      userId: member.user_id,
      email: member.email,
      role: member.role,
      accessLevel: member.access_level,
      unrestricted: true
    };
  }

  // Invited SEATS are matchable (their first authenticated match is what
  // activates them); non-seat collaborators keep the day-one active-only
  // semantics exactly.
  const collaboratorResult = await queryFirmDb(
    `select *
     from firm_collaborators
     where firm_id = $1
       and (
         status = 'active'
         or (status = 'invited' and seat_role is not null)
       )
       and (
         ($2 <> '' and user_id = $2)
         or ($3 <> '' and lower(email) = $3)
       )
     order by user_id nulls last
     limit 1`,
    [firmId, userId, email]
  );
  const collaborator = collaboratorResult.rows[0];
  if (!collaborator) return null;
  const seatDecision = decideSeatResolution({ row: collaborator });
  if (seatDecision.disposition === 'suspend_expired') {
    // Fail-closed at the window's edge: deny NOW; the receipted flip rides
    // its own transaction and retries next request if it failed.
    await __suspendExpiredSeatCollaborator({ firmId, collaborator });
    return null;
  }
  if (seatDecision.disposition === 'activate') {
    const activation = await __activateInvitedSeatCollaborator({ firmId, collaborator, userId });
    if (!activation.activated) return null;
    collaborator.status = 'active';
    collaborator.user_id = activation.userIdAfter ?? collaborator.user_id;
  }
  if (userId && !collaborator.user_id) {
    await queryFirmDb('update firm_collaborators set user_id = $1, updated_at = now() where id = $2', [userId, collaborator.id]);
    collaborator.user_id = userId;
  }
  return {
    principalType: 'firm_collaborator',
    principalId: collaborator.id,
    userId: collaborator.user_id,
    email: collaborator.email,
    role: collaborator.role,
    accessLevel: collaborator.access_level,
    unrestricted: false,
    // The seat discriminator (build spec amendment 5): present ONLY on staff
    // seats, so attribution and enforcement can key on it without ever
    // confusing a seat with the portal-owner collaborator shape.
    ...(collaborator.seat_role
      ? { seatRole: collaborator.seat_role, affiliation: collaborator.affiliation || 'internal' }
      : {})
  };
};

// Gate 2A route pin: the Electron proxy authenticates with its per-boot
// appliance token, but a client-create receipt must still name the real owner
// member Certificate B can verify. On the desktop host only, resolve that
// token to exactly one active owner (or, for a legacy book with no owner stamp,
// exactly one active member). Ambiguity refuses creation; it never guesses and
// never records `access-token` as though it were a human.
export const resolveDesktopClientCreationPrincipal = async ({
  firmId = DEFAULT_FIRM_ID,
  principal,
  queryFn = queryFirmDb,
  desktopHost = isDesktopHostEnv()
} = {}) => {
  if (principal?.principalType !== 'access_token' || !desktopHost) return principal;
  const result = await queryFn(
    `select id, user_id, email, role, access_level, status
       from firm_members
      where firm_id = $1 and status = 'active'
      order by case when access_level = 'owner' then 0 else 1 end, id
      limit 3`,
    [firmId]
  );
  const active = result.rows || [];
  const owners = active.filter((row) => row.access_level === 'owner');
  const selected = owners.length === 1 ? owners[0] : owners.length === 0 && active.length === 1 ? active[0] : null;
  if (!selected) {
    const error = new Error('Desktop client creation needs exactly one active owner member.');
    error.statusCode = 409;
    error.code = 'CLIENT_CREATION_MEMBER_AMBIGUOUS';
    error.details = { active_members: active.length, active_owners: owners.length };
    throw error;
  }
  return {
    principalType: 'firm_member',
    principalId: selected.id,
    userId: selected.user_id || null,
    email: selected.email || null,
    role: selected.role,
    accessLevel: selected.access_level,
    unrestricted: true,
    authenticatedVia: 'desktop_access_token'
  };
};

export const getAllowedClientIdsForPrincipal = async ({ firmId = DEFAULT_FIRM_ID, principal, dbClient = null, lockClientIds = null } = {}) => {
  if (!principal) return [];
  if (isFirmMemberPrincipal(principal) || principal.unrestricted) return null;

  const query = dbClient ? dbClient.query.bind(dbClient) : queryFirmDb;
  // Writer admission happens after blocking target locks. One statement clock
  // evaluates both bounds; transaction-start now() may predate a revoked window.
  const authorityTime = dbClient ? 'statement_timestamp()' : 'now()';
  const result = await query(
    `select client_id
     from client_assignments
     where firm_id = $1
       and principal_type = $2
       and principal_id = $3
       and status = 'active'
       and (starts_at is null or starts_at <= ${authorityTime})
       and (ends_at is null or ends_at > ${authorityTime})
       ${lockClientIds ? 'and client_id = any($4::text[]) for share nowait' : ''}`,
    [firmId, principal.principalType, principal.principalId, ...(lockClientIds ? [lockClientIds] : [])]
  );
  return result.rows.map((row) => row.client_id);
};

export const assertFirmAccess = async ({
  firmId = DEFAULT_FIRM_ID,
  auth,
  clientIds = [],
  requireMember = false,
  resolvedPrincipal = null,
  dbClient = null
} = {}) => {
  // Firm-scope isolation: refuse to authorize a request that resolved to the
  // shared demo firm in production — before any DB work and regardless of auth
  // type — so real client data can't silently land under donna-demo-firm by
  // default. This is the single chokepoint every HTTP route reaches.
  assertFirmScopeAllowed(firmId);
  // A named writer rechecks the exact authenticated identity on its existing
  // connection. It must not resolve a different identity, activate a seat, or
  // borrow a second connection while holding its source fence.
  let principal;
  if (resolvedPrincipal) {
    if (!dbClient || !['firm_member','firm_collaborator'].includes(resolvedPrincipal.principalType)) throw forbidden();
    const member = resolvedPrincipal.principalType === 'firm_member';
    const row = (await dbClient.query(`select *, clock_timestamp() as authority_now
      from ${member ? 'firm_members' : 'firm_collaborators'}
      where firm_id=$1 and id=$2 and status='active' for share nowait`,
      [firmId,resolvedPrincipal.principalId])).rows[0];
    if (!row || (resolvedPrincipal.userId && row.user_id !== resolvedPrincipal.userId)
      || (resolvedPrincipal.email && normalizeEmail(row.email) !== normalizeEmail(resolvedPrincipal.email))
      || (!member && decideSeatResolution({row,now:row.authority_now}).disposition !== 'proceed')) throw forbidden();
    principal = { ...resolvedPrincipal, unrestricted: member };
  } else {
    if (dbClient) throw forbidden();
    principal = await getFirmPrincipalForAuth({ firmId, auth });
  }
  if (!principal) throw forbidden();
  if (requireMember && !isFirmMemberPrincipal(principal)) {
    throw forbidden('Firm member access is required for this action.');
  }

  const allowedClientIds = await getAllowedClientIdsForPrincipal({ firmId, principal, dbClient,
    lockClientIds: dbClient ? clientIds.filter(Boolean) : null });
  if (Array.isArray(allowedClientIds)) {
    const allowed = new Set(allowedClientIds);
    const deniedClientId = clientIds.filter(Boolean).find((clientId) => !allowed.has(clientId));
    if (deniedClientId) throw forbidden(`You do not have access to client ${deniedClientId}.`);
  }

  return { principal, allowedClientIds };
};

// The per-client capability role for a principal (pod-safety #3). A firm member / access
// token is unrestricted → no per-client role needed (they resolve to 'founder' upstream). For
// a collaborator, read `client_assignments.role` (migration 001 — present since day one,
// written-only until now) for THIS client, time-bounded like the access check. Returns null
// when there is no active assignment → the capability layer fail-closes to 'viewer'.
// Since 117 the table also carries specialist ROLE assignments (assignment_kind
// 'specialist_role', role = a roleRegistry id) — those must never leak into the capability
// resolution (an unknown role string would silently demote the principal to 'viewer'), so
// this reads capability rows only.
export const getAssignmentRoleForPrincipal = async ({ firmId = DEFAULT_FIRM_ID, clientId, principal, dbClient = null } = {}) => {
  if (!principal || !clientId) return null;
  if (isFirmMemberPrincipal(principal) || principal.unrestricted) return null;
  const runner = dbClient
    ? (sql, params) => dbClient.query(sql, params)
    : (sql, params) => queryFirmDb(sql, params);
  const result = await runner(
    `select role
       from client_assignments
      where firm_id = $1 and client_id = $2
        and principal_type = $3 and principal_id = $4
        and assignment_kind = 'capability'
        and status = 'active'
        and (starts_at is null or starts_at <= statement_timestamp())
        and (ends_at is null or ends_at > statement_timestamp())
      order by updated_at desc
      limit 1`,
    [firmId, clientId, principal.principalType, principal.principalId]
  );
  return result.rows[0]?.role ?? null;
};

// The acting principal's SPECIALIST role on this client (S2 of the specialist-roles arc):
// the chat seam's half of the one converged role/authority decision. A human occupant hired
// into a bench role (roles/roleEmployment.js) is leashed to that role's action_set through
// decideRoleAction; a principal with no specialist assignment returns null → leash not
// applicable (the pre-S2 behavior, byte-identical). Unrestricted principals (firm members /
// access tokens) are never specialist occupants — they act as Donna core / the founder.
export const getSpecialistRoleForPrincipal = async ({ firmId = DEFAULT_FIRM_ID, clientId, principal, dbClient = null } = {}) => {
  if (!principal || !clientId) return null;
  if (isFirmMemberPrincipal(principal) || principal.unrestricted) return null;
  const runner = dbClient
    ? (sql, params) => dbClient.query(sql, params)
    : (sql, params) => queryFirmDb(sql, params);
  const result = await runner(
    `select role
       from client_assignments
      where firm_id = $1 and client_id = $2
        and principal_type = $3 and principal_id = $4
        and assignment_kind = 'specialist_role'
        and status = 'active'
        and (starts_at is null or starts_at <= now())
        and (ends_at is null or ends_at > now())
      order by updated_at desc
      limit 1`,
    [firmId, clientId, principal.principalType, principal.principalId]
  );
  return result.rows[0]?.role ?? null;
};

// ── Seat-lane helpers for the capability gate (build spec §3.4/§3.5) ────────
const SEAT_LADDER_ROLES = new Set(['junior', 'senior', 'partner']);

// The one amount read the seat materiality bound needs: compiled actions carry
// TARGETS, not amounts, so resolve the largest absolute amount of the
// referenced rows. Fail-CLOSED direction on any error: null amount makes a
// bounded role ROUTE upward, never slip through (the opposite of the gate's
// fail-open infra posture, deliberately — an unreadable amount must not widen
// authority).
const __resolveSeatActionAmount = async ({ action = null, clientId = null, dbClient = null } = {}) => {
  try {
    const runner = dbClient
      ? (sql, params) => dbClient.query(sql, params)
      : (sql, params) => queryFirmDb(sql, params);
    return await resolveActionAmountMinor({
      action,
      clientId,
      lookupTransactionAmounts: async (ids, cid) => {
        const res = await runner(
          'select amount from transactions where client_id = $1 and id = any($2)',
          [cid, ids]
        );
        return (res.rows || []).map((row) => row.amount);
      },
      lookupDocumentAmounts: async (ids, cid) => {
        const res = await runner(
          'select total_amount from documents where client_id = $1 and id = any($2)',
          [cid, ids]
        );
        return (res.rows || []).map((row) => row.total_amount);
      }
    });
  } catch (error) {
    console.warn('[seats] amount resolution failed; routing fail-closed', error?.message || error);
    return null;
  }
};

// The routing receipt: an approval a seat lacks authority for is NEVER hidden
// (spec §3.4) — who escalated, why, the amount and bound, and where it routed.
// Best-effort by design: the refusal itself IS the safe state; a failed
// receipt insert must not turn a routed refusal into a 500.
const __auditSeatApprovalRouted = async ({ firmId, clientId, principal, seatDecision, dbClient = null }) => {
  try {
    const runner = dbClient
      ? (sql, params) => dbClient.query(sql, params)
      : (sql, params) => queryFirmDb(sql, params);
    await runner(
      `insert into audit_events (firm_id, client_id, actor_type, actor_id, action, resource_type, resource_id, metadata)
       values ($1, $2, 'seat', $3, 'seat.approval_routed', 'chat_action', $4, $5::jsonb)`,
      [
        firmId,
        clientId || null,
        principal?.email || principal?.principalId || 'seat',
        seatDecision.action_type,
        JSON.stringify({
          seat_role: seatDecision.seat_role,
          route_to_role: seatDecision.route_to_role,
          reason: seatDecision.reason,
          action_class: seatDecision.action_class,
          amount_minor: seatDecision.amount_minor ?? null,
          bound_minor: seatDecision.bound_minor ?? null,
          escalated_by: principal?.email || principal?.principalId || null
        })
      ]
    );
  } catch (error) {
    console.warn('[seats] approval-routed receipt failed (refusal stands)', error?.message || error);
  }
};

// Pod-safety #3 — the per-action capability gate (reviewer ≠ founder), config-STAGED so it
// lands dormant. `assertFirmAccess` has already decided the principal MAY touch this book; this
// answers whether their ROLE may invoke THIS compiled action_type on it. Since S1 of the
// specialist-roles arc this is the chat seam's wiring of THE one converged role/authority
// decision (roles/roleAuthority.js decideRoleAction — INV-S2): the capability half is
// operatorCapability's own verdict, byte-identical; the specialist-role leash half binds when
// the acting principal holds a specialist assignment (S2's hire flow). Role resolution order
// (the S4 routing law, pinned in test): the principal's OWN active assignment ALWAYS wins —
// a leashed occupant can never escape or borrow a different leash via routing; the explicit
// `specialistRoleId` (S4's seam: the route resolved which hired role's lane this action is —
// Donna's occupant getting the acting role) binds only for a principal who is not themselves a
// specialist occupant. A principal with no assignment and no routed role reduces to the
// capability verdict, byte-identical to pre-S2. Here we supply the reads the decision needs
// (the assignment role + the specialist role + the flag stages) and decide what to DO with the
// verdict:
//   - a capability denial under an acting OPERATOR_CAPABILITY_ENFORCE → throw 403 (unchanged);
//   - a role-leash denial under an acting SPECIALIST_ROLE_ENFORCE → throw 403; at off/shadow
//     it LOGS a would-block (and receipts it at shadow) and never changes behavior — the flag
//     is shadow-ceilinged (clientConfig.SHADOW_CEILING_FLAGS) until INV-S2(b) lifts it;
//   - otherwise → return the verdict WITHOUT throwing, so the apply route can record a
//     would-block on the shadow receipt and proceed unchanged.
// An unrestricted firm member is always 'founder' class → this can never lock the founder out.
// Fail-OPEN on an infra error (the read throws): a capability read must never take down a live
// apply; the verdict rides as observe-only. Returns { allowed, enforced, decision, stage }.
export const assertActionCapability = async ({
  firmId = DEFAULT_FIRM_ID, clientId, principal, actionType, specialistRoleId = null, action = null, dbClient = null
} = {}) => {
  try {
    // A firm member / access token is 'founder' → allowed for everything, and we can skip the
    // assignment-role reads entirely on that (overwhelmingly common) path.
    const unrestricted = isFirmMemberPrincipal(principal) || principal?.unrestricted;
    const assignmentRole = unrestricted
      ? null
      : await getAssignmentRoleForPrincipal({ firmId, clientId, principal, dbClient });
    const capabilityClass = resolveCapabilityClass({ principal, assignmentRole });
    // Own assignment first (never overridable), routed role second (S4 law above).
    const principalSpecialistRoleId = unrestricted
      ? null
      : await getSpecialistRoleForPrincipal({ firmId, clientId, principal, dbClient });
    const effectiveSpecialistRoleId = principalSpecialistRoleId ?? specialistRoleId ?? null;
    const converged = decideRoleAction({ actionType, roleId: effectiveSpecialistRoleId, capabilityClass });
    const decision = converged.capability; // the pre-S1 return shape, unchanged for callers
    // SEAT LANE (build spec §2.3 + §3.4): a principal carrying seat_role is
    // BORN ENFORCED — no flag stage is consulted, in either direction — and a
    // shortfall never rests as a bare deny: the decision routes to the
    // smallest authorized role, is receipted (`seat.approval_routed`,
    // provenance in metadata), and throws a 403 whose `routing` payload the
    // spine surfaces so the item stays proposed in the authorized queue.
    // The per-entity extension point: an assignment row carrying a
    // seat-ladder role outranks the seat row (v1 writes them identically).
    const seatEffectiveRole = unrestricted
      ? null
      : (SEAT_LADDER_ROLES.has(String(assignmentRole || '').toLowerCase())
        ? String(assignmentRole).toLowerCase()
        : (principal?.seatRole || null));
    if (seatEffectiveRole) {
      // The specialist-role leash still binds a seat hired into a bench role,
      // enforced (not staged) like everything else on the seat lane.
      if (converged.role_allowed === false) {
        throw forbidden(`The '${converged.role_id}' role may not perform "${converged.action_type}" — outside its action set.`);
      }
      // External chase fence (build spec §4.6): chases go out in the
      // business's name — an EXTERNAL seat proposes, an internal seat
      // releases, unless the per-firm EXTERNAL_SEAT_CHASE_RELEASE flag acts.
      if (principal?.affiliation === 'external' && CLIENT_FACING_CHASE_VERBS.has(String(actionType || ''))) {
        let releaseAllowed = false;
        try {
          const chaseSnapshot = await (dbClient
            ? readClientConfigSnapshot(dbClient, { firmId, clientId })
            : withFirmDbClient((client) => readClientConfigSnapshot(client, { firmId, clientId })));
          releaseAllowed = clientFlagActs({
            flagKey: EXTERNAL_SEAT_CHASE_RELEASE_FLAG_KEY,
            snapshot: chaseSnapshot,
            envFallback: () => false
          });
        } catch {
          releaseAllowed = false; // unreadable toggle never releases
        }
        if (!releaseAllowed) {
          const chaseDecision = {
            outcome: 'route',
            seat_role: seatEffectiveRole,
            action_type: String(actionType || ''),
            action_class: 'nonroutine_proposal',
            route_to_role: seatEffectiveRole,
            reason: 'external_chase_release_disabled',
            amount_minor: null
          };
          await __auditSeatApprovalRouted({ firmId, clientId, principal, seatDecision: chaseDecision, dbClient });
          const fenced = forbidden('External seats propose client-facing chases; an internal seat releases them (firm toggle EXTERNAL_SEAT_CHASE_RELEASE is off).');
          fenced.code = 'SEAT_AUTHORITY_ROUTED';
          fenced.routing = {
            route_to_role: seatEffectiveRole,
            route_to_affiliation: 'internal',
            reason: 'external_chase_release_disabled',
            action_class: 'nonroutine_proposal',
            amount_minor: null,
            bound_minor: null,
            escalated_by: principal?.email || principal?.principalId || null
          };
          throw fenced;
        }
      }
      const amountMinor = await __resolveSeatActionAmount({ action, clientId, dbClient });
      const seatDecision = decideSeatAuthority({ seatRole: seatEffectiveRole, actionType, amountMinor });
      if (seatDecision.outcome === 'allow') {
        return { allowed: true, enforced: true, decision, role_decision: converged, seat_decision: seatDecision, stage_acts: false };
      }
      await __auditSeatApprovalRouted({ firmId, clientId, principal, seatDecision, dbClient });
      const routed = forbidden(
        `Your seat (${seatDecision.seat_role}) lacks authority for "${seatDecision.action_type}" — routed to ${seatDecision.route_to_role}.`
      );
      routed.code = 'SEAT_AUTHORITY_ROUTED';
      routed.routing = {
        route_to_role: seatDecision.route_to_role,
        reason: seatDecision.reason,
        action_class: seatDecision.action_class,
        amount_minor: seatDecision.amount_minor ?? null,
        bound_minor: seatDecision.bound_minor ?? null,
        escalated_by: principal?.email || principal?.principalId || null
      };
      throw routed;
    }
    // Enforcement only matters when the action is NOT allowed — an allowed apply never needs the
    // flag, so the common (founder / allowed-reviewer) path skips the config read altogether.
    if (converged.allowed) {
      return { allowed: true, enforced: false, decision, role_decision: converged, stage_acts: false };
    }
    let stageActsNow = false;
    let roleStageActs = false;
    let snapshot = null;
    try {
      snapshot = await (dbClient
        ? readClientConfigSnapshot(dbClient, { firmId, clientId })
        : withFirmDbClient((client) => readClientConfigSnapshot(client, { firmId, clientId })));
      // envFallback () => false: a brand-new flag with no legacy behaviour lands DORMANT —
      // enforcement only ever ACTS once a DB row stages it to canary/auto for the client.
      stageActsNow = clientFlagActs({ flagKey: OPERATOR_CAPABILITY_FLAG_KEY, snapshot, envFallback: () => false });
      roleStageActs = specialistRoleGateMode({ snapshot }) === 'act';
    } catch {
      stageActsNow = false; // fail-closed on the ENFORCE side: an unreadable flag never enforces
      roleStageActs = false;
    }
    if (stageActsNow && decision && !decision.allowed) {
      throw forbidden(`Your role (${decision.capability_class}) may not perform "${decision.action_type}" — requires ${decision.required_class} capability.`);
    }
    if (converged.role_allowed === false) {
      if (roleStageActs) {
        throw forbidden(`The '${converged.role_id}' role may not perform "${converged.action_type}" — outside its action set.`);
      }
      // off/shadow: log the would-block; receipt it when the flag observes.
      logSpecialistRoleWouldBlock({ seam: 'chat_apply', firmId, clientId, decision: converged });
      if (specialistRoleGateMode({ snapshot }) === 'shadow') {
        await recordRoleWouldBlock({
          query: dbClient ? (sql, params) => dbClient.query(sql, params) : queryFirmDb,
          firmId, clientId, seam: 'chat_apply', decision: converged
        });
      }
    }
    const enforced = (stageActsNow && decision && !decision.allowed) || (roleStageActs && converged.role_allowed === false);
    return { allowed: converged.allowed, enforced, decision, role_decision: converged, stage_acts: stageActsNow };
  } catch (error) {
    if (error?.statusCode === 403) throw error; // a real capability denial propagates
    // Any other error is infra (read failed) — never take down a live apply on it.
    return { allowed: true, enforced: false, decision: null, stage_acts: false, error: error?.message || String(error) };
  }
};

// Restrict the firm-wide convergence metrics to a principal's allowed clients:
// keep only those `by_client` buckets and re-derive `overall` from them (never
// reflecting a book the principal can't see). The unattributable '__unknown__'
// bucket is dropped under scope. Returns null when the snapshot carried no metric.
const scopeConvergenceMetricsForAccess = (metrics, allowed) => {
  if (!metrics || typeof metrics !== 'object') return metrics ?? null;
  const by_client = {};
  for (const [clientId, m] of Object.entries(metrics.by_client || {})) {
    if (allowed.has(clientId)) by_client[clientId] = m;
  }
  return { overall: mergeConvergenceMetrics(Object.values(by_client)), by_client };
};

// PROJECTION MINIMISATION (docs/donna-data-lifecycle-policy.md §5, Kari
// 2026-07-28). Retention asks how long the SERVER stores something; projection
// asks whether a routine client RECEIVES it at all. They are independent
// controls, and the second is not blocked behind the first.
//
// `/snapshot` serialises this whole object to the browser. It carried
// `llmDecisions` — the last 500 receipts including `llm_reasoning`, the model's
// prose about specific invoices and counterparties. Verified: NOTHING read it.
// No frontend module, and no server module either. The key was write-only.
//
// So decision receipts are removed from the projection entirely, at the SOURCE
// query below rather than only at this filter — a firm member's snapshot no
// longer contains them either. This SUPERSEDES the narrower F-5 client-filter
// and the `llm_raw_response_withheld` marker (#1133): with the collection gone,
// there is nothing to filter or withhold. The stronger guarantee replaces the
// weaker one. A UI that later needs receipt data gets an explicit minimised DTO
// that omits both prose columns by construction — never these raw rows.

export const filterFirmSnapshotForAccess = (snapshot, { principal, allowedClientIds } = {}) => {
  // An unscoped FIRM MEMBER returns here with the snapshot intact — which is
  // exactly what makes the withholding below "firm-member-only" rather than
  // "nobody".
  if (!Array.isArray(allowedClientIds)) return snapshot;

  const allowed = new Set(allowedClientIds);
  const clientAllowed = (item) => item?.client_id ? allowed.has(item.client_id) : true;
  return {
    ...snapshot,
    members: [],
    collaborators: (snapshot.collaborators || []).filter((collaborator) => collaborator.id === principal?.principalId),
    assignments: (snapshot.assignments || []).filter(
      (assignment) =>
        allowed.has(assignment.client_id) &&
        assignment.principal_type === principal?.principalType &&
        assignment.principal_id === principal?.principalId
    ),
    clients: (snapshot.clients || []).filter((client) => allowed.has(client.id)),
    documents: (snapshot.documents || []).filter(clientAllowed),
    transactions: (snapshot.transactions || []).filter(clientAllowed),
    accountingRules: (snapshot.accountingRules || []).filter(clientAllowed),
    clientRules: (snapshot.clientRules || []).filter(clientAllowed),
    xeroConnections: (snapshot.xeroConnections || []).filter(clientAllowed),
    xeroAccounts: (snapshot.xeroAccounts || []).filter(clientAllowed),
    xeroContacts: (snapshot.xeroContacts || []).filter(clientAllowed),
    xeroSyncRuns: (snapshot.xeroSyncRuns || []).filter(clientAllowed),
    ledgerAccounts: (snapshot.ledgerAccounts || []).filter(clientAllowed),
    ledgerJournals: (snapshot.ledgerJournals || []).filter(clientAllowed),
    ledgerLines: (snapshot.ledgerLines || []).filter(clientAllowed),
    closePeriods: (snapshot.closePeriods || []).filter(clientAllowed),
    closeChecks: (snapshot.closeChecks || []).filter(clientAllowed),
    closeArchives: (snapshot.closeArchives || []).filter(clientAllowed),
    clientEvidenceRequests: (snapshot.clientEvidenceRequests || []).filter(clientAllowed),
    reconciliationMatches: (snapshot.reconciliationMatches || []).filter(clientAllowed),
    // Scope the convergence metrics to the principal's allowed clients: keep only
    // those per-client buckets and re-derive `overall` from them, so a scoped
    // collaborator never sees another book's hanging/escalation numbers. The
    // unattributable '__unknown__' bucket is dropped for a scoped principal. (An
    // unscoped firm member returns early above with the firm-wide metric intact.)
    convergenceMetrics: scopeConvergenceMetricsForAccess(snapshot.convergenceMetrics, allowed),
    transactionReviewQueue: (snapshot.transactionReviewQueue || []).filter(clientAllowed),
    merchants: snapshot.merchants || [],
    queue: (snapshot.queue || []).filter(clientAllowed),
    history: (snapshot.history || []).filter(clientAllowed),
    recentUploadBatches: (snapshot.recentUploadBatches || []).filter(clientAllowed),
    // `llm_decisions` is per-client (migration 018) and carries verbatim
    // prompts and model output (`llm_reasoning`, `llm_raw_response`). It rode
    // the `...snapshot` spread unfiltered, so a client-scoped principal got
    // the firm's last 500 decision receipts across EVERY client. This filter
    // is the whole boundary — the query itself is deliberately firm-wide.
    //
    // Note the shape of this function: spread-then-override is fail-OPEN. Any
    // per-client key added to the snapshot leaks until someone remembers to
    // list it here — which is exactly how this key was missed. The source
    // lint in firmDb.test.js ("every firm-snapshot key is either filtered or
    // a declared firm-level key") diffs the two key sets, so the next one
    // fails a test instead of a customer.
    //
    // `llmDecisions` is GONE from the snapshot entirely (policy doc §5), so
    // there is no longer anything here to filter or withhold. Kept as a
    // deliberate empty rather than dropped, so the fail-open shape of this
    // function cannot quietly re-admit the key: if a future change puts
    // decision receipts back in the snapshot, they arrive here as [] rather
    // than riding the `...snapshot` spread unfiltered — which is exactly how
    // F-5 happened. The source lint below pins that every snapshot key is
    // listed; this keeps the entry honest when the collection is empty.
    llmDecisions: []
  };
};

// Two-surface IA (docs/design-donna-two-surface-ia.md): the Documents and
// Close folds are UNCONDITIONAL (graduated 2026-08-27, Kari's call — flag
// terminal state 1: deleted because the behavior is unconditional). The
// TWO_SURFACE_DOCUMENTS_FOLD / TWO_SURFACE_CLOSE_FOLD plane keys are gone;
// any surviving DB stage rows are inert history.

export const getAuthorizedFirmSnapshotFromDb = async ({ firmId = DEFAULT_FIRM_ID, auth } = {}) => {
  const access = await assertFirmAccess({ firmId, auth });
  const snapshot = await getFirmSnapshotFromDb({ firmId });
  const scoped = filterFirmSnapshotForAccess(snapshot, access);
  // This describes the authenticated reader's existing scope; it grants nothing.
  // A successful owner snapshot is not evidence of firm membership.
  const principal = access.principal;
  let surface = isFirmMemberPrincipal(principal) ? 'firm' : null;
  if (principal?.principalType === 'firm_collaborator') {
    if (principal.seatRole) {
      surface = INVITABLE_SEAT_ROLES.includes(principal.seatRole) ? 'firm' : null;
    } else if (principal.role === 'owner') {
      surface = 'owner';
    } else if (['viewer', 'reviewer', 'bookkeeper', 'senior_bookkeeper', 'preparer', 'accountant'].includes(principal.role)) {
      // Existing non-seat collaborator profiles keep their scoped firm surface.
      surface = 'firm';
    }
  }
  return {
    ...scoped,
    workspaceAccess: {
      surface,
      clientIds: Array.isArray(access.allowedClientIds) ? access.allowedClientIds : null
    }
  };
};

// Re-read a reverse target's CURRENT state (pod-safety #2 executor): the review item that
// owns this transaction + the transaction's live reconciliation_status, so the planner can
// detect a moved row (stale) or a since-posted line (needs_ledger_adjustment). Returns the
// shape reverseExecutor.planReverseForRow expects, plus the review_item_id the writer needs.
const readReverseTargetState = async (client, firmId, transactionId) => {
  const ri = await client.query(
    `select id, status
       from transaction_review_queue
      where firm_id = $1 and (item_id = $2 or payload->>'transaction_id' = $2)
      order by updated_at desc
      limit 1`,
    [firmId, String(transactionId)]
  );
  if (!ri.rows[0]) return { present: false };
  const tx = await client.query(
    'select reconciliation_status, coding_state from transactions where firm_id = $1 and id = $2',
    [firmId, String(transactionId)]
  );
  return {
    present: true,
    review_item_id: ri.rows[0].id,
    status: ri.rows[0].status,
    // RT-16: the projected label of the line's coding state (the capture's
    // vocabulary), never a queue-row state.
    review_state: reviewCaseLegacyLabel(tx.rows[0]?.coding_state, ri.rows[0].status),
    coding_state: tx.rows[0]?.coding_state ?? null,
    reconciliation_status: tx.rows[0]?.reconciliation_status ?? null
  };
};

// Re-read a MATCH-leg reverse target's CURRENT state (the match-writer reverse leg): the
// match row's live status + its bank transaction's reconciliation_status and ledger-posted
// signal (a stamped ledger_journal_id means a journal exists — the honest "posted" receipt,
// not a status inference). Returns the shape reverseExecutor.planMatchReverseForRow expects.
const readReverseMatchState = async (client, firmId, matchId) => {
  const result = await client.query(
    `select m.status, m.bank_transaction_id,
            t.reconciliation_status,
            t.payload->>'ledger_journal_id' as ledger_journal_id
       from reconciliation_matches m
       left join transactions t on t.firm_id = m.firm_id and t.id = m.bank_transaction_id
      where m.firm_id = $1 and m.id = $2`,
    [firmId, String(matchId)]
  );
  if (!result.rows[0]) return { present: false };
  return {
    present: true,
    match_status: result.rows[0].status,
    bank_transaction_id: result.rows[0].bank_transaction_id ?? null,
    reconciliation_status: result.rows[0].reconciliation_status ?? null,
    ledger_posted: Boolean(result.rows[0].ledger_journal_id)
  };
};

// G2 PR-14 — the MINT legs' current-state re-reads. One tiny query per kind returning the
// shape reverseExecutor.planMemoryReverseForRow expects ({ present, status }), so a fact
// already dismissed, a rule already retired, or an ask the owner has since ANSWERED is
// visible to the planner before anything is written. The ask read is client-scoped: the
// cancel writer refuses cross-client ids, and the plan must refuse them the same way
// rather than reporting a reversible row the apply phase would then 404 on.
const readReverseFactState = async (client, firmId, factId) => {
  const result = await client.query(
    'select status from firm_facts where firm_id = $1 and id = $2',
    [firmId, String(factId)]
  );
  if (!result.rows[0]) return { present: false };
  return { present: true, status: result.rows[0].status ?? null };
};

const readReverseRuleState = async (client, firmId, ruleId) => {
  const result = await client.query(
    'select status from client_rules where firm_id = $1 and id = $2',
    [firmId, String(ruleId)]
  );
  if (!result.rows[0]) return { present: false };
  return { present: true, status: result.rows[0].status ?? null };
};

const readReverseAskState = async (client, firmId, clientId, askId) => {
  const result = await client.query(
    'select status, transaction_id from client_evidence_requests where firm_id = $1 and client_id = $2 and id = $3',
    [firmId, clientId, String(askId)]
  );
  if (!result.rows[0]) return { present: false };
  return {
    present: true,
    status: result.rows[0].status ?? null,
    transaction_id: result.rows[0].transaction_id ?? null
  };
};

// The audit resource_type per mint leg — the object the reverse actually moved.
const MEMORY_LEG_RESOURCE_TYPE = Object.freeze({
  firm_fact: 'firm_fact',
  client_rule: 'client_rule',
  ask: 'client_evidence_request'
});

// G2 PR-14 — execute ONE planned mint reverse through the object's governed writer.
// Returns { record, writerResult }: `record` is the applied-list row (never throws for
// a benign no-op — a fact already dismissed or an ask answered between plan and apply
// records a skip, which is the honest outcome, not an error), `writerResult` is the
// before/after pair the reverse's own audit row carries.
// The ask leg is the one with a consequence beyond the object itself: cancelling the
// owner's question can leave the anchored LINE resting on neither sanctioned terminal.
// The cancel writer computes that verdict once (`leaves_line_hanging`); it rides into
// the reverse receipt so the FIRST principle is diagnosable from the reverse alone.
const reverseMemoryMintLeg = async ({ firmId, clientId, actorId, leg, entry, proposalId }) => {
  const reason = `Reversed by the operator reverse executor (proposal ${proposalId}).`;
  const expectedStatus = entry.preconditions?.expected_status ?? null;
  if (leg === 'firm_fact') {
    const dismissed = await withFirmDbClient(async (client) => {
      await client.query('begin');
      try {
        const ok = await dismissFirmFact({
          client, firmId, factId: entry.target, actorId, reason, source: 'reverse_executor'
        });
        await client.query('commit');
        return ok;
      } catch (error) {
        try { await client.query('rollback'); } catch { /* best-effort */ }
        throw error;
      }
    });
    return dismissed
      ? {
          record: { status: 'reversed', memory_status: 'dismissed' },
          writerResult: { before_state: { status: expectedStatus }, after_state: { status: 'dismissed' } }
        }
      : {
          // The row moved out of 'active' between the plan and this write.
          record: { status: 'skipped', reason: 'fact_not_active' },
          writerResult: { before_state: { status: expectedStatus }, after_state: { status: null } }
        };
  }
  if (leg === 'client_rule') {
    await updateClientRuleStatusInDb({
      firmId,
      ruleId: entry.target,
      nextStatus: 'retired',
      // The rule was ACTIVE when the apply minted it, so the retire needs the
      // active→retired unlock the settings governance route uses.
      allowActiveRetire: true,
      decidedBy: 'firm',
      actorId
    });
    return {
      record: { status: 'reversed', memory_status: 'retired' },
      writerResult: { before_state: { status: expectedStatus }, after_state: { status: 'retired' } }
    };
  }
  const cancelled = await cancelClientEvidenceRequestInDb({
    firmId, clientId, evidenceRequestId: entry.target, reason, actorId
  });
  if (!cancelled?.cancelled) {
    return {
      record: { status: 'skipped', reason: cancelled?.skipped_reason || 'ask_not_cancellable' },
      writerResult: {
        before_state: { status: cancelled?.prior_status ?? expectedStatus },
        after_state: { status: cancelled?.status ?? null }
      }
    };
  }
  return {
    record: {
      status: 'reversed',
      memory_status: 'cancelled',
      leaves_line_hanging: cancelled.leaves_line_hanging ?? null
    },
    writerResult: {
      before_state: { status: cancelled.prior_status ?? expectedStatus },
      after_state: { status: 'cancelled', leaves_line_hanging: cancelled.leaves_line_hanging ?? null }
    }
  };
};

// Pod-safety #2 — the reverse EXECUTOR. Iterates the captured before_after on the named
// proposal cards → the pure planner → and, when not a dry run, restores each still-safe
// target through the SAME writer the apply routed through (review-item cards via
// updateTransactionReviewItemInDb, match cards via updateReconciliationMatchInDb — both
// with captureBeforeState, so the reverse is itself a captured, attributed mutation).
// Kari's decisions are load-bearing here:
//   - FOUNDER-ONLY: the caller gates this endpoint on requireMember (+ the capability layer);
//   - SURFACE + STAY PROPOSED on a posted line: a `needs_ledger_adjustment` entry is REPORTED,
//     never auto-un-posted (the ledger path is on the isolation list; the fix is a dated
//     adjustment journal Kari posts);
//   - a MOVED row is `stale` and refused (optimistic concurrency).
// G2 PR-14 widened the coverage from what an apply POSTED to what it TAUGHT and ASKED:
// a card whose apply minted a firm fact, a merchant rule or an owner ask carries one
// capture row per minted object, and the restore routes through that object's own
// governed retire writer (dismissFirmFact / updateClientRuleStatusInDb with
// allowActiveRetire / cancelClientEvidenceRequestInDb). Three refusals are load-bearing
// there: a mint that landed on a PRE-EXISTING object is surfaced, never retired (the
// apply didn't create it); an ANSWERED ask is `stale`, never cancelled (the owner's
// answer superseded the action being reversed); and a resend is never auto-fired —
// outbound is not something a reverse may do.
// `dryRun` (default true) returns the plan without any write. Each executed reverse emits an
// audit_events row carrying the structured before/after, so an operator-week is "select these
// N, reverse", never forensics.
export const reverseAppliesInDb = async ({
  firmId = DEFAULT_FIRM_ID, clientId, proposalIds = null, actorId = 'system', dryRun = true, limit = 100
} = {}) => {
  if (!clientId) {
    const error = new Error('clientId is required to reverse applies.');
    error.statusCode = 400;
    throw error;
  }

  // Phase 1 — load the reversible cards + re-read each target's CURRENT state, then plan.
  // Each leg re-reads its own row shape: review-item cards by target (the bank tx id),
  // match cards by the captured match_id (the match row is what gets restored).
  const { plans, stateByTarget } = await withFirmDbClient(async (client) => {
    const cards = await loadReversibleProposalCards({ client, firmId, clientId, proposalIds, limit });
    const stateByTarget = new Map();
    const matchStateById = new Map();
    // Keyed by `<leg>:<object id>` — a fact and a rule can legitimately share an id
    // shape, and the three kinds live in three tables.
    const memoryStateByKey = new Map();
    const plans = [];
    for (const card of cards) {
      const currentByTarget = {};
      // A card the planner will fail-close on (unsupported writer) never consults
      // current state; skip the re-reads.
      const leg = reverseLegForWriter(card.writer);
      if (leg === 'review_item') {
        for (const row of card.before_after) {
          const target = String(row?.target ?? '');
          if (!target) continue;
          if (!stateByTarget.has(target)) {
            stateByTarget.set(target, await readReverseTargetState(client, firmId, target));
          }
          currentByTarget[target] = stateByTarget.get(target);
        }
      } else if (leg === 'match') {
        for (const row of card.before_after) {
          const matchId = matchReverseKeyForRow(row);
          if (!matchId) continue;
          if (!matchStateById.has(matchId)) {
            matchStateById.set(matchId, await readReverseMatchState(client, firmId, matchId));
          }
          currentByTarget[matchId] = matchStateById.get(matchId);
        }
      } else if (leg === 'firm_fact' || leg === 'client_rule' || leg === 'ask') {
        // The MINT legs (G2 PR-14): the capture's target IS the minted object's id.
        for (const row of card.before_after) {
          const objectId = String(row?.target ?? '');
          if (!objectId) continue;
          const key = `${leg}:${objectId}`;
          if (!memoryStateByKey.has(key)) {
            memoryStateByKey.set(key, leg === 'firm_fact'
              ? await readReverseFactState(client, firmId, objectId)
              : leg === 'client_rule'
                ? await readReverseRuleState(client, firmId, objectId)
                : await readReverseAskState(client, firmId, clientId, objectId));
          }
          currentByTarget[objectId] = memoryStateByKey.get(key);
        }
      }
      plans.push(planReverseForCard({ card, currentByTarget }));
    }
    return { plans, stateByTarget };
  });

  const rollUp = () => {
    // `surfaced` (G2 PR-14) counts entries carrying a side effect the reverse
    // deliberately does not undo — a report count beside the four dispositions.
    const totals = { total: 0, reverse: 0, stale: 0, needs_ledger_adjustment: 0, skip: 0, surfaced: 0 };
    for (const p of plans) {
      const s = summarizeReversePlan(p.entries);
      for (const k of Object.keys(totals)) totals[k] += s[k] || 0;
    }
    return totals;
  };

  if (dryRun) {
    return { dry_run: true, client_id: clientId, cards: plans, summary: rollUp(), applied: [] };
  }

  // Phase 2 — execute the applicable 'reverse' entries only, each through ITS OWN captured,
  // attributed writer call (per the plan's leg); a per-entry failure is recorded and never
  // aborts the batch.
  const auditReverseApply = ({ plan, entry, resourceType, resourceId, writerResult }) =>
    withFirmDbClient((client) => client.query(
      `insert into audit_events (firm_id, client_id, actor_type, actor_id, action, resource_type, resource_id, metadata)
       values ($1, $2, 'firm', $3, 'operator.reverse_apply', $4, $5, $6::jsonb)`,
      [
        firmId, clientId, actorId || 'system', resourceType, String(resourceId),
        JSON.stringify({
          proposal_id: plan.proposal_id,
          source: 'reverse_executor',
          ...(entry.match_id ? { match_id: entry.match_id, bank_transaction_id: entry.target } : {}),
          before_state: writerResult?.before_state ?? null,
          after_state: writerResult?.after_state ?? null
        })
      ]
    ));

  const applied = [];
  for (const plan of plans) {
    for (const entry of applicableReverseEntries(plan)) {
      try {
        if (plan.leg === 'match') {
          // Restore through the MATCH writer (updateReconciliationMatchInDb, the same
          // PATCH-path writer the FE uses — INV-1). Its own branch runs the cascade:
          // a re-confirm flips the tx back to 'reconciled', a reject of a manual link
          // reopens it to 'needs_review' — the writer's semantics, never a raw write.
          const writerResult = await updateReconciliationMatchInDb({
            firmId,
            matchId: entry.match_id,
            patch: { ...entry.patch, reviewer_note: 'Reversed by the operator reverse executor.' },
            actorId,
            captureBeforeState: true,
            returnSnapshot: false
          });
          await auditReverseApply({
            plan, entry,
            resourceType: 'reconciliation_match', resourceId: entry.match_id,
            writerResult
          });
          applied.push({ proposal_id: plan.proposal_id, target: entry.target, match_id: entry.match_id, status: 'reversed' });
          continue;
        }
        if (plan.leg === 'firm_fact' || plan.leg === 'client_rule' || plan.leg === 'ask') {
          // The MINT legs (G2 PR-14): each routes to the object's OWN governed retire
          // writer (INV-1 — the reverse is a router onto existing writers, never a
          // second memory backend). None of the three is a delete: the fact keeps its
          // content as the trail of a human "no", the rule keeps its history, the ask
          // keeps the question that was asked.
          const outcome = await reverseMemoryMintLeg({
            firmId, clientId, actorId, leg: plan.leg, entry, proposalId: plan.proposal_id
          });
          await auditReverseApply({
            plan, entry,
            resourceType: MEMORY_LEG_RESOURCE_TYPE[plan.leg], resourceId: entry.target,
            writerResult: outcome.writerResult
          });
          applied.push({
            proposal_id: plan.proposal_id, target: entry.target, kind: entry.kind ?? null, ...outcome.record
          });
          continue;
        }
        const state = stateByTarget.get(String(entry.target));
        if (!state?.review_item_id) {
          applied.push({ proposal_id: plan.proposal_id, target: entry.target, status: 'skipped', reason: 'review_item_not_found' });
          continue;
        }
        const writerResult = await updateTransactionReviewItemInDb({
          firmId,
          reviewItemId: state.review_item_id,
          patch: entry.patch,
          actorId,
          captureBeforeState: true,
          returnSnapshot: false
        });
        await auditReverseApply({
          plan, entry,
          resourceType: 'transaction', resourceId: entry.target,
          writerResult
        });
        applied.push({ proposal_id: plan.proposal_id, target: entry.target, status: 'reversed' });
      } catch (error) {
        applied.push({
          proposal_id: plan.proposal_id, target: entry.target, ...(entry.match_id ? { match_id: entry.match_id } : {}), status: 'error',
          reason: error?.message || 'reverse_apply_failed'
        });
      }
    }
  }

  return {
    dry_run: false,
    client_id: clientId,
    cards: plans,
    summary: { ...rollUp(), reversed: applied.filter((a) => a.status === 'reversed').length, errors: applied.filter((a) => a.status === 'error').length },
    applied,
    snapshot: await getFirmSnapshotFromDb({ firmId })
  };
};
