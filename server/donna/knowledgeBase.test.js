// Donna — K1 contract tests (slice K1-1). Load-bearing properties:
//   - the no-tenant-identifier refusal fires on keys AND id-shaped values, and
//     does NOT fire on ordinary prose (a false positive would make legitimate
//     passages uncurable)
//   - grounding is checkable: excerpt + anchor + proposition all required
//   - the effective window is a HARD filter, evaluated against the DECISION date
//   - staleness is risk-classed: stale exact values are withheld, stale
//     explanations are served with the staleness stated
//   - a passage may narrow its source's window, never widen it
//   - a refused draft produces NO record (never a half-validated one)

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  KNOWLEDGE_JURISDICTIONS,
  KNOWLEDGE_AUTHORITY_CLASSES,
  KNOWLEDGE_TOPICS,
  KNOWLEDGE_ANSWER_SHAPES,
  EXACT_VALUE_ANSWER_SHAPES,
  authorityRank,
  findTenantIdentifiers,
  knowledgeSourceId,
  knowledgePassageId,
  knowledgeContentFingerprint,
  validateKnowledgeSourceDraft,
  validateKnowledgePassageDraft,
  passageIsEffectiveAt,
  sourceIsStaleAt,
  passageRetrievability
} from './knowledgeBase.js';

const baseSource = (overrides = {}) => ({
  authority: 'Verohallinto',
  authority_class: 'tax_authority_guidance',
  jurisdiction: 'FI',
  title: 'Arvonlisäverotus — yleistä',
  citation: 'VH/1234/00.01.00/2026',
  source_url: 'https://www.vero.fi/example',
  language: 'fi',
  as_of: '2026-07-29T00:00:00.000Z',
  effective_from: '2026-01-01T00:00:00.000Z',
  confirmed_against_primary: true,
  ...overrides
});

const basePassage = (overrides = {}) => ({
  source_id: 'ksrc-abc',
  jurisdiction: 'FI',
  topic: 'vat_rates',
  question_forms: ['what is the VAT rate', 'paljonko on alv'],
  source_excerpt: 'Yleinen arvonlisäverokanta on 25,5 prosenttia.',
  source_anchor: '§ 84',
  curated_proposition: 'The standard Finnish VAT rate is 25.5%.',
  answer_shape: 'rate',
  ...overrides
});

// ─── Law 1: the no-tenant-identifier refusal ────────────────────────────────

await test('tenant identifier: refuses forbidden KEYS at any depth', () => {
  assert.deepEqual(findTenantIdentifiers({ client_id: 'x' }).map((h) => h.path), ['client_id']);
  assert.deepEqual(findTenantIdentifiers({ firm_id: 'x' }).map((h) => h.path), ['firm_id']);
  // Nested and inside arrays — the scan is recursive, not top-level.
  assert.deepEqual(
    findTenantIdentifiers({ provenance: { partyRef: 'x' } }).map((h) => h.path),
    ['provenance.partyRef']
  );
  assert.deepEqual(
    findTenantIdentifiers({ notes: [{ counterparty_id: 'x' }] }).map((h) => h.path),
    ['notes[0].counterparty_id']
  );
});

await test('tenant identifier: refuses MACHINE-id-shaped VALUES', () => {
  // A digit in the tail, or an underscore separator — identifier syntax.
  for (const [value, token] of [
    ['checked against firm-abc123 books', 'firm-abc123'],
    ['see client_acme prior treatment', 'client_acme'],
    ['imported for tenant-7f3a2b', 'tenant-7f3a2b']
  ]) {
    const hits = findTenantIdentifiers({ verification_note: value });
    assert.equal(hits.length, 1, value);
    assert.equal(hits[0].reason, 'tenant_identifier_value');
    assert.equal(hits[0].token, token);
  }
});

// The false-positive half, and it is as load-bearing as the refusal itself: a
// scan that fired on ordinary curated text would make legitimate passages
// impossible to load, which is a worse failure than the one it guards. Real
// English and real official URLs are full of hyphenated compounds.
await test('tenant identifier: does NOT fire on ordinary prose or official URLs', () => {
  for (const prose of [
    'A client must retain accounting records for six years.',
    'Each party to the contract keeps its own copy.',
    'The customer is liable for the tax where the reverse charge applies.',
    'Identifier requirements for a valid VAT invoice are listed below.',
    'Vendor invoices must show the supplier VAT number.',
    // Hyphenated English compounds — a bare hyphen + word is not an identifier.
    'Client-facing supplies are treated the same as customer-owned goods.',
    'A party-appointed representative may sign the return.'
  ]) {
    assert.deepEqual(findTenantIdentifiers({ curated_proposition: prose }), [], prose);
  }

  // Official document addresses are exempt: gov.uk and vero.fi paths are
  // exactly where these words legitimately live.
  assert.deepEqual(
    findTenantIdentifiers({ source_url: 'https://www.gov.uk/guidance/vat-rules/customer-liability-2026' }),
    [],
    'a gov.uk path is never a tenant identifier'
  );
  // …but the exemption is scoped to the URL field, not global.
  assert.equal(
    findTenantIdentifiers({ curated_proposition: 'see customer-liability-2026 in the ledger' }).length,
    1,
    'the same token in prose still fires'
  );
});

await test('tenant identifier: a source draft carrying one is REFUSED with no record', () => {
  const { record, errors } = validateKnowledgeSourceDraft({
    source: baseSource({ client_id: 'client-acme' })
  });
  assert.equal(record, null, 'refused drafts produce NO record');
  assert.ok(errors.some((e) => e.includes('K1 is global and carries no tenant identifier')));
});

await test('tenant identifier: a passage draft carrying one is REFUSED with no record', () => {
  const { record, errors } = validateKnowledgePassageDraft({
    passage: basePassage({ caveats: 'see firm-abc123 prior treatment' })
  });
  assert.equal(record, null);
  assert.ok(errors.some((e) => e.includes('tenant_identifier_value')));
});

// ─── Vocabularies + ranking ─────────────────────────────────────────────────

await test('authority ranks: statute outranks guidance outranks professional body', () => {
  assert.ok(authorityRank('statute') < authorityRank('tax_authority_guidance'));
  assert.ok(authorityRank('tax_authority_guidance') < authorityRank('regulator_guidance'));
  assert.ok(authorityRank('regulator_guidance') < authorityRank('professional_body'));
  // Unknown sorts last rather than throwing — ranking is never the thing that explodes.
  assert.ok(authorityRank('rumour') > authorityRank('professional_body'));
});

await test('vocabularies are closed and match the design', () => {
  assert.deepEqual([...KNOWLEDGE_JURISDICTIONS], ['FI', 'GB']);
  assert.equal(KNOWLEDGE_TOPICS.length, 13);
  assert.ok(KNOWLEDGE_TOPICS.includes('reverse_charge'));
  assert.deepEqual([...EXACT_VALUE_ANSWER_SHAPES], ['rate', 'threshold']);
  for (const shape of EXACT_VALUE_ANSWER_SHAPES) assert.ok(KNOWLEDGE_ANSWER_SHAPES.includes(shape));
  for (const cls of KNOWLEDGE_AUTHORITY_CLASSES) assert.equal(typeof cls, 'string');
});

// ─── Validation ─────────────────────────────────────────────────────────────

await test('source: a valid draft validates and mints a deterministic id', () => {
  const { record, errors } = validateKnowledgeSourceDraft({ source: baseSource() });
  assert.deepEqual(errors, []);
  assert.match(record.id, /^ksrc-[0-9a-f]{24}$/);
  assert.equal(record.status, 'draft', 'a loader may never mint an ACTIVE source');
  // Same document re-curated ⇒ same id ⇒ the loader is idempotent.
  const again = validateKnowledgeSourceDraft({ source: baseSource() });
  assert.equal(again.record.id, record.id);
  // A different effective_from is a different version of the document.
  const later = validateKnowledgeSourceDraft({
    source: baseSource({ effective_from: '2027-01-01T00:00:00.000Z' })
  });
  assert.notEqual(later.record.id, record.id);
});

await test('source: unconfirmed is permitted but never silent', () => {
  const bare = validateKnowledgeSourceDraft({
    source: baseSource({ confirmed_against_primary: false, verification_note: null })
  });
  assert.equal(bare.record, null);
  assert.ok(bare.errors.some((e) => e.startsWith('verification_note:')));

  const honest = validateKnowledgeSourceDraft({
    source: baseSource({
      confirmed_against_primary: false,
      verification_note: 'gov.uk 403s through the egress proxy; pending a network-open curation session'
    })
  });
  assert.deepEqual(honest.errors, []);
  assert.equal(honest.record.confirmed_against_primary, false);
});

await test('source: a loader cannot mint an active row', () => {
  const { record, errors } = validateKnowledgeSourceDraft({ source: baseSource({ status: 'active' }) });
  assert.equal(record, null);
  assert.ok(errors.some((e) => e.startsWith('status:')));
});

await test('source: an inverted effective window is refused', () => {
  const { record, errors } = validateKnowledgeSourceDraft({
    source: baseSource({ effective_from: '2026-06-01T00:00:00.000Z', effective_until: '2026-01-01T00:00:00.000Z' })
  });
  assert.equal(record, null);
  assert.ok(errors.some((e) => e.includes('must be after effective_from')));
});

await test('passage: grounding is checkable — excerpt, anchor and proposition all required', () => {
  for (const missing of ['source_excerpt', 'source_anchor', 'curated_proposition']) {
    const { record, errors } = validateKnowledgePassageDraft({ passage: basePassage({ [missing]: null }) });
    assert.equal(record, null, `${missing} is required`);
    assert.ok(errors.some((e) => e.startsWith(`${missing}:`)));
  }
});

await test('passage: question_forms must be a non-empty array of non-empty strings', () => {
  for (const bad of [[], null, 'what is the rate', ['']]) {
    const { record } = validateKnowledgePassageDraft({ passage: basePassage({ question_forms: bad }) });
    assert.equal(record, null, JSON.stringify(bad));
  }
});

await test('passage: may NARROW its source window, never widen it', () => {
  const source = {
    jurisdiction: 'FI',
    effective_from: '2026-01-01T00:00:00.000Z',
    effective_until: '2027-01-01T00:00:00.000Z'
  };

  const narrowed = validateKnowledgePassageDraft({
    passage: basePassage({ effective_from: '2026-03-01T00:00:00.000Z' }),
    source
  });
  assert.deepEqual(narrowed.errors, []);
  assert.equal(narrowed.record.effective_from, '2026-03-01T00:00:00.000Z');
  assert.equal(narrowed.record.effective_until, '2027-01-01T00:00:00.000Z', 'inherits the source close');

  const widened = validateKnowledgePassageDraft({
    passage: basePassage({ effective_from: '2025-01-01T00:00:00.000Z' }),
    source
  });
  assert.equal(widened.record, null);
  assert.ok(widened.errors.some((e) => e.includes('never widen it')));

  const outlived = validateKnowledgePassageDraft({
    passage: basePassage({ effective_until: '2030-01-01T00:00:00.000Z' }),
    source
  });
  assert.equal(outlived.record, null);
});

await test('passage: jurisdiction must match its source (never a GB answer from an FI source)', () => {
  const { record, errors } = validateKnowledgePassageDraft({
    passage: basePassage({ jurisdiction: 'GB' }),
    source: { jurisdiction: 'FI' }
  });
  assert.equal(record, null);
  assert.ok(errors.some((e) => e.includes('must match its source')));
});

await test('fingerprint: content changes move it, id-stable metadata does not', () => {
  const a = knowledgeContentFingerprint(basePassage());
  assert.equal(a, knowledgeContentFingerprint(basePassage()), 'stable');
  // Order of question_forms is not content.
  assert.equal(
    a,
    knowledgeContentFingerprint(basePassage({ question_forms: ['paljonko on alv', 'what is the VAT rate'] })),
    'question_forms order is not content'
  );
  assert.notEqual(a, knowledgeContentFingerprint(basePassage({ curated_proposition: 'changed' })));
  assert.notEqual(a, knowledgeContentFingerprint(basePassage({ source_excerpt: 'changed' })));
});

await test('passage ids are deterministic per (source, topic, anchor)', () => {
  const id = knowledgePassageId({ source_id: 'ksrc-a', topic: 'vat_rates', source_anchor: '§ 84' });
  assert.match(id, /^kpsg-[0-9a-f]{24}$/);
  assert.equal(id, knowledgePassageId({ source_id: 'ksrc-a', topic: 'vat_rates', source_anchor: '§ 84' }));
  assert.notEqual(id, knowledgePassageId({ source_id: 'ksrc-a', topic: 'vat_rates', source_anchor: '§ 85' }));
  assert.notEqual(knowledgeSourceId({ jurisdiction: 'FI', citation: 'x' }), knowledgeSourceId({ jurisdiction: 'GB', citation: 'x' }));
});

// ─── Law 3: the effective window is a HARD filter, on the DECISION date ─────

await test('effective window: a passage outside it is not effective, at either edge', () => {
  const passage = {
    effective_from: '2026-01-01T00:00:00.000Z',
    effective_until: '2027-01-01T00:00:00.000Z'
  };
  assert.equal(passageIsEffectiveAt(passage, new Date('2026-06-01T00:00:00.000Z')), true);
  assert.equal(passageIsEffectiveAt(passage, new Date('2025-12-31T23:59:59.000Z')), false);
  // The close is exclusive: the instant a rule stops applying, it stops.
  assert.equal(passageIsEffectiveAt(passage, new Date('2027-01-01T00:00:00.000Z')), false);
  // An open-ended passage stays effective.
  assert.equal(passageIsEffectiveAt({ effective_from: '2026-01-01T00:00:00.000Z' }, new Date('2030-01-01T00:00:00.000Z')), true);
});

await test('effective window: a 2026 question about a 2024 transaction gets the 2024 rule', () => {
  const rule2024 = { effective_from: '2024-01-01T00:00:00.000Z', effective_until: '2025-01-01T00:00:00.000Z' };
  const rule2026 = { effective_from: '2026-01-01T00:00:00.000Z' };
  const decisionDate = new Date('2024-06-01T00:00:00.000Z');

  assert.equal(passageIsEffectiveAt(rule2024, decisionDate), true, 'the rule that applied then');
  assert.equal(passageIsEffectiveAt(rule2026, decisionDate), false, "today's rule does not reach back");
});

// ─── Law 4: staleness is risk-classed ───────────────────────────────────────

await test('staleness: measured against now, and a source with no review date is never stale', () => {
  const now = new Date('2026-07-29T00:00:00.000Z');
  assert.equal(sourceIsStaleAt({ review_due_at: '2026-01-01T00:00:00.000Z' }, now), true);
  assert.equal(sourceIsStaleAt({ review_due_at: '2027-01-01T00:00:00.000Z' }, now), false);
  assert.equal(sourceIsStaleAt({}, now), false);
});

await test('retrievability: a stale EXACT VALUE is withheld; a stale explanation is served with the staleness stated', () => {
  const now = new Date('2026-07-29T00:00:00.000Z');
  const staleSource = { status: 'active', review_due_at: '2026-01-01T00:00:00.000Z' };
  const freshSource = { status: 'active', review_due_at: '2027-01-01T00:00:00.000Z' };
  const active = (shape) => ({ status: 'active', answer_shape: shape, effective_from: '2026-01-01T00:00:00.000Z' });

  for (const shape of ['rate', 'threshold']) {
    const verdict = passageRetrievability({ passage: active(shape), source: staleSource, at: now, now });
    assert.equal(verdict.retrievable, false, `${shape} withheld when stale`);
    assert.equal(verdict.reason, 'stale_exact_value');
  }

  for (const shape of ['rule', 'procedure', 'definition']) {
    const verdict = passageRetrievability({ passage: active(shape), source: staleSource, at: now, now });
    assert.equal(verdict.retrievable, true, `${shape} still served when stale`);
    assert.equal(verdict.staleness, 'stale', 'and the answer must say so');
  }

  const fresh = passageRetrievability({ passage: active('rate'), source: freshSource, at: now, now });
  assert.equal(fresh.retrievable, true);
  assert.equal(fresh.staleness, 'fresh');
});

await test('retrievability: only ACTIVE rows are ever retrieved, and the reason says which', () => {
  const now = new Date('2026-07-29T00:00:00.000Z');
  const source = { status: 'active' };
  for (const status of ['draft', 'pending_review', 'superseded', 'withdrawn']) {
    const verdict = passageRetrievability({ passage: { status, answer_shape: 'rule' }, source, at: now, now });
    assert.equal(verdict.retrievable, false, status);
    assert.equal(verdict.reason, `passage_status_${status}`);
  }
  // A withdrawn SOURCE takes its active passages out of retrieval too.
  const orphan = passageRetrievability({
    passage: { status: 'active', answer_shape: 'rule' },
    source: { status: 'withdrawn' },
    at: now,
    now
  });
  assert.equal(orphan.retrievable, false);
  assert.equal(orphan.reason, 'source_status_withdrawn');
});

await test('retrievability: outside the window is withheld even when everything else is perfect', () => {
  const now = new Date('2026-07-29T00:00:00.000Z');
  const verdict = passageRetrievability({
    passage: { status: 'active', answer_shape: 'rule', effective_until: '2026-01-01T00:00:00.000Z' },
    source: { status: 'active' },
    at: now,
    now
  });
  assert.equal(verdict.retrievable, false);
  assert.equal(verdict.reason, 'outside_effective_window');
});
