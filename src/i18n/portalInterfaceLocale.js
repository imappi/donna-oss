// The client portal's default interface language — the rule, in one place:
//
//   1. A person's own saved choice on this device always wins (LocaleProvider).
//   2. Otherwise the portal opens in the language its owner is written to in.
//      That answer comes from the ONE server resolver,
//      server/donna/ownerLanguage.js: an explicit owner language on the
//      client's profile wins (Finnish ⇒ 'fi', anything else ⇒ 'en'); with none
//      set, a Finnish (FI) jurisdiction means Finnish; otherwise English.
//   3. Every other surface (the firm workspace) keeps the registry default.
//
// The portal's client record at first paint is the firm snapshot's client:
// the stored profile spread at the top level (server/donna/db/snapshot.js), so
// the resolver reads the same `locale` / `language` / `preferredLanguage` /
// `jurisdiction` keys here as it does on the server, and the client's
// authoritative jurisdiction column from `persisted_identity.jurisdiction`.
// No second language rule.
import { preferredOwnerTemplateLanguage } from '../../server/donna/ownerLanguage.js';
import { resolveInterfaceLocale } from './localeRegistry.js';

// Owner language → interface locale. Only ready interface locales qualify.
const OWNER_LANGUAGE_INTERFACE_LOCALE = Object.freeze({ fi: 'fi', en: 'en' });

export const portalDefaultInterfaceLocale = (client) => {
  if (!client || typeof client !== 'object') return null;
  const locale = OWNER_LANGUAGE_INTERFACE_LOCALE[preferredOwnerTemplateLanguage(client, client.persisted_identity)] || null;
  if (!locale) return null;
  const resolved = resolveInterfaceLocale(locale);
  return resolved.fallbackReason ? null : resolved.locale;
};

// The client the portal renders: the routed client id, else the first client
// (the same selection donna-client-portal.jsx makes).
export const portalClientForDefault = (clients, clientId) => {
  const list = Array.isArray(clients) ? clients : [];
  return clientId ? list.find((client) => client?.id === clientId) || null : list[0] || null;
};
