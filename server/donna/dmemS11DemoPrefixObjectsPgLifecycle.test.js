// DMEM-R1 W0 — S11, the LR-3 before-state: evidence under a foreign (demo-firm)
// namespace and the destructive cleanup that follows it
// (docs/audit-2026-09-04-memory-re-baseline.md §1 F-12, §7 S11; ACC-F12).
//
// EXPECTED FAILURE on the current tree (registered in scripts/run-tests.mjs), with
// RT-03's containment PINNED. A real receipt goes through the real routes and
// lands under the firm's OWN prefix (RT-03: the resolver runs before the key is
// built). Then the live appliance's residue is reproduced: an object stored under
// `donna-demo-firm/…` that no document references, older than the sweep's grace,
// plus a document row whose key still carries the demo prefix (the 31 live rows).
// The REAL cleanup task (`runParseCronTask({ task: 'storage_orphans' })`, api.js)
// runs. The doctrine (INV-15): trusted identity is resolved BEFORE a destructive
// cleanup target is constructed; ownership or audit that cannot be proven fails
// closed. The tree deletes the foreign-prefixed object first and only then tries
// to attribute it — a prefix that is not a firm on this book is "deleted without
// firm attribution" with a console warning and no receipt.

import test from 'node:test';
import assert from 'node:assert/strict';

import { bootApplianceForTest, applianceHarnessSkipReason } from './testSupport/applianceHarness.js';
import { layerMessage, zeroEffectOracle } from './testSupport/dmemFixtureSupport.js';
import { runParseCronTask } from './api.js';
import { storeLocalEvidenceBytes } from './evidenceStorage.js';

const S = 'S11';
export const S11_FINGERPRINTS = Object.freeze({
  L1: layerMessage(S, 1, 'destructive cleanup refuses an object whose key prefix is not a firm on this book — the object is kept and the refusal receipted, never deleted unaudited'),
  L3: layerMessage(S, 3, 'every object the cleanup deleted has an audit receipt (deleted_total equals the storage_orphan_cleaned receipts)')
});

test(
  'real PG (appliance, DMEM S11): new keys land under the firm (RT-03); a foreign-prefixed orphan is deleted without a receipt',
  { skip: applianceHarnessSkipReason() },
  async (t) => {
    const appliance = await bootApplianceForTest({ now: new Date('2026-08-31T09:00:00.000Z') });
    try {
      const { firmId } = appliance;
      const { clientId } = await appliance.createClient();
      appliance.providers.script('document_routing', ['document_routing/screwfix-receipt']);
      appliance.providers.script('unified_extraction', ['unified_extraction/screwfix-receipt']);
      appliance.providers.script('reconciliation_reasoning', ['reconciliation_reasoning/no-plausible-match']);
      appliance.providers.script('document_disposition', [{ status: 418, body: { error: { type: 'fixture_lane_dark', message: 'document disposition is not what this fixture proves' } }, times: Infinity }]);
      appliance.providers.script('transaction_coding', [{ status: 418, body: { error: { type: 'fixture_lane_dark', message: 'coding is not what this fixture proves' } }, times: Infinity }]);
      appliance.providers.script('ask_drafting', [{ status: 503, times: Infinity }]);
      const receipt = await appliance.uploadDocument({ clientId, fixture: 'receipt_screwfix' });
      await appliance.tick();
      const receiptRow = await appliance.read.document(receipt.documentId);
      assert.equal(receiptRow.parse_status, 'completed');
      const bucket = receiptRow.storage_bucket;

      await t.test('L1a database state — a new key is prefixed by the firm that owns it (RT-03)', () => {
        assert.equal(receiptRow.storage_object_key.split('/')[0], firmId, layerMessage(S, 1, `the upload key is under the resolved firm: ${receiptRow.storage_object_key}`));
        assert.equal(receiptRow.storage_object_key.split('/')[1], clientId, layerMessage(S, 1, 'and the client'));
      });

      // ── The live residue: a foreign-prefixed orphan object + a demo-prefixed document row. ──
      const orphanKey = `donna-demo-firm/${clientId}/dmem-w0-orphan.pdf`;
      await storeLocalEvidenceBytes({ bucket, key: orphanKey, bytes: Buffer.from('%PDF-1.4\n%dmem-w0-orphan\n'), contentType: 'application/pdf' });
      await appliance.query("update local_evidence_objects set created_at = now() - interval '3 hours' where bucket = $1 and key = $2", [bucket, orphanKey]);
      assert.ok(await appliance.read.localEvidence(orphanKey), 'the foreign-prefixed object is in the store');
      // W1: an ORDINARY aged orphan under the firm's own prefix, so the sweep has
      // one object it may delete (with its receipt) next to the one it must refuse.
      const ownOrphanKey = `${firmId}/${clientId}/dmem-w1-own-orphan.pdf`;
      await storeLocalEvidenceBytes({ bucket, key: ownOrphanKey, bytes: Buffer.from('%PDF-1.4\n%dmem-w1-own-orphan\n'), contentType: 'application/pdf' });
      await appliance.query("update local_evidence_objects set created_at = now() - interval '3 hours' where bucket = $1 and key = $2", [bucket, ownOrphanKey]);
      const legacyDocId = `${clientId}-doc-legacy-demo-prefixed`;
      await appliance.query(
        `insert into documents (id, firm_id, client_id, filename, document_type, status, storage_bucket, storage_object_key, parse_status, uploaded_at)
         values ($1, $2, $3, 'legacy-receipt.pdf', 'receipt', 'received', $4, $5, 'completed', now())`,
        [legacyDocId, firmId, clientId, bucket, `donna-demo-firm/${clientId}/legacy-receipt.pdf`]
      );
      const oracle = await zeroEffectOracle(appliance.query, { firmId });

      await t.test('L1b census — the LR-3 target-list predicate (§5.3) names exactly the demo-prefixed row', async () => {
        const rows = (await appliance.query(
          "select id from documents where firm_id = $1 and (storage_object_key like 'donna-demo-firm/%' or split_part(storage_object_key, '/', 1) <> firm_id) order by id",
          [firmId]
        )).rows.map((row) => row.id);
        assert.deepEqual(rows, [legacyDocId], layerMessage(S, 1, 'the census predicate finds the mis-keyed row and nothing else'));
      });

      const summary = await runParseCronTask({ task: 'storage_orphans', authorizedAs: 'dmem-w0' });
      const orphanAfter = await appliance.read.localEvidence(orphanKey);
      const ownOrphanAfter = await appliance.read.localEvidence(ownOrphanKey);
      const receipts = (await appliance.query("select id, action, metadata from audit_events where firm_id = $1 and action = 'storage.orphan_cleaned'", [firmId])).rows;
      const refusals = (await appliance.query("select id, action, metadata from audit_events where firm_id = $1 and action = 'storage.cleanup_refused_foreign_prefix'", [firmId])).rows;
      const authorizations = (await appliance.query("select id, action, metadata from audit_events where firm_id = $1 and action = 'storage.cleanup_authorized'", [firmId])).rows;

      await t.test('L1 database state — a foreign-prefixed object is never deleted unaudited', () => {
        const receiptedForKey = receipts.some((row) => row.metadata?.key === orphanKey);
        assert.ok(orphanAfter !== null || receiptedForKey, S11_FINGERPRINTS.L1);
        // W1: it is REFUSED — kept, and the refusal receipted on the book's sole firm.
        assert.notEqual(orphanAfter, null, layerMessage(S, 1, 'the foreign-prefixed object is kept'));
        assert.ok(refusals.some((row) => row.metadata?.key === orphanKey && row.metadata?.kept === true), layerMessage(S, 1, 'the refusal is receipted with the key'));
        assert.equal(Number(summary?.storage_orphans?.refused_total ?? 0), 1, layerMessage(S, 1, 'the run summary counts the refusal'));
      });

      await t.test('L3 receipt — every deletion has its receipt', () => {
        const deleted = Number(summary?.storage_orphans?.deleted_total ?? 0);
        assert.ok(deleted >= 1, layerMessage(S, 3, `the sweep deleted the aged own-prefix orphan: ${JSON.stringify(summary?.storage_orphans)}`));
        assert.equal(ownOrphanAfter, null, layerMessage(S, 3, 'the own-prefix orphan is gone'));
        assert.equal(receipts.length, deleted, S11_FINGERPRINTS.L3);
        // W1: audit BEFORE delete — the authorization receipt precedes each cleaned receipt for the same key.
        assert.ok(authorizations.some((row) => row.metadata?.key === ownOrphanKey), layerMessage(S, 3, 'the delete was authorized in the audit trail before it ran'));
        assert.ok(receipts.every((row) => authorizations.some((auth) => auth.metadata?.key === row.metadata?.key && auth.id < row.id)), layerMessage(S, 3, 'every cleaned receipt has an earlier authorization for its key'));
      });

      await t.test('L4 zero-effect oracle — cleanup posts nothing and touches no memory-plane row', async () => {
        const diff = await oracle.diffAgainst({});
        assert.equal(diff.effectUnchanged, true, layerMessage(S, 4, 'the accounting-effect hash is unchanged by cleanup'));
        const undeclared = Object.keys(diff.unauthorizedWrites).filter((table) => table !== 'audit_events');
        assert.deepEqual(undeclared, [], layerMessage(S, 4, `cleanup wrote no memory-plane row: ${JSON.stringify(diff.unauthorizedWrites)}`));
      });
    } finally {
      await appliance.stop();
    }
  }
);
