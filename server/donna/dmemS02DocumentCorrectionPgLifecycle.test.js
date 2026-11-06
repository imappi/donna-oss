// DMEM-R1 W0 — S02, document correction (forensic §13.2; docs/audit-2026-09-04-memory-re-baseline.md
// §1 F-07 / F-08, canaries 3 and 13; ACC-F07, ACC-F08, ACC-C03, ACC-C13).
//
// PASSES on the current tree (W1 flipped L1/L2; FI-02 flipped L3/L4, 2026-10-15).
// The real desktop path on the RT-06 harness (RT-11's recipe): the two-line
// Barclays statement parses, the Ochre Lighting bill (550 GBP) parses and the
// strong matcher settles it on the 550 line at 0.94 (auto-reconciled under the
// seeded material-FYI policy). Then the firm corrects the bill's total through the
// REAL correction writer (`recordDocumentCorrectionInDb`). The doctrine (INV-11):
// a material correction makes every dependent match / evaluation generation
// ineligible immediately and requires fresh matching before the goal is terminal
// again; and a correction example is scoped to its legal entity (INV-12). The
// tree before W1/FI-02: the match stayed settled, the line stayed explained, the
// reopen was a LOOPS-gated `goal.regressed` that requested no fresh match, and the
// correction entered every client's extraction prompt.

import test from 'node:test';
import assert from 'node:assert/strict';

import { bootApplianceForTest, applianceHarnessSkipReason } from './testSupport/applianceHarness.js';
import { layerMessage } from './testSupport/dmemFixtureSupport.js';
import { recordDocumentCorrectionInDb, getRecentFirmCorrectionsFromDb, buildCorrectionsPromptFragment } from './documentCorrections.js';

const S = 'S02';
export const S02_FINGERPRINTS = Object.freeze({
  L1: layerMessage(S, 1, 'a material correction to a settled document makes its match ineligible immediately (the match no longer settles the line)'),
  L2: layerMessage(S, 2, 'a correction recorded on one legal entity never enters another legal entity\'s extraction prompt'),
  L3: layerMessage(S, 3, 'after a material correction a fresh evaluation is requested before the reconciliation goal can be terminal again'),
  L4: layerMessage(S, 4, 'the corrected document\'s bank line is no longer settled by the stale match (its reconciliation status reopens)')
});

const SETTLING = new Set(['auto_matched', 'confirmed']);

test(
  'real PG (appliance, DMEM S02): correcting a settled bill\'s total invalidates and reopens its match and keeps the example on its legal entity',
  { skip: applianceHarnessSkipReason() },
  async (t) => {
    const appliance = await bootApplianceForTest({ now: new Date('2026-08-31T09:00:00.000Z') });
    try {
      const { firmId } = appliance;
      const { clientId } = await appliance.createClient();
      const { clientId: otherClientId } = await appliance.createClient({ profile: { companyName: 'Dune Apparel Ltd' } });

      appliance.providers.script('document_routing', ['document_routing/kestrel-bank-statement']);
      appliance.providers.script('bank_statement_extraction', ['bank_statement_extraction/kestrel-barclays-two-lines']);
      appliance.providers.script('transaction_coding', [{ status: 418, body: { error: { type: 'fixture_lane_dark', message: 'coding is not what this fixture proves' } }, times: Infinity }]);
      appliance.providers.script('bank_line_disposition', ['bank_line_disposition/kestrel-ochre-debit-chase-receipt', 'bank_line_disposition/kestrel-paylink-credit-chase-evidence']);
      appliance.providers.script('ask_drafting', [{ status: 503, times: Infinity }]);
      const statement = await appliance.uploadDocument({ clientId, fixture: 'bank_statement_two_lines' });
      const statementTick = await appliance.tick();
      const statementDoc = await appliance.read.document(statement.documentId);
      assert.equal(statementDoc.parse_status, 'completed', JSON.stringify({ parse: statementDoc.parse_error, jobs: statementTick.jobs.map((j) => [j.function_id, j.status, j.last_error]) }));
      const ochreLine = (await appliance.read.transactions(clientId)).find((tx) => Number(tx.money_out) === 550);
      assert.ok(ochreLine, 'the 550 GBP payment is on the feed');

      appliance.providers.script('document_routing', ['document_routing/ochre-supplier-bill']);
      appliance.providers.script('unified_extraction', ['unified_extraction/ochre-discount-line']);
      appliance.providers.script('reconciliation_reasoning', ['reconciliation_reasoning/ochre-bill-settled-by-candidate-1']);
      const bill = await appliance.uploadDocument({ clientId, fixture: 'supplier_bill_discount' });
      const billTick = await appliance.tick();
      const billDoc = await appliance.read.document(bill.documentId);
      assert.equal(billDoc.parse_status, 'completed', JSON.stringify({ parse: billDoc.parse_error, jobs: billTick.jobs.map((j) => [j.function_id, j.status, j.last_error]), calls: appliance.providers.calls.map((c) => [c.lane, c.status]) }));
      const settled = (await appliance.read.matches(clientId)).find((row) => row.matched_object_id === bill.documentId);
      assert.ok(settled && SETTLING.has(settled.status), `the matcher settled the bill on the 550 line: ${JSON.stringify(settled)}`);
      assert.equal(settled.bank_transaction_id, ochreLine.id);
      const lineBefore = (await appliance.read.transactions(clientId)).find((tx) => tx.id === ochreLine.id);
      assert.equal(lineBefore.reconciliation_status, 'explained', 'the line is settled before the correction');

      // ── The material correction, through the real writer. ──
      const correction = await recordDocumentCorrectionInDb({ firmId, documentId: bill.documentId, fieldPath: 'total_amount', correctedValue: 495, correctedBy: 'dmem-w0' });
      assert.ok(correction?.id, 'the correction row was written');
      await appliance.tick({ functions: ['parse-cron:loops_inbox'] });
      const matchAfter = (await appliance.read.matches(clientId)).find((row) => row.id === settled.id);
      const lineAfter = (await appliance.read.transactions(clientId)).find((tx) => tx.id === ochreLine.id);
      const docAfter = await appliance.read.document(bill.documentId);

      await t.test('L1a database state — the correction is recorded and written back', () => {
        assert.equal(Number(docAfter.total_amount), 495, layerMessage(S, 1, 'the corrected total is the document\'s current value'));
        assert.equal(docAfter.convergence_state !== undefined, true, layerMessage(S, 1, 'the persisted convergence column is read, never an in-memory projection'));
      });

      await t.test('L1 database state — the stale match is ineligible after a material correction', () => {
        assert.ok(!SETTLING.has(matchAfter.status) || matchAfter.payload?.invalidated_by_correction, S02_FINGERPRINTS.L1);
      });

      await t.test('L2 prompt receipt — the correction example is scoped to its legal entity', async () => {
        // The exact call the parse worker makes for a document of the OTHER client
        // (inngest/parseDocument.js:1767 → unifiedExtractor.js:257).
        const priorCorrections = await getRecentFirmCorrectionsFromDb({ firmId, limit: 20 });
        const fragmentForOtherClient = buildCorrectionsPromptFragment(priorCorrections, { documentType: 'supplier_bill' });
        assert.equal(fragmentForOtherClient, '', S02_FINGERPRINTS.L2);
        assert.ok(otherClientId, 'the other legal entity exists');
      });

      await t.test('L3 decision — a fresh evaluation is requested before the goal is terminal again', async () => {
        const requested = (await appliance.query(
          "select id, event_type, status from loop_event_outbox where firm_id = $1 and client_id = $2 and event_type = 'reconciliation.evaluation_requested'",
          [firmId, clientId]
        )).rows;
        const evaluations = await appliance.read.evaluations(clientId, { targetId: bill.documentId });
        const correctedAtMs = new Date(correction.corrected_at).getTime();
        const staleSettled = evaluations.filter((row) => new Date(row.evaluated_at).getTime() < correctedAtMs && row.verdict !== 'superseded');
        assert.ok(evaluations.length >= 1, layerMessage(S, 3, 'the matcher left an evaluation on the document before the correction'));
        assert.ok(requested.length >= 1 || staleSettled.length === 0, S02_FINGERPRINTS.L3);
      });

      await t.test('L4 accounting outcome — the line reopens instead of resting on the stale match', () => {
        assert.notEqual(lineAfter.reconciliation_status, 'explained', S02_FINGERPRINTS.L4);
        assert.notEqual(lineAfter.convergence_state, 'auto_reconciled', S02_FINGERPRINTS.L4);
      });
    } finally {
      await appliance.stop();
    }
  }
);
