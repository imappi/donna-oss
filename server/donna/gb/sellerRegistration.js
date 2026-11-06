import { resolveGbVatRegistrationOnDate } from './vatRegistration.js';

export const resolveSellerRegistration = ({ profile, onDate }) => {
  const result = resolveGbVatRegistrationOnDate({ registration: profile.vat_registration ?? null, onDate });
  return {
    taxRegistered: result.registered,
    taxRegistrationId: result.registrationId,
    regime: 'gb_vat',
    reason: result.reason,
    confirmedAgainstPrimary: result.confirmedAgainstPrimary
  };
};
