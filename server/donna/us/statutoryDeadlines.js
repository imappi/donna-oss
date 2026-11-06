// US-3 — federal and explicitly covered STATE statutory calendars. Pure data +
// pure compute: no DB, no network, no LLM.
//
// Fail-closed by construction. It refuses an unresolvable entity type, an
// unresolvable state, a state it does not explicitly cover, and an LLC with no
// persisted federal tax classification. There is no "default state cadence" —
// borrowing one state's dates for another is precisely the jurisdiction-bleed
// class this module exists to prevent.
//
// Scope of this first slice, stated so nobody reads more into the output:
//   - CALENDAR-YEAR filers only. A fiscal-year filer's dates differ and are not
//     computed here.
//   - Delaware only, on the state axis.
//   - NOMINAL statutory dates. Weekend and federal-holiday shifts are NOT
//     applied; `date_posture` on the verdict says so rather than presenting a
//     nominal date as if it were a business-day date.
//   - It computes DATES. It does not compute an amount, decide a treatment,
//     file, or transmit.

import { usEntityType, assertUsStateResolved } from './entity.js';

export const US_STATUTORY_DEADLINES_FLAG_KEY = 'US_STATUTORY_DEADLINES';

// The states this module will speak for. Adding one is a DATA addition plus its
// provenance entry — never a silent widening of the fallback.
export const US_DEADLINE_STATES = Object.freeze(['DE']);

export const US_DEADLINE_PROVENANCE = Object.freeze({
  federal: 'IRC §§6072, 6655; IRS Forms 1040-ES, 1120, 1120-S and 1065 instructions; as of 2026-07-27',
  DE: 'Delaware Code tit. 8 §502 and tit. 6 §18-1107; Delaware Division of Corporations annual-report/tax guidance; as of 2026-07-27'
});

export const US_DEADLINE_DATE_POSTURE = 'nominal_dates_holiday_adjustment_not_applied';

const iso = (y, m, d) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

const refuse = (message, code) => {
  throw Object.assign(new Error(message), { statusCode: 409, code });
};

// An LLC has no federal return form of its own — it files as whatever it
// ELECTED to be. That election is a persisted fact, so an LLC without it
// refuses rather than defaulting to a guess.
const federalAxis = ({ entity, federalTaxClassification }) => {
  if (entity !== 'llc') return entity;
  const axis = String(federalTaxClassification || '').trim().toLowerCase();
  if (!['c_corp', 's_corp', 'partnership', 'sole_prop'].includes(axis)) {
    refuse(
      'An LLC requires its persisted federal tax classification before deadlines can be computed.',
      'US_LLC_TAX_CLASSIFICATION_REQUIRED'
    );
  }
  return axis;
};

// Federal return form + due date + estimated-payment dates, by the federal
// classification axis. Authority: IRC §§6072, 6655 and the named IRS form
// instructions; as of 2026-07-27.
const federalCalendar = (federal, year) => {
  const following = year + 1;
  if (federal === 'c_corp') {
    return {
      return_form: '1120',
      return_due_on: iso(following, 4, 15),
      estimated_payment_due_on: [iso(year, 4, 15), iso(year, 6, 15), iso(year, 9, 15), iso(year, 12, 15)]
    };
  }
  if (federal === 's_corp') {
    return { return_form: '1120-S', return_due_on: iso(following, 3, 15), estimated_payment_due_on: [] };
  }
  if (federal === 'partnership') {
    return { return_form: '1065', return_due_on: iso(following, 3, 15), estimated_payment_due_on: [] };
  }
  // sole_prop — the individual return carries the business schedule, and the
  // fourth estimate falls in January of the FOLLOWING year.
  return {
    return_form: '1040 Schedule C',
    return_due_on: iso(following, 4, 15),
    estimated_payment_due_on: [iso(year, 4, 15), iso(year, 6, 15), iso(year, 9, 15), iso(following, 1, 15)]
  };
};

// Delaware keys off the LEGAL FORM, not the federal election: a corporation
// files the annual report + franchise tax by March 1; an LLC or LP owes the
// flat annual tax by June 1. So an LLC that elected C-corp treatment federally
// still owes the June 1 LLC tax — which is why `entity` is read here and
// `federal` is not.
const delawareObligations = (entity, year) => {
  const following = year + 1;
  if (['c_corp', 's_corp'].includes(entity)) {
    return [{ kind: 'annual_report_and_franchise_tax', due_on: iso(following, 3, 1) }];
  }
  if (['llc', 'partnership'].includes(entity)) {
    return [{ kind: 'annual_tax', due_on: iso(following, 6, 1) }];
  }
  // A sole proprietor is not a registered Delaware entity — no state-entity
  // obligation follows from the legal form alone.
  return [];
};

export const computeUsStatutoryDeadlines = ({ client = {}, taxYear, federalTaxClassification = null } = {}) => {
  const year = Number(taxYear);
  if (!Number.isInteger(year) || year < 2000) refuse('taxYear is required.', 'US_TAX_YEAR_INVALID');

  const entity = usEntityType(client);
  if (!entity) refuse('A recognised US entity type is required.', 'US_ENTITY_TYPE_UNKNOWN');

  const state = assertUsStateResolved({ client, surface: 'US statutory deadlines' });
  if (!US_DEADLINE_STATES.includes(state)) {
    refuse(
      `US statutory deadlines do not yet cover ${state}; no default state cadence will be used.`,
      'US_STATE_DEADLINES_UNSUPPORTED'
    );
  }

  const federal = federalAxis({ entity, federalTaxClassification });

  return {
    tax_year: year,
    entity_type: entity,
    federal_tax_classification: federal,
    state,
    federal: federalCalendar(federal, year),
    state_obligations: delawareObligations(entity, year),
    date_posture: US_DEADLINE_DATE_POSTURE,
    provenance: US_DEADLINE_PROVENANCE
  };
};
