// Persisted client identity and registered country facts → the one seller
// context consumed by owner invoice issuance. No I/O, country default, inferred
// tax registration, payment block or due term. Country adapters own registration
// meaning; outbound capability remains a separately declared operation.

import { loadOutboundPack, resolvePackIdForJurisdiction } from './outbound/packs.js';
import { resolveRegisteredSellerTax } from './sellerRegistrationRegistry.js';
import { normalizeProfileJurisdiction } from './profileValidation.js';

const clean = (value) => {
  if (value === null || value === undefined) return null;
  const trimmed = String(value).trim();
  return trimmed || null;
};

const isRecord = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const profileOf = (row = {}) => (isRecord(row?.profile) ? row.profile : {});

// Only the persisted canonical country authorizes seller operations. Historical
// profile facts remain evidence, including when that column is absent or cleared.
export const resolveSellerJurisdiction = (row = {}) => {
  const profile = profileOf(row);
  const column = normalizeProfileJurisdiction(row?.jurisdiction);
  const fromProfile = normalizeProfileJurisdiction(profile.jurisdiction);
  const country = column;
  if (!country || !/^[a-z]{2}$/.test(country)) {
    return { jurisdiction: null, status: 'jurisdiction_unresolved' };
  }
  const entities = [row?.entity_type, profile.entityType, profile.entity_type]
    .map((value) => clean(value)?.toLowerCase()).filter(Boolean);
  const conflict = (profile.jurisdiction != null && profile.jurisdiction !== '' && fromProfile !== country)
    || new Set(entities).size > 1
    || entities.some((entity) => /^[a-z]{2}-/.test(entity)
      && normalizeProfileJurisdiction(entity.slice(0, 2)) !== country);
  return conflict
    ? { jurisdiction: null, status: 'jurisdiction_context_conflict' }
    : { jurisdiction: country, status: 'resolved' };
};

export const jurisdictionForClientRow = (row = {}) => resolveSellerJurisdiction(row).jurisdiction;

// Compatibility export for existing readers. Dispatch is owned by the named
// registration root; this orchestration module has no country algorithms.
export const resolveSellerTaxRegistration = resolveRegisteredSellerTax;

// ── The seller context ───────────────────────────────────────────────────────
//
// Pure. Never throws: an unresolvable fact comes back as null and the adapter
// turns it into one of its own named refusals (`no_pack_for_jurisdiction` when
// `pack` is null, `issuer_not_configured` when `seller.name` is null, and the
// mint's `OUTBOUND_INVOICE_NO_PAYMENT_BLOCK` when the payment block is neither
// on file nor covered by a pay-link).
export const resolveOwnerInvoiceSellerContext = (row = {}, { onDate = null, packsRoot, registrationRegistry } = {}) => {
  const profile = profileOf(row);
  const identity = resolveSellerJurisdiction(row);
  const { jurisdiction } = identity;
  const loadOpts = packsRoot === undefined ? {} : { packsRoot };

  let pack = null;
  let packId = null;
  if (jurisdiction) {
    // A missing or malformed capability/pack refuses invoice issuance without
    // taking the owner webhook down.
    try {
      packId = resolvePackIdForJurisdiction(jurisdiction, loadOpts);
      if (packId) pack = loadOutboundPack(packId, loadOpts);
    } catch {
      pack = null;
      packId = null;
    }
  }

  const tax = identity.status === 'resolved'
    ? resolveSellerTaxRegistration({ jurisdiction, profile, onDate }, { registry: registrationRegistry })
    : { taxRegistered: null, taxRegistrationId: null, regime: null,
      reason: identity.status, confirmedAgainstPrimary: false };
  // A broken registration implementation is an operation failure, even for a
  // pack whose floor does not currently inspect registration. Never hide it as
  // an ordinary absent owner fact and continue minting.
  if (tax.reason === 'seller_registration_invalid' || tax.reason === 'seller_registration_unavailable') {
    pack = null;
    packId = null;
  }

  return {
    pack,
    packId,
    jurisdiction,
    jurisdictionResolution: identity.status,
    seller: {
      // Same two homes and same precedence the FI seller reader uses, so a
      // client provisioned by either path resolves identically.
      name: clean(row?.company_name) || clean(row?.name) || clean(profile.companyName) || clean(profile.company_name),
      // Companies House number / Y-tunnus / UEN — the registry identity, kept
      // distinct from the tax registration id by core's vocabulary (gap 1).
      businessId: clean(profile.businessId) || clean(profile.business_id) || clean(profile.uen),
      address: clean(profile.address),
      taxRegistrationId: tax.taxRegistrationId,
      taxRegistered: tax.taxRegistered
    },
    // The M1 seam `receivableCases.js` already reads. A pay-link makes it
    // optional at the mint; nothing is invented here when it is absent.
    paymentInstructions: clean(profile.payment_instructions),
    // Deliberately NOT defaulted. No authored pack declares a default payment
    // term, and a guessed due date is a guessed legal deadline. Null lets the
    // owner's own stated term win and otherwise falls to the mint's documented
    // 14-day fallback, rather than this module inventing a third answer.
    dueDays: null,
    // Carried for the receipt, not for a decision: which regime answered, why,
    // and whether the registration was ever confirmed against a primary source.
    taxRegistration: {
      regime: tax.regime,
      reason: tax.reason,
      confirmedAgainstPrimary: tax.confirmedAgainstPrimary
    }
  };
};
