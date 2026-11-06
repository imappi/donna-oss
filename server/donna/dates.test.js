// pg-Date regression suite. node-postgres returns date columns as JS
// Date objects (no setTypeParser override in this codebase); tests and
// JSONB payloads carry ISO strings. The #299 bug class — every LLM
// matcher call running windowless in production — survived because
// each module hand-rolled its own normalizer and every test fed
// strings, the shape pg never returns. These tests feed both shapes.

import assert from 'node:assert/strict';
import test from 'node:test';

import { toIsoDay, toUtcDayMs } from './dates.js';

test('toIsoDay: pg-style Date object → YYYY-MM-DD', () => {
  // The TRUE pg shape: node-postgres parses a `date` column to LOCAL
  // midnight — new Date(y, m, d) — whatever the host offset. (A UTC-midnight
  // Date is NOT that shape: on a negative-offset host it is still the
  // previous local day, and toIsoDay reads it as such — which is why the
  // fixture used to fail under TZ=America/New_York. RT-15b.)
  assert.equal(toIsoDay(new Date(2026, 4, 15)), '2026-05-15');
  assert.equal(toIsoDay(new Date(2026, 4, 15, 12, 30)), '2026-05-15');
});

test('toIsoDay: pg local-midnight Date keeps its calendar day on a non-UTC host', () => {
  // The appliance shape (2026-08-26 stage-C canary): under a positive
  // offset, local midnight Jan 1 is Dec 31 23:00Z — toISOString()-based
  // truncation read the PREVIOUS day, filing January under December.
  const priorTz = process.env.TZ;
  try {
    process.env.TZ = 'Europe/Berlin';
    const janFirst = new Date(2025, 0, 1);
    assert.equal(janFirst.toISOString(), '2024-12-31T23:00:00.000Z');
    assert.equal(toIsoDay(janFirst), '2025-01-01');
    process.env.TZ = 'America/New_York';
    assert.equal(toIsoDay(new Date(2025, 0, 1)), '2025-01-01');
  } finally {
    if (priorTz === undefined) delete process.env.TZ;
    else process.env.TZ = priorTz;
  }
});

test('toIsoDay: ISO date string passes through', () => {
  assert.equal(toIsoDay('2026-05-15'), '2026-05-15');
});

test('toIsoDay: ISO datetime string truncates to the day', () => {
  assert.equal(toIsoDay('2026-05-15T13:45:00Z'), '2026-05-15');
});

test('toIsoDay: null/undefined → empty string', () => {
  assert.equal(toIsoDay(null), '');
  assert.equal(toIsoDay(undefined), '');
});

test('toIsoDay: invalid Date → empty string', () => {
  assert.equal(toIsoDay(new Date('garbage')), '');
});

test('toUtcDayMs: Date object and ISO string land on the same UTC midnight', () => {
  // The pg local-midnight shape and the JSONB ISO string name the same day
  // on ANY host zone (a UTC-midnight Date would not, west of Greenwich).
  assert.equal(toUtcDayMs(new Date(2026, 4, 15)), toUtcDayMs('2026-05-15'));
  assert.equal(toUtcDayMs('2026-05-15'), Date.UTC(2026, 4, 15));
});

test('toUtcDayMs: missing or unparseable input → NaN, never a silent epoch', () => {
  assert.ok(Number.isNaN(toUtcDayMs(null)));
  assert.ok(Number.isNaN(toUtcDayMs('')));
  assert.ok(Number.isNaN(toUtcDayMs(new Date('garbage'))));
});

// The mangled shape itself: a Date stringified upstream of the helper
// ("Wed Nov 15 2023 …".slice(0, 10) → "Wed Nov 15") is not
// recoverable, by design — dates must arrive as Date objects or ISO
// strings. Pinned so any future "helpful" parse of this shape is a
// deliberate decision, not drift.
test('toUtcDayMs: pre-stringified Date stays NaN (the #299 mangle)', () => {
  assert.ok(Number.isNaN(toUtcDayMs(String(new Date('2026-05-15T00:00:00Z')))));
});

// ─── RT-07: the helpers the RT-15 truncation sweep replaces sites with ──
//
// The ~99 hand-rolled `toISOString().slice(0, 10)` sites fall into two
// intents that the one-liner conflated: "the calendar day this instant
// falls on HERE" (today stamps, uploaded_at → day) and "the UTC calendar
// day of an instant built in Date.UTC space" (statutory deadline
// arithmetic). The sweep needs a named helper for each, plus a whole-day
// comparator, so a site's intent is visible at the call and the lint can
// ban the ambiguous one-liner outright.

import { toLocalIsoDay, toUtcIsoDay, utcDayDiff } from './dates.js';

const withTz = (tz, fn) => {
  const priorTz = process.env.TZ;
  try {
    process.env.TZ = tz;
    return fn();
  } finally {
    if (priorTz === undefined) delete process.env.TZ;
    else process.env.TZ = priorTz;
  }
};

test('toLocalIsoDay: an instant lands on the HOST-local calendar day', () => {
  // 23:30Z on Jan 1 is already Jan 2 in Dubai (+04) and still Jan 1 in
  // New York (-05). The appliance runs in the owner's zone, so "today"
  // stamps must follow the wall clock, not UTC — the F-11 day shift.
  const instant = new Date('2026-01-01T23:30:00Z');
  assert.equal(withTz('Asia/Dubai', () => toLocalIsoDay(instant)), '2026-01-02');
  assert.equal(withTz('America/New_York', () => toLocalIsoDay(instant)), '2026-01-01');
  assert.equal(withTz('UTC', () => toLocalIsoDay(instant)), '2026-01-01');
});

test('toLocalIsoDay: accepts the non-Date instant shapes toIsoDay cannot', () => {
  // toIsoDay(number) would slice the digits of the epoch ms — the
  // "1700000000" bug shape. Epoch ms and ISO timestamp strings are
  // instants and resolve like a Date would.
  const ms = Date.UTC(2026, 0, 1, 23, 30);
  assert.equal(withTz('Asia/Dubai', () => toLocalIsoDay(ms)), '2026-01-02');
  assert.equal(withTz('Asia/Dubai', () => toLocalIsoDay('2026-01-01T23:30:00Z')), '2026-01-02');
  assert.equal(withTz('Asia/Dubai', () => toLocalIsoDay('2026-01-01T23:30:00.000+04:00')), '2026-01-01');
  // A pg `timestamp` rendered as text (space separator, no zone) is a
  // local wall-clock reading and stays on its own day.
  assert.equal(withTz('Asia/Dubai', () => toLocalIsoDay('2026-01-01 23:30:00')), '2026-01-01');
});

test('toLocalIsoDay / toUtcIsoDay: a calendar day is not an instant — it passes through', () => {
  // 'YYYY-MM-DD' names a day, not a moment; projecting it through a
  // zone would shift it (new Date('2026-01-01') is UTC midnight, which
  // is Dec 31 in New York). Both helpers keep it as the day it names.
  assert.equal(withTz('America/New_York', () => toLocalIsoDay('2026-01-01')), '2026-01-01');
  assert.equal(withTz('Asia/Dubai', () => toUtcIsoDay('2026-01-01')), '2026-01-01');
  assert.equal(toLocalIsoDay(' 2026-01-01 '), '2026-01-01');
});

test('toLocalIsoDay / toUtcIsoDay: an impossible calendar day is refused, not rolled', () => {
  // V8 rolls 2026-02-30 forward to March 2; a validator that leans on
  // these helpers must see '' (refused), never a silently different day.
  assert.equal(toLocalIsoDay('2026-02-30'), '');
  assert.equal(toUtcIsoDay('2026-02-30'), '');
  assert.equal(toUtcIsoDay('2026-13-01'), '');
  assert.equal(toUtcIsoDay('2024-02-29'), '2024-02-29');
});

test('toUtcIsoDay: the explicit UTC day of an instant, whatever the host zone', () => {
  // Statutory deadline arithmetic is built in Date.UTC space (month-end
  // + 7 days, etc.); its day must NOT move with the host zone. This is
  // the deliberate replacement for `toISOString().slice(0, 10)` at the
  // sites that meant UTC — named so the intent is visible at the call.
  const monthEnd = new Date(Date.UTC(2026, 1, 0));
  assert.equal(withTz('Asia/Dubai', () => toUtcIsoDay(monthEnd)), '2026-01-31');
  assert.equal(withTz('America/New_York', () => toUtcIsoDay(monthEnd)), '2026-01-31');
  assert.equal(withTz('Asia/Dubai', () => toUtcIsoDay(Date.UTC(2026, 0, 1, 23, 30))), '2026-01-01');
  assert.equal(withTz('Asia/Dubai', () => toUtcIsoDay('2026-01-01T23:30:00+04:00')), '2026-01-01');
});

test('toLocalIsoDay / toUtcIsoDay: missing, invalid, or non-ISO input → empty string', () => {
  for (const helper of [toLocalIsoDay, toUtcIsoDay]) {
    assert.equal(helper(null), '');
    assert.equal(helper(undefined), '');
    assert.equal(helper(''), '');
    assert.equal(helper(NaN), '');
    assert.equal(helper(new Date('garbage')), '');
    assert.equal(helper('yesterday'), '');
    assert.equal(helper({}), '');
    // The #299 mangle (a Date stringified upstream) stays unrecoverable
    // here too — dates arrive as Date objects, epoch ms, or ISO strings.
    assert.equal(helper(String(new Date('2026-05-15T00:00:00Z'))), '');
  }
});

test('utcDayDiff: whole calendar days between two day-bearing values', () => {
  assert.equal(utcDayDiff('2026-01-10', '2026-01-01'), 9);
  assert.equal(utcDayDiff('2026-01-01', '2026-01-10'), -9);
  assert.equal(utcDayDiff('2026-03-01', '2026-02-28'), 1);
  // Mixed shapes — a pg local-midnight Date against a JSONB ISO string —
  // compare on the calendar day, on any host zone (the toUtcDayMs rule).
  assert.equal(withTz('Asia/Dubai', () => utcDayDiff(new Date(2026, 0, 10), '2026-01-01')), 9);
  assert.equal(withTz('America/New_York', () => utcDayDiff(new Date(2026, 0, 1), '2026-01-01')), 0);
  // A time-of-day component does not turn a same-day pair into a
  // different-day pair.
  assert.equal(utcDayDiff('2026-01-01T23:59:00Z', '2026-01-01T00:01:00Z'), 0);
});

test('utcDayDiff: missing or unparseable on either side → NaN, never a silent 0', () => {
  assert.ok(Number.isNaN(utcDayDiff(null, '2026-01-01')));
  assert.ok(Number.isNaN(utcDayDiff('2026-01-01', undefined)));
  assert.ok(Number.isNaN(utcDayDiff('', '')));
  assert.ok(Number.isNaN(utcDayDiff(new Date('garbage'), '2026-01-01')));
});
