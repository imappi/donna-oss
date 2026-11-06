// The owner chat apply — ONE function, two doors (clientChatApply.js).
//
// Load-bearing properties:
//   - both doors (the portal route's 'client_chat', the hosted chat surfaces'
//     'chatgpt_app' / 'claude_remote') run the SAME gate → writer → audit →
//     stamp chain; an unknown door is refused, never receipted under a
//     made-up name;
//   - the apply audit (client_chat.*_applied) carries metadata.surface = the
//     DOOR, actor attribution, and is audit-as-precondition: it is emitted
//     INSIDE the execute thunk, before the stamp, with bestEffort false — a
//     failed receipt leaves the action un-stamped and the caller sees the
//     error;
//   - the message is read scoped to (firm, client): a message on another
//     entity's thread answers exactly like a nonexistent id;
//   - the spine's gates hold: a non-appliable type is refused (400), a
//     declined action 409, an unknown index 404, an applied action replays;
//   - a verb-owned non-applied terminal (`respond`) passes through unstamped
//     with the route's body; the response bodies are the route's, byte-for-
//     byte, so the api.js delegation is a wiring change, not a behaviour one.

import test from 'node:test';
import assert from 'node:assert/strict';

import { CLIENT_PORTAL_CHAT_APPLIABLE_ACTION_TYPES, assertClientChatActionCapability } from './clientPortalChat.js';
import { CLIENT_CHAT_APPLY_DOORS, CLIENT_CHAT_APPLY_SPINE_SURFACE, applyClientChatAction } from './clientChatApply.js';

const OWNER = { principalType: 'firm_collaborator', email: 'owner@example.test', collaborator: { id: 'collab-7' } };
const STAFF = { principalType: 'firm_member', email: 'staff@example.test' };

const messageWith = (actions, extra = {}) => ({
  id: 'clchat-alpha-assistant-abc',
  firm_id: 'firm-1',
  client_id: 'client-a',
  role: 'assistant',
  content: 'Got it.',
  model: 'claude-donna-test',
  payload: { actions },
  ...extra
});

const ANSWER = { type: 'answer_evidence_request', evidence_request_id: 'ask-1', reply_text: 'A milk frother for the shop.', status: 'proposed' };
const MILEAGE = { type: 'record_mileage', miles: 120, date: '2026-09-10', purpose: 'Sacramento conference', status: 'proposed' };

const poison = (name) => async () => { throw new Error(`${name} must not be reached`); };

// A recording dependency set. The message store is keyed by (client, id) so
// the scoped read behaves like the real one: another client's message is
// simply not there.
const makeDeps = ({ messages = {}, ask = { id: 'ask-1', status: 'open', transaction_id: 'tx-9' }, mileage = null, overrides = {} } = {}) => {
  const calls = { audits: [], stamps: [], resolves: [], mileages: [], bridges: [], reads: [] };
  const deps = {
    getClientPortalChatMessageFromDb: async ({ firmId, clientId, messageId }) => {
      calls.reads.push({ firmId, clientId, messageId });
      return messages[`${clientId}/${messageId}`] || null;
    },
    getClientEvidenceRequestForClientFromDb: async ({ clientId, evidenceRequestId }) => (ask && ask.id === evidenceRequestId && clientId === 'client-a' ? ask : null),
    resolveClientEvidenceRequestInDb: async (input) => {
      calls.resolves.push(input);
      return { evidence_request: { id: input.evidenceRequestId, status: 'replied', transaction_id: ask?.transaction_id || null }, recode: { applied: true } };
    },
    recordOwnerMileageExpenseInDb: async (input) => {
      calls.mileages.push(input);
      return mileage || { status: 'booked', ledger_journal_id: 'lj-1', amount: 54 };
    },
    updateClientPortalChatActionStatusInDb: async (input) => {
      calls.stamps.push(input);
      return { id: input.messageId, payload: { actions: [{ ...ANSWER, status: input.status, result: input.result }] } };
    },
    appendTransactionChatMessageInDb: async (input) => { calls.bridges.push(input); return { id: input.id }; },
    assertClientChatActionCapability,
    queryFirmDb: async (sql, params) => { calls.audits.push({ sql, params }); return { rows: [] }; },
    warn: () => {},
    ...overrides
  };
  return { deps, calls };
};

const apply = (deps, over = {}) => applyClientChatAction({
  firmId: 'firm-1',
  clientId: 'client-a',
  messageId: 'clchat-alpha-assistant-abc',
  actionIndex: 0,
  principal: OWNER,
  surface: 'client_chat',
  deps,
  ...over
});

const auditRowOf = (calls, i = 0) => {
  const { params } = calls.audits[i];
  return { firmId: params[0], clientId: params[1], actorType: params[2], actorId: params[3], action: params[4], resourceType: params[5], resourceId: params[6], metadata: JSON.parse(params[7]) };
};

test('the doors are the portal plus the two hosted chat surfaces; the spine surface is the owner grammar', () => {
  assert.deepEqual(CLIENT_CHAT_APPLY_DOORS, ['client_chat', 'chatgpt_app', 'claude_remote']);
  assert.equal(CLIENT_CHAT_APPLY_SPINE_SURFACE, 'client_chat');
  assert.deepEqual(CLIENT_PORTAL_CHAT_APPLIABLE_ACTION_TYPES, ['answer_evidence_request', 'record_mileage']);
});

for (const door of CLIENT_CHAT_APPLY_DOORS) {
  test(`door '${door}': answer_evidence_request runs the tracked ask → recode writer, audits with metadata.surface = the door BEFORE the stamp, bridges into the case file, returns the route body`, async () => {
    const { deps, calls } = makeDeps({ messages: { 'client-a/clchat-alpha-assistant-abc': messageWith([ANSWER]) } });
    const out = await apply(deps, { surface: door });
    assert.equal(out.disposition, 'applied');
    assert.equal(out.statusCode, 200);
    assert.deepEqual(Object.keys(out.body), ['applied', 'action_type', 'result', 'message']);
    assert.equal(out.body.applied, true);
    assert.equal(out.body.action_type, 'answer_evidence_request');
    assert.deepEqual(out.body.result, { evidence_request_id: 'ask-1', evidence_request_status: 'replied', recode: { applied: true } });
    // The writer: the same resolve an upload reply uses, with the actor.
    assert.equal(calls.resolves.length, 1);
    assert.equal(calls.resolves[0].actorId, 'owner@example.test');
    assert.equal(calls.resolves[0].replyAuthority.source, 'authenticated_client_chat');
    assert.equal(calls.resolves[0].replyAuthority.principal.principalType, 'firm_collaborator');
    assert.equal(calls.resolves[0].reply, 'A milk frother for the shop.');
    // The audit: the route's action name, resource, actor, and the DOOR.
    assert.equal(calls.audits.length, 1);
    const row = auditRowOf(calls);
    assert.equal(row.action, 'client_chat.answer_evidence_request_applied');
    assert.equal(row.resourceType, 'client_evidence_request');
    assert.equal(row.resourceId, 'ask-1');
    assert.equal(row.actorType, 'client');
    assert.equal(row.actorId, 'owner@example.test');
    assert.equal(row.metadata.surface, door, 'the receipt answers "which door applied this owner answer"');
    assert.equal(row.metadata.message_id, 'clchat-alpha-assistant-abc');
    assert.equal(row.metadata.action_index, 0);
    assert.equal(row.metadata.has_reply_text, true);
    // The stamp: through the spine, after the audit.
    assert.equal(calls.stamps.length, 1);
    assert.equal(calls.stamps[0].status, 'applied');
    assert.deepEqual(calls.stamps[0].result, out.body.result);
    // The case-file bridge names the door too.
    assert.equal(calls.bridges.length, 1);
    assert.equal(calls.bridges[0].payload.via, door);
    assert.equal(calls.bridges[0].payload.kind, 'client_reply_received');
  });
}

test('record_mileage: the mileage writer, its own audit row (ledger_journal resource), the door on the audit', async () => {
  const { deps, calls } = makeDeps({ messages: { 'client-a/clchat-alpha-assistant-abc': messageWith([MILEAGE]) } });
  const out = await apply(deps, { surface: 'chatgpt_app' });
  assert.equal(out.disposition, 'applied');
  assert.equal(calls.mileages.length, 1);
  assert.equal(calls.mileages[0].model, 'claude-donna-test', 'the proposing model rides to the mileage writer');
  assert.equal(calls.resolves.length, 0);
  const row = auditRowOf(calls);
  assert.equal(row.action, 'client_chat.record_mileage_applied');
  assert.equal(row.resourceType, 'ledger_journal');
  assert.equal(row.resourceId, 'lj-1');
  assert.equal(row.metadata.surface, 'chatgpt_app');
  assert.deepEqual(row.metadata.mileage, { miles: 120, purpose: 'Sacramento conference', date: '2026-09-10' });
  assert.equal(calls.bridges.length, 0, 'mileage has no ask to bridge');
});

test('a firm member confirming on the owner thread is attributed as firm, never as the client', async () => {
  const { deps, calls } = makeDeps({ messages: { 'client-a/clchat-alpha-assistant-abc': messageWith([ANSWER]) } });
  await apply(deps, { principal: STAFF });
  assert.equal(auditRowOf(calls).actorType, 'firm');
  assert.equal(auditRowOf(calls).actorId, 'staff@example.test');
});

test('audit-as-precondition: a failed apply audit propagates as the refusal, the action is NOT stamped, the bridge does not run', async () => {
  const { deps, calls } = makeDeps({
    messages: { 'client-a/clchat-alpha-assistant-abc': messageWith([ANSWER]) },
    overrides: { queryFirmDb: async () => { throw new Error('audit insert failed'); } }
  });
  const out = await apply(deps, { surface: 'claude_remote' });
  assert.equal(out.disposition, 'refuse');
  assert.equal(out.statusCode, 500);
  assert.match(out.body.error, /audit insert failed/);
  assert.equal(out.body.action_type, 'answer_evidence_request');
  assert.equal(calls.resolves.length, 1, 'the writer had committed (the recode stands)');
  assert.equal(calls.stamps.length, 0, 'never stamped applied without its receipt — stays proposed and re-appliable');
  assert.equal(calls.bridges.length, 0);
});

test('an unknown door is refused before anything is read', async () => {
  const { deps, calls } = makeDeps({ messages: { 'client-a/clchat-alpha-assistant-abc': messageWith([ANSWER]) } });
  const out = await apply(deps, { surface: 'admin_chat' });
  assert.equal(out.disposition, 'refuse');
  assert.equal(out.statusCode, 500);
  assert.match(out.body.error, /Unknown client-chat apply door/);
  assert.equal(calls.reads.length, 0);
  assert.equal(calls.audits.length, 0);
});

test('tenancy: a message on another entity’s thread reads as not found — the same 404 body as a nonexistent id', async () => {
  const { deps, calls } = makeDeps({ messages: { 'client-b/clchat-beta-assistant-xyz': messageWith([ANSWER], { client_id: 'client-b' }) } });
  const crossEntity = await apply(deps, { messageId: 'clchat-beta-assistant-xyz' });
  const nonexistent = await apply(deps, { messageId: 'clchat-nope' });
  assert.deepEqual(crossEntity, { disposition: 'refuse', statusCode: 404, body: { error: 'Chat message not found.' } });
  assert.deepEqual(nonexistent, crossEntity);
  assert.ok(calls.reads.every((r) => r.clientId === 'client-a'), 'every read is scoped to the calling entity');
  assert.equal(calls.audits.length, 0);
});

test('the spine gates hold on every door: non-appliable type 400, unknown index 404, declined 409 — nothing written', async () => {
  const { deps, calls } = makeDeps({
    messages: {
      'client-a/clchat-alpha-assistant-abc': messageWith([
        { type: 'recategorize', account_name: 'Office', status: 'proposed' },
        { ...ANSWER, status: 'declined' }
      ])
    }
  });
  const recat = await apply(deps, { surface: 'chatgpt_app', actionIndex: 0 });
  assert.equal(recat.statusCode, 400);
  assert.deepEqual(recat.body, { error: "Apply not yet supported for action type 'recategorize'.", action_type: 'recategorize' });
  const declined = await apply(deps, { surface: 'claude_remote', actionIndex: 1 });
  assert.equal(declined.statusCode, 409);
  assert.match(declined.body.error, /status 'declined'/);
  const oob = await apply(deps, { actionIndex: 7 });
  assert.equal(oob.statusCode, 404);
  assert.match(oob.body.error, /out of range/);
  assert.equal(calls.resolves.length + calls.mileages.length + calls.audits.length + calls.stamps.length, 0);
});

test('an already-applied action replays idempotently with the route body; no writer, no audit', async () => {
  const applied = { ...ANSWER, status: 'applied', result: { evidence_request_status: 'replied' } };
  const { deps, calls } = makeDeps({ messages: { 'client-a/clchat-alpha-assistant-abc': messageWith([applied]) } });
  const out = await apply(deps, { surface: 'chatgpt_app' });
  assert.equal(out.disposition, 'replay');
  assert.equal(out.statusCode, 200);
  assert.deepEqual(Object.keys(out.body), ['applied', 'replay', 'action', 'message']);
  assert.equal(out.body.replay, true);
  assert.equal(calls.resolves.length + calls.audits.length + calls.stamps.length, 0);
});

test('respond: the ask already resolved passes through as the route’s 409 with evidence_request_status, unstamped, unaudited', async () => {
  const { deps, calls } = makeDeps({
    messages: { 'client-a/clchat-alpha-assistant-abc': messageWith([ANSWER]) },
    ask: { id: 'ask-1', status: 'resolved', transaction_id: 'tx-9' }
  });
  const out = await apply(deps, { surface: 'chatgpt_app' });
  assert.equal(out.disposition, 'respond');
  assert.equal(out.statusCode, 409);
  assert.deepEqual(out.body, { error: 'This question is already resolved.', action_type: 'answer_evidence_request', evidence_request_status: 'resolved' });
  assert.equal(calls.resolves.length + calls.audits.length + calls.stamps.length, 0);
});

test('respond: a mileage entry the writer will not book passes through as the route’s 409 with status + reason, unstamped', async () => {
  const { deps, calls } = makeDeps({
    messages: { 'client-a/clchat-alpha-assistant-abc': messageWith([MILEAGE]) },
    mileage: { status: 'needs_clarification', reason: 'missing_business_purpose', computation: { rate: 0.45 } }
  });
  const out = await apply(deps, { surface: 'claude_remote' });
  assert.equal(out.disposition, 'respond');
  assert.equal(out.statusCode, 409);
  assert.deepEqual(out.body, { applied: false, action_type: 'record_mileage', status: 'needs_clarification', reason: 'missing_business_purpose', computation: { rate: 0.45 } });
  assert.equal(calls.audits.length + calls.stamps.length, 0);
});

test('the ask row must belong to this client at apply time (defense in depth on the model-named id): 404, nothing written', async () => {
  const { deps, calls } = makeDeps({
    messages: { 'client-a/clchat-alpha-assistant-abc': messageWith([{ ...ANSWER, evidence_request_id: 'ask-someone-elses' }]) }
  });
  const out = await apply(deps, { surface: 'chatgpt_app' });
  assert.equal(out.disposition, 'refuse');
  assert.equal(out.statusCode, 404);
  assert.deepEqual(out.body, { error: 'Evidence request not found for this client.', action_type: 'answer_evidence_request' });
  assert.equal(calls.resolves.length + calls.audits.length + calls.stamps.length, 0);
});

test('a pre-loaded message (a caller that pre-checked it) is used as-is — no second read', async () => {
  const { deps, calls } = makeDeps({ overrides: { getClientPortalChatMessageFromDb: poison('message read') } });
  const out = await apply(deps, { surface: 'chatgpt_app', message: messageWith([ANSWER]) });
  assert.equal(out.disposition, 'applied');
  assert.equal(calls.reads.length, 0);
});
