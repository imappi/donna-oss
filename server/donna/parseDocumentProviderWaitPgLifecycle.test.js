// A document whose reading failed only because the installation had no model
// provider key is read once the key is there — real PostgreSQL, on the
// appliance harness (the runtime the Electron shell and `npm run
// local:runtime` boot), nothing in the parse path mocked.
//
// What must hold (README "Run Donna locally", troubleshooting):
//   (a) provider dark → the upload WAITS: `pending`, a typed
//       payload.parse_hold naming the provider and the missing key, no
//       document attempt spent (parse_attempts 0, the job's attempt_count 0,
//       pending, never dead), no model request made, a growing recheck
//       cadence, ONE provider-wait audit; the snapshot carries the stored
//       reason and the convergence verdict names it.
//   (b) provider lit → the next recheck reads the document under the SAME
//       run id, once; a later tick reads nothing again.
//   (c) the counts are separate: waits before the key do not shorten the
//       document's own budget — a retryable document failure after the key
//       is lit still gets all four attempts.
//   (d) the neighbour: a file the provider cannot read (unreadable, then a
//       deterministic rejection) rests failed at once and is NOT retried.
//   (e) a scanned bank statement uploaded without a cloud OCR key waits the
//       same way — never `skipped / no_transactions_detected`.
//   (f) upgrade: a receipt the previous release rested `failed` on a missing
//       key, with its dead job (which kept Host A refusing every upload), is
//       re-admitted by migration 186 — new run, dead job settled — and read
//       once the key is there.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { PRESENCE_ONLY_KEY, applianceHarnessSkipReason, bootApplianceForTest } from './testSupport/applianceHarness.js';

const PARSE_FN = 'parse-document';
const BOOT_NOW = new Date('2026-08-31T09:00:00.000Z');
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
// A synthetic scanned statement with no text layer (the Finnish demo pack).
const SCANNED_STATEMENT = path.join(REPO_ROOT, 'data', 'evals', 'fixtures', 'fi-kultalanka-2025-02', 'sources', '01 OP Tiliote 02-2025.pdf');

const DARK = ['openai', 'anthropic'];

const jobsForRun = async (appliance, parseRunId) =>
  (await appliance.read.jobs({ functionId: PARSE_FN })).filter((job) => job.dedupe_key === parseRunId);

// The deferral's recheck is a wall-clock wait on the DB clock; make the parse
// job due now (one recheck window has passed) and run the parse queue alone.
const recheck = async (appliance) => {
  await appliance.query("update local_jobs set run_at = now() where function_id = $1 and status = 'pending'", [PARSE_FN]);
  return appliance.tick({ functions: [PARSE_FN], collapseWaits: false, maxRounds: 1 });
};

const lightProviders = () => {
  process.env.OPENAI_API_KEY = PRESENCE_ONLY_KEY('openai');
  process.env.ANTHROPIC_API_KEY = PRESENCE_ONLY_KEY('anthropic');
};

const scriptReceiptLanes = (appliance) => {
  appliance.providers.script('document_routing', ['document_routing/screwfix-receipt']);
  appliance.providers.script('unified_extraction', ['unified_extraction/screwfix-receipt']);
  appliance.providers.script('document_disposition', ['document_disposition/screwfix-receipt-immaterial-auto-explain']);
};

const snapshotDocument = async (appliance, documentId) => {
  const response = await appliance.api.request({
    path: `/api/donna/firms/snapshot?firm_id=${encodeURIComponent(appliance.firmId)}`,
    auth: true
  });
  assert.equal(response.status, 200, response.text);
  return (response.json.documents || []).find((row) => row.id === documentId) || null;
};

const assertWaiting = async (appliance, { documentId, runId, waits, keyName = 'OPENAI_API_KEY' }) => {
  const document = await appliance.read.document(documentId);
  assert.equal(document.parse_status, 'pending', `waits, never rests terminal: ${JSON.stringify({ parse_error: document.parse_error, summary: document.parse_summary })}`);
  assert.equal(document.parse_run_id, runId, 'the same run waits — no new run is minted');
  assert.equal(document.parse_error, null);
  assert.equal(document.parse_attempts, 0, 'a configuration wait hands the row-side attempt back');
  const hold = document.payload?.parse_hold;
  assert.equal(hold?.reason_code, 'provider_not_configured', JSON.stringify(hold));
  assert.equal(hold?.boundary, 'parse_extract');
  assert.equal(hold?.provider, 'openai');
  assert.equal(hold?.key_name, keyName);
  assert.equal(hold?.reason, 'openai_not_configured', 'the extractor\'s own stored reason is the receipt');
  assert.equal(hold?.parse_run_id, runId);
  assert.equal(hold?.waits, waits);
  const [job] = await jobsForRun(appliance, runId);
  assert.equal(job.status, 'pending', `the job waits, never dead: ${JSON.stringify(job)}`);
  assert.equal(job.attempt_count, 0, 'the deferral spends no attempt');
  assert.match(String(job.last_error), /provider_wait:provider_not_configured:openai/);
  return { document, hold, job };
};

test(
  'real PG (a)+(b): provider dark → the receipt waits with its stored reason, spends nothing; provider lit → read once under the same run, never again',
  { skip: applianceHarnessSkipReason({ dark: DARK }) },
  async () => {
    const appliance = await bootApplianceForTest({ keys: { openai: false, anthropic: false }, now: BOOT_NOW });
    try {
      const { clientId } = await appliance.createClient();
      const upload = await appliance.uploadDocument({ clientId, fixture: 'receipt_screwfix' });
      const runId = upload.registered.parse_run_id;

      await appliance.tick({ functions: [PARSE_FN], collapseWaits: false, maxRounds: 1 });
      const first = await assertWaiting(appliance, { documentId: upload.documentId, runId, waits: 1 });
      // Not at full speed: the first recheck is a minute out, not the queue's
      // immediate retry.
      const due = (await appliance.query(
        "select run_at > now() + interval '50 seconds' as later from local_jobs where id = $1", [first.job.id]
      )).rows[0];
      assert.equal(due.later, true, 'the first recheck waits about a minute');

      // Three more rechecks while dark: the waits accumulate on the hold,
      // the attempts do not.
      for (let n = 2; n <= 4; n += 1) {
        await recheck(appliance);
        await assertWaiting(appliance, { documentId: upload.documentId, runId, waits: n });
      }
      const cadence = (await appliance.query(
        "select extract(epoch from run_at - now())::int as seconds from local_jobs where id = $1", [first.job.id]
      )).rows[0].seconds;
      assert.ok(cadence > 240 && cadence <= 300, `the recheck backs off to the 300s cap: ${cadence}s`);
      assert.equal(appliance.providers.calls.length, 0, 'a missing key makes no model request');
      const waitAudits = await appliance.read.audit({ clientId, action: 'document.parse.provider_wait' });
      assert.equal(waitAudits.length, 1, 'one audit per distinct wait, not per recheck');
      assert.equal(waitAudits[0].metadata.key_name, 'OPENAI_API_KEY');
      assert.equal((await appliance.read.audit({ clientId, action: 'document.parse.failed' })).length, 0);
      assert.equal((await appliance.read.jobs({ functionId: PARSE_FN })).filter((job) => job.status === 'dead').length, 0,
        'no dead parse job — nothing for Host A to refuse uploads over');

      // What the firm view reads: the stored hold and the verdict naming it.
      const shown = await snapshotDocument(appliance, upload.documentId);
      assert.equal(shown?.parse_hold?.reason_code, 'provider_not_configured', JSON.stringify(shown));
      assert.equal(shown?.parse_hold?.key_name, 'OPENAI_API_KEY');
      assert.equal(shown?.convergence_state, 'hanging');
      assert.equal(shown?.convergence_reason, 'parse_hold:provider_not_configured');

      // The key is added (the restart's env), and the next recheck reads it.
      lightProviders();
      scriptReceiptLanes(appliance);
      await recheck(appliance);
      const [job] = await jobsForRun(appliance, runId);
      assert.equal(job.status, 'succeeded', job.last_error);
      assert.equal(job.attempt_count, 1, 'the read is the run\'s first attempt');
      const read = await appliance.read.document(upload.documentId);
      assert.equal(read.parse_status, 'completed', JSON.stringify(read.parse_error));
      assert.equal(read.parse_run_id, runId, 'read under the registered run id');
      assert.equal(read.parse_attempts, 1);
      assert.equal(read.payload?.parse_hold ?? null, null, 'the claim strips the hold');
      assert.equal(read.vendor_name, upload.fixture.expected.vendor_name);
      assert.equal(appliance.providers.callsFor('unified_extraction').length, 1);
      const completedAt = read.parse_completed_at;

      // Nothing is read twice.
      await appliance.tick();
      await appliance.tick();
      const again = await appliance.read.document(upload.documentId);
      assert.equal(again.parse_run_id, runId);
      assert.equal(String(again.parse_completed_at), String(completedAt));
      assert.equal(appliance.providers.callsFor('unified_extraction').length, 1, 'no second extraction');
      assert.equal(appliance.providers.callsFor('document_routing').length, 1, 'no second routing');
      const jobs = await appliance.read.jobs({ functionId: PARSE_FN });
      assert.equal(jobs.length, 1, `one run, one job: ${JSON.stringify(jobs)}`);
      assert.equal((await appliance.read.audit({ clientId, action: 'document.parse.completed' })).length, 1);
      appliance.providers.assertNoUnscripted();
    } finally {
      await appliance.stop();
    }
  }
);

test(
  'real PG (c): configuration waits and document attempts are counted separately — a document failure after the key is lit still gets four attempts',
  { skip: applianceHarnessSkipReason({ dark: DARK }) },
  async () => {
    const appliance = await bootApplianceForTest({ keys: { openai: false, anthropic: false }, now: BOOT_NOW });
    try {
      const { clientId } = await appliance.createClient();
      const upload = await appliance.uploadDocument({ clientId, fixture: 'receipt_screwfix' });
      const runId = upload.registered.parse_run_id;
      await appliance.tick({ functions: [PARSE_FN], collapseWaits: false, maxRounds: 1 });
      for (let n = 2; n <= 5; n += 1) await recheck(appliance);
      await assertWaiting(appliance, { documentId: upload.documentId, runId, waits: 5 });

      lightProviders();
      appliance.providers.script('document_routing', [{ recording: 'document_routing/screwfix-receipt', times: Infinity }]);
      appliance.providers.script('unified_extraction', [{ status: 429, times: Infinity }]);
      let job = null;
      for (let attempt = 0; attempt < 6 && job?.status !== 'dead'; attempt += 1) {
        await recheck(appliance);
        [job] = await jobsForRun(appliance, runId);
      }
      assert.equal(job.status, 'dead', JSON.stringify(job));
      assert.equal(job.attempt_count, 4, 'all four document attempts, none taken by the five waits');
      assert.equal(appliance.providers.callsFor('unified_extraction').length, 4);
      const document = await appliance.read.document(upload.documentId);
      assert.equal(document.parse_status, 'failed');
      assert.deepEqual(document.parse_error?.retry_exhausted, { attempts: 4, max_attempts: 4 });
      assert.equal(document.payload?.parse_hold ?? null, null);
    } finally {
      await appliance.stop();
    }
  }
);

test(
  'real PG (d): a file the provider cannot read rests failed at once and is not retried under the wait rule',
  { skip: applianceHarnessSkipReason({ dark: ['anthropic', 'typesafe'] }) },
  async () => {
    const appliance = await bootApplianceForTest({ keys: { openai: true, anthropic: false, typesafe: false }, now: BOOT_NOW });
    try {
      const { clientId } = await appliance.createClient();
      appliance.providers.script('document_routing', ['document_routing/screwfix-receipt']);
      appliance.providers.script('unified_extraction', ['unified_extraction/screwfix-receipt-unreadable-openai']);
      appliance.providers.script('receipt_extraction', [{ status: 400 }]);
      const upload = await appliance.uploadDocument({ clientId, fixture: 'receipt_screwfix' });
      await appliance.tick();
      const document = await appliance.read.document(upload.documentId);
      assert.equal(document.parse_status, 'failed', JSON.stringify(document.parse_error));
      assert.equal(document.parse_error?.code, 'DOCUMENT_EXTRACTION_REJECTED');
      assert.equal(document.parse_error?.retryable, false);
      assert.equal(document.payload?.parse_hold ?? null, null, 'a document failure is never a provider wait');
      await appliance.tick();
      await appliance.tick();
      assert.equal(appliance.providers.callsFor('unified_extraction').length, 1, 'not retried');
      assert.equal(appliance.providers.callsFor('receipt_extraction').length, 1, 'not retried');
      const jobs = await appliance.read.jobs({ functionId: PARSE_FN });
      assert.equal(jobs.length, 1);
      assert.equal(jobs[0].status, 'succeeded', 'the terminal is written; the job is done');
      assert.equal(jobs[0].attempt_count, 1);
      assert.equal((await appliance.read.audit({ clientId, action: 'document.parse.provider_wait' })).length, 0);
      appliance.providers.assertNoUnscripted();
    } finally {
      await appliance.stop();
    }
  }
);

test(
  'real PG (e): a scanned bank statement uploaded without a cloud OCR key waits on its provider — never skipped as "no transactions"',
  { skip: applianceHarnessSkipReason({ dark: DARK }) },
  async () => {
    const appliance = await bootApplianceForTest({ keys: { openai: false, anthropic: false }, now: BOOT_NOW });
    try {
      const { clientId } = await appliance.createClient();
      const upload = await appliance.uploadDocument({
        clientId,
        bytes: readFileSync(SCANNED_STATEMENT),
        filename: 'scanned-statement-2025-02.pdf',
        documentType: 'bank_statement'
      });
      const runId = upload.registered.parse_run_id;
      await appliance.tick({ functions: [PARSE_FN], collapseWaits: false, maxRounds: 1 });
      const { document } = await assertWaiting(appliance, { documentId: upload.documentId, runId, waits: 1 });
      assert.notEqual(document.parse_summary?.reason, 'no_transactions_detected');
      assert.deepEqual(await appliance.read.transactions(clientId), []);
      assert.equal(appliance.providers.calls.length, 0);
    } finally {
      await appliance.stop();
    }
  }
);

test(
  'real PG (f): upgrade — a receipt the old code rested failed on a missing key (and its dead job) is re-admitted by migration 186, read once, and Host A stops refusing uploads',
  { skip: applianceHarnessSkipReason({ dark: DARK }) },
  async () => {
    const appliance = await bootApplianceForTest({ keys: { openai: false, anthropic: false }, now: BOOT_NOW });
    try {
      const { clientId } = await appliance.createClient();
      const upload = await appliance.uploadDocument({ clientId, fixture: 'receipt_screwfix' });
      const oldRunId = upload.registered.parse_run_id;
      // The stored state the previous release left (the diagnosis record):
      // four attempts spent on `openai_not_configured`, the exhausted
      // terminal on the human, the job dead-lettered.
      await appliance.query(
        `update documents set parse_status = 'failed', parse_attempts = 4, parse_completed_at = now(),
                parse_error = $3::jsonb
          where firm_id = $1 and id = $2`,
        [appliance.firmId, upload.documentId, JSON.stringify({
          code: 'DOCUMENT_EXTRACTION_FAILED', model: 'gpt-5.4', reason: 'openai_not_configured', provider: 'openai',
          retryable: false, retry_owner: 'manual', retry_exhausted: { attempts: 4, max_attempts: 4 },
          safe_user_message: "Couldn't parse after 4 attempts; automatic retries are exhausted."
        })]
      );
      await appliance.query(
        `update local_jobs set status = 'dead', attempt_count = 4, completed_at = now(),
                last_error = 'Receipt extraction failed: openai_not_configured'
          where function_id = $1 and dedupe_key = $2`,
        [PARSE_FN, oldRunId]
      );
      await appliance.runtime.hostReadiness.renewNow();
      const blocked = await appliance.read.host();
      assert.equal(blocked.status, 'FAIL', 'the dead parse job gates the host (the old release)');
      assert.equal(blocked.reason_code, 'work_queue_needs_recovery');

      // The upgrade: migration 186, as the boot applies it.
      const migration = readFileSync(path.join(REPO_ROOT, 'db', 'migrations', '186_parse_provider_wait_readmission.sql'), 'utf8');
      await appliance.query(migration);
      const readmitted = await appliance.read.document(upload.documentId);
      assert.equal(readmitted.parse_status, 'pending');
      assert.notEqual(readmitted.parse_run_id, oldRunId, 'a new run, like a manual retry');
      assert.equal(readmitted.parse_attempts, 0, 'with its own fresh budget');
      assert.equal(readmitted.parse_error, null);
      assert.equal(readmitted.parse_event_sent_at, null, 'the outbox gives the run its job');
      const retryAudits = await appliance.read.audit({ clientId, action: 'document.parse.retry' });
      assert.equal(retryAudits.length, 1);
      assert.equal(retryAudits[0].metadata.source, 'provider_wait_readmission');
      assert.equal(retryAudits[0].metadata.previous_run_id, oldRunId);
      const [oldJob] = await jobsForRun(appliance, oldRunId);
      assert.equal(oldJob.status, 'cancelled', 'the superseded run\'s dead job is settled, visibly');
      assert.match(String(oldJob.last_error), /openai_not_configured/, 'its last error is kept');
      assert.deepEqual(retryAudits[0].metadata.cancelled_dead_job_ids, [Number(oldJob.id)]);
      // Running it again changes nothing.
      await appliance.query(migration);
      assert.equal((await appliance.read.document(upload.documentId)).parse_run_id, readmitted.parse_run_id);

      // The boot after the migrations mints a fresh certificate: nothing dead
      // is left on the queue, so the host certifies and accepts uploads again.
      await appliance.runtime.hostReadiness.renewNow();
      const host = await appliance.read.host();
      assert.equal(host.status, 'PASS', JSON.stringify({ reason: host.reason_code }));
      const signed = await appliance.api.request({
        method: 'POST',
        path: '/api/donna/firms/documents/upload-url',
        auth: true,
        body: { firm_id: appliance.firmId, client_id: clientId, filename: 'next.pdf', mime_type: 'application/pdf', size: 10, checksum_sha256: 'a'.repeat(64) }
      });
      assert.equal(signed.status, 200, signed.text);

      // The key is there; the outbox (past its 30s settle window) queues the
      // new run and the queue reads it.
      lightProviders();
      scriptReceiptLanes(appliance);
      await appliance.query("update documents set parse_enqueued_at = now() - interval '1 minute' where firm_id = $1 and id = $2", [appliance.firmId, upload.documentId]);
      await appliance.tick();
      const read = await appliance.read.document(upload.documentId);
      assert.equal(read.parse_status, 'completed', JSON.stringify(read.parse_error));
      assert.equal(read.parse_run_id, readmitted.parse_run_id);
      const newJobs = await jobsForRun(appliance, readmitted.parse_run_id);
      assert.equal(newJobs.length, 1);
      assert.equal(newJobs[0].status, 'succeeded', newJobs[0].last_error);
      assert.equal(appliance.providers.callsFor('unified_extraction').length, 1);

      await appliance.tick();
      assert.equal(appliance.providers.callsFor('unified_extraction').length, 1, 'read once');
      assert.equal((await appliance.read.document(upload.documentId)).parse_run_id, readmitted.parse_run_id);
    } finally {
      await appliance.stop();
    }
  }
);
