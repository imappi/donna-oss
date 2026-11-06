import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  BANK_FEED_LIST_MEASURE,
  BANK_FEED_ROW_COLUMNS,
  BANK_FEED_ROW_STYLE,
  BANK_FEED_SECTION_HEADING_STYLE,
  BANK_FEED_SECTION_STYLE
} from '../components/shared/bank-feed-list-style.js';

const inboxSource = readFileSync(new URL('../components/donna-firm-feed-panel.jsx', import.meta.url), 'utf8');
const feedListSource = readFileSync(new URL('../components/shared/feed-list.jsx', import.meta.url), 'utf8');

test('Inbox inherits Bank Feed measure, typography, rows, and section rhythm', () => {
  assert.equal(BANK_FEED_LIST_MEASURE, 1080);
  assert.equal(BANK_FEED_ROW_COLUMNS, '72px 1fr 120px 140px');
  assert.equal(BANK_FEED_ROW_STYLE.padding, '10px 16px');
  assert.equal(BANK_FEED_ROW_STYLE.fontSize, 13);
  assert.equal(BANK_FEED_SECTION_HEADING_STYLE.padding, '18px 0 8px');
  assert.deepEqual(BANK_FEED_SECTION_STYLE, { padding: '0 0 24px' });
  // One FeedRow mount — decision-grain group rows are retired (Kari,
  // 2026-09-01): every Inbox row renders individually, the same grammar as
  // the entity month stream.
  assert.equal(inboxSource.match(/layout="bank-feed"/g)?.length, 1);
  assert.doesNotMatch(inboxSource, /FeedGroupRow|groupBucketEntries/);
  assert.match(inboxSource, /maxWidth: BANK_FEED_LIST_MEASURE \+ 64/);
  assert.match(inboxSource, /fontFamily: D\.ui/);
});

test('Inbox removes its secondary toolbar without hiding keyboard behavior', () => {
  assert.doesNotMatch(inboxSource, /Inbox · j\/k navigate/);
  assert.doesNotMatch(inboxSource, /in Donna's hands<\/span>/);
  assert.match(inboxSource, /key === 'j' \|\| key === 'ArrowDown'/);
  assert.match(inboxSource, /key === 'Enter'/);
});

test('firm-wide rows keep venture identity inside the Bank Feed primary column', () => {
  assert.match(feedListSource, /showClientTag && !bankFeedLayout/);
  assert.match(feedListSource, /item\.verdict\?\.context\?\.client_name \|\| item\._clientTag/);
});

test('an Inbox row is ONE line with a state pill (Kari, 2026-09-01)', () => {
  // The primary cell truncates as a single line: venture prefix (muted,
  // legal suffix stripped) · description — never a block title wrapping to
  // a second row. Full identity + title ride the hover title.
  assert.match(feedListSource, /clientDisplayName\(item\.verdict\?\.context\?\.client_name \|\| item\._clientTag\)/);
  assert.match(feedListSource, /textOverflow: 'ellipsis',\s*whiteSpace: 'nowrap'\s*\}\}\s*>\s*\{showClientTag/s);
  // The trailing pill carries STATE in the entity screen's vocabulary; the
  // verbose reason/question rides the pill's hover title, never the pill.
  assert.match(feedListSource, /STATE_PILL_OF_BUCKET = \{/);
  assert.match(feedListSource, /operator_blocker: \{ labelId: 'lifecycle\.needsInput'/);
  assert.match(feedListSource, /client_info_needed: \{ labelId: 'lifecycle\.awaitingReply'/);
  assert.match(feedListSource, /donna_working: \{ labelId: 'lifecycle\.processing'/);
  assert.match(feedListSource, /auto_cleared: null/);
  assert.match(feedListSource, /title=\{shorthand \|\| undefined\}/);
  assert.match(inboxSource, /stateBucket=\{entry\.bucket\}/);
});
