// The strong coder selects source-line handles and chart accounts. This reader
// binds them to persisted amounts; the existing transaction journal writer posts.
import { currentCodingEvidence, codingEvidenceDigest } from './codingEvidence.js';
import { buildDonnaLedgerWriteback } from '../donnaLedgerWriteback.js';
import { roleForSeedName, roleMeta } from '../accountRoles.js';
import { documentSourceComponents, allocationAccountClassConflict } from '../documentAllocationComponents.js';
import { executePostingPolicyOperation } from '../postingPolicy.js';

// A singleton whole-invoice assignment is the ordinary single-account verdict
// expressed redundantly. Validate equivalence; never choose a different account,
// tax treatment, amount or source. True component splits retain their contract.
export const singleAccountAllocationReceipt = ({ document, transaction, postingContext, coding }) => {
  const suggestion = transaction.ai_suggestion;
  const selected = suggestion?.document_allocations;
  const role = roleForSeedName(suggestion?.proposed_account);
  if (postingContext.policy.jurisdiction !== 'fi' || suggestion?.posting_requirement !== 'document_allocation'
    || !['supplier_bill','sales_invoice'].includes(document?.document_type)
    || !['confirmed','auto_matched'].includes(document.match_status) || document.matched_line_id
    || document.lines?.length !== 1 || !Array.isArray(selected) || selected.length !== 1
    || !coding || (coding.account_name || coding.xero_account_name || coding.proposed_account) !== suggestion.proposed_account
    || !selected[0] || selected[0].line_handle !== 'line_1' || selected[0].account !== suggestion.proposed_account
    || (selected[0].tax_treatment && selected[0].tax_treatment !== suggestion.tax_treatment)
    || !['expense','revenue'].includes(roleMeta(role)?.class)
    || ['expense.payroll','expense.interest','revenue.interest'].includes(role)
    || suggestion.evidence_digest !== codingEvidenceDigest(document)) return null;
  const net=Number(document.lines[0].amount), tax=Number(document.tax_amount), total=Number(document.total_amount);
  const incoming=Number(transaction.money_in || 0), outgoing=Number(transaction.money_out || 0);
  const cents=value=>Math.round(value*100);
  if (document.tax_amount == null || ![net,tax,total,incoming,outgoing].every(Number.isFinite)
    || net<=0 || tax<0 || total<=0 || incoming<0 || outgoing<0 || (incoming>0)===(outgoing>0)
    || (document.document_type==='sales_invoice' ? incoming<=0 || roleMeta(role)?.class!=='revenue' : outgoing<=0 || roleMeta(role)?.class!=='expense')
    || !document.currency || !transaction.currency || String(document.currency).toUpperCase()!==String(transaction.currency).toUpperCase()
    || cents(net)+cents(tax)!==cents(total) || cents(incoming+outgoing)!==cents(total)) return null;
  return { version:1, from:'document_allocation', to:'single_account',
    basis:'same_account_whole_single_line_document', document_id:document.document_id,
    document_line_id:document.lines[0].id, evidence_digest:suggestion.evidence_digest,
    account:suggestion.proposed_account, tax_treatment:suggestion.tax_treatment };
};

const refuse = message => { throw Object.assign(new Error(message), { code: 'TRANSACTION_DOCUMENT_ALLOCATION_INVALID', statusCode: 409 }); };
export const resolveDocumentAllocation = async ({ client, firmId, clientId, transaction, postingContext, ledgerAccounts, coding = null, onSingleAccount = null }) => {
  if (transaction.ai_suggestion_status && transaction.ai_suggestion_status !== 'auto_applied') return null;
  const suggestion = transaction.ai_suggestion;
  if (suggestion?.posting_requirement !== 'document_allocation') return null;
  const document = await currentCodingEvidence({ client, firmId, clientId, transactionId: transaction.id });
  if (!document || !['confirmed','auto_matched'].includes(document.match_status)
    || suggestion.evidence_digest !== codingEvidenceDigest(document)) refuse('The allocation needs the exact current settled document.');
  const ordinary = singleAccountAllocationReceipt({ document, transaction, postingContext, coding });
  if (ordinary) {
    const source = (await client.query(`select d.parse_status,
      (select count(*)::int from reconciliation_matches m where m.firm_id=$1 and m.client_id=$2
        and m.bank_transaction_id=$3 and m.status in ('confirmed','auto_matched','suggested')) as match_count
      from documents d where d.firm_id=$1 and d.client_id=$2 and d.id=$4`,
    [firmId,clientId,transaction.id,document.document_id])).rows[0];
    if (source?.parse_status !== 'completed' || source.match_count !== 1) refuse('Single-account equivalence requires one complete, unambiguous document match.');
    onSingleAccount?.(ordinary); return null;
  }
  const incoming = Number(transaction.money_in || 0), outgoing = Number(transaction.money_out || 0);
  const source = documentSourceComponents(document);
  if (document.matched_line_id || (incoming > 0) === (outgoing > 0)
    || String(document.currency).toUpperCase() !== String(transaction.currency).toUpperCase()
    || Math.round(Number(document.total_amount) * 100) !== Math.round((incoming + outgoing) * 100)
    || !source.complete) refuse(`The allocation requires complete source components matching this bank movement (${source.reason || 'amount_or_currency'}).`);
  const selected = suggestion.document_allocations;
  if (selected?.length === 1 && !selected[0]?.tax_treatment) refuse('A legacy singleton allocation must establish exact single-account equivalence; an explicit component tax decision is required otherwise.');
  if (!Array.isArray(selected) || selected.length < 1 || selected.length !== source.components.length
    || new Set(selected.map(item => item.line_handle)).size !== selected.length) refuse('Every document component must be allocated exactly once.');
  const allowed = new Set([...(postingContext.codingPolicy.accountOptions || []), ...ledgerAccounts.map(account => account.name)]);
  const lines = selected.map(item => {
    const component = source.components.find(line => line.line_handle === item.line_handle);
    if (!component || !allowed.has(item.account)) refuse('An allocation handle or account is outside the current evidence and chart.');
    const treatment = item.tax_treatment || suggestion.tax_treatment;
    if (!postingContext.policy.capabilities.sourceTaxPosting) refuse('Document component tax allocation requires a supported country posting policy.');
    const accountClass = roleMeta(roleForSeedName(item.account))?.class
      || ledgerAccounts.find(account => account.name === item.account || account.code === item.account)?.account_type;
    if (allocationAccountClassConflict({documentType:document.document_type,incoming,outgoing,accountClass})) {
      throw Object.assign(new Error('A positive invoice charge must use an account consistent with the issuer and payment direction. Reconsider the selected component account using the current source.'), {
        code: 'TRANSACTION_DOCUMENT_ALLOCATION_ACCOUNT_CONFLICT', statusCode: 409,
        details: { line_handle: item.line_handle, document_type: document.document_type, account: item.account,
          account_class: accountClass, direction: incoming > 0 ? 'receive' : 'spend' }
      });
    }
    const direction = accountClass === 'expense' ? 'in' : accountClass === 'revenue' ? 'out' : incoming > 0 ? 'out' : 'in';
    const tax = executePostingPolicyOperation(postingContext.policy, 'sourceTaxPosting', { taxTreatment: treatment, direction, gross: component.gross });
    if (tax.splitRequired && tax.controlAccounts?.some(account => account.name === item.account || account.code === item.account)) {
      throw Object.assign(new Error('The component account holds the purchase or sale net amount. Its VAT control leg is written separately; select the source-supported base account.'), {
        code: 'TRANSACTION_DOCUMENT_ALLOCATION_ACCOUNT_CONFLICT', statusCode: 409,
        details: { line_handle: item.line_handle, account: item.account, reason: 'tax_control_used_as_net_account' }
      });
    }
    const code = tax.code;
    if (!code) refuse('Every allocation needs an explicit supported tax treatment.');
    if (tax.rate > 0 && !component.source_tax_known) refuse('A tax-bearing allocation requires source tax evidence for that component.');
    const sourceRate = tax.sourceRate ?? tax.rate;
    if (tax.rate > 0 && component.rate != null && Math.abs(sourceRate - component.rate) > 0.00001) {
      throw Object.assign(new Error('The selected component tax rate differs from the source rate. Correct coding; do not request a replacement for an arithmetically valid source.'),
        { code: 'TRANSACTION_ALV_CODING_SOURCE_CONFLICT', statusCode: 409, details: { line_handle: item.line_handle, source_rate: component.rate, selected_rate: sourceRate } });
    }
    const coding = buildDonnaLedgerWriteback({ ledgerAccounts, jurisdiction: postingContext.policy.jurisdiction,
      transaction: { id: transaction.id, currency: transaction.currency,
        money_out: outgoing > 0 ? component.gross : 0, money_in: incoming > 0 ? component.gross : 0,
        proposed_account: item.account, account_code: item.account, tax_treatment: treatment } }).coding;
    coding.account_type ||= roleMeta(roleForSeedName(item.account))?.class || '';
    coding.xero_tax_type = tax.taxType;
    coding.tax_type = coding.xero_tax_type;
    const split = tax.split;
    if ((tax.splitRequired ?? tax.rate > 0) && !split) refuse('This component tax action requires a supported tax split.');
    if (tax.rate > 0 && sourceRate === 0 && Math.abs(component.source_tax) > 0.02) refuse('A self-assessed tax treatment cannot carry supplier-charged tax.');
    if (split && Math.abs(split.vat - component.source_tax) > 0.02) refuse('Component tax does not agree with its source-backed amount.');
    return { ...component, amount: component.gross, coding,
      tax_split: split ? { ...split, vat: component.source_tax, net: component.net } : null };
  });
  const previous = (await client.query(`select j.id from ledger_journals j
    where j.firm_id=$1 and j.client_id=$2 and j.status='posted' and j.source_id<>$3
      and not (j.source_id=any($5::text[]))
      and (j.source_id=$4 or exists (select 1 from reconciliation_matches m
        where m.firm_id=j.firm_id and m.client_id=j.client_id
          and m.matched_object_id=$4 and m.status in ('confirmed','auto_matched')
          and (m.bank_transaction_id=j.source_id or (m.payload->'reminder_obligation'->>'invoice_document_id'=j.source_id
            and m.payload->'reminder_obligation'->>'status'='applied')))) limit 1`,
    [firmId,clientId,transaction.id,document.document_id,transaction.jev_refund_group?.status === 'selected' ? transaction.jev_refund_group.transaction_ids : []])).rows[0];
  if (previous) refuse('This source is already recognized in the ledger. Settle its existing obligation instead of recognizing its components twice.');
  return { document_id: document.document_id, evidence_digest: suggestion.evidence_digest, source_tax: source.source_tax, lines };
};
