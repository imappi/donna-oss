// Posting uses the persisted country and the same coding lineage as judgment.
// Callers own the transaction; a SHARE lock prevents profile edits until commit.
import { createHash } from 'node:crypto';
import { clientFlagActs } from '../clientConfig.js';
import { codingPolicyReceipt, assertCodingPolicyReceipt, CodingPolicyError, isCodingPolicyError } from '../codingPolicy.js';
import { readClientCodingContextWithClient } from './codingPolicyContext.js';
import { resolvePostingPolicy, PostingPolicyError } from '../postingPolicy.js';
import { codingInputFromTransaction } from '../xeroWriteback.js';
import { toIsoDay } from '../dates.js';

const canonical = (value) => {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  return value;
};
const digest = (value) => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');

const readPostingContextWithClient = async ({ client, firmId, clientId, businessDate, lockContext = false }) => {
  const { row, snapshot, codingPolicy } = await readClientCodingContextWithClient({
    client, firmId, clientId, businessDate, lockContext });
  const profile = row.profile || {};
  const policy = resolvePostingPolicy({ codingPolicy });
  const taxCodingEnabled = Boolean(policy.postingTaxCodingFlagKey && clientFlagActs({
    flagKey: policy.postingTaxCodingFlagKey, snapshot, envFallback: () => false
  }));
  const receipt = {
    version: 1, coding_policy: codingPolicyReceipt(codingPolicy),
    policy_id: policy.policyId, policy_version: policy.policyVersion,
    // Registration lives outside taxProfile too. Do not let an effective VAT,
    // ALV or GST registration edit survive a prepared posting unnoticed.
    profile_digest: digest(profile), tax_coding_enabled: taxCodingEnabled,
    settlement_flags: Object.fromEntries(['supplierBillAdmissionFlagKey', 'arSettlementFlagKey'].map((key) => [key,
      Boolean(policy[key] && clientFlagActs({ flagKey: policy[key], snapshot, envFallback: () => false }))]))
  };
  // The profile the receipt digests rides the context, so a country policy
  // reads registration from the same locked row (gb/postingPolicy.js).
  return { policy, codingPolicy, taxCodingEnabled, profile, receipt, row, snapshot };
};

export const resolvePostingContextWithClient = async (args) => {
  try {
    return await readPostingContextWithClient(args);
  } catch (error) {
    if (isCodingPolicyError(error) || error instanceof PostingPolicyError) throw error;
    // The same durable recovery path as coding owns transient read failures.
    // A database outage is not missing owner identity or a disabled tax flag.
    throw new CodingPolicyError('coding_policy_unavailable', {
      details: { cause: error.code || 'configuration_read_failed' }
    });
  }
};

export const assertPostingContextReceipt = (context, receipt) => {
  if (!receipt || digest(receipt) !== digest(context.receipt)) {
    throw new CodingPolicyError('jurisdiction_context_conflict', {
      jurisdiction: context.policy.jurisdiction, details: { reason: 'posting_policy_receipt_conflict' }
    });
  }
};

// Only the named review writer stamps an accepted policy after validating the
// applied correction under lock. A label mismatch is never proof of human authority.
export const assertPostingSuggestionLineage = (context, transaction) => {
  const receipt = transaction.accepted_coding_policy || transaction.ai_suggestion?.coding_policy;
  if (receipt) assertCodingPolicyReceipt(context.codingPolicy, receipt);
};

export const postingSourceReceipt = (transaction) => digest({
  id: transaction.id, client_id: transaction.client_id,
  date: toIsoDay(transaction.date || transaction.transaction_date),
  money_in: Number(transaction.money_in || 0), money_out: Number(transaction.money_out || 0),
  currency: transaction.currency ?? null, account_currency: transaction.account_currency ?? null,
  bank_hints: ['xero_bank_account_code', 'xeroBankAccountCode', 'bank_account_code', 'bankAccountCode',
    'source_account_code', 'sourceAccountCode', 'xero_bank_account_id', 'xeroBankAccountId',
    'bank_account_id', 'bankAccountId'].map((key) => transaction[key] ?? null),
  coding_state: transaction.coding_state || null,
  coding: codingInputFromTransaction(transaction),
  account_code: transaction.account_code || null, category: transaction.category || null,
  accepted_coding_policy: transaction.accepted_coding_policy || null,
  accepted_coding_evidence: transaction.accepted_coding_evidence || null,
  ai_suggestion: transaction.ai_suggestion || null,
  proposed_account: transaction.proposed_account || null,
  tax_treatment: transaction.tax_treatment || null,
  tax_posting_facts: transaction.tax_posting_facts || null,
  tax_type: transaction.tax_type || null, xero_tax_type: transaction.xero_tax_type || null
});
export const assertPostingSourceReceipt = (transaction, receipt) => {
  if (receipt && postingSourceReceipt(transaction) !== receipt) {
    throw new CodingPolicyError('jurisdiction_context_conflict', { details: { reason: 'posting_source_changed' } });
  }
};
