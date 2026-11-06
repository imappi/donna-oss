// Client subscription mirror — the DB read/write side of Stripe billing.
//
// The Stripe objects (Customer, Subscription) are the SOURCE OF TRUTH. The
// `clients.subscription_*` columns (migration 046) are a locally-rendered
// MIRROR, written ONLY here, ONLY from the signature-verified webhook
// (stripeBilling.js) — never inferred in the UI layer (CLAUDE.md "render the
// persisted verdict" rail). Read paths (the portal gate) read this mirror; they
// never call Stripe on the hot path.
//
// Kept OUT of firmDb.js on purpose: that file is the reconcile/coding engine
// (the parallel-track "do not edit" surface). Billing is a separate concern, so
// it gets its own thin module over the same `queryFirmDb` primitive.

import { queryFirmDb, DEFAULT_FIRM_ID } from './firmDb.js';
import { normalizeJurisdictionKey } from './taxCodeJurisdiction.js';
import { priceForBand } from '../../src/lib/pricing.js';
import { readInternalPilotAccessWithClient } from './internalPilotAccess.js';
import { readComplimentaryAccessWithClient, COMPLIMENTARY_ENTITLEMENT_BASIS } from './complimentaryAccess.js';

// Stripe subscription.status values that ENTITLE portal access. 'trialing' is
// entitled so a trial (if STRIPE_TRIAL_DAYS is set) opens the portal; 'past_due'
// is intentionally NOT here — the access cliff is the moment Stripe stops
// considering the subscription good. Stripe owns this vocabulary.
const ENTITLED_STATUSES = new Set(['active', 'trialing']);

export const isEntitledStatus = (status) => ENTITLED_STATUSES.has(String(status || '').trim());

// A one-off payment (one_month / catch_up) has no subscription status; it
// entitles the portal until its paid-through window lapses.
export const isWithinPaidWindow = (accessPaidThrough) => {
  if (!accessPaidThrough) return false;
  const end = new Date(accessPaidThrough).getTime();
  return Number.isFinite(end) && end > Date.now();
};

// The full entitlement rule the portal gate reads. Two independent grants:
//   - an active/trialing SUBSCRIPTION (recurring; Stripe keeps the status fresh)
//   - an unexpired ONE-OFF window (one_month / catch_up; no status to maintain)
// Subscription entitlement is status-driven (NOT period-end-driven) so the brief
// gap before a renewal webhook never locks a paying subscriber out.
export const computeEntitled = ({ status, accessPaidThrough } = {}) =>
  isEntitledStatus(status) || isWithinPaidWindow(accessPaidThrough);

export const BILLING_COLUMNS = `
  id,
  firm_id,
  company_name,
  profile,
  jurisdiction,
  entity_type,
  stripe_customer_id,
  stripe_subscription_id,
  subscription_status,
  subscription_current_period_end,
  subscription_updated_at,
  billing_kind,
  billing_band_id,
  access_paid_through
`;

export const mapBillingRow = (row) => {
  if (!row) return null;
  const profile = row.profile && typeof row.profile === 'object' ? row.profile : {};
  const bandId = row.billing_band_id || null;
  // Canonical ISO-2 billing jurisdiction (uk → GB), matching the uppercase the
  // client upsert stores in the column. buildCheckoutParams 409s on null —
  // never a silent default currency.
  const jurisdictionKey = normalizeJurisdictionKey(
    profile.jurisdiction || row.jurisdiction || ''
  );
  return {
    clientId: row.id,
    firmId: row.firm_id,
    companyName: row.company_name || null,
    entityType: row.entity_type || null,
    jurisdiction: jurisdictionKey ? jurisdictionKey.toUpperCase() : null,
    // Best-effort contact email for pre-filling the Checkout customer. Stripe
    // collects/validates the real one if this is absent.
    email: profile.email || profile.contact_email || profile.owner_email || null,
    stripeCustomerId: row.stripe_customer_id || null,
    stripeSubscriptionId: row.stripe_subscription_id || null,
    status: row.subscription_status || null,
    currentPeriodEnd: row.subscription_current_period_end || null,
    updatedAt: row.subscription_updated_at || null,
    billingKind: row.billing_kind || null,
    bandId,
    // The per-close (one-off) price for the client's band. NOTE: this is NOT
    // the recurring subscription price — that is flat (RECURRING_MONTHLY_PRICE
    // in pricing.js), and ClientPortalGate renders it from pricing.js directly.
    price: priceForBand(bandId),
    accessPaidThrough: row.access_paid_through || null,
    entitled: computeEntitled({
      status: row.subscription_status,
      accessPaidThrough: row.access_paid_through
    })
  };
};

// Portal entitlement gate — the SERVER-SIDE backstop behind ClientPortalGate
// (which fails open BY DESIGN, being a UX gate, not a security boundary). The UI
// gate hides the portal from a non-entitled owner; this refuses the portal's
// VALUE/WRITE endpoints when a client-scoped caller acts on a client whose plan
// is inactive, so a direct API call can't bypass the paywall.
//
// Who is gated: ONLY client-scoped principals (firm_collaborator —
// `unrestricted: false`). Firm members and the shared access token
// (`unrestricted: true`) are NEVER gated: a bookkeeper/pod must be able to
// service an unpaid client. Entitlement is a property of the CLIENT
// (`computeEntitled` over the persisted subscription mirror), never re-inferred
// here (CLAUDE.md "render the persisted verdict" rail).
//
// Canary-safe: a no-op unless billing is enabled (Stripe configured), matching
// the status endpoint's fail-open default — behaviour is byte-identical to
// pre-gate until the billing env is set. An unknown client is left to the
// handler to 404 honestly rather than masked as a 402 here.
//
// Accepts a single `clientId` and/or a `clientIds` array (e.g. a multi-document
// register call); every distinct client referenced must be entitled.
export const assertClientEntitled = async ({
  firmId = DEFAULT_FIRM_ID,
  clientId = null,
  clientIds = [],
  principal = null,
  billingEnabled = false,
  // Injectable for unit tests; defaults to the real DB-backed loader.
  loadBillingContext = getClientBillingContext
} = {}) => {
  if (!billingEnabled) return;                      // fail open until Stripe is configured
  if (!principal || principal.unrestricted) return; // firm member / access token — never gated
  const ids = [...new Set([clientId, ...(Array.isArray(clientIds) ? clientIds : [])].filter(Boolean))];
  if (!ids.length) return;                          // no client to check — let the handler proceed
  for (const id of ids) {
    const client = await loadBillingContext({ firmId, clientId: id });
    if (!client) continue;                          // unknown client — let the handler 404 honestly
    if (client.entitled) continue;
    const error = new Error('This plan is inactive. Start a plan to continue.');
    error.statusCode = 402;
    error.code = 'CLIENT_NOT_ENTITLED';
    throw error;
  }
};

// Load one client's billing context. firmId is included so callers can run it
// through assertFirmAccess before acting (the per-client authorization gate).
export const getClientBillingContext = async ({ firmId = DEFAULT_FIRM_ID, clientId } = {}) => {
  if (!clientId) return null;
  const result = await queryFirmDb(
    `select ${BILLING_COLUMNS} from clients where firm_id = $1 and id = $2 limit 1`,
    [firmId, clientId]
  );
  const context = mapBillingRow(result.rows[0]);
  if (context && await readInternalPilotAccessWithClient({ query: queryFirmDb }, { firmId, clientId })) {
    return { ...context, entitled: true, entitlementBasis: 'internal_pilot' };
  }
  // Complimentary access is an explicit config-plane grant, never a Stripe
  // status: the mirror columns stay untouched and the basis is surfaced.
  if (context && await readComplimentaryAccessWithClient({ query: queryFirmDb }, { firmId, clientId })) {
    return { ...context, entitled: true, entitlementBasis: COMPLIMENTARY_ENTITLEMENT_BASIS };
  }
  return context;
};

// Reverse lookup for the webhook: an event carries a Stripe customer id; find
// which client it mirrors. Scoped firm-wide because the webhook is not a
// per-firm request.
export const findClientByStripeCustomerId = async (stripeCustomerId) => {
  if (!stripeCustomerId) return null;
  const result = await queryFirmDb(
    `select ${BILLING_COLUMNS} from clients where stripe_customer_id = $1 limit 1`,
    [stripeCustomerId]
  );
  return mapBillingRow(result.rows[0]);
};

// Bind a Stripe customer to a client at checkout-session creation time, so the
// webhook can map events back even before any subscription exists. Idempotent:
// only writes when the column is empty or already matches (never silently
// re-wires a client onto a different customer — the partial unique index in 046
// is the hard backstop).
export const bindStripeCustomerToClient = async ({ firmId = DEFAULT_FIRM_ID, clientId, stripeCustomerId } = {}) => {
  if (!clientId || !stripeCustomerId) return;
  await queryFirmDb(
    `update clients
        set stripe_customer_id = $3,
            subscription_updated_at = now()
      where firm_id = $1
        and id = $2
        and (stripe_customer_id is null or stripe_customer_id = $3)`,
    [firmId, clientId, stripeCustomerId]
  );
};

// Write the subscription mirror from a webhook. Matches the client by stored
// customer id first, then by the client_id carried in subscription metadata
// (the checkout-time anchor), so an event that arrives before the customer id
// was persisted still lands on the right row.
// Resolve the (clientId, firmId) a webhook event lands on. Prefers an explicit
// clientId (from metadata); falls back to the stored customer-id mapping. Returns
// null when neither places the event, so the caller can log it rather than drop.
const resolveTarget = async ({ clientId, stripeCustomerId }) => {
  if (clientId) {
    const existing = await queryFirmDb('select firm_id from clients where id = $1 limit 1', [clientId]);
    return { clientId, firmId: existing.rows[0]?.firm_id || DEFAULT_FIRM_ID };
  }
  if (stripeCustomerId) {
    const existing = await findClientByStripeCustomerId(stripeCustomerId);
    if (existing) return { clientId: existing.clientId, firmId: existing.firmId };
  }
  return null;
};

const toIso = (value) =>
  typeof value === 'number' ? new Date(value * 1000).toISOString() : value || null;

export const applySubscriptionMirror = async ({
  clientId = null,
  stripeCustomerId = null,
  stripeSubscriptionId = null,
  status = null,
  currentPeriodEnd = null,
  billingKind = null,
  billingBandId = null
} = {}) => {
  const target = await resolveTarget({ clientId, stripeCustomerId });
  if (!target) return { matched: false };

  await queryFirmDb(
    `update clients
        set stripe_customer_id = coalesce($3, stripe_customer_id),
            stripe_subscription_id = coalesce($4, stripe_subscription_id),
            subscription_status = $5,
            subscription_current_period_end = $6,
            billing_kind = coalesce($7, billing_kind),
            billing_band_id = coalesce($8, billing_band_id),
            subscription_updated_at = now()
      where firm_id = $1 and id = $2`,
    [target.firmId, target.clientId, stripeCustomerId, stripeSubscriptionId, status, toIso(currentPeriodEnd), billingKind, billingBandId]
  );

  return { matched: true, clientId: target.clientId, firmId: target.firmId };
};

// Mirror a completed ONE-OFF payment (one_month / catch_up). Sets the
// paid-through window (the entitlement cliff) and the band/kind for re-pricing,
// WITHOUT touching subscription_status — a one-off is not a subscription.
export const applyOneTimePaymentMirror = async ({
  clientId = null,
  stripeCustomerId = null,
  kind = null,
  bandId = null,
  accessPaidThrough = null
} = {}) => {
  const target = await resolveTarget({ clientId, stripeCustomerId });
  if (!target) return { matched: false };

  await queryFirmDb(
    `update clients
        set stripe_customer_id = coalesce($3, stripe_customer_id),
            billing_kind = coalesce($4, billing_kind),
            billing_band_id = coalesce($5, billing_band_id),
            access_paid_through = $6,
            subscription_updated_at = now()
      where firm_id = $1 and id = $2`,
    [target.firmId, target.clientId, stripeCustomerId, kind, bandId, toIso(accessPaidThrough)]
  );

  return { matched: true, clientId: target.clientId, firmId: target.firmId };
};
