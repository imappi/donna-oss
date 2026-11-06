// AE — the effective-dated VAT registration record (the UAE backend lane,
// 2026-08-30). Fourth member of the alv_registration / gst_registration /
// vat_registration family, and the GB module's direct sibling by design: the
// AE pack, like GB's, declares a CONDITIONAL statutory invoice floor (gap 9),
// so the read side here is TRI-STATE for exactly the reason gb/vatRegistration.js
// documents — "not registered" actively forbids the TRN and per-line VAT rate
// on an AE invoice, so defaulting an unknown to "not registered" would issue a
// non-tax invoice for a registered business and understate output VAT. Only a
// RECORDED status yields `false`; absence flows through as null and the
// conditional floor refuses by name.
//
// Stored on `clients.profile.vat_registration` — the SAME profile key GB uses,
// deliberately: a VAT registration is the same jurisdiction-neutral concept,
// the client's fixed onboarding jurisdiction decides WHICH market's normalizer
// guards the write (clientProfileSchema.js dispatches on it), and the read
// side is dispatched the same way in ownerInvoiceSellerContext.js. Two keys
// for one concept would be the country corner facing inward.
//
// FORM-INDEPENDENT, exactly as its three twins are: VAT registration is a fact
// about the BUSINESS. A sole establishment over the threshold is registered
// exactly as a mainland LLC or a free-zone company is — nothing here reads
// `entity_type`, and free-zone standing plays no part (a designated-zone
// nuance is a TREATMENT question for the coder, never a registration fact).
//
// Provenance discipline (the model-id rail): `verified_from` / `verified_at`
// carry when the record was confirmed and against what (an FTA VAT
// registration certificate, an EmaraTax TRN lookup); a record with no
// verification still resolves but rides `confirmedAgainstPrimary: false`.

const dateOnly = (value) => {
  if (value === null || value === undefined) return null;
  const raw = String(value).slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : null;
};

// Structural check for an FTA Tax Registration Number: 15 digits, commonly
// printed with spaces or hyphens ("100 1234 5678 9012"). Structural only — it
// does not prove the TRN is live; that is what verified_at is for. Lives here
// rather than an ae/entity.js because the TRN is the only AE identifier this
// record needs; if a gap-6 entity module lands for AE, the check can move
// there the way isValidGbVatNumber lives in gb/entity.js.
export const isValidAeTrn = (value) => {
  const digits = String(value || '').replace(/[\s-]/g, '');
  return /^\d{15}$/.test(digits);
};

// Closed vocabularies. Anything else is refused at the write boundary and
// reads as UNKNOWN (never as "not registered") — the tri-state note above.
export const AE_VAT_REGISTRATION_STATUSES = Object.freeze(['registered', 'not_registered', 'deregistered']);

// Why the business is registered. 'mandatory' = the Article 13 threshold duty
// (either limb — see ae/vatRegistrationThreshold.js); 'voluntary' = the
// Article 17 election above the voluntary threshold, commonly taken to recover
// input tax; 'other' is the escape.
export const AE_VAT_REGISTRATION_BASES = Object.freeze(['mandatory', 'voluntary', 'other']);

// FTA-assigned tax periods. Quarterly is the standard assignment; monthly is
// assigned to the largest registrants. Deliberately NO 'year': the UAE has no
// annual-accounting scheme, and a narrower closed vocabulary is honest.
export const AE_VAT_RETURN_PERIODS = Object.freeze(['month', 'quarter']);

const PERIOD_ALIASES = Object.freeze({
  month: 'month', monthly: 'month',
  quarter: 'quarter', quarterly: 'quarter'
});

// normalizeAeVatRegistration(record) — the write-boundary normalizer. Accepts
// an owner/operator-shaped record, returns the canonical stored shape, throws
// a typed 400 on unusable input. Refuse at the boundary; stay honest at read.
//
// A registered record does NOT require a TRN, deliberately — the FTA issues
// the TRN on approval, and there is a real window in which a business IS
// registered (effective date set) and holds no number yet. The gap surfaces
// downstream by name instead: the conditional floor requires
// `seller_tax_registration_id` of a registered seller, so an invoice attempted
// in that window refuses rather than issuing an invalid tax invoice.
export const normalizeAeVatRegistration = (record = {}) => {
  const bad = (message) => {
    const error = new Error(message);
    error.statusCode = 400;
    error.code = 'AE_VAT_REGISTRATION_INVALID';
    return error;
  };
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    throw bad('vat_registration must be an object (or null to clear).');
  }
  const status = String(record.status || '').trim().toLowerCase();
  if (!AE_VAT_REGISTRATION_STATUSES.includes(status)) {
    throw bad(`vat_registration.status must be one of ${AE_VAT_REGISTRATION_STATUSES.join(' | ')}, got ${JSON.stringify(record.status)}.`);
  }
  const registeredFrom = dateOnly(record.registered_from);
  const registeredUntil = dateOnly(record.registered_until);
  if (status === 'registered' && !registeredFrom) {
    throw bad('vat_registration.registered_from (ISO date) is required for a registered record.');
  }
  if (status === 'deregistered' && !registeredUntil) {
    throw bad('vat_registration.registered_until (ISO date) is required for a deregistered record.');
  }
  if (registeredFrom && registeredUntil && registeredUntil < registeredFrom) {
    throw bad('vat_registration.registered_until must not precede registered_from.');
  }
  const trnRaw = String(record.vat_registration_number || '').trim().toUpperCase().replace(/\s+/g, ' ');
  if (trnRaw && !isValidAeTrn(trnRaw)) {
    throw bad(`vat_registration.vat_registration_number is not a structurally valid FTA TRN (15 digits): ${JSON.stringify(record.vat_registration_number)}.`);
  }
  // A business that states it is NOT registered must not carry a TRN: it is
  // the field the conditional floor FORBIDS on its invoices, and keeping a
  // stale one in the record is how it leaks back onto one.
  if (status === 'not_registered' && trnRaw) {
    throw bad('vat_registration.vat_registration_number must be absent on a not_registered record.');
  }
  const basis = String(record.registration_basis || '').trim().toLowerCase();
  const periodRaw = String(record.vat_return_period || '').trim().toLowerCase();
  return {
    status,
    registered_from: registeredFrom,
    registered_until: registeredUntil,
    // Stored as supplied (whitespace collapsed) rather than reformatted — a
    // display convention invented here would put a guessed statutory string on
    // an invoice.
    vat_registration_number: trnRaw || null,
    registration_basis: AE_VAT_REGISTRATION_BASES.includes(basis) ? basis : (basis ? 'other' : null),
    vat_return_period: PERIOD_ALIASES[periodRaw] || null,
    verified_from: String(record.verified_from || '').trim() || null,
    verified_at: dateOnly(record.verified_at)
  };
};

// resolveAeVatRegistrationOnDate({ registration, onDate }) — the effective
// registration state on a given date. Byte-for-byte the GB resolver's shape:
// `registered === null` means UNKNOWN and is the honest answer whenever the
// record cannot settle the question — it is what `seller.taxRegistered`
// carries through to the conditional floor, which refuses by name. Every
// `reason` is a closed name. Pure; throws only on a missing/unusable onDate
// (a caller bug, not a data state).
export const resolveAeVatRegistrationOnDate = ({ registration = null, onDate } = {}) => {
  const at = dateOnly(onDate);
  if (!at) throw new Error('resolveAeVatRegistrationOnDate requires an onDate (ISO date or timestamp).');

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
  if (!AE_VAT_REGISTRATION_STATUSES.includes(status)) return unknown('unrecognised_status');

  const from = dateOnly(registration.registered_from);
  const until = dateOnly(registration.registered_until);
  const confirmedAgainstPrimary = Boolean(dateOnly(registration.verified_at));
  // The TRN is surfaced ONLY alongside a positive resolution — on a negative
  // one it is the field the pack FORBIDS on the invoice.
  const registrationId = String(registration.vat_registration_number || '').trim() || null;

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

// aeVatReturnCadenceForProfile(profile) — the FTA-assigned return cadence, or
// null when the record does not state one. Deliberately NOT defaulted to
// 'quarter': the tax period is assigned by the FTA per registrant, and a
// guessed filing cadence is a guessed deadline. A caller that needs one asks
// the owner.
export const aeVatReturnCadenceForProfile = (profile = {}) => {
  const record = profile?.vat_registration;
  if (!record || typeof record !== 'object' || Array.isArray(record)) return null;
  const raw = String(record.vat_return_period || '').trim().toLowerCase();
  return PERIOD_ALIASES[raw] || null;
};
