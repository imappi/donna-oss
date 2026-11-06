// open_document FE wiring (two-surface IA record §4, precondition P4;
// Kari 2026-08-26: retrieval runs through Donna — the mascot/dock chat —
// and the answer opens in the artifact rail). Source-level pins, sibling
// of the other wiring tests: the dock chat renders an Open affordance for
// the read-only open_document action and the console opens the document's
// artifact from PERSISTED rows — never an Apply button, never a bespoke
// search UI, never model recollection driving the opener.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const feedChatSource = readFileSync(
  new URL('../components/financials/feed-chat.jsx', import.meta.url),
  'utf8'
);
const dockSource = readFileSync(
  new URL('../components/firm-dock.jsx', import.meta.url),
  'utf8'
);
const consoleSource = readFileSync(
  new URL('../components/FirmOpsConsole.jsx', import.meta.url),
  'utf8'
);
const financialsViewSource = readFileSync(
  new URL('../components/financials/financials-view.jsx', import.meta.url),
  'utf8'
);
const documentArtifactSource = readFileSync(
  new URL('../components/financials/document-artifact.jsx', import.meta.url),
  'utf8'
);
const remainingCatalogSource = readFileSync(
  new URL('../i18n/catalogs/remainingSurfaces.en.js', import.meta.url),
  'utf8'
);

test('the action card renders Open (not Apply) for open_document, gated on the sanitized id', () => {
  assert.match(feedChatSource, /OPERATOR_ACTION_TYPE_MESSAGE_IDS\[action\.type\]/);
  assert.match(remainingCatalogSource, /open_document: 'operator\.action\.type\.openDocument'/);
  assert.match(remainingCatalogSource, /'operator\.action\.type\.openDocument': 'Open document'/);
  assert.match(
    feedChatSource,
    /const canOpenDocument = !!documentTarget && typeof onOpenDocument === 'function';/
  );
  assert.match(feedChatSource, /onClick=\{\(\) => onOpenDocument\(documentTarget\)\}/);
});

test('the feed chat mount has no stale selected-document state setter', () => {
  assert.doesNotMatch(feedChatSource, /setSelectedDocumentIds/,
    'the retired document-selection state must not crash the firm console mount');
});

test('onOpenDocument threads FeedChat ← FirmDock ← FirmOpsConsole', () => {
  assert.match(feedChatSource, /onOpenDocument = null/);
  assert.match(feedChatSource, /onOpenDocument=\{onOpenDocument\}/);
  assert.match(dockSource, /onOpenDocument = null/);
  assert.match(dockSource, /onOpenDocument=\{onOpenDocument\}/);
  assert.match(consoleSource, /onOpenDocument=\{openDocumentFromChat\}/);
});

test('the console opener resolves the PERSISTED document row and opens the shared artifact', () => {
  const opener = consoleSource.slice(
    consoleSource.indexOf('const openDocumentFromChat'),
    consoleSource.indexOf('const dockNode')
  );
  assert.ok(opener.length > 0, 'openDocumentFromChat defined before the dock mount');
  assert.match(opener, /d\.id === documentId && d\.client_id === targetClientId/);
  assert.match(opener, /buildDocumentArtifactData\(doc, clientTransactions\)/);
  assert.match(opener, /type: 'document'/);
});

test('the shared artifact builder always carries the persisted document identity', () => {
  const builder = financialsViewSource.slice(
    financialsViewSource.indexOf('const buildDocumentArtifactData'),
    financialsViewSource.indexOf('const buildFinancials')
  );
  assert.ok(builder.length > 0, 'buildDocumentArtifactData source found');
  assert.match(builder, /firmDocument: document/);
});

test('document artifacts have one canonical chat surface and no legacy type panels', () => {
  assert.match(documentArtifactSource, /<DocumentChat/);
  assert.doesNotMatch(documentArtifactSource, /SummaryFieldList/);
  assert.doesNotMatch(documentArtifactSource, /DocumentLinesTable/);
  assert.doesNotMatch(documentArtifactSource, /ObligationScheduleTable/);
  assert.doesNotMatch(documentArtifactSource, /AgreementEvidenceCheck/);
  assert.doesNotMatch(documentArtifactSource, /<iframe/);
});
