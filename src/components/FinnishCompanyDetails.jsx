import { useEffect, useRef, useState } from 'react';
import { useIntl } from 'react-intl';
import { fetchFinnishProfileIntake, fetchFiscalPeriods, updateFirmClientProfile } from '../lib/firmApi.js';
import { readJurisdiction, readEntityType } from '../lib/clientAxes.js';

function Details({ clientId, onDatabaseSnapshot }) {
  const intl = useIntl();
  const m = key => intl.formatMessage({ id: `mounted.fiDetails.${key}` });
  const [context, setContext] = useState(null), [draft, setDraft] = useState(null);
  const [periods, setPeriods] = useState([]), [busy, setBusy] = useState(false), [error, setError] = useState(''), [saved, setSaved] = useState(false);
  const current = useRef(null), alive = useRef(true);
  const request = async operation => {
    current.current?.abort();
    const controller = new AbortController(); current.current = controller;
    const timer = setTimeout(() => controller.abort(), 20_000);
    try { const value = await operation(controller.signal); if (controller.signal.aborted) throw new DOMException('Aborted', 'AbortError'); return value; }
    finally { clearTimeout(timer); }
  };
  const load = async signal => {
    const [data, fiscal] = await Promise.all([fetchFinnishProfileIntake({ clientId, signal }), fetchFiscalPeriods({ clientId, signal })]);
    if (data?.client_id !== clientId || !data?.fields || typeof data.editable !== 'boolean' || !Array.isArray(data.locked_fields) || !Array.isArray(fiscal?.periods)) throw new Error(m('unavailable'));
    if (!alive.current || signal.aborted) return;
    setContext(data); setPeriods(fiscal.periods);
    setDraft({ businessId: data.fields.businessId || '', incorporation_date: data.fields.incorporation_date || '',
      status: data.fields.alv_registration?.status || '', registered_from: data.fields.alv_registration?.registered_from || '',
      registered_until: data.fields.alv_registration?.registered_until || '',
      cadence: data.fields.verokausi && data.fields.alv_registration?.tax_period && data.fields.verokausi !== data.fields.alv_registration.tax_period
        ? '' : data.fields.verokausi || data.fields.alv_registration?.tax_period || '' });
  };
  const refresh = async () => {
    setBusy(true); setError(''); setSaved(false); setContext(null);
    try { await request(load); } catch (failure) { if (alive.current) setError(failure?.name === 'AbortError' ? m('unavailable') : failure.message); }
    finally { if (alive.current) setBusy(false); }
  };
  useEffect(() => { alive.current = true; refresh(); return () => { alive.current = false; current.current?.abort(); }; }, []);
  const edit = (key, value) => { setDraft(old => ({ ...old, [key]: value })); setSaved(false); };
  const save = async event => {
    event.preventDefault(); if (!context?.editable || busy) return;
    setBusy(true); setError(''); setSaved(false);
    const registration = { ...(context.fields.alv_registration || {}), status: draft.status };
    const old = context.fields.alv_registration || {};
    if (draft.businessId !== (context.fields.businessId || '') || draft.status !== (old.status || '') || draft.registered_from !== (old.registered_from || '')
      || draft.registered_until !== (old.registered_until || '') || draft.cadence !== (old.tax_period || '')) {
      delete registration.verified_from; delete registration.verified_at;
    }
    for (const key of ['registered_from', 'registered_until']) { if (draft[key]) registration[key] = draft[key]; else delete registration[key]; }
    if (draft.cadence) registration.tax_period = draft.cadence; else delete registration.tax_period;
    // Recorded facts bound by pilot preparation are never re-sent; a still-empty
    // one may be recorded once (the server receipts it).
    const patch = Object.fromEntries(Object.entries({ businessId: draft.businessId, incorporation_date: draft.incorporation_date,
      alv_registration: registration, verokausi: draft.cadence || null }).filter(([key]) => !context.locked_fields.includes(key)));
    try {
      await request(async signal => {
        const snapshot = await updateFirmClientProfile({ clientId, profilePatch: patch, signal });
        if (!alive.current || signal.aborted) return;
        if (snapshot?.source !== 'database') throw new Error(m('unavailable'));
        onDatabaseSnapshot?.(snapshot);
        await load(signal);
        if (alive.current && !signal.aborted) setSaved(true);
      });
    } catch (failure) { if (alive.current) { setError(failure?.name === 'AbortError' ? m('unavailable') : failure.message); if (failure.code === 'FI_PROFILE_PILOT_PREPARED') setContext(old => ({ ...old, editable: false })); } }
    finally { if (alive.current) setBusy(false); }
  };
  const lockedKey = key => Boolean(context?.locked_fields?.includes(key));
  const firstPeriod = [...periods].sort((a,b) => String(a.starts_on).localeCompare(String(b.starts_on)))[0];
  const greenfield = context?.fields.incorporation_date && firstPeriod?.starts_on === context.fields.incorporation_date;
  return <section aria-label={m('title')} style={{ padding: 20, border: '1px solid #ddd', borderRadius: 12 }}>
    <h3>{m('title')}</h3><p>{m('guidance')}</p>
    {busy && <p role="status">{m('loading')}</p>}
    {error && <p role="alert">{error}</p>}
    {context && draft && <form onSubmit={save}>
      {!context.editable ? <p role="status">{m('locked')}</p> : context.locked_fields.length > 0 && <p role="status">{m('firstFill')}</p>}
      <fieldset disabled={busy || !context.editable} style={{ border: 0, padding: 0 }}>
        {[['businessId','businessId','text'],['incorporation_date','incorporation','date']].map(([key,label,type]) => <label key={key} style={{ display:'block', marginBlock:12 }}>{m(label)} <input required disabled={lockedKey(key)} type={type} value={draft[key]} onChange={e=>edit(key,e.target.value)} /></label>)}
        <label style={{ display:'block', marginBlock:12 }}>{m('registration')} <select required disabled={lockedKey('alv_registration')} value={draft.status} onChange={e=>edit('status',e.target.value)}>
          <option value="">{m('choose')}</option>{['registered','not_registered','deregistered'].map(value=><option key={value} value={value}>{m(value)}</option>)}
        </select></label>
        {draft.status !== 'not_registered' && <>
          <label style={{ display:'block', marginBlock:12 }}>{m('from')} <input required disabled={lockedKey('alv_registration')} type="date" value={draft.registered_from} onChange={e=>edit('registered_from',e.target.value)} /></label>
          <label style={{ display:'block', marginBlock:12 }}>{m('until')} <input required={draft.status==='deregistered'} disabled={lockedKey('alv_registration')} type="date" value={draft.registered_until} onChange={e=>edit('registered_until',e.target.value)} /></label>
        </>}
        <label style={{ display:'block', marginBlock:12 }}>{m('cadence')} <select required={draft.status !== 'not_registered'} disabled={lockedKey('alv_registration') && lockedKey('verokausi')} value={draft.cadence} onChange={e=>edit('cadence',e.target.value)}>
          <option value="">{m('choose')}</option>{['month','quarter','year'].map(value=><option key={value} value={value}>{m(value)}</option>)}
        </select></label>
        {context.editable && <button type="submit">{m('save')}</button>}
      </fieldset>
      {saved && <p role="status">{m('saved')}</p>}
      <p>{greenfield ? m('greenfield') : m('openingUnknown')}</p>
      <p>{m('priorPosition')}</p>
    </form>}
    <button type="button" disabled={busy} onClick={refresh}>{m('refresh')}</button>
  </section>;
}

export default function FinnishCompanyDetails({ profile, onDatabaseSnapshot }) {
  return readJurisdiction(profile) === 'fi' && readEntityType(profile) === 'fi-oy'
    ? <Details key={profile.id} clientId={profile.id} onDatabaseSnapshot={onDatabaseSnapshot} /> : null;
}
