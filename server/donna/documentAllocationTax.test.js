import test from 'node:test';
import assert from 'node:assert/strict';
import { documentSourceComponents } from './documentAllocationComponents.js';
import { decideJevCoding } from './jevCoding.js';
import { FI_POSTING_POLICY } from './finland/postingPolicy.js';
import { splitAlvGross } from './finland/alvCodes.js';
import { buildLedgerJournalForTransaction } from './ledger.js';

// Minimized extracted facts; no source files or customer identities.
// The business these source checks describe is ALV-registered (finland/postingPolicy.js
// refuses an ALV code without a registration on the line's date).
const registered = { alv_registration: { status: 'registered', registered_from: '2020-01-01' } };
const source = (amounts, rates, tax, total = amounts.reduce((a, b) => a + b, 0)) => ({
  document_id: 'synthetic-source', document_type: 'supplier_bill', currency: 'EUR', total_amount: total, tax_amount: tax,
  match_status: 'auto_matched', parse_summary: { line_amounts_include_tax: true, totals_validation: { matches: true } },
  lines: amounts.map((amount, i) => ({ id: `source-${i}`, description: `Component ${i + 1}`, amount, raw_extraction: { tax_rate: rates[i] } }))
});
const mixed = source([2.49, 4.99, 3.79, 2.95, 7.99, 8.95, 1.99], [.255, .255, .255, .255, .255, .14, .14], 5.85, 33.15);
const food = source([7.95, 1.19, 2.99, 5.99, .62], [.14, .14, .14, .14, 0], 2.23, 18.74);
const reminder = source([903.6, 20], [.255, 0], null, 923.6);
const taxes = ['ALV 25,5 %', 'ALV 14 %', 'Veroton toiminta (ALV-vapaa)', 'Ei ALV-käsittelyä'];
const accounts = ['Operating supplies', 'Sales', 'Loan payable', 'Interest expense'];
const taxFor = line => line.raw_extraction.tax_rate === .255 ? taxes[0] : line.raw_extraction.tax_rate === .14 ? taxes[1] : taxes[2];

test('source group arithmetic preserves mixed VAT, exempt deposit and reminder with absent header', () => {
  for (const [document, expected] of [[mixed, 5.85], [food, 2.23], [reminder, 183.60]]) {
    const result = documentSourceComponents(document);
    assert.equal(result.complete, true);
    assert.equal(result.source_tax, expected);
    assert.equal(Math.round(result.components.reduce((sum, c) => sum + c.source_tax, 0) * 100), Math.round(expected * 100));
    assert.equal(Math.round(result.components.reduce((sum, c) => sum + c.gross, 0) * 100), Math.round(document.total_amount * 100));
  }
  const unknown = documentSourceComponents(source([900, 100], [null, null], null, 1000));
  assert.equal(unknown.complete, true); assert.equal(unknown.tax_complete, false); assert.equal(unknown.source_tax, null);
  const untaxedComponents = documentSourceComponents({...source([360,52.35],[null,null],null,412.35),parse_summary:{line_amounts_include_tax:false}});
  assert.equal(untaxedComponents.complete,true); assert.equal(untaxedComponents.tax_complete,false);
  assert.deepEqual(untaxedComponents.components.map(c=>c.gross),[360,52.35]);
  assert.ok(untaxedComponents.components.every(c=>!c.source_tax_known));
});

test('Jev can select and compose a complete mixed action from source handles with low probabilities', async () => {
  let calls = 0;
  const transaction = { description: 'Mixed supplies', money_out: 33.15, currency: 'EUR', matched_document: mixed };
  const result = await decideJevCoding({ input: { transaction }, transaction, accountOptions: accounts, taxOptions: taxes,
    instructions: 'Use only supplied business-use facts and source tax.', suspenseAccountName: 'Suspense', defaultTaxTreatment: taxes[3],
    provider: async request => {
      calls++;
      return { model: 'fixture-provider', usage: { input_tokens: 1, output_tokens: 1 }, answers: Object.fromEntries(Object.keys(request.questions).map(key => {
        const handle = /^line_(\d+)_/.exec(key);
        const choice = key === 'decision' ? 'document_allocation' : key === 'materiality' ? 'normal'
          : key.endsWith('_decision') ? 'resolved' : key.endsWith('_account') ? 'account_0' : `tax_${taxes.indexOf(taxFor(mixed.lines[Number(handle[1]) - 1]))}`;
        return [key, { choice, probability: .42, probabilities: { [choice]: .42 } }];
      })) };
    } });
  assert.equal(calls, 3, 'one action decision, then two bounded component calls');
  assert.equal(result.suggestion.posting_requirement, 'document_allocation');
  assert.equal(result.suggestion.document_allocations.length, 7);
  assert.equal(result.receipt.coverage.complete, true); assert.equal(result.receipt.usage.input_tokens, 3);
  assert.equal(result.receipt.probability, .42);
  assert.ok(result.suggestion.document_allocations.every((c, i) => c.tax_treatment === taxFor(mixed.lines[i])));
  assert.ok(result.suggestion.document_allocations.every(c => !('amount' in c)), 'model cannot author amounts');
});

test('valid receipt plus wrong tax is a coding conflict; source absence cannot mint input VAT', () => {
  for (const document of [mixed, food, source([12.90], [.14], 1.58)]) {
    const transaction = { date: '2025-02-01', money_out: document.total_amount, tax_treatment: 'ALV 10 %', ai_suggestion: { posting_requirement: 'single_account' } };
    assert.throws(() => FI_POSTING_POLICY.assertPostableTaxCoding({ coding: { account_type: 'expense', tax_type: 'ALV_10_INPUT' }, transaction, taxCodingEnabled: true, profile: registered, matchedDocument: document }),
      error => error.code === 'TRANSACTION_ALV_CODING_SOURCE_CONFLICT');
  }
  assert.throws(() => FI_POSTING_POLICY.assertPostableTaxCoding({ coding: { account_type: 'expense', tax_type: 'ALV_25_5_INPUT' }, transaction: { date: '2025-02-01', money_out: 40 }, taxCodingEnabled: true, profile: registered }), error => error.code === 'TRANSACTION_ALV_EVIDENCE_REQUIRED');
});

test('the existing journal builder posts each selected component tax and balances both directions', () => {
  for (const [document, incoming] of [[mixed, false], [food, false], [reminder, true]]) {
    const result = documentSourceComponents(document);
    const allocation = { lines: result.components.map(component => {
      const code = component.rate ? `ALV_${String(component.rate).replace('.', '_')}_${incoming ? 'OUTPUT' : 'INPUT'}` : 'ALV_EXEMPT';
      const split = splitAlvGross({ gross: component.gross, code });
      return { ...component, amount: component.gross, coding: { account_name: incoming ? 'Sales' : 'Operating supplies', account_type: incoming ? 'revenue' : 'expense', tax_type: code },
        tax_split: split ? { ...split, vat: component.source_tax, net: component.net } : null };
    }) };
    const journal = buildLedgerJournalForTransaction({ transaction: { id: 'synthetic', date: '2025-02-01', currency: 'EUR', money_out: incoming ? 0 : document.total_amount, money_in: incoming ? document.total_amount : 0 },
      coding: allocation.lines[0].coding, bankAccount: { name: 'Bank', code: '1910', currency: 'EUR' }, documentAllocation: allocation });
    const debit = journal.lines.reduce((sum, line) => sum + line.debit, 0), credit = journal.lines.reduce((sum, line) => sum + line.credit, 0);
    assert.equal(Math.round(debit * 100), Math.round(credit * 100));
    const vat = journal.lines.filter(line => /arvonlisävero/.test(line.account.name)).reduce((sum, line) => sum + line.amount, 0);
    assert.equal(Math.round(vat * 100), Math.round(result.source_tax * 100));
  }
});


test('Jev settlement action selects gross sales VAT and processor fee treatment separately', async () => {
  const transaction = { money_in:2452.72, currency:'EUR', matched_document:{matched_line:{settlement_row:{gross:2480,fee:27.28,fee_tax:0,net:2452.72}}} };
  let calls = 0;
  const result = await decideJevCoding({input:{transaction},transaction,accountOptions:['Sales','Payment processor clearing'],taxOptions:taxes,instructions:'Source-supported sales.',
    provider:async request=>{calls++;return {model:'fixture-provider',usage:{input_tokens:1,output_tokens:1},answers:Object.fromEntries(Object.keys(request.questions).map(key=>{
      const choice=key==='decision'?'settlement_gross':key==='materiality'?'normal':key==='processor_fee_tax'?'tax_2':key.endsWith('_decision')?'resolved':key.endsWith('_account')?'account_0':'tax_0';
      return[key,{choice,probability:.42,probabilities:{[choice]:.42}}];
    }))};}});
  assert.equal(calls,2);assert.equal(result.receipt.action,'settlement_gross');
  assert.equal(result.suggestion.proposed_account,'Sales');assert.equal(result.suggestion.tax_treatment,'ALV 25,5 %');
  assert.equal(result.suggestion.processor_fee_tax_treatment,'Veroton toiminta (ALV-vapaa)');
});


test('complete Jev allocation receipt resolves coding without a probability gate', async () => {
  const {hasJevResolvedCoding}=await import('./jevDecisionReceipt.js');
  const {__shouldAutoApplyBatchSuggestion}=await import('./db/coding.js');
  const suggestion={source:'jev',decision_engine:'jev',model:'fixture',confidence:'low',proposed_account:'Operating supplies',evidence_required:false,posting_requirement:'document_allocation',
    jev_decision:{terminal:'resolved',model:'fixture',probability:.42,action:'document_allocation',coverage:{complete:true,source_components:2,selected_components:2}},
    document_allocations:[{line_handle:'line_1',account:'Operating supplies',tax_treatment:'ALV 25,5 %'},{line_handle:'line_2',account:'Operating supplies',tax_treatment:'ALV 14 %'}]};
  assert.equal(hasJevResolvedCoding(suggestion),true);
  assert.equal(__shouldAutoApplyBatchSuggestion({matched_document:{match_status:'auto_matched'},money_out:500},suggestion),true);
  assert.equal(hasJevResolvedCoding({...suggestion,document_allocations:suggestion.document_allocations.slice(1)}),false);
  assert.equal(hasJevResolvedCoding({...suggestion,document_allocations:[suggestion.document_allocations[0],suggestion.document_allocations[0]]}),false);
  assert.equal(hasJevResolvedCoding({...suggestion,evidence_required:true}),false);
  assert.equal(suggestion.jev_decision.probability,.42);
});

test('self-assessed acquisition rates do not masquerade as supplier-charged VAT',()=>{
  for(const [treatment,code] of [['EU-tavaraosto','ALV_EU_ACQUISITION'],['EU-palveluosto','ALV_EU_SERVICE_ACQUISITION']]){
    const document=source([150],[0],0);
    const options={coding:{account_type:'expense',tax_type:code},transaction:{date:'2025-02-01',money_out:150,tax_treatment:treatment},taxCodingEnabled:true,profile:registered,matchedDocument:document};
    assert.doesNotThrow(()=>FI_POSTING_POLICY.assertPostableTaxCoding(options));
    const action=FI_POSTING_POLICY.sourceTaxPosting({taxTreatment:treatment,direction:'in',gross:150});
    assert.equal(action.rate,25.5);assert.equal(action.sourceRate,0);assert.equal(action.splitRequired,false);assert.equal(action.split,null);
    assert.throws(()=>FI_POSTING_POLICY.assertPostableTaxCoding({...options,matchedDocument:source([150],[.14],18.42)}),{code:'TRANSACTION_ALV_CODING_SOURCE_CONFLICT'});
  }
  assert.throws(()=>FI_POSTING_POLICY.assertPostableTaxCoding({coding:{account_type:'expense',tax_type:'ALV_25_5_INPUT'},transaction:{date:'2025-02-01',money_out:150},taxCodingEnabled:true,profile:registered,matchedDocument:source([150],[0],0)}),{code:'TRANSACTION_ALV_CODING_SOURCE_CONFLICT'});
});


test('a component can request the existing reasoning handoff without emitting a partial allocation', async () => {
  let calls=0;
  const transaction={description:'Mixed source',money_out:mixed.total_amount,matched_document:mixed};
  const result=await decideJevCoding({input:{transaction},transaction,accountOptions:accounts,taxOptions:taxes,
    instructions:'Use the supplied evidence.',suspenseAccountName:'Suspense',defaultTaxTreatment:taxes[3],
    provider:async request=>{
      calls++;
      const answers=Object.fromEntries(Object.entries(request.questions).map(([key,q])=>{
        const choice=key==='decision'?'document_allocation':key==='materiality'?'normal':key==='line_4_decision'?'reasoning_judgment':Object.keys(q.criteria)[0];
        return [key,{choice,probability:.95,probabilities:{[choice]:.95}}];
      }));
      return {model:'fixture-provider',usage:{input_tokens:10,output_tokens:5},answers};
    }});
  assert.equal(calls,2,'stop before solving another batch after the explicit handoff');
  assert.equal(result.terminal,'needs_reasoning');assert.equal(result.suggestion,undefined);
  assert.equal(result.receipt.selected,'reasoning_judgment');assert.equal(result.receipt.component_handle,'line_4');
  assert.equal(result.receipt.selected_action,'document_allocation');
  assert.deepEqual(result.receipt.usage,{input_tokens:20,output_tokens:10});
});
