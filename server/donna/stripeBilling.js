// Stripe billing — the SDK-facing side of the client subscription.
//
// Boundary: this module is the runtime's ONLY Stripe adapter (the standalone
// catalogue script provisions account objects). It writes subscription mirrors
// through clientSubscriptionDb and firmSubscriptionDb. Routes call
// into here; they never construct a Stripe client themselves. The webhook is
// the only path that writes subscription STATUS — a UI action can start a
// checkout, but only Stripe (through a signature-verified event) can say a
// subscription is active.
//
// Test-mode-first (the agreed rollout): everything is env-driven, so the same
// code runs against rk_test/price_test/whsec_test in preview and the live keys
// in production. Per the CLAUDE.md "model id is the receipt" rail, the env
// values ARE the deployed reality — they apply only to deployments created
// after they are set.

import Stripe from 'stripe';
import { applyFirmSubscriptionMirror } from './firmSubscriptionDb.js';
import { FIRM_OFFER, isFirmOfferSubscription, firmSubscriptionSnapshot } from './firmSubscriptionOffer.js';

import {
  bindStripeCustomerToClient,
  applySubscriptionMirror,
  applyOneTimePaymentMirror
} from './clientSubscriptionDb.js';
import { resolveOffer, getBand, billingUnitPriceFor } from '../../src/lib/pricing.js';

const env = (key) => String(process.env[key] || '').trim();

const SECRET_KEY = () => env('STRIPE_SECRET_KEY');
const WEBHOOK_SECRET = () => env('STRIPE_WEBHOOK_SECRET');
// Optional free trial (recurring only). Unset/0 = no trial. A positive integer
// opens a trial of that many days on the subscription created at checkout.
const TRIAL_DAYS = () => {
  const raw = Number.parseInt(env('STRIPE_TRIAL_DAYS'), 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 0;
};

// Billing is ENABLED once the secret key exists. We no longer need a pre-created
// STRIPE_PRICE_ID: the offer's unit price is built inline as `price_data` at
// checkout (pricing.js is the single source of truth), so there is no
// pre-registered Price object to manage. When disabled, the portal gate fails OPEN (no
// lockout) — the feature stays inert until the key is set, and a missing key can
// never wall off an existing client. This is the safe default the rollout needs.
export const isBillingEnabled = () => Boolean(SECRET_KEY());
export const isWebhookConfigured = () => Boolean(SECRET_KEY() && WEBHOOK_SECRET());

// Per-close access window for a ONE-OFF payment (one_month / catch_up). Recurring
// access is governed by Stripe's subscription status, not this. A one-month close
// opens the portal for one ~30-day period; a catch-up opens it for one period per
// month bought. Anchored on Stripe's own session timestamp at webhook time.
const ACCESS_DAYS_PER_PERIOD = 30;
export const accessPeriodsForKind = (kind, months) =>
  kind === 'catch_up' ? Math.max(1, Math.round(Number(months) || 1)) : 1;

let cachedClient = null;
let cachedKey = '';
const getStripe = () => {
  const key = SECRET_KEY();
  if (!key) throw new Error('STRIPE_SECRET_KEY is not configured.');
  // Re-create if the key changed (e.g. test→live in a long-lived process).
  if (!cachedClient || cachedKey !== key) {
    cachedClient = new Stripe(key);
    cachedKey = key;
  }
  return cachedClient;
};

// Integration tests supply the real SDK pointed at a local Stripe fixture.
export const __setStripeClientForTests = client => {
  cachedClient = client;
  cachedKey = client ? SECRET_KEY() : '';
};

// Ensure a Stripe Customer exists for this client and is bound in our mirror,
// so every later webhook event can map back to the client. Reuses an existing
// customer id; otherwise creates one stamped with client_id/firm_id metadata.
const ensureCustomer = async (client) => {
  if (client.stripeCustomerId) return client.stripeCustomerId;
  const stripe = getStripe();
  const customer = await stripe.customers.create({
    name: client.companyName || undefined,
    email: client.email || undefined,
    metadata: { client_id: client.clientId, firm_id: client.firmId }
  });
  await bindStripeCustomerToClient({
    firmId: client.firmId,
    clientId: client.clientId,
    stripeCustomerId: customer.id
  });
  return customer.id;
};

// Build the Stripe Checkout Session params for an offer. PURE — no network, no
// DB — so the offer→params mapping (mode, line item, money, metadata) is unit
// testable. The amount is re-derived from { kind, bandId, months } via
// resolveOffer; the caller's `amount`/`price`, if any, are ignored (pricing
// guardrail #3 — the customer picks months, never a price).
//
// Mode by kind: recurring → a monthly `subscription` at the flat monthly price
// (RECURRING_MONTHLY_PRICE); one_month / catch_up → a one-off `payment` at the
// band's per-close price. Either way the unit price is inlined as `price_data`
// (no pre-created Price). catch_up itemizes as quantity = months so the receipt
// reads "N × $price"; the total still equals price × months with no backlog
// premium.
export const buildCheckoutParams = ({ client, offer, customerId, successUrl, cancelUrl, trialDays = 0 }) => {
  const resolved = resolveOffer(offer);
  if (!resolved) {
    const error = new Error('That plan is not available. Please pick your volume band again.');
    error.statusCode = 400;
    error.code = 'INVALID_OFFER';
    throw error;
  }
  const { kind, bandId, months } = resolved;
  const band = getBand(bandId);
  const recurring = kind === 'recurring';
  const billingPrice = billingUnitPriceFor({ jurisdiction: client?.jurisdiction, kind, bandId });
  if (!billingPrice.ok) {
    const unknown = billingPrice.reason === 'jurisdiction_unknown';
    const error = new Error(unknown
      ? 'Billing is unavailable because the client jurisdiction is unknown or unsupported.'
      : `Billing prices for ${String(client?.jurisdiction || '').toUpperCase()} are not confirmed.`);
    error.statusCode = 409;
    error.code = unknown ? 'BILLING_JURISDICTION_UNSUPPORTED' : 'BILLING_PRICE_UNCONFIRMED';
    throw error;
  }
  const unitAmount = Math.round(billingPrice.price * 100);

  const productName = recurring
    ? `Donna — monthly close (${band.label} tx/mo)`
    : kind === 'catch_up'
      ? `Donna — catch-up close (${band.label} tx/mo)`
      : `Donna — one monthly close (${band.label} tx/mo)`;

  // client_id/firm_id place the event on a client; kind/band_id/months let the
  // webhook compute the one-off access window and mirror the band for re-pricing.
  const metadata = {
    client_id: client.clientId,
    firm_id: client.firmId,
    kind,
    band_id: bandId,
    months: String(months)
  };

  const lineItem = {
    price_data: {
      currency: billingPrice.book.currency,
      unit_amount: unitAmount,
      product_data: { name: productName },
      ...(recurring ? { recurring: { interval: 'month' } } : {})
    },
    quantity: kind === 'catch_up' ? months : 1
  };

  return {
    mode: recurring ? 'subscription' : 'payment',
    customer: customerId,
    client_reference_id: client.clientId,
    line_items: [lineItem],
    success_url: successUrl,
    cancel_url: cancelUrl,
    metadata,
    ...(recurring
      ? {
          subscription_data: {
            metadata,
            ...(trialDays ? { trial_period_days: trialDays } : {})
          }
        }
      : {
          // Carry the client mapping on the one-off PaymentIntent too, so a
          // payment event that arrives without the session still maps back.
          payment_intent_data: { metadata }
        }),
    // Don't strand a half-finished checkout: let owners retry without a new row.
    allow_promotion_codes: true
  };
};

// Create a hosted Checkout Session for the chosen offer and return the redirect
// URL; the caller sends the browser there. The amount is derived by pricing.js:
// per-close band price for one_month/catch_up, the flat monthly subscription
// for recurring. The customer never picks a price.
export const createCheckoutSession = async ({ client, offer, successUrl, cancelUrl }) => {
  if (!isBillingEnabled()) throw new Error('Billing is not enabled.');
  const stripe = getStripe();
  const customerId = await ensureCustomer(client);
  const params = buildCheckoutParams({
    client,
    offer,
    customerId,
    successUrl,
    cancelUrl,
    trialDays: TRIAL_DAYS()
  });
  const session = await stripe.checkout.sessions.create(params);
  return { url: session.url, sessionId: session.id };
};

// Open the Stripe-hosted Billing Portal so an owner can update card / cancel.
// Authorization (does this caller own this customer?) is the ROUTE's job —
// this function trusts the customer id it is given.
export const createBillingPortalSession = async ({ stripeCustomerId, returnUrl }) => {
  if (!stripeCustomerId) throw new Error('No Stripe customer for this client yet.');
  const stripe = getStripe();
  const session = await stripe.billingPortal.sessions.create({
    customer: stripeCustomerId,
    return_url: returnUrl
  });
  return { url: session.url };
};

// Verify a raw webhook payload against the signing secret. Throws if the
// signature doesn't match — the only authentication a webhook gets.
export const constructWebhookEvent = (rawBody, signature) => {
  const secret = WEBHOOK_SECRET();
  if (!secret) throw new Error('STRIPE_WEBHOOK_SECRET is not configured.');
  return getStripe().webhooks.constructEvent(rawBody, signature, secret);
};

// Pull the mirror fields off a Stripe Subscription object. kind/bandId ride in
// the subscription metadata we stamped at checkout so the gate can re-price a
// lapsed recurring plan at the client's band.
const subscriptionToMirror = (sub) => ({
  clientId: sub?.metadata?.client_id || null,
  stripeCustomerId: typeof sub?.customer === 'string' ? sub.customer : sub?.customer?.id || null,
  stripeSubscriptionId: sub?.id || null,
  status: sub?.status || null,
  currentPeriodEnd: sub?.current_period_end || null,
  billingKind: sub?.metadata?.kind || 'recurring',
  billingBandId: sub?.metadata?.band_id || null
});

// Map a completed one-off Checkout Session (mode: 'payment') to a one-time
// entitlement window. Anchored on the session's own timestamp so the paid-through
// date is deterministic from the event, not the worker's wall clock.
const oneTimeSessionToMirror = (session) => {
  const kind = session?.metadata?.kind || 'one_month';
  const months = Number.parseInt(session?.metadata?.months, 10) || 1;
  const anchorUnix = Number.isFinite(session?.created) ? session.created : Math.floor(Date.now() / 1000);
  const periods = accessPeriodsForKind(kind, months);
  const paidThroughUnix = anchorUnix + periods * ACCESS_DAYS_PER_PERIOD * 86400;
  return {
    clientId: session?.client_reference_id || session?.metadata?.client_id || null,
    stripeCustomerId: typeof session?.customer === 'string' ? session.customer : session?.customer?.id || null,
    kind,
    bandId: session?.metadata?.band_id || null,
    accessPaidThrough: paidThroughUnix
  };
};

// Apply one verified webhook event to the mirror. Only subscription-shaped
// events move status; everything else is acknowledged and ignored. Returns a
// small result for logging (handled/matched), never throws on an unknown type.
export const applyWebhookEvent = async (event, {
  stripe = null,
  applyFirmMirror = applyFirmSubscriptionMirror,
  applyClientMirror = applySubscriptionMirror,
  applyPaymentMirror = applyOneTimePaymentMirror
} = {}) => {
  const type = event?.type || '';
  const stripeClient = () => stripe || getStripe();
  const applyFirm = async (subscriptionId, session = null) => {
    const result = await applyFirmMirror({ event, subscriptionId, loadSnapshot: async () => {
      const sub = await stripeClient().subscriptions.retrieve(subscriptionId,
        { expand: ['customer.tax_ids'] }, { timeout: 10000, maxNetworkRetries: 0 });
      // Expanded tax-id lists can be truncated; retain the complete inventory.
      if (sub.customer?.tax_ids?.has_more) {
        sub.customer.tax_ids.data = await stripeClient().customers.listTaxIds(sub.customer.id,
          { limit: 100 }, { timeout: 10000, maxNetworkRetries: 0 }).autoPagingToArray({ limit: 1000 });
      }
      return firmSubscriptionSnapshot(sub, session);
    } });
    return { handled: true, matched: result.matched, type, offer: FIRM_OFFER };
  };

  if (type === 'checkout.session.completed') {
    const session = event.data.object;

    // One-off purchase (one_month / catch_up): mode 'payment', no subscription.
    // Mirror a paid-through window so the gate entitles the portal until it lapses.
    if (session.mode === 'payment') {
      if (session.payment_status !== 'paid' && session.payment_status !== 'no_payment_required') {
        return { handled: true, matched: false, type };
      }
      const result = await applyPaymentMirror(oneTimeSessionToMirror(session));
      return { handled: true, matched: result.matched, type };
    }

    // Recurring: the session doesn't carry subscription status; fetch the
    // subscription it created and mirror that as the authoritative state.
    const subscriptionId = typeof session.subscription === 'string' ? session.subscription : session.subscription?.id;
    if (!subscriptionId) return { handled: true, matched: false, type };
    const sub = await stripeClient().subscriptions.retrieve(subscriptionId);
    if (isFirmOfferSubscription(sub)) return applyFirm(subscriptionId, session);
    // Carry the session's client_id forward if the subscription metadata is thin.
    const mirror = subscriptionToMirror(sub);
    if (!mirror.clientId) mirror.clientId = session.client_reference_id || session.metadata?.client_id || null;
    const result = await applyClientMirror(mirror);
    return { handled: true, matched: result.matched, type };
  }

  if (
    type === 'customer.subscription.created' ||
    type === 'customer.subscription.updated' ||
    type === 'customer.subscription.deleted'
  ) {
    const sub = event.data.object;
    if (isFirmOfferSubscription(sub)) return applyFirm(sub.id);
    const result = await applyClientMirror(subscriptionToMirror(sub));
    return { handled: true, matched: result.matched, type };
  }

  // Acknowledged but not acted on (invoice.*, payment_intent.*, etc.). Stripe
  // re-drives subscription.* for state changes, so we don't double-handle here.
  return { handled: false, matched: false, type };
};
