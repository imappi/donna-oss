import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');

const feedListSource = read('../components/shared/feed-list.jsx');
const sidebarSource = read('../components/FirmSidebar.jsx');
const teamSource = read('../components/TeamPanel.jsx');

test('Inbox has no owner-facing Ready to confirm lane', () => {
  assert.doesNotMatch(feedListSource, /Ready to confirm/);
  assert.doesNotMatch(feedListSource, /confirmable:\s*\{\s*label:/);
  assert.match(
    feedListSource,
    /FEED_BUCKET_ORDER = \['operator_blocker', 'client_info_needed', 'donna_working', 'auto_cleared'\]/
  );
});

test('Inbox and Team badges count genuine operator work only', () => {
  assert.match(sidebarSource, /const FIRM_MOVE_BUCKETS = \['operator_blocker'\]/);
  assert.match(teamSource, /const FIRM_MOVE_BUCKETS = \['operator_blocker'\]/);
  assert.doesNotMatch(sidebarSource, /FIRM_MOVE_BUCKETS = \[[^\]]*confirmable/);
  assert.doesNotMatch(teamSource, /FIRM_MOVE_BUCKETS = \[[^\]]*confirmable/);
});
