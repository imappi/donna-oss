// Outbound public routes (M1, G8/G9). Injected-db harness. Pins:
//   - unsubscribe: a valid token suppresses the RECEIPTED recipient
//     (fallback: the party's active primary email) with reason
//     'unsubscribed'; an unknown token 404s and writes nothing;
//   - approval: approve flips hold_for_approval → approved as an OWNER
//     principal; decline cancels with a receipt AND stops the receivable
//     case; a second tap reports the already-decided state instead of
//     re-deciding; an unknown token or decision 404s.

import assert from 'node:assert/strict';
import test from 'node:test';

import { handleOutboundUnsubscribe, handleOutboundApproval } from './outboundRoutes.js';

const actionRow = (over = {}) => ({
  id: 'a-1', firm_id: 'firm-1', client_id: 'client-1',
  action_type: 'send_receivable_reminder', target_party_id: 'p-1',
  anchor_type: 'document', anchor_id: 'doc-1',
  status: 'hold_for_approval', model: null, config_snapshot_id: null,
  approval_token: 'at-1', unsubscribe_token: 'ut-1',
  ...over
});

const makeMockClient = (handlers = []) => {
  const calls = [];
  return {
    calls,
    query: async (sql, params) => {
      calls.push({ sql: String(sql), params });
      const text = String(sql).replace(/\s+/g, ' ').trim().toLowerCase();
      if (text === 'begin' || text === 'commit' || text === 'rollback') return { rows: [], rowCount: 0 };
      for (const h of handlers) {
        if (text.includes(h.match)) {
          if (h.throw) throw h.throw;
          const rows = typeof h.rows === 'function' ? h.rows({ sql: text, params }) : (h.rows || []);
          return { rows, rowCount: rows.length };
        }
      }
      return { rows: [], rowCount: 0 };
    }
  };
};

const makeRes = () => {
  const res = {
    statusCode: 0, headers: {}, body: '',
    setHeader(k, v) { this.headers[k] = v; },
    end(chunk) { this.body = String(chunk || ''); }
  };
  return res;
};

const urlFor = (path, params) => {
  const u = new URL(`https://donna.test${path}`);
  for (const [k, v] of Object.entries(params || {})) u.searchParams.set(k, v);
  return u;
};

const deps = (client) => ({ withFirmDbClientFn: (fn) => fn(client) });

test('unsubscribe: valid token suppresses the receipted recipient', async () => {
  const client = makeMockClient([
    { match: 'from outbound_actions where unsubscribe_token', rows: [actionRow()] },
    { match: 'from outbound_action_receipts', rows: [{ recipient: 'ap@acme-com.example' }] },
    { match: 'insert into outbound_suppression', rows: [] },
    { match: 'insert into audit_events', rows: [] }
  ]);
  const res = makeRes();
  await handleOutboundUnsubscribe({}, res, urlFor('/api/donna/outbound/unsubscribe', { token: 'ut-1' }), deps(client));
  assert.equal(res.statusCode, 200);
  assert.match(res.body, /unsubscribed/i);
  const suppress = client.calls.find((c) => c.sql.includes('insert into outbound_suppression'));
  assert.ok(suppress, 'suppression written');
  assert.ok(suppress.params.includes('ap@acme-com.example'));
  assert.ok(suppress.params.includes('unsubscribed'));
});

test('unsubscribe: falls back to the party primary email when no receipt exists', async () => {
  const client = makeMockClient([
    { match: 'from outbound_actions where unsubscribe_token', rows: [actionRow()] },
    { match: 'from outbound_action_receipts', rows: [] },
    { match: 'from party_channels', rows: [{ normalized_value: 'billing@acme-com.example' }] },
    { match: 'insert into outbound_suppression', rows: [] },
    { match: 'insert into audit_events', rows: [] }
  ]);
  const res = makeRes();
  await handleOutboundUnsubscribe({}, res, urlFor('/api/donna/outbound/unsubscribe', { token: 'ut-1' }), deps(client));
  assert.equal(res.statusCode, 200);
  const suppress = client.calls.find((c) => c.sql.includes('insert into outbound_suppression'));
  assert.ok(suppress.params.includes('billing@acme-com.example'));
});

test('unsubscribe: unknown token 404s and writes nothing', async () => {
  const client = makeMockClient([
    { match: 'from outbound_actions where unsubscribe_token', rows: [] }
  ]);
  const res = makeRes();
  await handleOutboundUnsubscribe({}, res, urlFor('/api/donna/outbound/unsubscribe', { token: 'nope' }), deps(client));
  assert.equal(res.statusCode, 404);
  assert.ok(!client.calls.some((c) => c.sql.includes('insert into outbound_suppression')));
});

test('approval: approve flips the hold as an owner principal', async () => {
  const client = makeMockClient([
    { match: 'from outbound_actions where approval_token', rows: [actionRow()] },
    { match: "set status = 'approved'", rows: ({ params }) => [actionRow({ status: 'approved', action_type: 'send_receivable_reminder' })] },
    { match: 'insert into audit_events', rows: [] }
  ]);
  const res = makeRes();
  await handleOutboundApproval({}, res, urlFor('/api/donna/outbound/approval', { token: 'at-1', decision: 'approve' }), deps(client));
  assert.equal(res.statusCode, 200);
  assert.match(res.body, /Approved/);
  const flip = client.calls.find((c) => c.sql.includes("set status = 'approved'"));
  assert.ok(flip, 'approval update ran');
  assert.ok(flip.params.includes('owner'), 'owner principal');
});

test('approval: decline cancels with a receipt and stops the case', async () => {
  const cancelled = actionRow({ status: 'cancelled' });
  const client = makeMockClient([
    { match: 'from outbound_actions where approval_token', rows: [actionRow()] },
    { match: "set status = 'cancelled'", rows: [cancelled] },
    { match: 'update receivable_cases', rows: [{ id: 'rc-1' }] },
    { match: 'insert into outbound_action_receipts', rows: [] },
    { match: 'insert into audit_events', rows: [] }
  ]);
  const res = makeRes();
  await handleOutboundApproval({}, res, urlFor('/api/donna/outbound/approval', { token: 'at-1', decision: 'decline' }), deps(client));
  assert.equal(res.statusCode, 200);
  assert.match(res.body, /Declined/);
  assert.ok(client.calls.some((c) => c.sql.includes('insert into outbound_action_receipts')), 'cancel receipted');
  assert.ok(client.calls.some((c) => c.sql.includes('update receivable_cases')), 'case stopped');
});

test('approval: a second tap reports the decided state instead of re-deciding', async () => {
  const client = makeMockClient([
    { match: 'from outbound_actions where approval_token', rows: [actionRow({ status: 'executed' })] }
  ]);
  const res = makeRes();
  await handleOutboundApproval({}, res, urlFor('/api/donna/outbound/approval', { token: 'at-1', decision: 'approve' }), deps(client));
  assert.equal(res.statusCode, 200);
  assert.match(res.body, /already handled/);
  assert.ok(!client.calls.some((c) => c.sql.includes("set status = 'approved'")));
});

test('approval: unknown token or decision 404s', async () => {
  const client = makeMockClient([
    { match: 'from outbound_actions where approval_token', rows: [] }
  ]);
  const missing = makeRes();
  await handleOutboundApproval({}, missing, urlFor('/api/donna/outbound/approval', { token: 'nope' }), deps(client));
  assert.equal(missing.statusCode, 404);

  const bad = makeRes();
  await handleOutboundApproval({}, bad, urlFor('/api/donna/outbound/approval', { token: 'at-1', decision: 'maybe' }), deps(client));
  assert.equal(bad.statusCode, 404);
});

// ── reply_if_wrong v2: the owner-reply inbound webhook ───────────────────────

import { createHmac } from 'node:crypto';
import { handleOutboundReplyWebhook } from './outboundRoutes.js';

const REPLY_SECRET = `whsec_${Buffer.from('test-signing-key-32-bytes-long!!').toString('base64')}`;

const signReply = (body, { secret = REPLY_SECRET, id = 'msg_1' } = {}) => {
  const ts = String(Math.floor(Date.now() / 1000));
  const key = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
  const sig = createHmac('sha256', key).update(`${id}.${ts}.${body}`, 'utf8').digest('base64');
  return { 'svix-id': id, 'svix-timestamp': ts, 'svix-signature': `v1,${sig}` };
};

const makeWebhookReq = (body, headers = {}) => ({
  method: 'POST',
  headers,
  async *[Symbol.asyncIterator]() { yield Buffer.from(body); }
});

test('reply webhook refuses honestly when its secret is unset', async () => {
  const res = makeRes();
  await handleOutboundReplyWebhook(makeWebhookReq('{}'), res, urlFor('/api/donna/outbound/reply-webhook'), { env: {} });
  assert.equal(res.statusCode, 503);
  assert.match(res.body, /WEBHOOK_NOT_CONFIGURED/);
});

test('reply webhook rejects a bad signature', async () => {
  const res = makeRes();
  await handleOutboundReplyWebhook(
    makeWebhookReq('{}', { 'svix-id': 'x', 'svix-timestamp': '1', 'svix-signature': 'v1,nope' }),
    res, urlFor('/api/donna/outbound/reply-webhook'),
    { env: { OUTBOUND_REPLY_WEBHOOK_SECRET: REPLY_SECRET } }
  );
  assert.equal(res.statusCode, 401);
});

test('reply webhook acks non-received events without ingesting', async () => {
  const body = JSON.stringify({ type: 'email.bounced', data: {} });
  const res = makeRes();
  let ingested = 0;
  await handleOutboundReplyWebhook(
    makeWebhookReq(body, signReply(body)), res, urlFor('/api/donna/outbound/reply-webhook'),
    {
      env: { OUTBOUND_REPLY_WEBHOOK_SECRET: REPLY_SECRET },
      ingestFn: async () => { ingested += 1; return { retriable: false, body: { ok: true } }; }
    }
  );
  assert.equal(res.statusCode, 200);
  assert.match(res.body, /ignored/);
  assert.equal(ingested, 0);
});

test('reply webhook verifies, ingests, and maps retriable failures to 502 for Svix redelivery', async () => {
  const body = JSON.stringify({ type: 'email.received', data: { email_id: 'em-1' } });
  const calls = [];
  const res = makeRes();
  await handleOutboundReplyWebhook(
    makeWebhookReq(body, signReply(body)), res, urlFor('/api/donna/outbound/reply-webhook'),
    {
      env: { OUTBOUND_REPLY_WEBHOOK_SECRET: REPLY_SECRET },
      ingestFn: async (args) => { calls.push(args); return { retriable: false, body: { ok: true, id: 'r-1' } }; }
    }
  );
  assert.equal(res.statusCode, 200);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].eventType, 'email.received');

  const res2 = makeRes();
  await handleOutboundReplyWebhook(
    makeWebhookReq(body, signReply(body)), res2, urlFor('/api/donna/outbound/reply-webhook'),
    {
      env: { OUTBOUND_REPLY_WEBHOOK_SECRET: REPLY_SECRET },
      ingestFn: async () => ({ retriable: true, body: { code: 'RETRIEVAL_FAILED' } })
    }
  );
  assert.equal(res2.statusCode, 502, 'retriable failures 502 so Svix redelivers');
});
