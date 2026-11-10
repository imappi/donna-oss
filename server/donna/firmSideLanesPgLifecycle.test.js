// RT-10 — firm-side rows get lanes (docs/plan-2026-09-01-runtime-refactor-slices.md
// §5 RT-10; audit F-05 tail, F-08, F-13). The three acceptance fixtures the
// slice names, on the RT-06 appliance harness against a real PostgreSQL:
//
//   (a) a non-footing bill → ONE strong re-read (the document's own extractor,
//       the persisted numbers in the prompt) → still off → one open owner ask
//       (evidence_type supporting_document, anchored on the document and the
//       review row) → the review row resolves when the ask resolves. And the
//       twin: a re-read that FOOTS writes no review row and no ask.
//   (b) a byte-identical re-upload → auto-collapsed onto the canonical at
//       register time: terminal, no duplicate_pending row, no parse run, one
//       document.duplicate.auto_collapsed receipt.
//   (c) a needs_human disposition → an owner ask exists in the SAME
//       transaction as the verdict (a judgment verdict), or a scheduled
//       machine re-run job exists (a technical one) — and the re-run actually
//       re-evaluates the document when it is due.
//
// Written FIRST and watched fail on the pre-RT-10 tree (the review row rested
// firm-side with no ask; the re-upload landed duplicate_pending; needs_human
// stamped and rested).

import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveClientEvidenceRequestInDb } from './firmDb.js';
import { applianceHarnessSkipReason, bootApplianceForTest } from './testSupport/applianceHarness.js';
import { loadRecording } from './testSupport/recordedProviders.js';

// Wire-shaped variants of the committed Ochre recordings: the same bill with a
// printed total the lines do not reach (550 vs 600), a re-read that finds the
// dropped delivery line (500 + 50 + 50 = 600), and a needs_human verdict.
const billBody = (mutate) => {
  // RT-12: the unified extractor is the appliance default — the wire is the
  // unified lane's Anthropic recording (both keys present on this host).
  const rec = loadRecording('unified_extraction/ochre-discount-line');
  const body = JSON.parse(JSON.stringify(rec.body));
  const parsed = JSON.parse(body.content[0].text);
  mutate(parsed);
  body.content[0].text = JSON.stringify(parsed);
  return { status: 200, body };
};
const NON_FOOTING_BILL = () => billBody((p) => { p.header.total_amount = 600; });
const FOOTING_REREAD = () => billBody((p) => {
  p.header.total_amount = 600;
  p.header.subtotal_amount = 600;
  p.lines.push({ description: 'Delivery', quantity: 1, unit_price: 50, amount: 50, tax_rate: 0 });
});
// The router recording re-pointed at the receipt family (the committed
// routing recordings classify the bill and the payout; the screwfix receipt
// needs its own verdict so the router does not re-type it as a bill).
const ROUTE_RECEIPT = () => {
  const rec = loadRecording('document_routing/ochre-supplier-bill');
  const body = JSON.parse(JSON.stringify(rec.body));
  const parsed = JSON.parse(body.output[0].content[0].text);
  parsed.document_family = 'receipt';
  parsed.candidate_families = [{ family: 'receipt', confidence: 0.97 }, { family: 'invoice_or_bill', confidence: 0.02 }];
  parsed.reason = 'A till receipt from Screwfix for goods paid at the counter.';
  body.output[0].content[0].text = JSON.stringify(parsed);
  return { status: 200, body };
};
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
  p.owner_question = 'Was this lighting purchased for the business or for personal use?';
  p.owner_question_evidence_type = 'business_purpose';
});

// RT-14: the drain has no desktop entry; a tick's proof is the parse job it
// settled (the parse_status asserts below), not a drain receipt.
const assertNoDrain = (receipt) => assert.ok(!receipt.jobs.some((job) => job.function_id === 'parse-cron:drain'), 'no drain job on the appliance');

test(
  'real PG (RT-10): non-footing bill → one re-read → owner ask; footing re-read → no row; byte re-upload auto-collapses; needs_human → ask or scheduled re-run',
  { skip: applianceHarnessSkipReason() },
  async () => {
    const appliance = await bootApplianceForTest({ now: new Date('2026-08-31T09:00:00.000Z') });
    try {
      const routing = 'document_routing/ochre-supplier-bill';
      // The ask-batch DRAFTER (the digest layer over the asks these lanes
      // mint) wakes after each reconcile; it is RT-11's lane and has no
      // recording. A scripted refusal keeps it off the unscripted ledger —
      // the asks below exist regardless of the drafter (that is the point).
      appliance.providers.script('ask_drafting', [{ status: 503, times: Infinity }]);
      const laneCalls = (lane) => appliance.providers.callsFor(lane).length;

      // ── (a) the non-footing bill: re-read once, still off, on the owner ──
      const { clientId: clientA } = await appliance.createClient();
      appliance.providers.script('document_routing', [routing]);
      appliance.providers.script('unified_extraction', [NON_FOOTING_BILL(), NON_FOOTING_BILL()]);
      const billA = await appliance.uploadDocument({ clientId: clientA, fixture: 'supplier_bill_discount' });
      const tickA = await appliance.tick();
      assertNoDrain(tickA);
      const docA = await appliance.read.document(billA.documentId);
      assert.equal(docA.parse_status, 'completed', JSON.stringify({ parse_error: docA.parse_error, calls: appliance.providers.calls.map((c) => [c.seq, c.lane, c.status, c.recording]), log: tickA.log }));
      assert.equal(Number(docA.total_amount), 600, 'the header total is what the matcher sees');
      const extractionCalls = appliance.providers.callsFor('unified_extraction');
      assert.equal(extractionCalls.length, 2, 'exactly one re-read on the same extractor lane');
      assert.ok(extractionCalls[1].body_bytes > extractionCalls[0].body_bytes, 'the re-read carried the extra prompt fragment');
      const rereadA = docA.parse_summary?.totals_reread;
      assert.ok(rereadA, 'parse_summary carries the re-read receipt');
      assert.equal(rereadA.attempted, true);
      assert.equal(rereadA.outcome, 'still_off');
      assert.equal(rereadA.extractor, 'unified', 'the document\'s own extractor — the unified lane since RT-12');
      assert.equal(rereadA.model, 'claude-opus-4-8', 'the model id is part of the receipt');
      assert.equal(rereadA.parse_run_id, docA.parse_run_id);
      assert.equal(docA.parse_summary.totals_validation.drift, 50);
      // The review row exists, and rests on the OWNER: lane owner_ask + the ask.
      const rowsA = (await appliance.read.reviewQueue(clientA)).filter((r) => r.reason === 'amount_mismatch');
      assert.equal(rowsA.length, 1, JSON.stringify(rowsA));
      assert.equal(rowsA[0].status, 'open');
      assert.equal(rowsA[0].payload.lane?.kind, 'owner_ask', JSON.stringify(rowsA[0].payload));
      assert.equal(rowsA[0].payload.totals_reread?.outcome, 'still_off');
      assert.ok(rowsA[0].payload.evidence_request, 'the ask writer stamped the anchored row (RT-16: the case file carries the ask context, never a coding state)');
      const asksA = await appliance.read.asks(clientA);
      assert.equal(asksA.length, 1, JSON.stringify(asksA.map((a) => [a.evidence_type, a.status])));
      const askA = asksA[0];
      assert.equal(askA.id, rowsA[0].payload.lane.evidence_request_id);
      assert.equal(askA.status, 'draft');
      assert.equal(askA.evidence_type, 'supporting_document');
      assert.equal(askA.request_payload.document_id, billA.documentId);
      assert.equal(askA.review_item_id, rowsA[0].id, 'anchored on the review row so the resolve path flips it');
      assert.equal(askA.request_payload.lane, 'totals_mismatch');
      assert.match(askA.question, /600\.00/);
      assert.match(askA.question, /550\.00/);
      assert.equal(askA.audience, 'client');
      // The doc-first drain saw an open ask on the document and left it alone.
      assert.equal(appliance.providers.callsFor('document_disposition').length, 0, 'no disposition call while the owner holds the doc');
      // Same transaction: the ask's create audit and the parse-completed audit
      // are both there, and the parse audit names the lane + the numbers.
      const completedA = (await appliance.read.audit({ clientId: clientA, action: 'document.parse.completed' })).find((row) => row.resource_id === billA.documentId);
      assert.equal(completedA.metadata.totals_lane, 'owner_ask');
      assert.equal(completedA.metadata.totals_owner_ask_id, askA.id);
      assert.equal(completedA.metadata.totals_validation.drift, 50);
      assert.equal(completedA.metadata.totals_reread.outcome, 'still_off');
      assert.ok((await appliance.read.audit({ clientId: clientA, action: 'evidence_request.create' })).some((row) => row.resource_id === askA.id));
      // The review row resolves when the ask resolves.
      await resolveClientEvidenceRequestInDb({
        firmId: appliance.firmId,
        evidenceRequestId: askA.id,
        reply: 'The delivery line is missing — the printed total is right.',
        nextReviewState: 'resolved',
        actorId: appliance.memberId,
        actorType: 'member'
      });
      const rowsAfter = (await appliance.read.reviewQueue(clientA)).filter((r) => r.reason === 'amount_mismatch');
      assert.equal(rowsAfter[0].status, 'resolved', 'the anchored review row followed the ask');
      assert.equal((await appliance.read.asks(clientA))[0].status, 'resolved');

      // ── (a′) the footing twin: the re-read finds the dropped line ──
      const { clientId: clientB } = await appliance.createClient();
      appliance.providers.script('document_routing', [routing]);
      appliance.providers.script('unified_extraction', [NON_FOOTING_BILL(), FOOTING_REREAD()]);
      appliance.providers.script('document_disposition', ['document_disposition/ochre-bill-uncovered-account']);
      const billB = await appliance.uploadDocument({ clientId: clientB, fixture: 'supplier_bill_discount' });
      const tickB = await appliance.tick();
      assertNoDrain(tickB);
      const docB = await appliance.read.document(billB.documentId);
      assert.equal(docB.parse_status, 'completed', JSON.stringify({ parse_error: docB.parse_error, calls: appliance.providers.calls.map((c) => [c.seq, c.lane, c.status, c.recording]), log: tickB.log.slice(-12) }));
      assert.equal(docB.parse_summary.totals_reread.outcome, 'footed');
      assert.equal(docB.parse_summary.totals_reread.lines_replaced, true);
      assert.equal(docB.parse_summary.totals_validation.matches, true);
      assert.equal(docB.parse_summary.warnings.includes('amount_mismatch'), false);
      assert.equal(Number(docB.total_amount), 600);
      const linesB = await appliance.read.documentLines(billB.documentId);
      assert.equal(linesB.length, 3, 'the re-read lines are the ones written');
      assert.equal(linesB.reduce((sum, line) => sum + Number(line.amount), 0), 600);
      assert.equal((await appliance.read.reviewQueue(clientB)).filter((r) => r.reason === 'amount_mismatch').length, 0, 'a footing re-read needs no review row');
      assert.equal((await appliance.read.asks(clientB)).filter((a) => a.evidence_type === 'supporting_document').length, 0, 'and no totals ask');
      assert.equal(appliance.providers.callsFor('unified_extraction').length, 4);

      // ── (b) the byte-identical re-upload auto-collapses at register ──
      appliance.providers.script('document_routing', [ROUTE_RECEIPT()]);
      appliance.providers.script('unified_extraction', ['unified_extraction/screwfix-receipt']);
      appliance.providers.script('document_disposition', ['document_disposition/ochre-bill-uncovered-account']);
      const receipt1 = await appliance.uploadDocument({ clientId: clientA, fixture: 'receipt_screwfix' });
      const tickR = await appliance.tick();
      assertNoDrain(tickR);
      const canonical = await appliance.read.document(receipt1.documentId);
      assert.equal(canonical.parse_status, 'completed', JSON.stringify({ parse_error: canonical.parse_error, calls: appliance.providers.calls.map((c) => [c.seq, c.lane, c.status, c.recording]), log: tickR.log.slice(-12) }));
      const parseCallsBefore = {
        routing: laneCalls('document_routing'),
        extraction: laneCalls('unified_extraction'),
        disposition: laneCalls('document_disposition')
      };
      const receipt2 = await appliance.uploadDocument({ clientId: clientA, fixture: 'receipt_screwfix' });
      assert.equal(receipt2.checksum, receipt1.checksum, 'same bytes');
      assert.equal(receipt2.registered?.parse_status, 'skipped', JSON.stringify(receipt2.registered));
      assert.equal(receipt2.registered?.duplicate_reason, 'byte_match');
      assert.equal(receipt2.registered?.duplicate_of, receipt1.documentId);
      assert.equal(receipt2.registered?.parse_summary?.reason, 'duplicate_auto_collapsed');
      assert.equal(receipt2.registered?.parse_summary?.existing_filename, canonical.filename);
      const collapsed = await appliance.read.document(receipt2.documentId);
      assert.equal(collapsed.parse_status, 'skipped');
      assert.equal(collapsed.duplicate_of, receipt1.documentId);
      assert.equal(collapsed.parse_run_id, null, 'no parse run was minted');
      assert.ok(collapsed.parse_completed_at, 'terminal at register time');
      assert.equal((await appliance.read.documents(clientA)).filter((d) => d.parse_status === 'duplicate_pending').length, 0, 'no duplicate_pending placeholder');
      const collapseAudits = await appliance.read.audit({ clientId: clientA, action: 'document.duplicate.auto_collapsed' });
      assert.equal(collapseAudits.length, 1, 'one receipt');
      assert.equal(collapseAudits[0].resource_id, receipt2.documentId);
      assert.equal(collapseAudits[0].metadata.duplicate_of, receipt1.documentId);
      assert.equal(collapseAudits[0].metadata.canonical_parse_status, 'completed');
      assert.equal((await appliance.read.audit({ clientId: clientA, action: 'document.parse.duplicate_pending' })).length, 0);
      const tickDup = await appliance.tick();
      assertNoDrain(tickDup);
      assert.deepEqual(
        { routing: laneCalls('document_routing'), extraction: laneCalls('unified_extraction'), disposition: laneCalls('document_disposition') },
        parseCallsBefore,
        'the collapsed upload cost no routing / extraction / disposition call'
      );
      assert.equal((await appliance.read.document(receipt2.documentId)).parse_status, 'skipped', 'and stays terminal');

      // ── (c) needs_human: a JUDGMENT verdict → the owner ask, same transaction ──
      const { clientId: clientC } = await appliance.createClient();
      appliance.providers.script('document_routing', [routing]);
      appliance.providers.script('unified_extraction', ['unified_extraction/ochre-discount-line']);
      appliance.providers.script('document_disposition', [NEEDS_HUMAN_VERDICT()]);
      const billC = await appliance.uploadDocument({ clientId: clientC, fixture: 'supplier_bill_discount' });
      const tickC = await appliance.tick();
      assertNoDrain(tickC);
      assert.equal((await appliance.read.document(billC.documentId)).parse_status, 'completed');
      const evalC = (await appliance.read.evaluations(clientC, { targetId: billC.documentId })).find((row) => row.matcher_family === 'document_no_line_disposition');
      assert.ok(evalC, 'the disposition verdict was stamped');
      assert.equal(evalC.payload.disposition, 'needs_human');
      assert.equal(evalC.payload.lane?.kind, 'owner_ask', JSON.stringify(evalC.payload));
      const asksC = await appliance.read.asks(clientC);
      const askC = asksC.find((a) => a.id === evalC.payload.lane.evidence_request_id);
      assert.ok(askC, `the ask the verdict names exists: ${JSON.stringify(asksC.map((a) => [a.id, a.evidence_type]))}`);
      assert.equal(askC.status, 'draft');
      assert.equal(askC.evidence_type, 'business_purpose');
      assert.equal(askC.request_payload.document_id, billC.documentId);
      assert.equal(askC.request_payload.lane, 'needs_human_disposition');
      assert.match(askC.question, /Ochre Lighting/);
      assert.match(askC.question, /Was this lighting purchased for the business or for personal use\?/);
      assert.doesNotMatch(askC.question, /only the owner can say/);
      assert.match(askC.question, /dated 2026-08-12/);
      assert.ok((await appliance.read.audit({ clientId: clientC, action: 'document.disposition.owner_asked' })).length >= 1);

      // ── (c′) needs_human: a TECHNICAL verdict → a scheduled machine re-run, then the re-run ──
      const { clientId: clientD } = await appliance.createClient();
      appliance.providers.script('document_routing', [routing]);
      appliance.providers.script('unified_extraction', ['unified_extraction/ochre-discount-line']);
      // 418 is the one status every caller treats as terminal (no retry
      // sleep) — the outage costs exactly one call, so the journal stays
      // deterministic. The core still surfaces it as a transport-class
      // failure (no model judgment existed).
      appliance.providers.script('document_disposition', [{ status: 418, body: { error: { type: 'overloaded_error', message: 'scripted outage' } } }]);
      const billD = await appliance.uploadDocument({ clientId: clientD, fixture: 'supplier_bill_discount' });
      const tickD = await appliance.tick();
      assertNoDrain(tickD);
      assert.equal((await appliance.read.document(billD.documentId)).parse_status, 'completed');
      const evalD = (await appliance.read.evaluations(clientD, { targetId: billD.documentId })).find((row) => row.matcher_family === 'document_no_line_disposition');
      assert.ok(evalD, 'a technical needs_human is still stamped (with its lane)');
      assert.equal(evalD.payload.disposition, 'needs_human');
      assert.equal(evalD.payload.lane?.kind, 'machine_rerun', JSON.stringify(evalD.payload));
      assert.equal(evalD.payload.lane.attempt, 1);
      assert.ok(evalD.payload.lane.due_at, 'a due time is persisted');
      assert.equal((await appliance.read.asks(clientD)).length, 0, 'never an ask minted from an outage');
      const rerunJobs = (await appliance.read.jobs({ functionId: 'document-terminal-drain' }))
        .filter((job) => job.dedupe_key === `machine-rerun:document_no_line_disposition:${billD.documentId}:1`);
      assert.equal(rerunJobs.length, 1, 'a scheduled re-run job exists in local_jobs');
      assert.equal(rerunJobs[0].status, 'pending');
      assert.equal(String(rerunJobs[0].id), String(evalD.payload.lane.job_id), 'the verdict names the job');
      assert.ok(new Date(rerunJobs[0].run_at).getTime() > Date.now(), 'due in the future (backoff)');
      // When the re-run is due, the sweep re-picks the document and a real
      // verdict lands — with its own lane. The drain job sweeps EVERY
      // enrolled client, and client A's bill became a candidate again the
      // moment its totals ask resolved, so the verdict is scripted for each
      // candidate the sweep will see (A's bill, then D's re-run).
      appliance.providers.script('document_disposition', [{ ...NEEDS_HUMAN_VERDICT(), times: 4 }]);
      await appliance.query('update reconciliation_evaluations set payload = jsonb_set(payload, \'{lane,due_at}\', to_jsonb(now()::text)) where id = $1', [evalD.id]);
      const tickRerun = await appliance.tick({ functions: ['document-terminal-drain'] });
      const rerun = tickRerun.jobs.find((job) => String(job.id) === String(rerunJobs[0].id));
      assert.ok(rerun, `the scheduled job ran: ${JSON.stringify(tickRerun.jobs.map((j) => [j.id, j.status]))}`);
      assert.equal(rerun.status, 'succeeded', rerun.last_error);
      const evalD2 = (await appliance.read.evaluations(clientD, { targetId: billD.documentId })).find((row) => row.matcher_family === 'document_no_line_disposition');
      assert.equal(evalD2.payload.lane?.kind, 'owner_ask', JSON.stringify({ payload: evalD2.payload, calls: appliance.providers.callsFor('document_disposition').map((c) => [c.seq, c.status, c.recording]), audits: (await appliance.read.audit({ clientId: clientD })).map((a) => [a.action, a.metadata?.lane?.kind, a.metadata?.unmatchable_reason]), log: tickRerun.log.filter((l) => /disposition|drain|rerun|error/i.test(l)).slice(-20) }));
      const askD = (await appliance.read.asks(clientD)).find((a) => a.id === evalD2.payload.lane.evidence_request_id);
      assert.ok(askD, 'the re-run reached the owner');
      assert.equal(askD.evidence_type, 'business_purpose');

      appliance.providers.assertNoUnscripted();
    } finally {
      await appliance.stop();
    }
  }
);
