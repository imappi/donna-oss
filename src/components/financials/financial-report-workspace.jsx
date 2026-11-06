import { useIntl } from 'react-intl';

import ClientReports from '../donna-client-reports.jsx';
import { D } from '../shared/design-tokens.js';
import { useInterfaceLocale } from '../../i18n/LocaleProvider.jsx';

export default function FinancialReportWorkspace({ artifact, ventureLabel, onClose }) {
  const intl = useIntl();
  const { direction } = useInterfaceLocale();
  const period = artifact?.data?.period || null;
  return (
    <div style={{ padding: '24px clamp(24px, 4vw, 56px) 80px', maxWidth: 1440, margin: '0 auto' }}>
      <button
        type="button"
        onClick={onClose}
        style={{
          border: 0,
          background: 'transparent',
          color: D.inkSoft,
          fontFamily: D.ui,
          fontSize: 13,
          paddingBlock: 4,
          paddingInline: 0,
          marginBlockEnd: 28,
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
          cursor: 'pointer'
        }}
      >
        <span aria-hidden="true">{direction === 'rtl' ? '→' : '←'}</span>
        {intl.formatMessage({ id: 'report.navigation.backToOverview' })}
      </button>
      <ClientReports
        key={`${artifact?.data?.clientId || ''}:${period || 'latest'}`}
        clientId={artifact?.data?.clientId}
        databaseMode
        ventureLabel={ventureLabel}
        defaultDate={period ? `${period}-01` : null}
        showSupportingStatements
        embedded
        previewReport={artifact?.data?.previewReport || null}
        onDownloadReport={artifact?.data?.onDownloadReport || null}
      />
    </div>
  );
}
