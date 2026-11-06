// Whole-surface document intake for the desktop shell: while a file drag is
// in flight anywhere over the window, the content area (everything right of
// the sidebar) becomes the drop target for the SELECTED client — and when
// nothing is being dragged there is no idle chrome at all (Kari, 2026-08-03,
// replacing the first-cut inline dropzone bar). The overlay names the client
// it will upload to: with a multi-client sidebar, a silent wrong-book drop
// is the failure mode to design against.
//
// Window-level listeners also swallow drops outside the overlay — without
// that, Electron navigates the window to the dropped file. Upload mechanics
// live in src/lib/documentUploadSession.js; progress renders in the globally
// mounted UploadTray.

import { useEffect, useRef, useState } from 'react';
import { useIntl } from 'react-intl';

import { uploadFirmDocuments } from '../lib/documentUploadSession.js';
import { partitionFirmDropFiles } from '../lib/accountingImportDrop.js';
import { D } from './shared/design-tokens.js';
import { BidiText } from '../i18n/BidiText.jsx';

// The overlay positions against the rail, so it reads the rail's own width
// token rather than a copy of the number (D.rail in design-tokens.js).
const SIDEBAR_WIDTH = D.rail;

export const FirmDropTarget = ({ clientName = '', onDrop }) => {
  const intl = useIntl();
  return (
    <div
      onDrop={onDrop}
      onDragOver={(event) => event.preventDefault()}
      style={{
        position: 'fixed',
        insetBlock: 0,
        insetInlineStart: SIDEBAR_WIDTH,
        insetInlineEnd: 0,
        zIndex: 80,
        margin: 12,
        border: `2px dashed ${D.ink}`,
        borderRadius: 12,
        background: D.paper,
        opacity: 0.96,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 6,
        pointerEvents: 'auto',
        textAlign: 'center',
        paddingInline: 24
      }}
    >
      <div style={{ fontSize: 18, fontWeight: 600, color: D.ink }}>
        {intl.formatMessage({ id: 'drop.title' })}
      </div>
      {clientName && (
        <div style={{ fontSize: 14, color: D.inkSoft }}>
          {intl.formatMessage(
            { id: 'drop.client' },
            { clientName: <BidiText direction="auto" style={{ fontWeight: 700 }}>{clientName}</BidiText> }
          )}
        </div>
      )}
      <div style={{ fontSize: 12.5, color: D.inkMute }}>
        {intl.formatMessage({ id: 'drop.types' })}
      </div>
    </div>
  );
};

export default function FirmDropOverlay({ clientId, clientName = '', onAccountingImport = null }) {
  const intl = useIntl();
  const [active, setActive] = useState(false);
  const [inflight, setInflight] = useState(0);
  const [error, setError] = useState('');
  // dragenter/dragleave fire per element crossed; depth-count so the overlay
  // doesn't flicker while the drag moves across children.
  const depth = useRef(0);

  useEffect(() => {
    const hasFiles = (event) =>
      Array.from(event.dataTransfer?.types || []).includes('Files');
    const onDragEnter = (event) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      depth.current += 1;
      setActive(true);
    };
    const onDragOver = (event) => {
      if (hasFiles(event)) event.preventDefault();
    };
    const onDragLeave = (event) => {
      if (!hasFiles(event)) return;
      depth.current = Math.max(0, depth.current - 1);
      if (depth.current === 0) setActive(false);
    };
    const onDrop = (event) => {
      // Reached only when the drop lands OUTSIDE the overlay (its own
      // handler stops propagation): swallow it so Electron doesn't navigate.
      event.preventDefault();
      depth.current = 0;
      setActive(false);
    };
    window.addEventListener('dragenter', onDragEnter);
    window.addEventListener('dragover', onDragOver);
    window.addEventListener('dragleave', onDragLeave);
    window.addEventListener('drop', onDrop);
    return () => {
      window.removeEventListener('dragenter', onDragEnter);
      window.removeEventListener('dragover', onDragOver);
      window.removeEventListener('dragleave', onDragLeave);
      window.removeEventListener('drop', onDrop);
    };
  }, []);

  const handleDrop = async (event) => {
    event.preventDefault();
    event.stopPropagation();
    depth.current = 0;
    setActive(false);
    const files = Array.from(event.dataTransfer?.files || []);
    if (!files.length || !clientId) return;
    const { accountingImportFiles } = partitionFirmDropFiles(files);
    if (accountingImportFiles.length > 0) {
      setError('');
      if (files.length !== 1) {
        setError(intl.formatMessage({ id: 'drop.error.import_batch' }));
        return;
      }
      if (typeof onAccountingImport !== 'function') {
        setError(intl.formatMessage({ id: 'drop.error.generic' }));
        return;
      }
      onAccountingImport({ file: accountingImportFiles[0], clientId });
      return;
    }
    // Deliberately NOT gated on a previous drop still being in flight: each
    // drop is its own tray batch, and gating produced a silent dead state —
    // one hung upload made every later drop a no-op with no feedback
    // (observed on the first real Mac use, 2026-08-03). `inflight` only
    // drives the visible chip below.
    setError('');
    setInflight((count) => count + 1);
    try {
      const { failed } = await uploadFirmDocuments({ files, clientId });
      if (failed.length) {
        setError(intl.formatMessage(
          { id: 'drop.error.partial' },
          { failedCount: failed.length, fileCount: files.length }
        ));
      }
    } catch (err) {
      setError(err?.message || intl.formatMessage({ id: 'drop.error.generic' }));
    } finally {
      setInflight((count) => Math.max(0, count - 1));
    }
  };

  return (
    <>
      {active && clientId && (
        <FirmDropTarget clientName={clientName} onDrop={handleDrop} />
      )}
      {inflight > 0 && !active && (
        <div
          style={{
            position: 'fixed',
            insetBlockEnd: 16,
            insetInlineStart: `calc(${SIDEBAR_WIDTH}px + 24px)`,
            zIndex: 79,
            background: D.paper,
            border: `1px solid ${D.ruleSoft}`,
            color: D.inkSoft,
            borderRadius: 8,
            padding: '8px 12px',
            fontSize: 12.5,
            boxShadow: '0 2px 8px rgba(0,0,0,0.12)'
          }}
        >
          {intl.formatMessage({ id: 'drop.uploading' }, { dropCount: inflight })}
        </div>
      )}
      {error && !active && (
        <div
          role="button"
          tabIndex={0}
          aria-label={intl.formatMessage({ id: 'drop.error.dismiss' }, { message: error })}
          onClick={() => setError('')}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === 'Escape') setError('');
          }}
          style={{
            position: 'fixed',
            insetBlockEnd: 16,
            insetInlineStart: `calc(${SIDEBAR_WIDTH}px + 24px)`,
            zIndex: 80,
            background: D.paper,
            border: `1px solid ${D.alert}`,
            color: D.alert,
            borderRadius: 8,
            padding: '8px 12px',
            fontSize: 12.5,
            cursor: 'pointer',
            boxShadow: '0 2px 8px rgba(0,0,0,0.12)'
          }}
        >
          <BidiText direction="auto">
            {intl.formatMessage({ id: 'drop.error.dismiss' }, { message: error })}
          </BidiText>
        </div>
      )}
    </>
  );
}
