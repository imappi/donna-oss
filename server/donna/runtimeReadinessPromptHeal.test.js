// makePromptDueEntityHeal — the queue-activity retry runner that closes the
// Desert Rose flap (2026-09-01): a saga the migration-127 fence invalidated
// mid-sweep (the admitted posting minting a chart account) carries an
// immediately-due retry, but the only retry runner was the 5-minute
// renewal-time heal — so the rest of the pass starved at admission. The
// rails under test: it runs ONLY the existing bounded heal, only when a due
// saga exists, serialized, floored, and soft-failing.

import test from 'node:test';
import assert from 'node:assert/strict';

import { makePromptDueEntityHeal } from './runtimeReadiness.js';

const fakeDb = (dueRows) => {
  const queries = [];
  return {
    queries,
    withFirmDbClientFn: async (fn) => fn({
      query: async (sql) => {
        queries.push(sql);
        return { rows: dueRows() };
      }
    })
  };
};

test('non-settlement activity is ignored without touching the db', async () => {
  const db = fakeDb(() => [{ 1: 1 }]);
  let heals = 0;
  const hook = makePromptDueEntityHeal({
    withFirmDbClientFn: db.withFirmDbClientFn,
    healFn: async () => { heals += 1; }
  });
  await hook({ kind: 'leases_recovered' });
  await hook(undefined);
  assert.equal(db.queries.length, 0);
  assert.equal(heals, 0);
});

test('no due saga → one existence probe, no heal', async () => {
  const db = fakeDb(() => []);
  let heals = 0;
  const hook = makePromptDueEntityHeal({
    withFirmDbClientFn: db.withFirmDbClientFn,
    healFn: async () => { heals += 1; },
    minIntervalMs: 0
  });
  await hook({ kind: 'job_settled' });
  assert.equal(db.queries.length, 1);
  assert.match(db.queries[0], /retry_state = 'scheduled'/);
  assert.match(db.queries[0], /attempt_count < max_attempts/, 'exhausted sagas are never re-driven from here');
  // RT-09: a host wait has no clock (next_retry_at NULL); its runner is the
  // Host A PASS transition, never queue settlement.
  assert.match(db.queries[0], /next_retry_at is not null and next_retry_at <= now\(\)/, 'a clockless host wait is not "due" here');
  assert.doesNotMatch(db.queries[0], /next_retry_at is null or/);
  assert.equal(heals, 0);
});

test('a due saga runs the bounded targeted heal with the injected clock', async () => {
  const db = fakeDb(() => [{ '?column?': 1 }]);
  const healCalls = [];
  const hook = makePromptDueEntityHeal({
    withFirmDbClientFn: db.withFirmDbClientFn,
    healFn: async (args) => { healCalls.push(args); return { selected: 1 }; },
    now: () => new Date('2026-09-01T16:25:01.000Z'),
    minIntervalMs: 0
  });
  const result = await hook({ kind: 'job_settled' });
  assert.equal(healCalls.length, 1);
  assert.equal(healCalls[0].observedAt, '2026-09-01T16:25:01.000Z');
  assert.equal(healCalls[0].withFirmDbClientFn, db.withFirmDbClientFn);
  assert.equal(healCalls[0].includeHostWait, false, 'RT-09: the queue-activity heal never re-proves an entity against an unchanged failed host');
  assert.deepEqual(result, { selected: 1 });
});

test('concurrent settlements coalesce onto one in-flight heal', async () => {
  const db = fakeDb(() => [{ '?column?': 1 }]);
  let heals = 0;
  let release;
  const hook = makePromptDueEntityHeal({
    withFirmDbClientFn: db.withFirmDbClientFn,
    healFn: () => new Promise((resolve) => { heals += 1; release = () => resolve({ selected: 1 }); }),
    minIntervalMs: 0
  });
  const first = hook({ kind: 'job_settled' });
  await new Promise((resolve) => setImmediate(resolve)); // let the probe run
  const second = hook({ kind: 'job_settled' });
  release();
  await Promise.all([first, second]);
  assert.equal(heals, 1, 'the second settlement rode the in-flight heal');
});

test('the min-interval floor keeps a flapping saga from heal-looping at queue rate', async () => {
  const db = fakeDb(() => [{ '?column?': 1 }]);
  let heals = 0;
  let clock = 1_000_000;
  const hook = makePromptDueEntityHeal({
    withFirmDbClientFn: db.withFirmDbClientFn,
    healFn: async () => { heals += 1; },
    minIntervalMs: 15_000,
    now: () => new Date(clock)
  });
  await hook({ kind: 'job_settled' });
  assert.equal(heals, 1);
  clock += 5_000;
  await hook({ kind: 'job_settled' });
  assert.equal(heals, 1, 'inside the floor → skipped');
  clock += 15_000;
  await hook({ kind: 'job_settled' });
  assert.equal(heals, 2, 'past the floor → heals again');
});

test('a failing heal is swallowed and logged — queue settlement must never throw', async () => {
  const db = fakeDb(() => [{ '?column?': 1 }]);
  const errors = [];
  const hook = makePromptDueEntityHeal({
    withFirmDbClientFn: db.withFirmDbClientFn,
    healFn: async () => { throw new Error('provisioning refused'); },
    logger: { error: (...args) => errors.push(args.join(' ')) },
    minIntervalMs: 0
  });
  const result = await hook({ kind: 'job_settled' });
  assert.equal(result, null);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /provisioning refused/);
});
