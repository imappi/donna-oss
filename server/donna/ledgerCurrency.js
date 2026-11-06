import { normalizeIsoCurrency } from './parsePrimitives.js';

const currencies = new Set(Intl.supportedValuesOf('currency'));
export const normalizeLedgerCurrency = value => {
  const currency = normalizeIsoCurrency(value);
  return currencies.has(currency) ? currency : null;
};

// Denomination is evidence about an amount, not a country default. These
// refusals reach the existing API/proposal repair surface before ledger writes.
export const requireLedgerCurrency = (value, source = 'journal', { retained = false } = {}) => {
  // Retained journal denomination is historical evidence: ICU's current list
  // must not prevent reversing a currency that has since been withdrawn.
  const currency = retained ? normalizeIsoCurrency(value) : normalizeLedgerCurrency(value);
  if (currency) return currency;
  const error = new Error(`Confirm the ${source} currency before posting; no currency has been assumed.`);
  error.code = 'LEDGER_CURRENCY_UNRESOLVED';
  error.statusCode = 409;
  error.details = { source, repair: 'confirm_source_currency' };
  throw error;
};

export const assertLedgerCurrencyMatches = (value, currency, source = 'journal line', options) => {
  const actual = requireLedgerCurrency(value, source, options);
  if (actual === currency) return actual;
  const error = new Error(`The ${source} currency conflicts with the journal currency. Confirm denomination and conversion before posting.`);
  error.code = 'LEDGER_CURRENCY_CONFLICT';
  error.statusCode = 409;
  error.details = { source, currency: actual, journal_currency: currency, repair: 'confirm_source_currency' };
  throw error;
};
