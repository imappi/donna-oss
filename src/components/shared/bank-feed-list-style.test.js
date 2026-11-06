import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import {
  BANK_FEED_AMOUNT_STYLE,
  BANK_FEED_DATE_STYLE,
  BANK_FEED_DOT_STYLE,
  BANK_FEED_EMPTY_STYLE,
  BANK_FEED_LIST_MEASURE,
  BANK_FEED_ROW_COLUMNS,
  BANK_FEED_ROW_STYLE,
  BANK_FEED_SECTION_HEADING_STYLE,
  BANK_FEED_TRAILING_CELL_STYLE
} from './bank-feed-list-style.js';

const panelSource = fs.readFileSync(new URL('../financials/donna-financials-panel.jsx', import.meta.url), 'utf8');

test('Bank Feed list geometry is the shared pixel contract', () => {
  assert.equal(BANK_FEED_LIST_MEASURE, 1080);
  assert.equal(BANK_FEED_ROW_COLUMNS, '72px 1fr 120px 140px');
  assert.equal(BANK_FEED_ROW_STYLE.gap, 18);
  assert.equal(BANK_FEED_ROW_STYLE.padding, '10px 16px');
  assert.equal(BANK_FEED_ROW_STYLE.fontSize, 13);
  assert.equal(BANK_FEED_ROW_STYLE.lineHeight, 'normal');
  assert.equal(BANK_FEED_DATE_STYLE.fontSize, 12.5);
  assert.equal(BANK_FEED_AMOUNT_STYLE.fontSize, 13.5);
  assert.equal(BANK_FEED_DOT_STYLE.width, 7);
  assert.equal(BANK_FEED_DOT_STYLE.height, 7);
});

test('Bank Feed section headings share the same restrained rhythm', () => {
  assert.equal(BANK_FEED_SECTION_HEADING_STYLE.padding, '18px 0 8px');
  assert.equal(BANK_FEED_SECTION_HEADING_STYLE.fontSize, 13);
  assert.equal(BANK_FEED_SECTION_HEADING_STYLE.lineHeight, 'normal');
  assert.equal(BANK_FEED_SECTION_HEADING_STYLE.fontWeight, 600);
});

test('Bank Feed empty sections inherit row typography and inset', () => {
  assert.equal(BANK_FEED_EMPTY_STYLE.padding, BANK_FEED_ROW_STYLE.padding);
  assert.equal(BANK_FEED_EMPTY_STYLE.fontFamily, BANK_FEED_ROW_STYLE.fontFamily);
  assert.equal(BANK_FEED_EMPTY_STYLE.fontSize, BANK_FEED_ROW_STYLE.fontSize);
  assert.equal(BANK_FEED_EMPTY_STYLE.lineHeight, BANK_FEED_ROW_STYLE.lineHeight);
});

test('Bank Feed category pills terminate on the divider edge', () => {
  assert.equal(BANK_FEED_TRAILING_CELL_STYLE.marginInlineEnd, -16);
  assert.equal(BANK_FEED_TRAILING_CELL_STYLE.width, 'calc(100% + 16px)');
  assert.equal(BANK_FEED_TRAILING_CELL_STYLE.maxWidth, 'none');
  assert.equal(BANK_FEED_TRAILING_CELL_STYLE.justifyContent, 'flex-end');
  assert.equal(BANK_FEED_TRAILING_CELL_STYLE.textAlign, 'end');
  assert.match(
    panelSource,
    /\.\.\.BANK_FEED_TRAILING_CELL_STYLE,\s*display: 'inline-flex',[\s\S]*?alignItems: 'flex-end'/,
    'Open-row pills and receipt notes use the shared trailing edge'
  );
  assert.match(
    panelSource,
    /\.\.\.BANK_FEED_TRAILING_CELL_STYLE, display: 'flex'/,
    'Reconciled-row pills end at the same right edge'
  );
});
