// Desktop local job queue — the DB layer under the local durable scheduler
// (technical plan §4; tables from migration 112). Every operation is a single
// atomic statement against a caller-supplied pg client (the proposalStore
// convention), so there are no cross-statement transaction assumptions and
// tests can drive the SQL with a mock client.
//
// Semantics:
// - at-least-once: claiming increments attempt_count BEFORE the handler runs,
//   so a crash mid-run counts the attempt when the lease expires;
// - dedupe: one ACTIVE (pending/running) job per dedupe_key, enforced by the
//   partial unique index — a duplicate enqueue returns null, never a row;
// - dead-lettering: a failure (or expired lease) with attempts exhausted
//   rests the job at 'dead'; otherwise it returns to 'pending' with the
//   caller's backoff delay.

const asJson = (value) => JSON.stringify(value === undefined ? null : value);

export const enqueueLocalJob = async ({
  client, functionId, payload = {}, dedupeKey = null, runAt = null,
  maxAttempts = 1, handlerVersion = '1'
} = {}) => {
  if (!client || !functionId) return null;
  const result = await client.query(
    `insert into local_jobs (function_id, handler_version, payload, dedupe_key, run_at, max_attempts)
     values ($1, $2, $3::jsonb, $4, coalesce($5::timestamptz, now()), $6)
     on conflict (dedupe_key)
       where dedupe_key is not null and status in ('pending', 'running')
       do nothing
     returning *`,
    [functionId, handlerVersion, asJson(payload), dedupeKey, runAt, maxAttempts]
  );
  return result.rows?.[0] || null;
};

// Claim the oldest due pending job among the eligible functions. The caller
// computes eligibility (per-function concurrency); SKIP LOCKED keeps two
// dispatchers from double-claiming, though desktop runs exactly one.
//
// DMEM-R1 W2 (INV-27, doctrine §2.6): the claim IS the dispatch linearization
// point — the one crossing from queued to running before a handler can call a
// provider — so it carries the generation-checked compare-and-swap. A caller that
// holds a view of the work passes `jobId` (claim THIS job) and
// `expectedClaimGeneration` (the local_jobs.claim_generation it observed,
// migration 146); the swap to 'running' happens only if the row still carries
// that generation. An invalidation (bumpLocalJobClaimGeneration, a correction
// that made the queued work stale) moves the generation, and a claimer holding
// the old one LOSES the claim (null) instead of dispatching stale work. Two
// claimers racing on the same generation resolve as before: SKIP LOCKED plus
// the status flip let exactly one win. Without either option the statement and
// its parameters are BYTE-IDENTICAL to the legacy claim (the scheduler's path).
export const claimNextLocalJob = async ({
  client, workerId, eligibleFunctionIds, leaseMs = 600_000, jobId = null, expectedClaimGeneration = null
} = {}) => {
  if (!client || !workerId || !eligibleFunctionIds?.length) return null;
  const fenced = jobId !== null || expectedClaimGeneration !== null;
  if (fenced && expectedClaimGeneration !== null && !(Number.isInteger(Number(expectedClaimGeneration)) && Number(expectedClaimGeneration) >= 1)) {
    throw new Error('claimNextLocalJob: expectedClaimGeneration must be a positive integer');
  }
  const params = [workerId, leaseMs, eligibleFunctionIds];
  let fence = '';
  if (jobId !== null) {
    params.push(jobId);
    fence += `\n         and id = $${params.length}::bigint`;
  }
  if (expectedClaimGeneration !== null) {
    params.push(Number(expectedClaimGeneration));
    fence += `\n         and claim_generation = $${params.length}::bigint`;
  }
  const result = await client.query(
    `update local_jobs
     set status = 'running',
         locked_by = $1,
         locked_at = now(),
         lease_expires_at = now() + make_interval(secs => $2::numeric / 1000),
         attempt_count = attempt_count + 1
     where id = (
       select id from local_jobs
       where status = 'pending' and run_at <= now()
         and function_id = any($3::text[])${fence}
       order by run_at, id
       for update skip locked
       limit 1
     )
     returning *`,
    params
  );
  return result.rows?.[0] || null;
};

// The invalidation side of the fence (DMEM-R1 W2, INV-27 / doctrine §2.6): a
// correction that makes queued work stale advances the job's claim generation so
// a claimer holding the old one loses. Only a PENDING job can be invalidated —
// a running job is already past the linearization point, and the doctrine says
// so: the caller records an in-flight conflict and reconciles or compensates,
// never claims the dispatch was cancelled. Returns the new generation, or null
// when the row is not pending (in flight, finished, or absent). No live caller
// on this tree — W4's correction spine is the first; fixtures pin it.
export const bumpLocalJobClaimGeneration = async ({ client, jobId } = {}) => {
  if (!client || jobId === null || jobId === undefined) return null;
  const result = await client.query(
    `update local_jobs
     set claim_generation = claim_generation + 1
     where id = $1::bigint and status = 'pending'
     returning id, function_id, status, claim_generation`,
    [jobId]
  );
  const row = result.rows?.[0] || null;
  return row ? { ...row, claim_generation: Number(row.claim_generation) } : null;
};

export const completeLocalJob = async ({ client, jobId, result = null } = {}) => {
  if (!client || !jobId) return null;
  const updated = await client.query(
    `update local_jobs
     set status = 'succeeded', result = $2::jsonb, completed_at = now(),
         locked_by = null, locked_at = null, lease_expires_at = null
     where id = $1 and status = 'running'
     returning *`,
    [jobId, asJson(result)]
  );
  return updated.rows?.[0] || null;
};

// Retryable failure → back to pending after the caller's backoff; attempts
// exhausted → dead. Step memoization rows are deliberately KEPT so the retry
// skips completed steps.
export const failLocalJob = async ({ client, jobId, error, retryDelayMs = 30_000 } = {}) => {
  if (!client || !jobId) return null;
  const message = String(error?.message || error || 'unknown error').slice(0, 4000);
  const updated = await client.query(
    `update local_jobs
     set status = case when attempt_count >= max_attempts then 'dead' else 'pending' end,
         run_at = case when attempt_count >= max_attempts
                       then run_at
                       else now() + make_interval(secs => $3::numeric / 1000) end,
         completed_at = case when attempt_count >= max_attempts then now() else null end,
         last_error = $2,
         locked_by = null, locked_at = null, lease_expires_at = null
     where id = $1 and status = 'running'
     returning *`,
    [jobId, message, retryDelayMs]
  );
  return updated.rows?.[0] || null;
};

// Abandoned-job recovery: a running job whose lease expired (crash, kill,
// sleep past the lease) either retries immediately or dead-letters. The
// claim-time attempt increment makes this arithmetic honest.
export const recoverAbandonedLocalJobs = async ({ client } = {}) => {
  if (!client) return [];
  const result = await client.query(
    `update local_jobs
     set status = case when attempt_count >= max_attempts then 'dead' else 'pending' end,
         completed_at = case when attempt_count >= max_attempts then now() else null end,
         last_error = 'lease expired (worker crashed or slept past lease)',
         locked_by = null, locked_at = null, lease_expires_at = null
     where status = 'running' and lease_expires_at < now()
     returning id, function_id, status`,
    []
  );
  return result.rows || [];
};

export const cancelLocalJob = async ({ client, jobId } = {}) => {
  if (!client || !jobId) return null;
  const result = await client.query(
    `update local_jobs
     set status = 'cancelled', cancelled_at = now()
     where id = $1 and status = 'pending'
     returning *`,
    [jobId]
  );
  return result.rows?.[0] || null;
};

// A handler's typed "not now" (RT-08): thrown from `run` to release the lease
// and run again at `runAt` WITHOUT spending an attempt — Inngest's
// step.sleepUntil, on the local queue. The parse worker throws it when its
// claim was refused by entity readiness (the row rests pending with its hold;
// the ENTITY is what is waiting, not this job) or when the run is still owned
// by a concurrent or zombie attempt. Neither is a failure of this job, so
// neither may burn its budget: a readiness hold that outlives four rechecks
// must not dead-letter a perfectly good document.
export class LocalJobDeferred extends Error {
  constructor({ runAt, reason } = {}) {
    const at = runAt instanceof Date ? runAt : new Date(runAt);
    if (!Number.isFinite(at.getTime())) throw new Error('LocalJobDeferred needs a valid runAt');
    super(`deferred until ${at.toISOString()}: ${reason || 'not_ready'}`);
    this.name = 'LocalJobDeferred';
    this.runAt = at;
    this.reason = String(reason || 'not_ready');
  }
}

export const isLocalJobDeferral = (error) =>
  Boolean(error)
  && (error instanceof LocalJobDeferred
    || (error.name === 'LocalJobDeferred' && error.runAt instanceof Date && Number.isFinite(error.runAt.getTime())));

// Deferral: back to pending at `runAt`, the claim-time attempt increment
// handed back (a deferral is not an attempt), the lease released. Only a
// RUNNING row can be deferred — a lease that was already recovered has
// nothing to hand back. `last_error` carries the deferral reason so a pending
// job's wait is readable from the row (there is no other free-text column;
// the dispatcher log names it too). Step memoization rows are kept.
export const deferLocalJob = async ({ client, jobId, runAt, reason = 'not_ready' } = {}) => {
  if (!client || !jobId || !runAt) return null;
  const at = (runAt instanceof Date ? runAt : new Date(runAt)).toISOString();
  const updated = await client.query(
    `update local_jobs
     set status = 'pending',
         run_at = $2::timestamptz,
         attempt_count = greatest(0, attempt_count - 1),
         last_error = $3,
         locked_by = null, locked_at = null, lease_expires_at = null
     where id = $1 and status = 'running'
     returning *`,
    [jobId, at, `deferred until ${at}: ${String(reason || 'not_ready').slice(0, 3000)}`]
  );
  return updated.rows?.[0] || null;
};

export const getLocalStepResult = async ({ client, jobId, stepKey } = {}) => {
  if (!client || !jobId || !stepKey) return { found: false, result: null };
  const result = await client.query(
    'select result from local_job_steps where job_id = $1 and step_key = $2',
    [jobId, stepKey]
  );
  if (!result.rows?.length) return { found: false, result: null };
  return { found: true, result: result.rows[0].result };
};

// Forget one memoized step (RT-08): a step whose RESULT says "could not run
// yet" (the parse claim refused by readiness, or a run still owned by another
// attempt) must be re-run by the next attempt, not replayed — the shim
// memoizes returns, and a deferral is a return. Deleting the row is what
// makes the deferred job re-claim instead of re-reading its own refusal.
export const deleteLocalStepResult = async ({ client, jobId, stepKey } = {}) => {
  if (!client || !jobId || !stepKey) return 0;
  const result = await client.query(
    'delete from local_job_steps where job_id = $1 and step_key = $2',
    [jobId, stepKey]
  );
  return result.rowCount || 0;
};

export const saveLocalStepResult = async ({ client, jobId, stepKey, result = null } = {}) => {
  if (!client || !jobId || !stepKey) return null;
  await client.query(
    `insert into local_job_steps (job_id, step_key, result)
     values ($1, $2, $3::jsonb)
     on conflict (job_id, step_key)
       do update set result = excluded.result, completed_at = now()`,
    [jobId, stepKey, asJson(result)]
  );
  return true;
};

// Retire what the manifest no longer declares (RT-14). A build that drops a
// function (the drain's desktop entry, the env-dark crons, a ledger sweep on a
// 'none' book) leaves two kinds of residue behind: the retired function's
// cron cursor, which Host A would report as `unexpected_cron_state` on every
// boot, and its pending / dead jobs, which no dispatcher will ever claim
// (claims are scoped to declared functions) and which Host A counts as
// `dead_unsuperseded` forever. Both are settled here, visibly: the cursor is
// deleted and the jobs rest 'cancelled' with the reason on the row. Succeeded
// history is untouched (retention prunes it). Only the assembly that owns
// the WHOLE manifest may call this — a dispatcher over a subset (the test
// harness) must not.
export const retireUndeclaredLocalFunctions = async ({ client, declaredFunctionIds = [] } = {}) => {
  if (!client || !declaredFunctionIds.length) return { cron_state_deleted: [], jobs_cancelled: [] };
  const cursors = await client.query(
    `delete from local_job_cron_state
      where not (function_id = any($1::text[]))
      returning function_id`,
    [declaredFunctionIds]
  );
  const jobs = await client.query(
    `update local_jobs
        set status = 'cancelled',
            cancelled_at = now(),
            last_error = concat_ws(' | ', nullif(last_error, ''), 'function retired from the desktop manifest'),
            locked_by = null, locked_at = null, lease_expires_at = null
      where status in ('pending', 'dead')
        and not (function_id = any($1::text[]))
      returning id, function_id`,
    [declaredFunctionIds]
  );
  return {
    cron_state_deleted: (cursors.rows || []).map((row) => row.function_id),
    jobs_cancelled: (jobs.rows || []).map((row) => ({ id: row.id, function_id: row.function_id }))
  };
};

// Settle a document's superseded dead parse jobs (the appliance's queue),
// inside the caller's transaction: the writer that mints the document's NEW
// parse run (parseDocumentsDb.__retryParseRunsWithClient, the manual retry)
// calls this with the new run id, and names the returned ids on its own
// `document.parse.retry` receipt — the same settlement migration 186 applies
// to its re-admissions, in SQL. A dead job of a run the document no longer
// carries is the receipt of that run's spent budget; once a new run owns the
// document it rests `cancelled`, its last_error kept. Only dead jobs of THIS
// document's OTHER runs move; the new run's own job, and every other
// function's jobs, are untouched. On a host whose queue holds no such row
// (the cloud: Inngest owns parse retries), or has no local_jobs table at
// all, this settles nothing and never fails the retry.
// 'parse-document' is desktop/parseDocumentJob.js PARSE_DOCUMENT_FUNCTION_ID
// (equality pinned in localJobQueue.test.js; importing it here would cycle).
export const settleSupersededDeadParseJobsWithClient = async ({ client, firmId, documentId, currentRunId } = {}) => {
  if (!client || !firmId || !documentId || !currentRunId) return [];
  const present = await client.query("select to_regclass('public.local_jobs') as table_name");
  if (!present.rows?.[0]?.table_name) return [];
  const result = await client.query(
    `update local_jobs
        set status = 'cancelled', cancelled_at = now(),
            locked_by = null, locked_at = null, lease_expires_at = null
      where function_id = 'parse-document'
        and status = 'dead'
        and payload->>'firm_id' = $1
        and payload->>'document_id' = $2
        and payload->>'parse_run_id' is distinct from $3
      returning id`,
    [firmId, documentId, String(currentRunId)]
  );
  return (result.rows || []).map((row) => Number(row.id)).sort((a, b) => a - b);
};

export const listLocalCronState = async ({ client } = {}) => {
  if (!client) return [];
  const result = await client.query(
    'select function_id, last_enqueued_tick from local_job_cron_state',
    []
  );
  return result.rows || [];
};

export const setLocalCronState = async ({ client, functionId, lastEnqueuedTick } = {}) => {
  if (!client || !functionId) return null;
  await client.query(
    `insert into local_job_cron_state (function_id, last_enqueued_tick, updated_at)
     values ($1, $2::timestamptz, now())
     on conflict (function_id)
       do update set last_enqueued_tick = excluded.last_enqueued_tick, updated_at = now()`,
    [functionId, lastEnqueuedTick]
  );
  return true;
};

// Retention for finished jobs; the scheduler calls this on a daily cadence.
// A client's job rows carry the client only inside payload (client_id /
// clientId): no FK, so the clients cascade never reaches them. The birth
// residue proof (entityCertificateB's special_residue) counts exactly these
// rows, in EVERY status, so a delete that leaves them bricks the next birth
// under the same deterministic id. 2026-09-08: Kampaamo Kultalanka Oy's second
// birth failed prior_client_residue:local_jobs on cold_create and both boot
// heals (31 rows of the deleted life's parse and clock jobs), exhausted, and
// every upload was refused at upload_sign. Purge in the delete transaction,
// table-presence guarded (a pre-112 deploy is a no-op), counts by status
// returned for the client.delete receipt — nothing silent. Returns null when
// the table does not exist (the purge did not apply), never a fake zero.
export const purgeLocalJobsForDeletedClient = async ({ client, clientId } = {}) => {
  if (!client || !clientId) return null;
  const present = await client.query("select to_regclass('public.local_jobs') as table_name");
  if (!present.rows?.[0]?.table_name) return null;
  const result = await client.query(
    `delete from local_jobs
      where payload->>'client_id' = $1 or payload->>'clientId' = $1
      returning status`,
    [clientId]
  );
  const byStatus = {};
  for (const row of result.rows || []) byStatus[row.status] = (byStatus[row.status] || 0) + 1;
  return { deleted: (result.rows || []).length, by_status: byStatus };
};

export const pruneFinishedLocalJobs = async ({ client, olderThanDays = 30 } = {}) => {
  if (!client) return 0;
  const result = await client.query(
    `delete from local_jobs
     where status in ('succeeded', 'dead', 'cancelled')
       and coalesce(completed_at, cancelled_at, created_at) < now() - make_interval(days => $1)`,
    [olderThanDays]
  );
  return result.rowCount || 0;
};
