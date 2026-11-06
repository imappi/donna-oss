// FI-11 — Mileage (ajopäiväkirja) + per-diems (päivärahat) tracking + deduction
// aggregation for a Finnish sole trader (elinkeinonharjoittaja). Pure DATA + pure
// compute. Feeds FI-12 (the annual elinkeinonharjoittajan veroilmoitus) with the
// deductible totals. No ledger post, no isolation-listed import.
//
// KEEP-layer note: the Verohallinto rates below are STATUTORY CONSTANTS set each
// year by Verohallinto's decision on tax-free travel-cost reimbursements
// (päätös verovapaista matkakustannusten korvauksista). They are DATA keyed by
// tax year, deliberately easy to correct. The launch-critical 2026 row and the
// 2025 row were CONFIRMED against the primary Verohallinto decision (vero.fi
// decision register 47405) on 2026-07-09 — see each row's `source` string and the
// `confirmedAgainstPrimary` flag. When a new tax year's decision publishes, add its
// row and re-confirm the cents against that primary decision before it goes live —
// the amounts are law, not a guess. The AGGREGATION math (below) is the tested
// core; the constants are provenance-tagged data.
//
// For a sole trader, a privately-owned car used in business (<50% business use)
// gives an additional deduction (lisävähennys) at the tax-free kilometrikorvaus
// rate for the business kilometres driven; per-diems for business travel days are
// deductible at the full/partial rates. This module computes those totals; it does
// NOT decide car-in-business-assets-vs-private (>50% use) — that classification is
// upstream and changes which regime applies.
//
// Two layers here:
//   1. The RATE + DEDUCTION math (ratesForYear / mileageDeduction /
//      perDiemDeduction / travelDeductions) — the tested arithmetic core.
//   2. The CAPTURE layer (classifyTravelDay / captureTravelLog) — normalises the
//      raw ajopäiväkirja + travel-day log a WhatsApp intake (or an extraction
//      pass) produces into the { trips, fullDays, partialDays } shape the
//      deduction math consumes, and — per two-terminal-states — surfaces any row
//      it cannot classify as `needsClarification` (on the owner) rather than
//      silently dropping or guessing it.

// Rate tables keyed by tax year. km = kilometrikorvaus (€/km); perDiemFull =
// kokopäiväraha (travel > 10 h); perDiemPartial = osapäiväraha (travel > 6 h).
// `confirmedAgainstPrimary` = the cents were checked against the primary
// Verohallinto päätös (vero.fi decision register 47405) on the date in `source`.
export const TRAVEL_RATES_BY_YEAR = {
  // km 0.57/km confirmed against the primary vero.fi decision 47405 (2026-07-09);
  // the full/partial per diem are the established 2024 values (kokopäiväraha 51 €,
  // osapäiväraha 24 €), not re-quoted from the primary decision in this pass.
  2024: { km: 0.57, perDiemFull: 51, perDiemPartial: 24, confirmedAgainstPrimary: false, source: 'Verohallinto päätös 2024 — km confirmed vs primary vero.fi decision 47405 (2026-07-09); per diems established 2024 values' },
  // Confirmed 2026-07-09 against the primary vero.fi decision 47405 content:
  // km 0.59, kokopäiväraha 53 €, osapäiväraha 24 € (ateriakorvaus 13.25 €).
  2025: { km: 0.59, perDiemFull: 53, perDiemPartial: 24, confirmedAgainstPrimary: true, source: 'Verohallinto päätös 2025 — confirmed vs primary vero.fi decision 47405 (2026-07-09): km 0.59, kokopäiväraha 53, osapäiväraha 24' },
  // Confirmed 2026-07-09 against the primary vero.fi decision 47405 content
  // (also corroborated across Netvisor/Procountor/Veronmaksajat/m2/MYP/Greenstep):
  // km 0.55 (−0.04 from 2025), kokopäiväraha 54 €, osapäiväraha 25 €,
  // ateriakorvaus 13.50 €. This is the Phase-1 launch tax year.
  2026: { km: 0.55, perDiemFull: 54, perDiemPartial: 25, confirmedAgainstPrimary: true, source: 'Verohallinto päätös 2026 — confirmed vs primary vero.fi decision 47405 (2026-07-09): km 0.55, kokopäiväraha 54, osapäiväraha 25, ateriakorvaus 13.50' }
};

// The most recent year present in the table (fallback when a caller passes an
// unknown/future year — with a flag so the caller knows it was substituted).
const LATEST_YEAR = Math.max(...Object.keys(TRAVEL_RATES_BY_YEAR).map(Number));

// ratesForYear(year) — the rate row for a tax year. Returns { rates, exact }:
// exact=false means the requested year was not in the table and the latest was
// substituted (never silently — the caller can surface it).
export const ratesForYear = (year) => {
  const y = Number(year);
  if (TRAVEL_RATES_BY_YEAR[y]) return { year: y, rates: TRAVEL_RATES_BY_YEAR[y], exact: true };
  return { year: LATEST_YEAR, rates: TRAVEL_RATES_BY_YEAR[LATEST_YEAR], exact: false };
};

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

// mileageDeduction({ trips, year }) — sum the business kilometres across an
// ajopäiväkirja and apply the year's km rate. `trips` is [{ km, ... }]; only the
// `km` field is used here (date/purpose/route are for the log/audit, not the sum).
// Returns { totalKm, rate, deduction, year, exactRate }.
export const mileageDeduction = ({ trips = [], year } = {}) => {
  const { year: resolvedYear, rates, exact } = ratesForYear(year);
  const totalKm = trips.reduce((sum, t) => {
    const km = Number(t?.km);
    if (!Number.isFinite(km) || km < 0) return sum; // ignore malformed/negative rows
    return sum + km;
  }, 0);
  return {
    year: resolvedYear,
    rate: rates.km,
    exactRate: exact,
    totalKm: round2(totalKm),
    deduction: round2(totalKm * rates.km)
  };
};

// perDiemDeduction({ fullDays, partialDays, year }) — apply the full/partial
// per-diem rates to the counts of qualifying travel days. Returns
// { fullDays, partialDays, deduction, year, exactRate }.
export const perDiemDeduction = ({ fullDays = 0, partialDays = 0, year } = {}) => {
  const { year: resolvedYear, rates, exact } = ratesForYear(year);
  const f = Math.max(0, Number(fullDays) || 0);
  const p = Math.max(0, Number(partialDays) || 0);
  return {
    year: resolvedYear,
    exactRate: exact,
    fullDays: f,
    partialDays: p,
    deduction: round2(f * rates.perDiemFull + p * rates.perDiemPartial)
  };
};

// travelDeductions({ trips, fullDays, partialDays, year }) — the combined
// additional deductions (lisävähennykset) for a tax year, the shape FI-12 consumes.
export const travelDeductions = ({ trips = [], fullDays = 0, partialDays = 0, year } = {}) => {
  const mileage = mileageDeduction({ trips, year });
  const perDiem = perDiemDeduction({ fullDays, partialDays, year });
  return {
    year: mileage.year,
    exactRates: mileage.exactRate && perDiem.exactRate,
    mileage,
    perDiem,
    total: round2(mileage.deduction + perDiem.deduction)
  };
};

// ---------------------------------------------------------------------------
// Capture layer — normalise a raw travel log into the deduction-input shape.
// ---------------------------------------------------------------------------

// Per-diem duration thresholds (Verohallinto): a business trip earns a FULL
// per diem (kokopäiväraha) when it lasts OVER 10 hours, a PARTIAL per diem
// (osapäiväraha) when it lasts OVER 6 hours (and not over 10). ≤ 6 h earns
// neither. These hour thresholds are the statutory rule, stable across the years
// in the rate table above. KEEP-layer: this is a deterministic threshold test,
// not a model judgment.
//
// ⚠️ Nuances this DURATION classifier deliberately does NOT model (so it must not
// be treated as a full statutory per-diem engine): (a) eligibility also requires
// the destination be over 15 km from BOTH home and the ordinary workplace;
// (b) on a multi-day trip a final partial leg over 2 h beyond a full day earns an
// extra per diem; (c) a free meal provided halves the per diem. Days where these
// bite are for upstream/owner judgment — the capture layer classifies by the
// hours it is given and flags what it cannot, it does not invent the rest.
export const PER_DIEM_HOURS = { fullOver: 10, partialOver: 6 };

// classifyTravelDay(hours) — 'full' | 'partial' | 'none' | 'unknown'. 'unknown'
// (missing/invalid hours) is a needs-clarification signal, never coerced to 'none'.
export const classifyTravelDay = (hours) => {
  const h = Number(hours);
  if (hours === undefined || hours === null || hours === '' || !Number.isFinite(h) || h < 0) return 'unknown';
  if (h > PER_DIEM_HOURS.fullOver) return 'full';
  if (h > PER_DIEM_HOURS.partialOver) return 'partial';
  return 'none';
};

// captureTravelLog({ trips, travelDays, year }) — normalise the raw ajopäiväkirja
// (mileage) + travel-day (per-diem) log into the { trips, fullDays, partialDays }
// shape travelDeductions consumes, and run the deduction math over the clean rows.
//
// `trips`: [{ date?, route?, purpose?, km }] — a trip with a finite km > 0 is
//   counted; a trip with a missing/invalid/negative km is NOT summed (it would
//   corrupt the deduction) and is surfaced in `needsClarification` — the two-
//   terminal-states rule: a row is either clean-and-counted or on-the-owner.
// `travelDays`: [{ date?, hours, ... }] — classified by classifyTravelDay; 'full'
//   and 'partial' are counted, 'none' is recorded as excluded (not deductible but
//   not an error), 'unknown' goes to `needsClarification`.
//
// Returns { year, trips, fullDays, partialDays, excludedDays, needsClarification,
//   deductions } where `deductions` is the travelDeductions verdict for the clean
//   rows. `needsClarification` being non-empty means the log is not yet complete —
//   the owner must resolve those rows before the totals are final.
export const captureTravelLog = ({ trips = [], travelDays = [], year } = {}) => {
  const cleanTrips = [];
  const needsClarification = [];

  (Array.isArray(trips) ? trips : []).forEach((t, i) => {
    const km = Number(t?.km);
    if (!Number.isFinite(km) || km <= 0) {
      needsClarification.push({ kind: 'trip', index: i, reason: 'missing or invalid km', row: t });
      return;
    }
    cleanTrips.push({
      date: t?.date ?? null,
      route: t?.route ?? null,
      purpose: t?.purpose ?? null,
      km: round2(km)
    });
  });

  let fullDays = 0;
  let partialDays = 0;
  const excludedDays = [];

  (Array.isArray(travelDays) ? travelDays : []).forEach((d, i) => {
    const cls = classifyTravelDay(d?.hours);
    if (cls === 'full') fullDays += 1;
    else if (cls === 'partial') partialDays += 1;
    else if (cls === 'none') excludedDays.push({ index: i, reason: 'under 6 h — no per diem', row: d });
    else needsClarification.push({ kind: 'travelDay', index: i, reason: 'missing or invalid hours', row: d });
  });

  const deductions = travelDeductions({ trips: cleanTrips, fullDays, partialDays, year });

  return {
    year: deductions.year,
    trips: cleanTrips,
    fullDays,
    partialDays,
    excludedDays,
    needsClarification,
    complete: needsClarification.length === 0,
    deductions
  };
};
