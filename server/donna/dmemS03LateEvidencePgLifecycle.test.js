// DMEM-R1 W0 — S03, late evidence (forensic §13.3; docs/audit-2026-09-04-memory-re-baseline.md
// §1 F-11, canary 4; ACC-F11, ACC-C04).
//
// Regression proof for the repaired late-evidence and delivery lifecycle.
// The real desktop path, end to
// end: the statement parses and the coder (the committed recording) proposes both
// lines; the coding-convergence sweep mints Donna's OWN owner ask for the
// unevidenced material Ochre line through the one ask writer; the disposition
// pass had already searched and found no receipt (chase_receipt, a `no_match`
// verdict). Then the bill arrives and the matcher settles the line. What holds
// today: RT-11 D3 resolves the document ask from the match, migration 131
// supersedes the stale `no_match` (the earlier search/no-match conclusion is
// ineligible for current use — doctrine §4.2), and the next coding tick refreshes
// the verdict on the changed evidence and posts the settled line. The ask
// remains a draft until an actual delivery event (INV-14).

import test from 'node:test';
import assert from 'node:assert/strict';

import { bootApplianceForTest, applianceHarnessSkipReason } from './testSupport/applianceHarness.js';
import { loadRecording } from './testSupport/recordedProviders.js';
import { layerMessage } from './testSupport/dmemFixtureSupport.js';

const S = 'S03';
const CODING_CONVERGENCE_FUNCTION_ID = 'parse-cron:coding_convergence';
export const S03_FINGERPRINTS = Object.freeze({
  L1: layerMessage(S, 1, 'the ask Donna minted for the missing receipt rests draft with no sent stamp until a channel delivers it')
});

const codingRecordingFor = ({ payoutTransactionId, ochreTransactionId }) => {
  const recording = loadRecording('transaction_coding/kestrel-two-lines-coded');
  const body = JSON.parse(JSON.stringify(recording.body));
  body.output[0].content[0].text = body.output[0].content[0].text
    .split('__TX_PAYOUT__').join(payoutTransactionId)
    .split('__TX_OCHRE__').join(ochreTransactionId);
  return { status: recording.status, body };
};

test(
  'real PG (appliance, DMEM S03): late evidence resolves the draft ask, supersedes stale no_match and refreshes coding before posting',
  { skip: applianceHarnessSkipReason() },
  async (t) => {
    const appliance = await bootApplianceForTest({ now: new Date('2026-08-31T09:00:00.000Z') });
    try {
      const { clientId } = await appliance.createClient();
      appliance.providers.script('document_routing', ['document_routing/kestrel-bank-statement']);
      appliance.providers.script('bank_statement_extraction', ['bank_statement_extraction/kestrel-barclays-two-lines']);
      appliance.providers.script('bank_line_disposition', ['bank_line_disposition/kestrel-ochre-debit-chase-receipt', 'bank_line_disposition/kestrel-paylink-credit-chase-evidence']);
      appliance.providers.script('ask_drafting', [{ status: 503, times: Infinity }]);
      const statement = await appliance.uploadDocument({ clientId, fixture: 'bank_statement_two_lines' });
      const payoutTransactionId = `${statement.documentId}-tx-0`;
      const ochreTransactionId = `${statement.documentId}-tx-1`;
      appliance.providers.script('transaction_coding', [codingRecordingFor({ payoutTransactionId, ochreTransactionId })]);
      const statementTick = await appliance.tick();
      const statementDoc = await appliance.read.document(statement.documentId);
      assert.equal(statementDoc.parse_status, 'completed', JSON.stringify({ parse: statementDoc.parse_error, jobs: statementTick.jobs.map((j) => [j.function_id, j.status, j.last_error]) }));
      const searchedNotFound = (await appliance.read.evaluations(clientId, { targetId: ochreTransactionId })).find((row) => row.matcher_family === 'bank_line_disposition');
      assert.equal(searchedNotFound?.verdict, 'no_match', 'the disposition pass searched and found no receipt for the 550 line');
      assert.equal(searchedNotFound?.payload?.disposition, 'chase_receipt');

      // ── Donna's own ask, minted by the coding-convergence sweep through the ONE ask writer. ──
      await appliance.tick({ functions: [CODING_CONVERGENCE_FUNCTION_ID], advanceMs: 5 * 60_000 });
      const askBefore = (await appliance.read.asks(clientId)).find((row) => row.transaction_id === ochreTransactionId);
      assert.ok(askBefore, `the sweep minted an owner ask for the unevidenced material line: ${JSON.stringify((await appliance.read.asks(clientId)).map((row) => [row.transaction_id, row.evidence_type, row.status]))}`);
      const lineAsked = (await appliance.read.transactions(clientId)).find((tx) => tx.id === ochreTransactionId);
      assert.equal(lineAsked.coding_state, 'asked', 'the ask flipped the line to ASKED (RT-16)');

      await t.test('L1 database state — the ask Donna minted is a draft until delivered', () => {
        assert.equal(askBefore.send_count, 0, layerMessage(S, 1, 'nothing delivered it (the drafter was refused, no channel is bound)'));
        assert.equal(askBefore.first_sent_at, null, S03_FINGERPRINTS.L1);
        assert.equal(askBefore.status, 'draft', S03_FINGERPRINTS.L1);
      });

      // ── The late evidence: the bill arrives and settles the line. ──
      appliance.providers.script('document_routing', ['document_routing/ochre-supplier-bill']);
      appliance.providers.script('unified_extraction', ['unified_extraction/ochre-discount-line']);
      appliance.providers.script('reconciliation_reasoning', ['reconciliation_reasoning/ochre-bill-settled-by-candidate-1']);
      const bill = await appliance.uploadDocument({ clientId, fixture: 'supplier_bill_discount' });
      const billTick = await appliance.tick();
      const billDoc = await appliance.read.document(bill.documentId);
      assert.equal(billDoc.parse_status, 'completed', JSON.stringify({ parse: billDoc.parse_error, jobs: billTick.jobs.map((j) => [j.function_id, j.status, j.last_error]), calls: appliance.providers.calls.map((c) => [c.lane, c.status]) }));
      const match = (await appliance.read.matches(clientId)).find((row) => row.matched_object_id === bill.documentId);
      assert.ok(match && ['auto_matched', 'confirmed'].includes(match.status), `the late bill settled the line: ${JSON.stringify(match)}`);

      await t.test('L2 database state — the earlier searched-but-not-found conclusion is ineligible for current use (migration 131)', async () => {
        const disposition = (await appliance.read.evaluations(clientId, { targetId: ochreTransactionId })).find((row) => row.matcher_family === 'bank_line_disposition');
        assert.equal(disposition?.verdict, 'superseded', layerMessage(S, 2, `the stale no_match is superseded by the settling match: ${JSON.stringify(disposition)}`));
        assert.equal(disposition?.payload?.superseded_by_match_id, match.id, layerMessage(S, 2, 'the supersession names the match that made it stale'));
      });

      await t.test('L3 decision — the late evidence resolves the document ask (RT-11 D3) with a receipt', async () => {
        const askAfter = (await appliance.read.asks(clientId)).find((row) => row.id === askBefore.id);
        assert.equal(askAfter.status, 'resolved', layerMessage(S, 3, `the document ask is answered by the match: ${JSON.stringify([askAfter.evidence_type, askAfter.status, askAfter.response_payload])}`));
        assert.equal(askAfter.response_payload?.auto_resolved_by_match, true);
        const receipts = await appliance.read.audit({ clientId, action: 'client_evidence_request.auto_resolved_by_match' });
        assert.ok(receipts.length >= 1, layerMessage(S, 3, 'the resolution is receipted'));
      });

      await t.test('L4 accounting outcome — the next coding tick reconsiders and posts the settled line; the persisted column carries it', async () => {
        const freshCoding = codingRecordingFor({ payoutTransactionId, ochreTransactionId });
        const answer = JSON.parse(freshCoding.body.output[0].content[0].text);
        answer.suggestions = answer.suggestions.filter(row => row.transaction_id === ochreTransactionId);
        freshCoding.body.output[0].content[0].text = JSON.stringify(answer);
        appliance.providers.script('transaction_coding', [freshCoding]);
        const payoutBefore = (await appliance.read.transactions(clientId)).find(tx => tx.id === payoutTransactionId);
        await appliance.tick({ functions: [CODING_CONVERGENCE_FUNCTION_ID], advanceMs: 5 * 60_000 });
        const line = (await appliance.read.transactions(clientId)).find((tx) => tx.id === ochreTransactionId);
        assert.ok(['explained', 'reconciled', 'posted'].includes(line.reconciliation_status), layerMessage(S, 4, `the line is settled by the late evidence and posted by the sweep: ${line.reconciliation_status}`));
        assert.ok(['applied', 'posted'].includes(line.coding_state), layerMessage(S, 4, `the released line is coded on the matched evidence: ${line.coding_state}`));
        assert.equal(line.convergence_state, 'auto_reconciled', layerMessage(S, 4, `the persisted column is the verdict: ${line.convergence_reason}`));
        assert.equal(line.coding_state,'posted','fresh coding reaches the existing journal writer');
        const payoutAfter = (await appliance.read.transactions(clientId)).find(tx => tx.id === payoutTransactionId);
        assert.equal(payoutAfter.coding_state,payoutBefore.coding_state,'the unrelated payout remains on the owner');
        assert.deepEqual(payoutAfter.coding_state_as_of,payoutBefore.coding_state_as_of,'the unrelated payout is not reconsidered');
        assert.equal(appliance.providers.calls.filter(call=>call.lane==='transaction_coding').length,2,
          'exactly the initial recording and one late-evidence reconsideration');
        const journals = (await appliance.query(`select l.account_name,l.debit,l.credit from ledger_journals j
          join ledger_lines l on l.journal_id=j.id where j.firm_id=$1 and j.client_id=$2 and j.source_id=$3 order by l.line_no`,
        [appliance.firmId,clientId,ochreTransactionId])).rows;
        assert.deepEqual(journals.map(row=>[Number(row.debit),Number(row.credit)]).sort(),[[0,550],[550,0]],
          'the unchanged recorded economics produce exactly one expense/bank journal');
        assert.equal(journals.find(row=>Number(row.debit)===550).account_name,'Repairs and maintenance');
        appliance.providers.assertNoUnscripted();
      });
    } finally {
      await appliance.stop();
    }
  }
);
