import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { portalUploadSession } from './portalUploadSession.js';
import * as tray from '../../../src/lib/uploadTray.js';
import { registerFirmDocuments } from '../../../src/lib/firmApi.js';

// Only auth/provider platform and private storage are fixture services. The
// browser upload closures, HTTP router, admission and registration writer are real.
export const provePartialUploadHttpRecovery = async ({ pool, clientId, firmId, createUpload, originalFetch, pause }) => {
  const { default: router } = await import('../../../api/donna-router.js');
  const server = createServer(router); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const wire = globalThis.fetch, previousWindow = globalThis.window;
  const saved = Object.fromEntries(['SUPABASE_PUBLISHABLE_KEY','DONNA_ACCESS_TOKEN','DONNA_AUTH_ALLOWED_EMAILS'].map(key => [key, process.env[key]]));
  Object.assign(process.env, { SUPABASE_PUBLISHABLE_KEY:'fixture-public', DONNA_ACCESS_TOKEN:'fixture-not-owner', DONNA_AUTH_ALLOWED_EMAILS:'' });
  const storage = new Map([['donna.auth_session.v1', JSON.stringify({access_token:'partial-owner',user:{id:'probe-owner'}})]]);
  globalThis.window = {location:{pathname:'/client/synthetic'},localStorage:{getItem:key=>storage.get(key)||null,setItem:(key,value)=>storage.set(key,String(value)),removeItem:key=>storage.delete(key)}};
  globalThis.fetch = (address, init) => {
    if (String(address).startsWith('/api/donna/firms/')) return originalFetch(`http://127.0.0.1:${server.address().port}/api/donna-router?path=firm${String(address).slice('/api/donna/firm'.length)}`,init);
    if (String(address)==='https://storage.invalid/auth/v1/user') return Promise.resolve(new Response(JSON.stringify({id:'probe-owner',email:'owner@fixture.invalid'})));
    return wire(address,init);
  };
  let release;
  try {
    const ownerId = (await pool.query("select id from firm_collaborators where user_id='probe-owner'")).rows[0].id;
    const principal = {principalType:'firm_collaborator',principalId:ownerId};
    const files = Array.from({length:10},(_,index)=>{const name=`partial-${index}.pdf`;return {name,type:'application/pdf',size:Buffer.byteLength(name),base64:Buffer.from(name).toString('base64')};});
    let uploads=0, failure; const sent=[]; let visibleDocuments=[];
    const session=await portalUploadSession({clientId,resolveClientEvidenceRequest:async value=>{sent.push(value);return {};},
      setDocuments:update=>{visibleDocuments=update(visibleDocuments);},
      registerFirmDocuments:async options=>{try{return await registerFirmDocuments(options);}catch(error){failure=error;throw error;}},
      uploadEvidenceObject:async({filename,base64,mimeType})=>{
        const bytes=Buffer.from(base64,'base64'), checksum=createHash('sha256').update(bytes).digest('hex'); uploads+=1;
        const signed=await createUpload({firmId,clientId,principal,bucket:'donna-evidence',filename,checksum,size:bytes.length,mimeType});
        assert.equal((await originalFetch(signed.signed_url,{method:'PUT',body:bytes})).status,200);
        if(filename==='partial-2.pdf') pause({key:signed.key,started:()=>{},wait:new Promise(resolve=>{release=resolve;})});
        return {provider:'supabase_storage',bucket:signed.bucket,key:signed.key,checksum_sha256:checksum,size:bytes.length,content_type:mimeType};
      }});
    const question={id:'partial-question',evidence_request_id:'partial-question',text:'Please attach the complete set.'};
    await session.submitReply({files,question,reply:'Here is the full set.'});
    assert.equal(sent.length,0,'actual reply handler must not send after a partial registration');
    assert.equal(failure?.code,'PILOT_UPLOAD_VERIFICATION_TIMEOUT'); assert.equal(failure?.status,503);
    assert.equal(failure.body.partial_results.length,2,'actual HTTP response preserves committed prefix');
    assert.equal(visibleDocuments.length,2,'received-file inventory uses only persisted canonical documents');
    const rows=tray.loadTrayState().batches[0].rows;
    assert.equal(rows.filter(row=>row.document_id).length,2,'portal immediately renders only the committed prefix as registered');
    assert.ok(rows.slice(0,2).every(row=>!row.register_warning));
    assert.ok(rows.slice(2).every(row=>row.register_warning&&!row.document_id));
    assert.equal((await pool.query("select count(*)::int n from documents where filename like 'partial-%'")).rows[0].n,2);
    const keys=rows.map(row=>row.storage_object_key);
    release(); pause(null);
    // A same-page retry of the actual owner handler reuses all ten PUT intents.
    // It never creates fresh storage objects, including the unregistered eight.
    const completed=await session.persistEvidenceFiles({files,question});
    assert.equal(uploads,10); assert.equal(completed.length,10); assert.equal(new Set(completed.map(doc=>doc.id)).size,10);
    assert.deepEqual(tray.loadTrayState().batches[0].rows.map(row=>row.storage_object_key),keys);
    await session.persistEvidenceFiles({files,question}); assert.equal(uploads,10);
    const counts=(await pool.query(`select count(*)::int documents,count(distinct parse_run_id)::int runs from documents where filename like 'partial-%'`)).rows[0];
    assert.deepEqual(counts,{documents:10,runs:10});
    const queued=(await pool.query("select resource_id,count(*)::int n from audit_events where action='document.parse.queued' and resource_id in (select id from documents where filename like 'partial-%') group by resource_id")).rows;
    assert.equal(queued.length,10); assert.ok(queued.every(row=>row.n===1));
    assert.equal((await pool.query('select count(*)::int n from ledger_journals')).rows[0].n,0);
    assert.equal(sent.length,0,'registration recovery never sends an owner reply');
  } finally {
    release?.(); pause(null); globalThis.fetch=wire;
    if(previousWindow===undefined)delete globalThis.window;else globalThis.window=previousWindow;
    for(const [key,value] of Object.entries(saved))if(value===undefined)delete process.env[key];else process.env[key]=value;
    server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
  }
};
