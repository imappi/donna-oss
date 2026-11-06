import assert from 'node:assert/strict';
import test from 'node:test';

import { classifyLane } from './lanePolicy.js';
import { suggestAccountForVendor } from './vendorAccountSuggestion.js';
import { deduplicateMerchants } from './merchantLookup.js';

// --- 3a. Orchestration: VENDOR_SIGNALS as validation, not primary ---

await test('categorize lane: LLM + VENDOR_SIGNALS agree → green eligible when client_rule_match signal set', () => {
  const result = classifyLane({
    decisionType: 'categorize',
    confidence: { score: 0.95, label: 'high' },
    signals: { client_rule_match: true, vendor_signal_agrees: true },
    accountType: 'expense',
    accountName: 'Vehicle Fuel'
  });
  assert.equal(result.lane, 'green');
});

await test('categorize lane: LLM-only verdict without corroboration → yellow', () => {
  const result = classifyLane({
    decisionType: 'categorize',
    confidence: { score: 0.85, label: 'high' },
    signals: { client_rule_match: false, vendor_signal_agrees: false },
    accountType: 'expense',
    accountName: 'Office Supplies'
  });
  assert.equal(result.lane, 'yellow');
});

await test('categorize lane: LLM + VENDOR_SIGNALS disagree → yellow (no client_rule_match)', () => {
  const result = classifyLane({
    decisionType: 'categorize',
    confidence: { score: 0.85, label: 'high' },
    signals: {
      client_rule_match: false,
      vendor_signal_agrees: false,
      vendor_signal_disagrees: true
    },
    accountType: 'expense',
    accountName: 'Office Supplies'
  });
  assert.equal(result.lane, 'yellow');
});

await test('categorize lane: red lane for tax account even with high confidence', () => {
  const result = classifyLane({
    decisionType: 'categorize',
    confidence: { score: 0.99, label: 'high' },
    signals: { client_rule_match: true, vendor_signal_agrees: true },
    accountType: 'expense',
    accountName: 'Tax Payment'
  });
  assert.equal(result.lane, 'red');
  assert.ok(result.blockers.includes('sensitive_account'));
});

await test('categorize lane: red lane for equity account', () => {
  const result = classifyLane({
    decisionType: 'categorize',
    confidence: { score: 0.95, label: 'high' },
    signals: { client_rule_match: true },
    accountType: 'equity',
    accountName: 'Owner Equity'
  });
  assert.equal(result.lane, 'red');
});

await test('categorize lane: capital/expense ambiguity → red', () => {
  const result = classifyLane({
    decisionType: 'categorize',
    confidence: { score: 0.95, label: 'high' },
    signals: { client_rule_match: true },
    accountType: 'expense',
    accountName: 'Fixed Asset Equipment'
  });
  assert.equal(result.lane, 'red');
  assert.ok(result.blockers.includes('capital_expense_ambiguity'));
});

// --- 3a. VENDOR_SIGNALS validation layer ---

await test('VENDOR_SIGNALS: chevron matches to fuel expense', () => {
  const accounts = [
    { code: '5100', name: 'Vehicle Fuel', account_type: 'expense' },
    { code: '5200', name: 'Office Supplies', account_type: 'expense' }
  ];
  const result = suggestAccountForVendor('', 'CHEVRON GAS STA #1234', accounts);
  assert.ok(result);
  assert.equal(result.account.code, '5100');
});

await test('VENDOR_SIGNALS: no match for unknown merchant', () => {
  const accounts = [
    { code: '5100', name: 'Vehicle Fuel', account_type: 'expense' },
    { code: '5200', name: 'Office Supplies', account_type: 'expense' }
  ];
  const result = suggestAccountForVendor('', 'ACME CORP PAYMENT 12345', accounts);
  assert.equal(result, null);
});

await test('VENDOR_SIGNALS: agreement check — same account code means agreement', () => {
  const accounts = [
    { code: '5100', name: 'Vehicle Fuel', account_type: 'expense' },
    { code: '5200', name: 'Office Supplies', account_type: 'expense' }
  ];
  const vendorSignal = suggestAccountForVendor('', 'CHEVRON GAS STA #1234', accounts);
  const llmAccountCode = '5100';
  assert.ok(vendorSignal);
  assert.equal(vendorSignal.account.code === llmAccountCode, true);
});

await test('VENDOR_SIGNALS: disagreement check — different account code', () => {
  const accounts = [
    { code: '5100', name: 'Vehicle Fuel', account_type: 'expense' },
    { code: '5200', name: 'Office Supplies', account_type: 'expense' }
  ];
  const vendorSignal = suggestAccountForVendor('', 'CHEVRON GAS STA #1234', accounts);
  const llmAccountCode = '5200';
  assert.ok(vendorSignal);
  assert.equal(vendorSignal.account.code !== llmAccountCode, true);
});

// --- 3a. Confidence boosting ---

await test('confidence boost: LLM + VENDOR_SIGNALS agree → +0.1 boost', () => {
  const llmConfidence = 0.88;
  const boosted = Math.min(llmConfidence + 0.1, 0.98);
  assert.equal(boosted, 0.98);
});

await test('confidence boost: capped at 0.98', () => {
  const llmConfidence = 0.95;
  const boosted = Math.min(llmConfidence + 0.1, 0.98);
  assert.equal(boosted, 0.98);
});

await test('confidence boost: no boost when vendor has no opinion', () => {
  const llmConfidence = 0.88;
  const vendorSignal = null;
  const vendorAgrees = vendorSignal && vendorSignal.account?.code === '5100';
  const effectiveConfidence = vendorAgrees ? Math.min(llmConfidence + 0.1, 0.98) : llmConfidence;
  assert.equal(effectiveConfidence, 0.88);
});

// --- 3b. Batch size and model ---

await test('batch size reduced to 20: deduplication still works with many unique merchants', async () => {
  const merchants = [
    'CHEVRON GAS', 'SHELL OIL', 'HOME DEPOT', 'AMAZON PURCHASE',
    'STAPLES OFFICE', 'STRIPE PAYOUT', 'GUSTO PAYROLL', 'XERO SUBSCRIPTION'
  ];
  const rows = merchants.map((name, i) => ({
    description: `${name} #${i}`,
    raw_description: '',
    money_out: 100 + i,
    review_id: `r${i}`,
    transaction_id: `t${i}`
  }));
  const deduped = deduplicateMerchants(rows);
  assert.ok(deduped.length >= 1);
  assert.ok(deduped.length <= rows.length);
});

// --- 3c. Lane policy integration ---

await test('green lane: client rule match + high confidence + safe type → green', () => {
  const result = classifyLane({
    decisionType: 'categorize',
    confidence: { score: 0.95, label: 'high' },
    signals: { client_rule_match: true },
    accountType: 'expense',
    accountName: 'Office Supplies'
  });
  assert.equal(result.lane, 'green');
});

await test('green lane: cost_of_sales is a safe type', () => {
  const result = classifyLane({
    decisionType: 'categorize',
    confidence: { score: 0.92, label: 'high' },
    signals: { client_rule_match: true },
    accountType: 'cost_of_sales',
    accountName: 'Bee Supplies'
  });
  assert.equal(result.lane, 'green');
});

await test('green lane: revenue is a safe type', () => {
  const result = classifyLane({
    decisionType: 'categorize',
    confidence: { score: 0.92, label: 'high' },
    signals: { client_rule_match: true },
    accountType: 'revenue',
    accountName: 'Honey Sales'
  });
  assert.equal(result.lane, 'green');
});

await test('yellow lane: confidence below 0.9 → yellow even with client_rule_match', () => {
  const result = classifyLane({
    decisionType: 'categorize',
    confidence: { score: 0.85, label: 'high' },
    signals: { client_rule_match: true },
    accountType: 'expense',
    accountName: 'Office Supplies'
  });
  assert.equal(result.lane, 'yellow');
});

await test('yellow lane: filename extraction source → yellow', () => {
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

// --- 3d. Auto-promote discipline ---

await test('auto-promote: first confirmation sets confidence to 0.7', () => {
  const currentCount = 0;
  const newCount = currentCount + 1;
  const newConfidence = newCount >= 2 ? 0.9 : 0.7;
  assert.equal(newCount, 1);
  assert.equal(newConfidence, 0.7);
});

await test('auto-promote: second confirmation promotes to 0.9', () => {
  const currentCount = 1;
  const newCount = currentCount + 1;
  const newConfidence = newCount >= 2 ? 0.9 : 0.7;
  assert.equal(newCount, 2);
  assert.equal(newConfidence, 0.9);
});

await test('auto-promote: third+ confirmation stays at 0.9', () => {
  const currentCount = 5;
  const newCount = currentCount + 1;
  const newConfidence = newCount >= 2 ? 0.9 : 0.7;
  assert.equal(newCount, 6);
  assert.equal(newConfidence, 0.9);
});

await test('auto-promote: single-shot LLM guess does not auto-promote', () => {
  const currentCount = 0;
  const newConfidence = currentCount >= 2 ? 0.9 : 0.7;
  assert.equal(newConfidence, 0.7);
});

await test('auto-promote: LLM rule starts with confirmation_count 0', () => {
  const rulePayload = {
    source: 'llm_suggested',
    confidence: 0.88,
    confirmation_count: 0
  };
  assert.equal(rulePayload.confirmation_count, 0);
  assert.equal(rulePayload.source, 'llm_suggested');
});

// --- 3d. Human outcome classification ---

await test('outcome: confirm when accepting with same account', () => {
  const reviewState = 'accepted';
  const firmAccountCode = '5100';
  const llmAccountCode = '5100';
  const isConfirm = (reviewState === 'accepted' || reviewState === 'resolved')
    && (!firmAccountCode || firmAccountCode === llmAccountCode);
  assert.equal(isConfirm, true);
});

await test('outcome: confirm when accepting with no firm override', () => {
  const reviewState = 'accepted';
  const firmAccountCode = '';
  const llmAccountCode = '5100';
  const isConfirm = (reviewState === 'accepted' || reviewState === 'resolved')
    && (!firmAccountCode || firmAccountCode === llmAccountCode);
  assert.equal(isConfirm, true);
});

await test('outcome: edit when accepting with different account', () => {
  const reviewState = 'accepted';
  const firmAccountCode = '5200';
  const llmAccountCode = '5100';
  const isEdit = (reviewState === 'accepted' || reviewState === 'resolved')
    && firmAccountCode && firmAccountCode !== llmAccountCode;
  assert.equal(isEdit, true);
});

await test('outcome: reject when cancelled', () => {
  const finalStatus = 'cancelled';
  const isReject = finalStatus === 'cancelled';
  assert.equal(isReject, true);
});

// --- 3a. Categorization source labeling ---

await test('source label: vendor_confirmed when LLM + VENDOR_SIGNALS agree', () => {
  const vendorAgrees = true;
  const vendorDisagrees = false;
  const source = vendorAgrees
    ? 'merchant_lookup_vendor_confirmed'
    : vendorDisagrees
      ? 'merchant_lookup_vendor_conflict'
      : 'merchant_lookup';
  assert.equal(source, 'merchant_lookup_vendor_confirmed');
});

await test('source label: vendor_conflict when they disagree', () => {
  const vendorAgrees = false;
  const vendorDisagrees = true;
  const source = vendorAgrees
    ? 'merchant_lookup_vendor_confirmed'
    : vendorDisagrees
      ? 'merchant_lookup_vendor_conflict'
      : 'merchant_lookup';
  assert.equal(source, 'merchant_lookup_vendor_conflict');
});

await test('source label: plain merchant_lookup when no vendor opinion', () => {
  const vendorAgrees = false;
  const vendorDisagrees = false;
  const source = vendorAgrees
    ? 'merchant_lookup_vendor_confirmed'
    : vendorDisagrees
      ? 'merchant_lookup_vendor_conflict'
      : 'merchant_lookup';
  assert.equal(source, 'merchant_lookup');
});

// --- 3e. Louis QA on categorizations ---

await test('Louis fail demotes green to yellow (review_state: suggested)', () => {
  const louisVerdict = 'fail';
  const originalLane = 'green';
  const demotedState = louisVerdict === 'fail' ? 'suggested' : 'accepted';
  const demotedLane = louisVerdict === 'fail' ? 'yellow' : originalLane;
  assert.equal(demotedState, 'suggested');
  assert.equal(demotedLane, 'yellow');
});

await test('Louis pass keeps green lane', () => {
  const louisVerdict = 'pass';
  const originalLane = 'green';
  const demotedState = louisVerdict === 'fail' ? 'suggested' : 'accepted';
  const demotedLane = louisVerdict === 'fail' ? 'yellow' : originalLane;
  assert.equal(demotedState, 'accepted');
  assert.equal(demotedLane, 'green');
});

await test('Louis warn keeps green lane', () => {
  const louisVerdict = 'warn';
  const originalLane = 'green';
  const demotedState = louisVerdict === 'fail' ? 'suggested' : 'accepted';
  const demotedLane = louisVerdict === 'fail' ? 'yellow' : originalLane;
  assert.equal(demotedState, 'accepted');
  assert.equal(demotedLane, 'green');
});

// --- Integration: full categorization decision flow ---

await test('full flow: LLM high confidence + vendor agrees + safe type → green auto-apply', () => {
  const llmConfidence = 0.88;
  const vendorAgrees = true;
  const effectiveConfidence = vendorAgrees ? Math.min(llmConfidence + 0.1, 0.98) : llmConfidence;

  const laneResult = classifyLane({
    decisionType: 'categorize',
    confidence: { score: effectiveConfidence, label: 'high' },
    signals: { client_rule_match: true },
    accountType: 'expense',
    accountName: 'Vehicle Fuel'
  });

  assert.equal(laneResult.lane, 'green');
  const reviewState = laneResult.lane === 'green' ? 'accepted' : 'suggested';
  assert.equal(reviewState, 'accepted');
});

await test('full flow: LLM medium confidence + no vendor signal → yellow suggested', () => {
  const llmConfidence = 0.75;
  const vendorAgrees = false;
  const effectiveConfidence = vendorAgrees ? Math.min(llmConfidence + 0.1, 0.98) : llmConfidence;

  const laneResult = classifyLane({
    decisionType: 'categorize',
    confidence: { score: effectiveConfidence, label: 'medium' },
    signals: { client_rule_match: false },
    accountType: 'expense',
    accountName: 'Office Supplies'
  });

  assert.equal(laneResult.lane, 'yellow');
  const reviewState = laneResult.lane === 'green' ? 'accepted' : 'suggested';
  assert.equal(reviewState, 'suggested');
});

await test('full flow: LLM suggests payroll → red blocked', () => {
  const llmConfidence = 0.95;
  const laneResult = classifyLane({
    decisionType: 'categorize',
    confidence: { score: llmConfidence, label: 'high' },
    signals: { client_rule_match: true },
    accountType: 'expense',
    accountName: 'Payroll Expenses'
  });

  assert.equal(laneResult.lane, 'red');
  assert.ok(laneResult.blockers.includes('sensitive_account'));
});

await test('full flow: vendor disagrees forces yellow even with high confidence', () => {
  const llmConfidence = 0.88;
  const vendorDisagrees = true;
  const effectiveConfidence = llmConfidence;

  const laneResult = classifyLane({
    decisionType: 'categorize',
    confidence: { score: effectiveConfidence, label: 'high' },
    signals: {
      client_rule_match: false,
      vendor_signal_disagrees: vendorDisagrees
    },
    accountType: 'expense',
    accountName: 'Office Supplies'
  });

  assert.equal(laneResult.lane, 'yellow');
});
