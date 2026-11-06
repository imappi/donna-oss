import { normalizeIntelText } from './transactionIntel.js';

export const DONNA_COA_ACCOUNTS = [
  {
    code: '201',
    name: 'Sales income',
    type: 'REVENUE',
    taxType: 'OUTPUTY24',
    role: 'revenue.operating',
    description: 'Revenue from normal business activity, provisioned by Donna.'
  },
  {
    code: '261',
    name: 'Other income',
    type: 'REVENUE',
    taxType: 'OUTPUTY24',
    role: 'revenue.other',
    description: 'Non-recurring or non-operating income, provisioned by Donna.'
  },
  {
    code: '401',
    name: 'IT & software',
    type: 'EXPENSE',
    taxType: 'INPUTY24',
    role: 'expense.software',
    description: 'Software subscriptions, cloud hosting, SaaS tools, and IT services.'
  },
  {
    code: '402',
    name: 'Professional fees',
    type: 'EXPENSE',
    taxType: 'INPUTY24',
    role: 'expense.professional_fees',
    description: 'Accounting, consulting, contractor, and other professional services.'
  },
  {
    code: '403',
    name: 'Travel',
    type: 'EXPENSE',
    taxType: 'OPINPUT',
    role: 'expense.travel',
    description: 'Business travel, lodging, taxis, and transport expenses.'
  },
  {
    code: '405',
    name: 'Meals and entertainment',
    type: 'EXPENSE',
    taxType: 'OPINPUT',
    role: 'expense.meals',
    description: 'Meals, coffee, and entertainment requiring support review.'
  },
  {
    code: '406',
    name: 'Marketing',
    type: 'EXPENSE',
    taxType: 'INPUTY24',
    role: 'expense.marketing',
    description: 'Advertising, promotion, and marketing expenses.'
  },
  {
    code: '407',
    name: 'Office operations',
    type: 'EXPENSE',
    taxType: 'INPUTY24',
    role: 'expense.office',
    description: 'General office operating costs and supplies.'
  },
  {
    code: '878',
    name: 'Intercompany clearing',
    type: 'CURRLIAB',
    taxType: 'NONE',
    role: 'clearing.intercompany',
    description: 'Clearing account for intercompany and internal transfer review.'
  },
  {
    code: '901',
    name: 'Director loan',
    type: 'TERMLIAB',
    taxType: 'NONE',
    role: 'liability.director_loan',
    description: 'Director/shareholder advances, repayments, and drawings under review.'
  },
  {
    code: '902',
    name: 'Related-party loan',
    type: 'TERMLIAB',
    taxType: 'NONE',
    role: 'liability.related_party_loan',
    description: 'Related-party loan movements requiring ownership/context review.'
  }
];

const xeroAccountCode = (account = {}) => String(account.code || account.Code || '').trim();
const xeroAccountName = (account = {}) => String(account.name || account.Name || '').trim();
const xeroAccountStatus = (account = {}) => normalizeIntelText(account.status || account.Status);

export const toXeroAccountPayload = (account = {}) => ({
  Code: account.code,
  Name: account.name,
  Type: account.type,
  TaxType: account.taxType,
  Description: account.description
});

export const buildXeroCoaProvisionPlan = ({
  xeroAccounts = [],
  desiredAccounts = DONNA_COA_ACCOUNTS
} = {}) => {
  const activeAccounts = xeroAccounts.filter((account) => {
    const status = xeroAccountStatus(account);
    return !status || status === 'active';
  });
  const byCode = new Map(activeAccounts.map((account) => [normalizeIntelText(xeroAccountCode(account)), account]));
  const byName = new Map(activeAccounts.map((account) => [normalizeIntelText(xeroAccountName(account)), account]));
  const actions = desiredAccounts.map((desired) => {
    const codeMatch = byCode.get(normalizeIntelText(desired.code));
    const nameMatch = byName.get(normalizeIntelText(desired.name));
    if (codeMatch && normalizeIntelText(xeroAccountName(codeMatch)) === normalizeIntelText(desired.name)) {
      return { action: 'already_exists', desired, existing: codeMatch };
    }
    if (nameMatch) {
      return { action: 'already_exists', desired, existing: nameMatch, note: 'Matched by account name.' };
    }
    if (codeMatch) {
      return {
        action: 'blocked',
        reason: 'code_conflict',
        desired,
        existing: codeMatch,
        note: `Code ${desired.code} is already used by ${xeroAccountName(codeMatch) || 'another Xero account'}.`
      };
    }
    return { action: 'create', desired, payload: toXeroAccountPayload(desired) };
  });
  return {
    desired_accounts: desiredAccounts,
    actions,
    counts: {
      desired: desiredAccounts.length,
      create: actions.filter((item) => item.action === 'create').length,
      already_exists: actions.filter((item) => item.action === 'already_exists').length,
      blocked: actions.filter((item) => item.action === 'blocked').length
    }
  };
};
