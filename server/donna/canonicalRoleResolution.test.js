import test from 'node:test';
import assert from 'node:assert/strict';

import {
  planCanonicalRoleResolution,
  isSingletonRole,
  POSTING_SINGLETON_ROLES,
  ROLE_RESOLUTION_REFUSALS,
  ROLE_RESOLUTION_TERMINALS
} from './canonicalRoleResolution.js';

// A GB chart shaped like the real ambiguity: two accounts that both look like
// "tax payable" to anything working from names, which is exactly why
// backfill_gb_sales_tax_roles.js refuses to choose between them.
const GB_CHART = [
  { id: 'a-1200', code: '1200', name: 'Bank current account', account_type: 'bank', normal_balance: 'debit', canonical_role: null },
  { id: 'a-1100', code: '1100', name: 'Trade debtors', account_type: 'asset', normal_balance: 'debit', canonical_role: null },
  { id: 'a-2220', code: '2220', name: 'VAT control', account_type: 'liability', normal_balance: 'credit', canonical_role: null },
  { id: 'a-2230', code: '2230', name: 'Corporation tax payable', account_type: 'liability', normal_balance: 'credit', canonical_role: null },
  { id: 'a-4000', code: '4000', name: 'Sales', account_type: 'revenue', normal_balance: 'credit', canonical_role: null },
  { id: 'a-6100', code: '6100', name: 'Subscriptions', account_type: 'expense', normal_balance: 'debit', canonical_role: null }
];

await test('the terminal and refusal vocabularies are closed and every refusal routes somewhere', () => {
  assert.deepEqual(ROLE_RESOLUTION_TERMINALS, ['assign', 'ask_owner', 'already_resolved']);
  assert.equal(ROLE_RESOLUTION_REFUSALS.length, new Set(ROLE_RESOLUTION_REFUSALS).size);
  assert.ok(ROLE_RESOLUTION_REFUSALS.includes('singleton_contended'));
  assert.ok(ROLE_RESOLUTION_REFUSALS.includes('no_candidate'));
});

await test('singleton roles cover every resolve-by-role posting site and every control role', () => {
  // The three accountForRole() sites (firmDb.js:16308/16311/16384).
  assert.ok(isSingletonRole('asset.accounts_receivable'));
  assert.ok(isSingletonRole('revenue.operating'));
  assert.ok(isSingletonRole('liability.sales_tax_payable'));
  // gb/cutover.js SUPPORTED_ROLES.
  assert.ok(isSingletonRole('equity.share_capital'));
  assert.ok(isSingletonRole('liability.director_loan'));
  // Control roles.
  assert.ok(isSingletonRole('liability.tax_payable'));
  assert.ok(isSingletonRole('control.suspense'));
  assert.ok(isSingletonRole('clearing.payment_processor'));
  // An ordinary expense role is NOT singleton — a chart may carry many.
  assert.ok(!isSingletonRole('expense.software'));
  assert.ok(!isSingletonRole('expense.travel'));
  // Stable and de-duplicated.
  assert.deepEqual(POSTING_SINGLETON_ROLES, [...new Set(POSTING_SINGLETON_ROLES)].sort());
});

await test('a confident, invariant-clean proposal is assigned — Donna does it herself', () => {
  const plan = planCanonicalRoleResolution({
    accounts: GB_CHART,
    proposals: [
      { account_id: 'a-2220', role: 'liability.sales_tax_payable', confidence: 0.97, rationale: 'VAT control' },
      { account_id: 'a-6100', role: 'expense.software', confidence: 0.91 }
    ]
  });
  assert.equal(plan.assignments.length, 2);
  assert.equal(plan.asks.length, 0);
  assert.equal(plan.rejected.length, 0);
  assert.ok(plan.assignments.every((a) => a.terminal === 'assign'));
  const vat = plan.assignments.find((a) => a.account_id === 'a-2220');
  assert.equal(vat.role, 'liability.sales_tax_payable');
});

await test('two accounts contending for one singleton role become ONE owner ask, and neither is assigned', () => {
  // The exact GB shape: the model cannot tell VAT control from Corporation tax
  // payable, so it proposes both onto the consumption-tax role.
  const plan = planCanonicalRoleResolution({
    accounts: GB_CHART,
    proposals: [
      { account_id: 'a-2220', role: 'liability.sales_tax_payable', confidence: 0.9 },
      { account_id: 'a-2230', role: 'liability.sales_tax_payable', confidence: 0.88 }
    ]
  });
  assert.equal(plan.assignments.length, 0, 'neither contender may be posted');
  assert.equal(plan.asks.length, 1, 'one ask for the role, not one per account');
  const ask = plan.asks[0];
  assert.equal(ask.terminal, 'ask_owner');
  assert.equal(ask.refusal, 'singleton_contended');
  assert.equal(ask.role, 'liability.sales_tax_payable');
  assert.equal(ask.role_label, 'Sales tax / VAT payable');
  assert.deepEqual(ask.candidates.map((c) => c.code).sort(), ['2220', '2230']);
  assert.equal(ask.held_count, 0);
});

await test('a non-singleton role may take several accounts without an ask', () => {
  const plan = planCanonicalRoleResolution({
    accounts: [
      { id: 'e-1', code: '6100', name: 'Subscriptions', account_type: 'expense', normal_balance: 'debit', canonical_role: null },
      { id: 'e-2', code: '6110', name: 'Hosting', account_type: 'expense', normal_balance: 'debit', canonical_role: null }
    ],
    proposals: [
      { account_id: 'e-1', role: 'expense.software', confidence: 0.95 },
      { account_id: 'e-2', role: 'expense.software', confidence: 0.95 }
    ]
  });
  assert.equal(plan.assignments.length, 2);
  assert.equal(plan.asks.length, 0);
});

await test('a proposal cannot become the SECOND account on a role the chart already holds', () => {
  const plan = planCanonicalRoleResolution({
    accounts: [
      { id: 'held', code: '2220', name: 'VAT control', account_type: 'liability', normal_balance: 'credit', canonical_role: 'liability.sales_tax_payable' },
      { id: 'new', code: '2225', name: 'VAT suspense', account_type: 'liability', normal_balance: 'credit', canonical_role: null }
    ],
    proposals: [{ account_id: 'new', role: 'liability.sales_tax_payable', confidence: 0.99 }]
  });
  assert.equal(plan.assignments.length, 0, 'a settled singleton must not gain a second account');
  assert.equal(plan.asks.length, 1);
  assert.equal(plan.asks[0].refusal, 'singleton_contended');
  assert.equal(plan.asks[0].held_count, 1, 'the ask must disclose it is contesting a standing assignment');
  assert.equal(plan.alreadyResolved.length, 1);
});

await test('an already-roled account is never overwritten and never re-proposed', () => {
  const plan = planCanonicalRoleResolution({
    accounts: [
      { id: 'a-4000', code: '4000', name: 'Sales', account_type: 'revenue', normal_balance: 'credit', canonical_role: 'revenue.operating' }
    ],
    proposals: [{ account_id: 'a-4000', role: 'revenue.other', confidence: 1 }]
  });
  assert.equal(plan.assignments.length, 0);
  assert.equal(plan.rejected.length, 0, 'a proposal onto a settled account is not work, not an error');
  assert.deepEqual(plan.alreadyResolved.map((a) => a.role), ['revenue.operating']);
});

await test('Keep-layer invariants refuse and route to the owner, never silently drop', () => {
  const accounts = [
    { id: 'x1', code: '9000', name: 'Mystery', account_type: 'expense', normal_balance: 'debit', canonical_role: null },
    { id: 'x2', code: '9001', name: 'Odd', account_type: 'revenue', normal_balance: 'credit', canonical_role: null },
    { id: 'x3', code: '9002', name: 'Backwards', account_type: 'liability', normal_balance: 'debit', canonical_role: null },
    { id: 'x4', code: '9003', name: 'Unsure', account_type: 'expense', normal_balance: 'debit', canonical_role: null }
  ];
  const plan = planCanonicalRoleResolution({
    accounts,
    proposals: [
      { account_id: 'x1', role: 'expense.not_a_real_role', confidence: 0.99 },
      { account_id: 'x2', role: 'expense.software', confidence: 0.99 },
      { account_id: 'x3', role: 'liability.accounts_payable', confidence: 0.99 },
      { account_id: 'x4', role: 'expense.travel', confidence: 0.4 }
    ]
  });
  assert.equal(plan.assignments.length, 0);
  assert.deepEqual(
    plan.rejected.map((r) => r.refusal).sort(),
    ['below_confidence_floor', 'class_mismatch', 'normal_balance_conflict', 'role_unknown']
  );
  assert.ok(plan.rejected.every((r) => ROLE_RESOLUTION_REFUSALS.includes(r.refusal)));
});

await test('the confidence floor is the caller\'s to set', () => {
  const accounts = [{ id: 'x', code: '6100', name: 'Subs', account_type: 'expense', normal_balance: 'debit', canonical_role: null }];
  const proposals = [{ account_id: 'x', role: 'expense.software', confidence: 0.62 }];
  assert.equal(planCanonicalRoleResolution({ accounts, proposals }).assignments.length, 0);
  assert.equal(planCanonicalRoleResolution({ accounts, proposals, confidenceFloor: 0.6 }).assignments.length, 1);
});

await test('an unclassifiable declared type is absence of evidence, not disagreement', () => {
  // A posting-time-minted account carries account_type 'unknown'; the role is
  // what resolves it (ledgerReadModel.classifiedAccountType). Refusing here
  // would refuse the normal case.
  const plan = planCanonicalRoleResolution({
    accounts: [{ id: 'u', code: null, name: 'Minted at posting', account_type: 'unknown', normal_balance: null, canonical_role: null }],
    proposals: [{ account_id: 'u', role: 'expense.office', confidence: 0.95 }]
  });
  assert.equal(plan.assignments.length, 1);
});

await test('a control/clearing role is never refused for class mismatch', () => {
  // Source systems type these inconsistently; ledgerReadModel deliberately
  // leaves them unclassified rather than guessing a side.
  const plan = planCanonicalRoleResolution({
    accounts: [{ id: 'c', code: '1240', name: 'Stripe clearing', account_type: 'bank', normal_balance: 'debit', canonical_role: null }],
    proposals: [{ account_id: 'c', role: 'clearing.payment_processor', confidence: 0.95 }]
  });
  assert.equal(plan.assignments.length, 1);
  assert.equal(plan.asks.length, 0);
});

await test('a REQUIRED singleton role with nothing to assign becomes the owner ask, not a 409', () => {
  // This is OUTBOUND_AR_NO_SALES_TAX_ACCOUNT — today a firm-side refusal that
  // only scripts/backfill_gb_sales_tax_roles.js can clear.
  const plan = planCanonicalRoleResolution({
    accounts: GB_CHART,
    proposals: [],
    requiredRoles: ['liability.sales_tax_payable']
  });
  assert.equal(plan.asks.length, 1);
  const ask = plan.asks[0];
  assert.equal(ask.refusal, 'no_candidate');
  assert.equal(ask.role, 'liability.sales_tax_payable');
  assert.equal(ask.had_refused_proposals, false);
  // The menu offers only accounts the Keep layer would actually accept: both
  // credit-normal liabilities, and neither the bank, the debtors, the revenue
  // nor the expense line.
  assert.deepEqual(ask.candidates.map((c) => c.code), ['2220', '2230']);
});

await test('a required role already held by the chart raises no ask', () => {
  const plan = planCanonicalRoleResolution({
    accounts: [{ id: 'v', code: '2220', name: 'VAT control', account_type: 'liability', normal_balance: 'credit', canonical_role: 'liability.sales_tax_payable' }],
    requiredRoles: ['liability.sales_tax_payable']
  });
  assert.equal(plan.asks.length, 0);
  assert.equal(plan.assignments.length, 0);
});

await test('a required role whose only proposals the Keep layer refused says so', () => {
  const plan = planCanonicalRoleResolution({
    accounts: GB_CHART,
    proposals: [{ account_id: 'a-2220', role: 'liability.sales_tax_payable', confidence: 0.2 }],
    requiredRoles: ['liability.sales_tax_payable']
  });
  assert.equal(plan.asks.length, 1);
  assert.equal(plan.asks[0].refusal, 'no_candidate');
  assert.equal(
    plan.asks[0].had_refused_proposals,
    true,
    'the drafter must be able to tell "no idea" from "an idea the invariants refused"'
  );
});

await test('a required role that is already contended asks once, not twice', () => {
  const plan = planCanonicalRoleResolution({
    accounts: GB_CHART,
    proposals: [
      { account_id: 'a-2220', role: 'liability.sales_tax_payable', confidence: 0.9 },
      { account_id: 'a-2230', role: 'liability.sales_tax_payable', confidence: 0.9 }
    ],
    requiredRoles: ['liability.sales_tax_payable']
  });
  assert.equal(plan.asks.length, 1);
  assert.equal(plan.asks[0].refusal, 'singleton_contended');
});

await test('every account needing work lands in exactly one of the two terminals', () => {
  const plan = planCanonicalRoleResolution({
    accounts: GB_CHART,
    proposals: [
      { account_id: 'a-1200', role: 'asset.cash', confidence: 0.99 },
      { account_id: 'a-1100', role: 'asset.accounts_receivable', confidence: 0.99 },
      { account_id: 'a-2220', role: 'liability.sales_tax_payable', confidence: 0.9 },
      { account_id: 'a-2230', role: 'liability.sales_tax_payable', confidence: 0.9 },
      { account_id: 'a-4000', role: 'revenue.operating', confidence: 0.99 },
      { account_id: 'a-6100', role: 'expense.software', confidence: 0.99 }
    ],
    requiredRoles: ['liability.sales_tax_payable', 'revenue.operating']
  });
  // Four clean assigns, one ask carrying the two contenders.
  assert.equal(plan.assignments.length, 4);
  assert.equal(plan.asks.length, 1);
  const accountedFor = new Set([
    ...plan.assignments.map((a) => a.account_id),
    ...plan.asks.flatMap((a) => a.candidates.map((c) => c.account_id)),
    ...plan.alreadyResolved.map((a) => a.account_id)
  ]);
  assert.equal(accountedFor.size, GB_CHART.length, 'no account may be silently dropped');
  assert.equal(plan.receipt.unresolved_resting_firm_side, 0);
});

await test('the receipt reports what happened, not what was hoped', () => {
  const plan = planCanonicalRoleResolution({
    accounts: GB_CHART,
    proposals: [
      { account_id: 'a-6100', role: 'expense.software', confidence: 0.99 },
      { account_id: 'a-4000', role: 'expense.software', confidence: 0.99 }
    ],
    requiredRoles: ['liability.sales_tax_payable'],
    confidenceFloor: 0.75
  });
  assert.equal(plan.receipt.accounts_considered, 6);
  assert.equal(plan.receipt.proposals_received, 2);
  assert.equal(plan.receipt.assigned, 1);
  assert.equal(plan.receipt.rejected, 1); // the revenue account onto an expense role
  assert.equal(plan.receipt.asked, 1);    // the required VAT role
  assert.equal(plan.receipt.confidence_floor, 0.75);
});

await test('an empty chart is a clean no-op, and a required role on it still asks', () => {
  assert.deepEqual(planCanonicalRoleResolution({}).receipt.accounts_considered, 0);
  assert.equal(planCanonicalRoleResolution({}).asks.length, 0);
  const required = planCanonicalRoleResolution({ requiredRoles: ['liability.sales_tax_payable'] });
  assert.equal(required.asks.length, 1);
  assert.deepEqual(required.asks[0].candidates, []);
});

await test('a below-floor proposal on a NON-required role defers to the next sweep, counted — no ask, no assignment (Kari 2026-08-01, option B)', () => {
  const plan = planCanonicalRoleResolution({
    accounts: GB_CHART,
    proposals: [{ account_id: 'a-6100', role: 'expense.software', confidence: 0.4 }]
  });
  assert.equal(plan.assignments.length, 0, 'below the floor must not post');
  assert.equal(plan.asks.length, 0, 'a role nothing requires must not interrupt the owner');
  assert.equal(plan.rejected.length, 1);
  assert.equal(plan.rejected[0].refusal, 'below_confidence_floor');
  // The deferral is NAMED, never invisible: which account, which role, why.
  assert.deepEqual(plan.deferred, [{
    account_id: 'a-6100', code: '6100', name: 'Subscriptions',
    role: 'expense.software', refusal: 'below_confidence_floor', confidence: 0.4
  }]);
  assert.equal(plan.receipt.deferred_to_next_sweep, 1);
  assert.equal(plan.receipt.unresolved_resting_firm_side, 0);
});

await test('a below-floor proposal on a REQUIRED role is promoted into the owner ask, not deferred', () => {
  const plan = planCanonicalRoleResolution({
    accounts: GB_CHART,
    proposals: [{ account_id: 'a-2220', role: 'liability.sales_tax_payable', confidence: 0.4 }],
    requiredRoles: ['liability.sales_tax_payable']
  });
  assert.equal(plan.assignments.length, 0);
  assert.equal(plan.asks.length, 1, 'posting reality needs the role, so the owner is asked');
  assert.equal(plan.asks[0].refusal, 'no_candidate');
  assert.equal(plan.asks[0].had_refused_proposals, true, 'the ask discloses Donna had an idea the floor refused');
  assert.deepEqual(plan.deferred, [], 'a rejection the ask covers is not a deferral');
  assert.equal(plan.receipt.deferred_to_next_sweep, 0);
});

await test('every rejection lands in exactly one named lane: asked, mooted by assignment, or deferred', () => {
  const plan = planCanonicalRoleResolution({
    accounts: GB_CHART,
    proposals: [
      // Contended singleton: both rejected, covered by the one ask.
      { account_id: 'a-2220', role: 'liability.sales_tax_payable', confidence: 0.9 },
      { account_id: 'a-2230', role: 'liability.sales_tax_payable', confidence: 0.9 },
      // Two proposals for one account: the confident one assigns, the
      // below-floor one is MOOT — the account settled anyway.
      { account_id: 'a-6100', role: 'expense.software', confidence: 0.95 },
      { account_id: 'a-6100', role: 'expense.travel', confidence: 0.3 },
      // Class mismatch on a non-required role: nothing covers it — deferred.
      { account_id: 'a-4000', role: 'expense.software', confidence: 0.99 }
    ]
  });
  assert.equal(plan.rejected.length, 4);
  assert.equal(plan.asks.length, 1);
  assert.equal(plan.assignments.length, 1);
  assert.deepEqual(plan.deferred.map((d) => [d.account_id, d.refusal]), [['a-4000', 'class_mismatch']]);
  assert.equal(plan.receipt.deferred_to_next_sweep, 1);
  assert.equal(plan.receipt.unresolved_resting_firm_side, 0);
});

await test('junk input does not throw: unknown accounts, unknown required roles, nulls', () => {
  const plan = planCanonicalRoleResolution({
    accounts: [null, ...GB_CHART],
    proposals: [null, { account_id: 'nope', role: 'expense.software', confidence: 1 }],
    requiredRoles: [null, 'not.a.role', '']
  });
  assert.equal(plan.assignments.length, 0);
  assert.equal(plan.asks.length, 0);
  assert.equal(plan.rejected.length, 0);
  assert.equal(plan.receipt.accounts_considered, 6);
});
