// Node-safe derivation for the Actions close-event card (two-surface IA
// stage C, C2b — docs/design-donna-two-surface-ia.md §7). Card presence and
// collapsed status render the PERSISTED close verdict: the snapshot's
// close_periods rows, whose payload is written by every checks run and lock
// (closePeriodSummaryPayload in firmDb.js) — never a fresh FE inference. A
// LOCKED row never cards: lock IS the card's resolution, and the standing
// receipt is the Locked month badge in Material (C2a).
//
// One synthetic "unchecked" entry covers the latest activity month when no
// close_periods row exists for it — once the Close tab folds away (C2c) the
// run-checks moment must stay reachable, or a never-checked month would have
// no close surface at all (the §4 states-must-not-VANISH precondition).
//
// Keep this module free of JSX and browser dependencies: the console derives
// the card list AND the Actions badge delta from this one function, so the
// two cannot disagree (the counts-must-reconcile charge).

import { monthKeyLabel, snapshotDayString, snapshotMonthKey } from './snapshot-dates.js';

// close_periods.payload.close_status vocabulary (the computed close_preview
// verdict persisted at checks time) — NOT the row's own open/reviewing/
// closed/locked lifecycle column.
const PERSISTED_STATUSES = new Set(['ready', 'review', 'blocked']);

const pad2 = (n) => String(n).padStart(2, '0');

// closePeriods: the selected client's snapshot close_periods rows.
// transactions: the same client's snapshot transactions (for the synthetic
// latest-activity-month entry only). Returns newest-first entries:
//   { periodStart, periodEnd, monthKey, label, status, lockable, checkedAt,
//     counts, transactionCount, source: 'close_periods' | 'activity' }
export const deriveCloseActionPeriods = ({ closePeriods = [], transactions = [] } = {}) => {
  const rows = Array.isArray(closePeriods) ? closePeriods : [];
  const txs = Array.isArray(transactions) ? transactions : [];
  const entries = [];
  const coveredMonths = new Set();

  for (const row of rows) {
    // TZ-safe: a pg date column serialized on a non-UTC host arrives as a
    // shifted ISO instant (Jan 1 reads "…-12-31T23:00Z") — normalize before
    // any keying, sorting, or round-trip back into the close writers.
    const periodStart = snapshotDayString(row?.period_start) || null;
    const periodEnd = snapshotDayString(row?.period_end) || null;
    const monthKey = snapshotMonthKey(row?.period_start);
    if (monthKey) coveredMonths.add(monthKey);
    if (String(row?.status || '') === 'locked') continue;
    const payload = row?.payload && typeof row.payload === 'object' ? row.payload : {};
    entries.push({
      periodStart,
      periodEnd,
      monthKey,
      label: monthKeyLabel(monthKey),
      // A row with no persisted verdict payload still represents an engaged,
      // unfinished close — "review" is the honest default, never "ready".
      status: PERSISTED_STATUSES.has(payload.close_status) ? payload.close_status : 'review',
      lockable: payload.lockable === true,
      checkedAt: payload.generated_at || row?.updated_at || null,
      counts: payload.review_counts && typeof payload.review_counts === 'object'
        ? payload.review_counts
        : null,
      transactionCount: null,
      source: 'close_periods'
    });
  }

  // Latest activity month by TZ-safe month key ('YYYY-MM' compares lexically).
  let latestMonthKey = null;
  for (const tx of txs) {
    const key = snapshotMonthKey(tx?.date || tx?.created_at);
    if (key && (!latestMonthKey || key > latestMonthKey)) latestMonthKey = key;
  }
  if (latestMonthKey) {
    const monthKey = latestMonthKey;
    if (!coveredMonths.has(monthKey)) {
      const year = Number(monthKey.slice(0, 4));
      const month = Number(monthKey.slice(5, 7)) - 1;
      const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
      const periodStart = `${monthKey}-01`;
      const periodEnd = `${monthKey}-${pad2(lastDay)}`;
      const transactionCount = txs.reduce((count, tx) => {
        const key = snapshotMonthKey(tx?.date || tx?.created_at);
        return key === monthKey ? count + 1 : count;
      }, 0);
      entries.push({
        periodStart,
        periodEnd,
        monthKey,
        label: monthKeyLabel(monthKey),
        status: 'unchecked',
        lockable: false,
        checkedAt: null,
        counts: null,
        transactionCount,
        source: 'activity'
      });
    }
  }

  entries.sort((a, b) => String(b.periodStart || '').localeCompare(String(a.periodStart || '')));
  return entries;
};

// The Actions badge adds ONLY the owner-decidable close moments: a
// ready-to-lock period, whose lock is the owner's material decision.
// Blocked/review/unchecked cards render as decide-and-notify context —
// visible, never badge pressure (an FYI must not become a click queue).
export const closeActionForYouCount = (periods = []) =>
  (Array.isArray(periods) ? periods : []).filter((p) => p?.lockable === true).length;
