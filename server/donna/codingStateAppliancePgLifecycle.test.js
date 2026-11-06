// RT-16 on the appliance (docs/plan-2026-09-01-runtime-refactor-slices.md §5
// "Coding-state collapse"; audit F-14): a bill and a bank line driven through
// coding → asked → posted across the REAL desktop path — createDonnaRuntimeServer,
// the local scheduler, the parse-document job (the batch coder inside it), the
// coding-convergence parse-cron task (source recovery → coder → ledger post), the
// strong matcher and its cascade — on the RT-06 harness against real
// PostgreSQL. At every step the ONE persisted column `transactions.coding_state`
// is read back (`read.transactions`) and asserted, and the persisted
// convergence verdict is asserted equal to a fresh `deriveConvergenceState`
// over the row's inputs (the derivation now takes the column as an input).
//
//   1. the two-line Barclays statement parses; the batch coder answers with
//      the committed `transaction_coding/kestrel-two-lines-coded` recording
//      (Sales for the PayLink payout, evidence_required; Repairs and
//      maintenance for the Ochre payment, no evidence needed but 550 GBP —
//      above the description-only ceiling) → both lines rest PROPOSED;
//   2. the coding-convergence task sweeps: the payout → owner_ask
//      (evidence_required), the Ochre payment → owner_ask (unevidenced,
//      material) — each ask minted through the ONE ask writer flips its line
//      to ASKED (on the owner);
//   3. the Ochre bill parses and the strong matcher settles the line at 0.94;
//      the cascade resolves the document ask the line was waiting on. The
//      coding stays ASKED until the next tick — the carried-forward law
//      (codingConvergence.js reconsiders the changed source on its next
//      clock, never inside the matcher), projected exactly as the legacy
//      `asked_client`/`waiting` labels were;
//   4. the next coding-convergence tick reconsiders the settled line's changed
//      source (asked → proposed, receipted), the recorded coder refreshes the
//      verdict on the new evidence (→ applied), and the existing writer posts
//      its journal inline (→ posted). POSTED is a ledger
//      fact the machine never leaves except to synced/closed. The payout
//      stays ASKED: on the owner.
//
// The review-queue rows the parse writer mints are CASE FILES: the column that
// used to carry a second coding vocabulary is gone (138), and no row of the run
// carries `review_state` in its payload. Every coding step is also a
// `coding_state_as_of` stamp that moves forward.

import assert from 'node:assert/strict';
import test from 'node:test';

import { applianceHarnessSkipReason, bootApplianceForTest } from './testSupport/applianceHarness.js';
import { loadRecording } from './testSupport/recordedProviders.js';
import { computeConvergenceForTransactions } from './reconcileConvergenceState.js';
import { CODING_STATE_TRANSITIONS, CodingStateTransitionError, applyCodingTransition, codingTransitionAllowed } from './codingState.js';
import { withFirmDbClient } from './firmDb.js';
import { codingCaseRevision } from './jevPreview.js';

const CODING_CONVERGENCE_FUNCTION_ID = 'parse-cron:coding_convergence';
const CODING_RECORDING = 'transaction_coding/kestrel-two-lines-coded';

// The committed recording names the lines by placeholder; the run's real ids
// are `<document>-tx-<idx>` (parseDocument.js), known once the upload returns.
const codingRecordingFor = ({ payoutTransactionId, ochreTransactionId }) => {
  const recording = loadRecording(CODING_RECORDING);
  const body = JSON.parse(JSON.stringify(recording.body));
  const text = body.output[0].content[0].text;
  assert.ok(text.includes('__TX_PAYOUT__') && text.includes('__TX_OCHRE__'), 'the recording carries both placeholders');
  body.output[0].content[0].text = text
    .split('__TX_PAYOUT__').join(payoutTransactionId)
    .split('__TX_OCHRE__').join(ochreTransactionId);
  return { status: recording.status, body };
};

test(
  'real PG (appliance, RT-16): a bill and a bank line run coding → asked → posted on the ONE coding column, the persisted convergence verdict equal to the derivation at every step',
  { skip: applianceHarnessSkipReason() },
  async () => {
    const appliance = await bootApplianceForTest({ now: new Date('2026-08-31T09:00:00.000Z') });
    const db = { query: appliance.query };
    const firmId = appliance.firmId;

    // Column == a fresh derivation for every transaction of the client, and no
    // unsettled mark rests on the firm — after every step.
    const assertConverged = async (label, clientId) => {
      const txIds = (await appliance.read.transactions(clientId)).map((tx) => tx.id);
      const computed = await computeConvergenceForTransactions(db, { firmId, transactionIds: txIds });
      assert.equal(computed.length, txIds.length, `${label}: every line derived`);
      for (const c of computed) {
        assert.deepEqual(
          { state: c.persisted.state, reason: c.persisted.reason },
          { state: c.derived?.state ?? null, reason: c.derived?.reason ?? null },
          `${label}: transaction ${c.target_id} column == deriveConvergenceState`
        );
      }
      const marks = await appliance.query('select count(*)::int as n from convergence_marks where firm_id = $1', [firmId]);
      assert.equal(marks.rows[0].n, 0, `${label}: no unsettled marks`);
      return Object.fromEntries(computed.map((c) => [c.target_id, { state: c.persisted.state, reason: c.persisted.reason }]));
    };
    const codingOf = async (clientId) => {
      const rows = await appliance.read.transactions(clientId);
      return Object.fromEntries(rows.map((tx) => [tx.id, { state: tx.coding_state, as_of: tx.coding_state_as_of ? new Date(tx.coding_state_as_of).getTime() : null }]));
    };
    const assertStep = ({ label, from, to }) => {
      if (from === to) return;
      assert.ok(codingTransitionAllowed(from, to), `${label}: ${from ?? 'none'} → ${to} is a transition of the machine (${JSON.stringify(CODING_STATE_TRANSITIONS[from ?? 'none'])})`);
    };
    const runCodingConvergence = async (label) => {
      const receipt = await appliance.tick({ functions: [CODING_CONVERGENCE_FUNCTION_ID], advanceMs: 5 * 60_000 });
      const job = receipt.jobs.find((j) => j.function_id === CODING_CONVERGENCE_FUNCTION_ID);
      assert.ok(job, `${label}: the coding-convergence task ran (${JSON.stringify(receipt.jobs.map((j) => [j.function_id, j.status]))})`);
      assert.equal(job.status, 'succeeded', `${label}: ${job.last_error}`);
      // The parse-cron runner keys each task's summary by task name.
      const summary = job.result?.coding_convergence;
      assert.ok(summary && !summary.error, `${label}: the task's own summary (${JSON.stringify(job.result)})`);
      return summary;
    };

    try {
      const { clientId } = await appliance.createClient();
      assert.ok(appliance.manifest.some((entry) => entry.functionId === CODING_CONVERGENCE_FUNCTION_ID), 'coding convergence is on the desktop manifest');

      // ── 1. The statement: two lines, coded by the recording → PROPOSED. ──
      appliance.providers.script('document_routing', ['document_routing/kestrel-bank-statement']);
      appliance.providers.script('bank_statement_extraction', ['bank_statement_extraction/kestrel-barclays-two-lines']);
      appliance.providers.script('bank_line_disposition', [
        'bank_line_disposition/kestrel-ochre-debit-chase-receipt',
        'bank_line_disposition/kestrel-paylink-credit-chase-evidence'
      ]);
      // The ask drafter is not this fixture's law: every draft attempt is
      // answered with a terminal refusal the job ledger names honestly.
      appliance.providers.script('ask_drafting', [{ status: 503, times: Infinity }]);
      const statement = await appliance.uploadDocument({ clientId, fixture: 'bank_statement_two_lines' });
      const payoutTransactionId = `${statement.documentId}-tx-0`;
      const ochreTransactionId = `${statement.documentId}-tx-1`;
      appliance.providers.script('transaction_coding', [codingRecordingFor({ payoutTransactionId, ochreTransactionId })]);

      const statementTick = await appliance.tick();
      const statementDoc = await appliance.read.document(statement.documentId);
      assert.equal(statementDoc.parse_status, 'completed', JSON.stringify({ parse: statementDoc.parse_error, jobs: statementTick.jobs.map((j) => [j.function_id, j.status, j.last_error]) }));
      const lines = await appliance.read.transactions(clientId);
      const payout = lines.find((tx) => tx.id === payoutTransactionId);
      const ochre = lines.find((tx) => tx.id === ochreTransactionId);
      assert.ok(payout && Number(payout.money_in) === 1213.75, `the payout line carries the predicted id: ${JSON.stringify(lines.map((tx) => [tx.id, tx.money_in, tx.money_out]))}`);
      assert.ok(ochre && Number(ochre.money_out) === 550, 'the Ochre line carries the predicted id');
      assert.equal(payout.payload?.ai_suggestion?.proposed_account, 'Sales', 'the recording coded the payout');
      assert.equal(ochre.payload?.ai_suggestion?.proposed_account, 'Repairs and maintenance', 'the recording coded the Ochre payment');
      assert.equal(payout.payload?.ai_suggestion?.evidence_required, true);
      assert.equal(ochre.payload?.ai_suggestion?.evidence_required, false);

      let coding = await codingOf(clientId);
      assert.deepEqual([coding[payoutTransactionId].state, coding[ochreTransactionId].state], ['proposed', 'proposed'], 'neither suggestion cleared the batch gate: the payout needs evidence, the 550 GBP payment is above the description-only ceiling');
      assert.ok(coding[payoutTransactionId].as_of && coding[ochreTransactionId].as_of, 'coding_state_as_of stamped');
      let verdicts = await assertConverged('after the statement tick', clientId);
      assert.deepEqual(verdicts[payoutTransactionId], { state: 'hanging', reason: 'coding_state:proposed' }, 'a proposed coding is firm-side limbo: hanging, named by the column');
      assert.deepEqual(verdicts[ochreTransactionId], { state: 'hanging', reason: 'coding_state:proposed' });
      const caseFiles = (await appliance.read.reviewQueue(clientId)).filter((row) => row.status === 'open');
      assert.deepEqual(caseFiles.map((row) => row.payload?.transaction_id).sort(), [ochreTransactionId, payoutTransactionId].sort(), 'one open case file per line');
      assert.ok(caseFiles.every((row) => row.review_state === undefined && !('review_state' in (row.payload || {}))), 'a case file carries no coding vocabulary (138 dropped the column and stripped the payload label)');
      assert.ok(lines.every((tx) => !('review_state' in (tx.payload || {})) && tx.payload?.ai_suggestion_status !== 'suggested'), 'no transaction payload carries a legacy coding label');

      // ── 2. The convergence sweep: both lines → the owner (ASKED). ──
      const sweep1 = await runCodingConvergence('sweep 1');
      const swept1 = (sweep1.swept || []).find((row) => row.client_id === clientId);
      assert.ok(swept1, `the client was swept: ${JSON.stringify(sweep1)}`);
      assert.equal(swept1.owner_asked, 2, JSON.stringify(swept1));
      assert.equal(swept1.auto_posted, 0, JSON.stringify(swept1));
      const prior = coding;
      coding = await codingOf(clientId);
      for (const id of [payoutTransactionId, ochreTransactionId]) {
        assertStep({ label: `sweep 1 ${id}`, from: prior[id].state, to: coding[id].state });
        assert.equal(coding[id].state, 'asked', `${id}: the ask writer flipped the line to ASKED`);
        assert.ok(coding[id].as_of > prior[id].as_of, `${id}: the as_of stamp moved forward`);
      }
      const asks = await appliance.read.asks(clientId);
      const payoutAsk = asks.find((row) => row.transaction_id === payoutTransactionId);
      const ochreAsk = asks.find((row) => row.transaction_id === ochreTransactionId);
      assert.ok(payoutAsk && ochreAsk, JSON.stringify(asks.map((row) => [row.transaction_id, row.evidence_type, row.status])));
      assert.equal(payoutAsk.status, 'draft'); // W1: minted by the sweep, no channel delivered it
      assert.equal(ochreAsk.status, 'draft');
      assert.equal(ochreAsk.evidence_type, 'supporting_document', 'the material unevidenced payment asks the owner for the document');
      verdicts = await assertConverged('after sweep 1', clientId);
      assert.equal(verdicts[payoutTransactionId].state, 'on_owner', JSON.stringify(verdicts[payoutTransactionId]));
      assert.equal(verdicts[ochreTransactionId].state, 'on_owner', JSON.stringify(verdicts[ochreTransactionId]));

      // ── 3. The bill: routed, extracted, matched at 0.94 → the document ask resolved; the coding waits for the recovery clock. ──
      appliance.providers.script('document_routing', ['document_routing/ochre-supplier-bill']);
      // RT-12: the unified extractor is the appliance's code default; the
      // family lane stays scripted for its fallback, unconsumed on this path.
      appliance.providers.script('unified_extraction', ['unified_extraction/ochre-discount-line']);
      appliance.providers.script('supplier_bill_extraction', ['supplier_bill_extraction/ochre-discount-line']);
      appliance.providers.script('reconciliation_reasoning', ['reconciliation_reasoning/ochre-bill-settled-by-candidate-1']);
      const bill = await appliance.uploadDocument({ clientId, fixture: 'supplier_bill_discount' });
      const billTick = await appliance.tick();
      const billDoc = await appliance.read.document(bill.documentId);
      assert.equal(billDoc.parse_status, 'completed', JSON.stringify({ parse: billDoc.parse_error, jobs: billTick.jobs.map((j) => [j.function_id, j.status, j.last_error]), unscripted: appliance.providers.unscripted }));
      const match = (await appliance.read.matches(clientId)).find((row) => row.matched_object_id === bill.documentId);
      assert.equal(match?.status, 'auto_matched', JSON.stringify(match?.payload?.authorization));
      assert.equal(match?.bank_transaction_id, ochreTransactionId);
      const beforeBill = coding;
      coding = await codingOf(clientId);
      assert.deepEqual(coding, beforeBill, 'the matcher settles the line and answers its ask; it does not code — the coding column is untouched by the bill tick');
      const ochreAskAfterMatch = (await appliance.read.asks(clientId)).find((row) => row.id === ochreAsk.id);
      assert.equal(ochreAskAfterMatch.status, 'resolved', 'the cascade answered the document ask the line was waiting on');
      const settledLine = (await appliance.read.transactions(clientId)).find((tx) => tx.id === ochreTransactionId);
      assert.ok(['explained', 'reconciled', 'auto_reconciled'].includes(settledLine.reconciliation_status), settledLine.reconciliation_status);
      verdicts = await assertConverged('after the bill tick', clientId);
      // The carried-forward projection of an ASKED coding with its ask
      // answered by the system: on the owner under the column's own key —
      // exactly what the legacy `asked_client`/`waiting` labels projected
      // (reconcileConvergenceState.test.js policy table) — until the recovery
      // below moves it. Named in the RT-16 handoff as a window, not changed
      // here: the projection changes deliberately, in one slice.
      assert.deepEqual(verdicts[ochreTransactionId], { state: 'on_owner', reason: 'coding_state:asked' });
      assert.equal(verdicts[payoutTransactionId].state, 'on_owner');

      // ── 4. Changed evidence (asked → proposed) → fresh coding (→ applied) → existing journal writer (→ posted). ──
      const freshCoding = codingRecordingFor({ payoutTransactionId, ochreTransactionId });
      const freshContent = JSON.parse(freshCoding.body.output[0].content[0].text);
      freshContent.suggestions = freshContent.suggestions.filter(row => row.transaction_id === ochreTransactionId);
      freshCoding.body.output[0].content[0].text = JSON.stringify(freshContent);
      appliance.providers.script('transaction_coding', [freshCoding]);
      const sweep2 = await runCodingConvergence('sweep 2');
      assert.deepEqual((sweep2.coding_evidence_recovery || []).map((row) => row.transaction_id),
        [ochreTransactionId], `only the settled line's changed source is reconsidered: ${JSON.stringify(sweep2)}`);
      const coded2 = (sweep2.coder || []).find((row) => row.client_id === clientId);
      assert.ok(coded2, `the fresh-evidence coder ran: ${JSON.stringify(sweep2)}`);
      assert.equal(coded2.suggested, 1, JSON.stringify(coded2));
      assert.equal(coded2.auto_applied, 1, JSON.stringify(coded2));
      assert.equal(appliance.providers.calls.filter(call => call.lane === 'transaction_coding').length, 2,
        'one initial recorded coding and exactly one fresh-source reconsideration');
      const asksAfterRecode = await appliance.read.asks(clientId);
      assert.equal(asksAfterRecode.filter(row => row.transaction_id === payoutTransactionId && ['draft','open'].includes(row.status)).length, 1,
        'the unrelated payout keeps its single owner ask');
      assert.equal(asksAfterRecode.filter(row => row.transaction_id === ochreTransactionId && ['draft','open'].includes(row.status)).length, 0,
        'the settled and posted line has no dangling owner ask');
      const beforePost = coding;
      coding = await codingOf(clientId);
      for (const [from, to] of [['asked', 'proposed'], ['proposed', 'applied'], ['applied', 'posted']]) {
        assertStep({ label: `sweep 2 ${from} → ${to}`, from, to });
      }
      assert.equal(coding[ochreTransactionId].state, 'posted', 'the ledger journal is a fact of the column');
      assert.ok(coding[ochreTransactionId].as_of > beforePost[ochreTransactionId].as_of);
      assert.equal(coding[payoutTransactionId].state, 'asked', 'the payout still rests on the owner');
      assert.equal(coding[payoutTransactionId].as_of, beforePost[payoutTransactionId].as_of, 'an untouched line keeps its stamp');
      const postedLine = (await appliance.read.transactions(clientId)).find((tx) => tx.id === ochreTransactionId);
      assert.ok(postedLine.payload?.ledger_journal_id, 'the journal the state names exists');
      assert.equal(postedLine.payload?.ledger_status, 'posted');
      assert.equal(postedLine.payload?.ai_suggestion_status, 'auto_applied', 'HOW the proposal was applied stays as the receipt');
      assert.equal(postedLine.account_code, 'Repairs and maintenance');
      const evidenceReceipts = await appliance.read.audit({ clientId, action: 'coding.evidence_changed' });
      assert.equal(evidenceReceipts.length, 1, 'the source reconsideration is receipted once');
      assert.equal(evidenceReceipts[0].resource_id, ochreTransactionId);
      const journalLines = (await appliance.query(`select l.account_name,l.debit,l.credit from ledger_journals j
        join ledger_lines l on l.journal_id=j.id where j.firm_id=$1 and j.client_id=$2 and j.source_id=$3 order by l.line_no`,
      [firmId,clientId,ochreTransactionId])).rows;
      assert.equal(journalLines.length, 2, 'one expense and one bank leg, no duplicated posting');
      assert.deepEqual(journalLines.map(row => [Number(row.debit),Number(row.credit)]).sort(), [[0,550],[550,0]]);
      assert.equal(journalLines.find(row => Number(row.debit) === 550).account_name, 'Repairs and maintenance');
      verdicts = await assertConverged('after sweep 2', clientId);
      assert.deepEqual(verdicts[ochreTransactionId], { state: 'auto_reconciled', reason: 'coding_state:posted' });
      assert.equal(verdicts[payoutTransactionId].state, 'on_owner');

      // A posted line never goes back: the machine refuses at the writer, and
      // the row is byte-identical afterwards.
      await assert.rejects(
        withFirmDbClient((client) => applyCodingTransition(client, { firmId, clientId, transactionId: ochreTransactionId, to: 'proposed' })),
        (error) => error instanceof CodingStateTransitionError && error.from === 'posted' && error.to === 'proposed'
      );
      assert.deepEqual(await codingOf(clientId), coding, 'the refused transition changed nothing');

      // Every step of the run above is one of the machine's transitions, and
      // every lane that was hit answered from a script.
      appliance.providers.assertNoUnscripted();
    } finally {
      await appliance.stop();
    }
  }
);


test('coding revision changes for owner evidence, never for asking or reply processing', () => {
  const evidence = { company:{id:'company'}, focal:{id:'bank'}, transactions:[{id:'bank'}],
    documents:[], matches:[], obligations:[], owner_replies:[], coverage:{status:'complete_within_scope',unread_sources:[]} };
  const initial = codingCaseRevision(evidence);
  const ask = {id:'ask',transaction_id:'bank',question:'What was this for?',evidence_type:'supporting_document',response_payload:{}};
  evidence.owner_replies = [ask];
  assert.equal(codingCaseRevision(evidence),initial,'minting an unanswered ask is not evidence');
  ask.response_payload = {reply:'Replacement lighting',document_ids:[],responded_at:'2026-09-01T10:00:00Z',answer_source:'portal'};
  const answered = codingCaseRevision(evidence);
  assert.notEqual(answered,initial,'a substantive owner answer reopens the source decision');
  ask.response_payload.reply_processing = {state:'completed',attempts:2};
  assert.equal(codingCaseRevision(evidence),answered,'processing that same answer cannot reopen it again');
  ask.response_payload.reply = 'Personal lighting';
  assert.notEqual(codingCaseRevision(evidence),answered,'a corrected owner fact changes the decision input');
  ask.response_payload = {document_ids:['bill'],auto_resolved_by_match:true};
  assert.equal(codingCaseRevision(evidence),initial,'the matcher resolving an ask is not an owner answer');
  ask.response_payload = {document_ids:['bill'],responded_at:'2026-09-01T10:00:00Z'};
  assert.notEqual(codingCaseRevision(evidence),initial,'an owner-supplied document is substantive evidence');
});
