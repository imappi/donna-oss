// Donna Inventory I4·posting — P7 §12 waiter drain: the READ-ONLY driver (fake-pg). Asserts the
// driver is strictly READ-ONLY (every query a SELECT), the open-waiter-head + retry-count wiring,
// and the plan/summary it returns.
//   node --test server/donna/inventory/postingWaiterDb.test.js

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  readOpenWaiterHeads, readIntegrationRetryCounts, gatherWaiterState, planInventoryWaiterDrain
} from './postingWaiterDb.js';
import { DEFAULT_RETRY_BACKOFF_MS } from './postingWaiters.js';

const T0 = '2026-07-12T00:00:00.000Z';

// Fake pg: seeds the heads SELECT + the retry-count SELECT (distinguished by table), records every
// query so we can assert SELECT-only.
const fake = ({ heads = [], retryCounts = [], throwCode = null } = {}) => {
  const queries = [];
  return {
    queries,
    async query(sql, params = []) {
      queries.push({ sql, params });
      if (throwCode) { const e = new Error('missing'); e.code = throwCode; throw e; }
      if (sql.includes('from inventory_posting_heads')) return { rows: heads };
      if (sql.includes('from inventory_posting_attempts')) return { rows: retryCounts };
      return { rows: [] };
    }
  };
};

test('driver is READ-ONLY — every query is a SELECT', async () => {
  const tx = fake({ heads: [{ operation_id: 'op1', posting_kind: 'receipt', waiter_type: 'integration_system_retry', created_at: T0 }], retryCounts: [{ operation_id: 'op1', posting_kind: 'receipt', retry_count: 1 }] });
  await planInventoryWaiterDrain({ client: tx, firmId: 'f1', clientId: 'c1', now: new Date(T0) });
  assert.ok(tx.queries.length >= 2);
  for (const q of tx.queries) assert.match(q.sql.trim().toLowerCase(), /^select/, `read-only: ${q.sql.slice(0, 40)}`);
});

test('readOpenWaiterHeads selects drainable, waitered heads only', async () => {
  const tx = fake({ heads: [] });
  await readOpenWaiterHeads(tx, 'f1', 'c1');
  const q = tx.queries[0];
  assert.match(q.sql, /from inventory_posting_heads/);
  assert.match(q.sql, /waiter_type is not null/);
  assert.match(q.sql, /outcome = any\(\$3\)/);
  assert.deepEqual(q.params[2], ['refused', 'integration_wait', 'blocked_locked_period']);
});

test('readIntegrationRetryCounts groups integration-retry attempts per (operation, kind)', async () => {
  const tx = fake({ retryCounts: [{ operation_id: 'op1', posting_kind: 'receipt', retry_count: 3 }] });
  const counts = await readIntegrationRetryCounts(tx, 'f1', 'c1');
  assert.equal(counts.get('op1::receipt'), 3);
  assert.match(tx.queries[0].sql, /waiter_type = 'integration_system_retry'/);
  assert.match(tx.queries[0].sql, /group by operation_id, posting_kind/);
});

test('gatherWaiterState joins each head to its retry count (0 when none)', async () => {
  const tx = fake({
    heads: [
      { operation_id: 'op1', posting_kind: 'receipt', waiter_type: 'integration_system_retry', created_at: T0 },
      { operation_id: 'op2', posting_kind: 'write_down', waiter_type: 'engineering_incident', created_at: T0 }
    ],
    retryCounts: [{ operation_id: 'op1', posting_kind: 'receipt', retry_count: 2 }]
  });
  const state = await gatherWaiterState({ client: tx, firmId: 'f1', clientId: 'c1' });
  assert.equal(state.length, 2);
  assert.equal(state.find((s) => s.attempt.operation_id === 'op1').retryCount, 2);
  assert.equal(state.find((s) => s.attempt.operation_id === 'op2').retryCount, 0);
});

test('planInventoryWaiterDrain returns the mapped plan + disposition summary', async () => {
  const tx = fake({
    heads: [
      { operation_id: 'op1', posting_kind: 'receipt', waiter_type: 'integration_system_retry', next_action: 'await_fx_fact', created_at: T0 },
      { operation_id: 'op2', posting_kind: 'write_down', waiter_type: 'engineering_incident', created_at: T0 },
      { operation_id: 'op3', posting_kind: 'shipment_cogs', waiter_type: 'accountant_operator', created_at: T0 }
    ],
    retryCounts: [{ operation_id: 'op1', posting_kind: 'receipt', retry_count: 1 }]
  });
  // now = T0 + backoffMs[1] + 1s → op1's retry is DUE.
  const res = await planInventoryWaiterDrain({ client: tx, firmId: 'f1', clientId: 'c1', now: new Date(Date.parse(T0) + DEFAULT_RETRY_BACKOFF_MS[1] + 1000) });
  assert.equal(res.total, 3);
  assert.equal(res.summary.retry, 1);
  assert.equal(res.summary.open_incident, 1);
  assert.equal(res.summary.human_owned, 1);
  assert.equal(res.plans.find((p) => p.operation_id === 'op1').disposition, 'retry');
});

test('degrades to empty (nothing to drain) pre-migration', async () => {
  const res = await planInventoryWaiterDrain({ client: fake({ throwCode: '42P01' }), firmId: 'f1', clientId: 'c1', now: new Date() });
  assert.equal(res.total, 0);
  assert.deepEqual(res.summary, { retry: 0, wait: 0, escalate: 0, open_incident: 0, human_owned: 0 });
});
