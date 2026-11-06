import { normalizeIntelText } from './transactionIntel.js';
import { normalizeJurisdictionKey } from './taxCodeJurisdiction.js';
import { XERO_TAX_POLICY_REGISTRY } from './xeroTaxPolicyRegistry.js';
import { isUnsureTaxTreatment } from './taxVocabularyRegistry.js';

// D4 (2026-07-07): a VAT/GST tax type (OUTPUT/INPUT/OPOUTPUT/OPINPUT/…) is only
// valid on a P&L account. On a balance-sheet / clearing / control account
// (intercompany clearing, suspense, loans, equity), Xero REJECTS it — the account
// takes No Tax / Out Of Scope only (live receipt: a pilot client's `878 · Intercompany
// clearing` + OPOUTPUT → HTTP 400 "cannot be used with account code '878'").
const PNL_ACCOUNT_TYPES = new Set([
  'REVENUE', 'SALES', 'OTHERINCOME',
  'EXPENSE', 'DIRECTCOSTS', 'OVERHEADS', 'DEPRECIATN',
  'WAGESEXPENSE', 'SUPERANNUATIONEXPENSE'
]);
const isPnlAccount = (account = {}) => PNL_ACCOUNT_TYPES.has(String(account.type || '').trim().toUpperCase());
// The only tax types Xero accepts on a balance-sheet account (both 0%).
const BALANCE_SHEET_SAFE_TAX_TYPES = new Set(['NONE', 'BASEXCLUDED']);

const accountLabelFor = (account = {}) => {
  const code = String(account.code || account.Code || '').trim();
  const name = String(account.name || account.Name || '').trim();
  return code && name ? `${code} · ${name}` : name || code;
};

const normalizedAccount = (account = {}) => {
  const code = String(account.code || account.Code || '').trim();
  const name = String(account.name || account.Name || '').trim();
  const type = String(account.type || account.Type || '').trim();
  const systemAccount = String(account.system_account || account.systemAccount || account.SystemAccount || '').trim();
  return {
    source: account,
    code,
    name,
    type,
    status: String(account.status || account.Status || '').trim(),
    systemAccount,
    taxType: String(account.tax_type || account.taxType || account.TaxType || '').trim(),
    normalizedCode: normalizeIntelText(code),
    normalizedName: normalizeIntelText(name),
    normalizedLabel: normalizeIntelText(`${code} ${name}`),
    // Names this row also answers to (a coded Donna row's pack-palette name,
    // FI-21). Absent on synced and code-less charts.
    normalizedAliases: (Array.isArray(account.aliases) ? account.aliases : []).map(normalizeIntelText).filter(Boolean),
    label: accountLabelFor({ code, name })
  };
};

const isActiveAccount = (account = {}) => {
  const status = normalizeIntelText(account.status);
  return !status || status === 'active';
};

const isBankLike = (account = {}) => /bank/.test(normalizeIntelText(account.type || account.name));

const isExcludedControlAccount = (account = {}) => {
  const name = normalizeIntelText(account.name);
  const code = String(account.code || '').trim();
  const system = normalizeIntelText(account.systemAccount);
  if (name === 'suspense') return false;
  if (['497', '498', '800', '801', '803', '820', '840', '860'].includes(code)) return true;
  return /accounts receivable|accounts payable|gst|rounding|historical adjustment|currency gains|bank revaluations|unpaid expense claims/.test(name) ||
    /debtors|creditors|gst|rounding|unpaidexpenseclaims|historical/.test(system);
};

export const postableXeroAccounts = (accounts = []) =>
  accounts
    .map(normalizedAccount)
    .filter((account) => isActiveAccount(account) && !isBankLike(account) && !isExcludedControlAccount(account));

const directionFor = (transaction = {}) => {
  if (Number(transaction.money_in || 0) > 0) return 'in';
  if (Number(transaction.money_out || 0) > 0) return 'out';
  return 'unknown';
};

const hasCapitalContributionCue = (transaction = {}) =>
  /\b(?:share issue|share capital|capital contribution|investor|osakepaaomanruiske|paaomanruiske|kauppahintaa)\b/i.test(
    `${transaction.description || ''} ${transaction.raw_description || ''} ${transaction.source_line || ''}`
  );

const hasFailedPaymentAdjustmentCue = (transaction = {}) =>
  /\b(?:adjustment reason|invalid account number|returned payment|reversal)\b/i.test(
    `${transaction.description || ''} ${transaction.raw_description || ''} ${transaction.source_line || ''}`
  );

const preferredTargetsFor = ({ account = '', transaction = {} } = {}) => {
  const key = normalizeIntelText(account);
  if (!key) return [];
  if (directionFor(transaction) === 'in' && hasCapitalContributionCue(transaction)) {
    return ['owner a share capital', 'owner a funds introduced'];
  }
  if (hasFailedPaymentAdjustmentCue(transaction)) {
    return ['suspense', 'intercompany clearing'];
  }
  if (key === 'suspense') return ['suspense'];
  if (/^sales|sales income|revenue|income$/.test(key)) return ['sales income', 'sales'];
  if (/other income|other revenue/.test(key)) return ['other income', 'other revenue'];
  if (/interest income/.test(key)) return ['interest income'];
  if (/bank fees|taxes and bank fees/.test(key)) return ['bank fees'];
  if (/software|subscription|saas|it software|it and software/.test(key)) return ['it software', 'it and software', 'subscriptions', 'office expenses', 'general expenses'];
  if (/marketing|advertising/.test(key)) return ['marketing', 'advertising'];
  if (/meal|entertainment|restaurant|coffee/.test(key)) return ['meals and entertainment', 'entertainment'];
  // D1 (2026-07-07): the model's account verdict decides national-vs-international,
  // not a keyword sniffer. The old `hasInternationalCue` upgraded any city /
  // EUR / hotel-ish line to "Travel - International", overriding a bare "Travel"
  // verdict (live receipt: a pilot client's taxis coded "Travel" exported as 494). If the
  // coder means international it says so and findExactAccount matches it directly;
  // a bare "Travel" now defaults to the neutral national bucket, never a
  // fabricated international one. This is intelligence-substituting scaffolding
  // retired, per CLAUDE.md's trust-the-strong-LLM rail.
  if (/travel|transport/.test(key)) return ['travel', 'travel national', 'travel international'];
  if (/professional|consult|accounting|contractor|freelancer/.test(key)) return ['professional fees', 'consulting and accounting', 'consulting accounting', 'legal expenses'];
  if (/legal/.test(key)) return ['legal expenses', 'consulting and accounting', 'consulting accounting'];
  if (/statutory|filing|general/.test(key)) return ['general expenses'];
  if (/office|office operations/.test(key)) return ['office operations', 'office expenses', 'general expenses'];
  if (/telecom|telephone|internet/.test(key)) return ['telephone internet'];
  if (/insurance/.test(key)) return ['insurance'];
  if (/rent/.test(key)) return ['rent'];
  if (/payroll|wages|salary|salaries/.test(key)) return ['wages and salaries'];
  if (/cpf|superannuation/.test(key)) return ['superannuation', 'superannuation payable'];
  if (/tax payable|income tax payable/.test(key)) return ['income tax payable', 'income tax expense'];
  if (/foreign exchange|fx|currency gain|currency loss/.test(key)) return ['realised currency gains', 'unrealised currency gains'];
  if (/share capital|investor|funds introduced|capital/.test(key)) return ['owner a share capital', 'owner a funds introduced'];
  if (/director|drawings|owner/.test(key)) {
    return directionFor(transaction) === 'in'
      ? ['director loan', 'owner a funds introduced', 'loan', 'owner a drawings']
      : ['director loan', 'owner a drawings', 'loan', 'owner a funds introduced'];
  }
  if (/related party|loan|loan payable|loan repayment/.test(key)) return ['related party loan', 'loan', 'owner a funds introduced', 'owner a drawings'];
  if (/intercompany|internal transfer|transfer/.test(key)) return ['intercompany clearing', 'tracking transfers', 'suspense'];
  return [key];
};

const findExactAccount = (accounts = [], account = '') => {
  const key = normalizeIntelText(account);
  if (!key) return null;
  // Codes are identifiers; names are labels. If one row's stale label
  // collides with another row's exact code, the explicit code must win even
  // when the stale-label row sorts first in the chart. This is especially
  // important for the local ledger after a recode repairs a name-as-code.
  return accounts.find((candidate) => candidate.normalizedCode === key) ||
    accounts.find((candidate) =>
    candidate.normalizedName === key ||
    candidate.normalizedLabel === key ||
    normalizeIntelText(candidate.label) === key
  ) || accounts.find((candidate) => candidate.normalizedAliases.includes(key)) || null;
};

const findPreferredAccount = (accounts = [], targets = []) => {
  const normalizedTargets = targets.map(normalizeIntelText).filter(Boolean);
  for (const target of normalizedTargets) {
    const exact = accounts.find((candidate) => candidate.normalizedName === target || candidate.normalizedCode === target);
    if (exact) return exact;
  }
  for (const target of normalizedTargets) {
    const includes = accounts.find((candidate) => candidate.normalizedName.includes(target) || target.includes(candidate.normalizedName));
    if (includes) return includes;
  }
  return null;
};

export const resolveXeroAccount = ({ account = '', transaction = {}, xeroAccounts = [] } = {}) => {
  const candidates = postableXeroAccounts(xeroAccounts);
  if (!candidates.length) return null;
  const exact = findExactAccount(candidates, account);
  if (exact) return exact;
  return findPreferredAccount(candidates, preferredTargetsFor({ account, transaction }));
};

const xeroFieldsFor = (match, { taxTreatment = '', taxType = '', direction = '', jurisdiction = null } = {}) => {
  if (!match) return {};
  // The coder's tax verdict outranks the account's chart default; the default
  // only fills in when the coder gave no usable tax signal.
  const taxPolicy = XERO_TAX_POLICY_REGISTRY[normalizeJurisdictionKey(jurisdiction)] || null;
  // Exact connector codes are supplied data. Only an explicitly selected
  // country adapter may translate a treatment into a connector code.
  // RT-23: the coder's UNSURE marker ('ALV-tarkistus' / 'VAT check' / 'GST
  // check') is a verdict, not silence — an explicit code still wins, but no
  // adapter and no chart default may resolve a rate the coder refused to
  // pick. (The chart default is written by the ledger-account upsert from
  // the last posted leg, so it laundered an unsure sale into last month's
  // standard rate.) Silence (no treatment at all) keeps the fallback.
  const unsure = isUnsureTaxTreatment(jurisdiction, taxTreatment);
  let resolvedTaxType = String(taxType || '').trim() ||
    (unsure ? null : (taxPolicy?.resolveCoderTaxType({ taxTreatment, direction }) || match.taxType || null));
  // D4: a VAT/GST tax type is invalid on a non-P&L (balance-sheet / clearing)
  // account — coerce it to the account's own out-of-scope default, or No Tax.
  // P&L accounts are untouched (the coder verdict / standard-rate default stands).
  if (
    resolvedTaxType &&
    !isPnlAccount(match) &&
    !BALANCE_SHEET_SAFE_TAX_TYPES.has(String(resolvedTaxType).toUpperCase())
  ) {
    const accountDefault = String(match.taxType || '').toUpperCase();
    resolvedTaxType = BALANCE_SHEET_SAFE_TAX_TYPES.has(accountDefault) ? match.taxType : 'NONE';
  }
  return {
    proposed_account: match.name,
    account_code: match.code || match.name,
    account_name: match.name,
    account_label: match.label,
    xero_account_id: match.source.xero_account_id || match.source.xeroAccountId || match.source.AccountID || null,
    xero_account_code: match.code || null,
    xero_account_name: match.name,
    xero_account_type: match.type || null,
    xero_tax_type: resolvedTaxType,
    // Label reflects what is ACTUALLY posted (the resolved code), not the account
    // default, so the chip / G7 history note read true.
    tax_treatment: resolvedTaxType
      ? (String(resolvedTaxType).toUpperCase() === 'NONE' ? 'No Tax (0%)' : taxPolicy?.labels?.[String(resolvedTaxType).toUpperCase()] || (taxPolicy ? taxTreatment : '') || String(resolvedTaxType))
      : taxTreatment,
    xero_account_match_status: 'matched'
  };
};

export const enrichCodingWithXeroAccount = ({ coding = {}, transaction = {}, xeroAccounts = [], jurisdiction = null } = {}) => {
  const resolvedJurisdiction = normalizeJurisdictionKey(jurisdiction);
  const account = coding.account_code || coding.proposed_account || coding.account || '';
  const match = resolveXeroAccount({ account, transaction, xeroAccounts });
  if (!match) {
    return xeroAccounts.length
      ? { ...coding, xero_account_match_status: account ? 'unmatched' : 'missing_account' }
      : coding;
  }
  return {
    ...coding,
    ...xeroFieldsFor(match, {
      taxTreatment: coding.tax_treatment || '',
      taxType: coding.xero_tax_type || '',
      direction: directionFor(transaction),
      jurisdiction: resolvedJurisdiction
    }),
    alternatives: Array.isArray(coding.alternatives)
      ? coding.alternatives.map((alternative) => enrichAlternativeWithXeroAccount({ alternative, transaction, xeroAccounts, jurisdiction: resolvedJurisdiction }))
      : coding.alternatives
  };
};

export const enrichAlternativeWithXeroAccount = ({ alternative = {}, transaction = {}, xeroAccounts = [], jurisdiction = null } = {}) => {
  const match = resolveXeroAccount({ account: alternative.account || alternative.account_code || alternative.proposed_account || '', transaction, xeroAccounts });
  if (!match) return alternative;
  return {
    ...alternative,
    account: match.name,
    ...xeroFieldsFor(match, {
      taxTreatment: alternative.tax_treatment || '',
      taxType: alternative.xero_tax_type || '',
      direction: directionFor(transaction),
      jurisdiction
    })
  };
};
