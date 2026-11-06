// Financials artifact — TB / P&L / cash in the right rail (two-surface IA
// stage C, Kari's pick 2026-08-26: "in Donna chat, in the artifact"). Opened
// by the open_financials chat verb (and any future host affordance); renders
// the SAME persisted close-preview read-model the close surface reads
// (fetchClosePeriodPreview → trial_balance / profit_and_loss / cash) —
// render-the-persisted-verdict, no client-side arithmetic, no re-inference,
// and never figures from the model. Month nav browses adjacent periods.
//
// Compact by design: the rail is narrow, so each section is a headline plus
// an account/amount list — the full-width debit/credit breakdown stays on
// the close surface (and the close archive) where there is room for it.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { FormattedMessage, useIntl } from 'react-intl';

import { T } from '../shared/design-tokens.js';
import { fetchClosePeriodPreview } from '../../lib/firmApi.js';
import { BidiText, FormattedValue, IdentifierText } from '../../i18n/BidiText.jsx';
import { useInterfaceLocale } from '../../i18n/LocaleProvider.jsx';

const parsePeriod = (value) => {
  const m = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(String(value || ''));
  if (!m) return null;
  return { year: Number(m[1]), monthIdx: Number(m[2]) - 1 };
};

const periodValue = ({ year, monthIdx }) => `${year}-${String(monthIdx + 1).padStart(2, '0')}`;

const periodBounds = ({ year, monthIdx }) => ({
  periodStart: `${year}-${String(monthIdx + 1).padStart(2, '0')}-01`,
  periodEnd: `${year}-${String(monthIdx + 1).padStart(2, '0')}-${String(new Date(Date.UTC(year, monthIdx + 1, 0)).getUTCDate()).padStart(2, '0')}`
});

const shiftPeriod = ({ year, monthIdx }, delta) => {
  const d = new Date(Date.UTC(year, monthIdx + delta, 1));
  return { year: d.getUTCFullYear(), monthIdx: d.getUTCMonth() };
};

const formatReportAmount = (formatAmount, n, ccy = '') => {
  const v = Number(n);
  if (!Number.isFinite(v)) return '—';
  return formatAmount(v, {
    currency: String(ccy || '').trim().toUpperCase(),
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  });
};

const formatSignedReportAmount = (formatAmount, n, ccy = '') => {
  const v = Number(n);
  if (!Number.isFinite(v)) return '—';
  return formatAmount(v, {
    currency: String(ccy || '').trim().toUpperCase(),
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
    signDisplay: 'exceptZero',
    negativeStyle: 'minus'
  });
};

const SectionHeading = ({ label, headline, sub, accent }) => (
  <div style={{ padding: '14px 16px 6px' }}>
    <div style={{ fontFamily: T.mono, fontSize: 10, fontWeight: 800, letterSpacing: '0.06em', textTransform: 'uppercase', color: T.muted }}>
      {label}
    </div>
    <div style={{ fontSize: 16, fontWeight: 700, color: accent || T.ink, marginTop: 4 }}>{headline}</div>
    {sub ? <div style={{ fontSize: 11.5, color: T.mutedSoft, marginTop: 2 }}>{sub}</div> : null}
  </div>
);

const AccountRows = ({ rows, amountKey, currencyFallback, emptyLabel, formatAmount }) => (
  rows.length === 0 ? (
    <div style={{ padding: '4px 16px 10px', fontSize: 12, color: T.muted }}>{emptyLabel}</div>
  ) : (
    <div style={{ padding: '0 16px 10px' }}>
      {rows.map((row, i) => (
        <div
          key={`${row.account_label || 'acct'}:${i}`}
          style={{ display: 'flex', alignItems: 'baseline', gap: 10, padding: '4px 0', borderBottom: `1px solid ${T.ruleSoft}` }}
        >
          <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 12.5 }}>
            <BidiText direction="auto">{row.account_label || row.name || '—'}</BidiText>
          </span>
          <span style={{ fontFamily: T.mono, fontSize: 12, whiteSpace: 'nowrap' }}>
            <FormattedValue>{formatSignedReportAmount(formatAmount, row[amountKey], row.currency || currencyFallback)}</FormattedValue>
          </span>
        </div>
      ))}
    </div>
  )
);

export default function FinancialsReportArtifact({ artifact, onRefreshRef = null }) {
  const intl = useIntl();
  const { direction, formatAmount, formatDate } = useInterfaceLocale();
  const clientId = artifact?.data?.clientId || null;
  const previewSnapshot = artifact?.data?.previewSnapshot || null;
  const initial = parsePeriod(artifact?.data?.period) || (() => {
    const now = new Date();
    return { year: now.getUTCFullYear(), monthIdx: now.getUTCMonth() };
  })();
  const [period, setPeriod] = useState(initial);
  const [preview, setPreview] = useState(previewSnapshot);
  const [status, setStatus] = useState(previewSnapshot ? 'ready' : 'loading'); // loading | ready | error
  const [error, setError] = useState(null);

  const load = useCallback(async ({ signal } = {}) => {
    if (!clientId) return;
    if (previewSnapshot) {
      setPreview(previewSnapshot);
      setStatus('ready');
      setError(null);
      return;
    }
    setStatus('loading');
    setError(null);
    try {
      const bounds = periodBounds(period);
      const result = await fetchClosePeriodPreview({ clientId, ...bounds, signal });
      setPreview(result || null);
      setStatus('ready');
    } catch (err) {
      if (err?.name === 'AbortError') return;
      setError(err?.message || intl.formatMessage({ id: 'report.error.loadPeriod' }));
      setStatus('error');
    }
  }, [clientId, intl, period, previewSnapshot]);

  useEffect(() => {
    const controller = new AbortController();
    load({ signal: controller.signal });
    return () => controller.abort();
  }, [load]);

  // The rail's refresh button re-runs the same persisted read.
  useEffect(() => {
    if (!onRefreshRef) return undefined;
    onRefreshRef.current = () => load();
    return () => { onRefreshRef.current = null; };
  }, [onRefreshRef, load]);

  const trial = preview?.trial_balance || null;
  const pnl = preview?.profit_and_loss || null;
  const cash = preview?.cash || null;
  const trialCcy = trial?.accounts?.[0]?.currency || 'EUR';
  const pnlCcy = pnl?.accounts?.[0]?.currency || 'EUR';
  const cashCcy = cash?.accounts?.[0]?.currency || 'EUR';
  const label = useMemo(() => formatDate(`${periodValue(period)}-01`, {
    day: null,
    month: 'short',
    year: 'numeric'
  }), [formatDate, period]);

  if (!clientId) return null;

  return (
    <div style={{ fontFamily: T.sans, color: T.ink }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '12px 16px', borderBottom: `1px solid ${T.ruleSoft}` }}>
        <button
          type="button"
          aria-label={intl.formatMessage({ id: 'report.navigation.previousMonth' })}
          onClick={() => setPeriod((p) => shiftPeriod(p, -1))}
          style={{ border: `1px solid ${T.rule}`, background: 'transparent', color: T.ink, borderRadius: 6, width: 26, height: 26, cursor: 'pointer', lineHeight: 1 }}
        >
          {direction === 'rtl' ? '›' : '‹'}
        </button>
        <span style={{ fontWeight: 700, fontSize: 13.5, minWidth: 88, textAlign: 'center' }}><FormattedValue>{label}</FormattedValue></span>
        <button
          type="button"
          aria-label={intl.formatMessage({ id: 'report.navigation.nextMonth' })}
          onClick={() => setPeriod((p) => shiftPeriod(p, 1))}
          style={{ border: `1px solid ${T.rule}`, background: 'transparent', color: T.ink, borderRadius: 6, width: 26, height: 26, cursor: 'pointer', lineHeight: 1 }}
        >
          {direction === 'rtl' ? '‹' : '›'}
        </button>
        <span style={{ flex: 1 }} />
        <span style={{ fontFamily: T.mono, fontSize: 10, color: T.mutedSoft, letterSpacing: '0.04em' }}>
          <IdentifierText>{periodValue(period)}</IdentifierText>
        </span>
      </div>

      {status === 'loading' && (
        <div style={{ padding: '20px 16px', fontSize: 12.5, color: T.muted }}>
          <FormattedMessage id="report.loading.period" values={{ period: <FormattedValue>{label}</FormattedValue> }} />
        </div>
      )}
      {status === 'error' && (
        <div style={{ padding: '20px 16px', fontSize: 12.5, color: T.alert }}><BidiText direction="auto">{error}</BidiText></div>
      )}
      {status === 'ready' && (
        <>
          <SectionHeading
            label={intl.formatMessage({ id: 'report.artifact.section.trialBalance' })}
            headline={trial?.balanced
              ? intl.formatMessage({ id: 'report.artifact.trialBalance.balanced' })
              : (
                  <FormattedMessage
                    id="report.artifact.trialBalance.imbalance"
                    values={{ amount: <FormattedValue>{formatSignedReportAmount(formatAmount, trial?.imbalance, trialCcy)}</FormattedValue> }}
                  />
                )}
            sub={(
              <FormattedMessage
                id="report.artifact.trialBalance.summary"
                values={{
                  debit: <FormattedValue>{formatReportAmount(formatAmount, trial?.total_debit, trialCcy)}</FormattedValue>,
                  credit: <FormattedValue>{formatReportAmount(formatAmount, trial?.total_credit, trialCcy)}</FormattedValue>
                }}
              />
            )}
            accent={trial?.balanced ? T.ok : T.alert}
          />
          <AccountRows
            rows={trial?.accounts || []}
            amountKey="balance"
            currencyFallback={trialCcy}
            emptyLabel={intl.formatMessage({ id: 'report.artifact.empty.movements' })}
            formatAmount={formatAmount}
          />
          <SectionHeading
            label={intl.formatMessage({ id: 'report.artifact.section.profitLoss' })}
            headline={<FormattedValue>{formatSignedReportAmount(formatAmount, pnl?.net_income, pnlCcy)}</FormattedValue>}
            sub={(
              <FormattedMessage
                id="report.artifact.profitLoss.summary"
                values={{
                  revenue: <FormattedValue>{formatReportAmount(formatAmount, pnl?.revenue, pnlCcy)}</FormattedValue>,
                  expenses: <FormattedValue>{formatReportAmount(formatAmount, pnl?.expenses, pnlCcy)}</FormattedValue>
                }}
              />
            )}
          />
          <AccountRows
            rows={pnl?.accounts || []}
            amountKey="net"
            currencyFallback={pnlCcy}
            emptyLabel={intl.formatMessage({ id: 'report.artifact.empty.profitLoss' })}
            formatAmount={formatAmount}
          />
          <SectionHeading
            label={intl.formatMessage({ id: 'report.artifact.section.cash' })}
            headline={<FormattedValue>{formatReportAmount(formatAmount, cash?.total, cashCcy)}</FormattedValue>}
            sub={intl.formatMessage({ id: 'report.artifact.cash.accounts' }, { count: (cash?.accounts || []).length })}
          />
          <AccountRows
            rows={cash?.accounts || []}
            amountKey="balance"
            currencyFallback={cashCcy}
            emptyLabel={intl.formatMessage({ id: 'report.artifact.empty.cash' })}
            formatAmount={formatAmount}
          />
          <div style={{ padding: '10px 16px 20px', fontSize: 10.5, color: T.mutedSoft, fontFamily: T.mono }}>
            {intl.formatMessage({ id: 'report.artifact.footer' })}
          </div>
        </>
      )}
    </div>
  );
}
