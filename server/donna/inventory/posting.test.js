// I4·posting P4 — pure journal builders (design §5 event map). Pins the bucket→role→account
// resolution, the §5-C/§5-E reason/cause routing, refusal typing + waiter routing, and an
// end-to-end pass over the REAL P1A kernel output so the leg-shape contract can't drift.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildInventoryJournalDraft,
  buildInventoryJournalDrafts,
  buildInventoryWriteDownDraft,
  INVENTORY_ISSUE_REASONS,
  INVENTORY_COUNT_CAUSES,
  INVENTORY_POSTING_REFUSALS
} from './posting.js';
import { valueInventoryOperations } from './valuation.js';

// A role→account map covering every role the builders resolve.
const ROLE_ACCOUNTS = {
  'asset.inventory': { code: '1520', name: 'Inventory', type: 'asset', normal_balance: 'debit', mapping_provenance_id: 'm1' },
  'liability.grni': { code: '2880', name: 'GRNI', type: 'liability', normal_balance: 'credit', mapping_provenance_id: 'm2' },
  'expense.cost_of_sales': { code: '5000', name: 'Cost of sales', type: 'expense', normal_balance: 'debit', mapping_provenance_id: 'm3' },
  'pnl.inventory_count_variance': { code: '5900', name: 'Count variance', type: 'expense', normal_balance: 'debit', mapping_provenance_id: 'm4' },
  'expense.inventory_write_down': { code: '5910', name: 'Write-down', type: 'expense', normal_balance: 'debit', mapping_provenance_id: 'm5' },
  'contra_asset.inventory_valuation_allowance': { code: '1529', name: 'Allowance', type: 'asset', normal_balance: 'credit', mapping_provenance_id: 'm6' }
};

// Build one balanced effect by hand in the kernel's leg shape.
const effect = (over = {}) => ({
  operationId: 'op1',
  effectType: 'receipt',
  posting: 'journal',
  functionalCurrency: 'EUR',
  legs: [
    { bucket: 'inventory', direction: 'debit', amount: 100 },
    { bucket: 'grni', direction: 'credit', amount: 100 }
  ],
  dates: { economic_date: '2026-07-01', accounting_date: '2026-07-02', tax_date: '2026-07-03', document_date: '2026-07-01' },
  fx: null,
  ...over
});

const draftBalances = (d) => {
  const debits = d.journal.lines.filter((l) => l.direction === 'debit').reduce((s, l) => s + l.debit, 0);
  const credits = d.journal.lines.filter((l) => l.direction === 'credit').reduce((s, l) => s + l.credit, 0);
  return Math.abs(debits - credits) < 0.001;
};

test('a receipt effect builds a balanced DR inventory / CR grni proposed draft', () => {
  const d = buildInventoryJournalDraft({ effect: effect(), roleAccounts: ROLE_ACCOUNTS, valuationRunId: 'vrun_x' });
  assert.equal(d.applied, true);
  assert.equal(d.posting_kind, 'receipt');
  assert.equal(d.journal.status, 'proposed');
  assert.ok(draftBalances(d), 'journal balances');
  assert.equal(d.detail.journal.debits, 100);
  assert.equal(d.detail.journal.credits, 100);
  // roles resolved to the mapped accounts, provenance threaded
  const inv = d.journal.lines.find((l) => l.direction === 'debit');
  assert.equal(inv.account.canonical_role, 'asset.inventory');
  assert.equal(inv.account.code, '1520');
  assert.equal(inv.account.mapping_provenance_id, 'm1');
  // accounting_date drives the journal date (§6)
  assert.equal(d.journal.journal_date, '2026-07-02');
  // source_id carries kind+op+run (§11 idempotency)
  assert.equal(d.journal.source_id, 'receipt:op1:vrun_x');
});

test('shipment routes cogs_or_variance by issue_reason (§5-C)', () => {
  const shipmentEffect = (reason) => effect({
    effectType: 'shipment',
    legs: [
      { bucket: 'inventory', direction: 'credit', amount: 60 },
      { bucket: 'cogs_or_variance', direction: 'debit', amount: 60 }
    ]
  });
  // sale → cost of sales
  const sale = buildInventoryJournalDraft({ effect: shipmentEffect(), roleAccounts: ROLE_ACCOUNTS, context: { issue_reason: 'sale' }, valuationRunId: 'v' });
  assert.equal(sale.applied, true);
  assert.equal(sale.posting_kind, 'shipment_cogs');
  assert.ok(sale.journal.lines.some((l) => l.account.canonical_role === 'expense.cost_of_sales'));
  // damage → count variance line
  const dmg = buildInventoryJournalDraft({ effect: shipmentEffect(), roleAccounts: ROLE_ACCOUNTS, context: { issue_reason: 'damage' }, valuationRunId: 'v' });
  assert.ok(dmg.journal.lines.some((l) => l.account.canonical_role === 'pnl.inventory_count_variance'));
});

test('shipment escalations & unknowns refuse with the right waiter (§5-C / §12)', () => {
  const shipmentEffect = () => effect({
    effectType: 'shipment',
    legs: [
      { bucket: 'inventory', direction: 'credit', amount: 60 },
      { bucket: 'cogs_or_variance', direction: 'debit', amount: 60 }
    ]
  });
  // sample → escalate to accountant/operator (needs a policy pack)
  const sample = buildInventoryJournalDraft({ effect: shipmentEffect(), roleAccounts: ROLE_ACCOUNTS, context: { issue_reason: 'promotional' }, valuationRunId: 'v' });
  assert.equal(sample.applied, false);
  assert.equal(sample.reason, 'unsupported_operation');
  assert.equal(sample.waiter_type, 'product_compliance');
  // no reason at all → the owner must answer what this issue was
  const noReason = buildInventoryJournalDraft({ effect: shipmentEffect(), roleAccounts: ROLE_ACCOUNTS, context: {}, valuationRunId: 'v' });
  assert.equal(noReason.reason, 'unknown_issue_reason');
  assert.equal(noReason.waiter_type, 'owner');
  // an unknown reason string → same
  const bogus = buildInventoryJournalDraft({ effect: shipmentEffect(), roleAccounts: ROLE_ACCOUNTS, context: { issue_reason: 'mystery' }, valuationRunId: 'v' });
  assert.equal(bogus.reason, 'unknown_issue_reason');
});

test('count found requires a confirmed shrinkage reversal; loss posts directly (§5-E)', () => {
  const found = (cause) => effect({
    effectType: 'found_stock',
    legs: [
      { bucket: 'inventory', direction: 'debit', amount: 20 },
      { bucket: 'cogs_or_variance', direction: 'credit', amount: 20 }
    ]
  });
  const ok = buildInventoryJournalDraft({ effect: found(), roleAccounts: ROLE_ACCOUNTS, context: { count_cause: 'reversal_of_shrinkage' }, valuationRunId: 'v' });
  assert.equal(ok.applied, true);
  assert.equal(ok.posting_kind, 'count_adjustment');
  // any other / absent cause → owner clarifies
  const other = buildInventoryJournalDraft({ effect: found(), roleAccounts: ROLE_ACCOUNTS, context: { count_cause: 'unrecorded_receipt' }, valuationRunId: 'v' });
  assert.equal(other.applied, false);
  assert.equal(other.reason, 'unknown_count_cause');
  assert.equal(other.waiter_type, 'owner');
  // a count LOSS posts to the variance line with no cause gate
  const loss = buildInventoryJournalDraft({
    effect: effect({ effectType: 'shrinkage', legs: [
      { bucket: 'inventory', direction: 'credit', amount: 15 },
      { bucket: 'cogs_or_variance', direction: 'debit', amount: 15 }
    ] }),
    roleAccounts: ROLE_ACCOUNTS, context: {}, valuationRunId: 'v'
  });
  assert.equal(loss.applied, true);
  assert.ok(loss.journal.lines.some((l) => l.account.canonical_role === 'pnl.inventory_count_variance'));
});

test('private use, opening balance, and reversal never auto-post in v1', () => {
  const pu = buildInventoryJournalDraft({ effect: effect({ effectType: 'owner_private_use', legs: [{ bucket: 'inventory', direction: 'credit', amount: 10 }, { bucket: 'owner_appropriation', direction: 'debit', amount: 10 }] }), roleAccounts: ROLE_ACCOUNTS });
  assert.equal(pu.reason, 'private_use_requires_review');
  assert.equal(pu.waiter_type, 'accountant_operator');

  const ob = buildInventoryJournalDraft({ effect: effect({ effectType: 'opening_balance', legs: [{ bucket: 'inventory', direction: 'debit', amount: 10 }, { bucket: 'opening_balance_equity', direction: 'credit', amount: 10 }] }), roleAccounts: ROLE_ACCOUNTS });
  assert.equal(ob.reason, 'unsupported_operation');

  // reversal is executor-owned (reverses the persisted journal, not a rebuild) — no waiter.
  const rev = buildInventoryJournalDraft({ effect: effect({ effectType: 'reversal', reverses: 'op0', legs: [] }), roleAccounts: ROLE_ACCOUNTS });
  assert.equal(rev.reason, 'reversal_requires_persisted_journal');
  assert.equal(rev.waiter_type, null);
});

test('a value-neutral effect is a recorded terminal, not a journal (§11 D-POST-14)', () => {
  const n = buildInventoryJournalDraft({ effect: effect({ effectType: 'neutral', posting: 'no_journal_required', legs: [] }), roleAccounts: ROLE_ACCOUNTS, valuationRunId: 'v' });
  assert.equal(n.applied, true);
  assert.equal(n.no_journal_required, true);
  assert.equal(n.posting_kind, 'value_neutral');
  assert.equal(n.journal, null);
});

test('an unmapped role refuses unmapped_account before any partial journal is built', () => {
  const { 'liability.grni': _omit, ...withoutGrni } = ROLE_ACCOUNTS;
  const d = buildInventoryJournalDraft({ effect: effect(), roleAccounts: withoutGrni, valuationRunId: 'v' });
  assert.equal(d.applied, false);
  assert.equal(d.reason, 'unmapped_account');
  assert.equal(d.detail.role, 'liability.grni');
  assert.equal(d.waiter_type, 'accountant_operator');
});

test('the write-down builder posts DR write-down / CR allowance (§5-F)', () => {
  const d = buildInventoryWriteDownDraft({ writeDown: { id: 'wd1', amount: 250, currency: 'EUR', date: '2026-07-10', scope_item_id: 'SKU-9', reviewer: 'kari', valuation_run_id: 'v' }, roleAccounts: ROLE_ACCOUNTS });
  assert.equal(d.applied, true);
  assert.equal(d.posting_kind, 'write_down');
  assert.ok(draftBalances(d));
  assert.ok(d.journal.lines.some((l) => l.direction === 'debit' && l.account.canonical_role === 'expense.inventory_write_down'));
  assert.ok(d.journal.lines.some((l) => l.direction === 'credit' && l.account.canonical_role === 'contra_asset.inventory_valuation_allowance'));
  // a non-positive amount refuses; a missing allowance role refuses unmapped_account
  assert.equal(buildInventoryWriteDownDraft({ writeDown: { amount: 0 }, roleAccounts: ROLE_ACCOUNTS }).reason, 'missing_valuation_basis');
  const { 'contra_asset.inventory_valuation_allowance': _o, ...noAllow } = ROLE_ACCOUNTS;
  assert.equal(buildInventoryWriteDownDraft({ writeDown: { amount: 5 }, roleAccounts: noAllow }).reason, 'unmapped_account');
});

test('end-to-end over the REAL kernel: receipt then sale → two balanced proposed drafts', () => {
  const valuation = valueInventoryOperations({
    operations: [
      { id: 'r1', operation_type: 'receipt', quantity: 10, unit_cost_amount: 5, unit_cost_currency: 'EUR', occurred_at: '2026-07-01' },
      { id: 's1', operation_type: 'shipment', quantity: 4, occurred_at: '2026-07-02' }
    ],
    policy: 'moving_average',
    functionalCurrency: 'EUR'
  });
  assert.equal(valuation.applied, true, 'kernel produced effects');

  const out = buildInventoryJournalDrafts({
    valuation,
    roleAccounts: ROLE_ACCOUNTS,
    operationContext: { s1: { issue_reason: 'sale' } }
  });
  assert.equal(out.applied, true);
  assert.equal(out.valuation_run_id, valuation.receipt.valuationRunId);
  assert.equal(out.results.length, 2);

  const [receipt, sale] = out.results;
  assert.equal(receipt.posting_kind, 'receipt');
  assert.ok(draftBalances(receipt));
  assert.equal(receipt.journal.lines.find((l) => l.direction === 'debit').account.canonical_role, 'asset.inventory');
  assert.equal(receipt.journal.lines.find((l) => l.direction === 'credit').account.canonical_role, 'liability.grni');

  assert.equal(sale.posting_kind, 'shipment_cogs');
  assert.ok(draftBalances(sale));
  // 4 units at the €5 moving average → €20 COGS
  assert.equal(sale.detail.journal.debits, 20);
  assert.ok(sale.journal.lines.some((l) => l.account.canonical_role === 'expense.cost_of_sales'));
});

test('buildInventoryJournalDrafts propagates a kernel refusal', () => {
  const refusal = valueInventoryOperations({ operations: [], policy: 'not_a_policy' });
  assert.equal(refusal.applied, false);
  const out = buildInventoryJournalDrafts({ valuation: refusal, roleAccounts: ROLE_ACCOUNTS });
  assert.equal(out.applied, false);
  assert.equal(out.reason, 'missing_valuation_basis');
  assert.deepEqual(out.results, []);
});

test('the closed vocabularies are frozen and self-consistent', () => {
  assert.ok(Object.isFrozen(INVENTORY_ISSUE_REASONS));
  assert.ok(Object.isFrozen(INVENTORY_COUNT_CAUSES));
  assert.ok(Object.isFrozen(INVENTORY_POSTING_REFUSALS));
  assert.ok(INVENTORY_ISSUE_REASONS.includes('sale'));
  assert.ok(INVENTORY_COUNT_CAUSES.includes('reversal_of_shrinkage'));
  assert.ok(INVENTORY_POSTING_REFUSALS.includes('unmapped_account'));
});
