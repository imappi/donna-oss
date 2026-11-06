// UK Ltd monthly-close projection. It extends the generic close contract by
// consuming its disposition verdicts, then folds deterministic UK deadlines and
// balance-sheet watches into exactly two item terminals: settled or on_owner.

import { CLOSE_DISPOSITIONS } from '../closeDisposition.js';
import { clientFlagActs } from '../clientConfig.js';
import { computeGbLtdStatutoryDeadlines } from './ltdStatutoryDeadlines.js';
import { evaluateGbLtdBalanceSheetWatches } from './ltdBalanceSheetWatches.js';

export const GB_LTD_CLOSE_TERMINALS = Object.freeze(['settled', 'on_owner']);
// Config-plane flag (migration 042 pattern) — clientFlagActs, envFallback: () => false;
// dark by default, canary per client.
export const GB_LTD_MONTHLY_CLOSE_FLAG_KEY = 'GB_LTD_MONTHLY_CLOSE';
export const gbLtdMonthlyCloseEnabled = ({ snapshot = null, env = process.env } = {}) => clientFlagActs({
  flagKey: GB_LTD_MONTHLY_CLOSE_FLAG_KEY, snapshot, envFallback: () => false, env
});
export const GB_LTD_CLOSE_BLOCKER_SURFACE = 'gb_ltd_monthly_close';
export const GB_LTD_CLOSE_ITEM_IDS = Object.freeze([
  'generic_reconciliation',
  'bank_and_processor_controls',
  'ar_ap_reconciliation',
  'vat_control',
  'corporation_tax_control',
  'payroll_control',
  'director_and_related_party_balances',
  'fixed_assets',
  'accruals_and_prepayments',
  'equity_and_reserves',
  'companies_house_accounts_window',
  'confirmation_statement_window',
  'ct600_window',
  'corporation_tax_payment_window',
  'vat_quarter_calendar',
  'unresolved_judgment_items'
]);

const REASON_CODE_BY_ITEM = Object.freeze({
  generic_reconciliation: 'gb_ltd_generic_reconciliation_unresolved',
  bank_and_processor_controls: 'gb_ltd_bank_control_unreconciled',
  ar_ap_reconciliation: 'gb_ltd_ar_ap_unreconciled',
  vat_control: 'gb_ltd_vat_control_unreconciled',
  corporation_tax_control: 'gb_ltd_corporation_tax_control_unreconciled',
  payroll_control: 'gb_ltd_payroll_control_unreconciled',
  director_and_related_party_balances: 'gb_ltd_director_loan_unresolved',
  fixed_assets: 'gb_ltd_fixed_assets_unreconciled',
  accruals_and_prepayments: 'gb_ltd_accruals_prepayments_unreconciled',
  equity_and_reserves: 'gb_ltd_equity_reserves_unreconciled',
  companies_house_accounts_window: 'gb_ltd_companies_house_accounts_overdue',
  confirmation_statement_window: 'gb_ltd_confirmation_statement_overdue',
  ct600_window: 'gb_ltd_ct600_overdue',
  corporation_tax_payment_window: 'gb_ltd_corporation_tax_payment_overdue',
  vat_quarter_calendar: 'gb_ltd_vat_quarter_calendar_unresolved',
  unresolved_judgment_items: 'gb_ltd_judgment_item_unresolved'
});
export const GB_LTD_CLOSE_REASON_CODES = Object.freeze(GB_LTD_CLOSE_ITEM_IDS.map((id) => REASON_CODE_BY_ITEM[id]));
const STORE_VALID_ASSIGNEES = new Set(['firm', 'client', 'accountant', 'auditor', 'counsel']);
const normalizeAssignee = (assignee) => assignee === 'owner' || !STORE_VALID_ASSIGNEES.has(assignee) ? 'client' : assignee;

const settled = (id, reason, evidence = null) => ({ id, terminal: 'settled', assignedTo: null, blocksClose: false, reason, evidence, blocker_surface: null, reason_code: null, severity: null, blockerAssignee: null });
const onOwner = (id, reason, evidence = null) => ({ id, terminal: 'on_owner', assignedTo: 'owner', blocksClose: true, reason, evidence, blocker_surface: GB_LTD_CLOSE_BLOCKER_SURFACE, reason_code: REASON_CODE_BY_ITEM[id], severity: 'review_required', blockerAssignee: normalizeAssignee('owner') });
const dateOnly = (value) => /^\d{4}-\d{2}-\d{2}$/.test(String(value || '').slice(0, 10)) ? String(value).slice(0, 10) : null;

const genericCloseItem = (items) => {
  if (!Array.isArray(items) || items.length === 0) {
    return onOwner('generic_reconciliation', 'Generic close dispositions have not been established.');
  }
  const unresolved = items.filter((item) => item?.blocks_close === true
    || item?.blocksClose === true
    || item?.disposition === CLOSE_DISPOSITIONS.OPERATOR_BLOCKER);
  return unresolved.length
    ? onOwner('generic_reconciliation', 'Resolve the generic close items that still block closing.', unresolved.map((item) => item.id || item.reason_code || null))
    : settled('generic_reconciliation', 'Generic close dispositions are non-blocking.');
};

const signalItem = (id, signal, absentReason) => {
  if (signal?.status === 'settled') return settled(id, signal.reason || 'Reconciled.', signal.evidence ?? null);
  if (signal?.status === 'blocked') return onOwner(id, signal.reason || absentReason, signal.evidence ?? null);
  return onOwner(id, absentReason);
};

const deadlineItem = ({ id, deadline, asOf, filed, label }) => {
  const dueDate = deadline?.due_date;
  const evidence = deadline ? { dueDate, statutory_date: deadline.statutory_date, asOf } : null;
  if (!dueDate) return onOwner(id, `${label} deadline could not be established.`);
  if (filed === true) return settled(id, `${label} is recorded complete.`, evidence);
  if (asOf > dueDate) return onOwner(id, `${label} is past its computed due date and completion is not established.`, evidence);
  return settled(id, `${label} window is open and not overdue.`, evidence);
};

export const evaluateGbLtdMonthlyClose = ({
  accountingPeriodEnd,
  confirmationReviewPeriodEnd,
  vatStagger,
  asOf,
  genericCloseItems,
  itemSignals = {},
  balanceSheetSignals = {},
  completionEvidence = {}
} = {}) => {
  const at = dateOnly(asOf);
  if (!at) {
    const error = new Error('A deterministic asOf date is required for the GB Ltd close.');
    error.code = 'GB_LTD_CLOSE_AS_OF_NOT_ESTABLISHED';
    error.statusCode = 422;
    throw error;
  }
  const deadlines = computeGbLtdStatutoryDeadlines({ accountingPeriodEnd, confirmationReviewPeriodEnd, vatStagger });
  const watchVerdict = evaluateGbLtdBalanceSheetWatches({ signals: balanceSheetSignals, asOf: at });
  const items = [
    genericCloseItem(genericCloseItems),
    signalItem('bank_and_processor_controls', itemSignals.bank_and_processor_controls, 'Bank and processor controls are not established.'),
    signalItem('ar_ap_reconciliation', itemSignals.ar_ap_reconciliation, 'AR and AP reconciliation is not established.'),
    signalItem('vat_control', itemSignals.vat_control, 'VAT control reconciliation is not established.'),
    signalItem('corporation_tax_control', itemSignals.corporation_tax_control, 'Corporation Tax control reconciliation is not established.'),
    signalItem('payroll_control', itemSignals.payroll_control, 'Payroll control reconciliation is not established.'),
    signalItem('director_and_related_party_balances', itemSignals.director_and_related_party_balances, 'Director and related-party balances are not established.'),
    signalItem('fixed_assets', itemSignals.fixed_assets, 'Fixed-asset reconciliation is not established.'),
    signalItem('accruals_and_prepayments', itemSignals.accruals_and_prepayments, 'Accruals and prepayments are not established.'),
    signalItem('equity_and_reserves', itemSignals.equity_and_reserves, 'Equity and reserves reconciliation is not established.'),
    deadlineItem({ id: 'companies_house_accounts_window', deadline: deadlines.companiesHouseAccountsDue, asOf: at, filed: completionEvidence.accountsFiled, label: 'Companies House accounts' }),
    deadlineItem({ id: 'confirmation_statement_window', deadline: deadlines.confirmationStatementDue, asOf: at, filed: completionEvidence.confirmationStatementFiled, label: 'Confirmation statement' }),
    deadlineItem({ id: 'ct600_window', deadline: deadlines.ct600Due, asOf: at, filed: completionEvidence.ct600Filed, label: 'CT600' }),
    deadlineItem({ id: 'corporation_tax_payment_window', deadline: deadlines.corporationTaxPaymentDue, asOf: at, filed: completionEvidence.corporationTaxPaid, label: 'Corporation Tax payment' }),
    settled('vat_quarter_calendar', 'VAT quarter ends resolved from the persisted HMRC stagger.', deadlines.vatQuarterEnds),
    signalItem('unresolved_judgment_items', itemSignals.unresolved_judgment_items, 'Unresolved judgment items have not been cleared.')
  ];

  const watchTargets = {
    negative_net_assets: 'equity_and_reserves',
    director_loan_debit: 'director_and_related_party_balances',
    aged_director_loan: 'director_and_related_party_balances',
    unreconciled_vat_control: 'vat_control',
    unreconciled_corporation_tax: 'corporation_tax_control',
    fixed_asset_register_mismatch: 'fixed_assets',
    suspense_balance: 'unresolved_judgment_items',
    bank_control_mismatch: 'bank_and_processor_controls'
  };
  for (const watch of watchVerdict.watches) {
    const index = items.findIndex((item) => item.id === watchTargets[watch.id]);
    if (index >= 0) items[index] = onOwner(items[index].id, watch.reason, { watchId: watch.id, ...watch.evidence });
  }

  const blocking = items.filter((item) => item.terminal === 'on_owner');
  return {
    terminal: blocking.length ? 'blocked' : 'closed',
    closed: blocking.length === 0,
    items,
    blocking: blocking.map((item) => item.id),
    settledCount: items.length - blocking.length,
    onOwnerCount: blocking.length,
    deadlines,
    watches: watchVerdict,
    provenance: {
      deterministic: true,
      asOf: at,
      genericCloseContract: 'closeDisposition blocks_close/disposition verdicts',
      statutory: deadlines.provenance
    }
  };
};
