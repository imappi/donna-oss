import { resolveGstRegistrationOnDate } from './gstRegistration.js';
import { isRegistrationRecord, unknownSellerRegistration } from '../sellerRegistration.js';

export const resolveSellerRegistration = ({ profile, onDate }) => {
  if (!isRegistrationRecord(profile.gst_registration)) return unknownSellerRegistration('sg_gst', 'no_record');
  const result = resolveGstRegistrationOnDate({ registration: profile.gst_registration, onDate });
  return {
    taxRegistered: result.registered === true,
    taxRegistrationId: result.registered === true
      ? (String(profile.gst_registration.gst_registration_number ?? '').trim() || null) : null,
    regime: 'sg_gst',
    reason: result.reason,
    confirmedAgainstPrimary: !result.unverified
  };
};
