import test from 'node:test';
import assert from 'node:assert/strict';

import { requestDonnaApi } from './testSupport/apiSeamHarness.js';

const TOKEN = 'api-seam-token';
const priorToken = process.env.DONNA_ACCESS_TOKEN;
process.env.DONNA_ACCESS_TOKEN = TOKEN;

test.after(() => {
  if (priorToken === undefined) delete process.env.DONNA_ACCESS_TOKEN;
  else process.env.DONNA_ACCESS_TOKEN = priorToken;
});

await test('API seam refuses a missing or incorrect bearer', async () => {
  const missing = await requestDonnaApi({ url: '/api/donna/firms/not-a-route' });
  assert.equal(missing.statusCode, 401);
  assert.equal(missing.json?.error, 'Access token required.');

  const wrong = await requestDonnaApi({
    url: '/api/donna/firms/not-a-route',
    headers: { authorization: 'Bearer wrong-token' }
  });
  assert.equal(wrong.statusCode, 401);
  assert.equal(wrong.json?.error, 'Access token required.');
});

await test('API seam lets a valid bearer reach the real firms router envelope', async () => {
  const response = await requestDonnaApi({
    url: '/api/donna/firms/not-a-route',
    headers: { authorization: `Bearer ${TOKEN}` }
  });
  assert.equal(response.statusCode, 405);
  assert.deepEqual(response.json, { error: 'Method not allowed' });
  assert.match(response.headers['content-type'], /application\/json/);
});

await test('API seam separates pool calls and physical transaction/savepoint state', async () => {
  const { createApiSeamPool } = await import('./testSupport/apiSeamHarness.js');
  const { withConvergenceTransaction, isConvergencePool } = await import('./convergenceConnection.js');
  const failure = Object.assign(new Error('fixture statement failed'), { code: '23514' });
  const pool = createApiSeamPool([[/^select fail$/, () => { throw failure; }]]);
  assert.equal(isConvergencePool(pool), true);
  const first = await pool.connect(), second = await pool.connect();
  assert.notEqual(first.connection, second.connection);
  assert.equal(isConvergencePool(first), false);
  assert.equal(pool.totalCount, 2);
  await first.query('begin');
  await first.query('savepoint outer_probe');
  await assert.rejects(second.query('savepoint other_probe'), { code: '25P01' });
  await assert.rejects(first.query('select fail'), error => error === failure);
  await assert.rejects(first.query('select 1'), { code: '25P02' });
  await first.query('rollback to savepoint outer_probe');
  await first.query('select 1');
  await first.query('savepoint inner_probe');
  await first.query('release savepoint outer_probe');
  await assert.rejects(first.query('rollback to savepoint inner_probe'), { code: '3B001' });
  await first.query('rollback');
  await assert.rejects(first.query('savepoint after_rollback'), { code: '25P01' });
  await first.query('begin');
  await first.query('commit');
  await assert.rejects(first.query('savepoint after_commit'), { code: '25P01' });
  first.release(); second.release();
  assert.equal(pool.totalCount, 0);
  await assert.rejects(first.query('select 1'), /after checkout release/);
  await pool.query('begin');
  await assert.rejects(pool.query('savepoint cannot_cross_checkout'), { code: '25P01' });
  const before = pool.checkouts.length;
  await withConvergenceTransaction(pool, async raw => {
    await raw.query('select 1');
    await withConvergenceTransaction(raw, async nested => nested.query('select 2'));
  });
  assert.equal(pool.checkouts.length, before + 1, 'nested owner reuses one physical checkout');
  assert.equal(pool.totalCount, 0, 'the real owner releases its borrowed checkout');
  assert.equal(pool.matching(/^commit$/).length, 2);
});
