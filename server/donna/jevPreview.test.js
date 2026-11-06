import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareJevPreview, runJevPreview, jevCasePrompt, matchRelationshipEvidence, caseReplyProvenance, evidenceSummary, projectJevCaseRows } from './jevPreview.js';
import { generateMenu, decideDirectAction } from '../../scripts/jev_direct_action.js';
const document = { id: 'invoice', firm_id: 'firm', client_id: 'company', document_type: 'sales_invoice', parse_status: 'completed', document_date: '2026-09-01', total_amount: '100.00', currency: 'EUR', filename: 'invoice.pdf', reference_number: 'INV-12', parse_summary: { payment_note: 'Pay INV-12' } };
const transaction = { id: 'payment', firm_id: 'firm', client_id: 'company', transaction_date: '2026-09-02', money_in: '100.00', money_out: '0', currency: 'EUR', description: 'INV-12', eligible: true };
const base = { firmId: 'firm', clientId: 'company', document, transactions: [transaction], asOf: '2026-09-19' };

test('prompt compaction preserves every source and alternative while removing identical envelopes',()=>{
  const evidence={scope:{firm_id:'firm',client_id:'company'},documents:[{...document,
    parse_summary:{document_type:'sales_invoice',document_date:document.document_date,currency:'EUR',
      warnings:['Printed private use','Gross includes 25.5%; fee exempt'],tax_groups:[{rate:25.5,amount:20.32}],
      date_candidates:[{value:document.document_date,confidence:.9}],amount_candidates:[{value:100},{value:125}],
      currency_resolution:{currency:'EUR',candidate:'EUR'},prompt_version:'operational'},
    lines:[{id:'source-line',document_id:document.id,description:'Services',amount:100,tax_rate:25.5,
      raw_extraction:{description:'Services',amount:100,tax_rate:25.5,quantity:2,unit_price:50,printed_note:'Source wording'}}]}],
    transactions:[{...transaction,raw_description:transaction.description}],matches:[],owner_replies:[],obligations:[],postings:[]};
  const before=JSON.stringify(evidence),out=jevCasePrompt(evidence),d=out.documents[0];
  assert.equal(JSON.stringify(evidence),before,'canonical apply-time evidence is untouched');
  assert.deepEqual(d.parse_summary.warnings,evidence.documents[0].parse_summary.warnings);
  assert.deepEqual(d.parse_summary.amount_candidates,[{value:100},{value:125}]);
  assert.deepEqual(d.lines[0].raw_extraction,{quantity:2,unit_price:50,printed_note:'Source wording'});
  assert.equal(d.lines[0].tax_rate,25.5);assert.equal(d.parse_summary.date_candidates,undefined);
  assert.equal(d.parse_summary.document_date,undefined);assert.equal(d.firm_id,undefined);
  assert.equal(out.transactions[0].raw_description,undefined);
  assert.deepEqual(out.matches,[]);assert.deepEqual(out.coverage.unread_sources,[]);
  assert.match(out.representation,/nullable fields are unknown/);
});

test('prompt compaction retains zero tax and mismatched totals while sharing exact settlement rows',()=>{
  const row={gross:125,fee:5,fee_tax:0,net:120,net_derived:false};
  const evidence={scope:{firm_id:'firm',client_id:'company'},documents:[{...document,tax_amount:null,
    parse_summary:{tax_amount:null,settlement:{rows:[row]},totals_validation:{matches:false,total:100,expected:120,drift:20},warnings:['Unresolved total']},
    lines:[{id:'source-line',document_id:'invoice',amount:120,tax_rate:null,raw_extraction:{},settlement_row:row}]}],
    transactions:[],matches:[],owner_replies:[],obligations:[],postings:[],coverage:{unread_sources:[],omitted_source_ids:[]}};
  const out=jevCasePrompt(evidence),d=out.documents[0];
  assert.equal(d.parse_summary.settlement,undefined);assert.equal(d.lines[0].settlement_row.fee_tax,0);
  assert.equal(d.lines[0].settlement_row.net_derived,false);assert.equal(d.tax_amount,undefined);
  assert.deepEqual(d.parse_summary.totals_validation,{matches:false,total:100,expected:120,drift:20});
  assert.deepEqual(d.parse_summary.warnings,['Unresolved total']);
});

test('match evidence retains consumed source relationships without prior decision envelopes',()=>{
  const input={consumed_evidence:{documents:['obsolete']},authorization:{model:'fixture',credit_notes:{applied:[{credit_document_id:'credit',amount:20,linkage:'linked',already_applied:false}],applied_total:20}},
    settlement_row:{line_id:'line',line_no:1,net:100},cross_entity:{detected:true,own_side:'Other company'},
    reminder_obligation:{status:'applied',invoice_document_id:'invoice',principal_amount:80,principal_tax:16,charges_amount:20,model:'fixture'}};
  const out=matchRelationshipEvidence(input);
  assert.equal(out.consumed_evidence,undefined);assert.equal(out.authorization,undefined);
  assert.deepEqual(out.settlement_row,{line_id:'line',line_no:1,net:100});
  assert.deepEqual(out.cross_entity,{detected:true,own_side:'Other company'});
  assert.equal(out.reminder_obligation.invoice_document_id,'invoice');assert.equal(out.reminder_obligation.model,undefined);
  assert.equal(out.credit_notes.applied[0].credit_document_id,'credit');
});

test('preview carries persisted evidence without inventing links or complete retrieval', () => {
  const out = prepareJevPreview(base);
  assert.equal(out.prepared.packet.invoice.amount_minor, 10000);
  assert.deepEqual(out.prepared.packet.links, []);
  assert.equal(out.prepared.retrieval_complete, false);
  assert.equal(out.limits.absence_proven, false);
  assert.match(out.prepared.packet.sources.find(s => s.kind === 'sales_invoice').content, /Pay INV-12/);
  assert.deepEqual(out.prepared.eligible_ids, ['payment']);
  assert.ok(generateMenu(out.prepared).plans.some(p => p.terminal === 'resolve'));
});

test('preview rejects scope leakage and existing FX allocations instead of fabricating invoice amounts', () => {
  assert.throws(() => prepareJevPreview({ ...base, document: { ...document, client_id: 'other' } }), { code: 'document_not_found' });
  assert.throws(() => prepareJevPreview({ ...base, transactions: [{ ...transaction, client_id: 'other' }] }), { code: 'foreign_evidence' });
  assert.throws(() => prepareJevPreview({ ...base, matches: [{ id: 'match', firm_id: 'firm', client_id: 'company', matched_object_id: 'invoice', matched_object_type: 'sales_invoice', status: 'confirmed', currency: 'USD', match_amount: 100 }] }), { code: 'existing_fx_allocation' });
});

test('rejected focal pairs remain visible but ineligible and fully settled documents make no provider call', async () => {
  const match = { id: 'match', firm_id: 'firm', client_id: 'company', bank_transaction_id: 'payment', matched_object_id: 'invoice', matched_object_type: 'sales_invoice', status: 'rejected', currency: 'EUR', match_amount: 100 };
  const rejected = prepareJevPreview({ ...base, matches: [match] });
  assert.deepEqual(rejected.prepared.eligible_ids, []);
  assert.equal(rejected.prepared.packet.transactions.length, 1);
  assert.equal(rejected.prepared.packet.allocations[0].status, 'rejected');
  const elsewhere = prepareJevPreview({ ...base, matches: [{ ...match, matched_object_id: 'other-invoice' }] });
  assert.deepEqual(elsewhere.prepared.eligible_ids, ['payment']);
  let calls = 0;
  const client = { query: async sql => {
    if (sql.includes('from clients')) return { rows:[{id:'company',company_name:'Test Company'}] };
    if (sql.includes('from documents') && sql.includes('id=$3')) return { rows: [document] };
    if (sql.includes('from transactions')) return { rows: [transaction] };
    if (sql.includes('from reconciliation_matches')) return { rows: [{ ...match, status: 'confirmed' }] };
    return { rows: [] };
  } };
  await assert.rejects(runJevPreview({ client, firmId: 'firm', clientId: 'company', documentId: 'invoice', asOf: '2026-09-19', provider: async () => { calls++; } }), { code: 'already_settled', statusCode: 422 });
  assert.equal(calls, 0);
});

test('read-only bridge scopes every read and makes exactly one deciding call without a confidence floor', async () => {
  let reads = 0, calls = 0;
  const client = { query: async (sql, params) => {
    assert.match(sql.trim(), /^select /);
    assert.deepEqual(params.slice(0, 2), ['firm', 'company']);
    reads++;
    if (sql.includes('from clients')) return { rows:[{id:'company',company_name:'Test Company'}] };
    if (sql.includes('from documents') && sql.includes('id=$3')) return { rows: [document] };
    if (sql.includes('from transactions')) return { rows: [transaction] };
    return { rows: [] };
  } };
  const out = await runJevPreview({ client, firmId: 'firm', clientId: 'company', documentId: 'invoice', asOf: '2026-09-19', provider: async prepared => {
    calls++;
    const menu = generateMenu(prepared), plan = menu.plans.find(p => p.terminal === 'resolve');
    const decision = decideDirectAction(prepared, menu, { plan: { type: 'choice', choice: plan.id, probability: 0.36 } });
    return { decision, menu, model: 'test-provider-receipt', usage: { input_tokens: 1, output_tokens: 1 }, latency_ms: 5 };
  } });
  assert.equal(reads, 9);
  assert.equal(calls, 1);
  assert.equal(out.read_only, true);
  assert.equal(out.accepted, true);
  assert.equal(out.outcome, 'resolve');
  assert.equal(out.probability, 0.36);
  assert.equal(out.selected_plan.allocations[0].transaction_id, 'payment');
});


test('reply attribution requires an actual client answer and its recorded actor',()=>{
  const base={status:'replied',audience:'client',response_payload:{reply:'Business use',reply_processing:{actor_id:'owner-7'}}};
  assert.equal(caseReplyProvenance(base),'attributable_owner_reply');
  assert.equal(caseReplyProvenance({...base,status:'resolved'}),'attributable_owner_reply');
  assert.equal(caseReplyProvenance({...base,response_payload:{resolution_note:'Automatically resolved',retracted:true}}),'unanswered_question');
  assert.equal(caseReplyProvenance({...base,response_payload:{reply:'Business use'}}),'unverified_reply');
  assert.equal(caseReplyProvenance({...base,audience:'agent'}),'unverified_reply');
  assert.equal(caseReplyProvenance({...base,status:'draft'}),'unverified_reply');
  assert.equal(caseReplyProvenance({...base,response_payload:{reply:'Business use',reply_processing:{actor_id:'system'}}}),'unverified_reply');
  assert.equal(caseReplyProvenance({...base,response_payload:{document_ids:['uploaded-source'],answer_recorded_by:'member-2'}}),'attributable_owner_reply');
});


test('partial extraction semantic evidence ignores run metadata but preserves source changes and stored provenance', () => {
  const partial = { header: { vendor_name: 'Supplier', total_amount: 25, tax_amount: 0, line_amounts_include_tax: false },
    extraction_status: 'failed', reason: 'invalid_schema', code: 'DOCUMENT_EXTRACTION_FAILED',
    provider: 'fixture', model_source: 'response_proven', line_count: 0,
    parse_run_id: '00000000-0000-4000-8000-000000000001', persisted_at: '2026-01-01T10:00:00Z' };
  const summary = { partial_header: partial, warnings: ['Date unreadable'], payment_note: 'Printed reference' };
  const original = structuredClone(summary);
  const project = parseSummary => projectJevCaseRows({ firmId: 'firm', clientId: 'company', documentId: 'invoice',
    company: { id: 'company' }, documents: [{ ...document, parse_status: 'failed', parse_summary: parseSummary }],
    transactions: [], lines: [], matches: [], replies: [], obligations: [], postings: [] }).caseEvidence;
  const first = project(summary);
  const replay = project({ ...summary, partial_header: { ...partial,
    parse_run_id: '00000000-0000-4000-8000-000000000002', persisted_at: '2026-01-02T11:01:02Z' } });
  assert.deepEqual(replay, first, 'the complete projected evidence and its digest replay exactly');
  assert.deepEqual(summary, original, 'persisted provenance must not be mutated');
  assert.deepEqual(first.documents[0].parse_summary.partial_header.header, partial.header);
  assert.equal(first.documents[0].parse_summary.partial_header.reason, 'invalid_schema');
  assert.deepEqual(first.documents[0].parse_summary.warnings, ['Date unreadable']);
  assert.notEqual(project({ ...summary, partial_header: { ...partial, header: { ...partial.header, total_amount: 26 } } }).packet_sha256,
    first.packet_sha256, 'a changed extracted amount invalidates the semantic evidence');
  assert.notEqual(project({ ...summary, partial_header: { ...partial, reason: 'low_confidence' } }).packet_sha256,
    first.packet_sha256, 'a changed failure qualification remains material');
  assert.deepEqual(evidenceSummary({ payment_note: 'Printed reference', tax_amount: 0 }),
    { payment_note: 'Printed reference', tax_amount: 0 }, 'complete neighboring sources retain their facts');
});
