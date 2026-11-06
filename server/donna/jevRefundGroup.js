import { createHash } from 'node:crypto';
import { toIsoDay } from './dates.js';
import { documentSourceComponents } from './documentAllocationComponents.js';

// Menu vocabulary, not a merchant matcher. The model must select the semantic
// duplicate/refund conclusion from the complete case. Arithmetic alone cannot.
export function planRefundGroup({document,transactions=[]}={}) {
  const refuse=reason=>({ok:false,reason});
  if (!document || document.parse_status!=='completed' || !['supplier_bill','receipt'].includes(document.parse_summary?.document_type || document.document_type)
    || !(Number(document.total_amount)>0) || transactions.length!==3 || new Set(transactions.map(t=>t.id)).size!==3) return refuse('refund_group_shape');
  const minor=value=>Math.round(Number(value||0)*100);
  const amount=minor(document.total_amount),currency=String(document.currency||'').toUpperCase();
  const rows=transactions.map(t=>({id:t.id,firm_id:t.firm_id,client_id:t.client_id,date:toIsoDay(t.transaction_date||t.date),description:t.description||'',currency:String(t.currency||'').toUpperCase(),money_in:minor(t.money_in),money_out:minor(t.money_out)}))
    .sort((a,b)=>String(a.date).localeCompare(String(b.date))||String(a.id).localeCompare(String(b.id)));
  if(rows.some(t=>t.firm_id!==document.firm_id || t.client_id!==document.client_id || t.currency!==currency || !t.date))return refuse('refund_group_scope');
  const debits=rows.filter(t=>t.money_out===amount&&t.money_in===0),credits=rows.filter(t=>t.money_in===amount&&t.money_out===0);
  if(debits.length!==2||credits.length!==1||credits[0].date<debits[1].date)return refuse('refund_group_amounts');
  const source=documentSourceComponents(document);
  if(!source.complete)return refuse('refund_group_source_incomplete');
  const facts={document_id:document.id,transaction_ids:rows.map(t=>t.id).sort(),purchase_transaction_id:debits[0].id,duplicate_transaction_id:debits[1].id,refund_transaction_id:credits[0].id,
    amount:amount/100,currency,allocation_basis:'chronological_convention_without_instrument_identity',bank_sources:rows,
    source:{date:toIsoDay(document.document_date),reference:document.reference_number||null,vendor_name:document.vendor_name||null,components:source.components}};
  return {ok:true,version:1,...facts,source_digest:createHash('sha256').update(JSON.stringify(facts)).digest('hex')};
}
