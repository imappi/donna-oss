// Slice 3 — the auto-DRAFT request producer + consumer (autonomous-loop demo).
//
// Mock-pg harness (mirrors reconciliationEvalConsumer.test.js — substring handlers with
// rowCount, since the outbox CAS helpers gate on result.rowCount). The draft operation
// itself is injected (draftBatchFn) so these tests pin the consumer's gate / claim /
// dispatch orchestration; the real draft SQL is pinned by askBatch.test.js.
//
// Pins:
//   consumer — canary+ drafts (claim → draft → dispatched); shadow is held (no claim,
//     no draft); nothing_to_ask still dispatches (request satisfied); a vanished client
//     drops; a transient draft error fails (backoff); loops off → a clean skip.
//   producer — a canary firm enqueues a coalesced ask_draft.requested row; a shadow firm
//     does not (no backlog at shadow); an already-pending request is not duplicated.

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  runAskDraftRequest, drainAskDraftRequests, ASK_DRAFT_REQUEST_EVENT
} from './askAutoDraftConsumer.js';
import { onReconcileCompleteRequestAskDraft } from './loopsShadowProducers.js';

const makeMockClient = (handlers = []) => {
  const calls = [];
  return {
    calls,
    query: async (sql, params) => {
      calls.push({ sql: String(sql), params });
      const text = String(sql).trim().toLowerCase();
      if (text === 'begin' || text === 'commit' || text === 'rollback') return { rows: [], rowCount: 0 };
      for (const h of handlers) {
        if (text.includes(h.match)) {
          if (h.throw) throw h.throw;
          const rows = typeof h.rows === 'function' ? h.rows() : (h.rows || []);
          return { rows, rowCount: rows.length };
        }
      }
      return { rows: [], rowCount: 0 };
    }
  };
};

const hasCall = (client, needle) => client.calls.some((c) => c.sql.toLowerCase().includes(needle));

const CANARY_ENV = { LOOPS_TIER: 'canary' };
const CANARY_FIRM = { metadata: { loops: { tier: 'canary' } } };
const SHADOW_FIRM = { metadata: { loops: { tier: 'shadow' } } };

const draftRow = (overrides = {}) => ({
  id: 'ob-1', firm_id: 'firm-1', client_id: 'client-1',
  event_type: ASK_DRAFT_REQUEST_EVENT, object_type: 'client', object_id: 'client-1',
  status: 'pending', attempts: 0, payload: { requested_at: '2026-06-23T10:00:00Z' },
  ...overrides
});

// Consumer outbox-mutation handlers (claim/mark/drop/fail return a row → rowCount 1).
const consumerHandlers = ({ firm = CANARY_FIRM } = {}) => [
  { match: 'select metadata from firms', rows: [firm] },
  { match: "set status = 'dispatching'", rows: [{ id: 'ob-1' }] },
  { match: "set status = 'dispatched'", rows: [{ id: 'ob-1' }] },
  { match: "set status = 'cancelled'", rows: [{ id: 'ob-1' }] },
  { match: "set status = 'failed'", rows: [{ id: 'ob-1' }] }
];

// ── consumer ────────────────────────────────────────────────────────────

await test('canary firm: claims, drafts, marks dispatched', async () => {
  const client = makeMockClient(consumerHandlers());
  let drafted = null;
  const out = await runAskDraftRequest({
    client, row: draftRow(), env: CANARY_ENV,
    draftBatchFn: async (args) => { drafted = args; return { batch: { id: 'ask-batch-x' } }; }
  });
  assert.equal(out.status, 'dispatched');
  assert.equal(out.batchId, 'ask-batch-x');
  assert.equal(drafted.firmId, 'firm-1');
  assert.equal(drafted.clientId, 'client-1');
  assert.equal(drafted.actorId, 'system');
  assert.ok(hasCall(client, "set status = 'dispatching'"), 'claimed the row');
  assert.ok(hasCall(client, "set status = 'dispatched'"), 'marked dispatched');
});

await test('shadow firm: held — no claim, no draft (inert at shadow)', async () => {
  const client = makeMockClient(consumerHandlers({ firm: SHADOW_FIRM }));
  let draftCalled = false;
  const out = await runAskDraftRequest({
    client, row: draftRow(), env: CANARY_ENV,
    draftBatchFn: async () => { draftCalled = true; return { batch: { id: 'x' } }; }
  });
  assert.equal(out.status, 'held');
  assert.equal(draftCalled, false);
  assert.ok(!hasCall(client, "set status = 'dispatching'"), 'never claimed');
});

await test('nothing_to_ask still dispatches — the request is satisfied', async () => {
  const client = makeMockClient(consumerHandlers());
  const out = await runAskDraftRequest({
    client, row: draftRow(), env: CANARY_ENV,
    draftBatchFn: async () => ({ batch: null, reason: 'nothing_to_ask' })
  });
  assert.equal(out.status, 'dispatched');
  assert.equal(out.batchId, null);
  assert.equal(out.reason, 'nothing_to_ask');
  assert.ok(hasCall(client, "set status = 'dispatched'"));
});

await test('a vanished client drops (permanent), never retried', async () => {
  const client = makeMockClient(consumerHandlers());
  const err = new Error('Client was not found.');
  err.code = 'ASK_BATCH_CLIENT_NOT_FOUND';
  err.statusCode = 404;
  const out = await runAskDraftRequest({
    client, row: draftRow(), env: CANARY_ENV,
    draftBatchFn: async () => { throw err; }
  });
  assert.equal(out.status, 'dropped');
  assert.equal(out.reason, 'client_absent');
  assert.ok(hasCall(client, "set status = 'cancelled'"), 'dropped the row');
});

await test('a transient draft error fails the row (backoff to retry)', async () => {
  const client = makeMockClient(consumerHandlers());
  const out = await runAskDraftRequest({
    client, row: draftRow(), env: CANARY_ENV,
    draftBatchFn: async () => { throw new Error('no api key'); }
  });
  assert.equal(out.status, 'failed');
  assert.ok(hasCall(client, "set status = 'failed'"), 'failed the row');
});

await test('drain: loops off → a clean skip', async () => {
  const client = makeMockClient(consumerHandlers());
  const out = await drainAskDraftRequests({ client, env: {} });
  assert.equal(out.skipped, true);
  assert.equal(out.reason, 'loops_off');
});

await test('drain: tables absent → a clean skip', async () => {
  const client = makeMockClient([
    { match: "to_regclass('public.bookkeeping_cases')", rows: [{ present: null }] }
  ]);
  const out = await drainAskDraftRequests({ client, env: CANARY_ENV });
  assert.equal(out.skipped, true);
  assert.equal(out.reason, 'tables_absent');
});

await test('drain: canary firm drafts each pending request, tallies dispatched', async () => {
  const client = makeMockClient([
    { match: "to_regclass('public.bookkeeping_cases')", rows: [{ present: 'bookkeeping_cases' }] },
    // Two DIFFERENT clients ⇒ two different serialization lanes ⇒ both draft.
    // (object_id is the lane key, so it must move with client_id.)
    { match: 'from loop_event_outbox', rows: [
      draftRow(), draftRow({ id: 'ob-2', client_id: 'client-2', object_id: 'client-2' })
    ] },
    ...consumerHandlers()
  ]);
  const out = await drainAskDraftRequests({
    client, env: CANARY_ENV,
    draftBatchFn: async () => ({ batch: { id: 'ask-batch-x' } })
  });
  assert.equal(out.skipped, false);
  assert.equal(out.planned, 2);
  assert.equal(out.dispatched, 2);
});

// ── F-19: the drain plans before it claims ────────────────────────────────────
// readDispatchableOutbox deliberately returns 'dispatching' rows so a crashed
// worker's row can be reclaimed. The claim CAS keys on (id, status, attempts) —
// and an in-flight worker has ALREADY bumped attempts — so claiming straight off
// the raw read let the next tick re-claim a live row and spend a second model
// call on it. The drain now runs the same planner the dispatcher does.

await test('drain: a row another worker is still running is deferred, not re-claimed', async () => {
  const NOW = Date.parse('2026-07-27T12:00:00Z');
  const client = makeMockClient([
    { match: "to_regclass('public.bookkeeping_cases')", rows: [{ present: 'bookkeeping_cases' }] },
    { match: 'from loop_event_outbox', rows: [draftRow({
      status: 'dispatching', attempts: 1,
      // Claimed one minute ago — inside the 5-minute stuck window.
      last_error: { at: new Date(NOW - 60_000).toISOString(), phase: 'dispatching' }
    })] },
    ...consumerHandlers()
  ]);
  let drafts = 0;
  const out = await drainAskDraftRequests({
    client, env: CANARY_ENV, asOf: NOW,
    draftBatchFn: async () => { drafts += 1; return { batch: { id: 'ask-batch-x' } }; }
  });
  assert.equal(out.planned, 1);
  assert.equal(out.deferred, 1, 'held behind the stuck window');
  assert.equal(out.dispatched, 0);
  assert.equal(drafts, 0, 'no second model call on an in-flight row');
  assert.ok(!hasCall(client, "set status = 'dispatching'"), 'never re-claimed');
});

await test('drain: a row stuck past the window IS reclaimed (a crashed worker heals)', async () => {
  const NOW = Date.parse('2026-07-27T12:00:00Z');
  const client = makeMockClient([
    { match: "to_regclass('public.bookkeeping_cases')", rows: [{ present: 'bookkeeping_cases' }] },
    { match: 'from loop_event_outbox', rows: [draftRow({
      status: 'dispatching', attempts: 1,
      // Claimed an hour ago — the worker is gone.
      last_error: { at: new Date(NOW - 3_600_000).toISOString(), phase: 'dispatching' }
    })] },
    ...consumerHandlers()
  ]);
  const out = await drainAskDraftRequests({
    client, env: CANARY_ENV, asOf: NOW,
    draftBatchFn: async () => ({ batch: { id: 'ask-batch-x' } })
  });
  assert.equal(out.deferred, 0);
  assert.equal(out.dispatched, 1, 'the stuck row is reclaimed and completed');
});

await test('drain: two requests for the SAME client serialize (the double-draft race)', async () => {
  const client = makeMockClient([
    { match: "to_regclass('public.bookkeeping_cases')", rows: [{ present: 'bookkeeping_cases' }] },
    { match: 'from loop_event_outbox', rows: [
      draftRow({ id: 'ob-1', created_at: '2026-07-27T10:00:00Z' }),
      draftRow({ id: 'ob-2', created_at: '2026-07-27T10:00:05Z' })
    ] },
    ...consumerHandlers()
  ]);
  let drafts = 0;
  const out = await drainAskDraftRequests({
    client, env: CANARY_ENV,
    draftBatchFn: async () => { drafts += 1; return { batch: { id: 'ask-batch-x' } }; }
  });
  assert.equal(out.planned, 2);
  assert.equal(out.dispatched, 1, 'only the lane head drafts');
  assert.equal(out.deferred, 1, 'the sibling waits behind it');
  assert.equal(drafts, 1, 'one client, one draft per tick');
});

await test('drain: a failed row honours its backoff instead of re-spending every tick', async () => {
  const NOW = Date.parse('2026-07-27T12:00:00Z');
  const client = makeMockClient([
    { match: "to_regclass('public.bookkeeping_cases')", rows: [{ present: 'bookkeeping_cases' }] },
    { match: 'from loop_event_outbox', rows: [draftRow({
      status: 'failed', attempts: 2,
      last_error: { at: new Date(NOW - 1_000).toISOString(), message: 'no api key' }
    })] },
    ...consumerHandlers()
  ]);
  let drafts = 0;
  const out = await drainAskDraftRequests({
    client, env: CANARY_ENV, asOf: NOW,
    draftBatchFn: async () => { drafts += 1; return { batch: { id: 'ask-batch-x' } }; }
  });
  assert.equal(out.deferred, 1);
  assert.equal(drafts, 0, 'a just-failed row does not retry on the very next tick');
});

// ── producer (onReconcileCompleteRequestAskDraft uses runShadow → process.env) ─────

const withLoopsEnv = async (vars, fn) => {
  const saved = {};
  for (const [k, v] of Object.entries(vars)) { saved[k] = process.env[k]; process.env[k] = v; }
  try { return await fn(); }
  finally {
    for (const k of Object.keys(vars)) {
      if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
    }
  }
};

await test('producer: a canary firm enqueues a coalesced ask_draft.requested row', async () => {
  await withLoopsEnv({ LOOPS_SHADOW: 'true', LOOPS_TIER: 'canary' }, async () => {
    const client = makeMockClient([
      { match: "to_regclass('public.bookkeeping_cases')", rows: [{ present: 'bookkeeping_cases' }] },
      { match: 'select metadata from firms', rows: [CANARY_FIRM] },
      { match: "status in ('pending', 'dispatching', 'failed')", rows: [] }, // coalesce: none in flight
      { match: 'insert into loop_event_outbox', rows: [{ id: 'ob-new' }] }
    ]);
    const out = await onReconcileCompleteRequestAskDraft({ client, firmId: 'firm-1', clientId: 'client-1' });
    assert.equal(out.enqueued, 1);
    const insert = client.calls.find((c) => c.sql.toLowerCase().includes('insert into loop_event_outbox'));
    assert.ok(insert, 'enqueued the outbox row');
    // eventType ships as a literal so the registry source-scan attributes the producer.
    assert.equal(insert.params[3], 'ask_draft.requested');
  });
});

await test('producer: a shadow firm does NOT enqueue (no backlog at shadow)', async () => {
  await withLoopsEnv({ LOOPS_SHADOW: 'true', LOOPS_TIER: 'canary' }, async () => {
    const client = makeMockClient([
      { match: "to_regclass('public.bookkeeping_cases')", rows: [{ present: 'bookkeeping_cases' }] },
      { match: 'select metadata from firms', rows: [SHADOW_FIRM] }
    ]);
    const out = await onReconcileCompleteRequestAskDraft({ client, firmId: 'firm-1', clientId: 'client-1' });
    assert.equal(out.enqueued, 0);
    assert.ok(!hasCall(client, 'insert into loop_event_outbox'), 'never enqueued');
  });
});

await test('producer: an already-pending request is not duplicated (coalesce)', async () => {
  await withLoopsEnv({ LOOPS_SHADOW: 'true', LOOPS_TIER: 'canary' }, async () => {
    const client = makeMockClient([
      { match: "to_regclass('public.bookkeeping_cases')", rows: [{ present: 'bookkeeping_cases' }] },
      { match: 'select metadata from firms', rows: [CANARY_FIRM] },
      { match: "status in ('pending', 'dispatching', 'failed')", rows: [{ '?column?': 1 }] } // one in flight
    ]);
    const out = await onReconcileCompleteRequestAskDraft({ client, firmId: 'firm-1', clientId: 'client-1' });
    assert.equal(out.enqueued, 0);
    assert.equal(out.reason, 'already_pending');
    assert.ok(!hasCall(client, 'insert into loop_event_outbox'), 'coalesced — no duplicate enqueue');
  });
});
