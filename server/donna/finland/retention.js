// FI-15 G-9 (docs/design-donna-finland-fi15-g9-retention-optout.md) — the
// Kirjanpitolaki 2:10 retention policy, encoded. Pure KEEP-layer date math:
// two closed retention classes, deterministic retain-until computation off the
// fiscal-year end, and the archive statement block. No DB, no model call —
// enforcement lives at the hard-delete writers in firmDb.js, the statement
// lives on the close archive.
//
// The two statutory clocks are DIFFERENT and that difference is the whole
// reason this module exists instead of a constant:
//   - kirjanpitokirja (books, financial statements, chart of accounts, list of
//     books): 10 years from the fiscal-year END DATE.
//   - tosite (vouchers, business correspondence, other material): 6 years from
//     the END OF THE CALENDAR YEAR in which the fiscal year ended.
// Example: FY ending 2027-03-31 → books held to 2037-03-31, vouchers to
// 2033-12-31.

import { toLocalIsoDay, toUtcIsoDay } from '../dates.js';

export const RETENTION_CLASSES = Object.freeze(['tosite', 'kirjanpitokirja']);

export const RETENTION_YEARS = Object.freeze({
  tosite: 6,
  kirjanpitokirja: 10
});

// finlex.fi is proxy-blocked from this container class (403, 2026-07-11) —
// the statute text is corroborated against unanimous secondary sources
// (Taloushallintoliitto, Minilex, Finnish accounting firms). Primary
// verification is F-G9-V on the F-FI8-R1 network-open checklist. The rule is
// decades-stable; the flag records the honest verification state anyway.
export const RETENTION_PROVENANCE = Object.freeze({
  statute: 'Kirjanpitolaki 2:10',
  confirmedAgainstPrimary: false,
  source: 'KPL 2:10 — kirjanpitokirjat 10 v tilikauden päättymisestä; tositteet 6 v sen kalenterivuoden lopusta, jonka aikana tilikausi päättyi. RE-CORROBORATED via search extraction 2026-07-11 (Taloushallintoliitto/Monetor/Minilex/Azets, incl. the worked example FY ending 31.3.2025 → tositteet to 2031-12-31, kirjat to 2035-03-31 — matches both clocks here exactly); byte-level primary finlex.fi read pending (network policy, F-G9-V).'
});

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const isIsoDate = (s) => typeof s === 'string' && ISO_DATE.test(s);

// Add whole years to an ISO date, UTC-safe. Feb 29 + N years lands on Feb 28
// in a non-leap target year (setUTCFullYear would roll to Mar 1 — clamp it).
const addYearsIso = (iso, years) => {
  const [y, m, d] = iso.split('-').map(Number);
  const target = new Date(Date.UTC(y + years, m - 1, d));
  if (target.getUTCMonth() !== m - 1) target.setUTCDate(0);
  return toUtcIsoDay(target); // UTC on purpose: Date.UTC arithmetic on a bare day
};

// retentionUntil({ retentionClass, fiscalYearEndsOn }) → the LAST held day
// (inclusive), ISO. Throws on an unknown class or a bad date — callers pass
// persisted fiscal_years rows, so garbage here is a bug to surface, not to
// smooth over.
export const retentionUntil = ({ retentionClass, fiscalYearEndsOn } = {}) => {
  if (!RETENTION_CLASSES.includes(retentionClass)) {
    throw Object.assign(new Error(`Unknown retention class: ${retentionClass}`), { code: 'RETENTION_UNKNOWN_CLASS' });
  }
  if (!isIsoDate(fiscalYearEndsOn)) {
    throw Object.assign(new Error('fiscalYearEndsOn must be an ISO date.'), { code: 'RETENTION_BAD_DATE' });
  }
  if (retentionClass === 'kirjanpitokirja') {
    return addYearsIso(fiscalYearEndsOn, RETENTION_YEARS.kirjanpitokirja);
  }
  // tosite: 6 years from the end of the CALENDAR YEAR the fiscal year ended in.
  const endYear = Number(fiscalYearEndsOn.slice(0, 4));
  return `${endYear + RETENTION_YEARS.tosite}-12-31`;
};

// evaluateRetentionHold({ retentionClass, fiscalYearEndsOn, status, at }) →
// { held, retain_until, retention_class, reason }. A hold arms only once the
// fiscal year leaves 'open' ('closing' counts as held — a close in progress is
// already statutory material); during an open year, deleting a wrong upload is
// normal bookkeeping correction. The close is the one-way door (D-G9-1).
export const evaluateRetentionHold = ({ retentionClass, fiscalYearEndsOn, status = 'open', at } = {}) => {
  const retain_until = retentionUntil({ retentionClass, fiscalYearEndsOn });
  // "today" is the HOST's calendar day — the appliance runs ahead of UTC.
  const atIso = isIsoDate(at) ? at : toLocalIsoDay(new Date());
  const fiscalYearArmed = status !== 'open';
  const withinWindow = atIso <= retain_until;
  const held = fiscalYearArmed && withinWindow;
  return {
    held,
    retain_until,
    retention_class: retentionClass,
    reason: held
      ? `KPL 2:10 retention holds ${retentionClass} material of the fiscal year ending ${fiscalYearEndsOn} until ${retain_until}.`
      : (fiscalYearArmed ? 'Retention window has elapsed.' : 'Fiscal year is open; retention arms at close.')
  };
};

// describeArchiveRetention({ fiscalYear, at }) → the close-archive statement
// block (D-G9-2). `fiscalYear` is the persisted fiscal_years row containing
// the archive period — render the persisted verdict; the caller omits the
// block entirely when no row exists (never fabricate a calendar assumption).
export const describeArchiveRetention = ({ fiscalYear, at } = {}) => {
  const endsOn = fiscalYear?.ends_on;
  if (!isIsoDate(endsOn)) return null;
  const tosite = evaluateRetentionHold({ retentionClass: 'tosite', fiscalYearEndsOn: endsOn, status: fiscalYear?.status || 'open', at });
  const kirjanpitokirja = evaluateRetentionHold({ retentionClass: 'kirjanpitokirja', fiscalYearEndsOn: endsOn, status: fiscalYear?.status || 'open', at });
  return {
    statute: RETENTION_PROVENANCE.statute,
    fiscal_year: { label: fiscalYear?.label || null, starts_on: fiscalYear?.starts_on || null, ends_on: endsOn, status: fiscalYear?.status || 'open' },
    classes: {
      tosite: { retain_until: tosite.retain_until, years: RETENTION_YEARS.tosite },
      kirjanpitokirja: { retain_until: kirjanpitokirja.retain_until, years: RETENTION_YEARS.kirjanpitokirja }
    },
    commitment_fi: `Kirjanpitolain 2:10 mukaisesti: tilikauden ${endsOn} tositteet säilytetään ${tosite.retain_until} saakka ja kirjanpitokirjat sekä tilinpäätös ${kirjanpitokirja.retain_until} saakka.`,
    commitment_en: `Per Kirjanpitolaki 2:10: vouchers of the fiscal year ending ${endsOn} are retained until ${tosite.retain_until}; the books and financial statements until ${kirjanpitokirja.retain_until}.`,
    provenance: RETENTION_PROVENANCE
  };
};
