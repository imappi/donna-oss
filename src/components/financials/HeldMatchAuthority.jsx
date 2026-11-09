// A material match held ONLY by the materiality ceiling, on the firm surface:
// two separate acts, never merged.
//   - "Confirm this match": today's line-level confirm (PATCH the match to
//     confirmed). The server stamps a one-time authority receipt on THIS match;
//     it mints nothing and implies nothing about future lines.
//   - "Authorise future matches like this": opens a preview of exactly what a
//     standing grant would cover (server-derived scope, kind, accept-only
//     action, ceiling + currency, review date, this match as the example).
//     Nothing is pre-ticked; the grant is minted only when a person ticks the
//     acknowledgement and submits. The example line still needs its own confirm.
import { useState } from 'react';
import { useIntl } from 'react-intl';

import { D } from '../shared/design-tokens.js';
import { btnPrimary, btnChip, btnDisabled } from '../shared/buttons.js';
import { isMatchHeldForAuthority, defaultReviewDate } from '../../lib/heldMatchAuthority.js';
import { mintReconciliationAuthorityGrant, previewReconciliationAuthorityGrant } from '../../lib/firmApi.js';

const row = { display: 'grid', gridTemplateColumns: 'minmax(96px, 0.42fr) minmax(0, 1fr)', columnGap: 12, rowGap: 6, fontSize: 12.5 };
const label = { color: D.inkMute };
const value = { color: D.ink, overflowWrap: 'anywhere' };
const input = { font: 'inherit', fontSize: 12.5, padding: '4px 6px', border: `1px solid ${D.ruleSoft}`, borderRadius: 4, minWidth: 0 };

export const GrantPreviewForm = ({ clientId, preview, onMinted, onCancel, mint = mintReconciliationAuthorityGrant }) => {
  const intl = useIntl();
  const message = (id, values) => intl.formatMessage({ id }, values);
  const [ceiling, setCeiling] = useState(String(preview.amount ?? ''));
  const [reviewDate, setReviewDate] = useState(defaultReviewDate());
  const [reason, setReason] = useState('');
  const [acknowledged, setAcknowledged] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const scope = preview.scope || {};
  const example = preview.example || {};
  const canSubmit = acknowledged && !busy && Number(ceiling) > 0 && Boolean(reviewDate);
  const submit = async () => {
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    try {
      const result = await mint({
        clientId,
        matchId: preview.match_id,
        amountCeiling: Number(ceiling),
        currency: preview.currency,
        reviewAfter: new Date(`${reviewDate}T23:59:59Z`).toISOString(),
        acknowledged: true,
        reason: reason.trim() || null
      });
      onMinted?.(result);
    } catch (err) {
      setError(err?.message || String(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div data-testid="grant-preview" style={{ marginTop: 12, paddingTop: 12, borderTop: `1px solid ${D.ruleSoft}` }}>
      <div style={{ fontSize: 13, fontWeight: 600, color: D.ink, marginBottom: 8 }}>{message('firm.reconAuthority.preview.heading')}</div>
      <div style={row}>
        <span style={label}>{message('firm.reconAuthority.preview.scope')}</span>
        <span style={value} data-testid="grant-scope">{message('firm.reconAuthority.preview.scopeValue', {
          vendor: example.vendor_name || scope.merchant || '—', label: example.document_type || scope.document_type || '—', account: scope.account || '—'
        })}</span>
        <span style={label}>{message('firm.reconAuthority.preview.archetype')}</span>
        <span style={value}>{message(`firm.reconAuthority.archetype.${preview.archetype}`)}</span>
        <span style={label}>{message('firm.reconAuthority.preview.action')}</span>
        <span style={value}>{message('firm.reconAuthority.preview.actionValue')}</span>
        <label style={label} htmlFor="grant-ceiling">{message('firm.reconAuthority.preview.ceiling')}</label>
        <input id="grant-ceiling" data-testid="grant-ceiling" type="number" min="0" step="0.01" value={ceiling} onChange={(e) => setCeiling(e.target.value)} style={input} />
        <span style={label}>{message('firm.reconAuthority.preview.currency')}</span>
        <span style={value} data-testid="grant-currency">{preview.currency}</span>
        <label style={label} htmlFor="grant-review">{message('firm.reconAuthority.preview.reviewAfter')}</label>
        <input id="grant-review" data-testid="grant-review" type="date" value={reviewDate} onChange={(e) => setReviewDate(e.target.value)} style={input} />
        <span style={label}>{message('firm.reconAuthority.preview.example')}</span>
        <span style={value}>{message('firm.reconAuthority.preview.exampleValue', {
          vendor: example.vendor_name || '—', amount: example.amount, currency: example.currency, date: String(example.date || '').slice(0, 10) || '—'
        })}</span>
        <label style={label} htmlFor="grant-reason">{message('firm.reconAuthority.preview.reason')}</label>
        <input id="grant-reason" type="text" value={reason} onChange={(e) => setReason(e.target.value)} style={input} />
      </div>
      <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', marginTop: 12, fontSize: 12.5, color: D.ink }}>
        <input data-testid="grant-acknowledge" type="checkbox" checked={acknowledged} onChange={(e) => setAcknowledged(e.target.checked)} />
        <span>{message('firm.reconAuthority.preview.acknowledge')}</span>
      </label>
      {error && <div role="alert" style={{ marginTop: 8, fontSize: 12, color: D.ink }}>{message('firm.reconAuthority.preview.mintFailed', { reason: error })}</div>}
      <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
        <button type="button" data-testid="grant-submit" disabled={!canSubmit} onClick={submit} style={canSubmit ? btnPrimary : { ...btnPrimary, ...btnDisabled }}>
          {busy ? message('firm.reconAuthority.preview.submitting') : message('firm.reconAuthority.preview.submit')}
        </button>
        <button type="button" onClick={onCancel} style={btnChip}>{message('firm.reconAuthority.preview.cancel')}</button>
      </div>
    </div>
  );
};

const HeldMatchAuthority = ({
  match,
  clientId,
  onConfirmMatch,
  preview: loadPreview = previewReconciliationAuthorityGrant,
  mint = mintReconciliationAuthorityGrant
}) => {
  const intl = useIntl();
  const message = (id, values) => intl.formatMessage({ id }, values);
  const [confirming, setConfirming] = useState(false);
  const [confirmError, setConfirmError] = useState(null);
  const [panel, setPanel] = useState({ state: 'closed' });
  const [confirmed, setConfirmed] = useState(false);
  if (!isMatchHeldForAuthority(match)) return null;
  if (confirmed) {
    return (
      <section data-testid="held-match-confirmed" style={{ marginTop: 14, fontSize: 12.5, color: D.ink, fontFamily: D.ui }}>
        {message('firm.reconAuthority.held.confirmed')}
      </section>
    );
  }

  const confirm = async () => {
    if (!onConfirmMatch || confirming) return;
    setConfirming(true);
    setConfirmError(null);
    try {
      await onConfirmMatch();
      setConfirmed(true);
    } catch (err) {
      setConfirmError(err?.message || String(err));
    } finally {
      setConfirming(false);
    }
  };
  const openGrant = async () => {
    setPanel({ state: 'loading' });
    try {
      const { preview } = await loadPreview({ clientId, matchId: match.id });
      setPanel({ state: 'ready', preview });
    } catch (err) {
      setPanel({ state: 'failed', error: err?.message || String(err) });
    }
  };

  return (
    <section data-testid="held-match-authority" style={{ marginTop: 14, padding: 12, border: `1px solid ${D.ruleSoft}`, borderRadius: 6, fontFamily: D.ui }}>
      <div style={{ fontSize: 13, fontWeight: 600, color: D.ink }}>{message('firm.reconAuthority.held.title')}</div>
      <div style={{ marginTop: 4, fontSize: 12.5, color: D.inkSoft, lineHeight: 1.45 }}>{message('firm.reconAuthority.held.body')}</div>
      <div style={{ display: 'flex', gap: 12, marginTop: 10, flexWrap: 'wrap' }}>
        <div style={{ display: 'grid', gap: 4 }}>
          <button type="button" data-testid="held-confirm" disabled={!onConfirmMatch || confirming} onClick={confirm} style={btnPrimary}>
            {confirming ? message('firm.reconAuthority.held.confirming') : message('firm.reconAuthority.held.confirm')}
          </button>
          <span style={{ fontSize: 11.5, color: D.inkMute }}>{message('firm.reconAuthority.held.confirmHint')}</span>
        </div>
        <div style={{ display: 'grid', gap: 4 }}>
          <button type="button" data-testid="held-authorise" disabled={!clientId || panel.state === 'loading'} onClick={openGrant} style={btnChip}>
            {message('firm.reconAuthority.held.authorise')}
          </button>
          <span style={{ fontSize: 11.5, color: D.inkMute }}>{message('firm.reconAuthority.held.authoriseHint')}</span>
        </div>
      </div>
      {confirmError && <div role="alert" style={{ marginTop: 8, fontSize: 12 }}>{message('firm.reconAuthority.held.confirmFailed')}</div>}
      {panel.state === 'loading' && <div style={{ marginTop: 10, fontSize: 12, color: D.inkMute }}>{message('firm.reconAuthority.preview.loading')}</div>}
      {panel.state === 'failed' && <div role="alert" style={{ marginTop: 10, fontSize: 12 }}>{message('firm.reconAuthority.preview.failed')}</div>}
      {panel.state === 'ready' && !panel.preview.eligible && (
        <div data-testid="grant-ineligible" style={{ marginTop: 10, fontSize: 12.5, color: D.inkSoft }}>
          {message(`firm.reconAuthority.ineligible.${panel.preview.ineligible_reason}`, { status: panel.preview.existing_grant?.status || '' })}
        </div>
      )}
      {panel.state === 'ready' && panel.preview.eligible && (
        <GrantPreviewForm
          clientId={clientId}
          preview={panel.preview}
          mint={mint}
          onCancel={() => setPanel({ state: 'closed' })}
          onMinted={() => setPanel({ state: 'granted' })}
        />
      )}
      {panel.state === 'granted' && (
        <div data-testid="grant-granted" style={{ marginTop: 10, fontSize: 12.5, color: D.ink }}>{message('firm.reconAuthority.preview.granted')}</div>
      )}
    </section>
  );
};

export default HeldMatchAuthority;
