// Marketing inbound (M3) — coverage for the pure halves: Svix signature
// verification (the webhook's only auth), header access/threading parse,
// the deterministic classification matrix, and the action plan. The DB/route
// orchestration stays thin around these invariants.

import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import test from 'node:test';

import {
  FORWARDED_CLASSIFICATIONS,
  HANDLED_INBOUND_EVENTS,
  INBOUND_CLASSIFICATIONS,
  classifyInbound,
  headerValue,
  parseThreading,
  planInboundActions,
  verifySvixSignature
} from './marketingInbound.js';

// ── Svix verification ────────────────────────────────────────────────────────

const KEY_B64 = Buffer.from('test-signing-key-32-bytes-long!!').toString('base64');
const SECRET = `whsec_${KEY_B64}`;
const NOW = new Date('2026-07-24T12:00:00Z');
const TS = String(Math.floor(NOW.getTime() / 1000));

const sign = ({ id = 'msg_1', ts = TS, body = '{}', secret = SECRET } = {}) => {
  const key = Buffer.from(String(secret).replace(/^whsec_/, ''), 'base64');
  const sig = createHmac('sha256', key).update(`${id}.${ts}.${body}`, 'utf8').digest('base64');
  return { svixId: id, svixTimestamp: ts, svixSignature: `v1,${sig}`, rawBody: body };
};

test('a correctly signed request verifies', () => {
  const headers = sign({ body: '{"type":"email.received"}' });
  assert.deepEqual(verifySvixSignature({ secret: SECRET, ...headers, now: NOW }), { ok: true });
});

test('multiple space-delimited signatures verify if ANY v1 entry matches (secret rotation)', () => {
  const headers = sign({ body: '{}' });
  const rotated = { ...headers, svixSignature: `v1,garbage ${headers.svixSignature}` };
  assert.equal(verifySvixSignature({ secret: SECRET, ...rotated, now: NOW }).ok, true);
});

test('tampered body, wrong secret, and non-v1 entries are refused', () => {
  const headers = sign({ body: '{"a":1}' });
  assert.equal(verifySvixSignature({ secret: SECRET, ...headers, rawBody: '{"a":2}', now: NOW }).ok, false);
  assert.equal(
    verifySvixSignature({ secret: `whsec_${Buffer.from('another-key').toString('base64')}`, ...headers, now: NOW }).ok,
    false
  );
  assert.equal(
    verifySvixSignature({ secret: SECRET, ...headers, svixSignature: headers.svixSignature.replace('v1,', 'v2,'), now: NOW }).ok,
    false
  );
});

test('replay guard: a timestamp outside tolerance is refused even with a valid signature', () => {
  const oldTs = String(Math.floor(NOW.getTime() / 1000) - 600);
  const headers = sign({ ts: oldTs });
  const verdict = verifySvixSignature({ secret: SECRET, ...headers, now: NOW });
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /tolerance/);
});

test('missing material fails closed with a reason, never throws', () => {
  assert.equal(verifySvixSignature({}).ok, false);
  assert.equal(verifySvixSignature({ secret: SECRET }).ok, false);
  assert.equal(verifySvixSignature({ secret: SECRET, svixId: 'x', svixTimestamp: 'not-a-number', svixSignature: 'v1,x', rawBody: '' }).ok, false);
});

// ── Header access + threading ────────────────────────────────────────────────

test('headerValue reads object-shaped and array-shaped headers, case-insensitively', () => {
  assert.equal(headerValue({ 'Message-Id': '<a@x>' }, 'message-id'), '<a@x>');
  assert.equal(headerValue([{ name: 'In-Reply-To', value: '<b@y>' }], 'in-reply-to'), '<b@y>');
  assert.equal(headerValue(null, 'anything'), null);
});

test('parseThreading extracts the three RFC threading fields', () => {
  const threading = parseThreading({
    'Message-ID': '<m1@resend>',
    'In-Reply-To': '<sent1@donna>',
    References: '<sent1@donna> <m0@x>'
  });
  assert.deepEqual(threading, {
    message_id: '<m1@resend>',
    in_reply_to: '<sent1@donna>',
    references_header: '<sent1@donna> <m0@x>'
  });
});

// ── Classification matrix ────────────────────────────────────────────────────

test('event-type verdicts: bounced → bounce, complained → complaint', () => {
  assert.equal(classifyInbound({ eventType: 'email.bounced' }), 'bounce');
  assert.equal(classifyInbound({ eventType: 'email.complained' }), 'complaint');
});

test('automated mail beats keywords: Auto-Submitted and OOO both outrank an unsubscribe footer', () => {
  assert.equal(
    classifyInbound({
      eventType: 'email.received',
      headers: { 'Auto-Submitted': 'auto-replied' },
      textBody: 'I want to unsubscribe',
      matched: true
    }),
    'auto_reply'
  );
  assert.equal(
    classifyInbound({
      eventType: 'email.received',
      subject: 'Automatic reply: your note',
      textBody: 'I am out of office until Monday. To unsubscribe click below.',
      matched: true
    }),
    'out_of_office'
  );
});

test('an unsubscribe ask classifies unsubscribe_request, matched or not', () => {
  for (const matched of [true, false]) {
    assert.equal(
      classifyInbound({ eventType: 'email.received', textBody: 'Please remove me from your list.', matched }),
      'unsubscribe_request'
    );
  }
});

test('human mail: matched → reply, unknown sender → unmatched', () => {
  assert.equal(
    classifyInbound({ eventType: 'email.received', textBody: 'Interesting — how does pricing work?', matched: true }),
    'reply'
  );
  assert.equal(
    classifyInbound({ eventType: 'email.received', textBody: 'Interesting — how does pricing work?', matched: false }),
    'unmatched'
  );
});

test('our own unsubscribe footer in QUOTED history does not hijack the classification', () => {
  const body = `Sounds good, let's talk.\n\n${'x'.repeat(600)}\n> No more emails? unsubscribe here`;
  assert.equal(classifyInbound({ eventType: 'email.received', textBody: body, matched: true }), 'reply');
});

// ── Action plan ──────────────────────────────────────────────────────────────

test('bounce and complaint suppress OUR recipients; unsubscribe suppresses the sender; replies act on nothing', () => {
  // Recipients arrive already address-extracted (the route's extractAddress
  // strips "Name <email>" forms); the plan normalizes case only.
  assert.deepEqual(planInboundActions({ classification: 'bounce', recipients: ['LEAD@x-com.example', 'lead2@x-com.example'] }), [
    { action: 'suppress', email: 'lead@x-com.example', reason: 'bounced' },
    { action: 'suppress', email: 'lead2@x-com.example', reason: 'bounced' }
  ]);
  assert.deepEqual(planInboundActions({ classification: 'complaint', recipients: ['lead@x-com.example'] }), [
    { action: 'suppress', email: 'lead@x-com.example', reason: 'complaint' }
  ]);
  assert.deepEqual(planInboundActions({ classification: 'unsubscribe_request', fromEmail: 'Lead@X-com.example' }), [
    { action: 'suppress', email: 'lead@x-com.example', reason: 'unsubscribed' }
  ]);
  for (const classification of ['reply', 'unmatched', 'out_of_office', 'auto_reply']) {
    assert.deepEqual(planInboundActions({ classification, fromEmail: 'a@b.c', recipients: ['d@e.f'] }), []);
  }
});

test('vocabularies are frozen and consistent', () => {
  assert.deepEqual([...HANDLED_INBOUND_EVENTS], ['email.received', 'email.bounced', 'email.complained']);
  for (const c of FORWARDED_CLASSIFICATIONS) {
    assert.ok(INBOUND_CLASSIFICATIONS.includes(c), `${c} must be a known classification`);
  }
  assert.ok(!FORWARDED_CLASSIFICATIONS.includes('bounce'), 'transport noise is never forwarded');
});
