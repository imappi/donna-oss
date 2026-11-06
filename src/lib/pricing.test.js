// Pricing — single source of truth. These are the numbers shown to customers
// and used to compute every charge, so pin them.

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  BANDS,
  getBand,
  priceForBand,
  RECURRING_MONTHLY_PRICE,
  unitPriceFor,
  catchUpTotal,
  amountFor,
  fmt,
  resolveOffer,
  clampCatchUpMonths,
  FINLAND_PILOT_MONTHLY_PRICE_EUR,
  fmtEur
} from './pricing.js';

test('the three volume bands carry the spec prices', () => {
  assert.deepEqual(
    BANDS.map((b) => [b.id, b.price]),
    [['lt200', 50], ['200-500', 90], ['500-1k', 150]]
  );
});

test('priceForBand resolves known bands and rejects unknown/unfit', () => {
  assert.equal(priceForBand('lt200'), 50);
  assert.equal(priceForBand('200-500'), 90);
  assert.equal(priceForBand('500-1k'), 150);
  // > 1,000 is not a band — it is the unfit gate.
  assert.equal(priceForBand('over'), null);
  assert.equal(priceForBand('nope'), null);
  assert.equal(getBand('over'), null);
});

test('catch-up bills the same per-close price × months (no backlog premium)', () => {
  assert.equal(catchUpTotal('200-500', 4), 360);
  assert.equal(catchUpTotal('lt200', 1), 50);
  // Clamp/round non-integers defensively.
  assert.equal(catchUpTotal('500-1k', 0), 150); // floored to 1 month
});

test('the recurring subscription is a flat $99/mo for every qualified band', () => {
  // Pinned: Kari's 2026-07-03 call — bands one-off, $99/mo recurring.
  assert.equal(RECURRING_MONTHLY_PRICE, 99);
  assert.equal(unitPriceFor('recurring', 'lt200'), 99);
  assert.equal(unitPriceFor('recurring', '200-500'), 99);
  assert.equal(unitPriceFor('recurring', '500-1k'), 99);
  // A valid band is still REQUIRED — the band is the qualification gate, and
  // >1,000 tx stays unfit even though it no longer moves the recurring price.
  assert.equal(unitPriceFor('recurring', 'over'), null);
  assert.equal(unitPriceFor('recurring', null), null);
  // One-off kinds keep the band's per-close price.
  assert.equal(unitPriceFor('one_month', '500-1k'), 150);
  assert.equal(unitPriceFor('catch_up', '200-500'), 90);
});

test('amountFor: one_month bills one close at band price; recurring bills flat monthly; catch_up bills months', () => {
  assert.equal(amountFor({ kind: 'one_month', bandId: '500-1k' }), 150);
  assert.equal(amountFor({ kind: 'recurring', bandId: '500-1k' }), 99);
  assert.equal(amountFor({ kind: 'recurring', bandId: 'lt200' }), 99);
  assert.equal(amountFor({ kind: 'catch_up', bandId: '500-1k', months: 3 }), 450);
  assert.equal(amountFor({ kind: 'one_month', bandId: 'over' }), null);
  assert.equal(amountFor({ kind: 'recurring', bandId: 'over' }), null);
});

test('fmt renders a rounded dollar amount with separators', () => {
  assert.equal(fmt(50), '$50');
  assert.equal(fmt(1500), '$1,500');
  assert.equal(fmt(89.6), '$90');
});

test('the Finnish pilot price is €29/mo (D7, Kari 2026-07-12) — display-only, distinct from the $99 line', () => {
  // Pinned: a change here reprices the FI landing display. The number must stay
  // Competitor-parity €29 until a dated call moves it; it is NOT the $99 recurring.
  assert.equal(FINLAND_PILOT_MONTHLY_PRICE_EUR, 29);
  assert.notEqual(FINLAND_PILOT_MONTHLY_PRICE_EUR, RECURRING_MONTHLY_PRICE);
});

test('fmtEur renders a fi-FI euro amount with the symbol after the number', () => {
  assert.equal(fmtEur(29), '29 €');
  assert.equal(fmtEur(29.4), '29 €'); // rounded
  assert.equal(fmtEur(0), '0 €');
});

test('clampCatchUpMonths keeps months in [1, 24] and defaults bad input', () => {
  assert.equal(clampCatchUpMonths(4), 4);
  assert.equal(clampCatchUpMonths(0), 1);
  assert.equal(clampCatchUpMonths(99), 24);
  assert.equal(clampCatchUpMonths(undefined), 4); // CATCH_UP_DEFAULT
});

test('resolveOffer derives the canonical, server-trusted offer (amount is computed, never trusted)', () => {
  // one_month / recurring bill one close; months is forced to 1.
  assert.deepEqual(resolveOffer({ kind: 'one_month', bandId: 'lt200' }), {
    kind: 'one_month', bandId: 'lt200', months: 1, price: 50, amount: 50
  });
  // recurring resolves the flat monthly price, whatever the band.
  assert.deepEqual(resolveOffer({ kind: 'recurring', bandId: '500-1k' }), {
    kind: 'recurring', bandId: '500-1k', months: 1, price: 99, amount: 99
  });
  assert.deepEqual(resolveOffer({ kind: 'recurring', bandId: 'lt200' }), {
    kind: 'recurring', bandId: 'lt200', months: 1, price: 99, amount: 99
  });
  // catch_up clamps months and bills price × months.
  assert.deepEqual(resolveOffer({ kind: 'catch_up', bandId: '200-500', months: 4 }), {
    kind: 'catch_up', bandId: '200-500', months: 4, price: 90, amount: 360
  });
  assert.deepEqual(resolveOffer({ kind: 'catch_up', bandId: '200-500', months: 99 }), {
    kind: 'catch_up', bandId: '200-500', months: 24, price: 90, amount: 2160
  });
  // A caller-supplied price/amount is IGNORED — only kind/bandId/months matter.
  assert.equal(resolveOffer({ kind: 'one_month', bandId: 'lt200', price: 1, amount: 1 }).amount, 50);
});

test('resolveOffer rejects an unfit band or an invalid kind', () => {
  assert.equal(resolveOffer({ kind: 'one_month', bandId: 'over' }), null); // >1,000 tx is the unfit gate
  assert.equal(resolveOffer({ kind: 'recurring', bandId: 'over' }), null); // flat price doesn't bypass the gate
  assert.equal(resolveOffer({ kind: 'one_month', bandId: null }), null);
  assert.equal(resolveOffer({ kind: 'tier_pro', bandId: 'lt200' }), null);
  assert.equal(resolveOffer({}), null);
});
