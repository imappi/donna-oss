import test from 'node:test';
import assert from 'node:assert/strict';
import { nativeBirthDefinition } from './nativeChartLineage.js';
import { nativeAccountChoices, accountChoicePrompt, resolveNativeAccountChoice, decodeNativeCodingChoice, assertNativeCodingChoice, nativeCodingPromptProjection } from './codingAccountChoices.js';
import { resolveCodingPolicy, codingPolicyReceipt, requireCodingPolicyForClient } from './codingPolicy.js';
import { suggestTransactionCoding, suggestTransactionCodingBatch, accountOptionsForClient } from './transactionLlm.js';
import { buildTransactionChatContext, generateTransactionChatReply } from './transactionChat.js';

const definition = nativeBirthDefinition('sg_pte_native.v1');
const context = { contract_id: definition.contract_id, client_life: { firm_id: 'test-firm', client_id: 'test-client', created_at: '2026-09-01', after_delete_id: '0' },
  receipt_id: '1', receipt_digest: 'birth-receipt', selection_digest: definition.selection_digest,
  menu_contract_version: definition.menu_contract_version, birth_registration_digest: 'birth-registration',
  registration_observation: { revision: 'profile.gst_registration.observation.v1', record: null } };
const policy = resolveCodingPolicy({ jurisdiction: 'sg', entityType: 'sg-pte', accountingSystem: 'none', nativeChart: context });
const profile = { jurisdiction: 'sg', entityType: 'sg-pte', accountingSystem: 'none', codingPolicy: policy };
const menu = nativeAccountChoices(context);
const transaction = { id: 'test-transaction', date: '2026-09-01', description: 'Office rent September', money_out: 500, currency: 'SGD' };
const choice = code => menu.choices.find(row => row.code === code);
const raw = code => ({ proposed_account: choice(code).handle, posting_requirement: 'single_account', document_allocations: [],
  tax_treatment: 'No GST', confidence: 'high', evidence_required: false, reasoning: 'Supported by supplied evidence.', alternatives: [] });
const transport = { provider: 'openai_compatible', endpoint: { url: 'http://fixture.invalid/v1/chat/completions', headers: { authorization: 'Bearer fixture-key' } }, model: 'fixture-provider' };

test('native batch and feed registration projections use each operation date and keep source identity private', () => {
  const dated = nativeAccountChoices({ ...context, registration_evidence: {
    registration: { status: 'registered', registered_from: '2026-09-01', registered_until: '2026-09-30',
      verified_from: 'Synthetic notification', verified_at: '2026-09-01', source_document_id: 'private-document-id' },
    revision: { revision_digest: 'verified-revision' }, source_current: true
  } });
  for (const key of ['transactions', 'feed_rows']) {
    const projected = nativeCodingPromptProjection({ [key]: [
      { id: 'before', date: '2026-08-31' }, { id: 'within', transaction_date: '2026-09-01' }, { id: 'undated' }
    ] }, dated);
    assert.equal(projected.native_registration_by_transaction.before.reason, 'before_recorded_interval');
    assert.equal(projected.native_registration_by_transaction.within.status, 'registered');
    assert.equal(projected.native_registration_by_transaction.undated.reason, 'business_date_missing');
    assert.equal(projected.native_registration_by_transaction.within.source_document_recorded, true);
    assert.equal(projected.native_registration_by_transaction.within.tax_authority, false);
    assert.doesNotMatch(JSON.stringify(projected), /private-document-id/);
  }
});

test('one full native menu excludes only reservations and keeps a nonposting choice', () => {
  assert.equal(menu.choices.length, 53);
  assert.equal(menu.choices.filter(row => row.kind === 'account').length, 52);
  const names = accountOptionsForClient([{ name: 'Owner drawings' }, { name: 'Suspense' }], profile);
  assert.equal(names.length, 53);
  for (const name of ['Owner drawings', 'Share premium', 'Suspense', 'Rent']) assert.ok(!names.includes(name));
  assert.equal(requireCodingPolicyForClient({ ...profile, codingPolicy: codingPolicyReceipt(policy) }).policyId, 'sg_native_coding');
  assert.equal(resolveCodingPolicy({ jurisdiction: 'sg' }).policyId, 'sg_legacy_coding');
  assert.equal(resolveNativeAccountChoice(menu, { name: 'Rent' }, { allowAlias: true }).code, '7000');
  assert.equal(resolveNativeAccountChoice(menu, { name: 'Travel' }, { allowAlias: true }).code, '7300');
  assert.equal(resolveNativeAccountChoice(menu, { name: 'Marketing' }, { allowAlias: true }).code, '7600');
  assert.equal(choice('3100').name, 'Sales');
  assert.equal(choice('2940').account_type, 'liability');
  assert.ok(choice('5300'));
  for (const row of menu.choices.filter(row => row.id)) assert.ok(!JSON.stringify(accountChoicePrompt(menu)).includes(row.id));
});

test('identity disagreements, stale receipts, reserved accounts and sentinel cannot apply', () => {
  const decoded = decodeNativeCodingChoice(menu, raw('7000'));
  assert.equal(decoded.account_id, choice('7000').id);
  assertNativeCodingChoice(menu, decoded, { applying: true });
  for (const patch of [{ account_id: choice('3100').id }, { account_code: '3100' }, { proposed_account: 'Sales' }, { account_name: 'Sales' }, { category: 'Sales' }, { code: '3100' }, { id: 'foreign-account' }, { xero_account_id: choice('3100').id }, { xero_account_code: '3100' }, { xero_account_name: 'Sales' }, { label: 'Sales' }, { account_label: '3100 · Sales' }, { native_choice: null }]) {
    assert.throws(() => assertNativeCodingChoice(menu, { ...decoded, ...patch }, { applying: true }), { code: 'NATIVE_CODING_CHOICE_INVALID' });
  }
  for (const input of [{ name: 'Suspense' }, { code: '2950' }, { name: 'A missing account' }, { handle: 'unresolved' }]) {
    assert.throws(() => resolveNativeAccountChoice(menu, input), { code: 'NATIVE_CODING_CHOICE_INVALID' });
  }
  for (const label of [choice('7000').name, `7000 · ${choice('7000').name}`]) {
    assert.equal(resolveNativeAccountChoice(menu, { label }).id, choice('7000').id);
    assertNativeCodingChoice(menu, { ...decoded, xero_account_id: choice('7000').id, xero_account_code: '7000', xero_account_name: choice('7000').name, account_label: label }, { applying: true });
  }
  const unresolved = decodeNativeCodingChoice(menu, { proposed_account: 'unresolved', posting_requirement: 'owner_fact', ask_client_question: 'What was this payment for?' });
  assert.equal(unresolved.native_choice.kind, 'unresolved');
  assert.equal(unresolved.account_id, undefined);
  assertNativeCodingChoice(menu, unresolved);
  assert.throws(() => assertNativeCodingChoice(menu, unresolved, { applying: true }), { code: 'NATIVE_CODING_CHOICE_INVALID' });
  assert.throws(() => decodeNativeCodingChoice(menu, { ...raw('7000'), missing_account_name: 'Unsupported expense' }), { code: 'NATIVE_CODING_CHOICE_INVALID' });
});

test('actual compatible single/batch schemas use the same handles and decode exact identity', async () => {
  const requests = [];
  const fetchImpl = async (_url, options) => {
    const body = JSON.parse(options.body); requests.push(body);
    const batch = body.messages[0].content.includes('transaction_coding_batch_suggestion');
    const result = batch ? { suggestions: [{ transaction_id: transaction.id, ...raw('3100') }], group_summary: [] } : raw('7000');
    return new Response(JSON.stringify({ model: 'fixture-provider', choices: [{ message: { content: JSON.stringify(result) } }] }), { status: 200 });
  };
  const single = await suggestTransactionCoding({ clientProfile: profile, transaction, transport, fetchImpl });
  assert.equal(single.account_code, '7000');
  const batch = await suggestTransactionCodingBatch({ clientProfile: profile, transactions: [transaction], transport, fetchImpl });
  assert.equal(batch.suggestions[0].account_code, '3100');
  for (const request of requests) {
    assert.match(JSON.stringify(request), /account_choices/);
    for (const row of menu.choices.filter(row => row.id)) assert.ok(!JSON.stringify(request).includes(row.id));
    assert.doesNotMatch(JSON.stringify(request), /account is created in the chart on first posting/);
  }
  assert.equal(requests.length, 2);
});

test('native chat excludes shortcuts without an identity consumer, while retaining exact coding actions', async () => {
  const context = buildTransactionChatContext({ clientProfile: profile, transaction, accountOptions: policy.accountOptions });
  context.native_coding_sources = { [transaction.id]: { transaction_id: transaction.id, firm_id: 'test-firm', client_id: 'test-client' } };
  for (const type of ['remember_merchant', 'mark_personal', 'apply_category']) {
    const reply = await generateTransactionChatReply({ context, userMessage: 'Record this treatment.',
      __config: { apiKey: 'fixture', model: 'fixture-provider' }, __callAnthropic: async ({ tool }) => {
        const schema = tool.input_schema.properties.actions.items.properties;
        assert.ok(!schema.type.enum.includes('remember_merchant'));
        assert.ok(!schema.type.enum.includes('mark_personal'));
        assert.ok(schema.account_name.enum.includes(choice('7000').handle));
        return { ok: true, json: async () => ({ stop_reason: 'tool_use', content: [{ type: 'tool_use', name: 'submit_structured_reply',
          input: { text: 'Treatment proposed.', actions: [{ type, account_name: choice('7000').handle, account_code: '7000', tax_treatment: 'No GST', merchant_pattern: 'Office rent', note: 'Fixture' }] } }] }) };
      } });
    assert.equal(reply.kind, type === 'apply_category' ? 'ok' : 'failed', JSON.stringify(reply));
  }
});


test('actual native Jev typed/components and strong fallback share the identity map', async () => {
  const saved = Object.fromEntries(['TYPESAFE_API_KEY','TYPESAFE_MODEL','OPENAI_API_KEY'].map(key => [key, process.env[key]]));
  Object.assign(process.env, { TYPESAFE_API_KEY: 'fixture-key', TYPESAFE_MODEL: 'fixture-provider', OPENAI_API_KEY: 'fixture-key' });
  const captures = [];
  try {
    for (const mode of ['typed', 'components', 'fallback', 'unresolved']) {
      const fetchImpl = async (url, init) => {
        const request = JSON.parse(init.body); captures.push(request);
        if (String(url).includes('typesafe')) {
          const answers = Object.fromEntries(Object.entries(request.questions).map(([key, question]) => {
            const keys = Object.keys(question.criteria);
            const selected = key === 'decision'
              ? mode === 'fallback' ? 'reasoning_judgment' : mode === 'unresolved' ? 'ask_business_use'
                : keys.includes('resolved') ? 'resolved' : keys.find(k => question.criteria[k].includes(`to ${choice('7000').name}, tax treatment No GST;`))
              : key === 'account' ? choice('7000').handle : key === 'tax' ? keys.find(k => question.criteria[k] === 'No GST')
                : key === 'materiality' ? 'normal' : keys[0];
            assert.ok(keys.includes(selected), `${mode}/${key}/${selected}`);
            return [key, { type: 'choice', choice: selected, confidence: 0.8,
              probabilities: Object.fromEntries(keys.map(k => [k, k === selected ? 0.8 : 0.2 / (keys.length - 1)])) }];
          }));
          return new Response(JSON.stringify({ model: 'fixture-provider', usage: { input_tokens: 10, output_tokens: 5 }, answers }));
        }
        return new Response(JSON.stringify({ output_text: JSON.stringify(raw('7000')) }));
      };
      const tx = { ...transaction,
        correction_context: { current_posting: [{ account_id: choice('7000').id, account_code: '7000', account_name: choice('7000').name }] },
        ...(mode === 'components' ? { case_evidence: { fixture_context: 'source detail '.repeat(9000) } } : {}) };
      const result = await suggestTransactionCoding({ clientProfile: profile, transaction: tx, jevEnabled: true, fetchImpl });
      assert.equal(result.provider_failure, undefined, `${mode}: ${JSON.stringify(result)}`);
      assert.equal(result.native_choice.kind, mode === 'unresolved' ? 'unresolved' : 'account');
      if (mode !== 'unresolved') assert.equal(result.account_id, choice('7000').id);
      if (mode === 'components') assert.equal(result.jev_decision.choice_mode, 'account_tax_components');
      if (mode === 'fallback') assert.equal(result.decision_engine, 'strong_after_jev');
      if (mode === 'unresolved') {
        assert.equal(result.posting_requirement, 'owner_fact'); assert.equal(result.jev_decision.terminal, 'ask_owner');
      }
    }
    for (const request of captures) for (const row of menu.choices.filter(row => row.id)) assert.ok(!JSON.stringify(request).includes(row.id));
  } finally {
    for (const [key, value] of Object.entries(saved)) if (value == null) delete process.env[key]; else process.env[key] = value;
  }
});
