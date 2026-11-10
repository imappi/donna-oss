// Phone-app device registrations for notifications (migration 170) — the
// owner of `mobile_push_registrations` and of the contract's
// POST /notifications/registrations and DELETE /notifications/registrations/{id}.
//
// WHY A NEW STORE: Donna has no push infrastructure (owner nudges are email,
// outbound/ownerDigest.js) and no table or writer holding a device address of
// any kind, so there is no existing owner to route to. This module STORES and
// REMOVES registrations only. It sends nothing and calls no notification
// service; the settings resource keeps reporting notification_delivery
// `not_configured` until a sender exists.
//
// WHO OWNS A REGISTRATION: the signed-in owner identity (resolveMobileOwner).
// Donna's owner principal is firm-scoped — a `firm_collaborators` row without
// a seat — so one identity that owns books in two firms is two principals. A
// registration is ONE contract id for (identity, device token) with ONE ROW
// PER OWNER PRINCIPAL the identity held when it registered, each row tied by
// foreign key to that collaborator row (it goes when the row goes). Deleting
// the id removes every row of it. A firm the identity joins later is not
// covered until the app registers again (GAPS.md).
//
// THE RULES this module enforces:
//   - Same identity + same token again → the same registration id
//     (idempotent; an unchanged registration writes nothing).
//   - A token that turns up under a different owner moves to the new owner:
//     the old registration's rows end in the same transaction, each with its
//     own receipt in its own firm's trail.
//   - Removing an id that is not the caller's is 404 (never 403: the phone must
//     not learn whether someone else's registration exists).
//   - The token is personal data and is what a sender would deliver with. It
//     never appears in a log line, an error message or audit metadata; receipts
//     carry `token_ref` (the first 12 hex of its sha256) instead.
//   - Every write commits with its audit_events receipt in the same
//     transaction, attributed to the acting owner principal in that firm.
//
// LIFETIME — a registration must not outlive the access it serves:
//   - the collaborator row is deleted → FK cascade;
//   - the firm removes the owner's access (removeClientOwnerAccessInDb ends the
//     assignment, keeps the collaborator row) or deletes the client (the
//     assignment cascades away, the collaborator row stays) → those writers call
//     endPushRegistrationsWithoutCurrentAccess in their own transaction, which
//     removes the rows of every principal in that firm left with no current
//     client assignment, and carry the ended ids on their own receipt;
//   - an assignment window that simply lapses (ends_at passes) has no writer to
//     hook, so the row can stand until the next registration of that token.
//
// THE RULE A FUTURE SENDER MUST APPLY (nothing here sends; this is the
// contract for whoever builds the sender): a registration row is usable for a
// notification about entity (firm F, client C) ONLY IF, at send time, the
// row's collaborator still has a current assignment to C — the
// getAllowedClientIdsForPrincipal predicate: client_assignments for
// (F, 'firm_collaborator', collaborator_id, C) with status 'active',
// starts_at null or <= now, ends_at null or > now — AND the collaborator row
// is still an active, non-seat 'owner' row. Never send to a registration
// because it exists. The notification preference switches (settings) are a
// further filter on top of this, not a substitute. Prune a token on Expo's
// DeviceNotRegistered receipt by deleting its rows with a receipt.
import { createHash, randomUUID } from 'node:crypto';

import { withFirmDbClient } from '../firmDb.js';
import { mobileError } from './mobileAuth.js';

export const PUSH_REGISTRATION_RESOURCE = 'mobile_push_registration';
export const PUSH_PLATFORMS = Object.freeze(['ios', 'android']);
export const PUSH_LOCALES = Object.freeze(['en', 'fi']);

// Expo push tokens: `ExponentPushToken[…]` (and the newer `ExpoPushToken[…]`).
export const EXPO_PUSH_TOKEN_SHAPE = /^Expo(?:nent)?PushToken\[[A-Za-z0-9_-]{16,128}\]$/;
const REGISTRATION_ID_SHAPE = /^mpr_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export const pushTokenSha256 = (token) => createHash('sha256').update(String(token)).digest('hex');
export const pushTokenRef = (sha256Hex) => String(sha256Hex).slice(0, 12);

// The contract's closed request shape → a validated registration, or 400.
// Messages name the field, never the value.
export const parseRegistrationBody = (body) => {
  const platform = body?.platform;
  if (!PUSH_PLATFORMS.includes(platform)) {
    throw mobileError(400, 'REGISTRATION_INVALID', 'platform must be ios or android.');
  }
  const token = body?.expo_push_token;
  if (typeof token !== 'string' || !EXPO_PUSH_TOKEN_SHAPE.test(token)) {
    throw mobileError(400, 'REGISTRATION_INVALID', 'expo_push_token is not an Expo push token.');
  }
  const locale = body?.locale ?? null;
  if (locale !== null && !PUSH_LOCALES.includes(locale)) {
    throw mobileError(400, 'REGISTRATION_INVALID', 'locale must be en or fi.');
  }
  return { platform, token, tokenSha256: pushTokenSha256(token), locale };
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

const audit = (db, { firmId, actor, action, registrationId, metadata }) => db.query(
  `insert into audit_events (firm_id, client_id, actor_type, actor_id, action, resource_type, resource_id, metadata)
   values ($1, null, $2, $3, $4, 'mobile_push_registration', $5, $6::jsonb)`,
  [firmId, actor.type, actor.id, action, registrationId, JSON.stringify(metadata)]
);

// The acting owner's principal in a firm, or — for a row in a firm where the
// actor holds no principal (a token that moved across firms) — the system, so
// one firm's trail never names another firm's principal.
const actorIn = (principalsByFirm, firmId) => {
  const principal = principalsByFirm.get(firmId);
  return principal
    ? { type: 'firm_collaborator', id: principal.principalId }
    : { type: 'system', id: 'mobile_push_registration' };
};

// Each owner principal that STILL has a current client assignment (the
// getAllowedClientIdsForPrincipal predicate that admitted it), read
// on the writer's connection with FOR SHARE: an access removal or client
// delete running concurrently either commits first (and this sees no row) or
// waits for this transaction and then sweeps what it wrote.
const principalsWithCurrentAccess = async (db, owner) => {
  const current = new Map();
  for (const { firmId, principal } of owner.owners) {
    const rows = (await db.query(
      `select ca.id
         from client_assignments ca
        where ca.firm_id = $1 and ca.principal_type = 'firm_collaborator' and ca.principal_id = $2
          and ca.status = 'active'
          and (ca.starts_at is null or ca.starts_at <= statement_timestamp())
          and (ca.ends_at is null or ca.ends_at > statement_timestamp())
        for share`,
      [firmId, principal.principalId]
    )).rows;
    if (rows.length) current.set(firmId, principal);
  }
  return current;
};

// POST /notifications/registrations → { status: 201, body: { id } }.
export const registerPushDevice = async ({ owner, body, deps = {} }) => {
  const registration = parseRegistrationBody(body);
  const { withFirmDbClient: withDb = withFirmDbClient } = deps;
  const id = await withDb((db) => tx(db, async () => {
    // One registration of a given token at a time, across every firm.
    await db.query(`select pg_advisory_xact_lock(hashtextextended('mobile_push_registration:' || $1, 0))`, [registration.tokenSha256]);
    const mine = await principalsWithCurrentAccess(db, owner);
    if (!mine.size) throw mobileError(403, 'NO_BOOKS', 'This account is not linked to any business books yet.');
    const existing = (await db.query(
      `select id, registration_id, firm_id, collaborator_id, platform, locale
         from mobile_push_registrations where token_sha256 = $1 for update`,
      [registration.tokenSha256]
    )).rows;
    const isMine = (row) => mine.get(row.firm_id)?.principalId === row.collaborator_id;
    const registrationId = existing.find(isMine)?.registration_id || `mpr_${randomUUID()}`;
    const tokenRef = pushTokenRef(registration.tokenSha256);

    // Rows of this token that are not the caller's current registration end:
    // another owner's (the token moved), or a principal of the caller's that
    // no longer has current access.
    for (const row of existing) {
      if (isMine(row) && row.registration_id === registrationId) continue;
      await db.query('delete from mobile_push_registrations where id = $1', [row.id]);
      await audit(db, {
        firmId: row.firm_id,
        actor: actorIn(mine, row.firm_id),
        action: 'mobile_push_registration.ended',
        registrationId: row.registration_id,
        metadata: {
          reason: row.registration_id === registrationId ? 'access_not_current' : 'token_moved_to_another_registration',
          collaborator_id: row.collaborator_id,
          platform: row.platform,
          token_ref: tokenRef
        }
      });
    }

    for (const [firmId, principal] of mine) {
      const before = existing.find((row) => row.firm_id === firmId && isMine(row) && row.registration_id === registrationId);
      if (before && before.platform === registration.platform && (before.locale ?? null) === registration.locale) continue;
      await db.query(
        `insert into mobile_push_registrations
           (id, registration_id, firm_id, collaborator_id, platform, expo_push_token, token_sha256, locale)
         values ($1, $2, $3, $4, $5, $6, $7, $8)
         on conflict (registration_id, firm_id) do update
           set collaborator_id = excluded.collaborator_id, platform = excluded.platform,
               expo_push_token = excluded.expo_push_token, locale = excluded.locale, updated_at = now()`,
        [randomUUID(), registrationId, firmId, principal.principalId, registration.platform,
          registration.token, registration.tokenSha256, registration.locale]
      );
      await audit(db, {
        firmId,
        actor: { type: 'firm_collaborator', id: principal.principalId },
        action: 'mobile_push_registration.registered',
        registrationId,
        metadata: {
          created: !before,
          collaborator_id: principal.principalId,
          platform: registration.platform,
          locale: registration.locale,
          token_ref: tokenRef,
          channel: 'mobile'
        }
      });
    }
    return registrationId;
  }));
  return { status: 201, body: { id } };
};

// DELETE /notifications/registrations/{registrationId} → { status: 204 }.
export const unregisterPushDevice = async ({ owner, registrationId, deps = {} }) => {
  const notFound = () => mobileError(404, 'NOT_FOUND', 'No such registration in this account.');
  if (typeof registrationId !== 'string' || !REGISTRATION_ID_SHAPE.test(registrationId)) throw notFound();
  const { withFirmDbClient: withDb = withFirmDbClient } = deps;
  const principalsByFirm = new Map(owner.owners.map(({ firmId, principal }) => [firmId, principal]));
  await withDb((db) => tx(db, async () => {
    const rows = (await db.query(
      `select id, firm_id, collaborator_id, platform, token_sha256
         from mobile_push_registrations where registration_id = $1 for update`,
      [registrationId]
    )).rows;
    // Yours if any row of it is one of your principals; a registration id is
    // only ever shared by one identity's principals, so all its rows go.
    if (!rows.some((row) => principalsByFirm.get(row.firm_id)?.principalId === row.collaborator_id)) throw notFound();
    for (const row of rows) {
      await db.query('delete from mobile_push_registrations where id = $1', [row.id]);
      await audit(db, {
        firmId: row.firm_id,
        actor: actorIn(principalsByFirm, row.firm_id),
        action: 'mobile_push_registration.removed',
        registrationId,
        metadata: {
          collaborator_id: row.collaborator_id,
          platform: row.platform,
          token_ref: pushTokenRef(row.token_sha256),
          channel: 'mobile'
        }
      });
    }
  }));
  return { status: 204 };
};

// The access writers' sweep lives in its own import-free module so that
// db/clients.js and clientOwnerInvitesDb.js can call it without an import
// cycle through firmDb.js.
export { endPushRegistrationsWithoutCurrentAccess } from './mobilePushRegistrationAccess.js';

// Mobile routes this module answers (path relative to the API prefix).
// Each handler resolves { status, body }.
const decodeSegment = (value) => {
  try { return decodeURIComponent(value); } catch { return ''; }
};
export const PUSH_REGISTRATION_ROUTES = Object.freeze([
  ['POST', /^\/notifications\/registrations$/, async ({ owner, readBody }) => registerPushDevice({ owner, body: await readBody() })],
  ['DELETE', /^\/notifications\/registrations\/([^/]+)$/, ({ owner, match }) => unregisterPushDevice({ owner, registrationId: decodeSegment(match[1]) })]
]);
