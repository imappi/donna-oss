// The ask-client question: ONE builder for the text the firm previews on the
// "Ask client" pill and the draft that Send transmits to the client.
//
// A message to the client's business owner is written in the OWNER's
// language, never in the staff member's interface language. The owner's
// language comes from the one resolver, server/donna/ownerLanguage.js, read
// through portalDefaultInterfaceLocale (the same rule the client portal opens
// in): an explicit owner language on the profile wins, else a Finnish (FI)
// jurisdiction means Finnish, else English.
//
// The server sends the question text exactly as the composer holds it
// (POST /transaction-chat/ask-client), so the text is built here, in the
// owner's locale: the sentence, its inserted phrases, the date and the amount.
import { createIntl, createIntlCache } from 'react-intl';

import { getInterfaceCatalog } from '../i18n/localeCatalog.js';
import { INTERFACE_LOCALES } from '../i18n/localeRegistry.js';
import { formatAccountingAmount, formatAccountingDate } from '../i18n/localeFormatting.js';
import { portalDefaultInterfaceLocale } from '../i18n/portalInterfaceLocale.js';
import { askClientBusinessUse, askClientTransactionPhrase } from './interfaceValueLabels.js';

const OWNER_FALLBACK_LOCALE = 'en';
const cache = createIntlCache();
const intls = new Map();

const intlFor = (locale) => {
  if (!intls.has(locale)) {
    intls.set(locale, createIntl({
      locale: INTERFACE_LOCALES[locale]?.formatLocale || OWNER_FALLBACK_LOCALE,
      defaultLocale: OWNER_FALLBACK_LOCALE,
      messages: getInterfaceCatalog(locale) || getInterfaceCatalog(OWNER_FALLBACK_LOCALE),
      onError: () => {}
    }, cache));
  }
  return intls.get(locale);
};

// The locale a message to this client's owner is written in: 'fi' or 'en'.
// `client` is the firm snapshot's client record (profile spread at the top
// level, the jurisdiction column under persisted_identity). With no record the
// resolver's own fallback applies: English.
export const ownerMessageLocale = (client) => portalDefaultInterfaceLocale(client) || OWNER_FALLBACK_LOCALE;

const ownerDate = (value, locale) => {
  if (!value) return null;
  try {
    return formatAccountingDate(value instanceof Date ? value : String(value).slice(0, 10), {
      locale, day: '2-digit', month: 'short', year: 'numeric'
    });
  } catch {
    return null;
  }
};

const ownerAmount = (tx, locale) => {
  const inAmt = Number(tx?.money_in || 0);
  const outAmt = Number(tx?.money_out || 0);
  const currency = tx?.account_currency || tx?.currency || null;
  try {
    if (inAmt > 0) return formatAccountingAmount(inAmt, { locale, currency, signDisplay: 'always', negativeStyle: 'minus' });
    if (outAmt > 0) return formatAccountingAmount(-outAmt, { locale, currency, negativeStyle: 'minus' });
  } catch {
    return null;
  }
  return null;
};

// The question for `tx`, in `locale`. `vendor` is the merchant hint the
// artifact already extracts from the bank description (shown as written).
export const buildAskClientQuestion = ({ tx = {}, vendor = null, locale = OWNER_FALLBACK_LOCALE } = {}) => {
  const intl = intlFor(locale);
  const formatMessage = intl.formatMessage;
  const transaction = askClientTransactionPhrase({
    vendor: vendor || null,
    date: ownerDate(tx.transaction_date || tx.date, locale),
    amount: ownerAmount(tx, locale)
  }, formatMessage);
  const businessUse = askClientBusinessUse(Number(tx.money_in || 0) > 0, formatMessage);
  return formatMessage({ id: 'transaction.question.example' }, { transaction, businessUse });
};

// Interface-language messages naming the language the question is written in.
export const ASK_CLIENT_PREVIEW_MESSAGE_IDS = Object.freeze({
  fi: 'transaction.question.previewIn.fi',
  en: 'transaction.question.previewIn.en'
});
export const ASK_CLIENT_COMPOSER_LANGUAGE_MESSAGE_IDS = Object.freeze({
  fi: 'transaction.composer.clientLanguage.fi',
  en: 'transaction.composer.clientLanguage.en'
});
