// parseDocumentJob — the per-document parse as a local job (RT-08). What
// must hold, without a database:
//   - the manifest declaration is a cron-less local-event job with the D7
//     budget, and the env knobs are the same ones the drain backstop reads;
//   - one job per parse run (dedupe_key = parse_run_id), payload = event data;
//   - the producer fork: Inngest configured ⇒ the event; otherwise ⇒ the job;
//   - the runner threads the job's attempt budget into the exported worker
//     handler and turns the two "not yet" outcomes into a DEFERRAL (attempt
//     handed back, memoized claim step forgotten), every other handled:false
//     into a completed job, and a thrown error into a failed attempt;
//   - the worker's first durable step is the one the runner forgets.
// The end-to-end behaviour on real PG is parseDocumentJobPgLifecycle.test.js.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { isLocalJobDeferral } from './localJobQueue.js';
import {
  PARSE_AND_WRITE_STEP_KEY,
  PARSE_DOCUMENT_FUNCTION_ID,
  PARSE_DOCUMENT_MAX_ATTEMPTS_DEFAULT,
  enqueueParseDocumentJob,
  parseDocumentConcurrency,
  parseDocumentJobDeclaration,
  parseDocumentJobPayload,
  parseDocumentMaxAttempts,
  parseHoldRecheckMs,
  requestParseRun,
  runParseDocumentJob
} from './parseDocumentJob.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RUN_ID = '11111111-1111-4111-8111-111111111111';
const quiet = { log: () => {}, warn: () => {}, error: () => {} };
const payload = { firm_id: 'firm-1', document_id: 'doc-1', parse_run_id: RUN_ID, client_id: 'client-1', document_type: 'receipt' };
const fakeStep = () => {
  const forgotten = [];
  return { forgotten, step: { __desktop: true, run: async (_name, fn) => fn(), forget: async (name) => { forgotten.push(name); return 1; } } };
};

test('declaration: a cron-less local-event job with the D7 budget; env knobs are shared with the drain backstop', () => {
  assert.deepEqual(parseDocumentJobDeclaration({ env: {} }), {
    functionId: 'parse-document',
    kind: 'local-event',
    cron: null,
    maxAttempts: 4,
    concurrency: 2,
    leaseMs: 10 * 60_000,
    timeoutMs: 5 * 60_000,
    handlerVersion: '1'
  });
  assert.equal(PARSE_DOCUMENT_FUNCTION_ID, 'parse-document');
  assert.equal(PARSE_DOCUMENT_MAX_ATTEMPTS_DEFAULT, 4);
  assert.equal(parseDocumentMaxAttempts({ PARSE_MAX_ATTEMPTS: '6' }), 6);
  assert.equal(parseDocumentMaxAttempts({ PARSE_MAX_ATTEMPTS: '0' }), 4, 'a non-positive knob falls back to D7');
  assert.equal(parseDocumentMaxAttempts({ PARSE_MAX_ATTEMPTS: 'many' }), 4);
  assert.equal(parseDocumentConcurrency({ INNGEST_PARSE_CONCURRENCY: '3' }), 3);
  assert.equal(parseDocumentConcurrency({}), 2);
  assert.equal(parseHoldRecheckMs({}), 300_000, 'the drain\'s hold recheck window, in ms');
  assert.equal(parseHoldRecheckMs({ PARSE_HOLD_RECHECK_SECONDS: '60' }), 60_000);
});

test('enqueueParseDocumentJob: one job per parse run — dedupe_key is the run id, the payload is the event data', async () => {
  const seen = [];
  const result = await enqueueParseDocumentJob({
    client: { query: async () => ({ rows: [] }) },
    firmId: 'firm-1', documentId: 'doc-1', parseRunId: RUN_ID, clientId: 'client-1', documentType: 'receipt',
    env: { PARSE_MAX_ATTEMPTS: '5' },
    enqueue: async (args) => { seen.push(args); return { id: 42 }; }
  });
  assert.deepEqual(result, { enqueued: true, deduped: false, job: { id: 42 } });
  assert.equal(seen[0].functionId, 'parse-document');
  assert.equal(seen[0].dedupeKey, RUN_ID);
  assert.equal(seen[0].maxAttempts, 5);
  assert.equal(seen[0].handlerVersion, '1');
  assert.deepEqual(seen[0].payload, payload);
  assert.deepEqual(parseDocumentJobPayload({ firmId: 'f', documentId: 'd', parseRunId: 'r' }),
    { firm_id: 'f', document_id: 'd', parse_run_id: 'r', client_id: null, document_type: null });

  const deduped = await enqueueParseDocumentJob({
    client: {}, firmId: 'firm-1', documentId: 'doc-1', parseRunId: RUN_ID, enqueue: async () => null
  });
  assert.deepEqual(deduped, { enqueued: false, deduped: true, job: null }, 'a second enqueue for the same run lands on the partial index — reported, never a second job');
  await assert.rejects(() => enqueueParseDocumentJob({ client: {}, firmId: 'firm-1', enqueue: async () => null }), /requires firm_id, document_id, parse_run_id/);
});

test('requestParseRun: Inngest configured ⇒ the event, untouched; otherwise ⇒ the local job', async () => {
  const sent = [];
  const enqueued = [];
  const send = async (args) => { sent.push(args); };
  const enqueue = async (args) => { enqueued.push(args); return { enqueued: true, deduped: false, job: { id: 9 } }; };
  const cloud = await requestParseRun({
    firmId: 'firm-1', documentId: 'doc-1', parseRunId: RUN_ID, clientId: 'client-1', documentType: 'receipt',
    inngestConfigured: true, send, enqueue
  });
  assert.deepEqual(cloud, { transport: 'inngest', job_id: null, deduped: false });
  assert.deepEqual(sent, [{ firmId: 'firm-1', documentId: 'doc-1', parseRunId: RUN_ID, clientId: 'client-1', documentType: 'receipt' }]);
  assert.equal(enqueued.length, 0);

  const desktop = await requestParseRun({
    firmId: 'firm-1', documentId: 'doc-1', parseRunId: RUN_ID, clientId: 'client-1', documentType: 'receipt',
    client: { query: async () => ({ rows: [] }) }, inngestConfigured: false, send, enqueue
  });
  assert.deepEqual(desktop, { transport: 'local_job', job_id: 9, deduped: false });
  assert.equal(sent.length, 1, 'no event on the appliance');
  assert.equal(enqueued[0].parseRunId, RUN_ID);
  await assert.rejects(() => requestParseRun({ firmId: 'firm-1', inngestConfigured: false, send, enqueue }), /requires/);
});

test('runParseDocumentJob: threads the attempt budget into the exported handler and returns a handled result', async () => {
  const seen = [];
  const { step } = fakeStep();
  const result = await runParseDocumentJob({
    step, logger: quiet, payload, job: { id: 3, attempt_count: 2, max_attempts: 4 },
    deps: { handleParseEvent: async (args) => { seen.push(args); return { handled: true, outcome: 'completed', document_id: 'doc-1' }; } }
  });
  assert.deepEqual(result, { handled: true, outcome: 'completed', document_id: 'doc-1' });
  assert.deepEqual(seen[0].attempt, { count: 2, max: 4 });
  assert.equal(seen[0].step, step);
  assert.deepEqual(seen[0].event, { id: RUN_ID, name: 'document/parse.requested', data: payload });
});

test('runParseDocumentJob: a refused claim DEFERS for the hold recheck window and forgets the memoized claim step', async () => {
  const { step, forgotten } = fakeStep();
  const now = new Date('2026-08-31T09:01:00.000Z');
  await assert.rejects(
    () => runParseDocumentJob({
      step, logger: quiet, payload, job: { id: 3, attempt_count: 1, max_attempts: 4 },
      deps: {
        now: () => now,
        env: { PARSE_HOLD_RECHECK_SECONDS: '120' },
        handleParseEvent: async () => ({
          handled: false, reason: 'admission_refused', claim_outcome: 'admission_refused',
          reason_code: 'entity_readiness_failed', hold: { reason_code: 'entity_readiness_failed' }
        })
      }
    }),
    (error) => {
      assert.ok(isLocalJobDeferral(error), `a deferral, not a failure: ${error?.message}`);
      assert.equal(error.runAt.getTime(), now.getTime() + 120_000);
      assert.equal(error.reason, 'admission_refused:entity_readiness_failed');
      return true;
    }
  );
  assert.deepEqual(forgotten, [PARSE_AND_WRITE_STEP_KEY], 'the memoized refusal is forgotten so the recheck re-claims');
});

test('runParseDocumentJob: not_pending with the run still owned elsewhere defers; a finished run completes the job', async () => {
  const now = new Date('2026-08-31T09:01:00.000Z');
  const owned = fakeStep();
  await assert.rejects(
    () => runParseDocumentJob({
      step: owned.step, logger: quiet, payload, job: { id: 3, attempt_count: 2, max_attempts: 4 },
      deps: {
        now: () => now,
        handleParseEvent: async () => ({ handled: false, reason: 'not_pending', claim_outcome: 'not_pending' }),
        getDocumentForParseInDb: async () => ({ id: 'doc-1', parse_run_id: RUN_ID, parse_status: 'processing' })
      }
    }),
    (error) => {
      assert.ok(isLocalJobDeferral(error));
      assert.equal(error.runAt.getTime(), now.getTime() + 60_000, 'ownership rechecks on the one-minute cadence');
      assert.equal(error.reason, 'run_owned_elsewhere:processing');
      return true;
    }
  );
  assert.deepEqual(owned.forgotten, [PARSE_AND_WRITE_STEP_KEY]);

  const finished = fakeStep();
  const result = await runParseDocumentJob({
    step: finished.step, logger: quiet, payload, job: { id: 3, attempt_count: 2, max_attempts: 4 },
    deps: {
      handleParseEvent: async () => ({ handled: false, reason: 'not_pending', claim_outcome: 'not_pending' }),
      getDocumentForParseInDb: async () => ({ id: 'doc-1', parse_run_id: RUN_ID, parse_status: 'failed' })
    }
  });
  assert.deepEqual(result, { handled: false, reason: 'not_pending', claim_outcome: 'not_pending', parse_status: 'failed' });
  assert.deepEqual(finished.forgotten, [], 'a finished run has nothing to forget');

  const superseded = fakeStep();
  const stale = await runParseDocumentJob({
    step: superseded.step, logger: quiet, payload, job: { id: 3, attempt_count: 1, max_attempts: 4 },
    deps: { handleParseEvent: async () => ({ handled: false, reason: 'stale_run', claim_outcome: 'stale_run' }) }
  });
  assert.deepEqual(stale, { handled: false, reason: 'stale_run', claim_outcome: 'stale_run' }, 'a newer run has its own job; this one is done');
  assert.deepEqual(superseded.forgotten, []);
});

test('runParseDocumentJob: a malformed payload fails the job loudly; a thrown parse error propagates as a failure, never a deferral', async () => {
  const { step } = fakeStep();
  await assert.rejects(
    () => runParseDocumentJob({ step, logger: quiet, payload: { firm_id: 'firm-1' }, job: { id: 5, attempt_count: 1, max_attempts: 4 }, deps: { handleParseEvent: async () => ({ handled: true }) } }),
    /parse-document job #5 payload is missing firm_id\/document_id\/parse_run_id/
  );
  await assert.rejects(
    () => runParseDocumentJob({ step, logger: quiet, payload, job: { id: 5, attempt_count: 4, max_attempts: 4 }, deps: { handleParseEvent: async () => { throw Object.assign(new Error('429 Too Many Requests'), { status: 429 }); } } }),
    (error) => {
      assert.equal(isLocalJobDeferral(error), false, 'a provider failure is the queue\'s to retry or dead-letter');
      assert.match(error.message, /429/);
      return true;
    }
  );
});

test('lockstep: the worker exports handleParseEvent and its first durable step is the one the runner forgets', () => {
  const source = readFileSync(path.join(HERE, '..', 'inngest', 'parseDocument.js'), 'utf8');
  assert.ok(source.includes('export const handleParseEvent = async ({ event, step, logger, attempt = null })'),
    'the desktop manifest runs the SAME handler the Inngest registration wraps');
  assert.ok(source.includes(`step.run('${PARSE_AND_WRITE_STEP_KEY}'`), 'the parse+claim step name the runner forgets on a deferral');
  assert.ok(source.includes('attemptsExhausted(attempt)'), 'the exhausted-attempts branch keys on the threaded budget');
});
