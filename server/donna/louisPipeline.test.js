import assert from 'node:assert/strict';
import test from 'node:test';

import { LOUIS_PIPELINE_SYSTEM, buildPipelineEvalPrompt, evaluatePipelineDecision } from './louisPipeline.js';

// --- System prompt tests ---

await test('system prompt includes match evaluation criteria', () => {
  assert.ok(LOUIS_PIPELINE_SYSTEM.includes('amount_validity'));
  assert.ok(LOUIS_PIPELINE_SYSTEM.includes('vendor_identity'));
  assert.ok(LOUIS_PIPELINE_SYSTEM.includes('date_plausibility'));
  assert.ok(LOUIS_PIPELINE_SYSTEM.includes('red_flags'));
});

await test('system prompt includes categorization evaluation criteria', () => {
  assert.ok(LOUIS_PIPELINE_SYSTEM.includes('account_fit'));
  assert.ok(LOUIS_PIPELINE_SYSTEM.includes('type_correctness'));
  assert.ok(LOUIS_PIPELINE_SYSTEM.includes('policy_sensitivity'));
  assert.ok(LOUIS_PIPELINE_SYSTEM.includes('pattern_stability'));
});

await test('system prompt requires JSON output with verdict', () => {
  assert.ok(LOUIS_PIPELINE_SYSTEM.includes('"verdict"'));
  assert.ok(LOUIS_PIPELINE_SYSTEM.includes('"pass"'));
  assert.ok(LOUIS_PIPELINE_SYSTEM.includes('"warn"'));
  assert.ok(LOUIS_PIPELINE_SYSTEM.includes('"fail"'));
});

await test('system prompt has verdict rules matching existing Louis', () => {
  assert.ok(LOUIS_PIPELINE_SYSTEM.includes('scores 2 or below'));
  assert.ok(LOUIS_PIPELINE_SYSTEM.includes('ALL dimensions score 4 or above'));
});

// --- Prompt builder tests ---

await test('buildPipelineEvalPrompt includes decision record', () => {
  const prompt = buildPipelineEvalPrompt({
    decision: {
      decision_type: 'match',
      target_type: 'transaction',
      target_id: 'tx-123',
      lane: 'green',
      confidence: { score: 0.92, label: 'high' },
      deterministic_signals: { amount_exact: true },
      llm_reasoning: 'Good match.',
      policy_blockers: []
    }
  });

  assert.ok(prompt.includes('## Decision record'));
  assert.ok(prompt.includes('Type: match'));
  assert.ok(prompt.includes('Lane: green'));
  assert.ok(prompt.includes('Good match.'));
});

await test('buildPipelineEvalPrompt includes document when provided', () => {
  const prompt = buildPipelineEvalPrompt({
    decision: {
      decision_type: 'match',
      target_type: 'transaction',
      target_id: 'tx-1',
      lane: 'yellow',
      confidence: {},
      deterministic_signals: {},
      policy_blockers: []
    },
    document: {
      filename: 'invoice_001.pdf',
      document_type: 'supplier_bill',
      vendor_name: 'Acme Corp',
      total_amount: 150.00,
      currency: 'USD',
      document_date: '2025-08-01',
      due_date: '2025-09-01',
      extraction_confidence: 0.92
    }
  });

  assert.ok(prompt.includes('## Document'));
  assert.ok(prompt.includes('invoice_001.pdf'));
  assert.ok(prompt.includes('Acme Corp'));
  assert.ok(prompt.includes('150'));
});

await test('buildPipelineEvalPrompt includes transaction when provided', () => {
  const prompt = buildPipelineEvalPrompt({
    decision: {
      decision_type: 'categorize',
      target_type: 'transaction',
      target_id: 'tx-1',
      lane: 'yellow',
      confidence: {},
      deterministic_signals: {},
      policy_blockers: []
    },
    transaction: {
      description: 'CITY FARMERS MARKET 0902',
      money_out: 15.51,
      currency: 'USD',
      date: '2025-08-09',
      account_name: 'Marketing Expenses'
    }
  });

  assert.ok(prompt.includes('## Transaction'));
  assert.ok(prompt.includes('CITY FARMERS MARKET'));
  assert.ok(prompt.includes('15.51'));
  assert.ok(prompt.includes('Marketing Expenses'));
});

await test('buildPipelineEvalPrompt includes chart of accounts excerpt', () => {
  const prompt = buildPipelineEvalPrompt({
    decision: {
      decision_type: 'categorize',
      target_type: 'transaction',
      target_id: 'tx-1',
      lane: 'yellow',
      confidence: {},
      deterministic_signals: {},
      policy_blockers: []
    },
    chartOfAccounts: [
      { code: '5100', name: 'Vehicle Fuel', account_type: 'expense' },
      { code: '5200', name: 'Office Supplies', account_type: 'expense' }
    ]
  });

  assert.ok(prompt.includes('## Chart of accounts'));
  assert.ok(prompt.includes('5100'));
  assert.ok(prompt.includes('Vehicle Fuel'));
});

await test('buildPipelineEvalPrompt includes client profile', () => {
  const prompt = buildPipelineEvalPrompt({
    decision: {
      decision_type: 'match',
      target_type: 'transaction',
      target_id: 'tx-1',
      lane: 'green',
      confidence: {},
      deterministic_signals: {},
      policy_blockers: []
    },
    clientProfile: {
      companyName: 'Honeybee Hills Apiary',
      industry: 'Agriculture'
    }
  });

  assert.ok(prompt.includes('## Client'));
  assert.ok(prompt.includes('Honeybee Hills Apiary'));
  assert.ok(prompt.includes('Agriculture'));
});

await test('buildPipelineEvalPrompt handles missing optional sections', () => {
  const prompt = buildPipelineEvalPrompt({
    decision: {
      decision_type: 'match',
      target_type: 'transaction',
      target_id: 'tx-1',
      lane: 'yellow',
      confidence: {},
      deterministic_signals: {},
      policy_blockers: []
    }
  });

  assert.ok(prompt.includes('## Decision record'));
  assert.ok(!prompt.includes('## Document'));
  assert.ok(!prompt.includes('## Transaction'));
  assert.ok(!prompt.includes('## Chart of accounts'));
  assert.ok(!prompt.includes('## Client'));
});

await test('buildPipelineEvalPrompt shows policy blockers', () => {
  const prompt = buildPipelineEvalPrompt({
    decision: {
      decision_type: 'categorize',
      target_type: 'transaction',
      target_id: 'tx-1',
      lane: 'red',
      confidence: { score: 0.5 },
      deterministic_signals: {},
      policy_blockers: ['sensitive_account', 'competing_candidates']
    }
  });

  assert.ok(prompt.includes('sensitive_account, competing_candidates'));
});

await test('buildPipelineEvalPrompt handles NULL vendor', () => {
  const prompt = buildPipelineEvalPrompt({
    decision: {
      decision_type: 'match',
      target_type: 'transaction',
      target_id: 'tx-1',
      lane: 'yellow',
      confidence: {},
      deterministic_signals: {},
      policy_blockers: []
    },
    document: {
      filename: '25-08-09_Farmers_Market_15.51.pdf',
      vendor_name: null,
      total_amount: 15.51
    }
  });

  assert.ok(prompt.includes('NULL (not extracted)'));
});

// --- evaluatePipelineDecision tests ---

await test('evaluatePipelineDecision returns null without apiKey', async () => {
  const result = await evaluatePipelineDecision({
    decision: { decision_type: 'match' }
  });
  assert.equal(result, null);
});

await test('evaluatePipelineDecision returns null without decision', async () => {
  const result = await evaluatePipelineDecision({
    apiKey: 'test-key'
  });
  assert.equal(result, null);
});
