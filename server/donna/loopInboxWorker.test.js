// Donna Loops — Phase 3 inbox drainer tests. Load-bearing:
//   - LOOPS_SHADOW off → skipped, zero queries
//   - a client_reply.received event is claimed, processed, marked processed
//   - an unhandled event type is IGNORED (not failed)
//   - a poisoned event is marked failed + rolled back, and the drain continues
//     (no-throw per event)

import test from 'node:test';
import assert from 'node:assert/strict';

import { drainLoopInbox } from './loopInboxWorker.js';

const makeMockClient = (responders = []) => {
  const calls = [];
  const queue = [...responders];
  return {
    calls,
    query: async (sql, params) => {
      calls.push({ sql: String(sql), params });
      const text = String(sql).toLowerCase();
      if (text === 'begin' || text === 'commit' || text === 'rollback') return { rows: [], rowCount: 0 };
      const idx = queue.findIndex((r) => text.includes(r.match));
      if (idx !== -1) {
        const [r] = queue.splice(idx, 1);
        if (r.throw) throw r.throw;
        return { rows: r.rows || [], rowCount: (r.rows || []).length };
      }
      return { rows: [], rowCount: 0 };
    }
  };
};

const withShadow = async (value, fn) => {
  const prev = process.env.LOOPS_SHADOW;
  process.env.LOOPS_SHADOW = value;
  try { return await fn(); } finally {
    if (prev === undefined) delete process.env.LOOPS_SHADOW;
    else process.env.LOOPS_SHADOW = prev;
  }
};

const replyEvent = (eventType = 'client_reply.received') => ({
  id: 'loop-inbox-1', firm_id: 'f', client_id: 'cl', source: 'client_portal',
  event_type: eventType, object_type: 'client_evidence_request', object_id: 'er-1', payload: {}
});

test('LOOPS_SHADOW off → drain is skipped with zero queries', async () => {
  await withShadow('false', async () => {
    const c = makeMockClient();
    const out = await drainLoopInbox({ client: c });
    assert.deepEqual(out, { skipped: true, reason: 'loops_shadow_off' });
    assert.equal(c.calls.length, 0);
  });
});

test('a client_reply.received event is claimed, processed, and marked processed', async () => {
  await withShadow('on', async () => {
    const c = makeMockClient([
      { match: 'to_regclass', rows: [{ present: 'bookkeeping_cases' }] },
      { match: 'skip locked', rows: [replyEvent()] },
      { match: 'from client_evidence_requests', rows: [{ id: 'er-1', transaction_id: 't-1', status: 'replied', response_payload: { reply: 'Yes that is correct', document_ids: [] } }] },
      { match: 'insert into bookkeeping_cases', rows: [{ id: 'case-evidence-1', status: 'waiting_client' }] },
      { match: "blocker_type = 'missing_client_answer'", rows: [{ id: 'blk-1' }] },
      { match: 'update bookkeeping_case_blockers', rows: [{ case_id: 'case-evidence-1', firm_id: 'f', client_id: 'cl', blocker_type: 'missing_client_answer', owner_type: 'client' }] },
      { match: 'insert into loop_event_outbox', rows: [{ id: 'loop-outbox-1' }] },
      { match: "set status = 'processed'", rows: [{ id: 'loop-inbox-1' }] }
    ]);
    const out = await drainLoopInbox({ client: c });
    assert.equal(out.skipped, false);
    assert.equal(out.claimed, 1);
    assert.equal(out.processed, 1);
    assert.equal(out.ignored, 0);
    assert.equal(out.failed, 0);
    assert.ok(c.calls.some((q) => /set status = 'processed'/.test(q.sql)), 'marked processed');
    assert.ok(c.calls.some((q) => /insert into loop_event_outbox/.test(q.sql)), 'requested the re-run');
  });
});

test('an unhandled event type is IGNORED, not failed', async () => {
  await withShadow('on', async () => {
    const c = makeMockClient([
      { match: 'to_regclass', rows: [{ present: 'bookkeeping_cases' }] },
      { match: 'skip locked', rows: [replyEvent('parse.unknown')] }
    ]);
    const out = await drainLoopInbox({ client: c });
    assert.equal(out.claimed, 1);
    assert.equal(out.ignored, 1);
    assert.equal(out.processed, 0);
    assert.equal(out.failed, 0);
    assert.ok(c.calls.some((q) => /set status = 'ignored'/.test(q.sql)));
    // unhandled → no resume work touched the case spine
    assert.ok(!c.calls.some((q) => /update bookkeeping_case_blockers/.test(q.sql)));
  });
});

test('a loop-trigger event drains to a wake; a no-case event IGNORES (re-evaluates, never opens)', async () => {
  await withShadow('on', async () => {
    const reconEvent = {
      id: 'loop-inbox-2', firm_id: 'f', client_id: 'cl', source: 'recon',
      event_type: 'reconciliation.run_completed', object_type: 'document', object_id: 'doc-1',
      payload: {}, first_seen_at: null
    };
    // Table-specific to_regclass matches so each presence probe maps to its own
    // responder (loopsTablesPresent, the new readActiveCaseSuspension probe, and the
    // engine's loopGoalTablesPresent) — the suspension table is ABSENT here, so the
    // gate stays permissive exactly as before this slice.
    const c = makeMockClient([
      { match: "to_regclass('public.bookkeeping_cases')", rows: [{ present: 'bookkeeping_cases' }] },          // loopsTablesPresent (worker)
      { match: 'skip locked', rows: [reconEvent] },
      { match: "to_regclass('public.bookkeeping_case_suspensions')", rows: [{ present: null }] },              // readActiveCaseSuspension → absent → null
      { match: "to_regclass('public.loop_goal_reports')", rows: [{ present: 'loop_goal_reports' }] },          // loopGoalTablesPresent (engine)
      { match: 'case_version, status', rows: [] },                      // case absent → re-eval has nothing
      { match: "set status = 'ignored'", rows: [{ id: 'loop-inbox-2' }] }
    ]);
    const out = await drainLoopInbox({ client: c });
    assert.equal(out.claimed, 1);
    assert.equal(out.ignored, 1);
    assert.equal(out.processed, 0);
    assert.equal(out.failed, 0);
    // it reached the engine (queried the case spine) but opened NO case
    assert.ok(c.calls.some((q) => /case_version, status/.test(q.sql)), 'dispatched to the wake');
    assert.ok(!c.calls.some((q) => /insert into bookkeeping_cases/.test(q.sql)), 'opened nothing');
    assert.ok(c.calls.some((q) => /set status = 'ignored'/.test(q.sql)));
  });
});

test('a loop-trigger event for a SUSPENDED case is IGNORED (case_suspended); the engine never runs', async () => {
  await withShadow('on', async () => {
    const reconEvent = {
      id: 'loop-inbox-3', firm_id: 'f', client_id: 'cl', source: 'recon',
      event_type: 'reconciliation.run_completed', object_type: 'document', object_id: 'doc-1',
      payload: {}, first_seen_at: null
    };
    // The case is PAUSED (latest suspension action), so decideLoopExecution blocks
    // the wake with 'case_suspended' BEFORE the engine touches the case spine.
    const c = makeMockClient([
      { match: "to_regclass('public.bookkeeping_cases')", rows: [{ present: 'bookkeeping_cases' }] },          // loopsTablesPresent
      { match: 'skip locked', rows: [reconEvent] },
      { match: "to_regclass('public.bookkeeping_case_suspensions')", rows: [{ present: 'bookkeeping_case_suspensions' }] },
      { match: 'from bookkeeping_case_suspensions', rows: [{
        id: 'case-susp-1', action: 'pause', reason: 'client away',
        authorized_by_actor_type: 'firm_operator', authorized_by_actor_id: 'op-1',
        authority_level: 'firm_operator', created_at: '2026-06-20T00:00:00Z'
      }] },
      { match: "set status = 'ignored'", rows: [{ id: 'loop-inbox-3' }] }
    ]);
    const out = await drainLoopInbox({ client: c });
    assert.equal(out.claimed, 1);
    assert.equal(out.ignored, 1);
    assert.equal(out.processed, 0);
    assert.equal(out.failed, 0);
    // the gate blocked the wake → the engine never queried the case spine
    assert.ok(!c.calls.some((q) => /case_version, status/.test(q.sql)), 'engine did not run');
    // and the ignore carried the typed gate reason (markIgnored serializes it into
    // last_error as {"ignored_reason":"case_suspended"})
    assert.ok(
      c.calls.some((q) =>
        /set status = 'ignored'/.test(q.sql)
        && (q.params || []).some((p) => String(p).includes('case_suspended'))),
      'IGNORED with reason case_suspended'
    );
  });
});

test('§6.2 cascade routing: a dependency.resolved for a CODING case runs the coding evaluator', async () => {
  await withShadow('on', async () => {
    const depEvent = {
      id: 'loop-inbox-9', firm_id: 'f', client_id: 'cl', source: 'loop_outbox',
      event_type: 'dependency.resolved', object_type: 'bookkeeping_case', object_id: 'C',
      payload: { case_id: 'C' }, first_seen_at: null
    };
    const c = makeMockClient([
      { match: "to_regclass('public.bookkeeping_cases')", rows: [{ present: 'bookkeeping_cases' }] }, // loopsTablesPresent
      { match: 'skip locked', rows: [depEvent] },
      // dependency.resolved is subscribed by >1 loop → disambiguate by case type
      { match: 'case_type from bookkeeping_cases', rows: [{ case_type: 'coding' }] },
      { match: "to_regclass('public.bookkeeping_case_suspensions')", rows: [{ present: null }] },
      { match: "to_regclass('public.loop_goal_reports')", rows: [{ present: 'loop_goal_reports' }] },
      { match: 'case_version, status', rows: [{ id: 'C', firm_id: 'f', client_id: 'cl', case_version: 1, status: 'waiting_client', primary_object_type: 'client_ask_batch', primary_object_id: 'ab-1' }] },
      { match: 'loop_runs where id =', rows: [] },
      { match: 'progress_fingerprint_after, stop_reason', rows: [] },
      // the CODING evaluator reads the graph + the blocking evidence cases' answers
      { match: 'from bookkeeping_case_dependencies', rows: [{ id: 'd1', parent_case_id: 'E1', child_case_id: 'C', relationship_type: 'blocks', resolved_at: null, created_at: 1 }] },
      { match: 'from bookkeeping_case_blockers', rows: [{ case_id: 'E1', open_answers: 1 }] }, // unanswered → unmet
      { match: 'set case_version = case_version + 1', rowCount: 1 },
      { match: 'insert into loop_runs', rows: [{ inserted: true }] },
      { match: 'insert into loop_goal_specs', rows: [{ inserted: true }] },
      { match: 'insert into bookkeeping_case_events', rows: [{ id: 'evt-c1' }] },
      { match: 'insert into loop_goal_reports', rows: [{ inserted: true }] },
      { match: "set status = 'processed'", rows: [{ id: 'loop-inbox-9' }] }
    ]);
    const out = await drainLoopInbox({ client: c });
    assert.equal(out.processed, 1);
    // it disambiguated by case type and ran the CODING evaluator (read the dep graph)
    assert.ok(c.calls.some((q) => /case_type from bookkeeping_cases/.test(q.sql)), 'read the case type to route');
    assert.ok(c.calls.some((q) => /from bookkeeping_case_dependencies/.test(q.sql)), 'ran the coding evaluator');
    // NOT the reconciliation evaluator
    assert.ok(!c.calls.some((q) => /from reconciliation_evaluations/.test(q.sql)), 'did not run reconciliation');
    // unmet → no case.resolved cascade emitted
    assert.ok(!c.calls.some((q) => /insert into loop_event_outbox/.test(q.sql)));
  });
});

test('§6.2 cascade routing: a dependency.resolved for a RECONCILIATION case runs the reconciliation evaluator', async () => {
  await withShadow('on', async () => {
    const depEvent = {
      id: 'loop-inbox-10', firm_id: 'f', client_id: 'cl', source: 'loop_outbox',
      event_type: 'dependency.resolved', object_type: 'bookkeeping_case', object_id: 'R',
      payload: { case_id: 'R' }, first_seen_at: null
    };
    const c = makeMockClient([
      { match: "to_regclass('public.bookkeeping_cases')", rows: [{ present: 'bookkeeping_cases' }] },
      { match: 'skip locked', rows: [depEvent] },
      { match: 'case_type from bookkeeping_cases', rows: [{ case_type: 'reconciliation' }] },
      { match: "to_regclass('public.bookkeeping_case_suspensions')", rows: [{ present: null }] },
      { match: "to_regclass('public.loop_goal_reports')", rows: [{ present: 'loop_goal_reports' }] },
      { match: 'case_version, status', rows: [{ id: 'R', firm_id: 'f', client_id: 'cl', case_version: 1, status: 'waiting_firm', primary_object_type: 'document', primary_object_id: 'doc-1' }] },
      { match: 'loop_runs where id =', rows: [] },
      { match: 'progress_fingerprint_after, stop_reason', rows: [] },
      // the RECONCILIATION evaluator reads the persisted verdict + match state
      { match: 'from reconciliation_evaluations', rows: [{ verdict: 'no_match', model: 'm1' }] },
      { match: "status in ('confirmed', 'auto_matched')", rows: [] },
      { match: 'from reconciliation_matches', rows: [] },
      { match: 'from documents', rows: [{ payment_status: 'unpaid' }] },
      { match: 'bookkeeping_case_blockers', rows: [] },
      { match: 'set case_version = case_version + 1', rowCount: 1 },
      { match: 'insert into loop_runs', rows: [{ inserted: true }] },
      { match: 'insert into loop_goal_specs', rows: [{ inserted: true }] },
      { match: 'insert into bookkeeping_case_events', rows: [{ id: 'evt-r1' }] },
      { match: 'insert into loop_goal_reports', rows: [{ inserted: true }] },
      { match: "set status = 'processed'", rows: [{ id: 'loop-inbox-10' }] }
    ]);
    const out = await drainLoopInbox({ client: c });
    assert.equal(out.processed, 1);
    assert.ok(c.calls.some((q) => /from reconciliation_evaluations/.test(q.sql)), 'ran the reconciliation evaluator');
    assert.ok(!c.calls.some((q) => /from bookkeeping_case_dependencies/.test(q.sql)), 'did not run the coding evaluator');
  });
});

test('a dependency.resolved with no explicit case_id is IGNORED (ambiguous, cannot route)', async () => {
  await withShadow('on', async () => {
    const depEvent = {
      id: 'loop-inbox-11', firm_id: 'f', client_id: 'cl', source: 'loop_outbox',
      event_type: 'dependency.resolved', object_type: null, object_id: null,
      payload: {}, first_seen_at: null
    };
    const c = makeMockClient([
      { match: "to_regclass('public.bookkeeping_cases')", rows: [{ present: 'bookkeeping_cases' }] },
      { match: 'skip locked', rows: [depEvent] },
      { match: "set status = 'ignored'", rows: [{ id: 'loop-inbox-11' }] }
    ]);
    const out = await drainLoopInbox({ client: c });
    assert.equal(out.ignored, 1);
    assert.equal(out.processed, 0);
    // ambiguous + no case anchor → never read a case type, never ran an evaluator
    assert.ok(!c.calls.some((q) => /case_type from bookkeeping_cases/.test(q.sql)));
    assert.ok(!c.calls.some((q) => /case_version, status/.test(q.sql)));
  });
});

test('a poisoned event is marked failed + rolled back, and the drain continues (no-throw)', async () => {
  await withShadow('1', async () => {
    const c = makeMockClient([
      { match: 'to_regclass', rows: [{ present: 'bookkeeping_cases' }] },
      { match: 'skip locked', rows: [replyEvent()] },
      { match: 'from client_evidence_requests', throw: new Error('boom') },
      { match: "set status = 'failed', last_error = $2", rows: [{ id: 'loop-inbox-1' }] }
    ]);
    const out = await drainLoopInbox({ client: c });
    assert.equal(out.claimed, 1);
    assert.equal(out.failed, 1);
    assert.equal(out.processed, 0);
    assert.ok(c.calls.some((q) => q.sql === 'rollback'), 'rolled back the poisoned event');
    assert.ok(c.calls.some((q) => /set status = 'failed', last_error = \$2/.test(q.sql)), 'marked failed');
  });
});
