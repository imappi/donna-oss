import test from 'node:test';
import assert from 'node:assert/strict';

import { createDocumentDeleteQueue } from './documentDeleteQueue.js';

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};

test('optimistic removal happens immediately, before the server answers', async () => {
  const removed = [];
  const gate = deferred();
  const queue = createDocumentDeleteQueue({
    deleteDocument: () => gate.promise,
    applySnapshot: () => {},
    removeDocument: (id) => removed.push(id)
  });
  const run = queue.request('doc-1');
  assert.deepEqual(removed, ['doc-1']);
  assert.equal(queue.isPending('doc-1'), true);
  gate.resolve({ source: 'database', documents: [] });
  assert.deepEqual(await run, {
    ok: true,
    documentId: 'doc-1',
    snapshot: { source: 'database', documents: [] }
  });
  assert.equal(queue.isPending('doc-1'), false);
});

test('deletes are serialized: the second DELETE only starts after the first settles', async () => {
  const starts = [];
  const gates = { 'doc-1': deferred(), 'doc-2': deferred() };
  const queue = createDocumentDeleteQueue({
    deleteDocument: (id) => { starts.push(id); return gates[id].promise; },
    applySnapshot: () => {},
    removeDocument: () => {}
  });
  queue.request('doc-1');
  const second = queue.request('doc-2');
  await Promise.resolve();
  assert.deepEqual(starts, ['doc-1'], 'doc-2 must wait for doc-1');
  gates['doc-1'].resolve({ documents: [] });
  gates['doc-2'].resolve({ documents: [] });
  await second;
  assert.deepEqual(starts, ['doc-1', 'doc-2']);
});

test('an earlier snapshot cannot resurrect a doc whose delete is still pending', async () => {
  // The race from the 2026-07-21 report: delete A's returned snapshot was
  // built before delete B committed, so it still contains B's row.
  const applied = [];
  const gates = { A: deferred(), B: deferred() };
  const queue = createDocumentDeleteQueue({
    deleteDocument: (id) => gates[id].promise,
    applySnapshot: (snapshot) => applied.push(snapshot),
    removeDocument: () => {}
  });
  queue.request('A');
  const runB = queue.request('B');
  // A's snapshot arrives while B is still queued — and still contains B.
  gates.A.resolve({ documents: [{ id: 'B' }, { id: 'C' }] });
  await Promise.resolve(); await Promise.resolve();
  // The app-level applier runs every snapshot's documents through the
  // pending filter: B must be dropped, C kept.
  assert.deepEqual(queue.filterSnapshotDocuments(applied[0].documents), [{ id: 'C' }]);
  gates.B.resolve({ documents: [{ id: 'C' }] });
  await runB;
  // After B settles the filter is a no-op.
  assert.deepEqual(queue.filterSnapshotDocuments([{ id: 'B' }, { id: 'C' }]), [{ id: 'B' }, { id: 'C' }]);
});

test('a refused delete restores the row and reports the error', async () => {
  const restored = [];
  const errors = [];
  const applied = [];
  const queue = createDocumentDeleteQueue({
    deleteDocument: async () => { throw Object.assign(new Error('retention hold'), { code: 'FINLAND_RETENTION_DOCUMENT_HELD' }); },
    applySnapshot: (s) => applied.push(s),
    removeDocument: () => {},
    restoreDocument: (id, row) => restored.push({ id, row }),
    onError: (error, id) => errors.push({ code: error.code, id })
  });
  const result = await queue.request('doc-1', { id: 'doc-1', filename: 'held.pdf' });
  assert.deepEqual(restored, [{ id: 'doc-1', row: { id: 'doc-1', filename: 'held.pdf' } }]);
  assert.deepEqual(errors, [{ code: 'FINLAND_RETENTION_DOCUMENT_HELD', id: 'doc-1' }]);
  assert.equal(applied.length, 0, 'no snapshot applied on failure');
  assert.equal(queue.isPending('doc-1'), false);
  assert.equal(result.ok, false);
  assert.equal(result.documentId, 'doc-1');
  assert.equal(result.error.code, 'FINLAND_RETENTION_DOCUMENT_HELD');
});

test('batch callers can suppress per-row errors and receive an explicit failure receipt', async () => {
  const errors = [];
  const queue = createDocumentDeleteQueue({
    deleteDocument: async () => { throw Object.assign(new Error('retention hold'), { code: 'FINLAND_RETENTION_DOCUMENT_HELD' }); },
    applySnapshot: () => {},
    removeDocument: () => {},
    restoreDocument: () => {},
    onError: (error) => errors.push(error)
  });
  const result = await queue.request('held', { id: 'held' }, { reportError: false });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'FINLAND_RETENTION_DOCUMENT_HELD');
  assert.deepEqual(errors, [], 'the batch surface owns its one aggregate failure message');
});

test('a failed delete does not break the chain for the next delete', async () => {
  const applied = [];
  let calls = 0;
  const queue = createDocumentDeleteQueue({
    deleteDocument: async (id) => {
      calls += 1;
      if (id === 'doc-1') throw new Error('boom');
      return { documents: [] };
    },
    applySnapshot: (s) => applied.push(s),
    removeDocument: () => {},
    restoreDocument: () => {},
    onError: () => {}
  });
  await queue.request('doc-1');
  await queue.request('doc-2');
  assert.equal(calls, 2);
  assert.equal(applied.length, 1);
});

test('double-clicking the same row is a no-op while its delete is pending', async () => {
  let calls = 0;
  const gate = deferred();
  const queue = createDocumentDeleteQueue({
    deleteDocument: () => { calls += 1; return gate.promise; },
    applySnapshot: () => {},
    removeDocument: () => {}
  });
  const first = queue.request('doc-1');
  queue.request('doc-1');
  queue.request('doc-1');
  gate.resolve({ documents: [] });
  await first;
  assert.equal(calls, 1);
});

test('filterSnapshotDocuments leaves non-array documents untouched', () => {
  const queue = createDocumentDeleteQueue({ deleteDocument: async () => ({}), applySnapshot: () => {}, removeDocument: () => {} });
  assert.equal(queue.filterSnapshotDocuments(undefined), undefined);
  assert.equal(queue.filterSnapshotDocuments(null), null);
});
