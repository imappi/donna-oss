// Real-book snapshot admission is identical on web and desktop.

import test from 'node:test';
import assert from 'node:assert/strict';

import { isDesktopPortalPreview, resolveFirmSnapshotOutcome } from './desktopShell.js';

test('the loopback marker identifies a desktop portal preview without carrying authority', () => {
  const marker = { querySelector: (selector) => selector.includes('donna-portal-preview') ? {} : null };
  assert.equal(isDesktopPortalPreview(marker), true);
  assert.equal(isDesktopPortalPreview({ querySelector: () => null }), false);
  assert.equal(isDesktopPortalPreview(null), false);
});

test('a database snapshot renders the real book in either shell', () => {
  assert.equal(resolveFirmSnapshotOutcome({ desktop: false, source: 'database' }), 'database');
  assert.equal(resolveFirmSnapshotOutcome({ desktop: true, source: 'database' }), 'database');
});

test('desktop never degrades into the demo firm', () => {
  // Fetch failed (timeout, abort, 5xx).
  assert.equal(resolveFirmSnapshotOutcome({ desktop: true, failed: true }), 'unreachable');
  // Runtime answered, but from seeds — it is not reading the local book.
  assert.equal(resolveFirmSnapshotOutcome({ desktop: true, source: 'seed' }), 'unreachable');
  assert.equal(resolveFirmSnapshotOutcome({ desktop: true, source: null }), 'unreachable');
});

test('web refuses errors and non-database responses', () => {
  assert.equal(resolveFirmSnapshotOutcome({ desktop: false, failed: true }), 'unreachable');
  assert.equal(resolveFirmSnapshotOutcome({ desktop: false, source: 'seed' }), 'unreachable');
});

test('a failed fetch outranks a database source claim', () => {
  // Defensive: never read a stale/partial body as success.
  assert.equal(resolveFirmSnapshotOutcome({ desktop: true, failed: true, source: 'database' }), 'unreachable');
  assert.equal(resolveFirmSnapshotOutcome({ desktop: false, failed: true, source: 'database' }), 'unreachable');
});

test('defaults are safe with no arguments', () => {
  assert.equal(resolveFirmSnapshotOutcome(), 'unreachable');
});

// resolveFirstRunRequired — the Gate 3 first-run gate.

import { resolveFirstRunRequired } from './desktopShell.js';

test('first-run: desktop + database source + no firm row', () => {
  assert.equal(resolveFirstRunRequired({ desktop: true, source: 'database', firm: null }), true);
});

test('first-run never triggers once a firm exists, on web, or on non-database sources', () => {
  assert.equal(resolveFirstRunRequired({ desktop: true, source: 'database', firm: { id: 'f' } }), false);
  assert.equal(resolveFirstRunRequired({ desktop: false, source: 'database', firm: null }), false);
  // A seed/failed snapshot is 'unreachable' territory, never onboarding —
  // minting a firm because the runtime couldn't read the book would be the
  // §4b-iii disaster with a signup form on top.
  assert.equal(resolveFirstRunRequired({ desktop: true, source: 'seed', firm: null }), false);
  assert.equal(resolveFirstRunRequired({ desktop: true, source: null, firm: null }), false);
  assert.equal(resolveFirstRunRequired(), false);
});
