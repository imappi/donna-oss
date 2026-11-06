// Donna Inventory I4·posting — P7 §12 incident records: the WRITER (fake-pg). Asserts the writer
// touches ONLY inventory_posting_incidents (never the ledger, the attempts log, or the heads),
// the idempotent insert + dedupe accounting, the guarded acknowledge/resolve transitions, the
// loud-pre-migration writer vs degrade-empty reader split, and the end-to-end drain-and-record.
//   node --test server/donna/inventory/postingIncidentDb.test.js

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  insertInventoryPostingIncident,
  recordInventoryPostingIncidents,
  recordInventoryWaiterDrainIncidents,
  acknowledgeInventoryPostingIncident,
  resolveInventoryPostingIncident,
  listOpenInventoryPostingIncidents
} from './postingIncidentDb.js';

const T0 = '2026-07-12T00:00:00.000Z';

// Fake pg: an in-memory inventory_posting_incidents table with the 084 natural-key dedupe, plus
// seedable heads/retry-count reads for the drain path. Records every query.
const fake = ({ heads = [], retryCounts = [], throwCode = null } = {}) => {
  const queries = [];
  const incidents = [];
  let nextId = 1;
  const naturalKey = (r) => [r.firm_id, r.client_id, r.operation_id, r.posting_kind, r.incident_kind, r.reason_code ?? ''].join('::');
  return {
    queries,
    incidents,
    async query(sql, params = []) {
      queries.push({ sql, params });
      if (throwCode) { const e = new Error('missing'); e.code = throwCode; throw e; }
      if (sql.includes('from inventory_posting_heads')) return { rows: heads };
      if (sql.includes('from inventory_posting_attempts')) return { rows: retryCounts };
      if (sql.includes('insert into inventory_posting_incidents')) {
        const [firmId, clientId, operationId, postingKind, incidentKind, reasonCode, condition, waiterType, targetQueue, retriesUsed, retriesMax, sourceAttemptId, actorId, detail] = params;
        const row = {
          id: nextId, firm_id: firmId, client_id: clientId, operation_id: operationId, posting_kind: postingKind,
          incident_kind: incidentKind, reason_code: reasonCode, condition, waiter_type: waiterType,
          target_queue: targetQueue, retries_used: retriesUsed, retries_max: retriesMax,
          source_attempt_id: sourceAttemptId, status: 'open', opened_by_actor_id: actorId, detail,
          acknowledged_by_actor_id: null, resolved_by_actor_id: null, resolved_at: null, resolution_note: null
        };
        const dup = incidents.some((i) => ['open', 'acknowledged'].includes(i.status) && naturalKey(i) === naturalKey(row));
        if (dup) return { rows: [] }; // on conflict do nothing
        nextId += 1;
        incidents.push(row);
        return { rows: [row] };
      }
      if (sql.includes('update inventory_posting_incidents')) {
        const [firmId, clientId, incidentId, actorId, note] = params;
        const toAck = sql.includes("set status = 'acknowledged'");
        const row = incidents.find((i) => i.firm_id === firmId && i.client_id === clientId && i.id === incidentId);
        if (!row) return { rows: [] };
        if (toAck) {
          if (row.status !== 'open') return { rows: [] };
          Object.assign(row, { status: 'acknowledged', acknowledged_by_actor_id: actorId });
        } else {
          if (!['open', 'acknowledged'].includes(row.status)) return { rows: [] };
          Object.assign(row, { status: 'resolved', resolved_by_actor_id: actorId, resolved_at: T0, resolution_note: note });
        }
        return { rows: [row] };
      }
      if (sql.includes('from inventory_posting_incidents')) {
        return { rows: incidents.filter((i) => i.firm_id === params[0] && i.client_id === params[1] && ['open', 'acknowledged'].includes(i.status)) };
      }
      return { rows: [] };
    }
  };
};

const incidentPlan = (over = {}) => ({
  disposition: 'open_incident', waiter_type: 'engineering_incident', operation_id: 'op1',
  posting_kind: 'write_down', reason: 'conservation_residual', condition: 'investigate_residual',
  target_queue: 'engineering', retries_used: null, retries_max: null, attempt_id: 11, ...over
});

test('recordInventoryPostingIncidents inserts the opening dispositions and counts the rest', async () => {
  const tx = fake();
  const res = await recordInventoryPostingIncidents({
    client: tx, firmId: 'f1', clientId: 'c1', actorId: 'operator-1',
    plans: [
      incidentPlan(),
      { disposition: 'escalate', waiter_type: 'integration_system_retry', operation_id: 'op2', posting_kind: 'receipt', reason: 'missing_close_fx_rate', condition: 'await_fx_fact', target_queue: 'integration_operator', retries_used: 5, retries_max: 5, attempt_id: 12 },
      { disposition: 'wait', operation_id: 'op3', posting_kind: 'receipt', target_queue: null },
      { disposition: 'human_owned', operation_id: 'op4', posting_kind: 'receipt', target_queue: 'owner' }
    ]
  });
  assert.equal(res.opened.length, 2);
  assert.equal(res.deduped, 0);
  assert.equal(res.ignored, 2);
  const escalated = res.opened.find((r) => r.incident_kind === 'retry_exhausted');
  assert.equal(escalated.target_queue, 'integration_operator');
  assert.equal(escalated.retries_used, 5);
  assert.equal(escalated.source_attempt_id, 12);
  assert.equal(escalated.opened_by_actor_id, 'operator-1');
  // The writer touched ONLY the incidents table — never the ledger / attempts / heads.
  for (const q of tx.queries) {
    assert.match(q.sql, /inventory_posting_incidents/, `only the ops table: ${q.sql.slice(0, 60)}`);
    assert.doesNotMatch(q.sql, /ledger_journals|inventory_posting_attempts|inventory_posting_heads/);
  }
});

test('re-recording the same open plan dedupes (idempotent re-drain), and insert uses on-conflict', async () => {
  const tx = fake();
  const args = { client: tx, firmId: 'f1', clientId: 'c1', actorId: 'operator-1', plans: [incidentPlan()] };
  const first = await recordInventoryPostingIncidents(args);
  const second = await recordInventoryPostingIncidents(args);
  assert.equal(first.opened.length, 1);
  assert.equal(second.opened.length, 0);
  assert.equal(second.deduped, 1);
  assert.match(tx.queries[0].sql, /on conflict do nothing/);
});

test('a resolved incident frees the natural key — a recurrence opens a NEW record', async () => {
  const tx = fake();
  const args = { client: tx, firmId: 'f1', clientId: 'c1', actorId: 'operator-1', plans: [incidentPlan()] };
  const first = await recordInventoryPostingIncidents(args);
  await resolveInventoryPostingIncident({ client: tx, firmId: 'f1', clientId: 'c1', incidentId: first.opened[0].id, actorId: 'operator-2', note: 'fixed upstream' });
  const again = await recordInventoryPostingIncidents(args);
  assert.equal(again.opened.length, 1);
  assert.notEqual(again.opened[0].id, first.opened[0].id);
});

test('acknowledge is guarded: open → acknowledged once; resolve is terminal', async () => {
  const tx = fake();
  const { opened } = await recordInventoryPostingIncidents({ client: tx, firmId: 'f1', clientId: 'c1', actorId: 'op', plans: [incidentPlan()] });
  const id = opened[0].id;
  const acked = await acknowledgeInventoryPostingIncident({ client: tx, firmId: 'f1', clientId: 'c1', incidentId: id, actorId: 'operator-2' });
  assert.equal(acked.status, 'acknowledged');
  assert.equal(await acknowledgeInventoryPostingIncident({ client: tx, firmId: 'f1', clientId: 'c1', incidentId: id, actorId: 'operator-3' }), null, 'no re-acknowledge');
  const resolved = await resolveInventoryPostingIncident({ client: tx, firmId: 'f1', clientId: 'c1', incidentId: id, actorId: 'operator-2', note: 'done' });
  assert.equal(resolved.status, 'resolved');
  assert.equal(resolved.resolution_note, 'done');
  assert.equal(await resolveInventoryPostingIncident({ client: tx, firmId: 'f1', clientId: 'c1', incidentId: id, actorId: 'operator-2' }), null, 'resolved is terminal');
  // The guarded-transition predicates live in the SQL itself.
  const ackSql = tx.queries.find((q) => q.sql.includes("set status = 'acknowledged'")).sql;
  assert.match(ackSql, /status = 'open'/);
  const resolveSql = tx.queries.find((q) => q.sql.includes("set status = 'resolved'")).sql;
  assert.match(resolveSql, /status in \('open', 'acknowledged'\)/);
});

test('recordInventoryWaiterDrainIncidents plans the drain then records only the opening dispositions', async () => {
  const tx = fake({
    heads: [
      { attempt_id: 21, operation_id: 'op1', posting_kind: 'write_down', outcome: 'refused', waiter_type: 'engineering_incident', reason_code: 'conservation_residual', created_at: T0 },
      { attempt_id: 22, operation_id: 'op2', posting_kind: 'receipt', outcome: 'refused', waiter_type: 'integration_system_retry', reason_code: 'missing_close_fx_rate', created_at: T0 },
      { attempt_id: 23, operation_id: 'op3', posting_kind: 'shipment_cogs', outcome: 'refused', waiter_type: 'owner', created_at: T0 }
    ],
    retryCounts: [{ operation_id: 'op2', posting_kind: 'receipt', retry_count: 99 }] // exhausted → escalate
  });
  const res = await recordInventoryWaiterDrainIncidents({ client: tx, firmId: 'f1', clientId: 'c1', actorId: 'drain-cron', now: T0 });
  assert.equal(res.plan.total, 3);
  assert.equal(res.opened.length, 2);
  assert.equal(res.ignored, 1);
  const engineering = res.opened.find((r) => r.incident_kind === 'engineering_incident');
  assert.equal(engineering.source_attempt_id, 21);
  assert.equal(engineering.target_queue, 'engineering');
});

test('the WRITER fails loudly pre-migration; the READER degrades to an empty queue', async () => {
  await assert.rejects(
    recordInventoryPostingIncidents({ client: fake({ throwCode: '42P01' }), firmId: 'f1', clientId: 'c1', actorId: 'op', plans: [incidentPlan()] }),
    /missing/
  );
  assert.deepEqual(await listOpenInventoryPostingIncidents(fake({ throwCode: '42P01' }), 'f1', 'c1'), []);
});

test('missing required args throw (no silent unattributed incident)', async () => {
  await assert.rejects(recordInventoryPostingIncidents({ client: fake(), firmId: 'f1', clientId: 'c1', plans: [] }), /actorId/);
  await assert.rejects(acknowledgeInventoryPostingIncident({ client: fake(), firmId: 'f1', clientId: 'c1', actorId: 'op' }), /incidentId/);
  await assert.rejects(resolveInventoryPostingIncident({ client: fake(), firmId: 'f1', clientId: 'c1', incidentId: 1 }), /actorId/);
});

test('listOpenInventoryPostingIncidents returns only unresolved incidents', async () => {
  const tx = fake();
  const { opened } = await recordInventoryPostingIncidents({
    client: tx, firmId: 'f1', clientId: 'c1', actorId: 'op',
    plans: [incidentPlan(), incidentPlan({ operation_id: 'op9', reason: 'other_reason' })]
  });
  await resolveInventoryPostingIncident({ client: tx, firmId: 'f1', clientId: 'c1', incidentId: opened[0].id, actorId: 'op', note: 'n' });
  const open = await listOpenInventoryPostingIncidents(tx, 'f1', 'c1');
  assert.equal(open.length, 1);
  assert.equal(open[0].operation_id, 'op9');
});
