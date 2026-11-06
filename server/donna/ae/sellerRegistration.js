import { resolveAeVatRegistrationOnDate } from './vatRegistration.js';

export const resolveSellerRegistration = ({ profile, onDate }) => {
  const result = resolveAeVatRegistrationOnDate({ registration: profile.vat_registration ?? null, onDate });
  return {
    taxRegistered: result.registered,
    taxRegistrationId: result.registrationId,
    regime: 'ae_vat',
    reason: result.reason,
    confirmedAgainstPrimary: result.confirmedAgainstPrimary
  };
};
