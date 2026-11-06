// The UK corpus worksheet, machine-checked against the signed spec
// (design-donna-k1-uk-corpus-mvp.md, D1–D5) and the store contract:
//
//   1. 32 questions, unique, covering ALL 13 closed topics — no vocabulary
//      extension (D2).
//   2. Worksheet invariants (D3/D5): every excerpt null, every source
//      unfetched (as_of/hash/snapshot null) with confirmed_against_primary
//      false + a verification note — nothing model-recalled is loadable.
//   3. The mapped records carry no tenant identifier, and a fixture-filled
//      version VALIDATES under the store contract — the worksheet is exactly
//      one curation fill-in away from loadable, nothing more.
//   4. D4: review_due_at is risk-classed by shape, exact values earliest.

import test from 'node:test';
import assert from 'node:assert/strict';

import { GB_CORPUS_V1, GB_CORPUS_SOURCES, GB_CORPUS_PASSAGES, GB_CORPUS_REVIEW_DUE } from './gbCorpusV1.js';
import {
  KNOWLEDGE_TOPICS,
  KNOWLEDGE_ANSWER_SHAPES,
  KNOWLEDGE_AUTHORITY_CLASSES,
  EXACT_VALUE_ANSWER_SHAPES,
  findTenantIdentifiers,
  validateKnowledgeSourceDraft,
  validateKnowledgePassageDraft
} from '../knowledgeBase.js';
import {
  mapWorksheetSource,
  mapWorksheetPassage,
  planCorpusLoad,
  reviewDueForShape,
  reviewDueForSource
} from '../../../scripts/load_knowledge_corpus.mjs';

test('32 unique questions covering all 13 closed topics — D2 holds, no vocabulary extension', () => {
  assert.equal(GB_CORPUS_PASSAGES.length, 32);
  const specIds = GB_CORPUS_PASSAGES.map((p) => p.spec_question);
  assert.equal(new Set(specIds).size, 32, 'spec_question ids must be unique');
  const topicsCovered = new Set(GB_CORPUS_PASSAGES.map((p) => p.topic));
  assert.deepEqual([...topicsCovered].sort(), [...KNOWLEDGE_TOPICS].sort(), 'every closed topic is covered and no topic outside the vocabulary appears');
  for (const p of GB_CORPUS_PASSAGES) {
    assert.ok(KNOWLEDGE_ANSWER_SHAPES.includes(p.answer_shape), `${p.spec_question}: shape ${p.answer_shape}`);
    assert.ok(Array.isArray(p.question_forms) && p.question_forms.length >= 2, `${p.spec_question}: owner phrasings`);
    assert.ok(p.question_forms.every((f) => typeof f === 'string' && f.trim()), `${p.spec_question}: non-empty forms`);
    assert.ok(typeof p.draft_proposition === 'string' && p.draft_proposition.trim(), `${p.spec_question}: draft proposition present (a curation target, never rendered)`);
    assert.ok(typeof p.source_anchor === 'string' && p.source_anchor.trim(), `${p.spec_question}: anchor hint for the curator`);
  }
});

test('every passage names a registered source; every source is referenced by at least one passage', () => {
  const keys = new Set(GB_CORPUS_SOURCES.map((s) => s.key));
  assert.equal(keys.size, GB_CORPUS_SOURCES.length, 'source keys unique');
  for (const p of GB_CORPUS_PASSAGES) assert.ok(keys.has(p.source_key), `${p.spec_question}: source ${p.source_key} registered`);
  // A source counts as referenced as a passage's primary OR as a spec-named
  // supporting source — the registry is the curation session's complete fetch
  // list either way, and an unreferenced entry would be silent fetch work.
  const referenced = new Set(GB_CORPUS_PASSAGES.flatMap((p) => [p.source_key, ...(p.supporting_source_keys || [])]));
  for (const p of GB_CORPUS_PASSAGES) {
    for (const k of p.supporting_source_keys || []) assert.ok(keys.has(k), `${p.spec_question}: supporting source ${k} registered`);
  }
  for (const s of GB_CORPUS_SOURCES) assert.ok(referenced.has(s.key), `source ${s.key} is referenced — no orphan sources`);
});

test('worksheet invariants (D3/D5): excerpts null, sources unfetched, honesty note on every source, gov.uk only', () => {
  for (const p of GB_CORPUS_PASSAGES) {
    assert.equal(p.source_excerpt, null, `${p.spec_question}: an excerpt can only be captured in the curation session`);
  }
  for (const s of GB_CORPUS_SOURCES) {
    assert.equal(s.as_of, null, `${s.key}: unfetched`);
    assert.equal(s.content_hash, null, `${s.key}: unhashed`);
    assert.equal(s.snapshot_ref, null, `${s.key}: unsnapshotted`);
    assert.equal(s.confirmed_against_primary, false, `${s.key}: the flip belongs to the curation session`);
    assert.match(s.verification_note || '', /curation session/, `${s.key}: says why it is unverified`);
    assert.match(s.source_url, /^https:\/\/www\.gov\.uk\//, `${s.key}: HMRC/gov.uk named sources only (spec §5)`);
    assert.equal(s.authority_class, 'tax_authority_guidance');
    assert.ok(KNOWLEDGE_AUTHORITY_CLASSES.includes(s.authority_class));
    assert.equal(s.jurisdiction, 'GB');
  }
});

test('the loader plan refuses EVERYTHING today, each entry with its named missing fields — the D3 split is structural', () => {
  const plan = planCorpusLoad(GB_CORPUS_V1);
  assert.equal(plan.sources.filter((s) => s.ready).length, 0);
  assert.equal(plan.passages.filter((p) => p.ready).length, 0);
  for (const s of plan.sources) assert.deepEqual(s.missing, ['as_of', 'content_hash', 'snapshot_ref']);
  for (const p of plan.passages) assert.ok(p.missing.includes('source_excerpt'), `${p.spec_question} waits on its excerpt`);
});

test('D4: review cadence is risk-classed by shape; a mixed source takes the earliest due date', () => {
  assert.equal(reviewDueForShape('rate'), GB_CORPUS_REVIEW_DUE.exact_value);
  assert.equal(reviewDueForShape('threshold'), GB_CORPUS_REVIEW_DUE.exact_value);
  assert.equal(reviewDueForShape('rule'), GB_CORPUS_REVIEW_DUE.rule);
  assert.ok(GB_CORPUS_REVIEW_DUE.exact_value < GB_CORPUS_REVIEW_DUE.rule, 'exact values re-verify first');
  // vat_notice_700 carries rules AND the Q27 procedure — rule cadence; the
  // capital_allowances source carries the Q21 threshold — exact-value cadence.
  assert.equal(reviewDueForSource('capital_allowances', GB_CORPUS_PASSAGES), GB_CORPUS_REVIEW_DUE.exact_value);
  assert.equal(reviewDueForSource('bim_travel', GB_CORPUS_PASSAGES), GB_CORPUS_REVIEW_DUE.rule);
});

test('mapped records carry no tenant identifier — the global-corpus law holds at the exact records the loader would submit', () => {
  for (const ws of GB_CORPUS_SOURCES) {
    const record = mapWorksheetSource(ws, GB_CORPUS_PASSAGES);
    assert.deepEqual(findTenantIdentifiers(record), [], `${ws.key}: tenant-free`);
  }
  for (const ws of GB_CORPUS_PASSAGES) {
    const record = mapWorksheetPassage(ws, { sourceId: 'ksrc-fixture' });
    assert.deepEqual(findTenantIdentifiers(record), [], `${ws.spec_question}: tenant-free`);
  }
});

test('a fixture-filled worksheet VALIDATES under the store contract — one fill-in away from loadable, nothing more', () => {
  for (const ws of GB_CORPUS_SOURCES) {
    const filled = { ...ws, as_of: '2026-08-15T00:00:00.000Z', content_hash: 'sha256:fixture', snapshot_ref: 'snap://fixture' };
    const record = mapWorksheetSource(filled, GB_CORPUS_PASSAGES);
    const { errors } = validateKnowledgeSourceDraft({ source: { ...record, status: 'pending_review' } });
    assert.deepEqual(errors, [], `${ws.key}: ${errors.join(' | ')}`);
  }
  for (const ws of GB_CORPUS_PASSAGES) {
    const filled = { ...ws, source_excerpt: `[fixture excerpt] ${ws.source_anchor}` };
    const record = mapWorksheetPassage(filled, { sourceId: 'ksrc-fixture' });
    const { errors } = validateKnowledgePassageDraft({ passage: record });
    assert.deepEqual(errors, [], `${ws.spec_question}: ${errors.join(' | ')}`);
  }
});

test('outcome-2 variables name their resolve-before-asking home (spec §3) wherever declared', () => {
  const withVariables = GB_CORPUS_PASSAGES.filter((p) => p.outcome2);
  assert.ok(withVariables.length >= 15, 'most questions carry a named business-fact variable');
  for (const p of withVariables) {
    assert.ok(typeof p.outcome2.variable === 'string' && p.outcome2.variable.trim(), `${p.spec_question}: variable`);
    assert.ok(typeof p.outcome2.resolve_from === 'string' && p.outcome2.resolve_from.trim(), `${p.spec_question}: where resolution looks first`);
  }
});
