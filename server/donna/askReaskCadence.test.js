// Re-ask cadence (F9; design 2026-07-06 §3 — nudge 7d, again 14d, then
// escalate to the firm). Mock-pg harness (substring handlers). Pins:
//   - flag off ⇒ clean skip (born on the plane, envFallback false);
//   - shadow ⇒ would-run receipted, nothing mutated;
//   - an overdue ask below the send ceiling is NUDGED through the first
//     send's own fan-out: with OWNER_EMAIL_ASKS on, one email + one ledger
//     row, and send_count moves only through the deliverer's bump;
//   - no channel delivered: a portal-visible ask is a portal reminder (no sent
//     stamp moves — the portal is not a delivery; the step is recorded in
//     request_payload.portal_reminders and counts toward escalation); an ask
//     nobody can see escalates ('owner_unreachable') without inflating the
//     count;
//   - send containment / readiness refusal ⇒ nothing sent, nothing counted;
//   - an overdue ask AT the ceiling is ESCALATED exactly once
//     (request_payload.escalated_to_firm + due_at cleared + audit
//     evidence_request.escalated_to_firm + the firm-owned case blocker);
//   - a poisoned row rolls back alone; the sweep continues.

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  runAskReaskSweep, askReaskNudgeDays, ASK_REASK_MAX_SEND_COUNT, REASK_CADENCE_FLAG_KEY
} from './askReaskCadence.js';
import { deliverEvidenceAsksOnAllChannels } from './db/asks.js';
import { OWNER_EMAIL_ASKS_FLAG_KEY } from './db/channels.js';

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
// The send-containment read (internalPilotAccess.js) is the only config read
// that projects `as released`; no pilot enrollment ⇒ not contained.
const notContained = { match: 'as released', rows: [] };
const portalRecipient = { match: 'from firm_collaborators', rows: [{ '?column?': 1 }] };
// Readiness admission at 'ask_send' (not enforced for an unenrolled client).
const admitted = async () => ({ enforced: false, allowed: true, boundary: 'ask_send' });
// A fan-out where every channel is dark / unbound: nothing left, no bump.
const darkFanout = async () => ({ email: { skipped: true, reason: 'flag_off' } });
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

await test('canary, no channel delivered, owner can see the portal: portal reminder — no sent stamp, step recorded, due_at advanced, audited', async () => {
  const client = makeMockClient([
    notContained,
    cannedConfig(configRowAt('canary')),
    portalRecipient,
    cannedOverdue([OVERDUE_ROW()])
  ]);
  const out = await runAskReaskSweep({
    client, firmId: 'firm-1', clientId: 'client-1', now: NOW,
    deps: { deliver: darkFanout, evaluateAdmission: admitted }
  });
  assert.equal(out.nudged, 1);
  assert.equal(out.portal, 1);
  assert.equal(out.delivered, 0);
  assert.equal(out.escalated, 0);
  assert.ok(!client.calls.some((c) => /set send_count|last_sent_at =/.test(c.sql)), 'no sent stamp moves');
  const nudge = client.calls.find((c) => c.sql.includes("'portal_reminders'"));
  assert.ok(nudge, 'portal reminder update ran');
  assert.equal(nudge.params[2], new Date(NOW + 7 * 86400000).toISOString(), 'due_at advanced one interval');
  assert.deepEqual(JSON.parse(nudge.params[4]), [new Date(NOW).toISOString()], 'the step is recorded as a portal reminder');
  const audit = client.calls.find((c) => c.sql.includes('evidence_request.nudged'));
  assert.ok(audit, 'nudge audited');
  assert.deepEqual([JSON.parse(audit.params[3]).surface, JSON.parse(audit.params[3]).send_count, JSON.parse(audit.params[3]).portal_reminder_count], ['portal', 1, 1]);
  assert.ok(!hasCall(client, 'due_at = null'), 'no escalation ran');
});

// The real fan-out (db/asks.js deliverEvidenceAsksOnAllChannels → the email
// deliverer in db/channels.js) driven against the mock client; only the
// transport (deliverOwnerMessage) is faked. WhatsApp/SMS/Telegram stay dark
// on their env allowlists, as in a default environment.
const realFanoutHarness = ({ emailOn = true, contained = false, portal = false } = {}) => {
  let sendCount = 1;
  const sends = [];
  const configRows = [
    ...configRowAt('canary'),
    ...(emailOn ? [{ flag_key: OWNER_EMAIL_ASKS_FLAG_KEY, stage: 'canary', source: 'manual', client_id: 'client-1' }] : [])
  ];
  const client = makeMockClient([
    { match: 'as released', rows: contained
      ? [{ client_id: 'client-1', flag_key: 'INTERNAL_PILOT_ACCESS', stage: 'canary', source: 'manual', reason: 'donna.fi-hosted-pilot.v1', valid_to: null, released: false }]
      : [] },
    cannedConfig(configRows),
    ...(portal ? [portalRecipient] : []),
    { match: 'select company_name, profile from clients', rows: [{ company_name: 'Example Oy', profile: { email: 'owner@example.test' } }] },
    { match: 'set send_count = send_count + 1', rows: () => { sendCount += 1; return [{ id: 'evr-1' }]; } },
    { match: 'select send_count from client_evidence_requests', rows: () => [{ send_count: sendCount }] },
    { match: 'select id from client_evidence_requests', rows: [{ id: 'evr-1' }] },
    { match: 'select * from client_evidence_requests', rows: [OVERDUE_ROW()] },
    cannedOverdue([OVERDUE_ROW()])
  ]);
  // The sweep's own deps (its reminder-wording marker) ride through, as the
  // production defaultDeliver forwards them; only the transport is faked.
  const deliver = (args) => deliverEvidenceAsksOnAllChannels({
    ...args,
    deps: { ...(args.deps || {}), deliverOwnerMessage: async (msg) => { sends.push(msg); return { ok: true, id: 'email-msg-1' }; } }
  });
  return { client, sends, deliver, sendCount: () => sendCount };
};

await test('email channel on: the nudge is ONE real email, ONE ledger row, send_count moved only by the deliverer', async () => {
  const h = realFanoutHarness({ emailOn: true });
  const out = await runAskReaskSweep({
    client: h.client, firmId: 'firm-1', clientId: 'client-1', now: NOW,
    deps: { deliver: h.deliver, evaluateAdmission: admitted }
  });
  assert.equal(out.nudged, 1);
  assert.equal(out.delivered, 1);
  assert.equal(out.portal, 0);
  assert.equal(h.sends.length, 1, 'exactly one owner message');
  assert.equal(h.sends[0].channel, 'email');
  assert.equal(h.sends[0].recipient.email, 'owner@example.test');
  assert.match(h.sends[0].email.text, /Who was check 3851 paid to\?/);
  // A nudge is a reminder, and its email says so (the first ask's wording is
  // pinned unchanged in ownerEmailAsks.test.js).
  assert.match(h.sends[0].email.subject, /\(reminder\)/);
  assert.match(h.sends[0].email.text, /A quick reminder: I still need one answer/);
  const ledger = callsMatching(h.client, 'insert into message_delivery_ledger');
  assert.equal(ledger.length, 1, 'one delivery-ledger entry');
  assert.equal(ledger[0].params[2], 'email');
  assert.equal(ledger[0].params[4], 'evr-1');
  assert.equal(h.sendCount(), 2, 'the deliverer bumped send_count once');
  assert.ok(!hasCall(h.client, 'set send_count = $3'), 'the sweep never bumps a delivered nudge itself');
  assert.equal(JSON.parse(h.client.calls.find((c) => c.sql.includes('evidence_request.nudged')).params[3]).send_count, 2, 'the audit names the delivered count');
  const rearm = h.client.calls.find((c) => c.sql.includes('set due_at = $3'));
  assert.equal(rearm.params[2], new Date(NOW + 7 * 86400000).toISOString(), 'clock re-armed');
  const audit = h.client.calls.find((c) => c.sql.includes('evidence_request.nudged'));
  assert.equal(JSON.parse(audit.params[3]).surface, 'channel');
});

await test('email channel off and nobody in the portal: nothing sent, count not inflated, the ask goes to the firm', async () => {
  const h = realFanoutHarness({ emailOn: false });
  const out = await runAskReaskSweep({
    client: h.client, firmId: 'firm-1', clientId: 'client-1', now: NOW,
    deps: { deliver: h.deliver, evaluateAdmission: admitted }
  });
  assert.equal(h.sends.length, 0, 'nothing sent');
  assert.equal(h.sendCount(), 1, 'send_count untouched');
  assert.ok(!hasCall(h.client, 'set send_count = $3'), 'no phantom nudge');
  assert.ok(!hasCall(h.client, 'insert into message_delivery_ledger'), 'no ledger row for a dark channel');
  assert.equal(out.nudged, 0);
  assert.equal(out.escalated, 1);
  const escalate = h.client.calls.find((c) => c.sql.includes('due_at = null'));
  assert.ok(escalate.params.find((p) => typeof p === 'string' && p.includes('owner_unreachable')), 'named exception');
});

await test('send-contained client: the email gate is on but nothing is sent, counted or rewritten', async () => {
  const h = realFanoutHarness({ emailOn: true, contained: true, portal: true });
  let fanouts = 0;
  const out = await runAskReaskSweep({
    client: h.client, firmId: 'firm-1', clientId: 'client-1', now: NOW,
    deps: { deliver: async (args) => { fanouts += 1; return h.deliver(args); }, evaluateAdmission: admitted }
  });
  assert.equal(fanouts, 0, 'the fan-out never ran');
  assert.equal(h.sends.length, 0);
  assert.equal(h.sendCount(), 1);
  assert.equal(out.held, 1);
  assert.equal(out.nudged, 0);
  assert.equal(out.escalated, 0);
  assert.ok(!hasCall(h.client, 'update client_evidence_requests'), 'row untouched');
});

await test('entity-readiness refusal at ask_send holds the reminder the same way', async () => {
  const h = realFanoutHarness({ emailOn: true });
  const out = await runAskReaskSweep({
    client: h.client, firmId: 'firm-1', clientId: 'client-1', now: NOW,
    deps: { deliver: h.deliver, evaluateAdmission: async () => ({ enforced: true, allowed: false, reason_code: 'ENTITY_NOT_READY' }) }
  });
  assert.equal(h.sends.length, 0);
  assert.equal(out.held, 1);
  assert.equal(h.sendCount(), 1);
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

await test('canary: an owner who answered "still unpaid" is not unresponsive: only sends after that answer count toward escalation', async () => {
  const acknowledged = { obligation_open_acknowledged: { at: '2026-01-01T00:00:00.000Z', send_count: 3 } };
  const client = makeMockClient([
    notContained,
    cannedConfig(configRowAt('canary')),
    cannedOverdue([OVERDUE_ROW({ id: 'evr-ack', send_count: 3, request_payload: acknowledged }),
      OVERDUE_ROW({ id: 'evr-ack-ignored', send_count: 6, request_payload: acknowledged })]),
    { match: 'to_regclass', rows: [{ present: 'x' }] },
    { match: 'from bookkeeping_cases', rows: [{ id: 'case-9', status: 'open' }] },
    portalRecipient
  ]);
  const swept = await runAskReaskSweep({ client, firmId: 'firm-1', clientId: 'client-1', now: NOW,
    deps: { deliver: async () => ({}), evaluateAdmission: admitted } });
  assert.equal(swept.escalated, 1, 'three unanswered sends after the answer: escalated');
  assert.equal(swept.nudged, 1, 'acknowledged at send 3, overdue at send 3: re-asked, not escalated');
  const escalate = client.calls.find((c) => c.sql.includes('due_at = null'));
  assert.ok(escalate.params.includes('evr-ack-ignored'));
});

await test('a poisoned row rolls back alone; the rest of the sweep continues', async () => {
  let failedOnce = false;
  const client = makeMockClient([
    notContained,
    cannedConfig(configRowAt('canary')),
    portalRecipient,
    cannedOverdue([OVERDUE_ROW({ id: 'evr-bad' }), OVERDUE_ROW({ id: 'evr-good' })]),
    {
      match: "'portal_reminders'",
      rows: () => {
        if (!failedOnce) { failedOnce = true; throw new Error('boom'); }
        return [];
      }
    }
  ]);
  // The throwing handler consumes the first nudge; the second must still land.
  const out = await runAskReaskSweep({
    client, firmId: 'firm-1', clientId: 'client-1', now: NOW,
    deps: { deliver: darkFanout, evaluateAdmission: admitted }
  });
  assert.equal(out.errors, 1);
  assert.equal(out.nudged, 1);
  assert.ok(callsMatching(client, 'rollback').length >= 1, 'poisoned row rolled back');
});

await test('portal reminders count toward escalation like the sends they replace; those before a "still unpaid" answer do not', async () => {
  const twoPortal = { portal_reminders: ['2026-06-28T10:00:00.000Z', '2026-07-05T10:00:00.000Z'] };
  const client = makeMockClient([
    notContained,
    cannedConfig(configRowAt('canary')),
    cannedOverdue([
      // one delivered send + two portal reminders, unanswered: the third step.
      OVERDUE_ROW({ id: 'evr-portal-3', request_payload: twoPortal }),
      // the same, but the owner answered "still unpaid" after the first portal reminder.
      OVERDUE_ROW({ id: 'evr-portal-ack', request_payload: { ...twoPortal,
        obligation_open_acknowledged: { at: '2026-06-30T10:00:00.000Z', send_count: 1 } } })
    ]),
    { match: 'to_regclass', rows: [{ present: 'x' }] },
    { match: 'from bookkeeping_cases', rows: [{ id: 'case-9', status: 'open' }] },
    portalRecipient
  ]);
  const out = await runAskReaskSweep({ client, firmId: 'firm-1', clientId: 'client-1', now: NOW,
    deps: { deliver: darkFanout, evaluateAdmission: admitted } });
  assert.equal(out.escalated, 1);
  assert.equal(out.portal, 1);
  const escalate = client.calls.find((c) => c.sql.includes('due_at = null'));
  assert.ok(escalate.params.includes('evr-portal-3'));
  const marker = JSON.parse(escalate.params.find((p) => typeof p === 'string' && p.includes('escalated_to_firm'))).escalated_to_firm;
  assert.deepEqual([marker.reason, marker.send_count, marker.portal_reminder_count], ['owner_unresponsive', 1, 2]);
});
