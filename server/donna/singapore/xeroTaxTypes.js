import { normalizeIntelText } from '../transactionIntel.js';

export const SG_XERO_TAX_TYPE_LABELS = Object.freeze({
  OUTPUT: 'Standard-Rated Supplies (9%)',
  OUTPUTY24: 'Standard-Rated Supplies (9%)',
  INPUT: 'Standard-Rated Purchases (9%)',
  INPUTY24: 'Standard-Rated Purchases (9%)',
  NONE: 'No Tax (0%)',
  BASEXCLUDED: 'Out Of Scope (0%)',
  OPINPUT: 'Out Of Scope Purchases (0%)',
  OPOUTPUT: 'Out Of Scope Supplies (0%)',
  EXEMPTOUTPUT: 'Exempt Supplies (0%)',
  ZERORATEDOUTPUT: 'Zero-Rated Supplies (0%)'
});

// The known SG tax-type CODES (keys above) — used to recognise a coder-supplied
// xero_tax_type that is ALREADY a real Xero code (honour it verbatim).
const KNOWN_TAX_TYPE_CODES = new Set(Object.keys(SG_XERO_TAX_TYPE_LABELS));

// Translate the strong coder's tax VERDICT into a Xero tax-type code. This plumbs
// the model's decision through to the write-back — it does NOT re-decide it, and
// it must OUTRANK the matched account's chart default. (The prior bug:
// `xero_tax_type` was forced to the account default, so a "No GST" foreign-supplier
// charge coded to a standard-rated account posted phantom 9% input GST.) Order:
// an explicit, real Xero code from the coder wins; else the prose `tax_treatment`
// is mapped — out-of-scope / no-GST → Out Of Scope (OPINPUT for a purchase,
// OPOUTPUT for a supply, the firm's chosen mapping), zero-rated / exempt keep
// their own codes. Returns '' for standard/taxable/unknown so the caller falls
// back to the account default (which carries the right standard rate).
export const resolveSgCoderTaxType = ({ taxType = '', taxTreatment = '', direction = '' } = {}) => {
  const explicit = String(taxType || '').trim().toUpperCase();
  if (explicit && KNOWN_TAX_TYPE_CODES.has(explicit)) return explicit;
  const treatment = normalizeIntelText(taxTreatment);
  if (!treatment) return '';
  const isSupply = direction === 'in';
  if (/zero\s*rated/.test(treatment)) return isSupply ? 'ZERORATEDOUTPUT' : 'OPINPUT';
  if (/exempt/.test(treatment)) return isSupply ? 'EXEMPTOUTPUT' : 'OPINPUT';
  if (/(no gst|out of scope|not subject|not applicable|not registered|reverse charge|foreign supply)/.test(treatment)) {
    return isSupply ? 'OPOUTPUT' : 'OPINPUT';
  }
  return '';
};
