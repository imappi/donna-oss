// reply_if_wrong v2 — email-reply ingestion. Pins:
//   - the digest reply-to flips ONLY when the lane at least observes AND the
//     inbound address is deployed (additive, never subtractive);
//   - the Keep layer discards any action id outside the candidate set, and
//     an invalid intent fails toward the owner;
//   - the classifier prompt carries the untrusted-content guard (reply text
//     is DATA, never instructions);
//   - webhook ingestion: no inbound address ⇒ ignored; another lane's mail
//     ⇒ ignored; digest-thread attribution wins; ambiguous sender match
//     stores NOTHING (never a guessed binding); redelivery is a duplicate
//     no-op; the optional forward is stamped on the row;
//   - the sweep: flag-off is dark; a confident wrong-claim routes THROUGH
//     the mark-wrong writer wrapper (actor 'owner', channel 'email_reply');
//     shadow classifies + counts would-marks with ZERO marking and ZERO
//     owner-visible surface; an ambiguous wrong-claim and a question rest
//     ON THE OWNER (needs_owner); exhausted classification fails toward the
//     owner; everything classified is receipted in one aggregate audit
//     event;
//   - sender-auth hardening (v2): the verdict comes from the FIRST
//     Authentication-Results header (the receiving MTA's prepended stamp —
//     a sender-smuggled fake-pass rides behind it and is never read); only
//     an AFFIRMATIVE dmarc=fail blocks; a spoof-flagged reply is still
//     STORED and forwarded with a warning (additive, never subtractive)
//     but terminates receipted no_action BEFORE the classifier — never
//     marks, never surfaces to the owner; a verdict-less row (pre-hardening
//     or AR-less provider) classifies exactly as before.

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildReplyClassifierInstructions,
  buildReplyClassifierSchema,
  constrainVerdictToCandidates,
  extractMessageIdCandidates,
  parseSenderAuthVerdict,
  resolveOwnerDigestReplyTo,
  senderAuthBlocksAction,
  REPLY_INTENTS,
  REPLY_STATUSES
} from './replyIngestionCore.js';
import {
  classifyOwnerReply, ingestOutboundReplyEvent, processOwnerReplies
} from './replyIngestion.js';

const FIRM = 'firm-1';
const CLIENT = 'client-1';

// The clientConfig snapshot consumed by clientFlagActs/Observes is the shape
// readClientConfigSnapshot returns; build it through the real reader against
// a mock client so the test can't drift from the runtime shape.
import { readClientConfigSnapshot } from '../clientConfig.js';

const makeSnapshot = async (stage) => {
  const client = {
    query: async (sql) => {
      const text = String(sql).toLowerCase();
      if (text.includes('from client_capability_config')) {
        return {
          rows: stage
            ? [{ flag_key: 'OUTBOUND_REPLY_INGESTION', stage, source: 'test', client_id: CLIENT }]
            : []
        };
      }
      return { rows: [] };
    }
  };
  return readClientConfigSnapshot(client, { firmId: FIRM, clientId: CLIENT });
};

// ── Core: reply-to resolution ────────────────────────────────────────────────

test('digest reply-to flips only when the lane observes/acts AND the address is deployed', async () => {
  const env = { OUTBOUND_REPLY_INBOUND_ADDRESS: 'actions@in.donnamail.example' };
  assert.equal(
    resolveOwnerDigestReplyTo({ snapshot: await makeSnapshot(null), env }),
    null, 'flag off ⇒ default reply-to untouched'
  );
  assert.equal(
    resolveOwnerDigestReplyTo({ snapshot: await makeSnapshot('shadow'), env }),
    'actions@in.donnamail.example', 'shadow observes ⇒ replies flow to the webhook'
  );
  assert.equal(
    resolveOwnerDigestReplyTo({ snapshot: await makeSnapshot('canary'), env }),
    'actions@in.donnamail.example', 'canary acts ⇒ replies flow to the webhook'
  );
  assert.equal(
    resolveOwnerDigestReplyTo({ snapshot: await makeSnapshot('canary'), env: {} }),
    null, 'no deployed inbound address ⇒ the lane cannot half-exist'
  );
});

// ── Core: the Keep layer around the verdict ──────────────────────────────────

test('constrainVerdictToCandidates discards invented ids and off-vocabulary intents', () => {
  const candidates = [{ id: 'a-1', description: 'Payment reminder to Acme' }];
  assert.equal(
    constrainVerdictToCandidates(
      { intent: 'send_was_wrong', action_id: 'a-999', reason: 'x' }, candidates
    ).action_id,
    null, 'an id outside the candidate set is discarded'
  );
  assert.equal(
    constrainVerdictToCandidates(
      { intent: 'send_was_wrong', action_id: 'a-1', reason: 'x' }, candidates
    ).action_id,
    'a-1', 'a candidate id survives'
  );
  assert.equal(
    constrainVerdictToCandidates(
      { intent: 'question_or_request', action_id: 'a-1', reason: 'x' }, candidates
    ).action_id,
    null, 'a non-wrong intent never carries a target'
  );
  assert.equal(
    constrainVerdictToCandidates({ intent: 'nonsense', action_id: null, reason: 'x' }, candidates).intent,
    'question_or_request', 'an off-vocabulary intent fails toward the owner'
  );
});

test('classifier prompt carries the untrusted-content guard and a closed schema', () => {
  const instructions = buildReplyClassifierInstructions();
  assert.match(instructions, /UNTRUSTED CONTENT BOUNDARY/, 'the guard is pinned into the prompt');
  const schema = buildReplyClassifierSchema();
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(schema.properties.intent.enum, [...REPLY_INTENTS]);
  assert.deepEqual(schema.required, ['intent', 'action_id', 'reason']);
});

test('extractMessageIdCandidates yields the raw id and its local part', () => {
  assert.deepEqual(
    extractMessageIdCandidates('<rs-123@updates.donnamail.example>'),
    ['rs-123@updates.donnamail.example', 'rs-123']
  );
  assert.deepEqual(extractMessageIdCandidates(''), []);
});

test('REPLY_STATUSES stays the closed lifecycle vocabulary', () => {
  assert.deepEqual(
    [...REPLY_STATUSES],
    ['stored', 'marked_wrong', 'already_marked', 'no_action', 'needs_owner']
  );
});

// ── Core: sender-auth verdicts (the v2 hardening) ────────────────────────────

test('parseSenderAuthVerdict reads the receiving MTA stamp; absence is none, never fail', () => {
  assert.deepEqual(
    parseSenderAuthVerdict({
      'Authentication-Results':
        'inbound.resend.example; dmarc=pass header.from=acme-com.example; spf=pass smtp.mailfrom=acme-com.example; dkim=pass'
    }),
    { dmarc: 'pass', spf: 'pass', dkim: 'pass' }
  );
  assert.deepEqual(
    parseSenderAuthVerdict({
      'authentication-results': 'inbound.resend.example; dmarc=fail; spf=softfail; dkim=none'
    }),
    { dmarc: 'fail', spf: 'softfail', dkim: 'none' },
    'header name matches case-insensitively; method tokens persist as data'
  );
  assert.deepEqual(
    parseSenderAuthVerdict({ Subject: 'no auth header here' }),
    { dmarc: 'none', spf: 'none', dkim: 'none' }
  );
  assert.deepEqual(
    parseSenderAuthVerdict(null),
    { dmarc: 'none', spf: 'none', dkim: 'none' },
    'a header-less (pre-hardening) row yields none across the board'
  );
});

test('a sender-smuggled fake-pass AR header rides behind the MTA stamp and is never read', () => {
  const verdict = parseSenderAuthVerdict({
    'Authentication-Results': [
      'inbound.resend.example; dmarc=fail header.from=acme-com.example',
      'evil.example; dmarc=pass; spf=pass; dkim=pass'
    ]
  });
  assert.equal(verdict.dmarc, 'fail', 'the FIRST (prepended, receiving-MTA) instance decides');
});

test('senderAuthBlocksAction blocks ONLY on affirmative dmarc=fail', () => {
  assert.equal(senderAuthBlocksAction({ dmarc: 'fail', spf: 'pass', dkim: 'pass' }), true);
  assert.equal(senderAuthBlocksAction({ dmarc: 'pass', spf: 'fail', dkim: 'fail' }), false,
    'spf/dkim failures alone never block — DMARC is the aligned policy verdict');
  assert.equal(senderAuthBlocksAction({ dmarc: 'none', spf: 'none', dkim: 'none' }), false,
    'absence of a verdict never blocks (forwarding quirks, unevaluated mail)');
  assert.equal(senderAuthBlocksAction({ dmarc: 'temperror', spf: 'none', dkim: 'none' }), false,
    'temperror/permerror are not fail');
  assert.equal(senderAuthBlocksAction(null), false);
});

// ── classifyOwnerReply transport ─────────────────────────────────────────────

test('classifyOwnerReply parses the strict verdict and returns the provider model id', async () => {
  let sent = null;
  const fetchImpl = async (url, options) => {
    sent = { url, body: JSON.parse(options.body) };
    return {
      ok: true,
      json: async () => ({
        model: 'gpt-5.4-2026-06-01',
        output_text: JSON.stringify({ intent: 'send_was_wrong', action_id: 'a-1', reason: 'names Acme' })
      })
    };
  };
  const { verdict, model } = await classifyOwnerReply({
    reply: { subject: 'Re: Donna', text_body: 'The Acme reminder was wrong' },
    candidates: [{ id: 'a-1', description: 'Payment reminder to Acme' }],
    fetchImpl, openAiConfig: { apiKey: 'k', model: 'gpt-5.4' }
  });
  assert.equal(verdict.action_id, 'a-1');
  assert.equal(model, 'gpt-5.4-2026-06-01', 'the provider-returned model id is the receipt');
  assert.equal(sent.body.text.format.strict, true, 'strict structured outputs');
  assert.match(sent.body.input, /a-1/, 'candidates ride the input');
});

// ── Webhook ingestion ────────────────────────────────────────────────────────

const receivedEvent = ({ to = 'actions@in.donnamail.example', from = 'owner@acme-com.example' } = {}) => ({
  type: 'email.received',
  created_at: '2026-07-24T10:00:00Z',
  data: { email_id: 'em-1', from, to: [to], subject: 'Re: Donna digest' }
});

const okGetEmail = async () => ({
  ok: true,
  email: {
    text: 'That reminder to Acme was wrong.',
    html: null,
    headers: { 'Message-Id': '<m-2@x>', 'In-Reply-To': '<rs-digest-1@updates.donnamail.example>' }
  }
});

const makeQuery = (handlers) => {
  const calls = [];
  const query = async (sql, params) => {
    calls.push({ sql: String(sql).replace(/\s+/g, ' ').toLowerCase(), params });
    const text = calls[calls.length - 1].sql;
    for (const h of handlers) {
      if (text.includes(h.match)) {
        if (h.throw) throw h.throw;
        const rows = typeof h.rows === 'function' ? h.rows({ sql: text, params }) : (h.rows || []);
        return { rows, rowCount: rows.length };
      }
    }
    return { rows: [], rowCount: 0 };
  };
  query.calls = calls;
  return query;
};

test('ingestion without a deployed inbound address acks and stores nothing', async () => {
  const query = makeQuery([]);
  const result = await ingestOutboundReplyEvent({
    event: receivedEvent(), eventType: 'email.received',
    deps: { query, getEmail: okGetEmail, send: async () => ({ ok: true }), env: {} }
  });
  assert.equal(result.body.ignored, 'inbound_address_unconfigured');
  assert.equal(query.calls.length, 0);
});

test("another lane's mail on a shared inbound stream is acked, never ingested", async () => {
  const query = makeQuery([]);
  const result = await ingestOutboundReplyEvent({
    event: receivedEvent({ to: 'prospect-replies@in.donnamail.example' }), eventType: 'email.received',
    deps: {
      query, getEmail: okGetEmail, send: async () => ({ ok: true }),
      env: { OUTBOUND_REPLY_INBOUND_ADDRESS: 'actions@in.donnamail.example' }
    }
  });
  assert.equal(result.body.ignored, 'not_for_this_lane');
});

test('digest-thread attribution wins and the reply is stored with provenance', async () => {
  const query = makeQuery([
    { match: 'from outbound_digests', rows: [{ firm_id: FIRM, client_id: CLIENT }] },
    { match: 'insert into outbound_owner_replies', rows: [{ id: 'r-1' }] }
  ]);
  const result = await ingestOutboundReplyEvent({
    event: receivedEvent(), eventType: 'email.received',
    deps: {
      query, getEmail: okGetEmail, send: async () => ({ ok: true }),
      env: { OUTBOUND_REPLY_INBOUND_ADDRESS: 'actions@in.donnamail.example' }
    }
  });
  assert.equal(result.body.ok, true);
  assert.equal(result.body.matched_via, 'digest_thread');
  const insert = query.calls.find((c) => c.sql.includes('insert into outbound_owner_replies'));
  assert.ok(insert.params.includes('digest_thread'));
  assert.ok(insert.params.includes('owner@acme-com.example'));
  const threadLookup = query.calls.find((c) => c.sql.includes('from outbound_digests'));
  assert.ok(threadLookup.params[0].includes('rs-digest-1'), 'In-Reply-To local part is a lookup candidate');
});

test('an ambiguous owner-email match stores NOTHING (never a guessed binding)', async () => {
  const query = makeQuery([
    { match: 'from outbound_digests', rows: [] },
    { match: 'from clients', rows: [
      { firm_id: FIRM, id: CLIENT }, { firm_id: FIRM, id: 'client-2' }
    ] }
  ]);
  const result = await ingestOutboundReplyEvent({
    event: receivedEvent(), eventType: 'email.received',
    deps: {
      query, getEmail: okGetEmail, send: async () => ({ ok: true }),
      env: { OUTBOUND_REPLY_INBOUND_ADDRESS: 'actions@in.donnamail.example' }
    }
  });
  assert.equal(result.body.ignored, 'unattributed');
  assert.ok(!query.calls.some((c) => c.sql.includes('insert into outbound_owner_replies')));
});

test('a unique owner-email match binds; redelivery is a duplicate no-op', async () => {
  let firstInsert = true;
  const query = makeQuery([
    { match: 'from outbound_digests', rows: [] },
    { match: 'from clients', rows: [{ firm_id: FIRM, id: CLIENT }] },
    { match: 'insert into outbound_owner_replies', rows: () => {
      if (firstInsert) { firstInsert = false; return [{ id: 'r-1' }]; }
      return []; // on conflict do nothing
    } }
  ]);
  const deps = {
    query, getEmail: okGetEmail, send: async () => ({ ok: true }),
    env: { OUTBOUND_REPLY_INBOUND_ADDRESS: 'actions@in.donnamail.example' }
  };
  const first = await ingestOutboundReplyEvent({ event: receivedEvent(), eventType: 'email.received', deps });
  assert.equal(first.body.matched_via, 'owner_email');
  const second = await ingestOutboundReplyEvent({ event: receivedEvent(), eventType: 'email.received', deps });
  assert.equal(second.body.duplicate, true);
});

test('body-retrieval failure is retriable (Svix redelivers the whole unit)', async () => {
  const result = await ingestOutboundReplyEvent({
    event: receivedEvent(), eventType: 'email.received',
    deps: {
      query: makeQuery([]), getEmail: async () => ({ ok: false, error: 'resend 500' }),
      send: async () => ({ ok: true }),
      env: { OUTBOUND_REPLY_INBOUND_ADDRESS: 'actions@in.donnamail.example' }
    }
  });
  assert.equal(result.retriable, true);
});

test('a dmarc=fail reply is STILL stored (additive) — receipted on the response, warned on the forward', async () => {
  const sends = [];
  const query = makeQuery([
    { match: 'from outbound_digests', rows: [{ firm_id: FIRM, client_id: CLIENT }] },
    { match: 'insert into outbound_owner_replies', rows: [{ id: 'r-1' }] },
    { match: 'set forwarded_to', rows: [] }
  ]);
  const failGetEmail = async () => ({
    ok: true,
    email: {
      text: 'Please wire the balance to this new account.',
      html: null,
      headers: {
        'Message-Id': '<m-2@x>',
        'In-Reply-To': '<rs-digest-1@updates.donnamail.example>',
        'Authentication-Results': 'inbound.resend.example; dmarc=fail; spf=fail; dkim=none'
      }
    }
  });
  const result = await ingestOutboundReplyEvent({
    event: receivedEvent(), eventType: 'email.received',
    deps: {
      query, getEmail: failGetEmail,
      send: async (args) => { sends.push(args); return { ok: true }; },
      env: {
        OUTBOUND_REPLY_INBOUND_ADDRESS: 'actions@in.donnamail.example',
        OUTBOUND_REPLY_FORWARD_TO: 'kari@books.example'
      }
    }
  });
  assert.equal(result.body.ok, true, 'storage happens whatever the verdict — additive, never subtractive');
  assert.deepEqual(result.body.sender_auth, { dmarc: 'fail', spf: 'fail', dkim: 'none' },
    'the webhook receipt carries the verdict');
  assert.ok(query.calls.some((c) => c.sql.includes('insert into outbound_owner_replies')));
  assert.equal(sends.length, 1);
  assert.match(sends[0].text, /sender authentication failed \(dmarc=fail\)/i,
    'the forwarded human copy carries the spoof warning');
});

test('the configured forward sends a copy and stamps the row', async () => {
  const sends = [];
  const query = makeQuery([
    { match: 'from outbound_digests', rows: [{ firm_id: FIRM, client_id: CLIENT }] },
    { match: 'insert into outbound_owner_replies', rows: [{ id: 'r-1' }] },
    { match: 'set forwarded_to', rows: [] }
  ]);
  await ingestOutboundReplyEvent({
    event: receivedEvent(), eventType: 'email.received',
    deps: {
      query, getEmail: okGetEmail,
      send: async (args) => { sends.push(args); return { ok: true }; },
      env: {
        OUTBOUND_REPLY_INBOUND_ADDRESS: 'actions@in.donnamail.example',
        OUTBOUND_REPLY_FORWARD_TO: 'kari@books.example'
      }
    }
  });
  assert.equal(sends.length, 1);
  assert.equal(sends[0].to, 'kari@books.example');
  const stamp = query.calls.find((c) => c.sql.includes('set forwarded_to'));
  assert.ok(stamp, 'forward stamped on the row');
});

// ── The sweep ────────────────────────────────────────────────────────────────

const storedReply = (over = {}) => ({
  id: 'r-1', subject: 'Re: Donna digest',
  text_body: 'The Acme reminder was wrong', from_email: 'owner@acme-com.example',
  attempts: 0, ...over
});

const autoSentAction = (over = {}) => ({
  id: 'a-1', action_type: 'send_receivable_reminder', party_name: 'Acme LLC',
  cadence_step: 2, amount: 1250, currency: 'USD',
  payload: { render_values: { invoice_number: 'INV-14' } },
  receipt_created_at: '2026-07-23T09:00:00Z', ...over
});

const makeSweepClient = ({
  stage = 'canary', replies = [storedReply()], autoSent = [autoSentAction()]
} = {}) => {
  const calls = [];
  const handlers = [
    { match: 'from client_capability_config', rows: stage
      ? [{ flag_key: 'OUTBOUND_REPLY_INGESTION', stage, source: 'test', client_id: CLIENT }]
      : [] },
    { match: 'from cohort_capability_config', rows: [] },
    { match: "status = 'stored'", rows: replies },
    { match: 'outbound_action_receipts', rows: autoSent },
    { match: 'from outbound_digests', rows: [] },
    { match: 'update outbound_owner_replies', rows: [] },
    { match: 'insert into audit_events', rows: [] }
  ];
  return {
    calls,
    query: async (sql, params) => {
      const text = String(sql).replace(/\s+/g, ' ').trim().toLowerCase();
      calls.push({ sql: text, params });
      if (text === 'begin' || text === 'commit' || text === 'rollback') return { rows: [], rowCount: 0 };
      for (const h of handlers) {
        if (text.includes(h.match)) {
          const rows = typeof h.rows === 'function' ? h.rows({ sql: text, params }) : (h.rows || []);
          return { rows, rowCount: rows.length };
        }
      }
      return { rows: [], rowCount: 0 };
    }
  };
};

test('sweep is dark when the flag is off', async () => {
  const client = makeSweepClient({ stage: null });
  const stats = await processOwnerReplies({
    client, firmId: FIRM, clientId: CLIENT, env: {},
    classifier: async () => { throw new Error('must not classify'); }
  });
  assert.equal(stats.skipped, true);
  assert.equal(stats.reason, 'flag_off');
});

test('acting lane: a confident wrong-claim routes THROUGH the writer wrapper as the owner via email', async () => {
  const client = makeSweepClient();
  const markCalls = [];
  const stats = await processOwnerReplies({
    client, firmId: FIRM, clientId: CLIENT, env: {},
    classifier: async () => ({
      verdict: { intent: 'send_was_wrong', action_id: 'a-1', reason: 'names Acme' },
      model: 'gpt-5.4-2026-06-01'
    }),
    markWrong: async (_c, args) => { markCalls.push(args); return { marked: true, marked_wrong_at: 'now' }; }
  });
  assert.equal(stats.marked_wrong, 1);
  assert.equal(markCalls.length, 1);
  assert.equal(markCalls[0].actionId, 'a-1');
  assert.equal(markCalls[0].actorType, 'owner');
  assert.equal(markCalls[0].actorId, 'owner@acme-com.example');
  assert.equal(markCalls[0].channel, 'email_reply');
  const update = client.calls.find((c) => c.sql.includes('update outbound_owner_replies') && c.sql.includes('classification'));
  assert.ok(update.params.includes('marked_wrong'), 'row terminates marked_wrong');
  assert.match(String(update.params.find((p) => String(p).includes('model'))), /gpt-5\.4-2026-06-01/,
    'the provider model id persists on the row');
  const receipt = client.calls.find((c) => c.sql.includes('insert into audit_events'));
  assert.ok(receipt.params.includes('outbound.owner_reply_ingestion'), 'aggregate receipt written');
});

test('a re-classified reply against an already-marked action terminates already_marked (no second correction)', async () => {
  const client = makeSweepClient();
  const stats = await processOwnerReplies({
    client, firmId: FIRM, clientId: CLIENT, env: {},
    classifier: async () => ({
      verdict: { intent: 'send_was_wrong', action_id: 'a-1', reason: 'x' }, model: 'm'
    }),
    markWrong: async () => ({ marked: false, already: 'marked' })
  });
  assert.equal(stats.already_marked, 1);
  assert.equal(stats.marked_wrong, 0);
});

test('shadow: classifies, counts the would-mark, never marks, never surfaces to the owner', async () => {
  const client = makeSweepClient({ stage: 'shadow' });
  const stats = await processOwnerReplies({
    client, firmId: FIRM, clientId: CLIENT, env: {},
    classifier: async () => ({
      verdict: { intent: 'send_was_wrong', action_id: 'a-1', reason: 'x' }, model: 'm'
    }),
    markWrong: async () => { throw new Error('shadow must never mark'); }
  });
  assert.equal(stats.shadow_would_mark, 1);
  assert.equal(stats.marked_wrong, 0);
  assert.equal(stats.needs_owner, 0, 'shadow keeps zero owner-visible surface');
  const update = client.calls.find((c) => c.sql.includes('update outbound_owner_replies') && c.sql.includes('classification'));
  assert.ok(update.params.includes('no_action'), 'shadow rows terminate no_action');
  const receipt = client.calls.find((c) => c.sql.includes('insert into audit_events'));
  assert.ok(receipt.params.includes('outbound.owner_reply_ingestion_would_act'), 'shadow receipt named honestly');
});

test('an ambiguous wrong-claim and a question rest ON THE OWNER; an invented id is discarded first', async () => {
  const client = makeSweepClient({ replies: [storedReply(), storedReply({ id: 'r-2' })] });
  const verdicts = [
    { intent: 'send_was_wrong', action_id: 'a-999', reason: 'invented id' },
    { intent: 'question_or_request', action_id: null, reason: 'asks about VAT' }
  ];
  let call = 0;
  const stats = await processOwnerReplies({
    client, firmId: FIRM, clientId: CLIENT, env: {},
    classifier: async () => ({ verdict: verdicts[call++], model: 'm' }),
    markWrong: async () => { throw new Error('must not mark an invented id'); }
  });
  assert.equal(stats.needs_owner, 2);
});

test('sweep: a dmarc=fail row terminates receipted no_action BEFORE the classifier — never marks, never surfaces', async () => {
  const spoofed = storedReply({
    headers: { 'Authentication-Results': 'inbound.resend.example; dmarc=fail; spf=fail; dkim=none' }
  });
  const client = makeSweepClient({ replies: [spoofed] });
  const stats = await processOwnerReplies({
    client, firmId: FIRM, clientId: CLIENT, env: {},
    classifier: async () => { throw new Error('must never classify a spoof-flagged reply'); },
    markWrong: async () => { throw new Error('must never mark on failed sender auth'); }
  });
  assert.equal(stats.auth_failed, 1);
  assert.equal(stats.no_action, 1, 'terminates no_action — receipted, not an owner interruption');
  assert.equal(stats.needs_owner, 0, 'a spoofer cannot inject digest lines');
  assert.equal(stats.errors, 0);
  const update = client.calls.find((c) => c.sql.includes('update outbound_owner_replies'));
  assert.ok(update.sql.includes("status = 'no_action'"));
  const receiptJson = String(update.params[3]);
  assert.match(receiptJson, /sender_auth_failed/, 'the named outcome is the receipt');
  assert.match(receiptJson, /"dmarc":"fail"/, 'the verdict persists on the row');
  const receipt = client.calls.find((c) => c.sql.includes('insert into audit_events'));
  assert.match(String(receipt.params[3]), /"auth_failed":1/, 'the aggregate receipt counts it');
});

test('sweep: a dmarc=pass row classifies as before and the verdict rides the classification receipt', async () => {
  const authenticated = storedReply({
    headers: { 'Authentication-Results': 'inbound.resend.example; dmarc=pass; spf=pass; dkim=pass' }
  });
  const client = makeSweepClient({ replies: [authenticated] });
  const stats = await processOwnerReplies({
    client, firmId: FIRM, clientId: CLIENT, env: {},
    classifier: async () => ({
      verdict: { intent: 'acknowledgement_or_other', action_id: null, reason: 'thanks' }, model: 'm'
    }),
    markWrong: async () => { throw new Error('must not mark') }
  });
  assert.equal(stats.no_action, 1);
  assert.equal(stats.auth_failed, 0);
  const update = client.calls.find((c) => c.sql.includes('update outbound_owner_replies') && c.sql.includes('classification'));
  const classification = String(update.params.find((p) => String(p).includes('sender_auth')));
  assert.match(classification, /"dmarc":"pass"/, 'the auth verdict is part of the receipt, like the model id');
});

test('sweep: a verdict-less (pre-hardening) row classifies exactly as before', async () => {
  const client = makeSweepClient({ replies: [storedReply()] });
  let classified = 0;
  const stats = await processOwnerReplies({
    client, firmId: FIRM, clientId: CLIENT, env: {},
    classifier: async () => {
      classified += 1;
      return { verdict: { intent: 'acknowledgement_or_other', action_id: null, reason: 'ok' }, model: 'm' };
    },
    markWrong: async () => { throw new Error('must not mark') }
  });
  assert.equal(classified, 1, 'absence of an AR header never blocks the classifier');
  assert.equal(stats.auth_failed, 0);
  assert.equal(stats.no_action, 1);
});

test('an acknowledgement terminates no_action — genuinely nothing to do', async () => {
  const client = makeSweepClient();
  const stats = await processOwnerReplies({
    client, firmId: FIRM, clientId: CLIENT, env: {},
    classifier: async () => ({
      verdict: { intent: 'acknowledgement_or_other', action_id: null, reason: 'thanks' }, model: 'm'
    }),
    markWrong: async () => { throw new Error('must not mark'); }
  });
  assert.equal(stats.no_action, 1);
  assert.equal(stats.needs_owner, 0);
});

test('exhausted classification fails toward the owner, never a silent poison loop', async () => {
  const client = makeSweepClient({ replies: [storedReply({ attempts: 2 })] });
  const stats = await processOwnerReplies({
    client, firmId: FIRM, clientId: CLIENT, env: {},
    classifier: async () => { throw new Error('model down'); },
    markWrong: async () => { throw new Error('must not mark'); }
  });
  assert.equal(stats.errors, 1);
  assert.equal(stats.needs_owner, 1, 'third failure terminates needs_owner');
  const update = client.calls.find((c) => c.sql.includes('update outbound_owner_replies'));
  assert.ok(update.params.includes('needs_owner'));
});

test('a fresh classification failure leaves the row stored for the next sweep', async () => {
  const client = makeSweepClient({ replies: [storedReply({ attempts: 0 })] });
  const stats = await processOwnerReplies({
    client, firmId: FIRM, clientId: CLIENT, env: {},
    classifier: async () => { throw new Error('transient'); },
    markWrong: async () => { throw new Error('must not mark'); }
  });
  assert.equal(stats.errors, 1);
  assert.equal(stats.needs_owner, 0);
  const update = client.calls.find((c) => c.sql.includes('update outbound_owner_replies'));
  assert.ok(update.params.includes('stored'), 'row stays stored (attempts bumped)');
});

test('an unconfigured model skips the sweep without burning attempts', async () => {
  const client = makeSweepClient();
  delete process.env.OPENAI_API_KEY;
  const stats = await processOwnerReplies({
    client, firmId: FIRM, clientId: CLIENT, env: {}
  });
  // Either llm_unconfigured (no key anywhere) or a real key exists in the
  // environment — accept only the honest skip when no classifier is injected
  // and no key is configured; a configured environment would have classified
  // against the real network, which the harness must never do.
  assert.equal(stats.skipped, true);
  assert.equal(stats.reason, 'llm_unconfigured');
});
