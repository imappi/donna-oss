// Named composition root for country-owned invoice/quote lifecycle operations.
// Registration declares capability, never authority. Keep the module namespace
// lazy across the existing database import cycle; exports preserve writer identity.
import * as finland from './finland/issuanceDb.js';
import { normalizeJurisdictionKey } from './taxCodeJurisdiction.js';

export {
  finlandInvoiceIssuanceEntryActsInDb,
  finlandEInvoiceReceiveEntryActsInDb,
  finlandInvoicingWhatsAppFlagActsInDb,
  finlandEInvoiceReceiveWhatsAppFlagActsInDb,
  finlandQuotesWhatsAppFlagActsInDb,
  finlandAlvInvoicingWhatsAppFlagActsInDb,
  persistFinlandSellerIdentityInDb,
  createInvoiceIssuanceEvidenceRequestInDb,
  __createIssuedInvoiceDraftWithClient,
  createIssuedInvoiceDraftInDb,
  __supersedeIssuedInvoiceDraftWithClient,
  supersedeIssuedInvoiceDraftInDb,
  __cancelIssuedInvoiceWithClient,
  cancelIssuedInvoiceInDb,
  __markIssuedInvoiceIssuedWithClient,
  markIssuedInvoiceIssuedInDb,
  getIssuedInvoiceCreditContextInDb,
  __createIssuedQuoteDraftWithClient,
  createIssuedQuoteDraftInDb,
  __supersedeIssuedQuoteDraftWithClient,
  supersedeIssuedQuoteDraftInDb,
  __cancelIssuedQuoteWithClient,
  cancelIssuedQuoteInDb,
  __markIssuedQuoteSentWithClient,
  markIssuedQuoteSentInDb,
  __declineIssuedQuoteWithClient,
  declineIssuedQuoteInDb,
  getIssuedQuoteByIdInDb,
  getIssuedQuoteContextInDb,
  getFinlandQuotesFromDb,
  getFinlandIssuedInvoicesFromDb,
  getInvoiceSellerContextInDb,
  getIssuedInvoiceByIdInDb
} from './finland/issuanceDb.js';

export const createIssuanceRegistry = (definitions) => {
  for (const [country, operations] of Object.entries(definitions)) {
    if (!/^[a-z]{2}$/.test(country) || !operations || typeof operations !== 'object' || Array.isArray(operations)) {
      throw new TypeError('Issuance registration requires a canonical country and named operations.');
    }
  }
  return Object.freeze({ ...definitions });
};
export const ISSUANCE_REGISTRY = createIssuanceRegistry({ fi: finland });
export const resolveIssuanceOperation = ({ jurisdiction, operation, registry = ISSUANCE_REGISTRY } = {}) => {
  const country = normalizeJurisdictionKey(jurisdiction);
  const implementation = country && Object.hasOwn(registry, country) ? registry[country] : null;
  if (implementation && Object.hasOwn(implementation, operation) && typeof implementation[operation] === 'function') return implementation[operation];
  const error = new Error(`Issuance operation '${operation || ''}' is unavailable for '${country || ''}'.`);
  error.code = !country ? 'issuance_jurisdiction_unresolved' : !implementation ? 'issuance_jurisdiction_unsupported' : 'issuance_operation_unsupported';
  error.statusCode = 409;
  throw error;
};
