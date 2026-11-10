// Donna — the firm-to-owner portal invite (migration 166).
//
// A firm invites its client's business owner into THAT client's portal and
// into nothing else. This module owns the invite lifecycle; it does not add a
// second principal model. Acceptance binds the person as the existing owner
// principal (seatModel.js header: a firm_collaborators row WITHOUT seat_role,
// role 'owner', plus a capability client_assignments row for the one client)
// through the self-signup binder `bindOwnerPrincipalWithClient`, with the
// binder's adoption rule (ownerRowIsAdoptable) unchanged. Access is then
// enforced exactly where it always was: assertFirmAccess.
//
// Who may administer a client's owner access: the firm-side OWNER shapes of
// the seat-admin gate (seatsDb.js actorIsOwner) — an active firm member or
// the deployment access token. actorIsOwner also admits an 'owner'-role
// collaborator (a self-serve owner administering its own team); that shape is
// refused here, so a portal principal can never invite, re-invite or remove
// an owner, even on its own client. Fail-closed: anything else is 403.
//
// Every state change commits in ONE transaction with its audit event
// (resource_type 'client_owner_invite'). Refused acceptances are receipted
// too, in their own transaction after the refusal rolls back.

import { createHash, randomBytes } from 'node:crypto';

import { withFirmDbClient } from './firmDb.js';
import { bindOwnerPrincipalWithClient, ProvisionPrincipalConflictError } from './selfProvisionDb.js';
import { selfProvisionId as idFor } from './selfProvisionIdentity.js';
import { validateClientOwnerInvite, CLIENT_OWNER_ROLE } from './seatModel.js';
import { preferredOwnerTemplateLanguage } from './ownerLanguage.js';
import { sendEmail } from './email/resendClient.js';
import { publicAppOrigin } from './publicAppOrigin.js';

export const CLIENT_OWNER_INVITE_TTL_MS = 14 * 24 * 60 * 60 * 1000;
export const CLIENT_OWNER_INVITE_PATH = '/owner-invite';
export const CLIENT_OWNER_INVITE_RESOURCE = 'client_owner_invite';

const httpError = (statusCode, code, message) =>
  Object.assign(new Error(message), { statusCode, code });

const normalizeEmail = (value) => String(value || '').trim().toLowerCase();

// The link token: 32 random bytes, base64url. Only its sha256 is stored.
export const hashOwnerInviteToken = (token) =>
  createHash('sha256').update(String(token || '')).digest('hex');
const mintToken = () => randomBytes(32).toString('base64url');
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{43}$/;

// ── Authorization ────────────────────────────────────────────────────────────

export const principalMayAdministerClientOwner = (principal) =>
  Boolean(principal && principal.unrestricted === true
    && (principal.principalType === 'firm_member' || principal.principalType === 'access_token'));

export const assertMayAdministerClientOwner = (principal) => {
  if (!principalMayAdministerClientOwner(principal)) {
    throw httpError(403, 'CLIENT_OWNER_ADMIN_REQUIRES_FIRM_OWNER',
      "Only the firm's owner can manage a client's portal access.");
  }
};

const actorOf = (principal) => ({
  type: principal?.principalType === 'access_token' ? 'access_token' : 'firm_member',
  id: principal?.principalId || principal?.email || 'access-token'
});

const audit = async (db, { firmId, clientId, actorType, actorId, action, resourceId, metadata = {} }) => {
  await db.query(
    `insert into audit_events (firm_id, client_id, actor_type, actor_id, action, resource_type, resource_id, metadata)
     values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)`,
    [firmId, clientId, actorType, actorId, action, CLIENT_OWNER_INVITE_RESOURCE, resourceId, JSON.stringify(metadata)]
  );
};

const tx = async (db, fn) => {
  await db.query('begin');
  try {
    const out = await fn();
    await db.query('commit');
    return out;
  } catch (error) {
    await db.query('rollback').catch(() => {});
    throw error;
  }
};

const loadClientRow = async (db, { firmId, clientId, lock = false }) => {
  const row = (await db.query(lock
    ? 'select id, firm_id, company_name, jurisdiction, profile from clients where firm_id = $1 and id = $2 for update'
    : 'select id, firm_id, company_name, jurisdiction, profile from clients where firm_id = $1 and id = $2',
  [firmId, clientId])).rows[0];
  if (!row) throw httpError(404, 'CLIENT_NOT_FOUND', 'Client not found.');
  return row;
};

// (SQL below spells the owner role 'owner' literally — CLIENT_OWNER_ROLE —
// so every statement stays static for the memory-writer scan.)
// Active owner principals of this client, through the same predicate shape
// assertFirmAccess and ASK_DELIVERY_SQL read: a capability assignment inside
// its window, on an active non-seat 'owner' collaborator.
const ACTIVE_OWNER_SQL = `
  select fc.id as collaborator_id, fc.name, fc.email, ca.id as assignment_id, ca.starts_at
    from client_assignments ca
    join firm_collaborators fc on fc.id = ca.principal_id and fc.firm_id = ca.firm_id
   where ca.firm_id = $1 and ca.client_id = $2
     and ca.principal_type = 'firm_collaborator' and ca.assignment_kind = 'capability'
     and ca.status = 'active'
     and (ca.starts_at is null or ca.starts_at <= now())
     and (ca.ends_at is null or ca.ends_at > now())
     and fc.status = 'active' and fc.seat_role is null and fc.role = 'owner'
   order by ca.created_at asc`;

const projectInvite = (row) => row && ({
  id: row.id,
  name: row.name,
  email: row.email,
  language: row.language || null,
  status: row.status,
  expires_at: row.expires_at,
  expired: row.status === 'pending' && new Date(row.expires_at).getTime() <= Date.now(),
  created_at: row.created_at,
  accepted_at: row.accepted_at || null,
  revoked_at: row.revoked_at || null,
  removed_at: row.removed_at || null,
  invite_email_status: row.invite_email_status || null,
  invite_email_reason: row.invite_email_reason || null,
  invite_email_at: row.invite_email_at || null
});

const readOwnerAccess = async (db, { firmId, clientId }) => {
  const owners = (await db.query(ACTIVE_OWNER_SQL, [firmId, clientId])).rows;
  const invites = (await db.query(
    `select * from client_owner_invites where firm_id = $1 and client_id = $2 order by created_at desc limit 10`,
    [firmId, clientId]
  )).rows;
  const pending = invites.find((row) => row.status === 'pending') || null;
  const endedOwner = owners.length ? null : (await db.query(
    `select 1 from client_assignments ca
       join firm_collaborators fc on fc.id = ca.principal_id and fc.firm_id = ca.firm_id
      where ca.firm_id = $1 and ca.client_id = $2 and ca.principal_type = 'firm_collaborator'
        and ca.assignment_kind = 'capability' and fc.seat_role is null and fc.role = 'owner'
      limit 1`,
    [firmId, clientId]
  )).rows[0];
  const state = owners.length ? 'active'
    : pending ? 'invited'
      : (endedOwner || invites.some((row) => row.status === 'removed')) ? 'access_removed'
        : 'not_invited';
  return {
    client_id: clientId,
    state,
    owners: owners.map((row) => ({ collaborator_id: row.collaborator_id, name: row.name, email: row.email, since: row.starts_at })),
    invite: projectInvite(pending),
    history: invites.map(projectInvite)
  };
};

export const getClientOwnerAccessInDb = async ({ firmId, clientId, actorPrincipal, deps = {} } = {}) => {
  assertMayAdministerClientOwner(actorPrincipal);
  const d = { withFirmDbClient, ...deps };
  return d.withFirmDbClient(async (db) => {
    await loadClientRow(db, { firmId, clientId });
    return readOwnerAccess(db, { firmId, clientId });
  });
};

// Same-firm principals this email may NOT become an owner from. Only this
// firm's own rows are read: the inviting firm learns nothing about other
// firms, and an email that is unknown everywhere reads exactly like one known
// elsewhere. (Cross-firm conflicts are refused at acceptance, to the signed-in
// person only.)
const assertEmailInvitableInFirm = async (db, { firmId, email }) => {
  const member = (await db.query(
    "select 1 from firm_members where firm_id = $1 and status = 'active' and lower(email) = $2 limit 1",
    [firmId, email]
  )).rows[0];
  const collaborator = (await db.query(
    'select role, seat_role, status from firm_collaborators where firm_id = $1 and lower(email) = $2 limit 1',
    [firmId, email]
  )).rows[0];
  const ownerShape = collaborator && !collaborator.seat_role && collaborator.role === CLIENT_OWNER_ROLE;
  if (member || (collaborator && !ownerShape)) {
    throw httpError(409, 'CLIENT_OWNER_EMAIL_IS_FIRM_STAFF',
      'This email belongs to someone on your firm’s team. A team member cannot also be a client’s owner — use the owner’s own email address.');
  }
  if (ownerShape && collaborator.status !== 'active') {
    throw httpError(409, 'CLIENT_OWNER_EMAIL_SUSPENDED',
      'This email belongs to an owner whose access in your firm is suspended. Reactivate that person before inviting them.');
  }
};

// ── Invite ───────────────────────────────────────────────────────────────────

export const inviteClientOwnerInDb = async ({ firmId, clientId, actorPrincipal, invite = {}, now = new Date(), deps = {} } = {}) => {
  assertMayAdministerClientOwner(actorPrincipal);
  const validated = validateClientOwnerInvite(invite);
  if (!validated.ok) throw httpError(400, validated.code, validated.message);
  const { name, email, language } = validated.normalized;
  const actor = actorOf(actorPrincipal);
  const d = { withFirmDbClient, ...deps };
  return d.withFirmDbClient(async (db) => tx(db, async () => {
    const client = await loadClientRow(db, { firmId, clientId, lock: true });
    const current = await readOwnerAccess(db, { firmId, clientId });
    if (current.state === 'active') {
      throw httpError(409, 'CLIENT_OWNER_ALREADY_ACTIVE', 'This client already has an owner in the portal. Remove their access first to invite someone else.');
    }
    if (current.state === 'invited') {
      throw httpError(409, 'CLIENT_OWNER_INVITE_PENDING', 'An invitation is already pending for this client. Resend it or revoke it first.');
    }
    await assertEmailInvitableInFirm(db, { firmId, email });
    const token = mintToken();
    const id = `owner-invite-${randomBytes(9).toString('hex')}`;
    const expiresAt = new Date(now.getTime() + CLIENT_OWNER_INVITE_TTL_MS).toISOString();
    const inserted = (await db.query(
      `insert into client_owner_invites
         (id, firm_id, client_id, email, name, language, token_hash, status, expires_at, invited_by_type, invited_by_id)
       values ($1, $2, $3, $4, $5, $6, $7, 'pending', $8, $9, $10)
       returning *`,
      [id, firmId, clientId, email, name, language, hashOwnerInviteToken(token), expiresAt, actor.type, actor.id]
    )).rows[0];
    // An explicit language is the owner's language: store it where the one
    // resolver (ownerLanguage.js) reads it first, so later owner messages use
    // it too. The change is receipted on the invite event below.
    let previousLocale = null;
    if (language) {
      previousLocale = client.profile?.locale ?? null;
      await db.query(
        `update clients set profile = jsonb_set(coalesce(profile, '{}'::jsonb), '{locale}', to_jsonb($3::text), true), updated_at = now()
          where firm_id = $1 and id = $2`,
        [firmId, clientId, language]
      );
    }
    await audit(db, {
      firmId, clientId, actorType: actor.type, actorId: actor.id, action: 'client_owner.invited', resourceId: id,
      metadata: {
        email, name, language, expires_at: expiresAt,
        ...(language ? { profile_locale: { from: previousLocale, to: language } } : {})
      }
    });
    return {
      invite: projectInvite(inserted),
      token,
      emailContext: {
        companyName: client.company_name || client.profile?.companyName || '',
        language: preferredOwnerTemplateLanguage({ ...(client.profile || {}), ...(language ? { locale: language } : {}) }, client)
      }
    };
  }));
};

// Rotate the link of a pending invite (the old link stops working) and renew
// its expiry. Works for an expired pending invite too — that is the recovery.
export const resendClientOwnerInviteInDb = async ({ firmId, clientId, actorPrincipal, now = new Date(), deps = {} } = {}) => {
  assertMayAdministerClientOwner(actorPrincipal);
  const actor = actorOf(actorPrincipal);
  const d = { withFirmDbClient, ...deps };
  return d.withFirmDbClient(async (db) => tx(db, async () => {
    const client = await loadClientRow(db, { firmId, clientId, lock: true });
    const pending = (await db.query(
      "select * from client_owner_invites where firm_id = $1 and client_id = $2 and status = 'pending' for update",
      [firmId, clientId]
    )).rows[0];
    if (!pending) throw httpError(409, 'CLIENT_OWNER_INVITE_NOT_PENDING', 'There is no pending invitation to resend.');
    const token = mintToken();
    const expiresAt = new Date(now.getTime() + CLIENT_OWNER_INVITE_TTL_MS).toISOString();
    const updated = (await db.query(
      `update client_owner_invites set token_hash = $2, expires_at = $3, updated_at = now() where id = $1 returning *`,
      [pending.id, hashOwnerInviteToken(token), expiresAt]
    )).rows[0];
    await audit(db, {
      firmId, clientId, actorType: actor.type, actorId: actor.id, action: 'client_owner.invite_resent', resourceId: pending.id,
      metadata: { email: pending.email, previous_expires_at: pending.expires_at, expires_at: expiresAt, link_rotated: true }
    });
    return {
      invite: projectInvite(updated),
      token,
      emailContext: {
        companyName: client.company_name || client.profile?.companyName || '',
        language: preferredOwnerTemplateLanguage(client.profile || {}, client)
      }
    };
  }));
};

export const revokeClientOwnerInviteInDb = async ({ firmId, clientId, actorPrincipal, deps = {} } = {}) => {
  assertMayAdministerClientOwner(actorPrincipal);
  const actor = actorOf(actorPrincipal);
  const d = { withFirmDbClient, ...deps };
  return d.withFirmDbClient(async (db) => tx(db, async () => {
    await loadClientRow(db, { firmId, clientId, lock: true });
    const revoked = (await db.query(
      `update client_owner_invites set status = 'revoked', revoked_at = now(), revoked_by_id = $3, updated_at = now()
        where firm_id = $1 and client_id = $2 and status = 'pending' returning *`,
      [firmId, clientId, actor.id]
    )).rows[0];
    if (!revoked) throw httpError(409, 'CLIENT_OWNER_INVITE_NOT_PENDING', 'There is no pending invitation to revoke.');
    await audit(db, {
      firmId, clientId, actorType: actor.type, actorId: actor.id, action: 'client_owner.invite_revoked', resourceId: revoked.id,
      metadata: { email: revoked.email }
    });
    return readOwnerAccess(db, { firmId, clientId });
  }));
};

// Remove the owner's access to THIS client: the capability assignment ends
// (status 'ended' + ends_at, the endRoleAssignment convention), which is what
// assertFirmAccess and the ask-delivery predicate read. Nothing is deleted:
// the collaborator row, its other clients' assignments, the audit trail and
// every answer the owner gave stay exactly as they were.
export const removeClientOwnerAccessInDb = async ({ firmId, clientId, actorPrincipal, deps = {} } = {}) => {
  assertMayAdministerClientOwner(actorPrincipal);
  const actor = actorOf(actorPrincipal);
  const d = { withFirmDbClient, ...deps };
  return d.withFirmDbClient(async (db) => tx(db, async () => {
    await loadClientRow(db, { firmId, clientId, lock: true });
    const ended = (await db.query(
      `update client_assignments ca set status = 'ended', ends_at = now(), updated_at = now()
         from firm_collaborators fc
        where fc.id = ca.principal_id and fc.firm_id = ca.firm_id
          and ca.firm_id = $1 and ca.client_id = $2
          and ca.principal_type = 'firm_collaborator' and ca.assignment_kind = 'capability'
          and ca.status = 'active' and (ca.ends_at is null or ca.ends_at > now())
          and fc.seat_role is null and fc.role = 'owner'
        returning ca.id as assignment_id, fc.id as collaborator_id, fc.email`,
      [firmId, clientId]
    )).rows;
    if (ended.length === 0) throw httpError(409, 'CLIENT_OWNER_NOT_ACTIVE', 'This client has no owner with portal access.');
    const invites = (await db.query(
      `update client_owner_invites set status = 'removed', removed_at = now(), removed_by_id = $3, updated_at = now()
        where firm_id = $1 and client_id = $2 and status = 'accepted' returning id`,
      [firmId, clientId, actor.id]
    )).rows;
    await audit(db, {
      firmId, clientId, actorType: actor.type, actorId: actor.id, action: 'client_owner.access_removed',
      resourceId: invites[0]?.id || ended[0].assignment_id,
      metadata: {
        ended_assignments: ended.map((row) => ({ assignment_id: row.assignment_id, collaborator_id: row.collaborator_id, email: row.email })),
        invite_ids: invites.map((row) => row.id)
      }
    });
    return readOwnerAccess(db, { firmId, clientId });
  }));
};

// ── Invite email receipt ─────────────────────────────────────────────────────

export const recordClientOwnerInviteEmailOutcomeInDb = async ({ firmId, clientId, inviteId, actorPrincipal, outcome = {}, deps = {} } = {}) => {
  const d = { withFirmDbClient, ...deps };
  const status = String(outcome?.status || 'skipped');
  const reason = outcome?.reason ? String(outcome.reason) : null;
  const actor = actorOf(actorPrincipal);
  try {
    return await d.withFirmDbClient(async (db) => tx(db, async () => {
      const row = (await db.query(
        `update client_owner_invites set invite_email_status = $3, invite_email_reason = $4, invite_email_at = now(), updated_at = now()
          where firm_id = $1 and id = $2 returning *`,
        [firmId, inviteId, status, reason]
      )).rows[0];
      if (!row) throw httpError(404, 'CLIENT_OWNER_INVITE_NOT_FOUND', 'Invitation not found.');
      await audit(db, {
        firmId, clientId, actorType: actor.type, actorId: actor.id, action: 'client_owner.invite_email', resourceId: inviteId,
        metadata: { status, reason, language: outcome?.language || null }
      });
      return { recorded: true, invite: projectInvite(row) };
    }));
  } catch (error) {
    console.warn(`[owner-invite] email outcome stamp failed for ${inviteId}; send outcome was ${status}`, error?.message || error);
    return { recorded: false, invite: null };
  }
};

// ── Acceptance ───────────────────────────────────────────────────────────────

// One message for every unusable link (unknown, used, revoked, expired), so a
// link-holder learns nothing about which it is.
const INVALID_LINK_MESSAGE = 'This invitation link is no longer valid. Ask your accounting firm to send you a new one.';
const invalidLink = () => httpError(410, 'CLIENT_OWNER_INVITE_INVALID', INVALID_LINK_MESSAGE);

const refusalMessages = {
  CLIENT_OWNER_INVITE_EMAIL_UNVERIFIED: 'Confirm your email address first, then open the invitation link again.',
  CLIENT_OWNER_INVITE_EMAIL_MISMATCH: 'This invitation was sent to a different email address. Sign out and sign in with the address the invitation was sent to.',
  CLIENT_OWNER_INVITE_ACCOUNT_IN_USE: 'This sign-in is already used for another Donna workspace, so it cannot be added to this company’s portal. Sign in with a different email address, or ask your accounting firm.'
};
const refuse = (code) => httpError(403, code, refusalMessages[code]);

// The cross-firm half of the conflict rule, read for the SIGNED-IN identity
// only (its user id or email), and answered only to that person. Principal
// resolution matches `user_id OR email` and stops at the first row, so the
// owner principal must be the identity's ONLY principal: any firm membership,
// any staff seat, or any collaborator row other than this firm's owner row for
// the invited email makes resolution ambiguous — refused, never weakened.
const assertIdentityIsOnlyThisOwner = async (db, { firmId, email, userId }) => {
  const member = (await db.query(
    `select 1 from firm_members where status = 'active'
       and ((user_id is not null and user_id = $1) or lower(email) = $2) limit 1`,
    [userId, email]
  )).rows[0];
  if (member) throw refuse('CLIENT_OWNER_INVITE_ACCOUNT_IN_USE');
  const other = (await db.query(
    `select 1 from firm_collaborators
      where ((user_id is not null and user_id = $1) or lower(email) = $2)
        and not (firm_id = $3 and lower(email) = $2 and seat_role is null and role = 'owner')
      limit 1`,
    [userId, email, firmId]
  )).rows[0];
  if (other) throw refuse('CLIENT_OWNER_INVITE_ACCOUNT_IN_USE');
};

const receiptRefusal = async (d, { invite, auth, code }) => {
  if (!invite) return; // an unknown token names no firm to receipt against
  try {
    await d.withFirmDbClient((db) => audit(db, {
      firmId: invite.firm_id, clientId: invite.client_id, actorType: 'client',
      actorId: normalizeEmail(auth?.email) || String(auth?.userId || 'unknown'),
      action: 'client_owner.accept_refused', resourceId: invite.id,
      metadata: { reason: code, user_id: String(auth?.userId || '') || null }
    }));
  } catch (error) {
    console.warn('[owner-invite] refusal receipt failed (refusal stands)', error?.message || error);
  }
};

export const acceptClientOwnerInviteInDb = async ({ auth, token, deps = {} } = {}) => {
  const d = { withFirmDbClient, ...deps };
  const email = normalizeEmail(auth?.email);
  const userId = String(auth?.userId || '').trim();
  if (auth?.type !== 'supabase_user' || !email || !userId) {
    throw httpError(401, 'CLIENT_OWNER_INVITE_SIGN_IN_REQUIRED', 'Sign in to accept this invitation.');
  }
  if (!TOKEN_SHAPE.test(String(token || ''))) throw invalidLink();
  const tokenHash = hashOwnerInviteToken(token);
  let seen = null;
  try {
    return await d.withFirmDbClient(async (db) => tx(db, async () => {
      const invite = (await db.query(
        'select * from client_owner_invites where token_hash = $1 for update',
        [tokenHash]
      )).rows[0];
      seen = invite || null;
      if (!invite || invite.status !== 'pending' || new Date(invite.expires_at).getTime() <= Date.now()) {
        throw Object.assign(invalidLink(), { receiptCode: invite ? `invite_${invite.status === 'pending' ? 'expired' : invite.status}` : null });
      }
      if (auth.emailVerified !== true) throw refuse('CLIENT_OWNER_INVITE_EMAIL_UNVERIFIED');
      if (email !== normalizeEmail(invite.email)) throw refuse('CLIENT_OWNER_INVITE_EMAIL_MISMATCH');
      await assertIdentityIsOnlyThisOwner(db, { firmId: invite.firm_id, email, userId });
      await loadClientRow(db, { firmId: invite.firm_id, clientId: invite.client_id, lock: true });
      let bound;
      try {
        bound = await bindOwnerPrincipalWithClient(db, {
          firmId: invite.firm_id,
          email,
          userId,
          clientId: invite.client_id,
          displayName: invite.name,
          assignmentId: idFor('assign-owner-invite', invite.firm_id, `${email}|${invite.client_id}`)
        });
      } catch (error) {
        if (error instanceof ProvisionPrincipalConflictError) throw refuse('CLIENT_OWNER_INVITE_ACCOUNT_IN_USE');
        throw error;
      }
      // A re-invited owner whose earlier access was removed: the binder's
      // assignment insert is do-nothing on an existing row, so reopen it here.
      await db.query(
        `update client_assignments set status = 'active', starts_at = now(), ends_at = null, updated_at = now()
          where firm_id = $1 and client_id = $2 and principal_type = 'firm_collaborator' and principal_id = $3
            and assignment_kind = 'capability' and role = 'owner'
            and (status <> 'active' or ends_at is not null)`,
        [invite.firm_id, invite.client_id, bound.collaboratorId]
      );
      const consumed = (await db.query(
        `update client_owner_invites set status = 'accepted', accepted_at = now(), accepted_user_id = $2,
                collaborator_id = $3, updated_at = now()
          where id = $1 and status = 'pending' returning id`,
        [invite.id, userId, bound.collaboratorId]
      )).rows[0];
      if (!consumed) throw invalidLink();
      await audit(db, {
        firmId: invite.firm_id, clientId: invite.client_id, actorType: 'client', actorId: bound.collaboratorId,
        action: 'client_owner.accepted', resourceId: invite.id,
        metadata: { email, user_id: userId, collaborator_id: bound.collaboratorId }
      });
      return { firm_id: invite.firm_id, client_id: invite.client_id };
    }));
  } catch (error) {
    const code = error?.receiptCode || (String(error?.code || '').startsWith('CLIENT_OWNER_INVITE_') ? error.code : null);
    if (code) await receiptRefusal(d, { invite: seen, auth, code });
    if (error && 'receiptCode' in error) delete error.receiptCode;
    throw error;
  }
};

// ── The email ────────────────────────────────────────────────────────────────

const escapeHtml = (value) => String(value ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const formatDate = (iso, language) => {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat(language === 'fi' ? 'fi-FI' : 'en-GB',
    { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }).format(date);
};

// Pure: the subject + HTML of the invite, in the firm's name and the owner's
// language. Finnish is everyday informal (sinä).
export const buildClientOwnerInviteEmail = ({ firmName, companyName, ownerName, email, link, expiresAt, language = 'en' } = {}) => {
  const firm = escapeHtml(firmName || '');
  const company = escapeHtml(companyName || '');
  const name = escapeHtml(ownerName || '');
  const address = escapeHtml(email || '');
  const href = escapeHtml(link || '');
  const until = escapeHtml(formatDate(expiresAt, language));
  if (language === 'fi') {
    return {
      subject: `${firmName} kutsuu sinut Donnaan`,
      html: [
        `<p>Hei ${name},</p>`,
        `<p>${firm} hoitaa ${company ? `yrityksen <strong>${company}</strong>` : 'yrityksesi'} kirjanpitoa Donnassa ja kutsuu sinut yrityksen asiakasportaaliin. Siellä voit lähettää kuitit ja muut tositteet suoraan tilitoimistolle ja vastata sen kysymyksiin.</p>`,
        `<p><a href="${href}">Avaa kutsu</a></p>`,
        `<p>Kirjaudu sisään tai luo tunnus tällä samalla sähköpostiosoitteella (<strong>${address}</strong>). Linkki toimii vain kerran ja on voimassa ${until} asti.</p>`,
        '<p>Jos et odottanut tätä viestiä, voit jättää sen huomiotta.</p>'
      ].join('\n')
    };
  }
  return {
    subject: `${firmName} has invited you to Donna`,
    html: [
      `<p>Hi ${name},</p>`,
      `<p>${firm} keeps the books for ${company ? `<strong>${company}</strong>` : 'your company'} in Donna and has invited you to the company’s portal, where you can send receipts and documents to your accountant and answer their questions.</p>`,
      `<p><a href="${href}">Open your invitation</a></p>`,
      `<p>Sign in or create an account with this same email address (<strong>${address}</strong>). The link works once and is valid until ${until}.</p>`,
      '<p>If you weren’t expecting this email, you can ignore it.</p>'
    ].join('\n')
  };
};

// Post-commit, best-effort, like the staff invite (seatsDb.sendSeatInviteEmail):
// the invite row is the truth and the outcome is stamped on it. Unlike the
// staff invite this email cannot be useful without its link (acceptance is
// the token, not an email match), so a deployment with no public origin
// skips loudly instead of sending a dead end.
export const sendClientOwnerInviteEmail = async ({ invite, token, firmName, companyName, language = 'en', deps = {} } = {}) => {
  const d = { sendEmail, env: process.env, ...deps };
  if (!String(d.env.RESEND_API_KEY || '').trim()) return { status: 'skipped', reason: 'resend_not_configured', language };
  const origin = publicAppOrigin(d.env).replace(/\/+$/, '');
  if (!origin) return { status: 'skipped', reason: 'public_origin_not_configured', language };
  try {
    const message = buildClientOwnerInviteEmail({
      firmName: firmName || 'Your accounting firm',
      companyName,
      ownerName: invite.name,
      email: invite.email,
      link: `${origin}${CLIENT_OWNER_INVITE_PATH}?token=${encodeURIComponent(token)}`,
      expiresAt: invite.expires_at,
      language
    });
    const result = await d.sendEmail({ to: invite.email, subject: message.subject, html: message.html });
    return result?.ok ? { status: 'sent', language } : { status: 'failed', reason: result?.error || 'send_failed', language };
  } catch (error) {
    return { status: 'failed', reason: error?.message || String(error), language };
  }
};

export const readFirmNameInDb = async ({ firmId, deps = {} } = {}) => {
  const d = { withFirmDbClient, ...deps };
  try {
    return await d.withFirmDbClient(async (db) =>
      String((await db.query('select name from firms where id = $1', [firmId])).rows[0]?.name || '').trim());
  } catch {
    return '';
  }
};

// The seat-admin fence for firm-invited owners. seatsDb's owner gate admits an
// 'owner'-role collaborator because a SELF-SERVE owner administers its own
// team; an owner a firm invited into its portal is in that client's portal and
// nothing else, so it never reads the firm's roster or administers seats.
// Keyed on the invite that bound the principal (self-serve owners have none,
// so their behaviour is unchanged). Fail-closed: an unreadable answer fences.
export const principalIsFirmInvitedOwnerInDb = async ({ firmId, principal, deps = {} } = {}) => {
  if (principal?.principalType !== 'firm_collaborator' || principal.seatRole) return false;
  if (String(principal.role || '') !== CLIENT_OWNER_ROLE) return false;
  const d = { withFirmDbClient, ...deps };
  try {
    return await d.withFirmDbClient(async (db) => Boolean((await db.query(
      `select 1 from client_owner_invites
        where firm_id = $1 and collaborator_id = $2 and status in ('accepted', 'removed') limit 1`,
      [firmId, principal.principalId]
    )).rows[0]));
  } catch {
    return true;
  }
};
