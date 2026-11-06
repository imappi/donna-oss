// AR-4E real-PostgreSQL lifecycle. The executor, action/party/config readers,
// receipt writer, constraints and migration all run for real; only the final
// network deliverer is replaced with a recorder so this certificate sends
// nothing externally.

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

import { executeDueOutboundActions } from './actionExecutor.js';

const PG_URL = process.env.DONNA_PG_TEST_URL || '';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

test('AR-4E real PG: executor → fake deliverer → exact language/HTML/attachment receipt persistence', {
  skip: PG_URL ? false : 'DONNA_PG_TEST_URL not set — real-PG outbound language lifecycle not exercised in this run'
}, async () => {
  const database = `donna_ar4e_${Date.now().toString(36)}_${process.pid}`;
  const admin = new pg.Client({ connectionString: PG_URL });
  await admin.connect();
  await admin.query(`create database "${database}"`);
  const scratch = new URL(PG_URL);
  scratch.pathname = `/${database}`;
  const client = new pg.Client({ connectionString: scratch.toString() });
  await client.connect();
  try {
    for (const migration of [
      '001_firm_core.sql',
      '042_client_capability_config.sql',
      '043_client_cohorts.sql',
      '090_outbound_parties.sql',
      '091_outbound_actions.sql',
      '092_receivable_cases.sql',
      '093_outbound_owner_surface.sql',
      '094_outbound_metrics.sql',
      '095_outbound_actions_m2.sql',
      '100_outbound_earned_auto.sql',
      '104_owner_invoice_commands.sql',
      '132_outbound_language_receipts.sql'
    ]) {
      await client.query(await readFile(path.join(ROOT, 'db', 'migrations', migration), 'utf8'));
    }

    await client.query("insert into firms (id, name, slug) values ('firm-ar4e', 'AR-4E Firm', 'ar4e-firm')");
    await client.query(
      `insert into clients (id, firm_id, company_name, profile)
       values ('client-ar4e', 'firm-ar4e', 'Roofline FZ-LLC', '{"email":"owner@roofline.example"}'::jsonb)`
    );
    await client.query(
      `insert into client_capability_config
         (id, firm_id, client_id, flag_key, stage, source)
       values ('cfg-ar4e', 'firm-ar4e', 'client-ar4e', 'OUTBOUND_DUNNING', 'auto', 'manual')`
    );
    await client.query(
      `insert into client_parties
         (id, firm_id, client_id, display_name, normalized_name, is_customer,
          preferred_language, fallback_language)
       values ('party-ar4e', 'firm-ar4e', 'client-ar4e', 'شركة المثال',
               'شركة المثال', true, 'ar', null)`
    );
    await client.query(
      `insert into party_channels
         (id, firm_id, client_id, party_id, channel_kind, channel_value,
          normalized_value, is_primary)
       values ('channel-ar4e', 'firm-ar4e', 'client-ar4e', 'party-ar4e',
               'email', 'billing@example-ae.example', 'billing@example-ae.example', true)`
    );
    await client.query(
      `insert into outbound_actions
         (id, firm_id, client_id, action_type, target_party_id, anchor_type,
          anchor_id, pack_id, template, language, payload, amount, currency,
          confidence, gate_verdict, status, scheduled_for, cadence_step,
          idempotency_key, created_by, unsubscribe_token)
       values
         ('action-ar4e', 'firm-ar4e', 'client-ar4e', 'send_receivable_reminder',
          'party-ar4e', 'document', 'invoice-ar4e', 'ae', 'reminder_step_1', 'en',
          $1::jsonb, 1250, 'AED', 1, 'auto_execute', 'scheduled', '2026-08-31T00:00:00Z', 1,
          'ar4e-real-pg', 'ar4e_test', 'unsubscribe-ar4e')`,
      [JSON.stringify({
        due_date: '2026-08-01',
        render_values: {
          owner_business_name: 'Roofline FZ-LLC',
          invoice_number: 'AE-INV-41',
          amount_due: '1,250.00',
          due_date: '1 Aug 2026',
          payment_instructions: 'IBAN AE07 0331 2345 6789 0123 456'
        }
      })]
    );

    const deliveries = [];
    const stats = await executeDueOutboundActions({
      client,
      firmId: 'firm-ar4e',
      clientId: 'client-ar4e',
      env: { OUTBOUND_PUBLIC_BASE_URL: 'https://donna.test' },
      now: Date.parse('2026-09-01T00:00:00Z'),
      paidTruthCheck: async () => 'unpaid',
      roleDecisionFn: () => ({
        allowed: true, role_id: 'invoicing_collections', reasons: []
      }),
      deliverers: {
        email: async (message) => {
          deliveries.push(message);
          return { providerMessageId: 'fake-provider-ar4e' };
        }
      }
    });

    assert.equal(stats.sent, 1, JSON.stringify(stats));
    assert.equal(deliveries.length, 1);
    assert.equal(deliveries[0].text, deliveries[0].body);
    assert.match(deliveries[0].html, /^<!doctype html><html lang="ar" dir="rtl">/);
    assert.match(deliveries[0].html, /<bdi dir="ltr">AE-INV-41<\/bdi>/);

    const action = (await client.query(
      "select status from outbound_actions where id = 'action-ar4e'"
    )).rows[0];
    assert.equal(action.status, 'executed');

    const receipt = (await client.query(
      "select * from outbound_action_receipts where action_id = 'action-ar4e' and outcome = 'sent'"
    )).rows[0];
    assert.equal(receipt.provider_message_id, 'fake-provider-ar4e');
    assert.equal(receipt.requested_language, 'ar');
    assert.equal(receipt.actual_language, 'ar');
    assert.equal(receipt.language_source, 'party_preference');
    assert.equal(receipt.language_fallback_basis, null);
    assert.equal(receipt.correspondence_locale, 'ar-AE');
    assert.equal(receipt.template_name, 'reminder_step_1');
    assert.equal(receipt.template_catalog_id, 'ae');
    assert.equal(receipt.template_catalog_version, 6);
    assert.match(receipt.rendered_html, /^<!doctype html><html lang="ar" dir="rtl">/);
    assert.deepEqual(receipt.attachment_manifest, []);
    assert.match(receipt.content_fingerprint, /^sha256:[0-9a-f]{64}$/);
    assert.equal(receipt.delivery_contract_version, 2);
    assert.match(receipt.delivery_contract_fingerprint, /^sha256:[0-9a-f]{64}$/);
  } finally {
    await client.end();
    await admin.query(
      'select pg_terminate_backend(pid) from pg_stat_activity where datname = $1 and pid <> pg_backend_pid()',
      [database]
    );
    await admin.query(`drop database if exists "${database}"`);
    await admin.end();
  }
});
