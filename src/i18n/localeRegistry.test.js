import test from 'node:test';
import assert from 'node:assert/strict';

import {
  INTERFACE_LOCALES,
  INTERFACE_PREFERENCES_KEY,
  PRODUCTION_INTERFACE_LOCALES,
  applyDocumentLocale,
  decodeInterfacePreferences,
  isInterfaceLocaleLabEnabled,
  isLocaleShellPreview,
  isLocaleMountedPreview,
  isLocaleSettingsPreview,
  isLocaleWorkspacePreview,
  readInterfacePreferences,
  resolveInterfaceLocale,
  writeInterfacePreferences
} from './localeRegistry.js';

const memoryStorage = (seed = {}) => {
  const values = new Map(Object.entries(seed));
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    values
  };
};

test('the registry exposes only ready interface locales in production', () => {
  assert.equal(INTERFACE_LOCALES.en.status, 'ready');
  assert.equal(INTERFACE_LOCALES['ar-AE'].status, 'ready');
  assert.equal(INTERFACE_LOCALES['ar-XB'].status, 'test_only');
  assert.equal(INTERFACE_LOCALES['ar-AE'].direction, 'rtl');
  assert.equal(INTERFACE_LOCALES['ar-AE'].maturity, 'alpha');
  assert.deepEqual(PRODUCTION_INTERFACE_LOCALES.map((entry) => entry.tag), ['en', 'ar-AE']);
  assert.equal(PRODUCTION_INTERFACE_LOCALES[1].productionLabel, 'العربية — إصدار تجريبي');

  assert.equal(resolveInterfaceLocale('en').locale, 'en');
  assert.equal(resolveInterfaceLocale('ar-AE').locale, 'ar-AE');
  assert.equal(resolveInterfaceLocale('ar-AE').fallbackReason, null);
  assert.equal(resolveInterfaceLocale('ar-XB').fallbackReason, 'test_locale_disabled');
  assert.equal(resolveInterfaceLocale('ar-XB', { allowTestLocale: true }).locale, 'ar-XB');
});

test('production preferences persist Arabic per device while pseudo-RTL remains test-only', () => {
  const storage = memoryStorage();
  const saved = writeInterfacePreferences(
    { locale: 'ar-AE', numberStyle: 'arab' },
    { storage, dispatch: null }
  );
  assert.equal(saved.locale, 'ar-AE');
  assert.deepEqual(
    JSON.parse(storage.values.get(INTERFACE_PREFERENCES_KEY)),
    { locale: 'ar-AE', numberStyle: 'arab' }
  );
  assert.equal(readInterfacePreferences({ storage }).locale, 'ar-AE');
  assert.equal(readInterfacePreferences({ storage }).numberStyle, 'arab');

  assert.throws(
    () => writeInterfacePreferences(
      { locale: 'ar-XB', numberStyle: 'locale' },
      { storage, dispatch: null }
    ),
    /not available/
  );
});

test('invalid or unknown saved values fall visibly to English', () => {
  assert.equal(decodeInterfacePreferences('{broken').fallbackReason, 'preferences_invalid');
  const unknown = decodeInterfacePreferences(JSON.stringify({ locale: 'zz-ZZ', numberStyle: 'bogus' }));
  assert.equal(unknown.locale, 'en');
  assert.equal(unknown.numberStyle, 'locale');
  assert.equal(unknown.fallbackReason, 'locale_unknown');
});

test('Arabic stays ready outside labs and the test locale still needs an explicit lab override', () => {
  const production = resolveInterfaceLocale('ar-AE');
  assert.equal(production.locale, 'ar-AE');
  assert.equal(production.entry.direction, 'rtl');
  assert.equal(production.fallbackReason, null);
  assert.equal(resolveInterfaceLocale('ar-XB').locale, 'en');
  assert.equal(resolveInterfaceLocale('ar-XB', { allowTestLocale: true }).locale, 'ar-XB');
});

test('pre-paint document attributes carry language, direction and fallback state', () => {
  const documentLike = { documentElement: { lang: '', dir: '', dataset: {} } };
  applyDocumentLocale(documentLike, resolveInterfaceLocale('ar-XB', { allowTestLocale: true }));
  assert.deepEqual(documentLike.documentElement, {
    lang: 'ar-XB',
    dir: 'rtl',
    dataset: { interfaceLocale: 'ar-XB' }
  });

  applyDocumentLocale(documentLike, resolveInterfaceLocale('ar-AE'));
  assert.equal(documentLike.documentElement.lang, 'ar-AE');
  assert.equal(documentLike.documentElement.dir, 'rtl');
  assert.equal(documentLike.documentElement.dataset.localeFallback, undefined);
});

test('the pseudo locale and standalone Settings preview are development-only', () => {
  assert.equal(isInterfaceLocaleLabEnabled({ search: '?locale-lab=1', development: true }), true);
  assert.equal(isInterfaceLocaleLabEnabled({ search: '?locale-lab=settings', development: true }), true);
  assert.equal(isInterfaceLocaleLabEnabled({ search: '?locale-lab=shell', development: true }), true);
  assert.equal(isInterfaceLocaleLabEnabled({ search: '?locale-lab=workspaces', development: true }), true);
  assert.equal(isInterfaceLocaleLabEnabled({ search: '?locale-lab=mounted', development: true }), true);
  assert.equal(isInterfaceLocaleLabEnabled({ search: '?locale-lab=1', development: false }), false);
  assert.equal(isLocaleSettingsPreview({ search: '?locale-lab=settings', development: true }), true);
  assert.equal(isLocaleSettingsPreview({ search: '?locale-lab=settings-production', development: true }), true);
  assert.equal(isInterfaceLocaleLabEnabled({ search: '?locale-lab=settings-production', development: true }), false);
  assert.equal(isLocaleSettingsPreview({ search: '?locale-lab=1', development: true }), false);
  assert.equal(isLocaleSettingsPreview({ search: '?locale-lab=settings', development: false }), false);
  assert.equal(isLocaleShellPreview({ search: '?locale-lab=shell', development: true }), true);
  assert.equal(isLocaleShellPreview({ search: '?locale-lab=settings', development: true }), false);
  assert.equal(isLocaleShellPreview({ search: '?locale-lab=shell', development: false }), false);
  assert.equal(isLocaleWorkspacePreview({ search: '?locale-lab=workspaces', development: true }), true);
  assert.equal(isLocaleWorkspacePreview({ search: '?locale-lab=shell', development: true }), false);
  assert.equal(isLocaleWorkspacePreview({ search: '?locale-lab=workspaces', development: false }), false);
  assert.equal(isLocaleMountedPreview({ search: '?locale-lab=mounted', development: true }), true);
  assert.equal(isLocaleMountedPreview({ search: '?locale-lab=shell', development: true }), false);
  assert.equal(isLocaleMountedPreview({ search: '?locale-lab=mounted', development: false }), false);
});
