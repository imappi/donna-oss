import { TAX_VOCABULARY } from './taxVocabulary.js';
import { loadOutboundPack, fallbackAccountNamesForPack, suspenseAccountNameForPack } from '../outbound/packs.js';

export const AE_CODING_POLICY = Object.freeze({
  id: 'ae_coding', version: 1, jurisdiction: 'ae', taxVocabulary: TAX_VOCABULARY.marker,
  taxTreatmentOptions: TAX_VOCABULARY.options, defaultTaxTreatment: TAX_VOCABULARY.unsureMarker,
  outOfScopeTaxTreatment: TAX_VOCABULARY.outOfScope, taxInstructions: TAX_VOCABULARY.instructionsNote,
  loadAccountPalette: () => { const pack = loadOutboundPack('ae'); return { accountOptions: fallbackAccountNamesForPack(pack), suspenseAccountName: suspenseAccountNameForPack(pack) }; },
});
