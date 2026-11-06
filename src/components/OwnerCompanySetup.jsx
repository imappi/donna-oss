import { useEffect, useRef, useState } from 'react';
import { useIntl } from 'react-intl';
import { updateFirmClientProfile } from '../lib/firmApi.js';
import { D } from './shared/design-tokens.js';

export default function OwnerCompanySetup({ clientId, status, onRefresh, onSessionChanged, isCurrent }) {
  const intl = useIntl();
  const m = key => intl.formatMessage({ id: `mounted.ownerSetup.${key}` });
  const [name, setName] = useState(''), [date, setDate] = useState(''), [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const pending = useRef(null);
  useEffect(() => () => { pending.current?.abort(); pending.current = null; }, []);
  const save = async event => {
    event.preventDefault();
    if (!isCurrent()) { onSessionChanged(); return; }
    if (busy || !confirmed || !name.trim() || !date) return;
    const controller = new AbortController(); pending.current = controller;
    const timer = setTimeout(() => controller.abort(), 20_000);
    setBusy(true); setError('');
    try {
      await updateFirmClientProfile({ clientId, ownerSetup: true, signal: controller.signal,
        profilePatch: { companyName: name.trim(), jurisdiction: 'FI', entityType: 'fi-oy', incorporation_date: date } });
      if (pending.current === controller && !controller.signal.aborted) {
        if (!isCurrent()) onSessionChanged(); else onRefresh();
      }
    } catch (failure) {
      if (failure.code === 'AUTH_SESSION_CHANGED') { onSessionChanged(); return; }
      if (pending.current === controller && !controller.signal.aborted) setError(failure.message || m('failed'));
      else if (pending.current === controller) setError(m('failed'));
    } finally {
      clearTimeout(timer);
      if (pending.current === controller) { pending.current = null; setBusy(false); }
    }
  };
  const field = { display: 'block', width: '100%', boxSizing: 'border-box', padding: 10, font: 'inherit', marginBlock: 8 };
  return <main style={{ maxWidth: 500, margin: '5vh auto', padding: 24, fontFamily: D.body, color: D.ink }} aria-busy={busy}>
    <p>DONNA</p>
    <h1>{m(status.company_setup_required ? 'title' : 'pending')}</h1>
    <p>{m(status.company_setup_required ? 'intro' : 'next')}</p>
    <p>{status.owner_email}</p>
    {status.company_setup_required ? <form onSubmit={save}>
      <fieldset disabled={busy} style={{ border: 0, padding: 0 }}>
        <label>{m('company')}<input required maxLength={200} style={field} value={name} onChange={event => { setName(event.target.value); setConfirmed(false); }} /></label>
        <label>{m('date')}<input required type="date" style={field} value={date} onChange={event => { setDate(event.target.value); setConfirmed(false); }} /></label>
        <label style={{ display: 'block', marginBlock: 20 }}><input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} /> {m('confirm')}</label>
        <button type="submit" disabled={!confirmed || !name.trim() || !date}>{m(busy ? 'saving' : 'save')}</button>
      </fieldset>
    </form> : <p><strong>{status.company_name}</strong></p>}
    {error && <p role="alert">{error}</p>}
    <p>{m('noPayment')}</p>
    <button type="button" disabled={busy} onClick={onRefresh}>{m('refresh')}</button>
  </main>;
}
