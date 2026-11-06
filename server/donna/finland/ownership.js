// FI-13 slice 13.0A-2 — the Oy ownership model (D-FI13-14).
//
// "Ownership is a real, effective-dated data model" — not a percentage field.
// The pilot ENVELOPE is one Finnish-resident natural-person 100 % shareholder,
// but ownership FEEDS everything downstream (YEL, 6B shareholder reporting,
// dividend classification, osakaslaina, loss/ownership-change effects, AML
// beneficial ownership, related-party detection), so the MODEL is the real thing.
//
// This module is the pragmatic effective-dated CORE (Kari, 2026-07-12): the store
// over migration 078's four tables (shareholders / share classes / append-only
// ownership events / effective-dated shareholdings) PLUS the pure cap-table
// derivation that turns those rows into the flags the acceptance envelope
// (D-FI13-13) and the downstream consumers read. Store conventions mirror
// statutoryBlocker.js: deterministic ids, idempotent upserts, and pre-migration
// soft-fail (42P01/42703 → null/[]) so a deploy that predates 078 degrades to
// "no ownership recorded" rather than a hard crash.
//
// Effective-dating is load-bearing: a holding active on date D satisfies
// valid_from <= D and (valid_until is null or D < valid_until). An ownership
// CHANGE closes the prior holdings (sets valid_until) and opens new ones under a
// new ownership_event — never an in-place mutation. That is what makes the
// "no ownership change during the pilot ⇒ escalate + re-qualify" rail a fact the
// model can SEE, and lets a cap table be reconstructed as-of any date.
//
// AML / PII posture (the AML workstream is a HARD counsel gate, §8): NO raw
// national identifiers are stored — identifierRef is a REFERENCE, never a hetu /
// Y-tunnus. Beneficial ownership is DERIVED for the pilot (a natural-person direct
// owner at/over the threshold is the beneficial owner); full AML BO modelling is
// counsel-gated, not baked in here.

import crypto from 'node:crypto';

// party_type — pinned to the 078 CHECK by migrations.test.js.
export const OWNERSHIP_PARTY_TYPES = Object.freeze(['natural_person', 'legal_entity']);

// The append-only ownership-event vocabulary — pinned to the 078 CHECK.
export const OWNERSHIP_EVENT_TYPES = Object.freeze([
  'incorporation', 'issuance', 'transfer', 'redemption', 'reclassification', 'correction'
]);

// The beneficial-owner derivation threshold (AML: >25 % direct/indirect is the
// usual test). DERIVED for the pilot only — the real AML program is counsel-gated
// (§8); this is a convenience flag, not an AML determination.
export const BENEFICIAL_OWNER_THRESHOLD_PCT = 25;

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

const hash = (...parts) =>
  crypto.createHash('sha256').update(parts.map((p) => String(p ?? '')).join('|')).digest('hex').slice(0, 16);
const slug = (value) =>
  String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32) || 'x';

// Deterministic ids — the same identity upserts into ONE row (idempotent), never
// a duplicate on re-record. A shareholder's natural key is its identifierRef when
// present, else its display name (client-scoped).
export const buildShareholderId = ({ firmId, clientId, identifierRef = null, displayName = null } = {}) =>
  ['fi-holder', slug(clientId), hash(firmId, clientId, identifierRef || displayName || '')].join('-');
export const buildShareClassId = ({ firmId, clientId, className } = {}) =>
  ['fi-class', slug(clientId), hash(firmId, clientId, className)].join('-');
export const buildOwnershipEventId = ({ firmId, clientId, eventType, effectiveDate, eventKey = '' } = {}) =>
  ['fi-ownevt', slug(clientId), hash(firmId, clientId, eventType, effectiveDate, eventKey)].join('-');
export const buildShareholdingId = ({ firmId, clientId, shareholderId, shareClassId, validFrom } = {}) =>
  ['fi-holding', slug(clientId), hash(firmId, clientId, shareholderId, shareClassId, validFrom)].join('-');

// ── Pure cap-table derivation ────────────────────────────────────────────────

// computeCapTable({ holdings }) → the aggregated cap table + the pilot flags.
// `holdings` are the active (as-of) rows joined with their shareholder + class:
//   { shareholder_id, display_name, party_type, is_finnish_resident,
//     share_class_id, share_count, votes_per_share }.
// Pure, never throws. Percentages are DERIVED here (render-the-verdict — never
// store a percentage that can drift from the share counts). An empty cap table
// yields no owner and every pilot flag false (fail-closed).
export const computeCapTable = ({ holdings = [] } = {}) => {
  const rows = Array.isArray(holdings) ? holdings : [];
  const totalShares = round2(rows.reduce((n, h) => n + num(h.share_count), 0));
  const totalVotes = round2(rows.reduce((n, h) => n + num(h.share_count) * (Number.isFinite(Number(h.votes_per_share)) ? Number(h.votes_per_share) : 1), 0));

  const byShareholder = new Map();
  const classIds = new Set();
  for (const h of rows) {
    if (h.share_class_id) classIds.add(h.share_class_id);
    const id = h.shareholder_id;
    if (!id) continue;
    const votesPerShare = Number.isFinite(Number(h.votes_per_share)) ? Number(h.votes_per_share) : 1;
    const prev = byShareholder.get(id) || {
      id,
      display_name: h.display_name ?? null,
      party_type: h.party_type ?? null,
      is_finnish_resident: h.is_finnish_resident === true,
      // Passthrough for YEL/osakaslaina family aggregation (D-FI13-7/18): a
      // shared free-form group ref, null in the single-owner pilot. Carried
      // here so a consumer can aggregate ownership by family without re-reading.
      family_group_ref: h.family_group_ref ?? null,
      shares: 0,
      votes: 0
    };
    prev.shares = round2(prev.shares + num(h.share_count));
    prev.votes = round2(prev.votes + num(h.share_count) * votesPerShare);
    byShareholder.set(id, prev);
  }

  const shareholders = [...byShareholder.values()].map((s) => {
    const ownership_pct = totalShares > 0 ? round2((s.shares / totalShares) * 100) : null;
    const voting_pct = totalVotes > 0 ? round2((s.votes / totalVotes) * 100) : null;
    return {
      ...s,
      ownership_pct,
      voting_pct,
      // Pilot-DERIVED beneficial owner (natural person at/over the threshold).
      // NOT an AML determination — that is counsel-gated (§8).
      is_beneficial_owner: s.party_type === 'natural_person' && ownership_pct !== null && ownership_pct >= BENEFICIAL_OWNER_THRESHOLD_PCT
    };
  });

  const singleShareholderFullOwnership =
    shareholders.length === 1 && shareholders[0].ownership_pct === 100;
  const allFinnishResidentNaturalPersons =
    shareholders.length > 0 &&
    shareholders.every((s) => s.party_type === 'natural_person' && s.is_finnish_resident === true);

  return {
    totalShares,
    totalVotes,
    shareClassCount: classIds.size,
    shareholders,
    singleShareholderFullOwnership,
    allFinnishResidentNaturalPersons,
    provenance: { deterministic: true }
  };
};

// deriveOwnershipEnvelopeAttributes(capTable) → the SUBSET of acceptance-envelope
// attributes (D-FI13-13) the ownership model can answer. The onboarding intake
// merges this with the non-ownership attributes before calling
// evaluateAcceptanceEnvelope — this is the model's wiring INTO the envelope, kept
// pure so the mapping is testable without a DB.
export const deriveOwnershipEnvelopeAttributes = (capTable = {}) => ({
  singleShareholderFullOwnership: capTable.singleShareholderFullOwnership === true,
  shareholdersAllFinnishResidentNaturalPersons: capTable.allFinnishResidentNaturalPersons === true,
  shareClassCount: Number.isFinite(Number(capTable.shareClassCount)) ? Number(capTable.shareClassCount) : 0
});

// ── Store (pre-migration soft-fail like statutoryBlocker.js) ─────────────────

const softFail = (error) => error?.code === '42P01' || error?.code === '42703';

// Upsert a shareholder (idempotent on identity). Returns { id } or null (bad
// input / pre-migration). is_finnish_resident is derived from residency when not
// given explicitly.
export const upsertShareholder = async ({
  client, firmId, clientId, partyType, displayName,
  residencyCountry = null, isFinnishResident = null, identifierRef = null, familyGroupRef = null, detail = {}
} = {}) => {
  if (!client || !firmId || !clientId || !displayName) return null;
  if (!OWNERSHIP_PARTY_TYPES.includes(partyType)) return null;
  const id = buildShareholderId({ firmId, clientId, identifierRef, displayName });
  const resident = isFinnishResident === null && residencyCountry
    ? String(residencyCountry).trim().toUpperCase() === 'FI'
    : isFinnishResident;
  try {
    await client.query(
      `insert into finland_shareholders
         (id, firm_id, client_id, party_type, display_name, residency_country, is_finnish_resident, identifier_ref, family_group_ref, detail)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)
       on conflict (id) do update set
         party_type = excluded.party_type,
         display_name = excluded.display_name,
         residency_country = excluded.residency_country,
         is_finnish_resident = excluded.is_finnish_resident,
         identifier_ref = excluded.identifier_ref,
         family_group_ref = excluded.family_group_ref,
         detail = finland_shareholders.detail || excluded.detail,
         updated_at = now()`,
      [id, firmId, clientId, partyType, displayName, residencyCountry, resident, identifierRef, familyGroupRef, JSON.stringify(detail || {})]
    );
  } catch (error) {
    if (softFail(error)) return null;
    throw error;
  }
  return { id };
};

// Upsert a share class (idempotent on class_name). Returns { id } or null.
export const upsertShareClass = async ({
  client, firmId, clientId, className, votesPerShare = 1, detail = {}
} = {}) => {
  if (!client || !firmId || !clientId || !className) return null;
  const id = buildShareClassId({ firmId, clientId, className });
  try {
    await client.query(
      `insert into finland_share_classes (id, firm_id, client_id, class_name, votes_per_share, detail)
       values ($1,$2,$3,$4,$5,$6::jsonb)
       on conflict (id) do update set
         votes_per_share = excluded.votes_per_share,
         detail = finland_share_classes.detail || excluded.detail,
         updated_at = now()`,
      [id, firmId, clientId, className, num(votesPerShare) || 1, JSON.stringify(detail || {})]
    );
  } catch (error) {
    if (softFail(error)) return null;
    throw error;
  }
  return { id };
};

// Record an ownership event (append-only; idempotent on the deterministic id).
// Returns { id } or null. An event is the REASON a set of holdings opened/closed.
export const recordOwnershipEvent = async ({
  client, firmId, clientId, eventType, effectiveDate, actorType = 'system', actorId = null, detail = {}, eventKey = ''
} = {}) => {
  if (!client || !firmId || !clientId || !effectiveDate || !actorType) return null;
  if (!OWNERSHIP_EVENT_TYPES.includes(eventType)) return null;
  const id = buildOwnershipEventId({ firmId, clientId, eventType, effectiveDate, eventKey });
  try {
    await client.query(
      `insert into finland_ownership_events (id, firm_id, client_id, event_type, effective_date, actor_type, actor_id, detail)
       values ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)
       on conflict (id) do update set
         detail = finland_ownership_events.detail || excluded.detail`,
      [id, firmId, clientId, eventType, effectiveDate, actorType, actorId, JSON.stringify(detail || {})]
    );
  } catch (error) {
    if (softFail(error)) return null;
    throw error;
  }
  return { id };
};

// Record an effective-dated shareholding. Idempotent on (shareholder, class,
// valid_from). Returns { id } or null. Closing a holding is recording it with
// valid_until set (or updating an open one) — the caller drives the temporal
// close on an ownership change.
export const recordShareholding = async ({
  client, firmId, clientId, shareholderId, shareClassId, shareCount, validFrom,
  validUntil = null, ownershipEventId = null, detail = {}
} = {}) => {
  if (!client || !firmId || !clientId || !shareholderId || !shareClassId || !validFrom) return null;
  if (!Number.isFinite(Number(shareCount))) return null;
  const id = buildShareholdingId({ firmId, clientId, shareholderId, shareClassId, validFrom });
  try {
    await client.query(
      `insert into finland_shareholdings
         (id, firm_id, client_id, shareholder_id, share_class_id, share_count, valid_from, valid_until, ownership_event_id, detail)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)
       on conflict (id) do update set
         share_count = excluded.share_count,
         valid_until = excluded.valid_until,
         ownership_event_id = coalesce(excluded.ownership_event_id, finland_shareholdings.ownership_event_id),
         detail = finland_shareholdings.detail || excluded.detail,
         updated_at = now()`,
      [id, firmId, clientId, shareholderId, shareClassId, num(shareCount), validFrom, validUntil, ownershipEventId, JSON.stringify(detail || {})]
    );
  } catch (error) {
    if (softFail(error)) return null;
    throw error;
  }
  return { id };
};

// loadCapTableAsOf({ client, firmId, clientId, asOf }) → the computed cap table as
// of a date (default today at the DB). Returns computeCapTable over the active
// joined holdings, or null when the store predates migration 078 (soft-fail).
export const loadCapTableAsOf = async ({ client, firmId, clientId, asOf = null } = {}) => {
  if (!client || !firmId || !clientId) return null;
  try {
    const result = await client.query(
      `select h.shareholder_id, s.display_name, s.party_type, s.is_finnish_resident,
              s.family_group_ref,
              h.share_class_id, c.class_name, c.votes_per_share, h.share_count
         from finland_shareholdings h
         join finland_shareholders s on s.id = h.shareholder_id
         join finland_share_classes c on c.id = h.share_class_id
        where h.firm_id = $1 and h.client_id = $2
          and h.valid_from <= coalesce($3::date, current_date)
          and (h.valid_until is null or coalesce($3::date, current_date) < h.valid_until)`,
      [firmId, clientId, asOf]
    );
    return computeCapTable({ holdings: result.rows || [] });
  } catch (error) {
    if (softFail(error)) return null;
    throw error;
  }
};
