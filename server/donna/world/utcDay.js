// The world's own calendar-day formatter.
//
// world/* may not import Donna's dates.js (worldBoundary.test.js: the
// oracle stays independent of the solver), and dateTruncationLint.js bans
// `toISOString().slice(0, 10)` everywhere under server/donna — so the
// world modules that turn an instant back into a bare YYYY-MM-DD share
// this one formatter instead of six private copies of the banned idiom.
//
// UTC on purpose, and UTC getters rather than toISOString: every world
// date is a bare calendar day anchored at T00:00:00Z, and the day it
// names must not move with the host zone (the oracle runs on the same
// appliance as the solver, at UTC+4). The round-trip validators
// (`utcIsoDay(new Date(`${value}T00:00:00Z`)) === value`) lean on the
// same anchor: an impossible day such as 2026-02-30 rolls to March 2 and
// fails the comparison, so it never passes as a real day.

const pad2 = (n) => String(n).padStart(2, '0');

export function utcIsoDay(date) {
  return `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}-${pad2(date.getUTCDate())}`;
}
