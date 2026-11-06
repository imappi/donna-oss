// SG-3 — the GST F5 engine: period resolution, the box identities, the
// aggregation walk, blockers, the control cross-check.
// node --test server/donna/singapore/gstReturn.test.js

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SINGAPORE_GST_RETURN_FLAG_KEY,
  SINGAPORE_GST_FILING_FLAG_KEY,
  GST_RETURN_STATUSES,
  resolveGstPeriod,
  gstFilingDueDate,
  assertGstF5Foots,
  buildGstF5FromLedgerLines
} from './gstReturn.js';

test('flags + lifecycle vocabulary', () => {
  assert.equal(SINGAPORE_GST_RETURN_FLAG_KEY, 'SINGAPORE_GST_RETURN');
  assert.equal(SINGAPORE_GST_FILING_FLAG_KEY, 'SINGAPORE_GST_FILING');
  assert.deepEqual([...GST_RETURN_STATUSES], ['draft_pending_confirmation', 'filed', 'cancelled']);
});

test('period resolution: month + quarter only — Singapore has no annual GST period', () => {
  assert.deepEqual(resolveGstPeriod('2026-Q2'), {
    key: '2026-Q2', type: 'quarter', starts_on: '2026-04-01', ends_on: '2026-06-30'
  });
  assert.deepEqual(resolveGstPeriod('2026-02'), {
    key: '2026-02', type: 'month', starts_on: '2026-02-01', ends_on: '2026-02-28'
  });
  assert.equal(resolveGstPeriod('2024-02').ends_on, '2024-02-29', 'leap-aware');
  assert.throws(() => resolveGstPeriod('2026'), (e) => e.code === 'SINGAPORE_GST_PERIOD_INVALID');
  assert.throws(() => resolveGstPeriod('2026-Q5'), (e) => e.code === 'SINGAPORE_GST_PERIOD_INVALID');
  assert.throws(() => resolveGstPeriod('junk'), /YYYY-MM or YYYY-QN/);
});

test('the F5 due date is one month after period end', () => {
  assert.equal(gstFilingDueDate(resolveGstPeriod('2026-Q2')), '2026-07-31');
  assert.equal(gstFilingDueDate(resolveGstPeriod('2026-Q4')), '2027-01-31');
  assert.equal(gstFilingDueDate(resolveGstPeriod('2026-01')), '2026-02-28');
  assert.equal(gstFilingDueDate({}), null);
});

test('assertGstF5Foots enforces BOTH identities (box 4 = 1+2+3; box 8 = 6−7 = payable)', () => {
  const good = { boxes: { 1: 1000, 2: 200, 3: 0, 4: 1200, 5: 500, 6: 90, 7: 45, 8: 45, 9: 0, 13: 1200, 14: 0 }, payable: 45 };
  assert.equal(assertGstF5Foots(good), true);
  assert.throws(
    () => assertGstF5Foots({ boxes: { ...good.boxes, 4: 999 }, payable: 45 }),
    (e) => e.code === 'SINGAPORE_GST_RETURN_MISFOOT'
  );
  assert.throws(
    () => assertGstF5Foots({ boxes: { ...good.boxes }, payable: 44 }),
    (e) => e.code === 'SINGAPORE_GST_RETURN_MISFOOT'
  );
});

const lines = (rows) => rows.map((row, i) => ({ journal_id: `j${i}`, line_no: i, ...row }));

test('the aggregation: standard supplies + purchases + zero-rated + RC land in the right boxes and foot', () => {
  const { gstReturn, review, period } = buildGstF5FromLedgerLines({
    period: '2026-Q2',
    lines: lines([
      // Standard-rated revenue, net base 10,000 → box 1, output tax 900 → box 6.
      { account_type: 'revenue', account_code: '3000', tax_type: 'GST_SR_9_OUTPUT', credit: 10000, debit: 0 },
      // Split control leg for that output tax (role-marked).
      { account_type: 'liability', account_code: '2950', role: 'gst_output', credit: 900, debit: 0 },
      // Zero-rated export revenue → box 2 only.
      { account_type: 'revenue', account_code: '3200', tax_type: 'GST_ZR_OUTPUT', credit: 5000, debit: 0 },
      // Standard-rated purchase, net base 2,000 → box 5, input tax 180 → box 7.
      { account_type: 'expense', account_code: '7000', tax_type: 'GST_SR_9_INPUT', debit: 2000, credit: 0 },
      { account_type: 'liability', account_code: '2951', role: 'gst_input_claimable', debit: 180, credit: 0 },
      // IRAS Completing GST Return (2026-09-24), boxes 1/5/14 and 7:
      // https://www.iras.gov.sg/taxes/goods-services-tax-(gst)/filing-gst/completing-gst-returns
      // RC base 1,000 → 1/5/14; output 90 → 6; recovery requires assessment.
      { account_type: 'expense', account_code: '4400', tax_type: 'GST_RC_IMPORTED_SERVICES', debit: 1000, credit: 0 }
    ])
  });
  assert.equal(period.key, '2026-Q2');
  assert.equal(gstReturn.boxes['1'], 11000);
  assert.equal(gstReturn.boxes['2'], 5000);
  assert.equal(gstReturn.boxes['4'], 16000);
  assert.equal(gstReturn.boxes['5'], 3000);
  assert.equal(gstReturn.boxes['6'], 990, 'output 900 + RC self-assessed 90');
  assert.equal(gstReturn.boxes['7'], 180, 'no automatic full RC credit');
  assert.equal(gstReturn.boxes['8'], 810);
  assert.equal(gstReturn.payable, 810);
  assert.equal(gstReturn.boxes['13'], 15000, 'box 13 revenue = accounting revenue');
  assert.equal(gstReturn.boxes['14'], 1000);
  assert.equal(gstReturn.nilReturn, false);
  assert.equal(gstReturn.fullInputTaxCreditAssumed, false);
  assert.equal(review.status, 'needs_review');
  assert.deepEqual(review.blockers, ['reverse_charge_input_tax_assessment_required']);
  assert.equal(review.inputTaxAssessmentLines[0].tax_type, 'GST_RC_IMPORTED_SERVICES');
  assert.equal(review.inputTaxAssessmentLines[0].amount, 1000);
  assert.equal(review.controlCheck.ran, true);
  assert.equal(review.controlCheck.outputTax.expected, 900, 'RC tax excluded from the split-leg expectation');
  assert.equal(review.controlCheck.outputTax.actual, 900);
});

test('uncoded revenue blocks; uncoded expense only counts; a nil period is a VALID return', () => {
  const { gstReturn, review } = buildGstF5FromLedgerLines({
    period: '2026-Q1',
    lines: lines([
      { account_type: 'revenue', account_code: '3000', tax_type: null, credit: 500, debit: 0 },
      { account_type: 'expense', account_code: '7000', tax_type: '', debit: 120, credit: 0 }
    ])
  });
  assert.equal(review.status, 'needs_review');
  assert.deepEqual(review.blockers, ['uncoded_revenue_lines']);
  assert.equal(review.uncodedRevenueLines.length, 1);
  assert.equal(review.uncodedExpenseLineCount, 1);
  assert.equal(gstReturn.boxes['13'], 500, 'box 13 still reports the accounting revenue');

  const nil = buildGstF5FromLedgerLines({ period: '2026-Q1', lines: [] });
  assert.equal(nil.gstReturn.nilReturn, true);
  assert.equal(nil.gstReturn.payable, 0);
  assert.equal(nil.review.status, 'ready', 'a nil F5 is a valid return, never a blocker');
});

test('code↔account incompatibility + control-account codes block; unmarked control movement is INFO', () => {
  const { review } = buildGstF5FromLedgerLines({
    period: '2026-Q1',
    lines: lines([
      // An output code on an expense account — incompatible.
      { account_type: 'expense', account_code: '7000', tax_type: 'GST_SR_9_OUTPUT', debit: 100, credit: 0 },
      // A GST code resting on a control account — incompatible.
      { account_type: 'liability', account_code: '2950', tax_type: 'GST_SR_9_INPUT', debit: 50, credit: 0 },
      // Unmarked movement on a control account (the IRAS settlement) — INFO only.
      { account_type: 'liability', account_code: '2950', tax_type: null, debit: 700, credit: 0 }
    ])
  });
  assert.ok(review.blockers.includes('incompatible_tax_lines'));
  assert.equal(review.incompatibleLines.length, 2);
  assert.equal(review.controlCheck.unmarkedControlMovement, 700);
});

test('the control cross-check blocks when the posted legs disagree with the computed boxes', () => {
  const { review } = buildGstF5FromLedgerLines({
    period: '2026-Q1',
    lines: lines([
      { account_type: 'revenue', account_code: '3000', tax_type: 'GST_SR_9_OUTPUT', credit: 10000, debit: 0 },
      // The split leg posted only 500 against a computed 900 — a broken split.
      { account_type: 'liability', account_code: '2950', role: 'gst_output', credit: 500, debit: 0 }
    ])
  });
  assert.ok(review.blockers.includes('control_account_mismatch'));
  assert.equal(review.controlCheck.outputTax.expected, 900);
  assert.equal(review.controlCheck.outputTax.actual, 500);
});

test('credit notes net out via signed bases; refunds flip the payable sign', () => {
  const { gstReturn } = buildGstF5FromLedgerLines({
    period: '2026-Q1',
    lines: lines([
      { account_type: 'revenue', account_code: '3000', tax_type: 'GST_SR_9_OUTPUT', credit: 1000, debit: 0 },
      // A credit note reversing 400 of it.
      { account_type: 'revenue', account_code: '3000', tax_type: 'GST_SR_9_OUTPUT', debit: 400, credit: 0 },
      { account_type: 'expense', account_code: '7000', tax_type: 'GST_SR_9_INPUT', debit: 5000, credit: 0 }
    ])
  });
  assert.equal(gstReturn.boxes['1'], 600);
  assert.equal(gstReturn.boxes['6'], 54);
  assert.equal(gstReturn.boxes['7'], 450);
  assert.equal(gstReturn.payable, -396);
  assert.equal(gstReturn.refund, true);
});

// Regression: even offsetting RC entries need an input-tax eligibility assessment.
// IRAS Completing GST Return, boxes 7/14; retrieved 2026-09-24 (URL above).
test('offsetting reverse-charge purchases cannot silently erase recovery review', () => {
  const result = buildGstF5FromLedgerLines({ period: '2026-Q2', lines: lines([
    { account_type: 'expense', tax_type: 'GST_RC_IMPORTED_SERVICES', debit: 1000, credit: 0 },
    { account_type: 'expense', tax_type: 'GST_RC_IMPORTED_SERVICES', debit: 0, credit: 1000 }
  ]) });
  assert.equal(result.gstReturn.boxes['14'], 0);
  assert.equal(result.review.status, 'needs_review');
  assert.equal(result.review.inputTaxAssessmentLines.length, 2);
});

// Independent oracle: hand-written expectations, not derived from the tables under test.
const NTC_ACCOUNTS = [
  { id: 'a-exp', code: '7000', name: 'Rent', account_type: 'expense' },
  { id: 'a-bank', code: '1910', name: 'Bank', account_type: 'asset' },
  { id: 'a-rev', code: '6000', name: 'Sales', account_type: 'revenue' },
  { id: 'a-sales', code: '6100', name: 'Sales', account_type: 'sales' }
];

test('gross-coded posted expenses are a non-computation: needs_review, not ready nil', () => {
  const r = buildGstF5FromLedgerLines({ period: '2026-Q3', accounts: NTC_ACCOUNTS, lines: [
    { account_id: 'a-exp', account_code: '7000', debit: 1090, credit: 0, tax_type: 'INPUTY24' },
    { account_id: 'a-bank', account_code: '1910', debit: 0, credit: 1090, tax_type: '' },
    { account_id: 'a-exp', account_code: '7000', debit: 218, credit: 0, tax_type: 'INPUTY24' },
    { account_id: 'a-bank', account_code: '1910', debit: 0, credit: 218, tax_type: '' }
  ] });
  assert.equal(r.review.status, 'needs_review');
  assert.deepEqual(r.review.blockers, ['gst_not_coded_at_posting']);
  assert.equal(r.review.uncodedPnlLineCount, 2);
  assert.equal(r.gstReturn.nilReturn, true);
});

test('revenue on a Xero-style account type is classified once (box 13 counts it); a truly unknown type still blocks', () => {
  // F-7: 'sales' / 'otherincome' / 'REVENUE' are revenue, 'OVERHEADS' is expense — normalised
  // once in the calculator, so uncoded sales are named revenue lines, never silently dropped.
  const r = buildGstF5FromLedgerLines({ period: '2026-Q3', accounts: NTC_ACCOUNTS, lines: [
    { account_id: 'a-sales', account_code: '6100', debit: 0, credit: 500, tax_type: '' },
    { account_id: 'a-bank', account_code: '1910', debit: 500, credit: 0, tax_type: '' }
  ] });
  assert.equal(r.review.status, 'needs_review');
  assert.deepEqual(r.review.blockers, ['uncoded_revenue_lines']);
  assert.equal(r.review.unclassifiedUncodedLineCount, 0);
  assert.equal(r.gstReturn.boxes['13'], 500);
  const unknown = buildGstF5FromLedgerLines({ period: '2026-Q3', lines: [
    { account_code: '99999', account_type: 'mystery', debit: 10, credit: 0, tax_type: '' }
  ] });
  assert.deepEqual(unknown.review.blockers, ['gst_not_coded_at_posting']);
});

test('F-7: coded revenue counts in box 13 on sales / otherincome / REVENUE types; coded lines on an unclassified type block', () => {
  const book = (revenueType, expenseType = 'OVERHEADS') => buildGstF5FromLedgerLines({ period: '2026-Q2', lines: [
    { account_code: '4000', account_type: revenueType, debit: 0, credit: 1000, tax_type: 'GST_SR_9_OUTPUT' },
    { account_code: '2950', account_type: 'liability', role: 'gst_output', debit: 0, credit: 90, tax_type: '' },
    { account_code: '6000', account_type: expenseType, debit: 500, credit: 0, tax_type: 'GST_SR_9_INPUT' },
    { account_code: '2960', account_type: 'liability', role: 'gst_input_claimable', debit: 45, credit: 0, tax_type: '' }
  ] });
  for (const type of ['revenue', 'sales', 'otherincome', 'REVENUE', 'Sales']) {
    const r = book(type);
    assert.equal(r.gstReturn.boxes['13'], 1000, type);
    assert.equal(r.gstReturn.boxes['5'], 500, type);
    assert.equal(r.review.status, 'ready', `${type}: ${r.review.blockers}`);
  }
  const unclassified = book('mystery');
  assert.equal(unclassified.review.status, 'needs_review');
  assert.ok(unclassified.review.blockers.includes('incompatible_tax_lines'));
  assert.equal(unclassified.review.incompatibleLines.length, 1);
});

test('genuine nil periods stay ready: no activity, or balance-sheet-only movement', () => {
  const none = buildGstF5FromLedgerLines({ period: '2026-Q3', accounts: NTC_ACCOUNTS, lines: [] });
  assert.equal(none.review.status, 'ready');
  assert.equal(none.gstReturn.nilReturn, true);
  const bsOnly = buildGstF5FromLedgerLines({ period: '2026-Q3', accounts: NTC_ACCOUNTS, lines: [
    { account_id: 'a-bank', account_code: '1910', debit: 100, credit: 0, tax_type: '' }
  ] });
  assert.equal(bsOnly.review.status, 'ready');
});

test('a coded book with some gross expenses stays ready (info count only) once the input side is coded', () => {
  const r = buildGstF5FromLedgerLines({ period: '2026-Q3', accounts: NTC_ACCOUNTS, lines: [
    { account_id: 'a-rev', account_code: '6000', debit: 0, credit: 1000, tax_type: 'GST_SR_9_OUTPUT' },
    { account_code: '2950', account_type: 'liability', role: 'gst_output', debit: 0, credit: 90, tax_type: '' },
    { account_id: 'a-exp', account_code: '7000', debit: 100, credit: 0, tax_type: 'GST_SR_9_INPUT' },
    { account_code: '2960', account_type: 'liability', role: 'gst_input_claimable', debit: 9, credit: 0, tax_type: '' },
    { account_id: 'a-exp', account_code: '7000', debit: 15, credit: 0, tax_type: '' }
  ] });
  assert.equal(r.review.status, 'ready');
  assert.equal(r.review.uncodedExpenseLineCount, 1);
  assert.equal(r.gstReturn.boxes['6'], 90); // 1000 x 9%
});

test('F-8: one coded sale beside uncoded gross expenses is a gross-only book, not a ready return', () => {
  const lines = [
    { account_id: 'a-rev', account_code: '6000', debit: 0, credit: 1000, tax_type: 'GST_SR_9_OUTPUT' },
    { account_code: '2950', account_type: 'liability', role: 'gst_output', debit: 0, credit: 90, tax_type: '' },
    ...Array.from({ length: 40 }, () => ({ account_id: 'a-exp', account_code: '7000', debit: 10.9, credit: 0, tax_type: '' }))
  ];
  const r = buildGstF5FromLedgerLines({ period: '2026-Q3', accounts: NTC_ACCOUNTS, lines });
  assert.equal(r.review.status, 'needs_review');
  assert.deepEqual(r.review.blockers, ['gst_not_coded_at_posting']);
  assert.equal(r.gstReturn.boxes['5'], 0);
});

test('F-8: depreciation-only and FX-revaluation-only quarters are ready nil returns', () => {
  const dep = buildGstF5FromLedgerLines({ period: '2026-Q3', lines: [
    { account_code: '6800', account_type: 'expense', debit: 300, credit: 0, tax_type: '' },
    { account_code: '1180', account_type: 'tangible_asset', debit: 0, credit: 300, tax_type: '' }
  ] });
  assert.equal(dep.review.status, 'ready');
  assert.equal(dep.gstReturn.nilReturn, true);
  const fx = buildGstF5FromLedgerLines({ period: '2026-Q3', lines: [
    { account_code: '8100', account_type: 'expense', canonical_role: 'expense.fx', debit: 40, credit: 0, tax_type: '' },
    { account_code: '1910', account_type: 'asset', debit: 0, credit: 40, tax_type: '' }
  ] });
  assert.equal(fx.review.status, 'ready');
  // Neighbour: an ordinary uncoded expense in the same otherwise-empty quarter still blocks.
  const fee = buildGstF5FromLedgerLines({ period: '2026-Q3', lines: [
    { account_code: '7000', account_type: 'expense', debit: 15, credit: 0, tax_type: '' },
    { account_code: '1910', account_type: 'asset', debit: 0, credit: 15, tax_type: '' }
  ] });
  assert.deepEqual(fee.review.blockers, ['gst_not_coded_at_posting']);
});

test('F-8: a P&L fully coded out-of-scope / no-GST plus one uncoded fee is a legitimate nil return', () => {
  const r = buildGstF5FromLedgerLines({ period: '2026-Q3', lines: [
    { account_code: '7000', account_type: 'expense', debit: 200, credit: 0, tax_type: 'GST_OUT_OF_SCOPE' },
    { account_code: '7100', account_type: 'expense', debit: 80, credit: 0, tax_type: 'GST_NO_GST_INPUT' },
    { account_code: '7200', account_type: 'expense', debit: 15, credit: 0, tax_type: '' }
  ] });
  assert.equal(r.review.status, 'ready');
  assert.equal(r.gstReturn.nilReturn, true);
  assert.equal(r.review.uncodedExpenseLineCount, 1);
});

test('F-5: import GST is never inferred as 9% of the ledger expense — imports block and stay out of box 7', () => {
  const imp = buildGstF5FromLedgerLines({ period: '2026-Q2', lines: [
    { journal_id: 'j-imp', line_no: 1, account_code: '5000', account_type: 'expense', debit: 1000, credit: 0, tax_type: 'GST_IMPORT_TAXABLE' }
  ] });
  assert.equal(imp.review.status, 'needs_review');
  assert.deepEqual(imp.review.blockers, ['reverse_charge_input_tax_assessment_required']);
  assert.equal(imp.review.inputTaxAssessmentLines.length, 1);
  assert.equal(imp.review.inputTaxAssessmentLines[0].tax_type, 'GST_IMPORT_TAXABLE');
  assert.equal(imp.gstReturn.boxes['7'], 0, 'no 9% x ledger expense credit');
  assert.equal(imp.gstReturn.fullInputTaxCreditAssumed, false);
  // Neighbour: an ordinary standard-rated purchase stays ready with box 7 = 9%.
  const ok = buildGstF5FromLedgerLines({ period: '2026-Q2', lines: [
    { account_code: '5000', account_type: 'expense', debit: 1000, credit: 0, tax_type: 'GST_SR_9_INPUT' },
    { account_code: '2960', account_type: 'liability', role: 'gst_input_claimable', debit: 90, credit: 0, tax_type: '' }
  ] });
  assert.equal(ok.review.status, 'ready');
  assert.equal(ok.gstReturn.boxes['7'], 90);
});

test('F-13: the control tolerance grows 0.5c per leg, so a wrong leg in a big book cannot hide', () => {
  const sale = { account_code: '4000', account_type: 'revenue', debit: 0, tax_type: 'GST_SR_9_OUTPUT' };
  const leg = (credit) => ({ account_code: '2950', account_type: 'liability', role: 'gst_output', debit: 0, credit, tax_type: '' });
  // 500 sales of 100.00 (9.00 output tax each) with their 500 GST legs.
  const book = (wrongLegCredit) => buildGstF5FromLedgerLines({ period: '2026-Q2', lines: Array.from({ length: 500 }, (_, i) =>
    [{ ...sale, credit: 100 }, leg(i === 0 && wrongLegCredit != null ? wrongLegCredit : 9)]).flat() });
  assert.equal(book().review.status, 'ready');
  // One leg posted 4.01 instead of 9.00: legs 4495.01 vs box 6 4500.00 — inside the OLD tolerance
  // (max(0.02, 0.01 x 500) = 5) and inside no honest rounding drift.
  const bad = book(4.01);
  assert.ok(bad.review.blockers.includes('control_account_mismatch'));
  assert.equal(bad.review.controlCheck.tolerance, 2.51);
  // Legitimately rounded 500-leg book: every 10.05 sale carries a 0.90 leg (true tax 0.9045, so
  // 0.0045 honest drift per leg, 2.25 in total) — inside 0.005 x N + 0.01 and stays ready.
  const rounded = buildGstF5FromLedgerLines({ period: '2026-Q2', lines: Array.from({ length: 500 }, () =>
    [{ ...sale, credit: 10.05 }, leg(0.9)]).flat() });
  assert.equal(rounded.review.status, 'ready', String(rounded.review.blockers));
});

test('F-16: a credit-note-only quarter (negative boxes) needs review; a refund quarter (box 8 < 0 only) stays ready', () => {
  const credit = buildGstF5FromLedgerLines({ period: '2026-Q2', lines: [
    { account_code: '4000', account_type: 'revenue', debit: 1000, credit: 0, tax_type: 'GST_SR_9_OUTPUT' },
    { account_code: '2950', account_type: 'liability', role: 'gst_output', debit: 90, credit: 0, tax_type: '' }
  ] });
  assert.equal(credit.review.status, 'needs_review');
  assert.deepEqual(credit.review.blockers, ['negative_return_box']);
  assert.deepEqual(credit.review.negativeBoxes, ['1', '6']);
  const refund = buildGstF5FromLedgerLines({ period: '2026-Q2', lines: [
    { account_code: '5000', account_type: 'expense', debit: 1000, credit: 0, tax_type: 'GST_SR_9_INPUT' },
    { account_code: '2960', account_type: 'liability', role: 'gst_input_claimable', debit: 90, credit: 0, tax_type: '' }
  ] });
  assert.equal(refund.review.status, 'ready');
  assert.equal(refund.gstReturn.refund, true);
});
