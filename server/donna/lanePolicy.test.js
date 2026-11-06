import assert from 'node:assert/strict';
import test from 'node:test';

import { classifyLane } from './lanePolicy.js';

// --- Red-lane rules ---

await test('red: tax account name triggers red lane', () => {
  const result = classifyLane({
    decisionType: 'categorize',
    confidence: { score: 0.95, label: 'high' },
    accountName: 'Sales Tax Payable',
    accountType: 'liability'
  });
  assert.equal(result.lane, 'red');
  assert.ok(result.blockers.includes('sensitive_account'));
});

await test('red: payroll account triggers red lane', () => {
  const result = classifyLane({
    decisionType: 'categorize',
    confidence: { score: 0.99, label: 'high' },
    accountName: 'Payroll Expenses',
    accountType: 'expense'
  });
  assert.equal(result.lane, 'red');
  assert.ok(result.blockers.includes('sensitive_account'));
});

await test('red: director loan triggers red lane', () => {
  const result = classifyLane({
    decisionType: 'categorize',
    confidence: { score: 0.95, label: 'high' },
    accountName: 'Director Loan Account',
    accountType: 'liability'
  });
  assert.equal(result.lane, 'red');
  assert.ok(result.blockers.includes('sensitive_account'));
});

await test('red: shareholder equity triggers red lane', () => {
  const result = classifyLane({
    decisionType: 'categorize',
    confidence: { score: 0.95, label: 'high' },
    accountName: 'Shareholder Equity',
    accountType: 'equity'
  });
  assert.equal(result.lane, 'red');
  assert.ok(result.blockers.includes('sensitive_account'));
});

await test('red: owner drawings triggers red lane', () => {
  const result = classifyLane({
    decisionType: 'categorize',
    confidence: { score: 0.95, label: 'high' },
    accountName: 'Owner Drawings',
    accountType: 'equity'
  });
  assert.equal(result.lane, 'red');
  assert.ok(result.blockers.includes('sensitive_account'));
});

await test('red: dividend account triggers red lane', () => {
  const result = classifyLane({
    decisionType: 'categorize',
    confidence: { score: 0.95, label: 'high' },
    accountName: 'Dividend Payable',
    accountType: 'liability'
  });
  assert.equal(result.lane, 'red');
  assert.ok(result.blockers.includes('sensitive_account'));
});

await test('red: equity account type triggers red lane', () => {
  const result = classifyLane({
    decisionType: 'categorize',
    confidence: { score: 0.95, label: 'high' },
    accountName: 'Common Stock',
    accountType: 'equity'
  });
  assert.equal(result.lane, 'red');
  assert.ok(result.blockers.includes('sensitive_account'));
});

await test('red: retained earnings triggers red lane', () => {
  const result = classifyLane({
    decisionType: 'categorize',
    confidence: { score: 0.95, label: 'high' },
    accountName: 'Retained Earnings',
    accountType: 'equity'
  });
  assert.equal(result.lane, 'red');
  assert.ok(result.blockers.includes('sensitive_account'));
});

await test('red: capital contribution triggers red lane', () => {
  const result = classifyLane({
    decisionType: 'categorize',
    confidence: { score: 0.95, label: 'high' },
    accountName: 'Capital Contribution',
    accountType: 'equity'
  });
  assert.equal(result.lane, 'red');
  assert.ok(result.blockers.includes('sensitive_account'));
});

await test('red: personal/mixed-use flag triggers red lane', () => {
  const result = classifyLane({
    decisionType: 'match',
    confidence: { score: 0.95, label: 'high' },
    signals: { personal_mixed_use: true, amount_exact: true, vendor_overlap: true, date_within_window: true },
    accountType: 'expense',
    accountName: 'Vehicle Fuel'
  });
  assert.equal(result.lane, 'red');
  assert.ok(result.blockers.includes('personal_mixed_use'));
});

await test('red: competing candidates triggers red lane', () => {
  const result = classifyLane({
    decisionType: 'match',
    confidence: { score: 0.90, label: 'high' },
    signals: { amount_exact: true, vendor_overlap: true, date_within_window: true },
    hasCompetingCandidates: true
  });
  assert.equal(result.lane, 'red');
  assert.ok(result.blockers.includes('competing_candidates'));
});

await test('red: competing_delta_below_threshold signal triggers red lane', () => {
  const result = classifyLane({
    decisionType: 'match',
    confidence: { score: 0.90, label: 'high' },
    signals: { amount_exact: true, vendor_overlap: true, date_within_window: true, competing_delta_below_threshold: true }
  });
  assert.equal(result.lane, 'red');
  assert.ok(result.blockers.includes('competing_candidates'));
});

await test('red: parse warning amount_mismatch triggers red lane', () => {
  const result = classifyLane({
    decisionType: 'match',
    confidence: { score: 0.90, label: 'high' },
    signals: { amount_exact: true, vendor_overlap: true, date_within_window: true, amount_mismatch: true }
  });
  assert.equal(result.lane, 'red');
  assert.ok(result.blockers.includes('parse_warning'));
});

await test('red: parse warning duplicate triggers red lane', () => {
  const result = classifyLane({
    decisionType: 'match',
    confidence: { score: 0.90, label: 'high' },
    signals: { amount_exact: true, vendor_overlap: true, date_within_window: true, duplicate: true }
  });
  assert.equal(result.lane, 'red');
  assert.ok(result.blockers.includes('parse_warning'));
});

await test('red: capital vs expense ambiguity on categorize triggers red lane', () => {
  const result = classifyLane({
    decisionType: 'categorize',
    confidence: { score: 0.95, label: 'high' },
    accountName: 'Fixed Asset - Equipment',
    accountType: 'asset'
  });
  assert.equal(result.lane, 'red');
  assert.ok(result.blockers.includes('capital_expense_ambiguity'));
});

await test('red: depreciation account is capital/expense ambiguity', () => {
  const result = classifyLane({
    decisionType: 'categorize',
    confidence: { score: 0.95, label: 'high' },
    accountName: 'Depreciation Expense',
    accountType: 'expense'
  });
  assert.equal(result.lane, 'red');
  assert.ok(result.blockers.includes('capital_expense_ambiguity'));
});

await test('red: multiple blockers all reported', () => {
  const result = classifyLane({
    decisionType: 'match',
    confidence: { score: 0.90, label: 'high' },
    signals: { personal_mixed_use: true, duplicate: true },
    hasCompetingCandidates: true,
    accountName: 'Tax Payable',
    accountType: 'liability'
  });
  assert.equal(result.lane, 'red');
  assert.ok(result.blockers.includes('sensitive_account'));
  assert.ok(result.blockers.includes('personal_mixed_use'));
  assert.ok(result.blockers.includes('competing_candidates'));
  assert.ok(result.blockers.includes('parse_warning'));
});

// --- Green-lane rules: match ---

await test('green: match with all signals passing', () => {
  const result = classifyLane({
    decisionType: 'match',
    confidence: { score: 0.92, label: 'high' },
    signals: { amount_exact: true, vendor_overlap: true, date_within_window: true },
    hasCompetingCandidates: false,
    extractionConfidence: 0.90,
    extractionSource: 'parser'
  });
  assert.equal(result.lane, 'green');
  assert.deepEqual(result.blockers, []);
});

await test('green: match with null extractionConfidence (treated as OK)', () => {
  const result = classifyLane({
    decisionType: 'match',
    confidence: { score: 0.88, label: 'high' },
    signals: { amount_exact: true, vendor_overlap: true, date_within_window: true },
    hasCompetingCandidates: false,
    extractionConfidence: null,
    extractionSource: 'parser'
  });
  assert.equal(result.lane, 'green');
});

await test('yellow: match missing amount_exact falls to yellow', () => {
  const result = classifyLane({
    decisionType: 'match',
    confidence: { score: 0.92, label: 'high' },
    signals: { amount_exact: false, vendor_overlap: true, date_within_window: true },
    hasCompetingCandidates: false,
    extractionConfidence: 0.90
  });
  assert.equal(result.lane, 'yellow');
});

await test('yellow: match missing vendor_overlap falls to yellow', () => {
  const result = classifyLane({
    decisionType: 'match',
    confidence: { score: 0.92, label: 'high' },
    signals: { amount_exact: true, vendor_overlap: false, date_within_window: true },
    hasCompetingCandidates: false,
    extractionConfidence: 0.90
  });
  assert.equal(result.lane, 'yellow');
});

await test('yellow: match missing date_within_window falls to yellow', () => {
  const result = classifyLane({
    decisionType: 'match',
    confidence: { score: 0.92, label: 'high' },
    signals: { amount_exact: true, vendor_overlap: true, date_within_window: false },
    hasCompetingCandidates: false,
    extractionConfidence: 0.90
  });
  assert.equal(result.lane, 'yellow');
});

await test('yellow: match with low extraction confidence falls to yellow', () => {
  const result = classifyLane({
    decisionType: 'match',
    confidence: { score: 0.92, label: 'high' },
    signals: { amount_exact: true, vendor_overlap: true, date_within_window: true },
    hasCompetingCandidates: false,
    extractionConfidence: 0.70
  });
  assert.equal(result.lane, 'yellow');
});

await test('yellow: match with filename extraction source is never green', () => {
  const result = classifyLane({
    decisionType: 'match',
    confidence: { score: 0.95, label: 'high' },
    signals: { amount_exact: true, vendor_overlap: true, date_within_window: true },
    hasCompetingCandidates: false,
    extractionConfidence: 0.95,
    extractionSource: 'filename'
  });
  assert.equal(result.lane, 'yellow');
});

await test('yellow: match with low confidence score falls to yellow', () => {
  const result = classifyLane({
    decisionType: 'match',
    confidence: { score: 0.80, label: 'medium' },
    signals: { amount_exact: true, vendor_overlap: true, date_within_window: true },
    hasCompetingCandidates: false,
    extractionConfidence: 0.90
  });
  assert.equal(result.lane, 'yellow');
});

// --- Green-lane rules: categorize ---

await test('green: categorize with client rule match, high confidence, safe account', () => {
  const result = classifyLane({
    decisionType: 'categorize',
    confidence: { score: 0.95, label: 'high' },
    signals: { client_rule_match: true },
    accountType: 'expense',
    accountName: 'Vehicle Fuel'
  });
  assert.equal(result.lane, 'green');
  assert.deepEqual(result.blockers, []);
});

await test('green: categorize with revenue account type is green-eligible', () => {
  const result = classifyLane({
    decisionType: 'categorize',
    confidence: { score: 0.92, label: 'high' },
    signals: { client_rule_match: true },
    accountType: 'revenue',
    accountName: 'Sales Revenue'
  });
  assert.equal(result.lane, 'green');
});

await test('green: categorize with cost_of_sales account type is green-eligible', () => {
  const result = classifyLane({
    decisionType: 'categorize',
    confidence: { score: 0.92, label: 'high' },
    signals: { client_rule_match: true },
    accountType: 'cost_of_sales',
    accountName: 'Cost of Goods Sold'
  });
  assert.equal(result.lane, 'green');
});

await test('yellow: categorize without client_rule_match falls to yellow', () => {
  const result = classifyLane({
    decisionType: 'categorize',
    confidence: { score: 0.95, label: 'high' },
    signals: {},
    accountType: 'expense',
    accountName: 'Vehicle Fuel'
  });
  assert.equal(result.lane, 'yellow');
});

await test('yellow: categorize with low confidence falls to yellow', () => {
  const result = classifyLane({
    decisionType: 'categorize',
    confidence: { score: 0.85, label: 'medium' },
    signals: { client_rule_match: true },
    accountType: 'expense',
    accountName: 'Vehicle Fuel'
  });
  assert.equal(result.lane, 'yellow');
});

await test('yellow: categorize with liability account type falls to yellow', () => {
  const result = classifyLane({
    decisionType: 'categorize',
    confidence: { score: 0.95, label: 'high' },
    signals: { client_rule_match: true },
    accountType: 'liability',
    accountName: 'Accounts Payable'
  });
  assert.equal(result.lane, 'yellow');
});

await test('yellow: categorize with asset account type falls to yellow', () => {
  const result = classifyLane({
    decisionType: 'categorize',
    confidence: { score: 0.95, label: 'high' },
    signals: { client_rule_match: true },
    accountType: 'asset',
    accountName: 'Accounts Receivable'
  });
  assert.equal(result.lane, 'yellow');
});

await test('yellow: categorize with filename extraction source falls to yellow', () => {
  const result = classifyLane({
    decisionType: 'categorize',
    confidence: { score: 0.95, label: 'high' },
    signals: { client_rule_match: true },
    accountType: 'expense',
    accountName: 'Office Supplies',
    extractionSource: 'filename'
  });
  assert.equal(result.lane, 'yellow');
});

// --- Yellow-lane (default) ---

await test('yellow: unknown decision type defaults to yellow', () => {
  const result = classifyLane({
    decisionType: 'triage',
    confidence: { score: 0.90, label: 'high' }
  });
  assert.equal(result.lane, 'yellow');
  assert.deepEqual(result.blockers, []);
});

await test('yellow: match with partial signals defaults to yellow', () => {
  const result = classifyLane({
    decisionType: 'match',
    confidence: { score: 0.60, label: 'low' },
    signals: { amount_exact: true, date_within_window: true }
  });
  assert.equal(result.lane, 'yellow');
});

// --- Edge cases ---

await test('edge: empty input defaults to yellow', () => {
  const result = classifyLane({});
  assert.equal(result.lane, 'yellow');
});

await test('edge: no arguments defaults to yellow', () => {
  const result = classifyLane();
  assert.equal(result.lane, 'yellow');
});

await test('edge: confidence score as zero defaults to yellow for match', () => {
  const result = classifyLane({
    decisionType: 'match',
    confidence: { score: 0, label: 'none' },
    signals: { amount_exact: true, vendor_overlap: true, date_within_window: true }
  });
  assert.equal(result.lane, 'yellow');
});

await test('edge: confidence without score property defaults to 0', () => {
  const result = classifyLane({
    decisionType: 'match',
    confidence: { label: 'high' },
    signals: { amount_exact: true, vendor_overlap: true, date_within_window: true }
  });
  assert.equal(result.lane, 'yellow');
});

await test('red lane takes priority over green eligibility', () => {
  const result = classifyLane({
    decisionType: 'match',
    confidence: { score: 0.95, label: 'high' },
    signals: { amount_exact: true, vendor_overlap: true, date_within_window: true, personal_mixed_use: true },
    hasCompetingCandidates: false,
    extractionConfidence: 0.95,
    accountName: 'Vehicle Fuel',
    accountType: 'expense'
  });
  assert.equal(result.lane, 'red');
});

await test('edge: PAYE account triggers red', () => {
  const result = classifyLane({
    decisionType: 'categorize',
    confidence: { score: 0.95, label: 'high' },
    accountName: 'PAYE Liability',
    accountType: 'liability'
  });
  assert.equal(result.lane, 'red');
});

await test('edge: owner equity triggers red', () => {
  const result = classifyLane({
    decisionType: 'categorize',
    confidence: { score: 0.95, label: 'high' },
    accountName: "Owner's Equity",
    accountType: 'owners_equity'
  });
  assert.equal(result.lane, 'red');
});

await test('edge: match confidence exactly 0.85 is green-eligible', () => {
  const result = classifyLane({
    decisionType: 'match',
    confidence: { score: 0.85, label: 'high' },
    signals: { amount_exact: true, vendor_overlap: true, date_within_window: true },
    hasCompetingCandidates: false,
    extractionConfidence: 0.85,
    extractionSource: 'parser'
  });
  assert.equal(result.lane, 'green');
});

await test('edge: categorize confidence exactly 0.9 is green-eligible', () => {
  const result = classifyLane({
    decisionType: 'categorize',
    confidence: { score: 0.9, label: 'high' },
    signals: { client_rule_match: true },
    accountType: 'expense',
    accountName: 'Office Supplies'
  });
  assert.equal(result.lane, 'green');
});

await test('edge: extraction confidence exactly 0.85 is green-eligible', () => {
  const result = classifyLane({
    decisionType: 'match',
    confidence: { score: 0.90, label: 'high' },
    signals: { amount_exact: true, vendor_overlap: true, date_within_window: true },
    hasCompetingCandidates: false,
    extractionConfidence: 0.85
  });
  assert.equal(result.lane, 'green');
});

await test('edge: extraction confidence 0.849 is NOT green-eligible', () => {
  const result = classifyLane({
    decisionType: 'match',
    confidence: { score: 0.90, label: 'high' },
    signals: { amount_exact: true, vendor_overlap: true, date_within_window: true },
    hasCompetingCandidates: false,
    extractionConfidence: 0.849
  });
  assert.equal(result.lane, 'yellow');
});

await test('edge: match confidence 0.849 is NOT green-eligible', () => {
  const result = classifyLane({
    decisionType: 'match',
    confidence: { score: 0.849, label: 'high' },
    signals: { amount_exact: true, vendor_overlap: true, date_within_window: true },
    hasCompetingCandidates: false,
    extractionConfidence: 0.90
  });
  assert.equal(result.lane, 'yellow');
});

await test('edge: categorize confidence 0.899 is NOT green-eligible', () => {
  const result = classifyLane({
    decisionType: 'categorize',
    confidence: { score: 0.899, label: 'high' },
    signals: { client_rule_match: true },
    accountType: 'expense',
    accountName: 'Office Supplies'
  });
  assert.equal(result.lane, 'yellow');
});

await test('red: capital-expense ambiguity does NOT fire for match type', () => {
  const result = classifyLane({
    decisionType: 'match',
    confidence: { score: 0.92, label: 'high' },
    signals: { amount_exact: true, vendor_overlap: true, date_within_window: true },
    accountName: 'Fixed Asset - Equipment',
    accountType: 'asset',
    hasCompetingCandidates: false,
    extractionConfidence: 0.90
  });
  assert.notEqual(result.lane, 'red');
});

await test('green: other_income account type is green-eligible for categorize', () => {
  const result = classifyLane({
    decisionType: 'categorize',
    confidence: { score: 0.95, label: 'high' },
    signals: { client_rule_match: true },
    accountType: 'other_income',
    accountName: 'Interest Income'
  });
  assert.equal(result.lane, 'green');
});
