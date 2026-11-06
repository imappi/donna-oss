// fiscalPeriodIntake.js — the PURE half of explicit fiscal-period intake.
//
// WHY THIS EXISTS (and why it is not a Finland file).
//
// `fiscal_years` (migration 063) has exactly ONE writer in the tree:
// `ensureFiscalYearRowTx` in `firmDb.js`, which never takes bounds from a
// caller — it DERIVES them from `resolveClientFiscalYearTx` and is only
// reachable from Finland-flagged paths. That leaves two markets stuck on the
// same chicken-and-egg, in opposite directions:
//
//   - GB: `postGbOpeningBalanceJournalWithClient` requires exactly one
//     PERSISTED open period (`GB_OPENING_BALANCE_OPEN_PERIOD_REQUIRED`) and
//     deliberately derives nothing — a UK accounting reference period is set
//     per company, not by the calendar. No GB flow creates that row, so every
//     GB switcher refuses.
//   - FI `fi-oy`: `resolveFiscalYearForEntity` REFUSES to assume a calendar
//     year for an Oy (`FISCAL_YEAR_OY_REQUIRES_PERSISTED_PERIOD`) — correct,
//     an Oy tilikausi is off-calendar-capable. But the only writer resolves
//     its bounds through that same refusal, so an Oy cannot get its FIRST
//     period row either.
//
// So the missing capability is NOT GB-specific. Both markets need the same
// thing: a way to state a fiscal period EXPLICITLY, from an owner-supplied
// fact, rather than deriving it. That is why this module is jurisdiction-
// neutral — the standing parallel-markets question ("does this hold for the
// OTHER market too?") answers itself here.
//
// WHAT THIS MODULE REFUSES TO KNOW.
//
// A maximum period length is STATUTORY and differs by jurisdiction. Finland's
// is already in the tree and sourced (`finland/tilikausi.js` —
// `assertValidTilikausi`, 12 months toiminimi / 18 months general). The UK's
// is NOT confirmed here: gov.uk returns 403 through the egress proxy, exactly
// as it does for the VAT rates and thresholds. Encoding a plausible Companies
// Act rule from memory is the failure mode this repo names by name, so this
// module does not. It takes the statutory assertion as an INJECTED function
// and records, in the receipt, whether one was enforced.
//
// That injection also keeps the import graph honest: this module has no
// `finland/` import. The caller (`firmDb.js`) already imports both sides and
// wires FI's assertion in.

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export const FISCAL_PERIOD_INTAKE_FLAG_KEY = 'FISCAL_PERIOD_INTAKE';

export const isIsoDate = (value) => typeof value === 'string' && ISO_DATE.test(value);

export const fiscalPeriodError = (message, code, statusCode = 409) =>
  Object.assign(new Error(message), { code, statusCode });

// What Donna can and cannot ASSERT about a jurisdiction's maximum period
// length. `enforced: false` is a statement of ignorance, not permission — the
// neutral bounds below still apply, and the receipt says the statutory bound
// went unchecked so a reader can never mistake silence for a clean check.
export const FISCAL_PERIOD_STATUTORY_BOUND_PROVENANCE = Object.freeze({
  FI: Object.freeze({
    authority: 'Kirjanpitolaki (Finnish Accounting Act)',
    source: 'server/donna/finland/tilikausi.js — assertValidTilikausi, 12 calendar months (toiminimi) / 18 calendar months (general, Oy)',
    enforced: true,
    note: 'Already in the tree with its own tests; this intake delegates to it rather than restating it.'
  }),
  GB: Object.freeze({
    authority: 'Companies House / HMRC',
    source: null,
    enforced: false,
    note: 'A UK maximum accounting reference period is NOT confirmed against primary source — gov.uk returns 403 through the egress proxy, as it does for GB_VAT_RATE_PROVENANCE. Encoding one from memory is out of scope; the neutral bounds and the overlap check still apply.'
  })
});

export const statutoryBoundProvenanceFor = (jurisdiction) =>
  FISCAL_PERIOD_STATUTORY_BOUND_PROVENANCE[String(jurisdiction || '').trim().toUpperCase()] || null;

// Neutral bounds — true in every jurisdiction, and nothing more. Mirrors the
// table's own `fiscal_years_bounds_ck` so the refusal is named here rather
// than surfacing as a constraint violation.
export const assertValidFiscalPeriodBounds = ({ startsOn, endsOn } = {}) => {
  if (!isIsoDate(startsOn) || !isIsoDate(endsOn)) {
    throw fiscalPeriodError('Fiscal-period bounds must be YYYY-MM-DD dates.', 'FISCAL_PERIOD_BAD_BOUNDS', 400);
  }
  if (endsOn < startsOn) {
    throw fiscalPeriodError(
      `Fiscal period ${startsOn}..${endsOn} ends before it starts.`,
      'FISCAL_PERIOD_BAD_BOUNDS',
      400
    );
  }
  return { startsOn, endsOn };
};

const normalizeExisting = (row = {}) => ({
  id: row.id ?? null,
  label: row.label == null ? null : String(row.label),
  starts_on: row.starts_on,
  ends_on: row.ends_on,
  status: row.status ?? null
});

// Half-open-free overlap: two closed date ranges overlap iff each starts on or
// before the other ends.
export const overlappingFiscalPeriods = ({ startsOn, endsOn }, existingPeriods = []) =>
  existingPeriods
    .map(normalizeExisting)
    .filter((row) => isIsoDate(row.starts_on) && isIsoDate(row.ends_on))
    .filter((row) => row.starts_on <= endsOn && row.ends_on >= startsOn);

// planFiscalPeriodRegistration — decide, purely, what an explicit intake should
// do. Returns `{ decision: 'insert' | 'noop', period, existing, statutory }`
// or throws a NAMED refusal. It never picks between two plausible periods and
// never repairs an existing row: a period whose bounds disagree with what is
// persisted is a fact conflict, and the owner is the only one who can settle it.
export const planFiscalPeriodRegistration = ({
  label,
  startsOn,
  endsOn,
  existingPeriods = [],
  jurisdiction = null,
  statutoryAssert = null
} = {}) => {
  const cleanLabel = typeof label === 'string' ? label.trim() : '';
  if (!cleanLabel) {
    throw fiscalPeriodError('A fiscal period requires a label.', 'FISCAL_PERIOD_LABEL_REQUIRED', 400);
  }
  assertValidFiscalPeriodBounds({ startsOn, endsOn });

  // The jurisdiction's statutory maximum, when the tree can actually assert one.
  // A throw from here is the jurisdiction's own named refusal (e.g. FI's
  // TILIKAUSI_TOO_LONG) and is deliberately NOT re-wrapped — the caller should
  // see which statute refused.
  const provenance = statutoryBoundProvenanceFor(jurisdiction);
  if (typeof statutoryAssert === 'function') statutoryAssert({ starts_on: startsOn, ends_on: endsOn });
  const statutory = {
    jurisdiction: String(jurisdiction || '').trim().toUpperCase() || null,
    bound_enforced: typeof statutoryAssert === 'function',
    authority: provenance?.authority ?? null,
    source: provenance?.source ?? null
  };

  const existing = existingPeriods.map(normalizeExisting);
  const sameStart = existing.find((row) => row.starts_on === startsOn);

  if (sameStart) {
    // Idempotent re-registration of the identical fact. Returning noop (rather
    // than inserting) is what keeps a retried intake from emitting a second
    // receipt for the same period.
    if (sameStart.ends_on === endsOn && sameStart.label === cleanLabel) {
      return { decision: 'noop', period: sameStart, existing: sameStart, statutory };
    }
    throw fiscalPeriodError(
      `A fiscal period already starts on ${startsOn} (${sameStart.label ?? 'unlabelled'} ${sameStart.starts_on}..${sameStart.ends_on}); registering ${cleanLabel} ${startsOn}..${endsOn} would silently change it.`,
      'FISCAL_PERIOD_CONFLICTS_EXISTING'
    );
  }

  const sameLabel = existing.find((row) => row.label === cleanLabel);
  if (sameLabel) {
    throw fiscalPeriodError(
      `Label ${cleanLabel} is already used by the fiscal period ${sameLabel.starts_on}..${sameLabel.ends_on}.`,
      'FISCAL_PERIOD_LABEL_CONFLICT'
    );
  }

  const overlaps = overlappingFiscalPeriods({ startsOn, endsOn }, existing);
  if (overlaps.length) {
    const first = overlaps[0];
    throw fiscalPeriodError(
      `Fiscal period ${startsOn}..${endsOn} overlaps the persisted period ${first.label ?? 'unlabelled'} ${first.starts_on}..${first.ends_on}.`,
      'FISCAL_PERIOD_OVERLAPS_EXISTING'
    );
  }

  return {
    decision: 'insert',
    period: { label: cleanLabel, starts_on: startsOn, ends_on: endsOn, status: 'open' },
    existing: null,
    statutory
  };
};
