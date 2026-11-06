// Country-owned composition of the existing ALV posting rules. No writer lives here.
import {
  ALV_SPLIT_CONTROL, FINLAND_ALV_CODING_FLAG_KEY, KNOWN_ALV_CODES,
  alvDirectionForTransaction, alvOutputCodeForRate, applyAlvCodingToCoding, resolveAlvCode,
  resolveAlvSplitForPosting, splitAlvGross, withFinlandAlvSettlementAccount, resolveAlvEntry
} from './alvCodes.js';
import { SALES_INVOICE_RECEIVABLE_ACCOUNT, SUPPLIER_BILL_PAYABLES_ACCOUNT, ledgerAccountTypeFor } from '../ledger.js';
import { documentSourceComponents } from '../documentAllocationComponents.js';
import { planArSettlement } from './issuedInvoiceSettlement.js';

const round2 = (value) => Math.round((Number(value) + Number.EPSILON) * 100) / 100;
const refuse = (code, message) => { throw Object.assign(new Error(message), { code, statusCode: 409 }); };
// Input codes with a tax return box assess tax on the buyer's net base;
// their statutory rate is not VAT charged by the supplier.
const supplierTaxRate = entry => entry?.direction === 'in' && entry.return_boxes?.tax ? 0 : entry?.rate;
const taxPosting = Object.freeze({ outputCodeForRate: alvOutputCodeForRate, control: ALV_SPLIT_CONTROL.out });

export const FI_POSTING_POLICY = Object.freeze({
  jurisdiction: 'fi', policyId: 'fi_posting', policyVersion: 1,
  postingTaxCodingFlagKey: FINLAND_ALV_CODING_FLAG_KEY,
  supplierBillAdmissionFlagKey: 'FINLAND_EINVOICE_RECEIVE', supplierBillNeedsChart: false,
  nativeTaxCodePrefixes: Object.freeze(['ALV_']), nativeTaxCodes: Object.freeze([...KNOWN_ALV_CODES]),
  salesInvoiceChannels: Object.freeze(['finland']), salesTaxControlRole: null,
  capabilities: Object.freeze({ prepareLedgerAccounts: true, enrichCoding: true, transactionSplit: true,
    salesInvoiceTaxPosting: true, supplierBillTaxPosting: true,
    planArSettlement: true, arSettlementReceivableCoding: true, assertPostableTaxCoding: true, sourceTaxPosting: true }),
  arSettlementFlagKey: 'FINLAND_AR_SETTLEMENT',
  planArSettlement,
  arSettlementReceivableCoding: () => ({
    account_code: SALES_INVOICE_RECEIVABLE_ACCOUNT.code,
    account_name: SALES_INVOICE_RECEIVABLE_ACCOUNT.name,
    account_type: SALES_INVOICE_RECEIVABLE_ACCOUNT.type,
    account_label: `${SALES_INVOICE_RECEIVABLE_ACCOUNT.code} · ${SALES_INVOICE_RECEIVABLE_ACCOUNT.name}`
  }),
  prepareLedgerAccounts: ({ ledgerAccounts = [], taxCodingEnabled = false } = {}) =>
    taxCodingEnabled ? withFinlandAlvSettlementAccount(ledgerAccounts) : ledgerAccounts,
  enrichCoding: ({ coding = {}, sourceCoding = coding, transaction = {}, taxCodingEnabled = false } = {}) =>
    taxCodingEnabled ? applyAlvCodingToCoding({ coding: { ...coding,
      // Account defaults are context, never a replacement for this line's
      // authored tax decision. The preview may already contain that default.
      tax_type: sourceCoding.tax_type || sourceCoding.xero_tax_type || '',
      xero_tax_type: sourceCoding.xero_tax_type || sourceCoding.tax_type || '',
      tax_treatment: sourceCoding.tax_treatment || ''
    }, transaction }) : coding,
  // RT-23 — the AR/bank-line twin of SUPPLIER_BILL_ALV_SPLIT_UNSUPPORTED. After
  // enrichCoding, a coding that targets a P&L account (revenue or expense —
  // the legs the ALV return reads) for an ALV-coding client must carry a
  // resolved ALV code; 'ALV-tarkistus' (the coder's own unsure marker), an
  // unknown prose treatment or a missing one refuses by name. Balance-sheet
  // codings (a loan repayment, TyEL payable, owner funds) are not VAT legs
  // and post as before; an ALV control account already carries 'NONE'.
  assertPostableTaxCoding: ({ coding = {}, transaction = {}, taxCodingEnabled = false, matchedDocument: document = null } = {}) => {
    if (!taxCodingEnabled) return coding;
    const suggestion = transaction.ai_suggestion || {};
    // The component writer validates every selected code against the locked source.
    // Its complete plan, rather than the summary account's tax, owns this journal.
    if (suggestion.posting_requirement === 'document_allocation') return coding;
    const stamped = String(coding.xero_tax_type || coding.tax_type || '').trim().toUpperCase();
    const entry = resolveAlvEntry(stamped);
    if (['revenue', 'expense'].includes(ledgerAccountTypeFor(coding)) && entry && entry.direction !== 'both' && entry.direction !== alvDirectionForTransaction(transaction, coding)) {
      refuse('TRANSACTION_ALV_ACCOUNT_INCOMPATIBLE',
        'The explicit ALV code conflicts with the resolved expense or revenue account. Correct the coding before posting.');
    }
    const gross = Math.abs(Number(transaction.money_out || 0)) || Math.abs(Number(transaction.money_in || 0));
    // Enrichment deliberately stamps control settlements NONE. Do not revive
    // the discarded rate-bearing suggestion while checking source evidence.
    const selectedCode = stamped === 'NONE' ? 'NONE' : resolveAlvCode({ taxType: coding.xero_tax_type || coding.tax_type || '',
      taxTreatment: transaction.tax_treatment || suggestion.tax_treatment || '', direction: alvDirectionForTransaction(transaction, coding) });
    const selectedEntry = resolveAlvEntry(selectedCode);
    // A bank descriptor is not purchase-tax evidence, even on an immaterial line.
    if (selectedEntry?.direction === 'in' && selectedEntry.rate > 0 && (!document || !['confirmed', 'auto_matched'].includes(document.match_status))) {
      refuse('TRANSACTION_ALV_EVIDENCE_REQUIRED', 'A deductible VAT posting needs the usable source document and its current settled relationship.');
    }
    if (document && !document.matched_line_id && suggestion.posting_requirement !== 'document_allocation'
      && Math.round(Number(document.total_amount) * 100) === Math.round(gross * 100)) {
      const source = documentSourceComponents(document);
      if (source.complete && source.components.some(line => line.rate != null && selectedEntry?.rate > 0 && Math.abs(line.rate - supplierTaxRate(selectedEntry)) > 0.00001)) {
        throw Object.assign(new Error('The selected whole-document tax treatment differs from the source components. Recode the valid source with its component treatments; a replacement receipt is not required.'),
          { code: 'TRANSACTION_ALV_CODING_SOURCE_CONFLICT', statusCode: 409,
            details: { source_validation: source, selected_tax_treatment: selectedCode, recovery: 'recode_current_evidence' } });
      }
      const statedTax = source.complete ? source.source_tax : document.tax_amount;
      const split = splitAlvGross({ gross, code: selectedCode });
      const expectedSupplierTax = selectedEntry?.direction === 'in' && selectedEntry.return_boxes?.tax ? 0 : split?.vat;
      if (statedTax != null && expectedSupplierTax != null && Math.abs(expectedSupplierTax - Number(statedTax)) > 0.02) {
        throw Object.assign(new Error(`The source states ${statedTax} VAT but the selected coding calculates ${expectedSupplierTax}. Reconsider the coding using the source validation; this comparison does not establish a source arithmetic defect.`),
          { code: source.complete || document.parse_summary?.totals_validation?.matches ? 'TRANSACTION_ALV_CODING_SOURCE_CONFLICT' : 'TRANSACTION_ALV_DOCUMENT_AMOUNT_MISMATCH', statusCode: 409,
            details: { source_validation: source, selected_tax_treatment: selectedCode, recovery: 'recode_current_evidence' } });
      }
    }
    if (!['revenue', 'expense'].includes(ledgerAccountTypeFor(coding))) return coding;
    if (stamped === 'NONE' || entry) return coding;
    // Resolvability, not stamping: a treatment enrichCoding would render to a
    // code passes even when the caller skipped enrichment; the unsure marker,
    // unknown prose and a missing treatment resolve to nothing.
    const code = resolveAlvCode({ taxType: stamped, taxTreatment: coding.tax_treatment || '', direction: alvDirectionForTransaction(transaction, coding) });
    if (code) return coding;
    const treatment = String(coding.tax_treatment || '').trim();
    refuse('TRANSACTION_ALV_TREATMENT_UNRESOLVED',
      `An ALV-coding client's ${ledgerAccountTypeFor(coding)} post requires a resolved ALV treatment — the coding says ${treatment ? `'${treatment}'` : 'nothing'}, which maps to no ALV code. Posting uncoded would leave the ALV return blind to this line; the line stays proposed until the treatment is resolved.`);
  },
  sourceTaxPosting: ({ taxType = '', taxTreatment = '', direction = '', gross = 0 } = {}) => {
    const code = resolveAlvCode({ taxType, taxTreatment, direction });
    const entry = resolveAlvEntry(code);
    return { code, taxType: code === 'ALV_OUT_OF_SCOPE' ? 'NONE' : code,
      rate: entry?.rate ?? null, sourceRate: supplierTaxRate(entry) ?? null,
      inputDeductible: entry?.direction === 'in' && Number(entry.rate) > 0 && Boolean(entry.return_boxes?.deductible),
      inputTaxRoles: ['alv_input', ALV_SPLIT_CONTROL.in.role],
      controlAccounts: Object.values(ALV_SPLIT_CONTROL).map(control => control.account),
      splitRequired: ['standard','reduced'].includes(entry?.kind) && entry.rate > 0,
      split: splitAlvGross({ gross, code }) };
  },
  transactionSplit: resolveAlvSplitForPosting,
  salesInvoiceTaxPosting: ({ channel = 'finland' } = {}) => channel === 'finland' ? taxPosting : null,
  supplierBillTaxPosting: ({ verdict = {}, document = {}, taxCodingEnabled = false } = {}) => {
    let expenseTaxType = verdict.tax_type || verdict.xero_tax_type;
    if (!taxCodingEnabled) return { expenseTaxType, alvSplit: null, payablesAccount: SUPPLIER_BILL_PAYABLES_ACCOUNT };
    const code = resolveAlvCode({ taxType: expenseTaxType || '', taxTreatment: verdict.tax_treatment || '', direction: 'in' });
    if (!code) refuse('SUPPLIER_BILL_ALV_SPLIT_UNSUPPORTED', "An ALV-coding client's AP post requires a resolvable ALV treatment on the coding verdict — posting gross would forfeit the input-VAT deduction.");
    expenseTaxType = code;
    let alvSplit = splitAlvGross({ gross: document.total_amount, code });
    const statedVat = round2(document.tax_amount);
    if (alvSplit && statedVat > 0) {
      if (Math.abs(statedVat - alvSplit.vat) > 0.02) refuse('SUPPLIER_BILL_ALV_AMOUNT_MISMATCH',
        `The bill states ${statedVat} VAT but the ${alvSplit.rate}% coding computes ${alvSplit.vat} — refusing rather than guessing which is right.`);
      alvSplit = { ...alvSplit, vat: statedVat, net: round2(round2(document.total_amount) - statedVat) };
    }
    return { expenseTaxType, alvSplit, payablesAccount: SUPPLIER_BILL_PAYABLES_ACCOUNT };
  }
});
