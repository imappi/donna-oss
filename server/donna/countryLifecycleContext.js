import { normalizeJurisdictionKey } from './taxCodeJurisdiction.js';
// Current country selection uses persisted identity, never flags or a fallback
// implementation. Legacy profile fields remain readable only when non-conflicting.
export const lifecycleJurisdiction = (row = {}) => {
  const country = normalizeJurisdictionKey(row?.jurisdiction);
  if (!country) return null;
  const profile = row?.profile || {};
  if (profile.jurisdiction && normalizeJurisdictionKey(profile.jurisdiction) !== country) return null;
  const forms = [row?.entity_type, profile.entity_type, profile.entityType]
    .filter(v => typeof v === 'string' && v.trim()).map(v => v.trim().toLowerCase());
  if (new Set(forms).size > 1 || forms.some(form => /^[a-z]{2}-/.test(form) && normalizeJurisdictionKey(form.slice(0, 2)) !== country)) return null;
  return country;
};
