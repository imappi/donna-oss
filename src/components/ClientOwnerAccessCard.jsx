// Firm side of the owner portal invite (server/donna/clientOwnerInvitesDb.js):
// on a client's People tab, the firm sees whether the business owner is in the
// portal and can invite, resend, revoke a pending invite, or remove access.
// Every action is receipted server-side; this card only renders the state the
// server returns. Mounted from FirmClientWorkspace (People tab).
//
// Copy is local English on purpose: the AR-3B mounted catalog is closed and
// carries exact Arabic parity, which this change does not touch.

import { useCallback, useEffect, useState } from 'react';

import { D } from './shared/design-tokens.js';
import { fetchClientOwnerAccess, postClientOwnerAccess } from '../lib/firmApi.js';

const STATE_LABEL = {
  not_invited: 'Not invited',
  invited: 'Invited',
  active: 'Active',
  access_removed: 'Access removed'
};

const EMAIL_NOTE = {
  sent: 'Invitation email sent.',
  skipped: 'The invitation is saved, but no email was sent from this deployment. Resend once email is set up.',
  failed: 'The invitation is saved, but the email failed to send. Try Resend.'
};

const formatDay = (value) => {
  if (!value) return '';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : date.toISOString().slice(0, 10);
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
      setError(err?.message || 'Could not load the owner’s portal access.');
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
      if (next.invite_email) setNotice(EMAIL_NOTE[next.invite_email.status] || '');
      else if (action === 'revoke') setNotice('Invitation revoked. The link no longer works.');
      else if (action === 'remove') setNotice('Access removed. Their past answers and the history stay.');
      if (action === 'invite') setForm({ name: '', email: '', language: '' });
    } catch (err) {
      setError(err?.message || 'That did not work. Try again.');
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
            Owner portal access
          </div>
          <div style={{ marginBlockStart: 4, fontSize: 13, color: D.inkSoft }}>
            The business owner uses the client portal to send documents and answer your questions. They see this company only.
          </div>
        </div>
        {state && (
          <span data-testid="client-owner-state" style={{ fontSize: 12, padding: '3px 10px', borderRadius: 999, border: `1px solid ${D.rule}`, color: D.ink }}>
            {STATE_LABEL[state] || state}
          </span>
        )}
      </div>

      {!access && !error && <div style={{ marginBlockStart: 14, fontSize: 13, color: D.inkSoft }}>Loading…</div>}

      {state === 'active' && owner && (
        <div style={{ marginBlockStart: 14, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
          <div style={{ fontSize: 14 }}>
            <strong>{owner.name}</strong> <span style={{ color: D.inkSoft }}>{owner.email}</span>
            {owner.since && <span style={{ color: D.inkSoft }}> · since {formatDay(owner.since)}</span>}
          </div>
          {confirmRemove ? (
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <span style={{ fontSize: 13 }}>Remove their access to this company’s portal?</span>
              <button type="button" disabled={busy} style={button(true, busy)} onClick={() => run('remove')}>Remove access</button>
              <button type="button" disabled={busy} style={button(false, busy)} onClick={() => setConfirmRemove(false)}>Cancel</button>
            </div>
          ) : (
            <button type="button" disabled={busy} style={button(false, busy)} onClick={() => setConfirmRemove(true)}>Remove access</button>
          )}
        </div>
      )}

      {state === 'invited' && invite && (
        <div style={{ marginBlockStart: 14, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
          <div style={{ fontSize: 14 }}>
            <strong>{invite.name}</strong> <span style={{ color: D.inkSoft }}>{invite.email}</span>
            <div style={{ fontSize: 12, color: invite.expired ? D.alert : D.inkSoft, marginBlockStart: 2 }}>
              {invite.expired ? 'The invitation link has expired. Resend to send a new one.' : `Link valid until ${formatDay(invite.expires_at)}.`}
              {invite.invite_email_status && invite.invite_email_status !== 'sent' && ` Email ${invite.invite_email_status}.`}
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button type="button" disabled={busy} style={button(true, busy)} onClick={() => run('resend')}>Resend</button>
            <button type="button" disabled={busy} style={button(false, busy)} onClick={() => run('revoke')}>Revoke</button>
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
            Owner’s name
            <input style={input} required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </label>
          <label style={{ display: 'grid', gap: 4, fontSize: 12, color: D.inkSoft }}>
            Email
            <input style={input} type="email" required value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
          </label>
          <label style={{ display: 'grid', gap: 4, fontSize: 12, color: D.inkSoft }}>
            Language
            <select style={input} value={form.language} onChange={(e) => setForm({ ...form, language: e.target.value })}>
              <option value="">From the company’s country</option>
              <option value="fi">Finnish</option>
              <option value="en">English</option>
            </select>
          </label>
          <button type="submit" disabled={busy} style={{ ...button(true, busy), justifySelf: 'start', padding: '8px 14px' }}>
            {state === 'access_removed' ? 'Invite again' : 'Invite owner'}
          </button>
        </form>
      )}

      {notice && <div role="status" style={{ marginBlockStart: 12, fontSize: 13, color: D.ink }}>{notice}</div>}
      {error && <div role="alert" style={{ marginBlockStart: 12, fontSize: 13, color: D.alert }}>{error}</div>}
    </section>
  );
}
