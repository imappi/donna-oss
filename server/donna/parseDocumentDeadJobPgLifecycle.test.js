// A document that could not be read is an outcome about that document, not a
// fault of the host — real PostgreSQL, on the appliance harness (the runtime
// the Electron shell and `npm run local:runtime` boot), nothing in the parse
// path or the certificate mocked.
//
// The diagnosis (stored state, before this change): a `parse-document` job
// that spends its four automatic attempts rests `dead`, its document
// `failed` / retry_exhausted / retry_owner 'manual' under the same run id.
// Host Certificate A's work-queue rule counted every dead non-cron job as
// `dead_unsuperseded`, so database_schema read FAIL
// (work_queue_needs_recovery): `upload-url` answered 503
// ENTITY_READINESS_ADMISSION_BLOCKED for every new upload on the book, and a
// manual retry's new run was deferred at its own claim
// (admission_refused:work_queue_needs_recovery), so the book could not move.
//
// What must hold now:
//   (a) one document fails for good; a second document uploaded afterwards
//       is admitted and read; the certificate passes with the dead job
//       visible and accounted for; the failed document shows its own stored
//       reason and the book shows no host fault; a manual retry runs under a
//       new run id and settles the old dead job with its id on the retry's
//       receipt, in the retry's transaction.
//   (b) a dead parse job with NO recorded outcome — its document still
//       claims that run in flight, or its document row is gone — still
//       fails the certificate and refuses new work, as before.
//   (c) a book already blocked by the previous release (a failed document
//       with its dead job, and one whose retry was minted but held at its
//       claim) comes unblocked at the next certificate, no data deleted, and
//       the held retry is read.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { applianceHarnessSkipReason, bootApplianceForTest } from './testSupport/applianceHarness.js';

const PARSE_FN = 'parse-document';
const BOOT_NOW = new Date('2026-08-31T09:00:00.000Z');

const jobsForRun = async (appliance, parseRunId) =>
  (await appliance.read.jobs({ functionId: PARSE_FN })).filter((job) => job.dedupe_key === parseRunId);

// Run the parse queue alone, with every pending parse job due now (the
// backoff and recheck windows are wall-clock waits on the DB clock).
const parseTick = async (appliance) => {
  await appliance.query("update local_jobs set run_at = now() where function_id = $1 and status = 'pending'", [PARSE_FN]);
  return appliance.tick({ functions: [PARSE_FN], collapseWaits: false, maxRounds: 1 });
};

const certify = async (appliance) => {
  await appliance.runtime.hostReadiness.renewNow();
  const host = await appliance.read.host();
  const database = host.certificate?.checks?.find((entry) => entry.id === 'database_schema');
  return { host, database, queue: database?.detail?.queue || {} };
};

const signUpload = (appliance, clientId, seed) => appliance.api.request({
  method: 'POST',
  path: '/api/donna/firms/documents/upload-url',
  auth: true,
  body: { firm_id: appliance.firmId, client_id: clientId, filename: `${seed}.pdf`, mime_type: 'application/pdf', size: 10, checksum_sha256: seed.repeat(64).slice(0, 64) }
});

const snapshot = async (appliance) => {
  const response = await appliance.api.request({
    path: `/api/donna/firms/snapshot?firm_id=${encodeURIComponent(appliance.firmId)}`,
    auth: true
  });
  assert.equal(response.status, 200, response.text);
  return response.json;
};

const retryParse = async (appliance, documentId) => {
  const response = await appliance.api.request({
    method: 'POST',
    path: '/api/donna/firms/documents/retry-parse',
    auth: true,
    body: { firm_id: appliance.firmId, document_ids: [documentId] }
  });
  assert.equal(response.status, 200, response.text);
  return response.json;
};

// A receipt read whose extraction answers 5xx on every automatic attempt.
const failForGood = async (appliance, clientId) => {
  appliance.providers.script('document_routing', [{ recording: 'document_routing/screwfix-receipt', times: 4 }]);
  appliance.providers.script('unified_extraction', [{ status: 500, times: 4 }]);
  const upload = await appliance.uploadDocument({ clientId, fixture: 'receipt_screwfix' });
  const runId = upload.registered.parse_run_id;
  let job = null;
  for (let attempt = 0; attempt < 6 && job?.status !== 'dead'; attempt += 1) {
    await parseTick(appliance);
    [job] = await jobsForRun(appliance, runId);
  }
  return { upload, runId, job };
};

const scriptOneRead = (appliance) => {
  appliance.providers.script('document_routing', ['document_routing/screwfix-receipt']);
  appliance.providers.script('unified_extraction', ['unified_extraction/screwfix-receipt']);
  appliance.providers.script('document_disposition', ['document_disposition/screwfix-receipt-immaterial-auto-explain']);
};

test(
  'real PG (a): a document that fails for good does not stop the book — the next upload is read, the host certifies, the failed document shows its reason, and its manual retry runs and settles the dead job',
  { skip: applianceHarnessSkipReason() },
  async () => {
    const appliance = await bootApplianceForTest({ keys: { openai: true, anthropic: true }, now: BOOT_NOW });
    try {
      const { clientId } = await appliance.createClient();
      const failed = await failForGood(appliance, clientId);

      // The stored outcome: the job dead after four attempts, the document
      // failed under the SAME run with its typed, exhausted error.
      assert.equal(failed.job.status, 'dead', JSON.stringify(failed.job));
      assert.equal(failed.job.attempt_count, 4);
      const rested = await appliance.read.document(failed.upload.documentId);
      assert.equal(rested.parse_status, 'failed');
      assert.equal(rested.parse_run_id, failed.runId);
      assert.equal(rested.parse_error?.code, 'DOCUMENT_EXTRACTION_FAILED');
      assert.equal(rested.parse_error?.retryable, false);
      assert.equal(rested.parse_error?.retry_owner, 'manual');
      assert.deepEqual(rested.parse_error?.retry_exhausted, { attempts: 4, max_attempts: 4 });

      // Host A: the dead job stays visible and is accounted for by the
      // document's own outcome — not a host fault.
      const after = await certify(appliance);
      assert.equal(after.host.status, 'PASS', JSON.stringify({ reason: after.host.reason_code, queue: after.queue }));
      assert.equal(after.database.status, 'PASS');
      assert.equal(after.queue.dead, 1, 'the dead job stays visible in the receipt');
      assert.equal(after.queue.dead_unsuperseded, 0);
      assert.equal(after.queue.dead_accounted_by_document, 1);

      // A second document uploaded afterwards is admitted and read.
      scriptOneRead(appliance);
      const second = await appliance.uploadDocument({
        clientId,
        bytes: Buffer.concat([readFileSync(new URL('./fixtures/appliance/screwfix-receipt-2026-08-22.pdf', import.meta.url)), Buffer.from('\n% second\n')]),
        filename: 'second-receipt.pdf',
        documentType: 'receipt'
      });
      await parseTick(appliance);
      const read = await appliance.read.document(second.documentId);
      assert.equal(read.parse_status, 'completed', JSON.stringify({ error: read.parse_error, hold: read.payload?.parse_hold }));
      assert.equal(read.parse_run_id, second.registered.parse_run_id);

      // What the person sees: the failed document's own stored reason and a
      // retryable state; the book's readiness names no host fault.
      const view = await snapshot(appliance);
      const shown = (view.documents || []).find((row) => row.id === failed.upload.documentId);
      assert.equal(shown?.parse_status, 'failed', JSON.stringify(shown));
      assert.equal(shown?.parse_error?.safe_user_message, rested.parse_error.safe_user_message);
      assert.equal(shown?.parse_error?.retry_owner, 'manual');
      const client = (view.clients || []).find((row) => row.id === clientId);
      assert.equal(client?.runtime_readiness?.effective_state, 'ready', JSON.stringify(client?.runtime_readiness));
      assert.equal(client?.runtime_readiness?.mutation_ready, true);

      // The manual retry: a new run, the old dead job settled in the same
      // transaction, its id on the retry's receipt; the new run is claimed
      // and read.
      const retried = await retryParse(appliance, failed.upload.documentId);
      assert.equal(retried.documents.length, 1, JSON.stringify(retried));
      const newRunId = retried.documents[0].parse_run_id;
      assert.notEqual(newRunId, failed.runId);
      const [oldJob] = await jobsForRun(appliance, failed.runId);
      assert.equal(oldJob.status, 'cancelled', 'the superseded run\'s dead job is settled');
      assert.match(String(oldJob.last_error), /_500/, 'its last error is kept');
      const receipts = (await appliance.read.audit({ clientId, action: 'document.parse.retry' }))
        .filter((row) => row.resource_id === failed.upload.documentId);
      assert.equal(receipts.length, 1);
      assert.equal(receipts[0].metadata.parse_run_id, newRunId);
      assert.equal(receipts[0].metadata.previous_run_id, failed.runId);
      assert.equal(receipts[0].metadata.previous_status, 'failed');
      assert.deepEqual(receipts[0].metadata.cancelled_dead_job_ids, [Number(oldJob.id)]);

      scriptOneRead(appliance);
      await parseTick(appliance);
      const [newJob] = await jobsForRun(appliance, newRunId);
      assert.equal(newJob.status, 'succeeded', newJob.last_error);
      const reread = await appliance.read.document(failed.upload.documentId);
      assert.equal(reread.parse_status, 'completed', JSON.stringify(reread.parse_error));
      assert.equal(reread.parse_run_id, newRunId);

      const settled = await certify(appliance);
      assert.equal(settled.host.status, 'PASS');
      assert.equal(settled.queue.dead, 0);
      assert.equal(settled.queue.cancelled, 1);
      appliance.providers.assertNoUnscripted();
    } finally {
      await appliance.stop();
    }
  }
);

test(
  'real PG (b): a dead parse job with no recorded outcome — its document still in flight, or its document gone — still fails the certificate and refuses new work',
  { skip: applianceHarnessSkipReason() },
  async () => {
    const appliance = await bootApplianceForTest({ keys: { openai: true, anthropic: true }, now: BOOT_NOW });
    try {
      const { clientId } = await appliance.createClient();
      const baseline = await certify(appliance);
      assert.equal(baseline.host.status, 'PASS');

      // The job died while its document still claims the run in flight (the
      // worker's terminal write never landed): lost work.
      const upload = await appliance.uploadDocument({ clientId, fixture: 'receipt_screwfix' });
      const runId = upload.registered.parse_run_id;
      await appliance.query(
        `update local_jobs set status = 'dead', attempt_count = 4, completed_at = now(), last_error = 'Unified extraction failed: openai_500'
          where function_id = $1 and dedupe_key = $2`,
        [PARSE_FN, runId]
      );
      for (const inFlight of ['pending', 'processing']) {
        await appliance.query('update documents set parse_status = $3 where firm_id = $1 and id = $2', [appliance.firmId, upload.documentId, inFlight]);
        const blocked = await certify(appliance);
        assert.equal(blocked.host.status, 'FAIL', `${inFlight}: ${JSON.stringify(blocked.queue)}`);
        assert.equal(blocked.host.reason_code, 'work_queue_needs_recovery');
        assert.equal(blocked.queue.dead_unsuperseded, 1);
        assert.equal(blocked.queue.dead_accounted_by_document, 0);
        const refused = await signUpload(appliance, clientId, 'c');
        assert.equal(refused.status, 503, refused.text);
        assert.equal(refused.json?.code, 'ENTITY_READINESS_ADMISSION_BLOCKED');
        assert.equal(refused.json?.details?.reason_code, 'work_queue_needs_recovery');
      }

      // `failed` without a typed error is not a recorded outcome either.
      await appliance.query("update documents set parse_status = 'failed', parse_error = null where firm_id = $1 and id = $2", [appliance.firmId, upload.documentId]);
      assert.equal((await certify(appliance)).host.status, 'FAIL', 'failed with no typed error does not account for the job');

      // Its document row is gone: lost work.
      await appliance.query("update documents set parse_status = 'failed', parse_error = $3::jsonb where firm_id = $1 and id = $2",
        [appliance.firmId, upload.documentId, JSON.stringify({ code: 'DOCUMENT_EXTRACTION_FAILED', reason: 'openai_500', retryable: false, retry_owner: 'manual' })]);
      assert.equal((await certify(appliance)).host.status, 'PASS', 'the typed terminal accounts for it');
      await appliance.query(
        `insert into local_jobs (function_id, payload, status, attempt_count, max_attempts, dedupe_key, completed_at, last_error)
         values ($1, $2::jsonb, 'dead', 4, 4, $3, now(), 'Unified extraction failed: openai_500')`,
        [PARSE_FN, JSON.stringify({ firm_id: appliance.firmId, document_id: `${clientId}-doc-gone`, parse_run_id: '00000000-0000-4000-8000-000000000001', client_id: clientId }), '00000000-0000-4000-8000-000000000001']
      );
      const orphan = await certify(appliance);
      assert.equal(orphan.host.status, 'FAIL');
      assert.equal(orphan.host.reason_code, 'work_queue_needs_recovery');
      assert.equal(orphan.queue.dead, 2);
      assert.equal(orphan.queue.dead_unsuperseded, 1, 'the orphan, only');
      assert.equal(orphan.queue.dead_accounted_by_document, 1);
      const refused = await signUpload(appliance, clientId, 'd');
      assert.equal(refused.status, 503, refused.text);

      // A dead job of another non-cron kind is lost work exactly as before,
      // even with every parse job accounted for.
      await appliance.query("delete from local_jobs where dedupe_key = '00000000-0000-4000-8000-000000000001'");
      assert.equal((await certify(appliance)).host.status, 'PASS');
      await appliance.query(
        `insert into local_jobs (function_id, payload, status, attempt_count, max_attempts, completed_at, last_error)
         values ('memory-projection-rebuild', '{}'::jsonb, 'dead', 4, 4, now(), 'synthetic')`
      );
      const other = await certify(appliance);
      assert.equal(other.host.status, 'FAIL');
      assert.equal(other.host.reason_code, 'work_queue_needs_recovery');
      assert.equal(other.queue.dead_unsuperseded, 1);
    } finally {
      await appliance.stop();
    }
  }
);

test(
  'real PG (c): a book the previous release left blocked — a failed document with its dead job, and a retry held at its claim — comes unblocked at the next certificate, nothing deleted, and the held retry is read',
  { skip: applianceHarnessSkipReason() },
  async () => {
    const appliance = await bootApplianceForTest({ keys: { openai: true, anthropic: true }, now: BOOT_NOW });
    try {
      const { clientId } = await appliance.createClient();
      const failed = await failForGood(appliance, clientId);
      assert.equal(failed.job.status, 'dead');
      // The previous release's retry: a new run minted while the old dead
      // job stayed dead (the old writer did not settle it), the new run's
      // claim refused and its job deferred on the host's verdict.
      const previousRunId = failed.runId;
      const heldRunId = '00000000-0000-4000-8000-0000000000aa';
      await appliance.query(
        `update documents set parse_status = 'pending', parse_run_id = $3::uuid, parse_attempts = 0, parse_error = null,
                parse_completed_at = null, parse_enqueued_at = now(), parse_event_sent_at = now(),
                payload = coalesce(payload, '{}'::jsonb) || jsonb_build_object('parse_hold', jsonb_build_object(
                  'boundary', 'parse_claim', 'reason_code', 'work_queue_needs_recovery', 'responsible_system', 'donna_readiness'))
          where firm_id = $1 and id = $2`,
        [appliance.firmId, failed.upload.documentId, heldRunId]
      );
      await appliance.query(
        `insert into local_jobs (function_id, payload, status, attempt_count, max_attempts, dedupe_key, run_at, last_error)
         values ($1, $2::jsonb, 'pending', 0, 4, $3, now() + interval '5 minutes', 'deferred: admission_refused:work_queue_needs_recovery')`,
        [PARSE_FN, JSON.stringify({ firm_id: appliance.firmId, document_id: failed.upload.documentId, parse_run_id: heldRunId, client_id: clientId, document_type: 'receipt' }), heldRunId]
      );
      const before = await appliance.query('select count(*)::int as n from local_jobs');
      const host = await certify(appliance);
      assert.equal(host.host.status, 'PASS', JSON.stringify({ reason: host.host.reason_code, queue: host.queue }));
      assert.equal(host.queue.dead, 1);
      assert.equal(host.queue.dead_accounted_by_document, 1, 'accounted for by the document\'s later run');
      assert.equal((await appliance.query('select count(*)::int as n from local_jobs')).rows[0].n, before.rows[0].n, 'nothing deleted');
      const [oldJob] = await jobsForRun(appliance, previousRunId);
      assert.equal(oldJob.status, 'dead', 'the receipt of the spent budget stays as it was');
      const signed = await signUpload(appliance, clientId, 'e');
      assert.equal(signed.status, 200, signed.text);

      // The held retry is claimed at its next recheck and read.
      scriptOneRead(appliance);
      await parseTick(appliance);
      const [held] = await jobsForRun(appliance, heldRunId);
      assert.equal(held.status, 'succeeded', held.last_error);
      const read = await appliance.read.document(failed.upload.documentId);
      assert.equal(read.parse_status, 'completed', JSON.stringify({ error: read.parse_error, hold: read.payload?.parse_hold }));
      assert.equal(read.parse_run_id, heldRunId);
    } finally {
      await appliance.stop();
    }
  }
);
