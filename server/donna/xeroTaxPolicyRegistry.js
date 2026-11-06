// Explicit country ownership for Xero treatment translation. Other countries
// retain supplied connector codes and chart defaults without interpreting prose.
import { resolveGbCoderTaxType } from './gb/xeroTaxTypes.js';
import { SG_XERO_TAX_TYPE_LABELS, resolveSgCoderTaxType } from './singapore/xeroTaxTypes.js';

export const XERO_TAX_POLICY_REGISTRY = Object.freeze({
  sg: Object.freeze({ resolveCoderTaxType: resolveSgCoderTaxType, labels: SG_XERO_TAX_TYPE_LABELS }),
  gb: Object.freeze({ resolveCoderTaxType: resolveGbCoderTaxType })
});
