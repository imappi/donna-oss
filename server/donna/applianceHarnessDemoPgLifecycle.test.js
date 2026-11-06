// RT-06 demo lifecycle (docs/plan-2026-09-01-runtime-refactor-slices.md;
// audit F-20 / §9): the appliance test harness proves the REAL desktop path
// on real PostgreSQL with every model lane lit and answered from committed
// recordings — createDonnaRuntimeServer → Host A → the local scheduler over
// the desktop manifest → the `parse-document` local job the register route
// enqueued (RT-08; the drain cron stays on the manifest as a backstop that
// leaves a queue-owned row alone) → router → the unified extractor (RT-12) →
// writer → the bill matcher — and reads the persisted rows back.
//
// Three suites:
//   1. The four fixture PDFs are the world renderer's output, byte for byte
//      (DONNA_APPLIANCE_FIXTURES_WRITE=1 regenerates them from world.json).
//   2. The provider stub classifies the wire by lane without naming a host.
//   3. The lifecycle, twice in one boot: first with the lanes UNSCRIPTED —
//      the parse must NOT complete and the refusals must be on the ledger
//      (the harness discriminates; a stub that let a dark lane pass would be
//      the false confidence F-20 names) — then with the lanes scripted, the
//      bill completes with lines and a matcher evaluation.
//
// RT-01/02/03/04/05/08/09 write their fixtures on the same harness; the
// module header of testSupport/applianceHarness.js names the seam each one
// leans on.

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  APPLIANCE_FIXTURES,
  loadApplianceFixture,
  verifyApplianceFixtures,
  writeApplianceFixtures
} from './fixtures/appliance/index.js';
import { KNOWN_PROVIDER_HOSTS } from './providerEndpoints.js';
import { applianceHarnessSkipReason, bootApplianceForTest } from './testSupport/applianceHarness.js';
import { classifyProviderRequest, loadRecording } from './testSupport/recordedProviders.js';
import { renderWorldArtifacts } from './world/worldRenderer.js';

const hostFor = (endpointClass) => KNOWN_PROVIDER_HOSTS.find((entry) => entry.endpointClass === endpointClass).host;

test('the appliance fixture PDFs are the world renderer\'s output, byte for byte', async () => {
  if (process.env.DONNA_APPLIANCE_FIXTURES_WRITE === '1') {
    await writeApplianceFixtures({ renderWorldArtifacts });
  }
  const verdict = await verifyApplianceFixtures({ renderWorldArtifacts });
  assert.deepEqual(verdict.mismatches, [], 'world.json changed without regenerating — run with DONNA_APPLIANCE_FIXTURES_WRITE=1');
  for (const name of Object.keys(APPLIANCE_FIXTURES)) {
    const fixture = loadApplianceFixture(name);
    assert.ok(fixture.bytes.subarray(0, 5).toString('latin1').startsWith('%PDF-'), `${name} renders as a PDF`);
    assert.equal(fixture.receipt.sha256, fixture.sha256);
  }
});

test('recorded providers classify the wire by lane, and only provider hosts are intercepted', () => {
  const responses = (schemaName) => ({
    url: `https://${hostFor('openai')}/v1/responses`,
    init: {
      method: 'POST',
      body: JSON.stringify({ model: 'gpt-5.4', text: { format: { type: 'json_schema', name: schemaName } }, input: [] })
    }
  });
  assert.equal(classifyProviderRequest(responses('supplier_bill_extraction')).lane, 'supplier_bill_extraction');
  assert.equal(classifyProviderRequest(responses('document_routing')).lane, 'document_routing');
  assert.equal(classifyProviderRequest(responses('transaction_coding_batch_suggestion')).lane, 'transaction_coding');
  assert.equal(classifyProviderRequest(responses('client_ask_message_draft')).lane, 'ask_drafting');
  const anthropic = (system) => ({
    url: `https://${hostFor('anthropic')}/v1/messages`,
    init: { method: 'POST', body: JSON.stringify({ model: 'claude-opus-4-8', system, messages: [] }) }
  });
  assert.equal(classifyProviderRequest(anthropic('You match a parsed supplier bill to bank transactions…')).lane, 'reconciliation_reasoning');
  assert.equal(classifyProviderRequest(anthropic('You triage a single unmatched bank DEBIT (money out)…')).lane, 'bank_line_disposition');
  assert.equal(classifyProviderRequest(anthropic('You triage a single parsed evidence DOCUMENT…')).lane, 'document_disposition');
  const unknown = classifyProviderRequest(anthropic('Something no lane opens with'));
  assert.ok(unknown.lane.startsWith('anthropic:'), 'an unknown lane is still named by what the wire carried');
  assert.equal(classifyProviderRequest({ url: 'http://127.0.0.1:4242/api/donna/firms/documents/parse-cron?task=drain', init: {} }), null,
    'the runtime\'s loopback self-call passes through');
  // The recordings name their lane and carry the model id in the body.
  for (const name of [
    'document_routing/ochre-supplier-bill',
    'document_routing/paylink-payout',
    'supplier_bill_extraction/ochre-discount-line',
    'unified_extraction/ochre-discount-line',
    'unified_extraction/ochre-discount-line-openai',
    'bank_statement_extraction/kestrel-barclays-two-lines',
    'reconciliation_reasoning/ochre-bill-settled-by-candidate-1'
  ]) {
    const recording = loadRecording(name);
    assert.equal(recording.status, 200);
    assert.ok(typeof recording.body.model === 'string' && recording.body.model, `${name} carries the model id`);
    assert.ok(recording.provenance.startsWith('synthetic'), `${name} states its provenance`);
  }
});

test(
  'real PG: the appliance drains a supplier bill through the scheduler with every lane recorded — and refuses to pass with the lanes dark',
  { skip: applianceHarnessSkipReason() },
  async () => {
    const appliance = await bootApplianceForTest({ now: new Date('2026-08-31T09:00:00.000Z') });
    try {
      // The boot: Host A PASS with both provider keys present, scheduler admitted,
      // the public health receipt naming both lanes lit.
      const host = await appliance.read.host();
      assert.equal(host?.status, 'PASS', JSON.stringify(host?.certificate?.checks?.map(({ id, status }) => [id, status])));
      assert.equal(appliance.runtime.schedulerRunning(), true, 'Host A admitted the scheduler');
      const health = await appliance.api.health();
      assert.equal(health.status, 200);
      assert.equal(health.json.database_configured, true, 'the public health receipt reaches the scratch database');
      // The per-provider lane receipt on this route (`model_lanes`) lands with
      // RT-01; the harness asserts only what main ships today.
      const modelRoutes = host.certificate.checks.find(({ id }) => id === 'model_routes');
      assert.equal(modelRoutes?.status, 'PASS', 'both provider keys present ⇒ every model lane lit on Host A');
      assert.ok(appliance.manifest.some((entry) => entry.functionId === 'parse-document'), 'the parse job is on the desktop manifest (RT-08)');
      assert.ok(!appliance.manifest.some((entry) => entry.functionId === 'parse-cron:drain'), 'the drain has no desktop entry — the job owns every parse run (RT-14)');
      assert.ok(!appliance.manifest.some((entry) => entry.kind === 'http-cron'), 'no manifest entry self-calls the router (RT-14)');

      // The client: the real authenticated create route seeds the plane rows
      // and certifies the entity ready.
      const { clientId, readiness, flags } = await appliance.createClient();
      assert.equal(readiness?.state, 'ready', JSON.stringify(readiness));
      assert.ok(flags.some((row) => row.flag_key === 'DOCUMENT_EXTRACTORS_ENABLED' && row.stage === 'auto'), 'the extractor wave is seeded');
      assert.ok(flags.some((row) => row.flag_key === 'DOCUMENT_ROUTER_ENABLED' && row.stage === 'auto'), 'the router is seeded');

      // ── Negative half: nothing scripted. The lanes are LIT (keys present) but
      // every call is refused at the wire; the parse must not complete. ──
      const dark = await appliance.uploadDocument({ clientId, fixture: 'receipt_screwfix' });
      assert.equal(dark.registered?.parse_status, 'pending');
      assert.equal(dark.registered?.event_sent, true, 'register enqueued the parse-document job (RT-08)');
      const darkTick = await appliance.tick();
      const darkJob = darkTick.jobs.find((job) => job.function_id === 'parse-document');
      assert.ok(darkJob, `the parse job ran on the first tick: ${JSON.stringify(darkTick.jobs.map((job) => [job.function_id, job.status]))}`);
      assert.ok(['succeeded', 'pending', 'dead'].includes(darkJob.status), `a refused lane settles the job honestly, never limbo: ${JSON.stringify(darkJob)}`);
      const darkDocument = await appliance.read.document(dark.documentId);
      assert.notEqual(darkDocument.parse_status, 'completed', 'an unscripted lane must never let a parse complete');
      assert.ok(darkDocument.parse_status === 'failed' || darkDocument.parse_status === 'pending', darkDocument.parse_status);
      const refused = appliance.providers.unscripted.map((entry) => entry.lane);
      // RT-12: the unified lane is the appliance default and is refused first; the
      // per-type lane is the one-release fall-through and is refused next.
      assert.ok(refused.includes('unified_extraction'), `the unified refusal is on the ledger: ${JSON.stringify(refused)}`);
      assert.ok(refused.includes('receipt_extraction'), `the fall-through refusal is on the ledger: ${JSON.stringify(refused)}`);
      assert.throws(() => appliance.providers.assertNoUnscripted(), /unscripted provider call/);
      appliance.providers.reset();

      // ── Positive half: the two lanes the bill needs, scripted from the
      // committed recordings. ──
      appliance.providers.script('document_routing', ['document_routing/ochre-supplier-bill']);
      // RT-12: the unified extractor is the appliance default (both keys present
      // ⇒ the Anthropic transport); the per-type lane is never reached.
      appliance.providers.script('unified_extraction', ['unified_extraction/ochre-discount-line']);
      // The appliance's doc-first terminal drain (DOCUMENT_NO_LINE_DISPOSITION,
      // seeded auto) gives a bill the matcher left bare ONE strong-model
      // verdict inside the same drain — the third lane this document reaches.
      appliance.providers.script('document_disposition', ['document_disposition/ochre-bill-uncovered-account']);
      const bill = await appliance.uploadDocument({ clientId, fixture: 'supplier_bill_discount' });
      assert.equal(bill.registered?.parse_status, 'pending');
      assert.ok(bill.registered?.parse_run_id, 'register minted a parse run');
      assert.ok(await appliance.read.localEvidence(bill.storageRef.key), 'the bytes landed in the local evidence store');
      assert.ok(bill.storageRef.key.startsWith(`${appliance.firmId}/`), `the evidence key is under the minted firm: ${bill.storageRef.key}`);

      const receipt = await appliance.tick();
      const billJob = (await appliance.read.jobs({ functionId: 'parse-document' }))
        .find((job) => job.dedupe_key === bill.registered.parse_run_id);
      assert.ok(billJob, `one parse-document job per parse run: ${JSON.stringify(receipt.jobs.map((job) => [job.function_id, job.status]))}`);
      assert.equal(billJob.status, 'succeeded', billJob.last_error);
      assert.equal(billJob.attempt_count, 1);
      // The per-minute sweeps ran in-process on the same tick (RT-14): the
      // stuck sweep's job result is the runner's own summary, not an HTTP body.
      const stuck = receipt.jobs.find((job) => job.function_id === 'parse-cron:stuck');
      assert.ok(stuck, 'the stuck sweep ticks');
      assert.equal(stuck.status, 'succeeded', stuck.last_error);
      assert.ok(stuck.result && 'stuck' in stuck.result && !('body' in stuck.result), `the summary is the runner's: ${JSON.stringify(stuck.result)}`);

      const document = await appliance.read.document(bill.documentId);
      assert.equal(
        document.parse_status,
        'completed',
        JSON.stringify({ parse_stage: document.parse_stage, parse_error: document.parse_error, log: receipt.log.slice(-15) })
      );
      const { expected } = bill.fixture;
      assert.equal(document.document_type, 'supplier_bill');
      assert.equal(document.vendor_name, expected.vendor_name);
      assert.equal(Number(document.total_amount), expected.total_amount);
      assert.equal(document.currency, expected.currency);
      assert.equal(document.reference_number, expected.reference_number);
      assert.equal(String(document.document_date).slice(0, 10), expected.document_date);
      assert.equal(document.parse_run_id, bill.registered.parse_run_id, 'the completing run is the registered run');

      const lines = await appliance.read.documentLines(bill.documentId);
      assert.equal(lines.length, expected.line_count, JSON.stringify(lines.map((line) => [line.description, line.amount])));
      assert.equal(lines.reduce((sum, line) => sum + Number(line.amount), 0), expected.subtotal_amount);

      const evaluations = await appliance.read.evaluations(clientId, { targetId: bill.documentId });
      const billEvaluation = evaluations.find((row) => row.matcher_family === 'supplier_bill');
      assert.ok(billEvaluation, `the bill matcher recorded its verdict: ${JSON.stringify(evaluations.map((row) => [row.matcher_family, row.verdict]))}`);
      // No bank statement was uploaded, so the matcher's honest verdict is
      // "no candidates" — written without a model call.
      assert.equal(billEvaluation.verdict, 'no_candidates');
      assert.equal(billEvaluation.eligible_count, 0);

      // The disposition verdict is persisted where the writer puts a
      // chase_evidence: the evaluation row (only an auto_explain settles the
      // document's own payload holder) with the SERVED model id, plus its
      // audit event — the receipt the owner-ask lane (RT-11) reads from.
      const dispositionEvaluation = evaluations.find((row) => row.matcher_family === 'document_no_line_disposition');
      assert.ok(dispositionEvaluation, JSON.stringify(evaluations.map((row) => [row.matcher_family, row.verdict])));
      assert.equal(dispositionEvaluation.verdict, 'no_match');
      assert.equal(dispositionEvaluation.unmatchable_reason, 'evidence_needed');
      assert.equal(dispositionEvaluation.payload?.disposition, 'chase_evidence', JSON.stringify(dispositionEvaluation.payload));
      assert.equal(dispositionEvaluation.payload?.settlement_channel, 'uncovered_account');
      assert.equal(dispositionEvaluation.model, loadRecording('document_disposition/ochre-bill-uncovered-account').body.model,
        'the persisted disposition receipt carries the SERVED model id');
      assert.equal(document.payload?.no_line_disposition, undefined, 'a chase_evidence verdict never settles the document');

      // Provider receipts: each lane hit exactly once, requested and served
      // model ids agree, and the served id is what the recording carries.
      const routing = appliance.providers.callsFor('document_routing');
      const extraction = appliance.providers.callsFor('unified_extraction');
      const dispositionCalls = appliance.providers.callsFor('document_disposition');
      assert.equal(dispositionCalls.length, 1, JSON.stringify(appliance.providers.calls.map((call) => [call.lane, call.status])));
      assert.equal(dispositionCalls[0].endpoint_class, 'anthropic');
      assert.equal(routing.length, 1, JSON.stringify(appliance.providers.calls.map((call) => [call.lane, call.status])));
      assert.equal(extraction.length, 1);
      assert.equal(routing[0].status, 200);
      assert.equal(extraction[0].status, 200);
      assert.equal(routing[0].model_served, loadRecording('document_routing/ochre-supplier-bill').body.model);
      assert.equal(extraction[0].model_served, loadRecording('unified_extraction/ochre-discount-line').body.model);
      assert.equal(routing[0].model_requested, routing[0].model_served, 'the router asked for the model the recording answers as');
      assert.equal(extraction[0].model_requested, extraction[0].model_served);
      assert.equal(extraction[0].endpoint_class, 'anthropic');
      assert.ok(extraction[0].system_prefix.startsWith('You are extracting fields from one financial document'), extraction[0].system_prefix);
      assert.equal(document.parse_summary?.extractor?.path, 'unified', JSON.stringify(document.parse_summary?.extractor));
      assert.equal(document.parse_summary?.extractor?.model, extraction[0].model_served);
      assert.ok(extraction[0].body_bytes > bill.fixture.bytes.length, 'the extractor sent the document bytes');
      appliance.providers.assertNoUnscripted();
      assert.equal(appliance.providers.remaining('document_routing'), 0);
      assert.equal(appliance.providers.remaining('unified_extraction'), 0);
      assert.equal(appliance.providers.callsFor('supplier_bill_extraction').length, 0, 'the per-type extractor is not the production extractor any more');

      // The persisted classification receipt names the model that ran the
      // router — read from the data, never from a code default.
      const classification = document.parse_summary?.classification || null;
      assert.ok(classification, 'parse_summary carries the classification receipt');
      assert.equal(classification.source, 'router_v1', JSON.stringify(classification));
      assert.equal(classification.model, routing[0].model_served);
      assert.equal(classification.final_type, 'supplier_bill');
      assert.equal(classification.direction_hint, 'ap');
      assert.equal(classification.confidence, 0.97);

      // Audit trail: the upload was signed and stored under the minted firm and
      // the parse was queued and completed.
      const actions = new Set((await appliance.read.audit({ clientId })).map((row) => row.action));
      for (const action of ['document.parse.queued', 'document.parse.completed', 'document.disposition.evaluated']) {
        assert.ok(actions.has(action), `audit carries ${action}: ${JSON.stringify([...actions])}`);
      }

      // The queue ledger: every settled job on both ticks is accounted for.
      const jobs = await appliance.read.jobs();
      assert.ok(jobs.every((job) => ['succeeded', 'pending', 'dead', 'failed'].includes(job.status)));
      assert.ok(jobs.filter((job) => job.function_id === 'parse-cron:stuck' && job.status === 'succeeded').length >= 2);
      assert.equal(jobs.filter((job) => job.function_id === 'parse-cron:drain').length, 0, 'no drain job was ever enqueued');
    } finally {
      await appliance.stop();
    }
  }
);
