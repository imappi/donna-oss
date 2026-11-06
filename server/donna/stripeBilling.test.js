// Stripe billing — unit coverage for the pure, load-bearing logic that does
// NOT require a DB connection or a network call to Stripe:
//   - the entitlement vocabulary (which statuses open the portal gate),
//   - the safe-default enablement gates (billing inert until env is set),
//   - the webhook dispatcher's ignore path for unhandled event types.
// The DB-writing and Stripe-calling paths are exercised by integration, not
// here — those need a live DB / Stripe and would be flaky as unit tests.

import assert from 'node:assert/strict';
import test from 'node:test';

import { isEntitledStatus } from './clientSubscriptionDb.js';
import {
  applyWebhookEvent,
  isBillingEnabled,
  isWebhookConfigured,
  buildCheckoutParams,
  accessPeriodsForKind
} from './stripeBilling.js';

const CLIENT = { clientId: 'client-1', firmId: 'firm-1', jurisdiction: 'US' };

test('isEntitledStatus: only active and trialing entitle portal access', () => {
  assert.equal(isEntitledStatus('active'), true);
  assert.equal(isEntitledStatus('trialing'), true);
  // past_due is intentionally NOT entitled — the access cliff is the moment
  // Stripe stops considering the subscription good.
  assert.equal(isEntitledStatus('past_due'), false);
  assert.equal(isEntitledStatus('canceled'), false);
  assert.equal(isEntitledStatus('unpaid'), false);
  assert.equal(isEntitledStatus(null), false);
  assert.equal(isEntitledStatus(''), false);
  assert.equal(isEntitledStatus(undefined), false);
});

test('applyWebhookEvent ignores unhandled event types without touching Stripe/DB', async () => {
  // invoice.paid falls through to the no-op return — it must not call getStripe()
  // (no key here) or the DB, so this resolves cleanly.
  const result = await applyWebhookEvent({ type: 'invoice.paid', data: { object: {} } });
  assert.deepEqual(result, { handled: false, matched: false, type: 'invoice.paid' });
});

test('billing enablement is the safe default — off until the secret key is set', () => {
  const snapshot = {
    STRIPE_SECRET_KEY: process.env.STRIPE_SECRET_KEY,
    STRIPE_WEBHOOK_SECRET: process.env.STRIPE_WEBHOOK_SECRET
  };
  try {
    delete process.env.STRIPE_SECRET_KEY;
    delete process.env.STRIPE_WEBHOOK_SECRET;
    assert.equal(isBillingEnabled(), false, 'disabled with no env');
    assert.equal(isWebhookConfigured(), false, 'webhook disabled with no env');

    // The secret key alone now enables billing — the per-close price is built
    // inline as price_data, so there is no STRIPE_PRICE_ID to require.
    process.env.STRIPE_SECRET_KEY = 'sk_test_dummy';
    assert.equal(isBillingEnabled(), true, 'enabled once the secret key is present');

    assert.equal(isWebhookConfigured(), false, 'webhook still off without its secret');
    process.env.STRIPE_WEBHOOK_SECRET = 'whsec_dummy';
    assert.equal(isWebhookConfigured(), true, 'webhook on with key + secret');
  } finally {
    for (const [key, value] of Object.entries(snapshot)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('accessPeriodsForKind: one period per close, one per month for catch-up', () => {
  assert.equal(accessPeriodsForKind('one_month', 1), 1);
  assert.equal(accessPeriodsForKind('recurring', 1), 1);
  assert.equal(accessPeriodsForKind('catch_up', 4), 4);
  assert.equal(accessPeriodsForKind('catch_up', 0), 1); // floored to 1
});

test('buildCheckoutParams: recurring → a monthly subscription at the flat $99/mo (any band)', () => {
  const params = buildCheckoutParams({
    client: CLIENT,
    offer: { kind: 'recurring', bandId: '500-1k' },
    customerId: 'cus_1',
    successUrl: 'https://app/s',
    cancelUrl: 'https://app/c'
  });
  assert.equal(params.mode, 'subscription');
  assert.equal(params.customer, 'cus_1');
  assert.equal(params.client_reference_id, 'client-1');
  const item = params.line_items[0];
  assert.equal(item.quantity, 1);
  assert.equal(item.price_data.currency, 'usd');
  assert.equal(item.price_data.unit_amount, 9900); // flat $99/mo in cents, NOT the $150 band price
  assert.deepEqual(item.price_data.recurring, { interval: 'month' });
  // Metadata rides on both the session and the subscription for the webhook.
  assert.equal(params.metadata.kind, 'recurring');
  assert.equal(params.metadata.band_id, '500-1k');
  assert.equal(params.subscription_data.metadata.client_id, 'client-1');
  assert.equal(params.payment_intent_data, undefined);
});

test('buildCheckoutParams: one_month → a one-off payment, no recurring/subscription_data', () => {
  const params = buildCheckoutParams({
    client: CLIENT,
    offer: { kind: 'one_month', bandId: 'lt200' },
    customerId: 'cus_1',
    successUrl: 'https://app/s',
    cancelUrl: 'https://app/c'
  });
  assert.equal(params.mode, 'payment');
  const item = params.line_items[0];
  assert.equal(item.quantity, 1);
  assert.equal(item.price_data.unit_amount, 5000); // $50
  assert.equal(item.price_data.recurring, undefined);
  assert.equal(params.subscription_data, undefined);
  assert.equal(params.payment_intent_data.metadata.kind, 'one_month');
});

test('buildCheckoutParams: catch_up → one-off, itemized as quantity = months (no premium)', () => {
  const params = buildCheckoutParams({
    client: CLIENT,
    offer: { kind: 'catch_up', bandId: '200-500', months: 4 },
    customerId: 'cus_1',
    successUrl: 'https://app/s',
    cancelUrl: 'https://app/c'
  });
  assert.equal(params.mode, 'payment');
  const item = params.line_items[0];
  assert.equal(item.quantity, 4);
  assert.equal(item.price_data.unit_amount, 9000); // $90 per close × 4 = $360 total
  assert.equal(params.metadata.months, '4');
});

test('buildCheckoutParams: an unfit/invalid offer is refused with a 400', () => {
  assert.throws(
    () => buildCheckoutParams({ client: CLIENT, offer: { kind: 'one_month', bandId: 'over' }, customerId: 'c' }),
    (err) => err.statusCode === 400 && err.code === 'INVALID_OFFER'
  );
});

test('buildCheckoutParams: FI and GB resolve their currency but refuse unconfirmed amounts', async () => {
  const { billingPriceBookForJurisdiction } = await import('../../src/lib/pricing.js');
  assert.equal(billingPriceBookForJurisdiction('FI').currency, 'eur');
  assert.equal(billingPriceBookForJurisdiction('gb').currency, 'gbp');
  for (const jurisdiction of ['FI', 'GB']) {
    assert.throws(
      () => buildCheckoutParams({ client: { ...CLIENT, jurisdiction }, offer: { kind: 'recurring', bandId: 'lt200' }, customerId: 'cus_1' }),
      (error) => error.code === 'BILLING_PRICE_UNCONFIRMED' && error.statusCode === 409
    );
  }
});

test('buildCheckoutParams: missing or unsupported jurisdiction never defaults to USD', () => {
  for (const jurisdiction of [null, '', 'SG', 'XX']) {
    assert.throws(
      () => buildCheckoutParams({ client: { ...CLIENT, jurisdiction }, offer: { kind: 'one_month', bandId: 'lt200' }, customerId: 'cus_1' }),
      (error) => error.code === 'BILLING_JURISDICTION_UNSUPPORTED' && error.statusCode === 409
    );
  }
});

// THE SEAM the 2026-07-30 audit found broken (L1): the billing read path
// dropped `jurisdiction` from its SELECT, so every checkout in every market
// 409ed BILLING_JURISDICTION_UNSUPPORTED — and the hand-built CLIENT fixture
// above (jurisdiction hardcoded) masked it. This test goes row → mapBillingRow
// → buildCheckoutParams, and derives the fixture's keys FROM BILLING_COLUMNS,
// so a column missing from the SELECT cannot be papered over here again.
test('seam: a client read through the billing read path carries jurisdiction into checkout', async () => {
  const { BILLING_COLUMNS, mapBillingRow } = await import('./clientSubscriptionDb.js');
  const columns = BILLING_COLUMNS.split(',').map((c) => c.trim()).filter(Boolean);
  assert.ok(columns.includes('jurisdiction'), 'BILLING_COLUMNS must select jurisdiction');

  // A US client row exactly as the SELECT would return it — values exist ONLY
  // for selected columns, the way a real pg row behaves.
  const values = {
    id: 'client-1',
    firm_id: 'firm-1',
    company_name: 'Acme LLC',
    profile: {},
    jurisdiction: 'US',
    billing_band_id: 'lt200'
  };
  const row = Object.fromEntries(columns.map((c) => [c, values[c] ?? null]));

  const client = mapBillingRow(row);
  assert.equal(client.jurisdiction, 'US');
  const params = buildCheckoutParams({
    client,
    offer: { kind: 'one_month', bandId: 'lt200' },
    customerId: 'cus_1'
  });
  assert.equal(params.line_items[0].price_data.currency, 'usd');

  // The alias leg: a legacy 'uk' value (migration 022's own example) must bill
  // as GB — currency resolves, only the unconfirmed GBP amount refuses.
  const ukClient = mapBillingRow({ ...row, jurisdiction: 'uk' });
  assert.equal(ukClient.jurisdiction, 'GB');
  assert.throws(
    () => buildCheckoutParams({ client: ukClient, offer: { kind: 'one_month', bandId: 'lt200' }, customerId: 'cus_1' }),
    (error) => error.code === 'BILLING_PRICE_UNCONFIRMED'
  );

  // No jurisdiction anywhere → the honest 409, never a silent USD default.
  const bare = mapBillingRow({ ...row, jurisdiction: null });
  assert.equal(bare.jurisdiction, null);
  assert.throws(
    () => buildCheckoutParams({ client: bare, offer: { kind: 'one_month', bandId: 'lt200' }, customerId: 'cus_1' }),
    (error) => error.code === 'BILLING_JURISDICTION_UNSUPPORTED'
  );
});
