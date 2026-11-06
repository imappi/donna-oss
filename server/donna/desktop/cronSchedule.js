// Minimal 5-field cron matcher for the desktop local scheduler (plan §4).
//
// Scope is deliberate: exactly the syntax the tree's schedules use —
// numbers, `*`, `*/n`, ranges (`a-b`, `a-b/n`) and lists (`a,b,c`) on the
// standard minute/hour/day-of-month/month/day-of-week fields — evaluated in
// UTC, matching how Inngest Cloud and Vercel run the same expressions today.
// No seconds field, no names (`MON`), no `L/W/#` extensions; an expression
// outside that grammar throws at parse time rather than misfiring silently.
//
// Standard cron day semantics: when BOTH day-of-month and day-of-week are
// restricted, a timestamp matches if EITHER does (none of our schedules do
// this, but misencoding the classic rule is how a scheduler surprises you).

const FIELD_RANGES = [
  { name: 'minute', min: 0, max: 59 },
  { name: 'hour', min: 0, max: 23 },
  { name: 'dayOfMonth', min: 1, max: 31 },
  { name: 'month', min: 1, max: 12 },
  { name: 'dayOfWeek', min: 0, max: 7 } // 7 normalized to 0 (Sunday)
];

const parseField = (raw, { name, min, max }) => {
  const values = new Set();
  let wildcard = true;
  for (const part of String(raw).split(',')) {
    let body = part;
    let stepText = null;
    if (part.includes('/')) {
      const pieces = part.split('/');
      if (pieces.length !== 2) throw new Error(`Invalid cron ${name} field: ${raw}`);
      [body, stepText] = pieces;
    }
    const step = stepText === null ? 1 : Number(stepText);
    if (!Number.isInteger(step) || step < 1) throw new Error(`Invalid cron ${name} step: ${raw}`);

    let start;
    let end;
    if (body === '*') {
      start = min;
      end = max;
    } else if (body.includes('-')) {
      const [a, b] = body.split('-').map(Number);
      start = a;
      end = b;
    } else {
      start = Number(body);
      end = stepText === null ? start : max;
    }
    if (!Number.isInteger(start) || !Number.isInteger(end) || start > end) {
      throw new Error(`Invalid cron ${name} field: ${raw}`);
    }
    const normalize = (v) => (name === 'dayOfWeek' && v === 7 ? 0 : v);
    if (start < min || end > max) throw new Error(`Cron ${name} out of range: ${raw}`);
    if (body !== '*' || step !== 1) wildcard = false;
    for (let v = start; v <= end; v += step) values.add(normalize(v));
  }
  return { values, wildcard };
};

export const parseCronExpression = (expression) => {
  const fields = String(expression || '').trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new Error(`Cron expression must have 5 fields: "${expression}"`);
  }
  const [minute, hour, dayOfMonth, month, dayOfWeek] = fields.map((raw, i) =>
    parseField(raw, FIELD_RANGES[i])
  );
  return { minute, hour, dayOfMonth, month, dayOfWeek };
};

export const cronMatches = (parsed, date) => {
  const p = typeof parsed === 'string' ? parseCronExpression(parsed) : parsed;
  if (!p.minute.values.has(date.getUTCMinutes())) return false;
  if (!p.hour.values.has(date.getUTCHours())) return false;
  if (!p.month.values.has(date.getUTCMonth() + 1)) return false;
  const domMatch = p.dayOfMonth.values.has(date.getUTCDate());
  const dowMatch = p.dayOfWeek.values.has(date.getUTCDay());
  if (!p.dayOfMonth.wildcard && !p.dayOfWeek.wildcard) return domMatch || dowMatch;
  return domMatch && dowMatch;
};

const MINUTE_MS = 60_000;
// A valid 5-field cron fires at least yearly; 366 days bounds the scan.
const MAX_SCAN_MINUTES = 366 * 24 * 60;

const floorToMinute = (date) => new Date(Math.floor(date.getTime() / MINUTE_MS) * MINUTE_MS);

// The next matching minute STRICTLY AFTER `from`.
export const nextCronOccurrence = (expression, from) => {
  const p = parseCronExpression(expression);
  let cursor = new Date(floorToMinute(from).getTime() + MINUTE_MS);
  for (let i = 0; i < MAX_SCAN_MINUTES; i += 1) {
    if (cronMatches(p, cursor)) return cursor;
    cursor = new Date(cursor.getTime() + MINUTE_MS);
  }
  throw new Error(`No occurrence of "${expression}" within a year`);
};

// The latest matching minute AT OR BEFORE `at` — the bounded-catch-up
// primitive: after a sleep, the dispatcher enqueues this single tick
// rather than replaying every missed one.
export const previousCronOccurrence = (expression, at) => {
  const p = parseCronExpression(expression);
  let cursor = floorToMinute(at);
  for (let i = 0; i < MAX_SCAN_MINUTES; i += 1) {
    if (cronMatches(p, cursor)) return cursor;
    cursor = new Date(cursor.getTime() - MINUTE_MS);
  }
  throw new Error(`No occurrence of "${expression}" within a year`);
};
