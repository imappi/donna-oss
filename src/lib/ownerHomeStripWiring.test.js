// Period-first overview wiring pins (docs/design-donna-two-surface-ia.md §14).

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const panelSource = readFileSync(
  new URL('../components/financials/donna-financials-panel.jsx', import.meta.url),
  'utf8'
);
const ghostSource = readFileSync(
  new URL('../components/financials/financials-view.jsx', import.meta.url),
  'utf8'
);
const mountedPanelSource = panelSource.slice(panelSource.indexOf('export default function DonnaFinancialsPanel'));

test('the venture-wide aggregate is retired from the mounted feed', () => {
  assert.doesNotMatch(mountedPanelSource, /<OwnerHomeStrip|owner-home-strip|buildOwnerHomeCounts/);
});

test('the mounted feed sends every persisted lane to one period projection', () => {
  assert.match(panelSource, /openRows: filtered/);
  assert.match(panelSource, /ownerRows,/);
  assert.match(panelSource, /reconciledRows: reconciledHistoryRows/);
  assert.match(panelSource, /documentRows: unmatchedDocRows/);
  assert.match(panelSource, /closePeriods,/);
});

test('the ghost surface does not grow the strip', () => {
  assert.doesNotMatch(ghostSource, /OwnerHomeStrip|buildOwnerHomeCounts/);
});
