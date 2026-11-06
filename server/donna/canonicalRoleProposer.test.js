import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildCanonicalRoleProposerPrompt,
  proposeCanonicalRoles
} from './canonicalRoleProposer.js';
import { planCanonicalRoleResolution } from './canonicalRoleResolution.js';

const GB_CHART = [
  { id: 'gb-2210', code: '2210', name: 'Accruals', account_type: 'liability', normal_balance: 'credit', canonical_role: null },
  { id: 'gb-2220', code: '2220', name: 'VAT control', account_type: 'liability', normal_balance: 'credit', canonical_role: null },
  { id: 'gb-2230', code: '2230', name: 'Corporation tax payable', account_type: 'liability', normal_balance: 'credit', canonical_role: null },
  { id: 'gb-4000', code: '4000', name: 'Sales', account_type: 'revenue', normal_balance: 'credit', canonical_role: 'revenue.operating' }
];

const callWith = async (proposals, extra = {}) => {
  const calls = [];
  const result = await proposeCanonicalRoles({
    accounts: extra.accounts || GB_CHART,
    jurisdiction: extra.jurisdiction || 'GB',
    pack: extra.pack || { id: 'gb-ltd', vat_registered: true },
    clientIdentity: { display_name: 'Example Ltd' },
    env: extra.env || {},
    compose: async (request) => {
      calls.push(request);
      return {
        model: 'resolved-strong-model',
        output: JSON.stringify({ proposals })
      };
    }
  });
  return { calls, result };
};

await test('one whole-chart call separates GB VAT control and assigns it without an owner ask', async () => {
  const { calls, result } = await callWith([
    {
      account_id: 'gb-2220',
      role: 'liability.sales_tax_payable',
      confidence: 0.98,
      rationale: 'VAT control account'
    },
    {
      account_id: 'gb-2230',
      role: 'liability.tax_payable',
      confidence: 0.96,
      rationale: 'Corporation tax liability'
    }
  ]);

  assert.equal(calls.length, 1, 'the entire chart must use one model call');
  assert.match(calls[0].prompt, /VAT control/);
  assert.match(calls[0].prompt, /Corporation tax payable/);
  assert.match(calls[0].prompt, /Jurisdiction: GB/);
  assert.match(calls[0].prompt, /gb-ltd/);

  const plan = planCanonicalRoleResolution({
    accounts: GB_CHART,
    proposals: result.proposals,
    requiredRoles: ['liability.sales_tax_payable']
  });
  assert.equal(plan.assignments.length, 2);
  assert.equal(plan.asks.length, 0);
  assert.equal(
    plan.assignments.find((entry) => entry.account_id === 'gb-2220')?.role,
    'liability.sales_tax_payable'
  );
  assert.equal(result.receipt.model_used, 'resolved-strong-model');
});

await test('a Finnish-language chart and FI pack are passed intact and produce proposals', async () => {
  const accounts = [
    { id: 'fi-2939', code: '2939', name: 'Suoritettava arvonlisävero', account_type: 'liability', normal_balance: 'credit', canonical_role: null },
    { id: 'fi-2950', code: '2950', name: 'Ennakkoverovelka', account_type: 'liability', normal_balance: 'credit', canonical_role: null }
  ];
  const { calls, result } = await callWith([
    {
      account_id: 'fi-2939',
      role: 'liability.sales_tax_payable',
      confidence: 0.97,
      rationale: 'Suoritettavan ALV:n tili'
    }
  ], {
    accounts,
    jurisdiction: 'FI',
    pack: { id: 'fi-osakeyhtio', language: 'fi' }
  });

  assert.match(calls[0].prompt, /Jurisdiction: FI/);
  assert.match(calls[0].prompt, /Suoritettava arvonlisävero/);
  assert.match(calls[0].prompt, /fi-osakeyhtio/);
  assert.equal(result.proposals[0].account_id, 'fi-2939');
});

await test('singleton contention reaches the planner as exactly one ask and no assignment', async () => {
  const { result } = await callWith([
    { account_id: 'gb-2220', role: 'liability.sales_tax_payable', confidence: 0.91, rationale: 'VAT liability' },
    { account_id: 'gb-2230', role: 'liability.sales_tax_payable', confidence: 0.89, rationale: 'Tax liability' }
  ]);
  const plan = planCanonicalRoleResolution({ accounts: GB_CHART, proposals: result.proposals });
  assert.equal(plan.assignments.length, 0);
  assert.equal(plan.asks.length, 1);
  assert.equal(plan.asks[0].refusal, 'singleton_contended');
});

await test('a hallucinated role is preserved for the planner to refuse as role_unknown', async () => {
  const { result } = await callWith([
    { account_id: 'gb-2220', role: 'liability.imaginary_tax', confidence: 0.99, rationale: 'Tax account' }
  ]);
  assert.equal(result.proposals[0].role, 'liability.imaginary_tax');
  const plan = planCanonicalRoleResolution({ accounts: GB_CHART, proposals: result.proposals });
  assert.equal(plan.rejected.length, 1);
  assert.equal(plan.rejected[0].refusal, 'role_unknown');
});

await test('no injected model returns zero proposals and an honest receipt without throwing', async () => {
  const result = await proposeCanonicalRoles({ accounts: GB_CHART, jurisdiction: 'GB', env: {} });
  assert.deepEqual(result.proposals, []);
  assert.equal(result.receipt.status, 'not_called');
  assert.equal(result.receipt.reason, 'model_not_injected');
  assert.equal(result.receipt.model_used, null);
});

await test('CANONICAL_ROLE_PROPOSER_MODEL env override reaches the compose call, and an explicit model outranks it', async () => {
  // The env override (#1183 review): the receipt and the actual request must
  // both carry the override, or a staged model change is invisible in the data
  // (the model-id-is-part-of-the-receipt rail).
  const { calls, result } = await callWith([], { env: { CANONICAL_ROLE_PROPOSER_MODEL: 'claude-opus-4-9-staged' } });
  assert.equal(calls[0].model, 'claude-opus-4-9-staged');
  assert.equal(result.receipt.model_requested, 'claude-opus-4-9-staged');

  // An explicit caller model outranks the env override.
  const explicitCalls = [];
  const explicit = await proposeCanonicalRoles({
    accounts: GB_CHART,
    jurisdiction: 'GB',
    model: 'caller-pinned-model',
    env: { CANONICAL_ROLE_PROPOSER_MODEL: 'claude-opus-4-9-staged' },
    compose: async (request) => {
      explicitCalls.push(request);
      return { model: 'caller-pinned-model', output: JSON.stringify({ proposals: [] }) };
    }
  });
  assert.equal(explicitCalls[0].model, 'caller-pinned-model');
  assert.equal(explicit.receipt.model_requested, 'caller-pinned-model');
});

await test('malformed proposal entries are counted on the receipt, never silently dropped', async () => {
  const { result } = await callWith([
    // Valid.
    { account_id: 'gb-2220', role: 'liability.sales_tax_payable', confidence: 0.95, rationale: 'VAT control' },
    // Dropped: settled target, bad confidence, missing role, not an object.
    { account_id: 'gb-4000', role: 'revenue.other', confidence: 0.9 },
    { account_id: 'gb-2230', role: 'liability.tax_payable', confidence: 1.7 },
    { account_id: 'gb-2210', confidence: 0.9 },
    'not-an-object'
  ]);
  assert.equal(result.proposals.length, 1);
  assert.equal(result.receipt.proposals_returned, 1);
  assert.equal(result.receipt.proposals_dropped, 4);
});

await test('settled accounts are context-only, and a model violation cannot overwrite one', async () => {
  const prompt = buildCanonicalRoleProposerPrompt({ accounts: GB_CHART, jurisdiction: 'GB' });
  assert.match(prompt, /"status": "settled_context"/);
  assert.match(prompt, /"canonical_role": "revenue.operating"/);

  const { result } = await callWith([
    { account_id: 'gb-4000', role: 'revenue.other', confidence: 1, rationale: 'Other sales' },
    { account_id: 'gb-2220', role: 'liability.sales_tax_payable', confidence: 0.95, rationale: 'VAT control' }
  ]);
  assert.deepEqual(result.proposals.map((entry) => entry.account_id), ['gb-2220']);
  const plan = planCanonicalRoleResolution({ accounts: GB_CHART, proposals: result.proposals });
  assert.deepEqual(plan.alreadyResolved.map((entry) => entry.role), ['revenue.operating']);
  assert.ok(!plan.assignments.some((entry) => entry.account_id === 'gb-4000'));
});
