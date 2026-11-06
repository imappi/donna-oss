// Date-truncation lint — unit tests for the scanner + the ratchet
// contract over the real tree.
//
// The integration sweep is the gate: every non-test module under
// server/donna/ must match dateTruncationAllowlist.json exactly — no new
// file with a `toISOString().slice(0, 10)`-style site, no file whose
// count grew, no allowlist entry the tree has already outgrown. The
// allowlist shrinks to empty in RT-15 and this test keeps it there.

import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  DEFAULT_ALLOWLIST_PATH,
  DEFAULT_SCAN_ROOT,
  REPO_ROOT,
  TRUNCATION_PATTERNS,
  collectModuleFiles,
  censusDateTruncations,
  formatViolations,
  lintDateTruncations,
  loadAllowlist,
  scanSource
} from './dateTruncationLint.js';

// ─── Scanner ────────────────────────────────────────────────────────────

test('scanSource: every banned idiom is found, with its line', () => {
  const source = [
    'const a = new Date().toISOString().slice(0, 10);',
    'const b = value.toISOString().slice(0,10);',
    "const c = when.toISOString().split('T')[0];",
    'const d = when.toISOString().split("T")[0];',
    'const e = when.toISOString().substring(0, 10);',
    'const f = when.toISOString().substr(0, 10);',
    'const g = maybe?.toISOString()?.slice(0, 10);',
    'const h = new Date(Date.UTC(y, m, d))',
    '  .toISOString().slice(0, 10);',
    'const i = new Date(x).toISOString()',
    '  .slice(0, 10);'
  ].join('\n');
  const sites = scanSource(source);
  assert.deepEqual(
    sites.map((s) => [s.line, s.pattern]),
    [
      [1, 'toISOString_slice'],
      [2, 'toISOString_slice'],
      [3, 'toISOString_split_T'],
      [4, 'toISOString_split_T'],
      [5, 'toISOString_substring'],
      [6, 'toISOString_substring'],
      [7, 'toISOString_slice'],
      // A chained call that spans lines is one site, reported on the
      // line carrying `.toISOString()` (line 9 and line 10 below).
      [9, 'toISOString_slice'],
      [10, 'toISOString_slice']
    ]
  );
  assert.equal(sites[0].text, 'const a = new Date().toISOString().slice(0, 10);');
});

test('scanSource: the correct rule and unrelated slices are not sites', () => {
  const source = [
    "import { toIsoDay, toLocalIsoDay, toUtcIsoDay } from './dates.js';",
    'const day = toIsoDay(row.transaction_date);',
    'const stamp = new Date().toISOString();',
    'const month = new Date().toISOString().slice(0, 7);',
    'const text = String(value).slice(0, 10);',
    "const key = String(stamp).split('T')[0];",
    'const id = uuid().slice(0, 10);'
  ].join('\n');
  assert.deepEqual(scanSource(source), []);
});

test('scanSource: comment lines are not counted', () => {
  const source = [
    '// never `new Date().toISOString().slice(0, 10)` — use toLocalIsoDay',
    '/* value.toISOString().slice(0, 10) was the F-11 bug */',
    ' * value.toISOString().split(\'T\')[0] too',
    'const day = toIsoDay(value); // not value.toISOString().slice(0, 10)'
  ].join('\n');
  // The last line is CODE with a trailing comment; the idiom appears
  // only in the comment, but the scan is textual and the line is not a
  // comment line, so it counts. That is the conservative direction:
  // a site can only hide in a full comment line, never in live code.
  assert.deepEqual(scanSource(source).map((s) => s.line), [4]);
});

test('scanSource: empty / non-string input is no site', () => {
  assert.deepEqual(scanSource(''), []);
  assert.deepEqual(scanSource(null), []);
});

test('TRUNCATION_PATTERNS: sources compile and stay stateless across scans', () => {
  for (const { id, source } of TRUNCATION_PATTERNS) {
    assert.doesNotThrow(() => new RegExp(source, 'g'), id);
  }
  const line = 'x.toISOString().slice(0, 10)';
  assert.equal(scanSource(line).length, 1);
  assert.equal(scanSource(line).length, 1, 'a second scan of the same text finds the same site');
});

// ─── Allowlist file hygiene ─────────────────────────────────────────────

test('allowlist: well-formed, sorted, positive counts, non-test modules under server/donna', () => {
  const allowlist = loadAllowlist(DEFAULT_ALLOWLIST_PATH);
  const keys = Object.keys(allowlist.files);
  assert.deepEqual(keys, [...keys].sort(), 'entries must be sorted by path');
  assert.match(String(allowlist.frozen_at), /^\d{4}-\d{2}-\d{2}$/);
  for (const key of keys) {
    assert.ok(key.startsWith('server/donna/'), `${key} is outside the scan root`);
    assert.doesNotMatch(key, /\.test\.js$/, `${key} is a test file`);
    assert.ok(Number.isInteger(allowlist.files[key]) && allowlist.files[key] >= 1, `${key} count`);
  }
});

test('loadAllowlist: a malformed file throws instead of allowing nothing', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'rt07-allowlist-'));
  try {
    const file = path.join(root, 'bad.json');
    writeFileSync(file, JSON.stringify({ files: [] }));
    assert.throws(() => loadAllowlist(file), /"files" must be an object/);
    writeFileSync(file, JSON.stringify({ files: { 'a.js': 0 } }));
    assert.throws(() => loadAllowlist(file), /non-positive-integer/);
    writeFileSync(file, JSON.stringify({ files: { '/abs/a.js': 1 } }));
    assert.throws(() => loadAllowlist(file), /relative to the repo root/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ─── Integration sweep — the ratchet ────────────────────────────────────

test('integration: the tree matches dateTruncationAllowlist.json exactly', () => {
  const { violations } = lintDateTruncations();
  if (violations.length) {
    throw new Error(`date-truncation violations:\n${formatViolations(violations)}`);
  }
  assert.equal(violations.length, 0);
});

test('integration: the allowlist is EMPTY — RT-15 drained it, and it stays empty', () => {
  // RT-07 froze 99 sites in 57 files; RT-15a/b replaced every one with a
  // dates.js helper. From here the ratchet bans the idiom outright: a new
  // site anywhere under server/donna/ is a `new_file` violation.
  const allowlist = loadAllowlist(DEFAULT_ALLOWLIST_PATH);
  assert.deepEqual(allowlist.files, {});
  assert.deepEqual(censusDateTruncations(), {});
});

test('integration: the scan covers the whole server/donna tree, tests excluded', () => {
  const files = collectModuleFiles({ scanRoot: DEFAULT_SCAN_ROOT, repoRoot: REPO_ROOT });
  assert.ok(files.includes('server/donna/firmDb.js'));
  assert.ok(files.includes('server/donna/outbound/issuance.js'), 'subdirectories are walked');
  assert.ok(files.includes('server/donna/roles/journeys/collectionsJourneys.js'), 'nested subdirectories too');
  assert.ok(files.includes('server/donna/dates.js'));
  assert.ok(!files.some((f) => f.endsWith('.test.js')), 'test files are not scanned');
  assert.ok(!files.some((f) => f.includes('node_modules/')));
});

test('integration: dates.js itself carries no banned idiom', () => {
  // The one correct rule must not be implemented with the idiom it
  // replaces — its UTC formatter uses UTC getters, not toISOString().
  const sites = censusDateTruncations()['server/donna/dates.js'];
  assert.equal(sites, undefined);
});

test('integration proof: one planted site in an allowlisted file trips count_grew', () => {
  // Same shape as sqlWriterLint's "planted unknown column" proof: take a
  // module frozen at N sites, add ONE more, and show the ratchet sees it.
  // Done in a scratch tree so the repo is untouched. The frozen module is
  // synthetic: this proof used to plant into firmDb.js while it was still
  // frozen at 13 sites, and RT-15b drains the real allowlist to empty.
  const target = 'server/donna/frozen.js';
  const frozen = [
    "export const today = () => new Date().toISOString().slice(0, 10);",
    "export const day = (d) => d.toISOString().slice(0, 10);",
    ''
  ].join('\n');
  const root = mkdtempSync(path.join(tmpdir(), 'rt07-planted-'));
  try {
    mkdirSync(path.join(root, 'server', 'donna'), { recursive: true });
    const planted = `${frozen}export const plantedDay = () => new Date().toISOString().slice(0, 10);\n`;
    writeFileSync(path.join(root, target), planted);
    const { violations } = lintDateTruncations({
      scanRoot: path.join(root, 'server', 'donna'),
      repoRoot: root,
      allowlist: { frozen_at: '2026-09-01', files: { [target]: 2 } }
    });
    assert.deepEqual(
      violations.map((v) => [v.kind, v.file, v.allowed, v.actual]),
      [['count_grew', target, 2, 3]]
    );
    assert.equal(violations[0].sites.at(-1).text, 'export const plantedDay = () => new Date().toISOString().slice(0, 10);');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ─── Synthetic trees: the three violation kinds ─────────────────────────

const withSyntheticTree = (files, fn) => {
  const root = mkdtempSync(path.join(tmpdir(), 'rt07-synthetic-'));
  try {
    for (const [relPath, source] of Object.entries(files)) {
      mkdirSync(path.dirname(path.join(root, relPath)), { recursive: true });
      writeFileSync(path.join(root, relPath), source);
    }
    return fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
};

const ONE_SITE = 'export const today = () => new Date().toISOString().slice(0, 10);\n';
const TWO_SITES = `${ONE_SITE}export const day = (d) => d.toISOString().slice(0, 10);\n`;
const CLEAN = "import { toLocalIsoDay } from './dates.js';\nexport const today = () => toLocalIsoDay(new Date());\n";

test('a new file with one truncation is a violation against an empty allowlist', () => {
  withSyntheticTree({ 'fresh.js': ONE_SITE, 'clean.js': CLEAN }, (root) => {
    const { violations } = lintDateTruncations({ scanRoot: root, repoRoot: root, allowlist: { files: {} } });
    assert.deepEqual(
      violations.map((v) => [v.kind, v.file, v.allowed, v.actual]),
      [['new_file', 'fresh.js', 0, 1]]
    );
    assert.equal(violations[0].sites[0].line, 1);
    assert.match(formatViolations(violations), /fresh\.js: new_file \(allowed 0, found 1\)/);
    assert.match(formatViolations(violations), /toLocalIsoDay/);
  });
});

test('a frozen file whose count grows is a violation; an exact match is not', () => {
  withSyntheticTree({ 'a.js': TWO_SITES }, (root) => {
    const grew = lintDateTruncations({ scanRoot: root, repoRoot: root, allowlist: { files: { 'a.js': 1 } } });
    assert.deepEqual(grew.violations.map((v) => [v.kind, v.allowed, v.actual]), [['count_grew', 1, 2]]);
    const exact = lintDateTruncations({ scanRoot: root, repoRoot: root, allowlist: { files: { 'a.js': 2 } } });
    assert.deepEqual(exact.violations, []);
  });
});

test('the ratchet turns one way: an allowlist entry above the tree is stale', () => {
  withSyntheticTree({ 'a.js': ONE_SITE, 'gone.js': CLEAN }, (root) => {
    const { violations } = lintDateTruncations({
      scanRoot: root,
      repoRoot: root,
      allowlist: { files: { 'a.js': 2, 'gone.js': 1, 'deleted.js': 3 } }
    });
    assert.deepEqual(
      violations.map((v) => [v.kind, v.file, v.allowed, v.actual]),
      [
        ['stale_entry', 'a.js', 2, 1],
        ['stale_entry', 'deleted.js', 3, 0],
        ['stale_entry', 'gone.js', 1, 0]
      ]
    );
    const text = formatViolations(violations);
    assert.match(text, /a\.js: stale_entry \(allowed 2, found 1\) — shrink dateTruncationAllowlist\.json to 1/);
    assert.match(text, /gone\.js: stale_entry .* remove the entry/);
  });
});

test('test files and nested node_modules are outside the scan', () => {
  withSyntheticTree(
    {
      'a.test.js': TWO_SITES,
      'node_modules/dep/index.js': TWO_SITES,
      'nested/deep/b.js': ONE_SITE
    },
    (root) => {
      const { sites, violations } = lintDateTruncations({ scanRoot: root, repoRoot: root, allowlist: { files: {} } });
      assert.deepEqual(Object.keys(sites), ['nested/deep/b.js']);
      assert.deepEqual(violations.map((v) => v.file), ['nested/deep/b.js']);
    }
  );
});
