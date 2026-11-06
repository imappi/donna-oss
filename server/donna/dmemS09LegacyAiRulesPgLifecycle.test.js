// DMEM-R1 W0 — S09, the LR-1 before-state: one model result becomes active
// accounting policy (docs/audit-2026-09-04-memory-re-baseline.md §1 F-01, §7 S09;
// ACC-F01; the 21 live AI-created rules are exactly this row, minted this way).
//
// EXPECTED FAILURE on the current tree (registered in scripts/run-tests.mjs).
// The REAL batch coder (`batchSuggestTransactionCodingInDb`, db/coding.js) runs
// on a seeded small bank line with the coding lane served at the wire by a body
// this fixture authors: one suggestion, high confidence, no evidence needed,
// `remember_candidate: true`. The coder auto-applies (12.50 is under every
// ceiling) and calls the ONE mint (`saveMerchantRuleForPayload`, db/memory.js) with
// `source 'ai_batch'` → an ACTIVE `client_rules` row, `created_by 'ai'`, confidence
// 0.86 — and its cascade recodes an OLDER line the firm had already coded
// differently. The doctrine (INV-01 / INV-26): a model may propose a rule; active
// policy is a separate governed transition. W1 flips L1/L4 (the model mint rests
// `proposed`, no cascade); W3 closes (a projection of an approved claim).

import test from 'node:test';
import assert from 'node:assert/strict';

import { bootApplianceForTest, applianceHarnessSkipReason } from './testSupport/applianceHarness.js';
import { codingBatchBody, codingSuggestion, expectedFailure, layerMessage, seedBankLine, zeroEffectOracle } from './testSupport/dmemFixtureSupport.js';
import { batchSuggestTransactionCodingInDb } from './firmDb.js';
import { clientRuleMatchFor } from './transactionIntel.js';

const S = 'S09';
export const S09_FINGERPRINTS = Object.freeze({
  L1: layerMessage(S, 1, 'model output mints no active client_rules row (a model-proposed rule rests proposed, created_by ai, never active)'),
  L2: layerMessage(S, 2, 'an AI-created rule is not admitted as deterministic coding authority until governed (clientRuleMatchFor ignores it)'),
  L3: layerMessage(S, 3, 'the batch coder\'s coding decision is receipted in llm_decisions for the line it coded'),
  L4: layerMessage(S, 4, 'a model-minted rule recodes no line the firm had already coded (no retroactive cascade)')
});

test(
  'real PG (appliance, DMEM S09): the batch coder turns one model suggestion into an active rule and a retroactive cascade',
  { skip: applianceHarnessSkipReason() },
  async (t) => {
    const appliance = await bootApplianceForTest({ now: new Date('2026-09-04T09:00:00.000Z') });
    try {
      const { firmId } = appliance;
      const { clientId } = await appliance.createClient();
      // An older Screwfix line the firm ALREADY coded to a different account (out of the coder's pool).
      const olderCodedId = `${clientId}-tx-screwfix-old`;
      await appliance.query(
        `insert into transactions (id, firm_id, client_id, transaction_date, description, raw_description, money_out, currency, status, account_code, payload)
         values ($1, $2, $3, '2026-07-10', 'SCREWFIX DIRECT LTD', 'SCREWFIX DIRECT LTD', 9.99, 'GBP', 'ready', '6300',
                 '{"account_code":"6300","proposed_account":"Repairs and maintenance","ai_suggestion":{"proposed_account":"Repairs and maintenance","confidence":"high"},"ai_suggestion_status":"applied","support_status":"explained","reconciliation_status":"explained"}'::jsonb)`,
        [olderCodedId, firmId, clientId]
      );
      const transactionId = await seedBankLine(appliance.query, {
        firmId, clientId, id: `${clientId}-tx-screwfix-1`, date: '2026-08-22', description: 'SCREWFIX DIRECT LTD', moneyOut: 12.5
      });
      const oracle = await zeroEffectOracle(appliance.query, { firmId });

      appliance.providers.script('transaction_coding', [{
        status: 200,
        body: codingBatchBody({
          suggestions: [codingSuggestion({
            transactionId, proposedAccount: 'Operating supplies', contact: 'Screwfix', merchantPattern: 'screwfix',
            rememberCandidate: true, autoExplainLimit: 50
          })],
          groupSummary: [{ merchant_pattern: 'screwfix', proposed_account: 'Operating supplies', transaction_count: 1, reasoning: 'Recurring small supplier purchase.' }]
        })
      }]);
      await batchSuggestTransactionCodingInDb({ firmId, clientIds: [clientId] });
      const codingCalls = appliance.providers.calls.filter((call) => call.lane === 'transaction_coding');
      assert.equal(codingCalls.length, 1, `the batch coder called the coding lane exactly once: ${JSON.stringify(appliance.providers.calls.map((c) => [c.lane, c.status]))}`);

      const rules = (await appliance.query('select * from client_rules where firm_id = $1 and client_id = $2 order by created_at', [firmId, clientId])).rows;
      const lines = await appliance.read.transactions(clientId);
      const coded = lines.find((tx) => tx.id === transactionId);
      // On the desktop seeds the batch coder auto-applies AND posts the journal inline
      // (CODING_AUTO_POST + LEDGER_AUTO_POST are `auto` on the owner shell): one model
      // result reaches the ledger in the same round as the rule it minted.
      assert.ok(['applied', 'posted'].includes(coded?.coding_state), `the coder auto-applied the small line: ${JSON.stringify(lines.map((tx) => [tx.id, tx.coding_state, tx.account_code]))}`);

      await t.test('L1 database state — the model mint rests proposed, never active', () => {
        assert.ok(rules.length >= 1, layerMessage(S, 1, 'the coder recorded the model\'s rule proposal as a row'));
        const activeAi = rules.filter((rule) => rule.created_by === 'ai' && rule.status === 'active');
        assert.deepEqual(activeAi.map((rule) => rule.id), [], S09_FINGERPRINTS.L1);
      });

      await t.test('L1b census — the LR-1 target-list predicate (§5.1) finds no NEW row after W1; the proposal carries the LR-1 signature', async () => {
        // Before W1 this predicate named the row the coder had just minted ACTIVE
        // (the shape of the 21 live rules). After W1 the mint rests `proposed`,
        // so a fresh book yields ZERO rows — LR-1's target list is exactly the
        // pre-W1 population, never a row this tree can still create. The
        // proposal itself keeps the signature (source ai_batch, confidence 0.86,
        // created_by ai) so the same census reads it as a post-W1 proposal.
        const census = (await appliance.query(
          "select id from client_rules where firm_id = $1 and status = 'active' and created_by = 'ai'",
          [firmId]
        )).rows;
        assert.deepEqual(census, [], layerMessage(S, 1, 'the LR-1 predicate finds no row the containment could still produce'));
        const proposed = (await appliance.query(
          "select id, status, created_by, payload->>'source' as source, payload->>'confidence' as confidence from client_rules where firm_id = $1 and created_by = 'ai'",
          [firmId]
        )).rows;
        assert.equal(proposed.length, 1, layerMessage(S, 1, 'the coder recorded exactly one model proposal'));
        assert.equal(proposed[0].status, 'proposed');
        assert.equal(proposed[0].source, 'ai_batch');
        assert.equal(Number(proposed[0].confidence), 0.86, layerMessage(S, 1, 'the mint stamps the fixed 0.86 the forensic review found on all 21 live rules'));
      });

      await t.test('L2 deterministic consumer — an ungoverned AI rule is not coding authority', () => {
        const match = clientRuleMatchFor({ description: 'SCREWFIX DIRECT LTD', raw_description: 'SCREWFIX DIRECT LTD' }, rules);
        assert.equal(match, null, S09_FINGERPRINTS.L2);
      });

      await t.test('L3 decision receipt — the coder\'s consequential decision is receipted', () => expectedFailure({ id: `${S}/L3`, fingerprint: S09_FINGERPRINTS.L3 }, async () => {
        // The batch coder records NO llm_decisions row for the lines it codes (the
        // forensic review's 73 receipts come from the parse-time coder, the matchers
        // and the dispositions) — a consequential model decision with no receipt
        // at all (INV-10), one step before the missing envelope S12 asserts.
        const decisions = (await appliance.query(
          'select id, decision_type, model_name from llm_decisions where firm_id = $1 and client_id = $2 and target_id = $3',
          [firmId, clientId, transactionId]
        )).rows;
        assert.ok(decisions.length >= 1, S09_FINGERPRINTS.L3);
        assert.ok(decisions.every((row) => row.model_name), layerMessage(S, 3, 'every receipt names the model'));
      }));

      await t.test('L4 accounting outcome — the older, already-coded line is left as the firm coded it', async () => {
        const older = (await appliance.read.transactions(clientId)).find((tx) => tx.id === olderCodedId);
        assert.equal(older.account_code, '6300', S09_FINGERPRINTS.L4);
        assert.equal(older.payload?.matched_client_rule_id ?? null, null, S09_FINGERPRINTS.L4);
      });

      await t.test('L4b accounting-effect oracle — the round posts exactly the coded line, and nothing for the cascaded older line', async () => {
        const diff = await oracle.diffAgainst({});
        const journals = (await appliance.query('select id, source_type, source_id from ledger_journals where firm_id = $1 and client_id = $2 order by id', [firmId, clientId])).rows;
        const forCoded = journals.filter((row) => row.source_id === transactionId);
        const forOlder = journals.filter((row) => row.source_id === olderCodedId);
        assert.equal(forCoded.length, journals.length, layerMessage(S, 4, `every journal of the round belongs to the coded line: ${JSON.stringify(journals)}`));
        assert.deepEqual(forOlder, [], layerMessage(S, 4, 'the cascade posted nothing for the older line'));
        assert.equal(diff.effectUnchanged, forCoded.length === 0, layerMessage(S, 4, 'the accounting-effect hash moved exactly when the coded line was posted'));
        const undeclared = Object.keys(diff.unauthorizedWrites).filter((table) => !['client_rules', 'audit_events', 'llm_decisions', 'ledger_journals', 'ledger_lines'].includes(table));
        assert.deepEqual(undeclared, [], layerMessage(S, 4, `no memory-plane table outside rules/audit/decisions/ledger was written: ${JSON.stringify(diff.unauthorizedWrites)}`));
      });
    } finally {
      await appliance.stop();
    }
  }
);
