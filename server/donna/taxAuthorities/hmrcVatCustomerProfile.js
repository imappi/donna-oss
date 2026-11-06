const invalidProfile = (message) => {
  const error = new Error(message);
  error.code = 'GB_VAT_OBLIGATION_INVALID';
  error.statusCode = 400;
  return error;
};

export const normalizeHmrcVatCustomerProfile = (profile) => {
  if (!profile || typeof profile.id !== 'string' || profile.id.length === 0) {
    throw invalidProfile('profile.id is required.');
  }
  if (typeof profile.vrn !== 'string' || profile.vrn.length === 0) {
    throw invalidProfile('profile.vrn is required.');
  }
  if (profile.payload === undefined) {
    throw invalidProfile('profile.payload is required.');
  }
  return {
    id: profile.id,
    vrn: profile.vrn,
    effectiveRegistrationDate: profile.effectiveRegistrationDate ?? null,
    flatRateScheme: profile.flatRateScheme ?? null,
    deregistrationDate: profile.deregistrationDate ?? null,
    payload: profile.payload
  };
};
