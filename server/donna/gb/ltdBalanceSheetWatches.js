// Pure, deterministic balance-sheet watches for a UK private limited company.
// These are close controls, not legal/tax conclusions and never call a model.

export const GB_LTD_WATCH_POLICY = Object.freeze({
  directorLoanAgeDays: 180,
  materialDifferencePounds: 1,
  confirmedAgainstPrimary: false,
  note: 'Age and difference limits are conservative Donna close policy, not statutory deadlines. Fired watches ask the owner for the missing business fact.'
});

export const GB_LTD_BALANCE_SHEET_WATCH_IDS = Object.freeze([
  'negative_net_assets',
  'director_loan_debit',
  'aged_director_loan',
  'unreconciled_vat_control',
  'unreconciled_corporation_tax',
  'fixed_asset_register_mismatch',
  'suspense_balance',
  'bank_control_mismatch'
]);

const round2 = (value) => Math.round((Number(value) + Number.EPSILON) * 100) / 100;
const finite = (value) => Number.isFinite(Number(value)) ? Number(value) : null;
const dateOnly = (value) => /^\d{4}-\d{2}-\d{2}$/.test(String(value || '').slice(0, 10))
  ? String(value).slice(0, 10) : null;
const daysBetween = (from, to) => Math.floor((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000);

const watch = (id, reason, evidence) => ({
  id,
  terminal: 'on_owner',
  assignedTo: 'owner',
  blocksClose: true,
  reason,
  evidence
});

export const evaluateGbLtdBalanceSheetWatches = ({ signals = {}, asOf } = {}) => {
  const watches = [];
  const at = dateOnly(asOf);
  const netAssets = finite(signals.netAssets);
  if (netAssets !== null && netAssets < 0) {
    watches.push(watch('negative_net_assets', 'Confirm the facts and intended response to negative net assets.', { netAssets: round2(netAssets) }));
  }

  const directorLoan = finite(signals.directorLoanDebit);
  if (directorLoan !== null && directorLoan > 0) {
    watches.push(watch('director_loan_debit', 'Confirm the director-loan purpose, parties, terms, and repayments.', { balance: round2(directorLoan) }));
    const opened = dateOnly(signals.directorLoanOldestOpenDate);
    if (opened && at) {
      const ageDays = daysBetween(opened, at);
      if (ageDays > GB_LTD_WATCH_POLICY.directorLoanAgeDays) {
        watches.push(watch('aged_director_loan', 'Confirm why the director-loan debit remains outstanding and the repayment plan.', { balance: round2(directorLoan), oldestOpenDate: opened, ageDays }));
      }
    }
  }

  const differenceWatch = (id, value, reason) => {
    const difference = finite(value);
    if (difference !== null && Math.abs(difference) >= GB_LTD_WATCH_POLICY.materialDifferencePounds) {
      watches.push(watch(id, reason, { difference: round2(difference) }));
    }
  };
  differenceWatch('unreconciled_vat_control', signals.vatControlDifference, 'Explain or correct the VAT control-account difference.');
  differenceWatch('unreconciled_corporation_tax', signals.corporationTaxDifference, 'Explain or correct the Corporation Tax control-account difference.');
  differenceWatch('fixed_asset_register_mismatch', signals.fixedAssetRegisterDifference, 'Explain or correct the fixed-asset register difference.');
  differenceWatch('bank_control_mismatch', signals.bankControlDifference, 'Explain or correct the bank control-account difference.');

  const suspense = finite(signals.suspenseBalance);
  if (suspense !== null && Math.abs(suspense) >= GB_LTD_WATCH_POLICY.materialDifferencePounds) {
    watches.push(watch('suspense_balance', 'Identify the business purpose and correct destination of the suspense balance.', { balance: round2(suspense) }));
  }

  return {
    terminal: watches.length ? 'blocked' : 'clear',
    blocksClose: watches.length > 0,
    watches: watches.sort((a, b) => GB_LTD_BALANCE_SHEET_WATCH_IDS.indexOf(a.id) - GB_LTD_BALANCE_SHEET_WATCH_IDS.indexOf(b.id)),
    evaluatedWatchIds: GB_LTD_BALANCE_SHEET_WATCH_IDS,
    provenance: { deterministic: true, ...GB_LTD_WATCH_POLICY }
  };
};
