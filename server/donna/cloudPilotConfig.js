import { OUTBOUND_ACTION_FLAG_KEYS } from './outbound/actionGate.js';
import { INTERNAL_PILOT_ACCESS_FLAG, HOSTED_PILOT_VERSION, SG_HOSTED_REVIEW_VERSION, US_HOSTED_PILOT_VERSION } from './internalPilotAccess.js';
export const HOSTED_FIRM_POLICY_REASON = 'authenticated_fi_firm_creation_default';
export const US_HOSTED_FIRM_POLICY_REASON = 'authenticated_us_firm_creation_default';

// The same baseline is used by reviewed setup and authenticated firm creation.
export const FI_HOSTED_PILOT_STAGES = Object.freeze({
  JURISDICTION_ACCOUNT_PALETTE: 'auto', JURISDICTION_TAX_CODING: 'auto',
  FINLAND_ALV_CODING: 'auto', FINLAND_ALV_RETURN: 'auto',
  OPERATOR_CAPABILITY_ENFORCE: 'auto', FISCAL_PERIOD_INTAKE: 'canary',
  FINLAND_ALV_FILING: 'off', RECONCILE_RETRACTION_AUTOSEND: 'off',
  ...Object.fromEntries(Object.values(OUTBOUND_ACTION_FLAG_KEYS).map(key => [key, 'off'])),
  [INTERNAL_PILOT_ACCESS_FLAG]: 'canary'
});

// Exact cloud pilot extension. No cohort scope or material authority.
export const CLOUD_PILOT_PROCESSING_VERSION='donna.fi-cloud-processing.v1';
export const BANK_LINE_DISPOSITION_FLAG = 'BANK_LINE_DISPOSITION';
export const CLOUD_PILOT_PROCESSING_FLAGS=Object.freeze(['ENTITY_READINESS_ADMISSION','DOCUMENT_EXTRACTORS_ENABLED','DOCUMENT_LINES_ENABLED',
  'GENERIC_DOCUMENT_EXTRACTOR_ENABLED','DOCUMENT_ROUTER_ENABLED','BANK_STATEMENT_LLM_EXTRACTION','RECONCILIATION_AUTO_MATCH',
  'RECONCILIATION_CODE_MATCHED_NO_REVIEW','JEV_RECONCILIATION','CODING_AUTO_POST','LEDGER_AUTO_POST','DOCUMENT_NO_LINE_DISPOSITION',
  'RECONCILIATION_ASK_QUIESCENCE_GATE','ASK_SEND_SETTLE_GATE',BANK_LINE_DISPOSITION_FLAG]);

// SG-4: a document-processing/review contract, not accounting completion.
// No inherited firm flag or legacy environment setting may enable posting.
export const SG_HOSTED_CAPABILITY_MANIFEST = 'sg-cloud-review.v1';
export const SG_HOSTED_PROFILE_ID = 'sg-pte.firm-intake.vercel.none.management-books.sg-cloud-review-v1';
export const SG_NATIVE_PROCESSING_REVIEW_FLAG = 'SG_NATIVE_PROCESSING_REVIEW';
export const SG_NATIVE_CAPABILITY_MANIFEST = 'sg-native-cloud-review.v1';
export const SG_NATIVE_PROFILE_ID = 'sg-pte.firm-intake.vercel.none.management-books.sg-native-cloud-review-v1';
export const SG_HOSTED_REVIEW_STAGES = Object.freeze({
  JURISDICTION_ACCOUNT_PALETTE: 'auto', OPERATOR_CAPABILITY_ENFORCE: 'auto',
  [INTERNAL_PILOT_ACCESS_FLAG]: 'canary', ENTITY_READINESS_ADMISSION: 'canary',
  DOCUMENT_EXTRACTORS_ENABLED: 'canary', DOCUMENT_LINES_ENABLED: 'canary',
  GENERIC_DOCUMENT_EXTRACTOR_ENABLED: 'canary', DOCUMENT_ROUTER_ENABLED: 'canary',
  BANK_STATEMENT_LLM_EXTRACTION: 'canary',
  JURISDICTION_TAX_CODING: 'off', CODING_AUTO_POST: 'off', LEDGER_AUTO_POST: 'off',
  RECONCILIATION_AUTO_MATCH: 'off', RECONCILIATION_CODE_MATCHED_NO_REVIEW: 'off',
  JEV_RECONCILIATION: 'off', JEV_HELD_PLAN_COMPLETION: 'off',
  DOCUMENT_NO_LINE_DISPOSITION: 'off', BANK_LINE_DISPOSITION: 'off',
  RECONCILE_RETRACTION_AUTOSEND: 'off',
  ...Object.fromEntries(Object.values(OUTBOUND_ACTION_FLAG_KEYS).map(key => [key, 'off']))
});

// US hosted pilot (docs/design-donna-us-hosted-lane.md, Kari 2026-10-01).
// Gross-only books: the US posting policy has no tax-coding flag, so
// JURISDICTION_TAX_CODING stays off. Outbound and retraction sends stay off;
// asks reach the owner only through the receipted send release.
export const US_HOSTED_PILOT_FLAG = 'US_HOSTED_PILOT';
export const US_HOSTED_CAPABILITY_MANIFEST = 'us-cloud-pilot.v1';
export const US_HOSTED_PROFILE_ID = 'us-llc.firm-intake.vercel.none.management-books.us-cloud-pilot-v1';
export const US_HOSTED_PILOT_STAGES = Object.freeze({
  JURISDICTION_ACCOUNT_PALETTE: 'auto', OPERATOR_CAPABILITY_ENFORCE: 'auto',
  JURISDICTION_TAX_CODING: 'off', RECONCILE_RETRACTION_AUTOSEND: 'off',
  ...Object.fromEntries(Object.values(OUTBOUND_ACTION_FLAG_KEYS).map(key => [key, 'off'])),
  [INTERNAL_PILOT_ACCESS_FLAG]: 'canary'
});

// The ONE table of hosted markets. A hosted lane decision that differs by
// market reads its row here instead of naming a country. `processing`:
// 'accounting' = the full pipeline (coding, posting, bank-line convergence,
// first-line coder); 'review_only' = document processing and review.
// `birthSelectionFlag` = the firm-default row that must act before a
// firm-member create on the hosted runtime births this market at all (null =
// unconditional, as FI has been since its lane opened). `birthPolicyReason`
// = the reason on the reconciliation lane policy an accounting birth writes.
export const HOSTED_MARKET_PROFILES = Object.freeze({
  FI: Object.freeze({ jurisdiction: 'FI', entityType: 'fi-oy', currency: 'EUR', version: HOSTED_PILOT_VERSION,
    processing: 'accounting', baselineStages: FI_HOSTED_PILOT_STAGES, capabilityManifest: 'fi-cloud-pilot.v1',
    birthSelectionFlag: null, birthPolicyReason: HOSTED_FIRM_POLICY_REASON }),
  SG: Object.freeze({ jurisdiction: 'SG', entityType: 'sg-pte', currency: 'SGD', version: SG_HOSTED_REVIEW_VERSION,
    processing: 'review_only', baselineStages: SG_HOSTED_REVIEW_STAGES, capabilityManifest: SG_HOSTED_CAPABILITY_MANIFEST,
    birthSelectionFlag: null, birthPolicyReason: null }),
  US: Object.freeze({ jurisdiction: 'US', entityType: 'us-llc', currency: 'USD', version: US_HOSTED_PILOT_VERSION,
    processing: 'accounting', baselineStages: US_HOSTED_PILOT_STAGES, capabilityManifest: US_HOSTED_CAPABILITY_MANIFEST,
    birthSelectionFlag: US_HOSTED_PILOT_FLAG, birthPolicyReason: US_HOSTED_FIRM_POLICY_REASON })
});

export const hostedMarketProfileFor = (jurisdiction) =>
  HOSTED_MARKET_PROFILES[String(jurisdiction || '').trim().toUpperCase()] || null;

// The (jurisdiction, legal form, pilot version) triples whose pilot rows run
// the full accounting pipeline on the hosted runtime.
export const HOSTED_ACCOUNTING_MARKETS = Object.freeze(Object.values(HOSTED_MARKET_PROFILES)
  .filter(row => row.processing === 'accounting'));

// The Jev first-line coder's permanent-policy basis per hosted accounting
// market (FI keeps its historical 'hosted_fi_default' bytes).
export const hostedJevDefaultBasisFor = (jurisdiction) => `hosted_${String(jurisdiction).toLowerCase()}_default`;
export const HOSTED_JEV_DEFAULT_BASES = Object.freeze(HOSTED_ACCOUNTING_MARKETS.map(row => hostedJevDefaultBasisFor(row.jurisdiction)));
