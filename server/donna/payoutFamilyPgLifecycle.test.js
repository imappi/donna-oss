// RT-18 acceptance fixtures on the RT-06 appliance harness
// (docs/plan-2026-09-01-runtime-refactor-slices.md §5 RT-18; audit F-04 part
// 2 / F-23): the payout / deposit-slip document family end to end on the
// REAL desktop path — createDonnaRuntimeServer → the local scheduler → the
// parse-cron self-call → drain → router → the unified extractor (RT-12; the
// payout extractor's settlement contract folded in) → the completed_header writer — with every model lane answered from committed
// recordings and the persisted rows read back.
//
//   (a) a payout statement whose filename no regex names uploads as
//       `unknown`; the router types it payout_statement, the extractor reads
//       gross → fees → net, the NET is the header total (what the bank feed
//       shows), the breakdown lands as signed document lines, and the RT-04
//       totals receipt foots. The August statement then arrives AFTER the
//       payout: the credit quotes the payout reference, so the statement
//       refresh's deterministic exact-reference tier (transactionIntel.js,
//       pre-existing for every family) claims the line first at 0.98 with
//       the document's own type on the row, and the payout matcher records
//       the honest `no_candidates` verdict for a line already claimed.
//   (b) a counter deposit slip (cash + one cheque), on a second client so
//       its candidate list is its own: typed deposit_slip, then matched to
//       the September statement's reference-less COUNTER CREDIT — the case
//       the exact-reference tier cannot claim — by the payout matcher at
//       ≥ 0.85 (authorizeMatch gates unchanged: 3,000 rests above the 500
//       materiality ceiling as matched_pending_authority, the honest band,
//       never a silent auto, with the authorization receipt saying so).
//   (c) the Deliveroo-style NON-footing statement (the world's settlement
//       carries a promotional deduction the printed statement omits): the
//       printed net stands, the totals receipt carries the signed drift,
//       `amount_mismatch` opens the document-scoped review row with the
//       receipt in its payload — the owner ask is RT-10's lane to write.
//
// Fail-first record (2026-09-02): on the tree before RT-18 the routing
// recording's family fell outside the router enum, the document rested
// `unknown` / skipped (extractor_unavailable) and the first assertion on
// document_type failed.

import assert from 'node:assert/strict';
import test from 'node:test';

import { applianceHarnessSkipReason, bootApplianceForTest } from './testSupport/applianceHarness.js';
import { loadRecording } from './testSupport/recordedProviders.js';

const money = (value) => (value == null ? null : Number(value));

test(
  'real PG: a payout statement the filename layer cannot name is typed by the router, read as gross → fees → net, and its totals receipt foots; a non-footing one rests with its drift',
  { skip: applianceHarnessSkipReason() },
  async () => {
    const appliance = await bootApplianceForTest({ now: new Date('2026-08-31T09:00:00.000Z') });
    try {
      const { clientId, readiness, flags } = await appliance.createClient();
      assert.equal(readiness?.state, 'ready', JSON.stringify(readiness));
      assert.ok(flags.some((row) => row.flag_key === 'DOCUMENT_LINES_ENABLED' && row.stage === 'auto'), 'lines are seeded on the appliance');

      // ── (a) the footing PayLink settlement ──
      appliance.providers.script('document_routing', ['document_routing/paylink-payout']);
      // RT-12: the unified extractor is the appliance default — the payout
      // family rides it (the settlement equation folded into its mapper).
      appliance.providers.script('unified_extraction', ['unified_extraction/paylink-PO-88121']);
      const payout = await appliance.uploadDocument({ clientId, fixture: 'payout_statement' });
      assert.equal(payout.fixture.documentType, 'unknown', 'uploaded as the SPA sends a filename its classifier does not know');
      assert.equal(payout.registered?.parse_status, 'pending');

      const receipt = await appliance.tick();
      const parseJob = receipt.jobs.find((job) => job.function_id === 'parse-document');
      assert.ok(parseJob, `the parse job ran: ${JSON.stringify(receipt.jobs.map((job) => [job.function_id, job.status]))}`);
      assert.equal(parseJob.status, 'succeeded', parseJob.last_error);

      const document = await appliance.read.document(payout.documentId);
      const { expected } = payout.fixture;
      assert.equal(
        document.parse_status,
        'completed',
        JSON.stringify({ parse_stage: document.parse_stage, parse_error: document.parse_error, log: receipt.log.slice(-15) })
      );
      assert.equal(document.document_type, expected.document_type, 'the router, not the filename, typed it');
      assert.equal(document.direction, expected.direction, 'the firm\'s own revenue arriving');
      assert.equal(document.vendor_name, expected.counterparty_name, 'the provider is the counterparty the bank line names');
      assert.equal(document.customer_name, null);
      assert.equal(money(document.total_amount), expected.net_amount, 'the header total is the NET payout — what the bank feed shows');
      assert.equal(document.currency, expected.currency);
      assert.equal(document.reference_number, expected.reference_number);
      assert.equal(String(document.document_date).slice(0, 10), expected.document_date);
      assert.equal(document.payment_status, 'paid', 'settled by construction');
      assert.equal(document.parse_run_id, payout.registered.parse_run_id, 'the completing run is the registered run');

      const lines = await appliance.read.documentLines(payout.documentId);
      assert.equal(lines.length, expected.line_count, JSON.stringify(lines.map((line) => [line.description, line.amount])));
      assert.deepEqual(lines.map((line) => money(line.amount)), [expected.gross_amount, -expected.fee_amount], 'the breakdown lands as signed lines');

      const summary = document.parse_summary;
      assert.equal(summary.document_type, 'payout_statement');
      assert.equal(summary.counterparty_role, 'processor');
      assert.equal(summary.settlement.gross_sales, expected.gross_amount);
      assert.equal(summary.settlement.fee_total, expected.fee_amount);
      assert.equal(summary.settlement.net_payout, expected.net_amount);
      assert.equal(summary.settlement.period_start, expected.period_start);
      assert.equal(summary.settlement.period_end, expected.period_end);
      assert.equal(summary.settlement.transaction_count, expected.transaction_count);
      assert.equal(summary.settlement.bank_last4, expected.bank_last4);
      assert.equal(summary.settlement.payout_reference, expected.reference_number);
      // The RT-04 receipt shape — read by RT-10's re-read → owner-ask lane
      // without a payout special case.
      assert.equal(summary.totals_validation.matches, true, JSON.stringify(summary.totals_validation));
      assert.equal(summary.totals_validation.expected, expected.net_amount);
      assert.equal(summary.totals_validation.total, expected.net_amount);
      assert.equal(summary.totals_validation.drift, 0);
      assert.equal(summary.totals_validation.basis, 'lines');
      assert.ok(!(summary.warnings || []).includes('amount_mismatch'), JSON.stringify(summary.warnings));
      // The classification receipt: the router saw a payout, wanted the
      // payout extractor, and the override landed without a fallback.
      assert.equal(summary.classification.source, 'router_v1');
      assert.equal(summary.classification.original_type, 'unknown');
      assert.equal(summary.classification.family, expected.router_family);
      assert.equal(summary.classification.direction_hint, expected.router_direction);
      assert.equal(summary.classification.recommended_extractor, 'payout_statement');
      assert.equal(summary.classification.final_type, 'payout_statement');
      assert.equal(summary.classification.fallback_used, false, JSON.stringify(summary.classification));
      // The extractor receipt carries the SERVED model id.
      assert.equal(summary.extractor.path, 'unified', JSON.stringify(summary.extractor));
      assert.equal(summary.extractor.model, loadRecording('unified_extraction/paylink-PO-88121').body.model);

      // Provider receipts: one routing call, one extraction call on the
      // payout lane with the document bytes, requested and served ids agree.
      const routing = appliance.providers.callsFor('document_routing');
      const extraction = appliance.providers.callsFor('unified_extraction');
      assert.equal(routing.length, 1, JSON.stringify(appliance.providers.calls.map((call) => [call.lane, call.status])));
      assert.equal(extraction.length, 1, JSON.stringify(appliance.providers.calls.map((call) => [call.lane, call.status])));
      assert.equal(extraction[0].status, 200);
      assert.equal(extraction[0].endpoint_class, 'anthropic');
      assert.ok(extraction[0].system_prefix.startsWith('You are extracting fields from one financial document'), extraction[0].system_prefix);
      assert.equal(extraction[0].model_requested, extraction[0].model_served, 'the extractor asked for the model the recording answers as');
      assert.ok(extraction[0].body_bytes > payout.fixture.bytes.length, 'the extractor sent the document bytes');
      assert.equal(summary.classification.model, routing[0].model_served);
      appliance.providers.assertNoUnscripted();
      assert.equal(appliance.providers.remaining('document_routing'), 0);
      assert.equal(appliance.providers.remaining('unified_extraction'), 0);

      const footingReview = (await appliance.read.reviewQueue(clientId))
        .filter((row) => row.reason === 'amount_mismatch' && row.payload?.document_id === payout.documentId);
      assert.deepEqual(footingReview, [], 'a footing statement opens no totals review row');

      const actions = new Set((await appliance.read.audit({ clientId })).map((row) => row.action));
      for (const action of ['document.parse.queued', 'document.parse.completed']) {
        assert.ok(actions.has(action), `audit carries ${action}: ${JSON.stringify([...actions])}`);
      }

      // ── (c) the non-footing Northgate Marketplace statement ──
      appliance.providers.reset();
      appliance.providers.script('document_routing', ['document_routing/northgate-marketplace-payout']);
      // The non-footing statement is read once, then RE-READ once by RT-10's
      // lane through the document's own (unified) extractor — the payout
      // family joined TOTALS_REREAD_CAPABLE_TYPES in RT-12.
      appliance.providers.script('unified_extraction', ['unified_extraction/northgate-nonfooting', 'unified_extraction/northgate-nonfooting']);
      const nonfooting = await appliance.uploadDocument({ clientId, fixture: 'payout_statement_nonfooting' });
      const secondReceipt = await appliance.tick();
      const secondParse = secondReceipt.jobs.find((job) => job.function_id === 'parse-document');
      assert.equal(secondParse?.status, 'succeeded', secondParse?.last_error);

      const drifting = await appliance.read.document(nonfooting.documentId);
      const driftExpected = nonfooting.fixture.expected;
      assert.equal(
        drifting.parse_status,
        'completed',
        JSON.stringify({ parse_stage: drifting.parse_stage, parse_error: drifting.parse_error, log: secondReceipt.log.slice(-15) })
      );
      assert.equal(drifting.document_type, 'payout_statement');
      assert.equal(drifting.vendor_name, driftExpected.counterparty_name);
      assert.equal(money(drifting.total_amount), driftExpected.net_amount, 'the printed net stands — never adjusted to foot');
      assert.equal(drifting.reference_number, driftExpected.reference_number);
      const driftSummary = drifting.parse_summary;
      assert.equal(driftSummary.totals_validation.matches, false, JSON.stringify(driftSummary.totals_validation));
      assert.equal(driftSummary.totals_validation.expected, driftExpected.printed_sum, 'gross − commission − VAT on commission, as printed');
      assert.equal(driftSummary.totals_validation.total, driftExpected.net_amount);
      assert.equal(driftSummary.totals_validation.drift, driftExpected.drift, 'signed: total − expected — the deduction the provider never printed');
      assert.equal(driftSummary.totals_validation.basis, 'lines');
      assert.ok(driftSummary.warnings.includes('amount_mismatch'), JSON.stringify(driftSummary.warnings));
      assert.equal(driftSummary.settlement.fee_tax_total, driftExpected.fee_tax_amount);
      assert.deepEqual(driftSummary.tax_registration_ids, { seller: driftExpected.seller_tax_id, buyer: driftExpected.buyer_tax_id }, 'the tax registration ids the statement prints are persisted');
      // The writer records a totals mismatch as ONE document-scoped exception
      // anchored on one line (never N line decisions), and recomputes the
      // count from the open review rows — so the persisted count is 1.
      assert.equal(driftSummary.review_line_count, 1, 'one document-scoped totals exception, anchored on one line');

      const driftLines = await appliance.read.documentLines(nonfooting.documentId);
      assert.deepEqual(driftLines.map((line) => money(line.amount)), [driftExpected.gross_amount, -(driftExpected.fee_amount + driftExpected.fee_tax_amount)]);
      assert.ok(driftLines.every((line) => line.review_status === 'needs_review'), `uncoded breakdown lines rest needs_review: ${JSON.stringify(driftLines.map((line) => line.review_status))}`);

      // The document-scoped totals review row carries the receipt (RT-04);
      // it rests firm-side until RT-10 gives it a lane — asserted here so
      // the payout family never opens a row without its numbers.
      const driftReview = (await appliance.read.reviewQueue(clientId))
        .filter((row) => row.reason === 'amount_mismatch' && row.payload?.document_id === nonfooting.documentId);
      assert.equal(driftReview.length, 1, JSON.stringify(driftReview));
      assert.equal(driftReview[0].status, 'open');
      assert.equal(driftReview[0].item_type, 'document_line');
      assert.equal(driftReview[0].payload?.scope, 'document_totals');
      assert.equal(driftReview[0].payload?.totals_validation?.drift, driftExpected.drift);
      assert.equal(driftReview[0].payload?.totals_validation?.expected, driftExpected.printed_sum);

      appliance.providers.assertNoUnscripted();

      // ── (a) match half: the August statement arrives AFTER the payouts ──
      // The router confirms the statement and the statement extractor
      // yields the two lines. The intel refresh's exact-reference tier
      // (reference + amount + date ≤ 14d, pre-existing for every family)
      // claims the PayLink credit first — the description quotes PO-88121 —
      // so by the time the statement-side orchestrator runs the payout
      // matcher, the line is already settled and the honest verdict is
      // `no_candidates`. The Northgate net is on no line at all.
      appliance.providers.reset();
      appliance.providers.script('document_routing', ['document_routing/kestrel-barclays-statement']);
      appliance.providers.script('bank_statement_extraction', ['bank_statement_extraction/kestrel-barclays-two-lines']);
      const statement = await appliance.uploadDocument({ clientId, fixture: 'bank_statement_two_lines' });
      const statementReceipt = await appliance.tick();
      const statementParse = statementReceipt.jobs.find((job) => job.function_id === 'parse-document');
      assert.equal(statementParse?.status, 'succeeded', statementParse?.last_error);
      const statementDoc = await appliance.read.document(statement.documentId);
      assert.equal(
        statementDoc.parse_status,
        'completed',
        JSON.stringify({ parse_stage: statementDoc.parse_stage, parse_error: statementDoc.parse_error, log: statementReceipt.log.slice(-20) })
      );
      const transactions = await appliance.read.transactions(clientId);
      assert.equal(transactions.length, 2, JSON.stringify(transactions.map((tx) => [tx.description, tx.money_in, tx.money_out])));
      const payoutLine = transactions.find((tx) => money(tx.money_in) === expected.net_amount);
      assert.ok(payoutLine, 'the PayLink credit is on the feed');

      const matches = await appliance.read.matches(clientId);
      const payoutMatch = matches.find((row) => row.matched_object_id === payout.documentId);
      assert.ok(payoutMatch, `the payout is matched: ${JSON.stringify(matches.map((row) => [row.matched_object_type, row.matched_object_id, row.status]))}`);
      assert.equal(payoutMatch.bank_transaction_id, payoutLine.id, 'matched to the money_in line');
      assert.equal(payoutMatch.matched_object_type, 'payout_statement', 'the document type flows onto the row');
      assert.ok(Number(payoutMatch.match_confidence) >= 0.85, `confidence ${payoutMatch.match_confidence}`);
      assert.equal(money(payoutMatch.match_amount), expected.net_amount, 'the NET, never the gross');
      assert.equal(payoutMatch.payload?.source, 'transaction_intel', 'the exact-reference tier claimed it first (the reference is on the credit)');
      assert.equal(payoutMatch.status, 'auto_matched');
      const payoutEvaluation = (await appliance.read.evaluations(clientId, { targetId: payout.documentId }))
        .find((row) => row.matcher_family === 'payout_statement');
      assert.ok(payoutEvaluation, 'the payout matcher recorded its verdict');
      assert.equal(payoutEvaluation.verdict, 'no_candidates', 'the line was already claimed — recorded, never an absence of rows');
      assert.equal(payoutEvaluation.eligible_count, 0);
      const northgateEvaluation = (await appliance.read.evaluations(clientId, { targetId: nonfooting.documentId }))
        .find((row) => row.matcher_family === 'payout_statement');
      assert.ok(northgateEvaluation, 'the non-footing payout was evaluated too');
      assert.equal(northgateEvaluation.verdict, 'no_candidates', 'its net is on no line and the only credit is claimed');
      assert.ok(!matches.some((row) => row.matched_object_id === nonfooting.documentId), 'no phantom match for the Northgate payout');
      assert.equal(appliance.providers.callsFor('reconciliation_reasoning').length, 0, 'no model call for a claimed or empty candidate list');
      // The statement's post-parse legs also run the strong batch coder and
      // the bare-line disposition producer (the Ochre debit has no bill in
      // this fixture), and later ticks let the ask lane draft for that bare
      // line; the coder's strict schema is built per client and no static
      // recording exists (RT-06), so those lanes are refused at the wire and
      // stay visible on the ledger — and nothing else may be.
      const backgroundLanes = new Set(['transaction_coding', 'bank_line_disposition', 'ask_drafting']);
      const unscriptedAfterStatement = [...new Set(appliance.providers.unscripted.map((entry) => entry.lane))];
      assert.ok(
        unscriptedAfterStatement.every((lane) => backgroundLanes.has(lane)),
        `only the per-client coding, bare-line disposition and ask-drafting lanes may be unscripted: ${JSON.stringify(unscriptedAfterStatement)}`
      );

      // ── (b) the deposit slip, on its own client ──
      const second = await appliance.createClient();
      appliance.providers.reset();
      appliance.providers.script('document_routing', ['document_routing/barclays-deposit-slip']);
      appliance.providers.script('unified_extraction', ['unified_extraction/barclays-deposit-slip-DS-4471']);
      const slip = await appliance.uploadDocument({ clientId: second.clientId, fixture: 'deposit_slip' });
      const slipReceipt = await appliance.tick();
      const slipDoc = await appliance.read.document(slip.documentId);
      const slipExpected = slip.fixture.expected;
      assert.equal(
        slipDoc.parse_status,
        'completed',
        JSON.stringify({ parse_stage: slipDoc.parse_stage, parse_error: slipDoc.parse_error, log: slipReceipt.log.slice(-15) })
      );
      assert.equal(slipDoc.document_type, slipExpected.document_type, 'the router typed the slip');
      assert.equal(slipDoc.direction, 'incoming');
      assert.equal(slipDoc.vendor_name, slipExpected.counterparty_name, 'the bank is the counterparty');
      assert.equal(money(slipDoc.total_amount), slipExpected.net_amount);
      assert.equal(slipDoc.reference_number, slipExpected.reference_number);
      assert.equal(String(slipDoc.document_date).slice(0, 10), slipExpected.document_date);
      assert.equal(slipDoc.parse_summary.counterparty_role, 'bank');
      assert.equal(slipDoc.parse_summary.settlement.kind, 'deposit_slip');
      assert.equal(slipDoc.parse_summary.settlement.deposit_reference, slipExpected.reference_number);
      assert.equal(slipDoc.parse_summary.totals_validation.matches, true);
      const slipLines = await appliance.read.documentLines(slip.documentId);
      assert.deepEqual(slipLines.map((line) => money(line.amount)), [slipExpected.cash_amount, slipExpected.cheque_amount], 'cash + cheque are the components');
      const slipClassification = slipDoc.parse_summary.classification;
      assert.equal(slipClassification.family, slipExpected.router_family);
      assert.equal(slipClassification.final_type, 'deposit_slip');
      assert.equal(slipClassification.fallback_used, false);

      appliance.providers.reset();
      appliance.providers.script('document_routing', ['document_routing/kestrel-barclays-statement']);
      appliance.providers.script('bank_statement_extraction', ['bank_statement_extraction/kestrel-barclays-sep-deposit']);
      appliance.providers.script('reconciliation_reasoning', ['reconciliation_reasoning/deposit-slip-settled-by-candidate-1']);
      const september = await appliance.uploadDocument({ clientId: second.clientId, fixture: 'bank_statement_deposit' });
      const septemberReceipt = await appliance.tick();
      const septemberDoc = await appliance.read.document(september.documentId);
      assert.equal(
        septemberDoc.parse_status,
        'completed',
        JSON.stringify({ parse_stage: septemberDoc.parse_stage, parse_error: septemberDoc.parse_error, log: septemberReceipt.log.slice(-20) })
      );
      const depositLines = await appliance.read.transactions(second.clientId);
      assert.equal(depositLines.length, 1, JSON.stringify(depositLines.map((tx) => [tx.description, tx.money_in])));
      assert.equal(depositLines[0].description, 'COUNTER CREDIT YORK PARLIAMENT ST', 'the statement prints no slip reference');
      const slipMatches = (await appliance.read.matches(second.clientId)).filter((row) => row.matched_object_id === slip.documentId);
      assert.equal(slipMatches.length, 1, `one row per (line, document): the payout matcher refreshes the exact-reference tier's 0.82 suggestion rather than doubling it — ${JSON.stringify(slipMatches.map((row) => [row.matched_object_type, row.status, row.match_confidence, row.payload?.source]))}`);
      const slipMatch = slipMatches[0];
      assert.equal(slipMatch.bank_transaction_id, depositLines[0].id);
      assert.equal(slipMatch.matched_object_type, 'deposit_slip', 'the row carries the document\'s own type');
      assert.ok(Number(slipMatch.match_confidence) >= 0.85, `confidence ${slipMatch.match_confidence}`);
      assert.equal(money(slipMatch.match_amount), slipExpected.net_amount);
      const slipRecording = loadRecording('reconciliation_reasoning/deposit-slip-settled-by-candidate-1');
      assert.equal(slipMatch.payload?.source, 'payout_reconciliation_llm', 'the payout matcher made this match — the exact-reference tier could not');
      assert.equal(slipMatch.payload?.authorization?.model, slipRecording.body.model, 'the authorization receipt carries the SERVED model id');
      // Authority is unchanged by this slice: 3,000 sits above the appliance's
      // 500 materiality ceiling and this seed posture carries no material
      // auto-FYI row (RT-11, D2) — so the row rests matched_pending_authority
      // with the hold named, never a silent auto.
      assert.ok(['auto_matched', 'suggested'].includes(slipMatch.status), slipMatch.status);
      if (slipMatch.status === 'suggested') {
        assert.ok(
          (slipMatch.payload?.authorization?.reasons || []).includes('above_materiality_ceiling'),
          `the only hold is the materiality ceiling: ${JSON.stringify(slipMatch.payload?.authorization)}`
        );
      }
      const slipEvaluation = (await appliance.read.evaluations(second.clientId, { targetId: slip.documentId }))
        .find((row) => row.matcher_family === 'payout_statement');
      assert.equal(slipEvaluation?.verdict, 'proposed', JSON.stringify(slipEvaluation));
      assert.equal(slipEvaluation?.eligible_count, 1, 'one money_in candidate on the feed');
      assert.equal(slipEvaluation?.model, slipRecording.body.model, 'the verdict stamp carries the SERVED model id');
      const reasoningCalls = appliance.providers.callsFor('reconciliation_reasoning');
      assert.equal(reasoningCalls.length, 1, JSON.stringify(appliance.providers.calls.map((call) => [call.lane, call.status])));
      assert.equal(reasoningCalls[0].model_requested, reasoningCalls[0].model_served, 'the matcher asked for the model the recording answers as');
      // Client 1's bare Ochre debit keeps reaching the ask lane on later ticks
      // (a two-terminal terminal in the making: on the owner); the deposit
      // client itself minted no ask — its line is matched and its only hold
      // is authority, not a fact only the owner knows.
      const unscriptedAfterSeptember = [...new Set(appliance.providers.unscripted.map((entry) => entry.lane))];
      assert.ok(
        unscriptedAfterSeptember.every((lane) => backgroundLanes.has(lane)),
        `only the per-client coding, bare-line disposition and ask-drafting lanes may be unscripted: ${JSON.stringify(unscriptedAfterSeptember)}`
      );
      assert.deepEqual(await appliance.read.asks(second.clientId), [], 'no owner ask for a matched deposit');
    } finally {
      await appliance.stop();
    }
  }
);
