import { TAX_VOCABULARY } from './taxVocabulary.js';
import { loadOutboundPack, fallbackAccountNamesForPack, suspenseAccountNameForPack } from '../outbound/packs.js';
import { GB_OWNER_TRANSACTION_TYPES, GB_SOLE_TRADER_OWNER_TRANSACTION_TYPES, classifyOwnerTransaction } from './ownerTransactionTaxonomy.js';
import { gbEntityType } from './entity.js';

const OWNER_TRANSACTION_INSTRUCTIONS_NOTES = Object.freeze({
  ltd: `owner_transaction_type: when a line moves value between the company and its director/shareholder (salary, dividend, reimbursement, a director's loan movement, share capital), set it from the closed list; leave it '' for every ordinary third-party line. The type is your judgment from the evidence in front of you — when you can tell it is an owner transfer but not which kind, answer unknown_owner_transfer rather than guessing a specific type. The runtime applies the statutory evidence discipline per type; your job is only the honest identification.`,
  sole_trader: `owner_transaction_type: this client is a sole trader — the owner and the business are one legal person, so there is no salary, dividend or director's loan. When a line moves value between the owner personally and the business, set the type from the closed list (owner_drawings for money taken, owner_capital_introduced for money put in, business_expense_paid_personally / mileage_claim for claims, goods_own_use for stock taken privately); leave it '' for every ordinary third-party line. When you can tell it is an owner transfer but not which kind, answer unknown_owner_transfer rather than guessing.`
});

const OWNER_TYPES = { ltd: GB_OWNER_TRANSACTION_TYPES, sole_trader: GB_SOLE_TRADER_OWNER_TRANSACTION_TYPES };
const ownerPolicyFor = ({ entityType }) => {
  const axis = gbEntityType({ entity_type: entityType });
  return OWNER_TYPES[axis] ? Object.freeze({ axis, types: OWNER_TYPES[axis], instructions: OWNER_TRANSACTION_INSTRUCTIONS_NOTES[axis], classify: ({type,evidence}) => classifyOwnerTransaction({type,evidence,entityAxis:axis}) }) : null;
};

export const GB_CODING_POLICY = Object.freeze({
  id: 'gb_coding', version: 1, jurisdiction: 'gb', taxVocabulary: TAX_VOCABULARY.marker,
  taxTreatmentOptions: TAX_VOCABULARY.options, defaultTaxTreatment: TAX_VOCABULARY.unsureMarker,
  outOfScopeTaxTreatment: TAX_VOCABULARY.outOfScope, taxInstructions: TAX_VOCABULARY.instructionsNote,
  loadAccountPalette: () => { const pack = loadOutboundPack('gb'); return { accountOptions: fallbackAccountNamesForPack(pack), suspenseAccountName: suspenseAccountNameForPack(pack) }; },
  ownerPolicyFor,
});
