// Tests for the accounting mutation registry (Slice A). Pure, no DB. The registry is
// a verified inventory of every chat/drawer verb that mutates bookkeeping state; these
// tests keep it honest and make it FAIL the moment a chat surface adds an appliable
// verb without a registry entry (so the map can't silently drift).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  ACCOUNTING_MUTATION_REGISTRY,
  KNOWN_WRITERS,
  AUTONOMY_CLASSES,
  CONVERGENCE_IMPACTS,
  ACTOR_STATUSES,
  PRESENCE_STATES,
  RECEIPT_STATES,
  REVERSIBILITY_CLASSES,
  registryVerbs,
  findMutationEntry,
  accountingMutationVerbs,
  mutationCoverageGaps
} from './accountingMutationRegistry.js';

import { FEED_CHAT_ALL_APPLIABLE_ACTION_TYPES } from './feedChat.js';
import { TRANSACTION_CHAT_ALL_APPLIABLE_ACTION_TYPES } from './transactionChat.js';
import { CLIENT_PORTAL_CHAT_APPLIABLE_ACTION_TYPES } from './clientPortalChat.js';
import {
  DOCUMENT_CHAT_APPLIABLE_ACTION_TYPES,
  DOCUMENT_CHAT_ACTION_TYPES
} from './documentChat.js';
import { INVENTORY_EXECUTOR_APPLIABLE_VERBS } from './inventory/postingLog.js';

const uniq = (xs) => [...new Set(xs)];

// The canonical "mutating verbs" set = every appliable+remedial verb across the chat surfaces
// PLUS the privileged inventory EXECUTOR verb(s) (I4·posting P5 — a loop/valuation-driven
// mutation, like reverse_apply, not a chat action-type; inventoried here so INV-1 governs its
// writer and its coverage stays honest). This is the contract the registry must cover exactly.
const ALL_MUTATING_VERBS = uniq([
  ...FEED_CHAT_ALL_APPLIABLE_ACTION_TYPES,
  ...TRANSACTION_CHAT_ALL_APPLIABLE_ACTION_TYPES,
  ...DOCUMENT_CHAT_APPLIABLE_ACTION_TYPES,
  ...CLIENT_PORTAL_CHAT_APPLIABLE_ACTION_TYPES,
  ...INVENTORY_EXECUTOR_APPLIABLE_VERBS
]);

test('coverage: every appliable chat verb has exactly one registry entry', () => {
  const verbs = registryVerbs();
  // no duplicate verb rows
  assert.equal(verbs.length, uniq(verbs).length, 'duplicate verb in registry');
  // every mutating verb is registered
  for (const verb of ALL_MUTATING_VERBS) {
    assert.ok(verbs.includes(verb), `mutating verb "${verb}" has no registry entry`);
  }
  // no phantom registry verb that isn't a real mutating chat verb
  for (const verb of verbs) {
    assert.ok(
      ALL_MUTATING_VERBS.includes(verb),
      `registry verb "${verb}" is not in any chat surface's appliable set`
    );
  }
  // exact set equality (both directions, sorted)
  assert.deepEqual([...verbs].sort(), [...ALL_MUTATING_VERBS].sort());
});

test('every entry routes to a known existing writer (INV-1, no second backend)', () => {
  for (const e of ACCOUNTING_MUTATION_REGISTRY) {
    assert.ok(typeof e.writer === 'string' && e.writer.length > 0, `${e.verb}: missing writer`);
    assert.ok(KNOWN_WRITERS.includes(e.writer), `${e.verb}: writer "${e.writer}" not in KNOWN_WRITERS`);
  }
});

test('every entry declares all fields with valid controlled-vocabulary values', () => {
  for (const e of ACCOUNTING_MUTATION_REGISTRY) {
    assert.ok(Array.isArray(e.surfaces) && e.surfaces.length > 0, `${e.verb}: surfaces`);
    assert.ok(Array.isArray(e.mutates) && e.mutates.length > 0, `${e.verb}: mutates`);
    assert.ok(AUTONOMY_CLASSES.includes(e.autonomyClass), `${e.verb}: autonomyClass`);
    assert.ok(
      e.reversibility === null || REVERSIBILITY_CLASSES.includes(e.reversibility),
      `${e.verb}: reversibility "${e.reversibility}"`
    );
    assert.ok(ACTOR_STATUSES.includes(e.actorStatus), `${e.verb}: actorStatus`);
    assert.ok(PRESENCE_STATES.includes(e.emitsAudit), `${e.verb}: emitsAudit`);
    assert.ok(RECEIPT_STATES.includes(e.emitsApplyReceipt), `${e.verb}: emitsApplyReceipt`);
    assert.ok(RECEIPT_STATES.includes(e.preflightToday), `${e.verb}: preflightToday`);
    assert.ok(
      Array.isArray(e.convergenceImpact) && e.convergenceImpact.length > 0,
      `${e.verb}: convergenceImpact empty`
    );
    for (const impact of e.convergenceImpact) {
      assert.ok(CONVERGENCE_IMPACTS.includes(impact), `${e.verb}: bad convergenceImpact "${impact}"`);
    }
  }
});

test('no anonymous mutation: every mutating verb requires an actor', () => {
  for (const e of ACCOUNTING_MUTATION_REGISTRY) {
    assert.equal(e.requiresActor, true, `${e.verb}: a mutation must require an actor`);
  }
});

test('read-only / proposed-only verbs are NOT registered as mutations', () => {
  // G1(a) (godmode build-spec PR-8) reversed the doc-chat half of this
  // pin ON PURPOSE: draft_evidence_request and mark_immaterial became
  // appliable mutations with registry entries. The verbs below stay
  // genuinely read-only.
  const readOnly = [
    'diagnose',
    'future_action',
    'search_transactions',
    'explain_match_reasoning'
  ];
  const verbs = registryVerbs();
  for (const verb of readOnly) {
    assert.ok(!verbs.includes(verb), `read-only verb "${verb}" must not be in the mutation registry`);
  }
  // sanity: the reversal is real — the two former proposed-only doc verbs
  // are appliable AND registered.
  assert.ok(DOCUMENT_CHAT_APPLIABLE_ACTION_TYPES.includes('mark_immaterial'));
  assert.ok(DOCUMENT_CHAT_APPLIABLE_ACTION_TYPES.includes('draft_evidence_request'));
  assert.ok(verbs.includes('mark_immaterial'));
  assert.ok(verbs.includes('draft_evidence_request'));
  // future_action stays in the vocabulary but never appliable.
  assert.ok(DOCUMENT_CHAT_ACTION_TYPES.includes('future_action'));
  assert.ok(!DOCUMENT_CHAT_APPLIABLE_ACTION_TYPES.includes('future_action'));
});

test('accounting-class verbs affect convergence (terminal or reopen), never workflow_only', () => {
  for (const e of ACCOUNTING_MUTATION_REGISTRY) {
    if (e.autonomyClass !== 'accounting') continue;
    const meaningful = e.convergenceImpact.some((i) =>
      ['auto_reconciled', 'on_owner', 'reopens'].includes(i)
    );
    assert.ok(meaningful, `${e.verb}: an accounting mutation must have a convergence impact`);
  }
});

test('helpers resolve entries and the accounting subset', () => {
  assert.equal(findMutationEntry('apply_category')?.writer, 'updateTransactionReviewItemInDb');
  assert.equal(findMutationEntry('nonexistent_verb'), null);
  const acct = accountingMutationVerbs();
  assert.ok(acct.includes('sync_to_accounting'));
  assert.ok(acct.includes('link_transaction'));
  assert.ok(!acct.includes('leave_review_note')); // workflow-class, not accounting
});

test('no silent mutation: every mutating verb emits an audit row (the #4 audit half)', () => {
  // The remember_merchant mint gap was CLOSED at the writer (saveMerchantRuleForPayload
  // emits client_rule.merchant_rule_saved inside the mint's own transaction) and
  // remember_fact was verified (saveFirmFact emits firm_fact.created on genuine
  // insert). No verb may regress to a silent mint — a new mutating verb ships with
  // its audit emission or this test names it.
  for (const e of ACCOUNTING_MUTATION_REGISTRY) {
    assert.equal(e.emitsAudit, 'yes', `${e.verb}: a mutating verb must emit an audit row`);
  }
});

test('the inventory honestly records current coverage gaps (pins today, updates deliberately)', () => {
  const gaps = mutationCoverageGaps();
  assert.ok(gaps.length > 0, 'expected open coverage gaps today (pre-hardening)');
  // The document-chat actor-attribution gap (pod-safety gap #1) was CLOSED by
  // #724 + the #4 apply spine (gateChatApplyAction attributes the operator and
  // both link routes thread it into the writer) — this assertion was updated
  // deliberately, per its own instruction. No verb may regress to an
  // unattributed actor while requiring one.
  for (const gap of gaps) {
    assert.notEqual(
      gap.actorStatus,
      'open',
      `${gap.verb}: actor attribution regressed to 'open' — the #4 spine threads actorId everywhere`
    );
  }
  // link_transaction remains a gap only for its receipt coverage, not attribution.
  const linkDoc = gaps.find((g) => g.verb === 'link_document');
  assert.ok(linkDoc, 'link_document still lacks a live apply receipt (Slice F remainder)');
  assert.equal(linkDoc.emitsApplyReceipt, 'none');
});
