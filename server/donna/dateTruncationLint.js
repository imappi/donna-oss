// Date-truncation lint — the ratchet that stops hand-rolled day
// truncation from spreading while the RT-15 sweep drains it.
//
// `dates.js` holds the ONE correct pg-Date rule: a `date` column arrives
// from node-postgres as a LOCAL-midnight Date, so
// `value.toISOString().slice(0, 10)` reads the PREVIOUS day on any host
// with a positive UTC offset (the appliance) — the January-in-December
// shift of the 2026-08-26 canary, fixed in one module (the twin-aging
// lane) while ~99 sibling sites in ~30 modules kept the same one-liner
// (audit F-11). Every one of those sites is a latent day shift.
//
// This module is the in-process guardrail, modelled on sqlWriterLint.js:
//   - scan every non-test module under server/donna/ for the truncation
//     idioms (`toISOString()` followed by `.slice(0, 10)`,
//     `.substring(0, 10)`, `.substr(0, 10)`, or `.split('T')[0]`);
//   - compare the per-file counts against dateTruncationAllowlist.json,
//     which FREEZES the sites that existed when the ratchet was born;
//   - a file whose count grows, or a file not on the allowlist with any
//     site, is a violation. So is an allowlist entry that is now higher
//     than the tree (the sweep must shrink the allowlist in the same
//     commit it removes a site — a ratchet only turns one way).
//
// The allowlist shrinks to zero in RT-15, one file group per PR; then it
// stays empty and this lint keeps it that way. New code reaches for
// `dates.js` (`toIsoDay`, `toLocalIsoDay`, `toUtcIsoDay`, `toUtcDayMs`,
// `utcDayDiff`) — there is no per-site opt-out on purpose.
//
// Comment lines (a line whose first token is `//`, `/*`, or `*`) are not
// counted, so a site can be explained away in prose without keeping the
// count up. The scan is textual, not an AST walk: `\s*` between the
// tokens lets a chained call span lines, and the census is exactly the
// grep a human would run.
//
// CLI: `node server/donna/dateTruncationLint.js` prints the violations
// (exit 1 if any); `--census` prints today's per-file counts as the JSON
// the allowlist's `files` map takes.

import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

export const REPO_ROOT = path.resolve(HERE, '..', '..');
export const DEFAULT_SCAN_ROOT = HERE;
export const DEFAULT_ALLOWLIST_PATH = path.join(HERE, 'dateTruncationAllowlist.json');

// Regex SOURCES, not compiled regexes — each scan compiles its own /g
// instance so no lastIndex state leaks between files.
export const TRUNCATION_PATTERNS = Object.freeze([
  {
    id: 'toISOString_slice',
    source: String.raw`\.toISOString\(\)\s*\??\.\s*slice\(\s*0\s*,\s*10\s*\)`
  },
  {
    id: 'toISOString_substring',
    source: String.raw`\.toISOString\(\)\s*\??\.\s*(?:substring|substr)\(\s*0\s*,\s*10\s*\)`
  },
  {
    id: 'toISOString_split_T',
    source: String.raw`\.toISOString\(\)\s*\??\.\s*split\(\s*(['"` + '`' + String.raw`])T\1\s*\)\s*\[\s*0\s*\]`
  }
]);

const COMMENT_LINE_RE = /^\s*(?:\/\/|\/\*|\*)/;

const lineStartOf = (source, index) => source.lastIndexOf('\n', index - 1) + 1;

const lineTextAt = (source, index) => {
  const start = lineStartOf(source, index);
  const end = source.indexOf('\n', index);
  return source.slice(start, end === -1 ? source.length : end);
};

const lineNumberAt = (source, index) => {
  let line = 1;
  for (let i = 0; i < index; i += 1) if (source.charCodeAt(i) === 10) line += 1;
  return line;
};

// Every truncation site in one module's source: [{ line, pattern, text }],
// in source order. Comment lines are skipped (see header).
export const scanSource = (source) => {
  const text = String(source ?? '');
  const sites = [];
  for (const { id, source: patternSource } of TRUNCATION_PATTERNS) {
    const re = new RegExp(patternSource, 'g');
    for (const match of text.matchAll(re)) {
      const lineText = lineTextAt(text, match.index);
      if (COMMENT_LINE_RE.test(lineText)) continue;
      sites.push({ line: lineNumberAt(text, match.index), pattern: id, text: lineText.trim() });
    }
  }
  return sites.sort((a, b) => a.line - b.line);
};

const SKIPPED_DIRS = new Set(['node_modules', '.git']);
const MODULE_EXTENSIONS = ['.js', '.mjs', '.cjs'];

const isModuleFile = (name) =>
  MODULE_EXTENSIONS.some((ext) => name.endsWith(ext)) && !/\.test\.(?:js|mjs|cjs)$/.test(name);

// Every non-test module under `scanRoot`, as posix paths relative to
// `repoRoot` (the allowlist's key space), sorted.
export const collectModuleFiles = ({ scanRoot = DEFAULT_SCAN_ROOT, repoRoot = REPO_ROOT } = {}) => {
  const files = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRS.has(entry.name)) walk(path.join(dir, entry.name));
      } else if (entry.isFile() && isModuleFile(entry.name)) {
        files.push(path.relative(repoRoot, path.join(dir, entry.name)).split(path.sep).join('/'));
      }
    }
  };
  walk(scanRoot);
  return files.sort();
};

// { [relPath]: sites[] } for every module with at least one site.
export const censusDateTruncations = ({ scanRoot = DEFAULT_SCAN_ROOT, repoRoot = REPO_ROOT } = {}) => {
  const sites = {};
  for (const relPath of collectModuleFiles({ scanRoot, repoRoot })) {
    const found = scanSource(readFileSync(path.join(repoRoot, relPath), 'utf8'));
    if (found.length) sites[relPath] = found;
  }
  return sites;
};

// The allowlist file: { frozen_at, files: { [relPath]: count } }. Shape
// errors throw — a malformed allowlist must fail the suite, never pass
// as "nothing allowed".
export const loadAllowlist = (allowlistPath = DEFAULT_ALLOWLIST_PATH) => {
  const parsed = JSON.parse(readFileSync(allowlistPath, 'utf8'));
  const files = parsed?.files;
  if (!files || typeof files !== 'object' || Array.isArray(files)) {
    throw new Error(`date-truncation allowlist ${allowlistPath}: "files" must be an object of { path: count }`);
  }
  for (const [relPath, count] of Object.entries(files)) {
    if (!Number.isInteger(count) || count < 1) {
      throw new Error(`date-truncation allowlist: ${relPath} has a non-positive-integer count (${count})`);
    }
    if (relPath.includes('\\') || path.posix.isAbsolute(relPath)) {
      throw new Error(`date-truncation allowlist: ${relPath} must be a posix path relative to the repo root`);
    }
  }
  return { frozen_at: parsed.frozen_at ?? null, files: { ...files } };
};

// The ratchet. Returns { sites, violations }; violations is empty when
// the tree matches the allowlist exactly. Kinds:
//   new_file    — a module with sites that the allowlist does not name
//   count_grew  — a named module has more sites than frozen
//   stale_entry — the allowlist names more sites than the tree has (the
//                 sweep removed some, or the file is gone): shrink it
export const lintDateTruncations = ({
  scanRoot = DEFAULT_SCAN_ROOT,
  repoRoot = REPO_ROOT,
  allowlist = loadAllowlist()
} = {}) => {
  const sites = censusDateTruncations({ scanRoot, repoRoot });
  const allowed = allowlist.files;
  const violations = [];
  for (const [relPath, found] of Object.entries(sites)) {
    const permitted = allowed[relPath];
    if (permitted === undefined) {
      violations.push({ kind: 'new_file', file: relPath, allowed: 0, actual: found.length, sites: found });
    } else if (found.length > permitted) {
      violations.push({ kind: 'count_grew', file: relPath, allowed: permitted, actual: found.length, sites: found });
    }
  }
  for (const [relPath, permitted] of Object.entries(allowed)) {
    const actual = sites[relPath]?.length ?? 0;
    if (actual < permitted) {
      violations.push({ kind: 'stale_entry', file: relPath, allowed: permitted, actual, sites: sites[relPath] ?? [] });
    }
  }
  violations.sort((a, b) => a.file.localeCompare(b.file));
  return { sites, violations };
};

export const formatViolations = (violations) =>
  violations
    .map((v) => {
      const head = `  ${v.file}: ${v.kind} (allowed ${v.allowed}, found ${v.actual})`;
      if (v.kind === 'stale_entry') {
        return `${head} — shrink dateTruncationAllowlist.json to ${v.actual || 'remove the entry'}`;
      }
      const lines = v.sites.map((s) => `      L${s.line} ${s.text}`).join('\n');
      return `${head} — use dates.js (toIsoDay / toLocalIsoDay / toUtcIsoDay)\n${lines}`;
    })
    .join('\n');

const main = () => {
  if (process.argv.includes('--census')) {
    const sites = censusDateTruncations();
    const files = Object.fromEntries(Object.keys(sites).sort().map((f) => [f, sites[f].length]));
    process.stdout.write(`${JSON.stringify(files, null, 2)}\n`);
    return;
  }
  const { violations } = lintDateTruncations();
  if (!violations.length) {
    process.stdout.write('date-truncation lint: clean\n');
    return;
  }
  process.stderr.write(`date-truncation violations:\n${formatViolations(violations)}\n`);
  process.exitCode = 1;
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
