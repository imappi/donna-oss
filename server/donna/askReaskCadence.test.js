// Re-ask cadence (F9; design 2026-07-06 §3 — nudge 7d, again 14d, then
// escalate to the firm). Mock-pg harness (substring handlers). Pins:
//   - flag off ⇒ clean skip (born on the plane, envFallback false);
//   - shadow ⇒ would-run receipted, nothing mutated;
//   - an overdue ask below the send ceiling is NUDGED (send_count +1,
//     due_at advanced, audit evidence_request.nudged), in its own txn;
//   - an overdue ask AT the ceiling is ESCALATED exactly once
//     (request_payload.escalated_to_firm + due_at cleared + audit
//     evidence_request.escalated_to_firm + the firm-owned case blocker);
//   - a poisoned row rolls back alone; the sweep continues.

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  runAskReaskSweep, askReaskNudgeDays, ASK_REASK_MAX_SEND_COUNT, REASK_CADENCE_FLAG_KEY
} from './askReaskCadence.js';

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
const callsMatching = (client, needle) => client.calls.filter((c) => c.sql.toLowerCase().includes(needle));

const cannedConfig = (rows) => ({ match: 'from client_capability_config', rows });
const configRowAt = (stage) => [{ flag_key: REASK_CADENCE_FLAG_KEY, stage, source: 'manual', client_id: 'client-1' }];
// The overdue gather is the only SELECT ... FROM client_evidence_requests in
// the sweep (the nudge/escalate writes are UPDATEs, which don't contain this
// substring).
const cannedOverdue = (rows) => ({ match: 'from client_evidence_requests', rows });

const OVERDUE_ROW = (overrides = {}) => ({
  id: 'evr-1',
  transaction_id: 'tx-1',
  question: 'Who was check 3851 paid to?',
  evidence_type: 'business_purpose',
  send_count: 1,
  due_at: '2026-06-28T10:00:00Z',
  last_sent_at: '2026-06-21T10:00:00Z',
  first_sent_at: '2026-06-21T10:00:00Z',
  created_at: '2026-06-21T09:00:00Z',
  request_payload: { evidence_request: { id: 'evr-1', question: 'Who was check 3851 paid to?' } },
  ...overrides
});

const NOW = new Date('2026-07-07T10:00:00Z').getTime();

await test('the nudge interval is a tuning knob (env), default 7 days; ceiling is 3 sends', () => {
  assert.equal(askReaskNudgeDays({}), 7);
  assert.equal(askReaskNudgeDays({ ASK_REASK_NUDGE_DAYS: '10' }), 10);
  assert.equal(ASK_REASK_MAX_SEND_COUNT, 3);
});

await test('flag off (no plane row): clean skip, nothing queried beyond config', async () => {
  const client = makeMockClient([cannedConfig([])]);
  const out = await runAskReaskSweep({ client, firmId: 'firm-1', clientId: 'client-1', now: NOW });
  assert.equal(out.skipped, true);
  assert.equal(out.reason, 'flag_off');
  assert.ok(!hasCall(client, 'escalated_to_firm'), 'overdue gather never ran');
});

await test('shadow: the would-run is receipted, nothing mutated', async () => {
  const client = makeMockClient([
    cannedConfig(configRowAt('shadow')),
    cannedOverdue([OVERDUE_ROW(), OVERDUE_ROW({ id: 'evr-2', send_count: 3 })])
  ]);
  const out = await runAskReaskSweep({ client, firmId: 'firm-1', clientId: 'client-1', now: NOW });
  assert.equal(out.shadow, true);
  assert.equal(out.considered, 2);
  assert.equal(out.nudged, 0);
  assert.equal(out.escalated, 0);
  assert.ok(hasCall(client, 'reask_would_run'), 'shadow receipt written');
  assert.ok(!hasCall(client, 'update client_evidence_requests'), 'nothing mutated at shadow');
});

await test('canary: an overdue ask below the ceiling is nudged — send_count +1, due_at advanced, audited', async () => {
  const client = makeMockClient([
    cannedConfig(configRowAt('canary')),
    cannedOverdue([OVERDUE_ROW()])
  ]);
  const out = await runAskReaskSweep({ client, firmId: 'firm-1', clientId: 'client-1', now: NOW });
  assert.equal(out.nudged, 1);
  assert.equal(out.escalated, 0);
  const nudge = client.calls.find((c) => c.sql.includes('set send_count = $3'));
  assert.ok(nudge, 'nudge update ran');
  assert.equal(nudge.params[2], 2, 'send_count 1 → 2');
  assert.equal(nudge.params[4], new Date(NOW + 7 * 86400000).toISOString(), 'due_at advanced one interval');
  assert.ok(hasCall(client, 'evidence_request.nudged'), 'nudge audited');
  assert.ok(!hasCall(client, 'due_at = null'), 'no escalation ran');
});

await test('canary: an overdue ask at the ceiling escalates exactly once — receipt, audit, firm blocker; re-ask clock stops', async () => {
  const client = makeMockClient([
    cannedConfig(configRowAt('canary')),
    cannedOverdue([OVERDUE_ROW({ id: 'evr-3', send_count: 3 })]),
    { match: 'to_regclass', rows: [{ present: 'x' }] },
    // openOrFindCase probe + insert path: existing case found.
    { match: 'from bookkeeping_cases', rows: [{ id: 'case-9', status: 'open' }] }
  ]);
  const out = await runAskReaskSweep({ client, firmId: 'firm-1', clientId: 'client-1', now: NOW });
  assert.equal(out.nudged, 0);
  assert.equal(out.escalated, 1);
  const escalate = client.calls.find((c) => c.sql.includes('due_at = null'));
  assert.ok(escalate, 'escalation update ran (due_at cleared — the re-ask clock stops)');
  const payloadArg = escalate.params.find((p) => typeof p === 'string' && p.includes('escalated_to_firm'));
  assert.ok(payloadArg.includes('owner_unresponsive'), 'the named exception');
  assert.ok(hasCall(client, 'evidence_request.escalated_to_firm'), 'escalation audited');
  assert.ok(hasCall(client, 'bookkeeping_case_blockers'), 'firm-queue surface row attempted');
});

await test('a poisoned row rolls back alone; the rest of the sweep continues', async () => {
  let failedOnce = false;
  const client = makeMockClient([
    cannedConfig(configRowAt('canary')),
    cannedOverdue([OVERDUE_ROW({ id: 'evr-bad' }), OVERDUE_ROW({ id: 'evr-good' })]),
    {
      match: 'set send_count = $3',
      rows: () => {
        if (!failedOnce) { failedOnce = true; throw new Error('boom'); }
        return [];
      }
    }
  ]);
  // The throwing handler consumes the first nudge; the second must still land.
  const out = await runAskReaskSweep({ client, firmId: 'firm-1', clientId: 'client-1', now: NOW });
  assert.equal(out.errors, 1);
  assert.equal(out.nudged, 1);
  assert.ok(callsMatching(client, 'rollback').length >= 1, 'poisoned row rolled back');
});
