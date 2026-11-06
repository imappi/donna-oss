// RT-08 acceptance fixtures — real PostgreSQL, on the RT-06 appliance harness
// (docs/plan-2026-09-01-runtime-refactor-slices.md §5 RT-08; audit F-02 proper,
// F-09, F-10 parse part).
//
// What must hold on the appliance once the per-document parse is a
// `local_jobs` function instead of a per-minute HTTP self-call:
//
//   (a) upload → ONE `parse-document` job row (dedupe_key = parse_run_id),
//       stamped as the "job exists" receipt → completed by the queue with
//       zero drain involvement; the backstop drain SKIPS a row the queue owns.
//   (b) provider 429 twice then 200 → completed, attempt_count 3, one job
//       row, no failed audit — the queue owns the retry, never the drain.
//   (c) 429 forever → job dead, document failed retryable:false with a
//       MANUAL owner (the human has the button), exactly one
//       document.parse.failed audit, one coalesced drafter wake (RT-02's
//       quiescence re-check, unchanged) and NO owner ask; a manual retry
//       then gives the new run its OWN attempt budget.
//   (d) a post-parse leg (coding) throws once → the retry replays the
//       memoized `parse-and-write` (one extraction call) and re-runs only
//       the leg; a non-final attempt writes no leg-failure receipt.
//   (e) an admission-refused claim DEFERS the job (no attempt spent, the
//       row rests pending with its readiness hold and the parse-status
//       projection shows it) and the queue re-drives it when readiness
//       heals — never a limbo, never a spent budget.
//   (f) the backstop drain drains a pending row that has NO job for its run
//       and reports it as the bug it is.
//
// Every model call is served at the wire from committed recordings; nothing
// in the parse path is mocked.

import assert from 'node:assert/strict';
import test from 'node:test';

import { applianceHarnessSkipReason, bootApplianceForTest } from './testSupport/applianceHarness.js';

const PARSE_FN = 'parse-document';
const BOOT_NOW = new Date('2026-08-31T09:00:00.000Z');

const jobsForRun = async (appliance, parseRunId) =>
  (await appliance.read.jobs({ functionId: PARSE_FN })).filter((job) => job.dedupe_key === parseRunId);

const stepsForJob = async (appliance, jobId) =>
  (await appliance.query('select step_key from local_job_steps where job_id = $1 order by completed_at, step_key', [jobId]))
    .rows.map((row) => row.step_key);

const askWakes = async (appliance) =>
  (await appliance.query(
    "select id, status from loop_event_outbox where firm_id = $1 and event_type = 'ask_draft.requested'",
    [appliance.firmId]
  )).rows;

const parseStatusFor = async (appliance, documentId) => {
  const response = await appliance.api.request({
    path: `/api/donna/firms/documents/parse-status?firm_id=${encodeURIComponent(appliance.firmId)}&ids=${encodeURIComponent(documentId)}`,
    auth: true
  });
  assert.equal(response.status, 200, response.text);
  return response.json.documents.find((row) => row.id === documentId) || null;
};

// The three lanes a lone receipt reaches on the appliance: the router, the
// receipt extractor, and — because the receipt matcher finds no bank line —
// the doc-first disposition (DOCUMENT_NO_LINE_DISPOSITION, seeded auto), which
// the recording answers as an immaterial auto_explain.
const scriptReceiptLanes = (appliance, { routingTimes = 1 } = {}) => {
  appliance.providers.script('document_routing', [{ recording: 'document_routing/screwfix-receipt', times: routingTimes }]);
  // RT-12: the unified extractor is the appliance default — the receipt rides
  // the unified lane (both keys present ⇒ the Anthropic transport).
  appliance.providers.script('unified_extraction', ['unified_extraction/screwfix-receipt']);
  appliance.providers.script('document_disposition', ['document_disposition/screwfix-receipt-immaterial-auto-explain']);
};

test(
  'real PG (a): an upload is ONE parse-document job the queue completes; no drain touches a queue-owned row (RT-14: the drain has no desktop entry)',
  { skip: applianceHarnessSkipReason() },
  async () => {
    const appliance = await bootApplianceForTest({ now: BOOT_NOW });
    try {
      assert.ok(appliance.manifest.some((entry) => entry.functionId === PARSE_FN && entry.kind === 'local-event' && entry.cron == null),
        `the parse-document local-event handler is on the desktop manifest: ${JSON.stringify(appliance.manifest.map((e) => [e.functionId, e.kind]))}`);
      const { clientId, readiness } = await appliance.createClient();
      assert.equal(readiness?.state, 'ready', JSON.stringify(readiness));
      scriptReceiptLanes(appliance);

      const upload = await appliance.uploadDocument({ clientId, fixture: 'receipt_screwfix' });
      const runId = upload.registered?.parse_run_id;
      assert.ok(runId, 'register minted a parse run');
      assert.equal(upload.registered.event_sent, true, 'the register route stamps the job as the "job exists" receipt');
      const before = await appliance.read.document(upload.documentId);
      assert.equal(before.parse_status, 'pending');
      assert.ok(before.parse_event_sent_at, 'parse_event_sent_at is the job-exists receipt');

      const queued = await jobsForRun(appliance, runId);
      assert.equal(queued.length, 1, `exactly one job row for the run: ${JSON.stringify(queued)}`);
      assert.equal(queued[0].status, 'pending');
      assert.equal(queued[0].max_attempts, 4, 'decision D7: four automatic attempts');
      assert.deepEqual(
        (await appliance.query('select payload from local_jobs where id = $1', [queued[0].id])).rows[0].payload,
        { firm_id: appliance.firmId, document_id: upload.documentId, parse_run_id: runId, client_id: clientId, document_type: 'receipt' }
      );

      // RT-14: there is no drain on the appliance to race the job — an aged
      // pending row stays the queue's until its job runs.
      await appliance.query("update documents set parse_enqueued_at = now() - interval '10 minutes' where id = $1", [upload.documentId]);
      assert.ok(!appliance.manifest.some((entry) => entry.functionId === 'parse-cron:drain'), 'the drain has no desktop manifest entry');
      assert.equal((await appliance.read.document(upload.documentId)).parse_status, 'pending', 'the row rests with its job');
      assert.equal(appliance.providers.calls.length, 0, 'no model call before the job runs');

      // The queue: one full minute settles the job.
      const receipt = await appliance.tick();
      const [job] = await jobsForRun(appliance, runId);
      assert.equal(job.status, 'succeeded', `${job.last_error} :: ${receipt.log.slice(-12).join('\n')}`);
      assert.equal(job.attempt_count, 1);
      const document = await appliance.read.document(upload.documentId);
      assert.equal(document.parse_status, 'completed', JSON.stringify({ parse_error: document.parse_error, stage: document.parse_stage }));
      assert.equal(document.parse_run_id, runId, 'the completing run is the registered run');
      assert.equal(document.vendor_name, upload.fixture.expected.vendor_name);
      assert.equal(Number(document.total_amount), upload.fixture.expected.total_amount);
      assert.deepEqual(await stepsForJob(appliance, job.id).then((steps) => steps.filter((s) => s === 'parse-and-write')), ['parse-and-write'],
        'the parse ran as a memoized durable step');
      // Zero drain involvement: no drain job exists on the appliance.
      assert.ok(!receipt.jobs.some((entry) => entry.function_id === 'parse-cron:drain'), 'no drain job on the tick');
      assert.equal(appliance.providers.callsFor('unified_extraction').length, 1);
      assert.equal(appliance.providers.callsFor('document_routing').length, 1);
      appliance.providers.assertNoUnscripted();
      const actions = (await appliance.read.audit({ clientId })).map((row) => row.action);
      assert.ok(actions.includes('document.parse.queued') && actions.includes('document.parse.completed'), JSON.stringify(actions));
      assert.equal(actions.filter((action) => action === 'document.parse.failed').length, 0);
    } finally {
      await appliance.stop();
    }
  }
);

test(
  'real PG (b): provider 429 twice then 200 → completed on the third attempt of ONE job; no failed audit, no drain',
  { skip: applianceHarnessSkipReason() },
  async () => {
    const appliance = await bootApplianceForTest({ now: BOOT_NOW });
    try {
      const { clientId } = await appliance.createClient();
      appliance.providers.script('document_routing', [{ recording: 'document_routing/screwfix-receipt', times: 3 }]);
      appliance.providers.script('unified_extraction', [{ status: 429 }, { status: 429 }, 'unified_extraction/screwfix-receipt']);
      appliance.providers.script('document_disposition', ['document_disposition/screwfix-receipt-immaterial-auto-explain']);
      const upload = await appliance.uploadDocument({ clientId, fixture: 'receipt_screwfix' });
      const runId = upload.registered.parse_run_id;

      // Attempt 1: the extractor is rate-limited; the worker releases the run
      // and the QUEUE backs the job off — the row rests pending with no
      // failure written and no promise made.
      const first = await appliance.tick({ collapseWaits: false });
      let [job] = await jobsForRun(appliance, runId);
      assert.equal(job.status, 'pending', `attempt 1 backs off: ${JSON.stringify(job)} :: ${first.log.slice(-8).join('\n')}`);
      assert.equal(job.attempt_count, 1);
      assert.ok(new Date(job.run_at).getTime() > Date.now(), 'the retry is held by the queue backoff');
      assert.match(String(job.last_error), /extraction|429|rate/i);
      let document = await appliance.read.document(upload.documentId);
      assert.equal(document.parse_status, 'pending', 'released back to pending for the next attempt');
      assert.equal(document.parse_error, null, 'no failure envelope while attempts remain');
      assert.equal(document.parse_attempts, 1);

      // Attempt 2: still rate-limited.
      await appliance.tick();
      [job] = await jobsForRun(appliance, runId);
      assert.equal(job.status, 'pending', JSON.stringify(job));
      assert.equal(job.attempt_count, 2);

      // Attempt 3: the recording answers; the parse completes.
      const third = await appliance.tick();
      [job] = await jobsForRun(appliance, runId);
      assert.equal(job.status, 'succeeded', `${job.last_error} :: ${third.log.slice(-8).join('\n')}`);
      assert.equal(job.attempt_count, 3);
      document = await appliance.read.document(upload.documentId);
      assert.equal(document.parse_status, 'completed', JSON.stringify(document.parse_error));
      assert.equal(document.parse_attempts, 3, 'the claim counted every attempt');
      assert.equal((await jobsForRun(appliance, runId)).length, 1, 'one job row for the whole retry story');
      assert.equal(appliance.providers.callsFor('unified_extraction').length, 3);
      assert.equal((await appliance.read.audit({ clientId, action: 'document.parse.failed' })).length, 0);
      appliance.providers.assertNoUnscripted();
    } finally {
      await appliance.stop();
    }
  }
);

test(
  'real PG (c): 429 forever → the job dies and the document rests on the human; a manual retry gets a fresh budget',
  { skip: applianceHarnessSkipReason() },
  async () => {
    const appliance = await bootApplianceForTest({ now: BOOT_NOW });
    try {
      const { clientId } = await appliance.createClient();
      appliance.providers.script('document_routing', [{ recording: 'document_routing/screwfix-receipt', times: Infinity }]);
      appliance.providers.script('unified_extraction', [{ status: 429, times: Infinity }]);
      const upload = await appliance.uploadDocument({ clientId, fixture: 'receipt_screwfix' });
      const runId = upload.registered.parse_run_id;

      let job = null;
      for (let attempt = 0; attempt < 4; attempt += 1) {
        await appliance.tick();
        [job] = await jobsForRun(appliance, runId);
        if (job.status === 'dead') break;
      }
      assert.equal(job.status, 'dead', `attempts exhausted rest at dead: ${JSON.stringify(job)}`);
      assert.equal(job.attempt_count, 4);

      const document = await appliance.read.document(upload.documentId);
      assert.equal(document.parse_status, 'failed', JSON.stringify(document.parse_error));
      assert.equal(document.parse_error?.retryable, false, JSON.stringify(document.parse_error));
      assert.equal(document.parse_error?.retry_owner, 'manual', 'the human has the retry button, honestly');
      assert.deepEqual(document.parse_error?.retry_exhausted, { attempts: 4, max_attempts: 4 });
      assert.equal(document.parse_error?.code, 'DOCUMENT_EXTRACTION_FAILED', 'the original failure stays the receipt');
      assert.doesNotMatch(String(document.parse_error?.safe_user_message), /Retrying shortly/);
      const failedAudits = await appliance.read.audit({ clientId, action: 'document.parse.failed' });
      assert.equal(failedAudits.length, 1, JSON.stringify(failedAudits.map((row) => row.metadata)));
      assert.equal(failedAudits[0].metadata?.retry_owner, 'manual');
      assert.deepEqual(failedAudits[0].metadata?.retry_exhausted, { attempts: 4, max_attempts: 4 });
      // The terminal writer's quiescence re-check (RT-02, unchanged) leaves ONE
      // coalesced `ask_draft.requested` wake for the drafter to look at the
      // client — a wake, not an ask. No owner ask is minted: there is nothing
      // to ask about a receipt nobody could read.
      const wakes = await askWakes(appliance);
      assert.equal(wakes.length, 1, `exactly one coalesced drafter wake, never one per attempt: ${JSON.stringify(wakes)}`);
      assert.deepEqual(await appliance.read.asks(clientId), [], 'a dead parse of a lone receipt mints no owner ask');
      const status = await parseStatusFor(appliance, upload.documentId);
      assert.equal(status.parse_status, 'failed');
      assert.equal(status.parse_error?.retry_owner, 'manual');
      assert.equal(appliance.providers.callsFor('unified_extraction').length, 4, 'four attempts, four extractor calls');
      assert.equal(appliance.providers.callsFor('receipt_extraction').length, 0, 'a retryable unified failure is the queue\'s to retry — never a silent second extractor');

      // Manual retry: a NEW run with its own job and its own attempt budget.
      appliance.providers.reset();
      scriptReceiptLanes(appliance);
      const retry = await appliance.api.request({
        method: 'POST',
        path: '/api/donna/firms/documents/retry-parse',
        auth: true,
        body: { firm_id: appliance.firmId, document_ids: [upload.documentId] }
      });
      assert.equal(retry.status, 200, retry.text);
      const retried = retry.json.retried?.[0] || retry.json.documents?.[0] || null;
      assert.ok(retried, JSON.stringify(retry.json));
      const retriedDocument = await appliance.read.document(upload.documentId);
      const newRunId = retriedDocument.parse_run_id;
      assert.notEqual(newRunId, runId, 'the retry minted a new run');
      assert.equal(retriedDocument.parse_status, 'pending');
      assert.equal(retriedDocument.parse_attempts, 0, 'a manual retry resets the row budget — each run owns its attempts');
      assert.equal(retriedDocument.parse_error, null);
      const newJobs = await jobsForRun(appliance, newRunId);
      assert.equal(newJobs.length, 1, `the retry enqueued one job for the new run: ${JSON.stringify(newJobs)}`);
      assert.equal(newJobs[0].status, 'pending');
      assert.equal(newJobs[0].attempt_count, 0);

      await appliance.tick();
      const [newJob] = await jobsForRun(appliance, newRunId);
      assert.equal(newJob.status, 'succeeded', newJob.last_error);
      const completed = await appliance.read.document(upload.documentId);
      assert.equal(completed.parse_status, 'completed', JSON.stringify(completed.parse_error));
      assert.equal(completed.parse_run_id, newRunId);
      assert.equal(completed.parse_attempts, 1);
      assert.equal((await appliance.read.jobs({ functionId: PARSE_FN })).length, 2, 'two runs, two job rows');
      appliance.providers.assertNoUnscripted();
    } finally {
      await appliance.stop();
    }
  }
);

test(
  'real PG (d): a post-parse leg throws once → the retry replays the memoized parse-and-write and re-runs only the leg',
  { skip: applianceHarnessSkipReason() },
  async () => {
    const appliance = await bootApplianceForTest({ now: BOOT_NOW });
    try {
      const { clientId } = await appliance.createClient();
      appliance.providers.script('document_routing', ['document_routing/kestrel-bank-statement']);
      appliance.providers.script('bank_statement_extraction', ['bank_statement_extraction/kestrel-barclays-two-lines']);
      // The reconciliation-scan leg's terminal drain disposes both bare lines
      // (no bill, no payout report in the feed) — one strong-model verdict per
      // line, inside the job.
      appliance.providers.script('bank_line_disposition', [
        'bank_line_disposition/kestrel-ochre-debit-chase-receipt',
        'bank_line_disposition/kestrel-paylink-credit-chase-evidence'
      ]);
      // The coder's first provider call is answered, and the WRITE of its
      // verdicts is where the injected fault lands (a transient persistence
      // failure, the class retries exist for). No production seam is touched.
      // (Until 2026-09-12 this scripted a 500 and relied on the coder writing
      // its deterministic template on a provider failure; a provider failure
      // is now receipted, never written as a verdict — see
      // fiProviderRecoveryPgLifecycle — so the fault must land on a real answer.)
      const codingBodyFor = (rows) => ({
        id: 'resp_fixture_code_kestrel_lines_first',
        object: 'response',
        status: 'completed',
        model: 'gpt-5.4',
        output: [{
          id: 'msg_fixture_code_kestrel_lines_first',
          type: 'message',
          status: 'completed',
          role: 'assistant',
          content: [{
            type: 'output_text',
            annotations: [],
            text: JSON.stringify({
              suggestions: rows.map((transaction) => ({
                transaction_id: transaction.id,
                proposed_account: Number(transaction.money_in) > 0 ? 'Sales' : 'Suspense',
                contact: Number(transaction.money_in) > 0 ? 'PayLink' : 'Ochre Lighting Ltd',
                tax_treatment: 'standard',
                support_note: '',
                ask_client_question: '',
                evidence_required: Number(transaction.money_in) > 0 ? false : true,
                remember_candidate: false,
                merchant_pattern: Number(transaction.money_in) > 0 ? 'paylink' : 'ochre lighting',
                missing_account_name: '',
                missing_account_type: '',
                missing_account_reason: '',
                auto_explain_limit: 0,
                confidence: 'medium',
                materiality: 'material',
                reasoning: 'Fixture coding verdict for the appliance world.',
                warnings: [],
                alternatives: []
              })),
              group_summary: []
            })
          }]
        }],
        usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 }
      });
      appliance.providers.script('transaction_coding', [{ respond: (request) => ({ status: 200, body: codingBodyFor(JSON.parse(request.input).transactions || []) }) }]);
      await appliance.query(`
        create or replace function appliance_fixture_coding_fault() returns trigger language plpgsql as $$
        begin
          if (new.payload ? 'ai_suggestion') and not coalesce(old.payload ? 'ai_suggestion', false) then
            raise exception 'appliance fixture: injected coding write fault';
          end if;
          return new;
        end $$;
        create trigger appliance_fixture_coding_fault before update on transactions
          for each row execute function appliance_fixture_coding_fault();
      `);

      const upload = await appliance.uploadDocument({ clientId, fixture: 'bank_statement_two_lines' });
      const runId = upload.registered.parse_run_id;

      // Only the parse function ticks here: the fixture is about the job and
      // its legs, and the loops_inbox cron would otherwise carry the chase
      // verdicts into the ask drafter (RT-11's lane, no recording committed).
      const first = await appliance.tick({ collapseWaits: false, functions: [PARSE_FN] });
      let [job] = await jobsForRun(appliance, runId);
      assert.equal(job.status, 'pending', `attempt 1 failed at the coding leg and backed off: ${JSON.stringify(job)} :: ${first.log.slice(-10).join('\n')}`);
      assert.equal(job.attempt_count, 1);
      assert.match(String(job.last_error), /injected coding write fault/);
      let document = await appliance.read.document(upload.documentId);
      assert.equal(document.parse_status, 'completed', 'the parse itself completed on attempt 1 — legs never touch parse_status');
      const transactions = await appliance.read.transactions(clientId);
      assert.equal(transactions.length, 2, 'both statement lines were written on attempt 1');
      const stepsAfterFirst = await stepsForJob(appliance, job.id);
      assert.ok(stepsAfterFirst.includes('parse-and-write'), JSON.stringify(stepsAfterFirst));
      assert.ok(stepsAfterFirst.includes('reconciliation-scan'), JSON.stringify(stepsAfterFirst));
      assert.ok(!stepsAfterFirst.includes('ai-coding'), `the failed leg is not memoized: ${JSON.stringify(stepsAfterFirst)}`);
      assert.ok(!stepsAfterFirst.includes('owner-media-summary'), 'later legs did not run in the failed attempt');
      assert.equal(appliance.providers.callsFor('bank_statement_extraction').length, 1);
      assert.equal(appliance.providers.callsFor('transaction_coding').length, 1);
      assert.equal((await appliance.read.audit({ clientId, action: 'document.parse.leg_failed' })).length, 0,
        'a NON-final attempt writes no leg-failure receipt — the queue still owns the retry');

      // Heal the fault and let the coder answer.
      await appliance.query('drop trigger appliance_fixture_coding_fault on transactions');
      const codingBody = {
        id: 'resp_fixture_code_kestrel_lines',
        object: 'response',
        status: 'completed',
        model: 'gpt-5.4',
        output: [{
          id: 'msg_fixture_code_kestrel_lines',
          type: 'message',
          status: 'completed',
          role: 'assistant',
          content: [{
            type: 'output_text',
            annotations: [],
            text: JSON.stringify({
              suggestions: transactions.map((transaction) => ({
                transaction_id: transaction.id,
                proposed_account: Number(transaction.money_in) > 0 ? 'Sales' : 'Suspense',
                contact: Number(transaction.money_in) > 0 ? 'PayLink' : 'Ochre Lighting Ltd',
                tax_treatment: 'standard',
                support_note: '',
                ask_client_question: '',
                evidence_required: Number(transaction.money_in) > 0 ? false : true,
                remember_candidate: false,
                merchant_pattern: Number(transaction.money_in) > 0 ? 'paylink' : 'ochre lighting',
                missing_account_name: '',
                missing_account_type: '',
                missing_account_reason: '',
                auto_explain_limit: 0,
                confidence: 'medium',
                materiality: 'material',
                reasoning: 'Fixture coding verdict for the appliance world.',
                warnings: [],
                alternatives: []
              })),
              group_summary: []
            })
          }]
        }],
        usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 }
      };
      appliance.providers.script('transaction_coding', [{ status: 200, body: codingBody }]);

      const second = await appliance.tick({ functions: [PARSE_FN] });
      [job] = await jobsForRun(appliance, runId);
      assert.equal(job.status, 'succeeded', `${job.last_error} :: ${second.log.slice(-10).join('\n')}`);
      assert.equal(job.attempt_count, 2);
      assert.equal(appliance.providers.callsFor('bank_statement_extraction').length, 1, 'parse-and-write was replayed from the memoized step — no second extraction');
      assert.equal(appliance.providers.callsFor('transaction_coding').length, 2, 'the coding leg alone re-ran');
      const stepsAfterSecond = await stepsForJob(appliance, job.id);
      assert.ok(stepsAfterSecond.includes('ai-coding') && stepsAfterSecond.includes('owner-media-summary'), JSON.stringify(stepsAfterSecond));
      assert.equal(stepsAfterSecond.filter((step) => step === 'parse-and-write').length, 1);
      document = await appliance.read.document(upload.documentId);
      assert.equal(document.parse_status, 'completed');
      assert.equal(document.parse_run_id, runId);
      const coded = await appliance.read.transactions(clientId);
      assert.ok(coded.every((row) => row.payload?.ai_suggestion), JSON.stringify(coded.map((row) => row.payload)));
      assert.equal((await appliance.read.audit({ clientId, action: 'document.parse.leg_failed' })).length, 0);
      appliance.providers.assertNoUnscripted();
    } finally {
      await appliance.stop();
    }
  }
);

test(
  'real PG (e): an admission-refused claim defers the job without spending an attempt; the queue re-drives it when readiness heals',
  { skip: applianceHarnessSkipReason() },
  async () => {
    const appliance = await bootApplianceForTest({ now: BOOT_NOW });
    try {
      const { clientId } = await appliance.createClient();
      scriptReceiptLanes(appliance);
      const upload = await appliance.uploadDocument({ clientId, fixture: 'receipt_screwfix' });
      const runId = upload.registered.parse_run_id;
      // The entity's readiness fails AFTER the upload was accepted (the saga
      // is what the parse_claim boundary reads).
      await appliance.query(
        "update entity_readiness_sagas set state = 'failed', reason_code = 'fixture_forced_failure' where firm_id = $1 and client_id = $2",
        [appliance.firmId, clientId]
      );

      const held = await appliance.tick();
      let [job] = await jobsForRun(appliance, runId);
      assert.equal(job.status, 'pending', `the refused claim DEFERS the job: ${JSON.stringify(job)} :: ${held.log.slice(-8).join('\n')}`);
      assert.equal(job.attempt_count, 0, 'a readiness hold is not an attempt');
      assert.ok(new Date(job.run_at).getTime() > Date.now() + 60_000, `the job waits for the hold recheck window: ${job.run_at}`);
      assert.match(String(job.last_error), /deferred/i);
      assert.match(String(job.last_error), /fixture_forced_failure|admission/i);
      let document = await appliance.read.document(upload.documentId);
      assert.equal(document.parse_status, 'pending');
      assert.equal(document.payload?.parse_hold?.reason_code, 'fixture_forced_failure', JSON.stringify(document.payload?.parse_hold));
      assert.equal(document.parse_attempts, 0);
      const status = await parseStatusFor(appliance, upload.documentId);
      assert.equal(status.parse_status, 'pending');
      assert.equal(status.parse_hold?.reason_code, 'fixture_forced_failure', `the parse-status projection carries the hold: ${JSON.stringify(status)}`);
      const blocked = await appliance.read.audit({ clientId, action: 'runtime.readiness_admission_blocked' });
      assert.equal(blocked.length, 1, 'one blocked audit for the refusal');
      assert.equal(appliance.providers.calls.length, 0, 'no model call while held');

      // Still held: nothing is due, nothing runs, nothing is re-audited.
      const stillHeld = await appliance.tick({ collapseWaits: false, functions: [PARSE_FN] });
      assert.deepEqual(stillHeld.jobs, [], 'the deferred job is not due yet');
      assert.equal((await appliance.read.audit({ clientId, action: 'runtime.readiness_admission_blocked' })).length, 1);

      // Readiness heals; the queue's next recheck claims and completes.
      await appliance.query(
        "update entity_readiness_sagas set state = 'ready', reason_code = null where firm_id = $1 and client_id = $2",
        [appliance.firmId, clientId]
      );
      const healed = await appliance.tick();
      [job] = await jobsForRun(appliance, runId);
      assert.equal(job.status, 'succeeded', `${job.last_error} :: ${healed.log.slice(-8).join('\n')}`);
      assert.equal(job.attempt_count, 1, 'the real attempt is the only one counted');
      document = await appliance.read.document(upload.documentId);
      assert.equal(document.parse_status, 'completed', JSON.stringify(document.parse_error));
      assert.equal(document.payload?.parse_hold, undefined, 'the successful claim strips the hold');
      assert.equal((await jobsForRun(appliance, runId)).length, 1);
      assert.equal((await appliance.read.audit({ clientId, action: 'runtime.readiness_admission_blocked' })).length, 1);
      appliance.providers.assertNoUnscripted();
    } finally {
      await appliance.stop();
    }
  }
);
