// GB — the effective-dated VAT registration record (kernel-audit M2, piece 1).
//
// This is the persisted home gap 9 left open. `buildOutboundInvoiceModel` reads
// `seller.taxRegistered` to select WHICH statutory floor applies to a GB invoice
// (`outbound/issuance.js`), and `seller.taxRegistrationId` to fill
// `seller_tax_registration_id`. Until this module, BOTH were caller-passed only:
// the contract could ask the question and nothing in the tree could answer it.
//
// Shape mirrors `finland/alvRegistration.js` (D-FI13-17) and
// `singapore/gstRegistration.js`: a durable, effective-dated record
// `{ status, registered_from/until, vat_registration_number, registration_basis,
//    vat_return_period, verified_from/at }` on `clients.profile` (jsonb — no
// migration), refused at the write boundary by a normalizer and read through a
// pure resolver.
//
// FORM-INDEPENDENT, deliberately, exactly as its two twins are. VAT registration
// is a fact about the BUSINESS, not about its legal form: a sole trader over the
// threshold is VAT-registered exactly as an Ltd is. Nothing here reads
// `entity_type`, and `gb/entity.js` is imported only for its structural VAT
// number check.
//
// ── The ONE way this differs from its FI and SG twins, on purpose ────────────
//
// Their read-side resolvers are FAIL-SAFE: an absent or unusable record resolves
// to NOT registered, because in both markets the no-tax path is byte-identical
// to the behaviour that shipped before the record existed, so a default is
// quiet. GB has no such path. The GB pack declares a CONDITIONAL statutory floor
// (gap 9), where "not registered" is not a quiet default at all — it actively
// FORBIDS `seller_tax_registration_id` and `line_tax_rate` and issues a no-VAT
// invoice. Defaulting an unknown to "not registered" would therefore issue a
// non-VAT invoice for a registered business and understate output VAT: a
// statutory error, not a cosmetic one.
//
// So this resolver is TRI-STATE — `true` / `false` / `null`-for-unknown — and
// only a RECORDED status yields `false`. An unknown flows through to
// `buildOutboundInvoiceModel`, which refuses the build by name. Refusing to
// issue is recoverable; issuing a wrong VAT invoice is not.
//
// Provenance discipline (the model-id / confirmedAgainstPrimary rail): a
// registration is only as trustworthy as its verification. `verified_from` /
// `verified_at` carry when the record was confirmed and against what (an HMRC
// registration certificate VAT4, a "Check a UK VAT number" lookup); a record
// with no verification still resolves (the owner entered it) but rides
// `confirmedAgainstPrimary: false`.

import { isValidGbVatNumber } from './entity.js';

const dateOnly = (value) => {
  if (value === null || value === undefined) return null;
  const raw = String(value).slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : null;
};

// Closed vocabularies. A record's status is one of these; anything else is
// refused at the write boundary and reads as UNKNOWN (never as "not
// registered") — see the tri-state note above.
export const GB_VAT_REGISTRATION_STATUSES = Object.freeze(['registered', 'not_registered', 'deregistered']);

// Why the business is registered. 'mandatory' = the threshold obligation (either
// statutory limb — see `gb/vatRegistrationThreshold.js`); 'voluntary' = elected
// below the threshold, which UK businesses commonly do to recover input tax;
// 'other' is the escape (e.g. registration on acquiring a going concern).
export const GB_VAT_REGISTRATION_BASES = Object.freeze(['mandatory', 'voluntary', 'other']);

// HMRC VAT return periods. Quarterly (a "stagger") is the default assignment;
// monthly is available on request and typical for repayment traders; annual is
// the Annual Accounting Scheme. SAME period-type vocabulary the FI and SG
// engines speak, so there is one cadence vocabulary across markets.
export const GB_VAT_RETURN_PERIODS = Object.freeze(['month', 'quarter', 'year']);

const PERIOD_ALIASES = Object.freeze({
  month: 'month', monthly: 'month',
  quarter: 'quarter', quarterly: 'quarter',
  year: 'year', yearly: 'year', annual: 'year', annually: 'year'
});

// normalizeGbVatRegistration(record) — the write-boundary normalizer. Accepts an
// owner/operator-shaped record, returns the canonical stored shape, throws a
// typed 400 on unusable input. Refuse at the boundary; stay honest at read.
//
// A registered record does NOT require a VAT number, deliberately. HMRC issues
// the VRN after the effective date of registration, so there is a real window in
// which a business IS registered and has no number yet. Refusing that record
// would force the owner to lie about their status to record anything at all. The
// gap surfaces downstream instead, by name: the conditional floor requires
// `seller_tax_registration_id` of a registered seller, so an invoice attempted
// in that window refuses rather than issuing an invalid VAT invoice.
export const normalizeGbVatRegistration = (record = {}) => {
  const bad = (message) => {
    const error = new Error(message);
    error.statusCode = 400;
    error.code = 'GB_VAT_REGISTRATION_INVALID';
    return error;
  };
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    throw bad('vat_registration must be an object (or null to clear).');
  }
  const status = String(record.status || '').trim().toLowerCase();
  if (!GB_VAT_REGISTRATION_STATUSES.includes(status)) {
    throw bad(`vat_registration.status must be one of ${GB_VAT_REGISTRATION_STATUSES.join(' | ')}, got ${JSON.stringify(record.status)}.`);
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
  // Structural only, and only when supplied. `isValidGbVatNumber` accepts the
  // four real UK forms (9-digit, 12-digit branch trader, GD/HA government
  // series, with or without the GB prefix). It does NOT prove the number is
  // live — that is what verified_at is for.
  const vatNumberRaw = String(record.vat_registration_number || '').trim().toUpperCase().replace(/\s+/g, ' ');
  if (vatNumberRaw && !isValidGbVatNumber(vatNumberRaw)) {
    throw bad(`vat_registration.vat_registration_number is not a structurally valid UK VAT number: ${JSON.stringify(record.vat_registration_number)}.`);
  }
  // A business that states it is NOT registered must not carry a VAT number: it
  // is the field the conditional floor FORBIDS on its invoices, and keeping a
  // stale one in the record is how it leaks back onto one.
  if (status === 'not_registered' && vatNumberRaw) {
    throw bad('vat_registration.vat_registration_number must be absent on a not_registered record.');
  }
  const basis = String(record.registration_basis || '').trim().toLowerCase();
  const periodRaw = String(record.vat_return_period || '').trim().toLowerCase();
  return {
    status,
    registered_from: registeredFrom,
    registered_until: registeredUntil,
    // Stored as the owner supplied it (upper-cased, whitespace collapsed) rather
    // than reformatted. The display convention ("GB 123 4567 89") is a
    // presentation choice, and inventing one here would put a guessed statutory
    // string on an invoice.
    vat_registration_number: vatNumberRaw || null,
    registration_basis: GB_VAT_REGISTRATION_BASES.includes(basis) ? basis : (basis ? 'other' : null),
    vat_return_period: PERIOD_ALIASES[periodRaw] || null,
    verified_from: String(record.verified_from || '').trim() || null,
    verified_at: dateOnly(record.verified_at)
  };
};

// resolveGbVatRegistrationOnDate({ registration, onDate }) — the effective
// registration state on a given date.
//
// Returns { registered: true | false | null, reason, status, registrationId,
//           registeredFrom, registeredUntil, confirmedAgainstPrimary, asOf }.
//
// `registered === null` means UNKNOWN and is the honest answer whenever the
// record cannot settle the question. It is NOT an error: it is what
// `seller.taxRegistered` is designed to carry through to the conditional floor,
// which refuses by name. Every `reason` is a closed name.
//
// Pure. Throws only on a missing/unusable `onDate`, which is a caller bug rather
// than a data state (same posture as `resolveGstRegistrationOnDate`).
export const resolveGbVatRegistrationOnDate = ({ registration = null, onDate } = {}) => {
  const at = dateOnly(onDate);
  if (!at) throw new Error('resolveGbVatRegistrationOnDate requires an onDate (ISO date or timestamp).');

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
  if (!GB_VAT_REGISTRATION_STATUSES.includes(status)) return unknown('unrecognised_status');

  const from = dateOnly(registration.registered_from);
  const until = dateOnly(registration.registered_until);
  const confirmedAgainstPrimary = Boolean(dateOnly(registration.verified_at));
  // The VAT number is surfaced ONLY alongside a positive resolution. On a
  // negative one it is the field the pack FORBIDS, so handing it to the seller
  // context would refuse the very invoice this resolution says is issuable.
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
  // A dated status with no effective date cannot be placed on a timeline. That
  // is an incomplete record, not a negative one — the normalizer refuses to
  // write it, but a hand-edited or legacy blob can still arrive here.
  if (!from) return unknown('no_effective_date', { status });
  if (at < from) return settled(false, 'not_yet_effective');
  if (until && at > until) return settled(false, 'deregistered');
  return settled(true, 'registered');
};

// gbVatReturnCadenceForProfile(profile) — the assigned VAT return cadence, or
// null when the record does not state one. Deliberately NOT defaulted to
// 'quarter': the stagger is assigned by HMRC, and a guessed filing cadence is a
// guessed deadline. A caller that needs one asks the owner.
export const gbVatReturnCadenceForProfile = (profile = {}) => {
  const record = profile?.vat_registration;
  if (!record || typeof record !== 'object' || Array.isArray(record)) return null;
  const raw = String(record.vat_return_period || '').trim().toLowerCase();
  return PERIOD_ALIASES[raw] || null;
};
