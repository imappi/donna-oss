// G14 (outbound-actions M1) — the owner-ask EMAIL deliverer. Pins:
//   - config-plane gate: OWNER_EMAIL_ASKS off ⇒ internal no-op (born off,
//     envFallback false — the rollout-flags rail, no env pair);
//   - one email per batch carrying every question un-truncated, addressed
//     via the profile owner-email ladder;
//   - one delivery-ledger entry PER ask (reply-anchoring stays per-request),
//     failure recorded as the visible fallback entry;
//   - no owner email on file ⇒ named skip, never a throw.

import assert from 'node:assert/strict';
import test from 'node:test';

import { deliverEmailEvidenceAsksAfterSend, OWNER_EMAIL_ASKS_FLAG_KEY } from './firmDb.js';

const FIRM = 'firm-1';
const CLIENT = 'client-1';

const askRow = (id, question) => ({
  id, question, request_payload: { period: 'June 2026' }
});

const makeMockClient = ({ stage = 'canary', profile = { email: 'kari@books.example' }, asks = [] } = {}) => {
  const calls = [];
  return {
    calls,
    query: async (sql, params) => {
      calls.push({ sql: String(sql), params });
      const text = String(sql).replace(/\s+/g, ' ').trim().toLowerCase();
      if (text.includes('from client_capability_config')) {
        return { rows: stage ? [{ flag_key: OWNER_EMAIL_ASKS_FLAG_KEY, stage, source: 'test', client_id: CLIENT }] : [] };
      }
      if (text.includes('from cohort_capability_config')) return { rows: [] };
      if (text.includes('select company_name, profile from clients')) {
        return { rows: [{ company_name: 'Roofline Co', profile }] };
      }
      if (text.includes('from client_evidence_requests')) {
        const found = asks.find((a) => a.id === params[2]);
        return { rows: found ? [found] : [] };
      }
      if (text.includes('insert into message_delivery_ledger')) {
        return { rows: [{ id: params[0] }] };
      }
      return { rows: [], rowCount: 0 };
    }
  };
};

const okDeliver = () => {
  const sent = [];
  return {
    sent,
    deliverOwnerMessage: async (args) => { sent.push(args); return { ok: true, id: 'rs-ask-1' }; },
    OWNER_CHANNELS: { EMAIL: 'email' }
  };
};

test('flag off means an internal no-op', async () => {
  const deps = okDeliver();
  const client = makeMockClient({ stage: 'off', asks: [askRow('ask-1', 'What was this?')] });
  const result = await deliverEmailEvidenceAsksAfterSend({
    client, firmId: FIRM, clientId: CLIENT, evidenceRequestIds: ['ask-1'], deps
  });
  assert.equal(result.skipped, true);
  assert.equal(result.reason, 'flag_off');
  assert.equal(deps.sent.length, 0);
});

test('one email per batch, full questions, one ledger entry per ask', async () => {
  const deps = okDeliver();
  const client = makeMockClient({
    asks: [
      askRow('ask-1', 'What was the $420 charge from Vistaprint for?'),
      askRow('ask-2', 'Is the Delta flight on June 12 a business trip?')
    ]
  });
  const result = await deliverEmailEvidenceAsksAfterSend({
    client, firmId: FIRM, clientId: CLIENT, evidenceRequestIds: ['ask-1', 'ask-2'], deps
  });
  assert.equal(result.sent, 2, JSON.stringify(result));
  assert.equal(deps.sent.length, 1, 'ONE email for the whole batch');
  assert.equal(deps.sent[0].channel, 'email');
  assert.equal(deps.sent[0].recipient.email, 'kari@books.example');
  assert.ok(deps.sent[0].email.text.includes('Vistaprint'));
  assert.ok(deps.sent[0].email.text.includes('Delta'));
  assert.ok(deps.sent[0].email.subject.includes('2 questions'));
  const ledger = client.calls.filter((c) => c.sql.includes('insert into message_delivery_ledger'));
  assert.equal(ledger.length, 2, 'per-ask ledger entries');
});

test('no owner email on file is a named skip', async () => {
  const deps = okDeliver();
  const client = makeMockClient({ profile: {}, asks: [askRow('ask-1', 'q')] });
  const result = await deliverEmailEvidenceAsksAfterSend({
    client, firmId: FIRM, clientId: CLIENT, evidenceRequestIds: ['ask-1'], deps
  });
  assert.equal(result.reason, 'no_owner_email');
  assert.equal(deps.sent.length, 0);
});

test('a failed send records the visible fallback entry per ask', async () => {
  const client = makeMockClient({ asks: [askRow('ask-1', 'q')] });
  const result = await deliverEmailEvidenceAsksAfterSend({
    client, firmId: FIRM, clientId: CLIENT, evidenceRequestIds: ['ask-1'],
    deps: {
      deliverOwnerMessage: async () => ({ ok: false, error: 'resend 500' }),
      OWNER_CHANNELS: { EMAIL: 'email' }
    }
  });
  assert.equal(result.sent, 0);
  assert.equal(result.failed, 1);
  const ledger = client.calls.find((c) => c.sql.includes('insert into message_delivery_ledger'));
  assert.ok(ledger.params.some((p) => String(p).includes('email_fallback_ask-1')));
});
