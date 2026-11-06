import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareJevPreview } from './jevPreview.js';
import { buildJevReconciliationRequest } from './jevRuntimeDecision.js';
import { jevCasePrompt } from './jevPreview.js';
import { callJevTyped } from './jevProvider.js';

test('large matching requests retain the entire evidence and action map through the actual provider transport', async () => {
  const document = { id: 'invoice', firm_id: 'firm', client_id: 'company', document_type: 'sales_invoice', parse_status: 'completed', document_date: '2026-09-01', total_amount: 100, currency: 'EUR', filename: 'invoice.pdf' };
  const transactions = Array.from({ length: 36 }, (_, i) => ({ id: `payment-${i}`, firm_id: 'firm', client_id: 'company', transaction_date: '2026-09-02', money_in: 100, money_out: 0, currency: 'EUR', description: `Possible payment ${i}`, eligible: true }));
  const mapped = prepareJevPreview({ firmId: 'firm', clientId: 'company', document, transactions, asOf: '2026-09-19' });
  mapped.sourceDocument = document;
  mapped.caseEvidence = { scope: { firm_id: 'firm', client_id: 'company' }, focal: { kind: 'document', id: document.id },
    documents: Array.from({ length: 27 }, (_, i) => ({ ...document, id: i ? `source-${i}` : document.id, filename: `source-${i}.pdf`, lines: Array.from({ length: 14 }, (_, n) => ({ id: `line-${i}-${n}`, line_no: n + 1, description: `Exact source annotation ${i}/${n}`, amount: 0, tax_rate: 0, raw_extraction: { source_false: false, source_null: null } })) })),
    transactions, matches: [], owner_replies: [{ id: 'reply-id', question: 'Was it for business?', reply: 'Half was private.', provenance: 'attributable_owner_reply' }], obligations: [], postings: [], coverage: { status: 'complete_within_scope', unread_sources: [] } };
  const original = structuredClone(mapped.caseEvidence);
  const expected = jevCasePrompt(mapped.caseEvidence, { bankHandles: mapped.prepared.bank_handles });
  const { request, plans } = buildJevReconciliationRequest(mapped, 'test-model');
  assert.equal(Object.keys(plans).length, 36);
  assert.ok(JSON.stringify(request.state).length > 60_000);
  const choice = Object.keys(plans)[0];
  const result = await callJevTyped(request, { apiKey: 'test-key', fetchImpl: async (_url, init) => {
    const wire = JSON.parse(init.body);
    assert.equal(typeof wire.state, 'string');
    assert.deepEqual(JSON.parse(wire.state).case_evidence, expected);
    assert.deepEqual(JSON.parse(wire.state), request.state);
    assert.deepEqual(wire.questions, request.questions);
    return new Response(JSON.stringify({ model: 'test-model', usage: { input_tokens: 1, output_tokens: 1 }, answers: { plan: { type: 'choice', choice, confidence: 1, probabilities: Object.fromEntries(Object.keys(wire.questions.plan.criteria).map(key => [key, key === choice ? 1 : 0])) } } }));
  } });
  assert.equal(result.answers.plan.choice, choice);
  assert.deepEqual(mapped.caseEvidence, original, 'the original write-time evidence remains unchanged');
});

test('the automatic choice retains every eligible full payment beyond the research menu cap', () => {
  const document = { id: 'invoice', firm_id: 'firm', client_id: 'company', document_type: 'sales_invoice', parse_status: 'completed', document_date: '2026-09-01', total_amount: '100.00', currency: 'EUR', filename: 'invoice.pdf' };
  const transactions = Array.from({ length: 20 }, (_, i) => ({ id: `payment-${i}`, firm_id: 'firm', client_id: 'company', transaction_date: '2026-09-02', money_in: '100.00', money_out: '0', currency: 'EUR', description: `Possible payment ${i}`, eligible: true }));
  transactions.push({ ...transactions[0], id: 'partial', money_in: '50.00' }, { ...transactions[0], id: 'foreign', currency: 'USD' });
  const mapped = prepareJevPreview({ firmId: 'firm', clientId: 'company', document, transactions, asOf: '2026-09-19' });
  const { request, plans } = buildJevReconciliationRequest(mapped, 'test-model');
  assert.equal(Object.keys(plans).length, 20);
  assert.equal(Object.keys(request.questions).length, 1);
  assert.equal(Object.keys(request.questions.plan.criteria).length, 22);
  assert.deepEqual(Object.values(plans).map(p => p.allocations[0].transaction_id).sort(), transactions.slice(0, 20).map(t => t.id).sort());
  assert.ok(request.questions.plan.criteria.needs_more_work);
  assert.ok(request.questions.plan.criteria.no_settlement);
});


test('matching prompt uses one evidence copy and the trusted action handles even when discovery order differs', () => {
  const document={id:'invoice',firm_id:'firm',client_id:'company',document_type:'sales_invoice',parse_status:'completed',document_date:'2026-09-01',total_amount:100,currency:'EUR',filename:'invoice.pdf'};
  const transactions=['z-near','a-far'].map((id,i)=>({id,firm_id:'firm',client_id:'company',transaction_date:`2026-09-0${i+1}`,money_in:100,money_out:0,currency:'EUR',description:`Bank row ${id}`,eligible:true}));
  const mapped=prepareJevPreview({firmId:'firm',clientId:'company',document,transactions,asOf:'2026-09-19'});
  mapped.sourceDocument=document;
  mapped.caseEvidence={scope:{firm_id:'firm',client_id:'company'},company:{id:'company'},focal:{kind:'document',id:document.id},
    documents:[{...document,lines:[]}],transactions,matches:[],owner_replies:[],obligations:[],postings:[],coverage:{status:'complete_within_scope',unread_sources:[]}};
  const {request,plans}=buildJevReconciliationRequest(mapped,'test-model');
  assert.equal(request.state.sources,undefined,'serialized research source copies do not duplicate the shared case');
  assert.equal(request.state.candidates,undefined,'there is no second candidate namespace');
  for(const [choice,plan] of Object.entries(plans)) {
    const id=plan.allocations[0].transaction_id;
    const visible=request.state.case_evidence.transactions.find(row=>row.id===choice);
    assert.equal(visible.description,`Bank row ${id}`,'each action handle refers to its exact bank row');
  }
  assert.equal(request.state.invoice.document,request.state.case_evidence.focal.id);
  assert.match(request.state.amount_units,/major units/);
});
