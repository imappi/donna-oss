import {
  applyDocumentLocale,
  isInterfaceLocaleLabEnabled,
  readInterfacePreferences
} from './localeRegistry.js';

// This module is the first dependency evaluated by main.jsx. The root is still
// empty at this point, so the saved language and direction land before React or
// the desktop titlebar can paint.
if (typeof document !== 'undefined') {
  applyDocumentLocale(
    document,
    readInterfacePreferences({ allowTestLocale: isInterfaceLocaleLabEnabled() })
  );
}
