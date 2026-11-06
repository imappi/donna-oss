// Donna Loops — caseSuspension unit tests (the Step 6 case-level suspension source).
// Load-bearing properties:
//   - readActiveCaseSuspension reports the LATEST action's effect: pause -> active
//     resumable HOLD, cancel -> active terminal DROP, resume / none -> null
//   - the reader/writer/purge no-op cleanly on a pre-038 deploy (presence guard) so
//     they never abort the worker's per-event transaction
//   - only an AUTHORITY may govern autonomy (§13.6); an owner is rejected
//   - cancel is terminal — no pause/resume may follow it
//   - the client-delete purge opens the append-only hatch and hard-deletes

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CASE_SUSPENSION_ACTIONS,
  readActiveCaseSuspension, recordCaseSuspension, purgeCaseSuspensionsForDeletedClient
} from './caseSuspension.js';

const makeMockClient = (responders = [], { tablesPresent = true } = {}) => {
  const calls = [];
  const queue = [...responders];
  return {
    calls,
    query: async (sql, params) => {
      calls.push({ sql: String(sql), params });
      const text = String(sql).toLowerCase();
      if (text === 'begin' || text === 'commit' || text === 'rollback') return { rows: [], rowCount: 0 };
      if (text.startsWith('set local')) return { rows: [], rowCount: 0 };
      const idx = queue.findIndex((r) => text.includes(r.match));
      if (idx !== -1) {
        const [r] = queue.splice(idx, 1);
        if (r.throw) throw r.throw;
        return { rows: r.rows || [], rowCount: r.rowCount ?? (r.rows || []).length };
      }
      if (text.includes('to_regclass')) {
        return { rows: [{ present: tablesPresent ? 'bookkeeping_case_suspensions' : null }] };
      }
      return { rows: [], rowCount: 0 };
    }
  };
};

const susp = (action, extra = {}) => ({
  id: `case-susp-${action}`, action, reason: `${action} reason`,
  authorized_by_actor_type: 'firm_operator', authorized_by_actor_id: 'op-1',
  authority_level: 'firm_operator', created_at: '2026-06-20T00:00:00Z', ...extra
});

test('CASE_SUSPENSION_ACTIONS is the pinned pause/resume/cancel vocabulary', () => {
  assert.deepEqual(CASE_SUSPENSION_ACTIONS, ['pause', 'resume', 'cancel']);
});

test('readActiveCaseSuspension: missing args → null with no query', async () => {
  const c = makeMockClient();
  assert.equal(await readActiveCaseSuspension({ client: c, firmId: 'f', clientId: 'cl' }), null);
  assert.equal(await readActiveCaseSuspension({ client: c, firmId: 'f', caseId: 'k' }), null);
  assert.equal(c.calls.length, 0);
});

test('readActiveCaseSuspension: pre-038 deploy → null (only the presence probe)', async () => {
  const c = makeMockClient([], { tablesPresent: false });
  assert.equal(await readActiveCaseSuspension({ client: c, firmId: 'f', clientId: 'cl', caseId: 'k' }), null);
  assert.equal(c.calls.length, 1);
  assert.match(c.calls[0].sql, /to_regclass/);
});

test('readActiveCaseSuspension: no suspension rows → null (never suspended)', async () => {
  const c = makeMockClient([{ match: 'from bookkeeping_case_suspensions', rows: [] }]);
  assert.equal(await readActiveCaseSuspension({ client: c, firmId: 'f', clientId: 'cl', caseId: 'k' }), null);
});

test('readActiveCaseSuspension: latest = pause → an active resumable HOLD', async () => {
  const c = makeMockClient([{ match: 'from bookkeeping_case_suspensions', rows: [susp('pause')] }]);
  const out = await readActiveCaseSuspension({ client: c, firmId: 'f', clientId: 'cl', caseId: 'k' });
  assert.equal(out.scope, 'case');
  assert.equal(out.mode, 'paused');
  assert.equal(out.terminal, false);
  assert.equal(out.reason, 'pause reason');
  assert.equal(out.authorizedByActorType, 'firm_operator');
  assert.equal(out.suspensionId, 'case-susp-pause');
});

test('readActiveCaseSuspension: latest = cancel → an active TERMINAL drop', async () => {
  const c = makeMockClient([{ match: 'from bookkeeping_case_suspensions', rows: [susp('cancel')] }]);
  const out = await readActiveCaseSuspension({ client: c, firmId: 'f', clientId: 'cl', caseId: 'k' });
  assert.equal(out.mode, 'cancelled');
  assert.equal(out.terminal, true);
});

test('readActiveCaseSuspension: latest = resume → null (lifted)', async () => {
  const c = makeMockClient([{ match: 'from bookkeeping_case_suspensions', rows: [susp('resume')] }]);
  assert.equal(await readActiveCaseSuspension({ client: c, firmId: 'f', clientId: 'cl', caseId: 'k' }), null);
});

test('recordCaseSuspension: an OWNER (non-authority) may not suspend → throws', async () => {
  const c = makeMockClient();
  await assert.rejects(
    () => recordCaseSuspension({
      client: c, firmId: 'f', clientId: 'cl', caseId: 'k', action: 'pause', actorType: 'client'
    }),
    /authority required/
  );
  assert.equal(c.calls.length, 0); // rejected before any query
});

test('recordCaseSuspension: unknown action → throws, no query', async () => {
  const c = makeMockClient();
  await assert.rejects(
    () => recordCaseSuspension({
      client: c, firmId: 'f', clientId: 'cl', caseId: 'k', action: 'halt', actorType: 'firm_operator'
    }),
    /unknown action/
  );
  assert.equal(c.calls.length, 0);
});

test('recordCaseSuspension: missing args → null, no query', async () => {
  const c = makeMockClient();
  assert.equal(
    await recordCaseSuspension({ client: c, firmId: 'f', clientId: 'cl', action: 'pause', actorType: 'admin' }),
    null
  );
  assert.equal(c.calls.length, 0);
});

test('recordCaseSuspension: pre-038 deploy → null (only the presence probe)', async () => {
  const c = makeMockClient([], { tablesPresent: false });
  const out = await recordCaseSuspension({
    client: c, firmId: 'f', clientId: 'cl', caseId: 'k', action: 'pause', actorType: 'firm_operator'
  });
  assert.equal(out, null);
  assert.equal(c.calls.length, 1);
  assert.match(c.calls[0].sql, /to_regclass/);
});

test('recordCaseSuspension: an authority pause with no prior state → INSERTs the action', async () => {
  // no active suspension (the select returns []) → terminal check passes → insert
  const c = makeMockClient([{ match: 'from bookkeeping_case_suspensions', rows: [] }]);
  const out = await recordCaseSuspension({
    client: c, firmId: 'f', clientId: 'cl', caseId: 'k', action: 'pause',
    actorType: 'firm_operator', actorId: 'op-1', authorityLevel: 'firm_operator', reason: 'client away'
  });
  assert.equal(out.action, 'pause');
  assert.match(out.id, /^case-susp-/);
  const insert = c.calls.find((q) => /insert into bookkeeping_case_suspensions/.test(q.sql));
  assert.ok(insert, 'appended the action row');
  assert.ok(insert.params.includes('pause') && insert.params.includes('firm_operator'));
});

test('recordCaseSuspension: cancel is TERMINAL → a later resume/pause is rejected', async () => {
  // the case is already cancelled (latest action) → no further action permitted
  const c = makeMockClient([{ match: 'from bookkeeping_case_suspensions', rows: [susp('cancel')] }]);
  await assert.rejects(
    () => recordCaseSuspension({
      client: c, firmId: 'f', clientId: 'cl', caseId: 'k', action: 'resume', actorType: 'admin'
    }),
    /cancelled \(terminal\)/
  );
  assert.ok(!c.calls.some((q) => /insert into/.test(q.sql)), 'no row appended after a terminal cancel');
});

test('purgeCaseSuspensionsForDeletedClient: opens the append-only hatch and hard-deletes', async () => {
  const c = makeMockClient([
    { match: 'delete from bookkeeping_case_suspensions', rowCount: 3 }
  ], { tablesPresent: true });
  const out = await purgeCaseSuspensionsForDeletedClient({ client: c, firmId: 'f', clientId: 'cl' });
  assert.deepEqual(out, { suspensions: 3 });
  const hatch = c.calls.findIndex((q) => /set local donna\.allow_append_only_purge/.test(q.sql));
  const del = c.calls.findIndex((q) => /delete from bookkeeping_case_suspensions/.test(q.sql));
  assert.ok(hatch !== -1 && hatch < del, 'hatch opened before the delete');
});

test('purgeCaseSuspensionsForDeletedClient: pre-038 → no-op (only the presence probe)', async () => {
  const c = makeMockClient([], { tablesPresent: false });
  const out = await purgeCaseSuspensionsForDeletedClient({ client: c, firmId: 'f', clientId: 'cl' });
  assert.deepEqual(out, { suspensions: 0 });
  assert.ok(!c.calls.some((q) => /allow_append_only_purge/.test(q.sql)), 'hatch never opened pre-038');
  assert.ok(!c.calls.some((q) => /delete from/.test(q.sql)), 'nothing deleted pre-038');
});

test('purgeCaseSuspensionsForDeletedClient: missing args → no-op, no query', async () => {
  const c = makeMockClient();
  assert.deepEqual(await purgeCaseSuspensionsForDeletedClient({ client: c, firmId: 'f' }), { suspensions: 0 });
  assert.equal(c.calls.length, 0);
});
