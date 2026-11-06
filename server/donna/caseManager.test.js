// Donna Loops — caseManager unit tests. Load-bearing properties:
//   - deterministic case id + ON CONFLICT find-or-create (idempotent)
//   - append-only events (no update/delete of the event log)
//   - rebuildCaseStatus projection: terminal verdict > most-severe blocker > open
//   - client-delete purge hits all six tables, presence-guarded

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildCaseId, openOrFindCase, appendCaseEvent, linkObject, openBlocker, resolveBlocker,
  rebuildCaseStatus, getCaseDebugSnapshot, listShadowCasesForClient,
  listCloseBlockersForClient, purgeLoopsShadowForDeletedClient, markCaseResolved,
  LOOP_CASE_TYPES, LOOP_CASE_STATUSES, LOOP_TERMINAL_STATUSES, LOOP_BLOCKER_TYPES, LOOP_OWNER_TYPES
} from './caseManager.js';

const makeMockClient = (responders = [], { tablesPresent = true } = {}) => {
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
      if (text.includes('to_regclass')) return { rows: [{ present: tablesPresent ? 'bookkeeping_cases' : null }] };
      return { rows: [], rowCount: 0 };
    }
  };
};

test('buildCaseId: deterministic per primary object; null without one', () => {
  const base = { firmId: 'f', clientId: 'c', caseType: 'evidence', primaryObjectType: 'client_evidence_request', primaryObjectId: 'er-1' };
  assert.equal(buildCaseId(base), buildCaseId({ ...base }));
  assert.notEqual(buildCaseId(base), buildCaseId({ ...base, primaryObjectId: 'er-2' }));
  assert.ok(buildCaseId(base).startsWith('case-evidence-'));
  assert.equal(buildCaseId({ ...base, primaryObjectId: null }), null);
});

test('openOrFindCase: inserts a new case (created=true)', async () => {
  const c = makeMockClient([{ match: 'insert into bookkeeping_cases', rows: [{ id: 'case-evidence-abc', status: 'open' }] }]);
  const kase = await openOrFindCase({
    client: c, firmId: 'firm-1', clientId: 'cl-1', caseType: 'evidence',
    primaryObject: { type: 'client_evidence_request', id: 'er-1' }
  });
  assert.equal(kase.created, true);
  assert.equal(kase.id, 'case-evidence-abc');
  assert.match(c.calls[0].sql, /on conflict \(id\) do nothing/);
});

test('openOrFindCase: conflict → fetches the existing case (created=false)', async () => {
  const c = makeMockClient([
    { match: 'insert into bookkeeping_cases', rows: [] },
    { match: 'select * from bookkeeping_cases where id', rows: [{ id: 'case-evidence-abc', status: 'waiting_client' }] }
  ]);
  const kase = await openOrFindCase({
    client: c, firmId: 'firm-1', clientId: 'cl-1', caseType: 'evidence',
    primaryObject: { type: 'client_evidence_request', id: 'er-1' }
  });
  assert.equal(kase.created, false);
  assert.equal(kase.id, 'case-evidence-abc');
});

test('openOrFindCase: invalid case type → null, no query', async () => {
  const c = makeMockClient();
  assert.equal(await openOrFindCase({ client: c, firmId: 'f', clientId: 'c', caseType: 'bogus', primaryObject: { type: 't', id: 'i' } }), null);
  assert.equal(c.calls.length, 0);
});

test('appendCaseEvent: inserts an event and bumps activity; never updates/deletes events', async () => {
  const c = makeMockClient([{ match: 'insert into bookkeeping_case_events', rows: [{ id: 'case-event-1' }] }]);
  const out = await appendCaseEvent({ client: c, firmId: 'f', clientId: 'cl', caseId: 'case-1', eventType: 'evidence_request.created' });
  assert.equal(out.id, 'case-event-1');
  assert.match(c.calls[1].sql, /update bookkeeping_cases set last_activity_at = now/);
  assert.ok(!c.calls.some((q) => /update bookkeeping_case_events|delete from bookkeeping_case_events/.test(q.sql)));
});

test('appendCaseEvent: invalid actor type → null, no query', async () => {
  const c = makeMockClient();
  assert.equal(await appendCaseEvent({ client: c, firmId: 'f', clientId: 'cl', caseId: 'k', eventType: 'x', actorType: 'robot' }), null);
  assert.equal(c.calls.length, 0);
});

test('linkObject: idempotent (created reflects ON CONFLICT)', async () => {
  const made = makeMockClient([{ match: 'insert into bookkeeping_case_links', rows: [{ id: 'case-link-1' }] }]);
  assert.deepEqual(await linkObject({ client: made, firmId: 'f', clientId: 'cl', caseId: 'k', objectType: 'transaction', objectId: 't1', role: 'primary' }), { id: 'case-link-1', created: true });
  assert.match(made.calls[0].sql, /on conflict \(case_id, object_type, object_id, role\) do nothing/);

  const dup = makeMockClient([{ match: 'insert into bookkeeping_case_links', rows: [] }]);
  assert.deepEqual(await linkObject({ client: dup, firmId: 'f', clientId: 'cl', caseId: 'k', objectType: 'transaction', objectId: 't1', role: 'primary' }), { id: null, created: false });
});

test('linkObject: invalid role → null', async () => {
  const c = makeMockClient();
  assert.equal(await linkObject({ client: c, firmId: 'f', clientId: 'cl', caseId: 'k', objectType: 't', objectId: 'i', role: 'bogus' }), null);
});

test('rebuildCaseStatus: explicit terminal verdict outranks blockers', async () => {
  const c = makeMockClient([{ match: 'select event_type from bookkeeping_case_events', rows: [{ event_type: 'case.resolved' }] }]);
  assert.equal(await rebuildCaseStatus({ client: c, caseId: 'k' }), 'resolved');
});

test('rebuildCaseStatus: reopened is not terminal; falls through to blockers', async () => {
  const c = makeMockClient([
    { match: 'select event_type from bookkeeping_case_events', rows: [{ event_type: 'case.reopened' }] },
    { match: 'select blocker_type, owner_type from bookkeeping_case_blockers', rows: [] }
  ]);
  assert.equal(await rebuildCaseStatus({ client: c, caseId: 'k' }), 'open');
});

test('rebuildCaseStatus: most-severe open blocker wins (system parse_failed → blocked)', async () => {
  const c = makeMockClient([
    { match: 'select event_type from bookkeeping_case_events', rows: [] },
    { match: 'select blocker_type, owner_type from bookkeeping_case_blockers', rows: [
      { blocker_type: 'missing_client_answer', owner_type: 'client' },
      { blocker_type: 'parse_failed', owner_type: 'system' }
    ] }
  ]);
  assert.equal(await rebuildCaseStatus({ client: c, caseId: 'k' }), 'blocked');
});

test('rebuildCaseStatus: a soft system blocker → waiting_system; a client blocker → waiting_client', async () => {
  const sys = makeMockClient([
    { match: 'select event_type from bookkeeping_case_events', rows: [] },
    { match: 'select blocker_type, owner_type from bookkeeping_case_blockers', rows: [{ blocker_type: 'parse_pending', owner_type: 'system' }] }
  ]);
  assert.equal(await rebuildCaseStatus({ client: sys, caseId: 'k' }), 'waiting_system');

  const cli = makeMockClient([
    { match: 'select event_type from bookkeeping_case_events', rows: [] },
    { match: 'select blocker_type, owner_type from bookkeeping_case_blockers', rows: [{ blocker_type: 'missing_client_answer', owner_type: 'client' }] }
  ]);
  assert.equal(await rebuildCaseStatus({ client: cli, caseId: 'k' }), 'waiting_client');
});

test('openBlocker: creates a blocker, appends a wait event, sets case status', async () => {
  const c = makeMockClient([
    { match: 'select id from bookkeeping_case_blockers', rows: [] },                 // no existing
    { match: 'select event_type from bookkeeping_case_events', rows: [] },           // rebuild: no terminal
    { match: 'select blocker_type, owner_type from bookkeeping_case_blockers', rows: [{ blocker_type: 'missing_client_answer', owner_type: 'client' }] }
  ]);
  const out = await openBlocker({ client: c, firmId: 'f', clientId: 'cl', caseId: 'k', blockerType: 'missing_client_answer', ownerType: 'client' });
  assert.equal(out.created, true);
  assert.equal(out.status, 'waiting_client');
  assert.ok(c.calls.some((q) => /insert into bookkeeping_case_blockers/.test(q.sql)));
  assert.ok(c.calls.some((q) => /insert into bookkeeping_case_events/.test(q.sql) && JSON.stringify(q.params).includes('case.waiting_client')));
  assert.ok(c.calls.some((q) => /update bookkeeping_cases\n? *set status = \$2/.test(q.sql)));
});

test('openBlocker: equivalent open blocker is not duplicated', async () => {
  const c = makeMockClient([
    { match: 'select id from bookkeeping_case_blockers', rows: [{ id: 'case-blocker-existing' }] },
    { match: 'select event_type from bookkeeping_case_events', rows: [] },
    { match: 'select blocker_type, owner_type from bookkeeping_case_blockers', rows: [{ blocker_type: 'missing_client_answer', owner_type: 'client' }] }
  ]);
  const out = await openBlocker({ client: c, firmId: 'f', clientId: 'cl', caseId: 'k', blockerType: 'missing_client_answer', ownerType: 'client' });
  assert.equal(out.created, false);
  assert.ok(!c.calls.some((q) => /insert into bookkeeping_case_blockers/.test(q.sql)));
});

test('resolveBlocker: resolves the blocker and recomputes status (last blocker → open)', async () => {
  const c = makeMockClient([
    { match: "set status = 'resolved'", rows: [{ case_id: 'k', firm_id: 'f', client_id: 'cl', blocker_type: 'missing_client_answer', owner_type: 'client' }] },
    { match: 'select event_type from bookkeeping_case_events', rows: [] },
    { match: 'select blocker_type, owner_type from bookkeeping_case_blockers', rows: [] }
  ]);
  const out = await resolveBlocker({ client: c, blockerId: 'case-blocker-1' });
  assert.equal(out.resolved, true);
  assert.equal(out.status, 'open');
  assert.ok(c.calls.some((q) => JSON.stringify(q.params).includes('case.blocker_resolved')));
});

test('resolveBlocker: already-resolved / missing → no-op', async () => {
  const c = makeMockClient([{ match: "set status = 'resolved'", rows: [] }]);
  assert.deepEqual(await resolveBlocker({ client: c, blockerId: 'x' }), { resolved: false });
});

test('getCaseDebugSnapshot: assembles case + events + links + blockers + projection', async () => {
  const c = makeMockClient([
    { match: 'select * from bookkeeping_cases where id', rows: [{ id: 'k', status: 'waiting_client', case_type: 'evidence' }] },
    { match: 'select id, event_type, actor_type', rows: [{ id: 'e1', event_type: 'evidence_request.created' }] },
    { match: 'select object_type, object_id, role, object_version', rows: [{ object_type: 'transaction', object_id: 't1', role: 'primary' }] },
    { match: 'select id, blocker_type, owner_type, status', rows: [{ id: 'b1', blocker_type: 'missing_client_answer', owner_type: 'client', status: 'open' }] },
    { match: 'select event_type from bookkeeping_case_events', rows: [] },
    { match: 'select blocker_type, owner_type from bookkeeping_case_blockers', rows: [{ blocker_type: 'missing_client_answer', owner_type: 'client' }] }
  ]);
  const snap = await getCaseDebugSnapshot({ client: c, caseId: 'k' });
  assert.equal(snap.case.id, 'k');
  assert.equal(snap.events.length, 1);
  assert.equal(snap.links.length, 1);
  assert.equal(snap.blockers.length, 1);
  assert.equal(snap.projected_status, 'waiting_client');
});

test('listShadowCasesForClient: scopes by firm + client, applies filters', async () => {
  const c = makeMockClient([{ match: 'from bookkeeping_cases', rows: [{ id: 'k', case_type: 'evidence', status: 'waiting_client' }] }]);
  const rows = await listShadowCasesForClient({ client: c, firmId: 'f', clientId: 'cl', status: 'waiting_client' });
  assert.equal(rows.length, 1);
  assert.match(c.calls[0].sql, /where firm_id = \$1 and client_id = \$2/);
  assert.match(c.calls[0].sql, /status = \$3/);
});

test('listCloseBlockersForClient: stitches open blockers under their cases, renders persisted status', async () => {
  const c = makeMockClient([
    { match: 'from bookkeeping_cases c', rows: [
      { id: 'case-a', case_type: 'evidence', status: 'waiting_client', title: 'Need bank statement', summary: null, primary_object_type: 'transaction', primary_object_id: 't1', due_at: null, last_activity_at: '2026-06-18T10:00:00Z' },
      { id: 'case-b', case_type: 'upload', status: 'blocked', title: null, summary: 'Parse failed', primary_object_type: 'document', primary_object_id: 'd9', due_at: null, last_activity_at: '2026-06-18T09:00:00Z' }
    ] },
    { match: 'where case_id = any', rows: [
      { id: 'b1', case_id: 'case-a', blocker_type: 'missing_client_answer', owner_type: 'client', reason: 'Awaiting reply', object_type: 'transaction', object_id: 't1', due_at: null, created_at: '2026-06-18T08:00:00Z' },
      { id: 'b2', case_id: 'case-b', blocker_type: 'parse_failed', owner_type: 'system', reason: 'OCR timeout', object_type: 'document', object_id: 'd9', due_at: null, created_at: '2026-06-18T07:00:00Z' }
    ] }
  ]);
  const rows = await listCloseBlockersForClient({ client: c, firmId: 'f', clientId: 'cl' });
  assert.equal(rows.length, 2);
  // Persisted status is read straight from the column (rail #1) — no event read.
  assert.equal(rows[0].status, 'waiting_client');
  assert.equal(rows[1].status, 'blocked');
  assert.ok(!c.calls.some((q) => /from bookkeeping_case_events/.test(q.sql)), 'no rebuildCaseStatus re-inference');
  // Blockers grouped under the right case.
  assert.equal(rows[0].blockers.length, 1);
  assert.equal(rows[0].blockers[0].blocker_type, 'missing_client_answer');
  assert.equal(rows[1].blockers[0].owner_type, 'system');
  // The cases query excludes terminal cases (carries LOOP_TERMINAL_STATUSES) and
  // only returns cases that still hold an open blocker.
  assert.match(c.calls[0].sql, /not \(c\.status = any\(\$3::text\[\]\)\)/);
  assert.match(c.calls[0].sql, /exists \(/);
  assert.deepEqual(c.calls[0].params[2], LOOP_TERMINAL_STATUSES);
});

test('listCloseBlockersForClient: no cases → [] without a blockers query', async () => {
  const c = makeMockClient([{ match: 'from bookkeeping_cases c', rows: [] }]);
  const rows = await listCloseBlockersForClient({ client: c, firmId: 'f', clientId: 'cl' });
  assert.deepEqual(rows, []);
  assert.equal(c.calls.length, 1);
  assert.ok(!c.calls.some((q) => /where case_id = any/.test(q.sql)));
});

test('listCloseBlockersForClient: a case with no matching blockers gets blockers: []', async () => {
  const c = makeMockClient([
    { match: 'from bookkeeping_cases c', rows: [
      { id: 'case-a', case_type: 'coding', status: 'waiting_firm', last_activity_at: '2026-06-18T10:00:00Z' }
    ] },
    { match: 'where case_id = any', rows: [] }
  ]);
  const rows = await listCloseBlockersForClient({ client: c, firmId: 'f', clientId: 'cl' });
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0].blockers, []);
});

test('listCloseBlockersForClient: missing firm/client → [] with no query', async () => {
  const c = makeMockClient();
  assert.deepEqual(await listCloseBlockersForClient({ client: c, firmId: 'f' }), []);
  assert.deepEqual(await listCloseBlockersForClient({ client: c, clientId: 'cl' }), []);
  assert.equal(c.calls.length, 0);
});

test('purgeLoopsShadowForDeletedClient: deletes all fifteen tables (spine + proposal + memory + goal layer + suspensions) by client_id', async () => {
  const c = makeMockClient([], { tablesPresent: true });
  await purgeLoopsShadowForDeletedClient({ client: c, firmId: 'f', clientId: 'cl' });
  const deleted = c.calls
    .filter((q) => /^delete from/.test(q.sql.trim()))
    .map((q) => q.sql.trim().match(/delete from (\w+)/)[1]);
  assert.deepEqual(new Set(deleted), new Set([
    // goal layer (037, append-only — purged first under the hatch)
    'loop_goal_reports', 'loop_runs', 'bookkeeping_case_dependencies',
    // case suspensions (038, append-only — purged first under the same hatch)
    'bookkeeping_case_suspensions',
    'bookkeeping_case_blockers', 'bookkeeping_case_links', 'bookkeeping_case_events',
    'bookkeeping_cases', 'loop_event_inbox', 'loop_event_outbox',
    'proposal_targets', 'check_reports', 'apply_receipts', 'proposal_cards',
    'memory_candidates'
  ]));
});

test('purgeLoopsShadowForDeletedClient: goal layer is purged BEFORE the cases/events deletes (cascade-into-append-only-guard avoidance)', async () => {
  // loop_goal_reports/loop_runs FK back to bookkeeping_cases/case_events with ON
  // DELETE CASCADE, but they are append-only — a cascaded DELETE is rejected
  // unless donna.allow_append_only_purge is set. So the explicit goal purge (which
  // sets that flag) MUST run before the case/event deletes, or client deletion
  // aborts once 037 is live.
  const c = makeMockClient([], { tablesPresent: true });
  await purgeLoopsShadowForDeletedClient({ client: c, firmId: 'f', clientId: 'cl' });
  const sqls = c.calls.map((q) => q.sql.trim());
  const idx = (re) => sqls.findIndex((s) => re.test(s));

  const hatch = idx(/set local donna\.allow_append_only_purge/);
  const goalDelete = idx(/^delete from loop_goal_reports/);
  const suspDelete = idx(/^delete from bookkeeping_case_suspensions/);
  const eventsDelete = idx(/^delete from bookkeeping_case_events/);
  const casesDelete = idx(/^delete from bookkeeping_cases\b/);

  assert.ok(hatch !== -1, 'the append-only purge hatch is opened');
  assert.ok(hatch < goalDelete, 'hatch is set before the goal-report delete');
  assert.ok(goalDelete !== -1 && goalDelete < eventsDelete, 'goal reports purged before case_events');
  assert.ok(goalDelete < casesDelete, 'goal reports purged before cases');
  // suspensions are append-only + FK-cascade off cases/events too → also purged
  // (under the hatch) before the case/event deletes.
  assert.ok(suspDelete !== -1 && suspDelete < eventsDelete, 'suspensions purged before case_events');
  assert.ok(suspDelete < casesDelete, 'suspensions purged before cases');
});

test('purgeLoopsShadowForDeletedClient: 034 absent → spine + memory purged, proposal tables skipped', async () => {
  // Spine present (033) but proposal_cards absent (034 not yet applied): the
  // proposal presence probe gates the four proposal deletes off while the six
  // spine deletes still run — a partial-migration deploy never 42P01s. The
  // memory_candidates purge (035) rides its own independent probe (present here).
  const c = makeMockClient([
    { match: "to_regclass('public.proposal_cards')", rows: [{ present: null }] }
  ], { tablesPresent: true });
  await purgeLoopsShadowForDeletedClient({ client: c, firmId: 'f', clientId: 'cl' });
  const deleted = c.calls
    .filter((q) => /^delete from/.test(q.sql.trim()))
    .map((q) => q.sql.trim().match(/delete from (\w+)/)[1]);
  assert.deepEqual(new Set(deleted), new Set([
    'loop_goal_reports', 'loop_runs', 'bookkeeping_case_dependencies',
    'bookkeeping_case_suspensions',
    'bookkeeping_case_blockers', 'bookkeeping_case_links', 'bookkeeping_case_events',
    'bookkeeping_cases', 'loop_event_inbox', 'loop_event_outbox', 'memory_candidates'
  ]));
  assert.ok(!deleted.includes('proposal_cards'), 'no proposal_cards delete when 034 absent');
});

test('purgeLoopsShadowForDeletedClient: goal layer absent → spine purged, append-only deletes skipped (no abort)', async () => {
  // Spine present (033) but the append-only layer absent (037/038 not yet applied —
  // sequential, so 037 absent ⟹ 038 absent): each append-only purge's own presence
  // probe gates its deletes (and the hatch) off, so a 033-only deploy purges the
  // spine without a 42P01 and without opening the hatch.
  const c = makeMockClient([
    { match: "to_regclass('public.loop_goal_reports')", rows: [{ present: null }] },
    { match: "to_regclass('public.bookkeeping_case_suspensions')", rows: [{ present: null }] }
  ], { tablesPresent: true });
  await purgeLoopsShadowForDeletedClient({ client: c, firmId: 'f', clientId: 'cl' });
  const deleted = c.calls
    .filter((q) => /^delete from/.test(q.sql.trim()))
    .map((q) => q.sql.trim().match(/delete from (\w+)/)[1]);
  assert.ok(!deleted.includes('loop_goal_reports'), 'no goal-report delete when 037 absent');
  assert.ok(!deleted.includes('loop_runs'), 'no loop_runs delete when 037 absent');
  assert.ok(!deleted.includes('bookkeeping_case_suspensions'), 'no suspension delete when 038 absent');
  assert.ok(!c.calls.some((q) => /allow_append_only_purge/.test(q.sql)), 'hatch not opened when the append-only layer is absent');
  assert.ok(deleted.includes('bookkeeping_cases'), 'spine still purged');
});

test('purgeLoopsShadowForDeletedClient: pre-migration → no-op (only the presence probe)', async () => {
  const c = makeMockClient([], { tablesPresent: false });
  const out = await purgeLoopsShadowForDeletedClient({ client: c, firmId: 'f', clientId: 'cl' });
  assert.deepEqual(out, { deleted: 0 });
  assert.equal(c.calls.length, 1);
  assert.match(c.calls[0].sql, /to_regclass/);
});

test('vocabulary constants are the canonical Phase 0 set (+ the 053 sync amendment)', () => {
  assert.deepEqual(LOOP_CASE_TYPES, ['evidence', 'coding', 'reconciliation', 'upload', 'sync']);
  assert.deepEqual(LOOP_CASE_STATUSES, [
    'open', 'waiting_client', 'waiting_firm', 'waiting_accountant', 'waiting_policy',
    'waiting_system', 'blocked', 'resolved', 'superseded', 'unsupported',
    'engineering_escalated', 'abandoned'
  ]);
  assert.deepEqual(LOOP_TERMINAL_STATUSES, ['resolved', 'superseded', 'unsupported', 'abandoned']);
  assert.ok(LOOP_OWNER_TYPES.includes('external_connector'));
  assert.ok(LOOP_BLOCKER_TYPES.includes('parse_stale'));
});

test('markCaseResolved: appends the case.resolved verdict and writes the terminal status', async () => {
  const c = makeMockClient([
    { match: 'insert into bookkeeping_case_events', rows: [{ id: 'case-event-r' }] },
    { match: 'select event_type from bookkeeping_case_events', rows: [{ event_type: 'case.resolved' }] }
  ]);
  const out = await markCaseResolved({ client: c, firmId: 'f', clientId: 'cl', caseId: 'case-1', reason: 'sync ok' });
  assert.equal(out.status, 'resolved');
  assert.equal(out.resolvedEventId, 'case-event-r');
  const statusWrite = c.calls.find((q) => /update bookkeeping_cases\s+set status = \$2/.test(q.sql));
  assert.ok(statusWrite, 'writes the projected status');
  assert.equal(statusWrite.params[1], 'resolved');
});

test('markCaseResolved: refuses when the verdict event could not be appended', async () => {
  const c = makeMockClient([
    { match: 'insert into bookkeeping_case_events', rows: [] }
  ]);
  const out = await markCaseResolved({ client: c, firmId: 'f', clientId: 'cl', caseId: 'case-1' });
  assert.equal(out, null);
  assert.ok(!c.calls.some((q) => /set status = \$2/.test(q.sql)), 'no status write without the verdict event');
});
