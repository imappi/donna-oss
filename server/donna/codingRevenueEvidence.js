import {roleForSeedName} from './accountRoles.js';

// A receipt of money does not establish a new sale. Bank interest and reversals
// retain their own roles; a deposit slip proves movement, not underlying sales.
export function codingRevenueEvidenceGap({transaction={},suggestion=transaction.ai_suggestion||{},matchedDocument=null,accountRole=null}={}) {
  if(!(Number(transaction.money_in)>0) || Number(transaction.money_out)>0)return false;
  const role=accountRole || roleForSeedName(suggestion.proposed_account || suggestion.account_name || transaction.account_name || transaction.account_code);
  if(role!=='revenue.operating')return false;
  return !(matchedDocument && ['confirmed','auto_matched'].includes(matchedDocument.match_status)
    && ['sales_invoice','issued_receipt','payout_statement'].includes(matchedDocument.document_type));
}
