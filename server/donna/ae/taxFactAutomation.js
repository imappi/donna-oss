// Country-owned composition loaded lazily by the registered posting policy.
// Effects remain in the existing core coding/fact/journal writers.
import { aeVatAutomationEnabled, aeVatAutomationClientEnabled, aeVatLegacyCodingNeedsRecovery,
  readAeVatReasoningContext, reasonAeVatFacts, aeVatAutomationError } from './vatPostingAutomation.js';
import { AE_VAT_FACT_ACTOR, AE_VAT_FACT_AUTHORITY, AE_VAT_BUSINESS_USE } from './vatAutomationContract.js';
import { assertAeFactualReplyActor } from './factualReplyActor.js';
import { validateAeVatBusinessUseAnswer } from './vatRecoveryReply.js';
import { aeNativeStandardSplit } from './nativeVatPosting.js';

export const AE_TAX_FACT_AUTOMATION = Object.freeze({
  actorId: AE_VAT_FACT_ACTOR, authorityBasis: AE_VAT_FACT_AUTHORITY, evidenceType: AE_VAT_BUSINESS_USE,
  enabled: aeVatAutomationEnabled, clientEnabled: aeVatAutomationClientEnabled,
  legacyNeedsRecovery: aeVatLegacyCodingNeedsRecovery, readContext: readAeVatReasoningContext,
  reason: reasonAeVatFacts, error: aeVatAutomationError, assertActor: assertAeFactualReplyActor,
  validateAnswer: validateAeVatBusinessUseAnswer, validatePostingFacts: aeNativeStandardSplit
});
