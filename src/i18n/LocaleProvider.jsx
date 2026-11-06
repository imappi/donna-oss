import { createContext, useCallback, useContext, useLayoutEffect, useMemo, useState } from 'react';
import { FormattedMessage, IntlProvider } from 'react-intl';

import { getInterfaceCatalog } from './localeCatalog.js';
import {
  formatAccountingAmount,
  formatAccountingDate,
  formatAccountingTimestamp,
  formatInterfaceNumber
} from './localeFormatting.js';
import {
  applyDocumentLocale,
  isInterfaceLocaleLabEnabled,
  isLocaleMountedPreview,
  normalizeNumberStyle,
  readInterfacePreferences,
  resolveInterfaceLocale,
  writeInterfacePreferences
} from './localeRegistry.js';

const InterfaceLocaleContext = createContext(null);

const LocaleFallbackNotice = ({ requestedLocale, onUseEnglish }) => (
  <div
    role="alert"
    style={{
      position: 'fixed',
      insetBlockStart: 12,
      insetInlineEnd: 12,
      zIndex: 10000,
      maxWidth: 420,
      padding: '12px 14px',
      border: '1px solid rgba(20, 18, 16, 0.18)',
      borderRadius: 10,
      background: '#fffdf9',
      color: '#171513',
      boxShadow: '0 10px 30px rgba(20, 18, 16, 0.14)',
      font: '14px/1.45 system-ui, sans-serif'
    }}
  >
    <strong style={{ display: 'block', marginBlockEnd: 3 }}>
      <FormattedMessage id="locale.fallback.title" />
    </strong>
    <FormattedMessage
      id="locale.fallback.body"
      values={{ requestedLocale: requestedLocale || 'the saved language' }}
    />
    <button
      type="button"
      onClick={onUseEnglish}
      style={{
        display: 'block',
        marginBlockStart: 8,
        padding: 0,
        border: 0,
        background: 'transparent',
        color: 'inherit',
        font: 'inherit',
        fontWeight: 700,
        textDecoration: 'underline',
        cursor: 'pointer'
      }}
    >
      <FormattedMessage id="locale.fallback.action" />
    </button>
  </div>
);

export const LocaleProvider = ({
  children,
  allowTestLocale = isInterfaceLocaleLabEnabled(),
  allowBuildingLocale = isLocaleMountedPreview(),
  initialPreferences = null,
  storage = undefined
}) => {
  const [preferences, setPreferences] = useState(() => (
    initialPreferences
      ? {
          ...resolveInterfaceLocale(initialPreferences.locale, { allowTestLocale, allowBuildingLocale }),
          numberStyle: normalizeNumberStyle(initialPreferences.numberStyle)
        }
      : readInterfacePreferences({ storage, allowTestLocale, allowBuildingLocale })
  ));

  useLayoutEffect(() => {
    if (typeof document !== 'undefined') applyDocumentLocale(document, preferences);
  }, [preferences]);

  const persist = useCallback((next) => {
    const saved = writeInterfacePreferences(next, { storage, allowTestLocale, allowBuildingLocale });
    if (typeof document !== 'undefined') applyDocumentLocale(document, saved);
    setPreferences(saved);
    return saved;
  }, [allowTestLocale, allowBuildingLocale, storage]);

  const setInterfaceLocale = useCallback((locale) => persist({
    locale,
    numberStyle: preferences.numberStyle
  }), [persist, preferences.numberStyle]);

  const setNumberStyle = useCallback((numberStyle) => persist({
    locale: preferences.locale,
    numberStyle
  }), [persist, preferences.locale]);

  const value = useMemo(() => ({
    locale: preferences.locale,
    requestedLocale: preferences.requestedLocale,
    direction: preferences.entry.direction,
    numberStyle: preferences.numberStyle,
    fallbackReason: preferences.fallbackReason,
    localeLabEnabled: allowTestLocale,
    setInterfaceLocale,
    setNumberStyle,
    formatAmount: (amount, options = {}) => formatAccountingAmount(amount, {
      locale: preferences.locale,
      numberStyle: preferences.numberStyle,
      ...options
    }),
    // Counts, ratios and percentages (the Profile and People tabs). Not an
    // accounting amount — see formatInterfaceNumber. Every key a consumer
    // destructures from useInterfaceLocale() must exist here:
    // interfaceLocaleHookContract.test.js machine-checks it.
    formatNumber: (value, options = {}) => formatInterfaceNumber(value, {
      locale: preferences.locale,
      numberStyle: preferences.numberStyle,
      ...options
    }),
    formatDate: (date, options = {}) => formatAccountingDate(date, {
      locale: preferences.locale,
      numberStyle: preferences.numberStyle,
      ...options
    }),
    formatTimestamp: (timestamp, options = {}) => formatAccountingTimestamp(timestamp, {
      locale: preferences.locale,
      numberStyle: preferences.numberStyle,
      ...options
    })
  }), [preferences, allowTestLocale, setInterfaceLocale, setNumberStyle]);

  const catalog = getInterfaceCatalog(preferences.locale) || getInterfaceCatalog('en');

  return (
    <InterfaceLocaleContext.Provider value={value}>
      <IntlProvider
        locale={preferences.entry.formatLocale}
        defaultLocale="en"
        messages={catalog}
        onError={(error) => {
          if (import.meta.env?.DEV) console.error(error);
        }}
      >
        {preferences.fallbackReason && (
          <LocaleFallbackNotice
            requestedLocale={preferences.requestedLocale}
            onUseEnglish={() => persist({ locale: 'en', numberStyle: preferences.numberStyle })}
          />
        )}
        {children}
      </IntlProvider>
    </InterfaceLocaleContext.Provider>
  );
};

export const useInterfaceLocale = () => {
  const context = useContext(InterfaceLocaleContext);
  if (!context) throw new Error('useInterfaceLocale must run inside LocaleProvider.');
  return context;
};
