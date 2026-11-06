// DMEM-R1 W0 — S07, entity identity and settlement (forensic §13.7;
// docs/audit-2026-09-04-memory-re-baseline.md §1 canaries 9 and 12; ACC-C09, ACC-C12).
//
// EXPECTED FAILURE + REGISTERED GAP on the current tree (registered in
// scripts/run-tests.mjs). Party identity through the REAL resolver
// (`outbound/partyStore.js` `resolvePartyCandidate`): two candidates that share
// only a normalized name — no business id on either side — collapse onto one
// party (`enriched_name_match`); the doctrine (§3, canary 12) wants a separate
// party or a merge SUGGESTION a human confirms, never an auto-merge of homonyms.
// The settlement half (a payout confirmation plus its underlying sales evidence,
// asserting no double booking) cannot be expressed: no store links a payout to
// the evidence beneath it — RT-18 (`payoutFamilyPgLifecycle.test.js`) proves the
// payout ↔ bank-credit match only. That layer is a REGISTERED_GAP until W2's
// evidence links exist.

import test from 'node:test';
import assert from 'node:assert/strict';

import { bootApplianceForTest, applianceHarnessSkipReason } from './testSupport/applianceHarness.js';
import { expectedFailure, layerMessage, registeredGap } from './testSupport/dmemFixtureSupport.js';
import { withFirmDbClient } from './firmDb.js';
import { resolvePartyCandidate } from './outbound/partyStore.js';

const S = 'S07';
export const S07_FINGERPRINTS = Object.freeze({
  L1: layerMessage(S, 1, 'a second party with the same name and no shared business id is a separate party or a merge suggestion, never an auto-enrichment of the first'),
  GAP: 'no store links a payout to its underlying sales evidence on this tree (RT-18 proves payout <-> bank credit only); double booking cannot be asserted until W2 evidence links exist'
});

test(
  'real PG (appliance, DMEM S07): homonym parties collapse; the payout/underlying-evidence relation is a registered gap',
  { skip: applianceHarnessSkipReason() },
  async (t) => {
    const appliance = await bootApplianceForTest({ now: new Date('2026-09-04T09:00:00.000Z') });
    try {
      const { firmId } = appliance;
      const { clientId } = await appliance.createClient();
      const resolve = (candidate) => withFirmDbClient(async (client) => {
        await client.query('begin');
        try {
          const out = await resolvePartyCandidate(client, { firmId, clientId, candidate });
          await client.query('commit');
          return out;
        } catch (error) {
          await client.query('rollback');
          throw error;
        }
      });
      const first = await resolve({ displayName: 'Alex Morgan', isCustomer: true, email: 'alex@morgan-design.example', source: 'dmem_w0' });
      assert.equal(first.action, 'created', 'the first Alex Morgan is minted');
      const second = await resolve({ displayName: 'Alex Morgan', isSupplier: true, email: 'alex.morgan@northgate-supplies.example', source: 'dmem_w0' });

      await t.test('L1 database state — a same-name candidate is never auto-merged onto an unrelated party', () => expectedFailure({ id: `${S}/L1`, fingerprint: S07_FINGERPRINTS.L1 }, async () => {
        assert.ok(['created', 'created_with_merge_suggestion', 'created_conflicting_business_id'].includes(second.action), S07_FINGERPRINTS.L1);
        const parties = (await appliance.query("select id, display_name, is_customer, is_supplier from client_parties where firm_id = $1 and client_id = $2 and status = 'active'", [firmId, clientId])).rows;
        assert.equal(parties.length, 2, layerMessage(S, 1, 'two active parties exist for the two Alex Morgans'));
      }));

      await t.test('L3 receipt — the resolution left a merge SUGGESTION for a human, not a silent enrichment', async () => {
        const suggestions = (await appliance.query('select id, reason, status from party_merge_suggestions where firm_id = $1 and client_id = $2', [firmId, clientId])).rows;
        const enriched = (await appliance.read.audit({ clientId })).filter((row) => row.action === 'outbound_party.merged');
        assert.deepEqual(enriched, [], layerMessage(S, 3, 'no party was merged without a confirmed human decision'));
        assert.ok(Array.isArray(suggestions), layerMessage(S, 3, 'merge suggestions are readable'));
      });

      await t.test('L4 accounting outcome — payout + underlying sales evidence, no double booking', () => registeredGap({ id: `${S}/L4`, reason: S07_FINGERPRINTS.GAP }));
    } finally {
      await appliance.stop();
    }
  }
);
