// Donna — seat lifecycle writers + roster (build spec §3.1/§4/§5/§6).
//
// Same module family and posture as mcp/mcpConsent.js: authenticated firm-API
// surface, deps-injectable for tests, every write in ONE transaction WITH its
// audit event (audit-as-precondition — a seat lifecycle transition cannot
// commit without its receipt; the "human action with no recorded actor" gap
// class is structurally impossible here).
//
// Authorization model (the route passes the resolved access):
//   - seat ADMIN (invite / role change / suspend / reactivate) — OWNER only:
//     an unrestricted principal (firm member / access token) or a
//     collaborator whose row role is 'owner' (the cloud self-serve owner).
//   - entity assignment + engagement extension — OWNER or internal PARTNER
//     (build spec: PARTNER manages entity assignments; OWNER/PARTNER extend).
//   - a SCOPED actor (cloud shared-firm topology) may only touch seats whose
//     entity set stays inside the actor's own allowed set — one owner can
//     never grow a seat into another customer's ventures.
//   - EXTERNAL seats never read the roster (no portfolio views) and never
//     administer seats.

import { createHash } from 'node:crypto';

import {
  DEFAULT_FIRM_ID,
  queryFirmDb,
  withFirmDbClient
} from './firmDb.js';
import { readClientConfigSnapshot, clientFlagActs } from './clientConfig.js';
import {
  validateSeatInvite,
  projectSeat,
  INVITABLE_SEAT_ROLES,
  EXTERNAL_SEAT_CHASE_RELEASE_FLAG_KEY
} from './seatModel.js';
import { sendEmail } from './email/resendClient.js';
import { publicAppOrigin } from './publicAppOrigin.js';

const httpError = (statusCode, code, message) =>
  Object.assign(new Error(message), { statusCode, code });

const shortHash = (value) => createHash('sha256').update(String(value)).digest('hex').slice(0, 24);

// OWNER check: unrestricted, or the collaborator row role is 'owner' (the
// self-provision owner shape). Seat rows carry their seat role in `role`, so
// a PARTNER/SENIOR/JUNIOR seat can never pass this.
const actorIsOwner = (principal) =>
  Boolean(principal?.unrestricted || principal?.principalType === 'firm_member'
    || principal?.principalType === 'access_token' || String(principal?.role || '') === 'owner');

const actorIsOwnerOrInternalPartner = (principal) =>
  actorIsOwner(principal)
  || (principal?.seatRole === 'partner' && principal?.affiliation !== 'external');

const assertNotExternal = (principal) => {
  if (principal?.affiliation === 'external') {
    throw httpError(403, 'EXTERNAL_SEAT_FORBIDDEN', 'External seats cannot access this surface.');
  }
};

const assertClientSubset = (clientIds, allowedClientIds, what = 'entities') => {
  if (!Array.isArray(allowedClientIds)) return; // unrestricted
  const allowed = new Set(allowedClientIds);
  const outside = (clientIds || []).find((id) => !allowed.has(id));
  if (outside) {
    throw httpError(403, 'ENTITY_OUT_OF_SCOPE', `You do not have access to ${what.slice(0, -1)} ${outside}.`);
  }
};

const auditSeatEvent = async (dbClient, { firmId, action, actorPrincipal, seatId, metadata = {} }) => {
  await dbClient.query(
    `insert into audit_events (firm_id, client_id, actor_type, actor_id, action, resource_type, resource_id, metadata)
     values ($1, null, $2, $3, $4, 'seat', $5, $6::jsonb)`,
    [
      firmId,
      actorPrincipal?.unrestricted ? 'firm_member' : 'owner',
      actorPrincipal?.email || actorPrincipal?.userId || actorPrincipal?.principalId || 'system',
      action,
      seatId,
      JSON.stringify(metadata)
    ]
  );
};

const loadSeatRow = async (dbClient, { firmId, seatId }) => {
  const res = await dbClient.query(
    'select * from firm_collaborators where firm_id = $1 and id = $2 and seat_role is not null',
    [firmId, seatId]
  );
  const row = res.rows[0];
  if (!row) throw httpError(404, 'SEAT_NOT_FOUND', 'Seat not found.');
  return row;
};

const seatAssignmentClientIds = async (dbClient, { firmId, seatIds }) => {
  if (!seatIds.length) return new Map();
  const res = await dbClient.query(
    `select principal_id, client_id from client_assignments
      where firm_id = $1 and principal_type = 'firm_collaborator'
        and assignment_kind = 'capability' and principal_id = any($2)`,
    [firmId, seatIds]
  );
  const map = new Map();
  for (const row of res.rows || []) {
    if (!map.has(row.principal_id)) map.set(row.principal_id, []);
    map.get(row.principal_id).push(row.client_id);
  }
  return map;
};

// ── Roster ───────────────────────────────────────────────────────────────────
//
// The "Your people" read. Includes the lazy expiry sweep: any seat whose
// engagement window has passed is suspended-with-receipt HERE too, so the
// audited auto-suspend fires even for a seat that never signs in again.
// Scoping (cloud shared-firm topology): an unrestricted caller sees members +
// every seat; a scoped caller sees their own row plus seats whose entity set
// intersects the caller's allowed set — never another customer's people.
export const listFirmSeats = async ({
  firmId = DEFAULT_FIRM_ID,
  principal = null,
  allowedClientIds = null,
  deps = {}
} = {}) => {
  const d = { withFirmDbClient, ...deps };
  assertNotExternal(principal);
  return d.withFirmDbClient(async (dbClient) => {
    // Expiry sweep first, receipted per seat, so the roster renders the truth.
    const expired = await dbClient.query(
      `select * from firm_collaborators
        where firm_id = $1 and seat_role is not null
          and status <> 'suspended' and ends_at is not null and ends_at <= now()`,
      [firmId]
    );
    for (const row of expired.rows || []) {
      await dbClient.query('begin');
      try {
        const updated = await dbClient.query(
          `update firm_collaborators
              set status = 'suspended', suspended_at = now(),
                  suspended_reason = 'engagement_expired', updated_at = now()
            where id = $1 and status <> 'suspended' returning id`,
          [row.id]
        );
        if (updated.rows.length > 0) {
          await dbClient.query(
            `insert into audit_events (firm_id, client_id, actor_type, actor_id, action, resource_type, resource_id, metadata)
             values ($1, null, 'system', 'system', 'seat.suspended', 'seat', $2, $3::jsonb)`,
            [firmId, row.id, JSON.stringify({
              reason: 'engagement_expired',
              seat_role: row.seat_role,
              affiliation: row.affiliation || 'internal',
              email: row.email,
              ends_at: row.ends_at
            })]
          );
        }
        await dbClient.query('commit');
      } catch (error) {
        await dbClient.query('rollback').catch(() => {});
        throw error;
      }
    }

    const unrestricted = !Array.isArray(allowedClientIds);
    const members = unrestricted
      ? (await dbClient.query(
        "select * from firm_members where firm_id = $1 and status = 'active' order by name asc",
        [firmId]
      )).rows
      : [];
    const collaborators = (await dbClient.query(
      `select * from firm_collaborators
        where firm_id = $1 and (seat_role is not null or role = 'owner')
        order by name asc`,
      [firmId]
    )).rows;
    const byId = await seatAssignmentClientIds(dbClient, { firmId, seatIds: collaborators.map((c) => c.id) });

    const visible = collaborators.filter((row) => {
      if (unrestricted) return true;
      if (row.id === principal?.principalId) return true;
      const ids = byId.get(row.id) || [];
      const allowed = new Set(allowedClientIds);
      return ids.some((id) => allowed.has(id));
    });

    const seats = [
      ...members.map((row) => projectSeat({ source: 'member', row })),
      ...visible.map((row) => projectSeat({ source: 'collaborator', row, clientIds: byId.get(row.id) || [] }))
    ].filter(Boolean);

    const clientRows = (await dbClient.query(
      'select id, company_name from clients where firm_id = $1 order by company_name asc',
      [firmId]
    )).rows.filter((row) => unrestricted || new Set(allowedClientIds).has(row.id));

    return { seats, entities: clientRows };
  });
};

// ── Invite ───────────────────────────────────────────────────────────────────

export const inviteSeatInDb = async ({
  firmId = DEFAULT_FIRM_ID,
  actorPrincipal = null,
  allowedClientIds = null,
  invite = {},
  deps = {}
} = {}) => {
  const d = { withFirmDbClient, ...deps };
  assertNotExternal(actorPrincipal);
  if (!actorIsOwner(actorPrincipal)) {
    throw httpError(403, 'SEAT_ADMIN_REQUIRES_OWNER', 'Only the owner can invite seats.');
  }
  const validated = validateSeatInvite(invite);
  if (!validated.ok) throw httpError(400, validated.code, validated.message);
  const { name, email, seatRole, affiliation, clientIds, endsAt } = validated.normalized;
  assertClientSubset(clientIds, allowedClientIds);

  return d.withFirmDbClient(async (dbClient) => {
    if (clientIds.length > 0) {
      const known = await dbClient.query(
        'select id from clients where firm_id = $1 and id = any($2)',
        [firmId, clientIds]
      );
      if ((known.rows || []).length !== clientIds.length) {
        throw httpError(400, 'ENTITY_UNKNOWN', 'One or more assigned entities do not exist.');
      }
    }
    const seatId = `seat-${shortHash(`${firmId}|${email}`)}`;
    await dbClient.query('begin');
    try {
      const inserted = await dbClient.query(
        `insert into firm_collaborators
           (id, firm_id, user_id, email, name, role, status, access_level,
            seat_role, affiliation, starts_at, ends_at, invited_at)
         values ($1, $2, null, $3, $4, $5, 'invited', 'client_scoped', $5, $6, now(), $7, now())
         on conflict (firm_id, email) do nothing
         returning *`,
        [seatId, firmId, email, name, seatRole, affiliation, endsAt]
      );
      if (inserted.rows.length === 0) {
        throw httpError(409, 'SEAT_EMAIL_TAKEN', 'A member with this email already exists.');
      }
      for (const clientId of clientIds) {
        await dbClient.query(
          `insert into client_assignments
             (id, firm_id, client_id, principal_type, principal_id, role, access_level, assignment_kind, starts_at, ends_at)
           values ($1, $2, $3, 'firm_collaborator', $4, $5, 'client_scoped', 'capability', now(), $6)
           on conflict (client_id, principal_type, principal_id) where assignment_kind = 'capability'
           do update set role = excluded.role, ends_at = excluded.ends_at, updated_at = now()`,
          [`assign-seat-${shortHash(`${seatId}|${clientId}`)}`, firmId, clientId, seatId, seatRole, endsAt]
        );
      }
      await auditSeatEvent(dbClient, {
        firmId,
        action: 'seat.invited',
        actorPrincipal,
        seatId,
        metadata: { email, name, seat_role: seatRole, affiliation, client_ids: clientIds, ends_at: endsAt }
      });
      await dbClient.query('commit');
      return projectSeat({ source: 'collaborator', row: inserted.rows[0], clientIds });
    } catch (error) {
      await dbClient.query('rollback').catch(() => {});
      throw error;
    }
  });
};

// The invite email — post-commit, best-effort by design (the seat row is the
// truth; the roster shows 'invited' regardless). Resend unset ⇒ 'skipped',
// loudly in the response, never a fake 'sent'. The invitee signs in with the
// invited email address — activation is the first authenticated match, so the
// email needs no token link. When the deployment declares a public origin
// (publicAppOrigin: PUBLIC_APP_URL et al.) the email carries the sign-in
// link; without one it still names the exact address to use, so the email is
// never a dead end that only says "sign in" with nowhere to go.
export const sendSeatInviteEmail = async ({ seat, firmName = 'your team', deps = {} } = {}) => {
  const d = { sendEmail, env: process.env, ...deps };
  if (!String(d.env.RESEND_API_KEY || '').trim()) return { status: 'skipped', reason: 'resend_not_configured' };
  try {
    const role = String(seat.seat_role || '').toUpperCase();
    const origin = publicAppOrigin(d.env);
    const signInLine = origin
      ? `<p>Sign in at <a href="${origin}">${origin}</a> using this exact email address (<strong>${seat.email}</strong>) to activate your seat. No account yet? Create one there with the same address.</p>`
      : `<p>Sign in using this exact email address (<strong>${seat.email}</strong>) to activate your seat.</p>`;
    const result = await d.sendEmail({
      to: seat.email,
      subject: `You've been invited to ${firmName} on Donna`,
      html: [
        `<p>${seat.name || seat.email} — you've been invited to <strong>${firmName}</strong> on Donna as <strong>${role}</strong>${seat.affiliation === 'external' ? ' (external)' : ''}.</p>`,
        signInLine,
        seat.ends_at ? `<p>This engagement runs until ${String(seat.ends_at).slice(0, 10)}.</p>` : ''
      ].join('\n')
    });
    return result?.ok ? { status: 'sent' } : { status: 'failed', reason: result?.error || 'send_failed' };
  } catch (error) {
    return { status: 'failed', reason: error?.message || String(error) };
  }
};

// The invite-email RECEIPT (migration 125). The send itself stays best-effort
// post-commit; this stamps its outcome onto the seat row so the roster shows
// it durably, with the `seat.invite_email` audit event in the SAME transaction
// as the stamp. Callers treat a stamping failure as non-fatal (the seat and
// the send already happened; the stamp retries on the next send) but never
// silent — the returned status tells the caller whether the stamp committed.
export const recordSeatInviteEmailOutcome = async ({
  firmId = DEFAULT_FIRM_ID,
  actorPrincipal = null,
  seatId,
  outcome = {},
  deps = {}
} = {}) => {
  const d = { withFirmDbClient, ...deps };
  const status = String(outcome?.status || 'skipped');
  const reason = outcome?.reason ? String(outcome.reason) : null;
  try {
    return await d.withFirmDbClient(async (dbClient) => {
      await dbClient.query('begin');
      try {
        const updated = await dbClient.query(
          `update firm_collaborators
              set invite_email_status = $3, invite_email_reason = $4,
                  invite_email_at = now(), updated_at = now()
            where firm_id = $1 and id = $2 and seat_role is not null
            returning invite_email_status, invite_email_reason, invite_email_at`,
          [firmId, seatId, status, reason]
        );
        if (updated.rows.length === 0) throw httpError(404, 'SEAT_NOT_FOUND', 'Seat not found.');
        await auditSeatEvent(dbClient, {
          firmId,
          action: 'seat.invite_email',
          actorPrincipal,
          seatId,
          metadata: { status, reason }
        });
        await dbClient.query('commit');
        return { recorded: true, ...updated.rows[0] };
      } catch (error) {
        await dbClient.query('rollback').catch(() => {});
        throw error;
      }
    });
  } catch (error) {
    console.warn(`[seats] invite-email outcome stamp failed for seat ${seatId}; send outcome was ${status}`, error?.message || error);
    return { recorded: false, invite_email_status: status, invite_email_reason: reason, invite_email_at: null };
  }
};

// Resend the invite email for a seat still at 'invited' — the recovery path
// for a skipped/failed (or lost-to-spam) first send. Same authorization law
// as invite (owner only, never external, scoped owners only within their own
// seats); refuses for active/suspended seats, where the email would be noise.
// Sends, then stamps the outcome + `seat.invite_email` receipt as above, and
// returns the refreshed seat projection alongside the send result.
export const resendSeatInviteEmail = async ({
  firmId = DEFAULT_FIRM_ID,
  actorPrincipal = null,
  allowedClientIds = null,
  seatId,
  firmName = 'your team',
  deps = {}
} = {}) => {
  const d = { withFirmDbClient, ...deps };
  assertNotExternal(actorPrincipal);
  if (!actorIsOwner(actorPrincipal)) {
    throw httpError(403, 'SEAT_ADMIN_REQUIRES_OWNER', 'Only the owner can resend invites.');
  }
  const { seat, clientIds } = await d.withFirmDbClient(async (dbClient) => {
    const row = await loadSeatRow(dbClient, { firmId, seatId });
    const assignments = await seatAssignmentClientIds(dbClient, { firmId, seatIds: [seatId] });
    return { seat: row, clientIds: assignments.get(seatId) || [] };
  });
  assertClientSubset(clientIds, allowedClientIds, 'seats');
  if (seat.status !== 'invited') {
    throw httpError(409, 'SEAT_NOT_INVITED', 'Only pending invites can be resent.');
  }
  const inviteEmail = await sendSeatInviteEmail({ seat, firmName, deps });
  const stamped = await recordSeatInviteEmailOutcome({ firmId, actorPrincipal, seatId, outcome: inviteEmail, deps });
  return {
    seat: projectSeat({
      source: 'collaborator',
      row: {
        ...seat,
        invite_email_status: stamped.invite_email_status,
        invite_email_reason: stamped.invite_email_reason,
        invite_email_at: stamped.invite_email_at
      },
      clientIds
    }),
    invite_email: inviteEmail
  };
};

// ── Lifecycle updates ────────────────────────────────────────────────────────

export const updateSeatInDb = async ({
  firmId = DEFAULT_FIRM_ID,
  actorPrincipal = null,
  allowedClientIds = null,
  seatId,
  op,
  params = {},
  deps = {}
} = {}) => {
  const d = { withFirmDbClient, ...deps };
  assertNotExternal(actorPrincipal);
  const ownerOps = new Set(['role_change', 'suspend', 'reactivate']);
  if (ownerOps.has(op) && !actorIsOwner(actorPrincipal)) {
    throw httpError(403, 'SEAT_ADMIN_REQUIRES_OWNER', 'Only the owner can manage seats.');
  }
  if (op === 'extend' && !actorIsOwnerOrInternalPartner(actorPrincipal)) {
    throw httpError(403, 'SEAT_EXTEND_REQUIRES_PARTNER', 'Only the owner or a partner can extend an engagement.');
  }
  return d.withFirmDbClient(async (dbClient) => {
    const seat = await loadSeatRow(dbClient, { firmId, seatId });
    const assignments = await seatAssignmentClientIds(dbClient, { firmId, seatIds: [seatId] });
    const seatClients = assignments.get(seatId) || [];
    assertClientSubset(seatClients, allowedClientIds, 'seats');
    await dbClient.query('begin');
    try {
      let updatedRow = seat;
      if (op === 'role_change') {
        const to = String(params.seat_role || '');
        if (!INVITABLE_SEAT_ROLES.includes(to)) {
          throw httpError(400, 'seat_role_invalid', `Role must be one of: ${INVITABLE_SEAT_ROLES.join(', ')}.`);
        }
        updatedRow = (await dbClient.query(
          'update firm_collaborators set seat_role = $2, role = $2, updated_at = now() where id = $1 returning *',
          [seatId, to]
        )).rows[0];
        await dbClient.query(
          `update client_assignments set role = $3, updated_at = now()
            where firm_id = $1 and principal_type = 'firm_collaborator'
              and principal_id = $2 and assignment_kind = 'capability'`,
          [firmId, seatId, to]
        );
        await auditSeatEvent(dbClient, {
          firmId, action: 'seat.role_changed', actorPrincipal, seatId,
          metadata: { from: seat.seat_role, to, affiliation: seat.affiliation, email: seat.email }
        });
      } else if (op === 'suspend') {
        updatedRow = (await dbClient.query(
          `update firm_collaborators
              set status = 'suspended', suspended_at = now(), suspended_reason = 'manual', updated_at = now()
            where id = $1 returning *`,
          [seatId]
        )).rows[0];
        await auditSeatEvent(dbClient, {
          firmId, action: 'seat.suspended', actorPrincipal, seatId,
          metadata: { reason: 'manual', seat_role: seat.seat_role, affiliation: seat.affiliation, email: seat.email }
        });
      } else if (op === 'reactivate') {
        if (seat.status !== 'suspended') throw httpError(409, 'SEAT_NOT_SUSPENDED', 'Seat is not suspended.');
        if (seat.ends_at && new Date(seat.ends_at).getTime() <= Date.now()) {
          throw httpError(409, 'SEAT_ENGAGEMENT_EXPIRED', 'The engagement window has passed — extend it first.');
        }
        const backTo = seat.activated_at ? 'active' : 'invited';
        updatedRow = (await dbClient.query(
          `update firm_collaborators
              set status = $2, suspended_at = null, suspended_reason = null, updated_at = now()
            where id = $1 returning *`,
          [seatId, backTo]
        )).rows[0];
        await auditSeatEvent(dbClient, {
          firmId, action: 'seat.reactivated', actorPrincipal, seatId,
          metadata: { to_status: backTo, seat_role: seat.seat_role, affiliation: seat.affiliation, email: seat.email }
        });
      } else if (op === 'extend') {
        const to = new Date(String(params.ends_at || ''));
        if (Number.isNaN(to.getTime()) || to.getTime() <= Date.now()) {
          throw httpError(400, 'ends_at_invalid', 'The new end date must be a future date.');
        }
        updatedRow = (await dbClient.query(
          'update firm_collaborators set ends_at = $2, updated_at = now() where id = $1 returning *',
          [seatId, to.toISOString()]
        )).rows[0];
        await dbClient.query(
          `update client_assignments set ends_at = $3, updated_at = now()
            where firm_id = $1 and principal_type = 'firm_collaborator'
              and principal_id = $2 and assignment_kind = 'capability'`,
          [firmId, seatId, to.toISOString()]
        );
        await auditSeatEvent(dbClient, {
          firmId, action: 'seat.extended', actorPrincipal, seatId,
          metadata: { from: seat.ends_at, to: to.toISOString(), seat_role: seat.seat_role, affiliation: seat.affiliation, email: seat.email }
        });
      } else {
        throw httpError(400, 'SEAT_OP_UNKNOWN', `Unknown seat operation '${op}'.`);
      }
      await dbClient.query('commit');
      return projectSeat({ source: 'collaborator', row: updatedRow, clientIds: seatClients });
    } catch (error) {
      await dbClient.query('rollback').catch(() => {});
      throw error;
    }
  });
};

// ── Entity assignment ────────────────────────────────────────────────────────

export const setSeatEntitiesInDb = async ({
  firmId = DEFAULT_FIRM_ID,
  actorPrincipal = null,
  allowedClientIds = null,
  seatId,
  clientIds = [],
  deps = {}
} = {}) => {
  const d = { withFirmDbClient, ...deps };
  assertNotExternal(actorPrincipal);
  if (!actorIsOwnerOrInternalPartner(actorPrincipal)) {
    throw httpError(403, 'SEAT_ENTITIES_REQUIRES_PARTNER', 'Only the owner or a partner can manage entity assignments.');
  }
  const ids = [...new Set((clientIds || []).filter(Boolean))];
  assertClientSubset(ids, allowedClientIds);
  return d.withFirmDbClient(async (dbClient) => {
    const seat = await loadSeatRow(dbClient, { firmId, seatId });
    if (seat.affiliation === 'external' && ids.length === 0) {
      throw httpError(400, 'external_requires_entities', 'External seats require at least one assigned entity.');
    }
    const assignments = await seatAssignmentClientIds(dbClient, { firmId, seatIds: [seatId] });
    const current = assignments.get(seatId) || [];
    // A scoped actor must also already hold the seat's CURRENT entities —
    // otherwise a partner could silently strip a seat they cannot even see.
    assertClientSubset(current, allowedClientIds, 'seats');
    if (ids.length > 0) {
      const known = await dbClient.query('select id from clients where firm_id = $1 and id = any($2)', [firmId, ids]);
      if ((known.rows || []).length !== ids.length) {
        throw httpError(400, 'ENTITY_UNKNOWN', 'One or more assigned entities do not exist.');
      }
    }
    const added = ids.filter((id) => !current.includes(id));
    const removed = current.filter((id) => !ids.includes(id));
    await dbClient.query('begin');
    try {
      for (const clientId of added) {
        await dbClient.query(
          `insert into client_assignments
             (id, firm_id, client_id, principal_type, principal_id, role, access_level, assignment_kind, starts_at, ends_at)
           values ($1, $2, $3, 'firm_collaborator', $4, $5, 'client_scoped', 'capability', now(), $6)
           on conflict (client_id, principal_type, principal_id) where assignment_kind = 'capability'
           do update set role = excluded.role, ends_at = excluded.ends_at, updated_at = now()`,
          [`assign-seat-${shortHash(`${seatId}|${clientId}`)}`, firmId, clientId, seatId, seat.seat_role, seat.ends_at]
        );
      }
      if (removed.length > 0) {
        await dbClient.query(
          `delete from client_assignments
            where firm_id = $1 and principal_type = 'firm_collaborator'
              and principal_id = $2 and assignment_kind = 'capability' and client_id = any($3)`,
          [firmId, seatId, removed]
        );
      }
      await auditSeatEvent(dbClient, {
        firmId, action: 'seat.entities_changed', actorPrincipal, seatId,
        metadata: { added, removed, now: ids, seat_role: seat.seat_role, affiliation: seat.affiliation, email: seat.email }
      });
      await dbClient.query('commit');
      return projectSeat({ source: 'collaborator', row: seat, clientIds: ids });
    } catch (error) {
      await dbClient.query('rollback').catch(() => {});
      throw error;
    }
  });
};

// ── The ask-batch send fence (build spec §4.6, route half) ───────────────────
//
// The chat verbs are fenced at the converged gate (firmDb seat lane); the
// batch SEND route runs this same check so no terminal lets an external seat
// release a chase while the firm toggle is off. Receipted like every routed
// refusal.
export const assertExternalChaseReleaseAllowed = async ({
  firmId = DEFAULT_FIRM_ID,
  clientId = null,
  principal = null,
  deps = {}
} = {}) => {
  if (principal?.affiliation !== 'external') return { allowed: true };
  const d = { withFirmDbClient, queryFirmDb, ...deps };
  let releaseAllowed = false;
  try {
    const snapshot = await d.withFirmDbClient((dbClient) => readClientConfigSnapshot(dbClient, { firmId, clientId }));
    releaseAllowed = clientFlagActs({
      flagKey: EXTERNAL_SEAT_CHASE_RELEASE_FLAG_KEY,
      snapshot,
      envFallback: () => false
    });
  } catch {
    releaseAllowed = false;
  }
  if (releaseAllowed) return { allowed: true };
  try {
    await d.queryFirmDb(
      `insert into audit_events (firm_id, client_id, actor_type, actor_id, action, resource_type, resource_id, metadata)
       values ($1, $2, 'seat', $3, 'seat.approval_routed', 'ask_batch', 'send', $4::jsonb)`,
      [firmId, clientId || null, principal?.email || principal?.principalId || 'seat', JSON.stringify({
        seat_role: principal?.seatRole || null,
        reason: 'external_chase_release_disabled',
        route_to_affiliation: 'internal',
        escalated_by: principal?.email || principal?.principalId || null
      })]
    );
  } catch (error) {
    console.warn('[seats] chase-fence receipt failed (refusal stands)', error?.message || error);
  }
  throw httpError(403, 'SEAT_AUTHORITY_ROUTED', 'External seats propose client-facing chases; an internal seat releases them.');
};

// ── Export fence (build spec §4.3) ───────────────────────────────────────────
//
// No statement downloads or bulk data egress for external seats — work
// happens in the queue. Called at the egress routes (financial statements,
// close archive export, ledger export package, batch export).
export const assertSeatExportAllowed = (principal) => {
  if (principal?.affiliation === 'external') {
    throw httpError(403, 'EXTERNAL_SEAT_EXPORT_DENIED', 'External seats cannot export or download statements.');
  }
};
