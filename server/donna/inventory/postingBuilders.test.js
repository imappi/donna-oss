// Donna Inventory I4·posting — P5 pure-builder tests: the §5-B matched-supplier-bill
// orchestrator, the landed-cost / provisional-settlement builders, plus property/invariant
// and golden-scenario coverage over the whole pure builder surface (design §5/§19).
//   node --test server/donna/inventory/postingBuilders.test.js

import assert from 'node:assert/strict';
import test from 'node:test';

import { valueInventoryOperations } from './valuation.js';
import {
  buildInventoryJournalDrafts,
  buildMatchedInventorySupplierBillDraft,
  buildInventoryLandedCostDraft,
  buildInventoryProvisionalSettlementDraft
} from './posting.js';

const roleAccounts = {
  'asset.inventory': { code: '1400', name: 'Inventory', type: 'asset', normal_balance: 'debit' },
  'liability.grni': { code: '2880', name: 'GRNI', type: 'liability', normal_balance: 'credit' },
  'liability.accounts_payable': { code: '2000', name: 'Accounts payable', type: 'liability', normal_balance: 'credit' },
  'liability.tax_payable': { code: '2939', name: 'Tax payable', type: 'liability', normal_balance: 'credit' },
  'expense.purchase_price_variance': { code: '5100', name: 'Purchase price variance', type: 'expense', normal_balance: 'debit' },
  'expense.cost_of_sales_adjustment': { code: '5110', name: 'Cost of sales adjustment', type: 'expense', normal_balance: 'debit' },
  'expense.fx': { code: '7600', name: 'FX gain/loss', type: 'expense', normal_balance: 'debit' },
  'expense.cost_of_sales': { code: '5000', name: 'Cost of sales', type: 'expense', normal_balance: 'debit' },
  'pnl.inventory_count_variance': { code: '5200', name: 'Inventory count variance', type: 'pnl', normal_balance: 'debit' },
  'expense.inventory_write_down': { code: '5300', name: 'Inventory write-down', type: 'expense', normal_balance: 'debit' },
  'contra_asset.inventory_valuation_allowance': { code: '1490', name: 'Inventory valuation allowance', type: 'contra_asset', normal_balance: 'credit' },
  'expense.office': { code: '6000', name: 'Office', type: 'expense', normal_balance: 'debit' }
};

const balances = (journal) => {
  const d = journal.lines.reduce((s, l) => s + l.debit, 0);
  const c = journal.lines.reduce((s, l) => s + l.credit, 0);
  return Math.abs(d - c) < 0.011;
};
const legFor = (journal, role) => journal.lines.find((l) => l.account.canonical_role === role);

// ── §5-B matched supplier bill ──────────────────────────────────────────────────
test('§5-B primary: DR grni + DR variance + DR tax = CR AP once (balanced)', () => {
  const draft = buildMatchedInventorySupplierBillDraft({
    bill: {
      id: 'bill-1', currency: 'EUR', accounting_date: '2026-07-02', gross_amount: 620,
      grni_clearing_amount: 500, input_tax_amount: 120,
      variance_lines: [{ component: 'purchase_price_variance', direction: 'debit', amount: 0 }]
    },
    roleAccounts, valuationRunId: 'vrun_x'
  });
  assert.equal(draft.applied, true);
  assert.equal(draft.posting_kind, 'matched_supplier_bill');
  assert.ok(balances(draft.journal), 'matched bill must balance');
  // AP credited exactly once, at gross.
  const apLegs = draft.journal.lines.filter((l) => l.account.canonical_role === 'liability.accounts_payable');
  assert.equal(apLegs.length, 1);
  assert.equal(apLegs[0].credit, 620);
  assert.equal(legFor(draft.journal, 'liability.grni').debit, 500);
  assert.equal(legFor(draft.journal, 'liability.tax_payable').debit, 120);
  assert.match(draft.journal.source_id, /:v1:/);
  assert.equal(draft.provenance.ap_credited, true);
});

test('§5-B post-hoc match: reclassification moves holding→GRNI, AP UNTOUCHED', () => {
  const draft = buildMatchedInventorySupplierBillDraft({
    bill: {
      id: 'bill-2', currency: 'EUR', accounting_date: '2026-07-05', accounting_basis_version: 2,
      ap_already_posted: true, grni_clearing_amount: 500,
      reclassify_from: [{ role: 'expense.office', direction: 'credit', amount: 500, memo: 'from generic expense' }]
    },
    roleAccounts, valuationRunId: 'vrun_y'
  });
  assert.equal(draft.applied, true);
  assert.ok(balances(draft.journal));
  assert.equal(draft.journal.lines.some((l) => l.account.canonical_role === 'liability.accounts_payable'), false, 'AP must not be touched on a post-hoc match');
  assert.equal(legFor(draft.journal, 'liability.grni').debit, 500);
  assert.equal(legFor(draft.journal, 'expense.office').credit, 500);
  assert.equal(draft.provenance.reclassification, true);
  assert.equal(draft.provenance.ap_credited, false);
  assert.match(draft.journal.source_id, /:v2:reclass:/);
});

test('§5-B refuses an unknown variance component (no silent dropped leg → no AP imbalance)', () => {
  const draft = buildMatchedInventorySupplierBillDraft({
    bill: { id: 'bill-3', gross_amount: 100, grni_clearing_amount: 100, variance_lines: [{ component: 'mystery', direction: 'debit', amount: 10 }] },
    roleAccounts
  });
  assert.equal(draft.applied, false);
  assert.equal(draft.reason, 'unsupported_operation');
});

test('§5-B refuses an unmapped account role', () => {
  const draft = buildMatchedInventorySupplierBillDraft({
    bill: { id: 'bill-4', gross_amount: 100, grni_clearing_amount: 100 },
    roleAccounts: { 'liability.grni': roleAccounts['liability.grni'] } // AP unmapped
  });
  assert.equal(draft.applied, false);
  assert.equal(draft.reason, 'unmapped_account');
});

test('§5-B unfavorable variance: DR grni + DR PPV = CR AP (variance routed, not blended)', () => {
  // GRNI accrued 500, bill gross 600, PPV +100 (paid more than accrued).
  const draft = buildMatchedInventorySupplierBillDraft({
    bill: { id: 'bill-5', currency: 'EUR', gross_amount: 600, grni_clearing_amount: 500, variance_lines: [{ component: 'purchase_price_variance', direction: 'debit', amount: 100 }] },
    roleAccounts, valuationRunId: 'vrun_z'
  });
  assert.ok(balances(draft.journal));
  assert.equal(legFor(draft.journal, 'expense.purchase_price_variance').debit, 100);
  assert.equal(legFor(draft.journal, 'liability.accounts_payable').credit, 600);
});

// ── Landed cost (allocateLandedCost) ─────────────────────────────────────────────
test('landed cost capitalizes the pool to inventory, balanced', () => {
  const draft = buildInventoryLandedCostDraft({
    allocation: {
      applied: true,
      receipt: { method: 'by_value', pool: { amount: 90, currency: 'EUR' }, allocations: [{ lineId: 'r1', allocatedAmount: 60, unitCostUplift: 6 }, { lineId: 'r2', allocatedAmount: 30, unitCostUplift: 3 }] }
    },
    creditRole: 'liability.accounts_payable', roleAccounts, operationId: 'freight-1', valuationRunId: 'vrun_lc', journalDate: '2026-07-03'
  });
  assert.equal(draft.applied, true);
  assert.equal(draft.posting_kind, 'landed_cost');
  assert.ok(balances(draft.journal));
  assert.equal(legFor(draft.journal, 'asset.inventory').debit, 90);
  assert.equal(legFor(draft.journal, 'liability.accounts_payable').credit, 90);
  assert.equal(draft.provenance.allocations.length, 2);
});

// ── Provisional → actual settlement (settleProvisionalCost) ──────────────────────
test('provisional settlement, fully on-hand: variance capitalizes to inventory', () => {
  const draft = buildInventoryProvisionalSettlementDraft({
    settlement: { applied: true, receipt: { variance: 50, currency: 'EUR', components: { purchase_price_variance: 50 }, revisedAverage: 15, inputs: { qty: 10, currentQtyOnHand: 10 } } },
    roleAccounts, counterRole: 'liability.accounts_payable', operationId: 'r-1', valuationRunId: 'vrun_ps', journalDate: '2026-07-06'
  });
  assert.ok(balances(draft.journal));
  assert.equal(legFor(draft.journal, 'asset.inventory').debit, 50);
  assert.equal(legFor(draft.journal, 'liability.accounts_payable').credit, 50);
});

test('provisional settlement, partly consumed: on-hand→inventory, consumed→variance', () => {
  const draft = buildInventoryProvisionalSettlementDraft({
    settlement: { applied: true, receipt: { variance: 100, currency: 'EUR', components: { purchase_price_variance: 100 }, inputs: { qty: 10, currentQtyOnHand: 6 } } },
    roleAccounts, counterRole: 'liability.accounts_payable', operationId: 'r-2', valuationRunId: 'vrun_ps2'
  });
  assert.ok(balances(draft.journal));
  assert.equal(legFor(draft.journal, 'asset.inventory').debit, 60);
  assert.equal(legFor(draft.journal, 'expense.purchase_price_variance').debit, 40);
  assert.equal(legFor(draft.journal, 'liability.accounts_payable').credit, 100);
});

test('provisional settlement, multi-component consumed split sums EXACTLY (no residual refusal)', () => {
  // Two components with a variance that does not divide evenly across the consumed share —
  // the remainder must land on the largest component so the journal still balances.
  const draft = buildInventoryProvisionalSettlementDraft({
    settlement: { applied: true, receipt: { variance: 100, currency: 'EUR', components: { purchase_price_variance: 70, fx_variance: 30 }, inputs: { qty: 3, currentQtyOnHand: 0 } } },
    roleAccounts, counterRole: 'liability.accounts_payable', operationId: 'r-multi', valuationRunId: 'vrun_multi'
  });
  assert.equal(draft.applied, true, draft.reason || 'must not refuse on a rounding residual');
  assert.ok(balances(draft.journal), 'multi-component consumed split must balance');
  assert.equal(legFor(draft.journal, 'liability.accounts_payable').credit, 100);
});

test('provisional settlement with zero variance is a value-neutral terminal', () => {
  const draft = buildInventoryProvisionalSettlementDraft({
    settlement: { applied: true, receipt: { variance: 0, currency: 'EUR', components: {}, inputs: { qty: 10, currentQtyOnHand: 10 } } },
    roleAccounts, operationId: 'r-3'
  });
  assert.equal(draft.applied, true);
  assert.equal(draft.no_journal_required, true);
  assert.equal(draft.journal, null);
});

// ── Property / invariant over the kernel-driven effect builders ──────────────────
test('property: every kernel effect draft balances (receipt → partial sale → count loss)', () => {
  const valuation = valueInventoryOperations({
    functionalCurrency: 'EUR',
    operations: [
      { id: 'op-recv', operation_type: 'receipt', occurred_at: '2026-07-01', quantity: 10, unit_cost_amount: 5, unit_cost_currency: 'EUR' },
      { id: 'op-ship', operation_type: 'shipment', occurred_at: '2026-07-02', quantity: 4 },
      { id: 'op-loss', operation_type: 'count_correction', occurred_at: '2026-07-03', quantity: -1 }
    ]
  });
  assert.equal(valuation.applied, true, valuation.reason || 'valuation applied');
  const built = buildInventoryJournalDrafts({
    valuation,
    roleAccounts,
    operationContext: { 'op-ship': { issue_reason: 'sale' } }
  });
  assert.equal(built.applied, true);
  const journals = built.results.filter((r) => r.applied && r.journal);
  assert.ok(journals.length >= 2, 'receipt + shipment at least');
  for (const r of journals) {
    assert.ok(balances(r.journal), `${r.posting_kind} must balance`);
    assert.equal(r.journal.status, 'proposed', 'a draft is proposed, never posted');
  }
  // The receipt is DR inventory / CR grni.
  const receipt = built.results.find((r) => r.posting_kind === 'receipt');
  assert.equal(legFor(receipt.journal, 'asset.inventory').debit, 50);
  assert.equal(legFor(receipt.journal, 'liability.grni').credit, 50);
  // The sale relieves COGS.
  const cogs = built.results.find((r) => r.posting_kind === 'shipment_cogs');
  assert.equal(legFor(cogs.journal, 'expense.cost_of_sales').debit, 20);
});

test('golden: receipt → sale → bill at higher cost, AP credited once across the whole bill', () => {
  // Receipt accrues GRNI 50 (10 @ 5). Bill arrives at 55 gross for the same goods → PPV +5.
  const bill = buildMatchedInventorySupplierBillDraft({
    bill: { id: 'bill-g', currency: 'EUR', gross_amount: 55, grni_clearing_amount: 50, variance_lines: [{ component: 'purchase_price_variance', direction: 'debit', amount: 5 }] },
    roleAccounts, valuationRunId: 'vrun_g'
  });
  assert.ok(balances(bill.journal));
  assert.equal(bill.journal.lines.filter((l) => l.account.canonical_role === 'liability.accounts_payable').length, 1);
  assert.equal(legFor(bill.journal, 'liability.accounts_payable').credit, 55);
  assert.equal(legFor(bill.journal, 'liability.grni').debit, 50);
  assert.equal(legFor(bill.journal, 'expense.purchase_price_variance').debit, 5);
});

// ── §5-F derecognition consumption — pure release math + builder (P6b) ─────────
import { computeAllowanceRelease, buildInventoryAllowanceReleaseDraft } from './posting.js';

test('computeAllowanceRelease: a partial derecognition consumes proportionally to quantity', () => {
  // Lot: allowance 30 on 10 bound units (unit = 3). Sell 4 → release 12, 6 units still bound.
  const r = computeAllowanceRelease({ lot: { allowance_amount: 30, consumed_amount: 0, remaining_quantity: 10 }, derecognizedQty: 4 });
  assert.equal(r.releaseAmount, 12);
  assert.equal(r.releaseQuantity, 4);
  assert.equal(r.fullyConsumed, false);
});

test('computeAllowanceRelease: FULL consumption releases the entire remainder (no stranded sub-cent)', () => {
  // Awkward unit (100/3 = 33.33…): consuming all 3 releases the whole outstanding, no drift.
  const r = computeAllowanceRelease({ lot: { allowance_amount: 100, consumed_amount: 0, remaining_quantity: 3 }, derecognizedQty: 3 });
  assert.equal(r.releaseAmount, 100);
  assert.equal(r.fullyConsumed, true);
});

test('computeAllowanceRelease: qty beyond the bound quantity caps at the remaining (never over-releases)', () => {
  const r = computeAllowanceRelease({ lot: { allowance_amount: 30, consumed_amount: 0, remaining_quantity: 5 }, derecognizedQty: 20 });
  assert.equal(r.releaseAmount, 30);
  assert.equal(r.releaseQuantity, 5);
  assert.equal(r.fullyConsumed, true);
});

test('computeAllowanceRelease: an already-outstanding-consumed lot releases only the remainder', () => {
  const r = computeAllowanceRelease({ lot: { allowance_amount: 30, consumed_amount: 12, remaining_quantity: 6 }, derecognizedQty: 6 });
  assert.equal(r.releaseAmount, 18); // 30 − 12 outstanding, fully consumed
  assert.equal(r.fullyConsumed, true);
});

test('release builder (sale): DR allowance / CR cost_of_sales, balanced', () => {
  const draft = buildInventoryAllowanceReleaseDraft({ lot: { id: 7, scope_item_id: 'SKU1' }, releaseAmount: 12, reason: 'sale', roleAccounts, operationId: 'op-sale', currency: 'EUR', date: '2026-07-10' });
  assert.equal(draft.applied, true);
  assert.equal(draft.posting_kind, 'allowance_release');
  assert.ok(balances(draft.journal));
  assert.equal(legFor(draft.journal, 'contra_asset.inventory_valuation_allowance').debit, 12);
  assert.equal(legFor(draft.journal, 'expense.cost_of_sales').credit, 12);
});

test('release builder (scrap): DR allowance / CR count_variance', () => {
  const draft = buildInventoryAllowanceReleaseDraft({ lot: { id: 8, scope_item_id: 'SKU2' }, releaseAmount: 9, reason: 'scrap', roleAccounts, operationId: 'op-scrap', currency: 'EUR' });
  assert.equal(draft.applied, true);
  assert.equal(legFor(draft.journal, 'contra_asset.inventory_valuation_allowance').debit, 9);
  assert.equal(legFor(draft.journal, 'pnl.inventory_count_variance').credit, 9);
});

test('release builder refuses an unsupported reason (e.g. customer return / restock in v1)', () => {
  const draft = buildInventoryAllowanceReleaseDraft({ lot: { id: 9 }, releaseAmount: 5, reason: 'customer_return', roleAccounts, operationId: 'op-r' });
  assert.equal(draft.applied, false);
  assert.equal(draft.reason, 'unsupported_release_reason');
  assert.equal(draft.waiter_type, 'accountant_operator');
});

test('release builder refuses an unmapped allowance role', () => {
  const draft = buildInventoryAllowanceReleaseDraft({ lot: { id: 10 }, releaseAmount: 5, reason: 'sale', roleAccounts: { 'expense.cost_of_sales': roleAccounts['expense.cost_of_sales'] }, operationId: 'op-u' });
  assert.equal(draft.applied, false);
  assert.equal(draft.reason, 'unmapped_account');
});

// ── §10 FX retranslation of open GRNI at close — pure builder (P6c) ────────────
import { buildInventoryGrniRetranslationDraft } from './posting.js';

test('retranslation: a POSITIVE delta (liability grew) posts DR fx / CR grni, balanced', () => {
  // Open GBP GRNI: £745 booked at 1.15, closes at 1.18 → delta = 745 × 0.03 = +22.35 (loss).
  const draft = buildInventoryGrniRetranslationDraft({
    currency: 'GBP', functionalCurrency: 'EUR', delta: 22.35, closeRate: 1.18, bookedRate: 1.15,
    sourceOpenAmount: 745, roleAccounts, operationId: 'grni_retranslation:2026-Q3:GBP', date: '2026-09-30'
  });
  assert.equal(draft.applied, true);
  assert.equal(draft.posting_kind, 'grni_retranslation');
  assert.ok(balances(draft.journal), 'the retranslation journal balances');
  assert.equal(draft.journal.currency, 'EUR'); // posts in FUNCTIONAL currency
  assert.equal(legFor(draft.journal, 'expense.fx').debit, 22.35); // DR fx loss
  assert.equal(legFor(draft.journal, 'liability.grni').credit, 22.35); // CR grni (liability grew)
  assert.equal(draft.journal.source_id, 'grni_retranslation:2026-Q3:GBP');
});

test('retranslation: a NEGATIVE delta (liability shrank) posts DR grni / CR fx (gain)', () => {
  const draft = buildInventoryGrniRetranslationDraft({
    currency: 'GBP', functionalCurrency: 'EUR', delta: -18.10, closeRate: 1.12, bookedRate: 1.15,
    roleAccounts, operationId: 'grni_retranslation:2026-Q3:GBP'
  });
  assert.equal(draft.applied, true);
  assert.ok(balances(draft.journal));
  assert.equal(legFor(draft.journal, 'liability.grni').debit, 18.10); // DR grni (liability shrank)
  assert.equal(legFor(draft.journal, 'expense.fx').credit, 18.10);    // CR fx gain
});

test('retranslation: a missing close rate REFUSES (integration_system_retry, await_fx_fact) — never a guessed rate', () => {
  const draft = buildInventoryGrniRetranslationDraft({
    currency: 'GBP', functionalCurrency: 'EUR', delta: null, closeRate: null,
    roleAccounts, operationId: 'grni_retranslation:2026-Q3:GBP'
  });
  assert.equal(draft.applied, false);
  assert.equal(draft.reason, 'missing_close_fx_rate');
  assert.equal(draft.waiter_type, 'integration_system_retry');
  assert.equal(draft.detail.next_action, 'await_fx_fact');
});

test('retranslation: a sub-cent (zero) delta is a recorded no_journal_required terminal, no legs', () => {
  const draft = buildInventoryGrniRetranslationDraft({
    currency: 'GBP', functionalCurrency: 'EUR', delta: 0, closeRate: 1.15, bookedRate: 1.15,
    roleAccounts, operationId: 'grni_retranslation:2026-Q3:GBP'
  });
  assert.equal(draft.applied, true);
  assert.equal(draft.no_journal_required, true);
  assert.equal(draft.journal, null);
  assert.equal(draft.consequence.commit, 'record_terminal');
});

test('retranslation: an unmapped fx role refuses unmapped_account (no silent post)', () => {
  const draft = buildInventoryGrniRetranslationDraft({
    currency: 'GBP', functionalCurrency: 'EUR', delta: 22.35, closeRate: 1.18, bookedRate: 1.15,
    roleAccounts: { 'liability.grni': roleAccounts['liability.grni'] }, operationId: 'grni_retranslation:2026-Q3:GBP'
  });
  assert.equal(draft.applied, false);
  assert.equal(draft.reason, 'unmapped_account');
});
