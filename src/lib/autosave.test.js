// createCoalescedAutosave — the services_engaged race, pinned.
//
// Three quick checkbox ticks used to fire three concurrent full-array
// PATCHes; commit order decided the books and the snapshot echoes
// reset the optimistic UI mid-flight. The writer's contract: at most
// one write in flight, pushes during a write coalesce into ONE
// follow-up carrying the LATEST value, success fires only for the
// final settled write.

import assert from 'node:assert/strict';
import test from 'node:test';

import { createCoalescedAutosave } from './autosave.js';

const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

const tick = () => new Promise((res) => setImmediate(res));

test('three quick pushes → two serialized writes, latest value wins, one success', async () => {
  const writes = [];
  const gates = [deferred(), deferred()];
  const successes = [];
  const writer = createCoalescedAutosave({
    write: (value) => {
      writes.push(value);
      return gates[writes.length - 1].promise;
    },
    onSuccess: (result, value) => successes.push({ result, value })
  });

  writer.push(['bank']);
  writer.push(['bank', 'sales']);
  writer.push(['bank', 'sales', 'bills']);
  await tick();

  assert.deepEqual(writes, [['bank']], 'only the first write is in flight');
  assert.ok(writer.isBusy());

  gates[0].resolve({ source: 'database', n: 1 });
  await tick();
  await tick();

  assert.equal(writes.length, 2, 'pushes 2+3 coalesced into one follow-up');
  assert.deepEqual(writes[1], ['bank', 'sales', 'bills'], 'follow-up carries the LATEST full set');
  assert.equal(successes.length, 0, 'intermediate write does not fire success');

  gates[1].resolve({ source: 'database', n: 2 });
  await tick();
  await tick();

  assert.equal(successes.length, 1, 'success fires once, for the final settled write');
  assert.equal(successes[0].result.n, 2, 'and with the FINAL snapshot, never a stale echo');
  assert.equal(writer.isBusy(), false);
});

test('failure drains the queue, reports once, and the writer recovers', async () => {
  const writes = [];
  let gate = deferred();
  const errors = [];
  const successes = [];
  const writer = createCoalescedAutosave({
    write: (value) => {
      writes.push(value);
      return gate.promise;
    },
    onSuccess: (result) => successes.push(result),
    onError: (error) => errors.push(error)
  });

  writer.push(['bank']);
  writer.push(['bank', 'sales']);
  await tick();
  gate.reject(new Error('boom'));
  await tick();
  await tick();

  assert.equal(errors.length, 1, 'one error report');
  assert.equal(writes.length, 1, 'queued follow-up is drained on failure');
  assert.equal(writer.isBusy(), false);

  gate = deferred();
  writer.push(['bank']);
  await tick();
  gate.resolve({ ok: true });
  await tick();
  await tick();
  assert.equal(successes.length, 1, 'writer keeps working after a failure');
});
