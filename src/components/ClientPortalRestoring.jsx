import { useIntl } from 'react-intl';

import { D } from './shared/design-tokens.js';
import { SurfaceInterfaceLocaleDefault } from '../i18n/LocaleProvider.jsx';

// Client-portal equivalent of the firm restoring/lock screen. An owner is a
// client, not a firm member, so the "Donna firm access / verify your sign-in"
// copy is the wrong persona on a /client route — it's what flashed before the
// portal loaded. It must also wear the right CANVAS: this loader sits in the
// signup funnel between WorkspaceProvisioner ("Setting up your workspace…") and
// the portal, both of which use the D (dossier) palette. Rendering it on the old
// `.firm-access` oatmeal canvas made an old-styled screen flash between the new
// branded loaders — so it mirrors the WorkspaceProvisioner loader exactly (D.paper
// shell, small mono caps) for a continuous transition.
export const ClientPortalRestoring = () => {
  const intl = useIntl();
  return (
  <div
    aria-busy="true"
    style={{
      minHeight: '100vh',
      backgroundColor: D.paper,
      color: D.ink,
      fontFamily: D.body,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      padding: 'clamp(1.5rem, 5vw, 3rem)'
    }}
  >
    <main style={{ width: '100%', maxWidth: 420, textAlign: 'center' }}>
      <div
        style={{
          fontFamily: D.mono,
          fontSize: 11,
          letterSpacing: D.tracking.mono,
          textTransform: 'uppercase',
          color: D.inkSoft
        }}
      >
        {intl.formatMessage({ id: 'shell.client.loading' })}
      </div>
    </main>
  </div>
  );
};


// The portal's surface-default language (src/i18n/portalInterfaceLocale.js).
export const ClientPortalLocaleDefault = ({ locale, children }) => (
  <SurfaceInterfaceLocaleDefault locale={locale}>{children}</SurfaceInterfaceLocaleDefault>
);
