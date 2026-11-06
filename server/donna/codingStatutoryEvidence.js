import {roleForSeedName} from './accountRoles.js';
import {fallbackAccountsForPack,loadOutboundPack} from './outbound/packs.js';

const STATUTORY_LIABILITY_ROLES=new Set(['liability.tax_payable','liability.sales_tax_payable','liability.payroll_payable']);
export const hasCodingStatutorySource = matchedDocument => Boolean(matchedDocument
  && ['confirmed','auto_matched'].includes(matchedDocument.match_status)
  && ['supplier_bill','payment_confirmation','tax_notice','tax_return','statutory_notice'].includes(matchedDocument.document_type));
// The canonical account role establishes a liability settlement, never the bank
// description. A current source relationship supplies its supporting notice.
// Notices use the existing supplier_bill/payment_confirmation families; do not
// invent a filing type from the filename or counterparty.
export function codingStatutoryEvidenceGap({transaction={},suggestion=transaction.ai_suggestion||{},matchedDocument=null,accountRole=null,identifiedObligation=false}={}) {
  if (!(Number(transaction.money_out)>0) || Number(transaction.money_in)>0) return false;
  const name=suggestion.proposed_account || suggestion.account_name || transaction.account_name || transaction.account_code;
  const jurisdiction=suggestion.coding_policy?.jurisdiction;
  const role=accountRole || roleForSeedName(name) || (jurisdiction?fallbackAccountsForPack(loadOutboundPack(jurisdiction)).find(account=>account.name===name)?.role:null);
  if (!STATUTORY_LIABILITY_ROLES.has(role)) return false;
  if (identifiedObligation===true) return false;
  return !hasCodingStatutorySource(matchedDocument);
}
