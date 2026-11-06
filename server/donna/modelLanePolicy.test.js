// Q6c — the model-policy store, pinned. The load-bearing properties: the
// qualified-set guard (the store is where the free picker stays
// structurally impossible), audit-as-precondition (receipt and policy
// commit together or neither), client-over-firm read precedence, and
// fail-closed absence semantics (missing table / no row ⇒ null ⇒ the
// strong default decides).

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  MODEL_LANE_POLICY_SET_ACTION,
  clearLaneDecidingPolicy,
  listLaneDecidingPolicies,
  readLaneDecidingPolicy,
  setLaneDecidingPolicy
} from './modelLanePolicy.js';
import { getLane } from './modelLanes.js';

const LANE = 'bank_line_disposition';
const QUALIFIED_RUNG = getLane(LANE).qualified.find((m) => m !== 'claude-opus-4-8');

const makeMockClient = (responses = []) => {
  const calls = [];
  const reserved = [...responses];
  return {
    calls,
    query: async (sql, params) => {
      calls.push({ sql: String(sql), params });
      const text = String(sql).trim().toLowerCase();
      if (text === 'begin' || text === 'commit' || text === 'rollback') return { rows: [] };
      const idx = reserved.findIndex((r) => text.includes(r.match));
      if (idx !== -1) {
        const [response] = reserved.splice(idx, 1);
        if (response.throw) throw response.throw;
        return { rows: response.rows || [] };
      }
      return { rows: [] };
    }
  };
};

const TABLE_PRESENT = { match: 'to_regclass', rows: [{ present: 'model_lane_policy' }] };

await test('set refuses an ungoverned lane and a model outside the qualified set — the feed rail', async () => {
  await assert.rejects(
    () => setLaneDecidingPolicy({ client: makeMockClient(), firmId: 'f1', laneId: 'document_routing', decidingModel: 'x' }),
    (err) => err.code === 'LANE_NOT_GOVERNED'
  );
  await assert.rejects(
    () => setLaneDecidingPolicy({ client: makeMockClient(), firmId: 'f1', laneId: LANE, decidingModel: 'gpt-5.4-nano' }),
    (err) => err.code === 'MODEL_NOT_QUALIFIED'
  );
  await assert.rejects(
    () => setLaneDecidingPolicy({ client: makeMockClient(), firmId: 'f1', laneId: 'nope', decidingModel: 'x' }),
    (err) => err.code === 'UNKNOWN_LANE'
  );
});

await test('set closes the prior row, inserts the new one, and receipts — one transaction', async () => {
  const client = makeMockClient([
    { match: 'update model_lane_policy', rows: [{ deciding_model: 'claude-opus-4-8', basis: 'experiment' }] }
  ]);
  const outcome = await setLaneDecidingPolicy({
    client, firmId: 'f1', laneId: LANE, decidingModel: QUALIFIED_RUNG,
    basis: 'experiment', reason: 'model lab', actorType: 'firm_member', actorId: 'kari@books.example'
  });
  assert.equal(outcome.deciding_model, QUALIFIED_RUNG);
  const sqls = client.calls.map((c) => c.sql);
  const beginIdx = sqls.findIndex((s) => s === 'begin');
  const closeIdx = sqls.findIndex((s) => s.includes('update model_lane_policy'));
  const insertIdx = sqls.findIndex((s) => s.includes('insert into model_lane_policy'));
  const auditIdx = sqls.findIndex((s) => s.includes('insert into audit_events'));
  const commitIdx = sqls.findIndex((s) => s === 'commit');
  assert.ok(beginIdx < closeIdx && closeIdx < insertIdx && insertIdx < auditIdx && auditIdx < commitIdx,
    'close → insert → receipt, inside one transaction');
  const audit = client.calls[auditIdx];
  assert.equal(audit.params[4], MODEL_LANE_POLICY_SET_ACTION);
  const metadata = JSON.parse(audit.params[7]);
  assert.equal(metadata.deciding_model, QUALIFIED_RUNG);
  assert.equal(metadata.prior.deciding_model, 'claude-opus-4-8', 'the receipt records what the flip replaced');
});

await test('a failed receipt rolls the policy back — no silent flip', async () => {
  const client = makeMockClient([
    { match: 'insert into audit_events', throw: new Error('audit write down') }
  ]);
  await assert.rejects(() => setLaneDecidingPolicy({
    client, firmId: 'f1', laneId: LANE, decidingModel: QUALIFIED_RUNG
  }));
  assert.ok(client.calls.some((c) => c.sql === 'rollback'), 'audit-as-precondition: no receipt, no policy');
});

await test('read: absent table or no row is null (the strong default decides); client row wins over firm-wide', async () => {
  const noTable = makeMockClient([{ match: 'to_regclass', rows: [{ present: null }] }]);
  assert.equal(await readLaneDecidingPolicy({ client: noTable, firmId: 'f1', clientId: 'c1', laneId: LANE }), null);

  const empty = makeMockClient([TABLE_PRESENT]);
  assert.equal(await readLaneDecidingPolicy({ client: empty, firmId: 'f1', clientId: 'c1', laneId: LANE }), null);

  const withRow = makeMockClient([
    TABLE_PRESENT,
    { match: 'order by client_id nulls last', rows: [{ id: 'p1', client_id: 'c1', lane: LANE, deciding_model: QUALIFIED_RUNG, basis: 'experiment', reason: null, valid_from: '2026-08-16T00:00:00Z' }] }
  ]);
  const policy = await readLaneDecidingPolicy({ client: withRow, firmId: 'f1', clientId: 'c1', laneId: LANE });
  assert.equal(policy.deciding_model, QUALIFIED_RUNG);
  assert.equal(policy.basis, 'experiment');
  const readSql = withRow.calls.find((c) => c.sql.includes('order by client_id nulls last'));
  assert.ok(readSql, 'the read orders client rows before the firm-wide row — override precedence');
});

await test('clear with nothing active is a no-op without a receipt; with a row it receipts the prior', async () => {
  const noop = makeMockClient([]);
  const cleared = await clearLaneDecidingPolicy({ client: noop, firmId: 'f1', laneId: LANE });
  assert.equal(cleared.cleared, false);
  assert.ok(!noop.calls.some((c) => c.sql.includes('insert into audit_events')), 'no change, no receipt');

  const active = makeMockClient([
    { match: 'update model_lane_policy', rows: [{ deciding_model: QUALIFIED_RUNG, basis: 'experiment' }] }
  ]);
  const outcome = await clearLaneDecidingPolicy({ client: active, firmId: 'f1', laneId: LANE });
  assert.equal(outcome.cleared, true);
  assert.ok(active.calls.some((c) => c.sql.includes('insert into audit_events')));
});

await test('list returns active rows only, shaped for the report', async () => {
  const client = makeMockClient([
    TABLE_PRESENT,
    { match: 'valid_to is null', rows: [{ id: 'p1', client_id: null, lane: LANE, deciding_model: QUALIFIED_RUNG, basis: 'experiment', reason: 'lab', valid_from: '2026-08-16T00:00:00Z' }] }
  ]);
  const rows = await listLaneDecidingPolicies({ client, firmId: 'f1' });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].deciding_model, QUALIFIED_RUNG);
});
