// GB Xero tax-type vocabulary: deterministic translation of the strong
// coder's persisted VAT treatment, never a treatment decision.
export const GB_XERO_TAX_TYPE_PROVENANCE = Object.freeze({
  authority: 'Xero UK organisation default tax rates',
  source: 'Remembered Xero UK tax-type vocabulary; primary documentation unavailable in this environment (F-GB-XERO-1)',
  as_of: '2026-07-31',
  confirmedAgainstPrimary: false
});

export const GB_XERO_TAX_TYPES = Object.freeze({
  standard: Object.freeze({ out: 'OUTPUT2', in: 'INPUT2' }),
  reduced: Object.freeze({ out: 'OUTPUT3', in: 'INPUT3' }),
  zero: Object.freeze({ out: 'ZERORATEDOUTPUT', in: 'ZERORATEDINPUT' }),
  exempt: Object.freeze({ out: 'EXEMPTOUTPUT', in: 'EXEMPTINPUT' }),
  reverse_charge: Object.freeze({ out: 'REVERSECHARGES', in: 'REVERSECHARGES' }),
  none: Object.freeze({ out: 'NONE', in: 'NONE' }),
  out_of_scope: Object.freeze({ out: 'BASEXCLUDED', in: 'BASEXCLUDED' })
});

export const KNOWN_GB_XERO_TAX_TYPES = new Set(
  Object.values(GB_XERO_TAX_TYPES).flatMap((entry) => Object.values(entry))
);

const legFor = (direction) => direction === 'in' ? 'out' : 'in';
const normalized = (value) => String(value || '').trim().toLowerCase();

export const resolveGbCoderTaxType = ({ taxType = '', taxTreatment = '', direction = '' } = {}) => {
  const explicit = String(taxType || '').trim().toUpperCase();
  if (explicit && KNOWN_GB_XERO_TAX_TYPES.has(explicit)) return explicit;
  const treatment = normalized(taxTreatment);
  const leg = legFor(direction);
  if (!treatment) return '';
  if (treatment.includes('reverse charge')) return GB_XERO_TAX_TYPES.reverse_charge[leg];
  if (treatment.includes('5%') || treatment.includes('5 %') || treatment.includes('reduced')) return GB_XERO_TAX_TYPES.reduced[leg];
  if (treatment.includes('20%') || treatment.includes('20 %') || treatment.includes('standard')) return GB_XERO_TAX_TYPES.standard[leg];
  if (treatment.includes('zero-rated') || treatment.includes('zero rated')) return GB_XERO_TAX_TYPES.zero[leg];
  if (treatment.includes('exempt')) return GB_XERO_TAX_TYPES.exempt[leg];
  if (treatment.includes('out of scope') || treatment.includes('not subject') || treatment.includes('not applicable')) return GB_XERO_TAX_TYPES.out_of_scope[leg];
  if (treatment.includes('no vat') || treatment.includes('not registered')) return GB_XERO_TAX_TYPES.none[leg];
  return '';
};
