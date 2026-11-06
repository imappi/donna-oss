// DMEM-R1 W0 — S04, merchant correction and isolation (forensic §13.4;
// docs/audit-2026-09-04-memory-re-baseline.md §1 F-02 / F-03 / F-05, canaries
// 5–7; ACC-F02, ACC-F03, ACC-F05, ACC-C05..C07).
//
// EXPECTED FAILURE on the current tree (registered in scripts/run-tests.mjs).
// Two legal entities on one firm. The REAL writers run: `saveMerchantRuleForPayload`
// (db/memory.js) twice for client A — the mapping and its correction — and
// `updateTransactionReviewItemInDb` (db/coding.js) for a human recode that
// disagrees with the model's prior verdict, with the distiller lane served at the
// wire. What the doctrine requires: one current rule per (client, pattern) after a
// correction (INV-06); an ordinary correction changes only its object — no active
// fact, a candidate that rests `suggested`, a receipt derived from what committed
// (INV-02 / INV-03 / INV-04). What the tree does: two active rules coexist
// (F-05); the correction mints an active fact, stages the candidate already
// `promoted`, and the receipt says `memory_minted:false` (F-02 / F-03). The
// isolation legs (A's rule and entity-keyed fact never reach B) PASS today and
// are pinned so W1 cannot regress them.

import test from 'node:test';
import assert from 'node:assert/strict';

import { bootApplianceForTest, applianceHarnessSkipReason } from './testSupport/applianceHarness.js';
import { distillerBody, layerMessage, seedBankLine } from './testSupport/dmemFixtureSupport.js';
import { ensureTransactionReviewItemInDb, saveMerchantRuleForPayload, updateTransactionReviewItemInDb, withFirmDbClient } from './firmDb.js';
import { getFirmFactsForSubjects } from './firmFacts.js';
import { buildCorrectionTeachingReceipt } from './correctionTeaching.js';
import { clientRuleMatchFor } from './transactionIntel.js';

const S = 'S04';
export const S04_FINGERPRINTS = Object.freeze({
  L1: layerMessage(S, 1, 'a corrected merchant mapping leaves exactly one current rule per (client, pattern) — the prior mapping is retired in the same transaction'),
  L1b: layerMessage(S, 1, 'an ordinary correction mints no active firm_facts row (teaching is an explicit, separate action)'),
  L1c: layerMessage(S, 1, 'the candidate staged from a correction rests suggested until a governed promotion'),
  L2: layerMessage(S, 2, 'the deterministic consumer applies the corrected account, never the retired mapping (two current rules on one pattern let input order decide)'),
  L3: layerMessage(S, 3, 'the correction receipt\'s memory_minted equals the number of facts the correction committed')
});

const mintRule = ({ firmId, clientId, transactionId, accountCode, actorId }) => withFirmDbClient(async (client) => {
  await client.query('begin');
  try {
    const out = await saveMerchantRuleForPayload({
      client, firmId, clientId, transactionId,
      payload: { description: 'ACME SUPPLIES LTD', raw_description: 'ACME SUPPLIES LTD', merchant_pattern: 'acme supplies', account_code: accountCode, contact: 'Acme Supplies', merchant_rule_auto_explain_limit: 100 },
      supportNote: `Use ${accountCode} for Acme Supplies.`,
      source: 'transaction_drawer',
      actorId
    });
    await client.query('commit');
    return out;
  } catch (error) {
    await client.query('rollback');
    throw error;
  }
});

test(
  'real PG (appliance, DMEM S04): a merchant correction leaves two current rules and silently teaches a fact; isolation between entities holds',
  { skip: applianceHarnessSkipReason() },
  async (t) => {
    const appliance = await bootApplianceForTest({ now: new Date('2026-09-04T09:00:00.000Z') });
    try {
      const { firmId } = appliance;
      const { clientId: clientA } = await appliance.createClient({ profile: { companyName: 'Kestrel Print Studio Ltd' } });
      const { clientId: clientB } = await appliance.createClient({ profile: { companyName: 'Dune Apparel FZ-LLC', jurisdiction: 'AE', entityType: 'ae-llc' } });
      const lineA = await seedBankLine(appliance.query, { firmId, clientId: clientA, id: `${clientA}-tx-acme-1`, date: '2026-08-12', description: 'ACME SUPPLIES LTD', moneyOut: 84 });
      const lineB = await seedBankLine(appliance.query, { firmId, clientId: clientB, id: `${clientB}-tx-acme-1`, date: '2026-08-13', description: 'ACME SUPPLIES LTD', moneyOut: 84, currency: 'AED' });

      // The mapping, then its correction — the SAME writer both times.
      await mintRule({ firmId, clientId: clientA, transactionId: lineA, accountCode: '6100', actorId: 'dmem-w0' });
      await mintRule({ firmId, clientId: clientA, transactionId: lineA, accountCode: '6200', actorId: 'dmem-w0' });
      const rulesA = (await appliance.query('select * from client_rules where firm_id = $1 and client_id = $2 order by created_at', [firmId, clientA])).rows;
      const rulesB = (await appliance.query('select id from client_rules where firm_id = $1 and client_id = $2', [firmId, clientB])).rows;

      await t.test('L1 database state — one current rule per (client, pattern) after a correction', () => {
        const active = rulesA.filter((rule) => rule.status === 'active');
        assert.equal(active.length, 1, S04_FINGERPRINTS.L1);
        assert.equal(active[0].account_code, '6200', layerMessage(S, 1, 'the surviving current rule is the corrected mapping'));
      });

      await t.test('L2 deterministic consumer — the corrected mapping is the one that codes', () => {
        // With two active rules on one pattern the matcher's tie-break is input
        // order (transactionIntel.js clientRuleMatchFor): the OLDER, retired-in-
        // intent mapping wins — F-05's consequence, not only its cause.
        const matchA = clientRuleMatchFor({ description: 'ACME SUPPLIES LTD', raw_description: 'ACME SUPPLIES LTD' }, rulesA.filter((rule) => rule.status === 'active'));
        assert.ok(matchA, layerMessage(S, 2, 'client A has a deterministic match for the merchant'));
        assert.equal(matchA.account_code, '6200', S04_FINGERPRINTS.L2);
      });

      await t.test('L2a isolation — the other legal entity received none of A\'s rules', () => {
        assert.deepEqual(rulesB, [], layerMessage(S, 2, 'client B (another legal entity, another jurisdiction) received none of A\'s rules'));
      });

      // The human recode: the model said Sales, the human says Operating supplies —
      // the exact disagreement the review writer distils after commit.
      await appliance.query(
        `update transactions set payload = payload || '{"ai_suggestion":{"proposed_account":"Sales","account_name":"Sales","confidence":"medium"}}'::jsonb where firm_id = $1 and id = $2`,
        [firmId, lineA]
      );
      const reviewItemId = await ensureTransactionReviewItemInDb({ firmId, clientId: clientA, transactionId: lineA, source: 'chat_apply' });
      assert.ok(reviewItemId, 'a review case file exists for the line');
      appliance.providers.script('memory_extraction', [{
        status: 200,
        body: distillerBody({ facts: [{ scope: 'merchant', subject: 'ACME SUPPLIES LTD', fact: 'Acme Supplies sells stationery and packaging to the studio.', confidence: 'medium' }] })
      }]);
      const action = { action_type: 'apply_category', correction_scope: 'transaction', account_name: 'Operating supplies', reason_code: 'wrong_account' };
      await updateTransactionReviewItemInDb({
        firmId, reviewItemId,
        patch: { status: 'resolved', account_name: 'Operating supplies', category: 'Operating supplies', reviewer_note: 'Stationery, not sales.' },
        actorId: 'dmem-w0', returnSnapshot: false
      });
      const distillCalls = appliance.providers.calls.filter((call) => call.lane === 'memory_extraction');
      assert.equal(distillCalls.length, 1, `the review writer called the distiller once after commit: ${JSON.stringify(appliance.providers.calls.map((c) => [c.lane, c.status]))}`);
      const facts = (await appliance.query('select id, scope, subject, fact, status, provenance from firm_facts where firm_id = $1 order by created_at', [firmId])).rows;
      const candidates = (await appliance.query('select id, client_id, status, minted_fact_id from memory_candidates where firm_id = $1 order by created_at', [firmId])).rows;

      await t.test('L1b database state — an ordinary correction mints no active fact', () => {
        assert.deepEqual(facts.filter((fact) => fact.status === 'active').map((fact) => fact.subject), [], S04_FINGERPRINTS.L1b);
      });

      await t.test('L1c database state — the candidate rests suggested, never pre-promoted', () => {
        assert.ok(candidates.length >= 1, layerMessage(S, 1, 'the correction staged a governance candidate'));
        assert.deepEqual(candidates.map((row) => row.status), candidates.map(() => 'suggested'), S04_FINGERPRINTS.L1c);
      });

      await t.test('L3 receipt — memory_minted is derived from the committed effect', () => {
        const receipt = buildCorrectionTeachingReceipt({ action, changedCount: 1 });
        const committedFacts = facts.filter((fact) => fact.status === 'active').length;
        assert.equal(receipt.memory_minted, committedFacts > 0, S04_FINGERPRINTS.L3);
      });

      await t.test('L2b isolation — the entity-keyed fact and A\'s rule never reach client B', async () => {
        const factsForB = await withFirmDbClient((client) => getFirmFactsForSubjects({ client, firmId, clientId: clientB, subjects: [{ scope: 'merchant', value: 'ACME SUPPLIES LTD' }] }));
        assert.deepEqual(factsForB, [], layerMessage(S, 2, 'client B retrieves none of the merchant facts client A\'s correction minted (entity-keyed since PR-3)'));
        const rowB = (await appliance.read.transactions(clientB)).find((tx) => tx.id === lineB);
        assert.equal(rowB.payload?.matched_client_rule_id ?? null, null, layerMessage(S, 2, 'A\'s rule cascade never touched B\'s line'));
      });
    } finally {
      await appliance.stop();
    }
  }
);
