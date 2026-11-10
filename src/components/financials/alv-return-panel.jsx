import { useMemo } from 'react';
import { useIntl } from 'react-intl';
import { T } from '../shared/design-tokens.js';
import { buildAlvReturnViewModel, alvPeriodOptions } from '../../lib/alvReturnView.js';
import { buildSuomifiMandateViewModel } from '../../lib/suomifiMandateView.js';

export default function AlvReturnPanel({ envelope, period, onPeriodChange, mandateEnvelope = null }) {
  const intl = useIntl();
  const message = (id, values) => intl.formatMessage({ id }, values);
  const vm = useMemo(() => buildAlvReturnViewModel(envelope), [envelope]);
  // G-3 follow-up — the Suomi.fi mandate strip: the persisted grant + the dated
  // validity verdict the filing gate itself uses, labelled verbatim.
  const mandateVm = useMemo(() => buildSuomifiMandateViewModel(mandateEnvelope), [mandateEnvelope]);
  // F-FI3-3: lead the picker with the client's assigned verokausi cadence
  // (envelope.verokausi) so the primary choices match how the client files.
  const periodChoices = useMemo(() => {
    const choices = alvPeriodOptions(new Date(), envelope?.verokausi);
    return choices.some(choice => choice.key === period) ? choices : [{ key: period, label: period }, ...choices];
  }, [envelope, period]);
  if (!vm) return null;
  const ready = vm.status === 'ready';
  const lifecycleColor = vm.lifecycle
    ? (vm.lifecycle.tone === 'ok' ? T.ok : vm.lifecycle.tone === 'pending' ? T.amber : T.muted)
    : null;

  const sectionTitle = (label) => (
    <div style={{ fontFamily: T.mono, fontSize: 10.5, letterSpacing: '0.14em', textTransform: 'uppercase', color: T.muted, marginTop: 4 }}>
      {label}
    </div>
  );
  const amountRow = (key, label, display, { bold = false, mono = true } = {}) => (
    <div key={key} style={{ display: 'flex', alignItems: 'baseline', gap: 12, padding: '3px 0' }}>
      <span style={{ fontFamily: mono ? T.mono : undefined, fontSize: mono ? 11.5 : 13, color: T.muted, width: 30 }}>{mono ? key : ''}</span>
      <span style={{ fontSize: 13, color: T.ink, fontWeight: bold ? 700 : 400, flex: 1 }}>{label}</span>
      <span style={{ fontFamily: T.mono, fontSize: 12.5, color: T.ink, fontWeight: bold ? 700 : 400 }}>{display}</span>
    </div>
  );

  return (
    <div style={{ padding: '24px 0', display: 'flex', flexDirection: 'column', gap: 14, maxWidth: 640 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <span style={{ fontFamily: T.mono, fontSize: 10.5, letterSpacing: '0.14em', textTransform: 'uppercase', color: T.muted }}>
          {message('mounted.financial.vat.title')}
        </span>
        <select
          value={period}
          onChange={(e) => onPeriodChange(e.target.value)}
          style={{ border: `1px solid ${T.rule}`, background: 'transparent', color: T.ink, borderRadius: 6, padding: '2px 6px', fontSize: 12 }}
        >
          {periodChoices.map((p) => (
            <option key={p.key} value={p.key}>{p.label}</option>
          ))}
        </select>
        <span style={{ flex: 1 }} />
        <span style={{ fontFamily: T.mono, fontSize: 10, letterSpacing: '0.06em', textTransform: 'uppercase', color: ready ? T.ok : T.amber }}>
          {message(ready
            ? (vm.nilReturn ? 'mounted.financial.vat.nilReturn' : 'mounted.financial.return.ready')
            : 'mounted.financial.return.needsReview')}
        </span>
      </div>
      <div style={{ fontSize: 12, color: T.muted }}>
        {vm.periodRangeLabel ? message('mounted.financial.vat.taxPeriod', { period: vm.periodRangeLabel }) : ''}
        {vm.periodTypeLabel ? ` · ${vm.periodTypeLabel}` : ''}
      </div>

      {vm.cadenceNotice && (
        <div role="status" style={{ fontSize: 12, color: vm.cadenceNotice.kind === 'disagreement' ? T.amber : T.muted, lineHeight: 1.45 }}>
          {vm.cadenceNotice.text}
        </div>
      )}

      {vm.coveredBy.length > 0 && (
        <div role="status" style={{ border: `1px solid ${T.rule}`, borderRadius: 8, padding: '10px 14px', display: 'flex', flexDirection: 'column', gap: 4 }}>
          {vm.coveredBy.map((c) => (
            <div key={c.periodKey} style={{ fontSize: 12.5, fontWeight: 600, color: c.tone === 'ok' ? T.ok : T.amber }}>
              {message(c.status === 'filed' ? 'mounted.financial.vat.coveredByFiled' : 'mounted.financial.vat.coveredByPending', { period: c.periodKey })}
              {c.rangeLabel ? <span style={{ fontWeight: 400, color: T.muted }}>{` · ${c.rangeLabel}`}</span> : null}
            </div>
          ))}
          <div style={{ fontSize: 12, color: T.muted, lineHeight: 1.45 }}>{message('mounted.financial.vat.coveredByHint')}</div>
        </div>
      )}

      {vm.lifecycle && (
        <div style={{ border: `1px solid ${T.rule}`, borderRadius: 8, padding: '10px 14px', display: 'flex', flexDirection: 'column', gap: 4 }}>
          <div style={{ fontSize: 12.5, fontWeight: 600, color: lifecycleColor }}>{vm.lifecycle.label}</div>
          {vm.lifecycle.filedAt && (
            <div style={{ fontSize: 12, color: T.muted }}>
              {message('mounted.financial.vat.filed', { date: vm.lifecycle.filedAt })}{vm.lifecycle.submissionId ? ` · ${message('mounted.financial.vat.identifier', { id: vm.lifecycle.submissionId })}` : ''}
            </div>
          )}
          {vm.lifecycle.cancelReason && (
            <div style={{ fontSize: 12, color: T.muted }}>{message('mounted.financial.vat.reason', { reason: vm.lifecycle.cancelReason })}</div>
          )}
        </div>
      )}

      {mandateVm && (
        <div style={{ border: `1px solid ${T.rule}`, borderRadius: 8, padding: '10px 14px', display: 'flex', flexDirection: 'column', gap: 4 }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
            <span style={{ fontFamily: T.mono, fontSize: 10.5, letterSpacing: '0.14em', textTransform: 'uppercase', color: T.muted }}>
              {message('mounted.financial.vat.mandate')}
            </span>
            <span style={{ fontSize: 12.5, fontWeight: 600, color: mandateVm.tone === 'ok' ? T.ok : T.amber }}>
              {mandateVm.label}
            </span>
            {mandateVm.scopeLabel && (
              <span style={{ fontSize: 12, color: T.muted }}>{mandateVm.scopeLabel}</span>
            )}
          </div>
          {mandateVm.detail && <div style={{ fontSize: 12, color: T.muted }}>{mandateVm.detail}</div>}
          {mandateVm.hint && <div style={{ fontSize: 12, color: T.muted, lineHeight: 1.45 }}>{mandateVm.hint}</div>}
        </div>
      )}

      {vm.blockers.length > 0 && (
        <div style={{ border: `1px solid ${T.rule}`, borderRadius: 8, padding: '10px 14px', display: 'flex', flexDirection: 'column', gap: 8 }}>
          {vm.blockers.map((b) => (
            <div key={b.code}>
              <div style={{ fontSize: 12.5, fontWeight: 600, color: T.amber }}>{b.label}</div>
              {b.hint && <div style={{ fontSize: 12, color: T.muted, lineHeight: 1.45 }}>{b.hint}</div>}
            </div>
          ))}
        </div>
      )}

      {vm.uncodedRevenueLines.length > 0 && (
        <>
          {sectionTitle(message('mounted.financial.vat.uncodedRevenue'))}
          <div>
            {vm.uncodedRevenueLines.map((r, i) => (
              <div key={`${r.journalId || 'row'}-${i}`} style={{ display: 'flex', gap: 12, padding: '3px 0', fontSize: 12.5, color: T.amber }}>
                <span style={{ fontFamily: T.mono }}>{r.accountCode || '—'}</span>
                <span style={{ flex: 1, fontFamily: T.mono, fontSize: 11.5 }}>{r.journalId || ''}</span>
                <span style={{ fontFamily: T.mono }}>{r.display}</span>
              </div>
            ))}
          </div>
        </>
      )}
      {vm.incompatibleLines.length > 0 && (
        <>
          {sectionTitle(message('mounted.financial.vat.incompatibleRows'))}
          <div>
            {vm.incompatibleLines.map((r, i) => (
              <div key={`${r.journalId || 'row'}-${i}`} style={{ display: 'flex', gap: 12, padding: '3px 0', fontSize: 12.5, color: T.amber }}>
                <span style={{ fontFamily: T.mono }}>{r.accountCode || '—'}</span>
                <span style={{ flex: 1, fontFamily: T.mono, fontSize: 11.5 }}>{r.taxType || ''}</span>
                <span style={{ fontFamily: T.mono }}>{r.display}</span>
              </div>
            ))}
          </div>
        </>
      )}

      {vm.controlCheckRows.some((r) => r.mismatch) && (
        <>
          {sectionTitle(message('mounted.financial.vat.controlReconciliation'))}
          <div>
            {vm.controlCheckRows.map((r) => (
              <div key={r.key} style={{ display: 'flex', gap: 12, padding: '3px 0', fontSize: 12.5, color: r.mismatch ? T.amber : T.muted }}>
                <span style={{ flex: 1 }}>{r.label}</span>
                <span style={{ fontFamily: T.mono }}>{message('mounted.financial.vat.expected', { amount: r.expected })}</span>
                <span style={{ fontFamily: T.mono }}>{message('mounted.financial.vat.actual', { amount: r.actual })}</span>
              </div>
            ))}
          </div>
        </>
      )}

      {vm.boxRows.length > 0 && (
        <>
          {sectionTitle(message('mounted.financial.vat.returnFields'))}
          <div>
            {vm.boxRows.map((r) => amountRow(r.field, r.label, r.display))}
          </div>
        </>
      )}

      <div style={{ borderTop: `1px solid ${T.rule}`, paddingTop: 8 }}>
        {amountRow('308', vm.payableLabel, vm.payableDisplay, { bold: true })}
      </div>

      {vm.selfAssessedNote && (
        <div style={{ fontSize: 12, color: T.muted, lineHeight: 1.45 }}>{vm.selfAssessedNote}</div>
      )}
      {vm.uncodedExpenseNote && (
        <div style={{ fontSize: 12, color: T.muted, lineHeight: 1.45 }}>{vm.uncodedExpenseNote}</div>
      )}
      {vm.unmarkedControlMovementNote && (
        <div style={{ fontSize: 12, color: T.muted, lineHeight: 1.45 }}>{vm.unmarkedControlMovementNote}</div>
      )}
      {vm.provenanceLine && (
        <div style={{ fontFamily: T.mono, fontSize: 10.5, color: T.mutedSoft }}>{vm.provenanceLine}</div>
      )}
      {vm.boxMapUnconfirmedNote && (
        <div style={{ fontFamily: T.mono, fontSize: 10.5, color: T.mutedSoft }}>{vm.boxMapUnconfirmedNote}</div>
      )}
    </div>
  );
}
