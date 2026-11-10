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

// The loader shown before the client is known ("Loading your books…") cannot
// apply rule 2: the owner's language arrives with the client. So the portal
// remembers, on this device, the language it last opened in, and the loader
// uses that as its surface default. It is a hint for the loader only: never a
// saved choice (rule 1 still wins, and nothing is written to the person's
// interface preferences), never sent anywhere, and replaced the next time the
// portal opens with a known client.
export const PORTAL_LAST_LOCALE_KEY = 'donna.portal.last_interface_locale.v1';

const deviceStorage = (storage) => {
  if (storage !== undefined) return storage;
  try {
    return typeof window !== 'undefined' ? window.localStorage : null;
  } catch {
    return null;
  }
};

export const rememberPortalLocale = (locale, storage = undefined) => {
  const target = deviceStorage(storage);
  if (!target || !locale) return;
  const resolved = resolveInterfaceLocale(locale);
  if (resolved.fallbackReason || resolved.locale !== locale) return;
  try {
    target.setItem(PORTAL_LAST_LOCALE_KEY, locale);
  } catch {
    // Storage unavailable or full: the loader keeps the registry default.
  }
};

export const rememberedPortalLocale = (storage = undefined) => {
  const target = deviceStorage(storage);
  if (!target) return null;
  try {
    const locale = target.getItem(PORTAL_LAST_LOCALE_KEY);
    if (!locale) return null;
    const resolved = resolveInterfaceLocale(locale);
    return resolved.fallbackReason ? null : resolved.locale;
  } catch {
    return null;
  }
};
