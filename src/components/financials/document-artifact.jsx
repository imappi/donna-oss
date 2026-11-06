import { useEffect, useMemo, useState } from 'react';
import { useIntl } from 'react-intl';

import { V } from '../shared/design-tokens.js';
import { buildManualLinkPickerData } from '../../lib/manualLinkPicker.js';
import { fetchFirmDocumentDownload } from '../../lib/firmApi.js';
import DocumentChat from '../documents/document-chat.jsx';
import JevPreview, { supportsJevPreview } from '../JevPreview.jsx';

// There is one persisted-document artifact. Materials, Actions, Donna
// retrieval, the firm home feed, and transaction match links all open this
// same chat surface. The former document-type panels (summary tables, receipt
// line editor, statement table, contract schedule) were a second UI system
// whose visibility depended on which opener remembered to attach
// `firmDocument`; that is how Cactus exposed an obsolete artifact while
// Honeybee looked correct.
const DocumentArtifact = ({ artifact, onRefreshRef }) => {
  const intl = useIntl();
  const message = (id) => intl.formatMessage({ id });
  const data = artifact?.data || {};
  const document = data.firmDocument || null;
  const shell = data.document || {};
  const linkable = data.linkable || null;
  const persistedFileUrl = data.fileUrl || '';

  const [lazyFileUrl, setLazyFileUrl] = useState('');
  useEffect(() => {
    if (persistedFileUrl || !document?.id) {
      setLazyFileUrl('');
      return undefined;
    }
    const controller = new AbortController();
    let cancelled = false;
    fetchFirmDocumentDownload({ documentId: document.id, signal: controller.signal })
      .then((response) => {
        if (!cancelled) setLazyFileUrl(response?.signed_url || response?.url || '');
      })
      .catch((error) => {
        if (!cancelled && error?.name !== 'AbortError') setLazyFileUrl('');
      });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [persistedFileUrl, document?.id]);

  const rankedCandidates = useMemo(() => {
    if (!document || !linkable?.transactions?.length) return [];
    const picker = buildManualLinkPickerData({
      documentId: document.id,
      documents: [document],
      transactions: linkable.transactions,
      reconciliationMatches: linkable.reconciliationMatches || []
    });
    return (picker.candidates || []).map((candidate) => candidate.transaction).slice(0, 30);
  }, [document, linkable?.transactions, linkable?.reconciliationMatches]);

  // Old/incomplete serialized artifacts no longer resurrect the retired
  // panels. They fail closed with an honest message and recover on the next
  // persisted-row activation.
  if (!document?.id || !document?.client_id) {
    return (
      <div style={{ padding: 20, color: V.t3, fontSize: 13 }}>
        {message('document.unavailable')}
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0, minHeight: 600, height: '100%' }}>
      {supportsJevPreview(document) && <JevPreview key={`${document.client_id}:${document.id}`} document={document} />}
      <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
      <DocumentChat
        documentId={document.id}
        clientId={document.client_id}
        documentContext={document}
        documentTitle={shell.title || document.title || document.filename || document.original_filename || message('document.title.fallback')}
        documentMeta=""
        fileUrl={persistedFileUrl || lazyFileUrl}
        candidateTransactions={rankedCandidates}
        linkable={linkable}
        focusComposerRequestId={data.focusComposerRequestId || null}
        previewMode={data.previewMode || null}
        previewMessages={data.previewMessages || undefined}
        previewAppliableActionTypes={data.previewAppliableActionTypes || undefined}
        onRefreshRef={onRefreshRef}
        onActionApplied={
          linkable?.onSnapshotApplied
            ? ({ snapshot }) => {
                if (snapshot) linkable.onSnapshotApplied(snapshot);
              }
            : undefined
        }
      />
      </div>
    </div>
  );
};

export default DocumentArtifact;
