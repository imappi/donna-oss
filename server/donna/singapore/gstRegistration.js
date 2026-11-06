// SG — the effective-dated GST registration model, mirroring
// finland/alvRegistration.js (D-FI13-17) 1:1.
//
// GST treatment must enable because an EFFECTIVE registration exists on the
// document date AND the line is taxable — NEVER because `entity_type ===
// 'sg-pte'`. "A Pte Ltd above the threshold is GST-registered" is an
// observation, not a rule the code keys on. So this model is deliberately
// FORM-INDEPENDENT: it reads only the registration record and a date; it never
// looks at the legal form. A sole proprietorship with an effective registration
// charges GST exactly as a Pte Ltd does.
//
// The record is a durable, effective-dated `{ status, registered_from/until,
// gst_period, registration_basis, gst_registration_number, verified_from/at }`
// stored on the client profile (jsonb — no migration).
//
// Provenance discipline (the-model-id / confirmedAgainstPrimary rail): a
// registration is only as trustworthy as its verification. `verified_from` /
// `verified_at` carry when the record was confirmed and against what (an IRAS
// "Register of GST-registered Businesses" lookup, a notification letter); a
// record with no verification still resolves (the firm entered it) but flags
// unverified. Pure; never throws except on an operator write with the wrong
// shape (the normalizer).

import { createHash } from 'node:crypto';
import { toIsoDay, toUtcIsoDay } from '../dates.js';

const dateOnly = (value) => {
  if (value === null || value === undefined) return null;
  const raw = String(value).slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : null;
};

// Closed vocabularies. A registration record's status is one of these; anything
// else is refused at the write boundary (normalizer) and treated as
// not-registered at read (fail-safe to the no-GST/byte-identical path).
export const GST_REGISTRATION_STATUSES = Object.freeze(['registered', 'not_registered', 'deregistered']);

// Why the client is registered — kept small and closed with an 'other' escape.
// 'mandatory' = threshold obligation (retrospective or prospective view);
// 'voluntary' = elected below the S$1M threshold (carries the 2-year minimum
// registration period — recorded, not enforced here).
export const GST_REGISTRATION_BASES = Object.freeze(['mandatory', 'voluntary', 'other']);

// The IRAS prescribed accounting periods. Quarterly is the default assignment;
// monthly is available on request (typically for regular refund claimants).
// SAME period-type vocabulary the return engine speaks (resolveGstPeriod).
export const GST_ACCOUNTING_PERIODS = Object.freeze(['month', 'quarter']);

const PERIOD_ALIASES = Object.freeze({
  month: 'month', monthly: 'month',
  quarter: 'quarter', quarterly: 'quarter'
});

export const DEFAULT_GST_ACCOUNTING_PERIOD = 'quarter';

// gstPeriodCadenceForProfile(profile) — the client's assigned GST filing
// cadence, read from the validated clients.profile.gst_period DATA field.
// Pure; unknown / absent ⇒ the quarterly default. Defensive on aliases/casing
// so a hand-set value still resolves rather than silently defaulting.
export const gstPeriodCadenceForProfile = (profile = {}) => {
  const raw = String(profile?.gst_period || '').trim().toLowerCase();
  if (!raw) return DEFAULT_GST_ACCOUNTING_PERIOD;
  return PERIOD_ALIASES[raw] || DEFAULT_GST_ACCOUNTING_PERIOD;
};

// normalizeGstRegistration(record) — the write-boundary normalizer. Accepts an
// operator-shaped record, returns the canonical stored shape, throws typed 400s
// on unusable input (the D-FI13-17 posture: refuse at the boundary, fail-safe
// at read).
export const normalizeGstRegistration = (record = {}) => {
  const bad = (message) => {
    const error = new Error(message);
    error.statusCode = 400;
    error.code = 'SINGAPORE_GST_REGISTRATION_INVALID';
    return error;
  };
  const status = String(record.status || '').trim().toLowerCase();
  if (!GST_REGISTRATION_STATUSES.includes(status)) {
    throw bad(`gst_registration.status must be one of ${GST_REGISTRATION_STATUSES.join(' | ')}, got ${JSON.stringify(record.status)}.`);
  }
  const registeredFrom = dateOnly(record.registered_from);
  const registeredUntil = dateOnly(record.registered_until);
  if (status === 'registered' && !registeredFrom) {
    throw bad('gst_registration.registered_from (ISO date) is required for a registered record.');
  }
  if (status === 'deregistered' && !registeredUntil) {
    throw bad('gst_registration.registered_until (ISO date) is required for a deregistered record.');
  }
  const basis = String(record.registration_basis || '').trim().toLowerCase();
  const gstPeriodRaw = String(record.gst_period || '').trim().toLowerCase();
  return {
    status,
    registered_from: registeredFrom,
    registered_until: registeredUntil,
    // The GST registration number IRAS issues (often the UEN itself, sometimes
    // an M-prefixed number for older/special registrations). Stored verbatim.
    gst_registration_number: String(record.gst_registration_number || '').trim() || null,
    registration_basis: GST_REGISTRATION_BASES.includes(basis) ? basis : (basis ? 'other' : null),
    gst_period: PERIOD_ALIASES[gstPeriodRaw] || null,
    verified_from: String(record.verified_from || '').trim() || null,
    verified_at: dateOnly(record.verified_at)
  };
};

// resolveGstRegistrationOnDate({ registration, onDate }) → { registered,
// reason, unverified }. The read-side resolver: fail-safe (a missing/unusable
// record resolves NOT registered — the no-GST path), effective-dated (the
// record's dates bracket the document date), and honest about verification.
export const resolveGstRegistrationOnDate = ({ registration = null, onDate } = {}) => {
  const at = dateOnly(onDate);
  if (!at) throw new Error('resolveGstRegistrationOnDate requires an onDate (ISO date or timestamp).');
  if (!registration || typeof registration !== 'object') {
    return { registered: false, reason: 'no_record', unverified: false };
  }
  const status = String(registration.status || '').trim().toLowerCase();
  if (status === 'not_registered') return { registered: false, reason: 'not_registered', unverified: false };
  if (status !== 'registered' && status !== 'deregistered') {
    return { registered: false, reason: 'unrecognised_status', unverified: false };
  }
  const from = dateOnly(registration.registered_from);
  const until = dateOnly(registration.registered_until);
  if (!from) return { registered: false, reason: 'no_effective_date', unverified: false };
  if (at < from) return { registered: false, reason: 'not_yet_effective', unverified: false };
  if (until && at > until) return { registered: false, reason: 'deregistered', unverified: false };
  const unverified = !registration.verified_at;
  return { registered: true, reason: 'registered', unverified };
};

// Native engineering contract, separate from the retained legacy resolver above.
// A recorded interval is evidence about that interval only. Neither the chart
// nor an absent record authorizes a tax treatment or establishes non-registration.
export const NATIVE_GST_REGISTRATION_VERSION = 'sg.native-registration.v1';
const canonical = value => value instanceof Date ? value.toISOString() : Array.isArray(value) ? value.map(canonical)
  : value && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
export const nativeRegistrationDigest = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
// PostgreSQL DATE is a local-midnight Date; timestamps remain UTC instants.
// Snapshot convergence and the row's touch timestamp are workflow observations,
// not replacement evidence. All source identity/content fields remain bound.
const sourceDigest = document => {
  const { convergence_state, convergence_reason, convergence_as_of, updated_at, ...source } = document;
  return nativeRegistrationDigest({ ...source,
  ...Object.fromEntries(['document_date', 'due_date'].filter(key => Object.hasOwn(document, key))
    .map(key => [key, document[key] == null ? null : toIsoDay(document[key])])) });
};
const same = (a, b) => nativeRegistrationDigest(a) === nativeRegistrationDigest(b);
const text = value => typeof value === 'string' ? value.trim() : '';
const nativeDay = value => {
  const day = value instanceof Date ? toIsoDay(value) : text(value);
  return /^\d{4}-\d{2}-\d{2}$/.test(day) && toUtcIsoDay(day) === day ? day : null;
};
const registrationInvalid = reason => {
  throw Object.assign(new Error(`Native registration evidence refused: ${reason}`), {
    code: 'SINGAPORE_NATIVE_REGISTRATION_INVALID', statusCode: 400, details: { reason }
  });
};
const NATIVE_FIELDS = new Set(['status', 'registered_from', 'registered_until',
  'covered_from', 'covered_until', 'gst_registration_number', 'registration_basis',
  'gst_period', 'verified_from', 'verified_at', 'source_document_id']);

export function normalizeNativeGstRegistration(record) {
  if (record === null) return null;
  if (!record || typeof record !== 'object' || Array.isArray(record)) registrationInvalid('record_invalid');
  if (Object.keys(record).some(key => !NATIVE_FIELDS.has(key))) registrationInvalid('unsupported_or_server_owned_field');
  const status = text(record.status).toLowerCase();
  if (!GST_REGISTRATION_STATUSES.includes(status)) registrationInvalid('status_invalid');
  const dates = {};
  for (const key of ['registered_from', 'registered_until', 'covered_from', 'covered_until', 'verified_at']) {
    dates[key] = record[key] == null || record[key] === '' ? null : nativeDay(record[key]);
    if (record[key] != null && record[key] !== '' && !dates[key]) registrationInvalid(`${key}_invalid`);
  }
  if (dates.registered_from && dates.registered_until && dates.registered_from > dates.registered_until
    || dates.covered_from && dates.covered_until && dates.covered_from > dates.covered_until) registrationInvalid('interval_reversed');
  if (status === 'not_registered' && (dates.registered_from || dates.registered_until)
    || status !== 'not_registered' && (dates.covered_from || dates.covered_until)) registrationInvalid('conflicting_status_dates');
  for (const key of ['gst_registration_number', 'registration_basis', 'gst_period', 'verified_from', 'source_document_id']) {
    if (record[key] != null && typeof record[key] !== 'string') registrationInvalid(`${key}_invalid`);
  }
  const basis = text(record.registration_basis).toLowerCase();
  const period = text(record.gst_period).toLowerCase();
  if (basis && !GST_REGISTRATION_BASES.includes(basis)) registrationInvalid('registration_basis_invalid');
  if (period && !PERIOD_ALIASES[period]) registrationInvalid('gst_period_invalid');
  return { status, ...dates, gst_registration_number: text(record.gst_registration_number) || null,
    registration_basis: basis || null, gst_period: PERIOD_ALIASES[period] || null,
    verified_from: text(record.verified_from) || null, source_document_id: text(record.source_document_id) || null };
}

export function createNativeRegistrationRevision({ before, after, clientLife, predecessorDigest, actor, sourceDocument = null }) {
  if (!actor?.id || actor.id === 'system' || !['firm_member', 'firm_collaborator'].includes(actor.type)) registrationInvalid('actor_required');
  const revision = { version: NATIVE_GST_REGISTRATION_VERSION, client_life: clientLife,
    predecessor_digest: predecessorDigest, before: before ?? null, after,
    actor_id: actor.id, actor_type: actor.type,
    authority_basis: { source: 'authenticated_profile_update', principal_id: actor.id, principal_type: actor.type },
    source: after === null ? { kind: 'explicit_withdrawal' } : {
      reference: after.verified_from, verified_at: after.verified_at,
      document: sourceDocument ? { id: sourceDocument.id, digest: sourceDigest(sourceDocument) } : null
    } };
  return { ...revision, revision_digest: nativeRegistrationDigest(revision) };
}

// The DB reader supplies the append-only current-life audit chain. Current
// profile is a projection of its last revision; an editable digest is no proof.
export function verifyNativeRegistrationRevisions({ registration, storedRevision, revisions, clientLife, birthDigest, birthRecord, sourceDocument = null }) {
  let predecessor = birthDigest, latest = null;
  for (const audit of revisions) {
    const revision = audit.metadata?.native_registration;
    if (!revision) registrationInvalid('revision_missing');
    const { revision_digest: digest, ...body } = revision;
    if (revision.version !== NATIVE_GST_REGISTRATION_VERSION || !same(revision.client_life, clientLife)
      || revision.predecessor_digest !== predecessor || digest !== nativeRegistrationDigest(body)
      || revision.actor_id !== audit.actor_id || revision.actor_type !== audit.actor_type
      || !['firm_member', 'firm_collaborator'].includes(audit.actor_type) || !audit.actor_id || audit.actor_id === 'system'
      || revision.authority_basis?.principal_id !== audit.actor_id
      || revision.authority_basis?.principal_type !== audit.actor_type
      || revision.authority_basis?.source !== 'authenticated_profile_update'
      || audit.firm_id !== clientLife.firm_id || audit.client_id !== clientLife.client_id
      || audit.resource_type !== 'client' || audit.resource_id !== clientLife.client_id
      || audit.action !== 'client.profile.update'
      || !same(revision.before, latest ? latest.after : birthRecord ?? null)) registrationInvalid('revision_chain_invalid');
    predecessor = digest; latest = revision;
  }
  if (!latest) {
    if (storedRevision != null) registrationInvalid('revision_audit_missing');
    return { version: NATIVE_GST_REGISTRATION_VERSION, revision: null, registration: registration ?? null, source_current: false };
  }
  if (!same(latest, storedRevision) || !same(latest.after, registration ?? null)) registrationInvalid('revision_projection_conflict');
  const source = latest.source?.document;
  return { version: NATIVE_GST_REGISTRATION_VERSION, revision: latest,
    registration: latest.after, source_current: !source || Boolean(sourceDocument
      && source.id === sourceDocument.id && source.digest === sourceDigest(sourceDocument)) };
}

export function resolveNativeGstRegistrationOnDate({ evidence, onDate } = {}) {
  const day = nativeDay(onDate);
  const result = { version: NATIVE_GST_REGISTRATION_VERSION, business_date: day,
    revision_digest: evidence?.revision?.revision_digest || null,
    registration: evidence?.registration ?? null, status: 'unknown', registered: null,
    tax_authority: false, reason: 'record_missing' };
  const unknown = reason => ({ ...result, reason });
  if (!day) return unknown(onDate == null || onDate === '' ? 'business_date_missing' : 'business_date_invalid');
  if (!evidence?.registration) return unknown(evidence?.revision ? 'record_cleared' : 'record_missing');
  let registration;
  try { registration = normalizeNativeGstRegistration(evidence.registration); }
  catch (error) { return unknown(error.details?.reason || 'record_invalid'); }
  if (!evidence.revision) return unknown('attributable_revision_missing');
  if (!evidence.source_current) return unknown('source_document_changed');
  if (!registration.verified_from) return unknown('verification_source_missing');
  if (!registration.verified_at) return unknown('unverified');
  const notRegistered = registration.status === 'not_registered';
  const from = notRegistered ? registration.covered_from : registration.registered_from;
  const until = notRegistered ? registration.covered_until : registration.registered_until;
  if (!from || (notRegistered || registration.status === 'deregistered') && !until) return unknown('covered_interval_missing');
  if (day < from || until && day > until) return { ...result, status: 'outside_recorded_interval',
    reason: day < from ? 'before_recorded_interval' : 'after_recorded_interval' };
  return { ...result, status: notRegistered ? 'not_registered' : 'registered',
    registered: !notRegistered, reason: notRegistered ? 'evidenced_not_registered' : 'evidenced_registered' };
}

export const NATIVE_GST_REGISTRATION_POLICY = Object.freeze({
  field: 'gst_registration', revisionField: 'gst_registration_revision',
  normalize: normalizeNativeGstRegistration, createRevision: createNativeRegistrationRevision,
  verifyRevisions: verifyNativeRegistrationRevisions, resolveOnDate: resolveNativeGstRegistrationOnDate
});
