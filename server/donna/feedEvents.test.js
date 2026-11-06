// /feed-events projection (Slice 1 of the realtime-truthful-feedback arc,
// docs/design-realtime-truthful-feedback.md) — unit tests.
//
// Load-bearing properties:
//   - SANITIZED: only whitelisted metadata keys reach the browser; parse_error
//     internals collapse to a boolean;
//   - bootstrap (no cursors) returns current high-water marks and NO rows —
//     the tick never replays history the snapshot already rendered;
//   - the cursor advances only as far as returned rows, so a limit-clipped
//     page resumes where it stopped;
//   - read-side only: the module takes a query function and issues SELECTs —
//     nothing here mutates.

import assert from 'node:assert/strict';
import test from 'node:test';

import { __sanitizeFeedEvent, buildFeedEventsFromDb } from './feedEvents.js';

test('sanitizer keeps whitelisted metadata keys and drops the rest', () => {
  const out = __sanitizeFeedEvent({
    id: '42',
    action: 'transaction.feed_chat_apply',
    actor_type: 'firm_member',
    actor_id: 'kari@books.example',
    resource_type: 'feed_chat',
    resource_id: 'msg-1',
    created_at: '2026-07-03T10:00:00.000Z',
    metadata: {
      action_type: 'apply_category',
      requested: 2,
      applied: 2,
      failed: 0,
      account_name: 'Marketing',
      internal_prompt: 'NEVER-SHIP-THIS',
      db_error_stack: 'NEVER-SHIP-THIS'
    }
  });
  assert.equal(out.id, 42);
  assert.equal(out.actor_id, 'kari@books.example');
  assert.deepEqual(out.metadata, {
    action_type: 'apply_category',
    requested: 2,
    applied: 2,
    failed: 0,
    account_name: 'Marketing'
  });
});

test('sanitizer tolerates absent/odd metadata', () => {
  assert.deepEqual(__sanitizeFeedEvent({ id: 1, action: 'x' }).metadata, {});
  assert.deepEqual(__sanitizeFeedEvent({ id: 1, action: 'x', metadata: null }).metadata, {});
});

test('bootstrap returns high-water marks and no rows', async () => {
  const calls = [];
  const query = async (sql, params) => {
    calls.push({ sql, params });
    return { rows: [{ max_event_id: '77', ts: '2026-07-03T12:00:00.000Z' }] };
  };
  const out = await buildFeedEventsFromDb({
    firmId: 'firm-1',
    clientId: 'client-1',
    query
  });
  assert.equal(calls.length, 1);
  assert.match(calls[0].sql, /max\(id\)/);
  assert.deepEqual(out.events, []);
  assert.deepEqual(out.documents, []);
  assert.deepEqual(out.transactions, []);
  assert.deepEqual(out.cursor, { event_id: 77, ts: '2026-07-03T12:00:00.000Z' });
});

test('incremental poll returns sanitized rows and advances both cursor legs', async () => {
  const query = async (sql, params) => {
    if (/from audit_events/.test(sql)) {
      assert.deepEqual(params, ['firm-1', 'client-1', 10, 200]);
      return {
        rows: [
          { id: '11', action: 'chat.proposal_minted', metadata: { surface: 'feed_chat', secret: 'x' }, created_at: '2026-07-03T12:00:01.000Z' },
          { id: '12', action: 'transaction.feed_chat_apply', metadata: { applied: 1 }, created_at: '2026-07-03T12:00:02.000Z' }
        ]
      };
    }
    if (/from documents/.test(sql)) {
      return {
        rows: [{
          id: 'doc-1',
          parse_status: 'processing',
          parse_stage: 'extracting',
          parse_progress_current: 1,
          parse_progress_total: 3,
          parse_error: { message: 'boom', stack: 'NEVER-SHIP-THIS' },
          updated_at: '2026-07-03T12:00:05.000Z'
        }]
      };
    }
    return { rows: [{ id: 'tx-1', updated_at: '2026-07-03T12:00:03.000Z' }] };
  };
  const out = await buildFeedEventsFromDb({
    firmId: 'firm-1',
    clientId: 'client-1',
    sinceEventId: 10,
    sinceTs: '2026-07-03T12:00:00.000Z',
    query
  });
  assert.equal(out.events.length, 2);
  assert.deepEqual(out.events[0].metadata, { surface: 'feed_chat' });
  assert.equal(out.documents[0].has_parse_error, true);
  assert.equal(out.documents[0].parse_error, undefined);
  assert.equal(out.transactions[0].id, 'tx-1');
  // event leg advances to the last returned id; ts leg to the max updated_at
  // across the documents/transactions legs (documents here).
  assert.deepEqual(out.cursor, { event_id: 12, ts: '2026-07-03T12:00:05.000Z' });
});

test('empty poll keeps the cursor where it was', async () => {
  const query = async () => ({ rows: [] });
  const out = await buildFeedEventsFromDb({
    firmId: 'firm-1',
    clientId: 'client-1',
    sinceEventId: 99,
    sinceTs: '2026-07-03T12:00:00.000Z',
    query
  });
  assert.deepEqual(out.cursor, { event_id: 99, ts: '2026-07-03T12:00:00.000Z' });
});

test('rejects bad cursors and half-cursors with 400s', async () => {
  const query = async () => ({ rows: [] });
  await assert.rejects(
    buildFeedEventsFromDb({ firmId: 'f', clientId: 'c', sinceEventId: 'abc', sinceTs: '2026-07-03T12:00:00.000Z', query }),
    (error) => error.statusCode === 400
  );
  await assert.rejects(
    buildFeedEventsFromDb({ firmId: 'f', clientId: 'c', sinceEventId: 5, sinceTs: 'not-a-date', query }),
    (error) => error.statusCode === 400
  );
  await assert.rejects(
    buildFeedEventsFromDb({ firmId: 'f', clientId: 'c', sinceEventId: 5, query }),
    (error) => error.statusCode === 400
  );
  await assert.rejects(
    buildFeedEventsFromDb({ firmId: 'f', clientId: 'c', query: undefined }),
    /query function/
  );
  await assert.rejects(
    buildFeedEventsFromDb({ firmId: 'f', query }),
    (error) => error.statusCode === 400
  );
});

test('limit is clamped to the max page size', async () => {
  const seen = [];
  const query = async (sql, params) => {
    seen.push(params[3]);
    return { rows: [] };
  };
  await buildFeedEventsFromDb({
    firmId: 'firm-1',
    clientId: 'client-1',
    sinceEventId: 0,
    sinceTs: '2026-07-03T12:00:00.000Z',
    limit: 999999,
    query
  });
  assert.ok(seen.every((n) => n === 500));
});
