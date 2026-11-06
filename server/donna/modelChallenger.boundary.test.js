// The evidence-only boundary (descent-ladder spec §3.5), in the
// knowledgeRetrievalBoundary style: DIRECT-EDGE allowlist assertions, never
// transitive reachability — the server/donna monolith holds a 44-module SCC,
// so a reachability proxy cannot pass and would only block the wiring (the
// K1 rail records why).
//
// Three laws:
//   1. modelChallenger.js imports only its named substrate — the flag gate,
//      the lane registry, and node builtins. NO writer: no firmDb, no
//      proposalStore, no memory mint, no ask writer, no chat apply, no
//      ledger path. Challenger output is structurally unable to become
//      state.
//   2. Only the SEAM may import modelChallenger.js — no lane, route, or
//      chat module wires a challenger directly. (At Q2 the importer set is
//      empty; Q4 adds the seam, in the same commit that extends this
//      allowlist.)
// (The third law of §3.5 — no ledger lane in the registry — is pinned in
// modelLanes.test.js; law 1's exact import allowlist makes a ledger edge
// from the harness impossible by construction.)

import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, relative, resolve as resolvePath } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = resolvePath(dirname(fileURLToPath(import.meta.url)), '..', '..');

const importSpecifiers = (source) => {
  const patterns = [
    /\b(?:import|export)\s+(?:[^'";]*?\s+from\s*)?['"]([^'"]+)['"]/gs,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g
  ];
  return patterns.flatMap((pattern) => [...source.matchAll(pattern)].map((match) => match[1]));
};

// Law 1 — the harness's own imports, exactly.
const HARNESS_IMPORT_ALLOWLIST = new Set([
  'node:crypto',
  './clientConfig.js',
  './modelLanes.js'
]);

await test('law 1: modelChallenger.js imports only its named substrate — no writer is reachable by direct edge', () => {
  const source = readFileSync(resolvePath(repoRoot, 'server/donna/modelChallenger.js'), 'utf8');
  const imports = importSpecifiers(source);
  const outside = imports.filter((specifier) => !HARNESS_IMPORT_ALLOWLIST.has(specifier));
  assert.deepEqual(
    outside,
    [],
    'modelChallenger.js grew an import outside its allowlist — if it is a writer this is the exact bug '
      + 'this test exists to refuse; if it is substrate, extend HARNESS_IMPORT_ALLOWLIST with a reason'
  );
  // The named writers, asserted absent by name as well — belt and braces
  // against an allowlist edit that quietly adds one.
  for (const forbidden of [
    './firmDb.js', './proposalStore.js', './firmFacts.js',
    './askPipeline.js', './feedChat.js', './transactionChat.js', './documentChat.js',
    './parseDocumentsDb.js', './caseManager.js'
  ]) {
    assert.ok(!imports.includes(forbidden), `modelChallenger.js must never import ${forbidden}`);
  }
});

// Law 2 — who may import the harness. Each entry is a NAMED lane-wiring
// module (the seam side of one lane), added in the same commit as its
// lane's wiring — never a lane's deciding module, route, or chat surface.
const IMPORTER_ALLOWLIST = new Set([
  'server/donna/jevShadow.js', // exact Jev observation, scoped budget, receipt-only reverse shadow
  // (Q4's bank_line_classification wiring, bankLineChallenger.js, was the
  // first entry here; deleted with its lane in RT-14, 2026-09-02.)
  // Q6a (2026-08-13): the disposition lane's wiring module — the live
  // bare-line decider's replay, same contract as the B2 wiring.
  'server/donna/bankLineDispositionChallenger.js',
  // Q7 (2026-08-16): the reconciliation_reasoning lane's wiring module —
  // reverse shadow only (Opus challengers the lab-seated rung); replay
  // via the family modules' pure exported builders, no writer imports.
  'server/donna/reconciliationReasoningChallenger.js'
]);

const walkJsFiles = (dir, acc = []) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = resolvePath(dir, entry.name);
    if (entry.isDirectory()) walkJsFiles(full, acc);
    else if (entry.name.endsWith('.js') && !entry.name.endsWith('.test.js')) acc.push(full);
  }
  return acc;
};

await test('law 2: only the seam may import modelChallenger.js — no lane, route, or chat module wires it directly', () => {
  const importers = walkJsFiles(resolvePath(repoRoot, 'server'))
    .map((file) => ({ rel: relative(repoRoot, file).split('\\').join('/'), source: readFileSync(file, 'utf8') }))
    .filter(({ source }) => importSpecifiers(source).some((specifier) => specifier.endsWith('/modelChallenger.js') || specifier === './modelChallenger.js'))
    .map(({ rel }) => rel)
    .filter((rel) => !IMPORTER_ALLOWLIST.has(rel));
  assert.deepEqual(
    importers,
    [],
    'these modules import the challenger harness directly — challenger dispatch belongs to the seam only'
  );
});
