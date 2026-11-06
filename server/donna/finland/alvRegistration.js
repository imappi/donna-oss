// FI-13 slice 13.4 PR1 (D-FI13-17) — the effective-dated ALV registration model.
//
// ALV invoicing must enable because an EFFECTIVE registration exists on the
// invoice date AND the line is taxable — NEVER because `entity_type === 'fi-oy'`.
// "An Oy is almost always ALV-registered" is an observation, not a rule the code
// keys on. So this model is deliberately FORM-INDEPENDENT: it reads only the
// registration record and a date; it never looks at the legal form. A toiminimi
// with an effective registration invoices with ALV exactly as an Oy does.
//
// This replaces the compile-time `alvRegistered` boolean (which never existed as
// data — it was a hardcoded `false` at every issuance call site) with a durable,
// effective-dated record `{ status, registered_from/until, tax_period,
// registration_basis, verified_from/at }` stored on the client profile (jsonb —
// no migration). PR1 is the MODEL + persistence + resolver only; it touches no
// issuance path, so it is byte-identical for the live book. PR2 wires the resolver
// into invoice issuance behind a dark flag.
//
// Provenance discipline (the-model-id / confirmedAgainstPrimary rail): a
// registration is only as trustworthy as its verification. `verified_from` /
// `verified_at` carry when the record was confirmed and against what; a record
// with no verification rides `confirmedAgainstPrimary:false` and the resolver
// still honours it (the firm entered it) but flags it unverified. Pure;
// never throws except on an operator write with the wrong shape (the normalizer).

const dateOnly = (value) => {
  if (value === null || value === undefined) return null;
  const raw = String(value).slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : null;
};

// Closed vocabularies. A registration record's status is one of these; anything
// else is refused at the write boundary (normalizer) and treated as
// not-registered at read (fail-safe to the exempt/byte-identical path).
export const ALV_REGISTRATION_STATUSES = Object.freeze(['registered', 'not_registered', 'deregistered']);

// Why the client is registered — kept small and closed with an 'other' escape.
// 'mandatory' = turnover/activity obligation; 'voluntary' = elected below the
// small-scale threshold; 'other' = anything the firm records with a note.
export const ALV_REGISTRATION_BASES = Object.freeze(['mandatory', 'voluntary', 'other']);

// The Verohallinto filing cadence (verokausi). SAME vocabulary the ALV engine
// already speaks (resolveAlvPeriod / verokausiCadenceForProfile), so tax_period
// here and the existing `verokausi` profile key stay one language. They COEXIST
// deliberately (D-FI13-17, Kari's call 2026-07-12): verokausi is untouched;
// tax_period rides inside the registration record. Reconciling the two is a
// later, deliberate step — not folded here.
export const ALV_TAX_PERIODS = Object.freeze(['month', 'quarter', 'year']);

const TAX_PERIOD_ALIASES = Object.freeze({
  month: 'month', monthly: 'month', kuukausi: 'month',
  quarter: 'quarter', quarterly: 'quarter', neljannes: 'quarter', 'neljännes': 'quarter',
  year: 'year', yearly: 'year', annual: 'year', annually: 'year', vuosi: 'year'
});

const throwBadRequest = (message) => {
  const error = new Error(message);
  error.statusCode = 400;
  throw error;
};

// normalizeAlvRegistrationProfile(value) — the clientProfileSchema delegate for
// the `alv_registration` key. Returns the record to store, or null to clear.
// Throws 400 on a malformed operator write (mirrors normalizeEnnakkoveroProfile).
//
// Shape (all fields optional except status):
//   { status, registered_from?, registered_until?, tax_period?,
//     registration_basis?, verified_from?, verified_at?, note? }
export const normalizeAlvRegistrationProfile = (value) => {
  if (value === null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throwBadRequest('alv_registration must be an object or null.');
  }

  const out = {};

  const status = typeof value.status === 'string' ? value.status.trim().toLowerCase() : null;
  if (!status) throwBadRequest('alv_registration.status is required (registered | not_registered | deregistered).');
  if (!ALV_REGISTRATION_STATUSES.includes(status)) {
    throwBadRequest(`alv_registration.status must be one of ${ALV_REGISTRATION_STATUSES.join(' | ')}, got ${JSON.stringify(value.status)}.`);
  }
  out.status = status;

  for (const key of ['registered_from', 'registered_until', 'verified_from', 'verified_at']) {
    if (value[key] === undefined || value[key] === null) continue;
    const iso = dateOnly(value[key]);
    if (!iso) throwBadRequest(`alv_registration.${key} must be an ISO date (YYYY-MM-DD).`);
    out[key] = iso;
  }

  // A registered record needs a start; a deregistered record needs an end.
  if (status === 'registered' && !out.registered_from) {
    throwBadRequest('alv_registration.registered_from is required when status is registered.');
  }
  if (status === 'deregistered' && !out.registered_until) {
    throwBadRequest('alv_registration.registered_until is required when status is deregistered.');
  }
  if (out.registered_from && out.registered_until && out.registered_until < out.registered_from) {
    throwBadRequest('alv_registration.registered_until must not precede registered_from.');
  }

  if (value.tax_period !== undefined && value.tax_period !== null) {
    const canonical = TAX_PERIOD_ALIASES[String(value.tax_period).trim().toLowerCase()];
    if (!canonical) throwBadRequest(`alv_registration.tax_period must be one of ${ALV_TAX_PERIODS.join(' | ')}.`);
    out.tax_period = canonical;
  }

  if (value.registration_basis !== undefined && value.registration_basis !== null) {
    const basis = String(value.registration_basis).trim().toLowerCase();
    if (!ALV_REGISTRATION_BASES.includes(basis)) {
      throwBadRequest(`alv_registration.registration_basis must be one of ${ALV_REGISTRATION_BASES.join(' | ')}.`);
    }
    out.registration_basis = basis;
  }

  if (typeof value.note === 'string' && value.note.trim()) out.note = value.note.trim().slice(0, 500);

  return out;
};

// resolveAlvRegistrationAsOf({ registration, asOf }) — the effective registration
// state on a given date. Pure; never throws (a garbage record resolves to
// not-registered, the fail-safe byte-identical-to-today path).
//
// A record is ACTIVE on `asOf` iff registered_from <= asOf AND (registered_until
// is null OR asOf <= registered_until). status 'not_registered' is never active;
// 'registered' with no until is ongoing; 'deregistered' carries the closing
// until and is active only within its window.
export const resolveAlvRegistrationAsOf = ({ registration = null, asOf = null } = {}) => {
  const at = dateOnly(asOf);
  const rec = registration && typeof registration === 'object' && !Array.isArray(registration) ? registration : null;
  const status = rec && ALV_REGISTRATION_STATUSES.includes(rec.status) ? rec.status : 'not_registered';
  const from = rec ? dateOnly(rec.registered_from) : null;
  const until = rec ? dateOnly(rec.registered_until) : null;
  const verifiedAt = rec ? dateOnly(rec.verified_at) : null;
  const verifiedFrom = rec ? dateOnly(rec.verified_from) : null;

  let registered = false;
  if (at && status !== 'not_registered' && from && from <= at && (!until || at <= until)) {
    registered = true;
  }

  return {
    registered,
    status,
    registered_from: from,
    registered_until: until,
    tax_period: rec && ALV_TAX_PERIODS.includes(rec.tax_period) ? rec.tax_period : null,
    registration_basis: rec && ALV_REGISTRATION_BASES.includes(rec.registration_basis) ? rec.registration_basis : null,
    verified_from: verifiedFrom,
    verified_at: verifiedAt,
    // A registration the firm entered but never confirmed against a primary
    // source (a Vero decision / the registry) rides false — honoured, but flagged.
    confirmedAgainstPrimary: Boolean(verifiedAt),
    as_of: at
  };
};

// alvInvoicingApplies({ registration, asOf, lineTaxable }) — the FORM-INDEPENDENT
// gate PR2's issuance path consumes. ALV applies iff an effective registration
// exists on the invoice date AND the line is taxable. `lineTaxable` defaults true
// (a normal sale); pass false for a genuinely exempt/out-of-scope line so an
// exempt line on a registered seller still renders exempt. Never reads the legal
// form. Fail-safe: no registration ⇒ false ⇒ the exempt path (byte-identical to
// today's hardcoded non-ALV issuance).
export const alvInvoicingApplies = ({ registration = null, asOf = null, lineTaxable = true } = {}) => {
  if (lineTaxable !== true) return false;
  return resolveAlvRegistrationAsOf({ registration, asOf }).registered === true;
};
