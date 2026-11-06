// TZ-safe day/month keys for snapshot DATE-column values (two-surface IA
// stage C — docs/design-donna-two-surface-ia.md §7, the January-in-December
// sighting from Kari's 2026-08-26 canary walkthrough).
//
// Postgres `date` columns are parsed by node-postgres into LOCAL-midnight JS
// Dates; the snapshot JSON then serializes them as ISO UTC instants. On a
// non-UTC appliance a January `period_start` therefore arrives as
// "2024-12-31T23:00:00.000Z" — and every `slice(0, 10)` / `^\d{4}-\d{2}`
// consumer groups it under December. The server now normalizes date columns
// at the snapshot source, but stale snapshots and older payloads still carry
// the shifted shape, so every FE month-key/day consumer routes through here.
//
// Contract: a plain `YYYY-MM-DD` string is trusted verbatim (the post-fix
// server shape). Anything carrying a time component is treated as a
// serialized date column and rounded to the NEAREST UTC midnight — correct
// for any serialization offset within ±12h, which covers every deployed
// host. Do not feed real event timestamps through this expecting wall-clock
// day-of semantics; it answers "which calendar day did this date column
// mean", not "when did this happen".

const DAY_MS = 86400000;
const PLAIN_DAY_RE = /^(\d{4}-\d{2}-\d{2})$/;

// 'YYYY-MM-DD' for a date-column value; '' when missing or unparseable.
export const snapshotDayString = (value) => {
  if (value == null || value === '') return '';
  const text = value instanceof Date ? value.toISOString() : String(value).trim();
  const plain = PLAIN_DAY_RE.exec(text);
  if (plain) return plain[1];
  const ts = Date.parse(text);
  if (!Number.isFinite(ts)) return '';
  return new Date(Math.round(ts / DAY_MS) * DAY_MS).toISOString().slice(0, 10);
};

// 'YYYY-MM' month key for a date-column value; null when unresolvable.
export const snapshotMonthKey = (value) => {
  const day = snapshotDayString(value);
  return day ? day.slice(0, 7) : null;
};

// Human month heading for a 'YYYY-MM' key — "January 2025".
export const monthKeyLabel = (monthKey) => {
  const m = /^(\d{4})-(\d{2})$/.exec(String(monthKey || ''));
  if (!m) return String(monthKey || '');
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, 1))
    .toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
};

// Human range for two day strings — "Jan 1 – Jan 31, 2025" (year once when
// shared, twice when the range crosses it). Falls back to the raw values so
// a malformed period still shows SOMETHING rather than an empty header.
export const dayRangeLabel = (startValue, endValue) => {
  const start = snapshotDayString(startValue);
  const end = snapshotDayString(endValue);
  if (!start || !end) return [startValue, endValue].filter(Boolean).join(' → ');
  const sameYear = start.slice(0, 4) === end.slice(0, 4);
  const fmt = (day, withYear) =>
    new Date(`${day}T00:00:00Z`).toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      ...(withYear ? { year: 'numeric' } : {}),
      timeZone: 'UTC'
    });
  return sameYear
    ? `${fmt(start, false)} – ${fmt(end, true)}`
    : `${fmt(start, true)} – ${fmt(end, true)}`;
};
