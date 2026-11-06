// Ask lifecycle honesty on the appliance (RT-11, fixture (c) + (a) end to end;
// docs/plan-2026-09-01-runtime-refactor-slices.md, audit F-16 / F-17,
// decisions D2 + D3). Runs the real desktop path on the RT-06 harness:
//
//   a FRESH desktop client (zero grants, the plane rows the seed gives it)
//     → the two-line Barclays statement parses
//     → two owner asks sit on the 550 GBP line (a purpose question and a
//       document request — the Union Coop shape)
//     → the Ochre Lighting bill (550 GBP — above the 500 ceiling, MATERIAL)
//       parses and the strong matcher settles it on that line at 0.94
//     → under RECONCILIATION_MATERIAL_AUTO_FYI (seeded auto, D2) the match
//       auto-reconciles with a material_auto_fyi receipt instead of resting
//       as a confirm ask (round 4: 16 of 95 asks were authority-only)
//     → the match answers the DOCUMENT ask and leaves the PURPOSE ask open
//       with the match recorded on it (D3)
//     → the owner's next message carries the FYI; sending it flips
//       owner_notified — decide-and-notify, end to end.
//
// Every model call is served at the wire from the committed recordings; the
// ledger of lanes hit is asserted, so a new lane on this path fails loudly.

import test from 'node:test';
import assert from 'node:assert/strict';

import { bootApplianceForTest, applianceHarnessSkipReason } from './testSupport/applianceHarness.js';
import { loadRecording } from './testSupport/recordedProviders.js';

const RT11_SEEDS = ['RECONCILIATION_MATERIAL_AUTO_FYI', 'RECONCILE_AUTO_EXPLAIN_RETRACTS', 'RECONCILE_RETRACTION_AUTOSEND'];

test(
  'real PG (appliance): a material match resolves only the document ask; without a journal it is never a posted FYI',
  { skip: applianceHarnessSkipReason() },
  async () => {
    const appliance = await bootApplianceForTest({ now: new Date('2026-08-31T09:00:00.000Z') });
    try {
      const { clientId } = await appliance.createClient();
      const flags = await appliance.read.flags(clientId);
      for (const key of RT11_SEEDS) {
        assert.ok(flags.some((row) => row.flag_key === key && row.stage === 'auto' && row.valid_to === null), `${key} is born auto on the owner shell`);
      }
      const grants = await appliance.query(
        'select count(*)::int as n from reconciliation_authority_grants where firm_id = $1 and client_id = $2',
        [appliance.firmId, clientId]
      );
      assert.equal(grants.rows[0].n, 0, 'a fresh owner client has zero grants — the FYI seed is the no-grant lever');

      // ── The statement: two lines, one of them the 550 GBP Ochre payment. The
      // loop's terminal drain disposes both bare lines on the same drain tick
      // (money_out first, then money_in): the Ochre payment has no bill yet
      // (chase_receipt), the PayLink payout no settlement report (chase_evidence)
      // — both material, neither settles; the verdict→ask chain owns them. ──
      appliance.providers.script('document_routing', ['document_routing/kestrel-bank-statement']);
      appliance.providers.script('bank_statement_extraction', ['bank_statement_extraction/kestrel-barclays-two-lines']);
      // The strong batch coder also runs on a freshly parsed statement. It is
      // scripted DARK here on purpose (the harness's own terminal refusal, so
      // no retry): coding is not what this fixture proves, and a coded payout
      // line would pull the per-line coding sweep's own ask into the picture.
      // The lines stay uncoded; the disposition pass alone routes the payout
      // to the owner. A recorded coder against the world's chart is the
      // named follow-up (RT-06 §5 left the same gap).
      appliance.providers.script('transaction_coding', [{
        status: 418,
        body: { error: { type: 'fixture_lane_dark', message: 'transaction_coding is scripted dark for this fixture' } }
      }]);
      appliance.providers.script('bank_line_disposition', [
        'bank_line_disposition/kestrel-ochre-debit-chase-receipt',
        'bank_line_disposition/kestrel-paylink-credit-chase-evidence'
      ]);
      const statement = await appliance.uploadDocument({ clientId, fixture: 'bank_statement_two_lines' });
      const statementTick = await appliance.tick();
      const statementDoc = await appliance.read.document(statement.documentId);
      assert.equal(statementDoc.parse_status, 'completed', JSON.stringify({ parse: statementDoc.parse_error, jobs: statementTick.jobs.map((j) => [j.function_id, j.status, j.last_error]), calls: appliance.providers.calls.map((c) => [c.lane, c.status]) }));
      const transactions = await appliance.read.transactions(clientId);
      const ochreLine = transactions.find((tx) => Number(tx.money_out) === 550);
      assert.ok(ochreLine, `the 550 GBP payment is on the feed: ${JSON.stringify(transactions.map((tx) => [tx.description, tx.money_in, tx.money_out]))}`);
      const payoutLine = transactions.find((tx) => Number(tx.money_in) === 1213.75);
      assert.ok(payoutLine, 'the PayLink payout is on the feed');
      const dispositions = (await appliance.read.evaluations(clientId)).filter((row) => row.matcher_family === 'bank_line_disposition');
      assert.deepEqual(
        dispositions.map((row) => [row.target_id, row.verdict, row.payload?.disposition]).sort(),
        [[ochreLine.id, 'no_match', 'chase_receipt'], [payoutLine.id, 'no_match', 'chase_evidence']].sort(),
        'neither bare line settles: both verdicts rest as owner-bound gaps'
      );

      // ── Two owner asks already sit on that line (the ask-before-match race). ──
      for (const [id, evidenceType, question] of [
        ['ask-purpose', 'business_purpose', 'Was the Ochre Lighting payment wholly for the studio rather than personal?'],
        ['ask-doc', 'supporting_document', 'Please send the Ochre Lighting invoice.']
      ]) {
        await appliance.query(
          `insert into client_evidence_requests
             (id, firm_id, client_id, transaction_id, status, evidence_type, question, request_payload, created_by, audience)
           values ($1, $2, $3, $4, 'open', $5, $6, '{}'::jsonb, 'ask_batch', 'client')`,
          [`${clientId}-${id}`, appliance.firmId, clientId, ochreLine.id, evidenceType, question]
        );
      }

      // ── The bill: routed, extracted, matched at 0.94 to candidate_1 (the 550 line). ──
      // The runtime drafts the owner's message on its own after each reconcile
      // (the ask_draft.requested outbox → the consumer at the next tick): the
      // statement's request drafts at the start of this tick — before the bill
      // is even parsed — and asks only for the payout report (the Ochre line
      // already rests on the owner's open asks, so it is never re-fed); the
      // bill's request drafts on the tick after, acknowledging the resolved evidence question without claiming a journal.
      appliance.providers.script('ask_drafting', [
        'ask_drafting/kestrel-payout-report-only',
        'ask_drafting/kestrel-payout-report-only'
      ]);
      appliance.providers.script('document_routing', ['document_routing/ochre-supplier-bill']);
      appliance.providers.script('unified_extraction', ['unified_extraction/ochre-discount-line']);
      appliance.providers.script('reconciliation_reasoning', ['reconciliation_reasoning/ochre-bill-settled-by-candidate-1']);
      const bill = await appliance.uploadDocument({ clientId, fixture: 'supplier_bill_discount' });
      const billTick = await appliance.tick();
      const billDoc = await appliance.read.document(bill.documentId);
      assert.equal(billDoc.parse_status, 'completed', JSON.stringify({ parse: billDoc.parse_error, jobs: billTick.jobs.map((j) => [j.function_id, j.status, j.last_error]), calls: appliance.providers.calls.map((c) => [c.lane, c.status]), unscripted: appliance.providers.unscripted }));

      const matches = await appliance.read.matches(clientId);
      const match = matches.find((row) => row.matched_object_id === bill.documentId);
      assert.ok(match, `the bill matcher settled the bill on a bank line: ${JSON.stringify(matches.map((m) => [m.matched_object_type, m.status, m.match_confidence]))}`);
      assert.equal(match.bank_transaction_id, ochreLine.id);
      assert.equal(Number(match.match_confidence), 0.94);
      assert.equal(match.status, 'auto_matched', JSON.stringify(match.payload?.authorization));
      const authorization = match.payload?.authorization || {};
      assert.deepEqual(authorization.reasons, ['material_auto_fyi'], 'held ONLY by the ceiling, then auto-reconciled under the seeded policy');
      assert.equal(authorization.gates?.E, false, 'the affirmative receipt still says E held — 550 GBP is above the 500 ceiling');
      assert.equal(authorization.gates?.A && authorization.gates?.B && authorization.gates?.C && authorization.gates?.D, true);
      assert.equal(authorization.material_auto_fyi?.owner_notified, false, 'matched; accounting completion is a separate receipt');
      assert.equal(authorization.material_auto_fyi?.materiality_ceiling, 500);
      assert.equal(authorization.model, loadRecording('reconciliation_reasoning/ochre-bill-settled-by-candidate-1').body.model, 'the model id is part of the receipt');
      assert.equal(authorization.delegated_authority, null, 'no grant was involved');
      const ochreAfterMatch = (await appliance.read.transactions(clientId)).find((tx) => tx.id === ochreLine.id);
      assert.equal(ochreAfterMatch.reconciliation_status, 'explained');

      // ── D3 on the real path: the document ask is answered, the purpose ask is not. ──
      const asks = await appliance.read.asks(clientId);
      const docAsk = asks.find((row) => row.id === `${clientId}-ask-doc`);
      const purposeAsk = asks.find((row) => row.id === `${clientId}-ask-purpose`);
      assert.equal(docAsk.status, 'resolved');
      assert.equal(docAsk.response_payload?.auto_resolved_by_match, true);
      assert.deepEqual(docAsk.response_payload?.document_ids, [bill.documentId]);
      assert.equal(purposeAsk.status, 'open', 'an amount match proves the charge exists, not what it was for');
      assert.equal(purposeAsk.request_payload?.matched_document_id, bill.documentId);
      assert.equal(purposeAsk.request_payload?.matched_reconciliation_match_id, match.id);
      const audit = await appliance.read.audit({ clientId });
      assert.ok(audit.some((row) => row.action === 'client_evidence_request.auto_resolved_by_match'));
      assert.ok(audit.some((row) => row.action === 'client_evidence_request.match_recorded' && row.resource_id === purposeAsk.id));

      // The next draft renders the match without claiming nonexistent accounting.
      await appliance.tick();
      const batches = (await appliance.query(
        'select id, status, payload from client_ask_batches where firm_id = $1 and client_id = $2 order by created_at, id',
        [appliance.firmId, clientId]
      )).rows;
      assert.deepEqual(batches.map((row) => row.status), ['superseded', 'draft'], `the pre-match draft is superseded by the post-match one: ${JSON.stringify(batches.map((row) => [row.id, row.status]))}`);
      const batchRow = batches[1];
      const batch = { id: batchRow.id, draft: batchRow.payload.draft };
      assert.deepEqual(batchRow.payload.posted_fyi_match_ids, [], 'a match without a journal cannot become a posted FYI');
      assert.deepEqual(batches[0].payload.posted_fyi_match_ids, [], 'the pre-match draft carried no FYI');
      assert.doesNotMatch(batch.draft.message_markdown, /matched and posted|booked to/i);
      // Exactly one question: the PayLink payout's settlement report (the
      // disposition-driven gather). The Ochre line is matched and its purpose
      // ask already rests on the owner — neither is re-asked.
      assert.deepEqual(
        (batch.draft?.items || []).map((item) => [item.transaction_id, item.disposition, item.evidence_type]),
        [[payoutLine.id, 'ask', 'supporting_document']],
        JSON.stringify(batch.draft)
      );
      const sent = await appliance.api.request({
        method: 'POST', path: `/api/donna/firms/ask-batches/${encodeURIComponent(batch.id)}/send`, auth: true,
        body: { firm_id: appliance.firmId, client_id: clientId }
      });
      assert.equal(sent.status, 200, `send route: ${sent.text.slice(0, 600)}`);
      const matchAfterSend = (await appliance.read.matches(clientId)).find((row) => row.id === match.id);
      assert.equal(matchAfterSend.status, 'auto_matched');
      assert.equal(matchAfterSend.payload?.authorization?.material_auto_fyi?.owner_notified, false, 'no posting FYI was sent before accounting completed');
      const sendAudit = (await appliance.read.audit({ clientId, action: 'ask_batch.send' }))[0];
      assert.equal(sendAudit?.metadata?.posted_fyi_notified, 0);
      assert.equal(sendAudit?.metadata?.evidence_request_count, 1, 'one new question minted — the payout report');
      const asksAfterSend = await appliance.read.asks(clientId);
      assert.equal(asksAfterSend.find((row) => row.id === purposeAsk.id).status, 'open', 'the purpose ask is still the owner\'s to answer');
      const payoutAsk = asksAfterSend.find((row) => row.transaction_id === payoutLine.id);
      assert.equal(payoutAsk?.status, 'draft', JSON.stringify(asksAfterSend.map((row) => [row.transaction_id, row.evidence_type, row.status])));
      assert.equal(payoutAsk.evidence_type, 'supporting_document');

      // ── The lane ledger: every call answered from a recording, nothing dark. ──
      appliance.providers.assertNoUnscripted();
      // Order-insensitive: within one tick the outbox consumer (the draft) and
      // the parse drain interleave, and that ordering is not this fixture's law.
      const ledger = appliance.providers.calls.map((call) => `${call.lane}:${call.status}`).sort();
      assert.deepEqual(ledger, [
        'ask_drafting:200', 'ask_drafting:200',
        'bank_line_disposition:200', 'bank_line_disposition:200',
        'bank_statement_extraction:200',
        'document_routing:200', 'document_routing:200',
        'reconciliation_reasoning:200',
        'transaction_coding:418',
        'unified_extraction:200'
      ]);
      for (const call of appliance.providers.calls.filter((c) => c.status === 200)) {
        assert.equal(call.model_requested, call.model_served, `${call.lane} asked for the model the recording answers as`);
      }
    } finally {
      await appliance.stop();
    }
  }
);
