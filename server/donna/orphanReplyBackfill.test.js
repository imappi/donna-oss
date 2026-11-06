// Orphan-reply backfill — pure-helper tests.
//
// Pins the row shape the backfill writes: it MUST match what the
// resolve route (server/donna/api.js, PR #142) emits live, otherwise
// consumers of transaction_chat_messages have to deal with two
// flavours of `client_reply_received` rows.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildClientReplyChatMessage,
  newBackfillMessageId
} from './orphanReplyBackfill.js';

const STD_REQUEST = {
  id: 'evreq-abc',
  firm_id: 'firm-1',
  client_id: 'client-9',
  transaction_id: 'tx-42',
  status: 'replied',
  response_payload: {
    reply: 'Coffee with a prospect on Mon.',
    document_ids: ['doc-7'],
    responded_at: '2024-04-01T10:30:00.000Z'
  },
  responded_at: '2024-04-01T10:30:00.000Z',
  resolved_at: null,
  updated_at: '2024-04-01T10:30:00.000Z',
  created_at: '2024-03-30T09:00:00.000Z'
};

test('buildClientReplyChatMessage: mirrors the live bridge row shape', () => {
  const msg = buildClientReplyChatMessage(STD_REQUEST);
  assert.equal(msg.role, 'system');
  assert.equal(msg.actor_type, 'system');
  assert.equal(msg.firm_id, 'firm-1');
  assert.equal(msg.client_id, 'client-9');
  assert.equal(msg.transaction_id, 'tx-42');
  assert.equal(msg.content, 'Coffee with a prospect on Mon.');
  assert.equal(msg.payload.kind, 'client_reply_received');
  assert.equal(msg.payload.evidence_request_id, 'evreq-abc');
  assert.deepEqual(msg.payload.document_ids, ['doc-7']);
  assert.equal(msg.payload.has_reply_text, true);
  assert.equal(msg.payload.backfilled, true);
});

test('buildClientReplyChatMessage: created_at prefers response_payload.responded_at', () => {
  // The bridge fires inside the resolve route, which sets
  // response_payload.responded_at to the same `now` used for the
  // table column. Using the payload field rather than the column is
  // belt-and-braces — if older code only set the payload, the
  // timestamp still survives.
  const msg = buildClientReplyChatMessage(STD_REQUEST);
  assert.equal(msg.created_at, '2024-04-01T10:30:00.000Z');
});

test('buildClientReplyChatMessage: empty reply with documents → docs-uploaded copy', () => {
  // Exactly matches the live bridge text in server/donna/api.js.
  const msg = buildClientReplyChatMessage({
    ...STD_REQUEST,
    response_payload: { document_ids: ['doc-1', 'doc-2'], responded_at: '2024-04-01T10:30:00Z' }
  });
  assert.equal(msg.content, 'Client uploaded 2 documents in response.');
  assert.equal(msg.payload.has_reply_text, false);
  assert.deepEqual(msg.payload.document_ids, ['doc-1', 'doc-2']);
});

test('buildClientReplyChatMessage: single document → singular noun', () => {
  const msg = buildClientReplyChatMessage({
    ...STD_REQUEST,
    response_payload: { document_ids: ['doc-1'], responded_at: '2024-04-01T10:30:00Z' }
  });
  assert.equal(msg.content, 'Client uploaded 1 document in response.');
});

test('buildClientReplyChatMessage: no reply and no documents → marked-resolved copy', () => {
  // Defensive: the client may have hit "Marked resolved" without
  // attaching evidence. The live bridge falls back to a static
  // string; the backfill matches.
  const msg = buildClientReplyChatMessage({
    ...STD_REQUEST,
    response_payload: { responded_at: '2024-04-01T10:30:00Z' }
  });
  assert.equal(msg.content, 'Client marked this resolved.');
  assert.equal(msg.payload.has_reply_text, false);
  assert.deepEqual(msg.payload.document_ids, []);
});

test('buildClientReplyChatMessage: falls back through responded_at → resolved_at → updated_at', () => {
  // If response_payload is missing the timestamp (older snapshots),
  // walk the row columns. Order matters — responded_at is closest
  // to the reply event.
  const a = buildClientReplyChatMessage({
    ...STD_REQUEST,
    response_payload: { reply: 'x' },
    responded_at: '2024-02-15T08:00:00Z',
    resolved_at: '2024-02-16T08:00:00Z'
  });
  assert.equal(a.created_at, '2024-02-15T08:00:00.000Z');

  const b = buildClientReplyChatMessage({
    ...STD_REQUEST,
    response_payload: { reply: 'x' },
    responded_at: null,
    resolved_at: '2024-02-16T08:00:00Z',
    updated_at: '2024-02-20T08:00:00Z'
  });
  assert.equal(b.created_at, '2024-02-16T08:00:00.000Z');
});

test('buildClientReplyChatMessage: returns null for ineligible rows', () => {
  // Without a transaction_id there's no chat thread to land in;
  // skip rather than emitting an orphan row.
  assert.equal(buildClientReplyChatMessage(null), null);
  assert.equal(buildClientReplyChatMessage({}), null);
  assert.equal(buildClientReplyChatMessage({
    ...STD_REQUEST,
    transaction_id: null
  }), null);
  assert.equal(buildClientReplyChatMessage({
    ...STD_REQUEST,
    client_id: null
  }), null);
});

test('newBackfillMessageId: produces txchat- prefixed ids that match the live shape', () => {
  // Same prefix and structure as live ids so consumers (audit logs,
  // grep) can't tell them apart by the id alone.
  const id = newBackfillMessageId({ transactionId: 'tx-42', createdAtMs: 1700000000000 });
  assert.match(id, /^txchat-tx-42-system-[a-f0-9]{12}$/);
});

test('newBackfillMessageId: random suffix prevents collision on concurrent inserts', () => {
  const a = newBackfillMessageId({ transactionId: 'tx-42', createdAtMs: 1700000000000 });
  const b = newBackfillMessageId({ transactionId: 'tx-42', createdAtMs: 1700000000000 });
  assert.notEqual(a, b);
});
