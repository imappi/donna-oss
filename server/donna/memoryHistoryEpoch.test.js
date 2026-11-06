// Donna — BizOS Slice 2c-iii (sub-PR 5): the hard history fence. Proves the fence
// excludes ALL pre-epoch messages + summaries from the model payload (both
// directions), fails closed on unknown vintage, and that the epoch writer is
// monotonic + audited (§F/§N-D, invariant test 9).

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MEMORY_HISTORY_EPOCH_MODES,
  buildHistoryForMemoryEpoch,
  getActiveMemoryHistoryEpoch,
  enterMemoryHistoryEpoch
} from './memoryHistoryEpoch.js';

const msg = (id, created_at, over = {}) => ({ id, role: 'user', content: `m-${id}`, created_at, payload: {}, ...over });

const history = [
  msg('a', '2026-05-01T00:00:00.000Z'),                                  // pre-epoch
  msg('b', '2026-05-02T00:00:00.000Z', { role: 'assistant', content: 'your VAT date is 4 May' }), // pre-epoch legacy leak
  msg('s', '2026-05-02T06:00:00.000Z', { role: 'summary', content: 'summary of legacy facts' }),  // pre-epoch summary
  msg('c', '2026-06-01T00:00:00.000Z'),                                  // in-epoch (current turn)
  msg('d', '2026-06-01T00:01:00.000Z', { role: 'assistant' })            // in-epoch
];

const epoch = (over = {}) => ({ epoch_seq: 1, mode_entered: 'v2', boundary_at: '2026-05-15T00:00:00.000Z', ...over });

// ── pure fence ──────────────────────────────────────────────────────────────

test('buildHistoryForMemoryEpoch: no epoch → unfenced, full history', () => {
  const r = buildHistoryForMemoryEpoch({ history, epoch: null });
  assert.equal(r.fenced, false);
  assert.equal(r.messages.length, 5);
});

test('buildHistoryForMemoryEpoch: active epoch excludes ALL pre-boundary msgs + summaries (test 9)', () => {
  const r = buildHistoryForMemoryEpoch({ history, epoch: epoch() });
  assert.equal(r.fenced, true);
  assert.deepEqual(r.messages.map((m) => m.id), ['c', 'd']);
  assert.equal(r.excluded_count, 3);
  // the legacy-fact assistant turn and the summary are gone from the model view
  assert.ok(!r.messages.some((m) => /VAT date/.test(m.content)));
  assert.ok(!r.messages.some((m) => m.role === 'summary'));
});

test('buildHistoryForMemoryEpoch: legacy sentinel in pre-epoch history never reaches the model payload', () => {
  const withSentinel = [msg('x', '2026-01-01T00:00:00.000Z', { content: 'SENTINEL-LEGACY-VAT-4-MAY' }), msg('y', '2026-06-01T00:00:00.000Z')];
  const r = buildHistoryForMemoryEpoch({ history: withSentinel, epoch: epoch() });
  assert.ok(!JSON.stringify(r.messages).includes('SENTINEL-LEGACY'));
});

test('buildHistoryForMemoryEpoch: fence applies on ROLLBACK too (mode_entered legacy)', () => {
  // a v2-derived assistant turn must not linger into a legacy prompt
  const h = [msg('v', '2026-06-10T00:00:00.000Z', { role: 'assistant', content: 'v2-derived fact' }), msg('w', '2026-07-01T00:00:00.000Z')];
  const r = buildHistoryForMemoryEpoch({ history: h, epoch: epoch({ epoch_seq: 2, mode_entered: 'legacy', boundary_at: '2026-06-20T00:00:00.000Z' }) });
  assert.deepEqual(r.messages.map((m) => m.id), ['w']);
});

test('buildHistoryForMemoryEpoch: fail closed on a message with no/invalid created_at', () => {
  const h = [msg('n', null), msg('bad', 'not-a-date'), msg('ok', '2026-06-01T00:00:00.000Z')];
  const r = buildHistoryForMemoryEpoch({ history: h, epoch: epoch() });
  assert.deepEqual(r.messages.map((m) => m.id), ['ok']);
  assert.equal(r.excluded_count, 2);
});

test('buildHistoryForMemoryEpoch: a message exactly at the boundary is in-epoch (inclusive)', () => {
  const h = [msg('at', '2026-05-15T00:00:00.000Z')];
  const r = buildHistoryForMemoryEpoch({ history: h, epoch: epoch() });
  assert.deepEqual(r.messages.map((m) => m.id), ['at']);
});

// ── DB reader/writer ─────────────────────────────────────────────────────────

const makeClient = (rowsBySql = []) => {
  const queries = [];
  let call = 0;
  return {
    queries,
    query: async (text, params) => {
      queries.push({ text, params });
      if (/coalesce\(max\(epoch_seq\)/i.test(text)) return { rows: [{ max_seq: rowsBySql.maxSeq ?? 0 }] };
      if (/from memory_history_epochs/i.test(text) && /select/i.test(text)) return { rows: rowsBySql.active ? [rowsBySql.active] : [] };
      call += 1;
      return { rows: [] };
    }
  };
};

test('MEMORY_HISTORY_EPOCH_MODES pinned', () => {
  assert.deepEqual([...MEMORY_HISTORY_EPOCH_MODES], ['v2', 'legacy']);
});

test('getActiveMemoryHistoryEpoch: returns null on missing inputs / no row', async () => {
  assert.equal(await getActiveMemoryHistoryEpoch(makeClient(), { firmId: 'f1', clientId: 'c1', audience: 'owner' }), null);
  assert.equal(await getActiveMemoryHistoryEpoch(makeClient({ active: null }), { firmId: 'f1', clientId: 'c1', audience: 'owner', purpose: 'portal_owner_context' }), null);
});

test('getActiveMemoryHistoryEpoch: maps a row (boundary_at ISO)', async () => {
  const client = makeClient({ active: { id: 'e1', tenant_id: 'f1', client_id: 'c1', audience: 'owner', purpose: 'portal_owner_context', epoch_seq: 2, mode_entered: 'v2', boundary_at: '2026-06-01T00:00:00.000Z', created_at: '2026-06-01T00:00:00.000Z' } });
  const e = await getActiveMemoryHistoryEpoch(client, { firmId: 'f1', clientId: 'c1', audience: 'owner', purpose: 'portal_owner_context' });
  assert.equal(e.epoch_seq, 2);
  assert.equal(e.boundary_at, '2026-06-01T00:00:00.000Z');
});

test('enterMemoryHistoryEpoch: monotonic epoch_seq + audit row', async () => {
  const client = makeClient({ maxSeq: 2 });
  const res = await enterMemoryHistoryEpoch(client, { firmId: 'f1', clientId: 'c1', audience: 'owner', purpose: 'portal_owner_context', modeEntered: 'v2', reason: 'canary entry' });
  assert.equal(res.epoch_seq, 3);
  assert.ok(client.queries.some((q) => /insert into memory_history_epochs/i.test(q.text)));
  assert.ok(client.queries.some((q) => /insert into audit_events/i.test(q.text) && /memory_history.epoch_opened/.test(q.text)));
});

test('enterMemoryHistoryEpoch: rejects an invalid mode', async () => {
  await assert.rejects(
    () => enterMemoryHistoryEpoch(makeClient(), { firmId: 'f1', clientId: 'c1', audience: 'owner', purpose: 'p', modeEntered: 'sideways' }),
    /invalid mode_entered/
  );
});
