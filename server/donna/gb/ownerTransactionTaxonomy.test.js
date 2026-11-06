import test from 'node:test';
import assert from 'node:assert/strict';

import {
  GB_OWNER_TRANSACTION_PROVENANCE,
  GB_OWNER_TRANSACTION_SPECS,
  GB_OWNER_TRANSACTION_TAXONOMY_FLAG_KEY,
  GB_OWNER_TRANSACTION_TYPES,
  classifyOwnerTransaction,
  directorsLoanAccountWatch,
  gbOwnerTransactionTaxonomyEnabled,
  isOwnerTransactionType,
  resolveOwnerTransactionSpec
} from './ownerTransactionTaxonomy.js';

test('catalog is closed and complete', () => {
  assert.deepEqual(GB_OWNER_TRANSACTION_TYPES, [
    'director_salary', 'expense_reimbursement', 'mileage_reimbursement', 'dividend',
    'directors_loan_advance', 'directors_loan_from_director', 'directors_loan_repayment_by_director',
    'loan_repayment_to_director', 'interest_to_director', 'share_subscription',
    'capital_reduction_return', 'related_party_purchase', 'related_party_sale', 'unknown_owner_transfer'
  ]);
  for (const type of GB_OWNER_TRANSACTION_TYPES) assert.equal(GB_OWNER_TRANSACTION_SPECS[type].type, type);
  assert.equal(Object.keys(GB_OWNER_TRANSACTION_SPECS).length, 14);
});

test('isOwnerTransactionType accepts only catalog members', () => {
  assert.equal(isOwnerTransactionType('dividend'), true);
  assert.equal(isOwnerTransactionType('nope'), false);
  assert.equal(isOwnerTransactionType(null), false);
  assert.equal(isOwnerTransactionType(1), false);
});

test('resolveOwnerTransactionSpec safely resolves an unknown type', () => {
  assert.equal(resolveOwnerTransactionSpec('nope'), GB_OWNER_TRANSACTION_SPECS.unknown_owner_transfer);
  assert.equal(resolveOwnerTransactionSpec(null), GB_OWNER_TRANSACTION_SPECS.unknown_owner_transfer);
});

test('expense reimbursement proposes when evidenced', () => {
  const result = classifyOwnerTransaction({ type: 'expense_reimbursement', evidence: ['expense_receipt'] });
  assert.equal(result.terminal, 'proposal');
  assert.deepEqual(result.suggested_accounts, { debit: '6900', credit: '2240' });
  assert.deepEqual(result.missing_evidence, []);
});

test('mileage reimbursement proposes when evidenced', () => {
  const result = classifyOwnerTransaction({ type: 'mileage_reimbursement', evidence: ['mileage_claim'] });
  assert.equal(result.terminal, 'proposal');
  assert.deepEqual(result.suggested_accounts, { debit: '6400', credit: '2240' });
});

test('missing evidence escalates with an owner question', () => {
  const result = classifyOwnerTransaction({ type: 'expense_reimbursement', evidence: [] });
  assert.equal(result.terminal, 'escalate');
  assert.equal(result.reason, 'missing_required_evidence');
  assert.deepEqual(result.missing_evidence, ['expense_receipt']);
  assert.match(result.question_en, /expense_receipt/);
});

test("director's loan from director proposes when evidenced", () => {
  const result = classifyOwnerTransaction({ type: 'directors_loan_from_director', evidence: ['loan_record'] });
  assert.equal(result.terminal, 'proposal');
  assert.deepEqual(result.suggested_accounts, { debit: '1400', credit: '2240' });
});

test("director's loan advance always escalates", () => {
  const result = classifyOwnerTransaction({ type: 'directors_loan_advance', evidence: ['loan_record'] });
  assert.equal(result.terminal, 'escalate');
  assert.equal(result.reason, 'directors_loan_advance_requires_review');
  assert.deepEqual(result.missing_evidence, []);
});

test('dividend detect-and-escalates when fully evidenced', () => {
  const result = classifyOwnerTransaction({ type: 'dividend', evidence: ['board_minute', 'dividend_voucher', 'distributable_profits_confirmation'] });
  assert.equal(result.terminal, 'escalate');
  assert.equal(result.reason, 'dividend_detect_and_escalate');
  assert.equal(result.spec.gated_decision, 'GB-DIR-D2');
});

test('director salary remains gated and is never inferred', () => {
  const result = classifyOwnerTransaction({ type: 'director_salary', evidence: ['payroll_rti_submission'] });
  assert.equal(result.terminal, 'escalate');
  assert.equal(result.reason, 'owner_salary_requires_payroll');
  assert.equal(result.spec.gated_decision, 'GB-DIR-D1');
});

test('truthy object keys are accepted as evidence', () => {
  assert.equal(classifyOwnerTransaction({ type: 'expense_reimbursement', evidence: { expense_receipt: true } }).terminal, 'proposal');
});

test('unknown explicit transfer is the safe terminal', () => {
  const result = classifyOwnerTransaction({ type: 'whatever' });
  assert.equal(result.terminal, 'escalate');
  assert.equal(result.type, 'unknown_owner_transfer');
  assert.equal(result.reason, 'owner_transfer_unresolved');
  assert.match(result.question_en, /isn't identified/);
});

test('missing type is the safe terminal and never throws', () => {
  const result = classifyOwnerTransaction();
  assert.equal(result.terminal, 'escalate');
  assert.equal(result.type, 'unknown_owner_transfer');
  assert.equal(result.reason, 'owner_transfer_unresolved');
});

test('DLA watch flags s455 and beneficial-loan attention over £10,000', () => {
  const result = directorsLoanAccountWatch({ balance: 12000 });
  assert.equal(result.overdrawn, true);
  assert.equal(result.s455_attention, true);
  assert.equal(result.beneficial_loan_attention, true);
  assert.deepEqual(result.watches.map(({ code }) => code), ['GB_DLA_S455_ATTENTION', 'GB_DLA_BENEFICIAL_LOAN_ATTENTION']);
});

test('DLA watch flags only s455 attention below £10,000', () => {
  const result = directorsLoanAccountWatch({ balance: 4000 });
  assert.equal(result.s455_attention, true);
  assert.equal(result.beneficial_loan_attention, false);
  assert.deepEqual(result.watches.map(({ code }) => code), ['GB_DLA_S455_ATTENTION']);
});

test('DLA watch leaves in-credit and nil accounts clear', () => {
  for (const balance of [-500, 0]) {
    const result = directorsLoanAccountWatch({ balance });
    assert.equal(result.overdrawn, false);
    assert.equal(result.s455_attention, false);
    assert.equal(result.beneficial_loan_attention, false);
    assert.deepEqual(result.watches, []);
  }
});

test('config-plane flag is born off and canary-enabled per client', () => {
  assert.equal(GB_OWNER_TRANSACTION_TAXONOMY_FLAG_KEY, 'GB_OWNER_TRANSACTION_TAXONOMY');
  assert.equal(gbOwnerTransactionTaxonomyEnabled({}), false);
  assert.equal(gbOwnerTransactionTaxonomyEnabled({ snapshot: { GB_OWNER_TRANSACTION_TAXONOMY: { stage: 'auto' } } }), true);
});

test('statutory provenance remains explicitly unverified and noted', () => {
  assert.equal(GB_OWNER_TRANSACTION_PROVENANCE.confirmedAgainstPrimary, false);
  for (const rule of Object.values(GB_OWNER_TRANSACTION_PROVENANCE.rules)) assert.ok(rule.note);
  assert.equal(GB_OWNER_TRANSACTION_PROVENANCE.rules.s455_rate.value, 0.3375);
  assert.equal(GB_OWNER_TRANSACTION_PROVENANCE.rules.beneficial_loan_threshold_gbp.value, 10000);
  assert.ok(GB_OWNER_TRANSACTION_PROVENANCE.verificationNote);
});

// ── The sole-trader axis (row 3 — the drawings taxonomy) ─────────────────────

import {
  GB_SOLE_TRADER_OWNER_TRANSACTION_SPECS,
  GB_SOLE_TRADER_OWNER_TRANSACTION_TYPES,
  soleTraderOwnerEquityWatch
} from './ownerTransactionTaxonomy.js';
import { GB_SOLE_TRADER_DEFAULT_CHART } from './defaultChart.js';

const ST = { entityAxis: 'sole_trader' };

test('sole-trader catalog is closed, complete, and carries NO company-only machinery', () => {
  assert.deepEqual([...GB_SOLE_TRADER_OWNER_TRANSACTION_TYPES].sort(), Object.keys(GB_SOLE_TRADER_OWNER_TRANSACTION_SPECS).sort());
  for (const spec of Object.values(GB_SOLE_TRADER_OWNER_TRANSACTION_SPECS)) {
    assert.ok(['company_to_owner', 'owner_to_company', 'either'].includes(spec.direction), spec.type);
    assert.ok(Array.isArray(spec.required_evidence), spec.type);
    assert.equal(typeof spec.auto_postable, 'boolean', spec.type);
    if (spec.auto_postable) assert.ok(spec.suggested_accounts?.debit && spec.suggested_accounts?.credit, `${spec.type}: an auto-postable spec names both legs`);
    else assert.ok(spec.escalation_reason || spec.type === 'unknown_owner_transfer', spec.type);
  }
  for (const companyOnly of ['dividend', 'director_salary', 'directors_loan_advance', 'share_subscription']) {
    assert.ok(!GB_SOLE_TRADER_OWNER_TRANSACTION_SPECS[companyOnly], `${companyOnly} must not exist for an unincorporated owner`);
  }
});

test('drawings and capital introduced propose with no evidence — mechanical equity movements once typed', () => {
  const drawings = classifyOwnerTransaction({ type: 'owner_drawings', ...ST });
  assert.equal(drawings.terminal, 'proposal');
  assert.deepEqual(drawings.suggested_accounts, { debit: '2010', credit: '1400' });
  const capital = classifyOwnerTransaction({ type: 'owner_capital_introduced', ...ST });
  assert.equal(capital.terminal, 'proposal');
  assert.deepEqual(capital.suggested_accounts, { debit: '1400', credit: '2000' });
});

test('the taxonomy default codes agree with the sole-trader default chart roles — a drift here is a real bug', () => {
  const byCode = new Map(GB_SOLE_TRADER_DEFAULT_CHART.map((a) => [a.code, a]));
  assert.equal(byCode.get('2010').canonical_role, 'equity.owner_drawings');
  assert.equal(byCode.get('2000').canonical_role, 'equity.owner_capital');
  assert.equal(byCode.get('1400').canonical_role, 'asset.cash');
});

test('expense paid personally: proposes with a receipt, escalates without one', () => {
  const evidenced = classifyOwnerTransaction({ type: 'business_expense_paid_personally', evidence: ['expense_receipt'], ...ST });
  assert.equal(evidenced.terminal, 'proposal');
  assert.deepEqual(evidenced.suggested_accounts, { debit: '6900', credit: '2000' });
  const bare = classifyOwnerTransaction({ type: 'business_expense_paid_personally', ...ST });
  assert.equal(bare.terminal, 'escalate');
  assert.equal(bare.reason, 'missing_required_evidence');
  assert.deepEqual(bare.missing_evidence, ['expense_receipt']);
});

test('mileage claim proposes when evidenced', () => {
  const result = classifyOwnerTransaction({ type: 'mileage_claim', evidence: { mileage_claim: true }, ...ST });
  assert.equal(result.terminal, 'proposal');
  assert.deepEqual(result.suggested_accounts, { debit: '6400', credit: '2000' });
});

test('goods taken for own use ALWAYS escalates — the VAT deemed-supply hazard is named, never guessed', () => {
  const result = classifyOwnerTransaction({ type: 'goods_own_use', evidence: ['anything'], ...ST });
  assert.equal(result.terminal, 'escalate');
  assert.equal(result.reason, 'own_use_vat_deemed_supply_review');
  assert.match(result.question_en, /deemed supply|VAT/i);
  assert.ok(GB_OWNER_TRANSACTION_PROVENANCE.rules.own_use_goods_vat_deemed_supply.note);
});

test('a company-only type on a sole-trader book escalates as MIS-TYPED, never coerced', () => {
  const result = classifyOwnerTransaction({ type: 'dividend', evidence: ['board_minute'], ...ST });
  assert.equal(result.terminal, 'escalate');
  assert.equal(result.reason, 'sole_trader_type_unavailable');
  assert.equal(result.mistyped_as, 'dividend');
  assert.match(result.question_en, /isn't available to a sole trader/);
});

test('a sole-trader type on the company axis escalates symmetrically — including on the axis-less legacy call shape', () => {
  for (const call of [{ type: 'owner_drawings', entityAxis: 'ltd' }, { type: 'owner_drawings' }]) {
    const result = classifyOwnerTransaction(call);
    assert.equal(result.terminal, 'escalate');
    assert.equal(result.reason, 'ltd_type_unavailable');
    assert.equal(result.mistyped_as, 'owner_drawings');
  }
});

test('an unidentified sole-trader transfer asks the sole-trader question', () => {
  const result = classifyOwnerTransaction({ type: 'something-else', ...ST });
  assert.equal(result.terminal, 'escalate');
  assert.equal(result.type, 'unknown_owner_transfer');
  assert.match(result.question_en, /drawings, capital you put in/);
});

test('sole-trader axis narrows helpers too: isOwnerTransactionType and resolveOwnerTransactionSpec dispatch by axis', () => {
  assert.equal(isOwnerTransactionType('owner_drawings', ST), true);
  assert.equal(isOwnerTransactionType('dividend', ST), false);
  assert.equal(isOwnerTransactionType('owner_drawings'), false, 'the axis-less legacy shape stays the company table');
  assert.equal(resolveOwnerTransactionSpec('owner_drawings', ST).direction, 'company_to_owner');
  assert.equal(resolveOwnerTransactionSpec('nonsense', ST).type, 'unknown_owner_transfer');
});

test('the owner-equity watch is advisory: negative equity gets the attention row, positive gets silence, and nothing blocks', () => {
  const overdrawn = soleTraderOwnerEquityWatch({ equityBalance: -1250.5 });
  assert.equal(overdrawn.overdrawn, true);
  assert.deepEqual(overdrawn.watches.map((w) => w.code), ['GB_ST_NEGATIVE_OWNER_EQUITY_ATTENTION']);
  assert.match(overdrawn.watches[0].note, /Advisory, not statutory/);
  const healthy = soleTraderOwnerEquityWatch({ equityBalance: 900 });
  assert.equal(healthy.overdrawn, false);
  assert.deepEqual(healthy.watches, []);
});
