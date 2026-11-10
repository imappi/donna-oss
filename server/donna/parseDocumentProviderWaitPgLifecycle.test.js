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
//   (g) no credit on the account (Anthropic 400 "credit balance is too low",
//       OpenAI 429 `insufficient_quota`) waits the same way, with its own
//       stored reason; a plain 429 rate limit stays a document attempt.
//   (h) a key the provider refuses (401) waits until the key is fixed.
//   (i) a scanned statement whose OCR account has no credit waits too.
//   (f) upgrade: a receipt the previous release rested `failed` on a missing
//       key, with its dead job (which kept Host A refusing every upload), is
//       re-admitted by migration 186 — new run, dead job settled — and read
//       once the key is there. (The dead job no longer gates the host: its
//       document's recorded outcome accounts for it.)

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

// No key at all: every document lane resolves Anthropic first (the owner's
// decision of 2026-11-10), so the wait names the Anthropic key — the one
// this installation is meant to hold.
const assertWaiting = async (appliance, { documentId, runId, waits, provider = 'anthropic', keyName = 'ANTHROPIC_API_KEY' }) => {
  const document = await appliance.read.document(documentId);
  assert.equal(document.parse_status, 'pending', `waits, never rests terminal: ${JSON.stringify({ parse_error: document.parse_error, summary: document.parse_summary })}`);
  assert.equal(document.parse_run_id, runId, 'the same run waits — no new run is minted');
  assert.equal(document.parse_error, null);
  assert.equal(document.parse_attempts, 0, 'a configuration wait hands the row-side attempt back');
  const hold = document.payload?.parse_hold;
  assert.equal(hold?.reason_code, 'provider_not_configured', JSON.stringify(hold));
  assert.equal(hold?.boundary, 'parse_extract');
  assert.equal(hold?.provider, provider);
  assert.equal(hold?.key_name, keyName);
  assert.equal(hold?.reason, `${provider}_not_configured`, 'the extractor\'s own stored reason is the receipt');
  assert.equal(hold?.parse_run_id, runId);
  assert.equal(hold?.waits, waits);
  const [job] = await jobsForRun(appliance, runId);
  assert.equal(job.status, 'pending', `the job waits, never dead: ${JSON.stringify(job)}`);
  assert.equal(job.attempt_count, 0, 'the deferral spends no attempt');
  assert.match(String(job.last_error), new RegExp(`provider_wait:provider_not_configured:${provider}`));
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
      assert.equal(waitAudits[0].metadata.key_name, 'ANTHROPIC_API_KEY');
      assert.equal((await appliance.read.audit({ clientId, action: 'document.parse.failed' })).length, 0);
      assert.equal((await appliance.read.jobs({ functionId: PARSE_FN })).filter((job) => job.status === 'dead').length, 0,
        'no dead parse job — nothing for Host A to refuse uploads over');

      // What the firm view reads: the stored hold and the verdict naming it.
      const shown = await snapshotDocument(appliance, upload.documentId);
      assert.equal(shown?.parse_hold?.reason_code, 'provider_not_configured', JSON.stringify(shown));
      assert.equal(shown?.parse_hold?.key_name, 'ANTHROPIC_API_KEY');
      assert.equal(shown?.convergence_state, 'hanging');
      assert.equal(shown?.convergence_reason, 'parse_hold:provider_not_configured');

      // The Anthropic key is added (the restart's env), and the next recheck
      // reads it, on Anthropic.
      process.env.ANTHROPIC_API_KEY = PRESENCE_ONLY_KEY('anthropic');
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
      assert.deepEqual(appliance.providers.calls.map((call) => call.endpoint_class).filter((cls) => cls !== 'anthropic'), [],
        'read on the key that was added');
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
      // A content rejection: a 400 whose error body names the file, not
      // credit or billing.
      appliance.providers.script('receipt_extraction', [{
        status: 400,
        body: { error: { type: 'invalid_request_error', code: 'invalid_image', message: 'The image data you provided does not represent a valid image.' } }
      }]);
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
  'real PG (e2): a Claude-only host whose statement knob holds a gpt id waits on the OpenAI key, and the wait names the knob that caused it',
  { skip: applianceHarnessSkipReason({ dark: ['openai'] }) },
  async () => {
    const appliance = await bootApplianceForTest({ keys: { openai: false, anthropic: true, typesafe: false }, env: { OPENAI_VISION_MODEL: 'gpt-5.4' }, now: BOOT_NOW });
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
      const { hold } = await assertWaiting(appliance, { documentId: upload.documentId, runId, waits: 1, provider: 'openai', keyName: 'OPENAI_API_KEY' });
      assert.equal(hold.pinned_by, 'OPENAI_VISION_MODEL=gpt-5.4');
      assert.match(hold.message, /OPENAI_API_KEY is not set, and OPENAI_VISION_MODEL=gpt-5\.4 pins this lane to openai/);
      assert.equal(appliance.providers.callsFor('bank_statement_extraction').length, 0);
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
      // Two more rows the old release rested: one after four 429s (an empty
      // account was stored exactly like a rate limit) — re-admitted; one the
      // provider rejected for its content — left alone.
      const legacyRow = async (suffix, parseError) => {
        const other = await appliance.uploadDocument({
          clientId,
          bytes: Buffer.concat([readFileSync(path.join(REPO_ROOT, 'server', 'donna', 'fixtures', 'appliance', 'screwfix-receipt-2026-08-22.pdf')), Buffer.from(`\n% ${suffix}\n`)]),
          filename: `${suffix}.pdf`,
          documentType: 'receipt'
        });
        await appliance.query(
          `update documents set parse_status = 'failed', parse_attempts = 4, parse_completed_at = now(), parse_error = $3::jsonb
            where firm_id = $1 and id = $2`,
          [appliance.firmId, other.documentId, JSON.stringify(parseError)]
        );
        await appliance.query("update local_jobs set status = 'cancelled' where function_id = $1 and dedupe_key = $2", [PARSE_FN, other.registered.parse_run_id]);
        return other;
      };
      const quotaRow = await legacyRow('legacy-429', {
        code: 'DOCUMENT_EXTRACTION_FAILED', reason: 'openai_429', provider: 'openai', retryable: false, retry_owner: 'manual',
        retry_exhausted: { attempts: 4, max_attempts: 4 }
      });
      const rejectedRow = await legacyRow('legacy-rejected', {
        code: 'DOCUMENT_EXTRACTION_REJECTED', reason: 'openai_400', provider: 'openai', retryable: false
      });

      // The old release's Host A read this dead job as lost work and refused
      // every upload (work_queue_needs_recovery). Its document already records
      // the run's final outcome (failed, typed error), so the work-queue rule
      // now accounts for it by that outcome — the host certifies before the
      // migration runs (parseDocumentDeadJobPgLifecycle.test.js is the proof);
      // the job stays dead, visibly, until the re-admission settles it.
      await appliance.runtime.hostReadiness.renewNow();
      const before = await appliance.read.host();
      assert.equal(before.status, 'PASS', JSON.stringify({ reason: before.reason_code }));
      const beforeQueue = before.certificate.checks.find((entry) => entry.id === 'database_schema').detail.queue;
      assert.equal(beforeQueue.dead, 1);
      assert.equal(beforeQueue.dead_accounted_by_document, 1);

      // The upgrade: migration 186, as the boot applies it.
      const migration = readFileSync(path.join(REPO_ROOT, 'db', 'migrations', '186_parse_provider_wait_readmission.sql'), 'utf8');
      await appliance.query(migration);
      const readmitted = await appliance.read.document(upload.documentId);
      assert.equal(readmitted.parse_status, 'pending');
      assert.notEqual(readmitted.parse_run_id, oldRunId, 'a new run, like a manual retry');
      assert.equal(readmitted.parse_attempts, 0, 'with its own fresh budget');
      assert.equal(readmitted.parse_error, null);
      assert.equal(readmitted.parse_event_sent_at, null, 'the outbox gives the run its job');
      const retryAudits = (await appliance.read.audit({ clientId, action: 'document.parse.retry' }))
        .filter((row) => row.resource_id === upload.documentId);
      assert.equal(retryAudits.length, 1);
      assert.equal(retryAudits[0].metadata.source, 'provider_wait_readmission');
      assert.equal(retryAudits[0].metadata.previous_run_id, oldRunId);
      const [oldJob] = await jobsForRun(appliance, oldRunId);
      assert.equal(oldJob.status, 'cancelled', 'the superseded run\'s dead job is settled, visibly');
      assert.match(String(oldJob.last_error), /openai_not_configured/, 'its last error is kept');
      assert.deepEqual(retryAudits[0].metadata.cancelled_dead_job_ids, [Number(oldJob.id)]);
      const quotaReadmitted = await appliance.read.document(quotaRow.documentId);
      assert.equal(quotaReadmitted.parse_status, 'pending', 'four 429s: re-admitted once');
      assert.notEqual(quotaReadmitted.parse_run_id, quotaRow.registered.parse_run_id);
      const rejectedKept = await appliance.read.document(rejectedRow.documentId);
      assert.equal(rejectedKept.parse_status, 'failed', 'a content rejection is the document\'s own: left alone');
      assert.equal(rejectedKept.parse_run_id, rejectedRow.registered.parse_run_id);
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
      // Two re-admitted documents, each read once.
      appliance.providers.script('document_routing', [{ recording: 'document_routing/screwfix-receipt', times: 2 }]);
      appliance.providers.script('unified_extraction', [{ recording: 'unified_extraction/screwfix-receipt', times: 2 }]);
      appliance.providers.script('document_disposition', [{ recording: 'document_disposition/screwfix-receipt-immaterial-auto-explain', times: 2 }]);
      await appliance.query("update documents set parse_enqueued_at = now() - interval '1 minute' where firm_id = $1 and id = any($2::text[])", [appliance.firmId, [upload.documentId, quotaRow.documentId]]);
      await appliance.tick();
      const read = await appliance.read.document(upload.documentId);
      assert.equal(read.parse_status, 'completed', JSON.stringify(read.parse_error));
      assert.equal(read.parse_run_id, readmitted.parse_run_id);
      const newJobs = await jobsForRun(appliance, readmitted.parse_run_id);
      assert.equal(newJobs.length, 1);
      assert.equal(newJobs[0].status, 'succeeded', newJobs[0].last_error);
      const quotaRead = await appliance.read.document(quotaRow.documentId);
      assert.equal(quotaRead.parse_status, 'completed', JSON.stringify(quotaRead.parse_error));
      assert.equal(appliance.providers.callsFor('unified_extraction').length, 2, 'one read per re-admitted document');
      assert.equal((await appliance.read.document(rejectedRow.documentId)).parse_status, 'failed');

      await appliance.tick();
      assert.equal(appliance.providers.callsFor('unified_extraction').length, 2, 'each read once');
      assert.equal((await appliance.read.document(upload.documentId)).parse_run_id, readmitted.parse_run_id);
    } finally {
      await appliance.stop();
    }
  }
);

const ANTHROPIC_NO_CREDIT = {
  status: 400,
  body: { type: 'error', error: { type: 'invalid_request_error', message: 'Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.' } }
};
const OPENAI_NO_CREDIT = {
  status: 429,
  body: { error: { message: 'You exceeded your current quota, please check your plan and billing details.', type: 'insufficient_quota', code: 'insufficient_quota' } }
};
const UNAUTHORIZED = (provider) => ({
  status: 401,
  body: provider === 'anthropic'
    ? { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }
    : { error: { message: 'Incorrect API key provided.', type: 'invalid_request_error', code: 'invalid_api_key' } }
});

const holdOf = async (appliance, documentId) => (await appliance.read.document(documentId)).payload?.parse_hold || null;

test(
  'real PG (g): an account with no credit is a provider wait with its own reason, for either provider; a plain rate limit stays a document attempt',
  { skip: applianceHarnessSkipReason() },
  async () => {
    // Anthropic (both keys: the unified extractor rides Anthropic).
    const appliance = await bootApplianceForTest({ now: BOOT_NOW });
    try {
      const { clientId } = await appliance.createClient();
      appliance.providers.script('document_routing', [{ recording: 'document_routing/screwfix-receipt', times: Infinity }]);
      appliance.providers.script('unified_extraction', [{ ...ANTHROPIC_NO_CREDIT, times: 2 }, 'unified_extraction/screwfix-receipt']);
      appliance.providers.script('document_disposition', ['document_disposition/screwfix-receipt-immaterial-auto-explain']);
      const upload = await appliance.uploadDocument({ clientId, fixture: 'receipt_screwfix' });
      const runId = upload.registered.parse_run_id;
      await appliance.tick({ functions: [PARSE_FN], collapseWaits: false, maxRounds: 1 });
      let document = await appliance.read.document(upload.documentId);
      assert.equal(document.parse_status, 'pending', JSON.stringify(document.parse_error));
      let hold = document.payload?.parse_hold;
      assert.equal(hold?.reason_code, 'provider_no_credit', JSON.stringify(hold));
      assert.equal(hold?.provider, 'anthropic', 'the provider is read from the failure record');
      assert.equal(hold?.reason, 'anthropic_no_credit');
      assert.equal(hold?.key_name, null, 'the key is fine; the account is empty');
      assert.equal(document.parse_attempts, 0);
      const [job] = await jobsForRun(appliance, runId);
      assert.equal(job.attempt_count, 0);
      assert.match(String(job.last_error), /provider_wait:provider_no_credit:anthropic/);
      await recheck(appliance);
      assert.equal((await holdOf(appliance, upload.documentId))?.waits, 2);
      // Credit is added: the next recheck reads it, once, under the same run.
      await recheck(appliance);
      document = await appliance.read.document(upload.documentId);
      assert.equal(document.parse_status, 'completed', JSON.stringify(document.parse_error));
      assert.equal(document.parse_run_id, runId);
      assert.equal(document.parse_attempts, 1);
      assert.equal(appliance.providers.callsFor('unified_extraction').length, 3, 'two empty-account answers, one read');
      assert.equal(appliance.providers.callsFor('receipt_extraction').length, 0, 'no fall-through to a second extractor');
    } finally {
      await appliance.stop();
    }

    // OpenAI's form of the same fault (an OpenAI-only host), next to a plain
    // rate limit on the same lane.
    const openai = await bootApplianceForTest({ keys: { openai: true, anthropic: false, typesafe: false }, now: BOOT_NOW });
    try {
      const { clientId } = await openai.createClient();
      openai.providers.script('document_routing', [{ recording: 'document_routing/screwfix-receipt', times: Infinity }]);
      openai.providers.script('unified_extraction', [OPENAI_NO_CREDIT]);
      const quota = await openai.uploadDocument({ clientId, fixture: 'receipt_screwfix' });
      await openai.tick({ functions: [PARSE_FN], collapseWaits: false, maxRounds: 1 });
      const hold = await holdOf(openai, quota.documentId);
      assert.equal(hold?.reason_code, 'provider_no_credit', JSON.stringify(hold));
      assert.equal(hold?.provider, 'openai');
      assert.equal((await jobsForRun(openai, quota.registered.parse_run_id))[0].attempt_count, 0);

      openai.providers.script('unified_extraction', [{
        status: 429,
        body: { error: { message: 'Rate limit reached for requests', type: 'requests', code: 'rate_limit_exceeded' } }
      }]);
      const limited = await openai.uploadDocument({ clientId, bytes: Buffer.from(upload_bytes_marker(quota)), filename: 'rate-limited-receipt.pdf', documentType: 'receipt' });
      await openai.tick({ functions: [PARSE_FN], collapseWaits: false, maxRounds: 1 });
      const limitedDocument = await openai.read.document(limited.documentId);
      assert.equal(limitedDocument.payload?.parse_hold ?? null, null, 'a rate limit is not a provider wait');
      const [limitedJob] = await jobsForRun(openai, limited.registered.parse_run_id);
      assert.equal(limitedJob.status, 'pending');
      assert.equal(limitedJob.attempt_count, 1, 'a rate limit spends a document attempt, as before');
      assert.doesNotMatch(String(limitedJob.last_error), /provider_wait/);
    } finally {
      await openai.stop();
    }
  }
);

// A second, distinct PDF for the rate-limit row (the same bytes would be a
// duplicate of the first upload).
const upload_bytes_marker = (upload) => Buffer.concat([readFileSync(path.join(REPO_ROOT, 'server', 'donna', 'fixtures', 'appliance', 'screwfix-receipt-2026-08-22.pdf')), Buffer.from(`\n% ${upload.documentId}\n`)]);

test(
  'real PG (h): a key the provider refuses (401) is a provider wait naming the key; fixed, the document is read once',
  { skip: applianceHarnessSkipReason() },
  async () => {
    const appliance = await bootApplianceForTest({ now: BOOT_NOW });
    try {
      const { clientId } = await appliance.createClient();
      appliance.providers.script('document_routing', [{ recording: 'document_routing/screwfix-receipt', times: Infinity }]);
      // Both lanes refuse the key: the unified read is final and falls
      // through to the receipt extractor, which (both keys lit) also resolves
      // Anthropic first since 2026-11-10 and is refused too. The stored
      // reason names the last lane that refused.
      appliance.providers.script('unified_extraction', [UNAUTHORIZED('anthropic'), 'unified_extraction/screwfix-receipt']);
      appliance.providers.script('receipt_extraction', [UNAUTHORIZED('anthropic')]);
      appliance.providers.script('document_disposition', ['document_disposition/screwfix-receipt-immaterial-auto-explain']);
      const upload = await appliance.uploadDocument({ clientId, fixture: 'receipt_screwfix' });
      const runId = upload.registered.parse_run_id;
      await appliance.tick({ functions: [PARSE_FN], collapseWaits: false, maxRounds: 1 });
      const document = await appliance.read.document(upload.documentId);
      assert.equal(document.parse_status, 'pending', `a refused key no longer rests terminal: ${JSON.stringify(document.parse_error)}`);
      const hold = document.payload?.parse_hold;
      assert.equal(hold?.reason_code, 'provider_unauthorized', JSON.stringify(hold));
      assert.equal(hold?.code, 'DOCUMENT_EXTRACTION_UNAUTHORIZED');
      assert.equal(hold?.provider, 'anthropic');
      assert.equal(hold?.key_name, 'ANTHROPIC_API_KEY');
      assert.equal(document.parse_attempts, 0);
      const [job] = await jobsForRun(appliance, runId);
      assert.equal(job.status, 'pending');
      assert.equal(job.attempt_count, 0);
      const shown = await snapshotDocument(appliance, upload.documentId);
      assert.equal(shown?.convergence_reason, 'parse_hold:provider_unauthorized');

      // The key is fixed: read once under the same run.
      await recheck(appliance);
      const read = await appliance.read.document(upload.documentId);
      assert.equal(read.parse_status, 'completed', JSON.stringify(read.parse_error));
      assert.equal(read.parse_run_id, runId);
      await appliance.tick();
      assert.equal(appliance.providers.callsFor('unified_extraction').length, 2);
      assert.equal(appliance.providers.callsFor('receipt_extraction').length, 1);
      assert.equal((await appliance.read.jobs({ functionId: PARSE_FN })).length, 1);
    } finally {
      await appliance.stop();
    }
  }
);

test(
  'real PG (i): a scanned statement whose OCR account has no credit waits on its provider — never skipped as "no transactions"',
  { skip: applianceHarnessSkipReason({ dark: ['anthropic', 'typesafe'] }) },
  async () => {
    const appliance = await bootApplianceForTest({ keys: { openai: true, anthropic: false, typesafe: false }, now: BOOT_NOW });
    try {
      const { clientId } = await appliance.createClient();
      appliance.providers.script('document_routing', [{ ...OPENAI_NO_CREDIT, times: Infinity }]);
      appliance.providers.script('bank_statement_extraction', [{ ...OPENAI_NO_CREDIT, times: Infinity }]);
      const upload = await appliance.uploadDocument({
        clientId,
        bytes: readFileSync(SCANNED_STATEMENT),
        filename: 'scanned-statement-2025-02.pdf',
        documentType: 'bank_statement'
      });
      await appliance.tick({ functions: [PARSE_FN], collapseWaits: false, maxRounds: 1 });
      const document = await appliance.read.document(upload.documentId);
      assert.equal(document.parse_status, 'pending', JSON.stringify({ summary: document.parse_summary, error: document.parse_error }));
      const hold = document.payload?.parse_hold;
      assert.equal(hold?.reason_code, 'provider_no_credit', JSON.stringify(hold));
      assert.equal(hold?.provider, 'openai');
      assert.equal(document.parse_attempts, 0);
      assert.equal(appliance.providers.callsFor('bank_statement_extraction').length, 1, 'the plain-OCR fallback is not tried against the same empty account');
      assert.deepEqual(await appliance.read.transactions(clientId), []);
    } finally {
      await appliance.stop();
    }
  }
);
