// The only firm subscription mirror writer. Stripe is truth; no entitlement,
// client mirror or automatic workspace linking is performed here.
import { withFirmDbClient } from './db/pool.js';
import { FIRM_BILLING_ACTION, FIRM_OFFER, FIRM_WEBHOOK_EVENTS } from './firmSubscriptionOffer.js';

const revision = async (db, subscriptionId) => (await db.query(
  `select id from audit_events where action = 'billing.firm_subscription_mirrored'
    and resource_id = $1 order by id desc limit 1`, [subscriptionId]
)).rows[0]?.id || null;

export const applyFirmSubscriptionMirror = async ({ event, subscriptionId, loadSnapshot }, {
  withClient = withFirmDbClient
} = {}) => {
  if (!event?.id?.startsWith('evt_') || !FIRM_WEBHOOK_EVENTS.includes(event.type) ||
      typeof event.livemode !== 'boolean' || !subscriptionId?.startsWith('sub_')) {
    throw new Error('Invalid firm subscription event identity.');
  }
  // Retrieve current Stripe state, not an old event snapshot. The receipt is an
  // optimistic revision: if another delivery commits while Stripe is read,
  // fetch again. No network call holds a database checkout or transaction.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const read = await withClient(async db => {
      const prior = (await db.query(`select resource_id from audit_events
        where action = 'billing.firm_subscription_mirrored' and metadata->>'stripe_event_id' = $1`, [event.id])).rows[0];
      if (prior && prior.resource_id !== subscriptionId) throw new Error('Stripe event identity conflict.');
      return { replayed: Boolean(prior), observed: prior ? null : await revision(db, subscriptionId) };
    });
    if (read.replayed) return { matched: true, replayed: true };
    const { observed } = read;
    const snapshot = await loadSnapshot();
    if (snapshot.stripeSubscriptionId !== subscriptionId || !snapshot.stripeCustomerId || !snapshot.status) {
      throw new Error('Incomplete firm subscription snapshot.');
    }
    const result = await withClient(async db => {
      await db.query('begin');
      try {
        await db.query("select pg_advisory_xact_lock(hashtextextended('firm-billing:' || $1, 0))", [subscriptionId]);
        const priorEvent = await db.query(
          `select resource_id from audit_events where action = 'billing.firm_subscription_mirrored'
            and metadata->>'stripe_event_id' = $1`, [event.id]);
        if (priorEvent.rows.length) {
          if (priorEvent.rows[0].resource_id !== subscriptionId) throw new Error('Stripe event identity conflict.');
          await db.query('commit');
          return { matched: true, replayed: true };
        }
        if (await revision(db, subscriptionId) !== observed) {
          await db.query('rollback');
          return null;
        }
        const before = (await db.query(
          'select status, current_period_end from firm_subscriptions where stripe_subscription_id = $1',
          [subscriptionId])).rows[0] || null;
        const end = snapshot.currentPeriodEnd == null ? null : new Date(snapshot.currentPeriodEnd * 1000).toISOString();
        await db.query(
          `insert into firm_subscriptions (stripe_subscription_id, stripe_customer_id, status,
            current_period_end, price_lookup_key, locale, customer_email, firm_name, tax_ids)
           values ($1,$2,$3,$4,$5,$6,$7,$8,coalesce($9::jsonb,'[]'::jsonb))
           on conflict (stripe_subscription_id) do update set
            stripe_customer_id = excluded.stripe_customer_id, status = excluded.status,
            current_period_end = excluded.current_period_end,
            price_lookup_key = coalesce(excluded.price_lookup_key, firm_subscriptions.price_lookup_key),
            locale = coalesce(excluded.locale, firm_subscriptions.locale),
            customer_email = coalesce(excluded.customer_email, firm_subscriptions.customer_email),
            firm_name = coalesce(excluded.firm_name, firm_subscriptions.firm_name),
            tax_ids = coalesce($9::jsonb, firm_subscriptions.tax_ids), updated_at = now()`,
          [subscriptionId, snapshot.stripeCustomerId, snapshot.status, end, snapshot.priceLookupKey,
            snapshot.locale, snapshot.customerEmail, snapshot.firmName,
            snapshot.taxIds == null ? null : JSON.stringify(snapshot.taxIds)]);
        // Platform-owned even after manual linking: firm deletion must not erase
        // payment provenance. Keep contact/tax values out of the audit payload.
        await db.query(
          `insert into audit_events (firm_id, client_id, actor_type, actor_id, action,
            resource_type, resource_id, metadata)
           values (null,null,'stripe',$1,$2,'firm_subscription',$3,$4::jsonb)`,
          [event.id, FIRM_BILLING_ACTION, subscriptionId, JSON.stringify({
            stripe_event_id: event.id, event_type: event.type, event_created: event.created,
            livemode: event.livemode, offer: FIRM_OFFER, authority_basis: 'stripe_webhook_signature',
            stripe_customer_id: snapshot.stripeCustomerId, before,
            after: { status: snapshot.status, current_period_end: end, price_lookup_key: snapshot.priceLookupKey }
          })]);
        await db.query('commit');
        return { matched: true, replayed: false };
      } catch (error) {
        await db.query('rollback');
        throw error;
      }
    });
    if (result) return result;
  }
  throw new Error('Firm subscription changed during refresh; retry delivery.');
};
