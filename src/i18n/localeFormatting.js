import {
  DEFAULT_INTERFACE_LOCALE,
  DEFAULT_NUMBER_STYLE,
  INTERFACE_LOCALES,
  NUMBER_STYLES,
  normalizeNumberStyle
} from './localeRegistry.js';

const formatLocaleFor = (locale) =>
  INTERFACE_LOCALES[locale]?.formatLocale
  || INTERFACE_LOCALES[DEFAULT_INTERFACE_LOCALE].formatLocale;

const numberingSystemFor = (numberStyle) =>
  NUMBER_STYLES[normalizeNumberStyle(numberStyle)]?.numberingSystem || undefined;

export const createAccountingNumberFormatter = ({
  locale = DEFAULT_INTERFACE_LOCALE,
  numberStyle = DEFAULT_NUMBER_STYLE,
  currency = 'AED',
  minimumFractionDigits = 2,
  maximumFractionDigits = 2,
  signDisplay = 'auto'
} = {}) => {
  const currencyCode = String(currency || '').trim();
  return new Intl.NumberFormat(formatLocaleFor(locale), {
    style: currencyCode ? 'currency' : 'decimal',
    ...(currencyCode ? {
      currency: currencyCode,
      currencyDisplay: 'code',
      currencySign: 'accounting'
    } : {}),
    minimumFractionDigits,
    maximumFractionDigits,
    signDisplay,
    numberingSystem: numberingSystemFor(numberStyle)
  });
};

export const formatAccountingAmount = (value, options = {}) => {
  const amount = Number(value);
  if (!Number.isFinite(amount)) throw new TypeError('Accounting amount must be finite.');
  const formatter = createAccountingNumberFormatter(options);
  if (amount < 0 && options.negativeStyle !== 'minus') {
    return `(${formatter.format(Math.abs(amount))})`;
  }
  return formatter.format(amount);
};

// The interface's "no value" glyph — what a count or ratio renders as when
// there is nothing finite to show. The same dash the mounted surfaces use.
export const INTERFACE_NO_VALUE = '\u2014';

// A plain interface number — a count, a ratio, a percentage — in the reader's
// locale and digit style. It is NOT an accounting amount: no currency, no
// accounting parentheses, and the caller's Intl.NumberFormat options
// (style: 'percent', fraction digits, …) pass straight through. It never
// throws: a non-finite input renders INTERFACE_NO_VALUE, because a formatter
// that throws inside a render is a white screen. (The Profile and People tabs
// destructured `formatNumber` from useInterfaceLocale from 2026-09-02
// (7e97170a) while the provider exposed no such formatter — every Profile
// click unmounted the app until this existed.)
export const createInterfaceNumberFormatter = ({
  locale = DEFAULT_INTERFACE_LOCALE,
  numberStyle = DEFAULT_NUMBER_STYLE,
  ...intlOptions
} = {}) => new Intl.NumberFormat(formatLocaleFor(locale), {
  ...intlOptions,
  numberingSystem: numberingSystemFor(numberStyle)
});

export const formatInterfaceNumber = (value, options = {}) => {
  const number = Number(value);
  if (!Number.isFinite(number)) return INTERFACE_NO_VALUE;
  return createInterfaceNumberFormatter(options).format(number);
};

const accountingDateValue = (value) => {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    // PostgreSQL DATE values may arrive as local-midnight Date objects. Preserve
    // their local calendar components before applying the book timezone so a
    // presentation conversion cannot move the accounting fact by one day.
    return new Date(Date.UTC(value.getFullYear(), value.getMonth(), value.getDate(), 12));
  }
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ''));
  if (!match) throw new TypeError('Accounting date must be an ISO calendar date.');
  // Midday UTC keeps the local calendar date stable in the AE book timezone.
  return new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 12));
};

export const createAccountingDateFormatter = (options = {}) => {
  const {
    locale = DEFAULT_INTERFACE_LOCALE,
    numberStyle = DEFAULT_NUMBER_STYLE,
    timeZone = 'Asia/Dubai'
  } = options;
  const field = (name, fallback) => Object.prototype.hasOwnProperty.call(options, name)
    ? options[name]
    : fallback;
  const day = field('day', 'numeric');
  const month = field('month', 'short');
  const year = field('year', 'numeric');
  return new Intl.DateTimeFormat(formatLocaleFor(locale), {
    ...(day ? { day } : {}),
    ...(month ? { month } : {}),
    ...(year ? { year } : {}),
    calendar: 'gregory',
    numberingSystem: numberingSystemFor(numberStyle),
    timeZone
  });
};

export const formatAccountingDate = (value, options = {}) =>
  createAccountingDateFormatter(options).format(accountingDateValue(value));

const accountingTimestampValue = (value) => {
  const timestamp = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(timestamp.getTime())) throw new TypeError('Accounting timestamp must be valid.');
  return timestamp;
};

export const createAccountingTimestampFormatter = (options = {}) => {
  const {
    locale = DEFAULT_INTERFACE_LOCALE,
    numberStyle = DEFAULT_NUMBER_STYLE,
    timeZone = 'Asia/Dubai'
  } = options;
  const field = (name, fallback) => Object.prototype.hasOwnProperty.call(options, name)
    ? options[name]
    : fallback;
  const day = field('day', '2-digit');
  const month = field('month', 'short');
  const year = field('year', 'numeric');
  const hour = field('hour', '2-digit');
  const minute = field('minute', '2-digit');
  const second = field('second', '2-digit');
  const timeZoneName = field('timeZoneName', 'short');
  return new Intl.DateTimeFormat(formatLocaleFor(locale), {
    ...(day ? { day } : {}),
    ...(month ? { month } : {}),
    ...(year ? { year } : {}),
    ...(hour ? { hour } : {}),
    ...(minute ? { minute } : {}),
    ...(second ? { second } : {}),
    ...(timeZoneName ? { timeZoneName } : {}),
    calendar: 'gregory',
    numberingSystem: numberingSystemFor(numberStyle),
    timeZone
  });
};

export const formatAccountingTimestamp = (value, options = {}) =>
  createAccountingTimestampFormatter(options).format(accountingTimestampValue(value));

const ARABIC_INDIC_ZERO = '٠'.codePointAt(0);
const EASTERN_ARABIC_ZERO = '۰'.codePointAt(0);

export const normalizeArabicDigits = (value) => String(value ?? '')
  .replace(/[٠-٩]/g, (digit) => String(digit.codePointAt(0) - ARABIC_INDIC_ZERO))
  .replace(/[۰-۹]/g, (digit) => String(digit.codePointAt(0) - EASTERN_ARABIC_ZERO))
  .replaceAll('٫', '.')
  .replaceAll('٬', ',');
