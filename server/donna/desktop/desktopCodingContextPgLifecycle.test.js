// Desktop jurisdiction coding context — real PostgreSQL lifecycle proof.
//
// The pure palette tests prove the authored US chart contains the right
// answers. This test proves the stateful desktop path that mattered in the
// Honeybee incident: a pre-existing US client resolves its authored policy
// even before boot seeds compatibility flags. The boot backfill still writes
// those rows through the governed writer, but flags no longer decide whether
// an explicitly US business receives US coding options.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

import {
  backfillDesktopRuntimePlane,
  DESKTOP_SEED_REASON
} from './hostPlaneSeed.js';
import {
  __endFirmDbPoolForTests,
  __resolveClientCodingPolicyWithClientForTests,
  ensureTransactionReviewItemInDb,
  updateTransactionReviewItemInDb
} from '../firmDb.js';
import { suggestTransactionCodingBatch } from '../transactionLlm.js';

const PG_URL = process.env.DONNA_PG_TEST_URL || '';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

test(
  'real PG: a Honeybee-shaped US client keeps its explicit coding policy before and after desktop boot',
  { skip: PG_URL ? false : 'DONNA_PG_TEST_URL not set — real-PG desktop coding context not exercised' },
  async () => {
    const dbName = `donna_desktop_coding_${Date.now().toString(36)}_${process.pid}`;
    const admin = new pg.Client({ connectionString: PG_URL });
    await admin.connect();
    await admin.query(`create database "${dbName}"`);
    const scratchUrl = new URL(PG_URL);
    scratchUrl.pathname = `/${dbName}`;
    const client = new pg.Client({ connectionString: scratchUrl.toString() });
    await client.connect();
    const priorDatabaseUrl = process.env.DATABASE_URL;

    try {
      const supabaseOnly = new Set([
        '010_evidence_object_storage.sql',
        '032_lock_down_public_rls.sql',
        '060_procountor_api_key.sql'
      ]);
      const migrations = (await readdir(path.join(ROOT, 'db', 'migrations')))
        .filter((file) => file.endsWith('.sql') && !supabaseOnly.has(file))
        .sort();
      for (const file of migrations) {
        await client.query(await readFile(path.join(ROOT, 'db', 'migrations', file), 'utf8'));
      }

      await client.query(
        `insert into firms (id, name, slug)
         values ('firm-honeybee', 'Honeybee Books', 'honeybee-books')`
      );
      await client.query(
        `insert into clients (id, firm_id, company_name, jurisdiction)
         values ('honeybee-hills-apiary-llc', 'firm-honeybee',
                 'Honeybee Hills Apiary LLC', 'US')`
      );
      await client.query(
        `insert into transactions (
           id, firm_id, client_id, transaction_date, description, raw_description,
           money_out, currency, category, account_code, reconciliation_status, coding_state, payload
         ) values (
           'tx-tractor-supply', 'firm-honeybee', 'honeybee-hills-apiary-llc',
           '2025-06-21', 'TRACTOR SUPPLY SC', 'TRACTOR SUPPLY SC',
           24.42, 'USD', 'Office expenses', 'Office expenses', 'explained', 'applied', $1::jsonb
         )`,
        [JSON.stringify({ review_status: 'resolved' })]
      );

      const before = await __resolveClientCodingPolicyWithClientForTests({
        client,
        firmId: 'firm-honeybee',
        clientId: 'honeybee-hills-apiary-llc',
        jurisdiction: 'US'
      });
      assert.equal(before.jurisdiction, 'us', 'an unseeded US client already receives its authored palette');
      assert.equal(before.policyId, 'us_coding', 'policy resolution does not wait for rollout flags');

      const seeded = await backfillDesktopRuntimePlane({
        withFirmDbClientFn: (fn) => fn(client),
        logger: { log: () => {} }
      });
      assert.ok(seeded.clientRows > 0);

      const row = (await client.query(
        `select stage, source, reason, set_by_actor_type
           from client_capability_config
          where firm_id = 'firm-honeybee'
            and client_id = 'honeybee-hills-apiary-llc'
            and flag_key = 'JURISDICTION_ACCOUNT_PALETTE'
            and valid_to is null`
      )).rows[0];
      assert.deepEqual(row, {
        stage: 'auto',
        source: 'default',
        reason: DESKTOP_SEED_REASON,
        set_by_actor_type: 'system'
      });

      const after = await __resolveClientCodingPolicyWithClientForTests({
        client,
        firmId: 'firm-honeybee',
        clientId: 'honeybee-hills-apiary-llc',
        jurisdiction: 'US'
      });
      assert.equal(after.jurisdiction, 'us');
      assert.equal(after.policyId, before.policyId);
      assert.equal(after.policyVersion, before.policyVersion);
      // Since 2026-08-31 (Kari, "nothing dark") the desktop seed carries
      // JURISDICTION_TAX_CODING too, so the vocabulary graduates WITH the
      // palette on the appliance — not silently, but through its own seeded,
      // provenanced row, asserted here exactly like the palette's above.
      const taxRow = (await client.query(
        `select stage, source, reason from client_capability_config
          where firm_id = 'firm-honeybee'
            and client_id = 'honeybee-hills-apiary-llc'
            and flag_key = 'JURISDICTION_TAX_CODING'
            and valid_to is null`
      )).rows[0];
      assert.deepEqual(taxRow, { stage: 'auto', source: 'default', reason: DESKTOP_SEED_REASON });
      assert.equal(after.policyId, 'us_coding',
        'boot seeding preserves the explicitly resolved jurisdiction vocabulary');

      // Drive the real coder surface after the database-backed marker read.
      // The transport is stubbed, but the request schema and sanitizer are the
      // production ones: this is the exact closed enum that constrained the
      // persisted Honeybee decision.
      const priorFetch = globalThis.fetch;
      const priorOpenAiKey = process.env.OPENAI_API_KEY;
      let request;
      process.env.OPENAI_API_KEY = 'test-key';
      globalThis.fetch = async (_url, init) => {
        request = JSON.parse(init.body);
        return {
          ok: true,
          json: async () => ({
            id: 'resp-honeybee-palette',
            output_text: JSON.stringify({
              suggestions: [{
                transaction_id: 'tx-tractor-supply',
                proposed_account: 'Operating supplies',
                contact: 'Tractor Supply Co',
                tax_treatment: 'No sales tax',
                support_note: 'Matched receipt lists smoker fuel, hive staples, and work gloves.',
                ask_client_question: '',
                evidence_required: false,
                remember_candidate: true,
                merchant_pattern: 'tractor supply sc',
                missing_account_name: '',
                missing_account_type: '',
                missing_account_reason: '',
                auto_explain_limit: 50,
                confidence: 'high',
                materiality: 'low',
                reasoning: 'Ordinary apiary supplies used to produce honey.',
                warnings: [],
                alternatives: []
              }],
              group_summary: []
            })
          })
        };
      };
      try {
        const coding = await suggestTransactionCodingBatch({
          clientProfile: {
            id: 'honeybee-hills-apiary-llc',
            companyName: 'Honeybee Hills Apiary LLC',
            jurisdiction: 'US',
            ...after
          },
          transactions: [{
            id: 'tx-tractor-supply',
            date: '2025-06-21',
            description: 'TRACTOR SUPPLY SC',
            money_in: 0,
            money_out: 24.42,
            account_currency: 'USD',
            matched_document: {
              match_status: 'auto_matched',
              document_type: 'receipt',
              vendor_name: 'Tractor Supply Co',
              total_amount: 24.42,
              line_items: ['Smoker Fuel 8.99', 'Hive Staples 6.49', 'Work Gloves 8.94']
            }
          }],
          clientRules: [],
          xeroAccounts: []
        });
        const accountEnum = request.text.format.schema
          .properties.suggestions.items.properties.proposed_account.enum;
        assert.ok(accountEnum.includes('Operating supplies'));
        assert.ok(!accountEnum.includes('CPF payable'));
        assert.equal(coding.suggestions[0].proposed_account, 'Operating supplies');
      } finally {
        globalThis.fetch = priorFetch;
        if (priorOpenAiKey === undefined) delete process.env.OPENAI_API_KEY;
        else process.env.OPENAI_API_KEY = priorOpenAiKey;
      }

      // The confident coding path has no review row. Prove the real bare-line
      // recovery and the real coding writer as one database lifecycle: the
      // server imports the transaction-owned decided state, then the ordinary
      // writer recodes without reopening the case or minting a second path.
      process.env.DATABASE_URL = scratchUrl.toString();
      const reviewItemId = await ensureTransactionReviewItemInDb({
        firmId: 'firm-honeybee',
        clientId: 'honeybee-hills-apiary-llc',
        transactionId: 'tx-tractor-supply',
        source: 'transaction_chat_recode_decided',
        preserveTransactionReviewState: true
      });
      assert.equal(reviewItemId, 'rvq-tx-tractor-supply-chat-bare');

      const minted = (await client.query(
        `select status, payload
           from transaction_review_queue where id = $1`,
        [reviewItemId]
      )).rows[0];
      assert.equal(minted.status, 'resolved', 'RT-16: a decided line mints its case already resolved');
      assert.equal(minted.payload.review_state, undefined, 'the case file carries no coding state');

      await updateTransactionReviewItemInDb({
        firmId: 'firm-honeybee',
        reviewItemId,
        patch: {
          status: 'resolved',
          review_state: 'accepted',
          category: 'Operating supplies',
          account_code: 'Operating supplies',
          account_name: 'Operating supplies',
          account_label: 'Operating supplies',
          reviewer_note: 'Receipt shows ordinary apiary operating supplies.'
        },
        actorId: 'member-kari',
        returnSnapshot: false,
        distillFactsFn: async () => null
      });
      const recoded = (await client.query(
        `select q.status, q.payload as review_payload,
                t.category, t.account_code, t.payload as transaction_payload, t.coding_state
           from transaction_review_queue q
           join transactions t on t.id = q.item_id and t.firm_id = q.firm_id
          where q.id = $1`,
        [reviewItemId]
      )).rows[0];
      assert.equal(recoded.status, 'resolved', 'a decided recode never reopens the case');
      assert.equal(recoded.coding_state, 'applied', 'RT-16: the decided level is preserved on the one column');
      assert.equal(recoded.category, 'Operating supplies');
      assert.equal(recoded.account_code, 'Operating supplies',
        'the prior Office expenses code must not survive the recode');
      assert.equal(recoded.review_payload.account_name, 'Operating supplies');
      assert.equal(recoded.transaction_payload.review_state, undefined, 'no legacy label in the payload');
      const recodeAudit = (await client.query(
        `select actor_id from audit_events
          where firm_id = 'firm-honeybee'
            and resource_id = $1
            and action = 'review.overridden'
          order by id desc limit 1`,
        [reviewItemId]
      )).rows[0];
      assert.equal(recodeAudit.actor_id, 'member-kari');

      const audited = await client.query(
        `select count(*)::int as count
           from audit_events
          where firm_id = 'firm-honeybee'
            and client_id = 'honeybee-hills-apiary-llc'
            and action = 'client_config.stage_set'
            and resource_id = 'JURISDICTION_ACCOUNT_PALETTE'`
      );
      assert.equal(audited.rows[0].count, 1, 'the governed writer leaves one audit receipt');
    } finally {
      await __endFirmDbPoolForTests().catch(() => {});
      if (priorDatabaseUrl === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = priorDatabaseUrl;
      await client.end().catch(() => {});
      await admin.query(
        `select pg_terminate_backend(pid) from pg_stat_activity
          where datname = $1 and pid <> pg_backend_pid()`,
        [dbName]
      ).catch(() => {});
      await admin.query(`drop database if exists "${dbName}"`).catch(() => {});
      await admin.end().catch(() => {});
    }
  }
);
