import { TAX_VOCABULARY } from './taxVocabulary.js';
import { loadOutboundPack, fallbackAccountNamesForPack, suspenseAccountNameForPack } from '../outbound/packs.js';

export const US_CODING_POLICY = Object.freeze({
  id: 'us_coding', version: 1, jurisdiction: 'us', taxVocabulary: TAX_VOCABULARY.marker,
  taxTreatmentOptions: TAX_VOCABULARY.options, defaultTaxTreatment: TAX_VOCABULARY.unsureMarker,
  outOfScopeTaxTreatment: TAX_VOCABULARY.outOfScope, taxInstructions: TAX_VOCABULARY.instructionsNote,
  loadAccountPalette: () => { const pack = loadOutboundPack('us'); return { accountOptions: fallbackAccountNamesForPack(pack), suspenseAccountName: suspenseAccountNameForPack(pack) }; },
});
