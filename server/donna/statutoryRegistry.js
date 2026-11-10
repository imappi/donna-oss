// Named composition root. Public compatibility exports retain function identity;
// country-owned implementations keep their existing named persistence writers.
import * as finland from './finland/statutoryDb.js';
import * as gb from './gb/statutoryDb.js';
import * as ae from './ae/statutoryDb.js';
import * as singapore from './singapore/statutoryDb.js';
import { normalizeJurisdictionKey } from './taxCodeJurisdiction.js';
import { totalsMismatchReplyAdapter } from './totalsMismatchReply.js';
import { taxRegistrationReplyAdapter } from './taxRegistrationReply.js';

export {
  getSingaporeGstDraftArtifactFromDb,
  singaporeGstDraftFilename
} from './singapore/gstReturnArtifact.js';

export {
  getFinlandAnnualReturnFromDb,
  getFinlandCutoverPackFromDb,
  getFinlandAlvReturnFromDb,
  getFinlandAlvThresholdWatchFromDb,
  drainFinlandAlvThresholdEscalations,
  deliverPendingFinlandScopeDriftAsks,
  getFinlandScopeDriftFromDb,
  getFinlandOyOnboardingStateFromDb,
  getFinlandOyYelApplicabilityFromDb,
  getFinlandOyBalanceSheetWatchesFromDb,
  getFinlandOyMonthlyCloseFromDb,
  getFinlandYelStatusFromDb,
  getFinlandEnnakkoveroStatusFromDb,
  __recordPrepaymentRegisterCheckWithClient,
  recordPrepaymentRegisterCheckInDb,
  getFinlandPrepaymentRegisterFromDb,
  getFinlandScopeDriftFilingGateFromDb,
  finlandAlvFilingWhatsAppFlagActsInDb,
  createAlvReturnEvidenceRequestInDb,
  __createAlvReturnDraftWithClient,
  createAlvReturnDraftInDb,
  __cancelAlvReturnWithClient,
  cancelAlvReturnInDb,
  __markAlvReturnFiledWithClient,
  markAlvReturnFiledInDb,
  getAlvReturnByIdInDb,
  getAlvReturnForPeriodInDb,
  findLiveAlvReturnsOverlappingInDb,
  assertAlvReturnFileableInDb,
  __recordSuomifiMandateWithClient,
  recordSuomifiMandateInDb,
  __revokeSuomifiMandateWithClient,
  revokeSuomifiMandateInDb,
  getActiveSuomifiMandateInDb,
  getSuomifiMandateStatusInDb,
  startFinlandAlvReturnFilingInDb
} from './finland/statutoryDb.js';

export {
  getGbStatutoryReportFromDb,
  buildGbLtdCloseRefusalEnvelope,
  prepareGbVatReturnFromDb,
  drainGbVatThresholdEscalations,
  getGbLtdMonthlyCloseFromDb
} from './gb/statutoryDb.js';

export {
  recordAeVatRegistrationReply,
  drainAeVatThresholdEscalations,
  drainAeVatReturnDeadlineEscalations,
  drainAeCtRegistrationEscalations,
  drainAeVatRegistrationEscalations
} from './ae/statutoryDb.js';

export {
  getSingaporeGstReturnFromDb,
  singaporeGstFilingFlagActsInDb,
  createGstReturnEvidenceRequestInDb,
  __createGstReturnDraftWithClient,
  createGstReturnDraftInDb,
  __cancelGstReturnWithClient,
  cancelGstReturnInDb,
  __markGstReturnFiledWithClient,
  markGstReturnFiledInDb,
  getGstReturnByIdInDb,
  getGstReturnForPeriodInDb,
  __recordCorpPassMandateWithClient,
  recordCorpPassMandateInDb,
  __revokeCorpPassMandateWithClient,
  revokeCorpPassMandateInDb,
  getActiveCorpPassMandateInDb,
  getCorpPassMandateStatusInDb,
  startSingaporeGstReturnFilingInDb,
  getSingaporeFilerContextInDb
} from './singapore/statutoryDb.js';

export const createStatutoryRegistry = (definitions) => {
  for (const [country, handlers] of Object.entries(definitions)) {
    if (!/^[a-z]{2}$/.test(country) || !handlers || typeof handlers !== 'object' || Array.isArray(handlers)) {
      throw new TypeError('Statutory registration requires a canonical country and named handlers.');
    }
  }
  // Preserve module namespaces: reading their exports during module initialization
  // would enter the existing firmDb import cycle before its bindings initialize.
  return Object.freeze({ ...definitions });
};

export const STATUTORY_REGISTRY = createStatutoryRegistry({ fi: finland, gb, ae, sg: singapore });

export const resolveStatutoryHandler = ({ jurisdiction, operation, registry = STATUTORY_REGISTRY } = {}) => {
  const country = normalizeJurisdictionKey(jurisdiction);
  const refuse = (code) => {
    const error = new Error(`Statutory operation '${operation || ''}' cannot resolve jurisdiction '${country || ''}'.`);
    error.code = code;
    error.statusCode = 409;
    error.details = { jurisdiction: country || null, operation: operation || null };
    throw error;
  };
  if (!country) return refuse('statutory_jurisdiction_unresolved');
  if (!Object.hasOwn(registry, country)) return refuse('statutory_jurisdiction_unsupported');
  if (!Object.hasOwn(registry[country], operation) || typeof registry[country][operation] !== 'function') {
    return refuse('statutory_operation_unsupported');
  }
  return registry[country][operation];
};

// Optional interpretation contracts are registered by the same country modules
// as their named factual writers. No generic engine branch owns a country's ask.
// A few ask LANES are market-neutral engine work rather than a country's fact
// (FI-03: the RT-10 totals lane). They register once, keyed by their evidence
// type AND `request_payload.lane`, so a generic evidence type such as
// 'supporting_document' is never claimed wholesale. Their key in the listing
// below is '<evidence_type>#<lane>', which the discovery SQL matches.
// A lane whose question is minted on a bank line but is about the business
// (the VAT/ALV registration question, taxRegistrationReply.js) declares
// `transactionAnchored`; only such a lane claims a line-anchored ask.
const LANE_OWNER_REPLY_ADAPTERS = Object.freeze([totalsMismatchReplyAdapter, taxRegistrationReplyAdapter]);
const laneKey = adapter => `${adapter.evidenceType}#${adapter.lane}`;
const laneOwnerReplyAdapter = request => LANE_OWNER_REPLY_ADAPTERS.find(adapter => adapter.evidenceType === request?.evidence_type
  && adapter.lane === request?.request_payload?.lane && (!request?.transaction_id || adapter.transactionAnchored === true)) || null;
export const listStructuredOwnerReplyEvidenceTypes = ({ registry = STATUTORY_REGISTRY } = {}) =>
  [...new Set([...Object.values(registry).flatMap(handlers => handlers.getOwnerReplyAdapters?.() || [])
    .map(adapter => adapter.evidenceType), ...LANE_OWNER_REPLY_ADAPTERS.map(laneKey)])];
export const supportsStructuredOwnerReplyEvidenceType = evidenceType =>
  listStructuredOwnerReplyEvidenceTypes().includes(evidenceType);
// The request-aware form: a registered country evidence type, or a registered lane.
export const supportsStructuredOwnerReply = request =>
  Boolean(laneOwnerReplyAdapter(request)) || supportsStructuredOwnerReplyEvidenceType(request?.evidence_type);
export const resolveStructuredOwnerReplyAdapter = ({ jurisdiction, evidenceType, request = null, registry = STATUTORY_REGISTRY } = {}) => {
  const lane = request ? laneOwnerReplyAdapter(request) : null;
  if (lane) return lane;
  const handlers = registry[normalizeJurisdictionKey(jurisdiction)];
  return (handlers?.getOwnerReplyAdapters?.() || []).find(adapter => adapter.evidenceType === evidenceType) || null;
};
