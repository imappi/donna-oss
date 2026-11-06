const privateFirmModules = import.meta.glob('../private/firmClientProfile.*.js', {
  eager: true
});

const privateFirmData = Object.values(privateFirmModules)
  .map((module) => module.default || module)
  .find(Boolean) || {};

export const privateFirmClientProfile = privateFirmData.firmClientProfile || null;
export const privateFirmClientProfiles =
  privateFirmData.firmClientProfiles ||
  (privateFirmData.firmClientProfile ? [privateFirmData.firmClientProfile] : null);
export const privateFirmMockQueue = privateFirmData.firmMockQueue || null;
export const privateFirmMockHistory = privateFirmData.firmMockHistory || null;
