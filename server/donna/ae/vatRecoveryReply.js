import { assertAeFactualReplyActor } from './factualReplyActor.js';
import { AE_VAT_BUSINESS_USE } from './vatAutomationContract.js';

export const validateAeVatBusinessUseAnswer = answer => Boolean(answer && typeof answer === 'object' && !Array.isArray(answer)
  && Object.keys(answer).length === 3 && Object.keys(answer).every(key => ['business_purpose','exclusively_taxable_business_use','personal_use'].includes(key))
  && typeof answer.business_purpose === 'string' && answer.business_purpose.trim().length > 0
  && answer.business_purpose.length <= 2000 && typeof answer.exclusively_taxable_business_use === 'boolean'
  && typeof answer.personal_use === 'boolean' && !(answer.exclusively_taxable_business_use && answer.personal_use));

export const aeVatRecoveryReplyAdapter = Object.freeze({
  evidenceType: AE_VAT_BUSINESS_USE,
  action: 'record_ae_vat_business_use',
  answerSchema: { type: 'object', additionalProperties: false,
    required: ['business_purpose','exclusively_taxable_business_use','personal_use'], properties: {
      business_purpose: { type: 'string', minLength: 1, maxLength: 2000 },
      exclusively_taxable_business_use: { type: 'boolean' }, personal_use: { type: 'boolean' }
    } },
  instructions: `Interpret only the owner's business-purpose and actual-use answer about the named invoice. The owner supplies facts, never a VAT recovery election or legal judgment. Exclusively taxable business use requires the owner's description to establish use solely for the business's taxable supplies; never infer it from silence or from saying 'yes' to a different question. Preserve negative, mixed-use and personal-use answers. If the purpose or personal/business allocation is unclear, ask one precise factual clarification. Never ask for the invoice already held.`,
  validateAnswer: validateAeVatBusinessUseAnswer,
  authorize: ({ client, firmId, request, actorId }) => assertAeFactualReplyActor({ client, firmId, clientId: request.client_id, actorId }),
  apply: async args => {
    const { recordAeVatBusinessUseWithClient } = await import('../db/coding.js');
    return recordAeVatBusinessUseWithClient(args);
  }
});
