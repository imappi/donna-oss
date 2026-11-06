import { D } from '../shared/design-tokens.js';
import { useIntl } from 'react-intl';
import { useEffect, useRef } from 'react';

import { useInterfaceLocale } from '../../i18n/LocaleProvider.jsx';

// Settings rail — swaps in for the venture rail while Settings is open
// (Kari, 2026-08-07: the native pattern — the sidebar becomes the settings
// nav with "← Back to app" on top, the content pane renders the section).
// Same chrome rules as FirmSidebar: the shared D.rail width (it SWAPS IN for
// that rail, so a mismatch would shift the whole window on entering settings),
// transparent on the shell ground, selected state is the 8%-ink wash, no
// borders.

const SELECTED_WASH = 'oklch(0.08 0 0 / 0.06)';

export const SETTINGS_SECTIONS = [
  {
    groupId: 'mounted.settings.group.personal',
    items: [
      { id: 'profile', labelId: 'mounted.settings.section.profile' },
      { id: 'language', labelId: 'settings.sidebar.language' },
      { id: 'notifications', labelId: 'mounted.settings.section.notifications' },
      { id: 'shortcuts', labelId: 'mounted.settings.section.shortcuts' }
    ]
  },
  {
    groupId: 'mounted.settings.group.practice',
    items: [
      { id: 'firm', labelId: 'firm.menu.profile' },
      { id: 'autonomy', labelId: 'mounted.settings.section.autonomy' },
      { id: 'claude', labelId: 'mounted.settings.section.claude' },
      { id: 'memory', labelId: 'mounted.settings.section.memory' },
      { id: 'billing', labelId: 'mounted.settings.section.billing' }
    ]
  },
  {
    groupId: 'mounted.settings.group.system',
    items: [
      { id: 'ai', labelId: 'mounted.settings.section.ai' },
      { id: 'data', labelId: 'mounted.settings.section.data' },
      { id: 'about', labelId: 'mounted.settings.section.about' }
    ]
  }
];

const SettingsSidebar = ({ section, onSection, onBack }) => {
  const intl = useIntl();
  const { direction } = useInterfaceLocale();
  const navRef = useRef(null);

  useEffect(() => {
    navRef.current?.querySelector('[aria-current="page"]')?.scrollIntoView({
      block: 'nearest',
      inline: 'nearest'
    });
  }, [direction, section]);

  return (
  <aside
    className="firm-sidebar"
    data-settings-sidebar="true"
    aria-label={intl.formatMessage({ id: 'mounted.settings.aria' })}
    style={{
      width: D.rail,
      flex: `0 0 ${D.rail}px`,
      padding: 'calc(16px + var(--donna-titlebar-h, 12px)) 0 12px',
      display: 'flex',
      flexDirection: 'column',
      position: 'sticky',
      top: 0,
      height: '100vh',
      background: 'transparent',
      // Platform face in chrome (see D.ui in design-tokens.js).
      fontFamily: D.ui,
      color: D.ink
    }}
  >
    <nav ref={navRef} style={{ display: 'flex', flexDirection: 'column', padding: '0 8px' }} aria-label={intl.formatMessage({ id: 'mounted.settings.sidebar.aria' })}>
      <button
        type="button"
        onClick={onBack}
        style={{
          font: 'inherit',
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '8px 14px',
          borderRadius: 6,
          border: 'none',
          cursor: 'pointer',
          textAlign: 'start',
          background: 'transparent',
          color: D.inkSoft,
          fontSize: 14,
          fontWeight: 400
        }}
        onMouseEnter={(e) => { e.currentTarget.style.color = D.ink; }}
        onMouseLeave={(e) => { e.currentTarget.style.color = D.inkSoft; }}
      >
        <span
          aria-hidden="true"
          style={{
            fontSize: 14,
            lineHeight: 1,
            transform: direction === 'rtl' ? 'scaleX(-1)' : 'none'
          }}
        >
          ←
        </span>
        {intl.formatMessage({ id: 'settings.sidebar.back' })}
      </button>

      {SETTINGS_SECTIONS.map((group) => (
        <div key={group.groupId} style={{ display: 'flex', flexDirection: 'column', gap: 1, marginTop: 20 }}>
          <div
            style={{
              padding: '0 14px 5px',
              fontSize: 12,
              fontWeight: 600,
              letterSpacing: '0.02em',
              color: D.inkMute
            }}
          >
            {intl.formatMessage({ id: group.groupId })}
          </div>
          {group.items.map((item) => {
            const selected = section === item.id;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => onSection(item.id)}
                aria-current={selected ? 'page' : undefined}
                style={{
                  font: 'inherit',
                  display: 'flex',
                  alignItems: 'center',
                  padding: '8px 14px',
                  borderRadius: 7,
                  border: 'none',
                  cursor: 'pointer',
                  textAlign: 'start',
                  background: selected ? SELECTED_WASH : 'transparent',
                  color: D.ink,
                  fontSize: 15,
                  // Same weight selected or not — this rail SWAPS IN for the
                  // venture rail, so it follows the same rule (Kari,
                  // 2026-08-08): the background wash carries selection alone.
                  fontWeight: 400
                }}
              >
                {intl.formatMessage({ id: item.labelId })}
              </button>
            );
          })}
        </div>
      ))}
    </nav>
  </aside>
  );
};

export default SettingsSidebar;
