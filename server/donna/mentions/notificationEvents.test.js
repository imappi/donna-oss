import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MENTION_NOTIFICATION_KINDS,
  NOTIFIABLE_PRINCIPAL_TYPES,
  notificationExcerpt,
  mentionNotificationId,
  buildMentionNotificationRows,
  buildRuntimeNotificationRow,
  buildNotificationPayload,
  buildMentionDigest
} from './notificationEvents.js';

const NOW = new Date('2026-08-27T12:00:00Z');

const seatRef = (id, extra = {}) => ({
  actor_type: 'seat', principal_type: 'firm_collaborator', principal_id: id, display: `Seat ${id}`, ...extra
});
const agentRef = { actor_type: 'agent', agent_id: 'clara', role: 'collections', display: 'Clara' };

test('enums pinned; principals are humans only', () => {
  assert.deepEqual([...MENTION_NOTIFICATION_KINDS], ['mention', 'assign', 'ask', 'ask_answered', 'agent_escalation']);
  assert.deepEqual([...NOTIFIABLE_PRINCIPAL_TYPES], ['firm_member', 'firm_collaborator']);
});

test('fan-out: one row per mentioned seat; agents and the poster are never notified', () => {
  const rows = buildMentionNotificationRows({
    firmId: 'f1',
    clientId: 'c1',
    surface: 'transaction_chat',
    threadId: 't-9',
    messageId: 'msg-1',
    flavor: 'mention',
    resolvedMentions: [seatRef('s-david'), seatRef('s-poster'), agentRef],
    actorPrincipal: { principal_type: 'firm_collaborator', principal_id: 's-poster' },
    actorId: 'poster@books.example',
    actorDisplay: 'Poster',
    text: 'first line\nsecond line',
    now: NOW
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].principal_id, 's-david');
  assert.equal(rows[0].kind, 'mention');
  assert.equal(rows[0].artifact_type, 'transaction');
  assert.equal(rows[0].artifact_id, 't-9');
  assert.equal(rows[0].excerpt, 'first line');
  assert.equal(rows[0].message_id, 'msg-1');
});

test('fan-out ids are deterministic — a retried write cannot double-notify', () => {
  const build = () => buildMentionNotificationRows({
    firmId: 'f1', clientId: 'c1', surface: 'document_chat', threadId: 'd-1',
    messageId: 'msg-2', flavor: 'assign', resolvedMentions: [seatRef('s-a')], text: 'x', now: NOW
  });
  const [a] = build();
  const [b] = build();
  assert.equal(a.id, b.id);
  assert.match(a.id, /^ntf-[0-9a-f]{24}$/);
  assert.equal(a.kind, 'assign');
  assert.equal(a.artifact_type, 'document');
  // a different kind on the same message is a different notification
  assert.notEqual(
    mentionNotificationId({ firmId: 'f1', principalType: 'firm_collaborator', principalId: 's-a', kind: 'mention', messageId: 'msg-2' }),
    a.id
  );
});

test('runtime row: agent-lane kinds only, humans only, unknown kind refused', () => {
  const row = buildRuntimeNotificationRow({
    firmId: 'f1', clientId: 'c1', kind: 'agent_escalation', artifactType: 'transaction',
    artifactId: 't-1', principal: { principal_type: 'firm_member', principal_id: 'm-kari' },
    actorId: 'clara', actorDisplay: 'Clara', text: 'Could not answer', askId: 'ask-1', now: NOW
  });
  assert.equal(row.kind, 'agent_escalation');
  assert.equal(row.ask_id, 'ask-1');
  assert.equal(buildRuntimeNotificationRow({ kind: 'nonsense', principal: { principal_type: 'firm_member', principal_id: 'x' } }), null);
  assert.equal(buildRuntimeNotificationRow({ kind: 'ask_answered', principal: { principal_type: 'ai_occupant', principal_id: 'clara' } }), null,
    'an agent principal never gets a notification row');
});

test('payload shape is the §7 mobile contract, keys stable', () => {
  const payload = buildNotificationPayload({
    kind: 'mention', artifact_type: 'transaction', artifact_id: 't-1', client_id: 'c1',
    actor_id: 'kari@books.example', actor_display: 'Kari', excerpt: 'hello'
  });
  assert.deepEqual(Object.keys(payload), ['kind', 'artifact', 'actor', 'excerpt', 'deep_link']);
  assert.deepEqual(payload.artifact, { type: 'transaction', id: 't-1', client_id: 'c1' });
  assert.deepEqual(payload.actor, { id: 'kari@books.example', display: 'Kari' });
  assert.equal(payload.deep_link, null);
});

test('digest wording: "N questions waiting on you · M mentions", read rows excluded', () => {
  const digest = buildMentionDigest({
    openAsks: [
      { question: 'What was this £120 charge?', transaction_id: 't-1', artifact_type: 'transaction', artifact_id: 't-1', created_by: 'kari@books.example' },
      { question: 'Receipt for the taxi?', artifact_type: 'document', artifact_id: 'd-2', created_by: 'kari@books.example' }
    ],
    notifications: [
      { kind: 'mention', excerpt: 'take a look', actor_display: 'Kari', artifact_type: 'transaction', artifact_id: 't-3', read_at: null },
      { kind: 'mention', excerpt: 'seen already', actor_display: 'Kari', artifact_type: 'transaction', artifact_id: 't-4', read_at: '2026-08-27T10:00:00Z' },
      { kind: 'ask', excerpt: 'an ask row is not a mention line', actor_display: 'Kari', artifact_type: 'transaction', artifact_id: 't-5', read_at: null }
    ]
  });
  assert.equal(digest.headline, '2 questions waiting on you · 1 mention');
  assert.equal(digest.ask_count, 2);
  assert.equal(digest.mention_count, 1);
  assert.equal(digest.items[0], 'kari asked on transaction t-1: "What was this £120 charge?"');
  assert.ok(digest.items.some((i) => i.includes('mentioned you on transaction t-3')));
});

test('excerpt: first non-empty line, bounded', () => {
  assert.equal(notificationExcerpt('\n\n  hello world  \nmore'), 'hello world');
  const long = 'x'.repeat(200);
  assert.equal(notificationExcerpt(long).length, 140);
  assert.ok(notificationExcerpt(long).endsWith('…'));
});
