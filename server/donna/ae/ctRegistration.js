// AE — the effective-dated CORPORATE TAX registration record (the UAE backend
// lane, 2026-08-30). Sibling of ae/vatRegistration.js by deliberate mirror:
// the same closed statuses, the same tri-state read side, the same typed 400s
// at the write boundary, the same verified_from/verified_at provenance. It is
// the standing FACT the `ae_corporate_tax_registration` obligation needs
// answered — the manifest calls that duty "a REGISTRY duty (obtain and hold a
// registration) … 'is this client registered, and can we evidence it'" — and
// this record is the evidence half. The obligation itself stays
// `declared_unbuilt`; binding it (manifest flip + drain) is the coordinating
// session's follow-up, not this module's job.
//
// TRI-STATE, for the registry duty's own reason: an ABSENT record means we do
// not know whether the client holds a CT registration — and "unknown" must
// drive an owner ask, never a quiet "not registered" (which would silently
// assert an open statutory duty) and never a quiet "registered" (which would
// silently discharge one). Only a RECORDED status may resolve `false`;
// absence flows through as null and the deadline rows refuse by name
// (ae/ctRegistrationDeadlines.js).
//
// Stored on `clients.profile.ct_registration` — a NEW profile key, not a
// second tenant of `vat_registration`: the FTA registers the two taxes
// separately, on separate applications, and issues SEPARATE TRNs — a business
// registered for both holds two different 15-digit numbers. One key per
// registration, exactly as the statute has one register per tax.
// clientProfileSchema.js dispatches the write by jurisdiction ('ae' only for
// now; every other jurisdiction refuses by name until its own market's
// normalizer exists).
//
// FORM-INDEPENDENT, exactly as the VAT record is: CT registration is a duty
// of every taxable person — a mainland LLC, a free-zone company (most free
// zone persons included), a sole establishment, a natural person over the
// AED 1m turnover trigger. Nothing here reads `entity_type`, and free-zone
// standing plays no part: QFZP / qualifying-income treatment is a TAX
// TREATMENT question for the return lane (and gap 6's OPEN axis question),
// never a registration fact.
//
// ── The CT TRN shape (VERIFY posture, as_of 2026-08-30) ────────────────────
// Corroborated across secondaries (alaan.com, daftra.com, bcl.ae,
// taxnews.ae, theaccountant.ae): the corporate-tax registration number is a
// 15-digit FTA TRN — same structural shape as the VAT TRN, but a DISTINCT
// number issued on the CT registration. tax.gov.ae and mof.gov.ae are
// blocked by this environment's egress proxy, so this is NOT confirmed
// against primary byte-for-byte — the structural check below therefore
// rides `confirmedAgainstPrimary: false` in AE_CT_TRN_SHAPE_PROVENANCE and
// the resolver's provenance discipline is unchanged: `verified_from` /
// `verified_at` record when a human confirmed the registration against real
// evidence (an FTA CT registration certificate, an EmaraTax lookup).
//
// Deliberate omissions, named so they are not mistaken for gaps:
// - NO `registration_basis`: CT has no voluntary-registration limb — every
//   taxable person must register (Federal Decree-Law No. 47 of 2022). A
//   mandatory/voluntary vocabulary here would be invented law.
// - NO return-cadence field: the CT tax period is the financial year and the
//   return clock (nine months from period end) belongs to the
//   `ae_corporate_tax_return` duty — a return-lane fact, not a registration
//   fact.

import { isValidAeTrn } from './vatRegistration.js';

const dateOnly = (value) => {
  if (value === null || value === undefined) return null;
  const raw = String(value).slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : null;
};

// The structural check is shared with the VAT record on purpose — one FTA,
// one 15-digit TRN shape (per the corroboration above) — while the NUMBERS
// are distinct per tax. If a gap-6 entity module ever lands for AE, both
// checks move there together.
export const isValidAeCtTrn = isValidAeTrn;

export const AE_CT_TRN_SHAPE_PROVENANCE = Object.freeze({
  confirmedAgainstPrimary: false,
  asOf: '2026-08-30',
  authority: 'Federal Tax Authority',
  source: 'The corporate-tax registration number is a 15-digit FTA TRN, issued separately from (and holding a different '
    + 'value than) any VAT TRN the same business holds — one registration and one number per tax. CORROBORATED '
    + '2026-08-30 across independent secondaries (alaan.com, daftra.com, bcl.ae, taxnews.ae, theaccountant.ae). '
    + 'Byte-level primary read PENDING: tax.gov.ae and mof.gov.ae are blocked by this environment\'s egress proxy. '
    + 'VERIFY against primary before any AE client is onboarded onto a statutory lane.'
});

// Closed vocabulary. Anything else is refused at the write boundary and reads
// as UNKNOWN (never as "not registered") — the tri-state note above.
// 'deregistered' is real law, not symmetry filler: a person ceasing business
// applies to deregister from corporate tax, so a closed record needs the
// terminal.
export const AE_CT_REGISTRATION_STATUSES = Object.freeze(['registered', 'not_registered', 'deregistered']);

// normalizeAeCtRegistration(record) — the write-boundary normalizer. Accepts
// an owner/operator-shaped record, returns the canonical stored shape, throws
// a typed 400 on unusable input. Refuse at the boundary; stay honest at read.
//
// A registered record does NOT require a TRN, mirroring the VAT record's
// reasoning: the FTA issues the number on approval, and there is a real
// window in which a business IS registered (effective date set) and holds no
// number yet. Downstream evidence checks refuse by name on the missing
// number rather than this boundary refusing the honest record.
export const normalizeAeCtRegistration = (record = {}) => {
  const bad = (message) => {
    const error = new Error(message);
    error.statusCode = 400;
    error.code = 'AE_CT_REGISTRATION_INVALID';
    return error;
  };
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    throw bad('ct_registration must be an object (or null to clear).');
  }
  const status = String(record.status || '').trim().toLowerCase();
  if (!AE_CT_REGISTRATION_STATUSES.includes(status)) {
    throw bad(`ct_registration.status must be one of ${AE_CT_REGISTRATION_STATUSES.join(' | ')}, got ${JSON.stringify(record.status)}.`);
  }
  const registeredFrom = dateOnly(record.registered_from);
  const registeredUntil = dateOnly(record.registered_until);
  if (status === 'registered' && !registeredFrom) {
    throw bad('ct_registration.registered_from (ISO date) is required for a registered record.');
  }
  if (status === 'deregistered' && !registeredUntil) {
    throw bad('ct_registration.registered_until (ISO date) is required for a deregistered record.');
  }
  if (registeredFrom && registeredUntil && registeredUntil < registeredFrom) {
    throw bad('ct_registration.registered_until must not precede registered_from.');
  }
  const trnRaw = String(record.ct_registration_number || '').trim().toUpperCase().replace(/\s+/g, ' ');
  if (trnRaw && !isValidAeCtTrn(trnRaw)) {
    throw bad(`ct_registration.ct_registration_number is not a structurally valid FTA TRN (15 digits): ${JSON.stringify(record.ct_registration_number)}.`);
  }
  // A record that states the business is NOT registered must not carry a CT
  // TRN — the two together are a contradiction, and a stale number kept in
  // the record is how a wrong "registered" impression leaks back onto an
  // evidence surface.
  if (status === 'not_registered' && trnRaw) {
    throw bad('ct_registration.ct_registration_number must be absent on a not_registered record.');
  }
  return {
    status,
    registered_from: registeredFrom,
    registered_until: registeredUntil,
    // Stored as supplied (whitespace collapsed) rather than reformatted — a
    // display convention invented here would put a guessed statutory string
    // on an FTA-facing document.
    ct_registration_number: trnRaw || null,
    verified_from: String(record.verified_from || '').trim() || null,
    verified_at: dateOnly(record.verified_at)
  };
};

// resolveAeCtRegistrationOnDate({ registration, onDate }) — the effective
// registration state on a given date. Byte-for-byte the VAT resolver's shape:
// `registered === null` means UNKNOWN and is the honest answer whenever the
// record cannot settle the question; the deadline rows turn it into a named
// owner ask. Every `reason` is a closed name. Pure; throws only on a
// missing/unusable onDate (a caller bug, not a data state).
export const resolveAeCtRegistrationOnDate = ({ registration = null, onDate } = {}) => {
  const at = dateOnly(onDate);
  if (!at) throw new Error('resolveAeCtRegistrationOnDate requires an onDate (ISO date or timestamp).');

  const unknown = (reason, extra = {}) => ({
    registered: null,
    reason,
    status: null,
    registrationId: null,
    registeredFrom: null,
    registeredUntil: null,
    confirmedAgainstPrimary: false,
    asOf: at,
    ...extra
  });

  if (registration === null || registration === undefined) return unknown('no_record');
  if (typeof registration !== 'object' || Array.isArray(registration)) return unknown('unusable_record');

  const status = String(registration.status || '').trim().toLowerCase();
  if (!AE_CT_REGISTRATION_STATUSES.includes(status)) return unknown('unrecognised_status');

  const from = dateOnly(registration.registered_from);
  const until = dateOnly(registration.registered_until);
  const confirmedAgainstPrimary = Boolean(dateOnly(registration.verified_at));
  // The TRN is surfaced ONLY alongside a positive resolution — on a negative
  // one there is no registration for the number to evidence.
  const registrationId = String(registration.ct_registration_number || '').trim() || null;

  const settled = (registered, reason) => ({
    registered,
    reason,
    status,
    registrationId: registered === true ? registrationId : null,
    registeredFrom: from,
    registeredUntil: until,
    confirmedAgainstPrimary,
    asOf: at
  });

  if (status === 'not_registered') return settled(false, 'not_registered');
  // A dated status with no effective date cannot be placed on a timeline —
  // an incomplete record, not a negative one. The normalizer refuses to write
  // it, but a hand-edited or legacy blob can still arrive here.
  if (!from) return unknown('no_effective_date', { status });
  if (at < from) return settled(false, 'not_yet_effective');
  if (until && at > until) return settled(false, 'deregistered');
  return settled(true, 'registered');
};
