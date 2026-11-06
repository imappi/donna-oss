import assert from 'node:assert/strict';
import test from 'node:test';
import { isFirmOfferSubscription, firmSubscriptionSnapshot, FIRM_OFFER } from './firmSubscriptionOffer.js';
import { applyWebhookEvent } from './stripeBilling.js';

const subscription = {
  id: 'sub_firm', customer: 'cus_firm', status: 'active', metadata: { offer: FIRM_OFFER, locale: 'fi' },
  items: { data: [{ price: { lookup_key: 'donna_firm_monthly_eur_v1' }, current_period_end: 1800000000 }] }
};
const event = (type, object) => ({ id: 'evt_test', type, livemode: false, created: 1790000000, data: { object } });

test('firm offer detection accepts metadata or the versioned price family only', () => {
  assert.equal(isFirmOfferSubscription(subscription), true);
  assert.equal(isFirmOfferSubscription({ metadata: { offer: FIRM_OFFER } }), true);
  assert.equal(isFirmOfferSubscription({ ...subscription, metadata: {} }), true);
  for (const value of [null, {}, { metadata: { offer: 'owner' } }, { items: { data: [{ price: { lookup_key: 'other' } }] } }]) {
    assert.equal(isFirmOfferSubscription(value), false);
  }
});

test('snapshot supports both Stripe period shapes and keeps absent checkout fields absent', () => {
  const modern = firmSubscriptionSnapshot(subscription, {
    customer_details: { email: 'test@example.invalid', tax_ids: [{ type: 'eu_vat', value: 'FI12345678' }] },
    custom_fields: [{ key: 'firmname', text: { value: 'Test firm' } }]
  });
  assert.equal(modern.currentPeriodEnd, 1800000000);
  assert.equal(modern.firmName, 'Test firm');
  assert.deepEqual(modern.taxIds, [{ type: 'eu_vat', value: 'FI12345678' }]);
  const old = firmSubscriptionSnapshot({ ...subscription, items: { data: [] }, current_period_end: 1810000000 });
  assert.equal(old.currentPeriodEnd, 1810000000);
  assert.equal(old.firmName, null);
  assert.equal(old.taxIds, null);
});

test('firm checkout retrieves the subscription before dispatch and never touches client mirrors', async () => {
  const calls = [];
  const stripe = { subscriptions: { retrieve: async id => { calls.push(id); return subscription; } } };
  const result = await applyWebhookEvent(event('checkout.session.completed', {
    mode: 'subscription', subscription: subscription.id, metadata: { client_id: 'must-not-reach-client' },
    custom_fields: [{ key: 'firmname', text: { value: 'Named firm' } }]
  }), { stripe, applyFirmMirror: async ({ loadSnapshot }) => {
    assert.equal(calls.length, 1);
    assert.equal((await loadSnapshot()).firmName, 'Named firm');
    return { matched: true };
  }, applyClientMirror: () => assert.fail('firm event reached client mirror') });
  assert.equal(result.offer, FIRM_OFFER);
  assert.deepEqual(calls, [subscription.id, subscription.id]);
});

test('ordinary client and unrelated subscription events retain the existing mirror path', async () => {
  for (const clientId of ['client_owner', null]) {
    let seen;
    const result = await applyWebhookEvent(event('customer.subscription.updated', {
      id: 'sub_owner', customer: 'cus_owner', status: 'active', metadata: { client_id: clientId }
    }), { applyClientMirror: async mirror => { seen = mirror; return { matched: Boolean(clientId) }; },
      applyFirmMirror: () => assert.fail('client event reached firm mirror') });
    assert.equal(seen.clientId, clientId);
    assert.equal(result.handled, true);
    assert.equal(result.matched, Boolean(clientId));
  }
});
