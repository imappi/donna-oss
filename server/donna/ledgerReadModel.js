import { ledgerDateOnly } from './ledger.js';
import { roleMeta } from './accountRoles.js';
import { buildSourceImportCompleteness } from './sourceImportCompleteness.js';
import { toUtcIsoDay } from './dates.js';

const numberValue = (value) => {
  const numeric = Number(value || 0);
  return Number.isFinite(numeric) ? numeric : 0;
};

const roundedMoney = (value) => Math.round(numberValue(value) * 100) / 100;

const normalizeAccountType = (value = '') => String(value || '').trim().toLowerCase().replace(/[\s-]+/g, '_');

const isRevenueType = (type = '') => /revenue|income|sales/.test(normalizeAccountType(type));
const isExpenseType = (type = '') => /expense|direct_cost|cost/.test(normalizeAccountType(type));
const isBankType = (type = '') => /bank/.test(normalizeAccountType(type));
const isCashOrBankType = (type = '') => isBankType(type) || normalizeAccountType(type) === 'cash';
// Balance-sheet classifiers. These mirror the canonical account_type vocabulary
// produced by accountTypeFor() in ledger.js (bank/revenue/expense/asset/liability/
// equity/unknown) but stay regex-tolerant of raw Xero/legacy strings so a row
// that never went through normalization still lands in the right section.
const isAssetType = (type = '') => /asset|receivable|prepay|inventory|equipment|fixed|cash/.test(normalizeAccountType(type)) || normalizeAccountType(type) === 'investment';
const isLiabilityType = (type = '') => /liabilit|payable|loan|clearing|suspense|accrual|credit_card|creditcard/.test(normalizeAccountType(type));
const isEquityType = (type = '') => /equity|capital|retained|reserve|drawings/.test(normalizeAccountType(type));

// Which Balance-Sheet section an account belongs to. Revenue/expense are checked
// FIRST so that a 'direct_cost' never gets swept into assets; bank/asset before
// liability/equity. Anything unrecognised is 'unknown' and surfaced as draft-ness.
export const balanceSheetSectionFor = (type = '') => {
  if (isRevenueType(type)) return 'revenue';
  if (isExpenseType(type)) return 'expense';
  if (isBankType(type) || isAssetType(type)) return 'asset';
  if (isLiabilityType(type)) return 'liability';
  if (isEquityType(type)) return 'equity';
  return 'unknown';
};

// Statement classes a canonical role may stand in for when account_type is
// unclassifiable. clearing/control roles are deliberately absent — they stay
// 'unknown' and surface as draft-ness rather than being guessed onto a side.
const ROLE_STATEMENT_CLASSES = new Set(['asset', 'liability', 'equity', 'revenue', 'expense']);

// An account minted at posting time can carry account_type='unknown' while its
// canonical_role WAS resolved at mint time from the explicit seed-name table
// (accountRoles.js — deterministic, never fuzzy). Rendering the persisted role
// is the "render the persisted verdict" rule; leaving the row in the
// unclassified bucket when its role is known would be rendering the gap.
const classifiedAccountType = ({ declaredType = '', canonicalRole = '' } = {}) => {
  if (balanceSheetSectionFor(declaredType) !== 'unknown') return declaredType;
  if (String(canonicalRole || '') === 'asset.cash') return 'bank';
  const roleClass = roleMeta(canonicalRole)?.class || '';
  return ROLE_STATEMENT_CLASSES.has(roleClass) ? roleClass : declaredType || 'unknown';
};

const sortAccounts = (rows = []) =>
  [...rows].sort((a, b) =>
    String(a.code || a.name || '').localeCompare(String(b.code || b.name || ''), undefined, { numeric: true })
  );

const periodStartFor = (periodEnd = ledgerDateOnly(new Date())) => `${String(periodEnd || '').slice(0, 7)}-01`;

// Period bounds are CALENDAR DAYS by contract, so an ISO datetime arriving
// here is always a pg `date` column that was serialized to a UTC instant on
// a non-UTC host and round-tripped back (a January period_start arrives as
// "…-12-31T23:00:00.000Z" — the 2026-08-26 stage-C canary sighting). A blind
// slice(0, 10) keeps the SHIFTED day, which is how a close writer could mint
// a second, off-by-one close_periods row for the same month. Round to the
// nearest UTC midnight instead: correct for any serialization offset within
// ±12h, a no-op for a true midnight instant. Everything else defers to
// ledgerDateOnly (whose datetime truncation stays right for its
// created_at/uploaded_at fallback callers).
const periodDayOnly = (value) => {
  const text = typeof value === 'string' ? value.trim() : '';
  if (/^\d{4}-\d{2}-\d{2}[T ]/.test(text)) {
    const ts = Date.parse(text);
    if (Number.isFinite(ts)) {
      const DAY_MS = 86400000;
      // UTC on purpose: the nearest UTC midnight IS the day the serialized
      // `date` column named — the host zone must not move it again.
      return toUtcIsoDay(Math.round(ts / DAY_MS) * DAY_MS);
    }
  }
  return ledgerDateOnly(value);
};

export const normalizeLedgerPeriod = ({ periodStart, periodEnd } = {}) => {
  const end = periodDayOnly(periodEnd || new Date());
  const start = periodDayOnly(periodStart || periodStartFor(end));
  if (!start || !end || start > end) {
    const error = new Error('A valid ledger period_start and period_end are required.');
    error.statusCode = 400;
    error.code = 'LEDGER_INVALID_PERIOD';
    throw error;
  }
  return { period_start: start, period_end: end };
};

const accountKeyForLine = (line = {}) =>
  line.account_id || [line.account_code || '', line.account_name || '', line.currency || ''].join('|');

// A code-less minted row can end up with its NAME sitting in the code slot
// (the legacy name-as-code fallback) — "Insurance · Insurance". Collapse the
// duplicate instead of rendering it.
const accountLabel = (account = {}) => {
  const explicit = account.account_label || account.label;
  if (explicit) return explicit;
  const code = String(account.code || '').trim();
  const name = String(account.name || '').trim();
  return code && name && code !== name ? `${code} · ${name}` : name || code || account.id || 'Uncoded account';
};

const accountFromLine = ({ line = {}, account = {} } = {}) => ({
  id: account.id || line.account_id || accountKeyForLine(line),
  code: account.code || line.account_code || null,
  name: account.name || line.account_name || 'Uncoded account',
  account_type: classifiedAccountType({
    declaredType: account.account_type || account.type || line.account_type || 'unknown',
    canonicalRole: account.canonical_role || line.canonical_role || ''
  }),
  canonical_role: account.canonical_role || line.canonical_role || null,
  ...(account.statutory_group ? { statutory_group: account.statutory_group } : {}),
  normal_balance: account.normal_balance || line.normal_balance || 'debit',
  currency: line.currency || account.currency || null,
  account_label: accountLabel({
    ...account,
    code: account.code || line.account_code,
    name: account.name || line.account_name
  })
});

const lineDate = (line = {}) => ledgerDateOnly(line.journal_date || line.date || line.transaction_date || line.created_at);

const reviewStateFor = (item = {}) =>
  String(item.review_state || item.reviewState || item.payload?.review_state || item.payload?.reviewState || item.status || '').trim().toLowerCase();

const xeroMirrorStateFor = (transaction = {}) => {
  if (transaction.xero_sync_error || transaction.xero_error || transaction.xero_writeback_error) return 'error';
  if (transaction.xero_bank_transaction_id || transaction.xero_synced_at || transaction.xero_sync_status === 'synced') return 'exported';
  return 'pending';
};

const buildTrialBalance = ({ accountsById, lines = [] } = {}) => {
  const balances = new Map();
  for (const line of lines) {
    const account = accountFromLine({ line, account: accountsById.get(line.account_id) || {} });
    const key = account.id;
    const current = balances.get(key) || {
      ...account,
      debit_movement: 0,
      credit_movement: 0,
      debit_balance: 0,
      credit_balance: 0,
      balance: 0
    };
    current.debit_movement = roundedMoney(current.debit_movement + numberValue(line.debit));
    current.credit_movement = roundedMoney(current.credit_movement + numberValue(line.credit));
    const signed = current.normal_balance === 'credit'
      ? current.credit_movement - current.debit_movement
      : current.debit_movement - current.credit_movement;
    current.balance = roundedMoney(signed);
    current.debit_balance = roundedMoney(signed > 0 && current.normal_balance !== 'credit' ? signed : signed < 0 && current.normal_balance === 'credit' ? Math.abs(signed) : 0);
    current.credit_balance = roundedMoney(signed > 0 && current.normal_balance === 'credit' ? signed : signed < 0 && current.normal_balance !== 'credit' ? Math.abs(signed) : 0);
    balances.set(key, current);
  }

  const accounts = Array.from(balances.values()).sort((a, b) =>
    String(a.code || a.name || '').localeCompare(String(b.code || b.name || ''), undefined, { numeric: true })
  );
  const totalDebit = roundedMoney(accounts.reduce((sum, account) => sum + account.debit_balance, 0));
  const totalCredit = roundedMoney(accounts.reduce((sum, account) => sum + account.credit_balance, 0));
  return {
    accounts,
    total_debit: totalDebit,
    total_credit: totalCredit,
    imbalance: roundedMoney(totalDebit - totalCredit),
    balanced: Math.abs(roundedMoney(totalDebit - totalCredit)) < 0.01
  };
};

const buildProfitAndLoss = ({ accountsById, periodLines = [] } = {}) => {
  const accounts = new Map();
  for (const line of periodLines) {
    const account = accountFromLine({ line, account: accountsById.get(line.account_id) || {} });
    if (!isRevenueType(account.account_type) && !isExpenseType(account.account_type)) continue;
    const key = account.id;
    const current = accounts.get(key) || {
      ...account,
      section: isRevenueType(account.account_type) ? 'revenue' : 'expense',
      revenue: 0,
      expense: 0,
      net: 0
    };
    const debit = numberValue(line.debit);
    const credit = numberValue(line.credit);
    if (isRevenueType(account.account_type)) current.revenue = roundedMoney(current.revenue + credit - debit);
    if (isExpenseType(account.account_type)) current.expense = roundedMoney(current.expense + debit - credit);
    current.net = roundedMoney(current.revenue - current.expense);
    accounts.set(key, current);
  }
  const rows = Array.from(accounts.values()).sort((a, b) =>
    String(a.code || a.name || '').localeCompare(String(b.code || b.name || ''), undefined, { numeric: true })
  );
  const revenue = roundedMoney(rows.reduce((sum, account) => sum + account.revenue, 0));
  const expenses = roundedMoney(rows.reduce((sum, account) => sum + account.expense, 0));
  return {
    accounts: rows,
    revenue,
    expenses,
    net_income: roundedMoney(revenue - expenses)
  };
};

const buildCashSummary = ({ accountsById, allLines = [] } = {}) => {
  const balances = new Map();
  for (const line of allLines) {
    const account = accountFromLine({ line, account: accountsById.get(line.account_id) || {} });
    if (!isCashOrBankType(account.account_type)) continue;
    const key = account.id;
    const current = balances.get(key) || {
      ...account,
      balance: 0,
      debit: 0,
      credit: 0
    };
    current.debit = roundedMoney(current.debit + numberValue(line.debit));
    current.credit = roundedMoney(current.credit + numberValue(line.credit));
    current.balance = roundedMoney(current.debit - current.credit);
    balances.set(key, current);
  }
  const accounts = Array.from(balances.values()).sort((a, b) =>
    String(a.code || a.name || '').localeCompare(String(b.code || b.name || ''), undefined, { numeric: true })
  );
  return {
    accounts,
    total: roundedMoney(accounts.reduce((sum, account) => sum + account.balance, 0))
  };
};

// Balance Sheet as-of a date, derived from the same per-account balances the
// trial balance already computes (so the two can never silently disagree).
//
// Footing guarantee: because the trial balance balances (sum of debit balances ==
// sum of credit balances), grouping those same balances into Assets / Liabilities /
// Equity and rolling net income (revenue - expense) into equity makes A = L + E
// foot EXACTLY — and only fails to foot by precisely the trial balance's own
// imbalance. We still assert it here (the Keep-layer footing discipline); we never
// render a Balance Sheet that doesn't foot without saying so loudly.
//
// Net income here is CUMULATIVE to the as-of date (it is read off the trial
// balance, which aggregates every line up to period_end), i.e. retained + current
// earnings — the correct equity figure for an as-of statement, distinct from the
// PERIOD net income shown on the P&L.
//
// FI-6 Half B (year-2 carryforward): when `earningsSplit` is supplied (the caller
// resolved a tilikausi under FINLAND_OPENING_BALANCES), that single cumulative
// earnings line is split into the two statutory Finnish equity captions —
// *edellisten tilikausien voitto/tappio* (prior tilikaudet, lines dated before the
// tilikausi start) and *tilikauden voitto/tappio* (this tilikausi). The split sums
// to the same total, so the balance sheet foots IDENTICALLY (KEEP-layer invariant,
// asserted below). Off (earningsSplit null) ⇒ the single-line behaviour is
// byte-identical (year-1 greenfield is unaffected).
//
// Uncoded ('unknown') accounts are placed on the side their balance naturally
// falls (net debit -> assets, net credit -> liabilities) so the statement still
// foots, AND listed separately under `unclassified` so the draft-ness is surfaced,
// never hidden behind a clean-looking total.
const buildBalanceSheet = ({ trialBalance, asOf, earningsSplit = null } = {}) => {
  const assets = [];
  const liabilities = [];
  const equity = [];
  const unclassified = [];
  let netIncome = 0;

  for (const account of trialBalance?.accounts || []) {
    // Debit-natural value: positive = a debit (asset) balance, negative = a credit
    // (liability/equity) balance. credit_balance/debit_balance are already signed
    // so exactly one is non-zero per account.
    const debitNatural = roundedMoney(numberValue(account.debit_balance) - numberValue(account.credit_balance));
    const creditNatural = roundedMoney(-debitNatural);
    const section = balanceSheetSectionFor(account.account_type);

    if (section === 'revenue' || section === 'expense') {
      // Revenue accounts are credit-natural (creditNatural > 0 adds to income),
      // expense accounts debit-natural (creditNatural < 0 subtracts). The sum is
      // net income.
      netIncome = roundedMoney(netIncome + creditNatural);
      continue;
    }

    if (section === 'asset') {
      assets.push({ ...account, amount: debitNatural });
    } else if (section === 'liability') {
      liabilities.push({ ...account, amount: creditNatural });
    } else if (section === 'equity') {
      equity.push({ ...account, amount: creditNatural });
    } else {
      // Unknown / uncoded: foot it on the side its balance falls, flag it.
      const natural_side = debitNatural >= 0 ? 'asset' : 'liability';
      const row = { ...account, amount: natural_side === 'asset' ? debitNatural : creditNatural, unclassified: true, natural_side };
      unclassified.push({ ...account, amount: debitNatural, natural_side });
      if (natural_side === 'asset') assets.push(row);
      else liabilities.push(row);
    }
  }

  // The synthetic earnings row(s). Default: one cumulative line (retained +
  // current). FI-6 Half B: two lines split by the tilikausi boundary. `current`
  // is derived as (netIncome - prior) so the two ALWAYS sum to netIncome to the
  // cent — the balance sheet foots identically to the single-line form.
  let earningsRows;
  if (earningsSplit && Number.isFinite(numberValue(earningsSplit.prior_years))) {
    const priorYears = roundedMoney(numberValue(earningsSplit.prior_years));
    const currentYear = roundedMoney(netIncome - priorYears);
    earningsRows = [
      {
        id: '__prior_years_earnings__',
        code: null,
        name: 'Edellisten tilikausien voitto (tappio)',
        account_type: 'equity',
        amount: priorYears,
        synthetic: true,
        statutory_group: 'retained_earnings'
      },
      {
        id: '__current_year_earnings__',
        code: null,
        name: 'Tilikauden voitto (tappio)',
        account_type: 'equity',
        amount: currentYear,
        synthetic: true,
        statutory_group: 'profit_for_year'
      }
    ];
  } else {
    earningsRows = [
      {
        id: '__retained_and_current_earnings__',
        code: null,
        name: 'Retained earnings & current earnings',
        account_type: 'equity',
        amount: netIncome,
        synthetic: true
      }
    ];
  }
  const equityRows = [...equity, ...earningsRows];

  const totalAssets = roundedMoney(assets.reduce((sum, row) => sum + row.amount, 0));
  const totalLiabilities = roundedMoney(liabilities.reduce((sum, row) => sum + row.amount, 0));
  const totalEquity = roundedMoney(equityRows.reduce((sum, row) => sum + row.amount, 0));
  const liabilitiesAndEquity = roundedMoney(totalLiabilities + totalEquity);
  const imbalance = roundedMoney(totalAssets - liabilitiesAndEquity);

  return {
    as_of: asOf,
    assets: { accounts: sortAccounts(assets), total: totalAssets },
    liabilities: { accounts: sortAccounts(liabilities), total: totalLiabilities },
    equity: { accounts: sortAccounts(equityRows), total: totalEquity },
    net_income: netIncome,
    unclassified: {
      accounts: sortAccounts(unclassified),
      total: roundedMoney(unclassified.reduce((sum, row) => sum + Math.abs(row.amount), 0))
    },
    total_assets: totalAssets,
    total_liabilities: totalLiabilities,
    total_equity: totalEquity,
    total_liabilities_and_equity: liabilitiesAndEquity,
    imbalance,
    balanced: Math.abs(imbalance) < 0.01
  };
};

const buildReviewCounts = ({ transactions = [], reviewItems = [], periodStart, periodEnd } = {}) => {
  const reviewByTransactionId = new Map();
  for (const item of reviewItems) {
    const transactionId = item.transaction_id || item.transactionId || item.payload?.transaction_id || item.payload?.transactionId || item.item_id;
    if (transactionId) reviewByTransactionId.set(transactionId, item);
  }

  const counts = {
    total: 0,
    suggested: 0,
    accepted: 0,
    asked_client: 0,
    waiting: 0,
    held: 0,
    resolved: 0,
    posted: 0,
    closed: 0,
    unposted: 0
  };
  const xeroMirror = { exported: 0, pending: 0, error: 0 };

  for (const transaction of transactions) {
    const date = ledgerDateOnly(transaction.date || transaction.transaction_date);
    if (!date || date < periodStart || date > periodEnd) continue;
    counts.total += 1;
    const review = reviewByTransactionId.get(transaction.id) || {};
    const state = reviewStateFor({ ...transaction, payload: { ...(transaction.payload || {}), ...(review.payload || {}) }, review_state: review.review_state || transaction.review_state });
    const posted = transaction.ledger_status === 'posted' || transaction.ledger_journal_id || state === 'posted' || state === 'closed';
    if (posted) counts.posted += 1;
    if (state === 'held') counts.held += 1;
    else if (state === 'waiting') counts.waiting += 1;
    else if (state === 'asked_client') counts.asked_client += 1;
    else if (state === 'accepted') counts.accepted += 1;
    else if (state === 'resolved') counts.resolved += 1;
    else if (state === 'closed') counts.closed += 1;
    else if (!posted) counts.suggested += 1;
    if (!posted) counts.unposted += 1;
    xeroMirror[xeroMirrorStateFor(transaction)] += 1;
  }

  return { counts, xeroMirror };
};

const check = ({ type, status, summary, count = null, payload = {} }) => ({
  check_type: type,
  status,
  summary,
  count,
  payload
});

export const buildLedgerPeriodReadModel = ({
  clientId,
  periodStart,
  periodEnd,
  ledgerAccounts = [],
  ledgerJournals = [],
  ledgerLines = [],
  documents = [],
  transactions = [],
  transactionReviewQueue = [],
  closePeriod = null,
  closeChecks = [],
  sourceImportRequired = false,
  basis = 'accrual',
  fiscalYear = null,
  // G-13 (D-P2-6): arms the statement-coverage close blocker inside the
  // source-import check. Default false — byte-identical to pre-G-13.
  requireStatementCoverage = false
} = {}) => {
  const period = normalizeLedgerPeriod({ periodStart, periodEnd });
  const normalizedBasis = String(basis || '').trim().toLowerCase() === 'cash' ? 'cash' : 'accrual';
  const accountsById = new Map(ledgerAccounts.map((account) => [account.id, account]));
  const journalsById = new Map(ledgerJournals.map((journal) => [journal.id, journal]));
  const allUsableLines = ledgerLines
    .map((line) => {
      const journal = journalsById.get(line.journal_id) || {};
      return {
        ...line,
        journal_date: line.journal_date || journal.journal_date,
        journal_status: line.journal_status || journal.status || 'posted'
      };
    })
    .filter((line) => line.client_id === clientId)
    .filter((line) => line.journal_status !== 'voided')
    .filter((line) => {
      const date = lineDate(line);
      return date && date <= period.period_end;
    });

  // Cash basis = lines belonging to a journal that actually moved money through a
  // bank/cash account. Accrual basis = the full general ledger. Donna's journals
  // are currently all bank-settlement journals, so the two sets are identical
  // today; `bases_identical` reports that honestly. The filter only diverges once
  // accrual-only (e.g. AR/AP) journals exist that never touch a bank account.
  const cashJournalIds = new Set(
    allUsableLines
      .filter((line) => isCashOrBankType(accountFromLine({ line, account: accountsById.get(line.account_id) || {} }).account_type))
      .map((line) => line.journal_id)
      .filter(Boolean)
  );
  const isCashLine = (line) => cashJournalIds.has(line.journal_id);
  const cashUsableLines = allUsableLines.filter(isCashLine);
  const basesIdentical = cashUsableLines.length === allUsableLines.length;
  const usableLines = normalizedBasis === 'cash' ? cashUsableLines : allUsableLines;
  const periodLines = usableLines.filter((line) => {
    const date = lineDate(line);
    return date >= period.period_start && date <= period.period_end;
  });

  const trialBalance = buildTrialBalance({ accountsById, lines: usableLines });
  const profitAndLoss = buildProfitAndLoss({ accountsById, periodLines });

  // FI-6 Half B (year-2 carryforward): when a tilikausi is resolved (the caller
  // acts under FINLAND_OPENING_BALANCES), split cumulative equity earnings into
  // prior tilikaudet vs this tilikausi. `prior_years` is the net income of the
  // rev/exp lines dated BEFORE the tilikausi start — computed with the SAME
  // aggregation as the P&L (buildProfitAndLoss) so the method is consistent; the
  // current-year figure is derived in buildBalanceSheet as (netIncome - prior)
  // so the split foots exactly. Ties (date == starts_on) belong to the current
  // year (the tilikausi is [starts_on, ends_on] inclusive). Off ⇒ null ⇒ the
  // single cumulative line is byte-identical.
  const tilikausiStart = fiscalYear && typeof fiscalYear.starts_on === 'string' ? fiscalYear.starts_on : null;
  const earningsSplit = tilikausiStart
    ? {
        prior_years: buildProfitAndLoss({
          accountsById,
          periodLines: usableLines.filter((line) => {
            const date = lineDate(line);
            return date && date < tilikausiStart;
          })
        }).net_income
      }
    : null;

  const balanceSheet = buildBalanceSheet({ trialBalance, asOf: period.period_end, earningsSplit });
  const cash = buildCashSummary({ accountsById, allLines: usableLines });

  // Presentation currency is read straight off the ledger lines (no FX, ever — the
  // ledger stores no rate, so converting would be a non-deterministic number).
  // One currency -> present in it; multiple -> `mixed` is true and callers must
  // subtotal by currency rather than sum a meaningless cross-currency total.
  const currencies = Array.from(
    new Set(allUsableLines.map((line) => String(line.currency || '').trim().toUpperCase()).filter(Boolean))
  ).sort();
  const currency = {
    presentation: currencies.length === 1 ? currencies[0] : null,
    currencies,
    mixed: currencies.length > 1
  };
  const { counts: reviewCounts, xeroMirror } = buildReviewCounts({
    transactions,
    reviewItems: transactionReviewQueue,
    periodStart: period.period_start,
    periodEnd: period.period_end
  });
  const sourceImport = sourceImportRequired
    ? buildSourceImportCompleteness({
        clientId,
        periodStart: period.period_start,
        periodEnd: period.period_end,
        documents,
        transactions,
        requireCoverageToPeriodEnd: requireStatementCoverage === true
      })
    : null;

  const periodJournalIds = new Set(periodLines.map((line) => line.journal_id).filter(Boolean));
  const blockedCount = reviewCounts.unposted + reviewCounts.waiting + reviewCounts.asked_client + reviewCounts.held;
  const generatedChecks = [
    ...(sourceImport
      ? [
          check({
            type: 'source_import',
            status: sourceImport.status === 'blocked' ? 'blocked' : sourceImport.status === 'warning' ? 'warning' : 'passed',
            summary: sourceImport.summary || 'Source import completeness checked.',
            count:
              (sourceImport.transactions_without_document?.length || 0) +
              (sourceImport.orphan_document_ids?.length || 0) +
              (sourceImport.duplicate_groups?.length || 0) +
              (sourceImport.statement_proof?.issues?.length || 0),
            payload: {
              bank_statement_count: sourceImport.bank_statement_count || 0,
              transaction_count: sourceImport.transaction_count || 0,
              statement_proof: sourceImport.statement_proof || null
            }
          })
        ]
      : []),
    check({
      type: 'ledger_balance',
      status: trialBalance.balanced ? 'passed' : 'blocked',
      summary: trialBalance.balanced
        ? 'Ledger debits and credits balance.'
        : `Ledger is out of balance by ${trialBalance.imbalance}.`,
      payload: { imbalance: trialBalance.imbalance }
    }),
    check({
      type: 'posting_completeness',
      status: reviewCounts.unposted === 0 ? 'passed' : 'blocked',
      summary: reviewCounts.unposted === 0
        ? 'All period transactions are posted to the Donna ledger.'
        : `${reviewCounts.unposted} period transaction${reviewCounts.unposted === 1 ? '' : 's'} still need posting.`,
      count: reviewCounts.unposted
    }),
    check({
      type: 'client_evidence',
      status: reviewCounts.waiting + reviewCounts.asked_client + reviewCounts.held === 0 ? 'passed' : 'warning',
      summary: reviewCounts.waiting + reviewCounts.asked_client + reviewCounts.held === 0
        ? 'No client evidence blockers are open for this period.'
        : `${reviewCounts.waiting + reviewCounts.asked_client + reviewCounts.held} period item${reviewCounts.waiting + reviewCounts.asked_client + reviewCounts.held === 1 ? '' : 's'} need client evidence or reviewer hold.`,
      count: reviewCounts.waiting + reviewCounts.asked_client + reviewCounts.held
    }),
    check({
      type: 'xero_mirror',
      status: xeroMirror.error > 0 ? 'warning' : 'passed',
      summary: xeroMirror.error > 0
        ? `${xeroMirror.error} Xero mirror export${xeroMirror.error === 1 ? '' : 's'} need retry.`
        : `${xeroMirror.exported}/${reviewCounts.total} period transaction${reviewCounts.total === 1 ? '' : 's'} exported to the Xero mirror.`,
      count: xeroMirror.error,
      payload: xeroMirror
    })
  ];

  const allChecks = [
    ...generatedChecks,
    ...closeChecks.map((item) => ({
      ...item,
      source: 'persisted'
    }))
  ];
  const status = blockedCount > 0 || !trialBalance.balanced || sourceImport?.status === 'blocked'
    ? 'blocked'
    : allChecks.some((item) => item.status === 'warning')
      ? 'review'
      : 'ready';

  return {
    source: 'ledger_period_preview',
    generated_at: new Date().toISOString(),
    client_id: clientId,
    period_start: period.period_start,
    period_end: period.period_end,
    basis: normalizedBasis,
    bases_identical: basesIdentical,
    currency,
    // FI-6 Half B: the resolved tilikausi bounds this read model is split against
    // (null when FINLAND_OPENING_BALANCES does not act). Lets FI-12/FI-7 aggregate
    // the right annual window and renders the persisted split, not a UI inference.
    tilikausi: tilikausiStart
      ? { label: fiscalYear.label || null, starts_on: fiscalYear.starts_on, ends_on: fiscalYear.ends_on || null }
      : null,
    ledger_period: {
      ...(closePeriod || {}),
      client_id: clientId,
      period_start: period.period_start,
      period_end: period.period_end,
      status: closePeriod?.status || 'preview',
      posted_journal_count: periodJournalIds.size,
      ledger_line_count: periodLines.length
    },
    trial_balance: trialBalance,
    profit_and_loss: profitAndLoss,
    balance_sheet: balanceSheet,
    cash,
    review_counts: reviewCounts,
    xero_mirror: xeroMirror,
    source_import: sourceImport,
    close_preview: {
      status,
      lockable: status === 'ready',
      checks: allChecks
    }
  };
};

// Exported so persisted-state observers (firmDb readTerminalInventoryInDb)
// share the same closed-status vocabulary as the preview's draft verdict —
// one source, no drift.
export const CLOSED_PERIOD_STATUSES = new Set(['locked', 'closed', 'archived', 'final']);

// The honest draft-ness verdict for a statement. A report is a DRAFT unless the
// period is closed AND nothing about the books is still incomplete. We surface the
// specific reasons (out of balance, uncoded accounts, unposted lines, open client
// questions) rather than hiding them behind a clean-looking total. The `stamp`
// drives the PDF/CSV header so a client can never mistake a half-coded export for
// a final statement.
export const buildReportDraftState = ({ readModel = {}, closePeriod = null, salesRecognition = null, purchaseRecognition = null } = {}) => {
  const reasons = [];
  const trialBalance = readModel.trial_balance || {};
  const balanceSheet = readModel.balance_sheet || null;
  const reviewCounts = readModel.review_counts || {};

  if (trialBalance.balanced === false) {
    reasons.push({ code: 'ledger_imbalance', detail: `Ledger debits and credits differ by ${trialBalance.imbalance}.` });
  }
  if (balanceSheet && balanceSheet.balanced === false) {
    reasons.push({ code: 'balance_sheet_imbalance', detail: `Balance sheet does not foot by ${balanceSheet.imbalance}.` });
  }
  const unclassifiedTotal = balanceSheet?.unclassified?.total || 0;
  const unclassifiedCount = balanceSheet?.unclassified?.accounts?.length || 0;
  if (unclassifiedCount > 0 && Math.abs(unclassifiedTotal) > 0.005) {
    reasons.push({
      code: 'unclassified_accounts',
      detail: `${unclassifiedCount} account${unclassifiedCount === 1 ? '' : 's'} not yet classified (${unclassifiedTotal}).`,
      amount: roundedMoney(unclassifiedTotal),
      count: unclassifiedCount
    });
  }
  const unposted = numberValue(reviewCounts.unposted);
  if (unposted > 0) {
    reasons.push({ code: 'unposted_transactions', detail: `${unposted} transaction${unposted === 1 ? '' : 's'} not yet posted to the ledger.`, count: unposted });
  }
  const pendingQuestions = numberValue(reviewCounts.waiting) + numberValue(reviewCounts.asked_client) + numberValue(reviewCounts.held);
  if (pendingQuestions > 0) {
    reasons.push({ code: 'pending_questions', detail: `${pendingQuestions} item${pendingQuestions === 1 ? '' : 's'} awaiting client evidence or review.`, count: pendingQuestions });
  }
  // FI-09: uploaded sales documents, and separately uploaded supplier
  // documents, the posted ledger does not recognise in this period
  // (salesRecognitionGap.js) — the statement says what it omits.
  if (salesRecognition?.code) reasons.push(salesRecognition);
  if (purchaseRecognition?.code) reasons.push(purchaseRecognition);

  const periodClosed = CLOSED_PERIOD_STATUSES.has(String(closePeriod?.status || '').trim().toLowerCase());
  const isDraft = !periodClosed || reasons.length > 0;
  return {
    is_draft: isDraft,
    period_closed: periodClosed,
    stamp: isDraft ? 'DRAFT' : 'FINAL',
    reasons
  };
};

// Projects the close-flow read model into a stable, presentation-oriented report
// shape (P&L + Balance Sheet + Trial Balance + cash + draft verdict) for the report
// endpoint, shared by the client portal and the firm console. It carries NO new
// numbers — every figure is the deterministic GL aggregation already computed by
// buildLedgerPeriodReadModel.
export const buildFinancialReport = ({ firmId = null, clientId = null, readModel = {}, salesRecognition = null, purchaseRecognition = null } = {}) => {
  const closePeriod = readModel.ledger_period || null;
  return {
    source: 'donna_ledger',
    generated_at: new Date().toISOString(),
    firm_id: firmId,
    client_id: clientId || readModel.client_id || null,
    period_start: readModel.period_start,
    period_end: readModel.period_end,
    as_of: readModel.period_end,
    basis: readModel.basis || 'accrual',
    bases_identical: readModel.bases_identical !== false,
    currency: readModel.currency || { presentation: null, currencies: [], mixed: false },
    profit_and_loss: readModel.profit_and_loss,
    balance_sheet: readModel.balance_sheet,
    trial_balance: readModel.trial_balance,
    cash: readModel.cash,
    ledger_period: closePeriod,
    draft: buildReportDraftState({ readModel, closePeriod, salesRecognition, purchaseRecognition })
  };
};
