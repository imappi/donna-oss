// D4 pay-links (M2). Pins:
//   - flag off ⇒ dark (no Stripe call, no rows); shadow ⇒ one would-create
//     audit, zero mutation; act without a connected account ⇒ counted skip
//     (the payment_instructions seam keeps working — additive, never a new
//     hard dependency);
//   - act + connected account: Stripe objects are created OUTSIDE any DB
//     transaction (INV-11) and the link row + audit land in a short txn;
//   - the settlement verdict is deterministic and conservative: only a fully
//     settled link says 'settled'; partial says 'ambiguous'; active says
//     nothing;
//   - the webhook apply is idempotent on provider_event_id, cancels pending
//     reminders WITH receipts, and settles the case in the same transaction;
//   - the HTTP handler refuses unconfigured (503) and unverified (400).

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ensureOutboundPayLinks, applyPayLinkWebhookEvent, payLinkSettlementVerdict,
  stripePayLinkAccountForProfile, getActivePayLinkForAnchor
} from './payLinks.js';
import { handleOutboundPayLinkWebhook } from './outboundRoutes.js';

const FIRM = 'firm-1';
const CLIENT = 'client-1';

const caseRow = (over = {}) => ({
  id: 'rc-1', anchor_type: 'document', anchor_id: 'doc-1',
  invoice_number: 'INV-14', amount: 1250, currency: 'USD', ...over
});

const makeClient = ({ stage = 'canary', cases = [caseRow()], overrides = [] } = {}) => {
  const calls = [];
  const handlers = [
    ...overrides,
    { match: 'from client_capability_config', rows: [
      { flag_key: 'OUTBOUND_PAY_LINKS', stage, source: 'test', client_id: CLIENT }
    ] },
    { match: 'from cohort_capability_config', rows: [] },
    { match: 'from receivable_cases rc', rows: cases },
    { match: 'select company_name, profile from clients', rows: [
      { company_name: 'Roofline Co', profile: { stripe_account_id: 'acct_1' } }
    ] },
    { match: 'insert into outbound_payment_links', rows: ({ params }) => [{ id: params[0] }] },
    { match: 'insert into audit_events', rows: [] }
  ];
  return {
    calls,
    query: async (sql, params) => {
      calls.push({ sql: String(sql), params });
      const text = String(sql).replace(/\s+/g, ' ').trim().toLowerCase();
      if (text === 'begin' || text === 'commit' || text === 'rollback') return { rows: [], rowCount: 0 };
      for (const h of handlers) {
        if (text.includes(h.match)) {
          if (h.throw) throw h.throw;
          const rows = typeof h.rows === 'function' ? h.rows({ sql: text, params }) : (h.rows || []);
          return { rows, rowCount: rows.length };
        }
      }
      return { rows: [], rowCount: 0 };
    }
  };
};

const makeStripe = () => {
  const created = { prices: [], links: [] };
  return {
    created,
    prices: { create: async (params, options) => { created.prices.push({ params, options }); return { id: 'price_1' }; } },
    paymentLinks: { create: async (params, options) => { created.links.push({ params, options }); return { id: 'plink_1', url: 'https://pay.test/plink_1' }; } }
  };
};

test('flag off is dark; shadow audits would-create with zero mutation', async () => {
  const off = makeClient({ stage: 'off' });
  const offStats = await ensureOutboundPayLinks({
    client: off, firmId: FIRM, clientId: CLIENT, env: {}, stripeFactory: async () => makeStripe()
  });
  assert.equal(offStats.skipped, true);
  assert.equal(offStats.reason, 'flag_off');

  const shadow = makeClient({ stage: 'shadow' });
  const stripe = makeStripe();
  const shadowStats = await ensureOutboundPayLinks({
    client: shadow, firmId: FIRM, clientId: CLIENT, env: {}, stripeFactory: async () => stripe
  });
  assert.equal(shadowStats.shadow_would_create, 1);
  assert.equal(shadowStats.created, 0);
  assert.equal(stripe.created.links.length, 0, 'no Stripe call in shadow');
  assert.ok(shadow.calls.some((c) => c.sql.includes('outbound_payment_link.would_create')));
  assert.ok(!shadow.calls.some((c) => c.sql.includes('insert into outbound_payment_links')));
});

test('act without a connected Stripe account is a counted skip, never a Stripe call', async () => {
  const client = makeClient({
    overrides: [{ match: 'select company_name, profile from clients', rows: [
      { company_name: 'Roofline Co', profile: {} }
    ] }]
  });
  const stripe = makeStripe();
  const stats = await ensureOutboundPayLinks({
    client, firmId: FIRM, clientId: CLIENT,
    env: { STRIPE_SECRET_KEY: 'rk_test' }, stripeFactory: async () => stripe
  });
  assert.equal(stats.skipped_no_stripe_account, 1);
  assert.equal(stats.created, 0);
  assert.equal(stripe.created.links.length, 0);
  assert.equal(stripePayLinkAccountForProfile({}), null);
  assert.equal(stripePayLinkAccountForProfile({ stripe_account_id: ' acct_9 ' }), 'acct_9');
});

test('act + connected account creates the link on the CLIENT account outside any txn, then persists + audits', async () => {
  const client = makeClient();
  const stripe = makeStripe();
  const stats = await ensureOutboundPayLinks({
    client, firmId: FIRM, clientId: CLIENT,
    env: { STRIPE_SECRET_KEY: 'rk_test' }, stripeFactory: async () => stripe
  });
  assert.equal(stats.created, 1, JSON.stringify(stats));
  assert.equal(stripe.created.prices[0].options.stripeAccount, 'acct_1', 'Connect call on the client account');
  assert.equal(stripe.created.prices[0].params.unit_amount, 125000, 'dollars → cents');
  assert.equal(stripe.created.prices[0].params.currency, 'usd', 'currency from case data, lowercased');
  assert.equal(stripe.created.links[0].params.metadata.anchor_id, 'doc-1');

  const beginIdx = client.calls.findIndex((c) => c.sql.trim().toLowerCase() === 'begin');
  assert.ok(beginIdx >= 0, 'link row persisted in a txn');
  const insert = client.calls.find((c) => c.sql.includes('insert into outbound_payment_links'));
  assert.ok(insert.params.includes('https://pay.test/plink_1'));
  assert.ok(client.calls.some((c) => c.sql.includes('outbound_payment_link.created')));
});

test('settlement verdict: settled-full ⇒ settled; partial ⇒ ambiguous; active/absent ⇒ null', () => {
  assert.equal(payLinkSettlementVerdict(null), null);
  assert.equal(payLinkSettlementVerdict({ status: 'active', amount: 100 }), null);
  assert.deepEqual(
    payLinkSettlementVerdict({ status: 'settled', amount: 100, settled_amount: 100 }),
    { verdict: 'settled', reason: 'payment_link_settled' }
  );
  assert.deepEqual(
    payLinkSettlementVerdict({ status: 'settled', amount: 100, settled_amount: 40 }),
    { verdict: 'ambiguous', reason: 'payment_link_partial_settlement' }
  );
});

const linkRow = (over = {}) => ({
  id: 'pl-1', firm_id: FIRM, client_id: CLIENT,
  anchor_type: 'document', anchor_id: 'doc-1',
  provider: 'stripe', provider_link_id: 'plink_1',
  amount: 1250, currency: 'USD', status: 'active', ...over
});

const webhookEvent = (over = {}) => ({
  id: 'evt_1', type: 'checkout.session.completed', account: 'acct_1',
  data: { object: { id: 'cs_1', payment_link: 'plink_1', payment_status: 'paid', amount_total: 125000 } },
  ...over
});

const makeWebhookClient = ({ link = linkRow(), pending = [{ id: 'a-1' }], eventInserted = true } = {}) => {
  const calls = [];
  return {
    calls,
    query: async (sql, params) => {
      calls.push({ sql: String(sql), params });
      const text = String(sql).replace(/\s+/g, ' ').trim().toLowerCase();
      if (text === 'begin' || text === 'commit' || text === 'rollback') return { rows: [], rowCount: 0 };
      if (text.includes('from outbound_payment_links')) return { rows: link ? [link] : [] };
      if (text.includes('insert into outbound_payment_link_events')) {
        return { rows: eventInserted ? [{ id: params[0] }] : [] };
      }
      if (text.includes('select id from outbound_actions')) return { rows: pending };
      if (text.includes("set status = 'cancelled'")) {
        return { rows: [{ id: params[0], action_type: 'send_receivable_reminder', target_party_id: 'p-1', model: null, config_snapshot_id: null }] };
      }
      if (text.includes('update receivable_cases')) {
        return { rows: [{ id: 'rc-1', anchor_type: 'document', anchor_id: 'doc-1' }] };
      }
      return { rows: [], rowCount: 0 };
    }
  };
};

test('webhook apply settles the link, cancels pending reminders with receipts, settles the case', async () => {
  const client = makeWebhookClient();
  const result = await applyPayLinkWebhookEvent({ client, event: webhookEvent() });
  assert.equal(result.handled, true);
  assert.equal(result.deduped, false);
  assert.equal(result.cancelled_pending_actions, 1);
  assert.equal(result.settled_amount, 1250);
  assert.ok(client.calls.some((c) => c.sql.includes("set status = 'settled'")), 'link flipped');
  assert.ok(client.calls.some((c) => c.sql.includes('outbound_payment_link.settled')));
  assert.ok(client.calls.some((c) => c.sql.includes('insert into outbound_action_receipts')), 'cancel receipted');
  assert.ok(client.calls.some((c) => c.sql.includes('update receivable_cases')), 'case settled');
});

test('webhook apply is idempotent on provider_event_id and ignores non-pay-link events', async () => {
  const deduped = await applyPayLinkWebhookEvent({
    client: makeWebhookClient({ eventInserted: false }), event: webhookEvent()
  });
  assert.equal(deduped.deduped, true);

  const wrongType = await applyPayLinkWebhookEvent({
    client: makeWebhookClient(), event: webhookEvent({ type: 'invoice.paid' })
  });
  assert.equal(wrongType.handled, false);

  const notPayLink = await applyPayLinkWebhookEvent({
    client: makeWebhookClient(),
    event: { id: 'evt_2', type: 'checkout.session.completed', data: { object: { payment_status: 'paid' } } }
  });
  assert.equal(notPayLink.handled, false);

  const unpaidSession = await applyPayLinkWebhookEvent({
    client: makeWebhookClient(),
    event: webhookEvent({ data: { object: { payment_link: 'plink_1', payment_status: 'unpaid' } } })
  });
  assert.equal(unpaidSession.handled, false);

  const unknownLink = await applyPayLinkWebhookEvent({
    client: makeWebhookClient({ link: null }), event: webhookEvent()
  });
  assert.equal(unknownLink.reason, 'unknown_payment_link');
});

test('getActivePayLinkForAnchor soft-fails pre-migration', async () => {
  const client = { query: async () => { const e = new Error('missing'); e.code = '42P01'; throw e; } };
  assert.equal(await getActivePayLinkForAnchor(client, {
    firmId: FIRM, clientId: CLIENT, anchorType: 'document', anchorId: 'doc-1'
  }), null);
});

const makeReq = ({ method = 'POST', body = '{}', headers = {} } = {}) => {
  const req = {
    method,
    headers: { 'stripe-signature': 'sig', ...headers },
    async *[Symbol.asyncIterator]() { yield Buffer.from(body); }
  };
  return req;
};

const makeRes = () => {
  const res = {
    statusCode: 0, headers: {}, body: null,
    setHeader(k, v) { this.headers[k] = v; },
    end(payload) { this.body = payload ? JSON.parse(payload) : null; }
  };
  return res;
};

test('webhook route: 503 unconfigured, 400 unverified, 200 on a verified apply', async () => {
  const url = new URL('https://donna.test/api/donna/outbound/paylink-webhook');

  const unconfigured = makeRes();
  await handleOutboundPayLinkWebhook(makeReq(), unconfigured, url, { env: {} });
  assert.equal(unconfigured.statusCode, 503);

  const env = { STRIPE_SECRET_KEY: 'rk_test', STRIPE_PAYLINK_WEBHOOK_SECRET: 'whsec_test' };
  const badSig = makeRes();
  await handleOutboundPayLinkWebhook(makeReq(), badSig, url, {
    env, constructEventFn: async () => { throw new Error('bad signature'); }
  });
  assert.equal(badSig.statusCode, 400);
  assert.equal(badSig.body.code, 'WEBHOOK_SIGNATURE_INVALID');

  const ok = makeRes();
  await handleOutboundPayLinkWebhook(makeReq({ body: JSON.stringify(webhookEvent()) }), ok, url, {
    env,
    constructEventFn: async ({ rawBody }) => JSON.parse(rawBody),
    withFirmDbClientFn: async (fn) => fn(makeWebhookClient()),
    applyFn: applyPayLinkWebhookEvent
  });
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.body.received, true);
  assert.equal(ok.body.handled, true);

  const wrongMethod = makeRes();
  await handleOutboundPayLinkWebhook(makeReq({ method: 'GET' }), wrongMethod, url, { env });
  assert.equal(wrongMethod.statusCode, 405);
});
