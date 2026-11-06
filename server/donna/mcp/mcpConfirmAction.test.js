// MCP act tier — confirm_action executor pins
// (docs/design-donna-chatgpt-app-build-brief.md §5 slice 3 tests).
//
// Load-bearing properties:
//   - ONLY the owner-appliable types reach the spine: recategorize, post,
//     request_report, share_portal_link and every firm verb are refused
//     BEFORE applyClientChatAction is called, with a coded error;
//   - the SAME apply path as the portal: the executor calls
//     applyClientChatAction with this surface as the door and nothing else —
//     it imports no resolver, no ledger writer, no status writer, no spine
//     primitive directly (source pin; K-mcp-1 on the act tier);
//   - cross-entity, cross-owner and nonexistent message ids answer with the
//     SAME coded not-found (no existence leak);
//   - the route's consequence renders honestly: applied → the result
//     (evidence_request_status / recode.applied); a `respond` → applied:false
//     with the reason; a replay → the recorded result; a refusal → a coded
//     error with the route's status;
//   - the billing backstop runs before any read, as on the portal route.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve as resolvePath } from 'node:path';

import { CLIENT_PORTAL_CHAT_APPLIABLE_ACTION_TYPES } from '../clientPortalChat.js';
import { MCP_SURFACES, findMcpTool } from './mcpReadSurface.js';
import {
  MCP_ACT_TOOL_EXECUTORS,
  MCP_CONFIRM_ACTION_CODES,
  MCP_CONFIRM_ACTION_TYPES,
  runConfirmAction
} from './mcpConfirmAction.js';

const here = dirname(fileURLToPath(import.meta.url));

const ENTITIES = [{ id: 'client-a', name: 'Alpha Ltd', jurisdiction: 'GB', accounting_basis: null }];
const OWNER_ACCESS = { principal: { principalType: 'firm_collaborator', email: 'owner@example.test' }, allowedClientIds: ['client-a'] };

const messageWith = (actions) => ({ id: 'clchat-alpha-assistant-abc', client_id: 'client-a', role: 'assistant', payload: { actions } });
const ANSWER = { type: 'answer_evidence_request', evidence_request_id: 'ask-1', reply_text: 'A milk frother for the shop.', status: 'proposed' };

const makeDeps = ({ messages = {}, applyOutcome = null, overrides = {} } = {}) => {
  const calls = { applies: [], entitled: [], reads: [] };
  const deps = {
    getClientPortalChatMessageFromDb: async ({ clientId, messageId }) => {
      calls.reads.push({ clientId, messageId });
      return messages[`${clientId}/${messageId}`] || null;
    },
    applyClientChatAction: async (input) => {
      calls.applies.push(input);
      return applyOutcome || {
        disposition: 'applied',
        statusCode: 200,
        body: {},
        result: { evidence_request_id: 'ask-1', evidence_request_status: 'replied', recode: { applied: true } }
      };
    },
    assertClientEntitled: async (input) => { calls.entitled.push(input); },
    isBillingEnabled: () => false,
    ...overrides
  };
  return { deps, calls };
};

const run = (deps, args = { entity_id: 'client-a', message_id: 'clchat-alpha-assistant-abc', action_index: 0 }, over = {}) =>
  runConfirmAction({ firmId: 'firm-1', access: OWNER_ACCESS, entities: ENTITIES, args, surface: MCP_SURFACES.chatgpt_app, deps, ...over });

const rejectsWith = async (promise, code, statusCode) => {
  await assert.rejects(promise, (error) => {
    assert.equal(error.code, code, error.message);
    assert.equal(error.statusCode, statusCode);
    return true;
  });
};

test('the tool’s closed enum IS the portal’s owner-appliable set, imported', () => {
  assert.equal(MCP_CONFIRM_ACTION_TYPES, CLIENT_PORTAL_CHAT_APPLIABLE_ACTION_TYPES);
  assert.deepEqual([...MCP_CONFIRM_ACTION_TYPES], ['answer_evidence_request', 'record_mileage']);
  assert.deepEqual(Object.keys(MCP_ACT_TOOL_EXECUTORS), ['confirm_action']);
  assert.equal(findMcpTool('confirm_action').tier, 'act');
});

test('applied: the ONE apply path runs with this surface as the door and the persisted message; the consequence renders as the route returns it', async () => {
  const { deps, calls } = makeDeps({ messages: { 'client-a/clchat-alpha-assistant-abc': messageWith([ANSWER]) } });
  const result = await run(deps);
  assert.equal(calls.entitled.length, 1);
  assert.equal(calls.applies.length, 1);
  const applyInput = calls.applies[0];
  assert.equal(applyInput.surface, 'chatgpt_app', 'the door is the calling MCP surface');
  assert.equal(applyInput.clientId, 'client-a');
  assert.equal(applyInput.messageId, 'clchat-alpha-assistant-abc');
  assert.equal(applyInput.actionIndex, 0);
  assert.equal(applyInput.principal, OWNER_ACCESS.principal);
  assert.equal(applyInput.message.id, 'clchat-alpha-assistant-abc', 'the pre-checked persisted row is handed over, not re-read');
  assert.equal(result.applied, true);
  assert.equal(result.action_type, 'answer_evidence_request');
  assert.equal(result.evidence_request_status, 'replied');
  assert.deepEqual(result.recode, { applied: true });
  assert.deepEqual(result.entity, { id: 'client-a', name: 'Alpha Ltd' });
  assert.equal(result.message_id, 'clchat-alpha-assistant-abc');
  assert.equal(result.action_index, 0);
  assert.equal(result.surface, 'chatgpt_app');
  assert.ok(!('model_id' in result), 'the owner applies; no model proposes on this tier');
});

test('only appliable owner types reach the spine: recategorize / post / request_report / share_portal_link / firm verbs are refused BEFORE applyClientChatAction', async () => {
  const forbidden = ['recategorize', 'post', 'request_report', 'share_portal_link', 'reject_match', 'mark_personal', 'learn_rule', 'sync_to_accounting', 'approve_payment', 'admin_chat', ''];
  for (const type of forbidden) {
    const { deps, calls } = makeDeps({ messages: { 'client-a/clchat-alpha-assistant-abc': messageWith([{ type, status: 'proposed' }]) } });
    await rejectsWith(run(deps), MCP_CONFIRM_ACTION_CODES.type_not_confirmable, 400);
    assert.equal(calls.applies.length, 0, `'${type}' must never reach the apply path`);
  }
});

test('cross-entity, cross-owner and nonexistent message ids: the SAME coded not-found, nothing applied', async () => {
  const { deps, calls } = makeDeps({
    messages: {
      // another entity's thread (or another owner's — one thread per entity)
      'client-b/clchat-beta-assistant-xyz': messageWith([ANSWER])
    }
  });
  const errors = [];
  for (const messageId of ['clchat-beta-assistant-xyz', 'clchat-nope']) {
    await assert.rejects(run(deps, { entity_id: 'client-a', message_id: messageId, action_index: 0 }), (error) => { errors.push(error); return true; });
  }
  assert.equal(errors[0].code, MCP_CONFIRM_ACTION_CODES.target_not_found);
  assert.equal(errors[0].statusCode, 404);
  assert.equal(errors[0].message, errors[1].message, 'no existence leak between "not yours" and "does not exist"');
  assert.equal(errors[0].code, errors[1].code);
  // An action index past the end is the same answer.
  const { deps: d2 } = makeDeps({ messages: { 'client-a/clchat-alpha-assistant-abc': messageWith([ANSWER]) } });
  await assert.rejects(run(d2, { entity_id: 'client-a', message_id: 'clchat-alpha-assistant-abc', action_index: 3 }), (error) => {
    assert.equal(error.code, MCP_CONFIRM_ACTION_CODES.target_not_found);
    assert.equal(error.message, errors[0].message);
    return true;
  });
  assert.ok(calls.reads.every((r) => r.clientId === 'client-a'), 'every read scoped to the calling entity');
  assert.equal(calls.applies.length, 0);
});

test('an unexposed / unknown entity is refused as ENTITY_NOT_FOUND before any read', async () => {
  const { deps, calls } = makeDeps();
  await rejectsWith(run(deps, { entity_id: 'client-z', message_id: 'm', action_index: 0 }), 'ENTITY_NOT_FOUND', 404);
  assert.equal(calls.reads.length + calls.entitled.length, 0);
});

test('argument guards: a blank message_id and a negative or non-integer action_index are refused before any read', async () => {
  const { deps, calls } = makeDeps();
  await rejectsWith(run(deps, { entity_id: 'client-a', message_id: '  ', action_index: 0 }), 'INVALID_ARGUMENTS', 400);
  await rejectsWith(run(deps, { entity_id: 'client-a', message_id: 'm', action_index: -1 }), 'INVALID_ARGUMENTS', 400);
  await rejectsWith(run(deps, { entity_id: 'client-a', message_id: 'm', action_index: 1.5 }), 'INVALID_ARGUMENTS', 400);
  await rejectsWith(run(deps, { entity_id: 'client-a', message_id: 'm', action_index: '0' }), 'INVALID_ARGUMENTS', 400);
  assert.equal(calls.reads.length, 0);
});

test('the billing backstop runs exactly as on the portal route: an unentitled owner is refused before any read', async () => {
  const { deps, calls } = makeDeps({
    overrides: { assertClientEntitled: async () => { throw Object.assign(new Error('Subscription inactive.'), { statusCode: 402, code: 'CLIENT_NOT_ENTITLED' }); } }
  });
  await rejectsWith(run(deps), 'CLIENT_NOT_ENTITLED', 402);
  assert.equal(calls.reads.length + calls.applies.length, 0);
});

test('a refused apply renders as a coded error carrying the route’s status: 409 not proposed, 403 not permitted, 404 target, 500 apply failed', async () => {
  const cases = [
    [{ disposition: 'refuse', statusCode: 409, body: { error: "Action is in status 'declined' and cannot be applied." } }, MCP_CONFIRM_ACTION_CODES.not_proposed],
    [{ disposition: 'refuse', statusCode: 403, body: { error: 'Capability denied.' } }, MCP_CONFIRM_ACTION_CODES.not_permitted],
    [{ disposition: 'refuse', statusCode: 404, body: { error: 'Evidence request not found for this client.' } }, MCP_CONFIRM_ACTION_CODES.target_not_found],
    [{ disposition: 'refuse', statusCode: 500, body: { error: 'audit insert failed' } }, MCP_CONFIRM_ACTION_CODES.apply_failed]
  ];
  for (const [applyOutcome, code] of cases) {
    const { deps } = makeDeps({ messages: { 'client-a/clchat-alpha-assistant-abc': messageWith([ANSWER]) }, applyOutcome });
    await assert.rejects(run(deps), (error) => {
      assert.equal(error.code, code);
      assert.equal(error.statusCode, applyOutcome.statusCode);
      assert.equal(error.message, applyOutcome.body.error);
      return true;
    });
  }
});

test('a `respond` disposition renders honestly: applied false, the reason, the ask status — never dressed as success', async () => {
  const { deps } = makeDeps({
    messages: { 'client-a/clchat-alpha-assistant-abc': messageWith([ANSWER]) },
    applyOutcome: { disposition: 'respond', statusCode: 409, body: { error: 'This question is already resolved.', action_type: 'answer_evidence_request', evidence_request_status: 'resolved' } }
  });
  const result = await run(deps);
  assert.equal(result.applied, false);
  assert.equal(result.outcome, 'not_applied');
  assert.equal(result.reason, 'This question is already resolved.');
  assert.equal(result.evidence_request_status, 'resolved');
  // The mileage shape.
  const { deps: d2 } = makeDeps({
    messages: { 'client-a/clchat-alpha-assistant-abc': messageWith([{ type: 'record_mileage', miles: 12, status: 'proposed' }]) },
    applyOutcome: { disposition: 'respond', statusCode: 409, body: { applied: false, action_type: 'record_mileage', status: 'needs_clarification', reason: 'missing_business_purpose', computation: { rate: 0.45 } } }
  });
  const mileage = await run(d2);
  assert.equal(mileage.applied, false);
  assert.equal(mileage.status, 'needs_clarification');
  assert.equal(mileage.reason, 'missing_business_purpose');
  assert.deepEqual(mileage.computation, { rate: 0.45 });
});

test('a replay returns the recorded result with replay: true — the owner confirmed already, here or in the portal', async () => {
  const applied = { ...ANSWER, status: 'applied', applied_at: '2026-09-15T09:00:00.000Z', result: { evidence_request_status: 'replied' } };
  const { deps } = makeDeps({
    messages: { 'client-a/clchat-alpha-assistant-abc': messageWith([applied]) },
    applyOutcome: { disposition: 'replay', statusCode: 200, body: {}, action: applied }
  });
  const result = await run(deps);
  assert.equal(result.applied, true);
  assert.equal(result.replay, true);
  assert.deepEqual(result.result, { evidence_request_status: 'replied' });
  assert.equal(result.applied_at, '2026-09-15T09:00:00.000Z');
});

test('the executor is dispatched with a surface or refuses — never a receipt-less door', async () => {
  const { deps, calls } = makeDeps({ messages: { 'client-a/clchat-alpha-assistant-abc': messageWith([ANSWER]) } });
  await rejectsWith(run(deps, undefined, { surface: null }), 'MCP_SURFACE_UNKNOWN', 500);
  assert.equal(calls.applies.length, 0);
});

test('K-mcp-1 on the act tier: the executor reaches the shared apply and nothing else (import pin)', () => {
  const source = readFileSync(resolvePath(here, 'mcpConfirmAction.js'), 'utf8');
  const imports = [...source.matchAll(/from '([^']+)'/g)].map((m) => m[1]).sort();
  assert.deepEqual(imports, [
    '../clientChatApply.js',
    '../clientPortalChat.js',
    '../clientSubscriptionDb.js',
    '../firmDb.js',
    '../stripeBilling.js',
    './mcpReadSurface.js'
  ]);
  // No writer, no spine primitive, no status writer reached directly: the
  // only mutation path is applyClientChatAction, which is the portal's.
  assert.doesNotMatch(source, /resolveClientEvidenceRequestInDb|recordOwnerMileageExpense|updateClientPortalChatActionStatusInDb/);
  assert.doesNotMatch(source, /gateChatApplyAction|executeChatApplyAction|auditChatApplyEvent/);
  assert.doesNotMatch(source, /ledgerPostingGateway|postJournal|proposalStore|setClientFlagStage|queryFirmDb|withFirmDbClient/);
  assert.match(source, /import \{ applyClientChatAction \} from '\.\.\/clientChatApply\.js'/);
  assert.match(source, /import \{ DEFAULT_FIRM_ID, getClientPortalChatMessageFromDb \} from '\.\.\/firmDb\.js'/, 'firmDb is imported for the firm id and the scoped message READ only');
});
