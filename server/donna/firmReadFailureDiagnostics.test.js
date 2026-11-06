import test from 'node:test';
import assert from 'node:assert/strict';
import { requestDonnaApi } from './testSupport/apiSeamHarness.js';
import { buildFirmReadFailureDiagnostic } from './firmReadFailureDiagnostics.js';
import { readFirmDbPoolCounts, __resetFirmDbPoolForTests, __setFirmDbPoolForTests, closeFirmDbPool } from './db/pool.js';

test('actual snapshot/report route failures log safe diagnostics and preserve their HTTP response', async () => {
  const previous = Object.fromEntries(['DATABASE_URL', 'DONNA_ACCESS_TOKEN'].map(key => [key, process.env[key]]));
  const originalError = console.error;
  const logs = [];
  console.error = (...args) => logs.push(args);
  process.env.DATABASE_URL = 'postgresql://synthetic:private-password@localhost/synthetic';
  process.env.DONNA_ACCESS_TOKEN = 'synthetic-read-diagnostic-token';
  try {
    for (const [path, route] of [['/snapshot', 'snapshot'], ['/reports/financial-statements', 'financial_statements'], ['/', 'snapshot']]) {
      logs.length = 0;
      let checkouts = 0, queries = 0;
      const failure = Object.assign(new Error('timeout exceeded when trying to connect'), {
        stack: 'private-stack', query: 'private-query', detail: 'private-detail', cause: new Error('private-cause')
      });
      const pool = { totalCount: 2, idleCount: 0, waitingCount: 3, options: { max: 2, password: 'private-password' },
        connect: async () => { checkouts += 1; throw failure; }, query: async () => { queries += 1; throw failure; } };
      const result = await requestDonnaApi({ url: `/api/donna/firms${path}?client_id=private-client&firm_id=private-firm`, pool,
        headers: { authorization: 'Bearer synthetic-read-diagnostic-token' } });
      assert.equal(result.statusCode, 500);
      assert.deepEqual(result.json, { error: failure.message });
      assert.equal(checkouts, 1);
      assert.equal(queries, 0, 'diagnosis cannot query the failing pool');
      assert.equal(logs.length, 1);
      assert.equal(logs[0][0], '[firm-read] failed');
      assert.deepEqual({ ...logs[0][1], elapsed_ms: 0 }, { route, status: 500, error_code: 'UNKNOWN', error_name: 'Error',
        classification: 'pool_acquire_timeout', elapsed_ms: 0, pool: { total: 2, idle: 0, waiting: 3, max: 2 } });
      assert.ok(Number.isInteger(logs[0][1].elapsed_ms) && logs[0][1].elapsed_ms >= 0);
      assert.doesNotMatch(JSON.stringify(logs), /private-|synthetic-read-diagnostic-token|timeout exceeded/);
    }
  } finally {
    console.error = originalError;
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});

test('classification is a closed vocabulary and never serializes untrusted error or pool fields', () => {
  const diagnostic = (error, extra = {}) => buildFirmReadFailureDiagnostic({ method: 'GET', pathname: '/snapshot', status: 500,
    error, elapsedMs: 12.8, ...extra });
  const poison = 'private-password-client-token-query';
  const result = diagnostic({ name: poison, code: poison, message: poison, stack: poison, cause: { code: 'ECONNRESET', message: poison } },
    { pool: { total: poison, idle: -1, waiting: NaN, max: Infinity, query: poison } });
  assert.deepEqual(result, { route: 'snapshot', status: 500, error_code: 'UNKNOWN', error_name: 'Error', classification: 'unclassified',
    elapsed_ms: 12, pool: { total: null, idle: null, waiting: null, max: null } });
  assert.doesNotMatch(JSON.stringify(result), /private/);
  for (const [code, classification] of [['ECONNRESET', 'transport_reset'], ['ETIMEDOUT', 'transport_timeout'],
    ['53300', 'database_connections_exhausted'], ['57014', 'database_query_cancelled'], ['40P01', 'database_deadlock'],
    ['40001', 'database_serialization_failure']]) {
    assert.equal(diagnostic({ code, message: poison }).classification, classification);
    assert.equal(diagnostic({ code, message: poison }).error_code, code);
  }
  assert.equal(diagnostic({ message: 'Connection terminated due to connection timeout' }).classification, 'db_connect_timeout');
  assert.equal(diagnostic({ message: 'Connection terminated unexpectedly' }).classification, 'transport_closed');
  assert.equal(diagnostic({ message: `timeout exceeded when trying to connect ${poison}` }).classification, 'unclassified', 'only exact known messages classify');
  assert.equal(diagnostic(new TypeError(poison)).error_name, 'TypeError');
  for (const extra of [{ method: 'POST' }, { pathname: '/feed' }, { pathname: '/snapshot/private-client' },
    { status: 200 }, { status: 403 }, { status: poison }]) assert.equal(diagnostic({}, extra), null);
});

test('pool diagnostic is synchronous, noninitializing and clears with reset/close', async () => {
  __resetFirmDbPoolForTests();
  assert.equal(readFirmDbPoolCounts(), null, 'uninitialized pool is not created by diagnostics');
  let io = 0;
  const pool = { totalCount: 2, idleCount: 1, waitingCount: 0, options: { max: 2 },
    connect() { io += 1; throw new Error('must not acquire'); }, query() { io += 1; throw new Error('must not query'); },
    end: async () => { io += 1; } };
  try {
    __setFirmDbPoolForTests(pool);
    assert.deepEqual(readFirmDbPoolCounts(), { total: 2, idle: 1, waiting: 0, max: 2 });
    pool.waitingCount = 4;
    assert.equal(readFirmDbPoolCounts().waiting, 4, 'counts reflect the current process, not a cached verdict');
    assert.equal(io, 0);
    await closeFirmDbPool();
    assert.equal(io, 1, 'only the explicit close owns I/O');
    assert.equal(readFirmDbPoolCounts(), null);
  } finally { __resetFirmDbPoolForTests(); }
});

test('real router logs no unrelated/4xx failures, redacts poisoned errors, and survives a broken logger', async () => {
  const previous = Object.fromEntries(['DATABASE_URL', 'DONNA_ACCESS_TOKEN'].map(key => [key, process.env[key]]));
  const originalError = console.error;
  const logs = [];
  process.env.DATABASE_URL = 'postgresql://synthetic:private-password@localhost/synthetic';
  process.env.DONNA_ACCESS_TOKEN = 'synthetic-read-diagnostic-token';
  const poison = 'private-password-client-token-query';
  try {
    for (const [path, status, brokenLogger] of [['/snapshot', 503, false], ['/reports/financial-statements', 500, false],
      ['/snapshot', 403, false], ['/feed', 500, false], ['/snapshot', 500, true]]) {
      logs.length = 0;
      console.error = (...args) => { if (brokenLogger) throw new Error(poison); logs.push(args); };
      const failure = Object.assign(new Error(poison), { name: poison, code: poison, statusCode: status,
        details: { retainedResponse: poison }, cause: { code: 'ECONNRESET', password: poison } });
      const pool = { connect: async () => { throw failure; }, query: async () => { throw failure; } };
      const result = await requestDonnaApi({ url: `/api/donna/firms${path}?client_id=${poison}`, pool,
        headers: { authorization: 'Bearer synthetic-read-diagnostic-token' } });
      assert.equal(result.statusCode, status);
      assert.deepEqual(result.json, { error: poison, code: poison, details: { retainedResponse: poison } }, 'existing authorized error response is unchanged');
      assert.equal(logs.length, status < 500 || path === '/feed' || brokenLogger ? 0 : 1);
      assert.doesNotMatch(JSON.stringify(logs), /private-|ECONNRESET/);
      if (logs.length) assert.equal(logs[0][1].classification, 'unclassified');
    }
  } finally {
    console.error = originalError;
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});
