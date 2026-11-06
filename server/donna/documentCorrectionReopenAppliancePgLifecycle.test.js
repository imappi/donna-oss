// FI-02 (Finland fix round, 2026-10-15) — correcting a SETTLED document
// reopens its match and re-evaluates it ONCE, on the real appliance path.
// S02 (dmemS02DocumentCorrectionPgLifecycle.test.js) pins the immediate
// consequence; this file follows it to the end: the Ochre bill (550 GBP)
// auto-matches the 550 debit, a neighbouring PayLink payout settles the
// credit, the firm corrects the bill's total to 495 through the real writer,
// and then:
//   - the stale match leaves the settled set through the named match writer
//     (suggested, the line back to needs_review), never resting settled;
//   - the convergence clock runs ONE fresh family evaluation (one
//     reconciliation_reasoning call), whose verdict here is no_match, and the
//     reopened pair it did not re-propose is retired, so nothing rests on it;
//   - a second clock tick spends nothing (the pool is empty again);
//   - the bill's fresh no_match goes on to an owner evidence question, and the
//     bank line's loop case regresses with it (no stale met report);
//   - the neighbouring payout's match and line are untouched;
//   - no journal row is deleted or rewritten.

import test from 'node:test';
import assert from 'node:assert/strict';

import { bootApplianceForTest, applianceHarnessSkipReason } from './testSupport/applianceHarness.js';
import { recordDocumentCorrectionInDb } from './documentCorrections.js';

const SETTLING = new Set(['auto_matched', 'confirmed']);

test(
  'real PG (appliance, FI-02): a settled bill whose total is corrected is reopened and re-evaluated once; the neighbouring settlement is untouched',
  { skip: applianceHarnessSkipReason() },
  async () => {
    const appliance = await bootApplianceForTest({ now: new Date('2026-08-31T09:00:00.000Z') });
    try {
      const { firmId } = appliance;
      const { clientId } = await appliance.createClient();

      // The neighbour first: the PayLink payout, so the statement's exact-
      // reference tier settles it on the credit (payoutFamilyPgLifecycle's world).
      appliance.providers.script('document_routing', ['document_routing/paylink-payout']);
      appliance.providers.script('unified_extraction', ['unified_extraction/paylink-PO-88121']);
      const payout = await appliance.uploadDocument({ clientId, fixture: 'payout_statement' });
      await appliance.tick();
      assert.equal((await appliance.read.document(payout.documentId)).parse_status, 'completed');

      appliance.providers.script('document_routing', ['document_routing/kestrel-bank-statement']);
      appliance.providers.script('bank_statement_extraction', ['bank_statement_extraction/kestrel-barclays-two-lines']);
      appliance.providers.script('transaction_coding', [{ status: 418, body: { error: { type: 'fixture_lane_dark', message: 'coding is not what this fixture proves' } }, times: Infinity }]);
      appliance.providers.script('bank_line_disposition', ['bank_line_disposition/kestrel-ochre-debit-chase-receipt', 'bank_line_disposition/kestrel-paylink-credit-chase-evidence']);
      appliance.providers.script('ask_drafting', [{ status: 503, times: Infinity }]);
      const statement = await appliance.uploadDocument({ clientId, fixture: 'bank_statement_two_lines' });
      await appliance.tick();
      assert.equal((await appliance.read.document(statement.documentId)).parse_status, 'completed');
      const lines = await appliance.read.transactions(clientId);
      const ochreLine = lines.find((tx) => Number(tx.money_out) === 550);
      const payoutLine = lines.find((tx) => Number(tx.money_in) > 0);
      assert.ok(ochreLine && payoutLine, 'both statement lines are on the feed');

      appliance.providers.script('document_routing', ['document_routing/ochre-supplier-bill']);
      appliance.providers.script('unified_extraction', ['unified_extraction/ochre-discount-line']);
      appliance.providers.script('reconciliation_reasoning', ['reconciliation_reasoning/ochre-bill-settled-by-candidate-1']);
      const bill = await appliance.uploadDocument({ clientId, fixture: 'supplier_bill_discount' });
      await appliance.tick();
      assert.equal((await appliance.read.document(bill.documentId)).parse_status, 'completed');

      const matchesBefore = await appliance.read.matches(clientId);
      const settled = matchesBefore.find((row) => row.matched_object_id === bill.documentId);
      assert.ok(settled && SETTLING.has(settled.status), `the bill is settled on the 550 line: ${JSON.stringify(settled)}`);
      assert.equal(settled.bank_transaction_id, ochreLine.id);
      const neighbour = matchesBefore.find((row) => row.matched_object_id === payout.documentId);
      assert.ok(neighbour && SETTLING.has(neighbour.status), `the payout is settled on the credit: ${JSON.stringify(matchesBefore.map((r) => [r.matched_object_type, r.status]))}`);
      const payoutLineBefore = (await appliance.read.transactions(clientId)).find((tx) => tx.id === payoutLine.id);
      const journalsBefore = (await appliance.query(
        'select id, status, updated_at from ledger_journals where firm_id = $1 and client_id = $2 order by id', [firmId, clientId]
      )).rows;
      const reasoningCallsBefore = appliance.providers.callsFor('reconciliation_reasoning').length;

      // ── The material correction, through the real writer. ──
      const correction = await recordDocumentCorrectionInDb({ firmId, documentId: bill.documentId, fieldPath: 'total_amount', correctedValue: 495, correctedBy: 'fi-02' });
      assert.deepEqual(correction.reconciliation.invalidated_match_ids, [settled.id], 'the consequence diff names the invalidated match');
      assert.ok(correction.reconciliation.superseded_evaluation_ids.length >= 1, 'the verdict judged on 550 is superseded');
      assert.equal(correction.reconciliation.reopened?.[0]?.after_state?.match_status, 'suggested', JSON.stringify(correction.reconciliation));

      const reopened = (await appliance.read.matches(clientId)).find((row) => row.id === settled.id);
      assert.equal(reopened.status, 'suggested', 'the stale match left the settled set through the named writer');
      assert.equal(reopened.payload?.invalidated_by_correction ?? null, null, 'the live marker became a receipt');
      assert.equal(reopened.payload?.reopened_by_correction?.correction_id, correction.id);
      const lineReopened = (await appliance.read.transactions(clientId)).find((tx) => tx.id === ochreLine.id);
      assert.equal(lineReopened.reconciliation_status, 'needs_review', 'the line no longer rests on the stale match');
      assert.notEqual(lineReopened.convergence_state, 'auto_reconciled');
      assert.equal(lineReopened.convergence_state, 'hanging', `until the fresh evaluation lands the line projects hanging: ${lineReopened.convergence_reason}`);
      assert.notEqual((await appliance.read.document(bill.documentId)).payment_status, 'paid', 'the bill is no longer paid by the stale match');

      // ── ONE fresh evaluation, through the convergence clock's family re-drive. ──
      appliance.providers.script('reconciliation_reasoning', ['reconciliation_reasoning/no-plausible-match']);
      const clock = await appliance.tick({ functions: ['parse-cron:coding_convergence'], advanceMs: 5 * 60_000 });
      assert.equal(appliance.providers.callsFor('reconciliation_reasoning').length, reasoningCallsBefore + 1,
        `exactly one fresh evaluation ran: ${JSON.stringify(clock.jobs.map((j) => [j.function_id, j.status, j.last_error]))}`);
      const fresh = (await appliance.read.evaluations(clientId, { targetId: bill.documentId }))
        .filter((row) => row.verdict !== 'superseded');
      assert.ok(fresh.some((row) => row.matcher_family === 'supplier_bill' && row.verdict === 'no_match'
        && new Date(row.evaluated_at).getTime() > new Date(correction.corrected_at).getTime()),
        `a fresh supplier_bill verdict newer than the correction: ${JSON.stringify(fresh.map((r) => [r.matcher_family, r.verdict, r.evaluated_at]))}`);
      const retired = (await appliance.read.matches(clientId)).find((row) => row.id === settled.id);
      assert.equal(retired.status, 'rejected', 'the reopened pair the fresh evaluation did not re-propose is retired, never left as a suggestion');
      const lineAfter = (await appliance.read.transactions(clientId)).find((tx) => tx.id === ochreLine.id);
      assert.notEqual(lineAfter.reconciliation_status, 'explained');
      assert.notEqual(lineAfter.convergence_state, 'auto_reconciled');

      // The pool is empty again: a second clock tick spends nothing.
      await appliance.tick({ functions: ['parse-cron:coding_convergence'], advanceMs: 5 * 60_000 });
      assert.equal(appliance.providers.callsFor('reconciliation_reasoning').length, reasoningCallsBefore + 1, 'one fresh evaluation, never a loop');

      // The neighbouring settlement is untouched.
      const neighbourAfter = (await appliance.read.matches(clientId)).find((row) => row.id === neighbour.id);
      assert.equal(neighbourAfter.status, neighbour.status);
      assert.equal(neighbourAfter.payload?.invalidated_by_correction ?? null, null);
      assert.equal(neighbourAfter.payload?.reopened_by_correction ?? null, null);
      const payoutLineAfter = (await appliance.read.transactions(clientId)).find((tx) => tx.id === payoutLine.id);
      assert.equal(payoutLineAfter.reconciliation_status, payoutLineBefore.reconciliation_status);
      assert.equal(payoutLineAfter.convergence_state, payoutLineBefore.convergence_state);
      assert.ok((await appliance.read.evaluations(clientId, { targetId: payout.documentId })).every((row) => row.verdict !== 'superseded' || row.payload?.superseded_by !== 'document_correction'),
        'no neighbouring verdict is superseded by the correction');

      // Journal history: nothing deleted, nothing rewritten.
      const journalsAfter = (await appliance.query(
        'select id, status, updated_at from ledger_journals where firm_id = $1 and client_id = $2 order by id', [firmId, clientId]
      )).rows;
      for (const journal of journalsBefore) {
        const still = journalsAfter.find((row) => row.id === journal.id);
        assert.ok(still, `journal ${journal.id} is kept`);
        assert.equal(still.status, journal.status);
        assert.equal(new Date(still.updated_at).getTime(), new Date(journal.updated_at).getTime());
      }

      // Where the fresh verdict leads, on the existing lanes: the bill's
      // no-line disposition asks the OWNER for the evidence (the ask drafting
      // lane is dark in this fixture, so the drafted ask itself is not shown),
      // and the bank line's loop case regressed with the correction, so its
      // stale met report no longer reads the line as matched.
      appliance.providers.script('document_disposition', ['document_disposition/ochre-bill-uncovered-account']);
      await appliance.tick();
      await appliance.tick();
      const billRest = await appliance.read.document(bill.documentId);
      assert.equal(billRest.convergence_state, 'hanging');
      assert.equal(billRest.convergence_reason, 'disposition:chase_evidence', 'the fresh no_match became an owner evidence question');
      const lineRest = (await appliance.read.transactions(clientId)).find((tx) => tx.id === ochreLine.id);
      assert.equal(lineRest.convergence_state, 'hanging');
      assert.equal(lineRest.convergence_reason, 'reconciliation_status:needs_review', 'no stale goal report reads the line as matched');
      assert.equal(appliance.providers.callsFor('reconciliation_reasoning').length, reasoningCallsBefore + 1, 'still one fresh evaluation');

      const audit = await appliance.read.audit({ clientId, action: 'reconciliation_match.invalidated_by_correction' });
      assert.equal(audit.length, 1, 'the invalidation is receipted once');
    } finally {
      await appliance.stop();
    }
  }
);
