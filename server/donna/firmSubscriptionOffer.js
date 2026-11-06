// The fixed firm offer is independent of the paused per-client price book.
export const FIRM_OFFER = 'donna_firm_monthly';
export const FIRM_BILLING_ACTION = 'billing.firm_subscription_mirrored';
export const FIRM_WEBHOOK_EVENTS = [
  'checkout.session.completed',
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted'
];

export const isFirmOfferSubscription = subscription =>
  subscription?.metadata?.offer === FIRM_OFFER ||
  (subscription?.items?.data || []).some(item =>
    item?.price?.lookup_key?.startsWith(FIRM_OFFER));

const objectId = value => typeof value === 'string' ? value : value?.id || null;

export const firmSubscriptionSnapshot = (subscription, session = null) => {
  const items = subscription?.items?.data || [];
  const item = items.find(row => row?.price?.lookup_key?.startsWith(FIRM_OFFER)) || items[0];
  const customer = typeof subscription?.customer === 'object' ? subscription.customer : null;
  const taxIds = customer?.tax_ids?.data ?? session?.customer_details?.tax_ids ?? null;
  return {
    stripeSubscriptionId: subscription.id,
    stripeCustomerId: objectId(subscription.customer),
    status: subscription.status,
    // Stripe moved billing periods to subscription items in the Basil API.
    currentPeriodEnd: item?.current_period_end ?? subscription.current_period_end ?? null,
    priceLookupKey: item?.price?.lookup_key || null,
    locale: subscription.metadata?.locale || session?.metadata?.locale || null,
    customerEmail: customer?.email || session?.customer_details?.email || null,
    firmName: session?.custom_fields?.find(field => field.key === 'firmname')?.text?.value || null,
    taxIds: taxIds?.map(({ type, value }) => ({ type, value })) ?? null
  };
};
