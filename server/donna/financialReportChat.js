// Deterministic bridge between Donna's read-only `open_financials` intent and
// the persisted-ledger report endpoint. The model chooses the venture/month;
// this module resolves a missing month from posted journals and attaches only
// figures already present in buildFinancialReport's read model.

const MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;

export const financialReportPeriodBounds = (period) => {
  const month = String(period || '').trim();
  if (!MONTH_PATTERN.test(month)) return null;
  const [year, monthNumber] = month.split('-').map(Number);
  const lastDay = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
  return {
    periodStart: `${month}-01`,
    periodEnd: `${month}-${String(lastDay).padStart(2, '0')}`
  };
};

const money = (value) => Math.round((Number(value) || 0) * 100) / 100;

export const buildFinancialReportActionSummary = (report = {}) => {
  const pnl = report.profit_and_loss || {};
  const drivers = (Array.isArray(pnl.accounts) ? pnl.accounts : [])
    .map((account) => {
      const section = account.section === 'revenue' ? 'revenue' : 'expense';
      const amount = money(section === 'revenue' ? account.revenue : account.expense);
      return {
        account_label: account.account_label || account.name || account.code || 'Unlabelled account',
        section,
        amount
      };
    })
    .filter((driver) => Math.abs(driver.amount) >= 0.005)
    .sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount)
      || a.account_label.localeCompare(b.account_label))
    .slice(0, 3);

  return {
    available: true,
    period_start: report.period_start || null,
    period_end: report.period_end || null,
    basis: report.basis || 'accrual',
    currency: report.currency || { presentation: null, currencies: [], mixed: false },
    profit_and_loss: {
      revenue: money(pnl.revenue),
      expenses: money(pnl.expenses),
      net_income: money(pnl.net_income)
    },
    cash: { total: money(report.cash?.total) },
    top_drivers: drivers,
    draft: {
      is_draft: report.draft?.is_draft !== false,
      period_closed: report.draft?.period_closed === true,
      stamp: report.draft?.stamp || 'DRAFT',
      reasons: Array.isArray(report.draft?.reasons)
        ? report.draft.reasons.map((reason) => ({
            code: reason.code || 'incomplete',
            detail: reason.detail || 'This period is not complete yet.',
            ...(Number.isFinite(Number(reason.count)) ? { count: Number(reason.count) } : {}),
            ...(Number.isFinite(Number(reason.amount)) ? { amount: money(reason.amount) } : {})
          }))
        : []
    }
  };
};

export const hydrateFinancialReportActions = async ({
  actions = [],
  firmId,
  defaultClientId = null,
  resolveLatestPeriod,
  loadReport
} = {}) => Promise.all((Array.isArray(actions) ? actions : []).map(async (action) => {
  if (action?.type !== 'open_financials') return action;
  const clientId = String(action.client_id || defaultClientId || '').trim();
  if (!clientId) return action;

  let period = MONTH_PATTERN.test(String(action.period || '').trim())
    ? String(action.period).trim()
    : null;
  if (!period && typeof resolveLatestPeriod === 'function') {
    try {
      period = await resolveLatestPeriod({ firmId, clientId });
    } catch (error) {
      console.warn('[financial-report-chat] latest period lookup failed', error?.message || error);
    }
  }
  const bounds = financialReportPeriodBounds(period);
  if (!bounds) {
    return {
      ...action,
      period: null,
      financial_summary: {
        available: false,
        reason: 'No posted ledger activity is available for this venture yet.'
      }
    };
  }

  try {
    const report = await loadReport({
      firmId,
      clientId,
      ...bounds,
      basis: 'accrual'
    });
    return {
      ...action,
      period,
      financial_summary: buildFinancialReportActionSummary(report)
    };
  } catch (error) {
    console.warn('[financial-report-chat] report hydration failed', error?.message || error);
    return {
      ...action,
      period,
      financial_summary: {
        available: false,
        reason: 'The ledger report could not be read just now.'
      }
    };
  }
}));
