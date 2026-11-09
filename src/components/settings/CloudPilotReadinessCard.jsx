import { useEffect,useRef,useState } from 'react';
import { useIntl } from 'react-intl';
import { getBookSessionIdentity } from '../../lib/bookSessionIdentity.js';
import { cloudPilotOperation } from '../../lib/firmApi.js';
import { isDesktopShell } from '../../lib/desktopShell.js';
import { btnPrimary,btnChip } from '../shared/buttons.js';

function PilotProcessingReview({firmId,clientId,sessionIdentity,onSessionChanged}) {
  const intl=useIntl(),m=id=>intl.formatMessage({id:`mounted.settings.cloudPilot.${id}`});
  const [review,setReview]=useState(null),[busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState(''),[confirmed,setConfirmed]=useState(false);
  const version=useRef(0),pending=useRef(null);
  useEffect(()=>()=>{version.current++;pending.current?.abort();},[]);
  const run=async action=>{
    if (getBookSessionIdentity()!==sessionIdentity) {onSessionChanged();return;}
    if (busy || (action==='enable' && (!confirmed || !review?.host_ready))) return;
    const current=version.current,controller=new AbortController();pending.current=controller;
    const timer=setTimeout(()=>controller.abort(),action==='probe'?75000:20000);
    const isCurrent=()=>current===version.current&&!controller.signal.aborted&&getBookSessionIdentity()===sessionIdentity;
    setBusy(true);setError('');setNotice('');
    try {
      const result=await cloudPilotOperation({firmId,clientId,action,reviewDigest:review?.review_digest,confirmed,signal:controller.signal});
      if(!isCurrent()){if(getBookSessionIdentity()!==sessionIdentity)onSessionChanged();return;}
      if (result?.firm_id!==firmId || result?.client_id!==clientId || !result?.actor_id
        || (action!=='review' && result.actor_id!==review?.actor_id)) throw new Error(intl.formatMessage({id:'mounted.pilot.invalidResponse'}));
      if(action==='review')setReview(result);
      else{setReview(null);setConfirmed(false);setNotice(action==='probe'?m('probeRequested'):m('staged')+' '+(result.entity_state||'INCOMPLETE'));}
    }catch(e){if(current===version.current&&getBookSessionIdentity()===sessionIdentity){setReview(null);setConfirmed(false);setError(e.name==='AbortError'?intl.formatMessage({id:'mounted.pilot.timeout'}):e.message);}}
    finally{clearTimeout(timer);if(pending.current===controller)pending.current=null;if(current===version.current)setBusy(false);}
  };
  return <section aria-label={m('title')} style={{border:'1px solid #dce1e5',borderRadius:12,padding:20,marginTop:16,overflowWrap:'anywhere'}}>
    <h3 style={{marginTop:0}}>{m('title')}</h3><p>{m('description')}</p>
    <button type="button" disabled={busy} onClick={()=>run('review')} style={btnChip}>{m('review')}</button>
    {error&&<p role="alert">{error}</p>}{notice&&<p role="status">{notice}</p>}
    {review&&<>
      <p role="status">{review.host_ready?m('hostReady'):m('hostIncomplete')} · {review.entity_ready?m('entityReady'):m('entityIncomplete')}</p>
      {review.expires_at&&<p>{m('expires')} <time dateTime={review.expires_at}>{intl.formatDate(review.expires_at,{dateStyle:'medium',timeStyle:'short'})}</time></p>}
      <ul>{review.checks.map(check=><li key={check.id}>{m(check.id)}: {check.status}{check.reason?` (${check.reason})`:''}</li>)}</ul>
      <p>{m('probeDescription')}</p><button type="button" disabled={busy} onClick={()=>run('probe')} style={btnChip}>{m('probe')}</button>
      <details><summary>{m('exactChanges')}</summary><p>{m('scope')}</p><ul>{review.changes.map(change=><li key={change.flag_key}><code>{change.flag_key}</code>: {change.stage}</li>)}</ul>
        <p>{m('legacy')}</p><ul>{Object.entries(review.legacy_configuration||{}).map(([key,value])=><li key={key}><code>{key}</code>: {value??'unset'}</li>)}</ul>
      </details>
      <p>{m('authority')}</p>
      <label style={{display:'block',margin:'12px 0'}}><input type="checkbox" checked={confirmed} disabled={busy||!review.host_ready} onChange={e=>setConfirmed(e.target.checked)}/> {m('confirm')}</label>
      <button type="button" style={btnPrimary} disabled={busy||!confirmed||!review.host_ready} onClick={()=>run('enable')}>{m('enable')}</button>
    </>}
  </section>;
}

// The receipted exit from internal-pilot send containment. Releasing sends
// nothing: drafts still go through the existing Send and its checks. It also
// switches on email questions and reminders for this client, as the review
// lists them (a channel already set for the client is left as it is).
const CHANNEL_LABELS={OWNER_EMAIL_ASKS:'ownerEmail',ASK_REASK_CADENCE:'reminders'};
function PilotSendRelease({firmId,clientId,sessionIdentity,onSessionChanged}) {
  const intl=useIntl(),m=(id,values)=>intl.formatMessage({id:`mounted.settings.cloudPilot.send.${id}`},values);
  const [review,setReview]=useState(null),[busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState(''),[confirmed,setConfirmed]=useState(false);
  const version=useRef(0),pending=useRef(null);
  useEffect(()=>()=>{version.current++;pending.current?.abort();},[]);
  const run=async action=>{
    if (getBookSessionIdentity()!==sessionIdentity) {onSessionChanged();return;}
    if (busy || (action==='send-release' && (!confirmed || !review?.contained))) return;
    const current=version.current,controller=new AbortController();pending.current=controller;
    const timer=setTimeout(()=>controller.abort(),20000);
    const isCurrent=()=>current===version.current&&!controller.signal.aborted&&getBookSessionIdentity()===sessionIdentity;
    setBusy(true);setError('');setNotice('');
    try {
      const result=await cloudPilotOperation({firmId,clientId,action,reviewDigest:review?.review_digest,confirmed,signal:controller.signal});
      if(!isCurrent()){if(getBookSessionIdentity()!==sessionIdentity)onSessionChanged();return;}
      if (result?.firm_id!==firmId || result?.client_id!==clientId || !result?.actor_id
        || (action!=='send-review' && (result.actor_id!==review?.actor_id || result.contained!==false || !result.receipt_id))) throw new Error(intl.formatMessage({id:'mounted.pilot.invalidResponse'}));
      if(action==='send-review')setReview(result);
      else{setReview(null);setConfirmed(false);setNotice(m('released',{id:result.receipt_id}));}
    }catch(e){if(current===version.current&&getBookSessionIdentity()===sessionIdentity){setReview(null);setConfirmed(false);setError(e.name==='AbortError'?intl.formatMessage({id:'mounted.pilot.timeout'}):e.message);}}
    finally{clearTimeout(timer);if(pending.current===controller)pending.current=null;if(current===version.current)setBusy(false);}
  };
  const onOff=value=>value?m('on'):m('off');
  return <section aria-label={m('title')} style={{border:'1px solid #dce1e5',borderRadius:12,padding:20,marginTop:16,overflowWrap:'anywhere'}}>
    <h3 style={{marginTop:0}}>{m('title')}</h3><p>{m('description')}</p>
    <button type="button" disabled={busy} onClick={()=>run('send-review')} style={btnChip}>{m('review')}</button>
    {error&&<p role="alert">{error}</p>}{notice&&<p role="status">{notice}</p>}
    {review&&<>
      <p role="status">{review.contained?m('contained'):review.release?m('releasedBy',{actorName:review.release.actor_id,date:intl.formatDate(review.release.released_at,{dateStyle:'medium',timeStyle:'short'})}):m('notContained')}</p>
      <p>{m('drafts',{count:review.draft_batches.length,questions:review.draft_owner_questions})}{review.draft_batches_truncated?` ${m('truncated')}`:''}</p>
      {review.draft_batches.length>0&&<ul>{review.draft_batches.map(batch=><li key={batch.id}>{batch.subject||batch.id} · {m('items',{count:batch.item_count+batch.document_ask_count})}</li>)}</ul>}
      <p>{m('effect')}</p>
      <ul>{(review.after_release.owner_channels||[]).map(channel=><li key={channel.flag_key}>
        {m(CHANNEL_LABELS[channel.flag_key]||'ownerEmail')} (<code>{channel.flag_key}</code>): {channel.action==='stage'?m('willSwitchOn'):m('leftAsIs',{stage:channel.existing_stage})} · {onOff(channel.acts_after_release)}
      </li>)}<li>{m('autoSend')}: {onOff(review.after_release.firm_auto_send_client_asks)}</li></ul>
      {review.after_release.owner_email_recipient&&<p>{m('recipient',{email:review.after_release.owner_email_recipient})}</p>}
      {review.after_release.owner_email_missing&&<p><strong>{m('noOwnerEmail')}</strong></p>}
      {review.contained&&<>
        <label style={{display:'block',margin:'12px 0'}}><input type="checkbox" checked={confirmed} disabled={busy} onChange={e=>setConfirmed(e.target.checked)}/> {m('confirm')}</label>
        <button type="button" style={btnPrimary} disabled={busy||!confirmed} onClick={()=>run('send-release')}>{m('release')}</button>
      </>}
    </>}
  </section>;
}

export default function CloudPilotReadinessCard({firm,clients=[],selectedClientId,dataSource}) {
  const intl=useIntl(),m=id=>intl.formatMessage({id:`mounted.pilot.${id}`});
  const [clientId,setClientId]=useState(selectedClientId||'');
  const [sessionIdentity,setSessionIdentity]=useState(getBookSessionIdentity);
  const refreshSession=()=>setSessionIdentity(getBookSessionIdentity());
  useEffect(()=>{
    const refresh=()=>setSessionIdentity(getBookSessionIdentity());
    window.addEventListener('storage',refresh);window.addEventListener('focus',refresh);
    return()=>{window.removeEventListener('storage',refresh);window.removeEventListener('focus',refresh);};
  },[]);
  // The hosted accounting markets (server HOSTED_MARKET_PROFILES rows with
  // processing 'accounting'); the server still refuses SG review clients.
  const candidates=clients.filter(c=>['FI','US'].includes(String(c.jurisdiction||c.profile?.jurisdiction).toUpperCase()));
  const selected=candidates.find(c=>c.id===clientId);
  if(isDesktopShell()||dataSource!=='database'||!firm?.id)return null;
  return <div style={{marginBlock:16}}>
    <label>{m('client')}<select aria-label={intl.formatMessage({id:'mounted.settings.cloudPilot.title'})} value={selected?.id||''}
      style={{display:'block',font:'inherit',padding:8,maxWidth:'100%'}} onChange={e=>setClientId(e.target.value)}>
      <option value="">{m('chooseClient')}</option>{candidates.map(c=><option key={c.id} value={c.id}>{c.companyName||c.id}</option>)}
    </select></label>
    {selected&&String(selected.jurisdiction||selected.profile?.jurisdiction).toUpperCase()==='FI'&&<PilotProcessingReview key={`${firm.id}:${selected.id}:${sessionIdentity}`} firmId={firm.id} clientId={selected.id}
      sessionIdentity={sessionIdentity} onSessionChanged={refreshSession}/>}
    {selected&&<PilotSendRelease key={`send:${firm.id}:${selected.id}:${sessionIdentity}`} firmId={firm.id} clientId={selected.id}
      sessionIdentity={sessionIdentity} onSessionChanged={refreshSession}/>}
  </div>;
}
