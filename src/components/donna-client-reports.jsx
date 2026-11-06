import { useCallback, useEffect, useMemo, useState } from 'react';
import { FormattedMessage, useIntl } from 'react-intl';

import { D } from './shared/design-tokens.js';
import { downloadFinancialReport, fetchFinancialReport, formatFirmError } from '../lib/firmApi.js';
import { BidiText, FormattedValue, IdentifierText } from '../i18n/BidiText.jsx';
import { useInterfaceLocale } from '../i18n/LocaleProvider.jsx';
import { REPORT_DRAFT_REASON_MESSAGE_IDS } from '../i18n/catalogs/remainingSurfaces.en.js';

// Client-facing financial statements (Profit & Loss + Balance Sheet), sourced
// from Donna's OWN posted ledger. The numbers are deterministic GL aggregation
// computed server-side with footing checks — this component only RENDERS the
// persisted verdict; it never computes or re-infers a figure. Draft-ness
// (uncoded / pending / out-of-balance) is surfaced honestly, never hidden behind
// a clean-looking total. The supporting Trial Balance stays on the firm side; the
// client sees the two headline statements plus PDF / CSV downloads. The firm
// can opt into Cash + Trial Balance through showSupportingStatements; both are
// still fields from the same report response, never recomputed here.

const pad2 = (n) => String(n).padStart(2, '0');
const toDateOnly = (date) => `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
const monthStart = (date) => toDateOnly(new Date(date.getFullYear(), date.getMonth(), 1));
const monthEnd = (date) => toDateOnly(new Date(date.getFullYear(), date.getMonth() + 1, 0));
const reportAnchorDate = (value) => {
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ''));
  if (dateOnly) return new Date(Number(dateOnly[1]), Number(dateOnly[2]) - 1, Number(dateOnly[3]));
  return value ? new Date(value) : new Date();
};

const presentationCurrency = (report) => (report?.currency?.mixed ? '' : report?.currency?.presentation || '');

const reportAmount = (formatAmount, value, currency) => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return '—';
  return formatAmount(numeric, {
    currency: String(currency || '').trim().toUpperCase(),
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  });
};

const monoLabel = {
  fontFamily: D.mono,
  fontSize: 11,
  letterSpacing: D.tracking.mono,
  textTransform: 'uppercase',
  color: D.inkMute
};

// Amounts are ALWAYS ink — a statement's numbers are facts, not alerts.
// Negatives read via the shared accounting formatter; `alert` is reserved for genuine
// failure states (footing errors), never for an ordinary credit balance.
const Amount = ({ value, currency, formatAmount, strong = false, alert = false }) => (
  <span
    style={{
      fontFamily: D.mono,
      fontSize: strong ? 14 : 13,
      fontWeight: strong ? 600 : 400,
      fontVariantNumeric: 'tabular-nums',
      color: alert ? D.alert : D.ink,
      whiteSpace: 'nowrap'
    }}
  >
    <FormattedValue>{reportAmount(formatAmount, value, currency)}</FormattedValue>
  </span>
);

const Row = ({ label, value, currency, formatAmount, strong = false, alert = false, indent = 0, muted = false, note = '', dynamicLabel = false }) => (
  <div
    style={{
      display: 'flex',
      alignItems: 'baseline',
      justifyContent: 'space-between',
      gap: '1rem',
      padding: '0.3rem 0',
      paddingInlineStart: indent ? `${indent}rem` : 0,
      borderTop: strong ? `1px solid ${D.rule}` : 'none'
    }}
  >
    <span
      style={{
        fontFamily: D.body,
        fontSize: strong ? 14 : 13,
        fontWeight: strong ? 600 : 400,
        color: alert ? D.alert : muted ? D.inkMute : D.inkSoft
      }}
    >
      {dynamicLabel ? <BidiText direction="auto">{label}</BidiText> : label}
      {note ? (
        <span style={{ fontFamily: D.mono, fontSize: 10, letterSpacing: D.tracking.mono, textTransform: 'uppercase', color: D.inkMute, marginInlineStart: '0.5rem' }}>
          {note}
        </span>
      ) : null}
    </span>
    <Amount value={value} currency={currency} formatAmount={formatAmount} strong={strong} alert={alert} />
  </div>
);

const TrialBalanceRow = ({ label, debit, credit, currency, formatAmount, strong = false, dynamicLabel = false }) => (
  <div
    style={{
      display: 'grid',
      gridTemplateColumns: 'minmax(0, 1fr) auto auto',
      alignItems: 'baseline',
      gap: '0.8rem',
      padding: '0.3rem 0',
      borderTop: strong ? `1px solid ${D.rule}` : 'none'
    }}
  >
    <span style={{ fontFamily: D.body, fontSize: 13, fontWeight: strong ? 600 : 400, color: D.inkSoft }}>
      {dynamicLabel ? <BidiText direction="auto">{label}</BidiText> : label}
    </span>
    <Amount value={debit} currency={currency} formatAmount={formatAmount} strong={strong} />
    <Amount value={credit} currency={currency} formatAmount={formatAmount} strong={strong} />
  </div>
);

const StatementCard = ({ title, subtitle, children }) => (
  <div
    style={{
      border: `1px solid ${D.rule}`,
      background: D.paper,
      padding: 'clamp(1rem, 3vw, 1.5rem)',
      display: 'flex',
      flexDirection: 'column',
      gap: '0.1rem'
    }}
  >
    <div style={{ marginBottom: '0.6rem' }}>
      <div style={{ fontFamily: D.display, fontSize: 22, letterSpacing: D.tracking.tight, color: D.ink }}>{title}</div>
      {subtitle ? <div style={{ ...monoLabel, marginTop: '0.2rem' }}>{subtitle}</div> : null}
    </div>
    {children}
  </div>
);

const Pill = ({ active, onClick, children }) => (
  <button
    type="button"
    onClick={onClick}
    style={{
      fontFamily: D.mono,
      fontSize: 11,
      letterSpacing: D.tracking.mono,
      textTransform: 'uppercase',
      fontWeight: 500,
      padding: '0.4rem 0.85rem',
      border: `1px solid ${D.ink}`,
      background: active ? D.ink : 'transparent',
      color: active ? D.paper : D.ink,
      cursor: 'pointer'
    }}
  >
    {children}
  </button>
);

const DraftReason = ({ reason, trialBalance, balanceSheet, currency, formatAmount }) => {
  const messageId = REPORT_DRAFT_REASON_MESSAGE_IDS[reason?.code] || 'report.reason.unknown';
  if (!REPORT_DRAFT_REASON_MESSAGE_IDS[reason?.code]) {
    return (
      <FormattedMessage
        id={messageId}
        values={{ detail: <BidiText direction="auto">{reason?.detail || reason?.code || '—'}</BidiText> }}
      />
    );
  }

  const values = (() => {
    if (reason.code === 'ledger_imbalance') {
      return { amount: <FormattedValue>{reportAmount(formatAmount, trialBalance?.imbalance, currency)}</FormattedValue> };
    }
    if (reason.code === 'balance_sheet_imbalance') {
      return { amount: <FormattedValue>{reportAmount(formatAmount, balanceSheet?.imbalance, currency)}</FormattedValue> };
    }
    if (reason.code === 'unclassified_accounts') {
      return {
        count: Number(reason.count ?? balanceSheet?.unclassified?.accounts?.length ?? 0),
        amount: <FormattedValue>{reportAmount(formatAmount, reason.amount ?? balanceSheet?.unclassified?.total, currency)}</FormattedValue>
      };
    }
    return { count: Number(reason.count ?? 0) };
  })();

  return <FormattedMessage id={messageId} values={values} />;
};

export default function ClientReports({
  clientId,
  databaseMode = false,
  ventureLabel = '',
  defaultDate = null,
  showSupportingStatements = false,
  embedded = false,
  previewReport = null,
  onDownloadReport = null
} = {}) {
  const intl = useIntl();
  const { formatAmount, formatDate } = useInterfaceLocale();
  const initial = useMemo(() => {
    // DATE strings are accounting calendar dates, not UTC instants. Construct
    // them in local calendar space so a western timezone cannot open July for
    // an explicit 2025-08 report target.
    const base = reportAnchorDate(defaultDate);
    const safe = Number.isFinite(base.getTime()) ? base : new Date();
    return { start: monthStart(safe), end: monthEnd(safe) };
  }, [defaultDate]);

  const [periodStart, setPeriodStart] = useState(initial.start);
  const [periodEnd, setPeriodEnd] = useState(initial.end);
  const [basis, setBasis] = useState('accrual');
  const [report, setReport] = useState(previewReport);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [downloading, setDownloading] = useState('');

  useEffect(() => {
    if (previewReport) {
      setReport(previewReport);
      setLoading(false);
      setError('');
      return undefined;
    }
    if (!databaseMode || !clientId) return undefined;
    const controller = new AbortController();
    setLoading(true);
    setError('');
    fetchFinancialReport({ clientId, periodStart, periodEnd, basis, signal: controller.signal })
      .then((data) => setReport(data))
      .catch((err) => {
        if (err?.name === 'AbortError') return;
        setReport(null);
        setError(formatFirmError(err, intl.formatMessage({ id: 'report.error.loadStatements' })));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [basis, clientId, databaseMode, intl, periodEnd, periodStart, previewReport]);

  const onDownload = useCallback(
    async (format) => {
      setDownloading(format);
      setError('');
      try {
        const canonicalRequest = { clientId, periodStart, periodEnd, basis, format };
        if (onDownloadReport) await onDownloadReport(canonicalRequest);
        else await downloadFinancialReport(canonicalRequest);
      } catch (err) {
        setError(formatFirmError(err, intl.formatMessage(
          { id: 'report.error.download' },
          { format: format.toUpperCase() }
        )));
      } finally {
        setDownloading('');
      }
    },
    [basis, clientId, intl, onDownloadReport, periodEnd, periodStart]
  );

  const currency = presentationCurrency(report);
  const resolvedVentureLabel = ventureLabel || intl.formatMessage({ id: 'report.heading.defaultVenture' });
  const pnl = report?.profit_and_loss;
  const bs = report?.balance_sheet;
  const cash = report?.cash;
  const trialBalance = report?.trial_balance;
  const draft = report?.draft;

  // Statement grouping. `section` is the server's persisted classification;
  // the sign-based fallback only covers reports generated before it existed.
  const pnlSectionFor = (account) => account.section || (Number(account.revenue) !== 0 ? 'revenue' : 'expense');
  const pnlRevenueRows = (pnl?.accounts || []).filter((account) => pnlSectionFor(account) === 'revenue');
  const pnlExpenseRows = (pnl?.accounts || []).filter((account) => pnlSectionFor(account) === 'expense');

  const fieldStyle = {
    fontFamily: D.mono,
    fontSize: 12,
    padding: '0.35rem 0.5rem',
    border: `1px solid ${D.rule}`,
    background: D.paper,
    color: D.ink
  };

  return (
    <section id="reports" style={{ marginTop: embedded ? 0 : 'clamp(2.5rem, 6vw, 4rem)' }}>
      <div style={{ ...monoLabel, marginBlockEnd: '0.4rem' }}>{intl.formatMessage({ id: 'report.heading.eyebrow' })}</div>
      <h2 style={{ fontFamily: D.display, fontSize: 'clamp(28px, 5vw, 40px)', letterSpacing: D.tracking.tight, color: D.ink, margin: '0 0 0.3rem' }}>
        <FormattedMessage
          id="report.heading.title"
          values={{ ventureName: <BidiText direction="auto">{resolvedVentureLabel}</BidiText> }}
        />
      </h2>
      <p style={{ fontFamily: D.body, fontSize: 14, color: D.inkSoft, maxWidth: '46ch', margin: '0 0 1.25rem' }}>
        <FormattedMessage
          id="report.heading.source"
          values={{ date: <FormattedValue>{formatDate(report?.as_of || periodEnd)}</FormattedValue> }}
        />
      </p>

      {/* Controls */}
      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          alignItems: 'flex-end',
          gap: '1rem',
          paddingBottom: '1rem',
          borderBottom: `1px solid ${D.rule}`,
          marginBottom: '1.25rem'
        }}
      >
        <label style={{ display: 'flex', flexDirection: 'column', gap: '0.3rem' }}>
          <span style={monoLabel}>{intl.formatMessage({ id: 'report.control.from' })}</span>
          <input type="date" value={periodStart} max={periodEnd} onChange={(e) => setPeriodStart(e.target.value)} style={fieldStyle} />
        </label>
        <label style={{ display: 'flex', flexDirection: 'column', gap: '0.3rem' }}>
          <span style={monoLabel}>{intl.formatMessage({ id: 'report.control.to' })}</span>
          <input type="date" value={periodEnd} min={periodStart} onChange={(e) => setPeriodEnd(e.target.value)} style={fieldStyle} />
        </label>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.3rem' }}>
          <span style={monoLabel}>{intl.formatMessage({ id: 'report.control.basis' })}</span>
          <div style={{ display: 'flex', gap: '0.4rem' }}>
            <Pill active={basis === 'accrual'} onClick={() => setBasis('accrual')}>{intl.formatMessage({ id: 'report.control.basisAccrual' })}</Pill>
            <Pill active={basis === 'cash'} onClick={() => setBasis('cash')}>{intl.formatMessage({ id: 'report.control.basisCash' })}</Pill>
          </div>
        </div>
        <div style={{ display: 'flex', gap: '0.4rem', marginInlineStart: 'auto' }}>
          <Pill active={false} onClick={() => onDownload('pdf')}>
            {intl.formatMessage({ id: downloading === 'pdf' ? 'report.download.preparing' : 'report.download.pdf' })}
          </Pill>
          <Pill active={false} onClick={() => onDownload('csv')}>
            {intl.formatMessage({ id: downloading === 'csv' ? 'report.download.preparing' : 'report.download.csv' })}
          </Pill>
        </div>
      </div>

      {!databaseMode && (
        <p style={{ fontFamily: D.body, fontSize: 13, color: D.inkMute }}>
          {intl.formatMessage({ id: 'report.empty.notConnected' })}
        </p>
      )}

      {/* Only the FIRST load (no report yet) shows the full-height placeholder.
          A basis/period change keeps the existing report mounted (see below) so
          the page height never collapses. */}
      {databaseMode && loading && !report && (
        <p style={{ ...monoLabel, color: D.inkSoft }}>{intl.formatMessage({ id: 'report.loading.ledger' })}</p>
      )}

      {error ? (
        <p style={{ fontFamily: D.body, fontSize: 13, color: D.alert }}><BidiText direction="auto">{error}</BidiText></p>
      ) : null}

      {/* Statements stay mounted across a basis/period refetch and just dim —
          unmounting on every toggle collapsed the page height and yanked the
          scroll position (the jumpy toggle). */}
      {databaseMode && report && (
        <div
          aria-busy={loading}
          style={{ opacity: loading ? 0.5 : 1, transition: 'opacity 140ms ease', pointerEvents: loading ? 'none' : 'auto' }}
        >
          {/* Draft / final + currency banners. The draft state is bookkeeping
              status, not an emergency — it reads as a quiet editorial note,
              not an orange alarm. */}
          {draft?.is_draft && (
        <div
          style={{
            border: `1px solid ${D.rule}`,
            borderInlineStart: `3px solid ${D.ink}`,
            background: D.paperDeep,
            padding: '0.75rem 1rem',
            marginBlockEnd: '1.25rem'
          }}
        >
          <div style={{ fontFamily: D.mono, fontSize: 11, letterSpacing: D.tracking.mono, textTransform: 'uppercase', fontWeight: 600, color: D.ink }}>
            {intl.formatMessage({ id: 'report.status.draft.title' })}
          </div>
          <p style={{ fontFamily: D.body, fontSize: 13, color: D.inkSoft, margin: '0.35rem 0 0' }}>
            {intl.formatMessage({ id: 'report.status.draft.body' })}
          </p>
          {(draft.reasons || []).length > 0 && (
            <ul style={{ margin: '0.5rem 0 0', paddingInlineStart: '1.1rem', color: D.inkSoft, fontFamily: D.body, fontSize: 13 }}>
              {draft.reasons.map((reason, index) => (
                <li key={`${reason.code || 'unknown'}:${index}`}>
                  <DraftReason
                    reason={reason}
                    trialBalance={trialBalance}
                    balanceSheet={bs}
                    currency={currency}
                    formatAmount={formatAmount}
                  />
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
          {draft && !draft.is_draft && (
            <div style={{ ...monoLabel, color: D.ink, marginBlockEnd: '1.25rem' }}>{intl.formatMessage({ id: 'report.status.final' })}</div>
          )}
          {report?.currency?.mixed && (
            <p style={{ fontFamily: D.body, fontSize: 13, color: D.inkSoft, marginBlockEnd: '1rem' }}>
              <FormattedMessage
                id="report.currency.mixed"
                values={{ currencies: <IdentifierText>{(report.currency.currencies || []).join(', ')}</IdentifierText> }}
              />
            </p>
          )}

          <div style={{ display: 'grid', gap: '1.25rem', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 340px), 1fr))' }}>
          {/* Profit & Loss — statement layout: Revenue section, Expenses
              section (both positive-natural; a contra balance shows in
              parentheses), then Net income. */}
          <StatementCard
            title={intl.formatMessage({ id: 'report.section.profitLoss' })}
            subtitle={(
              <>
                <FormattedMessage
                  id="report.period.range"
                  values={{
                    startDate: <FormattedValue>{formatDate(report.period_start)}</FormattedValue>,
                    endDate: <FormattedValue>{formatDate(report.period_end)}</FormattedValue>
                  }}
                />
                {currency ? <> · <IdentifierText>{currency}</IdentifierText></> : null}
              </>
            )}
          >
            {(pnl?.accounts || []).length === 0 && (
              <p style={{ fontFamily: D.body, fontSize: 13, color: D.inkMute }}>{intl.formatMessage({ id: 'report.empty.profitLoss' })}</p>
            )}
            {pnlRevenueRows.length > 0 && <div style={{ ...monoLabel, marginBlockStart: '0.2rem' }}>{intl.formatMessage({ id: 'report.label.revenue' })}</div>}
            {pnlRevenueRows.map((account) => (
              <Row key={account.id} label={account.account_label || account.name} value={account.revenue} currency={account.currency || currency} formatAmount={formatAmount} indent={0.5} dynamicLabel />
            ))}
            <Row label={intl.formatMessage({ id: 'report.label.totalRevenue' })} value={pnl?.revenue || 0} currency={currency} formatAmount={formatAmount} strong />
            {pnlExpenseRows.length > 0 && <div style={{ ...monoLabel, marginBlockStart: '0.8rem' }}>{intl.formatMessage({ id: 'report.label.expenses' })}</div>}
            {pnlExpenseRows.map((account) => (
              <Row key={account.id} label={account.account_label || account.name} value={account.expense} currency={account.currency || currency} formatAmount={formatAmount} indent={0.5} dynamicLabel />
            ))}
            <Row label={intl.formatMessage({ id: 'report.label.totalExpenses' })} value={pnl?.expenses || 0} currency={currency} formatAmount={formatAmount} strong />
            <Row label={intl.formatMessage({ id: 'report.label.netIncome' })} value={pnl?.net_income || 0} currency={currency} formatAmount={formatAmount} strong />
          </StatementCard>

          {/* Balance Sheet */}
          <StatementCard
            title={intl.formatMessage({ id: 'report.section.balanceSheet' })}
            subtitle={(
              <>
                <FormattedMessage
                  id="report.period.asOf"
                  values={{ date: <FormattedValue>{formatDate(bs?.as_of || report.period_end)}</FormattedValue> }}
                />
                {currency ? <> · <IdentifierText>{currency}</IdentifierText></> : null}
              </>
            )}
          >
            <div style={{ ...monoLabel, marginBlockStart: '0.2rem' }}>{intl.formatMessage({ id: 'report.label.assets' })}</div>
            {(bs?.assets?.accounts || []).map((account) => (
              <Row
                key={account.id}
                label={account.account_label || account.name}
                note={account.unclassified ? intl.formatMessage({ id: 'report.label.unclassified' }) : ''}
                value={account.amount}
                currency={account.currency || currency}
                formatAmount={formatAmount}
                indent={0.5}
                dynamicLabel
              />
            ))}
            <Row label={intl.formatMessage({ id: 'report.label.totalAssets' })} value={bs?.total_assets || 0} currency={currency} formatAmount={formatAmount} strong />

            <div style={{ ...monoLabel, marginBlockStart: '0.8rem' }}>{intl.formatMessage({ id: 'report.label.liabilities' })}</div>
            {(bs?.liabilities?.accounts || []).map((account) => (
              <Row
                key={account.id}
                label={account.account_label || account.name}
                note={account.unclassified ? intl.formatMessage({ id: 'report.label.unclassified' }) : ''}
                value={account.amount}
                currency={account.currency || currency}
                formatAmount={formatAmount}
                indent={0.5}
                dynamicLabel
              />
            ))}
            <Row label={intl.formatMessage({ id: 'report.label.totalLiabilities' })} value={bs?.total_liabilities || 0} currency={currency} formatAmount={formatAmount} strong />

            <div style={{ ...monoLabel, marginBlockStart: '0.8rem' }}>{intl.formatMessage({ id: 'report.label.equity' })}</div>
            {(bs?.equity?.accounts || []).map((account) => (
              <Row key={account.id} label={account.account_label || account.name} value={account.amount} currency={account.currency || currency} formatAmount={formatAmount} indent={0.5} muted={account.synthetic} dynamicLabel />
            ))}
            <Row label={intl.formatMessage({ id: 'report.label.totalEquity' })} value={bs?.total_equity || 0} currency={currency} formatAmount={formatAmount} strong />

            <Row label={intl.formatMessage({ id: 'report.label.totalLiabilitiesEquity' })} value={bs?.total_liabilities_and_equity || 0} currency={currency} formatAmount={formatAmount} strong />
            <div style={{ ...monoLabel, color: bs?.balanced ? D.inkMute : D.alert, marginBlockStart: '0.5rem' }}>
              {bs?.balanced
                ? intl.formatMessage({ id: 'report.balanceSheet.balanced' })
                : (
                    <FormattedMessage
                      id="report.balanceSheet.imbalance"
                      values={{ amount: <FormattedValue>{reportAmount(formatAmount, bs?.imbalance, currency)}</FormattedValue> }}
                    />
                  )}
            </div>
          </StatementCard>

          {showSupportingStatements && (
            <StatementCard
              title={intl.formatMessage({ id: 'report.section.cash' })}
              subtitle={(
                <>
                  <FormattedMessage
                    id="report.period.asOf"
                    values={{ date: <FormattedValue>{formatDate(report.period_end)}</FormattedValue> }}
                  />
                  {currency ? <> · <IdentifierText>{currency}</IdentifierText></> : null}
                </>
              )}
            >
              {(cash?.accounts || []).length === 0 && (
                <p style={{ fontFamily: D.body, fontSize: 13, color: D.inkMute }}>{intl.formatMessage({ id: 'report.empty.cash' })}</p>
              )}
              {(cash?.accounts || []).map((account) => (
                <Row
                  key={account.id}
                  label={account.account_label || account.name}
                  value={account.balance}
                  currency={account.currency || currency}
                  formatAmount={formatAmount}
                  indent={0.5}
                  dynamicLabel
                />
              ))}
              <Row label={intl.formatMessage({ id: 'report.label.totalCash' })} value={cash?.total || 0} currency={currency} formatAmount={formatAmount} strong />
            </StatementCard>
          )}

          {showSupportingStatements && (
            <StatementCard
              title={intl.formatMessage({ id: 'report.section.trialBalance' })}
              subtitle={(
                <>
                  <FormattedMessage
                    id="report.period.asOf"
                    values={{ date: <FormattedValue>{formatDate(report.period_end)}</FormattedValue> }}
                  />
                  {currency ? <> · <IdentifierText>{currency}</IdentifierText></> : null}
                </>
              )}
            >
              <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) auto auto', gap: '0.8rem', ...monoLabel }}>
                <span>{intl.formatMessage({ id: 'report.label.account' })}</span>
                <span>{intl.formatMessage({ id: 'report.label.debit' })}</span>
                <span>{intl.formatMessage({ id: 'report.label.credit' })}</span>
              </div>
              {(trialBalance?.accounts || []).length === 0 && (
                <p style={{ fontFamily: D.body, fontSize: 13, color: D.inkMute }}>{intl.formatMessage({ id: 'report.empty.trialBalance' })}</p>
              )}
              {(trialBalance?.accounts || []).map((account) => (
                <TrialBalanceRow
                  key={account.id}
                  label={account.account_label || account.name}
                  debit={account.debit_balance}
                  credit={account.credit_balance}
                  currency={account.currency || currency}
                  formatAmount={formatAmount}
                  dynamicLabel
                />
              ))}
              <TrialBalanceRow
                label={intl.formatMessage({ id: 'report.label.totals' })}
                debit={trialBalance?.total_debit || 0}
                credit={trialBalance?.total_credit || 0}
                currency={currency}
                formatAmount={formatAmount}
                strong
              />
              <div style={{ ...monoLabel, color: trialBalance?.balanced ? D.inkMute : D.alert, marginBlockStart: '0.5rem' }}>
                {trialBalance?.balanced
                  ? intl.formatMessage({ id: 'report.trialBalance.balanced' })
                  : (
                      <FormattedMessage
                        id="report.trialBalance.imbalance"
                        values={{ amount: <FormattedValue>{reportAmount(formatAmount, trialBalance?.imbalance, currency)}</FormattedValue> }}
                      />
                    )}
              </div>
            </StatementCard>
          )}
          </div>
        </div>
      )}
    </section>
  );
}
