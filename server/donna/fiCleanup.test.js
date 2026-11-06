import test from 'node:test';
import assert from 'node:assert/strict';
import { suggestTransactionCodingBatch, assertRefundGroupPolicyWindow } from './transactionLlm.js';
import { requireCodingPolicyForClient, assertCodingPolicyReceipt, isCodingPolicyError } from './codingPolicy.js';
import { runCodingConvergence } from './codingConvergence.js';
import { codingEvidenceDigest } from './db/codingEvidence.js';
import { codingCaseRevision } from './jevPreview.js';
import { hash } from './jevEvidenceContract.js';
import { decideJevCoding } from './jevCoding.js';
import { allocationAccountClassConflict } from './documentAllocationComponents.js';

const profile = { jurisdiction: 'fi', entityType: 'fi-oy', companyName: 'Synthetic Finnish salon Oy' };
test('FI: a cross-window refund is a group refusal, not a runtime policy incident', () => {
  const policy = requireCodingPolicyForClient(profile,{businessDate:'2025-02-14'});
  const group = {transaction_ids:['purchase','duplicate','refund'],source_digest:'source'};
  assert.doesNotThrow(()=>assertRefundGroupPolicyWindow(group,[policy,policy,policy]));
  assert.throws(()=>assertRefundGroupPolicyWindow(group,[policy,policy,{...policy,effectiveFrom:'2025-02-15'}]),error=>{
    assert.equal(error.code,'REFUND_GROUP_POLICY_WINDOW_UNSUPPORTED');
    assert.equal(isCodingPolicyError(error),false);
    assert.deepEqual(error.details.transaction_ids,group.transaction_ids);
    return true;
  });
});

test('FI: an isolated policy refusal does not suppress ask production for successful units', async () => {
  const requests=[];
  const result=await runCodingConvergence({firmId:'fi',env:{},asOf:Date.parse('2026-09-21T12:00:00Z'),
    discoverCoderClientsFn:async()=>[{client_id:'salon',unseen_lines:4}],
    batchSuggestFn:async()=>({transaction_ai_batch:{summaries:[{client_id:'salon',scanned:4,suggested:1,
      policy_failure:true,policy_failures:[{transaction_ids:['purchase','duplicate','refund'],code:'coding_policy_receipt_conflict'}]}]}}),
    requestAskDraftFn:async request=>{requests.push(request);return {enqueued:1};},
    releaseWaitingFn:async()=>[],recoverAskDraftFn:async()=>[],discoverSweepClientsFn:async()=>[],discoverLedgerPostClientsFn:async()=>[]});
  assert.equal(result.errors,1);assert.equal(result.coder[0].suggested,1);
  assert.equal(requests.length,1);assert.equal(requests[0].clientId,'salon');
  assert.equal(result.coder[0].ask_draft.enqueued,1);
});

test('FI: unresolved duplicate/refund members retain their own dated policy authority', async t => {
  const saved = { TYPESAFE_API_KEY: process.env.TYPESAFE_API_KEY, TYPESAFE_MODEL: process.env.TYPESAFE_MODEL };
  Object.assign(process.env, { TYPESAFE_API_KEY: 'fixture', TYPESAFE_MODEL: 'fixture' });
  t.after(() => { for (const [k,v] of Object.entries(saved)) if (v == null) delete process.env[k]; else process.env[k] = v; });
  const group = { status: 'selected', source_digest: 'fi-source', transaction_ids: ['purchase','duplicate','refund'], purchase_transaction_id: 'purchase' };
  const transactions = group.transaction_ids.map(id => ({ id, date: id === 'refund' ? '2025-02-17' : '2025-02-14',
    description: 'Cleaning supplies', money_out: id === 'refund' ? 0 : 19.90, money_in: id === 'refund' ? 19.90 : 0,
    account_currency: 'EUR', jev_refund_group: group }));
  const fetchImpl = async (_url, init) => {
    const request = JSON.parse(init.body);
    const answers = Object.fromEntries(Object.entries(request.questions).map(([key,q]) => {
      const choices = Object.keys(q.criteria), choice = key === 'decision' ? 'ask_business_use' : key === 'materiality' ? 'normal' : choices[0];
      assert.ok(choices.includes(choice));
      return [key,{ type:'choice', choice, confidence:.8, probabilities:Object.fromEntries(choices.map(k=>[k,k===choice?.8:.2/(choices.length-1)])) }];
    }));
    return new Response(JSON.stringify({ model:'fixture', answers, usage:{input_tokens:1,output_tokens:1} }), { status:200 });
  };
  const result = await suggestTransactionCodingBatch({ clientProfile:profile, transactions, jevEnabled:true, fetchImpl });
  assert.equal(result.suggestions.length, 3);
  for (const suggestion of result.suggestions) {
    const tx = transactions.find(tx => tx.id === suggestion.transaction_id);
    assert.equal(suggestion.evidence_required, true);
    assert.doesNotThrow(() => assertCodingPolicyReceipt(requireCodingPolicyForClient(profile,{businessDate:tx.date}),suggestion.coding_policy));
  }
  assert.throws(() => assertCodingPolicyReceipt(requireCodingPolicyForClient(profile,{businessDate:'2025-02-17'}),result.suggestions[0].coding_policy), /policy/i);
});

test('FI: routing metadata preserves old source digests, while real source changes invalidate them', () => {
  const original = { document_id:'source', document_type:'receipt', total_amount:22, parse_summary:null,
    lines:[{id:'line',description:'Groceries',amount:22}] };
  assert.equal(codingEvidenceDigest({...original,source_family:'receipt'}),hash({...original,matched_at:undefined}));
  assert.notEqual(codingEvidenceDigest(original),codingEvidenceDigest({...original,total_amount:23}));
  assert.notEqual(codingEvidenceDigest(original),codingEvidenceDigest({...original,lines:[{...original.lines[0],description:'New source fact'}]}));
  const evidence = {company:{jurisdiction:'fi'},focal:{id:'tx'},transactions:[{id:'tx'}],
    documents:[{...original,id:'source'}],matches:[{bank_transaction_id:'tx',matched_object_id:'source'}],
    owner_replies:[],obligations:[],coverage:{status:'complete',unread_sources:[]}};
  assert.equal(codingCaseRevision(evidence),codingCaseRevision({...evidence,documents:[{...evidence.documents[0],source_family:'receipt'}]}));
  assert.notEqual(codingCaseRevision(evidence),codingCaseRevision({...evidence,documents:[{...evidence.documents[0],total_amount:23}]}));
});

test('FI: purchase receipt component menu and writer constraint reject sales, preserving refunds and sales', async () => {
  const transaction = { money_out:22, money_in:0, matched_document:{document_type:'receipt',total_amount:22,tax_amount:2,
    lines:[{id:'a',amount:11,tax_rate:10},{id:'b',amount:11,tax_rate:10}]} };
  let calls=0;
  await decideJevCoding({input:{client:{jurisdiction:'fi'},transaction},transaction,accountOptions:['Operating supplies','Sales'],
    taxOptions:['ALV 10 %'],instructions:'Use source facts.',provider:async request => {
      calls++;
      for(const [key,q] of Object.entries(request.questions)) if(key.endsWith('_account')) assert.deepEqual(Object.values(q.criteria),['Operating supplies']);
      return {model:'fixture',usage:{},answers:Object.fromEntries(Object.entries(request.questions).map(([key,q])=>{
        const choice=key==='decision'?'document_allocation':Object.keys(q.criteria)[0];return[key,{choice,probability:1,probabilities:{[choice]:1}}];
      }))};
    }});
  assert.equal(calls,2);
  assert.equal(allocationAccountClassConflict({documentType:'receipt',outgoing:22,incoming:0,accountClass:'revenue'}),true);
  assert.equal(allocationAccountClassConflict({documentType:'receipt',outgoing:0,incoming:22,accountClass:'revenue'}),false);
  assert.equal(allocationAccountClassConflict({documentType:'sales_invoice',outgoing:0,incoming:22,accountClass:'revenue'}),false);
});
