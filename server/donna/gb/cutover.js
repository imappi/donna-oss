const round2 = (value) => Math.round((Number(value) + Number.EPSILON) * 100) / 100;
const SUPPORTED_ROLES = new Set([
  'asset.cash', 'asset.accounts_receivable', 'asset.inventory', 'asset.fixed',
  'liability.accounts_payable', 'liability.sales_tax_payable',
  'equity.share_capital', 'equity.retained_earnings', 'equity.owner_capital', 'liability.director_loan'
]);

const refusal = (code, message, details = {}) => Object.assign(new Error(message), { statusCode: 409, code, details });

export const normalizeGbOpeningBalanceIntake = ({ declaredLines = [], chart = [], openReceivables = [], openPayables = [], vatControl = null, statutoryCarryForwards = [] } = {}) => {
  if (statutoryCarryForwards.length) throw refusal('GB_CUTOVER_RULE_UNCONFIRMED', 'Statutory carry-forward treatment is not confirmed for this slice.', { refused: statutoryCarryForwards });
  const byRole = new Map();
  for (const account of chart) {
    const role = String(account?.canonical_role || '').trim();
    if (!role) continue;
    byRole.set(role, [...(byRole.get(role) || []), account]);
  }
  const missingRoles = [];
  const openingLines = [];
  if (!Array.isArray(declaredLines) || declaredLines.length === 0) return { terminal: 'owner_ask', code: 'GB_OPENING_BALANCE_DECLARATION_REQUIRED', question: 'Please provide the GBP opening trial balance with each line mapped to a canonical role.' };
  for (const line of declaredLines) {
    const role = String(line?.canonical_role || '').trim();
    if (!SUPPORTED_ROLES.has(role) || (byRole.get(role) || []).length !== 1) {
      missingRoles.push(role || 'missing');
      continue;
    }
    const debit = round2(line.debit || 0);
    const credit = round2(line.credit || 0);
    const account = byRole.get(role)[0];
    openingLines.push({ account: { code: account.code, name: account.name, type: account.account_type, normal_balance: account.normal_balance, canonical_role: role }, debit, credit });
  }
  if (missingRoles.length) return { terminal: 'owner_ask', code: 'GB_OPENING_BALANCE_CANONICAL_ROLE_REQUIRED', question: `Please map one account for each missing or ambiguous role: ${[...new Set(missingRoles)].join(', ')}.`, missing_roles: [...new Set(missingRoles)] };
  const sum = (items) => round2(items.reduce((total, item) => total + Number(item.amount_gbp || 0), 0));
  const netByRole = Object.fromEntries(openingLines.map((line) => [line.account.canonical_role, round2((line.debit || 0) - (line.credit || 0))]));
  const checks = [
    { code: 'open_receivables', declared: sum(openReceivables), ledger: netByRole['asset.accounts_receivable'] || 0 },
    { code: 'open_payables', declared: sum(openPayables), ledger: Math.abs(netByRole['liability.accounts_payable'] || 0) },
    ...(vatControl == null ? [] : [{ code: 'vat_control', declared: round2(vatControl.amount_gbp), ledger: Math.abs(netByRole['liability.sales_tax_payable'] || 0) }])
  ].map((check) => ({ ...check, delta: round2(check.declared - check.ledger) }));
  const mismatch = checks.find((check) => check.delta !== 0);
  if (mismatch) return { terminal: 'owner_ask', code: 'GB_OPENING_BALANCE_CONTROL_MISMATCH', question: `Please reconcile the ${mismatch.code} difference of GBP ${Math.abs(mismatch.delta).toFixed(2)}.`, checks };
  return { terminal: 'proposal', proposal: { currency: 'GBP', openingLines, openReceivables, openPayables, vatControl, checks } };
};
