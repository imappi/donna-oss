// Explicit source annotations are factual constraints, not account suggestions.
// Unknown use remains unknown; never infer it from a merchant or expense class.
import { roleForSeedName, roleMeta } from './accountRoles.js';
import { fallbackAccountsForPack, loadOutboundPack } from './outbound/packs.js';
import { hash } from './jevEvidenceContract.js';
import { resolvePostingPolicy, executePostingPolicyOperation } from './postingPolicy.js';

export const normalizeSourceBusinessUse = raw => {
  const sourceQuote=typeof raw?.source_quote==='string'?raw.source_quote.trim():'';
  const classification=['business','personal','mixed'].includes(raw?.classification)&&sourceQuote?raw.classification:'not_stated';
  const percent=raw?.business_use_percent;
  return {classification,source_quote:classification==='not_stated'?null:sourceQuote,
    business_use_percent:classification==='personal'?0:classification==='business'?100:
      classification==='mixed'&&typeof percent==='number'&&percent>0&&percent<100?percent:null};
};
export const sourceBusinessUseFact = document => normalizeSourceBusinessUse(document?.parse_summary?.source_business_use);
export const sourceUseOwnerReplyReceipt = ({transaction,suggestion,matchedDocument}) => {
  const reply=String(transaction?.client_reply_context?.client_reply || '').trim();
  return suggestion?.source_business_use_resolution==='owner_corrected_annotation' && reply && transaction.reply_evidence_request_id
    ? {evidence_request_id:transaction.reply_evidence_request_id,reply_digest:hash(reply),source_quote:reply,
      source_fact_digest:hash({document_id:matchedDocument?.document_id || matchedDocument?.id,fact:sourceBusinessUseFact(matchedDocument)}),
      authority_basis:'attributable_owner_reply_corrects_source_annotation'} : null;
};
export const codingSourceBusinessUseConflict = ({transaction={},suggestion=transaction.ai_suggestion || {},matchedDocument=null,accountClass=null,taxRole=null}) => {
  const fact=sourceBusinessUseFact(matchedDocument);
  if (!['personal','mixed'].includes(fact.classification) || !(Number(transaction.money_out)>0) || Number(transaction.money_in)>0) return null;
  const accounts=suggestion.posting_requirement==='document_allocation'
    ? (suggestion.document_allocations || []).map(item=>item.account) : [suggestion.proposed_account || transaction.account_name || transaction.account_code];
  let palette=[];
  const jurisdiction=suggestion.coding_policy?.jurisdiction;
  if (jurisdiction) palette=fallbackAccountsForPack(loadOutboundPack(jurisdiction));
  // Changing the expense account to equity does not establish input-tax
  // entitlement. Check the selected treatment and persisted tax-control legs.
  const taxSelections=suggestion.posting_requirement==='document_allocation'
    ? suggestion.document_allocations || [] : [suggestion];
  const policy=jurisdiction?resolvePostingPolicy({jurisdiction}):null;
  const personalTax=fact.classification==='personal' && policy?.capabilities.sourceTaxPosting
    && taxSelections.some(item=>{
      const tax=executePostingPolicyOperation(policy,'sourceTaxPosting',{
        taxType:item.tax_type,taxTreatment:item.tax_treatment,direction:'in',gross:Number(transaction.money_out)});
      return tax.inputDeductible || tax.inputTaxRoles?.includes(taxRole);
    });
  const declaredClass=String(accountClass || '').toLowerCase();
  return personalTax || accounts.some(account=>((declaredClass && declaredClass!=='unknown' ? declaredClass : null) || roleMeta(roleForSeedName(account) || palette.find(row=>row.name===account)?.role)?.class
    || suggestion.account_type || suggestion.xero_account_type || transaction.account_type || transaction.xero_account_type)==='expense')
    ? {document_id:matchedDocument.document_id || matchedDocument.id,filename:matchedDocument.filename || null,...fact,
      ...(personalTax?{constraint:'personal_source_cannot_claim_input_tax'}:{})} : null;
};
export const sourceBusinessUseQuestion = fact => `The source${fact.filename?` ${fact.filename}`:''} explicitly says “${fact.source_quote}”. Was this personal or mixed use as marked, and whose personal portion was paid by the business? If the annotation is incorrect, please explain the actual business use.`;

// A private-use annotation is not evidence of who the private party is. A
// receivable from, or loan to, a related person needs that relationship from an
// attributable owner answer; the annotation alone never establishes it.
export const RELATED_PARTY_ACCOUNT_ROLES = Object.freeze(['asset.receivable_from_owner', 'liability.director_loan']);
export const codingRelatedPartyRelationshipGuard = ({transaction={},suggestion={},matchedDocument=null}) => {
  const fact=sourceBusinessUseFact(matchedDocument);
  if (!['personal','mixed'].includes(fact.classification) || suggestion.source_identity_resolution==='owner_explained_relationship') return null;
  const accounts=suggestion.posting_requirement==='document_allocation'
    ? (suggestion.document_allocations || []).map(item=>item.account) : [suggestion.proposed_account];
  const jurisdiction=suggestion.coding_policy?.jurisdiction;
  const palette=jurisdiction?fallbackAccountsForPack(loadOutboundPack(jurisdiction)):[];
  const related=accounts.filter(account=>account && RELATED_PARTY_ACCOUNT_ROLES.includes(roleForSeedName(account) || palette.find(row=>row.name===account)?.role));
  if (!related.length) return null;
  return {document_id:matchedDocument.document_id || matchedDocument.id,filename:matchedDocument.filename || null,
    accounts:related,...fact,constraint:'related_party_relationship_unevidenced'};
};
export const relatedPartyRelationshipQuestion = guard => `The source${guard.filename?` ${guard.filename}`:''} says “${guard.source_quote}”, so the payment is proposed as a receivable from, or loan to, a related person rather than a company expense. Who is that person, and are they a shareholder, director or employee of the company? We will record the receivable or the benefit accordingly.`;
