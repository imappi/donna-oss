import test from 'node:test';
import assert from 'node:assert/strict';

import {
  INTERFACE_LOCALES,
  PRODUCTION_INTERFACE_LOCALES,
  applyDocumentLocale,
  decodeInterfacePreferences,
  readInterfacePreferences,
  resolveInterfaceLocale,
  writeInterfacePreferences
} from './localeRegistry.js';
import {
  formatAccountingAmount,
  formatAccountingDate,
  formatAccountingTimestamp,
  formatInterfaceNumber
} from './localeFormatting.js';

const memoryStorage = (seed = {}) => {
  const values = new Map(Object.entries(seed));
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    values
  };
};

// Intl writes Finnish groups with a no-break space and negatives with U+2212.
const NBSP = ' ';
const MINUS = '−';

test('Finnish is a ready alpha interface locale whose label says it is an early version', () => {
  const entry = INTERFACE_LOCALES.fi;
  assert.equal(entry.tag, 'fi');
  assert.equal(entry.formatLocale, 'fi');
  assert.equal(entry.direction, 'ltr');
  assert.equal(entry.status, 'ready');
  assert.equal(entry.maturity, 'alpha');
  assert.equal(entry.autonym, 'Suomi');
  assert.equal(entry.productionLabel, 'Suomi — varhainen versio');
  assert.ok(PRODUCTION_INTERFACE_LOCALES.includes(entry));

  const resolved = resolveInterfaceLocale('fi');
  assert.equal(resolved.locale, 'fi');
  assert.equal(resolved.fallbackReason, null);
});

test('a Finnish choice persists per device and lands on the document before paint', () => {
  const storage = memoryStorage();
  const saved = writeInterfacePreferences({ locale: 'fi', numberStyle: 'locale' }, { storage, dispatch: null });
  assert.equal(saved.locale, 'fi');
  assert.equal(saved.saved, true);
  const read = readInterfacePreferences({ storage });
  assert.equal(read.locale, 'fi');
  assert.equal(read.saved, true);

  const documentLike = { documentElement: { lang: '', dir: '', dataset: {} } };
  applyDocumentLocale(documentLike, read);
  assert.deepEqual(documentLike.documentElement, { lang: 'fi', dir: 'ltr', dataset: { interfaceLocale: 'fi' } });
});

test('only a stored choice counts as the person’s own', () => {
  assert.equal(readInterfacePreferences({ storage: memoryStorage() }).saved, false);
  assert.equal(readInterfacePreferences({ storage: null }).saved, false);
  assert.equal(decodeInterfacePreferences('{broken').saved, false);
  assert.equal(decodeInterfacePreferences(JSON.stringify({ numberStyle: 'latn' })).saved, false);
  assert.equal(decodeInterfacePreferences(JSON.stringify({ locale: 'en' })).saved, true);
});

test('Finnish euro amounts read 1 234,56 € with a minus sign for negatives', () => {
  assert.equal(formatAccountingAmount(1234.56, { locale: 'fi', currency: 'EUR' }), `1${NBSP}234,56${NBSP}€`);
  assert.equal(formatAccountingAmount(1234567.5, { locale: 'fi', currency: 'EUR' }), `1${NBSP}234${NBSP}567,50${NBSP}€`);
  assert.equal(formatAccountingAmount(-25, { locale: 'fi', currency: 'EUR' }), `${MINUS}25,00${NBSP}€`);
  // A caller that asks for accounting parentheses still gets them.
  assert.equal(
    formatAccountingAmount(-25, { locale: 'fi', currency: 'EUR', negativeStyle: 'parentheses' }),
    `(25,00${NBSP}€)`
  );
  // Currencies without a Finnish symbol keep their code.
  assert.equal(formatAccountingAmount(10, { locale: 'fi', currency: 'AED' }), `10,00${NBSP}AED`);
  assert.equal(formatAccountingAmount(1234.5, { locale: 'fi', currency: '' }), `1${NBSP}234,50`);
});

test('English and Arabic amounts keep their code display and parentheses', () => {
  assert.equal(formatAccountingAmount(1234.56, { locale: 'en', currency: 'EUR' }), `EUR${NBSP}1,234.56`);
  assert.equal(formatAccountingAmount(-25, { locale: 'en', currency: 'EUR' }), `(EUR${NBSP}25.00)`);
  const arabic = formatAccountingAmount(-25, { locale: 'ar-AE', numberStyle: 'latn', currency: 'AED' });
  assert.ok(arabic.startsWith('(') && arabic.endsWith(')') && arabic.includes('AED'));
});

test('Finnish dates are d.m.yyyy with Finnish month and weekday names', () => {
  assert.equal(formatAccountingDate('2026-08-31', { locale: 'fi', timeZone: 'Europe/Helsinki' }), '31.8.2026');
  assert.equal(formatAccountingDate('2026-01-05', { locale: 'fi', timeZone: 'Europe/Helsinki' }), '5.1.2026');
  assert.equal(
    formatAccountingDate('2026-08-01', { locale: 'fi', day: undefined, month: 'long', year: 'numeric' }),
    'elokuu 2026'
  );
  assert.equal(
    formatAccountingDate('2026-08-31', { locale: 'fi', weekday: 'long', day: 'numeric', month: 'long', year: undefined }),
    '31. elokuuta'
  );
  const weekday = new Intl.DateTimeFormat('fi', { weekday: 'long', timeZone: 'Europe/Helsinki' })
    .format(new Date(Date.UTC(2026, 7, 31, 12)));
  assert.equal(weekday, 'maanantai');
  const timestamp = formatAccountingTimestamp('2026-08-31T20:15:30Z', {
    locale: 'fi', timeZone: 'Europe/Helsinki', timeZoneName: null
  });
  assert.equal(timestamp, '31.8.2026 klo 23.15.30');
});

test('Finnish counts and percentages use a decimal comma and space grouping', () => {
  assert.equal(formatInterfaceNumber(1234, { locale: 'fi' }), `1${NBSP}234`);
  assert.equal(
    formatInterfaceNumber(0.125, { locale: 'fi', style: 'percent', minimumFractionDigits: 1, maximumFractionDigits: 1 }),
    `12,5${NBSP}%`
  );
  assert.equal(formatInterfaceNumber(2.5, { locale: 'fi', maximumFractionDigits: 1 }), '2,5');
});
