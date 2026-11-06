// Donna Loops — loop_event_outbox unit tests. Load-bearing property:
//   - Phase 1 enqueues pending rows but NEVER marks anything 'dispatched'
//     (that status is reserved for a real side effect emitted in later phases).

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  dropOutboxRow,
  enqueueOutbox,
  failOutboxRow,
  listPendingOutboxForDebug,
  LOOP_OUTBOX_STATUSES
} from './loopEventOutbox.js';

const makeMockClient = (responders = []) => {
  const calls = [];
  const queue = [...responders];
  return {
    calls,
    query: async (sql, params) => {
      calls.push({ sql: String(sql), params });
      const text = String(sql).toLowerCase();
      const idx = queue.findIndex((r) => text.includes(r.match));
      if (idx !== -1) {
        const [r] = queue.splice(idx, 1);
        const rows = r.rows || [];
        return { rows, rowCount: rows.length };
      }
      return { rows: [] };
    }
  };
};

test('enqueueOutbox: inserts a pending row', async () => {
  const c = makeMockClient([{ match: 'insert into loop_event_outbox', rows: [{ id: 'loop-outbox-1' }] }]);
  const out = await enqueueOutbox({ client: c, firmId: 'f', clientId: 'cl', eventType: 'case.waiting_client' });
  assert.deepEqual(out, { id: 'loop-outbox-1' });
  assert.match(c.calls[0].sql, /'pending'/);
});

test('enqueueOutbox: missing event type → null, no query', async () => {
  const c = makeMockClient();
  assert.equal(await enqueueOutbox({ client: c, firmId: 'f', clientId: 'cl', eventType: '' }), null);
  assert.equal(c.calls.length, 0);
});

test('Phase 1 has no mutating dispatcher: the debug lister leaves rows pending', async () => {
  const c = makeMockClient([{ match: 'select id, firm_id, client_id, event_type', rows: [{ id: 'loop-outbox-1', status: 'pending' }] }]);
  const rows = await listPendingOutboxForDebug({ client: c, firmId: 'f' });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 'pending');
  assert.ok(!c.calls.some((q) => /dispatched/.test(q.sql)), 'never writes dispatched in Phase 1');
});

test('LOOP_OUTBOX_STATUSES vocabulary', () => {
  assert.deepEqual(LOOP_OUTBOX_STATUSES, ['pending', 'dispatching', 'dispatched', 'failed', 'cancelled']);
});

test('failOutboxRow keeps the machine-readable error code and details', async () => {
  const c = makeMockClient([{ match: "set status = 'failed'", rows: [{ id: 'loop-outbox-1' }] }]);
  const error = new Error('draft became stale');
  error.code = 'ASK_BATCH_STALE_DURING_DRAFT';
  error.details = {
    phase: 'draft',
    stale_transaction_ids: ['tx-held-1'],
    stale_transaction_ids_by_lane: { held_match: ['tx-held-1'] }
  };

  assert.equal(await failOutboxRow({
    client: c,
    id: 'loop-outbox-1',
    error,
    asOf: '2026-08-28T12:34:00Z'
  }), true);
  const call = c.calls[0];
  assert.match(call.sql, /'code', nullif\(\$4::text, ''\)/);
  assert.match(call.sql, /'details', \$5::jsonb/);
  assert.equal(call.params[3], 'ASK_BATCH_STALE_DURING_DRAFT');
  assert.deepEqual(JSON.parse(call.params[4]), error.details);
});

test('dropOutboxRow preserves the final failure as the cancellation cause', async () => {
  const c = makeMockClient([{ match: "set status = 'cancelled'", rows: [{ id: 'loop-outbox-1' }] }]);
  assert.equal(await dropOutboxRow({
    client: c,
    id: 'loop-outbox-1',
    reason: 'max_attempts',
    expectedStatus: 'failed',
    asOf: '2026-08-28T12:35:00Z'
  }), true);
  assert.match(c.calls[0].sql, /'previous_error', case/);
  assert.match(c.calls[0].sql, /else last_error end/);
});
