import test from 'node:test';
import assert from 'node:assert/strict';

import en from './catalogs/en.js';
import {
  INTERFACE_CATALOGS,
  assertCatalogParity,
  getInterfaceCatalog,
  pseudoLocalizeMessage,
  validateInterfaceCatalog
} from './localeCatalog.js';

test('every runtime catalog is valid ICU and has exact English key/placeholder parity', () => {
  for (const [locale, catalog] of Object.entries(INTERFACE_CATALOGS)) {
    assert.deepEqual(validateInterfaceCatalog(catalog, { locale }), []);
    assert.equal(assertCatalogParity(en, catalog, { locale }), true);
  }
});

test('pseudo localization expands copy without corrupting ICU arguments', () => {
  const source = 'Could not load {requestedLocale}.';
  const pseudo = pseudoLocalizeMessage(source);
  assert.ok(pseudo.length > source.length);
  assert.match(pseudo, /\{requestedLocale\}/);
  assert.match(pseudo, /^⟦ /);
});

test('pseudo localization expands plural option text without corrupting ICU grammar', () => {
  const source = '{count, plural, one {# transaction imported} other {# transactions imported}}';
  const pseudo = pseudoLocalizeMessage(source);
  assert.match(pseudo, /one \{# ŧřááñšááçŧïïööñ ïïɱþööřŧëëđ\}/);
  assert.doesNotMatch(pseudo, /transactions imported/);
  assert.deepEqual(validateInterfaceCatalog({ plural: pseudo }, { locale: 'ar-XB' }), []);
});

test('the complete Arabic catalog is installed while availability stays a registry decision', () => {
  assert.ok(getInterfaceCatalog('ar-AE'));
  assert.ok(getInterfaceCatalog('en'));
  assert.ok(getInterfaceCatalog('ar-XB'));
});

test('catalog drift fails closed', () => {
  assert.throws(
    () => assertCatalogParity(en, { ...en, unexpected: 'No' }, { locale: 'drift' }),
    /key mismatch/
  );
  assert.throws(
    () => assertCatalogParity(
      { sample: 'Hello {name}' },
      { sample: 'Hello {other}' },
      { locale: 'drift' }
    ),
    /placeholder mismatch/
  );
  assert.throws(
    () => assertCatalogParity(
      { sample: '{count, plural, one {One} other {Other}}' },
      { sample: '{count, select, one {واحد} other {غير ذلك}}' },
      { locale: 'drift' }
    ),
    /ICU argument structure mismatch/
  );
});
