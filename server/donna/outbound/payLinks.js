// D4 — Stripe payment links (M2, the US fast-follow). The pay-link is BOTH
// the US collection lever (it replaces the profile.payment_instructions seam
// in reminders/invoices — the renderer swaps in the pack's localized
// payment_link block when a live link exists) AND the DETERMINISTIC settlement
// signal: the signature-verified webhook marks the link settled, the
// paid-truth guard reads that as 'settled', and the chase cancels with a
// receipt. It is the US replacement for the viitenumero, and the unlock for
// any future auto-graduation of US dunning (D6 grants).
//
// Boundary discipline (the stripeBilling.js rule, applied to a NEW lane):
// this module is the ONLY place that talks to Stripe for pay-links.
// stripeBilling.js stays billing-only — the platform's own subscription money
// never mixes with a client's receivables. Pay-links are created on the
// CLIENT's connected Stripe account (profile.stripe_account_id — the same
// read-only console-set seam as profile.payment_instructions until the
// owner-surface slice lands); the platform secret key carries the Connect
// call. No account id ⇒ no link ⇒ the payment_instructions seam keeps
// working — pay-links are additive, never a new hard dependency.
//
// Flag: OUTBOUND_PAY_LINKS on the config control plane, born 'off',
// envFallback () => false (the rollout rail). shadow = would-create audits,
// zero Stripe calls; act = links ensured for open receivable cases.
//
// Transaction posture: Stripe calls happen OUTSIDE any DB transaction
// (INV-11); each link then persists in its own short transaction. The
// executor/detector/guard only ever READ link rows — they never call Stripe.
//
// Keep-layer posture: deterministic scans, idempotent writes (unique anchor
// index; unique provider_event_id), receipts. No LLM.

import { randomUUID } from 'node:crypto';

import { clientFlagActs, clientFlagObserves, readClientConfigSnapshot } from '../clientConfig.js';
import { cancelOutboundAction } from './actionStore.js';
import { settleReceivableCase } from './receivableCases.js';
import { gateRoleSurfaceOperation } from '../roles/roleAuthority.js';

export const OUTBOUND_PAY_LINKS_FLAG_KEY = 'OUTBOUND_PAY_LINKS';

export const PAY_LINK_STATUSES = Object.freeze(['active', 'settled', 'deactivated']);
export const PAY_LINK_ANCHOR_TYPES = Object.freeze(['document', 'issued_invoice']);
export const PAY_LINK_PROVIDERS = Object.freeze(['stripe']);

const EPSILON = 0.01;

const missingTables = (error) => error?.code === '42P01' || error?.code === '42703';

export const payLinksGateMode = ({ snapshot = null, env = process.env } = {}) => {
  const acts = clientFlagActs({ flagKey: OUTBOUND_PAY_LINKS_FLAG_KEY, snapshot, envFallback: () => false, env });
  const observes = clientFlagObserves({ flagKey: OUTBOUND_PAY_LINKS_FLAG_KEY, snapshot, envFallback: () => false, env });
  if (acts) return 'act';
  if (observes) return 'shadow';
  return 'off';
};

// The client's connected Stripe account (their OWN money rail). Read-only
// seam — set via console/admin for customer #1; the proper owner surface is
// the G15/D12 workspace slice.
export const stripePayLinkAccountForProfile = (profile = {}) => {
  const p = profile && typeof profile === 'object' ? profile : {};
  const account = String(p.stripe_account_id || '').trim();
  return account || null;
};

// Pure settlement read over a link row: only a fully-settled link is a
// deterministic 'settled'; anything partial or unreadable is 'ambiguous'
// (the guard's conservatism — never guess toward 'paid' OR toward 'send').
export const payLinkSettlementVerdict = (link) => {
  if (!link || typeof link !== 'object') return null;
  if (link.status === 'settled') {
    const amount = Number(link.amount);
    const settled = Number(link.settled_amount);
    if (Number.isFinite(amount) && Number.isFinite(settled) && settled + EPSILON >= amount) {
      return { verdict: 'settled', reason: 'payment_link_settled' };
    }
    return { verdict: 'ambiguous', reason: 'payment_link_partial_settlement' };
  }
  return null;
};

export const getActivePayLinkForAnchor = async (client, {
  firmId, clientId, anchorType, anchorId
}) => {
  try {
    const { rows } = await client.query(
      `select * from outbound_payment_links
        where firm_id = $1 and client_id = $2 and anchor_type = $3 and anchor_id = $4
        order by created_at desc
        limit 1`,
      [firmId, clientId, anchorType, anchorId]
    );
    return rows[0] || null;
  } catch (error) {
    if (missingTables(error)) return null;
    throw error;
  }
};

// Lazy provider construction: the stripe SDK loads only when a link is
// actually created (never on the read paths).
const defaultStripeFactory = async (env) => {
  const key = String(env.STRIPE_SECRET_KEY || '').trim();
  if (!key) return null;
  const { default: Stripe } = await import('stripe');
  return new Stripe(key);
};

// Create the Stripe objects for one link (OUTSIDE any DB transaction).
// Payment Links require a Price; product_data inlines the display name.
const createStripeLink = async ({
  stripe, stripeAccount, amount, currency, name, metadata
}) => {
  const options = stripeAccount ? { stripeAccount } : {};
  const price = await stripe.prices.create({
    unit_amount: Math.round(Number(amount) * 100),
    currency: String(currency || '').toLowerCase(),
    product_data: { name }
  }, options);
  const link = await stripe.paymentLinks.create({
    line_items: [{ price: price.id, quantity: 1 }],
    metadata
  }, options);
  return { priceId: price.id, linkId: link.id, url: link.url };
};

// The sweep pre-step: ensure a pay-link exists for every open receivable case
// missing one (act stage + connected account + platform key). Idempotent per
// anchor (unique index). Returns stats; soft-skips are counted, never silent.
export const ensureOutboundPayLinks = async ({
  client, firmId, clientId, env = process.env,
  stripeFactory = defaultStripeFactory, limit = 20, logger = console
} = {}) => {
  const stats = {
    skipped: false, considered: 0, created: 0, shadow_would_create: 0,
    skipped_no_stripe_account: 0, errors: 0
  };
  if (!client || !firmId || !clientId) return { ...stats, skipped: true, reason: 'missing_args' };

  const snapshot = await readClientConfigSnapshot(client, { firmId, clientId });
  const mode = payLinksGateMode({ snapshot, env });
  if (mode === 'off') return { ...stats, skipped: true, reason: 'flag_off' };

  // S1 role leash (INV-S2): creating payment objects on the client's Stripe
  // account is the invoicing_collections role's audited surface operation.
  const roleGate = await gateRoleSurfaceOperation({
    actionType: 'create_pay_link', snapshot, env, seam: 'outbound_sweep',
    firmId, clientId, logger, query: (sql, params) => client.query(sql, params)
  });
  if (!roleGate.proceed) return { ...stats, skipped: true, reason: 'role_leash_denied' };

  const bounded = Math.min(Math.max(Number(limit) || 20, 1), 100);
  let candidates;
  try {
    // Two candidate sources, one link-per-anchor invariant:
    //   - open receivable cases (the dunning collection lever), and
    //   - pending issue_invoice actions (an invoice issued on the
    //     pay-links-only payment block needs its link BEFORE the issue email
    //     renders — the sweep runs detect → ensure → execute).
    candidates = await client.query(
      `select rc.id, rc.anchor_type, rc.anchor_id, rc.invoice_number, rc.amount, rc.currency
         from receivable_cases rc
        where rc.firm_id = $1 and rc.client_id = $2 and rc.status = 'open'
          and coalesce(rc.amount, 0) > 0 and rc.currency is not null
          and not exists (
            select 1 from outbound_payment_links pl
             where pl.firm_id = rc.firm_id and pl.client_id = rc.client_id
               and pl.anchor_type = rc.anchor_type and pl.anchor_id = rc.anchor_id)
        order by rc.created_at asc
        limit $3`,
      [firmId, clientId, bounded]
    ).then((r) => r.rows);
  } catch (error) {
    if (missingTables(error)) return { ...stats, skipped: true, reason: 'tables_absent' };
    throw error;
  }
  try {
    const issuance = await client.query(
      `select a.id, a.anchor_type, a.anchor_id,
              a.payload->'render_values'->>'invoice_number' as invoice_number,
              a.amount, a.currency
         from outbound_actions a
        where a.firm_id = $1 and a.client_id = $2
          and a.action_type = 'issue_invoice'
          and a.status in ('hold_for_approval', 'scheduled', 'approved')
          and coalesce(a.amount, 0) > 0 and a.currency is not null
          and not exists (
            select 1 from outbound_payment_links pl
             where pl.firm_id = a.firm_id and pl.client_id = a.client_id
               and pl.anchor_type = a.anchor_type and pl.anchor_id = a.anchor_id)
        order by a.created_at asc
        limit $3`,
      [firmId, clientId, bounded]
    ).then((r) => r.rows);
    const seen = new Set(candidates.map((c) => `${c.anchor_type}:${c.anchor_id}`));
    for (const row of issuance) {
      if (!seen.has(`${row.anchor_type}:${row.anchor_id}`)) candidates.push(row);
    }
  } catch (error) {
    if (!missingTables(error)) throw error;
  }
  stats.considered = candidates.length;
  if (!candidates.length) return stats;

  if (mode === 'shadow') {
    stats.shadow_would_create = candidates.length;
    try {
      await client.query(
        `insert into audit_events (firm_id, client_id, actor_type, action, resource_type, resource_id, metadata)
         values ($1, $2, 'system', 'outbound_payment_link.would_create', 'client', $2, $3::jsonb)`,
        [firmId, clientId, JSON.stringify({ case_ids: candidates.map((c) => c.id), count: candidates.length })]
      );
    } catch { /* best-effort shadow receipt */ }
    return stats;
  }

  const clientRow = await client.query(
    'select company_name, profile from clients where firm_id = $1 and id = $2',
    [firmId, clientId]
  ).then((r) => r.rows[0] || null).catch(() => null);
  const stripeAccount = stripePayLinkAccountForProfile(clientRow?.profile);
  if (!stripeAccount) {
    // Additive posture: no connected account is a counted skip, not a gap on
    // the owner — the payment_instructions seam still carries the reminder.
    stats.skipped_no_stripe_account = candidates.length;
    return stats;
  }
  const stripe = await stripeFactory(env);
  if (!stripe) return { ...stats, skipped: true, reason: 'stripe_key_missing' };

  const ownerBusinessName = String(clientRow?.company_name || '').trim();
  for (const candidate of candidates) {
    try {
      // Provider calls OUTSIDE any transaction (INV-11).
      const name = [ownerBusinessName, candidate.invoice_number || candidate.anchor_id]
        .filter(Boolean).join(' — ');
      const created = await createStripeLink({
        stripe, stripeAccount,
        amount: candidate.amount, currency: candidate.currency, name,
        metadata: {
          firm_id: firmId, client_id: clientId,
          anchor_type: candidate.anchor_type, anchor_id: candidate.anchor_id
        }
      });
      await client.query('begin');
      const id = randomUUID();
      const inserted = await client.query(
        `insert into outbound_payment_links
           (id, firm_id, client_id, anchor_type, anchor_id, provider, provider_account_id,
            provider_link_id, provider_price_id, url, amount, currency, status)
         values ($1, $2, $3, $4, $5, 'stripe', $6, $7, $8, $9, $10, $11, 'active')
         on conflict (firm_id, client_id, anchor_type, anchor_id, provider) do nothing
         returning id`,
        [id, firmId, clientId, candidate.anchor_type, candidate.anchor_id, stripeAccount,
          created.linkId, created.priceId, created.url, candidate.amount, candidate.currency]
      );
      if (inserted.rows[0]) {
        await client.query(
          `insert into audit_events (firm_id, client_id, actor_type, action, resource_type, resource_id, metadata)
           values ($1, $2, 'system', 'outbound_payment_link.created', 'outbound_payment_link', $3, $4::jsonb)`,
          [firmId, clientId, id, JSON.stringify({
            anchor: `${candidate.anchor_type}:${candidate.anchor_id}`,
            provider_link_id: created.linkId, amount: candidate.amount,
            currency: candidate.currency, provider_account_id: stripeAccount
          })]
        );
        stats.created += 1;
      }
      await client.query('commit');
    } catch (error) {
      try { await client.query('rollback'); } catch { /* best-effort */ }
      try {
        logger.warn?.(`[payLinks] ensure failed for case ${candidate.id}: ${error?.message || error}`);
      } catch { /* never throw from the logger */ }
      stats.errors += 1;
    }
  }
  return stats;
};

// Webhook signature verification — the only authentication a webhook gets.
// STRIPE_PAYLINK_WEBHOOK_SECRET is its OWN signing secret (a Connect webhook
// endpoint, distinct from the billing endpoint's STRIPE_WEBHOOK_SECRET; both
// env slots are rail-legitimate secrets). Missing secret/key ⇒ null (the
// route answers 503, never processes an unverified payload).
export const isPayLinkWebhookConfigured = (env = process.env) =>
  Boolean(String(env.STRIPE_SECRET_KEY || '').trim() && String(env.STRIPE_PAYLINK_WEBHOOK_SECRET || '').trim());

export const constructPayLinkWebhookEvent = async ({
  rawBody, signature, env = process.env, stripeFactory = defaultStripeFactory
} = {}) => {
  const secret = String(env.STRIPE_PAYLINK_WEBHOOK_SECRET || '').trim();
  if (!secret) throw new Error('STRIPE_PAYLINK_WEBHOOK_SECRET is not configured.');
  const stripe = await stripeFactory(env);
  if (!stripe) throw new Error('STRIPE_SECRET_KEY is not configured.');
  return stripe.webhooks.constructEvent(rawBody, signature, secret);
};

// Apply one signature-verified webhook event (the caller has already run
// constructEvent — this function trusts the event object, never the wire).
// Idempotent on provider_event_id. On a full settlement, in ONE transaction:
//   - the event receipt is appended,
//   - the link flips 'settled',
//   - every pending reminder for the anchor cancels with a receipt
//     (already_settled — the deterministic signal, not an inference),
//   - the receivable case settles.
// Two-terminal-states: the money arrived, so everything resting on this
// anchor converges to the settled terminal, receipted.
export const applyPayLinkWebhookEvent = async ({ client, event } = {}) => {
  const type = event?.type || '';
  if (type !== 'checkout.session.completed') {
    return { handled: false, reason: `ignored_event_type_${type || 'unknown'}` };
  }
  const session = event?.data?.object || {};
  const paymentLinkId = typeof session.payment_link === 'string'
    ? session.payment_link
    : session.payment_link?.id || null;
  if (!paymentLinkId) return { handled: false, reason: 'not_a_payment_link_session' };
  if (session.payment_status !== 'paid' && session.payment_status !== 'no_payment_required') {
    return { handled: false, reason: `payment_status_${session.payment_status || 'unknown'}` };
  }

  let link;
  try {
    link = await client.query(
      `select * from outbound_payment_links
        where provider = 'stripe' and provider_link_id = $1
        limit 1`,
      [paymentLinkId]
    ).then((r) => r.rows[0] || null);
  } catch (error) {
    if (missingTables(error)) return { handled: false, reason: 'tables_absent' };
    throw error;
  }
  if (!link) return { handled: false, reason: 'unknown_payment_link' };

  const settledAmount = Number.isFinite(Number(session.amount_total))
    ? Number(session.amount_total) / 100
    : Number(link.amount);

  await client.query('begin');
  try {
    const eventRow = await client.query(
      `insert into outbound_payment_link_events
         (id, firm_id, client_id, link_id, provider_event_id, event_type, amount, currency, payload)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)
       on conflict (provider_event_id) do nothing
       returning id`,
      [randomUUID(), link.firm_id, link.client_id, link.id,
        String(event.id || `evt-${paymentLinkId}`), type, settledAmount,
        link.currency, JSON.stringify({
          session_id: session.id || null, payment_status: session.payment_status,
          amount_total: session.amount_total ?? null, account: event.account || null
        })]
    );
    if (!eventRow.rows[0]) {
      await client.query('rollback');
      return { handled: true, deduped: true };
    }

    await client.query(
      `update outbound_payment_links
          set status = 'settled', settled_amount = $2, settled_at = now(),
              settlement_event_id = $3, updated_at = now()
        where id = $1`,
      [link.id, settledAmount, String(event.id || '')]
    );
    await client.query(
      `insert into audit_events (firm_id, client_id, actor_type, action, resource_type, resource_id, metadata)
       values ($1, $2, 'system', 'outbound_payment_link.settled', 'outbound_payment_link', $3, $4::jsonb)`,
      [link.firm_id, link.client_id, link.id, JSON.stringify({
        anchor: `${link.anchor_type}:${link.anchor_id}`,
        provider_event_id: String(event.id || ''), settled_amount: settledAmount
      })]
    );

    // Deterministic settlement observed ⇒ pending chases for this anchor
    // cancel NOW with receipts (not silently, and not waiting for the sweep).
    const pending = await client.query(
      `select id from outbound_actions
        where firm_id = $1 and client_id = $2
          and action_type = 'send_receivable_reminder'
          and anchor_type = $3 and anchor_id = $4
          and status in ('scheduled', 'hold_for_approval', 'approved')`,
      [link.firm_id, link.client_id, link.anchor_type, link.anchor_id]
    ).then((r) => r.rows);
    let cancelled = 0;
    for (const row of pending) {
      const done = await cancelOutboundAction(client, {
        firmId: link.firm_id, clientId: link.client_id, actionId: row.id,
        reason: 'already_settled',
        approvedBy: 'system:payment_link_webhook',
        authority: 'payment_link_settlement'
      });
      if (done) cancelled += 1;
    }
    try {
      await settleReceivableCase(client, {
        firmId: link.firm_id, clientId: link.client_id,
        anchorType: link.anchor_type, anchorId: link.anchor_id,
        reason: 'payment_link_settled'
      });
    } catch (error) {
      if (!missingTables(error)) throw error;
    }

    await client.query('commit');
    return {
      handled: true, deduped: false, linkId: link.id,
      anchor: `${link.anchor_type}:${link.anchor_id}`,
      cancelled_pending_actions: cancelled, settled_amount: settledAmount
    };
  } catch (error) {
    try { await client.query('rollback'); } catch { /* best-effort */ }
    throw error;
  }
};
