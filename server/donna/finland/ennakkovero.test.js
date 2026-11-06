// G-5 (FI-15) — ennakkovero forecast-and-warn: forecast math, profile
// normalizer, closed statuses/flags, payment detection, and the DB caller
// (injection idiom). The one invariant every test guards: bounded honesty —
// no code path ever computes a TAX amount (the forecast is profit-scale
// only), the 5 % yrittäjävähennys appears in forecasts only, and the copy
// never claims the tax is "handled".
//   node --test server/donna/finland/ennakkovero.test.js

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  FINLAND_ENNAKKOVERO_WATCH_FLAG_KEY,
  YRITTAJAVAHENNYS_RATE,
  ENNAKKOVERO_MIN_FORECAST_DAYS,
  ENNAKKOVERO_DIVERGENCE_RATIO,
  ENNAKKOVERO_DIVERGENCE_MIN_EUR,
  ENNAKKOVERO_MATERIAL_PROFIT_EUR,
  ENNAKKOVERO_STATUSES,
  ENNAKKOVERO_FLAGS,
  ENNAKKOVERO_HONESTY_NOTE_FI,
  hasEnnakkoveroPayments,
  forecastBusinessProfit,
  normalizeEnnakkoveroProfile,
  evaluateEnnakkoveroStatus
} from './ennakkovero.js';
import {
  getFinlandEnnakkoveroStatusFromDb
} from '../statutoryRegistry.js';

test('pins: flag key, the closed status/flag vocabularies, policy thresholds, the honesty boundary', () => {
  assert.equal(FINLAND_ENNAKKOVERO_WATCH_FLAG_KEY, 'FINLAND_ENNAKKOVERO_WATCH');
  assert.deepEqual([...ENNAKKOVERO_STATUSES], [
    'not_configured', 'payments_detected_unconfigured', 'forecast_material_unconfigured',
    'on_track', 'review_recommended', 'not_liable'
  ]);
  assert.deepEqual([...ENNAKKOVERO_FLAGS], [
    'decision_stale', 'forecast_above_basis', 'forecast_below_basis',
    'payment_gap', 'payments_while_not_liable', 'material_profit_while_not_liable'
  ]);
  assert.equal(YRITTAJAVAHENNYS_RATE, 0.05);
  assert.equal(ENNAKKOVERO_MIN_FORECAST_DAYS, 90);
  assert.equal(ENNAKKOVERO_DIVERGENCE_RATIO, 0.25);
  assert.equal(ENNAKKOVERO_DIVERGENCE_MIN_EUR, 3000);
  assert.equal(ENNAKKOVERO_MATERIAL_PROFIT_EUR, 8000);
  // The boundary is stated, and it never claims the tax is handled.
  assert.match(ENNAKKOVERO_HONESTY_NOTE_FI, /Donna ei laske veron määrää/);
  assert.match(ENNAKKOVERO_HONESTY_NOTE_FI, /OmaVero/);
  assert.doesNotMatch(ENNAKKOVERO_HONESTY_NOTE_FI, /hoidettu|handled/i);
});

test('forecast: linear calendar-year annualization, yrittäjävähennys in the FORECAST only', () => {
  // 2026-04-10 is day 100 of a 365-day year — clean numbers on purpose.
  const f = forecastBusinessProfit({ ytdRevenueEur: 30000, ytdExpensesEur: 20000, onDate: '2026-04-10' });
  assert.equal(f.year, 2026);
  assert.equal(f.days_elapsed, 100);
  assert.equal(f.days_in_year, 365);
  assert.equal(f.ytd_profit_eur, 10000);
  assert.equal(f.annualized_profit_eur, 36500);
  assert.equal(f.taxable_after_yrittajavahennys_eur, 34675, '5 % off the annualized profit — display only');
  assert.equal(f.confidence, 'ok');

  // Leap year: 2028-04-09 is day 100 of a 366-day year.
  const leap = forecastBusinessProfit({ ytdRevenueEur: 10000, ytdExpensesEur: 0, onDate: '2028-04-09' });
  assert.equal(leap.days_in_year, 366);
  assert.equal(leap.annualized_profit_eur, 36600);

  // Too early in the year → 'early'; a loss never yields a positive taxable figure.
  const early = forecastBusinessProfit({ ytdRevenueEur: 1000, ytdExpensesEur: 5000, onDate: '2026-02-14' });
  assert.equal(early.days_elapsed, 45);
  assert.equal(early.confidence, 'early');
  assert.equal(early.taxable_after_yrittajavahennys_eur, 0);

  assert.throws(() => forecastBusinessProfit({ ytdRevenueEur: 1 }), /onDate/);
});

test('normalizeEnnakkoveroProfile: stores what the owner transcribed, refuses garbage, null clears', () => {
  assert.deepEqual(
    normalizeEnnakkoveroProfile({ tax_year: 2026, assessed_income_eur: 24000.456, annual_amount_eur: 3600, decided_on: '2026-01-20', note: 'OmaVero-päätös' }),
    { tax_year: 2026, assessed_income_eur: 24000.46, annual_amount_eur: 3600, decided_on: '2026-01-20', note: 'OmaVero-päätös' }
  );
  assert.deepEqual(normalizeEnnakkoveroProfile({ not_liable: true, note: 'Vero: ei ennakoita 2026' }),
    { not_liable: true, note: 'Vero: ei ennakoita 2026' });
  assert.equal(normalizeEnnakkoveroProfile(null), null);
  assert.equal(normalizeEnnakkoveroProfile({}), null, 'an empty patch stores nothing');
  assert.throws(() => normalizeEnnakkoveroProfile({ tax_year: 26 }), /four-digit/);
  assert.throws(() => normalizeEnnakkoveroProfile({ assessed_income_eur: -5 }), /non-negative/);
  assert.throws(() => normalizeEnnakkoveroProfile({ annual_amount_eur: 'paljon' }), /non-negative/);
  assert.throws(() => normalizeEnnakkoveroProfile({ decided_on: 'tammikuu' }), /ISO date/);
  assert.throws(() => normalizeEnnakkoveroProfile('yes'), /object/);
});

test('payment detection is word-bounded — vero-prefixed ordinary words do not fire', () => {
  assert.equal(hasEnnakkoveroPayments(['VEROHALLINTO OMA-ALOITTEISET VEROT']), true);
  assert.equal(hasEnnakkoveroPayments(['ENNAKKOVERO ERÄ 7/2026']), true);
  assert.equal(hasEnnakkoveroPayments(['VERO SKATT viite 12345']), true);
  // 'veroton' (tax-free) and 'verkkokauppa' contain the stem but not the word.
  assert.equal(hasEnnakkoveroPayments(['Veroton myynti', 'verkkokauppa.com', 'K-Market']), false);
});

const okForecast = (over = {}) => forecastBusinessProfit({
  ytdRevenueEur: 30000, ytdExpensesEur: 20000, onDate: '2026-04-10', ...over
});

test('statuses: quiet when small/unconfigured, nudges when payments or material profit appear', () => {
  const quiet = evaluateEnnakkoveroStatus({
    profile: null,
    forecast: forecastBusinessProfit({ ytdRevenueEur: 3000, ytdExpensesEur: 2000, onDate: '2026-04-10' })
  });
  assert.equal(quiet.status, 'not_configured');
  assert.deepEqual(quiet.notes_fi, [], 'a small book gets NO nag');

  const detected = evaluateEnnakkoveroStatus({
    profile: null,
    forecast: okForecast(),
    paymentsDetected: true,
    lastPaymentOn: '2026-03-12'
  });
  assert.equal(detected.status, 'payments_detected_unconfigured');
  assert.match(detected.notes_fi.join(' '), /OmaVerosta/);

  const material = evaluateEnnakkoveroStatus({ profile: null, forecast: okForecast() });
  assert.equal(material.status, 'forecast_material_unconfigured');
  assert.match(material.notes_fi.join(' '), /36 500/);
  assert.match(material.notes_fi.join(' '), /Donna ei laske veron määrää/);

  // Too early in the year → the materiality nudge never fires.
  const early = evaluateEnnakkoveroStatus({
    profile: null,
    forecast: forecastBusinessProfit({ ytdRevenueEur: 30000, ytdExpensesEur: 0, onDate: '2026-02-14' })
  });
  assert.equal(early.status, 'not_configured');
  assert.deepEqual(early.notes_fi, []);

  assert.throws(() => evaluateEnnakkoveroStatus({ profile: null }), /forecast/);
});

test('divergence: forecast vs the decision basis — warn both directions, honesty note rides every warning', () => {
  const decision = { tax_year: 2026, assessed_income_eur: 20000, annual_amount_eur: 3200 };
  const above = evaluateEnnakkoveroStatus({ profile: decision, forecast: okForecast(), paymentsDetected: true });
  assert.equal(above.status, 'review_recommended');
  assert.deepEqual(above.flags, ['forecast_above_basis']);
  assert.match(above.notes_fi.join(' '), /korottaminen/);
  assert.match(above.notes_fi.join(' '), /Donna ei laske veron määrää/);

  const below = evaluateEnnakkoveroStatus({
    profile: { tax_year: 2026, assessed_income_eur: 60000, annual_amount_eur: 9000 },
    forecast: okForecast(),
    paymentsDetected: true
  });
  assert.equal(below.status, 'review_recommended');
  assert.deepEqual(below.flags, ['forecast_below_basis']);
  assert.match(below.notes_fi.join(' '), /alentaa/);

  const onTrack = evaluateEnnakkoveroStatus({
    profile: { tax_year: 2026, assessed_income_eur: 36000, annual_amount_eur: 3200 },
    forecast: okForecast(),
    paymentsDetected: true
  });
  assert.equal(onTrack.status, 'on_track');
  assert.deepEqual(onTrack.flags, []);
  assert.deepEqual(onTrack.notes_fi, [], 'a healthy book gets NO nudge');

  // Early confidence ⇒ no divergence verdict even against a tiny basis.
  const earlyDecision = evaluateEnnakkoveroStatus({
    profile: decision,
    forecast: forecastBusinessProfit({ ytdRevenueEur: 30000, ytdExpensesEur: 0, onDate: '2026-02-14' }),
    paymentsDetected: true
  });
  assert.equal(earlyDecision.status, 'on_track');
  assert.deepEqual(earlyDecision.flags, []);
});

test('flags: stale decision year, payment gap (innocent explanation first), not_liable surprises', () => {
  const stale = evaluateEnnakkoveroStatus({
    profile: { tax_year: 2025, assessed_income_eur: 36000, annual_amount_eur: 3200 },
    forecast: okForecast(),
    paymentsDetected: true
  });
  assert.equal(stale.status, 'review_recommended');
  assert.ok(stale.flags.includes('decision_stale'));
  assert.match(stale.notes_fi.join(' '), /vuotta 2025/);

  const gap = evaluateEnnakkoveroStatus({
    profile: { tax_year: 2026, assessed_income_eur: 36000, annual_amount_eur: 3200 },
    forecast: okForecast(),
    paymentsDetected: false
  });
  assert.deepEqual(gap.flags, ['payment_gap']);
  assert.equal(gap.status, 'on_track', 'a payment gap alone never downgrades the status');
  assert.match(gap.notes_fi.join(' '), /henkilökohtaiselta tililtä/, 'the gap note offers the innocent explanation first');

  const notLiable = evaluateEnnakkoveroStatus({
    profile: { not_liable: true },
    forecast: forecastBusinessProfit({ ytdRevenueEur: 3000, ytdExpensesEur: 2000, onDate: '2026-04-10' })
  });
  assert.equal(notLiable.status, 'not_liable');
  assert.deepEqual(notLiable.flags, []);
  assert.deepEqual(notLiable.notes_fi, []);

  const surprising = evaluateEnnakkoveroStatus({
    profile: { not_liable: true },
    forecast: okForecast(),
    paymentsDetected: true,
    lastPaymentOn: '2026-03-12'
  });
  assert.equal(surprising.status, 'not_liable');
  assert.deepEqual(surprising.flags, ['payments_while_not_liable', 'material_profit_while_not_liable']);
});

test('bounded honesty: NO output ever carries a computed tax amount or a "handled" claim', () => {
  const envelopes = [
    evaluateEnnakkoveroStatus({ profile: null, forecast: okForecast() }),
    evaluateEnnakkoveroStatus({
      profile: { tax_year: 2026, assessed_income_eur: 20000, annual_amount_eur: 3200 },
      forecast: okForecast()
    }),
    evaluateEnnakkoveroStatus({ profile: { not_liable: true }, forecast: okForecast(), paymentsDetected: true })
  ];
  for (const env of envelopes) {
    const raw = JSON.stringify(env);
    assert.doesNotMatch(raw, /hoidettu|handled/i, 'the copy never claims the tax is handled');
    assert.doesNotMatch(raw, /tax_due|tax_amount|estimated_tax/i, 'no tax-amount field, ever');
    // The only euro figures: the profit-scale forecast + the OWNER's own
    // recorded decision values.
    const numericKeys = Object.keys(env.forecast).filter((k) => k.endsWith('_eur'));
    assert.deepEqual(numericKeys.sort(), [
      'annualized_profit_eur', 'taxable_after_yrittajavahennys_eur',
      'ytd_expenses_eur', 'ytd_profit_eur', 'ytd_revenue_eur'
    ].sort());
  }
});

// ── The DB caller, driven with the yel.test.js idiom ──

const fakeClient = ({ flags = {}, profile = null, plRows = [], paymentRows = [] } = {}) => ({
  async query(sql) {
    if (sql.includes('select id from clients')) return { rows: [{ id: 'client-1' }] };
    if (sql.includes('from client_capability_config')) {
      return { rows: Object.entries(flags).map(([flag_key, stage]) => ({ flag_key, stage, source: 'test', client_id: 'client-1' })) };
    }
    if (sql.includes('from cohort_capability_config')) return { rows: [] };
    if (sql.includes('select profile from clients')) return { rows: [{ profile: profile ? { ennakkovero: profile } : {} }] };
    if (sql.includes('from ledger_lines')) return { rows: plRows };
    if (sql.includes('from transactions')) return { rows: paymentRows };
    throw new Error(`Unexpected query: ${sql}`);
  }
});

const call = ({ client } = {}) => getFinlandEnnakkoveroStatusFromDb({
  firmId: 'firm-1',
  clientId: 'client-1',
  readAt: '2026-04-10T00:00:00.000Z',
  withFirmDbClientFn: async (fn) => fn(client)
});

test('DB caller: dark flag is a typed 403; canary reads P&L + profile + Vero debits and evaluates', async () => {
  await assert.rejects(
    call({ client: fakeClient() }),
    (e) => e.statusCode === 403 && e.code === 'FINLAND_ENNAKKOVERO_WATCH_DISABLED'
  );

  const envelope = await call({
    client: fakeClient({
      flags: { FINLAND_ENNAKKOVERO_WATCH: 'canary' },
      profile: { tax_year: 2026, assessed_income_eur: 20000, annual_amount_eur: 3200 },
      plRows: [
        { account_type: 'revenue', amount: '30000' },
        { account_type: 'expense', amount: '20000' }
      ],
      paymentRows: [{ description: 'VEROHALLINTO ENNAKKOVERO', transaction_date: '2026-03-12' }]
    })
  });
  assert.equal(envelope.ennakkovero.status, 'review_recommended');
  assert.deepEqual(envelope.ennakkovero.flags, ['forecast_above_basis']);
  assert.equal(envelope.ennakkovero.forecast.annualized_profit_eur, 36500);
  assert.equal(envelope.ennakkovero.lastPaymentOn, '2026-03-12');
  assert.equal(envelope.provenance.deterministic, true);
});
