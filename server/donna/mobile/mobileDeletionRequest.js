// POST /me/deletion-request — an owner asks for their account to be deleted.
//
// WHAT THIS DOES: records the request, once per owner identity, and tells the
// owner the truth about what happens next. NOTHING is deleted or changed:
// books, documents, the owner principal (firm_collaborators), its
// client_assignments and the identity-provider sign-in are untouched. The only
// rows written are one owner_deletion_requests row (migration 171) and, in the
// same transaction, one audit_events row per firm the request covers,
// attributed to the owner principal in that firm.
//
// Why a new store: Donna has no owner-side deletion request anywhere. The one
// deletion writer, db/clients.js deleteClientInDb, is a firm-side operation
// that removes a whole client (and cascades its books), guarded by the KPL
// 2:10 retention hold (finland/retention.js); it is not something an owner's
// request may run. client_owner_invites (166) is the invite lifecycle only.
//
// Why NO hand-off to the firm: the existing way to put something in front of
// a named firm-side person is the ask primitive (client_evidence_requests with
// audience 'seat', askAudience.js / db/asks.js) and its Mentions lane
// (mention_notifications, 124). Neither fits without bending it:
//   - an ask must be anchored on a transaction, review item, document or a
//     closed standing subject (askIdentity.buildCanonicalAnchor); a deletion
//     request has none, so it would need a new anchor kind in the shared ask
//     identity and writer;
//   - an open seat ask is bookkeeping state: it moves the book's convergence
//     verdict to on_owner/open_seat_ask (reconcileConvergenceState, caseHealth),
//     appears in the firm feed's ask lane (firmFeed.js) and is read by the close
//     exceptions (db/close.js) — a deletion request would read as an unanswered
//     bookkeeping question;
//   - mention_notifications only accepts artifact_type transaction|document and
//     kinds mention/assign/ask/ask_answered/agent_escalation (CHECKs in 124).
// So the request is recorded and the owner is told, in plain words, that Donna
// has NOT passed it to the firm. The message never claims otherwise.
//
// The message is written here, in the owner's language as ownerLanguage.js
// resolves it for the owner's default business (getClientOwnerLanguageInDb,
// the one reader), Finnish in the informal sinä form.
import { randomUUID } from 'node:crypto';

import { getClientOwnerLanguageInDb, withFirmDbClient } from '../firmDb.js';
import { RETENTION_YEARS } from '../finland/retention.js';
import { mobileError } from './mobileAuth.js';
import { readEntities } from './mobileReads.js';

export const DELETION_REQUEST_RESOURCE = 'owner_deletion_request';
export const DELETION_REQUEST_ACTION = 'owner_deletion_request.recorded';
export const DELETION_REQUEST_STATUSES = Object.freeze(['recorded', 'acknowledged', 'completed', 'withdrawn']);

// One request per owner identity: the identity provider's user id, or the
// email for an identity that has none (resolveMobileOwner admits either).
export const deletionIdentityKey = (identity = {}) => {
  const userId = String(identity.userId || '').trim();
  if (userId) return userId;
  const email = String(identity.email || '').trim().toLowerCase();
  return email ? `email:${email}` : '';
};

// ── The message ───────────────────────────────────────────────────────────

const EN_MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const pad = (n) => String(n).padStart(2, '0');

// The instant in UTC, labelled as such: the server does not know the phone's
// time zone, and a day-only date could be off by one around midnight.
const formatInstant = (instant, language) => {
  const at = new Date(instant);
  const day = at.getUTCDate();
  const month = at.getUTCMonth();
  const year = at.getUTCFullYear();
  const time = language === 'fi'
    ? `${pad(at.getUTCHours())}.${pad(at.getUTCMinutes())}`
    : `${pad(at.getUTCHours())}:${pad(at.getUTCMinutes())}`;
  return language === 'fi'
    ? `${day}.${month + 1}.${year} klo ${time} (UTC)`
    : `${day} ${EN_MONTHS[month]} ${year} at ${time} UTC`;
};

const joinNames = (names, language) => {
  const and = language === 'fi' ? 'ja' : 'and';
  if (names.length <= 1) return names[0] || '';
  return `${names.slice(0, -1).join(', ')} ${and} ${names.at(-1)}`;
};

// Pure: the owner-facing statement for a recorded request. `firms` are the
// firms' names (firms.name), `businesses` the covered books' names, and
// `finnish` whether any covered business is a Finnish book (KPL 2:10 applies).
export const buildDeletionRequestMessage = ({ language, requestedAt, firms = [], businesses = [], finnish = false }) => {
  const fi = language === 'fi';
  const when = formatInstant(requestedAt, language);
  const firmNames = firms.map((name) => String(name || '').trim()).filter(Boolean);
  const businessNames = businesses.map((name) => String(name || '').trim()).filter(Boolean);
  const plural = firmNames.length > 1;
  const sentences = fi
    ? [
      `Pyyntösi poistaa Donna-tilisi kirjattiin ${when}.`,
      businessNames.length
        ? `Pyyntö koskee tiliäsi ja ${businessNames.length > 1 ? 'yritysten' : 'yrityksen'} ${joinNames(businessNames, 'fi')} kirjanpitoa.`
        : 'Pyyntö koskee tiliäsi ja yrityksesi kirjanpitoa.',
      'Mitään ei ole poistettu: tilisi, kirjautumisesi ja kirjanpitosi pysyvät toistaiseksi ennallaan.',
      firmNames.length
        ? `Pyynnön ${plural ? 'käsittelevät tilitoimistosi' : 'käsittelee tilitoimistosi'} ${joinNames(firmNames, 'fi')}.`
        : 'Pyynnön käsittelee tilitoimistosi.',
      `Donna ei ole välittänyt pyyntöä ${plural ? 'tilitoimistoille' : 'tilitoimistolle'} automaattisesti, joten ota ${plural ? 'niihin' : 'siihen'} yhteyttä myös itse.`,
      'Kirjanpitoaineistoa, joka lain mukaan on säilytettävä, ei voi poistaa ennen kuin säilytysaika on päättynyt.',
      ...(finnish
        ? [`Suomessa kirjanpitokirjat on säilytettävä ${RETENTION_YEARS.kirjanpitokirja} vuotta tilikauden päättymisestä ja tositteet ${RETENTION_YEARS.tosite} vuotta sen vuoden lopusta, jona tilikausi päättyi.`]
        : [])
    ]
    : [
      `Your request to delete your Donna account was recorded on ${when}.`,
      businessNames.length
        ? `It covers your account and the books of ${joinNames(businessNames, 'en')}.`
        : 'It covers your account and your business’s books.',
      'Nothing has been deleted: your account, your sign-in and your books stay as they are for now.',
      firmNames.length
        ? `Your accounting ${plural ? 'firms' : 'firm'}, ${joinNames(firmNames, 'en')}, ${plural ? 'handle' : 'handles'} the request.`
        : 'Your accounting firm handles the request.',
      `Donna has not passed your request on to ${plural ? 'them' : 'the firm'} automatically, so please contact ${plural ? 'them' : 'the firm'} yourself as well.`,
      'Bookkeeping records that the law requires to be kept cannot be deleted before that period ends.',
      ...(finnish
        ? [`In Finland, the books must be kept for ${RETENTION_YEARS.kirjanpitokirja} years after the financial year ends, and receipts and other vouchers for ${RETENTION_YEARS.tosite} years after the end of the year in which the financial year ended.`]
        : [])
    ];
  return sentences.join(' ');
};

// ── Persistence ───────────────────────────────────────────────────────────

const REQUEST_COLUMNS = 'id, status, requested_at, message';

const projectRequest = (row) => ({
  requested_at: new Date(row.requested_at).toISOString(),
  message: row.message
});

const readRequest = async (db, identityKey) =>
  (await db.query(`select ${REQUEST_COLUMNS} from owner_deletion_requests where identity_key = $1`, [identityKey])).rows[0] || null;

// The firms' names, as firms.name holds them.
const readFirmNames = async (db, firmIds) => {
  const result = await db.query('select id, name from firms where id = any($1::text[])', [firmIds]);
  return new Map(result.rows.map((row) => [row.id, row.name]));
};

// Record the request for an already-resolved owner (resolveMobileOwner), or
// return the one already recorded. Returns the contract body
// { requested_at, message }.
export const requestOwnerDeletion = async ({
  owner,
  now = () => new Date(),
  withFirmDbClientFn = withFirmDbClient,
  readLanguage = getClientOwnerLanguageInDb,
  readEntitiesFn = readEntities
} = {}) => {
  const identityKey = deletionIdentityKey(owner?.identity);
  if (!identityKey || !owner?.owners?.length) throw mobileError(401, 'AUTH_REQUIRED', 'Sign in to continue.');

  const existing = await withFirmDbClientFn((db) => readRequest(db, identityKey));
  if (existing) return projectRequest(existing);

  // What the request covers, read before the write: every firm and business
  // the owner was admitted to.
  const firms = [];
  for (const { firmId, principal, clientIds } of owner.owners) {
    const businesses = await readEntitiesFn({ firmId, clientIds });
    firms.push({ firmId, principalId: principal.principalId, clientIds, businesses });
  }
  const first = owner.owners[0];
  const language = await readLanguage({ firmId: first.firmId, clientId: first.clientIds[0] }) === 'fi' ? 'fi' : 'en';

  return withFirmDbClientFn(async (db) => {
    await db.query('begin');
    try {
      const names = await readFirmNames(db, firms.map((firm) => firm.firmId));
      const requestedAt = now();
      const scope = firms.map((firm) => ({
        firm_id: firm.firmId,
        firm_name: names.get(firm.firmId) || null,
        principal_id: firm.principalId,
        businesses: firm.businesses.map((row) => ({
          client_id: row.id, name: row.company_name || null, jurisdiction: row.jurisdiction || row.firm_jurisdiction || null
        }))
      }));
      const businesses = scope.flatMap((firm) => firm.businesses);
      const message = buildDeletionRequestMessage({
        language,
        requestedAt,
        firms: scope.map((firm) => firm.firm_name),
        businesses: businesses.map((row) => row.name),
        finnish: businesses.some((row) => String(row.jurisdiction || '').toUpperCase() === 'FI')
      });
      const inserted = (await db.query(
        `insert into owner_deletion_requests
           (id, identity_key, user_id, email, status, firm_ids, client_ids, scope, language, message, requested_at)
         values ($1, $2, $3, $4, 'recorded', $5::text[], $6::text[], $7::jsonb, $8, $9, $10)
         on conflict (identity_key) do nothing
         returning id, status, requested_at, message`,
        [
          `odr_${randomUUID()}`, identityKey, owner.identity.userId || null, owner.identity.email || null,
          firms.map((firm) => firm.firmId), firms.flatMap((firm) => firm.clientIds), JSON.stringify(scope),
          language, message, requestedAt
        ]
      )).rows[0];
      if (!inserted) {
        // A concurrent request won the identity: return the one it recorded.
        await db.query('rollback');
        return projectRequest(await readRequest(db, identityKey));
      }
      for (const firm of scope) {
        await db.query(
          `insert into audit_events (firm_id, client_id, actor_type, actor_id, action, resource_type, resource_id, metadata)
           values ($1, null, 'firm_collaborator', $2, 'owner_deletion_request.recorded', 'owner_deletion_request', $3, $4::jsonb)`,
          [firm.firm_id, firm.principal_id, inserted.id, JSON.stringify({
            status: inserted.status,
            client_ids: firm.businesses.map((row) => row.client_id),
            requested_at: new Date(inserted.requested_at).toISOString(),
            surface: 'mobile',
            firm_notified: false,
            deleted: []
          })]
        );
      }
      await db.query('commit');
      return projectRequest(inserted);
    } catch (error) {
      await db.query('rollback').catch(() => {});
      throw error;
    }
  });
};
