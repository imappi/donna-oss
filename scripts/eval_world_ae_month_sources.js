// Fictional raw evidence and synthetic provider responses. No expected books.
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { loadRecording } from '../server/donna/testSupport/recordedProviders.js';

export const MONTH_PROFILE = Object.freeze({ companyName:'Dune Design Services LLC',jurisdiction:'AE',entityType:'ae-llc',
  incorporationDate:'2020-01-01',currency:'AED',accounting_view:'management_books',accountingBasis:'cash',accounting_system:'none',
  vat_registration:{status:'registered',registered_from:'2026-01-01',vat_registration_number:'100123456789012'},
  ae_establishment:{emirate:'DXB',qualifying_ecommerce_registrant:false} });
export const MONTH_SOURCES = Object.freeze([
  {key:'sale',date:'2026-09-09',type:'sales_invoice',reference:'DDS-0909',counterparty:'Oasis Customer LLC',description:'September design services',net:1000,vat:50,total:1050},
  {key:'supplies',date:'2026-09-12',type:'supplier_bill',reference:'GULF-0912',counterparty:'Gulf Supplies LLC',description:'Design studio operating supplies',verificationEvidence:'Fictional purchaser receiving record GR-0912: Gulf Supplies LLC identity and TRN checked against retained supplier registration; goods delivered and accepted at the design studio on 2026-09-12.',net:200,vat:10,total:210},
  {key:'purpose',date:'2026-09-21',type:'supplier_bill',reference:'PALM-0921',counterparty:'Palm Supplies LLC',description:'Assorted consumables; purchaser use not stated',verificationEvidence:'Fictional purchaser receiving record GR-0921: Palm Supplies LLC identity and TRN checked against retained supplier registration; consumables delivered and accepted on 2026-09-21. Business or personal use is not recorded.',net:100,vat:5,total:105},
]);
export const MONTH_ORDERS = Object.freeze(['document_first','bank_first','late_document']);

export async function rawMonthPdf(lines) {
  const pdf=await PDFDocument.create();
  pdf.setCreationDate(new Date('2026-09-01T00:00:00Z'));pdf.setModificationDate(new Date('2026-09-01T00:00:00Z'));
  const page=pdf.addPage();const font=await pdf.embedFont(StandardFonts.Helvetica);
  lines.forEach((text,index)=>page.drawText(text,{x:40,y:780-index*25,size:11,font}));
  return Buffer.from(await pdf.save());
}
export function monthInvoiceBytes(source) {
  const sale=source.type==='sales_invoice';
  return rawMonthPdf(['SYNTHETIC TAX INVOICE '+source.reference,
    'Seller: '+(sale?MONTH_PROFILE.companyName:source.counterparty),
    'Buyer: '+(sale?source.counterparty:MONTH_PROFILE.companyName),
    'Seller TRN: '+(sale?'100123456789012':'100000000000003'),'Buyer TRN: '+(sale?'100000000000004':'100123456789012'),
    'Both parties: Dubai, United Arab Emirates','Invoice and supply date: '+source.date,source.description,
    `Net AED ${source.net.toFixed(2)}; VAT 5% AED ${source.vat.toFixed(2)}; Total AED ${source.total.toFixed(2)}`,
    'Fully paid by AED bank transfer on '+source.date,
    ...(source.verificationEvidence?source.verificationEvidence.match(/.{1,90}(?:\s|$)/g).map(line=>line.trim()):[]),
    ...(source.key==='supplies'?['Delivered to design studio for taxable design work; no personal use.']:[])]);
}
export function monthBankBytes() {
  return Buffer.from('Date,Description,Money In,Money Out,Balance,Currency\n09/09/2026,OASIS CUSTOMER DDS-0909,1050,0,11050,AED\n12/09/2026,GULF SUPPLIES GULF-0912,0,210,10840,AED\n21/09/2026,PALM SUPPLIES PALM-0921,0,105,10735,AED\n');
}
export const monthBankStatementBytes=()=>rawMonthPdf(['SYNTHETIC BANK STATEMENT',MONTH_PROFILE.companyName,
  'Account: AE070331234567890123456; currency AED','Statement period: 2026-09-01 to 2026-09-30',
  'Opening balance AED 10000.00; Closing balance AED 10735.00','Total deposits AED 1050.00; Total payouts AED 315.00; 3 transactions',
  '2026-09-09 OASIS CUSTOMER DDS-0909 credit 1050.00 balance 11050.00',
  '2026-09-12 GULF SUPPLIES GULF-0912 debit 210.00 balance 10840.00',
  '2026-09-21 PALM SUPPLIES PALM-0921 debit 105.00 balance 10735.00']);
export const monthBankExtractionFixture=()=>openAiFixture({transactions:MONTH_SOURCES.map((source,index)=>({
  date:source.date,counterparty:source.counterparty,payment_method:'bank_transfer',message:null,reference:source.reference,
  description:source.counterparty+' '+source.reference,direction:source.type==='sales_invoice'?'in':'out',amount:source.total,currency:'AED',balance:[11050,10840,10735][index]})),
  statement_summary:{opening_balance:10000,closing_balance:10735,total_deposits:1050,total_payouts:315,currency:'AED',
    period_start:'2026-09-01',period_end:'2026-09-30',account_identifier:'AE070331234567890123456'}});
export const monthOpeningBytes=()=>rawMonthPdf(['SYNTHETIC COMPLETE OWNER TRIAL BALANCE','Dune Design Services LLC',
  'Closing balances as of 2026-08-31, opening 2026-09-01','Bank AED 10000 debit','Share capital AED 10000 credit',
  'Total debits AED 10000; total credits AED 10000','All other balances zero; this is the complete trial balance.']);

// Reuse existing provider envelopes; only schema payloads are synthetic here.
export function openAiFixture(payload) {
  const body=structuredClone(loadRecording('document_routing/ochre-supplier-bill').body);
  body.output[0].content[0].text=JSON.stringify(payload);return {status:200,body};
}
export function anthropicFixture(payload) {
  const body=structuredClone(loadRecording('unified_extraction/ochre-discount-line').body);
  body.content[0].text=JSON.stringify(payload);return {status:200,body};
}
export function monthRoutingFixture(source) {
  const family=source==='opening'?'unknown_but_relevant':source==='bank'?'bank_statement':'invoice_or_bill';
  return openAiFixture({document_family:family,confidence:0.98,direction_hint:source?.type==='sales_invoice'?'ar':source?.type==='supplier_bill'?'ap':'unknown',
    candidate_families:[{family,confidence:0.98}],language_hint:'en',reason:'Synthetic classification of the supplied fictional source.'});
}
export function monthExtractionFixture(source) {
  const template=JSON.parse(loadRecording('unified_extraction/ochre-discount-line').body.content[0].text);
  const sale=source.type==='sales_invoice';
  Object.assign(template,{document_type:source.type});
  Object.assign(template.header,{counterparty_name:source.counterparty,counterparty_role:sale?'customer':'vendor',counterparty_tax_id:sale?'100000000000004':'100000000000003',
    own_name:MONTH_PROFILE.companyName,own_tax_id:'100123456789012',document_date:source.date,due_date:source.date,currency:'AED',subtotal_amount:source.net,
    tax_amount:source.vat,discount_amount:0,total_amount:source.total,payment_status:'paid',payment_terms:'Paid bank transfer same day',references:[{type:'invoice_number',value:source.reference}]});
  template.lines=[{description:[source.description,source.verificationEvidence].filter(Boolean).join(' '),quantity:1,unit_price:source.net,amount:source.net,tax_rate:0.05}];
  return anthropicFixture(template);
}
export const monthOpeningExtractionFixture=()=>openAiFixture({extraction_status:'validated',extraction_confidence:0.98,document_type_guess:'trial_balance',
  parties:[{name:MONTH_PROFILE.companyName,role:'company'}],amounts:[{value:10000,currency:'AED',label:'Total debits (equals total credits)',role:'total_gross'}],
  dates:[{value:'2026-08-31',label:'Closing trial balance date',role:'document_date'}],references:[],
  summary_text:'Complete declared closing trial balance: bank debit AED10000, share capital credit AED10000, other balances zero.',warnings:[]});
export function monthCodingFixture(statementId,accounts) {
  const base=JSON.parse(loadRecording('transaction_coding/kestrel-two-lines-coded').body.output[0].content[0].text).suggestions[1];
  return openAiFixture({suggestions:MONTH_SOURCES.map((source,index)=>({...base,transaction_id:`${statementId}-tx-${index}`,
    proposed_account:source.type==='sales_invoice'?accounts.sales.name:accounts.cost.name,contact:source.counterparty,
    tax_treatment:'VAT 5% (standard rated)',support_note:source.description,ask_client_question:'',evidence_required:false,
    merchant_pattern:source.counterparty.toLowerCase(),confidence:'high',materiality:'normal',reasoning:'Synthetic strong-provider coding from the exact retained source economics.',warnings:[],alternatives:[]})),group_summary:[]});
}
export function monthMatchingFixture(source) {
  return anthropicFixture({proposals:[{candidate_ref:'candidate_1',confidence:0.99,
    reasoning:`The AED ${source.total} movement on ${source.date} quotes exact invoice ${source.reference}; same counterparty, currency, amount and date.`,hops:[]}],unmatchable_reason:null});
}
export const monthDocumentDispositionFixture=()=>anthropicFixture({disposition:'chase_evidence',materiality:'material',expense_kind:'documented_bank_transfer',
  settlement_channel:'uncovered_account',confidence:0.99,reasoning:'The document states payment by bank transfer; the corresponding bank statement has not arrived yet.'});
export function monthBankDispositionFixture(request) {
  const system=typeof request?.system==='string'?request.system:'';
  const debit=system.startsWith('You triage a single unmatched bank DEBIT');
  const credit=system.startsWith('You triage a single unmatched bank CREDIT');
  if(!debit&&!credit)throw new Error('Synthetic disposition received no exact bank direction.');
  return anthropicFixture({disposition:debit?'chase_receipt':'chase_evidence',materiality:'material',expense_kind:'bank_transfer',
    confidence:0.99,reasoning:'The bank reference names an invoice that has not arrived yet.'});
}
export function monthToolFixture(name,input) {
  const fixture=anthropicFixture({});fixture.body.content=[{type:'tool_use',id:'synthetic-month-tool',name,input}];fixture.body.stop_reason='tool_use';return fixture;
}
// Select pre-authored synthetic answers by the exact source date. Assertions at
// this wire boundary prove the real runtime supplied the retained evidence;
// this fixture never supplies ids or expected journals to a production writer.
export function monthVatFixture(request) {
  const input=JSON.parse(request.messages[0].content);
  const source=MONTH_SOURCES.find(s=>s.date===input.bank_transaction.date);
  if(!source)throw new Error('Synthetic VAT fixture received an unknown source date.');
  const document=input.documents.find(d=>d.ref===input.settled_document_ref);
  if(!document)throw new Error('Synthetic VAT fixture received no settled source.');
  if(source.verificationEvidence&&!JSON.stringify(document).includes(source.verificationEvidence))throw new Error('Runtime omitted retained supplier verification evidence.');
  const needsUse=source.key==='purpose'&&!input.owner_business_use;
  return monthToolFixture('assess_ae_vat_facts',{outcome:needsUse?'owner_business_use':'supported',document_ref:input.settled_document_ref,
    explanation:needsUse?'The supplied PALM-0921 invoice and receiving record establish the purchase, but the business use is not recorded.':
      'Synthetic evidence assessment: exact retained tax invoice, same-day bank payment and receiving/owner evidence establish this supported supply.',
    question:needsUse?'Were the consumables on Palm Supplies invoice PALM-0921 used exclusively for your taxable design business, or was any part personal?':null,
    facts:needsUse?null:{date_of_supply:source.date,reporting_date:source.date,taxable_amount:source.net.toFixed(2),vat_amount:source.vat.toFixed(2),supply_class:'ordinary_domestic',
      payment_method:'bank_transfer',fully_paid:true,invoice_validity:'confirmed',direction:source.type==='sales_invoice'?'out':'in',
      input_recovery:source.type==='sales_invoice'?null:{basis:'direct_taxable',recovery_bps:10000,blocked:false,personal_use:false,supply_integrity:'verified',verification_evidence:source.verificationEvidence}}});
}
