// Grep-readable sources — the ratchet: no raw NUL bytes in text files.
//
// A raw NUL byte (0x00) anywhere in a text file flips ripgrep into binary
// mode for that file: content searches print "binary file matches" instead of
// the matching lines, and match output is suppressed. In this repo that is
// not a cosmetic problem — the standing verification protocol ("verify the
// running tree, not the handoff's word", the grep-anchor bootstrap steps in
// every session handoff, the wire-into-the-mounted-surface rail) RUNS on
// grep. A grep-invisible source file quietly defeats all of it.
//
// This class was found and fixed once before — a literal NUL in
// memoryModel.js's buildMemoryKey join separator, escaped on 2026-07-12 — but
// only the instance was fixed, and by 2026-08-15 eight more existed (join
// separators, control-char test fixtures, a regex class, and the very handoff
// doc recording the July fix). Instance-fixing without a ratchet demonstrably
// does not hold; this test closes the CLASS. The fix is always the same and
// always runtime-identical: write the escape (backslash-u0000 in JS source,
// i.e. the six characters \u0000) instead of the raw byte.
//
// Exemptions are for raw external captures whose bytes ARE their provenance
// (rewriting one to please grep would falsify it). There are none today: the
// scraped site captures that needed one left the repo on 2026-11-05. Add to
// EXEMPT_DIRS only with that justification; a code or docs file never
// qualifies.

import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url));

const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', 'build', '.next', 'coverage', '__pycache__', '.vercel']);

// Relative directory prefixes (POSIX form) whose files are raw external
// captures, preserved byte-for-byte.
const EXEMPT_DIRS = [];

const TEXT_EXTENSIONS = [
  '.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx',
  '.md', '.sql', '.json', '.py', '.sh', '.yml', '.yaml', '.css', '.html'
];

const walk = (dir, out = []) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) walk(join(dir, entry.name), out);
    } else if (entry.isFile() && TEXT_EXTENSIONS.some((ext) => entry.name.endsWith(ext))) {
      out.push(join(dir, entry.name));
    }
  }
  return out;
};

test('no text source file carries a raw NUL byte (it would be invisible to grep)', () => {
  const offenders = [];
  for (const path of walk(REPO_ROOT)) {
    const rel = relative(REPO_ROOT, path).split(sep).join('/');
    if (EXEMPT_DIRS.some((prefix) => rel.startsWith(prefix))) continue;
    const data = readFileSync(path);
    const at = data.indexOf(0);
    if (at !== -1) {
      const line = 1 + [...data.subarray(0, at)].filter((b) => b === 0x0a).length;
      offenders.push(`${rel}:${line}`);
    }
  }
  assert.deepEqual(offenders, [],
    'raw NUL byte(s) found — ripgrep will treat these files as binary and hide their content from every grep. '
    + 'Replace the raw byte with its escape (\\u0000 in JS source); the runtime value is identical. '
    + `Offenders: ${offenders.join(', ')}`);
});
