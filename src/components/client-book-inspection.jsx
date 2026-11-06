import { useEffect, useState } from 'react';
import { useIntl } from 'react-intl';
import { fetchFinlandAlvReturn, fetchLedgerAuditTrail, formatFirmError } from '../lib/firmApi.js';
import AlvReturnPanel from './financials/alv-return-panel.jsx';
import { defaultAlvPeriodKey, alvPeriodForJournalMonth } from '../lib/alvReturnView.js';
import { D } from './shared/design-tokens.js';
import { useInterfaceLocale } from '../i18n/LocaleProvider.jsx';

const JOURNAL_MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

// The same scoped readers used by the firm's workspace. No local/demo ledger
// fallback and no new accounting calculation or mutation on this surface.
export default function ClientBookInspection({ clientId, databaseMode, jurisdiction, defaultDate }) {
  const { formatAmount, formatDate } = useInterfaceLocale();
  const intl = useIntl();
  const message = (key) => intl.formatMessage({ id: `portal.inspection.${key}` });
  const [period, setPeriod] = useState(() => {
    // The portal supplies a Date, using the same local calendar as its reports.
    const month = defaultDate instanceof Date
      ? `${defaultDate.getFullYear()}-${String(defaultDate.getMonth() + 1).padStart(2, '0')}`
      : String(defaultDate || '').slice(0, 7);
    return JOURNAL_MONTH.test(month) ? month : defaultAlvPeriodKey(new Date());
  });
  const [retry, setRetry] = useState(0);
  const [state, setState] = useState(null);
  const [alvSelection, setAlvSelection] = useState(null);
  const [cadence, setCadence] = useState(null);
  const alvPeriod = alvSelection?.clientId === clientId && alvSelection?.month === period
    ? alvSelection.period
    : alvPeriodForJournalMonth(period, cadence?.clientId === clientId ? cadence.value : 'month');
  const [alv, setAlv] = useState(null);
  const scope = `${clientId}:${period}:${retry}`;
  const alvScope = `${clientId}:${alvPeriod}:${retry}`;
  const validPeriod = JOURNAL_MONTH.test(period);
  const isFinnish = String(jurisdiction || '').toUpperCase() === 'FI';
  useEffect(() => {
    if (!databaseMode || !clientId || !validPeriod) return undefined;
    const controller = new AbortController();
    const [year, month] = period.split('-').map(Number);
    const periodEnd = `${period}-${new Date(Date.UTC(year, month, 0)).getUTCDate()}`;
    fetchLedgerAuditTrail({ clientId, periodStart: `${period}-01`, periodEnd, signal: controller.signal })
      .then(data => {
        if (data?.client_id !== clientId || !Array.isArray(data?.native_ledger?.journals)) throw new Error(message('journalError'));
        if (!controller.signal.aborted) setState({ scope, data });
      })
      .catch(error => { if (!controller.signal.aborted) setState({ scope, error: formatFirmError(error) }); });
    return () => controller.abort();
  }, [clientId, databaseMode, period, retry, scope, validPeriod, intl]);
  useEffect(() => {
    if (!databaseMode || !clientId || !isFinnish || !alvPeriod) return undefined;
    const controller = new AbortController();
    fetchFinlandAlvReturn({ clientId, period: alvPeriod, signal: controller.signal })
      .then(data => {
        if (!data?.review || !data?.alvReturn) throw new Error(message('alvError'));
        if (!controller.signal.aborted) {
          setCadence({ clientId, value: data.verokausi });
          setAlv({ scope: alvScope, data });
        }
      })
      .catch(error => { if (!controller.signal.aborted) setAlv({ scope: alvScope, error: formatFirmError(error) }); });
    return () => controller.abort();
  }, [clientId, databaseMode, isFinnish, alvPeriod, retry, alvScope, intl]);
  if (!databaseMode || !clientId) return null;
  const current = state?.scope === scope ? state : null;
  const currentAlv = alv?.scope === alvScope ? alv : null;
  return <section aria-label={message('region')} style={{ padding: '1.5rem', borderTop: `1px solid ${D.rule}` }}>
    <h2>{message('title')}</h2>
    <p>{message('help')}</p>
    <label>{message('month')}{' '}<input type="month" value={period} onChange={event => {
      setPeriod(event.target.value);
    }} /></label>{' '}
    <button type="button" onClick={() => setRetry(value => value + 1)}>{message('refresh')}</button>
    {!validPeriod && <p role="alert">{message('monthRequired')}</p>}
    {validPeriod && !current && <p role="status">{message('loading')}</p>}
    {current?.error && <p role="alert">{current.error}</p>}
    {current?.data && !(current.data.native_ledger?.journals?.length) && <p>{message('empty')}</p>}
    {(current?.data?.native_ledger?.journals || []).map(journal => <details key={journal.id} style={{ padding: '0.6rem 0' }}>
      <summary><bdi>{formatDate(journal.journal_date)}</bdi> · <bdi>{journal.description || journal.memo || journal.id}</bdi> · <bdi>{journal.status}</bdi></summary>
      {journal.correction_reason && <p>{journal.correction_reason}</p>}
      <div style={{ overflowX: 'auto' }}><table>
        <thead><tr><th>{message('account')}</th><th>{message('debit')}</th><th>{message('credit')}</th><th>{message('taxCode')}</th></tr></thead>
        <tbody>{(journal.lines || []).map(line => <tr key={line.id || line.line_no}>
          <td><bdi>{line.account_name || line.account_label || line.account_code || '—'}</bdi></td>
          <td>{formatAmount(line.debit || 0, { currency: line.currency || journal.currency || '' })}</td>
          <td>{formatAmount(line.credit || 0, { currency: line.currency || journal.currency || '' })}</td>
          <td>{line.tax_type || '—'}</td>
        </tr>)}</tbody>
      </table></div>
    </details>)}
    {isFinnish && <>
      <p>{message('alvHelp')}</p>
      {!currentAlv && <p role="status">{message('alvLoading')}</p>}
      {currentAlv?.error && <p role="alert">{currentAlv.error}</p>}
      {currentAlv?.data && <AlvReturnPanel envelope={currentAlv.data} period={alvPeriod}
        onPeriodChange={value => setAlvSelection({ clientId, month: period, period: value })} />}
    </>}
  </section>;
}
