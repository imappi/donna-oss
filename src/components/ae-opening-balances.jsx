import React, { useEffect, useState } from 'react';
import './ae-opening-balances.css';
import { firmFetch } from '../lib/firmApi.js';

// Owner-declared full TB. The server owns chart identity, proposal, footing and
// confirmation. This card renders that persisted proposal without reclassifying.
export default function AeOpeningBalances({ clientId, periods = [] }) {
  const [state,setState]=useState(null);
  const [account,setAccount]=useState({code:'',name:'',canonical_role:'',currency:'AED'});
  const [existingAccount,setExistingAccount]=useState('');
  const [error,setError]=useState('');
  const [busy,setBusy]=useState(false);
  const [draft,setDraft]=useState({as_of:'',source_as_of:'',currency:'',source_document_id:'',complete:false,declared_lines:[{account_id:'',debit:'0',credit:'0'}]});
  const endpoint=`/api/donna/firms/clients/${encodeURIComponent(clientId)}/ae-opening-balances`;
  const load=async(signal)=>{
    const response=await firmFetch(endpoint,{signal}); const data=await response.json();
    if(!response.ok) throw new Error(data.error); setState(data);
  };
  useEffect(()=>{
    const controller=new AbortController();setState(null);setError('');
    load(controller.signal).catch(e=>{if(e.name!=='AbortError')setError(e.message);});
    return()=>controller.abort();
  },[clientId]);
  const act=async(body)=>{
    setBusy(true);setError('');
    try{const response=await firmFetch(endpoint,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
      const data=await response.json();await load();if(!response.ok)throw new Error(data.error);
    }catch(e){setError(e.message);}finally{setBusy(false);}
  };
  if(!state?.enabled)return error?<p role="alert">{error}</p>:null;
  const ask=state.asks.find(a=>['open','draft','replied'].includes(a.status));
  const saved=ask?.request_payload?.ae_opening_balance;
  const proposal=saved?.proposal;
  const posted=state.asks.find(a=>a.response_payload?.action==='posted');
  const updateLine=(index,key,value)=>setDraft(d=>({...d,declared_lines:d.declared_lines.map((line,i)=>i===index?{...line,[key]:value}:line)}));
  return <section className="ae-opening-balances" aria-label="AED opening trial balance">
    <h3>Opening trial balance · AED</h3>
    <p>Bring the complete closing trial balance into your management books. Include every balance; a bank statement alone is not a complete balance sheet.</p>
    {(state.limitations||[]).map(text=><p key={text}>{text}</p>)}
    {posted&&<p>Your opening balances are recorded. Changes require a fresh complete proposal and confirmation.</p>}
    {ask&&<p>{ask.question}</p>}
    {proposal&&<>
      <table><thead><tr><th>Account</th><th>Debit · AED</th><th>Credit · AED</th></tr></thead><tbody>
        {proposal.openingLines.map((line,i)=><tr key={i}><td>{line.account.name}</td><td>{line.debit.toFixed(2)}</td><td>{line.credit.toFixed(2)}</td></tr>)}
      </tbody></table>
      <p>Source closing date: {proposal.source_as_of}. Opening date: {proposal.as_of}.</p>
      <button type="button" disabled={busy} onClick={()=>act({action:'confirm',ask_id:ask.id,proposal_digest:saved.proposal_digest})}>Confirm complete balances and post</button>
    </>}
    {ask&&<button type="button" disabled={busy} onClick={()=>act({action:'cancel',ask_id:ask.id})}>Cancel this proposal</button>}
    <details><summary>Set up an accounting account</summary>
      <p>Choose the account role explicitly. Use an existing account when its role is already present.</p>
      <form onSubmit={e=>{e.preventDefault();act({action:'setup_account',intake:{as_of:draft.as_of,account:{account_id:existingAccount,currency:'AED'}}});}}>
        <label>Existing account<select required value={existingAccount} onChange={e=>setExistingAccount(e.target.value)}><option value="">Choose account to confirm in AED</option>{state.accounts.filter(a=>state.supported_roles.includes(a.canonical_role)).map(a=><option key={a.id} value={a.id}>{a.name} · {a.currency||'Denomination unconfirmed'}</option>)}</select></label>
        <button disabled={busy||!draft.as_of}>Confirm this account is denominated in AED</button>
      </form>
      <form onSubmit={e=>{e.preventDefault();act({action:'setup_account',intake:{as_of:draft.as_of,account}});}}>
        <label>Role<select required value={account.canonical_role} onChange={e=>setAccount(a=>({...a,canonical_role:e.target.value}))}><option value="">Choose role</option>{state.supported_roles.filter(role=>!state.accounts.some(a=>a.canonical_role===role)).map(role=><option key={role} value={role}>{state.role_labels[role]}</option>)}</select></label>
        <label>Account code<input required maxLength={30} pattern="[A-Za-z0-9_-]+" value={account.code} onChange={e=>setAccount(a=>({...a,code:e.target.value}))}/></label>
        <label>Account name<input required maxLength={120} value={account.name} onChange={e=>setAccount(a=>({...a,name:e.target.value}))}/></label>
        <button disabled={busy||!draft.as_of}>Add account for selected opening period</button>
      </form>
    </details>
    <form onSubmit={e=>{e.preventDefault();act({action:'submit',intake:draft});}}>
      <label>Opening date<select required value={draft.as_of} onChange={e=>setDraft(d=>({...d,as_of:e.target.value}))}><option value="">Choose a recorded open period</option>{periods.filter(p=>p.status==='open').map(p=><option key={p.id} value={String(p.starts_on).slice(0,10)}>{String(p.starts_on).slice(0,10)} – {String(p.ends_on).slice(0,10)}</option>)}</select></label>
      <label>Source closing date<input required type="date" value={draft.source_as_of} onChange={e=>setDraft(d=>({...d,source_as_of:e.target.value}))}/></label>
      <label>Trial-balance currency<select required value={draft.currency} onChange={e=>setDraft(d=>({...d,currency:e.target.value}))}><option value="">Confirm denomination</option><option value="AED">AED</option></select></label>
      <label>Uploaded source trial balance<select required value={draft.source_document_id} onChange={e=>setDraft(d=>({...d,source_document_id:e.target.value}))}><option value="">Choose source document</option>{state.sources.map(s=><option key={s.id} value={s.id}>{s.filename} · {s.currency||'Currency unconfirmed'}</option>)}</select></label>
      {draft.declared_lines.map((line,index)=><fieldset key={index}><legend>Balance {index+1}</legend>
        <label>Account<select required value={line.account_id} onChange={e=>updateLine(index,'account_id',e.target.value)}><option value="">Choose account</option>{state.accounts.map(a=><option key={a.id} value={a.id}>{a.code?`${a.code} · `:''}{a.name}</option>)}</select></label>
        <label>Debit<input required inputMode="decimal" value={line.debit} onChange={e=>updateLine(index,'debit',e.target.value)}/></label>
        <label>Credit<input required inputMode="decimal" value={line.credit} onChange={e=>updateLine(index,'credit',e.target.value)}/></label>
        <button type="button" disabled={busy||draft.declared_lines.length<2} onClick={()=>setDraft(d=>({...d,declared_lines:d.declared_lines.filter((_,i)=>i!==index)}))}>Remove balance</button>
      </fieldset>)}
      <button type="button" disabled={busy} onClick={()=>setDraft(d=>({...d,declared_lines:[...d.declared_lines,{account_id:'',debit:'0',credit:'0'}]}))}>Add balance</button>
      <label><input type="checkbox" checked={draft.complete} onChange={e=>setDraft(d=>({...d,complete:e.target.checked}))}/>This is the complete trial balance, including all assets, liabilities and equity.</label>
      <button disabled={busy} type="submit">Review complete trial balance</button>
    </form>
    {error&&<p role="alert">{error}</p>}
  </section>;
}
