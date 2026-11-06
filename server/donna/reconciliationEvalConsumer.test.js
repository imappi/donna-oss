// Donna Loops — PR 1b consumer tests (the reconciliation fresh-evaluation CONSUMER).
//
// Mock-pg + mock-fetch harness (mirrors bankLineDispositionLlm.test.js). Pins the
// per-row lifecycle: the suspension/tier re-gate (inert at shadow, drains at canary+),
// the stale-result rejection (case_version), the sticky-match / unsupported-target
// drops, the scoped re-match (the client answer fed to the strong call), the persisted
// fresh verdict, the deterministic completion event (idempotency = evaluation id), and
// the outbox row flipped dispatched. The live LLM path validates in CI; here fetch is
// mocked and the DB is a substring-matched mock client.

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  runReconciliationEvalRequest,
  drainReconciliationEvalRequests,
  RECON_EVAL_REQUEST_EVENT,
  RECON_EVAL_COMPLETED_EVENT
} from './reconciliationEvalConsumer.js';
// RT-11b (2026-09-02): the disposition ceiling FOLLOWS THE PACK (reconciliation.
// disposition_ceiling, resolved from the client's canonical jurisdiction); env
// is the only override and no pack ⇒ the guard fails closed. This file's
// fixtures carry no pack-resolvable jurisdiction, so the ceiling is pinned
// through the env override here (the family-matcher tests' convention for
// RECONCILIATION_AUTO_MATCH_MATERIALITY_CEILING). The pack path is pinned in
// dispositionMateriality.test.js and materialityCeilingPackAppliancePgLifecycle.test.js.
process.env.DISPOSITION_MATERIALITY_CEILING = '500';

// Non-consuming substring mock: the consumer makes many queries, several repeated, so
// handlers match by substring and are reusable (unlike the one-shot splice harness).
// Order handlers specific-first; begin/commit/rollback are no-ops.
const makeMockClient = (handlers = []) => {
  const calls = [];
  return {
    calls,
    query: async (sql, params) => {
      calls.push({ sql: String(sql), params });
      const text = String(sql).trim().toLowerCase();
      if (text === 'begin' || text === 'commit' || text === 'rollback') return { rows: [] };
      for (const h of handlers) {
        if (text.includes(h.match)) {
          if (h.throw) throw h.throw;
          const rows = typeof h.rows === 'function' ? h.rows() : (h.rows || []);
          // rowCount mirrors a real pg result — the outbox CAS helpers (claim/mark/
          // drop/fail) gate on result.rowCount, not rows.length.
          return { rows, rowCount: rows.length };
        }
      }
      return { rows: [], rowCount: 0 };
    }
  };
};

const findCall = (client, needle) => client.calls.find((c) => c.sql.toLowerCase().includes(needle));
const hasCall = (client, needle) => Boolean(findCall(client, needle));

const AUTO_EXPLAIN = {
  disposition: 'auto_explain', materiality: 'immaterial',
  expense_kind: 'software_subscription', confidence: 0.92,
  reasoning: 'Recurring SaaS sub from a known vendor.'
};

const makeFetchCapture = (responseBody) => {
  const captured = {};
  const fetchImpl = async (_url, opts) => {
    const body = JSON.parse(opts.body);
    captured.system = body.system;
    captured.user = body.messages?.[0]?.content;
    return { ok: true, status: 200, json: async () => ({ content: [{ text: JSON.stringify(responseBody) }] }) };
  };
  return { fetchImpl, captured };
};
const fetchShouldNotRun = async () => { throw new Error('LLM should not be called'); };

// Canary env + firm metadata so the gate ALLOWS the canary+ proposal_creation action.
const CANARY_ENV = { LOOPS_TIER: 'canary' };
const CANARY_FIRM = { metadata: { loops: { tier: 'canary' } } };

// A graduated-firm row + the standard per-row reads. `caseVersion` is the case's
// CURRENT version; `txReconStatus` lets a test settle the line. `answerReply` feeds
// client_evidence_requests; `sticky` / `suspensionRow` toggle those branches.
const baseHandlers = ({
  firm = CANARY_FIRM, caseVersion = 6, caseStatus = 'open',
  txReconStatus = null, answerReply = 'Our monthly Figma subscription.',
  sticky = false, suspensionPresent = false, suspensionRow = null
} = {}) => [
  { match: 'select metadata from firms', rows: [firm] },
  { match: "to_regclass('public.bookkeeping_case_suspensions')", rows: [{ present: suspensionPresent ? 'x' : null }] },
  { match: 'from bookkeeping_case_suspensions', rows: suspensionRow ? [suspensionRow] : [] },
  { match: "set status = 'dispatching'", rows: [{ id: 'ob-1' }] },         // claimOutboxRow
  { match: "set status = 'dispatched'", rows: [{ id: 'ob-1' }] },          // markOutboxDispatched
  { match: "set status = 'cancelled'", rows: [{ id: 'ob-1' }] },           // dropOutboxRow
  { match: "set status = 'failed'", rows: [{ id: 'ob-1' }] },              // failOutboxRow
  { match: 'from bookkeeping_cases', rows: [{ id: 'case-recon-1', status: caseStatus, case_version: caseVersion }] },
  { match: "status in ('confirmed', 'auto_matched')", rows: sticky ? [{ '?column?': 1 }] : [] },
  { match: 'from client_evidence_requests', rows: answerReply ? [{ response_payload: { reply: answerReply } }] : [] },
  { match: 'and id = $3', rows: [{ id: 'tx-1', money_out: 12, currency: 'EUR', description: 'FIGMA', reconciliation_status: txReconStatus }] },
  { match: 'money_out > 0', rows: [] },
  { match: 'from clients where firm_id', rows: [] },
  { match: 'from xero_contacts', rows: [] },
  { match: 'insert into reconciliation_evaluations', rows: [] },
  { match: 'insert into loop_event_inbox', rows: [{ id: 'inbox-1' }] }
];

const makeRow = (payloadOverrides = {}, overrides = {}) => ({
  id: 'ob-1', firm_id: 'firm-1', client_id: 'client-1',
  event_type: RECON_EVAL_REQUEST_EVENT, object_type: 'transaction', object_id: 'tx-1',
  status: 'pending', attempts: 0,
  payload: {
    case_id: 'case-recon-1', case_version: 5,
    target_type: 'transaction', target_id: 'tx-1',
    trigger_event_id: 'evt-1', run_id: 'run-1',
    reason: 'dependency_resolved_requires_fresh_reconciliation_judgment',
    ...payloadOverrides
  },
  ...overrides
});

// ── happy path ─────────────────────────────────────────────────────────
await test('dispatches: re-matches the line with the answer, stamps the fresh verdict, emits the completion', async () => {
  const client = makeMockClient(baseHandlers());
  const { fetchImpl, captured } = makeFetchCapture(AUTO_EXPLAIN);
  const out = await runReconciliationEvalRequest({
    client, row: makeRow(), apiKeyOverride: 'sk-test', fetchImpl, env: CANARY_ENV
  });

  assert.equal(out.status, 'dispatched');
  assert.equal(out.verdict, 'auto_explained');
  assert.ok(out.evaluationId?.startsWith('recon-eval-'));

  // The client's answer reached the re-match prompt.
  assert.ok(captured.user.includes('Our monthly Figma subscription.'), 'answer fed as context');
  assert.ok(/UNTRUSTED CONTENT BOUNDARY/i.test(captured.system), '§6 guard pinned with the answer');

  // A fresh verdict was stamped against the SAME (transaction, family) the wake reads.
  const stamp = findCall(client, 'insert into reconciliation_evaluations');
  assert.equal(stamp.params[3], 'transaction');
  assert.equal(stamp.params[4], 'tx-1');
  assert.equal(stamp.params[6], 'auto_explained');

  // The completion inbox event: deterministic id = the evaluation id; carries the case.
  const completion = findCall(client, 'insert into loop_event_inbox');
  assert.equal(completion.params[3], 'reconciliation_eval', 'source namespaced');
  assert.equal(completion.params[4], out.evaluationId, 'source_event_id = evaluation id (idempotent)');
  assert.equal(completion.params[5], 'reconciliation.evaluation_completed');
  assert.equal(completion.params[6], 'transaction');
  assert.equal(completion.params[7], 'tx-1');
  const payload = JSON.parse(completion.params[9]);
  assert.equal(payload.case_id, 'case-recon-1');
  assert.equal(payload.verdict, 'auto_explained');
  assert.equal(payload.based_on_case_version, 5);

  assert.ok(hasCall(client, "set status = 'dispatched'"), 'outbox row marked dispatched');
});

await test('the emitted completion type matches the exported constant', () => {
  assert.equal(RECON_EVAL_COMPLETED_EVENT, 'reconciliation.evaluation_completed');
  assert.equal(RECON_EVAL_REQUEST_EVENT, 'reconciliation.evaluation_requested');
});

// ── gating: inert at shadow ──────────────────────────────────────────────
await test('held at shadow: proposal_creation is canary+, so the row is left pending (no claim, no spend)', async () => {
  const client = makeMockClient(baseHandlers({ firm: { metadata: {} } }));
  const out = await runReconciliationEvalRequest({
    client, row: makeRow(), apiKeyOverride: 'sk-test', fetchImpl: fetchShouldNotRun,
    env: { LOOPS_TIER: 'shadow' }
  });
  assert.equal(out.status, 'held');
  assert.equal(out.reason, 'tier_too_low');
  assert.ok(!hasCall(client, "set status = 'dispatching'"), 'never claimed (no churn)');
  assert.ok(!hasCall(client, 'insert into reconciliation_evaluations'), 'no verdict stamped');
});

// ── terminal case suspension drops; resumable holds ──────────────────────
await test('a cancelled (terminal) case DROPS the row; a pause HOLDS it', async () => {
  const cancelled = makeMockClient(baseHandlers({
    suspensionPresent: true,
    suspensionRow: { id: 's1', action: 'cancel', reason: 'closed', authorized_by_actor_type: 'firm_operator' }
  }));
  const dropOut = await runReconciliationEvalRequest({
    client: cancelled, row: makeRow(), apiKeyOverride: 'sk-test', fetchImpl: fetchShouldNotRun, env: CANARY_ENV
  });
  assert.equal(dropOut.status, 'dropped');
  assert.equal(dropOut.reason, 'case_cancelled');
  assert.ok(hasCall(cancelled, "set status = 'cancelled'"), 'row terminally dropped');

  const paused = makeMockClient(baseHandlers({
    suspensionPresent: true,
    suspensionRow: { id: 's2', action: 'pause', reason: 'hold', authorized_by_actor_type: 'firm_operator' }
  }));
  const holdOut = await runReconciliationEvalRequest({
    client: paused, row: makeRow(), apiKeyOverride: 'sk-test', fetchImpl: fetchShouldNotRun, env: CANARY_ENV
  });
  assert.equal(holdOut.status, 'held');
  assert.ok(!hasCall(paused, "set status = 'cancelled'"), 'a paused case is not dropped');
});

// ── stale-result rejection (case_version) ────────────────────────────────
await test('a superseded case_version drops the row without spending a token or emitting a completion', async () => {
  // requested=5; current=8 (> requested+1=6) → a newer wake superseded this request.
  const client = makeMockClient(baseHandlers({ caseVersion: 8 }));
  const out = await runReconciliationEvalRequest({
    client, row: makeRow({ case_version: 5 }), apiKeyOverride: 'sk-test', fetchImpl: fetchShouldNotRun, env: CANARY_ENV
  });
  assert.equal(out.status, 'dropped');
  assert.equal(out.reason, 'superseded_case_version');
  assert.ok(!hasCall(client, 'insert into reconciliation_evaluations'), 'no re-match');
  assert.ok(!hasCall(client, 'insert into loop_event_inbox'), 'no completion');
});

await test('the expected +1 bump from the requesting wake is NOT treated as stale', async () => {
  // requested=5; current=6 (= requested+1, the request wake’s own CAS) → process.
  const client = makeMockClient(baseHandlers({ caseVersion: 6 }));
  const out = await runReconciliationEvalRequest({
    client, row: makeRow({ case_version: 5 }), apiKeyOverride: 'sk-test',
    fetchImpl: makeFetchCapture(AUTO_EXPLAIN).fetchImpl, env: CANARY_ENV
  });
  assert.equal(out.status, 'dispatched');
});

await test('a case that vanished drops the row', async () => {
  const client = makeMockClient(baseHandlers().map((h) => h.match === 'from bookkeeping_cases' ? { ...h, rows: [] } : h));
  const out = await runReconciliationEvalRequest({
    client, row: makeRow(), apiKeyOverride: 'sk-test', fetchImpl: fetchShouldNotRun, env: CANARY_ENV
  });
  assert.equal(out.status, 'dropped');
  assert.equal(out.reason, 'case_absent');
});

// ── already settled / unsupported target / malformed ─────────────────────
await test('a sticky match settles the line → dropped (INV-4), no re-match', async () => {
  const client = makeMockClient(baseHandlers({ sticky: true }));
  const out = await runReconciliationEvalRequest({
    client, row: makeRow(), apiKeyOverride: 'sk-test', fetchImpl: fetchShouldNotRun, env: CANARY_ENV
  });
  assert.equal(out.status, 'dropped');
  assert.equal(out.reason, 'already_settled');
  assert.ok(!hasCall(client, 'insert into reconciliation_evaluations'));
});

await test('a non-transaction target is dropped (unsupported_target_type), not parked', async () => {
  const client = makeMockClient(baseHandlers());
  const out = await runReconciliationEvalRequest({
    client, row: makeRow({ target_type: 'document', target_id: 'doc-1' }, { object_type: 'document', object_id: 'doc-1' }),
    apiKeyOverride: 'sk-test', fetchImpl: fetchShouldNotRun, env: CANARY_ENV
  });
  assert.equal(out.status, 'dropped');
  assert.equal(out.reason, 'unsupported_target_type');
});

await test('a malformed request (no case anchor) is dropped before gating', async () => {
  const client = makeMockClient(baseHandlers());
  const out = await runReconciliationEvalRequest({
    client, row: makeRow({ case_id: null }), apiKeyOverride: 'sk-test', fetchImpl: fetchShouldNotRun, env: CANARY_ENV
  });
  assert.equal(out.status, 'dropped');
  assert.equal(out.reason, 'malformed_request');
  assert.ok(!hasCall(client, "set status = 'dispatching'"), 'never claimed');
});

// ── the line went away after the request → drop, not retry forever ───────
await test('the line being gone drops the row (transaction_absent)', async () => {
  const client = makeMockClient(baseHandlers().map((h) => h.match === 'and id = $3' ? { ...h, rows: [] } : h));
  const out = await runReconciliationEvalRequest({
    client, row: makeRow(), apiKeyOverride: 'sk-test', fetchImpl: makeFetchCapture(AUTO_EXPLAIN).fetchImpl, env: CANARY_ENV
  });
  assert.equal(out.status, 'dropped');
  assert.equal(out.reason, 'transaction_absent');
});

// ── wrong event type is ignored ──────────────────────────────────────────
await test('a row of the wrong event_type is skipped (defensive)', async () => {
  const client = makeMockClient(baseHandlers());
  const out = await runReconciliationEvalRequest({
    client, row: makeRow({}, { event_type: 'something.else' }), apiKeyOverride: 'sk-test', fetchImpl: fetchShouldNotRun, env: CANARY_ENV
  });
  assert.equal(out.status, 'skipped');
  assert.equal(out.reason, 'wrong_event_type');
});

// ── drain-level: master gate + event-type filter ─────────────────────────
await test('drain — skips entirely when loops are off (no token spend)', async () => {
  const client = makeMockClient(baseHandlers());
  const out = await drainReconciliationEvalRequests({ client, env: {}, fetchImpl: fetchShouldNotRun });
  assert.equal(out.skipped, true);
  assert.equal(out.reason, 'loops_off');
});

await test('drain — processes only reconciliation.evaluation_requested rows', async () => {
  const requestRow = makeRow();
  const otherRow = { ...makeRow(), id: 'ob-2', event_type: 'case.resolved' };
  const handlers = [
    { match: "to_regclass('public.bookkeeping_cases')", rows: [{ present: 'bookkeeping_cases' }] },
    { match: 'from loop_event_outbox', rows: [requestRow, otherRow] },
    ...baseHandlers()
  ];
  const client = makeMockClient(handlers);
  const out = await drainReconciliationEvalRequests({
    client, apiKeyOverride: 'sk-test', fetchImpl: makeFetchCapture(AUTO_EXPLAIN).fetchImpl, env: CANARY_ENV
  });
  assert.equal(out.considered, 2);
  assert.equal(out.planned, 1, 'only the eval-request row is a candidate');
  assert.equal(out.dispatched, 1);
});

// ── F-19: the drain plans before it claims ────────────────────────────────────
// readDispatchableOutbox deliberately returns 'dispatching' rows so a crashed
// worker's row can be reclaimed. The claim CAS keys on (id, status, attempts) —
// and an in-flight worker has ALREADY bumped attempts — so claiming straight off
// the raw read let the next tick re-claim a live row and spend a second model
// call on it. The drain now runs the same planner the dispatcher does.

await test('drain — a row another worker is still running is deferred, never re-claimed', async () => {
  const NOW = Date.parse('2026-07-27T12:00:00Z');
  const inFlight = makeRow({}, {
    status: 'dispatching', attempts: 1,
    // Claimed one minute ago — inside the 5-minute stuck window.
    last_error: { at: new Date(NOW - 60_000).toISOString(), phase: 'dispatching' }
  });
  const client = makeMockClient([
    { match: "to_regclass('public.bookkeeping_cases')", rows: [{ present: 'bookkeeping_cases' }] },
    { match: 'from loop_event_outbox', rows: [inFlight] },
    ...baseHandlers()
  ]);
  const out = await drainReconciliationEvalRequests({
    client, apiKeyOverride: 'sk-test', fetchImpl: fetchShouldNotRun,
    env: CANARY_ENV, asOf: NOW
  });
  assert.equal(out.planned, 1);
  assert.equal(out.deferred, 1, 'held behind the stuck window');
  assert.equal(out.dispatched, 0);
  assert.ok(!hasCall(client, "set status = 'dispatching'"), 'never re-claimed');
  assert.ok(!hasCall(client, 'insert into reconciliation_evaluations'), 'no second verdict');
});

await test('drain — a row stuck past the window IS reclaimed (a crashed worker heals)', async () => {
  const NOW = Date.parse('2026-07-27T12:00:00Z');
  const stuck = makeRow({}, {
    status: 'dispatching', attempts: 1,
    // Claimed an hour ago — the worker is gone.
    last_error: { at: new Date(NOW - 3_600_000).toISOString(), phase: 'dispatching' }
  });
  const client = makeMockClient([
    { match: "to_regclass('public.bookkeeping_cases')", rows: [{ present: 'bookkeeping_cases' }] },
    { match: 'from loop_event_outbox', rows: [stuck] },
    ...baseHandlers()
  ]);
  const out = await drainReconciliationEvalRequests({
    client, apiKeyOverride: 'sk-test',
    fetchImpl: makeFetchCapture(AUTO_EXPLAIN).fetchImpl, env: CANARY_ENV, asOf: NOW
  });
  assert.equal(out.deferred, 0);
  assert.equal(out.dispatched, 1, 'the stuck row is reclaimed and completed');
});

await test('drain — two requests for the SAME transaction serialize (the double-eval race)', async () => {
  const client = makeMockClient([
    { match: "to_regclass('public.bookkeeping_cases')", rows: [{ present: 'bookkeeping_cases' }] },
    { match: 'from loop_event_outbox', rows: [
      makeRow({}, { id: 'ob-1', created_at: '2026-07-27T10:00:00Z' }),
      makeRow({}, { id: 'ob-2', created_at: '2026-07-27T10:00:05Z' })
    ] },
    ...baseHandlers()
  ]);
  const capture = makeFetchCapture(AUTO_EXPLAIN);
  const out = await drainReconciliationEvalRequests({
    client, apiKeyOverride: 'sk-test', fetchImpl: capture.fetchImpl, env: CANARY_ENV
  });
  assert.equal(out.planned, 2);
  assert.equal(out.dispatched, 1, 'only the lane head evaluates');
  assert.equal(out.deferred, 1, 'the sibling waits behind it');
});
