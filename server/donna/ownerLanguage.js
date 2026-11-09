// The ONE resolver for the language Donna uses with a client's business owner.
//
// Leaf module (no imports) so both the delivery plane (db/channels.js, the
// WhatsApp template language) and the ask drafter (askPipeline.js, the
// language the owner-facing message is written in) read the same answer
// without an import cycle: db/channels.js reaches askPipeline.js through
// db/clients.js → … → db/asks.js, so askPipeline.js cannot import it back.
// db/channels.js re-exports both names unchanged.
//
// Returns 'fi' or 'en'. Precedence:
//   1. an explicit owner language on the profile (locale, language, or
//      preferredLanguage): Finnish ⇒ 'fi', anything else ⇒ 'en'. An owner who
//      chose English keeps English even when the company is Finnish.
//   2. nothing set ⇒ the jurisdiction's default: FI ⇒ 'fi'.
//   3. otherwise 'en'.

export const OWNER_TEMPLATE_FALLBACK_LANGUAGE = 'en';

export const preferredOwnerTemplateLanguage = (profile) => {
  const locale = String(profile?.locale || profile?.language || profile?.preferredLanguage || '').trim().toLowerCase();
  if (locale) return locale.startsWith('fi') ? 'fi' : OWNER_TEMPLATE_FALLBACK_LANGUAGE;
  const jurisdiction = String(profile?.jurisdiction || '').trim().toUpperCase();
  return jurisdiction === 'FI' ? 'fi' : OWNER_TEMPLATE_FALLBACK_LANGUAGE;
};
