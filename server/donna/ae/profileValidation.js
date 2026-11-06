// Country-owned profile fields. Registration is independent of legal form and tax status.
import { normalizeAeVatRegistration } from './vatRegistration.js';
import { normalizeAeCtRegistration } from './ctRegistration.js';
import { normalizeAeEstablishment } from './establishment.js';

export const PROFILE_VALIDATORS = Object.freeze({
  vat_registration: (value) => normalizeAeVatRegistration(value),
  ct_registration: (value) => normalizeAeCtRegistration(value),
  ae_establishment: (value) => normalizeAeEstablishment(value)
});
