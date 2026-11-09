// The per-client grants view: every standing delegated-authority grant for
// material reconciliation matches, with who granted it and when, its ceiling,
// usage and corrections, and the governance actions (approve / decline a
// proposed grant, suspend, revoke, re-activate) — each needs a reason and is
// receipted server-side. Mounted on the firm's client Profile tab.
import { useCallback, useEffect, useState } from 'react';
import { useIntl } from 'react-intl';

import { useInterfaceLocale } from '../i18n/LocaleProvider.jsx';

import { D } from './shared/design-tokens.js';
import { btnPrimary, btnChip, btnDisabled } from './shared/buttons.js';
import {
  authorityActor,
  authorityAmount,
  authorityArchetype,
  authorityDate,
  authorityDocumentType,
  authorityGrantStatus,
  authorityRefusal,
  authoritySuspensionCause,
  defaultReviewDate,
  describeGrantScope,
  grantActionsFor
} from '../lib/heldMatchAuthority.js';
import {
  approveReconciliationAuthorityGrant,
  fetchReconciliationAuthorityGrants,
  revokeReconciliationAuthorityGrant,
  suspendReconciliationAuthorityGrant
} from '../lib/firmApi.js';

const DEFAULT_API = {
  list: fetchReconciliationAuthorityGrants,
  approve: approveReconciliationAuthorityGrant,
  suspend: suspendReconciliationAuthorityGrant,
  revoke: revokeReconciliationAuthorityGrant
};
const ACTIVATING = new Set(['approve', 'reactivate']);
const input = { font: 'inherit', fontSize: 12.5, padding: '4px 6px', border: `1px solid ${D.ruleSoft}`, borderRadius: 4, minWidth: 0 };

const GrantRow = ({ grant, clientId, delegatedAuthorityActs, api, onChanged }) => {
  const intl = useIntl();
  const { formatAmount, formatDate } = useInterfaceLocale();
  const message = (id, values) => intl.formatMessage({ id }, values);
  const date = (value) => authorityDate(value, formatDate);
  const [reason, setReason] = useState('');
  const [reviewDate, setReviewDate] = useState(defaultReviewDate());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const scope = describeGrantScope(grant.scope_key);
  const actions = grantActionsFor(grant, { delegatedAuthorityActs });
  const needsDate = actions.some((a) => ACTIVATING.has(a));
  const run = async (action) => {
    if (!reason.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const base = { clientId, grantId: grant.id, reason: reason.trim() };
      const result = ACTIVATING.has(action)
        ? await api.approve({ ...base, reviewAfter: new Date(`${reviewDate}T23:59:59Z`).toISOString() })
        : action === 'suspend' ? await api.suspend(base) : await api.revoke(base);
      setReason('');
      onChanged?.(result);
    } catch (err) {
      setError(authorityRefusal(intl, err));
    } finally {
      setBusy(false);
    }
  };
  const inert = grant.inert_reason === 'review_due' || grant.inert_reason === 'expired'
    ? message(`firm.reconAuthority.grants.inert.${grant.inert_reason}`) : null;
  return (
    <li data-testid={`grant-${grant.id}`} style={{ listStyle: 'none', padding: '12px 0', borderTop: `1px solid ${D.ruleSoft}`, fontSize: 12.5, color: D.ink }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' }}>
        <strong data-testid="grant-status">{authorityGrantStatus(intl, grant.status)}</strong>
        <span data-testid="grant-scope">{message('firm.reconAuthority.preview.scopeValue', { vendor: grant.example?.vendor_name || scope.merchant || '—', label: authorityDocumentType(intl, scope.document_type), account: scope.account || '—' })}</span>
      </div>
      <div style={{ marginTop: 4, color: D.inkSoft, display: 'grid', gap: 2 }}>
        <span data-testid="grant-ceiling">{authorityArchetype(intl, grant.archetype)} · {message('firm.reconAuthority.grants.ceilingValue', { amount: authorityAmount(grant.amount_ceiling, grant.currency, formatAmount) })}</span>
        {grant.status !== 'proposed' && <span data-testid="grant-granted-by">{message('firm.reconAuthority.grants.grantedBy', { actor: authorityActor(intl, grant.authorized_by_actor_id, grant.authorized_by_actor_type), date: date(grant.created_at) })}</span>}
        <span data-testid="grant-usage">{message('firm.reconAuthority.grants.usage', { count: grant.use_count, date: date(grant.last_used_at) })} · {message('firm.reconAuthority.grants.corrections', { count: grant.correction_count })}</span>
        {grant.review_after && <span data-testid="grant-review-by">{message('firm.reconAuthority.grants.reviewBy', { date: date(grant.review_after) })}</span>}
        {grant.expires_at && <span data-testid="grant-expires">{message('firm.reconAuthority.grants.expiresOn', { date: date(grant.expires_at) })}</span>}
        {inert && <span>{inert}</span>}
        {grant.status === 'suspended' && grant.last_auto_suspension && (
          <span data-testid="grant-auto-suspension">{message('firm.reconAuthority.grants.autoSuspended', { date: date(grant.last_auto_suspension.at), reason: authoritySuspensionCause(intl, grant.last_auto_suspension.reason) })}</span>
        )}
        {grant.status === 'revoked' && grant.revoked_reason && (
          <span>{message('firm.reconAuthority.grants.revokedBecause', { actor: authorityActor(intl, grant.revoked_by_actor_id, null), reason: grant.revoked_reason })}</span>
        )}
      </div>
      {actions.length > 0 && (
        <div style={{ display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <input aria-label={message('firm.reconAuthority.grants.reasonLabel')} placeholder={message('firm.reconAuthority.grants.reasonLabel')}
            data-testid="grant-reason" value={reason} onChange={(e) => setReason(e.target.value)} style={{ ...input, flex: '1 1 160px' }} />
          {needsDate && (
            <input aria-label={message('firm.reconAuthority.preview.reviewAfter')} type="date" value={reviewDate} onChange={(e) => setReviewDate(e.target.value)} style={input} />
          )}
          {actions.map((action) => {
            const enabled = Boolean(reason.trim()) && !busy;
            const primary = ACTIVATING.has(action);
            const base = primary ? btnPrimary : btnChip;
            return (
              <button key={action} type="button" data-testid={`grant-action-${action}`} disabled={!enabled} onClick={() => run(action)}
                style={enabled ? base : { ...base, ...btnDisabled }}>
                {busy ? message('firm.reconAuthority.grants.working') : message(`firm.reconAuthority.grants.${action}`)}
              </button>
            );
          })}
        </div>
      )}
      {error && <div role="alert" style={{ marginTop: 6 }}>{message('firm.reconAuthority.grants.actionFailed', { reason: error })}</div>}
    </li>
  );
};

const ReconciliationAuthorityGrants = ({ clientId, api = DEFAULT_API }) => {
  const intl = useIntl();
  const message = (id, values) => intl.formatMessage({ id }, values);
  const [state, setState] = useState({ status: 'loading', data: null });
  const load = useCallback(async (signal) => {
    try {
      const data = await api.list({ clientId, signal });
      setState({ status: 'ready', data });
    } catch (err) {
      if (err?.name === 'AbortError') return;
      setState({ status: err?.status === 403 ? 'hidden' : 'failed', data: null });
    }
  }, [api, clientId]);
  useEffect(() => {
    if (!clientId) return undefined;
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    load(controller?.signal);
    return () => controller?.abort();
  }, [clientId, load]);
  // A principal who cannot see governance (403) gets no card at all.
  if (!clientId || state.status === 'hidden') return null;
  const data = state.data;
  const grants = data?.grants || [];
  const proposed = grants.filter((g) => g.status === 'proposed');
  const others = grants.filter((g) => g.status !== 'proposed');
  const onChanged = (result) => {
    if (result?.grants) setState({ status: 'ready', data: { ...data, ...result } });
    else load();
  };
  const rowProps = { clientId, delegatedAuthorityActs: Boolean(data?.delegated_authority_acts), api, onChanged };
  return (
    <section data-testid="reconciliation-authority-grants" style={{ marginTop: 20, padding: 16, border: `1px solid ${D.ruleSoft}`, borderRadius: 8, fontFamily: D.ui }}>
      <div style={{ fontSize: 14, fontWeight: 600, color: D.ink }}>{message('firm.reconAuthority.grants.title')}</div>
      <div style={{ marginTop: 4, fontSize: 12.5, color: D.inkSoft, lineHeight: 1.45 }}>{message('firm.reconAuthority.grants.intro')}</div>
      {state.status === 'loading' && <div style={{ marginTop: 10, fontSize: 12.5 }}>{message('firm.reconAuthority.grants.loading')}</div>}
      {state.status === 'failed' && <div role="alert" style={{ marginTop: 10, fontSize: 12.5 }}>{message('firm.reconAuthority.grants.failed')}</div>}
      {state.status === 'ready' && !data.delegated_authority_acts && (
        <div data-testid="grants-flag-off" style={{ marginTop: 10, fontSize: 12.5, color: D.ink }}>{message('firm.reconAuthority.grants.flagOff')}</div>
      )}
      {state.status === 'ready' && grants.length === 0 && (
        <div style={{ marginTop: 10, fontSize: 12.5, color: D.inkMute }}>{message('firm.reconAuthority.grants.empty')}</div>
      )}
      {proposed.length > 0 && (
        <>
          <div style={{ marginTop: 14, fontSize: 12.5, fontWeight: 600 }}>{message('firm.reconAuthority.grants.proposedHeading')}</div>
          <ul style={{ margin: 0, padding: 0 }}>{proposed.map((g) => <GrantRow key={g.id} grant={g} {...rowProps} />)}</ul>
        </>
      )}
      {others.length > 0 && (
        <ul style={{ margin: '10px 0 0', padding: 0 }}>{others.map((g) => <GrantRow key={g.id} grant={g} {...rowProps} />)}</ul>
      )}
    </section>
  );
};

export default ReconciliationAuthorityGrants;
