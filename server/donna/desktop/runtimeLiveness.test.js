// runtimeLivenessProbe — the watchdog's wedge oracle. The rails: a healthy
// pool answers 200 fast; a starved/hung pool is BOUNDED by the probe's own
// timeout (never an unbounded await — the wedge it detects would otherwise
// wedge the detector); a DB error is a 503 with a coded reason; and an
// unconfigured DB is a config state, never a kill invitation.

import test from 'node:test';
import assert from 'node:assert/strict';

import { runtimeLivenessProbe } from './runtimeLiveness.js';

test('healthy db → 200 ok with db_ms', async () => {
  const result = await runtimeLivenessProbe({
    queryFn: async (sql) => {
      assert.equal(sql, 'select 1');
      return { rows: [{ '?column?': 1 }] };
    }
  });
  assert.equal(result.status, 200);
  assert.equal(result.body.ok, true);
  assert.equal(result.body.db_ok, true);
  assert.equal(typeof result.body.db_ms, 'number');
});

test('a hung pool is bounded by the probe timeout → 503 db_timeout', async () => {
  const startedAt = Date.now();
  const result = await runtimeLivenessProbe({
    queryFn: () => new Promise(() => {}), // never settles — the wedge shape
    timeoutMs: 50
  });
  assert.ok(Date.now() - startedAt < 2000, 'answered promptly despite the hung query');
  assert.equal(result.status, 503);
  assert.equal(result.body.ok, false);
  assert.equal(result.body.db_ok, false);
  assert.equal(result.body.reason, 'db_timeout');
});

test('a db error → 503 db_error with a bounded detail', async () => {
  const result = await runtimeLivenessProbe({
    queryFn: async () => { throw new Error('timeout exceeded when trying to connect'); }
  });
  assert.equal(result.status, 503);
  assert.equal(result.body.reason, 'db_error');
  assert.match(result.body.detail, /trying to connect/);
});

test('no configured db is a config state, not a wedge → 200', async () => {
  const result = await runtimeLivenessProbe({
    queryFn: async () => { throw new Error('must not be called'); },
    databaseConfigured: false
  });
  assert.equal(result.status, 200);
  assert.equal(result.body.ok, true);
  assert.equal(result.body.db_ok, null);
  assert.equal(result.body.reason, 'db_not_configured');
});
