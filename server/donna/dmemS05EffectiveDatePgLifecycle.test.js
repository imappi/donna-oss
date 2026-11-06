// DMEM-R1 W0 — S05, effective date (forensic §13.5; docs/audit-2026-09-04-memory-re-baseline.md
// §1 F-09, canary 8; ACC-F09, ACC-C08).
//
// EXPECTED FAILURE on the current tree (registered in scripts/run-tests.mjs).
// A merchant rule minted in August through the REAL mint (`saveMerchantRuleForPayload`,
// db/memory.js) must apply to lines on or after its business-effective start and
// leave a January line the firm had already coded untouched (INV-07: record time
// and business-effective time are distinct; a null applicability field is not a
// wildcard). The tree has no effective interval on `client_rules` (002) and the
// cascade scans the client's whole history, so the January line is recoded. W2
// adds the interval (additive); W3's projection carries it; the cascade is bounded
// in W1 as a stopgap.

import test from 'node:test';
import assert from 'node:assert/strict';

import { bootApplianceForTest, applianceHarnessSkipReason } from './testSupport/applianceHarness.js';
import { expectedFailure, layerMessage, seedBankLine } from './testSupport/dmemFixtureSupport.js';
import { saveMerchantRuleForPayload, withFirmDbClient } from './firmDb.js';

const S = 'S05';
export const S05_FINGERPRINTS = Object.freeze({
  L1: layerMessage(S, 1, 'a client_rules row carries a business-effective interval (valid_from, valid_until) and its jurisdiction applicability'),
  L3: layerMessage(S, 3, 'the merchant_rule_saved receipt records the rule\'s effective_from'),
  L4: layerMessage(S, 4, 'a rule minted in August leaves a January line coded as the firm coded it (no retroactive recode across the effective boundary)')
});

test(
  'real PG (appliance, DMEM S05): a rule minted mid-year is applied to the whole history',
  { skip: applianceHarnessSkipReason() },
  async (t) => {
    const appliance = await bootApplianceForTest({ now: new Date('2026-09-04T09:00:00.000Z') });
    try {
      const { firmId } = appliance;
      const { clientId } = await appliance.createClient();
      const januaryId = `${clientId}-tx-acme-jan`;
      await appliance.query(
        `insert into transactions (id, firm_id, client_id, transaction_date, description, raw_description, money_out, currency, status, account_code, payload)
         values ($1, $2, $3, '2026-01-15', 'ACME LEASING', 'ACME LEASING', 250.00, 'GBP', 'ready', '6300',
                 '{"account_code":"6300","proposed_account":"Repairs and maintenance","support_status":"explained","reconciliation_status":"explained"}'::jsonb)`,
        [januaryId, firmId, clientId]
      );
      const augustId = await seedBankLine(appliance.query, { firmId, clientId, id: `${clientId}-tx-acme-aug`, date: '2026-08-15', description: 'ACME LEASING', moneyOut: 250 });

      const minted = await withFirmDbClient(async (client) => {
        await client.query('begin');
        try {
          const out = await saveMerchantRuleForPayload({
            client, firmId, clientId, transactionId: augustId,
            payload: { description: 'ACME LEASING', raw_description: 'ACME LEASING', merchant_pattern: 'acme leasing', account_code: '6400', contact: 'Acme Leasing', merchant_rule_auto_explain_limit: 300, effective_from: '2026-07-01' },
            supportNote: 'Equipment lease from July 2026.',
            source: 'transaction_drawer',
            actorId: 'dmem-w0'
          });
          await client.query('commit');
          return out;
        } catch (error) {
          await client.query('rollback');
          throw error;
        }
      });
      assert.ok(minted?.ruleId, 'the mint returned a rule id');
      const rule = (await appliance.query('select * from client_rules where firm_id = $1 and id = $2', [firmId, minted.ruleId])).rows[0];
      const columns = new Set((await appliance.query("select column_name from information_schema.columns where table_name = 'client_rules'")).rows.map((row) => row.column_name));

      // DMEM-R1 W2 (migration 142): the schema half of L1 is satisfied — the
      // projection row HAS a half-open business-effective interval, its
      // jurisdiction and an applicability column, and the interval is enforced
      // in the database. Plain assertions from W2 on.
      await t.test('L1 schema (W2) — client_rules carries valid_from / valid_until / jurisdiction / applicability, half-open in the database', async () => {
        assert.ok(columns.has('valid_from') && columns.has('valid_until'), layerMessage(S, 1, 'the interval columns exist (migration 142)'));
        assert.ok(columns.has('jurisdiction') && columns.has('applicability'), layerMessage(S, 1, 'the jurisdiction + applicability columns exist (migration 142)'));
        await assert.rejects(
          () => appliance.query('update client_rules set valid_from = $3, valid_until = $3 where firm_id = $1 and id = $2', [firmId, minted.ruleId, '2026-07-01']),
          /client_rules_effective_interval_half_open/,
          layerMessage(S, 1, 'an empty interval is refused by the database (half-open [from, to))')
        );
        assert.equal(rule.valid_from ?? null, null, layerMessage(S, 1, 'W2 backfills nothing: the mint on this tree still writes no interval (W3 persists it)'));
      });

      // The writer half stays REGISTERED: the mint does not persist the caller's
      // effective_from until W3's projection gateway writes the interval.
      await t.test('L1 database state — the rule carries the caller\'s business-effective start', () => expectedFailure({ id: `${S}/L1`, fingerprint: S05_FINGERPRINTS.L1 }, () => {
        assert.equal(String(rule.valid_from ?? '').slice(0, 10), '2026-07-01', S05_FINGERPRINTS.L1);
      }));

      await t.test('L3 receipt — the mint receipt names the effective start', async () => {
        const receipts = (await appliance.read.audit({ clientId, action: 'client_rule.merchant_rule_saved' })).filter((row) => row.resource_id === minted.ruleId);
        assert.equal(receipts.length, 1, layerMessage(S, 3, 'the mint wrote exactly one merchant_rule_saved receipt'));
        assert.equal(receipts[0].metadata?.effective_from ?? null, '2026-07-01', S05_FINGERPRINTS.L3);
      });

      await t.test('L4 accounting outcome — the January line is left as the firm coded it', async () => {
        const lines = await appliance.read.transactions(clientId);
        const january = lines.find((tx) => tx.id === januaryId);
        const august = lines.find((tx) => tx.id === augustId);
        assert.equal(august.account_code, '6400', layerMessage(S, 4, 'the August line (after effective_from) is coded by the rule'));
        assert.equal(january.account_code, '6300', S05_FINGERPRINTS.L4);
        assert.equal(january.payload?.matched_client_rule_id ?? null, null, S05_FINGERPRINTS.L4);
      });
    } finally {
      await appliance.stop();
    }
  }
);
