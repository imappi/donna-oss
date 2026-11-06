// Donna — the GROUND vs GOVERN boundary, machine-checked as an ALLOWLIST.
//
// The design's central law (docs/design-donna-knowledge-base.md §2):
//
//   "A knowledge answer is never an authorization. […] K1 GROUNDS answers;
//    packs and modules GOVERN actions. A passage that disagrees with a pack is a
//    conflict to SURFACE, never an override and never a block on posting."
//
// ── WHY THIS IS AN ALLOWLIST NOW, NOT A REACHABILITY PROXY (§15, Kari 2026-07-30)
//
// Through K1-4 this test read *"no module that transitively imports K1 may
// transitively reach a ledger writer"*. That was valuable then (it caught the
// capability-pack taint bug on its first run) but it could not survive K1 being
// CALLED: `server/donna/**` has a single 44-module strongly-connected component
// holding `firmDb.js`, `clientPortalTurn.js` and `ledgerPostingGateway.js`
// together, so the instant any SCC member reads K1, every member "reaches" a
// writer and every member is "tainted" — 103 violations for one honest edge.
// Inside one cycle, module-granularity reachability cannot tell "the owner chat
// consulted a statute" from "the posting path consulted a statute". The green was
// an artifact of K1 being uncalled: it tested *"K1 is not wired"*, not *"K1 has
// no authority"*.
//
// §15 records Kari's dated call (option 1): re-express the check as an allowlist.
// It states the REAL law — *these named modules may ground answers; the grounding
// path may never reach a writer; no posting-decision module may consult a
// passage* — as DIRECT-edge assertions, which are satisfiable in a cyclic graph
// and are arguably STRONGER: they enumerate the legitimate readers instead of
// trusting a reachability proxy the monolith made meaningless. §14's substance is
// preserved exactly — no veto, no override, the pack stays the single execution
// authority; only the proxy is dropped. This does NOT route around the boundary
// by injecting the seam from outside server/donna/ (§15's named anti-pattern):
// the seam lives here and this test governs it.
//
// The three laws:
//   1. The grounding path CANNOT POST. No K1 ground module, and not the answer
//      seam, forward-reaches a ledger writer. This is the load-bearing law —
//      "K1 has no authority" — and it is satisfiable because every K1 module is
//      pure over its inputs (it imports only the store contract + clientConfig +
//      node builtins, none of which write).
//   2. Only the seam reaches K1's internals. Every module that directly imports a
//      K1 ground module is itself a K1 ground module or the answer seam — so a
//      new caller cannot quietly bind to the retrieval/answer internals.
//   3. Only named surfaces may ground. Every module that directly imports the
//      answer seam is on the answer-surface allowlist, and NO ledger writer
//      imports the seam.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, resolve as resolvePath, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = __dirname;

// The modules that write to the books of record — Donna's own ledger and the
// provider mirrors. Named explicitly; every entry is existence-checked below so
// the list cannot silently empty itself on a rename.
// RT-17: firmDb.js is decomposed into server/donna/db/<plane>.js; the hub keeps
// re-exporting, so it stays listed, and EVERY plane file joins the writer set
// (read from the directory so a new plane cannot land outside the law).
const DB_PLANE_FILES = readdirSync(resolvePath(ROOT, 'db'))
  .filter((f) => f.endsWith('.js') && !f.endsWith('.test.js'))
  .sort()
  .map((f) => `db/${f}`);
const LEDGER_WRITERS = [
  'ledger.js',
  'ledgerPostingGateway.js',
  'donnaLedgerWriteback.js',
  'xeroWriteback.js',
  'qboWriteback.js',
  'procountorWriteback.js',
  'documentSettlementEntry.js',
  'firmDb.js',
  ...DB_PLANE_FILES
];

// K1's read + answer path — the "ground" modules. A passage becomes an answer by
// flowing through these and nothing else. They must never reach a writer.
const K1_GROUND_MODULES = [
  'knowledgeRetrieval.js',
  'knowledgeRetrievalDb.js',
  'knowledgeAnswer.js',
  'knowledgeFactResolution.js'
];

// The single module that joins K1 to an owner surface (§10/§15). Everything an
// owner-facing assembler needs from K1 comes through here; it is the one place
// the ground modules may be imported from outside their own set.
const K1_SEAM = 'knowledgeAnswerSeam.js';

// The surfaces permitted to import the seam — the answer-path allowlist. Adding a
// surface here is a deliberate, reviewed act (owner channels and the admin chat
// join it when they are wired). A ledger writer may NEVER be on this list.
const K1_ANSWER_SURFACE_ALLOWLIST = [
  'clientPortalTurn.js'
];

// ── A small ESM import graph over server/donna/**.js ────────────────────────

const listModules = (dir) => {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = resolvePath(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...listModules(full));
    } else if (entry.endsWith('.js') && !entry.endsWith('.test.js')) {
      out.push(full);
    }
  }
  return out;
};

// Relative specifiers only — a bare package name cannot reach back into this
// tree, and resolving node_modules would make the graph enormous for no gain.
const IMPORT_RE = /(?:^|\n)\s*(?:import[\s\S]*?from\s*|export[\s\S]*?from\s*)['"](\.[^'"]+)['"]/g;
const DYNAMIC_IMPORT_RE = /\bimport\s*\(\s*['"](\.[^'"]+)['"]\s*\)/g;

const withJs = (p) => (p.endsWith('.js') ? p : `${p}.js`);

const buildGraph = () => {
  const graph = new Map();
  for (const file of listModules(ROOT)) {
    const src = readFileSync(file, 'utf8');
    const edges = new Set();
    for (const re of [IMPORT_RE, DYNAMIC_IMPORT_RE]) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(src)) !== null) {
        edges.add(withJs(resolvePath(dirname(file), m[1])));
      }
    }
    graph.set(file, edges);
  }
  return graph;
};

// Every module reachable FORWARD from `start` by following its imports.
const forwardReachable = (graph, start) => {
  const seen = new Set();
  const stack = [start];
  while (stack.length) {
    const node = stack.pop();
    if (seen.has(node)) continue;
    seen.add(node);
    for (const next of graph.get(node) || []) if (!seen.has(next)) stack.push(next);
  }
  return seen;
};

// The modules that DIRECTLY import `target` (reverse edges — a one-hop query, not
// reachability; this is what makes the allowlist satisfiable in a cyclic graph).
const directImporters = (graph, target) => {
  const importers = [];
  for (const [file, edges] of graph) {
    if (edges.has(target)) importers.push(file);
  }
  return importers;
};

// ── The check, factored out so the vacuity proofs can run it on a poisoned graph.

const findBoundaryViolations = (graph, { groundModules, seam, writers, surfaceAllowlist }) => {
  const groundSet = new Set(groundModules);
  const writerSet = new Set(writers);
  const allowlistSet = new Set(surfaceAllowlist);
  const violations = [];

  // Law 1 — the grounding path cannot post. No ground module, and not the seam,
  // may forward-reach a writer.
  for (const groundPathModule of [...groundModules, seam]) {
    for (const reached of forwardReachable(graph, groundPathModule)) {
      if (reached !== groundPathModule && writerSet.has(reached)) {
        violations.push({ law: 1, from: relative(ROOT, groundPathModule), reaches: relative(ROOT, reached) });
        break;
      }
    }
  }

  // Law 2 — only the seam (or another ground module) may import a ground module.
  for (const groundModule of groundModules) {
    for (const importer of directImporters(graph, groundModule)) {
      if (importer === seam || groundSet.has(importer)) continue;
      violations.push({ law: 2, from: relative(ROOT, importer), imports: relative(ROOT, groundModule) });
    }
  }

  // Law 3 — only an allowlisted surface may import the seam, and no writer may.
  for (const importer of directImporters(graph, seam)) {
    if (writerSet.has(importer)) {
      violations.push({ law: 3, from: relative(ROOT, importer), imports: relative(ROOT, seam), writer: true });
    } else if (!allowlistSet.has(importer)) {
      violations.push({ law: 3, from: relative(ROOT, importer), imports: relative(ROOT, seam) });
    }
  }

  return violations.sort((a, b) => (a.law - b.law) || a.from.localeCompare(b.from));
};

const abs = (name) => resolvePath(ROOT, name);
const boundarySets = () => ({
  groundModules: K1_GROUND_MODULES.map(abs),
  seam: abs(K1_SEAM),
  writers: LEDGER_WRITERS.map(abs),
  surfaceAllowlist: K1_ANSWER_SURFACE_ALLOWLIST.map(abs)
});

// ── The tests ───────────────────────────────────────────────────────────────

test('every named module exists (no list can silently empty itself)', () => {
  for (const name of [...LEDGER_WRITERS, ...K1_GROUND_MODULES, K1_SEAM, ...K1_ANSWER_SURFACE_ALLOWLIST]) {
    assert.doesNotThrow(() => statSync(abs(name)),
      `${name} is named by this test but is not in the tree — rename it here in the same commit`);
  }
});

test('the grounding path cannot post, only the seam grounds, only named surfaces ground', () => {
  const graph = buildGraph();
  const violations = findBoundaryViolations(graph, boundarySets());
  assert.deepEqual(violations, [],
    'K1 GROUNDS answers; packs and modules GOVERN actions. The grounding path must reach no '
    + 'writer, only the answer seam may read K1 internals, and only an allowlisted surface may '
    + 'import the seam.');
});

test('NOT vacuous — law 1: a ground module that reaches a writer is caught', () => {
  const graph = buildGraph();
  const sets = boundarySets();
  // Plant the exact mistake the rail prevents: a K1 read that also posts.
  graph.set(abs('knowledgeRetrieval.js'), new Set([...(graph.get(abs('knowledgeRetrieval.js')) || []), abs('ledger.js')]));
  const violations = findBoundaryViolations(graph, sets);
  assert.ok(violations.some((v) => v.law === 1 && v.from === 'knowledgeRetrieval.js' && v.reaches === 'ledger.js'),
    'a K1 ground module reaching a ledger writer must be a law-1 violation');
});

test('NOT vacuous — law 1 catches an INDIRECT edge to a writer', () => {
  const graph = buildGraph();
  const sets = boundarySets();
  const helper = abs('__synthetic_helper.js');
  // The seam gains a helper; the helper posts. Neither file mentions the other's
  // concern — exactly how this gets past review.
  graph.set(abs(K1_SEAM), new Set([...(graph.get(abs(K1_SEAM)) || []), helper]));
  graph.set(helper, new Set([abs('ledgerPostingGateway.js')]));
  const violations = findBoundaryViolations(graph, sets);
  assert.ok(violations.some((v) => v.law === 1 && v.from === K1_SEAM && v.reaches === 'ledgerPostingGateway.js'),
    'a writer reached through a helper is still on the grounding path');
});

test('NOT vacuous — law 2: a non-seam module importing a K1 internal is caught', () => {
  const graph = buildGraph();
  const sets = boundarySets();
  const offender = abs('__synthetic_reader.js');
  graph.set(offender, new Set([abs('knowledgeAnswer.js')]));
  const violations = findBoundaryViolations(graph, sets);
  assert.ok(violations.some((v) => v.law === 2 && v.from === '__synthetic_reader.js' && v.imports === 'knowledgeAnswer.js'),
    'only the seam or another ground module may import a K1 ground module');
});

test('NOT vacuous — law 3: a non-allowlisted surface importing the seam is caught', () => {
  const graph = buildGraph();
  const sets = boundarySets();
  const offender = abs('__synthetic_surface.js');
  graph.set(offender, new Set([abs(K1_SEAM)]));
  const violations = findBoundaryViolations(graph, sets);
  assert.ok(violations.some((v) => v.law === 3 && v.from === '__synthetic_surface.js' && v.imports === K1_SEAM),
    'only an allowlisted surface may import the answer seam');
});

test('NOT vacuous — law 3: a LEDGER WRITER importing the seam is caught as a writer breach', () => {
  const graph = buildGraph();
  const sets = boundarySets();
  graph.set(abs('firmDb.js'), new Set([...(graph.get(abs('firmDb.js')) || []), abs(K1_SEAM)]));
  const violations = findBoundaryViolations(graph, sets);
  assert.ok(violations.some((v) => v.law === 3 && v.from === 'firmDb.js' && v.writer === true),
    'a ledger writer importing the seam is the sharpest breach of the boundary');
});

test('the import graph is real — it found the seam and the strategy edges', () => {
  // Guards the whole file against a silent parser failure: if IMPORT_RE stopped
  // matching, every assertion above would pass by finding nothing at all.
  const graph = buildGraph();
  const seam = graph.get(abs(K1_SEAM));
  assert.ok(seam, 'the answer seam is missing from the graph');
  assert.ok(seam.has(abs('knowledgeRetrieval.js')), 'the seam imports knowledgeRetrieval.js — if this edge is missing the parser is broken');
  assert.ok(seam.has(abs('knowledgeAnswer.js')), 'the seam imports knowledgeAnswer.js');

  const strategy = graph.get(abs('knowledgeRetrieval.js'));
  assert.ok(strategy && strategy.has(abs('knowledgeBase.js')), 'knowledgeRetrieval.js imports knowledgeBase.js — parser check');

  const gateway = graph.get(abs('ledgerPostingGateway.js'));
  assert.ok(gateway && gateway.size > 0, 'the posting gateway resolved no imports — parser broken');

  // And the wiring is REAL: an allowlisted surface actually imports the seam.
  assert.ok(graph.get(abs('clientPortalTurn.js'))?.has(abs(K1_SEAM)),
    'clientPortalTurn.js must import the seam — the allowlist is not hypothetical');
});
