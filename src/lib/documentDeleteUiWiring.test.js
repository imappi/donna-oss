import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { MOUNTED_SURFACE_MESSAGES } from '../i18n/catalogs/mountedSurfaces.en.js';

// The per-doc actions live on the feed's doc-anchored Open rows via the
// shared menu + confirmation module (document-context-menu.jsx). The old
// Documents tab that first carried them was deleted at the two-surface IA
// graduation (2026-08-27); the feed rows are now the single surface.
const menuSource = readFileSync(new URL('../components/documents/document-context-menu.jsx', import.meta.url), 'utf8');
const feedSource = readFileSync(new URL('../components/financials/donna-financials-panel.jsx', import.meta.url), 'utf8');
const appSource = readFileSync(new URL('../App.jsx', import.meta.url), 'utf8');
const stylesSource = readFileSync(new URL('../styles.css', import.meta.url), 'utf8');

test('document deletion uses a visible in-app confirmation instead of a native browser dialog', () => {
  assert.doesNotMatch(menuSource, /window\.confirm/);
  assert.match(menuSource, /role="alertdialog"/);
  assert.match(menuSource, /aria-modal="true"/);
  assert.match(menuSource, /mounted\.document\.keep/);
  assert.match(menuSource, /mounted\.document\.delete/);
  assert.match(MOUNTED_SURFACE_MESSAGES['mounted.document.keep'], /Keep document/);
  assert.match(MOUNTED_SURFACE_MESSAGES['mounted.document.delete'], /Delete document/);
  assert.match(stylesSource, /\.document-delete-confirm \{[\s\S]*width: min\(520px, calc\(100vw - 32px\)\);/);
});

test('the feed doc rows carry the per-doc actions through the shared context menu', () => {
  assert.match(feedSource, /import \{ DocumentContextMenu, DocumentDeleteConfirmation \} from '\.\.\/documents\/document-context-menu\.jsx'/);
  assert.match(menuSource, /role="menu"/);
  // The feed row offers the three actions…
  assert.match(feedSource, /mounted\.document\.openArtifact/);
  assert.match(feedSource, /mounted\.document\.askDonna/);
  assert.match(feedSource, /mounted\.document\.deleteEllipsis/);
  assert.match(feedSource, /mounted\.financial\.documentOptions/);
  assert.equal(MOUNTED_SURFACE_MESSAGES['mounted.document.openArtifact'], 'Open in artifact pane');
  assert.equal(MOUNTED_SURFACE_MESSAGES['mounted.document.askDonna'], 'Ask Donna about this document');
  assert.equal(MOUNTED_SURFACE_MESSAGES['mounted.document.deleteEllipsis'], 'Delete document…');
  assert.equal(MOUNTED_SURFACE_MESSAGES['mounted.financial.documentOptions'], 'Document options');
  // …and the doc artifact opened from the feed carries the manual-link
  // affordance the old Documents tab attached (linkable), plus the composer
  // focus for ask-Donna.
  assert.match(feedSource, /docArtifact\.linkable = \{/);
  assert.match(feedSource, /focusComposerRequestId/);
});

test('a refused delete restores the row and explains the failure to the user', () => {
  assert.match(appSource, /Document delete failed; the row was restored\./);
  assert.match(appSource, /emitToast\(\{ message, tone: 'neg', durationMs: 8000 \}\)/);
  assert.match(appSource, /FINLAND_RETENTION_DOCUMENT_HELD/);
});
