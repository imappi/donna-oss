import './i18n/prepaint.js';

import React from 'react';
import ReactDOM from 'react-dom/client';
import { Analytics } from '@vercel/analytics/react';
import App from './App.jsx';
import CaptureTaskPage from './components/inventory/CaptureTaskPage.jsx';
import DesktopTitlebar, { DESKTOP_TITLEBAR_HEIGHT } from './components/DesktopTitlebar.jsx';
import DemoReplayNotice from './components/DemoReplayNotice.jsx';
import LocaleSettingsPreview from './components/settings/LocaleSettingsPreview.jsx';
import LocaleShellStatesPreview from './components/i18n/LocaleShellStatesPreview.jsx';
import LocaleWorkspaceStatesPreview from './components/i18n/LocaleWorkspaceStatesPreview.jsx';
import LocaleMountedSurfacePreview from './components/i18n/LocaleMountedSurfacePreview.jsx';
import { isDesktopShell } from './lib/desktopShell.js';
import { LocaleProvider } from './i18n/LocaleProvider.jsx';
import {
  isLocaleSettingsPreview,
  isLocaleShellPreview,
  isLocaleMountedPreview,
  isLocaleWorkspacePreview
} from './i18n/localeRegistry.js';
import './styles.css';

// Desktop only. The class lets stylesheet rules subtract the band from full
// height surfaces; on web nothing is added and every selector below it is
// inert, so the served app is byte-identical.
const desktop = isDesktopShell();
const capture = window.location.pathname === '/capture';
if (desktop) {
  document.documentElement.classList.add('donna-desktop');
  document.documentElement.style.setProperty('--donna-titlebar-h', `${DESKTOP_TITLEBAR_HEIGHT}px`);
}

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <LocaleProvider>
      {desktop ? <DesktopTitlebar /> : null}
      {capture ? <CaptureTaskPage /> : isLocaleSettingsPreview()
        ? <LocaleSettingsPreview />
        : isLocaleShellPreview()
          ? <LocaleShellStatesPreview />
          : isLocaleWorkspacePreview()
            ? <LocaleWorkspaceStatesPreview />
          : isLocaleMountedPreview()
            ? <LocaleMountedSurfacePreview />
          : <App />}
      {capture ? null : <DemoReplayNotice />}
      {capture ? null : <Analytics />}
    </LocaleProvider>
  </React.StrictMode>
);
