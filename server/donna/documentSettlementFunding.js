// Whose money settled a money-out document outside the bank feed, and the
// account the settlement entry credits for it. One rule, read by the named
// writer (db/ledger.js postDocumentSettlementJournalWithClient, which refuses
// on it) and by the entry producer (documentSettlementEntry.js, which names
// the account on its proposal card and refuses there first). The producer
// cannot import the writer statically (the firmDb cycle), so the rule lives
// here, beside neither.
//
// The fact is the persisted disposition's funding_source (the document itself
// or the owner's answer, as read by the disposition lane):
//   - personal_card, or cash the owner supplied ('owner')  → the owner's-funds
//     account (DONNA_COA 901 Director loan, every market);
//   - cash from the company's own cash box ('company_cash') → the market's
//     declared cash account (provisioningPolicyRegistry
//     .resolveMarketPostingAccounts(jurisdiction).cashAccount(); FI 1900
//     Käteinen raha). A market that declares none gets no substitute: the
//     rule refuses with DOCUMENT_SETTLEMENT_CASH_ACCOUNT_UNDECLARED;
//   - cash with no funding fact → DOCUMENT_SETTLEMENT_FUNDING_REQUIRED.
import { resolveMarketPostingAccounts } from './provisioningPolicyRegistry.js';

// Slice 4b (docs/donna-settlement-answer-and-ledger-entry-plan.md §3) — the
// owner's-funds credit account: the DONNA_COA 901 seed (xeroCoaProvisioning.js),
// jurisdiction-safe in all four markets (plan decision #2).
// upsertLedgerAccountForJournal mints it on demand — no provisioning step.
export const DOCUMENT_SETTLEMENT_OWNER_FUNDS_ACCOUNT = Object.freeze({
  code: '901',
  name: 'Director loan',
  type: 'liability',
  canonical_role: 'liability.director_loan',
  tax_type: 'NONE'
});

export const SETTLEMENT_FUNDING_OWNER = 'owner';
export const SETTLEMENT_FUNDING_COMPANY_CASH = 'company_cash';

const refusal = (code, message) => Object.assign(new Error(message), { code, statusCode: 409 });

export const settlementFundingAccountLabel = (account = {}) =>
  `${account.code || ''} · ${account.name || ''}`.replace(/^ · /, '').replace(/ · $/, '');

// → { funding_source, account } or throws a coded 409. `ownerFundsAccount` is
// the writer's existing override for the owner's-funds leg.
export const resolveDocumentSettlementFunding = ({
  disposition = {},
  jurisdiction = null,
  ownerFundsAccount = DOCUMENT_SETTLEMENT_OWNER_FUNDS_ACCOUNT
} = {}) => {
  if (disposition?.settlement_channel !== 'cash' || disposition?.funding_source === SETTLEMENT_FUNDING_OWNER) {
    return { funding_source: SETTLEMENT_FUNDING_OWNER, account: ownerFundsAccount };
  }
  if (disposition?.funding_source !== SETTLEMENT_FUNDING_COMPANY_CASH) {
    throw refusal('DOCUMENT_SETTLEMENT_FUNDING_REQUIRED', 'Cash settlement needs evidence of whose funds paid the document.');
  }
  const cash = resolveMarketPostingAccounts(jurisdiction)?.cashAccount?.() || null;
  if (!cash) {
    throw refusal('DOCUMENT_SETTLEMENT_CASH_ACCOUNT_UNDECLARED',
      'The document was paid from the company\'s cash, and this market declares no cash account to book it against. '
      + 'It stays unposted until the market declares one; no other account is substituted.');
  }
  return {
    funding_source: SETTLEMENT_FUNDING_COMPANY_CASH,
    account: Object.freeze({
      code: cash.code, name: cash.name, type: cash.account_type, normal_balance: cash.normal_balance,
      canonical_role: cash.canonical_role, statutory_group: cash.statutory_group || null, tax_type: 'NONE',
      // The cash box is the bank-side leg of the entry, not the owner's account.
      line_role: 'bank'
    })
  };
};

// The same rule as a non-throwing read for a check report.
export const documentSettlementFundingOrRefusal = (args) => {
  try { return { ...resolveDocumentSettlementFunding(args), refusal: null }; }
  catch (error) {
    if (typeof error?.code === 'string' && error.code.startsWith('DOCUMENT_SETTLEMENT_')) {
      return { funding_source: args?.disposition?.funding_source || null, account: null, refusal: { code: error.code, message: error.message } };
    }
    throw error;
  }
};
