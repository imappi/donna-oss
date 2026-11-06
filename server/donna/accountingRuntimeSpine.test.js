// Slice B contract test — the machine-checkable "no third spine" guard.
//
// The accounting runtime is the ASSEMBLY of the two existing spines (operator
// contract 034 + goal-first 037), never a third structure (plan §2). These tests
// pin that decision so a later slice can't quietly mint a parallel home: the map is
// total, every concept has exactly one home, no two concepts collapse to one home,
// no home declares a spine/migration outside the known substrate, the operator-
// contract concepts reuse the REAL exported schemas (no synonyms), the consequence
// diff and the convergence verdict are complementary-not-competing, and the Slice A
// registry's writers all sit under INV-1.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  RUNTIME_CONCEPTS,
  RUNTIME_SPINES,
  KNOWN_SUBSTRATE_MIGRATIONS,
  WRITERS_GOVERNING_INVARIANT,
  SPINE_MAP,
  COMPLEMENTARY_NOT_COMPETING,
  spineEntryForConcept,
  conceptsForSpine,
  spineHomeKeys,
  spineReconciliationIsTotal,
  registryWritersSitUnderInv1
} from './accountingRuntimeSpine.js';
import {
  PROPOSAL_CARD_SCHEMA,
  CHECK_REPORT_SCHEMA,
  APPLY_RECEIPT_SCHEMA,
  REVIEW_MODES,
  OPERATOR_CONTRACT_INVARIANTS
} from './operatorContract.js';
import { KNOWN_WRITERS, ACCOUNTING_MUTATION_REGISTRY } from './accountingMutationRegistry.js';

// ── Totality: every concept has exactly one home; no home for an unlisted concept ─

test('spine map covers exactly the canonical runtime concepts (totality)', () => {
  const mappedConcepts = SPINE_MAP.map((entry) => entry.concept);
  // Every canonical concept appears exactly once.
  for (const concept of RUNTIME_CONCEPTS) {
    assert.equal(
      mappedConcepts.filter((c) => c === concept).length,
      1,
      `concept "${concept}" must have exactly one home`
    );
  }
  // No home points at a concept outside the canonical list.
  for (const concept of mappedConcepts) {
    assert.ok(RUNTIME_CONCEPTS.includes(concept), `unexpected concept "${concept}" in spine map`);
  }
  assert.equal(SPINE_MAP.length, RUNTIME_CONCEPTS.length);
  assert.equal(spineReconciliationIsTotal(), true);
});

// ── No duplicate / third home: each concept resolves to a distinct persisted home ─

test('no two concepts share a home (no duplicate / third home)', () => {
  const keys = spineHomeKeys();
  assert.equal(new Set(keys).size, keys.length, `duplicate home key(s): ${keys.join(', ')}`);
});

// ── No third spine: every home belongs to the closed spine vocabulary ────────────

test('every home declares a spine from the closed vocabulary (no third spine)', () => {
  const allowedSpines = Object.keys(RUNTIME_SPINES);
  for (const entry of SPINE_MAP) {
    assert.ok(
      allowedSpines.includes(entry.spine),
      `concept "${entry.concept}" declares unknown spine "${entry.spine}"`
    );
  }
  // The two REAL persisted spines must each own at least one concept (they exist and
  // are used), and the assembly introduces no migration outside the known substrate.
  assert.ok(conceptsForSpine('operator_contract').length >= 1);
  assert.ok(conceptsForSpine('goal_first').length >= 1);
  for (const entry of SPINE_MAP) {
    if (entry.migration !== null) {
      assert.ok(
        KNOWN_SUBSTRATE_MIGRATIONS.includes(entry.migration),
        `concept "${entry.concept}" references unknown migration "${entry.migration}" — a third backend`
      );
    }
  }
});

// ── No synonyms: operator-contract concepts reference the REAL exported schemas ───

test('operator-contract homes reuse the real exported schema objects by identity', () => {
  // Identity (===), not deep-equal — proves the spine points AT the contract export,
  // not at a re-declared lookalike (the Phase-0 "do not mint synonyms" rule).
  assert.equal(spineEntryForConcept('typed_proposal').contractObject, PROPOSAL_CARD_SCHEMA);
  assert.equal(spineEntryForConcept('deterministic_checks').contractObject, CHECK_REPORT_SCHEMA);
  assert.equal(spineEntryForConcept('consequence_diff').contractObject, APPLY_RECEIPT_SCHEMA);
  assert.equal(spineEntryForConcept('authority_envelope').contractObject, REVIEW_MODES);
});

// ── The consequence diff and the convergence verdict are complementary ───────────

test('apply receipt and GoalReport are complementary, not competing', () => {
  const receipt = spineEntryForConcept(COMPLEMENTARY_NOT_COMPETING.receipt_concept);
  const verdict = spineEntryForConcept(COMPLEMENTARY_NOT_COMPETING.verdict_concept);

  // Both exist and are distinct homes on the two different spines.
  assert.ok(receipt && verdict);
  assert.notEqual(receipt.homeKey, verdict.homeKey);
  assert.equal(receipt.spine, 'operator_contract');
  assert.equal(verdict.spine, 'goal_first');

  // They reference each other as complementary — neither is the other's replacement.
  assert.equal(receipt.complementaryWith, 'convergence_verdict');
  assert.equal(verdict.complementaryWith, 'consequence_diff');
  assert.equal(COMPLEMENTARY_NOT_COMPETING.competes, false);

  // The two answer different questions: the receipt is the apply consequence
  // (apply_receipts), the verdict is the case terminal (loop_goal_reports).
  assert.equal(receipt.table, 'apply_receipts');
  assert.equal(verdict.table, 'loop_goal_reports');
});

// ── The Slice A registry's writers all sit under INV-1 ───────────────────────────

test('every registry writer routes to a known writer under INV-1', () => {
  assert.equal(registryWritersSitUnderInv1(), true);
  // INV-1 is a real operator-contract invariant, not an invented id.
  assert.ok(OPERATOR_CONTRACT_INVARIANTS.some((inv) => inv.id === WRITERS_GOVERNING_INVARIANT));
  // Spelled out: no registry verb names a writer outside the INV-1 allowlist.
  for (const entry of ACCOUNTING_MUTATION_REGISTRY) {
    assert.ok(
      KNOWN_WRITERS.includes(entry.writer),
      `registry verb "${entry.verb}" routes to unknown writer "${entry.writer}"`
    );
  }
});

// ── Shape sanity: each entry carries the fields downstream slices read ────────────

test('every spine entry is well-formed', () => {
  for (const entry of SPINE_MAP) {
    assert.equal(typeof entry.concept, 'string');
    assert.equal(typeof entry.spine, 'string');
    assert.equal(typeof entry.module, 'string');
    assert.equal(typeof entry.symbol, 'string');
    assert.equal(typeof entry.homeKey, 'string');
    assert.equal(typeof entry.role, 'string');
    assert.ok('table' in entry);          // null allowed (tableless homes)
    assert.ok('migration' in entry);      // null allowed
    assert.ok('contractObject' in entry); // null allowed (heavy-module homes)
  }
});
