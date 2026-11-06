// Shared result shape only. Country modules decide registration meaning.
export const unknownSellerRegistration = (regime, reason) => ({
  taxRegistered: null, taxRegistrationId: null, regime, reason, confirmedAgainstPrimary: false
});

export const isRegistrationRecord = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
