// RT-14b on the appliance (docs/session-handoff-2026-09-02-runtime-refactor-
// orchestrator-2.md §4; the residual RT-14 named in its handoff §4 item 3 and
// RT-08 in its §4 item 2): a register-time enqueue that fails must not leave
// the document resting on nobody.
//
// The register route swallows a local-job enqueue failure with
// `event_send_warning` ("the outbox sweeper picks this up") — a promise that
// was true only in the cloud. With the drain gone (RT-14) such a row rested
// `pending` with no job until a manual retry: the two-terminal violation
// (CLAUDE.md — a row resting on nobody is the bug). The fix is the converging
// one: `?task=outbox` forks on the producer (requestParseRun — the Inngest
// re-send in the cloud, unchanged; a `parse-document` local job on the
// appliance, dedupe_key = parse_run_id) and is scheduled on the appliance
// every minute, receipting every row it touches in `summary.outbox.requeued`.
//
// The sequence, on the REAL desktop assembly over real PostgreSQL:
//   1. the local-job enqueue is forced to fail AT THE DATABASE (a trigger
//      refuses the `parse-document` insert — the same statement
//      enqueueLocalJob runs, refused the way a real outage refuses it); the
//      upload registers 200 with the warning; the row rests pending with no
//      job and no job-exists receipt — today's state, asserted as such;
//   2. one scheduler minute: the outbox function requeues the run (ONE job,
//      dedupe_key = parse_run_id), stamps the receipt, names the document in
//      `summary.outbox.requeued` with the reason;
//   3. the receipt is cleared again (the route enqueued but its stamp failed)
//      and the outbox ticks again: the run DEDUPES against its active job —
//      still one job, the receipt re-stamped, `already_queued` names it;
//   4. the queue completes the parse; the document reaches its normal
//      terminal on the registered run;
//   5. a further minute requeues nothing.
//
// Written first and watched FAIL on the pre-RT-14b tree (no `parse-cron:outbox`
// on the desktop manifest; the row stayed pending with no job), then made green.

import assert from 'node:assert/strict';
import test from 'node:test';

import { applianceHarnessSkipReason, bootApplianceForTest } from './testSupport/applianceHarness.js';

const PARSE_FN = 'parse-document';
const OUTBOX_FN = 'parse-cron:outbox';
const BOOT_NOW = new Date('2026-09-02T09:00:00.000Z');

const jobsForRun = async (appliance, parseRunId) =>
  (await appliance.read.jobs({ functionId: PARSE_FN })).filter((job) => job.dedupe_key === parseRunId);

// The three lanes a lone receipt reaches on the appliance (the RT-08 fixtures'
// script): the router, the unified extractor, and the doc-first disposition.
const scriptReceiptLanes = (appliance) => {
  appliance.providers.script('document_routing', ['document_routing/screwfix-receipt']);
  appliance.providers.script('unified_extraction', ['unified_extraction/screwfix-receipt']);
  appliance.providers.script('document_disposition', ['document_disposition/screwfix-receipt-immaterial-auto-explain']);
};

// The injection: enqueueLocalJob's INSERT into local_jobs is refused by the
// database for the parse function only — the register route's producer sees
// exactly the error a real outage hands it, and nothing in the production
// path is stubbed.
const REFUSAL_MESSAGE = 'appliance harness: local-job enqueue forced to fail (RT-14b fixture)';
const refuseParseEnqueue = async (appliance) => {
  await appliance.query(`
    create or replace function appliance_harness_refuse_parse_enqueue() returns trigger
    language plpgsql as $$ begin raise exception '${REFUSAL_MESSAGE}'; end $$;
    create trigger appliance_harness_refuse_parse_enqueue
      before insert on local_jobs for each row
      when (new.function_id = '${PARSE_FN}')
      execute function appliance_harness_refuse_parse_enqueue();
  `);
};
const allowParseEnqueue = async (appliance) => {
  await appliance.query('drop trigger if exists appliance_harness_refuse_parse_enqueue on local_jobs');
};

const outboxSummaryOf = (receipt) => {
  const job = receipt.jobs.find((entry) => entry.function_id === OUTBOX_FN);
  assert.ok(job, `the outbox function ticked: ${JSON.stringify(receipt.jobs.map((entry) => [entry.function_id, entry.status]))}`);
  assert.equal(job.status, 'succeeded', job.last_error);
  assert.ok(job.result?.outbox && typeof job.result.outbox === 'object', `the job result is the runner's summary: ${JSON.stringify(job.result)}`);
  return job.result.outbox;
};

test(
  'real PG (appliance, RT-14b): a register-time enqueue failure rests pending on nobody until the scheduled outbox requeues the run as ONE deduped local job and the parse completes',
  { skip: applianceHarnessSkipReason() },
  async () => {
    const appliance = await bootApplianceForTest({ now: BOOT_NOW });
    try {
      const { clientId, readiness } = await appliance.createClient();
      assert.equal(readiness?.state, 'ready', JSON.stringify(readiness));
      scriptReceiptLanes(appliance);

      // ── 1. today's state: the enqueue fails, the route keeps the upload ──
      await refuseParseEnqueue(appliance);
      let upload;
      try {
        upload = await appliance.uploadDocument({ clientId, fixture: 'receipt_screwfix' });
      } finally {
        await allowParseEnqueue(appliance);
      }
      const runId = upload.registered?.parse_run_id;
      assert.ok(runId, 'register minted a parse run');
      assert.equal(upload.registered.parse_status, 'pending');
      assert.equal(upload.registered.event_sent, false, 'the route swallowed the enqueue failure — the owner uploaded; Donna owns the retry');
      assert.ok(String(upload.registered.event_send_warning || '').includes(REFUSAL_MESSAGE),
        `the warning names the enqueue failure: ${upload.registered.event_send_warning}`);
      const before = await appliance.read.document(upload.documentId);
      assert.equal(before.parse_status, 'pending');
      assert.equal(before.parse_run_id, runId);
      assert.equal(before.parse_event_sent_at, null, 'no job-exists receipt');
      assert.deepEqual(await jobsForRun(appliance, runId), [], 'no job for the run: the row rests on nobody');
      assert.equal(appliance.providers.calls.length, 0, 'no model call before a job exists');

      // The outbox's selection is the cloud's, unchanged: pending, no receipt,
      // past the 30-second settle window. The DB clock cannot be advanced from
      // the harness clock, so the row is aged here.
      await appliance.query(
        "update documents set parse_enqueued_at = now() - interval '2 minutes' where firm_id = $1 and id = $2",
        [appliance.firmId, upload.documentId]
      );

      // ── 2. the scheduled outbox requeues the run ──
      assert.ok(
        appliance.manifest.some((entry) => entry.functionId === OUTBOX_FN && entry.kind === 'parse-cron' && entry.cron === '* * * * *'),
        `the outbox is scheduled every minute on the appliance (RT-14b): ${JSON.stringify(appliance.manifest.map((e) => [e.functionId, e.cron]))}`
      );
      const first = outboxSummaryOf(await appliance.tick({ functions: [OUTBOX_FN] }));
      assert.equal(first.transport, 'local_job', JSON.stringify(first));
      assert.equal(first.picked, 1, JSON.stringify(first));
      assert.deepEqual(
        first.requeued.map(({ document_id, client_id, parse_run_id, reason }) => ({ document_id, client_id, parse_run_id, reason })),
        [{ document_id: upload.documentId, client_id: clientId, parse_run_id: runId, reason: 'no_job_receipt' }],
        `the requeue is receipted with the document id and the reason: ${JSON.stringify(first)}`
      );
      assert.deepEqual(first.already_queued, []);
      assert.deepEqual(first.failed, []);
      const queued = await jobsForRun(appliance, runId);
      assert.equal(queued.length, 1, `ONE parse-document job for the run: ${JSON.stringify(queued)}`);
      assert.equal(queued[0].status, 'pending', 'the job waits for the parse function\'s own dispatch');
      assert.equal(queued[0].dedupe_key, runId, 'dedupe_key = parse_run_id (RT-08)');
      assert.equal(String(first.requeued[0].job_id), String(queued[0].id), 'the receipt names the job it minted');
      assert.equal(queued[0].max_attempts, 4, 'the queue\'s attempt budget (D7), same as a route-enqueued job');
      assert.deepEqual(
        (await appliance.query('select payload from local_jobs where id = $1', [queued[0].id])).rows[0].payload,
        { firm_id: appliance.firmId, document_id: upload.documentId, parse_run_id: runId, client_id: clientId, document_type: 'receipt' },
        'the job payload is the event shape the handler expects'
      );
      const afterRequeue = await appliance.read.document(upload.documentId);
      assert.equal(afterRequeue.parse_status, 'pending', 'still pending — now with a job');
      assert.ok(afterRequeue.parse_event_sent_at, 'the outbox stamped the job-exists receipt');

      // ── 3. dedupe: the receipt is lost but the job is live ──
      await appliance.query(
        'update documents set parse_event_sent_at = null where firm_id = $1 and id = $2',
        [appliance.firmId, upload.documentId]
      );
      const second = outboxSummaryOf(await appliance.tick({ functions: [OUTBOX_FN] }));
      assert.equal(second.picked, 1, JSON.stringify(second));
      assert.deepEqual(second.requeued, [], 'no second job for a run that has one');
      assert.deepEqual(
        second.already_queued.map(({ document_id, parse_run_id, reason }) => ({ document_id, parse_run_id, reason })),
        [{ document_id: upload.documentId, parse_run_id: runId, reason: 'no_job_receipt' }],
        `the deduped row is named, never silent: ${JSON.stringify(second)}`
      );
      assert.equal((await jobsForRun(appliance, runId)).length, 1, 'dedupe_key = parse_run_id held: still one job');
      assert.ok((await appliance.read.document(upload.documentId)).parse_event_sent_at, 'the receipt is re-stamped');
      assert.equal(appliance.providers.calls.length, 0, 'the outbox itself never parses');

      // ── 4. the queue completes the parse on the registered run ──
      const full = await appliance.tick();
      assert.equal(outboxSummaryOf(full).picked, 0, 'a row with its receipt is not the outbox\'s');
      const [job] = await jobsForRun(appliance, runId);
      assert.equal(job.status, 'succeeded', `${job.last_error} :: ${full.log.slice(-12).join('\n')}`);
      assert.equal(job.attempt_count, 1);
      const document = await appliance.read.document(upload.documentId);
      assert.equal(document.parse_status, 'completed', JSON.stringify({ parse_error: document.parse_error, stage: document.parse_stage }));
      assert.equal(document.parse_run_id, runId, 'the completing run is the registered run');
      assert.equal(document.vendor_name, upload.fixture.expected.vendor_name);
      assert.equal(Number(document.total_amount), upload.fixture.expected.total_amount);
      assert.equal(appliance.providers.callsFor('unified_extraction').length, 1, 'the parse ran once');
      assert.equal(appliance.providers.callsFor('document_routing').length, 1);
      appliance.providers.assertNoUnscripted();
      const actions = (await appliance.read.audit({ clientId })).map((row) => row.action);
      assert.ok(actions.includes('document.parse.completed'), JSON.stringify(actions));
      assert.equal(actions.filter((action) => action === 'document.parse.failed').length, 0);

      // ── 5. nothing more to requeue ──
      const third = outboxSummaryOf(await appliance.tick({ functions: [OUTBOX_FN] }));
      assert.equal(third.picked, 0, JSON.stringify(third));
      assert.deepEqual(third.requeued, []);
      assert.equal((await jobsForRun(appliance, runId)).length, 1, 'one job for the run, start to finish');
      assert.equal((await appliance.read.document(upload.documentId)).parse_status, 'completed');
    } finally {
      await appliance.stop();
    }
  }
);
