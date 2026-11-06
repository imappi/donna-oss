// U08-S2: deterministic eligibility/arithmetic over an attributed factual
// decision. No inference from descriptions, vendors or missing profile flags.
import { readAccountingProfile } from '../../../src/lib/accountingProfile.js';
import { ledgerAccountTypeFor } from '../ledger.js';
import { toIsoDay, toUtcIsoDay } from '../dates.js';
import { resolveAeVatRegistrationOnDate } from './vatRegistration.js';
import { AE_VAT_INPUT_ROLE, AE_VAT_OUTPUT_ROLE } from './vatCodes.js';
import { taxFactsDigest } from '../db/taxPostingFacts.js';

const refuse = (suffix, message) => { throw Object.assign(new Error(message), {
  code: `TRANSACTION_AE_VAT_${suffix}`, statusCode: 409, jurisdiction: 'ae' }); };
const cents = value => {
  if (!/^(0|[1-9]\d*)(\.\d{1,2})?$/.test(String(value))) return null;
  const n = Math.round(Number(value) * 100);
  return Number.isSafeInteger(n) ? n : null;
};
const day = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && toUtcIsoDay(value) === value;

export const aeNativeStandardSplit = ({ entry, coding, transaction, taxCodingEnabled, taxPostingContext } = {}) => {
  const ctx = taxPostingContext;
  const f = ctx?.facts;
  if (!taxCodingEnabled || !ctx || !f) refuse('POSTING_UNSUPPORTED',
    'Native UAE standard VAT posting requires enabled tax coding and attributed invoice, recovery and tax-point facts through the review correction. Nothing was posted.');
  const runtimeAuthority = f.authority_basis === 'config_plane:AE_VAT_FACT_AUTOMATION'
    && f.actor_id === 'ae_vat_fact_automation' && Boolean(f.model && f.context_digest) && ctx.runtimeAuthority;
  if (!ctx.authority || f.version !== 1 || !(f.authority_basis === 'transaction_review_correction' || runtimeAuthority)
    || !f.actor_id || f.actor_id === 'system' || !ctx.evidenceCurrent) refuse('FACTS_STALE',
    'The UAE tax facts have no current attributed source/evidence receipt. Reconfirm the exact facts before posting.');
  if (ctx.profile.accounting_system !== 'none') refuse('CONNECTOR_UNSUPPORTED',
    'Native UAE standard VAT is not a supported external connector contract. Nothing was sent.');
  const date = toIsoDay(transaction.date || transaction.transaction_date);
  if (!day(f.date_of_supply) || !day(f.reporting_date) || f.date_of_supply !== date || f.reporting_date !== date) {
    refuse('TAX_POINT_UNSUPPORTED', 'This native slice requires an established tax point and recovery reporting date equal to the bank date; differing dates require the statutory period-allocation lane.');
  }
  if (date < '2026-01-01') refuse('TAX_POINT_UNSUPPORTED', 'This native contract supports tax points from 1 January 2026 only.');
  if (resolveAeVatRegistrationOnDate({ registration: ctx.profile.vat_registration, onDate: date }).registered !== true) {
    refuse('REGISTRATION_UNRESOLVED', 'A recorded UAE VAT registration must cover this tax point.');
  }
  const accounting = readAccountingProfile(ctx.profile);
  if (accounting.view.value !== 'management_books' || accounting.method.status !== 'stated'
    || accounting.method.value !== 'cash' || ctx.priorPost || ctx.issuedSettlement) {
    refuse('SCOPE_UNSUPPORTED', 'This native bank-line slice requires explicit cashbook basis and evidence not already posted or tied to an issued-invoice settlement.');
  }
  const evidence = ctx.evidence;
  if (transaction.currency !== 'AED' || (transaction.account_currency && transaction.account_currency !== 'AED')
    || evidence.currency !== 'AED') refuse('CURRENCY_UNSUPPORTED', 'Native UAE standard VAT supports AED source, invoice and control amounts only.');
  if (f.supply_class !== 'ordinary_domestic' || f.payment_method !== 'bank_transfer'
    || f.invoice_validity !== 'confirmed' || f.fully_paid !== true
    || evidence.duplicate_of || evidence.parse_status !== 'completed'
    || evidence.document_type !== (entry.direction === 'out' ? 'sales_invoice' : 'supplier_bill')) {
    refuse('SCOPE_UNSUPPORTED', 'This slice supports one fully paid ordinary domestic tax invoice paid by bank transfer; special supplies, cash, advances and adjustments require another lane.');
  }
  if (f.direction !== entry.direction) refuse('DIRECTION_MISMATCH', 'The factual supply direction differs from the coded transaction.');
  const targetName = coding.account_name || coding.xero_account_name || coding.proposed_account;
  const targetCode = coding.account_code || coding.xero_account_code;
  const targets = ctx.ledgerAccounts.filter(a => a.status === 'active' && (a.code
    ? a.code === targetCode
    : a.name === targetName && (!targetCode || targetCode === targetName)));
  const expectedType = entry.direction === 'out' ? 'revenue' : 'expense';
  if (targets.length !== 1 || targets[0].currency !== 'AED' || ledgerAccountTypeFor(coding) !== expectedType
    || ledgerAccountTypeFor(targets[0]) !== expectedType) refuse('ACCOUNT_UNRESOLVED',
    'Standard VAT requires one existing typed revenue/expense account in the current chart.');
  if (entry.direction === 'in' && (f.input_recovery?.basis !== 'direct_taxable'
    || f.input_recovery?.recovery_bps !== 10000 || f.input_recovery?.blocked !== false
    || f.input_recovery?.personal_use !== false || f.input_recovery?.supply_integrity !== 'verified'
    || !String(f.input_recovery?.verification_evidence || '').trim())) {
    refuse('RECOVERY_UNSUPPORTED', 'Full input recovery requires explicit direct-taxable use, no blocked/personal use, and documented supply-integrity verification. Partial and unestablished recovery are unsupported.');
  }
  const net = cents(f.taxable_amount), vat = cents(f.vat_amount), gross = cents(evidence.total_amount);
  const bank = cents(entry.direction === 'out' ? transaction.money_in : transaction.money_out);
  if (Number(entry.direction === 'out' ? transaction.money_out || 0 : transaction.money_in || 0) !== 0
    || net === null || vat === null || gross === null || net <= 0 || vat <= 0
    || net + vat !== gross || gross !== bank || cents(evidence.tax_amount) !== vat
    || Math.round(net * 5 / 100) !== vat) refuse('AMOUNT_MISMATCH',
    'The stated invoice net, 5% VAT, gross and full bank settlement must agree exactly to the fils.');
  const controls = ctx.ledgerAccounts.filter(a => a.canonical_role === 'liability.sales_tax_payable' && a.status === 'active');
  const control = controls[0];
  if (controls.length !== 1 || (!control.code && !control.name) || ledgerAccountTypeFor(control) !== 'liability'
    || control.normal_balance !== 'credit' || control.currency !== 'AED') refuse('CONTROL_UNRESOLVED',
    'The current chart must contain exactly one active AED liability.sales_tax_payable control with liability type and credit normal balance.');
  return { net: net / 100, vat: vat / 100,
    role: entry.direction === 'in' ? AE_VAT_INPUT_ROLE : AE_VAT_OUTPUT_ROLE,
    controlAccount: { code: control.code, name: control.name, account_type: control.type || control.account_type, normal_balance: control.normal_balance },
    tax_point: { date_of_supply: f.date_of_supply, reporting_date: f.reporting_date,
      document_id: f.document_id, evidence_digest: f.evidence_digest, actor_id: f.actor_id,
      authority_basis: f.authority_basis, input_recovery: f.input_recovery || null,
      ...(runtimeAuthority ? { facts_version: f.version, facts_digest: taxFactsDigest(f), context_digest: f.context_digest, model: f.model } : {}) } };
};
