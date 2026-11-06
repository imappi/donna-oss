// Universal mentions slice 4 — the agent-ask answer producer + consumer.
//
// Mock-pg harness (mirrors askAutoDraftConsumer.test.js — substring handlers
// with rowCount). The model call and the thread comment are injected
// (answerFn / postCommentFn) so these tests pin the consumer's gate / claim /
// composition / terminal orchestration, per the design §10 matrix:
//   - canary: model answers → the ask resolves with BOTH identities on the
//     receipt, the asker is notified (postCommentFn ask_answered), dispatched;
//   - shadow: held — no claim, no model call (inert);
//   - composition refused (a viewer-class instruction) → ESCALATED, model
//     never called — an agent-ask never rests refused;
//   - model can't answer → escalated to the instructing seat;
//   - transport failure → failed (outbox backoff; the dead-letter bound
//     escalates);
//   - an already-terminal ask → dispatched without spending anything;
//   - producer: canary enqueues one coalesced agent_answer.requested row,
//     shadow enqueues nothing.

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  runAgentAnswerRequest, drainAgentAskAnswers, escalateAgentAsk,
  AGENT_ANSWER_REQUEST_EVENT, AGENT_ANSWER_ACTION_TYPE
} from './agentAskAnswerConsumer.js';
import { onAgentAskCreatedRequestAnswer } from './loopsShadowProducers.js';

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
const callWith = (client, needle) => client.calls.find((c) => c.sql.toLowerCase().includes(needle));

const CANARY_ENV = { LOOPS_TIER: 'canary' };
const CANARY_FIRM = { metadata: { loops: { tier: 'canary' } } };
const SHADOW_FIRM = { metadata: { loops: { tier: 'shadow' } } };

const askRow = (overrides = {}) => ({
  id: 'ask-1', firm_id: 'firm-1', client_id: 'client-1',
  transaction_id: 't-1', status: 'open', audience: 'agent',
  addressee_principal_type: 'ai_occupant', addressee_principal_id: 'clara',
  question: 'Has this invoice been paid?',
  request_payload: {
    instructed_by: {
      principal_type: 'firm_collaborator', principal_id: 'c-david',
      display: 'David', actor_id: 'david@books.example',
      seat_role: 'senior', capability_class: 'senior'
    },
    agent: { agent_id: 'clara', role: 'invoicing_collections' }
  },
  ...overrides
});

const outboxRow = (overrides = {}) => ({
  id: 'ob-1', firm_id: 'firm-1', client_id: 'client-1',
  event_type: AGENT_ANSWER_REQUEST_EVENT,
  object_type: 'client_evidence_request', object_id: 'ask-1',
  status: 'pending', attempts: 0, payload: {},
  ...overrides
});

const consumerHandlers = ({ firm = CANARY_FIRM, ask = askRow() } = {}) => [
  { match: 'select metadata from firms', rows: [firm] },
  { match: 'from client_evidence_requests', rows: ask ? [ask] : [] },
  { match: 'from transactions', rows: [{ id: 't-1', description: 'STRIPE PAYOUT', money_in: 745 }] },
  { match: "set status = 'dispatching'", rows: [{ id: 'ob-1' }] },
  { match: "set status = 'dispatched'", rows: [{ id: 'ob-1' }] },
  { match: "set status = 'cancelled'", rows: [{ id: 'ob-1' }] },
  { match: "set status = 'failed'", rows: [{ id: 'ob-1' }] },
  { match: 'update client_evidence_requests', rows: [{ id: 'ask-1' }] },
  { match: 'insert into audit_events', rows: [{ id: 1 }] }
];

test('canary: model answers → resolve carries BOTH identities + composition; asker notified; dispatched', async () => {
  const client = makeMockClient(consumerHandlers());
  const posted = [];
  const out = await runAgentAnswerRequest({
    client, row: outboxRow(), env: CANARY_ENV,
    answerFn: async () => ({ can_answer: true, answer: 'Yes — settled on 12 Aug.', confidence: 0.9 }),
    postCommentFn: async (args) => { posted.push(args); return { id: 'msg-1' }; }
  });
  assert.equal(out.status, 'dispatched');
  assert.equal(out.outcome, 'answered');
  assert.ok(hasCall(client, "set status = 'dispatching'"), 'claimed');
  const resolve = callWith(client, 'update client_evidence_requests');
  assert.ok(resolve, 'the ask resolved');
  const audit = callWith(client, 'insert into audit_events');
  const metadata = JSON.parse(audit.params[5]);
  assert.equal(audit.params[3], 'evidence_request.agent_answer');
  assert.equal(metadata.agent.agent_id, 'clara');
  assert.equal(metadata.instructed_by.principal_id, 'c-david');
  assert.equal(metadata.authority_composition.action_type, AGENT_ANSWER_ACTION_TYPE);
  assert.equal(metadata.authority_composition.instructing_class, 'senior');
  assert.equal(metadata.authority_composition.agent_class, 'reviewer');
  assert.equal(metadata.authority_composition.effective_class, 'reviewer');
  assert.equal(posted.length, 1);
  assert.equal(posted[0].notificationKind, 'ask_answered');
  assert.equal(posted[0].instructedBy.principal_id, 'c-david');
});

test('shadow: held — no claim, no model call (inert)', async () => {
  const client = makeMockClient(consumerHandlers({ firm: SHADOW_FIRM }));
  let modelCalled = false;
  const out = await runAgentAnswerRequest({
    client, row: outboxRow(), env: CANARY_ENV,
    answerFn: async () => { modelCalled = true; return { can_answer: true, answer: 'x' }; },
    postCommentFn: async () => ({})
  });
  assert.equal(out.status, 'held');
  assert.equal(modelCalled, false);
  assert.ok(!hasCall(client, "set status = 'dispatching'"), 'never claimed');
});

test('composition refused (viewer-class instruction) → escalated, model never called', async () => {
  const ask = askRow();
  ask.request_payload = {
    ...ask.request_payload,
    instructed_by: { ...ask.request_payload.instructed_by, capability_class: 'viewer' }
  };
  const client = makeMockClient(consumerHandlers({ ask }));
  const posted = [];
  let modelCalled = false;
  const out = await runAgentAnswerRequest({
    client, row: outboxRow(), env: CANARY_ENV,
    answerFn: async () => { modelCalled = true; return { can_answer: true, answer: 'x' }; },
    postCommentFn: async (args) => { posted.push(args); return {}; }
  });
  assert.equal(out.status, 'dispatched');
  assert.equal(out.outcome, 'escalated');
  assert.equal(modelCalled, false, 'no token spent on a refused composition');
  const audit = callWith(client, 'insert into audit_events');
  assert.equal(audit.params[3], 'evidence_request.agent_escalated');
  assert.equal(posted[0].notificationKind, 'agent_escalation');
});

test('model cannot answer → escalated back to the instructing seat', async () => {
  const client = makeMockClient(consumerHandlers());
  const posted = [];
  const out = await runAgentAnswerRequest({
    client, row: outboxRow(), env: CANARY_ENV,
    answerFn: async () => ({ can_answer: false, answer: null, escalation_reason: 'not in the data' }),
    postCommentFn: async (args) => { posted.push(args); return {}; }
  });
  assert.equal(out.status, 'dispatched');
  assert.equal(out.outcome, 'escalated');
  assert.equal(out.reason, 'not in the data');
  assert.equal(posted[0].notificationKind, 'agent_escalation');
});

test('transport failure → failed (backoff), nothing resolved', async () => {
  const client = makeMockClient(consumerHandlers());
  const out = await runAgentAnswerRequest({
    client, row: outboxRow(), env: CANARY_ENV,
    answerFn: async () => ({ transport_failure: true, reason: 'api_error_529' }),
    postCommentFn: async () => ({})
  });
  assert.equal(out.status, 'failed');
  assert.ok(hasCall(client, "set status = 'failed'"));
  assert.ok(!hasCall(client, 'update client_evidence_requests'), 'the ask stayed open');
});

test('an already-terminal ask dispatches without spending anything', async () => {
  const client = makeMockClient(consumerHandlers({ ask: askRow({ status: 'resolved' }) }));
  let modelCalled = false;
  const out = await runAgentAnswerRequest({
    client, row: outboxRow(), env: CANARY_ENV,
    answerFn: async () => { modelCalled = true; return {}; },
    postCommentFn: async () => ({})
  });
  assert.equal(out.status, 'dispatched');
  assert.equal(out.reason, 'ask_already_terminal');
  assert.equal(modelCalled, false);
});

test('escalateAgentAsk resolves even when the thread comment fails (loud, never resurrected)', async () => {
  const client = makeMockClient(consumerHandlers());
  const out = await escalateAgentAsk({
    client, firmId: 'firm-1', ask: askRow(),
    agent: { agent_id: 'clara', role: 'invoicing_collections' },
    instructedBy: askRow().request_payload.instructed_by,
    reason: 'answer retries exhausted',
    postCommentFn: async () => { throw new Error('thread write failed'); }
  });
  assert.equal(out.outcome, 'escalated');
  assert.ok(hasCall(client, 'update client_evidence_requests'), 'the resolve committed');
});

// ── producer (onAgentAskCreatedRequestAnswer uses runShadow → process.env) ──

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

const producerHandlers = ({ firm = CANARY_FIRM, pending = [] } = {}) => [
  { match: "to_regclass('public.bookkeeping_cases')", rows: [{ present: 'bookkeeping_cases' }] },
  { match: 'select metadata from firms', rows: [firm] },
  { match: "status in ('pending', 'dispatching', 'failed')", rows: pending },
  { match: 'insert into loop_event_outbox', rows: [{ id: 'loop-outbox-x' }] }
];

test('producer: canary firm enqueues ONE coalesced agent_answer.requested row', async () => {
  await withLoopsEnv({ LOOPS_SHADOW: 'true', LOOPS_TIER: 'canary' }, async () => {
    const client = makeMockClient(producerHandlers());
    const out = await onAgentAskCreatedRequestAnswer({
      client, firmId: 'firm-1', clientId: 'client-1', evidenceRequestId: 'ask-1'
    });
    assert.equal(out?.enqueued, 1);
    const insert = callWith(client, 'insert into loop_event_outbox');
    // eventType ships as a literal so the registry source-scan attributes the producer.
    assert.equal(insert.params[3], 'agent_answer.requested');
    // coalesce: a pending row for the same ask short-circuits
    const client2 = makeMockClient(producerHandlers({ pending: [{ one: 1 }] }));
    const out2 = await onAgentAskCreatedRequestAnswer({
      client: client2, firmId: 'firm-1', clientId: 'client-1', evidenceRequestId: 'ask-1'
    });
    assert.equal(out2?.enqueued, 0);
    assert.equal(out2?.reason, 'already_pending');
  });
});

test('producer: shadow firm enqueues nothing (no held backlog at shadow)', async () => {
  await withLoopsEnv({ LOOPS_SHADOW: 'true', LOOPS_TIER: 'canary' }, async () => {
    const client = makeMockClient(producerHandlers({ firm: SHADOW_FIRM }));
    const out = await onAgentAskCreatedRequestAnswer({
      client, firmId: 'firm-1', clientId: 'client-1', evidenceRequestId: 'ask-1'
    });
    assert.equal(out?.enqueued ?? 0, 0);
    assert.ok(!hasCall(client, 'insert into loop_event_outbox'));
  });
});
