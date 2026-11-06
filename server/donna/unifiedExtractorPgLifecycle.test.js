// RT-12 acceptance fixtures on the RT-06 appliance harness
// (docs/plan-2026-09-01-runtime-refactor-slices.md §5 RT-12; audit F-12 /
// F-15; decision D1): the unified extractor as the appliance DEFAULT,
// provider-agnostic, on the REAL desktop path — createDonnaRuntimeServer →
// Host A → the local scheduler → the parse-document job → router → the
// unified extractor → the completed_header writer → matchers — with every
// model lane answered from committed recordings and the persisted rows read
// back.
//
//   (a) an OpenAI-ONLY host: the discounted bill completes through the
//       unified lane on the OpenAI transport (json_schema strict, the
//       response-named model id on parse_summary.extractor), with ZERO review
//       rows and a footing totals receipt (the RT-04 / RT-10 regression) —
//       and the per-type lane is never called.
//   (b) an Anthropic-ONLY host: the same bill, same outcome, on the Anthropic
//       transport (the router is dark without OpenAI; the declared type
//       stands and the unified model confirms it).
//   (c) an unreadable document: the unified model returns a partial read
//       below the floor; the header it DID return is persisted on
//       parse_summary.partial_header before the one-release fall-through, and
//       survives the parse resting failed when the per-type lane rejects.
//   (d) the payout family through the unified lane: the settlement equation
//       and the signed breakdown lines land exactly as RT-18 shipped them;
//       the NON-footing statement now gets RT-10's re-read through the
//       document's own (unified) extractor — the payout family joined
//       TOTALS_REREAD_CAPABLE_TYPES — then the row + owner ask.
//
// Fail-first record (2026-09-02): on the tree before RT-12 fixture (a)'s
// first assertion failed — parse_summary.extractor.path read 'type_specific'
// (the unified lane needed an EXTRACTOR_UNIFIED_<TYPE> row nobody seeds AND
// an Anthropic key, so the per-type extractor served every document on the
// appliance), and (c) had no parse_summary.partial_header at all.

import assert from 'node:assert/strict';
import test from 'node:test';

import { UNIFIED_EXTRACTOR_PROMPT_VERSION } from './unifiedExtractor.js';
import { applianceHarnessSkipReason, bootApplianceForTest } from './testSupport/applianceHarness.js';
import { loadRecording } from './testSupport/recordedProviders.js';

const money = (value) => (value == null ? null : Number(value));
const UNIFIED_SYSTEM_PREFIX = 'You are extracting fields from one financial document';

const assertBillLanded = async (appliance, { clientId, bill, provider, recording }) => {
  const document = await appliance.read.document(bill.documentId);
  assert.equal(
    document.parse_status,
    'completed',
    JSON.stringify({ parse_stage: document.parse_stage, parse_error: document.parse_error, unscripted: appliance.providers.unscripted, calls: appliance.providers.calls.map((c) => [c.lane, c.status]) })
  );
  const { expected } = bill.fixture;
  assert.equal(document.document_type, 'supplier_bill');
  assert.equal(document.vendor_name, expected.vendor_name);
  assert.equal(document.customer_name, null);
  assert.equal(money(document.total_amount), expected.total_amount);
  assert.equal(document.currency, expected.currency);
  assert.equal(document.reference_number, expected.reference_number);
  assert.equal(String(document.document_date).slice(0, 10), expected.document_date);
  assert.equal(String(document.due_date).slice(0, 10), expected.due_date);
  assert.equal(document.payment_status, 'unpaid');

  // The extractor receipt: the unified path, on THIS provider, with the
  // model id the RESPONSE named and the prompt version the module stamps.
  const receipt = document.parse_summary.extractor;
  assert.equal(receipt.path, 'unified', JSON.stringify(receipt));
  assert.equal(receipt.provider, provider);
  assert.equal(receipt.model, loadRecording(recording).body.model, 'the model id is part of the receipt — read from the response');
  assert.equal(receipt.model_source, 'response_proven');
  assert.equal(receipt.prompt_version, UNIFIED_EXTRACTOR_PROMPT_VERSION);
  assert.equal(receipt.unified_default, true);
  assert.equal(receipt.unified_default_reason, 'appliance_default');
  assert.equal(receipt.fallback_used, false);
  assert.equal(receipt.fallback_reason, null);
  assert.equal(document.parse_summary.source, 'unified_extractor');
  assert.equal(document.parse_summary.prompt_version, UNIFIED_EXTRACTOR_PROMPT_VERSION);
  assert.equal(document.parse_summary.partial_header, undefined, 'a completed unified read carries no partial header');
  // RT-19 asked for the tax registration ids on bills: seller = the supplier, buyer = the firm.
  assert.deepEqual(document.parse_summary.tax_registration_ids, { seller: 'GB 123 4567 89', buyer: 'GB 987 6543 21' });
  assert.equal(document.parse_summary.payment_terms_days, 30);

  // RT-04 / RT-10 regression: the discounted bill foots — no review row, no ask.
  const totals = document.parse_summary.totals_validation;
  assert.equal(totals.matches, true, JSON.stringify(totals));
  assert.equal(totals.strategy, 'declared_tax_exclusive');
  assert.equal(totals.expected, expected.total_amount);
  assert.equal(totals.discount, expected.discount_amount);
  assert.ok(!(document.parse_summary.warnings || []).includes('amount_mismatch'));
  assert.equal(document.parse_summary.review_line_count, 0);
  assert.deepEqual(await appliance.read.reviewQueue(clientId), [], 'zero review rows through the unified path');
  assert.equal(document.parse_summary.totals_reread, undefined, 'nothing to re-read');
  const lines = await appliance.read.documentLines(bill.documentId);
  assert.equal(lines.length, expected.line_count, JSON.stringify(lines.map((line) => [line.description, line.amount])));
  assert.equal(lines.reduce((sum, line) => sum + Number(line.amount), 0), expected.subtotal_amount);

  // The wire: exactly one unified call, on the provider's own transport; the
  // per-type lane never hit.
  const unifiedCalls = appliance.providers.callsFor('unified_extraction');
  assert.equal(unifiedCalls.length, 1, JSON.stringify(appliance.providers.calls.map((c) => [c.lane, c.status])));
  assert.equal(unifiedCalls[0].endpoint_class, provider);
  assert.equal(unifiedCalls[0].status, 200);
  assert.equal(unifiedCalls[0].model_requested, unifiedCalls[0].model_served, 'the extractor asked for the model the recording answers as');
  if (provider === 'openai') assert.equal(unifiedCalls[0].schema_name, 'unified_extraction');
  else assert.ok(unifiedCalls[0].system_prefix.startsWith(UNIFIED_SYSTEM_PREFIX));
  assert.ok(unifiedCalls[0].body_bytes > bill.fixture.bytes.length, 'the extractor sent the document bytes');
  assert.equal(appliance.providers.callsFor('supplier_bill_extraction').length, 0, 'the per-type extractor is not the production extractor any more');
  appliance.providers.assertNoUnscripted();
  return document;
};

test(
  'real PG (RT-12 a): an OpenAI-only host — the discounted bill completes through the unified lane on the OpenAI transport, zero review rows, the response-named model on the receipt',
  { skip: applianceHarnessSkipReason({ dark: ['anthropic', 'typesafe'] }) },
  async () => {
    const appliance = await bootApplianceForTest({ keys: { openai: true, anthropic: false, typesafe: false }, now: new Date('2026-08-31T09:00:00.000Z') });
    try {
      const host = await appliance.read.host();
      assert.equal(host?.status, 'PASS', JSON.stringify(host?.certificate?.checks?.map(({ id, status }) => [id, status])));
      const modelRoutes = host.certificate.checks.find(({ id }) => id === 'model_routes');
      const unifiedLane = modelRoutes.detail.lanes.find(({ lane_id }) => lane_id === 'unified_extraction');
      assert.equal(unifiedLane.credential_present, true, 'Host A: the unified lane is LIT through the OpenAI key');
      assert.deepEqual(unifiedLane.lit_providers, ['openai']);
      assert.ok(!modelRoutes.detail.dark_lanes.includes('unified_extraction'));

      const { clientId } = await appliance.createClient();
      appliance.providers.script('document_routing', ['document_routing/ochre-supplier-bill']);
      appliance.providers.script('unified_extraction', ['unified_extraction/ochre-discount-line-openai']);
      const bill = await appliance.uploadDocument({ clientId, fixture: 'supplier_bill_discount' });
      const receipt = await appliance.tick();
      const job = (await appliance.read.jobs({ functionId: 'parse-document' })).find((row) => row.dedupe_key === bill.registered.parse_run_id);
      assert.equal(job?.status, 'succeeded', `${job?.last_error} :: ${receipt.log.slice(-10).join('\n')}`);
      const document = await assertBillLanded(appliance, { clientId, bill, provider: 'openai', recording: 'unified_extraction/ochre-discount-line-openai' });
      assert.equal(document.parse_summary.classification.final_type_source, 'unified_extractor_agreed', 'the strong model agreed with the router');
    } finally {
      await appliance.stop();
    }
  }
);

test(
  'real PG (RT-12 b): an Anthropic-only host — the same bill through the unified lane on the Anthropic transport (the router is dark; the unified model confirms the declared type)',
  { skip: applianceHarnessSkipReason({ dark: ['openai', 'typesafe'] }) },
  async () => {
    const appliance = await bootApplianceForTest({ keys: { openai: false, anthropic: true, typesafe: false }, now: new Date('2026-08-31T09:00:00.000Z') });
    try {
      const host = await appliance.read.host();
      assert.equal(host?.status, 'PASS', JSON.stringify(host?.certificate?.checks?.map(({ id, status }) => [id, status])));
      const modelRoutes = host.certificate.checks.find(({ id }) => id === 'model_routes');
      assert.deepEqual(modelRoutes.detail.dark_providers, ['openai', 'typesafe']);
      assert.ok(modelRoutes.detail.dark_lanes.includes('jev_reconciliation'));
      assert.ok(modelRoutes.detail.dark_lanes.includes('document_routing'), 'the router is dark on an Anthropic-only host');
      assert.ok(!modelRoutes.detail.dark_lanes.includes('unified_extraction'));

      const { clientId } = await appliance.createClient();
      appliance.providers.script('unified_extraction', ['unified_extraction/ochre-discount-line']);
      // The doc-first terminal drain (Anthropic) reaches a bill the matcher left bare.
      appliance.providers.script('document_disposition', ['document_disposition/ochre-bill-uncovered-account']);
      const bill = await appliance.uploadDocument({ clientId, fixture: 'supplier_bill_discount' });
      await appliance.tick();
      const document = await assertBillLanded(appliance, { clientId, bill, provider: 'anthropic', recording: 'unified_extraction/ochre-discount-line' });
      assert.equal(appliance.providers.callsFor('document_routing').length, 0, 'no router call without an OpenAI key');
      assert.equal(document.parse_summary.classification.fallback_used, true, 'the router receipt says it did not run');
      assert.equal(document.parse_summary.classification.final_type_source, 'unified_extractor_agreed');
    } finally {
      await appliance.stop();
    }
  }
);

test(
  'real PG (RT-12 c): an unreadable document — the header the unified model DID return is persisted on parse_summary.partial_header and survives the parse resting failed',
  { skip: applianceHarnessSkipReason({ dark: ['anthropic', 'typesafe'] }) },
  async () => {
    const appliance = await bootApplianceForTest({ keys: { openai: true, anthropic: false, typesafe: false }, now: new Date('2026-08-31T09:00:00.000Z') });
    try {
      const { clientId } = await appliance.createClient();
      appliance.providers.script('document_routing', ['document_routing/screwfix-receipt']);
      appliance.providers.script('unified_extraction', ['unified_extraction/screwfix-receipt-unreadable-openai']);
      // The one-release fall-through: the per-type lane is reached and
      // REJECTS (a deterministic 4xx) — the parse rests failed, honestly.
      appliance.providers.script('receipt_extraction', [{ status: 400 }]);
      const upload = await appliance.uploadDocument({ clientId, fixture: 'receipt_screwfix' });
      const receipt = await appliance.tick();
      const job = (await appliance.read.jobs({ functionId: 'parse-document' })).find((row) => row.dedupe_key === upload.registered.parse_run_id);
      assert.ok(job, JSON.stringify(receipt.jobs.map((row) => [row.function_id, row.status])));
      const document = await appliance.read.document(upload.documentId);
      assert.equal(document.parse_status, 'failed', JSON.stringify({ parse_error: document.parse_error, summary: document.parse_summary }));
      assert.equal(document.parse_error?.code, 'DOCUMENT_EXTRACTION_REJECTED', JSON.stringify(document.parse_error));
      assert.equal(document.parse_error?.retryable, false);
      const partial = document.parse_summary?.partial_header;
      assert.ok(partial, `parse_summary.partial_header is the F-12 receipt: ${JSON.stringify(document.parse_summary)}`);
      assert.equal(partial.parse_run_id, upload.registered.parse_run_id);
      assert.equal(partial.document_type, 'receipt');
      assert.equal(partial.extraction_status, 'partial');
      assert.equal(partial.extraction_confidence, 0.2);
      assert.equal(partial.header.counterparty_name, 'Screwfix', 'the vendor the model read is kept');
      assert.equal(partial.header.total_amount, 42.99, 'the total the model read is kept');
      assert.equal(partial.header.document_date, null, 'the date it could not read stays null — never invented');
      assert.equal(partial.line_count, 0);
      assert.equal(partial.provider, 'openai');
      assert.equal(partial.model, loadRecording('unified_extraction/screwfix-receipt-unreadable-openai').body.model);
      assert.equal(partial.prompt_version, UNIFIED_EXTRACTOR_PROMPT_VERSION);
      assert.equal(partial.code, 'DOCUMENT_EXTRACTION_UNREADABLE');
      assert.equal(partial.reason, 'low_confidence');
      assert.ok(partial.persisted_at);
      assert.equal(document.vendor_name, null, 'the header columns are untouched by a failed parse');
      assert.equal(appliance.providers.callsFor('unified_extraction').length, 1);
      assert.equal(appliance.providers.callsFor('receipt_extraction').length, 1, 'the one-release fall-through was taken');
      appliance.providers.assertNoUnscripted();
    } finally {
      await appliance.stop();
    }
  }
);

test(
  'real PG (RT-12 d): the payout family through the unified lane — the settlement receipt as RT-18 shipped it, and the non-footing statement re-read through the unified extractor before the owner ask',
  { skip: applianceHarnessSkipReason() },
  async () => {
    const appliance = await bootApplianceForTest({ now: new Date('2026-08-31T09:00:00.000Z') });
    try {
      const { clientId } = await appliance.createClient();
      // The ask-batch DRAFTER wakes after the owner ask is minted; it has no
      // recording — a scripted refusal keeps it off the unscripted ledger.
      appliance.providers.script('ask_drafting', [{ status: 503, times: Infinity }]);

      // ── the footing PayLink settlement ──
      appliance.providers.script('document_routing', ['document_routing/paylink-payout']);
      appliance.providers.script('unified_extraction', ['unified_extraction/paylink-PO-88121']);
      const payout = await appliance.uploadDocument({ clientId, fixture: 'payout_statement' });
      assert.equal(payout.fixture.documentType, 'unknown', 'uploaded as the SPA sends a filename its classifier does not know');
      const firstTick = await appliance.tick();
      const document = await appliance.read.document(payout.documentId);
      const expected = payout.fixture.expected;
      assert.equal(document.parse_status, 'completed', JSON.stringify({ parse_error: document.parse_error, log: firstTick.log.slice(-12), unscripted: appliance.providers.unscripted }));
      assert.equal(document.document_type, expected.document_type, 'the router typed it; the unified model agreed');
      assert.equal(document.direction, expected.direction);
      assert.equal(document.vendor_name, expected.counterparty_name);
      assert.equal(document.customer_name, null);
      assert.equal(money(document.total_amount), expected.net_amount, 'the NET is the header total — what the bank feed shows');
      assert.equal(document.reference_number, expected.reference_number);
      assert.equal(document.payment_status, 'paid');
      assert.equal(String(document.document_date).slice(0, 10), expected.document_date);
      const summary = document.parse_summary;
      assert.equal(summary.extractor.path, 'unified');
      assert.equal(summary.extractor.provider, 'anthropic', 'both keys present ⇒ the strong default provider');
      assert.equal(summary.extractor.model, loadRecording('unified_extraction/paylink-PO-88121').body.model);
      assert.equal(summary.counterparty_role, 'processor');
      assert.equal(summary.settlement.kind, 'payout_statement');
      assert.equal(summary.settlement.gross_sales, expected.gross_amount);
      assert.equal(summary.settlement.fee_total, expected.fee_amount);
      assert.equal(summary.settlement.net_payout, expected.net_amount);
      assert.equal(summary.settlement.period_start, expected.period_start);
      assert.equal(summary.settlement.period_end, expected.period_end);
      assert.equal(summary.settlement.transaction_count, expected.transaction_count);
      assert.equal(summary.settlement.bank_last4, expected.bank_last4);
      assert.equal(summary.settlement.payout_reference, expected.reference_number);
      assert.equal(summary.totals_validation.matches, true, JSON.stringify(summary.totals_validation));
      assert.equal(summary.totals_validation.expected, expected.net_amount);
      assert.equal(summary.totals_validation.drift, 0);
      assert.equal(summary.totals_validation.basis, 'lines');
      const lines = await appliance.read.documentLines(payout.documentId);
      assert.deepEqual(lines.map((line) => money(line.amount)), [expected.gross_amount, -expected.fee_amount], 'the breakdown lands as signed lines');
      assert.equal(summary.classification.final_type_source, 'unified_extractor_agreed');

      // ── the NON-footing Northgate statement: re-read through the unified
      // extractor (the payout family joined the capable set), still off,
      // then the row + owner ask (RT-10's lane) ──
      appliance.providers.script('document_routing', ['document_routing/northgate-marketplace-payout']);
      appliance.providers.script('unified_extraction', ['unified_extraction/northgate-nonfooting', 'unified_extraction/northgate-nonfooting']);
      const nonfooting = await appliance.uploadDocument({ clientId, fixture: 'payout_statement_nonfooting' });
      const secondTick = await appliance.tick();
      const drifting = await appliance.read.document(nonfooting.documentId);
      const driftExpected = nonfooting.fixture.expected;
      assert.equal(drifting.parse_status, 'completed', JSON.stringify({ parse_error: drifting.parse_error, log: secondTick.log.slice(-12), unscripted: appliance.providers.unscripted }));
      assert.equal(money(drifting.total_amount), driftExpected.net_amount, 'the printed net stands — never adjusted to foot');
      const reread = drifting.parse_summary.totals_reread;
      assert.ok(reread, 'parse_summary carries the re-read receipt');
      assert.equal(reread.attempted, true, 'a payout is no longer no_reread_extractor');
      assert.equal(reread.extractor, 'unified');
      assert.equal(reread.outcome, 'still_off');
      assert.equal(reread.model, loadRecording('unified_extraction/northgate-nonfooting').body.model, 'the model id is part of the receipt');
      assert.equal(reread.parse_run_id, drifting.parse_run_id);
      const unifiedCalls = appliance.providers.callsFor('unified_extraction');
      assert.equal(unifiedCalls.length, 3, 'one call per payout, plus exactly one re-read');
      assert.ok(unifiedCalls[2].body_bytes > unifiedCalls[1].body_bytes, 'the re-read carried the extra prompt fragment');
      const driftSummary = drifting.parse_summary;
      assert.equal(driftSummary.totals_validation.matches, false);
      assert.equal(driftSummary.totals_validation.expected, driftExpected.printed_sum);
      assert.equal(driftSummary.totals_validation.drift, driftExpected.drift);
      assert.deepEqual(driftSummary.tax_registration_ids, { seller: driftExpected.seller_tax_id, buyer: driftExpected.buyer_tax_id });
      const rows = (await appliance.read.reviewQueue(clientId)).filter((row) => row.reason === 'amount_mismatch' && row.payload?.document_id === nonfooting.documentId);
      assert.equal(rows.length, 1, JSON.stringify(rows));
      assert.equal(rows[0].payload.lane?.kind, 'owner_ask', JSON.stringify(rows[0].payload));
      assert.equal(rows[0].payload.totals_reread?.outcome, 'still_off');
      const asks = (await appliance.read.asks(clientId)).filter((ask) => ask.request_payload?.document_id === nonfooting.documentId);
      assert.equal(asks.length, 1, JSON.stringify(asks.map((ask) => [ask.evidence_type, ask.status])));
      assert.equal(asks[0].evidence_type, 'supporting_document');
      assert.equal(asks[0].request_payload.lane, 'totals_mismatch');
      // DMEM-R1 W1 (INV-14): minted, never delivered by a channel — a `draft`,
      // not `open`; only a deliverer's send stamps it open.
      assert.equal(asks[0].status, 'draft');
      appliance.providers.assertNoUnscripted();
    } finally {
      await appliance.stop();
    }
  }
);
