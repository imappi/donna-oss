// FI-13 slice 13.1b — the Oy statutory deadline engine (D-FI13-5 v2).
//
// One PURE engine computes the statutory deadlines that hang off a tilikausi end:
// base date → month-end adjustment → weekend/holiday shift → the distinct
// deadlines. It is deliberately an ENGINE, not a date-add, because the 6B rule is
// "4 months from the END of the calendar month in which the tilikausi ends"
// (§1: a period ending 15.7.2026 is due 30.11.2026, NOT 15.11), and every
// statutory date shifts off a weekend or Finnish public holiday to the next
// business day.
//
// Deadlines produced (each with its base date + shift lineage):
//   • tax_return_6b          — the corporate income-tax return: the last day of
//                              the month 4 months after the tilikausi-end month,
//                              business-day shifted. (Calendar-year Oy ⇒ 30 Apr.)
//   • fs_attachment_vero     — the financial statements attach to the 6B filing;
//                              same date as the 6B (the FS rides the 6B channel).
//                              A DISTINCT supplementation window, if any, is
//                              provenance-pending (F-FI13-V) — modelled as the 6B
//                              date so nothing is silently invented.
//   • prh_registration       — statements registered at PRH within 8 months of
//                              the tilikausi end, business-day shifted.
//
// PROVENANCE: every rule here is `confirmedAgainstPrimary: false` and must be
// primary-verified in F-FI13-V before a real Oy filing leans on it — the Finnish
// public-holiday set and the exact FS-supplementation window especially. The
// ENGINE SHAPE (base → month-end → shift → distinct receipts) is the deliverable;
// the constants are the verification surface. Pure module: no DB, no model call.
//
// Off-scope for the pilot but noted: extensions (Vero can grant a filing
// extension) enter as an override on the computed base, never a silent shift —
// the extension point is `extensionDays`.

import { toUtcIsoDay } from '../dates.js';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const isIsoDate = (s) => typeof s === 'string' && ISO_DATE.test(s);

const utc = (iso) => new Date(`${iso}T00:00:00Z`);
// UTC on purpose: every deadline here is Date.UTC arithmetic on a bare
// calendar day — the host zone must not move it.
const toIso = toUtcIsoDay;

// Add n calendar months, clamping the day to the target month's last day
// (2026-01-31 + 1m → 2026-02-28). Deterministic UTC — the tilikausi.js convention.
const addMonthsIso = (iso, n) => {
  const d = utc(iso);
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + n);
  const lastDay = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, lastDay));
  return toIso(d);
};

// The last day of the month `iso` falls in.
const lastDayOfMonthIso = (iso) => {
  const d = utc(iso);
  return toIso(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)));
};

const addDaysIso = (iso, n) => {
  const d = utc(iso);
  d.setUTCDate(d.getUTCDate() + n);
  return toIso(d);
};

// Easter Sunday for a Gregorian year (Anonymous Gregorian algorithm) → ISO.
// Deterministic, pure; the anchor for Good Friday / Easter Monday / Ascension.
const easterSundayIso = (year) => {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31); // 3 = March, 4 = April
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
};

// The Friday of Midsummer Eve (juhannusaatto): the Friday between 19–25 June.
const midsummerEveIso = (year) => {
  // 20 June + days to the following Friday; the Eve is the Fri in [19,25].
  for (let day = 19; day <= 25; day++) {
    const iso = `${year}-06-${String(day).padStart(2, '0')}`;
    if (utc(iso).getUTCDay() === 5) return iso; // 5 = Friday
  }
  return `${year}-06-19`;
};

// The Finnish public holidays that shift an official deadline, for a given year.
// FIXED national holidays + the Easter-derived + Midsummer set. Sundays are
// already non-business days; the movable Sunday feasts (Easter Sunday, Pentecost)
// are covered by the weekend rule and omitted here. PROVENANCE-PENDING: verify
// this set (and bank-closure treatment of 24 Dec / Midsummer Day) in F-FI13-V.
export const finnishPublicHolidaysForYear = (year) => {
  const easter = easterSundayIso(year);
  return new Set([
    `${year}-01-01`,                 // Uudenvuodenpäivä
    `${year}-01-06`,                 // Loppiainen (Epiphany)
    addDaysIso(easter, -2),          // Pitkäperjantai (Good Friday)
    addDaysIso(easter, 1),           // 2. pääsiäispäivä (Easter Monday)
    `${year}-05-01`,                 // Vappu (May Day)
    addDaysIso(easter, 39),          // Helatorstai (Ascension)
    midsummerEveIso(year),           // Juhannusaatto (Midsummer Eve, a Friday)
    `${year}-12-06`,                 // Itsenäisyyspäivä (Independence Day)
    `${year}-12-24`,                 // Jouluaatto (Christmas Eve — banks closed)
    `${year}-12-25`,                 // Joulupäivä
    `${year}-12-26`                  // Tapaninpäivä
  ]);
};

// isFinnishBusinessDay(iso) — not a Saturday/Sunday and not a public holiday.
export const isFinnishBusinessDay = (iso) => {
  if (!isIsoDate(iso)) return false;
  const dow = utc(iso).getUTCDay();
  if (dow === 0 || dow === 6) return false; // Sunday / Saturday
  return !finnishPublicHolidaysForYear(Number(iso.slice(0, 4))).has(iso);
};

// nextFinnishBusinessDayIso(iso) — `iso` itself if it is a business day, else the
// next business day forward. Bounded scan (never loops forever).
export const nextFinnishBusinessDayIso = (iso) => {
  if (!isIsoDate(iso)) return null;
  let cur = iso;
  for (let i = 0; i < 21; i++) {
    if (isFinnishBusinessDay(cur)) return cur;
    cur = addDaysIso(cur, 1);
  }
  return cur;
};

// A single computed deadline: the raw statutory date, the business-day-adjusted
// date actually filed against, and whether the shift moved it.
const shiftedDeadline = (rawIso) => {
  const adjusted = nextFinnishBusinessDayIso(rawIso);
  return { statutory_date: rawIso, due_date: adjusted, shifted: adjusted !== rawIso };
};

// computeOyStatutoryDeadlines({ tilikausiEnd, extensionDays }) → the three
// deadlines for an Oy whose tilikausi ends on `tilikausiEnd` (ISO). Pure; returns
// null on a bad date. `extensionDays` (default 0) is the granted-extension
// extension point — added to the 6B statutory base BEFORE the business-day shift.
export const computeOyStatutoryDeadlines = ({ tilikausiEnd, extensionDays = 0 } = {}) => {
  if (!isIsoDate(tilikausiEnd)) return null;

  // 6B: the last day of the month 4 months after the tilikausi-end month.
  const sixBBase = lastDayOfMonthIso(addMonthsIso(tilikausiEnd, 4));
  const sixBWithExtension = Number(extensionDays) > 0 ? addDaysIso(sixBBase, Number(extensionDays)) : sixBBase;
  const taxReturn6b = shiftedDeadline(sixBWithExtension);

  // PRH: 8 months from the tilikausi end date itself.
  const prh = shiftedDeadline(addMonthsIso(tilikausiEnd, 8));

  return {
    tilikausi_end: tilikausiEnd,
    tax_return_6b: taxReturn6b,
    // The FS attach to the 6B filing (same channel, same date). A distinct
    // supplementation window is provenance-pending — modelled as the 6B date so
    // nothing is invented; separate it only on a primary-confirmed rule.
    fs_attachment_vero: { ...taxReturn6b, note: 'FS attaches to the 6B filing; distinct supplementation window pending F-FI13-V' },
    prh_registration: prh,
    provenance: {
      deterministic: true,
      confirmedAgainstPrimary: false,
      rules: {
        tax_return_6b: 'last day of the month 4 months after the tilikausi-end month, business-day shifted',
        prh_registration: '8 months from the tilikausi end, business-day shifted',
        holidays: 'Finnish public-holiday set incl. Easter-derived + Midsummer — verify in F-FI13-V'
      }
    }
  };
};
