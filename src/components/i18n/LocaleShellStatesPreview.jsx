import { useState } from 'react';
import { useIntl } from 'react-intl';

import FeedbackModal from '../FeedbackModal.jsx';
import FirmAuthGate from '../FirmAuthGate.jsx';
import { FirmDropTarget } from '../FirmDropOverlay.jsx';
import FirstRunOnboarding from '../FirstRunOnboarding.jsx';
import { UploadActivityRows } from '../UploadTray.jsx';
import { Toast } from '../shared/toast-host.jsx';
import { D } from '../shared/design-tokens.js';
import { useInterfaceLocale } from '../../i18n/LocaleProvider.jsx';

const SURFACES = [
  ['auth', 'shellPreview.surface.auth'],
  ['onboarding', 'shellPreview.surface.onboarding'],
  ['feedback', 'shellPreview.surface.feedback'],
  ['upload', 'shellPreview.surface.upload'],
  ['toast', 'shellPreview.surface.toast'],
  ['drop', 'shellPreview.surface.drop']
];

const noop = () => {};
const asyncNoop = async () => null;

const LocaleShellStatesPreview = () => {
  const intl = useIntl();
  const { locale, setInterfaceLocale } = useInterfaceLocale();
  const [surface, setSurface] = useState('auth');
  const message = (id) => intl.formatMessage({ id });
  const toast = {
    id: 'locale-shell-preview',
    tone: 'info',
    durationMs: 60_000,
    message: message('shellPreview.toast.message')
  };
  const uploadRows = [
    {
      row_id: 'shell-reading',
      document_id: 'shell-document-reading',
      filename: 'كشف حساب أغسطس 2026.pdf',
      size: 184320,
      parse_status: 'processing',
      parse_stage: 'extracting',
      parse_progress_current: 3,
      parse_progress_total: 8
    },
    {
      row_id: 'shell-complete',
      document_id: 'shell-document-complete',
      filename: 'INV-2026-001 — شركة النور.pdf',
      size: 92160,
      parse_status: 'completed',
      parse_summary: {
        document_type: 'sales_invoice',
        counterparty_name: 'شركة النور',
        currency: 'AED',
        total_amount: '12,450.00',
        line_count: 3,
        coded_line_count: 2,
        review_line_count: 1
      }
    },
    {
      row_id: 'shell-failed',
      document_id: 'shell-document-failed',
      filename: 'receipt دبي.jpg',
      size: 43008,
      parse_status: 'failed',
      parse_error: {
        safe_user_message: message('shellPreview.upload.error'),
        retryable: true
      }
    }
  ];

  let content;
  if (surface === 'auth') {
    content = (
      <FirmAuthGate
        status="locked"
        error=""
        pendingAccess={false}
        initialMode="signup"
        initialEmail="finance@example-ae.example"
        authConfiguredOverride
        onBackToSignIn={noop}
        onPasswordSubmit={asyncNoop}
        onSignUpSubmit={asyncNoop}
        onAccessKeySubmit={noop}
        onGoogleSignIn={noop}
      />
    );
  } else if (surface === 'onboarding') {
    content = <FirstRunOnboarding onProvisioned={asyncNoop} />;
  } else if (surface === 'feedback') {
    content = <FeedbackModal onClose={() => setSurface('auth')} />;
  } else if (surface === 'upload') {
    content = (
      <main style={{ maxWidth: 620, marginInline: 'auto', padding: '48px 24px' }}>
        <UploadActivityRows rows={uploadRows} />
      </main>
    );
  } else if (surface === 'toast') {
    content = (
      <main style={{ maxWidth: 420, marginInline: 'auto', padding: '64px 24px' }}>
        <Toast toast={toast} onDismiss={noop} />
      </main>
    );
  } else {
    content = <FirmDropTarget clientName="شركة النور للتجارة LLC" onDrop={noop} />;
  }

  return (
    <div
      data-locale-preview="shell"
      data-surface={surface}
      style={{ minHeight: '100vh', background: D.paper, color: D.ink, fontFamily: D.ui }}
    >
      <header
        style={{
          position: 'relative',
          zIndex: 110,
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          flexWrap: 'wrap',
          padding: '10px 14px',
          borderBlockEnd: `1px solid ${D.rule}`,
          background: D.card
        }}
      >
        <div style={{ marginInlineEnd: 'auto' }}>
          <strong style={{ display: 'block', fontSize: 13 }}>{message('shellPreview.title')}</strong>
          <span style={{ display: 'block', marginBlockStart: 2, fontSize: 11.5, color: D.inkMute }}>
            {message('shellPreview.note')}
          </span>
        </div>
        <div role="group" aria-label={message('settings.language.interface.label')} style={{ display: 'flex', gap: 4 }}>
          {[
            ['en', 'shellPreview.locale.english'],
            ['ar-AE', 'settings.language.arabic.label'],
            ['ar-XB', 'shellPreview.locale.rtl']
          ].map(([value, id]) => (
            <button
              key={value}
              data-locale-option={value}
              type="button"
              onClick={() => setInterfaceLocale(value)}
              aria-pressed={locale === value}
              style={{
                border: `1px solid ${locale === value ? D.ink : D.rule}`,
                borderRadius: 999,
                padding: '5px 10px',
                background: locale === value ? D.ink : D.card,
                color: locale === value ? D.card : D.ink,
                font: 'inherit',
                fontSize: 11.5,
                cursor: 'pointer'
              }}
            >
              {message(id)}
            </button>
          ))}
        </div>
        <nav aria-label={message('shellPreview.title')} style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
          {SURFACES.map(([value, id]) => (
            <button
              key={value}
              data-surface-option={value}
              type="button"
              onClick={() => setSurface(value)}
              aria-pressed={surface === value}
              style={{
                border: 0,
                borderBlockEnd: `2px solid ${surface === value ? D.ink : 'transparent'}`,
                padding: '5px 7px',
                background: 'transparent',
                color: surface === value ? D.ink : D.inkMute,
                font: 'inherit',
                fontSize: 11.5,
                cursor: 'pointer'
              }}
            >
              {message(id)}
            </button>
          ))}
        </nav>
      </header>
      {content}
    </div>
  );
};

export default LocaleShellStatesPreview;
