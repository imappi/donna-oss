import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveCodingPolicy, requireCodingPolicyForClient, codingPolicyReceipt,
  assertCodingPolicyReceipt, CodingPolicyError, isCodingPolicyError, CODING_POLICY_REGISTRY } from './codingPolicy.js';
import { suggestTransactionCoding, suggestTransactionCodingBatch,
  makeDeterministicTransactionSuggestion, taxTreatmentOptionsForClient,
  fallbackAccountOptionsForClient, accountOptionsForClient, suspenseAccountNameForClient } from './transactionLlm.js';

const transaction = { id: 'tx-policy', date: '2026-08-01', description: 'BANK FEE', money_out: 10 };
const expected = { sg: 'GST 9%', fi: 'ALV 25,5 %', gb: 'VAT 20%', ae: 'VAT 5% (standard rated)', us: 'No sales tax', au: 'GST 10%' };

test('all six authored jurisdictions resolve explicitly and keep tax registration unknown', () => {
  for (const jurisdiction of Object.keys(expected)) {
    const policy = resolveCodingPolicy({ jurisdiction, businessDate: transaction.date });
    assert.equal(policy.status, 'resolved');
    assert.equal(policy.jurisdiction, jurisdiction);
    assert.ok(policy.taxTreatmentOptions.includes(expected[jurisdiction]));
    assert.equal(policy.taxProfile, null);
    assert.ok(policy.accountOptions.includes(policy.suspenseAccountName));
    assert.ok(Object.isFrozen(policy));
    if (jurisdiction !== 'sg') {
      assert.ok(!policy.accountOptions.includes('CPF payable'));
      assert.doesNotMatch(policy.taxInstructions, /This client is .*registered business|otherwise prefer No GST/);
    }
  }
});

test('missing, unsupported, conflicting and unavailable contexts have distinct typed failures', () => {
  const cases = [
    [{}, 'jurisdiction_unresolved'], [{ jurisdiction: 'unknown' }, 'jurisdiction_unresolved'],
    [{ jurisdiction: 'zz' }, 'jurisdiction_unsupported'],
    [{ jurisdiction: 'zz', entityType: 'zz-company', profileEntityType: 'zz-partnership' }, 'jurisdiction_unsupported'],
    [{ jurisdiction: 'zz', profileJurisdiction: 'gb', entityType: 'gb-ltd' }, 'jurisdiction_unsupported'],
    [{ jurisdiction: 'gb', profileJurisdiction: 'sg' }, 'jurisdiction_context_conflict'],
    [{ jurisdiction: 'gb', entityType: 'gb-ltd', profileEntityType: 'gb-sole-trader' }, 'jurisdiction_context_conflict'],
    [{ jurisdiction: 'gb', entityType: 'sg-pte-ltd' }, 'jurisdiction_context_conflict'],
    [{ jurisdiction: 'sg', businessDate: '2026-02-30' }, 'coding_policy_invalid'],
    [{ jurisdiction: 'sg', businessDate: '2026-01-01not-a-date' }, 'coding_policy_invalid'],
    [{ jurisdiction: 'sg', businessDate: new Date(NaN) }, 'coding_policy_invalid']
  ];
  for (const [context, code] of cases) assert.throws(() => resolveCodingPolicy(context), (e) => isCodingPolicyError(e) && e.code === code);
  assert.throws(() => resolveCodingPolicy({ jurisdiction: 'sg' }, { registry: { sg: () => { throw new Error('secret'); } } }),
    (e) => e.code === 'coding_policy_unavailable' && !e.message.includes('secret'));
  assert.throws(() => resolveCodingPolicy({ jurisdiction: 'sg' }, { registry: { sg: {} } }), { code: 'coding_policy_invalid' });
  assert.equal(resolveCodingPolicy({ jurisdiction: ' UK ', profileJurisdiction: 'gb' }).jurisdiction, 'gb');
});

test('new country and dated policy register without edits to shared resolution', () => {
  const definition = { id: 'zz_fixture', version: 3, jurisdiction: 'zz',
    accountOptions: ['Fixture expense', 'Unclassified'], suspenseAccountName: 'Unclassified',
    taxTreatmentOptions: ['Fixture treatment', 'Uncertain'], defaultTaxTreatment: 'Uncertain',
    outOfScopeTaxTreatment: 'Fixture treatment', taxInstructions: 'Fixture instructions.',
    effectiveFrom: '2025-01-01', effectiveTo: '2025-12-31' };
  const registry = { ...CODING_POLICY_REGISTRY, zz: definition };
  const policy = resolveCodingPolicy({ jurisdiction: 'zz', businessDate: '2025-07-01' }, { registry });
  assert.equal(policy.policyId, 'zz_fixture');
  assert.equal(policy.businessDate, '2025-07-01');
  const timestampInterval = { ...registry, zz: { ...definition, effectiveFrom: '2025-01-01T00:00:00Z' } };
  const firstDay = resolveCodingPolicy({ jurisdiction: 'zz', businessDate: '2025-01-01' }, { registry: timestampInterval });
  assert.equal(firstDay.effectiveFrom, '2025-01-01');
  assert.throws(() => resolveCodingPolicy({ jurisdiction: 'zz' }, { registry }), { code: 'coding_policy_invalid' });
  assert.throws(() => resolveCodingPolicy({ jurisdiction: 'zz', businessDate: '2026-01-01' }, { registry }), { code: 'coding_policy_unavailable' });
});

test('stamps cannot replace registered code or cross jurisdiction, entity, date or version', () => {
  const profile = { jurisdiction: 'gb', entityType: 'gb-ltd' };
  const policy = resolveCodingPolicy({ ...profile, businessDate: transaction.date });
  const stamp = { ...policy, taxTreatmentOptions: ['GST 9%'] };
  assert.ok(!requireCodingPolicyForClient({ ...profile, codingPolicy: stamp }).taxTreatmentOptions.includes('GST 9%'));
  for (const edit of [{ jurisdiction: 'sg' }, { policyVersion: 99 }, { entityType: 'gb-sole-trader' }]) {
    assert.throws(() => requireCodingPolicyForClient({ ...profile, codingPolicy: { ...policy, ...edit } }), { code: 'jurisdiction_context_conflict' });
  }
  assert.throws(() => requireCodingPolicyForClient({ ...profile, codingPolicy: policy }, { businessDate: '2026-08-02' }), { code: 'jurisdiction_context_conflict' });
  assert.equal(assertCodingPolicyReceipt(policy, codingPolicyReceipt(policy)), policy);
  assert.throws(() => assertCodingPolicyReceipt(policy, { ...codingPolicyReceipt(policy), policyVersion: 2 }), { code: 'jurisdiction_context_conflict' });
});

test('actual coding/menu/fallback entry points refuse unresolved context before any network', async (t) => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; throw new Error('network forbidden'); });
  for (const profile of [{}, { taxVocabulary: 'gb_vat' }, { accountPalette: 'fi' }, { jurisdiction: 'zz' }]) {
    for (const helper of [taxTreatmentOptionsForClient, fallbackAccountOptionsForClient, suspenseAccountNameForClient]) {
      assert.throws(() => helper(profile), CodingPolicyError);
    }
    assert.throws(() => accountOptionsForClient([{ name: 'Sales' }], profile), CodingPolicyError);
    assert.throws(() => makeDeterministicTransactionSuggestion({ clientProfile: profile, transaction }), CodingPolicyError);
    await assert.rejects(suggestTransactionCoding({ clientProfile: profile, transaction }), CodingPolicyError);
    await assert.rejects(suggestTransactionCodingBatch({ clientProfile: profile, transactions: [transaction] }), CodingPolicyError);
  }
  assert.equal(calls, 0);
});

test('real single/batch requests and invalid-provider fallbacks use one explicit policy per transaction', async (t) => {
  const key = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'test-key';
  t.after(() => { if (key === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = key; });
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    assert.equal(url, 'https://api.openai.com/v1/responses');
    const body = JSON.parse(init.body); calls.push(body);
    const input = JSON.parse(body.input);
    const invalid = { proposed_account: 'Foreign account', tax_treatment: 'Foreign tax', confidence: 'low' };
    return { ok: true, json: async () => ({ output_text: JSON.stringify(input.transactions
      ? { suggestions: input.transactions.map((tx) => ({ ...invalid, transaction_id: tx.id })), group_summary: [] } : invalid) }) };
  });
  for (const jurisdiction of Object.keys(expected)) {
    const clientProfile = { jurisdiction };
    const policy = resolveCodingPolicy({ jurisdiction });
    const single = await suggestTransactionCoding({ clientProfile, transaction });
    const second = { ...transaction, id: 'tx-second', date: '2026-07-31' };
    const batch = await suggestTransactionCodingBatch({ clientProfile, transactions: [transaction, second] });
    for (const suggestion of [single, ...batch.suggestions]) {
      assert.ok(policy.taxTreatmentOptions.includes(suggestion.tax_treatment));
      assert.equal(suggestion.coding_policy.jurisdiction, jurisdiction);
    }
    assert.equal(batch.suggestions[0].coding_policy.businessDate, transaction.date);
    assert.equal(batch.suggestions[1].coding_policy.businessDate, second.date);
    for (const request of calls.splice(0)) {
      const properties = request.text.format.schema.properties.suggestions?.items.properties || request.text.format.schema.properties;
      assert.deepEqual(properties.tax_treatment.enum, policy.taxTreatmentOptions);
      assert.ok(request.instructions.includes(policy.taxInstructions));
      if (jurisdiction !== 'sg') assert.doesNotMatch(request.instructions, /otherwise prefer No GST/);
    }
  }
});

test('lineage binds entity, connector and tax-profile context without storing private tax details in the receipt', () => {
  const context = { jurisdiction: 'gb', entityType: 'gb-ltd', accountingSystem: 'xero', businessDate: '2026-08-01',
    taxProfile: { registered: true, number: 'private-registration', scheme: { type: 'standard', period: 'quarterly' } } };
  const policy = resolveCodingPolicy(context);
  const receipt = codingPolicyReceipt(policy);
  assert.equal(receipt.entityType, 'gb-ltd');
  assert.equal(receipt.accountingSystem, 'xero');
  assert.match(receipt.taxProfileDigest, /^[a-f0-9]{64}$/);
  assert.ok(!JSON.stringify(receipt).includes('private-registration'));
  const reordered = resolveCodingPolicy({ ...context, taxProfile: { scheme: { period: 'quarterly', type: 'standard' }, number: 'private-registration', registered: true } });
  assert.equal(assertCodingPolicyReceipt(reordered, receipt), reordered, 'JSON property order is not a policy change');
  for (const changed of [{ entityType: 'gb-sole-trader' }, { accountingSystem: 'donna' }, { taxProfile: { registered: false } }]) {
    assert.throws(() => assertCodingPolicyReceipt(resolveCodingPolicy({ ...context, ...changed }), receipt), { code: 'jurisdiction_context_conflict' });
  }
});

test('a no-provider fallback remains inside the same custom chart as the model schema', async (t) => {
  const previous = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  t.after(() => { if (previous !== undefined) process.env.OPENAI_API_KEY = previous; });
  const clientProfile = { jurisdiction: 'ae' };
  const xeroAccounts = [{ name: 'Custom expense' }];
  const result = await suggestTransactionCoding({ clientProfile, xeroAccounts, transaction });
  const options = accountOptionsForClient(xeroAccounts, clientProfile);
  assert.ok(options.includes(result.proposed_account));
  assert.equal(result.proposed_account, 'Suspense', 'fallback cannot propose absent Bank fees');
  assert.equal(result.tax_treatment, 'UAE VAT check');
  assert.equal(result.coding_policy.jurisdiction, 'ae');
});


test('business date preserves PostgreSQL local-midnight calendar meaning', () => {
  const date = new Date(2026, 0, 1);
  assert.equal(resolveCodingPolicy({ jurisdiction: 'sg', businessDate: date }).businessDate, '2026-01-01');
});
