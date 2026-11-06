export const INTERFACE_PREFERENCES_KEY = 'donna.interface_preferences.v1';
export const INTERFACE_PREFERENCES_EVENT = 'donna:interface-preferences';

export const DEFAULT_INTERFACE_LOCALE = 'en';
export const DEFAULT_NUMBER_STYLE = 'locale';

export const NUMBER_STYLES = Object.freeze({
  locale: { id: 'locale', numberingSystem: null },
  arab: { id: 'arab', numberingSystem: 'arab' },
  latn: { id: 'latn', numberingSystem: 'latn' }
});

// UI language is deliberately separate from book locale and counterparty
// correspondence language. Only `ready` entries can appear in production;
// test-only entries remain available solely to explicit development labs.
export const INTERFACE_LOCALES = Object.freeze({
  en: Object.freeze({
    tag: 'en',
    formatLocale: 'en',
    direction: 'ltr',
    status: 'ready',
    autonym: 'English',
    productionLabel: 'English'
  }),
  'ar-AE': Object.freeze({
    tag: 'ar-AE',
    formatLocale: 'ar-AE',
    direction: 'rtl',
    status: 'ready',
    maturity: 'alpha',
    autonym: 'العربية',
    productionLabel: 'العربية — إصدار تجريبي'
  }),
  'ar-XB': Object.freeze({
    tag: 'ar-XB',
    formatLocale: 'ar-AE',
    direction: 'rtl',
    status: 'test_only',
    autonym: 'RTL preview'
  })
});

export const PRODUCTION_INTERFACE_LOCALES = Object.freeze(
  Object.values(INTERFACE_LOCALES).filter((entry) => entry.status === 'ready')
);

const browserStorage = () => {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
};

const runtimeDevelopment = () => Boolean(import.meta.env?.DEV);

export const normalizeNumberStyle = (value) =>
  Object.prototype.hasOwnProperty.call(NUMBER_STYLES, value)
    ? value
    : DEFAULT_NUMBER_STYLE;

export const resolveInterfaceLocale = (
  requestedLocale,
  { allowTestLocale = false, allowBuildingLocale = false } = {}
) => {
  const requested = String(requestedLocale || DEFAULT_INTERFACE_LOCALE).trim();
  const requestedEntry = INTERFACE_LOCALES[requested] || null;
  const usable = requestedEntry?.status === 'ready'
    || (allowTestLocale && requestedEntry?.status === 'test_only')
    || (allowBuildingLocale && requestedEntry?.status === 'building');

  if (usable) {
    return {
      requestedLocale: requested,
      locale: requested,
      entry: requestedEntry,
      fallbackReason: null
    };
  }

  const fallbackReason = requestedEntry?.status === 'building'
    ? 'locale_not_ready'
    : requestedEntry?.status === 'test_only'
      ? 'test_locale_disabled'
      : requested !== DEFAULT_INTERFACE_LOCALE
        ? 'locale_unknown'
        : null;

  return {
    requestedLocale: requested,
    locale: DEFAULT_INTERFACE_LOCALE,
    entry: INTERFACE_LOCALES[DEFAULT_INTERFACE_LOCALE],
    fallbackReason
  };
};

export const decodeInterfacePreferences = (
  raw,
  { allowTestLocale = false, allowBuildingLocale = false } = {}
) => {
  let parsed = raw;
  let parseFailed = false;
  if (typeof raw === 'string') {
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = null;
      parseFailed = true;
    }
  }

  const object = parsed && typeof parsed === 'object' ? parsed : {};
  const resolved = resolveInterfaceLocale(object.locale, { allowTestLocale, allowBuildingLocale });

  return {
    ...resolved,
    numberStyle: normalizeNumberStyle(object.numberStyle),
    fallbackReason: parseFailed ? 'preferences_invalid' : resolved.fallbackReason
  };
};

export const readInterfacePreferences = ({
  storage = browserStorage(),
  allowTestLocale = false,
  allowBuildingLocale = false
} = {}) => {
  if (!storage) return decodeInterfacePreferences(null, { allowTestLocale, allowBuildingLocale });
  try {
    return decodeInterfacePreferences(
      storage.getItem(INTERFACE_PREFERENCES_KEY),
      { allowTestLocale, allowBuildingLocale }
    );
  } catch {
    return {
      ...decodeInterfacePreferences(null, { allowTestLocale, allowBuildingLocale }),
      fallbackReason: 'preferences_unavailable'
    };
  }
};

export const writeInterfacePreferences = ({
  locale,
  numberStyle
}, {
  storage = browserStorage(),
  allowTestLocale = false,
  allowBuildingLocale = false,
  dispatch = typeof window === 'undefined' ? null : window
} = {}) => {
  const resolved = resolveInterfaceLocale(locale, { allowTestLocale, allowBuildingLocale });
  if (resolved.locale !== locale || resolved.fallbackReason) {
    throw new Error(`Interface locale is not available: ${locale}`);
  }

  const persisted = {
    locale: resolved.locale,
    numberStyle: normalizeNumberStyle(numberStyle)
  };

  if (!storage) throw new Error('Interface preferences are unavailable on this device.');
  storage.setItem(INTERFACE_PREFERENCES_KEY, JSON.stringify(persisted));

  if (dispatch?.dispatchEvent && typeof CustomEvent !== 'undefined') {
    dispatch.dispatchEvent(new CustomEvent(INTERFACE_PREFERENCES_EVENT, { detail: persisted }));
  }

  return { ...resolved, numberStyle: persisted.numberStyle };
};

export const applyDocumentLocale = (documentLike, preferences) => {
  const root = documentLike?.documentElement;
  if (!root) return;
  const locale = preferences?.locale || DEFAULT_INTERFACE_LOCALE;
  const entry = INTERFACE_LOCALES[locale] || INTERFACE_LOCALES[DEFAULT_INTERFACE_LOCALE];
  root.lang = entry.tag;
  root.dir = entry.direction;
  root.dataset.interfaceLocale = entry.tag;
  if (preferences?.fallbackReason) {
    root.dataset.localeFallback = preferences.fallbackReason;
  } else {
    delete root.dataset.localeFallback;
  }
};

export const isInterfaceLocaleLabEnabled = ({
  search = typeof window === 'undefined' ? '' : window.location.search,
  development = runtimeDevelopment()
} = {}) => {
  if (!development) return false;
  const value = new URLSearchParams(search).get('locale-lab');
  return value === '1' || value === 'settings' || value === 'shell' || value === 'workspaces' || value === 'mounted';
};

export const isLocaleSettingsPreview = ({
  search = typeof window === 'undefined' ? '' : window.location.search,
  development = runtimeDevelopment()
} = {}) => development && ['settings', 'settings-production'].includes(
  new URLSearchParams(search).get('locale-lab')
);

export const isLocaleShellPreview = ({
  search = typeof window === 'undefined' ? '' : window.location.search,
  development = runtimeDevelopment()
} = {}) => development && new URLSearchParams(search).get('locale-lab') === 'shell';

export const isLocaleWorkspacePreview = ({
  search = typeof window === 'undefined' ? '' : window.location.search,
  development = runtimeDevelopment()
} = {}) => development && new URLSearchParams(search).get('locale-lab') === 'workspaces';

export const isLocaleMountedPreview = ({
  search = typeof window === 'undefined' ? '' : window.location.search,
  development = runtimeDevelopment()
} = {}) => development && new URLSearchParams(search).get('locale-lab') === 'mounted';
