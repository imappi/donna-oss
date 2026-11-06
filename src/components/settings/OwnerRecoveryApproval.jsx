import { useEffect, useRef, useState } from 'react';
import { useIntl } from 'react-intl';
import { getAuthSessionEpoch } from '../../lib/accessToken.js';
import { getBookPrincipalId, getBookSessionIdentity } from '../../lib/bookSessionIdentity.js';
import { ownerRecoveryOperation } from '../../lib/firmApi.js';
import { IdentifierText } from '../../i18n/BidiText.jsx';
import { D } from '../shared/design-tokens.js';
import { btnPrimary, btnChip } from '../shared/buttons.js';
const sessionKey = () => JSON.stringify([getBookSessionIdentity(),getAuthSessionEpoch()]);

function Approval({firmId,clientId,identity,changed}) {
  const intl=useIntl(), m=key=>intl.formatMessage({id:`mounted.ownerRevalidation.${key}`});
  const [review,setReview]=useState(null),[confirmed,setConfirmed]=useState(false),[receipt,setReceipt]=useState(null);
  const [busy,setBusy]=useState(false),[error,setError]=useState('');
  const pending=useRef(null),alive=useRef(true),generation=useRef(0);
  useEffect(()=>{alive.current=true;return()=>{alive.current=false;generation.current++;pending.current?.abort();};},[]);
  const run=async apply=>{
    if(sessionKey()!==identity){changed();return;}
    if(busy || (apply && (!review || !confirmed)))return;
    const controller=new AbortController(),attempt=++generation.current;pending.current=controller;
    const timer=setTimeout(()=>controller.abort(),20_000);
    setBusy(true);setError('');setReceipt(null);
    try {
      const data=await ownerRecoveryOperation({firmId,clientId,reviewDigest:apply?review.review_digest:undefined,signal:controller.signal});
      if(!alive.current || attempt!==generation.current || controller.signal.aborted || sessionKey()!==identity)return;
      if(data?.firm_id!==firmId || data?.client_id!==clientId || data?.actor_user_id!==getBookPrincipalId()
        || !data.actor_id || data.processing_readiness!=='INCOMPLETE'
        || data.purpose!==(apply?'deleted_owner_recovery_applied':'deleted_owner_recovery_operator')
        || (!apply && (!/^[a-f0-9]{64}$/.test(data.review_digest||'') || !data.owner_email || !data.company_name || !Number.isFinite(Date.parse(data.expires_at))))
        || (apply && (!(data.receipt_id>0) || data.actor_id!==review.actor_id)))throw new Error(m('invalidRecovery'));
      if(apply){setReceipt(data);setReview(null);}else setReview(data);
    }catch(failure){if(alive.current && attempt===generation.current && sessionKey()===identity){
      setReview(null);setError(failure.name==='AbortError'?intl.formatMessage({id:'mounted.pilot.timeout'}):failure.message);
    }}finally{
      clearTimeout(timer);if(pending.current===controller)pending.current=null;
      if(alive.current && attempt===generation.current){setBusy(false);setConfirmed(false);if(sessionKey()!==identity)changed();}
    }
  };
  useEffect(()=>{void run(false);},[]);
  return <div aria-busy={busy}>
    {busy && <p role="status">{m('working')}</p>}
    {error && <p role="alert" style={{color:D.alert}}>{error}</p>}
    {review && <>
      <h4><IdentifierText>{review.company_name}</IdentifierText></h4>
      <p><IdentifierText>{review.owner_email}</IdentifierText></p><p>{m('operatorRecoveryIntro')}</p>
      <p>{m('expires')} <time dateTime={review.expires_at}>{intl.formatDate(review.expires_at,{dateStyle:'medium',timeStyle:'short'})}</time></p>
      <label style={{display:'flex',gap:10,marginBlock:16}}><input type="checkbox" checked={confirmed} disabled={busy}
        onChange={event=>setConfirmed(event.target.checked)}/>{m('operatorRecoveryConsent')}</label>
      <button type="button" style={btnPrimary} disabled={busy || !confirmed} onClick={()=>run(true)}>{m('operatorRecoveryApply')}</button>
    </>}
    {receipt && <div role="status"><strong>{m('recoveryApplied')}</strong><p>{m('recoveryAppliedNext')}</p></div>}
    <button type="button" style={{...btnChip,marginBlock:16}} disabled={busy} onClick={()=>run(false)}>{m('recoveryReview')}</button>
  </div>;
}
export default function OwnerRecoveryApproval({firmId,clientId}) {
  const [identity,setIdentity]=useState(sessionKey),[revision,setRevision]=useState(0);
  const changed=()=>{setIdentity(sessionKey());setRevision(value=>value+1);};
  useEffect(()=>{
    const storage=event=>{if(!event.key || ['donna.auth_session.v1','donna.access_token.v1'].includes(event.key))changed();};
    const focus=()=>{if(sessionKey()!==identity)changed();};
    window.addEventListener('storage',storage);window.addEventListener('focus',focus);
    return()=>{window.removeEventListener('storage',storage);window.removeEventListener('focus',focus);};
  },[identity]);
  return <Approval key={`${firmId}:${clientId}:${identity}:${revision}`} {...{firmId,clientId,identity,changed}}/>;
}
