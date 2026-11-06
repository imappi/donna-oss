import { resolveAlvRegistrationAsOf } from './alvRegistration.js';
import { isRegistrationRecord, unknownSellerRegistration } from '../sellerRegistration.js';

export const resolveSellerRegistration = ({ profile, onDate }) => {
  // The legacy ALV reader's absent-record default is safe in its original lane,
  // but cannot select a seller's statutory invoice floor. Absence is unknown.
  if (!isRegistrationRecord(profile.alv_registration)) return unknownSellerRegistration('fi_alv', 'no_record');
  const result = resolveAlvRegistrationAsOf({ registration: profile.alv_registration, asOf: onDate });
  return {
    taxRegistered: result.registered === true,
    // The record has no separate ALV-number field; never invent an identifier.
    taxRegistrationId: null,
    regime: 'fi_alv',
    reason: result.registered === true ? 'registered' : (result.status || 'not_registered'),
    confirmedAgainstPrimary: Boolean(result.confirmedAgainstPrimary)
  };
};
