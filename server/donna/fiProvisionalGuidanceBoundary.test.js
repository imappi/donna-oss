// FIK-3 provisional arm (plan §8.8) — the seam boundary, machine-checked as an
// ALLOWLIST of direct references (the knowledgeRetrievalBoundary.test.js
// pattern: direct edges, never transitive reachability, which this monolith's
// import cycles make meaningless).
//
// The law: unreviewed draft guidance reaches a prompt only inside the scope the
// OFFLINE harness opens. So:
//   1. Only the renderer's own module and the harness runtime name the scope
//      entry. No other file under server/donna/ (nor api/, src/, desktop/,
//      packs/ or the root) may reference it, so no production path can open it.
//   2. Only the FI coding-policy definition calls the scope reader, and only the
//      shared resolver calls the definition hook; neither can open the scope.
//   3. The harness runtime that opens it is imported by nothing outside scripts/.
//   4. No flag, env var or config key names the provisional variant.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as decisionGuidance from './finland/decisionGuidance.js';

const REPO = fileURLToPath(new URL('../../', import.meta.url));
const SCAN = ['server', 'api', 'src', 'desktop', 'packs', 'scripts', 'supabase', 'vite.config.js'];
const SOURCE = /\.(?:m?js|cjs|jsx|ts|tsx)$/;
const isTest = (file) => /\.test\.(?:m?js|jsx|ts)$/.test(file) || file.includes('/testSupport/');
const walk = (path) => {
  if (!existsSync(path)) return [];
  if (!statSync(path).isDirectory()) return SOURCE.test(path) ? [path] : [];
  return readdirSync(path).filter((name) => name !== 'node_modules' && !name.startsWith('.')).flatMap((name) => walk(join(path, name)));
};
const files = SCAN.flatMap((entry) => walk(join(REPO, entry))).map((path) => ({ rel: relative(REPO, path).split('\\').join('/'), text: readFileSync(path, 'utf8') }));
const sorted = (...rels) => [...rels].sort();
const referencing = (name) => files.filter((f) => !isTest(f.rel) && new RegExp(`\\b${name}\\b`).test(f.text)).map((f) => f.rel).sort();

const RENDERER = 'server/donna/finland/decisionGuidance.js';
const FI_DEFINITION = 'server/donna/finland/codingPolicy.js';
const RESOLVER = 'server/donna/codingPolicy.js';
const HARNESS = 'scripts/jev_decision_plane_fi_run.js';
const HARNESS_LANE = 'scripts/jev_decision_plane_fi.js';

test('the scan sees the tree (the allowlist cannot pass by reading nothing)', () => {
  for (const rel of [RENDERER, FI_DEFINITION, RESOLVER, HARNESS, HARNESS_LANE, 'server/donna/db/coding.js', 'server/donna/db/postingPolicyContext.js']) {
    assert.ok(files.some((f) => f.rel === rel), `${rel} scanned`);
  }
  assert.ok(files.filter((f) => f.rel.startsWith('server/donna/')).length > 200);
});

test('1. only the renderer and the offline harness name the scope entry', () => {
  assert.equal(typeof decisionGuidance.__runWithFiProvisionalGuidanceForHarness, 'function');
  assert.deepEqual(referencing('__runWithFiProvisionalGuidanceForHarness'), sorted(HARNESS, RENDERER));
  // No server/donna/ file other than the renderer references the seam at all.
  const seam = ['__runWithFiProvisionalGuidanceForHarness', 'renderFiProvisionalGuidance', 'validateFiProvisionalGuidanceEntries', 'FI_PROVISIONAL_GUIDANCE_VARIANT'];
  for (const name of seam) {
    const inServer = referencing(name).filter((rel) => rel.startsWith('server/'));
    assert.deepEqual(inServer.filter((rel) => rel !== RENDERER && rel !== FI_DEFINITION), [], `${name} referenced in server/`);
  }
  // The scope store itself is never exported: only the entry and the reader.
  assert.deepEqual(Object.keys(decisionGuidance).filter((key) => /provisional/i.test(key)).sort(),
    ['FI_PROVISIONAL_GUIDANCE_VARIANT', '__runWithFiProvisionalGuidanceForHarness', 'renderFiProvisionalGuidance', 'validateFiProvisionalGuidanceEntries']);
});

test('2. the reader and the hook each have one named caller, neither of which opens the scope', () => {
  assert.deepEqual(referencing('renderFiProvisionalGuidance'), sorted(RENDERER, FI_DEFINITION));
  assert.deepEqual(referencing('provisionalGuidanceFor'), sorted(RESOLVER, FI_DEFINITION));
  assert.deepEqual(referencing('validateFiProvisionalGuidanceEntries'), sorted(HARNESS_LANE, RENDERER));
  assert.deepEqual(referencing('FI_PROVISIONAL_GUIDANCE_VARIANT'), sorted(HARNESS_LANE, RENDERER));
  for (const rel of [FI_DEFINITION, RESOLVER]) {
    const text = files.find((f) => f.rel === rel).text;
    assert.ok(!/__runWithFiProvisionalGuidanceForHarness|AsyncLocalStorage/.test(text), `${rel} cannot open a scope`);
  }
});

test('3. the harness runtime that opens the scope is imported by nothing outside scripts/', () => {
  const importers = files.filter((f) => !isTest(f.rel) && /(?:\bfrom\s*|\bimport\s*\(\s*)['"][^'"]*jev_decision_plane_fi_run(?:\.js)?['"]/.test(f.text)).map((f) => f.rel);
  assert.ok(importers.length > 0, 'the runner imports it');
  assert.deepEqual(importers.filter((rel) => !rel.startsWith('scripts/')), []);
});

test('4. no flag, env var or config key names the provisional variant', () => {
  // The only variant reader is the FIK-2 flag, and its answers are reviewed or none.
  const variantReader = files.find((f) => f.rel === 'server/donna/codingGuidanceVariant.js').text;
  assert.ok(!/provisional/i.test(variantReader));
  const flagOrEnv = /(?:process\.env\.|flagKey:\s*['"]|FLAG\s*=\s*['"])[A-Z0-9_]*PROVISIONAL_GUIDANCE/;
  assert.deepEqual(files.filter((f) => !isTest(f.rel) && flagOrEnv.test(f.text)).map((f) => f.rel), []);
  const migrations = walk(join(REPO, 'db/migrations')).concat(readdirSync(join(REPO, 'db/migrations')).filter((n) => n.endsWith('.sql')).map((n) => join(REPO, 'db/migrations', n)));
  for (const path of migrations) assert.ok(!/PROVISIONAL_GUIDANCE|fi_v8p/i.test(readFileSync(path, 'utf8')), relative(REPO, path));
});
