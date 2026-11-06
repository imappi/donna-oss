import test from 'node:test';
import assert from 'node:assert/strict';
import {
  OY_OWNER_TRANSACTION_TYPES,
  OY_OWNER_TRANSACTION_SPECS,
  isOwnerTransactionType,
  resolveOwnerTransactionSpec,
  classifyOwnerTransaction
} from './oyOwnerTransactionTaxonomy.js';

test('the catalog is closed and every type has a spec', () => {
  assert.equal(OY_OWNER_TRANSACTION_TYPES.length, 15, 'D-FI13-9 enumerates 15 owner-transaction types');
  assert.equal(new Set(OY_OWNER_TRANSACTION_TYPES).size, OY_OWNER_TRANSACTION_TYPES.length, 'no duplicate types');
  for (const t of OY_OWNER_TRANSACTION_TYPES) {
    const spec = OY_OWNER_TRANSACTION_SPECS[t];
    assert.ok(spec, `${t} needs a spec`);
    assert.equal(spec.type, t);
    assert.ok(['company_to_owner', 'owner_to_company', 'either'].includes(spec.direction), `${t} direction`);
    assert.ok(spec.name_fi && spec.name_en, `${t} needs both names`);
    assert.ok(Array.isArray(spec.required_evidence), `${t} required_evidence array`);
    assert.equal(typeof spec.auto_postable, 'boolean', `${t} auto_postable boolean`);
  }
  // Spec keys and the type list agree exactly (no orphan spec).
  assert.deepEqual(new Set(Object.keys(OY_OWNER_TRANSACTION_SPECS)), new Set(OY_OWNER_TRANSACTION_TYPES));
});

test('unknown_owner_transfer NEVER auto-posts and always escalates', () => {
  const spec = OY_OWNER_TRANSACTION_SPECS.unknown_owner_transfer;
  assert.equal(spec.auto_postable, false);
  assert.equal(spec.suggested_accounts, null);
  // Even with any evidence bag, it escalates — it is the safe unresolved state.
  const verdict = classifyOwnerTransaction({ type: 'unknown_owner_transfer', evidence: ['anything', 'more'] });
  assert.equal(verdict.terminal, 'escalate');
  assert.equal(verdict.type, 'unknown_owner_transfer');
  assert.ok(verdict.question_fi && verdict.question_en);
});

test('an unrecognised type collapses to unknown_owner_transfer (fail-safe, never a new category)', () => {
  assert.equal(isOwnerTransactionType('salary'), true);
  assert.equal(isOwnerTransactionType('made_up_kind'), false);
  assert.equal(resolveOwnerTransactionSpec('made_up_kind').type, 'unknown_owner_transfer');
  const verdict = classifyOwnerTransaction({ type: 'made_up_kind', evidence: ['expense_receipt'] });
  assert.equal(verdict.terminal, 'escalate');
  assert.equal(verdict.type, 'unknown_owner_transfer');
});

test('salary is never inferred — it needs a payroll package and otherwise escalates (D-FI13-16)', () => {
  const spec = OY_OWNER_TRANSACTION_SPECS.salary;
  assert.equal(spec.auto_postable, false);
  assert.deepEqual(spec.required_evidence, ['payroll_package']);
  assert.equal(spec.gated_decision, 'D-FI13-D1');
  // Even WITH a payroll package it stays escalate while D-FI13-D1 is undecided.
  const verdict = classifyOwnerTransaction({ type: 'salary', evidence: ['payroll_package'] });
  assert.equal(verdict.terminal, 'escalate');
  assert.equal(verdict.reason, 'owner_salary_requires_payroll_package');
});

test('dividend is detect-and-escalate (D-FI13-D2), never auto-posted', () => {
  const spec = OY_OWNER_TRANSACTION_SPECS.dividend;
  assert.equal(spec.auto_postable, false);
  assert.equal(spec.gated_decision, 'D-FI13-D2');
  const verdict = classifyOwnerTransaction({
    type: 'dividend',
    evidence: ['distribution_decision', 'confirmed_financial_statements', 'solvency_assessment']
  });
  assert.equal(verdict.terminal, 'escalate');
  assert.equal(verdict.reason, 'dividend_detect_and_escalate');
});

test('an evidenced expense reimbursement is proposal-able with its suggested accounts', () => {
  const verdict = classifyOwnerTransaction({ type: 'expense_reimbursement', evidence: ['expense_receipt'] });
  assert.equal(verdict.terminal, 'proposal');
  assert.equal(verdict.type, 'expense_reimbursement');
  assert.deepEqual(verdict.suggested_accounts, { debit: '7800', credit: '2766' });
  assert.deepEqual(verdict.missing_evidence, []);
});

test('a reimbursement WITHOUT its receipt escalates with the missing-evidence list', () => {
  const verdict = classifyOwnerTransaction({ type: 'expense_reimbursement', evidence: [] });
  assert.equal(verdict.terminal, 'escalate');
  assert.equal(verdict.reason, 'missing_required_evidence');
  assert.deepEqual(verdict.missing_evidence, ['expense_receipt']);
  assert.ok(/expense_receipt/.test(verdict.question_en));
});

test('an evidenced shareholder loan TO the company is proposal-able; the loan OUT is review-gated', () => {
  const inbound = classifyOwnerTransaction({ type: 'shareholder_loan_to_company', evidence: ['loan_agreement'] });
  assert.equal(inbound.terminal, 'proposal');
  assert.deepEqual(inbound.suggested_accounts, { debit: '1910', credit: '2762' });

  const outbound = classifyOwnerTransaction({ type: 'shareholder_loan_to_owner', evidence: ['loan_agreement'] });
  assert.equal(outbound.terminal, 'escalate');
  assert.equal(outbound.reason, 'shareholder_loan_out_requires_review');
});

test('an SVOP contribution posts to the SVOP reserve, not share capital', () => {
  const verdict = classifyOwnerTransaction({ type: 'svop_contribution', evidence: ['contribution_document'] });
  assert.equal(verdict.terminal, 'proposal');
  assert.equal(verdict.suggested_accounts.credit, '2110');
  // A share subscription (moves registered share capital) still escalates.
  const sub = classifyOwnerTransaction({ type: 'share_subscription', evidence: ['subscription_document'] });
  assert.equal(sub.terminal, 'escalate');
  assert.equal(sub.reason, 'share_capital_change_requires_registration');
});

test('classify accepts an evidence object (truthy keys) as well as an array', () => {
  const verdict = classifyOwnerTransaction({ type: 'travel_reimbursement', evidence: { travel_claim: true, ignored: false } });
  assert.equal(verdict.terminal, 'proposal');
  const missing = classifyOwnerTransaction({ type: 'travel_reimbursement', evidence: { travel_claim: false } });
  assert.equal(missing.terminal, 'escalate');
  assert.deepEqual(missing.missing_evidence, ['travel_claim']);
});

test('classify never throws on garbage input', () => {
  assert.doesNotThrow(() => classifyOwnerTransaction());
  assert.doesNotThrow(() => classifyOwnerTransaction({ type: null, evidence: null }));
  const v = classifyOwnerTransaction({ type: 42, evidence: 'not-an-array' });
  assert.equal(v.terminal, 'escalate');
  assert.equal(v.type, 'unknown_owner_transfer');
});
