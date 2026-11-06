// Copy-rail pins for the Claude Desktop extension landing (/claude —
// MarketingPage.jsx `claude` page; docs/design-donna-mcp-surface.md §8 item 4).
//
// The rails, from the design doc + CLAUDE.md:
//   - sells the CLOSE: the blocking-the-close ask is the headline use case;
//   - §2 data posture stated plainly (tool results reach the Claude model in
//     Anthropic's cloud) — bridge register, NO custody slogans (2026-08-11);
//   - read-only stated (cannot post/approve/file/send) + per-business consent
//     off by default + audit receipt — the enforcement facts, not vibes;
//   - promises nothing v1 doesn't do: no capability words beyond the five
//     read views, and no prices/amounts anywhere on the page;
//   - the route actually resolves (wire-into-the-mounted-surface: App.jsx
//     mounts MarketingPage for resolveMarketingPageKey hits, and the landing
//     footer links to it).
// (Source-text pins, like honestPromiseCopy.test.js — node:test cannot import
// JSX, so the route map and copy are asserted against the file text.)
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = await readFile(new URL('./MarketingPage.jsx', import.meta.url), 'utf8');
const landingSource = await readFile(new URL('./DonnaLanding.jsx', import.meta.url), 'utf8');

// The claude page object, sliced out of the source so the pins below read the
// COPY, not the whole file (comments in the file may legitimately name the
// forbidden patterns when documenting the rail).
const pageStart = source.indexOf("claude: {");
const pageEnd = source.indexOf("security: {", pageStart);
const claudeCopy = source.slice(pageStart, pageEnd);

test('the /claude route is mapped and the landing footer links it', () => {
  assert.match(source, /'\/claude': 'claude'/);
  assert.match(landingSource, /href: '\/claude'/);
});

test('sells the close: the blocking-the-close ask is the headline', () => {
  assert.match(claudeCopy, /blocking the close/i);
});

test('data posture stated plainly, no custody slogans', () => {
  assert.match(claudeCopy, /Anthropic’s cloud/);
  assert.match(claudeCopy, /off by default/i);
  assert.doesNotMatch(claudeCopy, /never leaves?|stays? on (this|your) (machine|office)|100% private/i);
});

test('read-only enforcement facts are stated', () => {
  assert.match(claudeCopy, /cannot post, approve, file, or send/i);
  assert.match(claudeCopy, /audit trail/i);
  assert.match(claudeCopy, /read-only/i);
});

test('no prices or amounts on the page', () => {
  assert.doesNotMatch(claudeCopy, /[$£€]\s?\d|\d+\s?(\/|per\s)(mo|month|year|yr)/i);
});

test('promises nothing v1 does not do: no write-capability verbs offered', () => {
  // Verbs that would promise mutation ("Claude can draft/send/post/file …").
  // The page may only DENY them (the read-only section does); asserting the
  // denial sentence exists is above — here, no "Claude (can|will) <mutate>".
  assert.doesNotMatch(claudeCopy, /Claude (can|will) (draft|send|post|file|approve|chase|pay)/i);
});
