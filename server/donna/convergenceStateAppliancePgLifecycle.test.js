// RT-13 on the appliance (docs/plan-2026-09-01-runtime-refactor-slices.md §5
// RT-13; audit F-08 / F-14): the persisted convergence verdict stays equal to
// the ONE derivation across the REAL desktop path — createDonnaRuntimeServer,
// the local scheduler, the parse-document job, the matchers, the terminal
// drain, the ask lanes — on the RT-06 harness against real PostgreSQL:
//
//   client A: the two-line Barclays statement (RT-11's recordings: the Ochre
//     payment rests chase_receipt, the PayLink payout chase_evidence) → two
//     owner asks land raw on the Ochre line → the Ochre bill parses and the
//     strong matcher settles it at 0.94 under material_auto_fyi (D2), the
//     cascade answers the document ask and keeps the purpose ask (D3) → the
//     runtime's own draft carries the FYI and the send mints the payout ask;
//   client C: a JUDGMENT needs_human on a bill (RT-10 (c)) — the owner ask
//     minted in the stamp's transaction puts the document on the owner;
//   client D: a TECHNICAL needs_human (RT-10 (c′)) — the machine re-run lane
//     rests hanging under `disposition:needs_human:machine_rerun`.
//
// After EVERY tick, every transaction and document of the run is asserted:
// column == a fresh derivation from the row's inputs, and no unsettled mark
// rests on the run. The nightly `convergence-drift-nightly` manifest function
// then runs through the scheduler and reports zero drift; and the reconcile
// orchestrator's `lines_left_hanging` — the stat the deleted SQL mirror used
// to compute — is shown equal to the column's own count.

import assert from 'node:assert/strict';
import test from 'node:test';

import { applianceHarnessSkipReason, bootApplianceForTest } from './testSupport/applianceHarness.js';
import { loadRecording } from './testSupport/recordedProviders.js';
import { computeConvergenceForTransactions, computeConvergenceForDocuments } from './reconcileConvergenceState.js';
import { CONVERGENCE_DRIFT_AUDIT_ACTION, CONVERGENCE_DRIFT_FUNCTION_ID } from './convergenceDriftCheck.js';
import { runReconciliationForBankStatementInDb } from './parseDocumentsDb.js';
import { queryFirmDb } from './firmDb.js';

const dispositionBody = (mutate) => {
  const rec = loadRecording('document_disposition/ochre-bill-uncovered-account');
  const body = JSON.parse(JSON.stringify(rec.body));
  const parsed = JSON.parse(body.content[0].text);
  mutate(parsed);
  body.content[0].text = JSON.stringify(parsed);
  return { status: 200, body };
};
const NEEDS_HUMAN_VERDICT = () => dispositionBody((p) => {
  p.disposition = 'needs_human';
  p.materiality = 'material';
  p.settlement_channel = 'unknown';
  p.confidence = 0.41;
  p.reasoning = 'The bill could be a personal purchase routed through the business; only the owner can say.';
});

test(
  'real PG (appliance, RT-13): the persisted convergence column equals the derivation after every tick, the nightly receipt reads zero drift, the reconcile stats count the column',
  { skip: applianceHarnessSkipReason() },
  async () => {
    const appliance = await bootApplianceForTest({ now: new Date('2026-08-31T09:00:00.000Z') });
    const db = { query: appliance.query };
    const firmId = appliance.firmId;

    // The consistency assertion over the WHOLE run: every tx / doc column equals
    // a fresh derivation, and nothing rests marked.
    const assertRunConverged = async (label) => {
      const txIds = (await appliance.query('select id from transactions where firm_id = $1 order by id', [firmId])).rows.map((r) => r.id);
      const docIds = (await appliance.query('select id from documents where firm_id = $1 order by id', [firmId])).rows.map((r) => r.id);
      const computed = [
        ...await computeConvergenceForTransactions(db, { firmId, transactionIds: txIds }),
        ...await computeConvergenceForDocuments(db, { firmId, documentIds: docIds })
      ];
      for (const c of computed) {
        assert.deepEqual(
          { state: c.persisted.state, reason: c.persisted.reason },
          { state: c.derived?.state ?? null, reason: c.derived?.reason ?? null },
          `${label}: ${c.target_type} ${c.target_id} column == derivation`
        );
        if (c.derived) assert.ok(c.persisted.as_of, `${label}: ${c.target_type} ${c.target_id} as_of stamped`);
      }
      const marks = await appliance.query('select count(*)::int as n from convergence_marks where firm_id = $1', [firmId]);
      assert.equal(marks.rows[0].n, 0, `${label}: no unsettled marks after the tick`);
      return computed;
    };
    const verdictOf = (computed, targetType, targetId) => {
      const c = computed.find((x) => x.target_type === targetType && x.target_id === targetId);
      return c ? { state: c.persisted.state, reason: c.persisted.reason } : undefined;
    };

    try {
      const { clientId } = await appliance.createClient();

      // ── The statement: two bare lines, two dispositions (RT-11's recordings). ──
      appliance.providers.script('document_routing', ['document_routing/kestrel-bank-statement']);
      appliance.providers.script('bank_statement_extraction', ['bank_statement_extraction/kestrel-barclays-two-lines']);
      appliance.providers.script('transaction_coding', [{ status: 418, body: { error: { type: 'fixture_lane_dark', message: 'coding is not what this fixture proves' } } }]);
      appliance.providers.script('bank_line_disposition', [
        'bank_line_disposition/kestrel-ochre-debit-chase-receipt',
        'bank_line_disposition/kestrel-paylink-credit-chase-evidence'
      ]);
      appliance.providers.script('ask_drafting', [
        'ask_drafting/kestrel-payout-report-only',
        'ask_drafting/kestrel-material-fyi-and-payout-ask'
      ]);
      const statement = await appliance.uploadDocument({ clientId, fixture: 'bank_statement_two_lines' });
      const statementTick = await appliance.tick();
      const statementDoc = await appliance.read.document(statement.documentId);
      assert.equal(statementDoc.parse_status, 'completed', JSON.stringify({ parse: statementDoc.parse_error, jobs: statementTick.jobs.map((j) => [j.function_id, j.status, j.last_error]) }));
      const transactions = await appliance.read.transactions(clientId);
      const ochreLine = transactions.find((tx) => Number(tx.money_out) === 550);
      const payoutLine = transactions.find((tx) => Number(tx.money_in) === 1213.75);
      assert.ok(ochreLine && payoutLine, JSON.stringify(transactions.map((tx) => [tx.description, tx.money_in, tx.money_out])));
      let computed = await assertRunConverged('after the statement tick');
      // RT-16: the parse writer minted an OPEN review-queue CASE FILE for each
      // unmatched line (no coding state on it — the column is gone). The batch
      // coder is scripted DARK (a 418 at the wire): since 2026-09-12 a provider
      // failure is never written as a verdict — the lines stay BARE on the one
      // column with the cause receipted (`coding_provider_failure`), owed to the
      // convergence clock. A bare line under a chase verdict is firm-side limbo
      // all the same: both rest hanging, the chase_receipt / chase_evidence
      // verdicts beneath. (Until then the deterministic template was persisted
      // and both lines rested `coding_state:proposed`.)
      const reviewRows = (await appliance.read.reviewQueue(clientId)).filter((r) => r.status === 'open');
      assert.deepEqual(reviewRows.map((r) => r.payload?.transaction_id).sort(), [ochreLine.id, payoutLine.id].sort());
      assert.ok(reviewRows.every((r) => r.review_state === undefined && r.payload?.review_state === undefined), 'a case file carries no coding state');
      assert.deepEqual([ochreLine.coding_state, payoutLine.coding_state], [null, null], 'a dark coding lane leaves no verdict on the one column');
      assert.deepEqual([ochreLine.payload?.ai_suggestion ?? null, payoutLine.payload?.ai_suggestion ?? null], [null, null], 'no template verdict is persisted for a provider failure');
      assert.equal(ochreLine.payload?.coding_provider_failure?.status, 418, 'the provider cause rides the line');
      assert.deepEqual(verdictOf(computed, 'transaction', ochreLine.id), { state: 'hanging', reason: 'disposition:chase_receipt' }, 'the Ochre payment: a bare line rests hanging under its chase_receipt verdict');
      assert.deepEqual(verdictOf(computed, 'transaction', payoutLine.id), { state: 'hanging', reason: 'disposition:chase_evidence' }, 'the payout: the same, under its chase_evidence verdict');
      const dispositions = (await appliance.read.evaluations(clientId)).filter((row) => row.matcher_family === 'bank_line_disposition');
      assert.deepEqual(
        dispositions.map((row) => [row.target_id, row.payload?.disposition]).sort(),
        [[ochreLine.id, 'chase_receipt'], [payoutLine.id, 'chase_evidence']].sort(),
        'the verdicts beneath the review rows'
      );
      assert.deepEqual(verdictOf(computed, 'document', statement.documentId), { state: null, reason: null }, 'a statement is not a reconcile row');

      // ── Two owner asks land RAW on the Ochre line (outside any hooked connection):
      //    the mark waits; the next runtime activity sweeps it. ──
      for (const [id, evidenceType, question] of [
        ['ask-purpose', 'business_purpose', 'Was the Ochre Lighting payment wholly for the studio rather than personal?'],
        ['ask-doc', 'supporting_document', 'Please send the Ochre Lighting invoice.']
      ]) {
        await appliance.query(
          `insert into client_evidence_requests
             (id, firm_id, client_id, transaction_id, status, evidence_type, question, request_payload, created_by, audience)
           values ($1, $2, $3, $4, 'open', $5, $6, '{}'::jsonb, 'ask_batch', 'client')`,
          [`${clientId}-${id}`, firmId, clientId, ochreLine.id, evidenceType, question]
        );
      }
      const rawMarks = await appliance.query('select count(*)::int as n from convergence_marks where firm_id = $1 and target_id = $2', [firmId, ochreLine.id]);
      assert.ok(rawMarks.rows[0].n >= 1, 'a raw insert leaves its mark for the next sweep');

      // ── The bill: routed, extracted, matched at 0.94 (material, FYI'd), cascaded. ──
      appliance.providers.script('document_routing', ['document_routing/ochre-supplier-bill']);
      appliance.providers.script('supplier_bill_extraction', ['supplier_bill_extraction/ochre-discount-line']);
      appliance.providers.script('reconciliation_reasoning', ['reconciliation_reasoning/ochre-bill-settled-by-candidate-1']);
      const bill = await appliance.uploadDocument({ clientId, fixture: 'supplier_bill_discount' });
      const billTick = await appliance.tick();
      const billDoc = await appliance.read.document(bill.documentId);
      assert.equal(billDoc.parse_status, 'completed', JSON.stringify({ parse: billDoc.parse_error, jobs: billTick.jobs.map((j) => [j.function_id, j.status, j.last_error]), unscripted: appliance.providers.unscripted }));
      const match = (await appliance.read.matches(clientId)).find((row) => row.matched_object_id === bill.documentId);
      assert.equal(match?.status, 'auto_matched', JSON.stringify(match?.payload?.authorization));
      computed = await assertRunConverged('after the bill tick');
      assert.deepEqual(verdictOf(computed, 'transaction', ochreLine.id), { state: 'on_owner', reason: 'open_owner_ask' }, 'D3: the match settled the line, the purpose ask still holds it on the owner');
      assert.deepEqual(verdictOf(computed, 'document', bill.documentId), { state: null, reason: null }, 'a matched bill carries no verdict of its own — its line does');
      const asks = await appliance.read.asks(clientId);
      assert.equal(asks.find((row) => row.id === `${clientId}-ask-doc`).status, 'resolved');
      assert.equal(asks.find((row) => row.id === `${clientId}-ask-purpose`).status, 'open');

      // ── Decide-and-notify: the runtime drafts, the send mints the payout ask. ──
      await appliance.tick();
      computed = await assertRunConverged('after the draft tick');
      const batches = (await appliance.query(
        "select id, status from client_ask_batches where firm_id = $1 and client_id = $2 and status = 'draft' order by created_at desc limit 1",
        [firmId, clientId]
      )).rows;
      assert.equal(batches.length, 1, 'the post-match draft is pending');
      const sent = await appliance.api.request({
        method: 'POST', path: `/api/donna/firms/ask-batches/${encodeURIComponent(batches[0].id)}/send`, auth: true,
        body: { firm_id: firmId, client_id: clientId }
      });
      assert.equal(sent.status, 200, `send route: ${sent.text.slice(0, 600)}`);
      computed = await assertRunConverged('after the send');
      assert.deepEqual(verdictOf(computed, 'transaction', payoutLine.id), { state: 'on_owner', reason: 'open_owner_ask' }, 'the payout ask landed: the line moved from hanging to the owner');
      assert.deepEqual(verdictOf(computed, 'transaction', ochreLine.id), { state: 'on_owner', reason: 'open_owner_ask' });
      // The owner answers the purpose question: Donna owes the processing (F8).
      const answered = await appliance.api.request({
        method: 'POST', path: `/api/donna/firms/evidence-requests/${encodeURIComponent(`${clientId}-ask-purpose`)}/resolve`, auth: true,
        body: { firm_id: firmId, client_id: clientId, reply: 'Studio lighting for the print room.', next_review_state: 'resolved' }
      });
      if (answered.status === 200) {
        computed = await assertRunConverged('after the owner reply');
        // RT-16: the firm resolved the purpose ask with next_review_state
        // 'resolved' — a decision on the line (the machine: asked/proposed →
        // applied). The match settled the bank line, the owner answered, the
        // firm decided: auto_reconciled on the ONE column. (Before RT-16 the
        // case file's stale 'suggested' outranked that decision — Leak B.)
        assert.equal((await appliance.read.transactions(clientId)).find((tx) => tx.id === ochreLine.id).coding_state, 'applied');
        assert.deepEqual(verdictOf(computed, 'transaction', ochreLine.id), { state: 'auto_reconciled', reason: 'coding_state:applied' }, 'purpose answered and resolved on a settled line: applied');
      } else {
        // The resolve route is not this fixture's law; a shape mismatch only
        // skips the reply leg. The reply lands through the runtime's own pool
        // (pool.query, no borrowed client) — the write-shaped sweep settles it
        // within the same call.
        await queryFirmDb("update client_evidence_requests set status = 'replied' where id = $1", [`${clientId}-ask-purpose`]);
        computed = await assertRunConverged('after a pool.query reply');
        assert.deepEqual(verdictOf(computed, 'transaction', ochreLine.id), { state: 'hanging', reason: 'owner_answered_processing' }, 'F8: an answered ask is Donna\'s work, never credited to the owner');
      }

      // ── Client C: a JUDGMENT needs_human → the owner ask minted in the stamp's transaction. ──
      appliance.providers.script('ask_drafting', [{ status: 503, times: Infinity }]);
      const { clientId: clientC } = await appliance.createClient();
      appliance.providers.script('document_routing', ['document_routing/ochre-supplier-bill']);
      appliance.providers.script('supplier_bill_extraction', ['supplier_bill_extraction/ochre-discount-line']);
      appliance.providers.script('document_disposition', [NEEDS_HUMAN_VERDICT()]);
      const billC = await appliance.uploadDocument({ clientId: clientC, fixture: 'supplier_bill_discount' });
      const tickC = await appliance.tick();
      assert.equal((await appliance.read.document(billC.documentId)).parse_status, 'completed', JSON.stringify(tickC.jobs.map((j) => [j.function_id, j.status, j.last_error])));
      const evalC = (await appliance.read.evaluations(clientC, { targetId: billC.documentId })).find((row) => row.matcher_family === 'document_no_line_disposition');
      assert.equal(evalC?.payload?.lane?.kind, 'owner_ask', JSON.stringify(evalC?.payload));
      computed = await assertRunConverged('after the judgment lane');
      assert.deepEqual(verdictOf(computed, 'document', billC.documentId), { state: 'on_owner', reason: 'open_owner_ask' }, 'RT-10 (c): the verdict and its ask land together, the document rests on the owner');

      // ── Client D: a TECHNICAL needs_human → the bounded machine re-run lane. ──
      const { clientId: clientD } = await appliance.createClient();
      appliance.providers.script('document_routing', ['document_routing/ochre-supplier-bill']);
      appliance.providers.script('supplier_bill_extraction', ['supplier_bill_extraction/ochre-discount-line']);
      appliance.providers.script('document_disposition', [{ status: 418, body: { error: { type: 'overloaded_error', message: 'scripted outage' } } }]);
      const billD = await appliance.uploadDocument({ clientId: clientD, fixture: 'supplier_bill_discount' });
      const tickD = await appliance.tick();
      assert.equal((await appliance.read.document(billD.documentId)).parse_status, 'completed', JSON.stringify(tickD.jobs.map((j) => [j.function_id, j.status, j.last_error])));
      const evalD = (await appliance.read.evaluations(clientD, { targetId: billD.documentId })).find((row) => row.matcher_family === 'document_no_line_disposition');
      assert.equal(evalD?.payload?.lane?.kind, 'machine_rerun', JSON.stringify(evalD?.payload));
      computed = await assertRunConverged('after the technical lane');
      assert.deepEqual(verdictOf(computed, 'document', billD.documentId), { state: 'hanging', reason: 'disposition:needs_human:machine_rerun' }, 'RT-10 (c′): a scheduled re-run is Donna\'s work in flight, named by its lane');

      // ── The nightly receipt, through the scheduler, over the persisted column. ──
      assert.ok(appliance.manifest.some((entry) => entry.functionId === CONVERGENCE_DRIFT_FUNCTION_ID), 'the nightly is on the desktop manifest');
      // The cron matcher is UTC-based and the scheduler enqueues the LATEST
      // due occurrence: a 25-hour advance makes a daily cron due exactly once,
      // whatever the process TZ.
      const nightly = await appliance.tick({ functions: [CONVERGENCE_DRIFT_FUNCTION_ID], advanceMs: 25 * 60 * 60_000 });
      const nightlyJob = nightly.jobs.find((job) => job.function_id === CONVERGENCE_DRIFT_FUNCTION_ID);
      assert.ok(nightlyJob, `the nightly ran: ${JSON.stringify(nightly.jobs.map((j) => [j.function_id, j.status]))}`);
      assert.equal(nightlyJob.status, 'succeeded', nightlyJob.last_error);
      assert.equal(nightlyJob.result?.drift_count, 0, JSON.stringify(nightlyJob.result));
      assert.equal(nightlyJob.result?.unsettled_marks, 0);
      assert.ok(nightlyJob.result?.rows_checked >= 5, JSON.stringify(nightlyJob.result));
      const receipts = await appliance.read.audit({ action: CONVERGENCE_DRIFT_AUDIT_ACTION });
      assert.equal(receipts.length, 1, 'one receipt for the firm');
      assert.equal(receipts[0].metadata.converged, true);
      assert.equal(receipts[0].metadata.drift_count, 0);

      // ── The reconcile orchestrator's convergence stat is the column's own count. ──
      // The matchers, the drain and the drafter all run inside; every candidate
      // already carries its verdict so the guards skip the models, and any lane
      // that IS hit answers with a terminal refusal the receipts name honestly.
      for (const lane of ['reconciliation_reasoning', 'bank_line_disposition', 'document_disposition', 'transaction_coding']) {
        appliance.providers.script(lane, [{ status: 418, body: { error: { type: 'fixture_lane_dark', message: 'the stats, not the models, are under test' } }, times: Infinity }]);
      }
      process.env.BANK_STATEMENT_MATCHER_ENABLED = process.env.BANK_STATEMENT_MATCHER_ENABLED || 'true';
      const stats = await runReconciliationForBankStatementInDb({ firmId, clientId });
      const columnCount = (await appliance.query(
        `select count(*) filter (where convergence_state = 'hanging')::int as hanging,
                count(*) filter (where convergence_state = 'hanging' and convergence_reason = 'disposition:chase_evidence')::int as awaiting
           from transactions where firm_id = $1 and client_id = $2 and (coalesce(money_in, 0) > 0 or coalesce(money_out, 0) > 0)`,
        [firmId, clientId]
      )).rows[0];
      assert.equal(stats.lines_left_hanging, columnCount.hanging, JSON.stringify({ stats, columnCount }));
      assert.equal(stats.lines_awaiting_ask, columnCount.awaiting);
      await assertRunConverged('after the reconcile stats read');
    } finally {
      await appliance.stop();
    }
  }
);
