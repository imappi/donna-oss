const RED_ACCOUNT_PATTERNS = /\b(tax|payroll|paye|director|shareholder|equity|dividend|loan\s*to\s*(?:director|shareholder|owner)|drawings?|capital\s*contribution|retained\s*earnings?|owner.?s?\s*(?:equity|capital|draw|distribut))\b/i;

const CAPITAL_EXPENSE_AMBIGUITY_PATTERNS = /\b(asset|capital|depreciat\w*|amorti\w*|fixed\s*asset|plant|property|equipment)\b/i;

const RED_ACCOUNT_TYPES = new Set([
  'equity',
  'owners_equity',
  'owner_equity',
]);

const SENSITIVE_ACCOUNT_TYPES = new Set([
  'tax',
  'payroll',
  'liability',
]);

export const isRedAccount = (accountType, accountName) => {
  const normType = String(accountType || '').toLowerCase().replace(/[^a-z_]/g, '');
  const normName = String(accountName || '').toLowerCase();

  if (RED_ACCOUNT_TYPES.has(normType)) return true;
  if (RED_ACCOUNT_PATTERNS.test(normName)) return true;
  if (SENSITIVE_ACCOUNT_TYPES.has(normType) && RED_ACCOUNT_PATTERNS.test(normName)) return true;

  return false;
};

const isSafeAccountType = (accountType) => {
  const normType = String(accountType || '').toLowerCase().replace(/[^a-z_]/g, '');
  return normType === 'expense' || normType === 'revenue' ||
         normType === 'cost_of_sales' || normType === 'costofgoods' ||
         normType === 'costofsales' || normType === 'other_expense' ||
         normType === 'other_income' || normType === 'income';
};

const hasCapitalExpenseAmbiguity = (accountName) =>
  CAPITAL_EXPENSE_AMBIGUITY_PATTERNS.test(String(accountName || ''));

export const classifyLane = ({
  decisionType,
  confidence = {},
  signals = {},
  accountType,
  accountName,
  amount,
  hasCompetingCandidates = false,
  extractionConfidence,
  extractionSource
} = {}) => {
  const blockers = [];
  const score = Number(confidence?.score ?? 0);

  if (isRedAccount(accountType, accountName)) {
    blockers.push('sensitive_account');
  }

  if (signals.personal_mixed_use) {
    blockers.push('personal_mixed_use');
  }

  if (hasCompetingCandidates || signals.competing_delta_below_threshold) {
    blockers.push('competing_candidates');
  }

  if (signals.amount_mismatch || signals.duplicate) {
    blockers.push('parse_warning');
  }

  if (decisionType === 'categorize' && hasCapitalExpenseAmbiguity(accountName)) {
    blockers.push('capital_expense_ambiguity');
  }

  if (blockers.length > 0) {
    return { lane: 'red', blockers };
  }

  if (decisionType === 'match') {
    const greenEligible =
      signals.amount_exact &&
      signals.date_within_window &&
      signals.vendor_overlap &&
      !hasCompetingCandidates &&
      (extractionConfidence == null || Number(extractionConfidence) >= 0.85) &&
      extractionSource !== 'filename' &&
      score >= 0.85;

    if (greenEligible) {
      return { lane: 'green', blockers: [] };
    }
  }

  if (decisionType === 'categorize') {
    const greenEligible =
      signals.client_rule_match &&
      score >= 0.9 &&
      isSafeAccountType(accountType) &&
      extractionSource !== 'filename';

    if (greenEligible) {
      return { lane: 'green', blockers: [] };
    }
  }

  return { lane: 'yellow', blockers: [] };
};
