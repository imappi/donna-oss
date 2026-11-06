// Pack-declared buyer facts. Registration is an explicit, scoped, dated fact;
// neither a tax identifier nor the seller's country establishes buyer status.
import { toUtcIsoDay } from '../dates.js';

const clean = (value) => String(value ?? '').trim();
const day = (value) => /^\d{4}-\d{2}-\d{2}$/.test(value || '')
  && toUtcIsoDay(value) === value;

export const hasBuyerRegistrationFloor = (pack) =>
  (pack?.documents?.mandatory_fields?.invoice_when_buyer_tax_registered || []).length > 0;

export const validBuyerRegistrationFact = (fact) => {
  if (!fact || typeof fact !== 'object' || Array.isArray(fact)) return false;
  if (!['registered', 'not_registered', 'unknown'].includes(fact.status)) return false;
  if (!/^[a-z]{2}$/.test(fact.jurisdiction || '')) return false;
  if (fact.source !== 'owner_statement') return false;
  if (!day(fact.effectiveFrom)) return false;
  if (fact.effectiveUntil != null && (!day(fact.effectiveUntil) || fact.effectiveUntil <= fact.effectiveFrom)) return false;
  if (fact.status !== 'registered' && clean(fact.registrationId)) return false;
  return true;
};

export const resolveBuyerRegistration = ({ pack, fact, onDate }) => {
  const unresolved = (reason) => ({ taxRegistered: null, taxRegistrationId: null, reason });
  if (!validBuyerRegistrationFact(fact)) return unresolved('buyer_registration_unknown');
  const contract = pack?.documents?.buyer_tax_registration;
  if (!contract || fact.jurisdiction !== contract.jurisdiction) return unresolved('buyer_registration_foreign');
  if (!day(onDate) || onDate < fact.effectiveFrom
    || (fact.effectiveUntil && onDate >= fact.effectiveUntil)) return unresolved('buyer_registration_stale');
  if (fact.status === 'unknown') return unresolved('buyer_registration_unknown');
  if (fact.status === 'not_registered') return { taxRegistered: false, taxRegistrationId: null, reason: null };
  const id = clean(fact.registrationId);
  if (!id || !new RegExp(contract.registration_id_pattern).test(id)) return unresolved('buyer_registration_id_required');
  return { taxRegistered: true, taxRegistrationId: id, reason: null };
};

export const buyerRegistrationQuestion = (reason) => reason === 'buyer_registration_id_required'
  ? 'Please provide the buyer’s tax registration number for this invoice, together with the registration country and the date this status applies from.'
  : 'Please confirm whether the buyer is tax registered in the invoice’s tax jurisdiction, the date this status applies from, and their tax registration number if registered.';
