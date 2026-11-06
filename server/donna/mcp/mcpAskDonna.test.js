// MCP converse tier — ask_donna executor pins
// (docs/design-donna-chatgpt-app-build-brief.md §5 slice 2 tests).
//
// Load-bearing properties:
//   - the SAME engine as POST /client-chat: the real generateClientPortalChatReply
//     (with a fake model call) and the real sanitizer sit on this path — an
//     out-of-scope ask id and a non-grammar type never reach persistence;
//   - NO ACTION IS APPLIED: the module imports no apply spine, no resolver,
//     no ledger writer (source pin), and a poisoned dependency set proves the
//     turn touches only the chat-row writer;
//   - the persisted rows carry the actor, the surface and Donna's model id;
//     the tool result carries proposals with requires_confirmation:true and
//     the model id the funnel puts on the receipt;
//   - a blocked memory seam answers the controlled text WITHOUT a model call;
//     a model failure persists the system row and refuses with a coded 502;
//   - a request_report proposal runs the deterministic report and narrates it
//     (read-only), exactly as the portal route does.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve as resolvePath } from 'node:path';

import { generateClientPortalChatReply, generateClientPortalReportNarration } from '../clientPortalChat.js';
import { MCP_SURFACES, findMcpTool, receiptModelIdFor, resultMetaFor } from './mcpReadSurface.js';
import {
  MCP_ASK_DONNA_CONFIRM_VIA,
  MCP_ASK_DONNA_ENGINE_SURFACE,
  MCP_CONVERSE_TOOL_EXECUTORS,
  projectProposedActions,
  runAskDonna
} from './mcpAskDonna.js';

const here = dirname(fileURLToPath(import.meta.url));

process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'test-key';

// ── Harness ────────────────────────────────────────────────────────────────

const okAnthropicResponse = (input) => ({
  ok: true,
  json: async () => ({
    stop_reason: 'tool_use',
    content: [{ type: 'tool_use', name: 'submit_structured_reply', input }]
  })
});

const ACTION_BASE = {
  reason: 'r', evidence_request_id: null, reply_text: null, miles: null, date: null, purpose: null,
  confidence: null, report_type: null, period_start: null, period_end: null, basis: null
};

const ENTITIES = [{ id: 'client-a', name: 'Alpha Ltd', jurisdiction: 'GB', accounting_basis: null }];
const OWNER_AUTH = { type: 'supabase_user', userId: 'user-9', email: 'owner@example.test' };
const OWNER_ACCESS = { principal: { principalType: 'firm_collaborator', collaborator: { id: 'collab-7' } }, allowedClientIds: ['client-a'] };

const poison = (name) => async () => { throw new Error(`${name} must not be reached by ask_donna`); };

// A dependency set that records the chat rows and refuses everything a
// mutation would need. `modelReply` is what the fake model returns.
const makeDeps = ({ modelReply, assembled = {}, overrides = {} } = {}) => {
  const rows = [];
  const sidecars = [];
  const deps = {
    persistClientPortalTurnMessage: async (row) => {
      const persisted = { ...row, created_at: `2026-09-14T10:00:0${rows.length}.000Z` };
      rows.push(persisted);
      return persisted;
    },
    assembleClientPortalTurn: async ({ userMessageRow }) => ({
      context: { client: { name: 'Alpha Ltd', jurisdiction: 'GB' }, open_asks: [{ id: 'ask-1', question: 'What was the £184.20 Amazon charge?' }], today: '2026-09-14' },
      history: [{ role: 'user', content: userMessageRow.content }],
      validAskIds: ['ask-1'],
      assistantName: null,
      ownerMemory: null,
      memoryRetrievalSnapshot: { source_turn_id: userMessageRow.id },
      selfKnowledge: null,
      knowledgeGrounding: null,
      firmFacts: [],
      effectiveFirmId: 'firm-1',
      ...assembled
    }),
    // The REAL engine with a fake model call — the sanitizer is on the path.
    generateClientPortalChatReply: (args) => generateClientPortalChatReply({
      ...args,
      __callAnthropic: async () => okAnthropicResponse(modelReply)
    }),
    generateClientPortalReportNarration: poison('report narration'),
    getFinancialReportFromDb: poison('financial report'),
    assertClientEntitled: async () => {},
    isBillingEnabled: () => false,
    onOwnerMessagePersisted: async (input) => { sidecars.push(['intent', input]); return { status: 'skipped' }; },
    onOwnerTurnMemoryShadow: async (input) => { sidecars.push(['memory', input]); return { status: 'skipped' }; },
    withFirmDbClient: poison('withFirmDbClient'),
    now: () => new Date('2026-09-14T10:00:00.000Z'),
    warn: () => {},
    ...overrides
  };
  return { deps, rows, sidecars };
};

const run = (deps, args = { entity_id: 'client-a', message: 'The Amazon charge was a milk frother for the shop.' }) =>
  runAskDonna({ firmId: 'firm-1', auth: OWNER_AUTH, access: OWNER_ACCESS, entities: ENTITIES, args, surface: MCP_SURFACES.chatgpt_app, deps });

// ── The executor ───────────────────────────────────────────────────────────

test('the sanitizer on this path drops out-of-scope ask ids and non-grammar types; only the in-scope proposal persists and returns', async () => {
  const { deps, rows } = makeDeps({
    modelReply: {
      text: 'Got it, a milk frother for the shop. Confirm it in your Donna portal and I file the answer.',
      actions: [
        { ...ACTION_BASE, type: 'answer_evidence_request', evidence_request_id: 'ask-1', reply_text: 'A milk frother for the shop.' },
        { ...ACTION_BASE, type: 'answer_evidence_request', evidence_request_id: 'ask-someone-elses', reply_text: 'invented' },
        { ...ACTION_BASE, type: 'recategorize', reply_text: 'Office expenses' },
        { ...ACTION_BASE, type: 'share_portal_link' }
      ]
    }
  });
  const result = await run(deps);

  // Two rows: the owner's message and Donna's reply, both stamped with the
  // surface and the actor.
  assert.equal(rows.length, 2);
  assert.equal(rows[0].role, 'user');
  assert.equal(rows[0].actorType, 'client');
  assert.equal(rows[0].payload.actor_id, 'collab-7');
  assert.equal(rows[0].payload.surface, 'chatgpt_app');
  assert.equal(rows[1].role, 'assistant');
  assert.equal(rows[1].actorType, 'llm');
  assert.ok(rows[1].model, 'Donna’s model id rides the persisted reply');
  assert.deepEqual(rows[1].payload.actions.map((a) => [a.type, a.evidence_request_id]), [['answer_evidence_request', 'ask-1']],
    'the out-of-scope ask id and the non-grammar types never reach persistence');

  // The result: text, proposals with requires_confirmation, nothing applied.
  assert.equal(result.message_id, rows[1].id);
  assert.equal(result.user_message_id, rows[0].id);
  assert.equal(result.text, rows[1].content);
  assert.equal(result.applied, false);
  assert.deepEqual(result.confirm_via, MCP_ASK_DONNA_CONFIRM_VIA);
  assert.deepEqual(result.actions, [{
    index: 0,
    type: 'answer_evidence_request',
    summary: 'Answer Donna’s open question ask-1 with: “A milk frother for the shop.”',
    evidence_request_id: 'ask-1',
    requires_confirmation: true
  }]);
  assert.equal(result.model_id, rows[1].model, 'the model id the receipt records is the one the engine reported');
  assert.equal(receiptModelIdFor(findMcpTool('ask_donna'), result), rows[1].model);
});

test('the engine is called on the external-chat surface with the turn’s ask scope; the portal link is NOT armed unless the pack arms it', async () => {
  let engineArgs = null;
  const { deps } = makeDeps({
    modelReply: { text: 'Yes, it settled on 2 July.', actions: [] },
    overrides: {
      generateClientPortalChatReply: async (args) => { engineArgs = args; return { kind: 'ok', text: 'Yes, it settled on 2 July.', actions: [], model: 'claude-test-model' }; }
    }
  });
  let assembleArgs = null;
  const baseAssemble = deps.assembleClientPortalTurn;
  deps.assembleClientPortalTurn = async (args) => { assembleArgs = args; return baseAssemble(args); };
  const result = await run(deps, { entity_id: 'client-a', message: 'Is the Shopify invoice paid?' });
  assert.equal(engineArgs.surface, MCP_ASK_DONNA_ENGINE_SURFACE);
  assert.equal(engineArgs.allowPortalLink, false);
  // The self-knowledge pack is asked for the external-chat surface (slice 4 C),
  // with the MCP surface id as the channel.
  assert.equal(assembleArgs.surface, 'external_chat');
  assert.equal(assembleArgs.channel, 'chatgpt_app');
  assert.deepEqual(engineArgs.validAskIds, ['ask-1']);
  assert.equal(engineArgs.userMessage, 'Is the Shopify invoice paid?');
  assert.equal(engineArgs.history.length, 0, 'the history handed to the engine excludes the turn’s own user row');
  assert.deepEqual(result.actions, []);
  assert.equal(result.model_id, 'claude-test-model');
});

test('no action is applied: the poisoned dependency set is never reached and the sidecars run after the persisted answer', async () => {
  const { deps, rows, sidecars } = makeDeps({
    modelReply: {
      text: 'Confirm it in your Donna portal and I file it.',
      actions: [{ ...ACTION_BASE, type: 'record_mileage', miles: 120, date: '2026-09-10', purpose: 'Sacramento beekeeping conference', confidence: 'high' }]
    }
  });
  const result = await run(deps, { entity_id: 'client-a', message: 'I drove 120 miles to the Sacramento beekeeping conference on 10 Sept.' });
  assert.equal(result.actions.length, 1);
  assert.equal(result.actions[0].type, 'record_mileage');
  assert.match(result.actions[0].summary, /120 business miles on 2026-09-10 for Sacramento beekeeping conference/);
  assert.equal(result.actions[0].requires_confirmation, true);
  assert.equal(result.applied, false);
  // Only the chat-row writer was touched.
  assert.equal(rows.length, 2);
  assert.deepEqual(sidecars.map(([name]) => name), ['intent', 'memory']);
  assert.equal(sidecars[0][1].channel, 'chatgpt_app');
  assert.equal(sidecars[0][1].sourceMessageId, rows[0].id);
  assert.equal(sidecars[1][1].answer.messageId, rows[1].id);
  assert.equal(sidecars[1][1].answer.modelId, rows[1].model);
});

test('a blocked memory seam answers the controlled text with NO model call', async () => {
  const { deps, rows } = makeDeps({
    modelReply: { text: 'never', actions: [] },
    assembled: { ownerMemory: { shortCircuit: true } },
    overrides: { generateClientPortalChatReply: poison('the model') }
  });
  const result = await run(deps);
  assert.equal(rows.length, 2);
  assert.equal(rows[1].actorType, 'system');
  assert.equal(rows[1].payload.memory_status, 'blocked');
  assert.equal(result.memory_status, 'blocked');
  assert.equal(result.model_id, null);
  assert.deepEqual(result.actions, []);
  assert.match(result.text, /can't safely reach your saved details/);
});

test('a model failure persists the system row (with the model-id diagnostic) and refuses with a coded 502', async () => {
  const { deps, rows } = makeDeps({
    modelReply: { text: 'never', actions: [] },
    overrides: {
      generateClientPortalChatReply: async () => ({ kind: 'failed', code: 'anthropic_overloaded', reason: 'overloaded', diagnostic: { model: 'claude-test-model', stop_reason: 'end_turn' } })
    }
  });
  await assert.rejects(run(deps), (error) => {
    assert.equal(error.statusCode, 502);
    assert.equal(error.code, 'DONNA_CHAT_UNAVAILABLE');
    assert.match(error.message, /anthropic_overloaded/);
    return true;
  });
  assert.equal(rows.length, 2);
  assert.equal(rows[1].role, 'system');
  assert.equal(rows[1].payload.failure_code, 'anthropic_overloaded');
  assert.equal(rows[1].payload.diagnostic.model, 'claude-test-model');
  assert.match(rows[1].content, /model=claude-test-model/);
});

test('the billing backstop applies exactly as on the portal POST: an unentitled owner is refused before any row is written', async () => {
  const { deps, rows } = makeDeps({
    modelReply: { text: 'never', actions: [] },
    overrides: {
      isBillingEnabled: () => true,
      assertClientEntitled: async ({ principal, billingEnabled, clientId }) => {
        assert.equal(billingEnabled, true);
        assert.equal(clientId, 'client-a');
        assert.equal(principal.principalType, 'firm_collaborator');
        throw Object.assign(new Error('This plan is inactive. Start a plan to continue.'), { statusCode: 402, code: 'CLIENT_NOT_ENTITLED' });
      }
    }
  });
  await assert.rejects(run(deps), (error) => error.statusCode === 402 && error.code === 'CLIENT_NOT_ENTITLED');
  assert.equal(rows.length, 0);
});

test('a request_report proposal runs the deterministic report and narrates it — read-only, as the portal route', async () => {
  const reads = [];
  const { deps, rows } = makeDeps({
    modelReply: {
      text: 'Let me run that.',
      actions: [{ ...ACTION_BASE, type: 'request_report', report_type: 'pnl', period_start: '2026-09-01', period_end: '2026-09-30', basis: 'accrual' }]
    },
    overrides: {
      getFinancialReportFromDb: async (input) => { reads.push(input); return { period_start: '2026-09-01', period_end: '2026-09-30', basis: 'accrual', draft: true, profit_and_loss: { revenue: 1000, expenses: 400, net_income: 600, accounts: [] }, currency: { presentation: 'GBP' } }; },
      generateClientPortalReportNarration: (args) => generateClientPortalReportNarration({
        ...args,
        __callAnthropic: async () => okAnthropicResponse({ text: 'So far in September: revenue £1,000, expenses £400, net £600, draft.', actions: [] })
      })
    }
  });
  const result = await run(deps, { entity_id: 'client-a', message: 'How is September looking?' });
  assert.deepEqual(reads, [{ firmId: 'firm-1', clientId: 'client-a', periodStart: '2026-09-01', periodEnd: '2026-09-30', basis: 'accrual' }]);
  assert.equal(rows.length, 2);
  assert.equal(rows[1].role, 'assistant');
  assert.equal(rows[1].payload.report_request.report_type, 'pnl');
  assert.equal(rows[1].payload.report_request.requested_today, '2026-09-14');
  assert.equal(rows[1].payload.report_result.draft, true);
  assert.deepEqual(rows[1].payload.actions, []);
  assert.match(result.text, /revenue £1,000/);
  assert.deepEqual(result.actions, []);
});

test('an unexposed or unknown entity is refused as ENTITY_NOT_FOUND before any row is written', async () => {
  const { deps, rows } = makeDeps({ modelReply: { text: 'never', actions: [] } });
  await assert.rejects(run(deps, { entity_id: 'not-exposed', message: 'hi' }), (error) => error.statusCode === 404 && error.code === 'ENTITY_NOT_FOUND');
  assert.equal(rows.length, 0);
});

// ── Projection ─────────────────────────────────────────────────────────────

test('projectProposedActions keeps the persisted index and surfaces only the owner-appliable grammar', () => {
  const projected = projectProposedActions([
    { type: 'request_report', report_type: 'pnl' },
    { type: 'answer_evidence_request', evidence_request_id: 'ask-1', reply_text: '  income tax ' },
    { type: 'share_portal_link' },
    { type: 'record_mileage', miles: 42, purpose: 'client visit' }
  ]);
  assert.deepEqual(projected.map((a) => [a.index, a.type, a.requires_confirmation]), [[1, 'answer_evidence_request', true], [3, 'record_mileage', true]]);
  assert.equal(projected[0].summary, 'Answer Donna’s open question ask-1 with: “income tax”');
  assert.equal(projected[1].summary, 'Record 42 business miles for client visit, computed at the current mileage rate');
  assert.deepEqual(projectProposedActions(null), []);
});

// ── K-mcp-1: no path from this tool to an unstaged mutation ────────────────

test('the executor module imports no apply spine, no resolver and no ledger writer (K-mcp-1 on the converse tier)', () => {
  const source = readFileSync(resolvePath(here, 'mcpAskDonna.js'), 'utf8');
  const imports = [...source.matchAll(/from '([^']+)'/g)].map((m) => m[1]).sort();
  assert.deepEqual(imports, [
    '../clientPortalChat.js',
    '../clientPortalTurn.js',
    '../clientSubscriptionDb.js',
    '../db/close.js',
    '../firmDb.js',
    '../intentCompilerShadow.js',
    '../memoryRetrievalShadow.js',
    '../ownerActorAttribution.js',
    '../ownerMemorySeam.js',
    // Slice 4 D: the portal deep link — resolver, composer and the share
    // receipt (an audit row, not a book writer). Deliberate, not incidental.
    '../selfKnowledge.js',
    '../stripeBilling.js',
    './mcpReadSurface.js'
  ]);
  // The vocabulary an apply path would need — none of it may appear.
  assert.doesNotMatch(source, /chatApplySpine|gateChatApplyAction|executeChatApplyAction|auditChatApplyEvent/);
  assert.doesNotMatch(source, /resolveClientEvidenceRequestInDb|recordOwnerMileageExpense|updateClientPortalChatActionStatusInDb/);
  assert.doesNotMatch(source, /ledgerPostingGateway|postJournal|proposalStore|setClientFlagStage/);
  // The only writer named is the chat-row writer, by its seam name.
  assert.match(source, /persistClientPortalTurnMessage/);
  assert.doesNotMatch(source, /appendClientPortalChatMessageInDb/);
  // The named reads the executor is allowed: the report reader.
  assert.match(source, /import \{ getFinancialReportFromDb \} from '\.\.\/db\/close\.js'/);
});

test('confirm_via names BOTH doors: confirm_action right here (the two-call shape) and the portal’s Confirm card; nothing recorded until then', () => {
  assert.equal(MCP_ASK_DONNA_CONFIRM_VIA.tool, 'confirm_action');
  assert.match(MCP_ASK_DONNA_CONFIRM_VIA.tool_arguments, /message_id/);
  assert.match(MCP_ASK_DONNA_CONFIRM_VIA.tool_arguments, /action_index/);
  assert.match(MCP_ASK_DONNA_CONFIRM_VIA.also, /Confirm card/);
  assert.match(MCP_ASK_DONNA_CONFIRM_VIA.also, /Donna portal/);
  assert.match(MCP_ASK_DONNA_CONFIRM_VIA.note, /not applied by ask_donna/);
  assert.match(MCP_ASK_DONNA_CONFIRM_VIA.note, /confirm one right here/);
  assert.match(MCP_ASK_DONNA_CONFIRM_VIA.note, /call confirm_action with this message_id/);
  assert.match(MCP_ASK_DONNA_CONFIRM_VIA.note, /Nothing is recorded until they do/);
  assert.doesNotMatch(JSON.stringify(MCP_ASK_DONNA_CONFIRM_VIA), /[—–]/, 'no dashes in copy the model relays');
});

test('the converse executor map is exactly ask_donna', () => {
  assert.deepEqual(Object.keys(MCP_CONVERSE_TOOL_EXECUTORS), ['ask_donna']);
  assert.equal(MCP_CONVERSE_TOOL_EXECUTORS.ask_donna, runAskDonna);
});


// ── Slice 4 D: the portal deep link, narrow version ───────────────────────

const SHARE_ACTION = { ...ACTION_BASE, type: 'share_portal_link', reason: 'Owner asked where to upload the receipt.' };
const ARMED_PACK = {
  portal_link_enabled: true,
  receipt: { self_knowledge_version: 'self-knowledge-pack.v1', self_knowledge_fingerprint: 'selfknow-x', config_snapshot_id: 'cfg-x', portal_link_enabled: true }
};

test('portal link, armed by the pack: the REAL link is resolved by the runtime and appended to the reply text; the share is receipted with this surface as the channel; nothing is applied and no confirmable action is returned', async () => {
  let engineArgs = null;
  const shares = [];
  const { deps, rows } = makeDeps({
    modelReply: { text: 'Upload the receipt in your Donna portal, here is the link.', actions: [SHARE_ACTION] },
    assembled: { selfKnowledge: ARMED_PACK },
    overrides: {
      env: { PUBLIC_APP_URL: 'https://app.donna.test' },
      recordOwnerPortalLinkShare: async (input) => { shares.push(input); }
    }
  });
  const baseEngine = deps.generateClientPortalChatReply;
  deps.generateClientPortalChatReply = async (args) => { engineArgs = args; return baseEngine(args); };
  const result = await run(deps, { entity_id: 'client-a', message: 'Where do I send the receipt?' });
  assert.equal(engineArgs.allowPortalLink, true, 'the pack arms the sanitizer');
  assert.equal(result.text, 'Upload the receipt in your Donna portal, here is the link.\nhttps://app.donna.test/client/client-a#list');
  assert.deepEqual(result.portal_link, { status: 'sent', path: '/client/client-a#list', url: 'https://app.donna.test/client/client-a#list' });
  assert.deepEqual(result.actions, [], 'share_portal_link is never a confirmable action');
  assert.equal(result.applied, false);
  // The persisted reply carries the link text and the link receipt.
  assert.equal(rows[1].content, result.text);
  assert.equal(rows[1].payload.portal_link.status, 'sent');
  assert.deepEqual(rows[1].payload.actions.map((a) => a.type), ['share_portal_link']);
  // The share is audited: owner actor, this surface as the channel, the pack version.
  assert.equal(shares.length, 1);
  assert.equal(shares[0].channel, 'chatgpt_app');
  assert.equal(shares[0].actorType, 'client');
  assert.equal(shares[0].actorId, 'collab-7');
  assert.equal(shares[0].status, 'sent');
  assert.equal(shares[0].linkPath, '/client/client-a#list');
  assert.equal(shares[0].selfKnowledgeVersion, 'self-knowledge-pack.v1');
  // The receipt meta records the share as a status flag only (never the URL).
  const meta = resultMetaFor('ask_donna', result);
  assert.equal(meta.portal_link, 'sent');
  assert.doesNotMatch(JSON.stringify(meta), /app\.donna\.test/);
});

test('portal link with no base URL configured: the honest named instruction, never a dead link; the degrade is receipted', async () => {
  const shares = [];
  const { deps } = makeDeps({
    modelReply: { text: 'Here is the link.', actions: [SHARE_ACTION] },
    assembled: { selfKnowledge: ARMED_PACK },
    overrides: { env: {}, recordOwnerPortalLinkShare: async (input) => { shares.push(input); } }
  });
  const result = await run(deps, { entity_id: 'client-a', message: 'Send me the portal link' });
  assert.match(result.text, /portal web address isn't configured on my side yet/);
  assert.match(result.text, /What I still need from you/);
  assert.doesNotMatch(result.text, /https?:\/\//);
  assert.equal(result.portal_link.status, 'no_base_url');
  assert.equal(shares[0].status, 'no_base_url');
});

test('portal link NOT armed: a model emission of share_portal_link is sanitized out; no link, no share receipt, text untouched (the pre-slice-4 behaviour)', async () => {
  const shares = [];
  for (const selfKnowledge of [null, { portal_link_enabled: false, receipt: {} }]) {
    const { deps, rows } = makeDeps({
      modelReply: { text: 'Upload it in your Donna portal.', actions: [SHARE_ACTION] },
      assembled: { selfKnowledge },
      overrides: { env: { PUBLIC_APP_URL: 'https://app.donna.test' }, recordOwnerPortalLinkShare: async (input) => { shares.push(input); } }
    });
    const result = await run(deps, { entity_id: 'client-a', message: 'Where do I upload?' });
    assert.equal(result.text, 'Upload it in your Donna portal.');
    assert.ok(!('portal_link' in result));
    assert.deepEqual(rows[1].payload.actions, []);
    assert.ok(!('portal_link' in rows[1].payload));
  }
  assert.equal(shares.length, 0);
});

test('portal link share receipt failure is named on the row, never hidden, and the reply still carries the real link', async () => {
  const { deps, rows } = makeDeps({
    modelReply: { text: 'Here you go.', actions: [SHARE_ACTION] },
    assembled: { selfKnowledge: ARMED_PACK },
    overrides: { env: { PUBLIC_APP_URL: 'https://app.donna.test' }, recordOwnerPortalLinkShare: async () => { throw new Error('audit down'); } }
  });
  const result = await run(deps, { entity_id: 'client-a', message: 'link please' });
  assert.match(result.text, /https:\/\/app\.donna\.test\/client\/client-a#list$/);
  assert.equal(rows[1].payload.portal_link.audit, 'failed');
  assert.equal(result.portal_link.status, 'sent');
});
