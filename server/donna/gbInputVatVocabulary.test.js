import assert from 'node:assert/strict';
import test from 'node:test';
import { GB_VAT_TAX_TREATMENT_OPTIONS } from './gb/taxVocabulary.js';
import { buildLedgerJournalForTransaction } from './ledger.js';
import { GB_VAT_CODES, applyGbVatCodingToCoding, resolveGbVatCodeForCoding, resolveGbVatSplitForPosting } from './gb/vatCodes.js';

const CONTROL = { code: '2202', name: 'VAT control', type: 'liability', normal_balance: 'credit', tax_type: 'NONE' };

test('the two IV-2 owner labels round-trip to their purchase codes only', () => {
  const pairs = [['EU acquisition', 'VAT_EU_ACQUISITION_20_INPUT'], ['VAT blocked (no reclaim)', 'VAT_BLOCKED_INPUT']];
  for (const [label, code] of pairs) {
    assert.ok(GB_VAT_TAX_TREATMENT_OPTIONS.includes(label));
    assert.equal(resolveGbVatCodeForCoding({ taxTreatment: label, direction: 'in' }), code);
    assert.equal(resolveGbVatCodeForCoding({ taxTreatment: label, direction: 'out' }), '');
  }
});

test("the closed rate/code pin includes kind: 'blocked'", () => {
  assert.deepEqual(GB_VAT_CODES.filter(({ direction }) => direction === 'in').map(({ code, rate, kind }) => [code, rate, kind]), [
    ['VAT_SR_20_INPUT', 20, 'standard'], ['VAT_RR_5_INPUT', 5, 'reduced'], ['VAT_ZR_INPUT', 0, 'zero'],
    ['VAT_EXEMPT_INPUT', 0, 'exempt'], ['VAT_OUTSIDE_SCOPE_INPUT', 0, 'outside_scope'], ['VAT_BLOCKED_INPUT', 20, 'blocked'],
    ['VAT_REVERSE_CHARGE_20_INPUT', 20, 'reverse_charge'], ['VAT_EU_ACQUISITION_20_INPUT', 20, 'eu_acquisition']
  ]);
});

test('bank preview split equals the split rebuilt at commit for an input transaction', () => {
  const transaction = { id: 'tx1', date: '2026-06-01', description: 'Inputs', money_out: 120, account_currency: 'GBP' };
  const coding = applyGbVatCodingToCoding({ coding: { account_code: '7500', account_name: 'Costs', account_type: 'expense', tax_treatment: 'VAT 20%' }, transaction, controlAccount: CONTROL });
  const previewSplit = resolveGbVatSplitForPosting({ coding, transaction });
  const preview = buildLedgerJournalForTransaction({ transaction, coding, bankAccount: { code: '1200', name: 'Bank' }, alvSplit: previewSplit });
  const commitSplit = resolveGbVatSplitForPosting({ coding: structuredClone(coding), transaction: structuredClone(transaction) });
  const committed = buildLedgerJournalForTransaction({ transaction, coding, bankAccount: { code: '1200', name: 'Bank' }, alvSplit: commitSplit });
  assert.deepEqual(commitSplit, previewSplit);
  assert.deepEqual(committed, preview);
});
