// Donna Loops — Step 7 outbox dispatcher tests. Load-bearing properties:
//   - loops off → skipped, zero queries (exact back-compat)
//   - shadow tier → ready rows are HELD (workflow_mutation needs canary+): the
//     dispatcher is INERT at shadow, exactly as the outbox behaved before Step 7
//   - canary → a case.resolved row CASCADES (dependency.resolved per downstream
//     case, in topological order) and is marked dispatched
//   - canary → a goal.regressed row REOPENS the case + re-wakes (manual.resume)
//   - a CANCELLED case (terminal suspension) DROPS its row; a PAUSED case HOLDS it
//   - an unhandled event type is left pending (never claimed/dispatched)
//   - a dead-lettered row is dropped; a duplicate collapses to the survivor

import test from 'node:test';
import assert from 'node:assert/strict';

import { dispatchLoopOutbox, DISPATCH_HANDLED_EVENT_TYPES } from './loopOutboxDispatcher.js';

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

const SHADOW = { LOOPS_SHADOW: 'on' };
const CANARY = { LOOPS_SHADOW: 'on', LOOPS_TIER: 'canary' };
const CANARY_FIRM = { metadata: { loops: { tier: 'canary' } } };

const outboxRow = (over = {}) => ({
  id: 'ob-1', firm_id: 'f', client_id: 'cl', event_type: 'case.resolved',
  object_type: null, object_id: null, payload: { case_id: 'E' },
  status: 'pending', attempts: 0, last_error: null, created_at: 1000,
  ...over
});

const hit = (c, needle) => c.calls.some((q) => q.sql.includes(needle));

test('the handled set is exactly the cascade + regression types', () => {
  assert.deepEqual([...DISPATCH_HANDLED_EVENT_TYPES].sort(), ['case.resolved', 'goal.regressed']);
});

test('loops off → skipped with zero queries (exact back-compat)', async () => {
  const c = makeMockClient();
  const out = await dispatchLoopOutbox({ client: c, env: { LOOPS_SHADOW: 'false' } });
  assert.deepEqual(out, { skipped: true, reason: 'loops_off' });
  assert.equal(c.calls.length, 0);
});

test('shadow tier → a ready row is HELD (workflow_mutation needs canary+); inert', async () => {
  const c = makeMockClient([
    { match: "to_regclass('public.bookkeeping_cases')", rows: [{ present: 'bookkeeping_cases' }] },
    { match: 'from loop_event_outbox', rows: [outboxRow()] },
    { match: 'from firms', rows: [{ metadata: {} }] },
    { match: "to_regclass('public.bookkeeping_case_suspensions')", rows: [{ present: null }] }
  ]);
  const out = await dispatchLoopOutbox({ client: c, env: SHADOW });
  assert.equal(out.held, 1);
  assert.equal(out.dispatched, 0);
  // never claimed: no status flip on the outbox row
  assert.ok(!hit(c, "set status = 'dispatching'"), 'did not claim');
  assert.ok(!hit(c, "set status = 'dispatched'"), 'did not dispatch');
});

test('canary → a case.resolved row cascades to its downstream dependents, in order', async () => {
  const c = makeMockClient([
    { match: "to_regclass('public.bookkeeping_cases')", rows: [{ present: 'bookkeeping_cases' }] },
    { match: 'from loop_event_outbox', rows: [outboxRow({ id: 'ob-1', payload: { case_id: 'E' } })] },
    { match: 'from firms', rows: [CANARY_FIRM] },
    { match: "to_regclass('public.bookkeeping_case_suspensions')", rows: [{ present: null }] },
    { match: "set status = 'dispatching'", rows: [{ id: 'ob-1' }] },
    { match: 'from bookkeeping_case_dependencies', rows: [
      { parent_case_id: 'E', child_case_id: 'C', relationship_type: 'blocks', resolved_at: null },
      { parent_case_id: 'C', child_case_id: 'M', relationship_type: 'blocks', resolved_at: null }
    ] },
    { match: 'insert into loop_event_inbox', rows: [{ id: 'in-C' }] },
    { match: 'insert into loop_event_inbox', rows: [{ id: 'in-M' }] },
    { match: "set status = 'dispatched'", rows: [{ id: 'ob-1' }] }
  ]);
  const out = await dispatchLoopOutbox({ client: c, env: CANARY });
  assert.equal(out.dispatched, 1);
  assert.equal(out.enqueued, 2, 'one dependency.resolved per downstream case (C, M)');
  // each cascade event is a dependency.resolved on the child case, idempotency-keyed
  const inboxInserts = c.calls.filter((q) => q.sql.includes('insert into loop_event_inbox'));
  assert.equal(inboxInserts.length, 2);
  assert.ok(inboxInserts.every((q) => (q.params || []).includes('dependency.resolved')), 'event_type dependency.resolved');
  assert.ok(inboxInserts.some((q) => (q.params || []).includes('ob-1:C')), 'idempotency key ob-1:C');
  assert.ok(inboxInserts.some((q) => (q.params || []).includes('ob-1:M')), 'idempotency key ob-1:M');
});

test('canary → a goal.regressed row reopens a terminal case and re-wakes the engine', async () => {
  const c = makeMockClient([
    { match: "to_regclass('public.bookkeeping_cases')", rows: [{ present: 'bookkeeping_cases' }] },
    { match: 'from loop_event_outbox', rows: [outboxRow({
      id: 'ob-2', event_type: 'goal.regressed',
      payload: { case_id: 'K', regression: { id: 'reg-1', kind: 'match_rejected', supersedesReportId: 'grep-1' } }
    })] },
    { match: 'from firms', rows: [CANARY_FIRM] },
    { match: "to_regclass('public.bookkeeping_case_suspensions')", rows: [{ present: null }] },
    { match: "set status = 'dispatching'", rows: [{ id: 'ob-2' }] },
    { match: 'case_version, client_id from bookkeeping_cases', rows: [{ id: 'K', status: 'resolved', case_version: 3, client_id: 'cl' }] },
    { match: 'from loop_goal_reports', rows: [{ id: 'grep-1', status: 'met', goal_key: 'reconciliation_gap_resolved', goal_version: '1' }] },
    { match: 'insert into bookkeeping_case_events', rows: [{ id: 'ce-reopened' }] }, // case.reopened
    { match: 'event_type in', rows: [{ event_type: 'case.reopened' }] },           // rebuildCaseStatus terminal probe
    { match: 'blocker_type, owner_type', rows: [] },                                // rebuildCaseStatus blockers
    { match: 'insert into bookkeeping_case_events', rows: [{ id: 'ce-status' }] },  // case.open
    { match: 'case_version = case_version + 1', rows: [{ case_version: 4 }] },       // INV-16 bump
    { match: 'insert into loop_event_inbox', rows: [{ id: 'in-resume' }] },         // manual.resume re-wake
    { match: "set status = 'dispatched'", rows: [{ id: 'ob-2' }] }
  ]);
  const out = await dispatchLoopOutbox({ client: c, env: CANARY });
  assert.equal(out.dispatched, 1);
  assert.equal(out.enqueued, 1, 're-wake enqueued');
  // it reopened the case (case.reopened receipt) and bumped the single-flight version
  assert.ok(c.calls.some((q) => (q.params || []).includes('case.reopened')), 'appended case.reopened');
  assert.ok(hit(c, 'case_version = case_version + 1'), 'bumped case_version (INV-16)');
  // the re-wake is a manual.resume keyed on the regressionKey (idempotent reopen)
  const resume = c.calls.find((q) => q.sql.includes('insert into loop_event_inbox'));
  assert.ok((resume.params || []).includes('manual.resume'), 'manual.resume event');
  assert.ok((resume.params || []).includes('regress:K:reg-1'), 'idempotent on the regression key');
});

test('canary → a goal.regressed row whose goal was never met is IGNORED (no reopen)', async () => {
  const c = makeMockClient([
    { match: "to_regclass('public.bookkeeping_cases')", rows: [{ present: 'bookkeeping_cases' }] },
    { match: 'from loop_event_outbox', rows: [outboxRow({
      id: 'ob-7', event_type: 'goal.regressed',
      payload: { case_id: 'K', regression: { id: 'reg-2', kind: 'match_rejected' } }
    })] },
    { match: 'from firms', rows: [CANARY_FIRM] },
    { match: "to_regclass('public.bookkeeping_case_suspensions')", rows: [{ present: null }] },
    { match: "set status = 'dispatching'", rows: [{ id: 'ob-7' }] },
    { match: 'case_version, client_id from bookkeeping_cases', rows: [{ id: 'K', status: 'open', case_version: 1, client_id: 'cl' }] },
    { match: 'from loop_goal_reports', rows: [{ id: 'grep-9', status: 'unmet', goal_key: 'reconciliation_gap_resolved', goal_version: '1' }] },
    { match: "set status = 'dispatched'", rows: [{ id: 'ob-7' }] }
  ]);
  const out = await dispatchLoopOutbox({ client: c, env: CANARY });
  assert.equal(out.dispatched, 1, 'still dispatched (the regression was correctly assessed)');
  assert.equal(out.enqueued, 0, 'no reopen — nothing to un-meet');
  assert.ok(!c.calls.some((q) => (q.params || []).includes('case.reopened')), 'did not reopen');
});

test('a CANCELLED case (terminal suspension) DROPS its outbox row, never retried', async () => {
  const c = makeMockClient([
    { match: "to_regclass('public.bookkeeping_cases')", rows: [{ present: 'bookkeeping_cases' }] },
    { match: 'from loop_event_outbox', rows: [outboxRow({ id: 'ob-3', payload: { case_id: 'X' } })] },
    { match: 'from firms', rows: [CANARY_FIRM] },
    { match: "to_regclass('public.bookkeeping_case_suspensions')", rows: [{ present: 'bookkeeping_case_suspensions' }] },
    { match: 'from bookkeeping_case_suspensions', rows: [{
      id: 'cs-1', action: 'cancel', reason: 'client closed',
      authorized_by_actor_type: 'firm_operator', authorized_by_actor_id: 'op-1',
      authority_level: 'firm_operator', created_at: '2026-06-20T00:00:00Z'
    }] },
    { match: "set status = 'cancelled'", rows: [{ id: 'ob-3' }] }
  ]);
  const out = await dispatchLoopOutbox({ client: c, env: CANARY });
  assert.equal(out.dropped, 1);
  assert.equal(out.dispatched, 0);
  assert.equal(out.held, 0);
  assert.ok(hit(c, "set status = 'cancelled'"), 'dropped (cancelled)');
  assert.ok(!hit(c, "set status = 'dispatching'"), 'never claimed for dispatch');
});

test('a PAUSED case (resumable suspension) HOLDS its outbox row (left pending)', async () => {
  const c = makeMockClient([
    { match: "to_regclass('public.bookkeeping_cases')", rows: [{ present: 'bookkeeping_cases' }] },
    { match: 'from loop_event_outbox', rows: [outboxRow({ id: 'ob-3b', payload: { case_id: 'X' } })] },
    { match: 'from firms', rows: [CANARY_FIRM] },
    { match: "to_regclass('public.bookkeeping_case_suspensions')", rows: [{ present: 'bookkeeping_case_suspensions' }] },
    { match: 'from bookkeeping_case_suspensions', rows: [{
      id: 'cs-2', action: 'pause', reason: 'client away',
      authorized_by_actor_type: 'firm_operator', authorized_by_actor_id: 'op-1',
      authority_level: 'firm_operator', created_at: '2026-06-20T00:00:00Z'
    }] }
  ]);
  const out = await dispatchLoopOutbox({ client: c, env: CANARY });
  assert.equal(out.held, 1);
  assert.equal(out.dropped, 0);
  assert.equal(out.dispatched, 0);
  assert.ok(!hit(c, "set status = 'cancelled'"), 'a paused case is not dropped');
  assert.ok(!hit(c, "set status = 'dispatching'"), 'and not claimed');
});

test('an unhandled event type is left PENDING (never claimed or dispatched)', async () => {
  const c = makeMockClient([
    { match: "to_regclass('public.bookkeeping_cases')", rows: [{ present: 'bookkeeping_cases' }] },
    { match: 'from loop_event_outbox', rows: [outboxRow({ id: 'ob-x', event_type: 'proposal_rerun.requested' })] }
  ]);
  const out = await dispatchLoopOutbox({ client: c, env: CANARY });
  assert.equal(out.considered, 1);
  assert.equal(out.planned, 0);
  assert.equal(out.dispatched, 0);
  // unhandled → not even gated; no firm/suspension read, no status flip
  assert.ok(!hit(c, 'from firms'), 'unhandled rows are not gated');
  assert.ok(!hit(c, 'set status ='), 'unhandled rows are untouched (stay pending)');
});

test('a row out of attempts is DEAD-LETTERED (dropped), not retried', async () => {
  const c = makeMockClient([
    { match: "to_regclass('public.bookkeeping_cases')", rows: [{ present: 'bookkeeping_cases' }] },
    { match: 'from loop_event_outbox', rows: [outboxRow({
      id: 'ob-4', status: 'failed', attempts: 5, last_error: { at: '2026-06-19T00:00:00Z', message: 'boom' }
    })] },
    { match: "set status = 'cancelled'", rows: [{ id: 'ob-4' }] }
  ]);
  const out = await dispatchLoopOutbox({ client: c, env: CANARY });
  assert.equal(out.deadLettered, 1);
  assert.equal(out.dispatched, 0);
  assert.ok(hit(c, "set status = 'cancelled'"), 'dead-lettered → cancelled');
  assert.ok(!hit(c, "set status = 'dispatching'"), 'never re-attempted');
});

test('duplicate idempotency keys collapse to the survivor; the survivor dispatches', async () => {
  const c = makeMockClient([
    { match: "to_regclass('public.bookkeeping_cases')", rows: [{ present: 'bookkeeping_cases' }] },
    { match: 'from loop_event_outbox', rows: [
      outboxRow({ id: 'ob-5', created_at: 1000, payload: { case_id: 'E', idempotencyKey: 'k1' } }),
      outboxRow({ id: 'ob-6', created_at: 2000, payload: { case_id: 'E', idempotencyKey: 'k1' } })
    ] },
    { match: "set status = 'cancelled'", rows: [{ id: 'ob-6' }] },          // duplicate dropped
    { match: 'from firms', rows: [CANARY_FIRM] },
    { match: "to_regclass('public.bookkeeping_case_suspensions')", rows: [{ present: null }] },
    { match: "set status = 'dispatching'", rows: [{ id: 'ob-5' }] },        // survivor claimed
    { match: 'from bookkeeping_case_dependencies', rows: [] },              // no downstream
    { match: "set status = 'dispatched'", rows: [{ id: 'ob-5' }] }
  ]);
  const out = await dispatchLoopOutbox({ client: c, env: CANARY });
  assert.equal(out.duplicates, 1);
  assert.equal(out.dispatched, 1);
  assert.equal(out.enqueued, 0, 'survivor had no downstream dependents');
});
