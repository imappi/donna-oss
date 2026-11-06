import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveCodingPolicy, codingPolicyReceipt } from './codingPolicy.js';
import { buildTransactionChatContext, generateTransactionChatReply, __SYSTEM_PROMPT } from './transactionChat.js';
import { buildFeedChatContext, generateFeedChatReply, __FEED_CHAT_SYSTEM_PROMPT } from './feedChat.js';

const tx = { id: 'tx-policy-chat', date: '2026-08-01', description: 'BANK FEE', money_out: 10 };
const response = (actions) => ({ ok: true, json: async () => ({ stop_reason: 'tool_use', content: [{ type: 'tool_use', name: 'submit_structured_reply', input: { text: 'Proposed coding.', actions } }] }) });

test('chat diagnostics never acquire a default country menu and explicit overrides cannot smuggle foreign tax', () => {
  assert.equal(buildFeedChatContext({}).tax_treatment_options, null);
  assert.equal(buildTransactionChatContext({ transaction: tx }).tax_treatment_options, null);
  for (const build of [(args) => buildFeedChatContext(args), (args) => buildTransactionChatContext({ transaction: tx, ...args })]) {
    assert.throws(() => build({ clientProfile: {} }), { code: 'jurisdiction_unresolved' });
    assert.throws(() => build({ clientProfile: { jurisdiction: 'zz' } }), { code: 'jurisdiction_unsupported' });
    assert.throws(() => build({ clientProfile: { jurisdiction: 'ae' }, taxTreatmentOptions: ['No GST'] }), { code: 'jurisdiction_context_conflict' });
  }
  for (const prompt of [__SYSTEM_PROMPT, __FEED_CHAT_SYSTEM_PROMPT]) {
    assert.doesNotMatch(prompt, /otherwise prefer "No GST"/);
    assert.match(prompt, /coding_policy.tax_uncertainty_treatment/);
  }
});

test('six-country chat requests carry exact policy guidance and runtime-owned date-bound action receipts', async (t) => {
  const key = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = 'test-key';
  t.after(() => { if (key === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = key; });
  for (const jurisdiction of ['sg', 'fi', 'gb', 'ae', 'us', 'au']) {
    const clientProfile = { jurisdiction, entity_type: jurisdiction === 'gb' ? 'gb-ltd' : null,
      accounting_system: 'none', tax_profile: { registration_status: 'unknown' } };
    const policy = resolveCodingPolicy({ jurisdiction, entityType: clientProfile.entity_type, accountingSystem: 'none', taxProfile: clientProfile.tax_profile, businessDate: tx.date });
    const transactionContext = buildTransactionChatContext({ clientProfile, transaction: tx, accountOptions: policy.accountOptions });
    const next = { ...tx, id: 'tx-next', date: '2026-07-31' };
    const feedContext = buildFeedChatContext({ clientProfile, feedRows: [tx, next], accountOptions: policy.accountOptions });
    for (const context of [transactionContext, feedContext]) {
      assert.deepEqual(context.tax_treatment_options, policy.taxTreatmentOptions);
      assert.equal(context.coding_policy.tax_instructions, policy.taxInstructions);
      assert.equal(context.coding_policy.tax_uncertainty_treatment, policy.uncertainTaxTreatment);
    }
    const captured = [];
    const single = await generateTransactionChatReply({ context: transactionContext, userMessage: 'Code this line',
      __callAnthropic: async (args) => { captured.push(args); return response([{ type: 'apply_category', account_name: policy.accountOptions[0], tax_treatment: policy.taxTreatmentOptions[0], coding_policy: { jurisdiction: 'forged' } }]); } });
    const feed = await generateFeedChatReply({ context: feedContext, userMessage: 'Code these lines', validTransactionIds: [tx.id, next.id],
      __callAnthropic: async (args) => { captured.push(args); return response([{ type: 'apply_category', transaction_ids: [tx.id, next.id], account_name: policy.accountOptions[0], tax_treatment: policy.taxTreatmentOptions[0], coding_policy_by_transaction: { [tx.id]: { jurisdiction: 'forged' } } }]); } });
    assert.equal(single.kind, 'ok');
    assert.equal(feed.kind, 'ok');
    assert.deepEqual(single.actions[0].coding_policy, codingPolicyReceipt(policy));
    assert.equal(feed.actions[0].coding_policy_by_transaction[tx.id].businessDate, tx.date);
    assert.equal(feed.actions[0].coding_policy_by_transaction[next.id].businessDate, next.date);
    assert.equal(feed.actions[0].coding_policy_by_transaction[tx.id].jurisdiction, jurisdiction);
    for (const args of captured) {
      const wireContext = JSON.parse(args.messages[0].content.slice(args.messages[0].content.indexOf('\n') + 1));
      assert.equal(wireContext.coding_policy.tax_instructions, policy.taxInstructions);
      assert.deepEqual(wireContext.tax_treatment_options, policy.taxTreatmentOptions);
      assert.doesNotMatch(args.system, /otherwise prefer "No GST"/);
    }
  }
});

test('a diagnostic-only model reply cannot mint an accounting action without policy context', async () => {
  await assert.rejects(generateTransactionChatReply({ context: buildTransactionChatContext({ transaction: tx }), userMessage: 'Code this',
    __config: { apiKey: 'test-key', model: 'test-model' },
    __callAnthropic: async () => response([{ type: 'apply_category', account_name: 'Sales' }]) }), { code: 'jurisdiction_context_conflict' });
});
