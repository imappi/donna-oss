// Execute the portal's actual upload closures without rendering its unrelated
// dashboard. Browser compression and HTTP are explicit adapter seams; the
// batch, metadata, tray lifecycle and all-files send guard are source code.
import {readFile} from 'node:fs/promises';
import {parse} from '@babel/parser';
import * as documents from '../../../src/lib/firmDocuments.js';
import * as tray from '../../../src/lib/uploadTray.js';
import * as reply from '../../../src/lib/evidenceReply.js';
import {getBookSessionIdentity} from '../../../src/lib/bookSessionIdentity.js';
import * as concurrency from '../../../src/lib/uploadConcurrency.js';

export const portalUploadSession = async ({clientId,uploadEvidenceObject,registerFirmDocuments,resolveClientEvidenceRequest,setDocuments=()=>{}}) => {
  const source=await readFile(new URL('../../../src/components/donna-client-portal.jsx',import.meta.url),'utf8');
  const wanted=new Set(['documentTypeForQuestion','buildEvidenceDocument','assertUploadBatchSize','persistEvidenceFiles','submitReply']);
  const functions=new Map();
  const visit=node=>{
    if(!node || typeof node!=='object')return;
    if(node.type==='VariableDeclarator' && wanted.has(node.id?.name)) functions.set(node.id.name,source.slice(node.init.start,node.init.end));
    for(const value of Object.values(node))if(Array.isArray(value))value.forEach(visit);else if(value && typeof value==='object')visit(value);
  };
  visit(parse(source,{sourceType:'module',plugins:['jsx']}));
  if(functions.size!==wanted.size)throw new Error('Portal upload consumer changed; update the integration harness explicitly.');
  const scope={...documents,...tray,...reply,...concurrency,getBookSessionIdentity,registeredEvidenceRef:{current:new WeakMap()},
    selectedClient:{id:clientId},previewMode:false,firmDataSource:'database',
    intl:{formatMessage:({id})=>id},message:id=>id,setDocuments,
    MAX_EVIDENCE_FILE_BYTES:6*1024*1024,MAX_EVIDENCE_UPLOAD_BYTES:7*1024*1024,
    formatFileSize:size=>String(size),compressImageFile:async file=>({base64:file.base64,mimeType:file.type}),
    uploadEvidenceObject,registerFirmDocuments,resolveClientEvidenceRequest,
    replyBusyById:{},setReplyBusyById:()=>{},setReplyErrorById:()=>{},setExpandedKey:()=>{},setExpandedSubKey:()=>{}};
  const declarations=[...wanted].map(name=>`const ${name} = ${functions.get(name)};`).join('\n');
  return Function(...Object.keys(scope),`${declarations}\nreturn {persistEvidenceFiles,submitReply};`)(...Object.values(scope));
};
