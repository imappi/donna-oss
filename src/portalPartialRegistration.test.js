import test from 'node:test';
import assert from 'node:assert/strict';
import { portalUploadSession } from '../server/donna/testSupport/portalUploadSession.js';
import * as tray from './lib/uploadTray.js';

test('actual owner upload handler clears only explicitly unusable intents, preserves committed siblings, and blocks incomplete replies',async()=>{
  const before=globalThis.window,storage=new Map();
  globalThis.window={location:{pathname:'/client/synthetic'},localStorage:{getItem:key=>storage.get(key)||null,setItem:(key,value)=>storage.set(key,String(value)),removeItem:key=>storage.delete(key)}};
  try {
    let uploads=0,attempt=0;const sent=[];let visible=[];
    const files=['first.pdf','second.pdf'].map(name=>({name,type:'application/pdf',size:1,base64:'YQ=='}));
    const canonical=doc=>({id:'canonical-'+doc.filename,client_id:doc.client_id,storage_bucket:doc.storage_bucket,storage_object_key:doc.storage_object_key,parse_status:'pending'});
    const session=await portalUploadSession({clientId:'client-a',setDocuments:update=>{visible=update(visible);},
      uploadEvidenceObject:async()=>({provider:'supabase_storage',bucket:'private',key:'key-'+(++uploads),checksum_sha256:'a'.repeat(64),size:1,content_type:'application/pdf'}),
      registerFirmDocuments:async({documents})=>{
        if(attempt++===0)throw Object.assign(new Error('Runtime readiness changed. Retry the upload.'),{code:'PILOT_UPLOAD_GENERATION_CHANGED',body:{partial_results:[{document:canonical(documents[0])}]}});
        return {documents:documents.map(canonical)};
      },resolveClientEvidenceRequest:async request=>{sent.push(request);return {};}});
    const question={id:'q',evidence_request_id:'q',text:'Provide both files.'};
    await session.submitReply({files,question,reply:'Both attached.'});
    assert.equal(sent.length,0);assert.equal(visible.length,1);
    const first=tray.loadTrayState().batches[0].rows;
    assert.equal(first[0].document_id,'canonical-first.pdf');assert.equal(first[0].register_warning,null);
    assert.equal(first[1].register_error_code,'PILOT_UPLOAD_GENERATION_CHANGED');
    assert.equal(tray.canRetryRegistration(first[1]),false);
    await session.submitReply({files,question,reply:'Retried after readiness recovered.'});
    assert.equal(uploads,3,'committed sibling retains its key; only unusable intent gets a new authorized PUT');
    assert.equal(sent.length,1);assert.equal(sent[0].documentIds.length,2);assert.equal(visible.length,2);
  } finally {if(before===undefined)delete globalThis.window;else globalThis.window=before;}
});

test('untrusted partial result identity never promotes an unrelated document into the owner tray',async()=>{
  const before=globalThis.window,storage=new Map();
  globalThis.window={location:{pathname:'/client/synthetic'},localStorage:{getItem:key=>storage.get(key)||null,setItem:(key,value)=>storage.set(key,String(value)),removeItem:key=>storage.delete(key)}};
  try {
    let visible=[];const session=await portalUploadSession({clientId:'client-a',setDocuments:update=>{visible=update(visible);},
      uploadEvidenceObject:async()=>({provider:'supabase_storage',bucket:'private',key:'key',checksum_sha256:'a'.repeat(64),size:1,content_type:'application/pdf'}),
      registerFirmDocuments:async()=>{throw Object.assign(new Error('Timeout'),{body:{partial_results:[{document:{id:'unrelated',client_id:'client-b',storage_bucket:'private',storage_object_key:'key'}}]}});},resolveClientEvidenceRequest:async()=>assert.fail('no send')});
    await assert.rejects(session.persistEvidenceFiles({files:[{name:'a.pdf',type:'application/pdf',size:1,base64:'YQ=='}]}));
    assert.equal(visible.length,0);assert.equal(tray.loadTrayState().batches[0].rows[0].document_id,null);
  } finally {if(before===undefined)delete globalThis.window;else globalThis.window=before;}
});
