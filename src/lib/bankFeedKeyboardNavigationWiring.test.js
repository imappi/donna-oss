import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const panelSource = readFileSync(
  new URL('../components/financials/donna-financials-panel.jsx', import.meta.url),
  'utf8'
);
const stylesSource = readFileSync(new URL('../styles.css', import.meta.url), 'utf8');

test('Bank Feed arrow navigation crosses the unified Open and Reconciled list', () => {
  assert.match(panelSource, /data-bank-feed-list="true"/);
  assert.match(panelSource, /event\.key !== 'ArrowDown' && event\.key !== 'ArrowUp'/);
  assert.match(panelSource, /querySelectorAll\('\[data-bank-feed-list-row="true"\]'\)/);
  assert.match(panelSource, /nextRow\.focus\(\{ preventScroll: true \}\)/);
  assert.match(panelSource, /nextRow\.click\(\)/);
  assert.match(panelSource, /nextRow\.scrollIntoView\(\{ block: 'nearest' \}\)/);
  assert.match(panelSource, /event\.type === 'click'[\s\S]*row\.focus\(\{ preventScroll: true \}\)/);
});

test('both Open and Reconciled rows participate in one selection model', () => {
  assert.match(panelSource, /data-bank-feed-row-id=\{`open:\$\{tx\.id\}`\}/);
  assert.match(panelSource, /const feedRowId = `reconciled:\$\{tx\.id\}`/);
  assert.match(panelSource, /activeFeedRowId === `open:\$\{tx\.id\}`/);
  assert.match(panelSource, /activeFeedRowId === feedRowId/);
});

test('desktop list selection is the white wash without a focus border', () => {
  assert.match(stylesSource, /\.bank-feed-list-row:focus-visible \{[\s\S]*background: var\(--bg-card\) !important;[\s\S]*outline: none !important;/);
});
