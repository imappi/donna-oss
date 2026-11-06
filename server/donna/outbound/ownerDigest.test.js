// Owner pending-actions digest (M1, G9). Mock-pg harness. Pins:
//   - the digest gathers ALL owner-resting surfaces: hold_for_approval
//     actions, failed sends, stale executing leases, escalated cases,
//     needs-info cases (two-terminal-states: nothing rests firm-side
//     unseen);
//   - rendering carries one-tap approve/decline links from the 093 tokens,
//     human copy for hold reasons and gaps, and degrades honestly when the
//     base URL knob is unset (links replaced by an instruction, digest
//     still sends);
//   - a dark pipeline sends nothing; an empty digest sends nothing; an
//     UNCHANGED digest is not re-sent inside the resurface window but an
//     aged one re-surfaces; a changed hash re-sends;
//   - a missing owner email is an AUDITED skip, never silent;
//   - a delivery lands the outbound_digests ledger row + audit event.

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  gatherOwnerDigest, digestContentHash, isOwnerDigestEmpty,
  renderOwnerDigestEmail, sendOwnerDigestForClient, describeOwnerReply
} from './ownerDigest.js';

const FIRM = 'firm-1';
const CLIENT = 'client-1';
const NOW = Date.parse('2026-07-24T00:00:00Z');

const pendingAction = (over = {}) => ({
  id: 'a-1', action_type: 'send_receivable_reminder', status: 'hold_for_approval',
  party_name: 'Acme LLC', cadence_step: 2, amount: 1250, currency: 'USD',
  approval_token: 'at-1',
  gate_basis: { held_at_send: ['paid_truth_ambiguous'] },
  payload: { render_values: { invoice_number: 'INV-14', amount_due: '1,250.00' } },
  ...over
});

const escalatedCase = (over = {}) => ({
  id: 'rc-1', status: 'escalated', invoice_number: 'INV-9', current_step: 3,
  anchor_id: 'doc-9', amount: 900, currency: 'USD', ...over
});

const needsInputCase = (over = {}) => ({
  id: 'rc-2', status: 'open', invoice_number: 'INV-7', current_step: 0,
  anchor_id: 'doc-7', amount: 300, currency: 'USD',
  status_reason: 'no_recipient_channel', ...over
});

const makeDigestClient = ({
  stage = 'canary', pending = [pendingAction()], failed = [], stale = [],
  cases = [escalatedCase(), needsInputCase()], lastDigest = null,
  profile = { email: 'kari@books.example' }, overrides = []
} = {}) => {
  const calls = [];
  const handlers = [
    ...overrides,
    { match: 'from client_capability_config', rows: [
      { flag_key: 'OUTBOUND_DUNNING', stage, source: 'test', client_id: CLIENT }
    ] },
    { match: 'from cohort_capability_config', rows: [] },
    { match: "a.status = 'hold_for_approval'", rows: pending },
    { match: "a.status = 'failed'", rows: failed },
    { match: "status = 'executing' and claimed_at", rows: stale },
    { match: 'from receivable_cases', rows: ({ params }) => {
      const statuses = params.find((p) => Array.isArray(p));
      return cases.filter((c) => !statuses || statuses.includes(c.status));
    } },
    { match: 'from outbound_digests', rows: lastDigest ? [lastDigest] : [] },
    { match: 'from clients where firm_id', rows: [{ company_name: 'Roofline Co', profile }] },
    { match: 'insert into outbound_digests', rows: [] },
    { match: 'insert into audit_events', rows: [] }
  ];
  return {
    calls,
    query: async (sql, params) => {
      calls.push({ sql: String(sql), params });
      const text = String(sql).replace(/\s+/g, ' ').trim().toLowerCase();
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

const okDeliver = async () => ({ providerMessageId: 'rs-digest-1' });

test('gather pulls every owner-resting surface', async () => {
  const client = makeDigestClient({
    failed: [pendingAction({ id: 'a-2', status: 'failed', send_error: 'resend 500' })],
    stale: [pendingAction({ id: 'a-3', status: 'executing' })]
  });
  const digest = await gatherOwnerDigest(client, { firmId: FIRM, clientId: CLIENT });
  assert.equal(digest.pending.length, 1);
  assert.equal(digest.failed.length, 1);
  assert.equal(digest.stale.length, 1);
  assert.equal(digest.escalated.length, 1);
  assert.equal(digest.needsInput.length, 1);
  assert.equal(isOwnerDigestEmpty(digest), false);
});

test('rendering carries approve/decline links, human hold copy, and gap copy', () => {
  const digest = {
    pending: [pendingAction()], failed: [], stale: [],
    escalated: [escalatedCase()], needsInput: [needsInputCase()]
  };
  const rendered = renderOwnerDigestEmail({
    digest, baseUrl: 'https://donna.test', clientName: 'Roofline Co'
  });
  assert.match(rendered.subject, /3 items/);
  assert.ok(rendered.text.includes('Acme LLC'));
  assert.ok(rendered.text.includes('INV-14'));
  assert.ok(rendered.text.includes('may already be paid'), 'paid-truth hold humanized');
  assert.ok(rendered.text.includes('https://donna.test/api/donna/outbound/approval?token=at-1&decision=approve'));
  assert.ok(rendered.text.includes('decision=decline'));
  assert.ok(rendered.text.includes('no email address on file'), 'gap copy humanized');
  assert.ok(rendered.text.includes('the cadence is done'), 'escalation surfaced');
  assert.ok(rendered.html.includes('<a href='), 'html links present');
});

test('rendering degrades honestly when the base URL is unset (no dead links, digest still sends)', () => {
  const digest = {
    pending: [pendingAction()], failed: [], stale: [], escalated: [], needsInput: []
  };
  const rendered = renderOwnerDigestEmail({ digest, baseUrl: '', clientName: null });
  assert.ok(!rendered.text.includes('?token='), 'no half-built links');
  assert.ok(rendered.text.includes('Approve links unavailable'));
});

test('dark pipeline and empty digest send nothing', async () => {
  const dark = makeDigestClient({ stage: 'off' });
  assert.equal((await sendOwnerDigestForClient({
    client: dark, firmId: FIRM, clientId: CLIENT, env: {}, now: NOW, deliverEmail: okDeliver
  })).reason, 'pipeline_dark');

  const empty = makeDigestClient({ pending: [], cases: [] });
  assert.equal((await sendOwnerDigestForClient({
    client: empty, firmId: FIRM, clientId: CLIENT, env: {}, now: NOW, deliverEmail: okDeliver
  })).reason, 'nothing_pending');
});

test('unchanged digest is not re-sent inside the window; aged or changed digests re-send', async () => {
  const digest = await gatherOwnerDigest(
    makeDigestClient({}), { firmId: FIRM, clientId: CLIENT }
  );
  const hash = digestContentHash(digest);

  const unchanged = makeDigestClient({
    lastDigest: { content_hash: hash, sent_at: new Date(NOW - 3600000).toISOString() }
  });
  assert.equal((await sendOwnerDigestForClient({
    client: unchanged, firmId: FIRM, clientId: CLIENT, env: {}, now: NOW, deliverEmail: okDeliver
  })).reason, 'unchanged');

  const aged = makeDigestClient({
    lastDigest: { content_hash: hash, sent_at: new Date(NOW - 8 * 86400000).toISOString() }
  });
  assert.equal((await sendOwnerDigestForClient({
    client: aged, firmId: FIRM, clientId: CLIENT, env: {}, now: NOW, deliverEmail: okDeliver
  })).sent, true, 'stale unchanged digest re-surfaces');

  const changed = makeDigestClient({
    lastDigest: { content_hash: 'different', sent_at: new Date(NOW - 3600000).toISOString() }
  });
  assert.equal((await sendOwnerDigestForClient({
    client: changed, firmId: FIRM, clientId: CLIENT, env: {}, now: NOW, deliverEmail: okDeliver
  })).sent, true);
});

test('AR-4E: language holds change the digest hash and never offer a dead approve link', () => {
  const blockedAction = pendingAction({
    pack_id: 'ae', language: 'fr', party_preferred_language: 'fr',
    party_fallback_language: null,
    gate_basis: { held_at_send: ['requested_language_unavailable'] }
  });
  const digest = {
    pending: [blockedAction], failed: [], stale: [], escalated: [], needsInput: [],
    autoSent: [], earned: [], ownerReplies: []
  };
  const withFallback = {
    ...digest,
    pending: [{ ...blockedAction, party_fallback_language: 'en' }]
  };
  assert.notEqual(digestContentHash(digest), digestContentHash(withFallback));
  const rendered = renderOwnerDigestEmail({
    digest, baseUrl: 'https://donna.test', clientName: 'Roofline', clientId: CLIENT
  });
  assert.match(rendered.text, /requested language is not available/);
  assert.doesNotMatch(rendered.text, /Approve:/);
  assert.match(rendered.text, /Choose a fallback in your workspace/);
  assert.match(rendered.text, /don't send:/i);
});

test('a delivery lands the ledger row + audit; missing owner email is an audited skip', async () => {
  const client = makeDigestClient({});
  const sent = [];
  const result = await sendOwnerDigestForClient({
    client, firmId: FIRM, clientId: CLIENT, env: { OUTBOUND_PUBLIC_BASE_URL: 'https://donna.test' },
    now: NOW,
    deliverEmail: async (args) => { sent.push(args); return { providerMessageId: 'rs-digest-1' }; }
  });
  assert.equal(result.sent, true, JSON.stringify(result));
  assert.equal(sent[0].to, 'kari@books.example');
  assert.ok(sent[0].text.includes('Approve:'));
  const ledger = client.calls.find((c) => c.sql.includes('insert into outbound_digests'));
  assert.ok(ledger, 'ledger row written');
  assert.ok(ledger.params.includes('rs-digest-1'), 'provider id recorded');
  assert.ok(client.calls.some(
    (c) => c.sql.includes('insert into audit_events') && (c.params || []).some((p) => String(p).includes('outbound_digest'))
      || c.sql.includes('outbound_digest.sent')
  ), 'delivery audited');

  const noEmail = makeDigestClient({ profile: {} });
  const skipped = await sendOwnerDigestForClient({
    client: noEmail, firmId: FIRM, clientId: CLIENT, env: {}, now: NOW, deliverEmail: okDeliver
  });
  assert.equal(skipped.reason, 'no_owner_email');
  assert.ok(noEmail.calls.some((c) => c.sql.includes('outbound_digest.no_owner_email')), 'skip audited');
});

test('a failed delivery skips the ledger (no phantom digest rows)', async () => {
  const client = makeDigestClient({});
  const result = await sendOwnerDigestForClient({
    client, firmId: FIRM, clientId: CLIENT, env: {}, now: NOW,
    deliverEmail: async () => { throw new Error('resend down'); },
    logger: { warn: () => {} }
  });
  assert.equal(result.reason, 'delivery_failed');
  assert.ok(!client.calls.some((c) => c.sql.includes('insert into outbound_digests')));
});

// ── D1: the decide-and-notify copy flip + the EARNED FYI ─────────────────────

const autoSentRow = (over = {}) => ({
  id: 'a-auto-1', action_type: 'send_receivable_reminder', status: 'executed',
  party_name: 'Acme LLC', cadence_step: 2, amount: 1250, currency: 'USD',
  payload: { render_values: { invoice_number: 'INV-14', amount_due: '1,250.00' } },
  ...over
});

const earnedRow = (over = {}) => ({
  id: 'ladder-1', action_type: 'send_receivable_reminder', state: 'earned',
  clean_streak: 7, total_clean: 7, corrections_count: 0, clean_target: null,
  ...over
});

test('D1: auto-sent receipts surface as never-notified FYIs; owner-directed and already-notified sends are excluded', async () => {
  const client = makeDigestClient({
    pending: [], cases: [],
    overrides: [
      { match: 'from outbound_action_receipts', rows: [
        autoSentRow(),
        autoSentRow({ id: 'a-auto-2', action_type: 'send_payable_notice' }),
        autoSentRow({ id: 'a-auto-3' })
      ] },
      { match: 'select payload from outbound_digests', rows: [
        { payload: { notified_ids: ['a-auto-3'] } }
      ] },
      { match: 'from outbound_earned_auto', rows: [earnedRow()] }
    ]
  });
  const digest = await gatherOwnerDigest(client, { firmId: FIRM, clientId: CLIENT });
  assert.deepEqual(digest.autoSent.map((a) => a.id), ['a-auto-1'],
    'owner-directed (payable) and already-notified sends are filtered out');
  assert.deepEqual(digest.earned.map((r) => r.id), ['ladder-1']);
  assert.equal(isOwnerDigestEmpty(digest), false, 'FYIs count as content');
});

test('D1: the digest copy flips — "sent for you, reply if wrong" + the EARNED-awaiting-approval FYI', () => {
  const digest = {
    pending: [], failed: [], stale: [], escalated: [], needsInput: [],
    autoSent: [autoSentRow()], earned: [earnedRow()]
  };
  const rendered = renderOwnerDigestEmail({ digest, baseUrl: 'https://donna.test', clientName: 'Roofline Co' });
  assert.match(rendered.subject, /reply if anything looks wrong/,
    'a pure-FYI digest never claims to need attention');
  assert.ok(rendered.text.includes('SENT FOR YOU (1)'));
  assert.ok(rendered.text.includes('no action needed; reply if anything looks wrong'));
  assert.ok(rendered.text.includes('Payment reminder (step 2) to Acme LLC'));
  assert.ok(!rendered.text.includes('Approve:'), 'the notify is a courtesy FYI, never a click queue');
  assert.ok(rendered.text.includes('Payment reminders: 7 in a row approved with no corrections'));
  assert.ok(rendered.text.includes('awaiting final approval'), 'the EARNED state is digest-visible');
});

test('D1: a new auto-send re-sends an otherwise unchanged digest, and its id lands in notified_ids', async () => {
  // First compute the digest hash so the "last digest" can carry it.
  const fixtures = {
    pending: [pendingAction()], cases: [],
    overrides: [
      { match: 'from outbound_action_receipts', rows: [autoSentRow()] },
      { match: 'select payload from outbound_digests', rows: [] },
      { match: 'from outbound_earned_auto', rows: [] }
    ]
  };
  const hashClient = makeDigestClient(fixtures);
  const digest = await gatherOwnerDigest(hashClient, { firmId: FIRM, clientId: CLIENT });
  const unchangedHash = digestContentHash(digest);

  const client = makeDigestClient({
    ...fixtures,
    lastDigest: { content_hash: unchangedHash, sent_at: new Date(NOW - 3600000).toISOString() }
  });
  const sent = [];
  const result = await sendOwnerDigestForClient({
    client, firmId: FIRM, clientId: CLIENT, env: {}, now: NOW,
    deliverEmail: async (args) => { sent.push(args); return { providerMessageId: 'd-1' }; }
  });
  assert.equal(result.sent, true, JSON.stringify(result));
  assert.equal(sent.length, 1, 'the courtesy FYI reaches the owner despite the unchanged hash');
  const ledger = client.calls.find((c) => c.sql.includes('insert into outbound_digests'));
  const payload = JSON.parse(ledger.params[ledger.params.length - 1]);
  assert.deepEqual(payload.notified_ids, ['a-auto-1'],
    'the FYI is recorded so the next digest never repeats it');
});

// ── reply_if_wrong v2: the "about your replies" lane ─────────────────────────

const needsOwnerReply = (over = {}) => ({
  id: 'r-1', subject: 'Re: Donna digest',
  classification: { intent: 'send_was_wrong', action_id: null, reason: 'ambiguous' },
  received_at: '2026-07-23T10:00:00Z', created_at: '2026-07-23T10:00:00Z',
  owner_notified_at: null, ...over
});

test('v2: gather surfaces un-notified needs-owner replies; the workspace read sees the whole window', async () => {
  const client = makeDigestClient({
    overrides: [
      { match: 'from outbound_owner_replies', rows: ({ params }) =>
        (params[2] === true
          ? [needsOwnerReply(), needsOwnerReply({ id: 'r-2', owner_notified_at: '2026-07-23T12:00:00Z' })]
          : [needsOwnerReply()]) }
    ]
  });
  const digest = await gatherOwnerDigest(client, { firmId: FIRM, clientId: CLIENT });
  assert.deepEqual(digest.ownerReplies.map((r) => r.id), ['r-1']);
  assert.equal(isOwnerDigestEmpty({ ...digest, pending: [], failed: [], stale: [], escalated: [], needsInput: [] }), false,
    'a needs-owner reply alone keeps the digest non-empty');
  const standing = await gatherOwnerDigest(client, {
    firmId: FIRM, clientId: CLIENT, includeNotifiedOwnerReplies: true
  });
  assert.equal(standing.ownerReplies.length, 2, 'the standing view includes notified rows');
});

test('v2: rendering names why Donna could not act, counts the reply in the subject, and the copy variants hold', () => {
  const digest = {
    pending: [], failed: [], stale: [], escalated: [], needsInput: [],
    ownerReplies: [needsOwnerReply()]
  };
  const rendered = renderOwnerDigestEmail({ digest, baseUrl: 'https://donna.test', clientName: 'Roofline Co' });
  assert.match(rendered.subject, /1 item needs your attention/, 'a needs-owner reply IS attention-worthy');
  assert.ok(rendered.text.includes('ABOUT YOUR REPLIES (1)'));
  assert.ok(rendered.text.includes("couldn't tell which send you meant"), 'the ambiguous wrong-claim copy');
  assert.ok(describeOwnerReply({ classification: { error: 'model down' } })
    .includes("couldn't process it"), 'the failed-classification copy');
  assert.ok(describeOwnerReply({ classification: { intent: 'question_or_request' } })
    .includes("can't act on it over email yet"), 'the question copy');
});

test('v2: an un-notified reply forces a send past the unchanged-hash guard, and the stamp lands after delivery', async () => {
  const fixtures = {
    pending: [pendingAction()], cases: [],
    overrides: [
      { match: 'from outbound_owner_replies', rows: [needsOwnerReply()] },
      { match: 'update outbound_owner_replies', rows: [] },
      { match: 'from outbound_earned_auto', rows: [] }
    ]
  };
  const hashClient = makeDigestClient(fixtures);
  const digest = await gatherOwnerDigest(hashClient, { firmId: FIRM, clientId: CLIENT });
  const unchangedHash = digestContentHash(digest);

  const client = makeDigestClient({
    ...fixtures,
    lastDigest: { content_hash: unchangedHash, sent_at: new Date(NOW - 3600000).toISOString() }
  });
  const result = await sendOwnerDigestForClient({
    client, firmId: FIRM, clientId: CLIENT, env: {}, now: NOW, deliverEmail: okDeliver
  });
  assert.equal(result.sent, true, JSON.stringify(result));
  const ledger = client.calls.find((c) => c.sql.includes('insert into outbound_digests'));
  const payload = JSON.parse(ledger.params[ledger.params.length - 1]);
  assert.deepEqual(payload.owner_reply_ids, ['r-1'], 'the digest payload records the notified replies');
  const stamp = client.calls.find((c) => c.sql.includes('update outbound_owner_replies'));
  assert.ok(stamp, 'owner_notified_at stamped (notified exactly once)');
  assert.deepEqual(stamp.params[2], ['r-1']);
});

test('v2: the digest reply-to flips to the inbound address only when the lane observes and the address is deployed', async () => {
  const laneOn = [
    { match: 'from client_capability_config', rows: [
      { flag_key: 'OUTBOUND_DUNNING', stage: 'canary', source: 'test', client_id: CLIENT },
      { flag_key: 'OUTBOUND_REPLY_INGESTION', stage: 'shadow', source: 'test', client_id: CLIENT }
    ] }
  ];
  const sent = [];
  const capture = async (args) => { sent.push(args); return { providerMessageId: 'd-1' }; };

  await sendOwnerDigestForClient({
    client: makeDigestClient({ overrides: laneOn }), firmId: FIRM, clientId: CLIENT,
    env: { OUTBOUND_REPLY_INBOUND_ADDRESS: 'actions@in.donnamail.example' }, now: NOW,
    deliverEmail: capture
  });
  assert.equal(sent[0].replyTo, 'actions@in.donnamail.example', 'lane on + address ⇒ replies route to the webhook');

  await sendOwnerDigestForClient({
    client: makeDigestClient({ overrides: laneOn }), firmId: FIRM, clientId: CLIENT,
    env: {}, now: NOW, deliverEmail: capture
  });
  assert.equal(sent[1].replyTo, undefined, 'no deployed address ⇒ the monitored default stands');

  await sendOwnerDigestForClient({
    client: makeDigestClient(), firmId: FIRM, clientId: CLIENT,
    env: { OUTBOUND_REPLY_INBOUND_ADDRESS: 'actions@in.donnamail.example' }, now: NOW,
    deliverEmail: capture
  });
  assert.equal(sent[2].replyTo, undefined, 'lane off ⇒ the monitored default stands');
});
