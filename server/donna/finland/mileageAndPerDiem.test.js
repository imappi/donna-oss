import test from 'node:test';
import assert from 'node:assert/strict';
import {
  TRAVEL_RATES_BY_YEAR,
  ratesForYear,
  mileageDeduction,
  perDiemDeduction,
  travelDeductions,
  classifyTravelDay,
  captureTravelLog,
  PER_DIEM_HOURS
} from './mileageAndPerDiem.js';

test('rate table is keyed by year with the required fields', () => {
  for (const [year, row] of Object.entries(TRAVEL_RATES_BY_YEAR)) {
    assert.ok(Number(year) > 2000, `bad year key ${year}`);
    for (const f of ['km', 'perDiemFull', 'perDiemPartial']) {
      assert.equal(typeof row[f], 'number', `${year}.${f} not numeric`);
      assert.ok(row[f] > 0, `${year}.${f} should be positive`);
    }
    // Every row carries a provenance string and an explicit confirmed-against-primary
    // flag (the rate-confirmation pass replaced the blanket VERIFY note with per-row
    // provenance; see the confirmation tests below).
    assert.ok(typeof row.source === 'string' && row.source.length > 0, `${year} should carry a provenance note`);
    assert.equal(typeof row.confirmedAgainstPrimary, 'boolean', `${year} should carry a confirmedAgainstPrimary flag`);
  }
});

test('ratesForYear returns exact for a known year, substitutes latest (flagged) otherwise', () => {
  const known = ratesForYear(2025);
  assert.equal(known.exact, true);
  assert.equal(known.year, 2025);

  const latestYear = Math.max(...Object.keys(TRAVEL_RATES_BY_YEAR).map(Number));
  const unknown = ratesForYear(2200);
  assert.equal(unknown.exact, false, 'unknown year must be flagged non-exact');
  assert.equal(unknown.year, latestYear, 'should fall back to the latest known year');
});

test('mileageDeduction sums km and applies the year rate', () => {
  const res = mileageDeduction({ trips: [{ km: 100 }, { km: 50.5 }], year: 2025 });
  assert.equal(res.totalKm, 150.5);
  assert.equal(res.rate, 0.59);
  assert.equal(res.deduction, 88.8); // 150.5 * 0.59 = 88.795 -> 88.80
  assert.equal(res.exactRate, true);
});

test('mileageDeduction ignores malformed and negative km rows', () => {
  const res = mileageDeduction({ trips: [{ km: 100 }, { km: -20 }, { km: 'x' }, {}], year: 2024 });
  assert.equal(res.totalKm, 100);
  assert.equal(res.deduction, 57); // 100 * 0.57
});

test('perDiemDeduction applies full and partial rates', () => {
  const res = perDiemDeduction({ fullDays: 3, partialDays: 2, year: 2025 });
  assert.equal(res.deduction, 3 * 53 + 2 * 24); // 159 + 48 = 207
  assert.equal(res.fullDays, 3);
  assert.equal(res.partialDays, 2);
});

test('perDiemDeduction floors negatives to zero', () => {
  const res = perDiemDeduction({ fullDays: -5, partialDays: 1, year: 2024 });
  assert.equal(res.fullDays, 0);
  assert.equal(res.deduction, 24);
});

test('travelDeductions combines mileage and per-diems and reports rate exactness', () => {
  const res = travelDeductions({ trips: [{ km: 200 }], fullDays: 1, partialDays: 0, year: 2025 });
  assert.equal(res.mileage.deduction, 118); // 200 * 0.59
  assert.equal(res.perDiem.deduction, 53);
  assert.equal(res.total, 171);
  assert.equal(res.exactRates, true);
});

test('travelDeductions flags non-exact rates when the year is unknown', () => {
  const res = travelDeductions({ trips: [{ km: 10 }], fullDays: 0, partialDays: 0, year: 2099 });
  assert.equal(res.exactRates, false);
});

test('2026 rate row is present and exact (current tax year, no longer a fallback)', () => {
  const res = ratesForYear(2026);
  assert.equal(res.exact, true);
  assert.equal(res.year, 2026);
  assert.equal(res.rates.km, 0.55);
  assert.equal(res.rates.perDiemFull, 54);
  assert.equal(res.rates.perDiemPartial, 25);
  // 2026 is now the latest year, so an unknown future year falls back to it.
  assert.equal(ratesForYear(2100).year, 2026);
});

test('classifyTravelDay applies the >10h full / >6h partial thresholds', () => {
  assert.equal(classifyTravelDay(11), 'full');
  assert.equal(classifyTravelDay(10.5), 'full');
  assert.equal(classifyTravelDay(10), 'partial'); // exactly 10 is not OVER 10
  assert.equal(classifyTravelDay(7), 'partial');
  assert.equal(classifyTravelDay(6), 'none'); // exactly 6 is not OVER 6
  assert.equal(classifyTravelDay(3), 'none');
  assert.equal(PER_DIEM_HOURS.fullOver, 10);
  assert.equal(PER_DIEM_HOURS.partialOver, 6);
});

test('classifyTravelDay returns "unknown" (not "none") for missing/invalid hours', () => {
  assert.equal(classifyTravelDay(undefined), 'unknown');
  assert.equal(classifyTravelDay(null), 'unknown');
  assert.equal(classifyTravelDay(''), 'unknown');
  assert.equal(classifyTravelDay('x'), 'unknown');
  assert.equal(classifyTravelDay(-1), 'unknown');
});

test('captureTravelLog normalises clean trips and days into the deduction totals', () => {
  const res = captureTravelLog({
    trips: [
      { date: '2026-03-01', route: 'Helsinki–Tampere', purpose: 'asiakaskäynti', km: 180 },
      { date: '2026-03-02', route: 'Tampere–Helsinki', purpose: 'paluu', km: 180 }
    ],
    travelDays: [{ date: '2026-03-01', hours: 12 }, { date: '2026-03-02', hours: 7 }],
    year: 2026
  });
  assert.equal(res.complete, true);
  assert.equal(res.needsClarification.length, 0);
  assert.equal(res.trips.length, 2);
  assert.equal(res.fullDays, 1);
  assert.equal(res.partialDays, 1);
  assert.equal(res.deductions.mileage.totalKm, 360);
  assert.equal(res.deductions.mileage.deduction, 198); // 360 * 0.55
  assert.equal(res.deductions.perDiem.deduction, 54 + 25);
  assert.equal(res.deductions.total, 198 + 79);
});

test('captureTravelLog surfaces bad-km trips and unknown-hours days as needsClarification (two-terminal-states)', () => {
  const res = captureTravelLog({
    trips: [{ km: 100 }, { km: -5 }, { km: 'x' }, { route: 'no km' }],
    travelDays: [{ hours: 12 }, { hours: null }, { date: 'd', notes: 'forgot hours' }],
    year: 2026
  });
  // one clean trip counted; three flagged
  assert.equal(res.trips.length, 1);
  assert.equal(res.deductions.mileage.totalKm, 100);
  // one full day counted; two unknown-hours days flagged
  assert.equal(res.fullDays, 1);
  assert.equal(res.partialDays, 0);
  assert.equal(res.complete, false);
  const tripFlags = res.needsClarification.filter((n) => n.kind === 'trip');
  const dayFlags = res.needsClarification.filter((n) => n.kind === 'travelDay');
  assert.equal(tripFlags.length, 3);
  assert.equal(dayFlags.length, 2);
});

test('captureTravelLog records sub-6h days as excluded (not deductible, not an error)', () => {
  const res = captureTravelLog({
    trips: [{ km: 40 }],
    travelDays: [{ date: '2026-05-01', hours: 4 }],
    year: 2026
  });
  assert.equal(res.complete, true); // a too-short day is a clean outcome, not a clarification
  assert.equal(res.excludedDays.length, 1);
  assert.equal(res.fullDays, 0);
  assert.equal(res.partialDays, 0);
  assert.equal(res.deductions.perDiem.deduction, 0);
});

test('captureTravelLog tolerates missing/empty inputs', () => {
  const res = captureTravelLog();
  assert.equal(res.complete, true);
  assert.equal(res.trips.length, 0);
  assert.equal(res.fullDays, 0);
  assert.equal(res.deductions.total, 0);
});

// FI-11 rate confirmation (2026-07-09): the cents below were checked against the
// primary Verohallinto decision (vero.fi decision register 47405). These pins make a
// future SILENT edit of a statutory rate trip CI — a rate is law, not a free-edit
// constant. Update a pin only in the SAME change that updates the rate against a new
// primary decision.
test('confirmed statutory rates match the primary Verohallinto päätös (47405)', () => {
  assert.deepEqual(
    { km: TRAVEL_RATES_BY_YEAR[2026].km, full: TRAVEL_RATES_BY_YEAR[2026].perDiemFull, partial: TRAVEL_RATES_BY_YEAR[2026].perDiemPartial },
    { km: 0.55, full: 54, partial: 25 }
  );
  assert.deepEqual(
    { km: TRAVEL_RATES_BY_YEAR[2025].km, full: TRAVEL_RATES_BY_YEAR[2025].perDiemFull, partial: TRAVEL_RATES_BY_YEAR[2025].perDiemPartial },
    { km: 0.59, full: 53, partial: 24 }
  );
  assert.equal(TRAVEL_RATES_BY_YEAR[2024].km, 0.57);
});

test('the launch-critical 2026 row (and 2025) are flagged confirmed against the primary source', () => {
  assert.equal(TRAVEL_RATES_BY_YEAR[2026].confirmedAgainstPrimary, true);
  assert.equal(TRAVEL_RATES_BY_YEAR[2025].confirmedAgainstPrimary, true);
  // 2024's per diems were not re-quoted from the primary decision this pass — the
  // flag is honestly false, not a silent "confirmed".
  assert.equal(TRAVEL_RATES_BY_YEAR[2024].confirmedAgainstPrimary, false);
  // Every confirmed row cites decision register 47405 in its provenance string.
  for (const y of [2025, 2026]) {
    assert.match(TRAVEL_RATES_BY_YEAR[y].source, /47405/);
  }
});
