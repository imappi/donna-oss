import { fileURLToPath } from 'node:url';
// desktop-files-whitelist — the packaged app ships ONLY what the files
// whitelist in desktop/electron-builder.yml matches (asar: false, app = repo
// root). This walks the static import closure of every packaged entrypoint
// and asserts the whitelist covers each reached file, so a new cross-tree
// import (the classic: a server module importing src/lib shared logic) fails
// HERE in the container instead of as a MODULE_NOT_FOUND 500 on the first
// Mac build. Bare specifiers are npm deps — electron-builder ships the
// production dependency tree itself, so they are out of scope here.

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// The processes the packaged app actually starts: Electron main (package.json
// "main") + preload, the utilityProcess runtime, and the node children the
// desktop lane spawns (boot, backup, migrate, seed). Keep in sync with the
// scripts/ entries in the whitelist.
const ENTRYPOINTS = [
  'desktop/main.mjs',
  'desktop/preload.cjs',
  'desktop/runtime.mjs',
  'scripts/desktop-boot.mjs',
  'scripts/desktop-backup.mjs',
  'scripts/migrate_firm_db.js',
  'scripts/seed_firm_db.js',
];

// ---- whitelist parsing (the files: block of desktop/electron-builder.yml) --

const readFilesWhitelist = () => {
  const yml = readFileSync(path.join(ROOT, 'desktop', 'electron-builder.yml'), 'utf8');
  const lines = yml.split('\n');
  const start = lines.findIndex((l) => /^files:\s*$/.test(l));
  assert.notEqual(start, -1, 'no files: block in desktop/electron-builder.yml');
  const patterns = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (/^\S/.test(line)) break; // next top-level key
    const m = line.match(/^\s+-\s+"?([^"#]+?)"?\s*$/);
    if (m) patterns.push(m[1]);
  }
  return patterns;
};

// Minimal glob→regex for the vocabulary the whitelist uses: exact paths,
// `dir/**/*`, `**/*`, `*` (no slash), `!` negations. Placeholder chars keep
// the `*` pass from mangling the multi-star tokens.
const globToRegExp = (glob) => {
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*\//g, '\u0000') // **/ → any depth (incl. none)
    .replace(/\*\*/g, '\u0001')   // **  → anything
    .replace(/\*/g, '[^/]*')      // *   → within one segment
    .replace(/\u0000/g, '(?:.*/)?')
    .replace(/\u0001/g, '.*');
  return new RegExp(`^${escaped}$`);
};

const makeCovered = (patterns) => {
  const positive = patterns.filter((p) => !p.startsWith('!')).map(globToRegExp);
  const negative = patterns.filter((p) => p.startsWith('!')).map((p) => globToRegExp(p.slice(1)));
  return (rel) => positive.some((re) => re.test(rel)) && !negative.some((re) => re.test(rel));
};

// ---- static import closure ------------------------------------------------

const SPEC_RE = /(?:import|export)[^'"`]*?from\s*['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)|require\s*\(\s*['"]([^'"]+)['"]\s*\)|import\s*['"]([^'"]+)['"]/g;

const resolveRelative = (fromFile, spec) => {
  const base = path.resolve(path.dirname(fromFile), spec);
  for (const cand of [base, `${base}.js`, `${base}.mjs`, `${base}.cjs`, path.join(base, 'index.js')]) {
    if (existsSync(cand) && statSync(cand).isFile()) return cand;
  }
  return null; // regex noise (strings that look like imports) or a path that already breaks in dev
};

const importClosure = (entryFiles) => {
  const seen = new Set();
  const queue = [...entryFiles];
  while (queue.length > 0) {
    const file = queue.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    let src;
    try { src = readFileSync(file, 'utf8'); } catch { continue; }
    for (const m of src.matchAll(SPEC_RE)) {
      const spec = m[1] || m[2] || m[3] || m[4];
      if (!spec || !spec.startsWith('.')) continue; // bare = npm dep, ships via node_modules
      const resolved = resolveRelative(file, spec);
      if (resolved && !seen.has(resolved)) queue.push(resolved);
    }
  }
  return seen;
};

// ---- the contract ----------------------------------------------------------

test('every packaged entrypoint exists and is whitelisted', () => {
  const covered = makeCovered(readFilesWhitelist());
  for (const entry of ENTRYPOINTS) {
    assert.ok(existsSync(path.join(ROOT, entry)), `entrypoint missing from tree: ${entry}`);
    assert.ok(covered(entry), `entrypoint not covered by the files whitelist: ${entry}`);
  }
});

test('the files whitelist covers the full import closure of the packaged app', () => {
  const covered = makeCovered(readFilesWhitelist());
  const closure = importClosure(ENTRYPOINTS.map((e) => path.join(ROOT, e)));
  // Sanity: the walk must actually descend into the server tree — a broken
  // walker passing vacuously would defeat the guard.
  assert.ok(closure.size > 100, `closure suspiciously small (${closure.size} files) — walker broken?`);

  const gaps = [...closure]
    .map((f) => path.relative(ROOT, f))
    .filter((rel) => !covered(rel))
    .sort();
  assert.deepEqual(
    gaps,
    [],
    `runtime-reachable files missing from desktop/electron-builder.yml files whitelist — ` +
      `the packaged app would MODULE_NOT_FOUND on these:\n  ${gaps.join('\n  ')}`
  );
});

// Data files the runtime READS at run time rather than imports — invisible
// to the static closure walk above, so they get their own explicit contract.
// (vercel.json was on this list until RT-14: handlerManifest.js used to
// derive the desktop scheduler's http-cron entries from it and was
// fatal-on-purpose when it was missing — the first drill launch died on
// exactly that, 2026-08-07. The manifest now carries its own schedule table
// and reads no file; the packaged bundle may still ship vercel.json, but
// nothing at runtime needs it.) Extend this list when a grep for
// REPO_ROOT-relative readFileSync targets grows a new entry.
const RUNTIME_DATA_FILES = [
  'data/worlds/admitted-entity-profiles.json',
  'data/worlds/policy/gb-uk-ltd-management-books-v1.json',
  'server/donna/outbound/fonts/NotoSansArabic-wdth-wght.ttf',
  'server/donna/outbound/fonts/OFL.txt'
];

test('runtime-read data files are whitelisted', () => {
  const covered = makeCovered(readFilesWhitelist());
  for (const file of RUNTIME_DATA_FILES) {
    assert.ok(existsSync(path.join(ROOT, file)), `runtime data file missing from tree: ${file}`);
    assert.ok(covered(file), `runtime-read data file not covered by the files whitelist: ${file}`);
  }
});

test('.env files are never whitelisted (secrets must not ship in the bundle)', () => {
  const covered = makeCovered(readFilesWhitelist());
  // providerKeyDotEnv.js reads these existsSync-guarded — absence is fine,
  // shipping them would leak keys into every built DMG.
  assert.ok(!covered('.env'), '.env must not be packaged');
  assert.ok(!covered('.env.local'), '.env.local must not be packaged');
});

test('glob translation handles the whitelist vocabulary', () => {
  const covered = makeCovered(['server/**/*', 'scripts/migrate_firm_db.js', 'src/lib/**/*', '!**/*.test.js']);
  assert.ok(covered('server/donna/firmDb.js'));
  assert.ok(covered('server/donna/desktop/pgSupervisor.js'));
  assert.ok(covered('scripts/migrate_firm_db.js'));
  assert.ok(covered('src/lib/pricing.js'));
  assert.ok(!covered('server/donna/firmDb.test.js'), 'negation must exclude tests at depth');
  assert.ok(!covered('scripts/seed_firm_db.js'), 'exact entries must not over-match');
  assert.ok(!covered('outside/x.js'));
});
