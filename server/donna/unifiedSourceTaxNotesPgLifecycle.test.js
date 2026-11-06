import test from 'node:test';
import assert from 'node:assert/strict';
import {readdir,readFile} from 'node:fs/promises';
import pg from 'pg';
import {extractUnified,UNIFIED_EXTRACTOR_PROMPT_VERSION} from './unifiedExtractor.js';
import {__writeParsedDocumentExtractionWithClient} from './parseDocumentsDb.js';
import {readJevCase,jevCasePrompt} from './jevPreview.js';

const salesNote='Bruttomyynti sisältää 25,5 %:n arvonlisäveron (kampaamopalvelut ja tuotemyynti).';
const feeNote='Maksunvälityksen palvelumaksu 1,10 % on arvonlisäveroton rahoituspalvelu (AVL 41 §) — palvelumaksusta ei voi tehdä ALV-vähennystä.';

test('real PG: explicit settlement tax clauses survive extraction, the named parse writer, rows and shared case', {skip:!process.env.DONNA_PG_TEST_URL}, async t=>{
 const admin=new pg.Client({connectionString:process.env.DONNA_PG_TEST_URL});await admin.connect();
 const name=`source_tax_notes_${process.pid}_${Date.now()}`;await admin.query(`create database "${name}"`);
 const url=new URL(process.env.DONNA_PG_TEST_URL);url.pathname=`/${name}`;
 const db=new pg.Client({connectionString:url.toString()});await db.connect();
 t.after(async()=>{await db.end();await admin.query(`drop database "${name}"`);await admin.end();});
 await db.query(`create schema storage;create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);create table storage.objects(id uuid default gen_random_uuid() primary key,bucket_id text references storage.buckets(id),name text,metadata jsonb);`);
 const migrations=new URL('../../db/migrations/',import.meta.url);
 for(const f of (await readdir(migrations)).filter(f=>f.endsWith('.sql')).sort())await db.query(await readFile(new URL(f,migrations),'utf8'));
 await db.query(`insert into firms(id,name,slug) values('f','Synthetic firm','source-tax-notes');
 insert into clients(id,firm_id,company_name,jurisdiction,profile) values('c','f','Synthetic merchant','fi','{}');
 insert into documents(id,firm_id,client_id,filename,document_type,parse_status,parse_run_id,payload)
 values('report','f','c','processor.pdf','payout_statement','processing','00000000-0000-4000-8000-000000000001','{}');
 insert into transactions(id,firm_id,client_id,transaction_date,description,money_in,money_out,currency,status,payload)
 values('payout','f','c','2025-02-03','Processor payout',2452.72,0,'EUR','needs_review','{}');`);
 const recording=JSON.parse(await readFile(new URL('./fixtures/recordings/unified_extraction/paylink-PO-88121.json',import.meta.url),'utf8'));
 const raw=JSON.parse(recording.body.content.find(c=>c.type==='text').text);
 Object.assign(raw,{warnings:[`source_tax: ${salesNote}`,`source_tax: ${feeNote}`],lines:[]});
 Object.assign(raw.header,{counterparty_name:'Synthetic processor',own_name:'Synthetic merchant',currency:'EUR',document_date:'2025-02-28',total_amount:2452.72,tax_amount:null,references:[]});
 Object.assign(raw.settlement,{period_start:'2025-01-27',period_end:'2025-02-28',payout_date:null,payout_reference:null,transaction_count:112,gross_sales:2480,gross_components:[],refunds:0,fees:[{description:'Service fee',amount:27.28,tax_amount:0}],adjustments:[],net_payout:2452.72,
  rows:[{period_label:'Week 5',period_start:'2025-01-27',period_end:'2025-02-02',paid_on:'2025-02-03',gross:2480,fee:27.28,fee_tax:0,net:2452.72,transaction_count:112,reference:null}]});
 let calls=0;
 const extracted=await extractUnified({base64:Buffer.from('%PDF synthetic transport fixture').toString('base64'),filename:'processor.pdf',documentId:'report',documentType:'payout_statement',env:{ANTHROPIC_API_KEY:'fixture'},fetchImpl:async(url,init)=>{
  calls++;const request=JSON.parse(init.body);
  assert.match(request.system,/SOURCE TAX NOTES/);assert.match(request.system,/demand charge, permit surcharge/);
  assert.match(request.system,/net rows are not tax bases/);
  return {ok:true,status:200,json:async()=>({id:'fixture',model:'fixture-extractor',content:[{type:'text',text:JSON.stringify(raw)}],usage:{input_tokens:1,output_tokens:1}})};
 }});
 assert.equal(calls,1);assert.equal(extracted.kind,'completed_header',JSON.stringify(extracted));
 assert.equal(extracted.prompt_version,UNIFIED_EXTRACTOR_PROMPT_VERSION);
 const notes=[`model:source_tax: ${salesNote}`,`model:source_tax: ${feeNote}`];
 assert.deepEqual(extracted.summary.warnings,notes);
 assert.equal(extracted.header.tax_amount,null,'a rate note does not invent a document tax amount');
 assert.equal(extracted.lines[0].tax_rate,null,'a net settlement row is not assigned the gross sales rate');
 const written=await __writeParsedDocumentExtractionWithClient({client:db,firmId:'f',documentId:'report',parseRunId:'00000000-0000-4000-8000-000000000001',header:extracted.header,summary:extracted.summary,lines:extracted.lines,documentType:'payout_statement'});
 assert.equal(written.handled,true,JSON.stringify(written));
 const source=(await db.query("select parse_summary from documents where id='report'")).rows[0];
 assert.deepEqual(source.parse_summary.warnings,notes);
 const lines=(await db.query("select id,amount,payload from document_lines where document_id='report'")).rows;
 assert.equal(lines.length,1);assert.equal(Number(lines[0].amount),2452.72);
 assert.deepEqual([lines[0].payload.raw_extraction.settlement_row.gross,lines[0].payload.raw_extraction.settlement_row.fee],[2480,27.28]);
 await db.query(`insert into reconciliation_matches(id,firm_id,client_id,bank_transaction_id,matched_object_type,matched_object_id,matched_line_id,status,match_amount,match_confidence)
 values('matched-row','f','c','payout','payout_statement','report',$1,'auto_matched',2452.72,1)`,[lines[0].id]);
 const current=await readJevCase({client:db,firmId:'f',clientId:'c',transactionId:'payout',evidenceOnly:true});
 assert.deepEqual(current.matchedDocument.parse_summary.warnings,notes);
 const input=JSON.stringify(jevCasePrompt(current.caseEvidence));
 assert.ok(input.includes(salesNote));assert.ok(input.includes(feeNote));
 assert.equal(current.matchedDocument.matched_line.settlement_row.fee_tax,0);
 await db.query(`update reconciliation_matches set payload=$1 where id='matched-row'`,[{consumed_evidence:current.caseEvidence,authorization:{reasoning:'An earlier model conclusion'}}]);
 const operational=await readJevCase({client:db,firmId:'f',clientId:'c',transactionId:'payout',evidenceOnly:true,lockEvidence:true});
 assert.equal(operational.caseEvidence.packet_sha256,current.caseEvidence.packet_sha256,'operational receipt growth is neither fresh source evidence nor model input');
 await db.query(`update reconciliation_matches set payload=payload || $1::jsonb where id='matched-row'`,[JSON.stringify({settlement_row:{line_id:lines[0].id,line_no:1,net:2452.72}})]);
 const related=await readJevCase({client:db,firmId:'f',clientId:'c',transactionId:'payout',evidenceOnly:true,lockEvidence:true});
 assert.notEqual(related.caseEvidence.packet_sha256,current.caseEvidence.packet_sha256,'a changed source relationship still invalidates earlier authority');
 assert.equal(jevCasePrompt(related.caseEvidence).matches[0].payload.settlement_row.line_id,'document_1_line_1');
});
