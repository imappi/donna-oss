// Named composition root for authored tax vocabulary and historical native codes.
// These declarations validate country membership; they never select a tax treatment.
import { TAX_VOCABULARY as ae } from './ae/taxVocabulary.js';
import { TAX_VOCABULARY as au } from './au/taxVocabulary.js';
import { TAX_VOCABULARY as gb } from './gb/taxVocabulary.js';
import { TAX_VOCABULARY as us } from './us/taxVocabulary.js';
import { FI_ALV_TAX_TREATMENT_OPTIONS, FI_ALV_TAX_VOCABULARY, FI_ALV_UNSURE_MARKER, KNOWN_ALV_CODES } from './finland/alvCodes.js';
import { SG_CODING_POLICY } from './singapore/codingPolicy.js';
import { KNOWN_SG_GST_CODES, SG_GST_TAX_TREATMENT_OPTIONS } from './singapore/gstCodes.js';

export const TAX_VOCABULARY_REGISTRY = Object.freeze({
  ae: Object.freeze({ ...ae, label: 'United Arab Emirates VAT', machineCodes: Object.freeze([]) }),
  au: Object.freeze({ ...au, label: 'Australia GST', machineCodes: Object.freeze([]) }),
  gb: Object.freeze({ ...gb, label: 'United Kingdom VAT', machineCodes: Object.freeze([]) }),
  us: Object.freeze({ ...us, label: 'United States sales tax', machineCodes: Object.freeze([]) }),
  fi: Object.freeze({ marker: FI_ALV_TAX_VOCABULARY, label: 'Finland ALV (VAT)',
    options: FI_ALV_TAX_TREATMENT_OPTIONS, machineCodes: Object.freeze([...KNOWN_ALV_CODES]),
    allCodes: Object.freeze([...KNOWN_ALV_CODES, ...FI_ALV_TAX_TREATMENT_OPTIONS]),
    unsureMarker: FI_ALV_UNSURE_MARKER }),
  sg: Object.freeze({ marker: SG_CODING_POLICY.taxVocabulary, label: 'Singapore GST',
    options: SG_CODING_POLICY.taxTreatmentOptions, machineCodes: Object.freeze([...KNOWN_SG_GST_CODES]),
    allCodes: Object.freeze([...new Set([...SG_CODING_POLICY.taxTreatmentOptions, ...KNOWN_SG_GST_CODES, ...SG_GST_TAX_TREATMENT_OPTIONS])]),
    unsureMarker: SG_CODING_POLICY.uncertainTaxTreatment })
});

// RT-23 (2026-09-09): the coder's UNSURE marker per jurisdiction ('ALV-tarkistus',
// 'VAT check', 'GST check', …). It is the one treatment nothing downstream may
// resolve on the coder's behalf: not a country adapter, not the account's chart
// default. The Kampaamo book showed the chart default doing exactly that — the
// ledger-account upsert had stamped Sales with the last posted code, and the
// matcher's fallback laundered 'ALV-tarkistus' into ALV_25_5_OUTPUT.
// (Keyed on the two-letter registry key the callers already normalize —
// taxCodeJurisdiction.js imports this module, so it cannot be imported here.)
export const unsureTaxTreatmentFor = (jurisdiction) => {
  const key = String(jurisdiction || '').trim().toLowerCase();
  const entry = key && Object.prototype.hasOwnProperty.call(TAX_VOCABULARY_REGISTRY, key) ? TAX_VOCABULARY_REGISTRY[key] : null;
  return entry?.unsureMarker || null;
};
const foldTreatment = (value) => String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
export const isUnsureTaxTreatment = (jurisdiction, treatment) => {
  const marker = unsureTaxTreatmentFor(jurisdiction);
  return Boolean(marker) && foldTreatment(treatment) === foldTreatment(marker);
};
