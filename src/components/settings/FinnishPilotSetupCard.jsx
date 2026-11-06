import OwnerRecoveryApproval from './OwnerRecoveryApproval.jsx';
import { useEffect, useRef, useState } from 'react';
import { useIntl } from 'react-intl';
import { D } from '../shared/design-tokens.js';
import { btnPrimary, btnChip } from '../shared/buttons.js';
import { IdentifierText } from '../../i18n/BidiText.jsx';
import { isDesktopShell } from '../../lib/desktopShell.js';
import { reviewFinnishPilotSetup, prepareFinnishPilotSetup } from '../../lib/firmApi.js';

const inputStyle = { font: 'inherit', padding: 8, border: `1px solid ${D.rule}`, borderRadius: 8, width: '100%', boxSizing: 'border-box' };

function PilotReview({ firmId, clientId }) {
  const intl = useIntl();
  const m = (key, values) => intl.formatMessage({ id: `mounted.pilot.${key}` }, values);
  const [review, setReview] = useState(null);
  const [receipt, setReceipt] = useState(null);
  const [name, setName] = useState('');
  const [basis, setBasis] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [reload, setReload] = useState(0);
  const alive = useRef(true);
  const pending = useRef(null);
  useEffect(() => { alive.current = true; return () => { alive.current = false; pending.current?.abort(); }; }, []);
  const bounded = async (operation) => {
    const controller = new AbortController();
    pending.current = controller;
    const timer = setTimeout(() => controller.abort(), 20_000);
    try { const result = await operation(controller.signal); if (controller.signal.aborted) throw new DOMException('Aborted', 'AbortError'); return result; }
    finally { clearTimeout(timer); if (pending.current === controller) pending.current = null; }
  };
  useEffect(() => {
    let current = true;
    setReview(null); setReceipt(null); setError(''); setConfirmed(false); setBusy(true);
    bounded(signal => reviewFinnishPilotSetup({ firmId, clientId, signal })).then(data => {
      if (!current) return;
      if (data?.firm_id !== firmId || data?.client_id !== clientId || !data?.client_version || !data?.actor_id) throw new Error(m('invalidResponse'));
      setReview(data); setName(data.profile?.companyName || ''); setBasis(data.profile?.accountingBasis || '');
      setReceipt(data.receipt?.metadata || null);
    }).catch(err => { if (current) setError(err?.name === 'AbortError' ? m('timeout') : err?.message || m('failed')); })
      .finally(() => { if (current) setBusy(false); });
    return () => { current = false; pending.current?.abort(); };
  }, [firmId, clientId, reload]);
  const apply = async () => {
    if (!review || !confirmed || busy || !name.trim() || !['cash', 'accrual'].includes(basis)) return;
    setBusy(true); setError(''); setReceipt(null);
    const profilePatch = { companyName: name.trim(), jurisdiction: 'FI', entityType: 'fi-oy', accountingCurrency: 'EUR',
      accounting_system: 'none', accounting_view: 'management_books', accountingBasis: basis };
    try {
      const data = await bounded(signal => prepareFinnishPilotSetup({ firmId, clientId, profilePatch, clientVersion: review.client_version, signal }));
      if (!alive.current) return;
      if (data?.client_id !== clientId || data?.firm_id !== firmId || data?.actor_id !== review.actor_id
        || data?.processing_readiness !== 'INCOMPLETE') throw new Error(m('invalidResponse'));
      setReceipt(data);
    } catch (err) {
      if (alive.current) setError(err?.name === 'AbortError' ? m('timeout') : err?.message || m('failed'));
    } finally {
      if (alive.current) { setBusy(false); setConfirmed(false); setReview(null); }
    }
  };
  return <div aria-busy={busy}>
    {busy && <p role="status">{m('working')}</p>}
    {error && <p role="alert" style={{ color: D.alert }}>{error}</p>}
    {review && <>
      <p>{m('operator')} <IdentifierText>{review.actor_id}</IdentifierText></p>
      {review.owner_provenance?.kind === 'existing_owner_revalidated' && <p>
        {intl.formatMessage({ id: 'mounted.ownerRevalidation.operatorRevalidated' })}{' '}
        <IdentifierText>{review.owner_provenance.owner_email}</IdentifierText>
      </p>}
      <label style={{ display: 'block', marginBlock: 12 }}>{m('company')}<input style={inputStyle} value={name} disabled={busy}
        onChange={event => { setName(event.target.value); setConfirmed(false); }} /></label>
      <p>{m('scope')}</p>
      <label style={{ display: 'block', marginBlock: 12 }}>{m('basis')}<select style={inputStyle} value={basis} disabled={busy}
        onChange={event => { setBasis(event.target.value); setConfirmed(false); }}>
        <option value="">{m('chooseBasis')}</option><option value="accrual">{m('accrual')}</option><option value="cash">{m('cash')}</option>
      </select></label>
      <p>{m('effects')}</p>
      <details><summary>{m('configuration')}</summary>
        <p>{m('configurationHelp')}</p>
        {(review.configuration || []).map(flag => <div key={flag.flag_key} style={{ overflowWrap: 'anywhere' }}>
          <IdentifierText>{flag.flag_key}</IdentifierText>{' · '}<IdentifierText>{flag.stage || m('unconfigured')}</IdentifierText>
          {flag.force_disabled ? ` · ${m('disabled')}` : ''}
        </div>)}
        <p>{m('runtimeIncomplete')}</p>
      </details>
      <label style={{ display: 'flex', gap: 10, alignItems: 'start', marginBlock: 16 }}>
        <input type="checkbox" checked={confirmed} disabled={busy} onChange={event => setConfirmed(event.target.checked)} />{m('confirm')}
      </label>
      <button type="button" style={btnPrimary} disabled={busy || !confirmed || !name.trim() || !['cash', 'accrual'].includes(basis)} onClick={apply}>{m('prepare')}</button>
    </>}
    {receipt && <div role="status" style={{ marginBlock: 16 }}>
      <strong>{m(receipt.already_prepared ? 'alreadyPrepared' : 'prepared')}</strong>
      <p>{m('runtimeIncomplete')}</p>
      <p><IdentifierText>{receipt.client_id}</IdentifierText>{' · '}<IdentifierText>{receipt.actor_id}</IdentifierText></p>
      {receipt.profile && <p>{receipt.profile.companyName}{' · '}{m(receipt.profile.accountingBasis === 'cash' ? 'cash' : 'accrual')}</p>}
      <details><summary>{m('receipt')}</summary><pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', fontSize: 12 }}><IdentifierText>{JSON.stringify(receipt, null, 2)}</IdentifierText></pre></details>
    </div>}
    <button type="button" style={{ ...btnChip, marginBlock: 12, marginInlineStart: review ? 12 : 0 }} disabled={busy} onClick={() => setReload(value => value + 1)}>{m('refresh')}</button>
  </div>;
}

export default function FinnishPilotSetupCard({ firm, clients = [], dataSource }) {
  const intl = useIntl();
  const m = key => intl.formatMessage({ id: `mounted.pilot.${key}` });
  const [clientId, setClientId] = useState('');
  const [recoveryOpen,setRecoveryOpen]=useState(false);
  if (isDesktopShell() || dataSource !== 'database' || !firm?.id) return null;
  const candidates = clients.filter(client => String(client.jurisdiction).toUpperCase() === 'FI');
  const selected = candidates.find(client => client.id === clientId);
  return <section aria-label={m('title')} style={{ background: D.paperDeep, padding: 24, borderRadius: 16, marginBottom: 16 }}>
    <h3 style={{ marginTop: 0 }}>{m('title')}</h3><p>{m('intro')}</p>
    <label>{m('client')}<select style={inputStyle} value={selected?.id || ''} onChange={event => {setClientId(event.target.value);setRecoveryOpen(false);}}>
      <option value="">{m('chooseClient')}</option>
      {candidates.map(client => <option key={client.id} value={client.id}>{client.companyName || client.id}</option>)}
    </select></label>
    {!candidates.length && <p>{m('noClients')}</p>}
    {selected && <button type="button" style={{...btnChip,marginBlock:16}} onClick={()=>setRecoveryOpen(value=>!value)}>
      {recoveryOpen ? m('refresh') : intl.formatMessage({id:'mounted.ownerRevalidation.recoveryReview'})}</button>}
    {selected && recoveryOpen && <OwnerRecoveryApproval firmId={firm.id} clientId={selected.id}/>}
    {selected && !recoveryOpen && <PilotReview key={`${firm.id}:${selected.id}`} firmId={firm.id} clientId={selected.id} />}
  </section>;
}
