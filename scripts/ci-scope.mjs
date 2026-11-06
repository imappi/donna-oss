#!/usr/bin/env node
// Decides what a CI run must prove, from the files the change touches
// (Kari, 2026-11-05: the Actions bill had become the largest line in the stack).
//
// - A change that touches only documentation skips the test suite, unless code
//   reads one of the changed files (a test that pins a doc). Root-level
//   markdown is NOT all documentation: only the files named in DOC_ROOT_FILES
//   count, so a root file the app reads is still treated as code.
// - Pull requests run the suite once, in UTC. A push to main also runs it in
//   Europe/Helsinki: the second, non-UTC pass is the 2026-09-01 forensics F-11
//   day-shift check, re-pointed from Asia/Dubai when the UAE went on hold.
// - When the changed files cannot be listed, the suite runs (fail closed).
//
// Usage in CI: node scripts/ci-scope.mjs  (writes run_tests and zones to $GITHUB_OUTPUT)
import { readFileSync, appendFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DOC_ROOT_FILES = Object.freeze(['AGENTS.md', 'CLAUDE.md', 'DEPLOYMENT.md', 'README.md', 'SESSION_HANDOFF.md']);
export const PULL_REQUEST_ZONES = Object.freeze(['UTC']);
export const MAIN_ZONES = Object.freeze(['UTC', 'Europe/Helsinki']);

export const isDocumentation = (file) => file.startsWith('docs/') || DOC_ROOT_FILES.includes(file);

// Paths that code (not comments) names as string literals: 'docs/x.md',
// '../../docs/dir/', `docs/dir/${name}`, 'Skill_Notes_v1.md'. A reference that
// ends in a directory or a template covers everything under it.
export const referencedPaths = (source) => {
  const code = source.split('\n').filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line)).join('\n');
  const found = new Set();
  for (const match of code.matchAll(/(['"`])((?:\.\.?\/)*(?:docs(?:\/[^'"`\s]*)?|[A-Za-z0-9_.-]+\.md))\1/g)) {
    found.add(match[2].replace(/^(\.\.?\/)+/, '').split('${')[0]);
  }
  return found;
};

export const coveredBy = (file, reference) => file === reference
  || file.startsWith(reference.endsWith('/') ? reference : `${reference}/`)
  || (!reference.includes('/') && path.posix.basename(file) === reference);

export const decideScope = ({ event, files, references }) => {
  const zones = event === 'push' ? [...MAIN_ZONES] : [...PULL_REQUEST_ZONES];
  if (!Array.isArray(files) || !files.length) return { runTests: true, zones, reason: 'the changed files could not be listed' };
  const code = files.filter((file) => !isDocumentation(file));
  if (code.length) return { runTests: true, zones, reason: `${code.length} changed file(s) outside the documentation, e.g. ${code[0]}` };
  const read = files.filter((file) => [...references].some((reference) => coveredBy(file, reference)));
  if (read.length) return { runTests: true, zones, reason: `code reads a changed doc: ${read.join(', ')}` };
  return { runTests: false, zones: [...PULL_REQUEST_ZONES], reason: `documentation only (${files.length} file(s))` };
};

export const listCodeReferences = () => {
  const sources = execFileSync('git', ['ls-files', '*.js', '*.mjs', '*.cjs', '*.jsx'], { cwd: ROOT, encoding: 'utf8' }).trim().split('\n');
  const references = new Set();
  for (const file of sources) {
    // This script, and the public exporter, name doc paths to leave out, not to read.
    if (file === 'scripts/ci-scope.mjs' || file === 'scripts/ci-scope.test.js'
      || file.startsWith('scripts/public-export/')) continue;
    for (const reference of referencedPaths(readFileSync(path.join(ROOT, file), 'utf8'))) references.add(reference);
  }
  return references;
};

const github = async (route) => {
  const response = await fetch(`https://api.github.com${route}`, {
    headers: { Authorization: `Bearer ${process.env.GITHUB_TOKEN}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' }
  });
  if (!response.ok) throw new Error(`GitHub API ${route} answered ${response.status}`);
  return response.json();
};

// The pull request's own file list (up to GitHub's 3,000), or the pushed range.
// A compare that hits GitHub's 300-file cap is treated as unknown.
const listChangedFiles = async () => {
  const repo = process.env.GITHUB_REPOSITORY;
  if (process.env.GITHUB_EVENT_NAME === 'pull_request') {
    const files = [];
    for (let page = 1; page <= 30; page += 1) {
      const batch = await github(`/repos/${repo}/pulls/${process.env.SCOPE_PR_NUMBER}/files?per_page=100&page=${page}`);
      files.push(...batch.map((entry) => entry.filename), ...batch.map((entry) => entry.previous_filename).filter(Boolean));
      if (batch.length < 100) return files;
    }
    return null;
  }
  const before = process.env.SCOPE_BEFORE || '';
  if (!/^[0-9a-f]{40}$/.test(before) || /^0+$/.test(before)) return null;
  const comparison = await github(`/repos/${repo}/compare/${before}...${process.env.GITHUB_SHA}`);
  if (!Array.isArray(comparison.files) || comparison.files.length >= 300) return null;
  return comparison.files.flatMap((entry) => [entry.filename, entry.previous_filename].filter(Boolean));
};

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let files = null;
  try {
    files = await listChangedFiles();
  } catch (error) {
    console.warn(`Could not list the changed files (${error.message}); running the suite.`);
  }
  const scope = decideScope({ event: process.env.GITHUB_EVENT_NAME, files, references: listCodeReferences() });
  console.log(`Scope: ${scope.runTests ? 'run the suite' : 'skip the suite'} in ${scope.zones.join(' + ')}, because ${scope.reason}.`);
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `run_tests=${scope.runTests}\nzones=${JSON.stringify(scope.zones)}\n`);
  }
}
