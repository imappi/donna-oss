import test from 'node:test';
import assert from 'node:assert/strict';

import {
  COMMENT_PAYLOAD_KINDS,
  COMMENT_AUDIT_ACTIONS,
  REDACTED_CONTENT_MARKER,
  buildCommentPayload,
  buildThreadResolutionPayload,
  isCommentPayload,
  chatCommentAuditEvent,
  latestAssignmentFromComments,
  redactionPayloadStamp
} from './commentEvents.js';

const seatRef = { actor_type: 'seat', principal_type: 'firm_member', principal_id: 'm-kari', display: 'Kari' };
const agentRef = { actor_type: 'agent', agent_id: 'clara', role: 'collections', display: 'Clara' };

test('enums pinned', () => {
  assert.deepEqual([...COMMENT_PAYLOAD_KINDS], ['comment', 'thread_resolution']);
  assert.equal(COMMENT_AUDIT_ACTIONS.posted, 'chat.comment_posted');
  assert.equal(REDACTED_CONTENT_MARKER, '[redacted]');
});

test('comment payload carries flavor + structured refs; unvalidated refs throw', () => {
  const p = buildCommentPayload({ flavor: 'ask', mentions: [seatRef, agentRef], askId: 'ask-1' });
  assert.equal(p.kind, 'comment');
  assert.equal(p.flavor, 'ask');
  assert.equal(p.ask_id, 'ask-1');
  assert.deepEqual(p.mentions[0], { actor_type: 'seat', principal_type: 'firm_member', principal_id: 'm-kari', display: 'Kari' });
  assert.deepEqual(p.mentions[1], { actor_type: 'agent', agent_id: 'clara', role: 'collections', display: 'Clara' });
  assert.equal('supersedes_message_id' in p, false);
  assert.throws(() => buildCommentPayload({ mentions: [{ actor_type: 'channel' }] }));
});

test('edit = a new version row via supersedes_message_id; audit action follows', () => {
  const edited = buildCommentPayload({ mentions: [seatRef], supersedesMessageId: 'msg-1' });
  assert.equal(edited.supersedes_message_id, 'msg-1');
  const audit = chatCommentAuditEvent({
    surface: 'transaction_chat',
    message: { id: 'msg-2', payload: edited },
    actorId: 'kari@books.example',
    threadRef: { transaction_id: 't1' }
  });
  assert.equal(audit.action, 'chat.comment_edited');
  assert.equal(audit.metadata.supersedes_message_id, 'msg-1');
});

test('comment audit: in-transaction shape, actor + mention attribution, per-surface resource type', () => {
  const payload = buildCommentPayload({ flavor: 'mention', mentions: [seatRef, agentRef] });
  const audit = chatCommentAuditEvent({
    surface: 'document_chat',
    message: { id: 'msg-9', payload },
    actorId: 'kari@books.example',
    threadRef: { document_id: 'd1' }
  });
  assert.equal(audit.action, 'chat.comment_posted');
  assert.equal(audit.resourceType, 'document_chat_message');
  assert.equal(audit.actorId, 'kari@books.example');
  assert.deepEqual(audit.metadata.mention_actors, ['seat:firm_member:m-kari', 'agent:clara']);
  assert.equal(audit.metadata.document_id, 'd1');
});

test('plain conversation stays un-audited; comment-lane rows never do', () => {
  assert.equal(chatCommentAuditEvent({ surface: 'transaction_chat', message: { id: 'm', payload: {} } }), null);
  assert.equal(chatCommentAuditEvent({ surface: 'transaction_chat', message: { id: 'm', payload: { kind: 'client_reply_received' } } }), null);
  assert.equal(isCommentPayload({ kind: 'comment' }), true);
  assert.equal(isCommentPayload({ kind: 'thread_resolution' }), true);
  assert.equal(isCommentPayload({}), false);
});

test('comment audit: a staff-seat poster stamps its ladder metadata; others stay bare', () => {
  const payload = buildCommentPayload({ flavor: 'mention', mentions: [seatRef] });
  const seatAudit = chatCommentAuditEvent({
    surface: 'transaction_chat',
    message: { id: 'm-s', payload },
    actorId: 'david@books.example',
    threadRef: { transaction_id: 't1' },
    actorSeat: { seat_role: 'junior', affiliation: 'external' }
  });
  assert.equal(seatAudit.metadata.actor_seat_role, 'junior');
  assert.equal(seatAudit.metadata.actor_affiliation, 'external');
  // affiliation fail-closes to internal when a seat rides without one
  const bareAffiliation = chatCommentAuditEvent({
    surface: 'transaction_chat',
    message: { id: 'm-b', payload },
    actorId: 'x@books.example',
    threadRef: { transaction_id: 't1' },
    actorSeat: { seat_role: 'senior' }
  });
  assert.equal(bareAffiliation.metadata.actor_affiliation, 'internal');
  // no actorSeat (owner / legacy poster) -> no seat keys in the receipt
  const ownerAudit = chatCommentAuditEvent({
    surface: 'transaction_chat',
    message: { id: 'm-o', payload },
    actorId: 'kari@books.example',
    threadRef: { transaction_id: 't1' }
  });
  assert.equal('actor_seat_role' in ownerAudit.metadata, false);
  assert.equal('actor_affiliation' in ownerAudit.metadata, false);
});

test('thread resolution: outcome note + flag-only policy-memory candidate', () => {
  const p = buildThreadResolutionPayload({ outcomeNote: 'treated as director loan', policyMemoryCandidate: true });
  assert.equal(p.kind, 'thread_resolution');
  assert.equal(p.policy_memory_candidate, true);
  const audit = chatCommentAuditEvent({ surface: 'transaction_chat', message: { id: 'm3', payload: p } });
  assert.equal(audit.action, 'chat.thread_resolved');
  assert.equal(audit.metadata.policy_memory_candidate, true);
  // Truthiness is not enough — the flag is an explicit boolean.
  assert.equal(buildThreadResolutionPayload({ policyMemoryCandidate: 'yes' }).policy_memory_candidate, false);
});

test('redaction stamp carries the actor and never the original text', () => {
  const stamp = redactionPayloadStamp({ actorId: 'kari@books.example', reason: 'legal' });
  assert.deepEqual(stamp, { content_redacted: true, redacted_by: 'kari@books.example', redaction_reason: 'legal' });
});

test('assignment projection: latest un-redacted assign comment wins; never a store', () => {
  const assign = (id, principalId, createdAt, extra = {}) => ({
    id,
    actor_id: 'kari@books.example',
    content: `handing to ${principalId}`,
    created_at: createdAt,
    payload: {
      kind: 'comment',
      flavor: 'assign',
      mentions: [{ actor_type: 'seat', principal_type: 'firm_collaborator', principal_id: principalId, display: principalId }],
      ...extra
    }
  });
  assert.equal(latestAssignmentFromComments([]), null);
  assert.equal(latestAssignmentFromComments([
    { id: 'm1', payload: { kind: 'comment', flavor: 'mention', mentions: [seatRef] } }
  ]), null, 'a plain mention never assigns');
  const projected = latestAssignmentFromComments([
    assign('m1', 's-first', '2026-08-27T09:00:00Z'),
    assign('m2', 's-second', '2026-08-27T11:00:00Z'),
    // a later assign that was redacted no longer speaks
    assign('m3', 's-third', '2026-08-27T12:00:00Z', { content_redacted: true })
  ]);
  assert.equal(projected.assigned_to.principal_id, 's-second');
  assert.equal(projected.assigned_by, 'kari@books.example');
  assert.equal(projected.message_id, 'm2');
  assert.equal(projected.note, 'handing to s-second');
  // an agent-only mention set cannot hold an assignment
  assert.equal(latestAssignmentFromComments([
    { id: 'm4', created_at: '2026-08-27T13:00:00Z', payload: { kind: 'comment', flavor: 'assign', mentions: [agentRef] } }
  ]), null);
});
