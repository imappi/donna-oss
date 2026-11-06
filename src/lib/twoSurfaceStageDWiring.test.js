// Single-lifecycle IA wiring pins (docs/design-donna-two-surface-ia.md §11).
//
// GRADUATED UNCONDITIONAL (2026-08-27, Kari's call): the fold is no longer
// flag-gated — the TWO_SURFACE_DOCUMENTS_FOLD plane key, the ui_flags
// snapshot boolean, and the Documents tab code are deleted (flag terminal
// state 1: deleted because the behavior is unconditional). These pins hold
// the graduated folds still hold, but Actions and Material now compose one
// overview. Stale route aliases land there and Aging remains in the ⋯ menu.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');

const consoleSource = read('../components/FirmOpsConsole.jsx');
const feedSource = read('../components/financials/donna-financials-panel.jsx');
const catalogSource = read('../i18n/catalogs/en.js');
const mountedFeedSource = feedSource.slice(feedSource.indexOf('export default function DonnaFinancialsPanel'));
const agingSource = read('../components/financials/aging-panel.jsx');

test('the fold is unconditional — no flag, env gate, or ui_flags read survives', () => {
  assert.doesNotMatch(consoleSource, /ui_flags/);
  assert.doesNotMatch(feedSource, /ui_flags/);
  assert.doesNotMatch(consoleSource, /TWO_SURFACE/);
  assert.doesNotMatch(feedSource, /TWO_SURFACE/);
  assert.doesNotMatch(consoleSource, /documentsTabFolded|closeTabFolded/);
  assert.doesNotMatch(feedSource, /documentsTabFolded|closeTabFolded/);
});

test('one lifecycle overview replaces the Actions / Material switch and keeps old routes live', () => {
  assert.doesNotMatch(consoleSource, /const ENTITY_TABS/);
  assert.doesNotMatch(consoleSource, /<SegmentedControl/);
  assert.doesNotMatch(consoleSource, /\{ key: 'documents', label: 'Documents' \}/);
  assert.doesNotMatch(consoleSource, /\{ key: 'close', label: 'Close' \}/);
  // Actions, Material and stale four-tab aliases all miss the occasional-view
  // allowlist and therefore resolve to the overview.
  assert.match(consoleSource, /const entityTab = ENTITY_MENU_TABS\.some\(\(tab\) => tab\.key === activeEntityTab\)/);
  assert.match(consoleSource, /: 'overview';/);
  assert.match(consoleSource, /id: 'overview',[\s\S]*?firm\.menu\.overview/);
  assert.match(consoleSource, /activeTab=\{entityTab === 'overview' \? 'accounting' : entityTab\}/);
  assert.match(consoleSource, /\['overview', 'profile', 'people'\]\.includes\(entityTab\)/);
  // The old tab panels are gone — nothing mounts them.
  assert.doesNotMatch(consoleSource, /documents-panel|donna-close-panel/);
});

test('the overview keeps only venture-wide communication above the period-owned ledger', () => {
  const ownerWork = consoleSource.indexOf("entityTab === 'overview' && (");
  const material = consoleSource.indexOf('<FirmClientWorkspace');
  assert.ok(ownerWork > -1 && material > ownerWork);
  assert.match(consoleSource, /<AskBatchPanel[\s\S]*embedded/);
  assert.match(consoleSource, /<AskBatchPanel[\s\S]*<FirmClientWorkspace/);
  assert.match(consoleSource, /periodOwnedDecisionItems\(feed, selectedClient\?\.id \|\| null\)/);
  assert.match(consoleSource, /periodOwnerDecisions=\{selectedPeriodOwnerDecisions\}/);
  assert.match(consoleSource, /onActivatePeriodOwnerDecision=\{handleHomeFeedActivate\}/);
  assert.match(feedSource, /return \[\.\.\.periodOwnerDecisions, \.\.\.reviewRows, \.\.\.bareRows\]/);
  assert.match(feedSource, /reasonShorthand\(row, intl\.formatMessage\)/);
  assert.doesNotMatch(consoleSource, /CloseActionRows|deriveCloseActionPeriods/);
  assert.doesNotMatch(feedSource, /id: 'asks', label: 'Client asks'/);
});

test('the overview is one date-sorted list under month boundaries and keeps empty-book onboarding', () => {
  assert.match(feedSource, /buildPeriodOverview\(\{/);
  assert.match(feedSource, /<PeriodHeader/);
  // Single-list amendment (Kari, 2026-08-31): the lanes survive only as
  // counts/filters; the render walks ONE per-month stream.
  assert.match(feedSource, /\{stream\.map\(\(entry\) => \{/);
  assert.doesNotMatch(feedSource, /period\.ownerRows\.map|period\.openRows\.map|period\.reconciledRows\.map/);
  assert.doesNotMatch(mountedFeedSource, /<OwnerHomeStrip|owner-home-strip/);
  assert.doesNotMatch(mountedFeedSource, /<FeedSectionHeading label="Reconciled"/);
  assert.doesNotMatch(feedSource, /Nothing needs attention\./);
  assert.match(feedSource, /financial\.empty\.reconcile\.title/);
  assert.match(feedSource, /financial\.empty\.reconcile\.body/);
  assert.match(catalogSource, /'financial\.empty\.reconcile\.title': 'No bank lines yet\.'/);
  assert.match(catalogSource, /'financial\.empty\.reconcile\.body': 'Upload a statement to begin\.'/);
});

test('the aging ⋯ read view re-homes the old tab strips, unconditionally', () => {
  assert.match(feedSource, /\{ id: 'aging', label: intl\.formatMessage\(\{ id: 'mounted\.financial\.tabs\.aging' \}\) \}/);
  assert.match(feedSource, /sub === 'aging' && \(/);
  // The read view renders the SAME summaries over the SAME persisted inbox
  // derivation the Documents tab used — render-the-persisted-verdict.
  assert.match(agingSource, /import ArAgingSummary from '\.\.\/documents\/ar-aging-summary\.jsx'/);
  assert.match(agingSource, /import ApAgingSummary from '\.\.\/documents\/ap-aging-summary\.jsx'/);
  assert.match(agingSource, /buildDocumentInbox\(\{ documents, reconciliationMatches, reviewItems \}\)/);
});
