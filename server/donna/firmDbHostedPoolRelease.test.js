// Hosted session hygiene (server/donna/db/pool.js): a Vercel instance frozen
// between invocations must hold no pooler session. The hosted pooler runs in
// SESSION mode with a fixed client cap (EMAXCONNSESSION pool_size 30, Kampaamo
// re-upload 2026-09-21), and a frozen instance cannot run pg-pool's idle
// reaper — so the last invocation out of an instance ends the idle pool.
import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import {
  __resetFirmDbPoolForTests, __setFirmDbPoolForTests, readFirmDbPoolCounts, readHostedInvocationCount,
  releaseFirmDbPoolWhenIdle, trackHostedInvocation
} from './db/pool.js';

const fakePool = ({ total = 2, idle = 2, waiting = 0 } = {}) => {
  const pool = { totalCount: total, idleCount: idle, waitingCount: waiting, options: { max: 2 }, ended: 0 };
  pool.end = async () => { pool.ended += 1; };
  return pool;
};

test.afterEach(() => __resetFirmDbPoolForTests());

test('an idle pool is ended and detached when the instance is quiet', async () => {
  const pool = fakePool();
  __setFirmDbPoolForTests(pool, { owned: true });
  assert.deepEqual(await releaseFirmDbPoolWhenIdle(), { released: true, total: 2, idle: 2, waiting: 0, max: 2 });
  assert.equal(pool.ended, 1);
  assert.equal(readFirmDbPoolCounts(), null, 'the next loadPgPool builds a fresh pool');
  assert.deepEqual(await releaseFirmDbPoolWhenIdle(), { released: false, reason: 'no_pool' });
});

test('a pool with a checked-out or waiting client is left alone', async () => {
  for (const [shape, reason] of [
    [{ total: 2, idle: 1, waiting: 0 }, 'in_use'],
    [{ total: 2, idle: 2, waiting: 1 }, 'in_use'],
    [{ total: 1, idle: 0, waiting: 0 }, 'in_use']
  ]) {
    const pool = fakePool(shape);
    __setFirmDbPoolForTests(pool, { owned: true });
    const receipt = await releaseFirmDbPoolWhenIdle();
    assert.equal(receipt.released, false, JSON.stringify(shape));
    assert.equal(receipt.reason, reason);
    assert.equal(pool.ended, 0);
    assert.ok(readFirmDbPoolCounts(), 'the pool stays attached');
    __resetFirmDbPoolForTests();
  }
  // API seam fakes without counters are never ended.
  __setFirmDbPoolForTests({ query: async () => ({ rows: [] }) }, { owned: true });
  assert.equal((await releaseFirmDbPoolWhenIdle()).reason, 'counts_unavailable');
});

test('overlapping hosted invocations release once, after the last response finishes', async () => {
  const pool = fakePool();
  __setFirmDbPoolForTests(pool, { owned: true });
  const releases = [];
  const release = async () => { releases.push(readHostedInvocationCount()); return releaseFirmDbPoolWhenIdle(); };
  const first = new EventEmitter(), second = new EventEmitter();
  trackHostedInvocation(first, { release });
  trackHostedInvocation(second, { release });
  assert.equal(readHostedInvocationCount(), 2);
  // While an invocation is still running here, even an idle pool stays.
  assert.deepEqual(await releaseFirmDbPoolWhenIdle(), { released: false, reason: 'invocation_active', active: 2 });
  first.emit('finish');
  first.emit('close'); // the second event of the same response is a no-op
  assert.equal(readHostedInvocationCount(), 1);
  assert.deepEqual(releases, []);
  assert.equal(pool.ended, 0);
  second.emit('close');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(readHostedInvocationCount(), 0);
  assert.deepEqual(releases, [0]);
  assert.equal(pool.ended, 1);
  assert.equal(readFirmDbPoolCounts(), null);
});

test('a pool the runtime did not build is never ended by a hosted invocation', async () => {
  // The real-PG suites inject their own pool and then drive the router on a
  // real HTTP server (partialUploadHttpProof.js): every finished response
  // must leave that pool attached and alive, or the suite's teardown fails
  // on an already-ended pool and its leaked admin client hangs node --test
  // (the cloud-readiness job on 2026-09-21).
  const pool = fakePool();
  __setFirmDbPoolForTests(pool);
  assert.deepEqual(await releaseFirmDbPoolWhenIdle(), { released: false, reason: 'not_owned' });
  const res = new EventEmitter();
  trackHostedInvocation(res);
  res.emit('finish');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(readHostedInvocationCount(), 0);
  assert.equal(pool.ended, 0);
  assert.deepEqual(readFirmDbPoolCounts(), { total: 2, idle: 2, waiting: 0, max: 2 }, 'the injected pool stays attached');
});

test('a failed pool end is receipted, never thrown into the response path', async () => {
  const pool = fakePool();
  pool.end = async () => { throw new Error('socket already closed'); };
  __setFirmDbPoolForTests(pool, { owned: true });
  const warnings = [];
  const res = new EventEmitter();
  trackHostedInvocation(res, { log: { warn: (line) => warnings.push(line) } });
  res.emit('finish');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(readFirmDbPoolCounts(), null, 'the broken pool is detached either way');
  assert.match(warnings[0], /hosted pool release failed: socket already closed/);
});

test('both hosted entry points track their invocation and the pool keeps its session-mode contract', async () => {
  for (const entrypoint of ['../../api/donna-router.js', '../../api/inngest.js']) {
    const source = await readFile(new URL(entrypoint, import.meta.url), 'utf8');
    assert.match(source, /import \{ trackHostedInvocation \} from '\.\.\/server\/donna\/db\/pool\.js'/, entrypoint);
    assert.match(source, /export default function handler\(req, res\) \{\s*\/\/[^\n]*\n(?:\s*\/\/[^\n]*\n)*\s*trackHostedInvocation\(res\);/, entrypoint);
  }
  const pool = await readFile(new URL('./db/pool.js', import.meta.url), 'utf8');
  // Session-level advisory leases (admissionLeaseLifecycle.js) need the session
  // endpoint; the remedy for the cap is holding fewer sessions, not a mode switch.
  assert.doesNotMatch(pool, /6543|transaction mode|pgbouncer/i);
  assert.match(pool, /max: Number\(process\.env\.DATABASE_POOL_MAX \|\| 2\)/);
});
