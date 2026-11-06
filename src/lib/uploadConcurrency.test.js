// Bounded-concurrency mapper — the upload paths' replacement for
// Promise.all (see uploadConcurrency.js for the 2026-08-31 incident).
// node --test src/lib/uploadConcurrency.test.js

import test from 'node:test';
import assert from 'node:assert/strict';

import { mapWithConcurrency, UPLOAD_CONCURRENCY } from './uploadConcurrency.js';

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

test('results keep input order even when later items finish first', async () => {
  const delays = [30, 0, 15, 5];
  const results = await mapWithConcurrency(delays, 4, async (delay, index) => {
    await new Promise((resolve) => setTimeout(resolve, delay));
    return `item-${index}`;
  });
  assert.deepEqual(results, ['item-0', 'item-1', 'item-2', 'item-3']);
});

test('never runs more than `limit` mappers at once', async () => {
  let inFlight = 0;
  let peak = 0;
  await mapWithConcurrency(Array.from({ length: 20 }, (_, i) => i), 3, async () => {
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    await tick();
    await tick();
    inFlight -= 1;
  });
  assert.equal(peak, 3);
});

test('a limit above the item count just runs them all', async () => {
  let peak = 0;
  let inFlight = 0;
  await mapWithConcurrency([1, 2], 50, async () => {
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    await tick();
    inFlight -= 1;
  });
  assert.equal(peak, 2);
});

test('a nonsense limit clamps to serial instead of unbounded', async () => {
  let peak = 0;
  let inFlight = 0;
  await mapWithConcurrency([1, 2, 3], 0, async () => {
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    await tick();
    inFlight -= 1;
  });
  assert.equal(peak, 1);
});

test('a mapper rejection rejects the whole map (Promise.all contract)', async () => {
  await assert.rejects(
    mapWithConcurrency([1, 2, 3], 2, async (item) => {
      if (item === 2) throw new Error('boom');
      return item;
    }),
    /boom/
  );
});

test('empty input resolves to an empty array without calling the mapper', async () => {
  let calls = 0;
  const results = await mapWithConcurrency([], 4, async () => { calls += 1; });
  assert.deepEqual(results, []);
  assert.equal(calls, 0);
});

test('the shared upload limit is a small burst, not a whole batch', () => {
  assert.ok(UPLOAD_CONCURRENCY >= 2 && UPLOAD_CONCURRENCY <= 8);
});
