import test from 'node:test';
import assert from 'node:assert/strict';
import {compactJevPromptTables,compactJevRefundGroups} from './jevPromptTables.js';
import {buildJevCodingRequest,decideJevCoding} from './jevCoding.js';
const expand=value=>{
  if(Array.isArray(value))return value.map(expand);
  if(!value || typeof value!=='object')return value;
  if(value.$table===true)return value.rows.map(row=>({...Object.fromEntries(value.columns.map((key,i)=>[key,expand(row[i])])),...expand(row.at(-1))}));
  return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,expand(v)]));
};
const records=Array.from({length:36},(_,i)=>({id:`candidate_${i+1}`,transaction_date:'2025-02-14',description:`Complete source description ${i}`,money_in:i===4?19.9:0,money_out:i===4?0:19.9,currency:'EUR',...(i===8?{structured_reference:'actual reference',optional:null}:{}),...(i===9?{business_use:false}: {})}));
test('nested evidence tables round-trip every source value, absent/null/false/zero, identity and ordering',()=>{
 const source={transactions:records,documents:Array.from({length:8},(_,i)=>({id:`document_${i+1}`,filename:`source-${i}.pdf`,lines:records,parse_summary:{warnings:['Exact original source text.']}}))};
 const original=structuredClone(source),encoded=compactJevPromptTables(source);
 assert.deepEqual(expand(encoded),source);assert.deepEqual(source,original);
 assert.ok(JSON.stringify(encoded).length<JSON.stringify(source).length*0.7);
 assert.equal(encoded.transactions.$table,true);
});
test('shared refund receipts preserve all members and conflicting receipts independently',()=>{
 const group={amount:19.9,transaction_ids:['candidate_1','candidate_2','candidate_3'],allocation_basis:'chronological_convention_without_instrument_identity',source:{components:[{source_tax:2.01,description:'Actual item'}]}};
 const source={transaction:{jev_refund_group:group,case_evidence:{transactions:[{id:'candidate_1',refund_group:group},{id:'candidate_2',refund_group:group},{id:'candidate_3',refund_group:{...group,amount:20}}]}}};
 const result=compactJevRefundGroups(source);
 assert.deepEqual(result.prompt_refund_groups.refund_group_1,group);
 assert.equal(result.prompt_refund_groups.refund_group_2.amount,20);
 assert.equal(result.transaction.case_evidence.transactions[1].refund_group.refund_group_ref,'refund_group_1');
 assert.deepEqual(source.transaction.jev_refund_group,group);
});
test('actual coding provider receives a reversible complete table while trusted decision coverage remains complete',async()=>{
 const full={document_type:'supplier_bill',total_amount:180,currency:'EUR',parse_summary:{line_amounts_include_tax:true},lines:Array.from({length:9},(_,i)=>({id:`source_${i}`,description:`Source item ${i}`,amount:20,tax_rate:0}))};
 const input={transaction:{id:'candidate_1',matched_document:full,case_evidence:{focal:{id:'candidate_1'},documents:[{...full,id:'document_1'}],transactions:records,matches:[{bank_transaction_id:'candidate_1',matched_object_id:'document_1',status:'confirmed'}]}}};
 const built=buildJevCodingRequest({input,accountOptions:['Supplies'],taxOptions:['No tax'],instructions:'Complete policy'});
 assert.deepEqual(expand(built.request.state).transaction.case_evidence.transactions,records);
 assert.equal(built.request.state.transaction.case_evidence.transactions.$table,true);
 let calls=0;
 const result=await decideJevCoding({input,transaction:input.transaction,accountOptions:['Supplies'],taxOptions:['No tax'],instructions:'Complete policy',provider:async request=>{
  calls++;
  assert.deepEqual(expand(request.state).transaction.case_evidence.transactions,records);
  if(calls>1)assert.equal(expand(request.state).source_components.length,9);
  return {model:'test',usage:{input_tokens:1,output_tokens:1},answers:Object.fromEntries(Object.entries(request.questions).map(([k,q])=>{
   const choice=k==='decision'?'document_allocation':k==='materiality'?'normal':Object.keys(q.criteria)[0];
   return[k,{choice,probability:1,probabilities:{[choice]:1}}];
  }))};
 }});
 assert.equal(calls,3);assert.equal(result.suggestion.document_allocations.length,9);
 assert.equal(result.receipt.coverage.complete,true);assert.deepEqual(input.transaction.matched_document,full);
});

test('call-local focal handle selects the refund convention even when provider transaction intentionally has no opaque id',()=>{
 const input={transaction:{case_evidence:{focal:{id:'candidate_2'},transactions:[{id:'candidate_2',refund_group:{transaction_ids:['candidate_1','candidate_2','candidate_3']}}]}}};
 const built=buildJevCodingRequest({input,accountOptions:['Supplies'],taxOptions:['No tax'],instructions:'Complete policy'});
 assert.match(built.request.state.accounting_policy,/netting to ONE purchase/);
 assert.match(built.request.state.accounting_policy,/including the incoming refund/);
});

test('nested record schemas round-trip complete large cases through the actual coding request',async()=>{
 const {compactJevPromptRecords}=await import('./jevPromptTables.js');
 const decode=(value,schemas)=>{
  if(!value||typeof value!=='object')return value;
  if(Array.isArray(value))return value.map(v=>decode(v,schemas));
  if(value.$record)return Object.fromEntries(schemas[value.$record].map((key,i)=>[key,decode(value.values[i],schemas)]));
  return Object.fromEntries(Object.entries(value).filter(([key])=>key!=='prompt_records').map(([key,v])=>[key,decode(v,schemas)]));
 };
 const documents=Array.from({length:36},(_,i)=>({id:`document_${i+1}`,filename:`source-${i}.pdf`,parse_summary:{
  full_source_annotation:`Exact source annotation ${i}. `+'Source detail. '.repeat(120),
  nullable_source_field:null,explicitly_false_source_field:false,zero_source_amount:0,
  original_source_array:[{source_description:'First',source_amount:1,source_flag:false},{source_description:'Second',source_amount:2,source_flag:null}]
 }}));
 const input={transaction:{case_evidence:{documents,transactions:records,matches:[],focal:{id:'candidate_1'}}}};
 const original=structuredClone(input),compact=compactJevPromptRecords(compactJevPromptTables(input));
 assert.deepEqual(expand(decode(compact,compact.prompt_records)),input);
 assert.deepEqual(input,original);
 const optional={records:Array.from({length:12},(_,i)=>({long_optional_source_description:i===0?undefined:'Retained',long_source_zero:0,long_source_false:false,long_source_null:null}))};
 const wire=JSON.parse(JSON.stringify(compactJevPromptRecords(optional)));
 assert.deepEqual(decode(wire,wire.prompt_records),JSON.parse(JSON.stringify(optional)),'JSON serialization cannot turn an absent source field into explicit null');
 const built=buildJevCodingRequest({input,accountOptions:['Supplies'],taxOptions:['No tax'],instructions:'Complete policy'});
 assert.ok(built.request.state.prompt_records,'actual large coding requests use the reversible schema representation');
 assert.deepEqual(expand(decode(built.request.state,built.request.state.prompt_records)).transaction,input.transaction);
 assert.deepEqual(compactJevPromptRecords({source:{$record:'literal_source_field'},documents}),{source:{$record:'literal_source_field'},documents},'literal reserved source fields are not reinterpreted');
});
