// DMEM-R1 W0 — S10, the LR-2 before-state: an ask that is sent and never sent
// (docs/audit-2026-09-04-memory-re-baseline.md §1 F-11, §7 S10; ACC-F11).
//
// EXPECTED FAILURE on the current tree (registered in scripts/run-tests.mjs).
// The REAL ask writer (`createClientEvidenceRequestInDb` → the one chokepoint in
// db/asks.js) mints a request for a bank line that no channel will ever deliver.
// The doctrine (INV-14): drafted, queued, sent and delivered are distinct,
// event-backed states — a mint is a DRAFT and carries no sent stamp until a
// deliverer sends. The tree stamps `first_sent_at` / `last_sent_at` and the
// payload's `sent_at` at mint with `send_count 0`: the exact contradiction the
// forensic review found on all 18 live requests (F-11). W1 flips L1/L2 (the mint
// becomes a non-sent draft); the census predicate (§5.2) is what LR-2 targets.
//
// Layers: L1 database state · L2 the retrieval/read models (the case timeline,
// the re-ask cadence's clock) · L3 the receipt · L4 the zero-effect oracle.

import test from 'node:test';
import assert from 'node:assert/strict';

import { bootApplianceForTest, applianceHarnessSkipReason } from './testSupport/applianceHarness.js';
import { layerMessage, seedBankLine, zeroEffectOracle } from './testSupport/dmemFixtureSupport.js';
import { createClientEvidenceRequestInDb } from './firmDb.js';
import { buildCaseTimeline } from './caseTimeline.js';

const S = 'S10';
export const S10_FINGERPRINTS = Object.freeze({
  L1: layerMessage(S, 1, 'a minted ask carries no sent stamp until a deliverer sends it (first_sent_at, last_sent_at and payload sent_at stay null while send_count is 0)'),
  L2: layerMessage(S, 2, 'the case timeline renders no ask_sent event for an ask that was never delivered')
});

test(
  'real PG (appliance, DMEM S10): the ask writer mints a request that reads as sent and never sent',
  { skip: applianceHarnessSkipReason() },
  async (t) => {
    const appliance = await bootApplianceForTest({ now: new Date('2026-09-04T09:00:00.000Z') });
    try {
      const { firmId } = appliance;
      const { clientId } = await appliance.createClient();
      const transactionId = await seedBankLine(appliance.query, {
        firmId, clientId, id: `${clientId}-tx-screwfix-1`, date: '2026-08-22', description: 'SCREWFIX DIRECT LTD', moneyOut: 42.99
      });
      const oracle = await zeroEffectOracle(appliance.query, { firmId });

      await createClientEvidenceRequestInDb({
        firmId, clientId, transactionId,
        question: 'Please send the Screwfix receipt for 22 Aug (42.99 GBP).',
        evidenceType: 'supporting_document',
        actorId: 'dmem-w0',
        returnSnapshot: false
      });
      const asks = await appliance.read.asks(clientId);
      assert.equal(asks.length, 1, 'the writer minted exactly one request');
      const ask = asks[0];
      const transaction = (await appliance.read.transactions(clientId)).find((tx) => tx.id === transactionId);

      await t.test('L1 database state — a mint is a draft, not a send', () => {
        assert.equal(ask.send_count, 0, layerMessage(S, 1, 'send_count is 0 at mint (only a deliverer bumps it)'));
        assert.equal(ask.first_sent_at, null, S10_FINGERPRINTS.L1);
        assert.equal(ask.last_sent_at, null, S10_FINGERPRINTS.L1);
        assert.equal(ask.request_payload?.evidence_request?.sent_at ?? null, null, S10_FINGERPRINTS.L1);
        assert.equal(ask.status, 'draft', layerMessage(S, 1, 'an undelivered ask rests draft, never open'));
      });

      await t.test('L2 read models — no ask_sent event, no re-ask clock, and the LR-2 census predicate names the row', async () => {
        const timeline = buildCaseTimeline({ transaction, evidenceRequests: [ask], auditEvents: [] });
        const events = Array.isArray(timeline?.events) ? timeline.events : (Array.isArray(timeline) ? timeline : []);
        assert.ok(!events.some((event) => event.kind === 'ask_sent'), S10_FINGERPRINTS.L2);
        const census = await appliance.query(
          `select id from client_evidence_requests
            where firm_id = $1 and send_count = 0
              and (first_sent_at is not null or last_sent_at is not null or request_payload->'evidence_request'->>'sent_at' is not null)`,
          [firmId]
        );
        assert.deepEqual(census.rows, [], layerMessage(S, 2, 'the LR-2 census predicate (§5.2) finds no contradictory row after the writer ran'));
      });

      await t.test('L3 receipt — the mint receipts a draft and never claims a send', async () => {
        const receipts = await appliance.read.audit({ clientId });
        const claimsSent = receipts.filter((row) => row.resource_id === ask.id && /sent|delivered/i.test(String(row.action)));
        assert.deepEqual(claimsSent, [], layerMessage(S, 3, 'no audit receipt on the minted request claims sent or delivered'));
      });

      await t.test('L4 zero-effect oracle — the mint posts nothing and writes only what it declares', async () => {
        const mintReceipts = (await appliance.read.audit({ clientId })).filter((row) => row.resource_id === ask.id).length;
        const diff = await oracle.diffAgainst({ client_evidence_requests: 1, audit_events: mintReceipts });
        assert.equal(diff.effectUnchanged, true, layerMessage(S, 4, 'the accounting-effect hash is unchanged by an ask mint'));
        assert.deepEqual(diff.unauthorizedWrites, {}, layerMessage(S, 4, 'no undeclared row was written by the ask mint'));
      });
    } finally {
      await appliance.stop();
    }
  }
);
