// FI-13 13.3A PR2 — the six Oy balance-sheet watches (D-FI13-19 + D-FI13-18).
// node --test server/donna/finland/oyBalanceSheetWatches.test.js

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  FINLAND_OY_BALANCE_SHEET_WATCHES_FLAG_KEY,
  OY_WATCH_SEVERITIES,
  OY_WATCH_ASSIGNEES,
  OY_BALANCE_SHEET_WATCH_IDS,
  RELATED_PARTY_AGEING_DAYS,
  STATUTORY_LIABILITY_LAG_DAYS,
  evaluateOyBalanceSheetWatches
} from './oyBalanceSheetWatches.js';
import {
  getFinlandOyBalanceSheetWatchesFromDb
} from '../statutoryRegistry.js';

const AT = '2026-07-12';

test('pins: flag key, severity + assignee vocabularies, the closed watch id list', () => {
  assert.equal(FINLAND_OY_BALANCE_SHEET_WATCHES_FLAG_KEY, 'FINLAND_OY_BALANCE_SHEET_WATCHES');
  assert.deepEqual([...OY_WATCH_SEVERITIES], ['informational', 'review_required', 'legal_duty']);
  assert.deepEqual([...OY_WATCH_ASSIGNEES], ['firm', 'accountant', 'reviewer', 'counsel']);
  assert.deepEqual([...OY_BALANCE_SHEET_WATCH_IDS], [
    'negative_equity', 'distributable_equity_depleted', 'overdue_statutory_liability',
    'related_party_receivable_ageing', 'unsupported_shareholder_debit', 'registry_books_period_mismatch'
  ]);
});

test('a healthy balance sheet fires nothing; the evaluator never throws on garbage', () => {
  const clear = evaluateOyBalanceSheetWatches({ signals: { equityTotal: 50000, distributableEquity: 30000 }, asOf: AT });
  assert.equal(clear.verdict, 'clear');
  assert.deepEqual(clear.watches, []);
  assert.equal(clear.confirmedAgainstPrimary, false);
  assert.doesNotThrow(() => evaluateOyBalanceSheetWatches());
  assert.doesNotThrow(() => evaluateOyBalanceSheetWatches({ signals: { equityTotal: 'NaN' } }));
});

test('negative equity fires the legal_duty watch on the firm with the OYL register-notification copy', () => {
  const out = evaluateOyBalanceSheetWatches({ signals: { equityTotal: -12000, capitalLoansTotal: 5000 }, asOf: AT });
  assert.equal(out.verdict, 'legal_duty');
  const w = out.watches.find((x) => x.id === 'negative_equity');
  assert.equal(w.severity, 'legal_duty');
  assert.equal(w.assigned_to, 'firm');
  assert.ok(w.note_fi.includes('rekisteri-ilmoitus'));
  assert.ok(w.note_en.includes('register notification'));
  assert.deepEqual(w.evidence, { equity_total: -12000, capital_loans_total: 5000, equity_plus_capital_loans: -7000 });
  // Positive equity does not fire it.
  assert.equal(evaluateOyBalanceSheetWatches({ signals: { equityTotal: 1 }, asOf: AT }).watches.some((x) => x.id === 'negative_equity'), false);
});

test('distributable equity depleted fires when free equity is zero or below', () => {
  const zero = evaluateOyBalanceSheetWatches({ signals: { distributableEquity: 0 }, asOf: AT });
  assert.ok(zero.watches.some((x) => x.id === 'distributable_equity_depleted'));
  const neg = evaluateOyBalanceSheetWatches({ signals: { distributableEquity: -500 }, asOf: AT });
  const w = neg.watches.find((x) => x.id === 'distributable_equity_depleted');
  assert.equal(w.assigned_to, 'accountant');
  assert.equal(w.evidence.distributable_equity, -500);
  // Positive distributable equity is quiet.
  assert.equal(evaluateOyBalanceSheetWatches({ signals: { distributableEquity: 10 }, asOf: AT }).watches.length, 0);
});

test('overdue statutory liabilities fire only past the per-kind lag, and only for a positive unpaid balance', () => {
  // VAT lag is 42 days; 100 days old → overdue. Employer lag is 12 days; 5 days old → not.
  const out = evaluateOyBalanceSheetWatches({
    signals: {
      statutoryLiabilities: [
        { kind: 'vat', balance: 2000, oldest_unpaid_date: '2026-04-01' },       // ~102 days → overdue
        { kind: 'employer_contribution', balance: 900, oldest_unpaid_date: '2026-07-08' }, // ~4 days → not
        { kind: 'corporate_tax', balance: 0, oldest_unpaid_date: '2026-01-01' } // zero balance → not
      ]
    },
    asOf: AT
  });
  const w = out.watches.find((x) => x.id === 'overdue_statutory_liability');
  assert.equal(w.evidence.overdue.length, 1);
  assert.equal(w.evidence.overdue[0].kind, 'vat');
  assert.equal(w.evidence.overdue[0].lag_days, STATUTORY_LIABILITY_LAG_DAYS.vat);
  assert.ok(w.evidence.overdue[0].age_days > 42);
});

test('related-party receivable ageing fires past the horizon, not before', () => {
  const old = evaluateOyBalanceSheetWatches({ signals: { relatedPartyReceivable: { balance: 8000, oldest_open_date: '2025-12-01' } }, asOf: AT });
  const w = old.watches.find((x) => x.id === 'related_party_receivable_ageing');
  assert.ok(w.evidence.age_days > RELATED_PARTY_AGEING_DAYS);
  assert.equal(w.evidence.threshold_days, RELATED_PARTY_AGEING_DAYS);
  const fresh = evaluateOyBalanceSheetWatches({ signals: { relatedPartyReceivable: { balance: 8000, oldest_open_date: '2026-06-01' } }, asOf: AT });
  assert.equal(fresh.watches.some((x) => x.id === 'related_party_receivable_ageing'), false);
});

test('the osakaslaina watch presents both clocks and draws no tax conclusion', () => {
  const out = evaluateOyBalanceSheetWatches({
    signals: { shareholderDebit: { companyPeriod: { balance: 15000, period_end: '2026-06-30' }, calendarYtd: { balance: 15000, year_end: '2025-12-31' } } },
    asOf: AT
  });
  const w = out.watches.find((x) => x.id === 'unsupported_shareholder_debit');
  assert.equal(w.assigned_to, 'reviewer');
  assert.equal(w.evidence.company_fiscal_period.balance, 15000);
  assert.equal(w.evidence.recipient_calendar_year_31dec.balance, 15000);
  assert.ok(w.note_fi.includes('verotuksellista johtopäätöstä'));
  assert.ok(w.note_en.toLowerCase().includes('no tax conclusion'));
  // A credit balance (shareholder lent TO the company) is not this watch.
  assert.equal(
    evaluateOyBalanceSheetWatches({ signals: { shareholderDebit: { companyPeriod: { balance: -15000 } } }, asOf: AT }).watches.length,
    0
  );
});

test('registry-vs-books period mismatch fires only on an actual difference', () => {
  const mismatch = evaluateOyBalanceSheetWatches({
    signals: { registryPeriod: { start: '2026-01-01', end: '2026-12-31' }, booksPeriod: { start: '2026-01-01', end: '2027-06-30' } },
    asOf: AT
  });
  assert.ok(mismatch.watches.some((x) => x.id === 'registry_books_period_mismatch'));
  const aligned = evaluateOyBalanceSheetWatches({
    signals: { registryPeriod: { start: '2026-01-01', end: '2026-12-31' }, booksPeriod: { start: '2026-01-01', end: '2026-12-31' } },
    asOf: AT
  });
  assert.equal(aligned.watches.length, 0);
});

test('the overall verdict is the MAX severity fired across watches', () => {
  const out = evaluateOyBalanceSheetWatches({
    signals: { equityTotal: -1, distributableEquity: -1, relatedPartyReceivable: { balance: 1, oldest_open_date: '2020-01-01' } },
    asOf: AT
  });
  assert.equal(out.verdict, 'legal_duty'); // negative_equity outranks the review_required watches
  assert.ok(out.watches.length >= 3);
});

// ── The DB caller (entity-gated + flag-gated, reads balances by chart code) ───

const fakeClient = ({ entityType = 'fi-oy', flags = {}, balances = [], calendarNet = 0, registry = null, extent = {} } = {}) => ({
  async query(sql) {
    if (sql.includes('select id from clients')) return { rows: [{ id: 'client-1' }] };
    if (sql.includes('entity_type') && sql.includes('from clients')) return { rows: [{ entity_type: entityType, profile: null }] };
    if (sql.includes('from client_capability_config')) {
      return { rows: Object.entries(flags).map(([flag_key, stage]) => ({ flag_key, stage, source: 'test', client_id: 'client-1' })) };
    }
    if (sql.includes('from cohort_capability_config')) return { rows: [] };
    if (sql.includes('from fiscal_years')) return { rows: registry ? [registry] : [] };
    if (sql.includes('from ledger_journals')) return { rows: [{ min_date: extent.min || null, max_date: extent.max || null }] };
    if (sql.includes('from ledger_lines') && sql.includes('group by la.code')) return { rows: balances };
    if (sql.includes('from ledger_lines')) return { rows: [{ net: calendarNet }] }; // the calendar-clock query
    throw new Error(`Unexpected query: ${sql}`);
  }
});

const callWatches = (opts) => getFinlandOyBalanceSheetWatchesFromDb({
  firmId: 'firm-1', clientId: 'client-1', readAt: '2026-07-12T00:00:00.000Z',
  withFirmDbClientFn: async (fn) => fn(fakeClient(opts))
});

test('DB caller: a non-oy client is refused (409); a dark flag is a typed 403', async () => {
  await assert.rejects(
    callWatches({ entityType: 'fi-toiminimi', flags: { FINLAND_OY_BALANCE_SHEET_WATCHES: 'canary' } }),
    (e) => e.statusCode === 409 && e.code === 'FINLAND_OY_BALANCE_SHEET_ENTITY_NOT_OY'
  );
  await assert.rejects(
    callWatches({ entityType: 'fi-oy', flags: {} }),
    (e) => e.statusCode === 403 && e.code === 'FINLAND_OY_BALANCE_SHEET_WATCHES_DISABLED'
  );
});

test('DB caller: reads balances by chart code and fires the fired watches', async () => {
  const out = await callWatches({
    entityType: 'fi-oy',
    flags: { FINLAND_OY_BALANCE_SHEET_WATCHES: 'canary' },
    // 2000 share capital net +12000 (debit) ⇒ equity value −12000 (negative);
    // 1760 shareholder receivable net +15000 (debit) ⇒ osakaslaina + old.
    balances: [
      { code: '2000', net: '12000', min_date: '2026-01-01' },
      { code: '1760', net: '15000', min_date: '2025-01-01' }
    ],
    calendarNet: '15000',
    registry: { starts_on: '2026-01-01', ends_on: '2026-12-31' },
    extent: { min: '2026-01-01', max: '2026-06-30' } // contained → no period mismatch
  });
  const ids = out.watches.watches.map((w) => w.id).sort();
  assert.deepEqual(ids, [
    'distributable_equity_depleted', 'negative_equity', 'related_party_receivable_ageing', 'unsupported_shareholder_debit'
  ]);
  assert.equal(out.watches.verdict, 'legal_duty');
  const neg = out.watches.watches.find((w) => w.id === 'negative_equity');
  assert.equal(neg.evidence.equity_total, -12000);
  const osakas = out.watches.watches.find((w) => w.id === 'unsupported_shareholder_debit');
  assert.equal(osakas.evidence.company_fiscal_period.balance, 15000);
  assert.equal(osakas.evidence.recipient_calendar_year_31dec.balance, 15000);
  assert.equal(out.provenance.deterministic, true);
});

test('DB caller: a healthy Oy balance sheet is clear', async () => {
  const out = await callWatches({
    entityType: 'fi-oy',
    flags: { FINLAND_OY_BALANCE_SHEET_WATCHES: 'canary' },
    balances: [{ code: '2000', net: '-20000', min_date: '2026-01-01' }, { code: '2251', net: '-10000', min_date: '2026-01-01' }],
    registry: { starts_on: '2026-01-01', ends_on: '2026-12-31' },
    extent: { min: '2026-02-01', max: '2026-06-30' }
  });
  assert.equal(out.watches.verdict, 'clear');
  assert.deepEqual(out.watches.watches, []);
});
