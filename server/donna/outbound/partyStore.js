// Outbound party store (M0.2, G1 — the root of the Phase-1 dependency graph).
// Persistence + deterministic resolution for client_parties / party_channels /
// party_attributes / party_merge_suggestions (migration 090).
//
// Layout per the marketing-rail precedent (risk #2): the pipeline owns its
// modules here; firmDb.js is only the pool (queryFirmDb / withFirmDbClient
// imports) — no methods added to the monolith.
//
// Resolution doctrine (trust-the-strong-LLM applied to identity):
//   - deterministic identity (same business id) may match and ENRICH;
//   - a name match with a CONFLICTING business id is a DIFFERENT entity —
//     never merged, a new party row;
//   - a fuzzy signal (shared email, differing names) PROPOSES a merge
//     suggestion and rests 'proposed' until confirmed (suggest-and-confirm);
//   - applyPartyMerge refuses conflicting business ids unconditionally (the
//     Keep layer; no override parameter exists).
//
// Transaction posture: low-level writers run on the CALLER's client handle
// and never begin/commit; orchestrators (resolvePartyCandidate via backfill)
// wrap each candidate in its own short transaction so one poisoned row never
// rolls back the rest (the F5 lesson, same as askReaskCadence).
//
// Every mutation writes an audit_events row in the same transaction, with the
// acting principal threaded (risk #3: outbound receipts/audits carry
// attribution from day one — actor defaults to system only for system sweeps).

import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { validBuyerRegistrationFact } from './buyerRegistration.js';

// Pinned by migrations.test.js against the 090 CHECK constraints.
export const PARTY_STATUSES = Object.freeze(['active', 'merged', 'archived']);
export const PARTY_CHANNEL_KINDS = Object.freeze([
  'email', 'phone', 'sms', 'whatsapp', 'postal', 'einvoice_address'
]);
export const PARTY_MERGE_SUGGESTION_STATUSES = Object.freeze([
  'proposed', 'confirmed', 'rejected', 'superseded'
]);

// The closed attribute set setPartyAttribute accepts (denormalized onto
// client_parties). Extending this list is a deliberate code change, never a
// free-text write (closed-enum discipline).
export const PARTY_ATTRIBUTES = Object.freeze([
  'preferred_language', 'fallback_language', 'payment_terms_days', 'do_not_contact', 'tax_registration'
]);

// Conservative: lowercase, NFKC, strip punctuation, collapse whitespace.
// Deliberately NO legal-suffix stripping — two legal entities must never
// collapse by name cosmetics (Oy vs Ltd vs Inc are different registrations).
export const normalizePartyName = (value = '') =>
  String(value || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();

export const normalizeChannelValue = (kind, value = '') => {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (kind === 'email') return raw.toLowerCase();
  if (kind === 'phone' || kind === 'sms' || kind === 'whatsapp') {
    return raw.replace(/[^\d+]/g, '');
  }
  return raw.replace(/\s+/g, ' ');
};

const auditEvent = async (client, {
  firmId, clientId, actorType = 'system', actorId = null,
  action, resourceType, resourceId, metadata = {}
}) => {
  await client.query(
    `insert into audit_events (firm_id, client_id, actor_type, actor_id, action, resource_type, resource_id, metadata)
     values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)`,
    [firmId, clientId, actorType, actorId, action, resourceType, resourceId, JSON.stringify(metadata)]
  );
};

// ── Readers ──────────────────────────────────────────────────────────────────

export const getPartyById = async (client, { firmId, clientId, partyId }) => {
  const { rows } = await client.query(
    'select * from client_parties where firm_id = $1 and client_id = $2 and id = $3',
    [firmId, clientId, partyId]
  );
  return rows[0] || null;
};

// The dated history and its attributed writer receipt are authoritative;
// detail is a current projection, never sufficient evidence on its own.
export const getPartyTaxRegistration = async (client, { firmId, clientId, party }) => {
  if (!party?.id || party.status !== 'active') return null;
  const rows = (await client.query(
    `select value, source, set_by_actor_type, set_by_actor_id from party_attributes
      where firm_id = $1 and client_id = $2 and party_id = $3
        and attribute = 'tax_registration' and valid_until is null`,
    [firmId, clientId, party.id]
  )).rows;
  const row = rows.length === 1 ? rows[0] : null;
  if (!row || row.source !== 'owner_statement' || !row.set_by_actor_id
    || ['system', 'owner'].includes(row.set_by_actor_id) || row.set_by_actor_type === 'system'
    || row.value?.actorId !== row.set_by_actor_id || !validBuyerRegistrationFact(row.value)
    || !isDeepStrictEqual(row.value, party.detail?.tax_registration)) return null;
  return row.value;
};

export const findPartyByBusinessId = async (client, { firmId, clientId, businessId }) => {
  const { rows } = await client.query(
    `select * from client_parties
      where firm_id = $1 and client_id = $2 and status = 'active' and business_id = $3
      order by created_at asc limit 1`,
    [firmId, clientId, String(businessId)]
  );
  return rows[0] || null;
};

export const findPartyByNormalizedName = async (client, { firmId, clientId, normalizedName }) => {
  const { rows } = await client.query(
    `select * from client_parties
      where firm_id = $1 and client_id = $2 and status = 'active' and normalized_name = $3
      order by created_at asc limit 1`,
    [firmId, clientId, normalizedName]
  );
  return rows[0] || null;
};

export const findPartyByChannel = async (client, { firmId, clientId, channelKind, normalizedValue }) => {
  const { rows } = await client.query(
    `select p.* from client_parties p
       join party_channels c on c.party_id = p.id and c.valid_until is null
      where p.firm_id = $1 and p.client_id = $2 and p.status = 'active'
        and c.channel_kind = $3 and c.normalized_value = $4
      order by p.created_at asc limit 1`,
    [firmId, clientId, channelKind, normalizedValue]
  );
  return rows[0] || null;
};

export const listPartiesForClient = async (client, { firmId, clientId, status = 'active', limit = 200 }) => {
  const { rows } = await client.query(
    `select * from client_parties
      where firm_id = $1 and client_id = $2 and ($3::text is null or status = $3)
      order by display_name asc limit $4`,
    [firmId, clientId, status, Math.min(Math.max(Number(limit) || 200, 1), 1000)]
  );
  return rows;
};

// The known-customer roster the owner-command reader is shown (kernel-audit
// M2). "invoice Acme for the May retainer" carries no email address, so the
// model is given the client's OWN existing customers and asked to match one —
// which is a reading of the owner's sentence, not an invention.
//
// Only CUSTOMERS with an active email channel are offered: a party with no
// address cannot be invoiced, and offering one would produce a match that
// refuses at the mint. An empty roster is a fine outcome — the owner then has
// to state the address, which becomes an owner QUESTION rather than a guess.
//
// Same client-scoped tenancy posture as listPartyChannels below: firmId +
// clientId are required and filtered on.
export const listCustomerPartyCandidates = async (client, { firmId, clientId, limit = 50 }) => {
  if (!firmId || !clientId) {
    throw new Error('listCustomerPartyCandidates requires firmId and clientId (client-scoped read)');
  }
  const { rows } = await client.query(
    `select p.id, p.display_name, p.business_id,
            (array_agg(c.normalized_value order by c.is_primary desc, c.created_at asc))[1] as email
       from client_parties p
       join party_channels c
         on c.party_id = p.id and c.firm_id = p.firm_id and c.client_id = p.client_id
        and c.channel_kind = 'email' and c.valid_until is null
      where p.firm_id = $1 and p.client_id = $2
        and p.status = 'active' and p.is_customer = true
        and coalesce(p.do_not_contact, false) = false
      group by p.id, p.display_name, p.business_id, p.created_at
      order by p.created_at asc
      limit $3`,
    [firmId, clientId, Math.min(Math.max(Number(limit) || 50, 1), 200)]
  );
  return rows.map((row) => ({
    id: row.id,
    display_name: row.display_name,
    email: row.email,
    business_id: row.business_id || null
  }));
};

// Customer-boundary read (the F-1 lesson): party_id is a UUID, but it is not
// a tenancy proof — every read on the send path resolves the recipient of a
// real third-party email, so the scope is asserted, not assumed. firmId +
// clientId are REQUIRED and the query filters on them; a caller that cannot
// name the scope refuses rather than reading across the boundary.
export const listPartyChannels = async (client, { firmId, clientId, partyId, activeOnly = true }) => {
  if (!firmId || !clientId) {
    throw new Error('listPartyChannels requires firmId and clientId (client-scoped read)');
  }
  if (!partyId) throw new Error('listPartyChannels requires partyId');
  const { rows } = await client.query(
    `select * from party_channels
      where firm_id = $1 and client_id = $2 and party_id = $3
        and ($4::boolean = false or valid_until is null)
      order by is_primary desc, created_at asc`,
    [firmId, clientId, partyId, activeOnly]
  );
  return rows;
};

// ── Writers (caller-managed transaction) ─────────────────────────────────────

export const createParty = async (client, {
  firmId, clientId, displayName,
  isCustomer = false, isSupplier = false,
  businessId = null, businessIdScheme = null, country = null,
  preferredLanguage = null, paymentTermsDays = null,
  source = 'manual', provenance = {}, detail = {},
  actorType = 'system', actorId = null
}) => {
  const name = String(displayName || '').trim();
  const normalized = normalizePartyName(name);
  if (!firmId || !clientId) throw new Error('createParty requires firmId, clientId');
  if (!name || !normalized) throw new Error('createParty requires a non-empty displayName');
  const id = randomUUID();
  const { rows } = await client.query(
    `insert into client_parties
       (id, firm_id, client_id, display_name, normalized_name, is_customer, is_supplier,
        business_id, business_id_scheme, country, preferred_language, payment_terms_days,
        source, provenance, detail)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::jsonb, $15::jsonb)
     returning *`,
    [id, firmId, clientId, name, normalized, Boolean(isCustomer), Boolean(isSupplier),
      businessId ? String(businessId) : null, businessIdScheme, country,
      preferredLanguage, paymentTermsDays,
      String(source || 'manual'), JSON.stringify(provenance || {}), JSON.stringify(detail || {})]
  );
  await auditEvent(client, {
    firmId, clientId, actorType, actorId,
    action: 'outbound_party.created', resourceType: 'client_party', resourceId: id,
    metadata: { display_name: name, source, business_id: businessId || null }
  });
  return rows[0];
};

// Idempotent on the active (party, kind, normalized value) — re-adding the
// same address is a no-op returning the existing row.
export const addPartyChannel = async (client, {
  firmId, clientId, partyId, channelKind, channelValue,
  isPrimary = false, source = 'manual', detail = {},
  actorType = 'system', actorId = null
}) => {
  if (!PARTY_CHANNEL_KINDS.includes(channelKind)) {
    throw new Error(`addPartyChannel: unknown channel_kind '${channelKind}'`);
  }
  const normalized = normalizeChannelValue(channelKind, channelValue);
  if (!normalized) throw new Error('addPartyChannel requires a non-empty channelValue');
  const id = randomUUID();
  const inserted = await client.query(
    `insert into party_channels
       (id, firm_id, client_id, party_id, channel_kind, channel_value, normalized_value,
        is_primary, source, detail)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)
     on conflict (party_id, channel_kind, normalized_value) where valid_until is null
     do nothing
     returning *`,
    [id, firmId, clientId, partyId, channelKind, String(channelValue).trim(), normalized,
      Boolean(isPrimary), String(source || 'manual'), JSON.stringify(detail || {})]
  );
  if (inserted.rows[0]) {
    await auditEvent(client, {
      firmId, clientId, actorType, actorId,
      action: 'outbound_party.channel_added', resourceType: 'party_channel', resourceId: id,
      metadata: { party_id: partyId, channel_kind: channelKind }
    });
    return { channel: inserted.rows[0], created: true };
  }
  const { rows } = await client.query(
    `select * from party_channels
      where party_id = $1 and channel_kind = $2 and normalized_value = $3 and valid_until is null`,
    [partyId, channelKind, normalized]
  );
  return { channel: rows[0] || null, created: false };
};

// Close an active channel (effective-dated close, never a delete).
export const closePartyChannel = async (client, {
  firmId, clientId, channelId, actorType = 'system', actorId = null, reason = null
}) => {
  const { rows } = await client.query(
    `update party_channels set valid_until = now(), updated_at = now()
      where id = $1 and firm_id = $2 and client_id = $3 and valid_until is null
      returning *`,
    [channelId, firmId, clientId]
  );
  if (!rows[0]) return null;
  await auditEvent(client, {
    firmId, clientId, actorType, actorId,
    action: 'outbound_party.channel_closed', resourceType: 'party_channel', resourceId: channelId,
    metadata: { party_id: rows[0].party_id, reason }
  });
  return rows[0];
};

const ATTRIBUTE_VALIDATORS = {
  preferred_language: (v) => typeof v === 'string' && /^[a-z]{2}$/.test(v),
  fallback_language: (v) => typeof v === 'string' && /^[a-z]{2}$/.test(v),
  payment_terms_days: (v) => Number.isInteger(v) && v >= 0 && v <= 365,
  do_not_contact: (v) => typeof v === 'boolean',
  tax_registration: validBuyerRegistrationFact
};

const ATTRIBUTE_COLUMNS = {
  preferred_language: 'preferred_language',
  fallback_language: 'fallback_language',
  payment_terms_days: 'payment_terms_days',
  do_not_contact: 'do_not_contact'
};

// One writer for the effective-dated attribute history + the denormalized
// current value, in the caller's transaction: close prior row → insert new →
// update the column → audit. Closed attribute set; invalid values refuse.
export const setPartyAttribute = async (client, {
  firmId, clientId, partyId, attribute, value,
  source = 'manual', actorType = 'system', actorId = null
}) => {
  if (!PARTY_ATTRIBUTES.includes(attribute)) {
    throw new Error(`setPartyAttribute: unknown attribute '${attribute}'`);
  }
  if (!ATTRIBUTE_VALIDATORS[attribute](value)) {
    throw new Error(`setPartyAttribute: invalid value for '${attribute}'`);
  }
  // Serialize current facts and their history under the same scoped identity
  // lock that the send boundary reads. A foreign id is never a write target.
  if (attribute === 'tax_registration') {
    const party = (await client.query(
      'select * from client_parties where id = $1 and firm_id = $2 and client_id = $3 for update',
      [partyId, firmId, clientId]
    )).rows[0];
    if (!party || party.status !== 'active') throw new Error('setPartyAttribute: active party not found in scope');
    if (!actorId || ['system', 'owner'].includes(actorId) || actorType === 'system') {
      throw new Error('setPartyAttribute: tax registration requires an attributed owner statement');
    }
    value = { ...value, actorId, source };
    if (!validBuyerRegistrationFact(value)) throw new Error('setPartyAttribute: invalid tax registration source');
  }
  await client.query(
    `update party_attributes set valid_until = now()
      where party_id = $1 and attribute = $2 and valid_until is null`,
    [partyId, attribute]
  );
  const id = randomUUID();
  await client.query(
    `insert into party_attributes
       (id, firm_id, client_id, party_id, attribute, value, source, set_by_actor_type, set_by_actor_id)
     values ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9)`,
    [id, firmId, clientId, partyId, attribute, JSON.stringify(value),
      String(source || 'manual'), actorType, actorId]
  );
  if (attribute === 'tax_registration') await client.query(
    `update client_parties set detail = jsonb_set(detail, '{tax_registration}', $4::jsonb), updated_at = now()
      where id = $1 and firm_id = $2 and client_id = $3`,
    [partyId, firmId, clientId, JSON.stringify(value)]
  );
  else await client.query(
    `update client_parties set ${ATTRIBUTE_COLUMNS[attribute]} = $4, updated_at = now()
      where id = $1 and firm_id = $2 and client_id = $3`,
    [partyId, firmId, clientId, value]
  );
  await auditEvent(client, {
    firmId, clientId, actorType, actorId,
    action: 'outbound_party.attribute_set', resourceType: 'client_party', resourceId: partyId,
    metadata: { attribute, value, source, attribute_row_id: id }
  });
  return { id, partyId, attribute, value };
};

// ── Merge lane (suggest-and-confirm) ─────────────────────────────────────────

export const suggestPartyMerge = async (client, {
  firmId, clientId, sourcePartyId, targetPartyId, reason, evidence = {},
  actorType = 'system', actorId = null
}) => {
  if (sourcePartyId === targetPartyId) throw new Error('suggestPartyMerge: source and target are the same party');
  const id = randomUUID();
  const { rows } = await client.query(
    `insert into party_merge_suggestions
       (id, firm_id, client_id, source_party_id, target_party_id, reason, evidence)
     values ($1, $2, $3, $4, $5, $6, $7::jsonb)
     on conflict (source_party_id, target_party_id) where status = 'proposed'
     do nothing
     returning *`,
    [id, firmId, clientId, sourcePartyId, targetPartyId, String(reason || 'unspecified'),
      JSON.stringify(evidence || {})]
  );
  if (!rows[0]) {
    const existing = await client.query(
      `select * from party_merge_suggestions
        where source_party_id = $1 and target_party_id = $2 and status = 'proposed'`,
      [sourcePartyId, targetPartyId]
    );
    return { suggestion: existing.rows[0] || null, created: false };
  }
  await auditEvent(client, {
    firmId, clientId, actorType, actorId,
    action: 'outbound_party.merge_suggested', resourceType: 'party_merge_suggestion', resourceId: id,
    metadata: { source_party_id: sourcePartyId, target_party_id: targetPartyId, reason }
  });
  return { suggestion: rows[0], created: true };
};

// THE KEEP-LAYER REFUSAL: two parties with conflicting business ids are never
// merged — no parameter overrides this. A confirmed merge re-points the source
// party's active channels at the target, closes the source (status merged),
// and receipts the decision on the suggestion row when one exists.
export const applyPartyMerge = async (client, {
  firmId, clientId, sourcePartyId, targetPartyId, suggestionId = null,
  actorType, actorId = null
}) => {
  if (!actorType || actorType === 'system') {
    throw new Error('applyPartyMerge requires a non-system acting principal (a merge is a confirmed decision)');
  }
  const source = await getPartyById(client, { firmId, clientId, partyId: sourcePartyId });
  const target = await getPartyById(client, { firmId, clientId, partyId: targetPartyId });
  if (!source || !target) throw new Error('applyPartyMerge: party not found');
  if (source.status !== 'active' || target.status !== 'active') {
    throw new Error('applyPartyMerge: both parties must be active');
  }
  if (source.business_id && target.business_id && source.business_id !== target.business_id) {
    throw new Error('applyPartyMerge REFUSED: conflicting business ids — these are different legal entities');
  }

  // Re-point the source's active channels; the partial unique index dedupes
  // (a channel both parties share closes on the source instead of moving).
  const channels = await listPartyChannels(client, { firmId, clientId, partyId: sourcePartyId });
  for (const channel of channels) {
    const moved = await client.query(
      `update party_channels set party_id = $2, updated_at = now()
        where id = $1 and valid_until is null
          and not exists (
            select 1 from party_channels t
             where t.party_id = $2 and t.channel_kind = party_channels.channel_kind
               and t.normalized_value = party_channels.normalized_value
               and t.valid_until is null)
        returning id`,
      [channel.id, targetPartyId]
    );
    if (!moved.rows[0]) {
      await client.query(
        'update party_channels set valid_until = now(), updated_at = now() where id = $1 and valid_until is null',
        [channel.id]
      );
    }
  }

  // Enrich the target with anything the source knew and the target lacks.
  await client.query(
    `update client_parties t
        set is_customer = t.is_customer or s.is_customer,
            is_supplier = t.is_supplier or s.is_supplier,
            business_id = coalesce(t.business_id, s.business_id),
            business_id_scheme = coalesce(t.business_id_scheme, s.business_id_scheme),
            country = coalesce(t.country, s.country),
            preferred_language = coalesce(t.preferred_language, s.preferred_language),
            fallback_language = coalesce(t.fallback_language, s.fallback_language),
            payment_terms_days = coalesce(t.payment_terms_days, s.payment_terms_days),
            do_not_contact = t.do_not_contact or s.do_not_contact,
            updated_at = now()
       from client_parties s
      where t.id = $1 and s.id = $2 and t.firm_id = $3 and t.client_id = $4`,
    [targetPartyId, sourcePartyId, firmId, clientId]
  );
  await client.query(
    `update client_parties
        set status = 'merged', merged_into_party_id = $2, updated_at = now()
      where id = $1 and firm_id = $3 and client_id = $4`,
    [sourcePartyId, targetPartyId, firmId, clientId]
  );
  if (suggestionId) {
    await client.query(
      `update party_merge_suggestions
          set status = 'confirmed', decided_by_actor_type = $2, decided_by_actor_id = $3, decided_at = now()
        where id = $1 and status = 'proposed'`,
      [suggestionId, actorType, actorId]
    );
  }
  await auditEvent(client, {
    firmId, clientId, actorType, actorId,
    action: 'outbound_party.merged', resourceType: 'client_party', resourceId: targetPartyId,
    metadata: { source_party_id: sourcePartyId, target_party_id: targetPartyId, suggestion_id: suggestionId }
  });
  return { sourcePartyId, targetPartyId, merged: true };
};

export const rejectPartyMerge = async (client, {
  firmId, clientId, suggestionId, actorType, actorId = null
}) => {
  const { rows } = await client.query(
    `update party_merge_suggestions
        set status = 'rejected', decided_by_actor_type = $2, decided_by_actor_id = $3, decided_at = now()
      where id = $1 and firm_id = $4 and client_id = $5 and status = 'proposed'
      returning *`,
    [suggestionId, actorType || 'system', actorId, firmId, clientId]
  );
  if (rows[0]) {
    await auditEvent(client, {
      firmId, clientId, actorType: actorType || 'system', actorId,
      action: 'outbound_party.merge_rejected', resourceType: 'party_merge_suggestion',
      resourceId: suggestionId, metadata: {}
    });
  }
  return rows[0] || null;
};

// ── Deterministic candidate resolution ───────────────────────────────────────
// One candidate (from backfill or extraction) → exactly one of:
//   matched_business_id | enriched_name_match | created |
//   created_conflicting_business_id | created_with_merge_suggestion
// The caller manages the transaction (backfill wraps each candidate).

export const resolvePartyCandidate = async (client, { firmId, clientId, candidate }) => {
  const displayName = String(candidate?.displayName || '').trim();
  const normalized = normalizePartyName(displayName);
  const email = normalizeChannelValue('email', candidate?.email || '');
  if (!normalized) return { action: 'skipped_unresolvable', party: null };

  const enrich = async (party) => {
    await client.query(
      `update client_parties
          set is_customer = is_customer or $4,
              is_supplier = is_supplier or $5,
              business_id = coalesce(business_id, $6),
              business_id_scheme = coalesce(business_id_scheme, $7),
              country = coalesce(country, $8),
              preferred_language = coalesce(preferred_language, $9),
              updated_at = now()
        where id = $1 and firm_id = $2 and client_id = $3`,
      [party.id, firmId, clientId,
        Boolean(candidate.isCustomer), Boolean(candidate.isSupplier),
        candidate.businessId ? String(candidate.businessId) : null,
        candidate.businessIdScheme || null, candidate.country || null,
        candidate.preferredLanguage || null]
    );
    if (email) {
      await addPartyChannel(client, {
        firmId, clientId, partyId: party.id, channelKind: 'email',
        channelValue: candidate.email, source: candidate.source || 'backfill'
      });
    }
    return getPartyById(client, { firmId, clientId, partyId: party.id });
  };

  const mint = async (extraDetail = {}) => {
    const party = await createParty(client, {
      firmId, clientId, displayName,
      isCustomer: Boolean(candidate.isCustomer), isSupplier: Boolean(candidate.isSupplier),
      businessId: candidate.businessId || null, businessIdScheme: candidate.businessIdScheme || null,
      country: candidate.country || null, preferredLanguage: candidate.preferredLanguage || null,
      source: candidate.source || 'backfill',
      provenance: { source_ref: candidate.sourceRef || null, ...(candidate.provenance || {}) },
      detail: extraDetail
    });
    if (email) {
      await addPartyChannel(client, {
        firmId, clientId, partyId: party.id, channelKind: 'email',
        channelValue: candidate.email, isPrimary: true, source: candidate.source || 'backfill'
      });
    }
    return party;
  };

  // 1. Business id is identity: same id ⇒ the same party, enrich.
  if (candidate.businessId) {
    const byId = await findPartyByBusinessId(client, {
      firmId, clientId, businessId: candidate.businessId
    });
    if (byId) return { action: 'matched_business_id', party: await enrich(byId) };
  }

  // 2. Exact normalized-name match.
  const byName = await findPartyByNormalizedName(client, { firmId, clientId, normalizedName: normalized });
  if (byName) {
    if (byName.business_id && candidate.businessId
      && String(byName.business_id) !== String(candidate.businessId)) {
      // Same name, different registrations: a DIFFERENT entity. Never merged.
      const party = await mint({ name_collision_with: byName.id });
      return { action: 'created_conflicting_business_id', party };
    }
    return { action: 'enriched_name_match', party: await enrich(byName) };
  }

  // 3. Shared email with a differently-named party: create separate + propose.
  if (email) {
    const byEmail = await findPartyByChannel(client, {
      firmId, clientId, channelKind: 'email', normalizedValue: email
    });
    if (byEmail && byEmail.normalized_name !== normalized) {
      const party = await mint();
      const { suggestion } = await suggestPartyMerge(client, {
        firmId, clientId, sourcePartyId: party.id, targetPartyId: byEmail.id,
        reason: 'shared_email_differing_names',
        evidence: { email_channel: email, source: candidate.source || 'backfill' }
      });
      return { action: 'created_with_merge_suggestion', party, suggestionId: suggestion?.id || null };
    }
  }

  // 4. New identity.
  return { action: 'created', party: await mint() };
};

// ── Backfill (per-source readers → per-candidate short transactions) ─────────
// Sources: issued-invoice buyer snapshots, xero/qbo/procountor mirrors. Each
// reader soft-fails on an absent table (42P01) so a partial deployment
// backfills what exists. Merchant-pattern backfill needs per-client
// transaction evidence to scope correctly — an M1 seam, add a reader here.

const SOURCE_READERS = [
  {
    source: 'issued_invoice_buyer',
    read: async (client, { firmId, clientId, limit }) => {
      const { rows } = await client.query(
        `select distinct on (buyer_name, buyer_email)
                buyer_name, buyer_email, draft->'buyer'->>'businessId' as business_id, id
           from issued_invoices
          where firm_id = $1 and client_id = $2 and buyer_name is not null
          order by buyer_name, buyer_email, created_at desc
          limit $3`,
        [firmId, clientId, limit]
      );
      return rows.map((r) => ({
        displayName: r.buyer_name, email: r.buyer_email || null,
        businessId: r.business_id || null, isCustomer: true, isSupplier: false,
        source: 'issued_invoice_buyer', sourceRef: r.id
      }));
    }
  },
  {
    source: 'xero_contacts',
    read: async (client, { firmId, clientId, limit }) => {
      const { rows } = await client.query(
        `select xero_contact_id, name, email_address, is_customer, is_supplier
           from xero_contacts
          where firm_id = $1 and client_id = $2 and name is not null
          limit $3`,
        [firmId, clientId, limit]
      );
      return rows.map((r) => ({
        displayName: r.name, email: r.email_address || null,
        isCustomer: Boolean(r.is_customer), isSupplier: Boolean(r.is_supplier),
        source: 'xero_contacts', sourceRef: r.xero_contact_id
      }));
    }
  },
  {
    source: 'qbo_customers',
    read: async (client, { firmId, clientId, limit }) => {
      const { rows } = await client.query(
        `select qbo_customer_id, coalesce(display_name, company_name) as name, email
           from qbo_customers
          where firm_id = $1 and client_id = $2
            and coalesce(display_name, company_name) is not null
          limit $3`,
        [firmId, clientId, limit]
      );
      return rows.map((r) => ({
        displayName: r.name, email: r.email || null,
        isCustomer: true, isSupplier: false,
        source: 'qbo_customers', sourceRef: r.qbo_customer_id
      }));
    }
  },
  {
    source: 'qbo_vendors',
    read: async (client, { firmId, clientId, limit }) => {
      const { rows } = await client.query(
        `select qbo_vendor_id, coalesce(display_name, company_name) as name, email
           from qbo_vendors
          where firm_id = $1 and client_id = $2
            and coalesce(display_name, company_name) is not null
          limit $3`,
        [firmId, clientId, limit]
      );
      return rows.map((r) => ({
        displayName: r.name, email: r.email || null,
        isCustomer: false, isSupplier: true,
        source: 'qbo_vendors', sourceRef: r.qbo_vendor_id
      }));
    }
  },
  {
    source: 'procountor_business_partners',
    read: async (client, { firmId, clientId, limit }) => {
      const { rows } = await client.query(
        `select procountor_partner_id, name, email, partner_type
           from procountor_business_partners
          where firm_id = $1 and client_id = $2 and name is not null
          limit $3`,
        [firmId, clientId, limit]
      );
      return rows.map((r) => ({
        displayName: r.name, email: r.email || null,
        isCustomer: String(r.partner_type || '').toUpperCase() === 'CUSTOMER',
        isSupplier: String(r.partner_type || '').toUpperCase() === 'SUPPLIER',
        source: 'procountor_business_partners', sourceRef: r.procountor_partner_id
      }));
    }
  }
];

export const backfillPartiesForClient = async ({
  client, firmId, clientId, limitPerSource = 500
}) => {
  if (!client || !firmId || !clientId) return { skipped: true, reason: 'missing_args' };
  const limit = Math.min(Math.max(Number(limitPerSource) || 500, 1), 2000);
  const stats = {
    skipped: false, sources: {}, considered: 0,
    created: 0, enriched: 0, suggestions: 0, errors: 0
  };
  for (const reader of SOURCE_READERS) {
    let candidates = [];
    try {
      candidates = await reader.read(client, { firmId, clientId, limit });
    } catch (error) {
      if (error?.code === '42P01' || error?.code === '42703') {
        stats.sources[reader.source] = { absent: true };
        continue;
      }
      throw error;
    }
    stats.sources[reader.source] = { candidates: candidates.length };
    for (const candidate of candidates) {
      stats.considered += 1;
      try {
        await client.query('begin');
        const result = await resolvePartyCandidate(client, { firmId, clientId, candidate });
        await client.query('commit');
        if (result.action === 'created' || result.action === 'created_conflicting_business_id') stats.created += 1;
        if (result.action === 'created_with_merge_suggestion') { stats.created += 1; stats.suggestions += 1; }
        if (result.action === 'enriched_name_match' || result.action === 'matched_business_id') stats.enriched += 1;
      } catch (error) {
        try { await client.query('rollback'); } catch { /* best-effort */ }
        stats.errors += 1;
      }
    }
  }
  return stats;
};
