// Statutory-watch rows for the GB owner-transaction watches — the mount that
// takes `directorsLoanAccountWatch` / `soleTraderOwnerEquityWatch` (pure
// functions over a balance, dark since 2026-07-30) onto the `/reports/
// gb-statutory` surface. Pure: balances arrive as grouped role/type sums from
// the route's one query; account identity is CANONICAL ROLE, never an account
// code or a name regex.
//
// Sign conventions, because both watches are sign-sensitive:
// - The DLA balance is DEBIT-normal here (debit − credit over accounts holding
//   `liability.director_loan`): positive means the director owes the company —
//   the overdrawn state s455 cares about.
// - Owner equity is EQUITY-normal (credit − debit over equity + revenue +
//   expense accounts): capital introduced plus current earnings minus drawings
//   and losses. Revenue/expense are included deliberately — equity accounts
//   alone would flag a profitable book whose profits simply have not been
//   closed to equity yet.
import {
  directorsLoanAccountWatch,
  soleTraderOwnerEquityWatch
} from './ownerTransactionTaxonomy.js';

const EQUITY_SIDE_TYPES = new Set(['equity', 'revenue', 'expense']);

export const deriveGbOwnerWatchBalances = ({ rows = [] } = {}) => {
  let dlaBalance = 0;
  let ownerEquityBalance = 0;
  for (const row of Array.isArray(rows) ? rows : []) {
    const credit = Number(row?.credit_total) || 0;
    const debit = Number(row?.debit_total) || 0;
    if (row?.canonical_role === 'liability.director_loan') dlaBalance += debit - credit;
    if (EQUITY_SIDE_TYPES.has(String(row?.account_type || ''))) ownerEquityBalance += credit - debit;
  }
  return { dlaBalance, ownerEquityBalance };
};

const WATCH_ROW_KEYS = Object.freeze({
  GB_DLA_S455_ATTENTION: 'dla_s455',
  GB_DLA_BENEFICIAL_LOAN_ATTENTION: 'dla_beneficial_loan',
  GB_ST_NEGATIVE_OWNER_EQUITY_ATTENTION: 'owner_equity'
});

// Rows share the statutory-view contract (key/label/due_date/terminal/
// reason_code) so `GbStatutoryRows` renders them for free. `on_owner` is the
// honest terminal for both: an overdrawn DLA is the owner's to repay or
// decide; negative sole-trader equity is advisory information that rests with
// the owner — neither ever rests firm-side. No watch firing means NO row:
// absence of an attention state is the watch's clean verdict, not a gap.
export const buildGbOwnerTransactionWatchRows = ({ entityAxis, balanceRows = [], currency = 'GBP' } = {}) => {
  const balances = deriveGbOwnerWatchBalances({ rows: balanceRows });
  const watch = entityAxis === 'ltd'
    ? directorsLoanAccountWatch({ balance: balances.dlaBalance, currency })
    : entityAxis === 'sole_trader'
      ? soleTraderOwnerEquityWatch({ equityBalance: balances.ownerEquityBalance, currency })
      : null;
  if (!watch) return [];
  const label = entityAxis === 'ltd' ? "Director's loan account" : 'Owner equity';
  return watch.watches.map(({ code }) => ({
    key: WATCH_ROW_KEYS[code] || code.toLowerCase(),
    label,
    due_date: null,
    terminal: 'on_owner',
    reason_code: code
  }));
};
