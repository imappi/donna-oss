import assert from 'node:assert/strict';
import test from 'node:test';
import { GB_LTD_BALANCE_SHEET_WATCH_IDS, evaluateGbLtdBalanceSheetWatches } from './ltdBalanceSheetWatches.js';

test('a clean balance sheet evaluates the complete closed watch catalog', () => {
  const out = evaluateGbLtdBalanceSheetWatches({ signals: {}, asOf: '2026-07-29' });
  assert.equal(out.terminal, 'clear');
  assert.deepEqual(out.evaluatedWatchIds, GB_LTD_BALANCE_SHEET_WATCH_IDS);
  assert.deepEqual(out.watches, []);
});

test('negative assets, director loan and every control mismatch block on the owner', () => {
  const out = evaluateGbLtdBalanceSheetWatches({
    asOf: '2026-07-29',
    signals: {
      netAssets: -100,
      directorLoanDebit: 5000,
      directorLoanOldestOpenDate: '2025-01-01',
      vatControlDifference: 2,
      corporationTaxDifference: -3,
      fixedAssetRegisterDifference: 4,
      suspenseBalance: 5,
      bankControlDifference: -6
    }
  });
  assert.equal(out.blocksClose, true);
  assert.deepEqual(out.watches.map((watch) => watch.id), GB_LTD_BALANCE_SHEET_WATCH_IDS);
  assert.ok(out.watches.every((watch) => watch.terminal === 'on_owner' && watch.assignedTo === 'owner'));
});

test('policy boundaries are deterministic and missing values do not invent a watch', () => {
  const out = evaluateGbLtdBalanceSheetWatches({
    asOf: '2026-07-29',
    signals: { directorLoanDebit: 1, directorLoanOldestOpenDate: '2026-01-30', vatControlDifference: 0.99 }
  });
  assert.deepEqual(out.watches.map((watch) => watch.id), ['director_loan_debit']);
});
