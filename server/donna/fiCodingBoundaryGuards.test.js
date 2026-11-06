// Frozen replay 2026-09-21 (runtime head 248951d2): the VR (row 25) and book
// (row 22) postings were strong_after_jev decisions that printed 10 % on 2025
// lines, and the ST1 shareholder receivable posted with the relationship
// unverified. Both are boundary guards on the strong coder's own output.
import test from 'node:test';
import assert from 'node:assert/strict';
import { suggestTransactionCoding } from './transactionLlm.js';
import { hasJevResolvedCoding } from './jevDecisionReceipt.js';
import { __shouldAutoApplyBatchSuggestion } from './db/coding.js';
import { evaluateCodingAutoPost, buildOwnerAsk } from './codingAutoPost.js';

const withStrongKey = async fn => {
  const saved = { OPENAI_API_KEY: process.env.OPENAI_API_KEY, OPENAI_MODEL: process.env.OPENAI_MODEL };
  process.env.OPENAI_API_KEY = 'synthetic-strong-key'; delete process.env.OPENAI_MODEL;
  try { await fn(); } finally { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
};
const strong = (output) => async (url) => {
  assert.match(String(url), /api\.openai\.com/);
  return { ok: true, status: 200, json: async () => ({ id: 'resp', output_text: JSON.stringify({ contact: '', support_note: '', ask_client_question: '', evidence_required: false,
    remember_candidate: false, merchant_pattern: '', auto_explain_limit: 0, confidence: 'high', materiality: 'low', reasoning: 'fixture', warnings: [], alternatives: [], document_allocations: [], ...output }) }) };
};
const fi = { clientProfile: { jurisdiction: 'fi', companyName: 'Synthetic Oy', entityType: 'fi-oy' }, xeroAccounts: [], clientRules: [], firmFacts: [], jevEnabled: false };
const held = (lines, extra = {}) => ({ document_id: 'src', filename: 'source.pdf', match_status: 'auto_matched', document_type: 'supplier_bill',
  total_amount: lines.reduce((s, l) => s + l.amount, 0), tax_amount: 0, parse_summary: { line_amounts_include_tax: true }, lines, ...extra });

test('FI strong coder: a historical rate without a stated basis is the document_discrepancy question, with a basis it posts, before the change it is current', () => withStrongKey(async () => {
  const vr = { id: 'vr', description: 'VR-YHTYMA OYJ', money_out: 28.6, date: '2025-02-25', account_currency: 'EUR',
    matched_document: held([{ id: 'l1', description: 'TAMPERE-HELSINKI EKO', amount: 28.6, tax_rate: 10 }]) };
  const printed = await suggestTransactionCoding({ ...fi, transaction: vr, fetchImpl: strong({ proposed_account: 'Travel', tax_treatment: 'ALV 10 %', posting_requirement: 'single_account', historical_rate_basis: '' }) });
  assert.equal(printed.tax_treatment, 'ALV 10 %');
  assert.equal(printed.posting_requirement, 'document_discrepancy');
  assert.equal(printed.evidence_required, true);
  assert.deepEqual(printed.historical_rate_guard, { treatments: ['ALV 10 %'], business_date: '2025-02-25', basis: '', verified_source: true, constraint: 'historical_rate_basis_unestablished' });
  assert.match(printed.ask_client_question, /source\.pdf prints ALV 10 %, a rate that was not in force on 2025-02-25/);
  assert.equal(hasJevResolvedCoding(printed), false);
  assert.equal(__shouldAutoApplyBatchSuggestion(vr, printed), false);
  const verdict = evaluateCodingAutoPost({ suggestion: printed, amount: 28.6, hasDocMatch: true });
  assert.equal(verdict.action, 'owner_ask'); assert.equal(verdict.reason, 'coding_document_discrepancy');
  assert.equal(buildOwnerAsk({ reason: verdict.reason, suggestion: printed, line: vr }).evidence_type, 'document_discrepancy');
  // The model's own timing_not_established is the same question.
  const unknown = await suggestTransactionCoding({ ...fi, transaction: vr, fetchImpl: strong({ proposed_account: 'Travel', tax_treatment: 'ALV 10 %', posting_requirement: 'single_account', historical_rate_basis: 'timing_not_established' }) });
  assert.equal(unknown.posting_requirement, 'document_discrepancy');
  // An established basis is a complete action and rides the receipt.
  const advance = await suggestTransactionCoding({ ...fi, transaction: vr, fetchImpl: strong({ proposed_account: 'Travel', tax_treatment: 'ALV 10 %', posting_requirement: 'single_account', historical_rate_basis: 'advance_paid_before_rate_change' }) });
  assert.equal(advance.posting_requirement, 'single_account');
  assert.equal(advance.historical_rate_basis, 'advance_paid_before_rate_change');
  assert.equal(advance.historical_rate_guard, undefined);
  assert.equal(advance.evidence_required, false);
  // Before the rate change 10 % is current: no basis is asked for.
  const earlier = await suggestTransactionCoding({ ...fi, transaction: { ...vr, date: '2024-12-15' }, fetchImpl: strong({ proposed_account: 'Travel', tax_treatment: 'ALV 10 %', posting_requirement: 'single_account', historical_rate_basis: '' }) });
  assert.equal(earlier.posting_requirement, 'single_account'); assert.equal(earlier.historical_rate_guard, undefined);
  // 2026: 14 % becomes historical too; 25,5 % is unaffected.
  const later = await suggestTransactionCoding({ ...fi, transaction: { ...vr, date: '2026-03-02' }, fetchImpl: strong({ proposed_account: 'Travel', tax_treatment: 'ALV 14 %', posting_requirement: 'single_account', historical_rate_basis: '' }) });
  assert.deepEqual(later.historical_rate_guard.treatments, ['ALV 14 %']);
  const standard = await suggestTransactionCoding({ ...fi, transaction: { ...vr, date: '2026-03-02' }, fetchImpl: strong({ proposed_account: 'Travel', tax_treatment: 'ALV 25,5 %', posting_requirement: 'single_account', historical_rate_basis: '' }) });
  assert.equal(standard.historical_rate_guard, undefined);
}));

test('FI strong coder: one historical component holds a whole document allocation', () => withStrongKey(async () => {
  const book = { id: 'book', description: 'SUOMALAINEN KIRJAKAUPPA', money_out: 58.46, date: '2025-02-18', account_currency: 'EUR',
    matched_document: held([{ id: 'l1', description: 'Kynät', amount: 12.55, tax_rate: 25.5 }, { id: 'l2', description: 'Paperi', amount: 18.9, tax_rate: 25.5 },
      { id: 'l3', description: 'Kansiot', amount: 12, tax_rate: 25.5 }, { id: 'l4', description: 'Kirja', amount: 15.01, tax_rate: 10 }], { tax_amount: 10.19 }) };
  const allocations = [1, 2, 3].map(i => ({ line_handle: `line_${i}`, account: 'Office expenses', tax_treatment: 'ALV 25,5 %' }))
    .concat([{ line_handle: 'line_4', account: 'Professional fees', tax_treatment: 'ALV 10 %' }]);
  const coding = await suggestTransactionCoding({ ...fi, transaction: book, fetchImpl: strong({ proposed_account: 'Office expenses', tax_treatment: 'ALV-tarkistus', posting_requirement: 'document_allocation', document_allocations: allocations, historical_rate_basis: '' }) });
  assert.equal(coding.posting_requirement, 'document_discrepancy');
  assert.deepEqual(coding.historical_rate_guard.treatments, ['ALV 10 %']);
  assert.equal(coding.document_allocations.length, 4, 'the model\'s allocation stays visible on the receipt');
  assert.equal(hasJevResolvedCoding(coding), false);
  assert.equal(__shouldAutoApplyBatchSuggestion(book, coding), false);
}));

test('FI strong coder: a related-party receivable from a private-use source needs the relationship from the owner', () => withStrongKey(async () => {
  const st1 = { id: 'st1', description: 'ST1 TAMPERE', money_out: 62.4, date: '2025-02-12', account_currency: 'EUR',
    matched_document: held([{ id: 'l1', description: 'Bensiini 95', amount: 62.4, tax_rate: 25.5 }],
      { document_type: 'receipt', parse_summary: { line_amounts_include_tax: true, source_business_use: { classification: 'personal', source_quote: 'yksityiskäyttö M.L.' } } }) };
  const receivable = { proposed_account: 'Shareholder receivable', tax_treatment: 'Ei ALV-käsittelyä', posting_requirement: 'single_account',
    warnings: ['If M.L. is not actually a shareholder, the firm may need to reclassify.'] };
  const posted = await suggestTransactionCoding({ ...fi, transaction: st1, fetchImpl: strong(receivable) });
  assert.equal(posted.proposed_account, 'Shareholder receivable');
  assert.equal(posted.posting_requirement, 'owner_fact');
  assert.equal(posted.evidence_required, true);
  assert.deepEqual(posted.related_party_relationship_guard.accounts, ['Shareholder receivable']);
  assert.equal(posted.related_party_relationship_guard.constraint, 'related_party_relationship_unevidenced');
  assert.match(posted.ask_client_question, /yksityiskäyttö M\.L\..*shareholder, director or employee/);
  assert.equal(posted.source_business_use_guard, undefined, 'a receivable is not the expense the existing use guard catches');
  assert.equal(__shouldAutoApplyBatchSuggestion(st1, posted), false);
  const verdict = evaluateCodingAutoPost({ suggestion: posted, amount: 62.4, hasDocMatch: true });
  assert.equal(verdict.action, 'owner_ask'); assert.equal(verdict.reason, 'coding_owner_fact');
  assert.equal(buildOwnerAsk({ reason: verdict.reason, suggestion: posted, line: st1 }).evidence_type, 'business_purpose');
  // The owner's attributable answer establishes it: the receivable posts.
  const explained = await suggestTransactionCoding({ ...fi, transaction: st1, fetchImpl: strong({ ...receivable, source_identity_resolution: 'owner_explained_relationship' }) });
  assert.equal(explained.posting_requirement, 'single_account');
  assert.equal(explained.related_party_relationship_guard, undefined);
  // A business-use source with the same account is not this guard's case.
  const business = await suggestTransactionCoding({ ...fi, transaction: { ...st1, matched_document: held([{ id: 'l1', description: 'Bensiini 95', amount: 62.4, tax_rate: 25.5 }], { document_type: 'receipt' }) }, fetchImpl: strong(receivable) });
  assert.equal(business.related_party_relationship_guard, undefined);
}));
