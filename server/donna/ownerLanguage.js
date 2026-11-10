// The ONE resolver for the language Donna uses with a client's business owner.
//
// Leaf module (no imports) so both the delivery plane (db/channels.js, the
// WhatsApp template language) and the ask drafter (askPipeline.js, the
// language the owner-facing message is written in) read the same answer
// without an import cycle: db/channels.js reaches askPipeline.js through
// db/clients.js → … → db/asks.js, so askPipeline.js cannot import it back.
// db/channels.js re-exports both names unchanged.
//
// preferredOwnerTemplateLanguage(profile, { jurisdiction }) — `profile` is the
// client's stored profile JSON; `jurisdiction` is the client's
// `clients.jurisdiction` column, the authoritative home of the client's
// country (the country packs and statutory code read it: countryLifecycleContext.js,
// profileValidation.js resolveProfileWriteJurisdiction). Every caller that has
// the client row passes it; a client whose country lives only in the column is
// otherwise read as English.
//
// Returns 'fi' or 'en'. Precedence:
//   1. an explicit owner language on the profile (locale, language, or
//      preferredLanguage): Finnish ⇒ 'fi', anything else ⇒ 'en'. An owner who
//      chose English keeps English even when the company is Finnish.
//   2. nothing set ⇒ the client's country default: FI ⇒ 'fi'. The country is
//      the column; the legacy profile.jurisdiction is read only when the column
//      is empty. When both are set and disagree, neither outranks the other
//      (as in resolveProfileWriteJurisdiction): there is no country default.
//   3. otherwise 'en'.

export const OWNER_TEMPLATE_FALLBACK_LANGUAGE = 'en';

// Same normalisation as profileValidation.js normalizeProfileJurisdiction
// (inlined: this module stays a leaf).
const countryKey = (value) => {
  const country = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return country === 'uk' ? 'gb' : country === 'unknown' ? '' : country;
};

const ownerCountry = (columnJurisdiction, profileJurisdiction) => {
  const column = countryKey(columnJurisdiction);
  const profile = countryKey(profileJurisdiction);
  if (column && profile && column !== profile) return null;
  return column || profile || null;
};

export const preferredOwnerTemplateLanguage = (profile, client = null) => {
  const locale = String(profile?.locale || profile?.language || profile?.preferredLanguage || '').trim().toLowerCase();
  if (locale) return locale.startsWith('fi') ? 'fi' : OWNER_TEMPLATE_FALLBACK_LANGUAGE;
  return ownerCountry(client?.jurisdiction, profile?.jurisdiction) === 'fi' ? 'fi' : OWNER_TEMPLATE_FALLBACK_LANGUAGE;
};
