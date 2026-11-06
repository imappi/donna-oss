// Pure GB limited-company cutover document-set evaluation. A balanced trial
// balance is necessary but not sufficient for a legally complete opening position.

import { clientFlagActs } from '../clientConfig.js';

export const GB_CUTOVER_DOCUMENT_SET_PROVENANCE = Object.freeze({
  authority: Object.freeze(['Companies House', 'HM Revenue & Customs']),
  asOf: '2026-07-30',
  confirmedAgainstPrimary: false,
  note: 'The required-document catalog and its material-versus-recommended classification are a remembered professional-judgment set, not confirmed statutory guidance.',
  verificationNote: 'Confirm the closed catalog and classification against primary sources and professional guidance during curation before mounting an acting lane.'
});

export const GB_CUTOVER_DOCUMENT_SET_FLAG_KEY = 'GB_CUTOVER_DOCUMENT_SET';
export const gbCutoverDocumentSetEnabled = ({ snapshot = null, env = process.env } = {}) => clientFlagActs({
  flagKey: GB_CUTOVER_DOCUMENT_SET_FLAG_KEY,
  snapshot,
  envFallback: () => false,
  env
});

export const GB_CUTOVER_PHASES = Object.freeze(['essential', 'reconciliation', 'tax_foundation', 'governance']);

export const GB_CUTOVER_DOCUMENTS = Object.freeze([
  { key: 'prior_filed_accounts', phase: 'essential', materiality: 'material', applicability: 'always', name_en: 'Prior filed statutory accounts' },
  { key: 'closing_trial_balance', phase: 'essential', materiality: 'material', applicability: 'always', name_en: 'Closing trial balance / general-ledger balances' },
  { key: 'articles_of_association', phase: 'essential', materiality: 'material', applicability: 'always', name_en: 'Articles of association' },
  { key: 'register_of_members', phase: 'essential', materiality: 'material', applicability: 'always', name_en: 'Register of members / statement of capital' },
  { key: 'open_receivables_payables', phase: 'reconciliation', materiality: 'material', applicability: 'conditional', name_en: 'Aged debtors and creditors (open AR/AP)' },
  { key: 'fixed_asset_register', phase: 'reconciliation', materiality: 'material', applicability: 'conditional', name_en: 'Fixed-asset register' },
  { key: 'loan_schedules', phase: 'reconciliation', materiality: 'material', applicability: 'conditional', name_en: 'Loan schedules' },
  { key: 'vat_account_reconciliation', phase: 'reconciliation', materiality: 'material', applicability: 'conditional', name_en: 'VAT account reconciliation at cutover' },
  { key: 'payroll_paye_liabilities', phase: 'reconciliation', materiality: 'material', applicability: 'conditional', name_en: 'Payroll / PAYE / NIC liabilities' },
  { key: 'directors_loan_account_balance', phase: 'reconciliation', materiality: 'material', applicability: 'conditional', name_en: "Director's loan account balance" },
  { key: 'prepayments_accruals', phase: 'reconciliation', materiality: 'recommended', applicability: 'conditional', name_en: 'Prepayments and accruals' },
  { key: 'latest_ct600_and_computation', phase: 'tax_foundation', materiality: 'material', applicability: 'always', name_en: 'Latest filed CT600 and tax computation' },
  { key: 'capital_allowances_pool_balances', phase: 'tax_foundation', materiality: 'material', applicability: 'always', name_en: 'Capital-allowances pool balances (written-down values)' },
  { key: 'carried_forward_losses', phase: 'tax_foundation', materiality: 'material', applicability: 'always', name_en: 'Agreed carried-forward loss position' },
  { key: 'directors_and_psc_details', phase: 'governance', materiality: 'material', applicability: 'always', name_en: 'Directors and PSC details' },
  { key: 'confirmation_statement_status', phase: 'governance', materiality: 'material', applicability: 'always', name_en: 'Latest confirmation statement (CS01) status' },
  { key: 'prior_dividend_history', phase: 'governance', materiality: 'recommended', applicability: 'conditional', name_en: 'Prior dividend history' }
]);

const DOC_BY_KEY = new Map(GB_CUTOVER_DOCUMENTS.map((document) => [document.key, document]));

export const GB_CUTOVER_BLOCKER_SURFACE = 'gb_ltd_opening_balance';
export const GB_CUTOVER_BLOCKER_REASON_CODE = 'incomplete_gb_cutover_document_set';
export const GB_CUTOVER_RESOLUTION_PATH = 'A UK limited-company opening position requires the full cutover document set, not just a balanced trial balance. Provide the missing material documents, or record a not-applicable mark where a position genuinely does not exist, before seeding the opening balances.';

const toSet = (value) => new Set(
  Array.isArray(value)
    ? value.filter((entry) => typeof entry === 'string' && entry.trim()).map((entry) => entry.trim())
    : value && typeof value === 'object'
      ? Object.keys(value).filter((key) => value[key])
      : []
);

export const evaluateGbCutoverIntake = ({ provided = [], notApplicable = [] } = {}) => {
  const providedSet = toSet(provided);
  const notApplicableSet = toSet(notApplicable);
  const statusOf = (document) => {
    if (providedSet.has(document.key)) return 'provided';
    if (document.applicability === 'conditional' && notApplicableSet.has(document.key)) return 'not_applicable';
    return 'missing';
  };
  const missingMaterial = [];
  const missingRecommended = [];
  const notApplicableOut = [];
  const phases = GB_CUTOVER_PHASES.map((phase) => {
    const rendered = GB_CUTOVER_DOCUMENTS
      .filter((document) => document.phase === phase)
      .map((document) => ({ ...document, status: statusOf(document) }));
    const phaseMissingMaterial = [];
    const phaseMissingRecommended = [];
    const phaseNotApplicable = [];
    let providedCount = 0;
    let materialTotal = 0;
    for (const document of rendered) {
      if (document.materiality === 'material') materialTotal += 1;
      if (document.status === 'provided') { providedCount += 1; continue; }
      if (document.status === 'not_applicable') { phaseNotApplicable.push(document.key); notApplicableOut.push(document.key); continue; }
      if (document.materiality === 'material') { phaseMissingMaterial.push(document.key); missingMaterial.push(document.key); }
      else { phaseMissingRecommended.push(document.key); missingRecommended.push(document.key); }
    }
    return {
      phase,
      documents: rendered,
      material_total: materialTotal,
      provided_count: providedCount,
      missing_material: phaseMissingMaterial,
      missing_recommended: phaseMissingRecommended,
      not_applicable: phaseNotApplicable,
      complete: phaseMissingMaterial.length === 0
    };
  });
  const openingBalanceReady = missingMaterial.length === 0;
  const blocker = openingBalanceReady ? null : {
    should_mint: true,
    surface: GB_CUTOVER_BLOCKER_SURFACE,
    reason_code: GB_CUTOVER_BLOCKER_REASON_CODE,
    severity: 'review_required',
    assigned_to: 'owner',
    resolution_path: GB_CUTOVER_RESOLUTION_PATH,
    missing_material: [...missingMaterial],
    detail: { missing_material: [...missingMaterial], missing_recommended: [...missingRecommended] }
  };
  return {
    phases,
    missing_material: missingMaterial,
    missing_recommended: missingRecommended,
    not_applicable: notApplicableOut,
    opening_balance_ready: openingBalanceReady,
    blocker,
    summary_en: openingBalanceReady
      ? 'The UK limited-company cutover document set is complete — opening balances can be seeded.'
      : `The UK limited-company cutover document set is missing ${missingMaterial.length} material documents — opening balances are refused until supplied or marked not-applicable.`
  };
};

export const labelForGbCutoverDocument = (key) => {
  const document = DOC_BY_KEY.get(key);
  return document ? { name_en: document.name_en } : null;
};
