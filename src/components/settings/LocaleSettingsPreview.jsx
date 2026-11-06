import { useState } from 'react';

import SettingsPanel from './SettingsPanel.jsx';
import SettingsSidebar from './SettingsSidebar.jsx';

// Developer-only preview mounted by main.jsx when Vite is in development and
// `?locale-lab=settings` is present. It exercises the real Settings components
// without asking a local reviewer to provision or authenticate a book merely
// to inspect directionality. The branch is statically false in production.
const LocaleSettingsPreview = () => {
  const [section, setSection] = useState('language');
  return (
    <div className="firm-shell" data-locale-preview="settings" data-surface="settings">
      <SettingsSidebar
        section={section}
        onSection={setSection}
        onBack={() => window.location.assign('/welcome?locale-lab=1')}
      />
      <main className="firm-shell__main">
        <SettingsPanel
          section={section}
          firm={{
            id: 'locale-preview',
            name: 'Locale preview',
            jurisdiction: 'AE',
            default_currency: 'AED'
          }}
          dataSource="local"
        />
      </main>
    </div>
  );
};

export default LocaleSettingsPreview;
