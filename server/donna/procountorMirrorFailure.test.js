// §E-2 observability hardening — the resilient writeback-failure trace.
//
// A Procountor writeback failure must ALWAYS leave a durable, queryable
// procountor_journal_mirrors row, and it must NEVER let a mirror-insert throw
// swallow the original API error (the "no DB trace" hunt that cost six probes on
// 2026-07-09; the #875 pkey collision was exactly such a throw). These tests pin
// that guarantee via the injectable-deps seam — no live DB.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  __persistProcountorMirrorFailure,
  __procountorMirrorFailureAnnotation
} from './firmDb.js';

const BASE = {
  firmId: 'firm_1',
  clientId: 'client_1',
  connection: { id: 'conn_1' },
  journal: { id: 'jr_1', source_type: 'transaction', source_id: 'txn_9' },
  docNumber: 'W-abc',
  lastError: 'No open financial year',
  request: { type: 'JOURNAL' },
  response: { code: 'MUST_NOT_BE_NULL' }
};

const recordId = (...parts) => `id-${parts.join('|')}`;

test('happy path: full persist succeeds, minimal fallback is NOT invoked', async () => {
  const calls = { persist: 0, query: 0 };
  await __persistProcountorMirrorFailure({
    ...BASE,
    deps: {
      persist: async (args) => {
        calls.persist += 1;
        assert.equal(args.status, 'error');
        assert.equal(args.lastError, 'No open financial year');
        assert.deepEqual(args.request, { type: 'JOURNAL' });
      },
      query: async () => { calls.query += 1; },
      recordId
    }
  });
  assert.equal(calls.persist, 1);
  assert.equal(calls.query, 0, 'no fallback when the full persist succeeds');
});

test('inner persist throws: falls back to a minimal row, does NOT rethrow', async () => {
  let queryArgs = null;
  await assert.doesNotReject(() => __persistProcountorMirrorFailure({
    ...BASE,
    deps: {
      persist: async () => { throw new Error('pkey 23505'); },
      query: async (sql, params) => { queryArgs = { sql, params }; },
      recordId
    }
  }));

  assert.ok(queryArgs, 'the minimal fallback insert ran');
  assert.match(queryArgs.sql, /insert into procountor_journal_mirrors/);
  assert.match(queryArgs.sql, /on conflict \(connection_id, journal_id\)/);

  const [id, connectionId, firmId, clientId, journalId, sourceType, sourceId, lastError] = queryArgs.params;
  assert.equal(id, 'id-journal-mirror|conn_1|jr_1');
  assert.equal(connectionId, 'conn_1');
  assert.equal(firmId, 'firm_1');
  assert.equal(clientId, 'client_1');
  assert.equal(journalId, 'jr_1');
  assert.equal(sourceType, 'transaction');
  assert.equal(sourceId, 'txn_9');
  // The fallback last_error keeps BOTH the API error and why the full persist died.
  assert.match(lastError, /No open financial year/);
  assert.match(lastError, /mirror persist failed: pkey 23505/);
});

test('double failure (persist AND fallback throw) still does NOT rethrow', async () => {
  await assert.doesNotReject(() => __persistProcountorMirrorFailure({
    ...BASE,
    deps: {
      persist: async () => { throw new Error('boom-1'); },
      query: async () => { throw new Error('boom-2'); },
      recordId
    }
  }), 'the wrapper must never throw — the caller re-throws the original API error');
});

test('missing lastError defaults to a stable message', async () => {
  let params = null;
  await __persistProcountorMirrorFailure({
    ...BASE,
    lastError: null,
    deps: {
      persist: async () => { throw new Error('db down'); },
      query: async (_sql, p) => { params = p; },
      recordId
    }
  });
  assert.match(params[7], /Procountor writeback failed\./);
});

test('annotation carries both errors and caps at 4000 chars', () => {
  const annotated = __procountorMirrorFailureAnnotation('api boom', new Error('persist boom'));
  assert.match(annotated, /^api boom \[mirror persist failed: persist boom\]$/);

  const long = __procountorMirrorFailureAnnotation('x'.repeat(5000), new Error('y'));
  assert.equal(long.length, 4000);

  // A non-Error second arg (e.g. a thrown string) degrades gracefully.
  assert.match(__procountorMirrorFailureAnnotation(null, 'raw string'), /Procountor writeback failed\. \[mirror persist failed: raw string\]/);
});
