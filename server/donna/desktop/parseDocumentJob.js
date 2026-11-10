// The per-document parse as a LOCAL JOB (RT-08 — docs/plan-2026-09-01-runtime-
// refactor-slices.md §5; audit F-02 proper, F-09, F-10 parse part).
//
// Before this module the appliance had no job per document: `/documents/
// register` fired an Inngest event that no bus received, the FE kicked a
// per-minute `parse-cron?task=drain` HTTP self-call sized for Vercel, and the
// worker's retry contract ("release to pending and throw for Inngest
// backoff") had no owner — a 429 ended as `failed` + "Retrying shortly" with
// nobody retrying (F-02). RT-02 contained that inside the drain; this module
// removes the shape: one `local_jobs` row per parse run, the queue's
// attempts / backoff / leases / dedupe as the retry contract, and the durable
// step shim memoizing `parse-and-write` and every post-parse leg, so a retry
// after a killed leg replays the parse from the step table and re-runs the
// leg alone — Inngest's semantics, now on the desktop.
//
// The seams, and who owns what:
//   - `requestParseRun` is the ONE producer entry point the routes call
//     (register, retry-parse, resolve-duplicate). Inngest configured (cloud)
//     ⇒ the Inngest event as before; otherwise ⇒ a `parse-document` job with
//     dedupe_key = parse_run_id. The caller stamps parse_event_sent_at as the
//     "a job exists" receipt exactly as it stamped "the event was sent".
//   - `runParseDocumentJob` is the manifest entry's `run`: the exported
//     Inngest handler (`handleParseEvent`) over the desktop durable step,
//     plus the two queue-level decisions the handler cannot make itself —
//     a refused claim DEFERS (LocalJobDeferred, no attempt spent) and a run
//     still owned by another attempt defers too; every other handled:false is
//     a completed job (a stale run has its own job).
//   - The attempt budget rides on the job (`job.attempt_count` /
//     `max_attempts`, decision D7 = 4) and is threaded into the handler so
//     the worker itself writes the honest terminal on the LAST retryable
//     failure (parseDocument.js, the exhausted-attempts branch).
//   - `dispatchQueuedParseJobsOnce` runs the parse queue to quiescence with
//     the real scheduler over this one entry — what the Gate 2A/2B proofs use
//     for the worker stage now that `?task=drain` no longer touches a row the
//     queue owns.
//
// Run-id gating is what makes a double delivery harmless (the drain backstop
// during the one-release overlap, a zombie attempt after a timeout): every
// worker write is fenced on parse_run_id, so this ships for good, no flag.

import { isInngestConfigured } from '../inngest/client.js';
import { handleParseEvent, sendParseDocumentEvent } from '../inngest/parseDocument.js';
import { queryFirmDb } from '../firmDb.js';
import { PARSE_HOLD_RECHECK_SECONDS_DEFAULT, getDocumentForParseInDb, reclaimAbandonedParseRunInDb } from '../parseDocumentsDb.js';
import { LocalJobDeferred, enqueueLocalJob } from './localJobQueue.js';
import { createLocalScheduler } from './localScheduler.js';

export const PARSE_DOCUMENT_FUNCTION_ID = 'parse-document';
export const PARSE_DOCUMENT_EVENT_NAME = 'document/parse.requested';
export const PARSE_DOCUMENT_HANDLER_VERSION = '1';
// The handler's first durable step (parseDocument.js `step.run('parse-and-write')`,
// pinned by parseDocumentJob.test.js). A deferral must forget it: the step
// RETURNED the refusal, and a memoized refusal would replay on every recheck.
export const PARSE_AND_WRITE_STEP_KEY = 'parse-and-write';
// Decision D7: four automatic attempts, then rest terminal with an honest
// message. Shared with the drain backstop (api.js) through the same knob.
export const PARSE_DOCUMENT_MAX_ATTEMPTS_DEFAULT = 4;
// The slice's desktop default; the cloud function keeps its own (8).
export const PARSE_DOCUMENT_CONCURRENCY_DEFAULT = 2;
// The extraction budget: the Inngest function's per-attempt cap (`timeout:
// '5m'`) and the Vercel maxDuration, byte for byte. A hung provider call is
// cut here; its late writes stay safe under run-id gating.
export const PARSE_DOCUMENT_TIMEOUT_MS = 5 * 60_000;
// The lease must outlive the timeout, or a slow-but-alive attempt would be
// recovered as abandoned while it still runs.
export const PARSE_DOCUMENT_LEASE_MS = 10 * 60_000;
// A run still owned by another attempt (a zombie past its timeout, or the
// drain backstop during the overlap release) is re-checked on this cadence
// — well inside the stuck-run sweep's 300s heartbeat threshold, so the job
// sees the sweep's terminal write or the zombie's release, whichever lands.
export const PARSE_JOB_OWNERSHIP_RECHECK_MS = 60_000;
// A run whose heartbeat is older than this has no live owner (the same
// threshold the stuck sweep uses, api.js `?task=stuck`). A recovered job that
// still has automatic attempts reclaims such a run — or one the sweep already
// rested `failed`/STUCK — instead of deferring until a human clicks retry.
export const PARSE_ABANDONED_HEARTBEAT_SECONDS = 300;

// A provider wait (parseErrors.providerWaitFor — no key on this installation,
// or the provider unreachable) re-checks on a growing cadence: a minute after
// the first wait, doubling, capped at the hold recheck window (300s by
// default). The wait spends no attempt, so this cadence — not the budget — is
// what keeps a dark provider from being asked at full speed.
export const PROVIDER_WAIT_FIRST_RECHECK_MS = 60_000;

const positiveInt = (raw, fallback) => {
  const n = Number(raw);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : fallback;
};

export const parseDocumentMaxAttempts = (env = process.env) =>
  positiveInt(env?.PARSE_MAX_ATTEMPTS, PARSE_DOCUMENT_MAX_ATTEMPTS_DEFAULT);

export const parseDocumentConcurrency = (env = process.env) =>
  positiveInt(env?.INNGEST_PARSE_CONCURRENCY, PARSE_DOCUMENT_CONCURRENCY_DEFAULT);

// The same recheck window the drain uses for a fresh readiness hold
// (PARSE_HOLD_RECHECK_SECONDS, default 300): a refused claim defers the job
// until the hold is stale enough to be worth re-evaluating.
export const parseHoldRecheckMs = (env = process.env) =>
  positiveInt(env?.PARSE_HOLD_RECHECK_SECONDS, PARSE_HOLD_RECHECK_SECONDS_DEFAULT) * 1000;

export const providerWaitRecheckMs = (waits, env = process.env) => {
  const n = Math.max(1, Math.floor(Number(waits) || 1));
  const cap = parseHoldRecheckMs(env);
  return Math.min(cap, PROVIDER_WAIT_FIRST_RECHECK_MS * 2 ** Math.min(n - 1, 20));
};

// The manifest declaration (handlerManifest.js spreads `run` onto it). Host
// Certificate A digests these fields, so a change here moves the digest —
// deliberately: the declaration IS the contract.
export const parseDocumentJobDeclaration = ({ env = process.env } = {}) => ({
  functionId: PARSE_DOCUMENT_FUNCTION_ID,
  kind: 'local-event',
  cron: null,
  maxAttempts: parseDocumentMaxAttempts(env),
  concurrency: parseDocumentConcurrency(env),
  leaseMs: PARSE_DOCUMENT_LEASE_MS,
  timeoutMs: PARSE_DOCUMENT_TIMEOUT_MS,
  handlerVersion: PARSE_DOCUMENT_HANDLER_VERSION
});

// The job payload is the Inngest event's `data`, key for key, so the handler
// sees one shape on both hosts.
export const parseDocumentJobPayload = ({ firmId, documentId, parseRunId, clientId = null, documentType = null } = {}) => ({
  firm_id: firmId,
  document_id: documentId,
  parse_run_id: parseRunId,
  client_id: clientId || null,
  document_type: documentType || null
});

const defaultQueueClient = () => ({ query: (text, params) => queryFirmDb(text, params) });

// One ACTIVE job per parse run: a second enqueue for the same run (a route
// retried by its caller, the outbox during the overlap) lands on the partial
// unique index and is reported as `deduped`, never as a second job.
export const enqueueParseDocumentJob = async ({
  client = null,
  firmId,
  documentId,
  parseRunId,
  clientId = null,
  documentType = null,
  env = process.env,
  enqueue = enqueueLocalJob
} = {}) => {
  if (!firmId || !documentId || !parseRunId) {
    throw new Error('enqueueParseDocumentJob requires firm_id, document_id, parse_run_id');
  }
  const job = await enqueue({
    client: client || defaultQueueClient(),
    functionId: PARSE_DOCUMENT_FUNCTION_ID,
    payload: parseDocumentJobPayload({ firmId, documentId, parseRunId, clientId, documentType }),
    dedupeKey: String(parseRunId),
    maxAttempts: parseDocumentMaxAttempts(env),
    handlerVersion: PARSE_DOCUMENT_HANDLER_VERSION
  });
  return { enqueued: Boolean(job), deduped: !job, job: job || null };
};

// The producer fork the routes call instead of sendParseDocumentEvent.
// Inngest configured (a Vercel deployment) ⇒ the event, unchanged. Not
// configured (the appliance — DONNA_DESKTOP_BLOB_DIR set — or any host without
// a bus) ⇒ the local job. Throws exactly like the send did, so the routes'
// existing "the row exists, the parse is just delayed" handling still holds.
export const requestParseRun = async ({
  firmId,
  documentId,
  parseRunId,
  clientId = null,
  documentType = null,
  client = null,
  env = process.env,
  inngestConfigured = isInngestConfigured(),
  send = sendParseDocumentEvent,
  enqueue = enqueueParseDocumentJob
} = {}) => {
  if (!firmId || !documentId || !parseRunId) {
    throw new Error('requestParseRun requires firm_id, document_id, parse_run_id');
  }
  if (inngestConfigured) {
    await send({ firmId, documentId, parseRunId, clientId, documentType });
    return { transport: 'inngest', job_id: null, deduped: false };
  }
  const result = await enqueue({ client, firmId, documentId, parseRunId, clientId, documentType, env });
  return { transport: 'local_job', job_id: result.job?.id ?? null, deduped: result.deduped === true };
};

const claimOutcomeOf = (result) => result?.claim_outcome || result?.reason || null;

// Defer this job: forget the memoized claim step first (its result IS the
// refusal we are deferring on), then hand the queue the typed "not now".
const deferParseJob = async ({ step, runAt, reason }) => {
  if (typeof step?.forget === 'function') await step.forget(PARSE_AND_WRITE_STEP_KEY);
  throw new LocalJobDeferred({ runAt, reason });
};

// The manifest entry's `run`. `job` is the claimed local_jobs row (attempt
// budget), `payload` its payload, `step` the desktop durable step shim.
export const runParseDocumentJob = async ({ step, payload, job, logger, deps = {} } = {}) => {
  const log = logger || console;
  const handle = deps.handleParseEvent || handleParseEvent;
  const readDocument = deps.getDocumentForParseInDb || getDocumentForParseInDb;
  const reclaim = deps.reclaimAbandonedParseRunInDb || reclaimAbandonedParseRunInDb;
  const now = deps.now || (() => new Date());
  const env = deps.env || process.env;
  const data = payload && typeof payload === 'object' ? payload : {};
  const firmId = data.firm_id;
  const documentId = data.document_id;
  const parseRunId = data.parse_run_id;
  if (!firmId || !documentId || !parseRunId) {
    // Our own enqueue wrote this payload; a missing key is a code bug. Fail
    // the job (it dead-letters visibly with this message) rather than
    // pretend a parse happened.
    throw new Error(`parse-document job #${job?.id ?? '?'} payload is missing firm_id/document_id/parse_run_id`);
  }
  const attempt = {
    count: Number(job?.attempt_count) || 0,
    max: positiveInt(job?.max_attempts, parseDocumentMaxAttempts(env))
  };
  const result = await handle({
    event: {
      id: String(parseRunId),
      name: PARSE_DOCUMENT_EVENT_NAME,
      data: parseDocumentJobPayload({
        firmId, documentId, parseRunId, clientId: data.client_id, documentType: data.document_type
      })
    },
    step,
    logger: log,
    attempt
  });
  if (result?.handled === false) {
    const outcome = claimOutcomeOf(result);
    if (outcome === 'admission_refused') {
      // The claim wrote payload.parse_hold on every pending row of the
      // entity (RT-02); the ENTITY is what is waiting. The job waits with it
      // — no attempt spent — and re-checks when the hold is stale.
      const reason = result.reason_code || result.hold?.reason_code || 'entity_readiness_not_ready';
      await deferParseJob({
        step,
        runAt: new Date(now().getTime() + parseHoldRecheckMs(env)),
        reason: `admission_refused:${reason}`
      });
    }
    if (outcome === 'provider_wait') {
      // The worker released the run with a typed provider hold on the row
      // (its persisted reason) and handed back the row-side attempt. The job
      // waits with it — no attempt spent here either — so a missing key never
      // dead-letters a document, and the next recheck that finds the
      // provider answering reads it under the same run id.
      const hold = result.hold || {};
      await deferParseJob({
        step,
        runAt: new Date(now().getTime() + providerWaitRecheckMs(hold.waits, env)),
        reason: `provider_wait:${hold.reason_code || 'provider_unavailable'}:${hold.provider || 'unknown'}`
      });
    }
    if (outcome === 'not_pending') {
      // Same run id, row not claimable: either a terminal writer already
      // finished this run (the job is done) or another attempt still owns
      // it — a zombie past its timeout, or the drain backstop. Read the row
      // rather than guess, and defer while someone else holds it.
      const row = await readDocument({ firmId, documentId });
      const sameRun = row && String(row.parse_run_id || '') === String(parseRunId);
      const abandoned = sameRun && (
        row.parse_status === 'failed' && row.parse_error?.code === 'STUCK'
        || row.parse_status === 'processing' && row.parse_heartbeat_at
          && (now().getTime() - new Date(row.parse_heartbeat_at).getTime()) >= PARSE_ABANDONED_HEARTBEAT_SECONDS * 1000
      );
      // The queue increments attempt_count at CLAIM, so `attempt.count` is the
      // number of the attempt running NOW — never "attempts already spent".
      // The last automatic attempt (count === max) is still an attempt: it
      // must reclaim too, or three crashes would rest the document on a manual
      // click with the fourth attempt unused (`<` did exactly that, 2026-09-13).
      // The cap holds elsewhere: a crash ON the last attempt dead-letters the
      // job in lease recovery (attempt_count >= max_attempts), and a retryable
      // failure on it writes the honest terminal (parseDocument.js,
      // attemptsExhausted).
      if (abandoned && attempt.count <= attempt.max) {
        // Crash recovery (2026-09-12): this job's earlier attempt died with
        // the run claimed. The lease sweep handed the job back; the run is
        // reclaimed to pending under the same run id (receipted) and the job
        // re-claims on its next round — the deferral hands the claim-time
        // increment back, so the re-claim runs as the same attempt number.
        const reclaimed = await reclaim({ firmId, documentId, parseRunId, staleAfterSeconds: PARSE_ABANDONED_HEARTBEAT_SECONDS, attempt });
        if (reclaimed) {
          log.warn?.('parse-document: reclaimed an abandoned run for the recovered job', {
            documentId, parseRunId, previous_status: row.parse_status, attempts: attempt.count, max_attempts: attempt.max
          });
          await deferParseJob({ step, runAt: now(), reason: `reclaimed_abandoned_run:${row.parse_status}` });
        }
      }
      if (sameRun && (row.parse_status === 'processing' || row.parse_status === 'pending')) {
        await deferParseJob({
          step,
          runAt: new Date(now().getTime() + PARSE_JOB_OWNERSHIP_RECHECK_MS),
          reason: `run_owned_elsewhere:${row.parse_status}`
        });
      }
      return { ...result, parse_status: row?.parse_status || null };
    }
    // stale_run: a newer manual retry minted a different run id, which has
    // its own job. This job is finished.
  }
  return result;
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Run the parse queue to quiescence, once, with the real scheduler over this
// one entry (same queue tables, same durable step, same handler). Used by the
// Gate 2A/2B proofs' worker stage; not by the runtime, whose scheduler
// dispatches the same entry from the desktop manifest. Backed-off and
// deferred jobs are left waiting — this dispatches what is DUE.
export const dispatchQueuedParseJobsOnce = async ({
  client = null,
  logger = console,
  workerId = `parse-dispatch-${process.pid}`,
  maxRounds = 25,
  settleTimeoutMs = 180_000,
  env = process.env
} = {}) => {
  const queueClient = client || defaultQueueClient();
  const settled = [];
  const dispatcher = createLocalScheduler({
    manifest: [{ ...parseDocumentJobDeclaration({ env }), run: runParseDocumentJob }],
    client: queueClient,
    logger,
    workerId,
    pollIntervalMs: 60 * 60_000,
    onQueueActivity: async (activity) => {
      if (activity?.kind === 'job_settled') settled.push(activity);
    }
  });
  await dispatcher.initialize();
  const startedAt = Date.now();
  let rounds = 0;
  try {
    while (rounds < maxRounds) {
      rounds += 1;
      await dispatcher.tickOnce();
      while (dispatcher.inFlightCount() > 0) {
        if (Date.now() - startedAt > settleTimeoutMs) {
          throw new Error(`dispatchQueuedParseJobsOnce did not settle within ${settleTimeoutMs}ms (${dispatcher.inFlightCount()} in flight)`);
        }
        await sleep(20);
      }
      const due = await queueClient.query(
        `select count(*)::int as due from local_jobs
          where function_id = $1 and status = 'pending' and run_at <= now()`,
        [PARSE_DOCUMENT_FUNCTION_ID]
      );
      if (Number(due.rows?.[0]?.due || 0) === 0) break;
    }
  } finally {
    await dispatcher.stop();
  }
  return { function_id: PARSE_DOCUMENT_FUNCTION_ID, rounds, settled };
};
