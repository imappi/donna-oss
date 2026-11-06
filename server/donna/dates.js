// Shared date normalization for row-fed code paths.
//
// Date columns arrive as JS Date objects from node-postgres (no
// setTypeParser override in this codebase) but as ISO strings from
// tests, JSONB payloads, and model output. `String(date).slice(0, 10)`
// mangles a Date object into "Wed Nov 15", which `new Date(
// `${day}T00:00:00Z`)` then parses to NaN. That exact bug nulled the
// candidate window on every LLM matcher call in production (#299) —
// and it survived because each module hand-rolled its own normalizer
// and every test fed ISO strings, the shape pg never returns. Both
// input shapes normalize here, once. Do not re-implement per module.

export const toIsoDay = (value) => {
  if (value == null) return '';
  if (value instanceof Date) {
    if (!Number.isFinite(value.getTime())) return '';
    // LOCAL getters, not toISOString(): pg parses a `date` column to LOCAL
    // midnight, so on a non-UTC host (the appliance) toISOString() lands on
    // the PREVIOUS day — the January-in-December shift caught on the
    // 2026-08-26 stage-C canary. Local getters read back exactly the
    // calendar day the column stores, on any host offset. (A UTC-midnight
    // Date passed in still resolves to the same day on every deployed
    // host — cloud runs UTC, the appliance runs positive offsets.)
    return [
      value.getFullYear(),
      String(value.getMonth() + 1).padStart(2, '0'),
      String(value.getDate()).padStart(2, '0')
    ].join('-');
  }
  return String(value).slice(0, 10);
};

// UTC-midnight epoch ms for the day `value` falls on; NaN when missing
// or unparseable. Date objects and ISO strings resolve to the same UTC
// midnight, so day-window math stays consistent when one side of a
// comparison comes from a DB row and the other from a JSONB payload.
export const toUtcDayMs = (value) => {
  const day = toIsoDay(value);
  if (!day) return NaN;
  return new Date(`${day}T00:00:00Z`).getTime();
};

// ─── RT-07: named day formatters for the RT-15 truncation sweep ────────
//
// `toISOString().slice(0, 10)` conflates two intents, and the lint
// (dateTruncationLint.js) bans the idiom outright, so each intent gets
// a helper whose name says which day it means:
//
//   toLocalIsoDay(instant)  the calendar day the instant falls on for
//                           the HOST's wall clock — "today" stamps,
//                           uploaded_at → day, anything an owner reads
//                           as "the day it happened here";
//   toUtcIsoDay(instant)    the calendar day of the instant in UTC —
//                           arithmetic built in Date.UTC space
//                           (statutory deadlines: month-end + N days),
//                           where the day must NOT move with the host.
//
// Both accept a Date, epoch milliseconds, or an ISO-8601 timestamp
// string, and return '' for anything else — including the #299 mangle
// (a Date stringified upstream), which stays unrecoverable on purpose.
// A bare 'YYYY-MM-DD' names a calendar day, not an instant: it passes
// through unchanged after a round-trip check (V8 rolls 2026-02-30 to
// March 2; a nonsense day is refused, never silently moved). pg `date`
// columns still go through `toIsoDay` above — that rule is unchanged.

const DAY_MS = 86_400_000;
const ISO_DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const ISO_INSTANT_RE = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/;

const pad2 = (n) => String(n).padStart(2, '0');

const utcDayOf = (date) =>
  `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}-${pad2(date.getUTCDate())}`;

// A bare calendar day, validated (round-trips through UTC midnight), or
// null when the string is not a bare day. '' means "a bare day that does
// not exist" so the caller can refuse it.
const bareDayOf = (value) => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!ISO_DAY_RE.test(trimmed)) return null;
  const roundTrip = new Date(`${trimmed}T00:00:00Z`);
  return Number.isFinite(roundTrip.getTime()) && utcDayOf(roundTrip) === trimmed ? trimmed : '';
};

// Date | epoch ms | ISO timestamp string → a valid Date, else null.
const instantOf = (value) => {
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value : null;
  if (typeof value === 'number') return Number.isFinite(value) ? new Date(value) : null;
  if (typeof value === 'string' && ISO_INSTANT_RE.test(value.trim())) {
    const parsed = new Date(value.trim());
    return Number.isFinite(parsed.getTime()) ? parsed : null;
  }
  return null;
};

export const toLocalIsoDay = (value) => {
  const bareDay = bareDayOf(value);
  if (bareDay !== null) return bareDay;
  const instant = instantOf(value);
  if (!instant) return '';
  return `${instant.getFullYear()}-${pad2(instant.getMonth() + 1)}-${pad2(instant.getDate())}`;
};

export const toUtcIsoDay = (value) => {
  const bareDay = bareDayOf(value);
  if (bareDay !== null) return bareDay;
  const instant = instantOf(value);
  return instant ? utcDayOf(instant) : '';
};

// Whole calendar days from `b` to `a` (positive when `a` is later), on
// the same UTC-midnight anchor as toUtcDayMs — so a pg local-midnight
// Date and a JSONB ISO string compare on the day they both name, on any
// host zone. NaN when either side is missing or unparseable: a missing
// date is never "the same day" as anything.
export const utcDayDiff = (a, b) => {
  const diff = toUtcDayMs(a) - toUtcDayMs(b);
  return Number.isNaN(diff) ? NaN : Math.round(diff / DAY_MS);
};
