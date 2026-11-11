// Whose money paid a document settled outside the bank feed, and the account
// its settlement entry credits (documentSettlementFunding.js), with the words
// and plans that carry the fact. Pure: no database, no provider.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DOCUMENT_SETTLEMENT_OWNER_FUNDS_ACCOUNT,
  resolveDocumentSettlementFunding,
  documentSettlementFundingOrRefusal
} from './documentSettlementFunding.js';
import { resolveMarketPostingAccounts } from './provisioningPolicyRegistry.js';
import { jevDispositionPlans } from './jevDisposition.js';
import { __GATHER_SQL, __buildSettlementProposalCard, __buildSettlementChecks } from './documentSettlementEntry.js';
import { __buildReversalProposalCard, __buildReversalChecks, __reversalReasonFor } from './documentSettlementReversal.js';
import { buildAskDraftInput } from './askPipeline.js';
import { buildLedgerJournalForDocumentSettlement } from './ledger.js';

const cash = (funding_source) => ({ disposition: 'auto_explain', settlement_channel: 'cash', funding_source });

test('the owner\'s funds credit 901 in every market; a personal card is the owner\'s funds', () => {
  for (const jurisdiction of ['fi', 'gb', 'sg', 'us', null]) {
    assert.deepEqual(resolveDocumentSettlementFunding({ disposition: cash('owner'), jurisdiction }),
      { funding_source: 'owner', account: DOCUMENT_SETTLEMENT_OWNER_FUNDS_ACCOUNT });
    assert.equal(resolveDocumentSettlementFunding({ disposition: { settlement_channel: 'personal_card' }, jurisdiction }).funding_source, 'owner');
  }
});

test('company cash credits the market\'s declared cash account (FI 1900), shaped as the declaration says', () => {
  const declared = resolveMarketPostingAccounts('fi').cashAccount();
  const { funding_source, account } = resolveDocumentSettlementFunding({ disposition: cash('company_cash'), jurisdiction: 'FI' });
  assert.equal(funding_source, 'company_cash');
  assert.deepEqual([account.code, account.name, account.type, account.normal_balance, account.canonical_role, account.statutory_group, account.line_role],
    [declared.code, declared.name, declared.account_type, declared.normal_balance, 'asset.cash', declared.statutory_group, 'bank']);
  assert.equal(declared.code, '1900');
});

test('a market that declares no cash account gets no substitute (GB, SG): a named refusal', () => {
  for (const jurisdiction of ['gb', 'sg']) {
    assert.equal(resolveMarketPostingAccounts(jurisdiction), null, `${jurisdiction} declares no posting accounts`);
    assert.throws(() => resolveDocumentSettlementFunding({ disposition: cash('company_cash'), jurisdiction }),
      (error) => error.code === 'DOCUMENT_SETTLEMENT_CASH_ACCOUNT_UNDECLARED' && error.statusCode === 409 && /declares no cash account/.test(error.message));
    const read = documentSettlementFundingOrRefusal({ disposition: cash('company_cash'), jurisdiction });
    assert.deepEqual([read.account, read.refusal.code], [null, 'DOCUMENT_SETTLEMENT_CASH_ACCOUNT_UNDECLARED']);
  }
});

test('cash with no funding fact still refuses with the existing code', () => {
  for (const funding of ['unknown', undefined]) {
    assert.throws(() => resolveDocumentSettlementFunding({ disposition: cash(funding), jurisdiction: 'fi' }), { code: 'DOCUMENT_SETTLEMENT_FUNDING_REQUIRED' });
  }
});

test('the journal credits the cash account as a debit-normal bank-side line, and an owner-funds line exactly as before', () => {
  const document = { id: 'doc', document_date: '2025-02-25', total_amount: 22, currency: 'EUR', vendor_name: 'Kukkakauppa' };
  const expenseAccount = { code: '7740', name: 'Toimistotarvikkeet ja -kulut', type: 'expense' };
  const fiCash = resolveDocumentSettlementFunding({ disposition: cash('company_cash'), jurisdiction: 'fi' }).account;
  const credit = buildLedgerJournalForDocumentSettlement({ document, expenseAccount, ownerFundsAccount: fiCash }).lines.at(-1);
  assert.deepEqual([credit.direction, credit.credit, credit.account.code, credit.account.role, credit.account.normal_balance, credit.account.statutory_group],
    ['credit', 22, '1900', 'bank', 'debit', 'cash_and_bank']);
  const owner = buildLedgerJournalForDocumentSettlement({ document, expenseAccount, ownerFundsAccount: DOCUMENT_SETTLEMENT_OWNER_FUNDS_ACCOUNT }).lines.at(-1);
  assert.deepEqual(owner.account, { role: 'owner_funds', code: '901', name: 'Director loan', type: 'liability', normal_balance: 'credit', tax_type: 'NONE',
    xero_account_id: '', canonical_role: 'liability.director_loan', label: '901 · Director loan' });
});

test('the entry lane gathers company cash and names the cash account on its card; a refusal is a failing check', () => {
  assert.match(__GATHER_SQL, /funding_source' in \('owner', 'company_cash'\)/);
  const document = { id: 'doc', total_amount: 22, currency: 'EUR', payment_status: 'paid' };
  const disposition = cash('company_cash');
  const proposal = { account: 'Office expenses', confidence: 0.95 };
  const args = { document, proposal, confidenceFloor: 0.75, authorityBasis: 'owner_reply', materialityCeiling: 500 };
  const fi = documentSettlementFundingOrRefusal({ disposition, jurisdiction: 'fi' });
  const card = __buildSettlementProposalCard({ document, disposition, proposal, ownerFundsLabel: '901 · Director loan', authorityBasis: 'owner_reply',
    checks: __buildSettlementChecks(args), model: 'm', funding: fi });
  assert.match(card.before_after[0].after.settlement_journal, /CR 1900 · Käteinen raha/);
  assert.deepEqual([card.detail.funding_source, card.detail.settlement_account, card.detail.owner_funds_account], ['company_cash', '1900 · Käteinen raha', undefined]);
  assert.equal(__buildSettlementChecks(args).status, 'pass');
  const gb = documentSettlementFundingOrRefusal({ disposition, jurisdiction: 'gb' });
  const refused = __buildSettlementChecks({ ...args, fundingRefusal: gb.refusal });
  assert.equal(refused.status, 'fail');
  assert.match(refused.checks.find((c) => c.name === 'settlement_funding_account').detail, /declares no cash account/);
  const gbCard = __buildSettlementProposalCard({ document, disposition, proposal, ownerFundsLabel: '901 · Director loan', authorityBasis: 'owner_reply', checks: refused, model: 'm', funding: gb });
  assert.match(gbCard.before_after[0].after.settlement_journal, /CR no declared cash account/);
  // An owner-funded card is unchanged.
  const owner = __buildSettlementProposalCard({ document, disposition: cash('owner'), proposal, ownerFundsLabel: '901 · Director loan', authorityBasis: 'owner_reply',
    checks: __buildSettlementChecks(args), model: 'm', funding: documentSettlementFundingOrRefusal({ disposition: cash('owner'), jurisdiction: 'fi' }) });
  assert.deepEqual([owner.detail.owner_funds_account, owner.detail.funding_source, owner.detail.settlement_account], ['901 · Director loan', undefined, undefined]);
  assert.equal(__buildSettlementChecks(args).checks.some((c) => c.name === 'settlement_funding_account'), false, 'no new check row on an owner-funded report');
});

test('the Jev first-line reader can record company cash for a money-out document, never for money in', () => {
  const answered = jevDispositionPlans({ kind: 'document', amount: 1000, materialityCeiling: 500, ownerReply: { answeredEvidenceType: 'payment_method' } });
  assert.deepEqual(answered.resolve_company_cash.semantic, { materiality: 'material', expense_kind: 'settled_business_document', settlement_channel: 'cash',
    line_identified: true, disposition: 'auto_explain', funding_source: 'company_cash' });
  assert.ok(answered.ask_cash_funding, 'an unclear answer can still be asked about');
  assert.equal(jevDispositionPlans({ kind: 'document', amount: 1000, materialityCeiling: 500 }).resolve_company_cash, undefined, 'material, unprompted: not offered');
  assert.equal(jevDispositionPlans({ kind: 'document', direction: 'money_in', amount: 10, materialityCeiling: 500 }).resolve_company_cash, undefined);
});

test('the reversal says which entry it reverses', () => {
  const document = { id: 'doc', vendor_name: 'Kukkakauppa Kukka-Aho', total_amount: 22, currency: 'EUR',
    settlement_entry: { journal_id: 'lj-1', funding_source: 'company_cash', settlement_account: '1900 · Käteinen raha', expense_account: '7740 · Toimistotarvikkeet ja -kulut' } };
  const match = { match_id: 'm-1', bank_transaction_id: 'tx-1', match_status: 'auto_matched' };
  const reason = __reversalReasonFor(document, match);
  assert.match(reason, /Reversing the company-cash settlement entry/);
  const card = __buildReversalProposalCard({ document, settlementEntry: document.settlement_entry, match, reason,
    checks: __buildReversalChecks({ settlementJournalRow: { status: 'posted' }, match }) });
  assert.match(card.before_after[0].after.settlement_reversal, /DR 1900 · Käteinen raha \/ CR 7740/);
  assert.deepEqual([card.detail.funding_source, card.detail.settlement_account, card.detail.owner_funds_account], ['company_cash', '1900 · Käteinen raha', undefined]);
  const ownerDoc = { ...document, settlement_entry: { journal_id: 'lj-1', owner_funds_account: '901 · Director loan', expense_account: 'Rent' } };
  assert.match(__reversalReasonFor(ownerDoc, match), /Reversing the owner-funds settlement entry/);
});

test('the owner notice carries whose money paid; an entry without the field reads as the owner\'s funds', () => {
  const row = { document_id: 'd', document_type: 'receipt', counterparty: 'Kukkakauppa', amount: 22, currency: 'EUR', date: '2025-02-25', expense_account: '7740', settlement_channel: 'cash' };
  const input = buildAskDraftInput({ recordedSettlements: [{ ...row, funding_source: 'company_cash' }, { ...row, document_id: 'e' }],
    settlementReversals: [{ ...row, funding_source: 'company_cash', bank_line_date: '2025-02-25', bank_line_description: 'KORTTIOSTO' }] });
  assert.deepEqual(input.recorded_settlements.map((r) => r.funding_source), ['company_cash', 'owner']);
  assert.equal(input.settlement_reversals[0].funding_source, 'company_cash');
});
