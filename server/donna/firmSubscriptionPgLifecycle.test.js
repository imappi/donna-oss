import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import { once } from 'node:events';
import { readFile, readdir } from 'node:fs/promises';
import pg from 'pg';
import Stripe from 'stripe';
import { handleDonnaApiRequest } from './api.js';
import { __setFirmDbPoolForTests, __resetFirmDbPoolForTests } from './db/pool.js';
import { __setStripeClientForTests } from './stripeBilling.js';
import { applyFirmSubscriptionMirror } from './firmSubscriptionDb.js';
import { FIRM_OFFER, firmSubscriptionSnapshot } from './firmSubscriptionOffer.js';

test('real HTTP/Stripe SDK/PostgreSQL: unlinked firm billing, audit isolation, replay, refresh races and owner regression', async t => {
  assert.ok(process.env.DONNA_PG_TEST_URL, 'INCOMPLETE: DONNA_PG_TEST_URL must name disposable PostgreSQL');
  const admin = new pg.Client({ connectionString: process.env.DONNA_PG_TEST_URL });
  await admin.connect();
  const name = `firm_billing_${process.pid}_${Date.now()}`;
  const url = new URL(process.env.DONNA_PG_TEST_URL); url.pathname = `/${name}`;
  await admin.query(`create database "${name}"`);
  const db = new pg.Client({ connectionString: url.href }); await db.connect();
  const pool = new pg.Pool({ connectionString: url.href, max: 3 });
  const connections = [];
  pool.on('connect', client => connections.push(once(client, 'end')));
  const oldEnv = { STRIPE_SECRET_KEY: process.env.STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET: process.env.STRIPE_WEBHOOK_SECRET };
  let api, provider;
  t.after(async () => {
    for (const server of [api, provider]) if (server) await new Promise(resolve => server.close(resolve));
    __setStripeClientForTests(null); __resetFirmDbPoolForTests();
    for (const [key, value] of Object.entries(oldEnv)) {
      if (value == null) delete process.env[key]; else process.env[key] = value;
    }
    await pool.end(); await Promise.all(connections); await db.end();
    await admin.query(`drop database "${name}"`); await admin.end();
  });
  await db.query(`create schema storage;
    create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
    create table storage.objects(id uuid default gen_random_uuid() primary key,bucket_id text references storage.buckets(id),name text,metadata jsonb)`);
  const dir = new URL('../../db/migrations/', import.meta.url);
  for (const file of (await readdir(dir)).filter(name => name.endsWith('.sql')).sort()) {
    await db.query(await readFile(new URL(file, dir), 'utf8'));
  }
  await db.query(await readFile(new URL('163_firm_subscriptions.sql', dir), 'utf8'));
  __setFirmDbPoolForTests(pool);
  process.env.STRIPE_SECRET_KEY = 'sk_test_firm_fixture';
  process.env.STRIPE_WEBHOOK_SECRET = 'whsec_firm_fixture';
  let subscription = { id: 'sub_firm', object: 'subscription', status: 'active',
    customer: { id: 'cus_firm', object: 'customer', email: 'firm@example.invalid', tax_ids: { data: [{ type: 'eu_vat', value: 'FI12345678' }] } },
    metadata: { offer: FIRM_OFFER, locale: 'fi' },
    items: { data: [{ price: { lookup_key: 'donna_firm_monthly_eur_v1' }, current_period_end: 1800000000 }] } };
  let stripeReads = 0;
  provider = http.createServer((req, res) => {
    assert.equal(req.method, 'GET'); assert.match(req.url, /^\/v1\/subscriptions\/sub_firm/);
    stripeReads += 1; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(subscription));
  });
  provider.listen(0, '127.0.0.1'); await once(provider, 'listening');
  const stripe = new Stripe('sk_test_firm_fixture', { host: '127.0.0.1', port: provider.address().port, protocol: 'http' });
  __setStripeClientForTests(stripe);
  api = http.createServer((req, res) => { void handleDonnaApiRequest(req, res); });
  api.listen(0, '127.0.0.1'); await once(api, 'listening');
  const event = (id, type, object) => ({ id, type, livemode: false, created: 1790000000, data: { object } });
  const post = async (value, valid = true) => {
    const payload = JSON.stringify(value);
    const signature = stripe.webhooks.generateTestHeaderString({ payload, secret: process.env.STRIPE_WEBHOOK_SECRET });
    const response = await fetch(`http://127.0.0.1:${api.address().port}/api/donna/billing/webhook`, {
      method: 'POST', headers: { 'stripe-signature': valid ? signature : 'invalid', 'content-type': 'application/json' }, body: payload
    });
    return { status: response.status, body: await response.json() };
  };
  const row = async () => (await db.query("select * from firm_subscriptions where stripe_subscription_id='sub_firm'")).rows[0];
  const receipts = async () => (await db.query("select * from audit_events where action='billing.firm_subscription_mirrored' order by id")).rows;
  const checkout = event('evt_checkout', 'checkout.session.completed', { mode: 'subscription', subscription: 'sub_firm',
    custom_fields: [{ key: 'firmname', text: { value: 'Synthetic accounting firm' } }] });

  await t.test('signed checkout lands before any firm exists, and retry is one row and receipt', async () => {
    assert.equal((await post(checkout, false)).status, 400);
    assert.equal((await post(checkout)).status, 200);
    assert.equal((await row()).firm_id, null);
    assert.equal((await row()).firm_name, 'Synthetic accounting firm');
    assert.equal((await row()).current_period_end.toISOString(), new Date(1800000000000).toISOString());
    assert.deepEqual((await row()).tax_ids, [{ type: 'eu_vat', value: 'FI12345678' }]);
    const before = await row();
    assert.equal((await post(checkout)).status, 200);
    assert.deepEqual(await row(), before);
    assert.equal((await receipts()).length, 1);
    assert.equal((await receipts())[0].actor_id, checkout.id);
    assert.equal((await receipts())[0].firm_id, null);
  });

  await t.test('updates preserve checkout name and manual firm link; old events read current Stripe state', async () => {
    await db.query("insert into firms(id,name,slug) values('firm_a','Synthetic A','synthetic-a')");
    await db.query("update firm_subscriptions set firm_id='firm_a' where stripe_subscription_id='sub_firm'");
    const oldSnapshot = structuredClone(subscription);
    subscription = { ...subscription, status: 'canceled', customer: { ...subscription.customer, tax_ids: { data: [] } } };
    assert.equal((await post(event('evt_deleted', 'customer.subscription.deleted', subscription))).status, 200);
    assert.equal((await post(event('evt_late_created', 'customer.subscription.created', oldSnapshot))).status, 200);
    assert.equal((await row()).status, 'canceled');
    assert.equal((await row()).firm_name, 'Synthetic accounting firm');
    assert.equal((await row()).firm_id, 'firm_a');
    assert.deepEqual((await row()).tax_ids, []);
    const readCount = stripeReads;
    await post(event('evt_late_created', 'customer.subscription.created', oldSnapshot));
    assert.equal(stripeReads, readCount, 'subscription event replay needs no provider access');
  });

  await t.test('a failed audit rolls back the mirror; a retry can commit', async () => {
    await db.query(`create function refuse_billing_test() returns trigger language plpgsql as $$ begin
      if new.actor_id='evt_refuse' then raise exception 'synthetic audit failure'; end if; return new; end $$;
      create trigger refuse_billing_test before insert on audit_events for each row execute function refuse_billing_test()`);
    const before = await row(); subscription = { ...subscription, status: 'past_due' };
    const value = event('evt_refuse', 'customer.subscription.updated', subscription);
    assert.equal((await post(value)).status, 500);
    assert.deepEqual(await row(), before);
    await db.query('drop trigger refuse_billing_test on audit_events');
    assert.equal((await post(value)).status, 200);
    assert.equal((await row()).status, 'past_due');
  });

  await t.test('a competing commit during a provider read forces a fresh snapshot', async () => {
    let calls = 0;
    await applyFirmSubscriptionMirror({ subscriptionId: 'sub_firm', event: event('evt_racing_old', 'customer.subscription.updated', subscription),
      loadSnapshot: async () => {
        calls += 1;
        if (calls === 1) {
          const stale = firmSubscriptionSnapshot(subscription);
          subscription = { ...subscription, status: 'unpaid' };
          await applyFirmSubscriptionMirror({ subscriptionId: 'sub_firm',
            event: event('evt_racing_new', 'customer.subscription.updated', subscription),
            loadSnapshot: async () => firmSubscriptionSnapshot(subscription) });
          return stale;
        }
        return firmSubscriptionSnapshot(subscription);
      } });
    assert.equal(calls, 2);
    assert.equal((await row()).status, 'unpaid');
  });

  await t.test('normal client and unrelated subscriptions still use the real client mirror', async () => {
    await db.query("insert into clients(id,firm_id,company_name,stripe_customer_id) values('owner_a','firm_a','Synthetic owner','cus_owner')");
    const before = await row();
    const result = await post(event('evt_owner', 'customer.subscription.updated', { id: 'sub_owner', customer: 'cus_owner', status: 'active', metadata: { client_id: 'owner_a' } }));
    assert.equal(result.status, 200); assert.equal(result.body.matched, true);
    assert.equal((await db.query("select subscription_status from clients where id='owner_a'")).rows[0].subscription_status, 'active');
    const unrelated = await post(event('evt_other', 'customer.subscription.updated', { id: 'sub_other', customer: 'cus_other', status: 'active', metadata: {} }));
    assert.equal(unrelated.status, 200); assert.equal(unrelated.body.matched, false);
    assert.deepEqual(await row(), before);
  });

  await t.test('null-firm exception rejects other audits and incomplete/spoofed receipts; firm deletion retains billing', async () => {
    for (const [action, metadata] of [['other.event', '{}'], ['billing.firm_subscription_mirrored', '{}'],
      ['billing.firm_subscription_mirrored', JSON.stringify({ offer: FIRM_OFFER, stripe_event_id: 'evt_wrong', authority_basis: 'stripe_webhook_signature', event_type: 'customer.subscription.updated', livemode: false })]]) {
      await assert.rejects(db.query(`insert into audit_events(action,actor_type,actor_id,resource_type,resource_id,metadata)
        values($1,'stripe','evt_bad','firm_subscription','sub_firm',$2)`, [action, metadata]), error => error.code === '23514');
    }
    const count = (await receipts()).length;
    await db.query("delete from firms where id='firm_a'");
    assert.equal((await row()).firm_id, null); assert.equal((await receipts()).length, count);
    const table = (await db.query("select relrowsecurity from pg_class where oid='firm_subscriptions'::regclass")).rows[0];
    assert.equal(table.relrowsecurity, true);
  });
});
