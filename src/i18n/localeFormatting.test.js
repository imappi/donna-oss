import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createAccountingDateFormatter,
  createAccountingNumberFormatter,
  createAccountingTimestampFormatter,
  formatAccountingAmount,
  formatAccountingDate,
  formatAccountingTimestamp,
  formatInterfaceNumber,
  INTERFACE_NO_VALUE,
  normalizeArabicDigits
} from './localeFormatting.js';

test('accounting amount formatters carry explicit AED, numbering and negative policy', () => {
  const western = formatAccountingAmount(1234.56, {
    locale: 'en', numberStyle: 'latn', currency: 'AED'
  });
  assert.match(western, /AED/);
  assert.match(western, /1,234\.56/);

  const arabicDigits = formatAccountingAmount(1234.56, {
    locale: 'ar-XB', numberStyle: 'arab', currency: 'AED'
  });
  assert.match(arabicDigits, /١/);
  assert.match(arabicDigits, /AED/);

  const negative = formatAccountingAmount(-25, {
    locale: 'ar-XB', numberStyle: 'arab', currency: 'AED'
  });
  assert.ok(negative.startsWith('(') && negative.endsWith(')'));
  assert.equal(createAccountingNumberFormatter({ numberStyle: 'arab' }).resolvedOptions().numberingSystem, 'arab');
});

test('accounting dates are Gregorian and pinned to the book timezone', () => {
  const formatter = createAccountingDateFormatter({
    locale: 'ar-XB', numberStyle: 'arab', timeZone: 'Asia/Dubai'
  });
  const options = formatter.resolvedOptions();
  assert.equal(options.calendar, 'gregory');
  assert.equal(options.numberingSystem, 'arab');
  assert.equal(options.timeZone, 'Asia/Dubai');
  assert.match(formatAccountingDate('2026-08-31', {
    locale: 'ar-XB', numberStyle: 'arab', timeZone: 'Asia/Dubai'
  }), /٢٠٢٦/);

  const monthOnly = formatAccountingDate('2026-08-01', {
    locale: 'en', day: undefined, month: 'long', year: 'numeric'
  });
  assert.equal(monthOnly, 'August 2026');

  const shortWithoutYear = formatAccountingDate('2026-08-14', {
    locale: 'en', day: '2-digit', month: 'short', year: undefined
  });
  assert.equal(shortWithoutYear, 'Aug 14');

  const localMidnightDate = new Date(2026, 7, 31, 0, 0, 0);
  assert.match(formatAccountingDate(localMidnightDate, {
    locale: 'en', timeZone: 'Asia/Dubai'
  }), /Aug 31, 2026/);
});

test('audit timestamps use the interface numbering system and the AE book timezone', () => {
  const formatter = createAccountingTimestampFormatter({
    locale: 'ar-XB', numberStyle: 'arab', timeZone: 'Asia/Dubai'
  });
  const options = formatter.resolvedOptions();
  assert.equal(options.calendar, 'gregory');
  assert.equal(options.numberingSystem, 'arab');
  assert.equal(options.timeZone, 'Asia/Dubai');
  assert.match(formatAccountingTimestamp('2026-08-31T20:15:30Z', {
    locale: 'ar-XB', numberStyle: 'arab', timeZone: 'Asia/Dubai'
  }), /٢٠٢٦/);

  const timeOnly = formatAccountingTimestamp('2026-08-31T20:15:30Z', {
    locale: 'en',
    timeZone: 'Asia/Dubai',
    day: null,
    month: null,
    year: null,
    second: null,
    timeZoneName: null
  });
  assert.match(timeOnly, /12:15/);
  assert.doesNotMatch(timeOnly, /2026|Aug|GMT/);
});

test('formatters reject non-canonical values instead of parsing their own localized output', () => {
  assert.throws(() => formatAccountingAmount('not-money'), /finite/);
  assert.throws(() => formatAccountingDate('31/08/2026'), /ISO calendar date/);
});

test('the input boundary normalizes both Arabic digit families without touching evidence text elsewhere', () => {
  assert.equal(normalizeArabicDigits('١٬٢٣٤٫٥٦'), '1,234.56');
  assert.equal(normalizeArabicDigits('۱۲۳'), '123');
});

test('interface numbers (counts, percentages) follow the locale and digit style, pass Intl options through, and never throw', () => {
  assert.equal(formatInterfaceNumber(1234, { locale: 'en', numberStyle: 'latn' }), '1,234');
  assert.equal(
    formatInterfaceNumber(0.125, { locale: 'en', numberStyle: 'latn', style: 'percent', minimumFractionDigits: 2, maximumFractionDigits: 2 }),
    '12.50%'
  );
  assert.equal(formatInterfaceNumber(0.4, { locale: 'en', numberStyle: 'latn', style: 'percent', maximumFractionDigits: 0 }), '40%');
  assert.match(formatInterfaceNumber(1234, { locale: 'ar-XB', numberStyle: 'arab' }), /١/);
  assert.doesNotMatch(formatInterfaceNumber(1234, { locale: 'ar-XB', numberStyle: 'arab' }), /AED/);
  // A render must never throw on a missing count: the dash, not a TypeError.
  assert.equal(formatInterfaceNumber(Number.NaN), INTERFACE_NO_VALUE);
  assert.equal(formatInterfaceNumber(undefined), INTERFACE_NO_VALUE);
  assert.equal(formatInterfaceNumber('3'), '3');
});
