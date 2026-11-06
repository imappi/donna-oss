// Donna Loops — loop_event_inbox unit tests. Load-bearing properties:
//   - at-least-once dedupe on (source, source_event_id)
//   - FOR UPDATE SKIP LOCKED claim, attempts bump, processing deadline
//   - worker-death recovery (stale processing → requeue under cap / fail over)

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  insertLoopEvent, claimPendingEvent, markProcessed, markFailed, markIgnored,
  reclaimStaleProcessingEvents, buildPayloadHash, LOOP_INBOX_STATUSES
} from './loopEventInbox.js';

const makeMockClient = (responders = []) => {
  const calls = [];
  const queue = [...responders];
  return {
    calls,
    query: async (sql, params) => {
      calls.push({ sql: String(sql), params });
      const text = String(sql).toLowerCase();
      if (text === 'begin' || text === 'commit' || text === 'rollback') return { rows: [] };
      const idx = queue.findIndex((r) => text.includes(r.match));
      if (idx !== -1) {
        const [r] = queue.splice(idx, 1);
        if (r.throw) throw r.throw;
        return { rows: r.rows || [] };
      }
      return { rows: [] };
    }
  };
};

test('insertLoopEvent: inserts once; duplicate returns the existing id', async () => {
  const fresh = makeMockClient([{ match: 'insert into loop_event_inbox', rows: [{ id: 'loop-inbox-1' }] }]);
  const first = await insertLoopEvent({
    client: fresh, firmId: 'firm-1', clientId: 'c-1',
    source: 'client_portal', sourceEventId: 'reply-9', eventType: 'client_reply.received', payload: { a: 1 }
  });
  assert.deepEqual(first, { id: 'loop-inbox-1', inserted: true });
  assert.match(fresh.calls[0].sql, /on conflict \(source, source_event_id\) do nothing/);

  const dup = makeMockClient([
    { match: 'insert into loop_event_inbox', rows: [] },                 // ON CONFLICT DO NOTHING → no row
    { match: 'select id from loop_event_inbox', rows: [{ id: 'loop-inbox-1' }] }
  ]);
  const second = await insertLoopEvent({
    client: dup, firmId: 'firm-1', clientId: 'c-1',
    source: 'client_portal', sourceEventId: 'reply-9', eventType: 'client_reply.received'
  });
  assert.deepEqual(second, { id: 'loop-inbox-1', inserted: false });
});

test('insertLoopEvent: missing required fields → null, no query', async () => {
  const c = makeMockClient();
  assert.equal(await insertLoopEvent({ client: c, firmId: 'f', clientId: 'c', source: '', sourceEventId: 'x', eventType: 'y' }), null);
  assert.equal(await insertLoopEvent({ client: c, firmId: 'f', clientId: 'c', source: 's', sourceEventId: '', eventType: 'y' }), null);
  assert.equal(await insertLoopEvent({ client: c, firmId: 'f', clientId: 'c', source: 's', sourceEventId: 'x', eventType: '' }), null);
  assert.equal(c.calls.length, 0);
});

test('buildPayloadHash: stable for identical payloads', () => {
  assert.equal(buildPayloadHash({ a: 1, b: 2 }), buildPayloadHash({ a: 1, b: 2 }));
  assert.notEqual(buildPayloadHash({ a: 1 }), buildPayloadHash({ a: 2 }));
});

test('claimPendingEvent: FOR UPDATE SKIP LOCKED, transitions to processing, bumps attempts', async () => {
  const c = makeMockClient([{ match: "set status = 'processing'", rows: [{ id: 'loop-inbox-1', status: 'processing' }] }]);
  const row = await claimPendingEvent({ client: c, workerId: 'w1' });
  assert.equal(row.id, 'loop-inbox-1');
  assert.match(c.calls[0].sql, /for update skip locked/i);
  assert.match(c.calls[0].sql, /attempts = attempts \+ 1/);
  assert.match(c.calls[0].sql, /processing_deadline_at = now\(\)/);
});

test('claimPendingEvent: nothing pending → null', async () => {
  const c = makeMockClient([{ match: "set status = 'processing'", rows: [] }]);
  assert.equal(await claimPendingEvent({ client: c }), null);
});

test('markProcessed / markFailed / markIgnored set the right status', async () => {
  const p = makeMockClient([{ match: "status = 'processed'", rows: [{ id: 'x' }] }]);
  assert.equal(await markProcessed({ client: p, eventId: 'x' }), true);
  assert.match(p.calls[0].sql, /processed_at = now\(\)/);

  const f = makeMockClient([{ match: "status = 'failed'", rows: [{ id: 'x' }] }]);
  assert.equal(await markFailed({ client: f, eventId: 'x', error: new Error('boom') }), true);
  assert.match(JSON.stringify(f.calls[0].params), /boom/);

  const ig = makeMockClient([{ match: "status = 'ignored'", rows: [{ id: 'x' }] }]);
  assert.equal(await markIgnored({ client: ig, eventId: 'x', reason: 'dup' }), true);
  assert.match(JSON.stringify(ig.calls[0].params), /dup/);
});

test('reclaimStaleProcessingEvents: requeues under the cap, fails over it', async () => {
  const c = makeMockClient([
    { match: "set status = 'pending'", rows: [{ id: 'a' }] },
    { match: "set status = 'failed'", rows: [{ id: 'b' }, { id: 'c' }] }
  ]);
  const out = await reclaimStaleProcessingEvents({ client: c, maxAttempts: 5 });
  assert.deepEqual(out, { requeued: 1, failed: 2 });
  assert.match(c.calls[0].sql, /processing_deadline_at < now\(\)/);
  assert.match(c.calls[0].sql, /attempts < \$1/);
  assert.match(c.calls[1].sql, /attempts >= \$1/);
});

test('LOOP_INBOX_STATUSES vocabulary', () => {
  assert.deepEqual(LOOP_INBOX_STATUSES, ['pending', 'processing', 'processed', 'failed', 'ignored']);
});
