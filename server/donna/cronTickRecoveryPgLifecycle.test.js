// A dead scheduled tick is recovered promptly — real PostgreSQL, on the
// appliance harness (the runtime the Electron shell and `npm run
// local:runtime` boot): the real queue, the real scheduler over the real
// manifest entry, the real Host Certificate A and the real admission fence.
//
// The diagnosis (stored state, before this change): `desktop-backup-daily`
// (cron `30 1 * * *`, two attempts) whose run throws on both attempts rests
// `dead`. Host A's work-queue rule counts a dead cron tick as
// `dead_unsuperseded` until a LATER success of the same function, so
// `database_schema` read FAIL (work_queue_needs_recovery) and every enrolled
// book refused its mutations — upload-url 503 ENTITY_READINESS_ADMISSION_BLOCKED,
// the journal writer the same — until the next 01:30 slot succeeded: a
// day. Nothing re-ran the function sooner. Queue-recovery mode kept the
// scheduler running and re-observed the host on every settled job, but the
// only job that could settle was the next scheduled one; there was no
// operator action and no boot sweep for a dead tick.
//
// What must hold now (localJobQueue.js, "Prompt recovery of a dead scheduled
// tick"):
//   (a) a daily tick dies → the host fails and NAMES the function, when it
//       died and the next attempt; a recovery tick is enqueued due exactly
//       CRON_RECOVERY_DELAYS_MS[0] after the death, naming the dead job; it
//       succeeds → the existing supersede rule clears the failure and the
//       host passes, with the compatibility digest unchanged throughout;
//   (b) recovery exhausted → no further recovery, the host stays failed and
//       names the next SCHEDULED run; that slot still runs and clears it;
//   (c) never two live ticks: a scheduled slot arriving during a pending
//       recovery is served by it; during a running one it waits; two
//       dispatchers racing and a restart in the middle plan one recovery;
//   (d) sleep: the clock jumps past every recovery delay; one recovery runs.

import assert from 'node:assert/strict';
import test from 'node:test';

import { createLocalScheduler } from './desktop/localScheduler.js';
import { CRON_RECOVERY_DELAYS_MS, CRON_RECOVERY_MAX_TICKS, enqueueCronRecoveryTicks } from './desktop/localJobQueue.js';
import { nextCronOccurrence } from './desktop/cronSchedule.js';
import { __writeLedgerJournalRows } from './db/ledger.js';
import { queryFirmDb, withFirmDbClient } from './firmDb.js';
import { applianceHarnessSkipReason, bootApplianceForTest } from './testSupport/applianceHarness.js';

const FN = 'desktop-backup-daily';
const BOOT_NOW = new Date('2026-08-31T01:00:00.000Z');
const SLOT = '2026-08-31T01:30:00.000Z';
const NEXT_SLOT = '2026-09-01T01:30:00.000Z';
const queueClient = { query: (text, params) => queryFirmDb(text, params) };
const silent = { log: () => {}, warn: () => {}, error: () => {} };

// The backup cannot run while its configuration points at a target (this
// harness's DATABASE_URL is TCP, the backup demands the appliance socket):
// the real handler throws on every attempt. Clearing the configuration lets
// the same handler return its configured-skip receipt — a succeeded run.
const BACKUP_FAILING_ENV = { DONNA_DESKTOP_BACKUP_DIR: '/nonexistent/synthetic-backup-target' };
const clearBackupFailure = () => { delete process.env.DONNA_DESKTOP_BACKUP_DIR; };

const boot = () => bootApplianceForTest({ keys: { openai: true, anthropic: true }, now: BOOT_NOW, env: BACKUP_FAILING_ENV });

const fnJobs = async (appliance) => (await appliance.query(
  `select id, status, attempt_count, max_attempts, run_at, completed_at, created_at, dedupe_key, payload, last_error
     from local_jobs where function_id = $1 order by id`, [FN]
)).rows;
const liveCount = async (appliance) => (await appliance.query(
  "select count(*)::int as n from local_jobs where function_id = $1 and status in ('pending', 'running')", [FN]
)).rows[0].n;

const certify = async (appliance) => {
  await appliance.runtime.hostReadiness.renewNow();
  const host = await appliance.read.host();
  const database = host.certificate?.checks?.find((entry) => entry.id === 'database_schema');
  return { host, database, queue: database?.detail?.queue || {}, failures: database?.detail?.queue_failures || [] };
};

const signUpload = (appliance, clientId, seed) => appliance.api.request({
  method: 'POST',
  path: '/api/donna/firms/documents/upload-url',
  auth: true,
  body: { firm_id: appliance.firmId, client_id: clientId, filename: `${seed}.pdf`, mime_type: 'application/pdf', size: 10, checksum_sha256: seed.repeat(64).slice(0, 64) }
});

// A posting reaches the journal writer every posting path shares
// (post-transaction, the auto-post sweep, document settlement); its first
// act is the entity admission decision. The journal itself never lands here.
const attemptPosting = (appliance, clientId) => withFirmDbClient(async (client) => {
  await client.query('begin');
  try {
    await __writeLedgerJournalRows({
      client, firmId: appliance.firmId, clientId, actorId: 'synthetic-poster',
      journal: { source_type: 'transaction', source_id: `${clientId}-synthetic-tx`, journal_date: '2026-08-30', currency: 'GBP', lines: [] }
    });
    return { allowed: true };
  } catch (error) {
    return { allowed: false, error };
  } finally {
    await client.query('rollback');
  }
});

// Drive the real scheduler (harness tick: its own dispatcher over the real
// manifest entry) until the given slot's tick is dead: two attempts, the
// backoff between them collapsed.
const killSlot = async (appliance, at) => {
  appliance.clock.set(at);
  for (let round = 0; round < 4; round += 1) {
    await appliance.tick({ functions: [FN], advanceMs: 0 });
    const jobs = await fnJobs(appliance);
    const last = jobs[jobs.length - 1];
    if (last?.status === 'dead') return last;
  }
  throw new Error('the backup tick did not die');
};

// The harness tick plans recovery on its first loop (the recovery loop's
// interval starts due) BEFORE it collapses waits, so a just-planned recovery
// keeps its run_at; the next tick collapses it and runs it.
const planRecovery = (appliance) => appliance.tick({ functions: [FN], advanceMs: 0, collapseWaits: false, maxRounds: 1 });

// A dispatcher of our own over the same manifest entry, with its own clock
// and, where a proof needs one, its own handler: the race and restart proofs
// need two of them, which the harness's tick() never builds.
const dispatcher = (appliance, { at, run = null, maxAttempts = null } = {}) => {
  const base = appliance.manifest.find((entry) => entry.functionId === FN);
  const entry = { ...base, ...(run ? { run } : {}), ...(maxAttempts ? { maxAttempts } : {}) };
  return createLocalScheduler({ manifest: [entry], client: queueClient, logger: silent, now: () => new Date(at), workerId: `synthetic-${Math.random().toString(36).slice(2, 8)}` });
};
const settle = async (scheduler) => {
  while (scheduler.inFlightCount() > 0) await new Promise((resolve) => setTimeout(resolve, 20));
};

test(
  'real PG (a): a daily tick dies → the host fails naming it → a recovery tick is due two minutes after the death, names the dead job, succeeds → the host passes',
  { skip: applianceHarnessSkipReason() },
  async () => {
    const appliance = await boot();
    try {
      const { clientId } = await appliance.createClient();
      const baseline = await certify(appliance);
      assert.equal(baseline.host.status, 'PASS');

      const dead = await killSlot(appliance, `${SLOT.slice(0, 16)}:10.000Z`);
      assert.equal(dead.status, 'dead');
      assert.equal(dead.attempt_count, 2);
      assert.equal(dead.payload.tick, SLOT);

      // The host fails and names the function, when it died, and the next attempt.
      const blocked = await certify(appliance);
      assert.equal(blocked.host.status, 'FAIL');
      assert.equal(blocked.host.reason_code, 'work_queue_needs_recovery');
      assert.equal(blocked.queue.dead_unsuperseded, 1);
      assert.equal(blocked.failures.length, 1, JSON.stringify(blocked.failures));
      const [named] = blocked.failures;
      assert.equal(named.function_id, FN);
      assert.equal(named.kind, 'scheduled');
      assert.equal(named.dead_job_id, Number(dead.id));
      assert.equal(named.died_at, new Date(dead.completed_at).toISOString());
      assert.match(named.last_error, /unix-socket DATABASE_URL/);
      assert.deepEqual(named.recovery, { recovers_job_id: Number(dead.id), used: 0, max: CRON_RECOVERY_MAX_TICKS, exhausted: false });
      assert.equal(named.next_attempt.kind, 'recovery');
      assert.equal(named.next_attempt.at, new Date(new Date(dead.completed_at).getTime() + CRON_RECOVERY_DELAYS_MS[0]).toISOString());
      // The receipt detail is outside the compatibility projection.
      assert.equal(blocked.host.certificate.compatibility_digest, baseline.host.certificate.compatibility_digest);

      // The refusal a book gets, on an upload and on a posting, carries it.
      const refused = await signUpload(appliance, clientId, 'a');
      assert.equal(refused.status, 503, refused.text);
      assert.equal(refused.json?.code, 'ENTITY_READINESS_ADMISSION_BLOCKED');
      assert.equal(refused.json?.details?.reason_code, 'work_queue_needs_recovery');
      assert.equal(refused.json?.details?.host_queue_failures?.[0]?.function_id, FN);
      assert.match(refused.json?.error, new RegExp(`Scheduled job ${FN} failed at ${named.died_at.replace(/[.]/g, '\\.')}; next attempt at `));
      const posting = await attemptPosting(appliance, clientId);
      assert.equal(posting.allowed, false);
      assert.equal(posting.error?.code, 'ENTITY_READINESS_ADMISSION_BLOCKED');
      assert.equal(posting.error?.details?.boundary, 'ledger_write');
      assert.equal(posting.error?.details?.host_queue_failures?.[0]?.dead_job_id, Number(dead.id));

      // The scheduler's recovery loop enqueues the recovery from the dead row:
      // due exactly the first delay after the death, naming the dead job.
      await planRecovery(appliance);
      const jobs = await fnJobs(appliance);
      assert.equal(jobs.length, 2, JSON.stringify(jobs.map((job) => [job.id, job.status])));
      const recovery = jobs[1];
      assert.equal(recovery.status, 'pending');
      assert.equal(new Date(recovery.run_at).getTime() - new Date(dead.completed_at).getTime(), CRON_RECOVERY_DELAYS_MS[0]);
      assert.equal(recovery.payload.recovers.dead_job_id, Number(dead.id));
      assert.equal(recovery.payload.recovers.previous_job_id, Number(dead.id));
      assert.equal(recovery.payload.recovers.dead_tick, SLOT);
      assert.equal(recovery.payload.recovers.recovery, 1);
      assert.equal(recovery.payload.recovers.of, CRON_RECOVERY_MAX_TICKS);
      assert.equal(recovery.dedupe_key, `${FN}@${SLOT}`);
      assert.equal(recovery.max_attempts, 2, 'the manifest entry\'s own attempt budget');
      const pending = await certify(appliance);
      assert.equal(pending.host.status, 'FAIL', 'a pending recovery does not pass the host');
      assert.deepEqual(
        { kind: pending.failures[0].next_attempt.kind, job_id: pending.failures[0].next_attempt.job_id, at: pending.failures[0].next_attempt.at },
        { kind: 'recovery', job_id: Number(recovery.id), at: new Date(recovery.run_at).toISOString() }
      );
      await planRecovery(appliance);
      assert.equal((await fnJobs(appliance)).length, 2, 'planning again adds nothing');

      // The condition clears; the recovery comes due and succeeds; the
      // unchanged supersede rule clears the failure.
      clearBackupFailure();
      await appliance.tick({ functions: [FN], advanceMs: 0 });
      const [, recovered] = await fnJobs(appliance);
      assert.equal(recovered.status, 'succeeded', recovered.last_error);
      const passed = await certify(appliance);
      assert.equal(passed.host.status, 'PASS', JSON.stringify(passed.failures));
      assert.equal(passed.queue.dead, 1, 'the dead tick stays visible');
      assert.equal(passed.queue.dead_unsuperseded, 0);
      assert.deepEqual(passed.failures, []);
      assert.equal(passed.host.certificate.compatibility_digest, baseline.host.certificate.compatibility_digest);
      const signed = await signUpload(appliance, clientId, 'b');
      assert.equal(signed.status, 200, signed.text);
      assert.equal((await fnJobs(appliance)).length, 2, 'no further recovery after the success');
    } finally {
      await appliance.stop();
    }
  }
);

test(
  'real PG (b): recovery exhausted — no further recovery, the host stays failed naming the next scheduled run; that slot still runs and clears it',
  { skip: applianceHarnessSkipReason() },
  async () => {
    const appliance = await boot();
    try {
      const { clientId } = await appliance.createClient();
      const root = await killSlot(appliance, `${SLOT.slice(0, 16)}:10.000Z`);
      let previous = root;
      for (let k = 1; k <= CRON_RECOVERY_MAX_TICKS; k += 1) {
        await planRecovery(appliance);
        const recovery = (await fnJobs(appliance)).at(-1);
        assert.equal(recovery.payload.recovers?.recovery, k, `recovery ${k} planned`);
        assert.equal(recovery.payload.recovers.dead_job_id, Number(root.id), 'every recovery names the root dead tick');
        assert.equal(recovery.payload.recovers.previous_job_id, Number(previous.id), 'and the job it follows');
        assert.equal(new Date(recovery.run_at).getTime() - new Date(previous.completed_at).getTime(), CRON_RECOVERY_DELAYS_MS[k - 1], 'growing delays');
        for (let round = 0; round < 3 && (await fnJobs(appliance)).at(-1).status !== 'dead'; round += 1) {
          await appliance.tick({ functions: [FN], advanceMs: 0 });
        }
        previous = (await fnJobs(appliance)).at(-1);
        assert.equal(previous.status, 'dead');
        assert.equal(Number(previous.id), Number(recovery.id));
      }
      const before = (await fnJobs(appliance)).length;
      await planRecovery(appliance);
      await appliance.tick({ functions: [FN], advanceMs: 0 });
      assert.equal((await fnJobs(appliance)).length, before, 'exhausted: nothing more is enqueued');
      assert.equal(before, 1 + CRON_RECOVERY_MAX_TICKS);

      const exhausted = await certify(appliance);
      assert.equal(exhausted.host.status, 'FAIL');
      assert.equal(exhausted.host.reason_code, 'work_queue_needs_recovery');
      const [named] = exhausted.failures;
      assert.equal(named.function_id, FN);
      assert.equal(named.dead_job_id, Number(previous.id), 'the latest death is named');
      assert.deepEqual(named.recovery, { recovers_job_id: Number(root.id), used: CRON_RECOVERY_MAX_TICKS, max: CRON_RECOVERY_MAX_TICKS, exhausted: true });
      assert.equal(named.next_attempt.kind, 'scheduled');
      assert.equal(named.next_attempt.at, nextCronOccurrence('30 1 * * *', new Date(exhausted.host.certificate.observed_at)).toISOString());
      const refused = await signUpload(appliance, clientId, 'c');
      assert.equal(refused.status, 503, refused.text);
      assert.match(refused.json?.error, /next attempt at .* \(its next scheduled run\)\./);

      // The next scheduled slot still runs, and its success clears the host.
      clearBackupFailure();
      appliance.clock.set(`${NEXT_SLOT.slice(0, 16)}:10.000Z`);
      await appliance.tick({ functions: [FN], advanceMs: 0 });
      const slot = (await fnJobs(appliance)).at(-1);
      assert.equal(slot.payload.tick, NEXT_SLOT);
      assert.equal(slot.payload.recovers, undefined, 'a plain scheduled tick');
      assert.equal(slot.status, 'succeeded', slot.last_error);
      const passed = await certify(appliance);
      assert.equal(passed.host.status, 'PASS', JSON.stringify(passed.failures));
    } finally {
      await appliance.stop();
    }
  }
);

test(
  'real PG (c): never two live ticks — a slot arriving during a pending recovery is served by it, during a running one it waits; racing dispatchers and a restart plan one recovery',
  { skip: applianceHarnessSkipReason() },
  async () => {
    const appliance = await boot();
    try {
      await appliance.createClient();
      const root = await killSlot(appliance, `${SLOT.slice(0, 16)}:10.000Z`);
      const slotAt = `${NEXT_SLOT.slice(0, 16)}:05.000Z`;

      // Racing: two dispatchers' whole loops at once over a dead tick with
      // nothing live — one recovery row.
      const hold = async () => ({ held: true });
      const [a, b] = [dispatcher(appliance, { at: `${SLOT.slice(0, 16)}:40.000Z`, run: hold }), dispatcher(appliance, { at: `${SLOT.slice(0, 16)}:40.000Z`, run: hold })];
      await Promise.all([a.initialize(), b.initialize()]);
      await Promise.all([a.tickOnce(), b.tickOnce()]);
      assert.equal(await liveCount(appliance), 1);
      assert.equal((await fnJobs(appliance)).length, 2);
      // And eight concurrent plans of the statement itself (after an
      // operator-cancelled first recovery reopened the slot): one row.
      await appliance.query("update local_jobs set status = 'cancelled', cancelled_at = now() where function_id = $1 and status = 'pending'", [FN]);
      const fn = appliance.manifest.find((entry) => entry.functionId === FN);
      const plan = { functionId: FN, handlerVersion: fn.handlerVersion, maxAttempts: fn.maxAttempts, slotTick: SLOT };
      const planned = (await Promise.all(Array.from({ length: 8 }, () => enqueueCronRecoveryTicks({ client: queueClient, functions: [plan] })))).flat();
      assert.equal(planned.length, 1, 'concurrent plans insert one recovery');
      assert.equal(planned[0].payload.recovers.recovery, 2, 'a cancelled recovery still counts against the budget');
      assert.equal(await liveCount(appliance), 1);

      // Restart in the middle: a new dispatcher boots over the pending
      // recovery and plans nothing more.
      const rebooted = dispatcher(appliance, { at: `${SLOT.slice(0, 16)}:50.000Z`, run: hold });
      await rebooted.initialize();
      await rebooted.tickOnce();
      assert.equal((await fnJobs(appliance)).length, 3, 'a restart does not duplicate the recovery');

      // The next scheduled slot arrives while the recovery is pending: the
      // recovery is made due now, stands for the slot, and runs; no second tick.
      const ranTicks = [];
      const atSlot = dispatcher(appliance, { at: slotAt, run: async ({ payload }) => { ranTicks.push(payload); return { ok: true }; } });
      await atSlot.initialize();
      await atSlot.tickOnce();
      await settle(atSlot);
      await atSlot.stop();
      let jobs = await fnJobs(appliance);
      assert.equal(jobs.length, 3, JSON.stringify(jobs.map((job) => [job.id, job.status, job.dedupe_key])));
      assert.equal(jobs[2].payload.stands_for_tick, NEXT_SLOT);
      assert.equal(jobs[2].status, 'succeeded');
      assert.equal(ranTicks.length, 1);
      assert.equal((await appliance.query('select last_enqueued_tick from local_job_cron_state where function_id = $1', [FN])).rows[0].last_enqueued_tick.toISOString(), NEXT_SLOT, 'the cursor moved past the served slot');
      await Promise.all([a.stop(), b.stop(), rebooted.stop()]);

      // A RUNNING recovery when a slot comes due: the slot waits for it (one
      // live tick), then runs after it settles.
      // (Its success is turned into a death to open one more recovery.)
      await appliance.query("update local_jobs set status = 'dead', completed_at = now() where id = $1", [jobs[2].id]);
      await planRecovery(appliance);
      jobs = await fnJobs(appliance);
      const running = jobs.at(-1);
      assert.equal(running.payload.recovers.dead_job_id, Number(root.id));
      await appliance.query(
        "update local_jobs set status = 'running', attempt_count = 1, locked_by = 'synthetic', locked_at = now(), lease_expires_at = now() + interval '10 minutes' where id = $1",
        [running.id]
      );
      const thirdSlot = '2026-09-02T01:30:00.000Z';
      const waiting = dispatcher(appliance, { at: '2026-09-02T01:30:05.000Z', run: hold });
      await waiting.initialize();
      await waiting.tickOnce();
      assert.equal(await liveCount(appliance), 1, 'the slot waits behind the running recovery');
      assert.equal((await fnJobs(appliance)).length, jobs.length);
      await appliance.query("update local_jobs set status = 'succeeded', completed_at = now(), locked_by = null, lease_expires_at = null where id = $1", [running.id]);
      await waiting.tickOnce();
      await settle(waiting);
      await waiting.stop();
      const after = await fnJobs(appliance);
      assert.equal(after.length, jobs.length + 1);
      assert.equal(after.at(-1).payload.tick, thirdSlot, 'the held slot runs once the recovery settled');
      assert.equal(after.at(-1).status, 'succeeded');
    } finally {
      await appliance.stop();
    }
  }
);

test(
  'real PG (d): sleep — the clock jumps past every recovery delay; one recovery runs on wake',
  { skip: applianceHarnessSkipReason() },
  async () => {
    const appliance = await boot();
    try {
      await appliance.createClient();
      const root = await killSlot(appliance, `${SLOT.slice(0, 16)}:10.000Z`);
      // The machine slept: the death is three hours back on the DB clock,
      // past all of CRON_RECOVERY_DELAYS_MS (2 + 10 + 30 minutes).
      await appliance.query("update local_jobs set completed_at = now() - interval '3 hours' where id = $1", [root.id]);
      let runs = 0;
      const woke = dispatcher(appliance, {
        at: '2026-08-31T04:30:40.000Z',
        maxAttempts: 1,
        run: async () => { runs += 1; throw new Error('synthetic: target still unreachable'); }
      });
      await woke.initialize();
      for (let loop = 0; loop < 5; loop += 1) {
        await woke.tickOnce();
        await settle(woke);
      }
      await woke.stop();
      assert.equal(runs, 1, 'one recovery on wake, not one per missed delay');
      const jobs = await fnJobs(appliance);
      assert.equal(jobs.length, 2, JSON.stringify(jobs.map((job) => [job.id, job.status, job.payload?.recovers?.recovery])));
      const [, first] = jobs;
      assert.equal(first.payload.recovers.recovery, 1);
      assert.equal(first.status, 'dead');
      // The next recovery's delay starts from that death, so it is ahead.
      await planRecovery(appliance);
      const next = (await fnJobs(appliance)).at(-1);
      assert.equal(next.payload.recovers.recovery, 2);
      assert.equal(new Date(next.run_at).getTime() - new Date(first.completed_at).getTime(), CRON_RECOVERY_DELAYS_MS[1]);
      assert.ok(new Date(next.run_at).getTime() > Date.now(), 'not due yet');
    } finally {
      await appliance.stop();
    }
  }
);
