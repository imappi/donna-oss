import { readAccountingCurrency, accountingProfileFailures } from '../../../src/lib/accountingProfile.js';
import { createHash } from 'node:crypto';
import { roleMeta } from '../accountRoles.js';
import { toIsoDay, toUtcIsoDay } from '../dates.js';

export const AE_OPENING_BALANCES_FLAG_KEY = 'AE_OPENING_BALANCES';
export const AE_OPENING_ASK_KIND = 'ae_opening_balance';
export const AE_OPENING_SUPPORTED_ROLES = Object.freeze([
  'asset.cash', 'asset.fixed', 'liability.director_loan',
  'equity.share_capital', 'equity.share_premium', 'equity.retained_earnings'
]);
export const AE_OPENING_LIMITATIONS = Object.freeze([
  'Nonzero AR/AP, inventory and tax controls require an opening subledger capability not supported by this slice. Never omit real balances to pass.',
  'No tax carry-forwards, FX, depreciation schedules, mid-period profit and loss or statutory migration admission.'
]);
export const aeOpeningError = (code, message) => Object.assign(new Error(message), { code, statusCode: 409 });
const stable = value => Array.isArray(value) ? value.map(stable)
  : value && typeof value === 'object' && !(value instanceof Date)
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;
export const aeOpeningDigest = value => createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
export const aeOpeningDay = value => {
  const day = value instanceof Date ? toIsoDay(value) : value;
  if (typeof day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(day)
    || Number.isNaN(Date.parse(`${day}T00:00:00Z`))
    || toUtcIsoDay(new Date(`${day}T00:00:00Z`)) !== day) {
    throw aeOpeningError('AE_OPENING_DATE_REQUIRED', 'Provide a valid calendar date.');
  }
  return day;
};
export const aeOpeningFils = value => {
  const text = String(value ?? '').trim();
  if (!/^\d+(\.\d{1,2})?$/.test(text)) throw aeOpeningError('AE_OPENING_AMOUNT_INVALID', 'Each balance must be a nonnegative AED amount with at most two decimals.');
  const [whole, fraction = ''] = text.split('.');
  const amount = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  if (!Number.isSafeInteger(amount) || amount > 1e12) throw aeOpeningError('AE_OPENING_AMOUNT_INVALID', 'Opening amount exceeds the supported exact-decimal range.');
  return amount;
};
export const assertAeOpeningIdentity = row => {
  if (String(row?.jurisdiction || '').toLowerCase() !== 'ae'
    || (row.profile?.jurisdiction && String(row.profile.jurisdiction).toLowerCase() !== 'ae')) {
    throw aeOpeningError('AE_OPENING_JURISDICTION_REQUIRED', 'Opening intake requires current authoritative AE identity.');
  }
  if (row.entity_type !== 'ae-llc') throw aeOpeningError('AE_OPENING_ENTITY_UNSUPPORTED', 'This opening intake supports ordinary AE LLCs only.');
  const currency=readAccountingCurrency(row.profile,{defaultCurrency:null});
  if (currency.status !== 'stated' || currency.value !== 'AED') throw aeOpeningError('AE_OPENING_CURRENCY_REQUIRED', 'Record AED as the authoritative accounting currency before opening intake.');
  if (row.profile?.accounting_system !== 'none' || accountingProfileFailures(row.profile).length) throw aeOpeningError('AE_OPENING_BOOK_UNSUPPORTED', 'This intake requires a consistent management-books view and a supported cash or accrual method when stated.');
};

// Explicit declarations only: account classification comes from the persisted
// chart. No filename, prose or bank-balance inference is an intake authority.
export const normalizeAeOpeningTrialBalance = ({ intake = {}, chart = [], period, clientRow } = {}) => {
  assertAeOpeningIdentity(clientRow);
  const asOf = aeOpeningDay(intake.as_of);
  const startsOn = aeOpeningDay(period.starts_on);
  if (asOf !== startsOn) throw aeOpeningError('AE_OPENING_PERIOD_START_REQUIRED', 'Opening date must equal the recorded fiscal-period start.');
  if (!clientRow.incorporation_date || aeOpeningDay(clientRow.incorporation_date) >= asOf) throw aeOpeningError('OPENING_BALANCE_GREENFIELD_NO_SEED', 'An opening trial balance requires an existing business incorporated before the opening date.');
  if (!Array.isArray(intake.declared_lines) || !intake.declared_lines.length || intake.complete !== true) return {
    terminal: 'owner_ask', code: 'AE_OPENING_COMPLETE_TB_REQUIRED',
    question: 'Provide the complete closing trial balance, its source document and date, then confirm that every opening balance is included. A bank opening balance alone does not establish a complete balance sheet.'
  };
  if (intake.currency !== 'AED') throw aeOpeningError('AE_OPENING_CURRENCY_REQUIRED', 'Declare AED explicitly for the complete trial balance.');
  const sourceAsOf = aeOpeningDay(intake.source_as_of);
  if (new Date(`${sourceAsOf}T00:00:00Z`).getTime() + 86400000 !== new Date(`${asOf}T00:00:00Z`).getTime()) throw aeOpeningError('AE_OPENING_SOURCE_DATE_CONFLICT', 'The source closing date must immediately precede the opening date.');
  if (intake.statutory_carry_forwards?.length) throw aeOpeningError('AE_OPENING_CARRY_IN_UNSUPPORTED', AE_OPENING_LIMITATIONS[1]);
  if (intake.declared_lines.length > 500 || intake.declared_lines.some(line=>!line || typeof line !== 'object')) throw aeOpeningError('AE_OPENING_AMOUNT_INVALID','Provide at most 500 explicit account balances.');
  const seen = new Set();
  let debits = 0, credits = 0, assets = 0, liabilities = 0, equity = 0;
  const openingLines = intake.declared_lines.map(line => {
    if (line.currency != null && line.currency !== 'AED') throw aeOpeningError('AE_OPENING_CURRENCY_REQUIRED', 'Every trial-balance line must be denominated in AED.');
    const account = chart.find(a => a.id === line.account_id);
    const role = account?.canonical_role;
    if (!account || account.status !== 'active' || !role || (account.currency != null && account.currency !== 'AED')
      || chart.filter(a => a.status === 'active' && a.canonical_role === role).length !== 1) throw aeOpeningError('AE_OPENING_ACCOUNT_REQUIRED', 'Select an active AED account with an unambiguous canonical role from the current chart.');
    if (seen.has(account.id)) throw aeOpeningError('AE_OPENING_ACCOUNT_DUPLICATE', 'Each account may appear only once in the trial balance.');
    seen.add(account.id);
    const debit = aeOpeningFils(line.debit ?? 0), credit = aeOpeningFils(line.credit ?? 0);
    if (debit && credit) throw aeOpeningError('AE_OPENING_AMOUNT_INVALID', 'A trial-balance line cannot have both a debit and a credit.');
    if ((debit || credit) && !AE_OPENING_SUPPORTED_ROLES.includes(role)) throw aeOpeningError('AE_OPENING_CARRY_IN_UNSUPPORTED', AE_OPENING_LIMITATIONS[0]);
    const meta = roleMeta(role);
    if (!['asset','liability','equity'].includes(meta?.class) || ![meta.class, ...(role === 'asset.cash' ? ['bank'] : [])].includes(account.account_type)
      || account.normal_balance !== meta.normal_balance) throw aeOpeningError('AE_OPENING_ACCOUNT_CLASS_CONFLICT', 'The persisted account class and canonical role disagree. Repair the chart before intake.');
    debits += debit; credits += credit;
    if (meta.class === 'asset') assets += debit - credit;
    if (meta.class === 'liability') liabilities += credit - debit;
    if (meta.class === 'equity') equity += credit - debit;
    return { account: { code: account.code, name: account.name, type: account.account_type, normal_balance: account.normal_balance, canonical_role: role }, debit: debit / 100, credit: credit / 100 };
  });
  if (!debits || debits !== credits || assets !== liabilities + equity) throw aeOpeningError('AE_OPENING_UNBALANCED', 'The full trial balance must balance: debits equal credits and assets equal liabilities plus equity.');
  return { terminal: 'proposal', proposal: { currency: 'AED', as_of: asOf, source_as_of: sourceAsOf,
    openingLines: openingLines.filter(line => line.debit || line.credit), totals: { debit: debits / 100, credit: credits / 100, assets: assets / 100, liabilities: liabilities / 100, equity: equity / 100 }, limitations: AE_OPENING_LIMITATIONS } };
};
