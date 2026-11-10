// Firm side of the owner portal invite (server/donna/clientOwnerInvitesDb.js):
// on a client's People tab, the firm sees whether the business owner is in the
// portal and can invite, resend, revoke a pending invite, or remove access.
// Every action is receipted server-side; this card only renders the state the
// server returns. Mounted from FirmClientWorkspace (People tab).
//
// Copy lives in the ownerAccess.* catalog messages
// (src/i18n/catalogs/ownerAccess.*.js), outside the closed AR-3B mounted
// namespace. Stored codes (the access state, the invite email's outcome) read
// as labels with a catalog fallback; dates go through the interface formatter.

import { useCallback, useEffect, useState } from 'react';
import { useIntl } from 'react-intl';

import { D } from './shared/design-tokens.js';
import { fetchClientOwnerAccess, postClientOwnerAccess } from '../lib/firmApi.js';
import { useInterfaceLocale } from '../i18n/LocaleProvider.jsx';
import { BidiText, IdentifierText } from '../i18n/BidiText.jsx';

const STATE_MESSAGE_IDS = {
  not_invited: 'ownerAccess.state.notInvited',
  invited: 'ownerAccess.state.invited',
  active: 'ownerAccess.state.active',
  access_removed: 'ownerAccess.state.accessRemoved'
};

// The notice after an invite or resend (the server's invite_email.status).
const EMAIL_NOTICE_IDS = {
  sent: 'ownerAccess.notice.sent',
  skipped: 'ownerAccess.notice.skipped',
  failed: 'ownerAccess.notice.failed'
};

// The pending invite's stored email outcome (invite_email_status).
const EMAIL_STATUS_IDS = {
  skipped: 'ownerAccess.invite.emailSkipped',
  failed: 'ownerAccess.invite.emailFailed'
};

const isoDay = (value) => {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10);
};

const button = (primary, busy) => ({
  font: 'inherit',
  fontSize: 12,
  padding: '6px 12px',
  borderRadius: 999,
  border: primary ? 'none' : `1px solid ${D.rule}`,
  background: primary ? D.ink : D.card,
  color: primary ? D.paper : D.inkSoft,
  cursor: busy ? 'wait' : 'pointer',
  opacity: busy ? 0.6 : 1
});

const input = {
  font: 'inherit',
  fontSize: 13,
  padding: '7px 10px',
  border: `1px solid ${D.rule}`,
  borderRadius: 6,
  background: D.card,
  color: D.ink,
  minWidth: 0
};

export default function ClientOwnerAccessCard({ clientId, enabled = true }) {
  const intl = useIntl();
  const { formatDate } = useInterfaceLocale();
  const message = (id, values) => intl.formatMessage({ id }, values);
  const formatDay = (value) => {
    const day = isoDay(value);
    if (!day) return '';
    try { return formatDate(day); } catch { return day; }
  };
  const [access, setAccess] = useState(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [fenced, setFenced] = useState(false);
  const [form, setForm] = useState({ name: '', email: '', language: '' });
  const [confirmRemove, setConfirmRemove] = useState(false);

  const load = useCallback(async (signal) => {
    try {
      const next = await fetchClientOwnerAccess({ clientId, signal });
      setAccess(next);
      setError('');
    } catch (err) {
      if (err?.name === 'AbortError') return;
      if (err?.status === 403) { setFenced(true); return; }
      setError('ownerAccess.error.load');
    }
  }, [clientId]);

  useEffect(() => {
    if (!enabled || !clientId) return undefined;
    const controller = new AbortController();
    setAccess(null); setFenced(false); setNotice(''); setError(''); setConfirmRemove(false);
    load(controller.signal);
    return () => controller.abort();
  }, [clientId, enabled, load]);

  if (!enabled || !clientId || fenced) return null;

  const run = async (action, payload = {}) => {
    setBusy(true); setError(''); setNotice('');
    try {
      const next = await postClientOwnerAccess(action, { clientId, ...payload });
      setAccess(next);
      setConfirmRemove(false);
      if (next.invite_email) setNotice(EMAIL_NOTICE_IDS[next.invite_email.status] || 'ownerAccess.notice.unknown');
      else if (action === 'revoke') setNotice('ownerAccess.notice.revoked');
      else if (action === 'remove') setNotice('ownerAccess.notice.removed');
      if (action === 'invite') setForm({ name: '', email: '', language: '' });
    } catch (err) {
      setError('ownerAccess.error.action');
    } finally {
      setBusy(false);
    }
  };

  const state = access?.state || null;
  const invite = access?.invite || null;
  const owner = access?.owners?.[0] || null;

  return (
    <section
      data-testid="client-owner-access"
      style={{ border: `1px solid ${D.rule}`, borderRadius: 10, background: D.card, padding: 18, marginBlockStart: 24 }}
    >
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
        <div>
          <div style={{ fontFamily: D.mono, fontSize: 11, letterSpacing: D.tracking?.mono, textTransform: 'uppercase', color: D.inkSoft }}>
            {message('ownerAccess.title')}
          </div>
          <div style={{ marginBlockStart: 4, fontSize: 13, color: D.inkSoft }}>
            {message('ownerAccess.description')}
          </div>
        </div>
        {state && (
          <span data-testid="client-owner-state" style={{ fontSize: 12, padding: '3px 10px', borderRadius: 999, border: `1px solid ${D.rule}`, color: D.ink }}>
            {message(STATE_MESSAGE_IDS[state] || 'ownerAccess.state.unknown')}
          </span>
        )}
      </div>

      {!access && !error && <div style={{ marginBlockStart: 14, fontSize: 13, color: D.inkSoft }}>{message('ownerAccess.loading')}</div>}

      {state === 'active' && owner && (
        <div style={{ marginBlockStart: 14, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
          <div style={{ fontSize: 14 }}>
            <strong><BidiText direction="auto">{owner.name}</BidiText></strong> <span style={{ color: D.inkSoft }}><IdentifierText>{owner.email}</IdentifierText></span>
            {owner.since && <span style={{ color: D.inkSoft }}> · {message('ownerAccess.since', { date: formatDay(owner.since) })}</span>}
          </div>
          {confirmRemove ? (
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <span style={{ fontSize: 13 }}>{message('ownerAccess.removeConfirm')}</span>
              <button type="button" disabled={busy} style={button(true, busy)} onClick={() => run('remove')}>{message('ownerAccess.removeAccess')}</button>
              <button type="button" disabled={busy} style={button(false, busy)} onClick={() => setConfirmRemove(false)}>{message('ownerAccess.cancel')}</button>
            </div>
          ) : (
            <button type="button" disabled={busy} style={button(false, busy)} onClick={() => setConfirmRemove(true)}>{message('ownerAccess.removeAccess')}</button>
          )}
        </div>
      )}

      {state === 'invited' && invite && (
        <div style={{ marginBlockStart: 14, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
          <div style={{ fontSize: 14 }}>
            <strong><BidiText direction="auto">{invite.name}</BidiText></strong> <span style={{ color: D.inkSoft }}><IdentifierText>{invite.email}</IdentifierText></span>
            <div style={{ fontSize: 12, color: invite.expired ? D.alert : D.inkSoft, marginBlockStart: 2 }}>
              {invite.expired ? message('ownerAccess.invite.expired') : message('ownerAccess.invite.validUntil', { date: formatDay(invite.expires_at) })}
              {invite.invite_email_status && invite.invite_email_status !== 'sent' && (
                <> {message(EMAIL_STATUS_IDS[invite.invite_email_status] || 'ownerAccess.invite.emailUnknown')}</>
              )}
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button type="button" disabled={busy} style={button(true, busy)} onClick={() => run('resend')}>{message('ownerAccess.resend')}</button>
            <button type="button" disabled={busy} style={button(false, busy)} onClick={() => run('revoke')}>{message('ownerAccess.revoke')}</button>
          </div>
        </div>
      )}

      {(state === 'not_invited' || state === 'access_removed') && (
        <form
          style={{ marginBlockStart: 14, display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 8, alignItems: 'end' }}
          onSubmit={(event) => {
            event.preventDefault();
            run('invite', { name: form.name, email: form.email, language: form.language || null });
          }}
        >
          <label style={{ display: 'grid', gap: 4, fontSize: 12, color: D.inkSoft }}>
            {message('ownerAccess.form.name')}
            <input style={input} required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </label>
          <label style={{ display: 'grid', gap: 4, fontSize: 12, color: D.inkSoft }}>
            {message('ownerAccess.form.email')}
            <input style={input} type="email" required value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
          </label>
          <label style={{ display: 'grid', gap: 4, fontSize: 12, color: D.inkSoft }}>
            {message('ownerAccess.form.language')}
            <select style={input} value={form.language} onChange={(e) => setForm({ ...form, language: e.target.value })}>
              <option value="">{message('ownerAccess.form.languageDefault')}</option>
              <option value="fi">{message('ownerAccess.form.languageFi')}</option>
              <option value="en">{message('ownerAccess.form.languageEn')}</option>
            </select>
          </label>
          <button type="submit" disabled={busy} style={{ ...button(true, busy), justifySelf: 'start', padding: '8px 14px' }}>
            {message(state === 'access_removed' ? 'ownerAccess.inviteAgain' : 'ownerAccess.invite')}
          </button>
        </form>
      )}

      {notice && <div role="status" style={{ marginBlockStart: 12, fontSize: 13, color: D.ink }}>{message(notice)}</div>}
      {error && <div role="alert" style={{ marginBlockStart: 12, fontSize: 13, color: D.alert }}>{message(error)}</div>}
    </section>
  );
}
