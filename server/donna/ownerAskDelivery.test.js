// Unit pins for the one owner-send gate and the clarification follow-up
// routing. The real-PostgreSQL proof of every path is
// ownerAskDeliveryPgLifecycle.test.js.
import assert from 'node:assert/strict';
import test from 'node:test';

import { evaluateOwnerSendGateWithClient, gateOwnerSendWithClient, OWNER_SEND_REFUSED_ACTION } from './ownerAskDelivery.js';
import { clarificationFollowUpAskIds } from './ownerReplyRecovery.js';
import { buildResolvedReplyText } from './channels/inboundCore.js';
import { deliverEvidenceAsksOnAllChannels } from './db/asks.js';

const recordingClient = (rows = {}) => {
  const calls = [];
  return {
    calls,
    query: async (sql, params) => {
      calls.push({ sql: String(sql), params });
      for (const [needle, value] of Object.entries(rows)) if (String(sql).includes(needle)) return { rows: value };
      return { rows: [] };
    }
  };
};

test('the gate fails closed: an unreadable containment read is a refusal, never a send', async () => {
  const gate = await evaluateOwnerSendGateWithClient({ client: {}, firmId: 'f', clientId: 'c',
    deps: { readSendContainment: async () => { throw new Error('db down'); } } });
  assert.equal(gate.allowed, false);
  assert.equal(gate.code, 'SEND_GATE_UNREADABLE');
});

test('a refusal is receipted for the operator with its surface and asks', async () => {
  const client = recordingClient();
  const gate = await gateOwnerSendWithClient({ client, firmId: 'f', clientId: 'c', surface: 'operator_resend', evidenceRequestIds: ['a1'],
    deps: { readSendContainment: async () => ({ contained: true }) } });
  assert.equal(gate.code, 'INTERNAL_PILOT_SEND_DISABLED');
  const audit = client.calls.find((c) => c.params?.includes(OWNER_SEND_REFUSED_ACTION));
  assert.ok(audit, 'receipt written');
  assert.deepEqual(JSON.parse(audit.params.at(-1)), { code: 'INTERNAL_PILOT_SEND_DISABLED', surface: 'operator_resend', evidence_request_ids: ['a1'] });
});

test('the fan-out is gated: a readiness refusal runs no deliverer and reports the refusal', async () => {
  const client = recordingClient({ 'select id from client_evidence_requests': [{ id: 'a1' }] });
  const sent = [];
  const out = await deliverEvidenceAsksOnAllChannels({ client, firmId: 'f', clientId: 'c', evidenceRequestIds: ['a1'],
    deps: {
      readSendContainment: async () => ({ contained: false }),
      evaluateAdmission: async () => ({ allowed: false, reason_code: 'ENTITY_NOT_READY' }),
      deliverOwnerMessage: async (m) => { sent.push(m); return { ok: true, id: 'x' }; }
    } });
  assert.equal(out.refused, 'ENTITY_NOT_READY');
  assert.equal(sent.length, 0);
  assert.equal(out.email, undefined, 'no deliverer ran');
});

test('clarification follow-ups: structured reopen, document clarification, native bank-line fact ask', () => {
  const request = { id: 'ask-1' };
  assert.deepEqual(clarificationFollowUpAskIds(request, { applied: false, needsClarification: true, clarification: 'Q?' }), ['ask-1']);
  assert.deepEqual(clarificationFollowUpAskIds(request, { applied: true, document_disposition: { clarification_request_id: 'ask-2' } }), ['ask-2']);
  assert.deepEqual(clarificationFollowUpAskIds(request, { applied: false, follow_up_request_id: 'ask-3' }), ['ask-3']);
  // Neighbours: an applied answer, a skip, a failure owe the owner nothing.
  assert.deepEqual(clarificationFollowUpAskIds(request, { applied: true }), []);
  assert.deepEqual(clarificationFollowUpAskIds(request, { applied: false, skipped: 'reply_already_processed' }), []);
  assert.deepEqual(clarificationFollowUpAskIds(request, null), []);
});

test('the in-band channel reply does not repeat a clarification the fan-out already delivered', () => {
  const resolved = (delivered) => ({
    evidence_request: { status: 'open', response_payload: { reply_processing: { clarification: 'Which month was this for?' } } },
    recode: { needsClarification: true, follow_up_delivery: { delivered } }
  });
  assert.equal(buildResolvedReplyText({ resolved: resolved(['ask-1']), fallback: 'x' }), 'Thanks. I sent you a follow-up question.');
  assert.equal(buildResolvedReplyText({ resolved: resolved([]), fallback: 'x' }), 'Which month was this for?');
});
