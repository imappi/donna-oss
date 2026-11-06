import { useState } from 'react';
import { useIntl } from 'react-intl';

import FirmNewEntity from '../FirmNewEntity.jsx';
import TeamPanel from '../TeamPanel.jsx';
import AccountingImportCard from '../settings/AccountingImportCard.jsx';
import SettingsSidebar from '../settings/SettingsSidebar.jsx';
import { D } from '../shared/design-tokens.js';
import { useInterfaceLocale } from '../../i18n/LocaleProvider.jsx';

const SURFACES = Object.freeze([
  ['venture', 'mounted.lab.venture'],
  ['team', 'mounted.lab.team'],
  ['import', 'mounted.lab.import'],
  ['workspace', 'mounted.lab.workspace']
]);

const CLIENTS = Object.freeze([
  Object.freeze({ id: 'locale-mounted-ae', company_name: 'شركة النور للتجارة LLC' }),
  Object.freeze({ id: 'locale-mounted-gb', company_name: 'Desert Rose Holdings Ltd' })
]);

const LocaleMountedSurfacePreview = () => {
  const intl = useIntl();
  const { locale, setInterfaceLocale } = useInterfaceLocale();
  const [surface, setSurface] = useState('venture');
  const [settingsSection, setSettingsSection] = useState('profile');
  const message = (id) => intl.formatMessage({ id });

  let content = <FirmNewEntity dataSource="local" onCreateEntity={() => {}} onCancel={() => {}} />;
  if (surface === 'team') {
    content = <TeamPanel clients={CLIENTS} selectedClientId={CLIENTS[0].id} dataSource="local" />;
  } else if (surface === 'import') {
    content = <AccountingImportCard clients={CLIENTS} initialClientId={CLIENTS[0].id} dataSource="local" />;
  } else if (surface === 'workspace') {
    content = (
      <div className="locale-mounted-preview__workspace" style={{ display: 'grid', gridTemplateColumns: 'minmax(210px, 260px) minmax(0, 1fr)', minHeight: 640 }}>
        <SettingsSidebar section={settingsSection} onSection={setSettingsSection} onBack={() => {}} />
        <main style={{ minWidth: 0, padding: 28 }}>
          <h1 style={{ marginBlockStart: 0 }}>{message('mounted.settings.section.profile')}</h1>
          <p>{message('mounted.settings.section.profile.subtitle')}</p>
        </main>
      </div>
    );
  }

  return (
    <div
      className="locale-mounted-preview"
      data-locale-preview="mounted"
      data-surface={surface}
      style={{ minHeight: '100vh', background: D.paper, color: D.ink, fontFamily: D.ui }}
    >
      <header className="locale-mounted-preview__header" style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', padding: 12, borderBlockEnd: `1px solid ${D.rule}`, background: D.card }}>
        <div style={{ marginInlineEnd: 'auto' }}>
          <strong style={{ display: 'block' }}>{message('mounted.lab.title')}</strong>
          <span style={{ color: D.inkMute, fontSize: 12 }}>{message('mounted.lab.note')}</span>
        </div>
        {['en', 'ar-AE', 'ar-XB'].map((value) => (
          <button key={value} data-locale-option={value} type="button" aria-pressed={locale === value} onClick={() => setInterfaceLocale(value)}>
            {value}
          </button>
        ))}
        {SURFACES.map(([value, id]) => (
          <button key={value} data-surface-option={value} type="button" aria-pressed={surface === value} onClick={() => setSurface(value)}>
            {message(id)}
          </button>
        ))}
      </header>
      {content}
    </div>
  );
};

export default LocaleMountedSurfacePreview;
