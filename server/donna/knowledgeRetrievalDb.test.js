// Donna — K1-4 runtime-read tests. Load-bearing properties:
//   - the read is READ-ONLY by construction (asserted by reading the file, not
//     by trusting that no test happened to call a writer)
//   - jurisdiction is validated BEFORE any SQL runs, and an unknown one THROWS
//     rather than returning [] — "we have nothing" and "we refused to look" are
//     different facts and an owner deserves the difference
//   - both sides of the join are filtered to 'active'
//   - the window/staleness rules are deliberately NOT applied in SQL
//   - the read takes no tenant parameter and cannot accept one

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadKnowledgeCandidates, knowledgeCandidateLoader } from './knowledgeRetrievalDb.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const moduleSource = readFileSync(resolvePath(__dirname, 'knowledgeRetrievalDb.js'), 'utf8');

// Strip comments before asserting ABSENCE — the header explains the very rules
// below, and a naive scan would be satisfied (or falsely failed) by its own
// prose. This trap has fired twice on this arc.
const codeOnly = moduleSource
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/^\s*\/\/.*$/gm, ' ');

const row = (overrides = {}) => ({
  passage_id: 'kpsg-1',
  passage_source_id: 'ksrc-1',
  passage_jurisdiction: 'FI',
  topic: 'vat_rates',
  question_forms: ['paljonko on alv'],
  source_excerpt: 'Yleinen verokanta on 25,5 prosenttia.',
  source_anchor: '§ 84',
  curated_proposition: 'The standard rate is 25.5%.',
  answer_shape: 'rate',
  caveats: null,
  passage_effective_from: '2026-01-01T00:00:00.000Z',
  passage_effective_until: null,
  passage_status: 'active',
  source_row_id: 'ksrc-1',
  authority: 'Verohallinto',
  authority_class: 'tax_authority_guidance',
  source_jurisdiction: 'FI',
  title: 'Arvonlisäverokannat',
  citation: 'VH/1/2026',
  source_url: 'https://www.vero.fi/example',
  content_hash: 'sha256:abc',
  snapshot_ref: 'snap://fi/1',
  language: 'fi',
  translation_status: 'original',
  published_at: '2026-01-01T00:00:00.000Z',
  source_effective_from: '2026-01-01T00:00:00.000Z',
  source_effective_until: null,
  as_of: '2026-07-01T00:00:00.000Z',
  review_due_at: '2027-01-01T00:00:00.000Z',
  confirmed_against_primary: true,
  verification_note: null,
  source_status: 'active',
  ...overrides
});

const makeMockClient = (rows = []) => {
  const calls = [];
  return {
    calls,
    query: async (sql, params) => {
      calls.push({ sql: String(sql), params });
      return { rows };
    }
  };
};

// ─── Read-only, structurally ────────────────────────────────────────────────

test('the runtime read contains no write of any kind', () => {
  for (const forbidden of [/\binsert\s+into\b/i, /\bupdate\s+\w+\s+set\b/i, /\bdelete\s+from\b/i, /'begin'/i, /\btruncate\b/i]) {
    assert.ok(!forbidden.test(codeOnly),
      `knowledgeRetrievalDb.js must be read-only — found ${forbidden}`);
  }
  // Non-vacuous: the scan finds a write when one is actually present.
  assert.ok(/\binsert\s+into\b/i.test('insert into knowledge_sources (id) values ($1)'),
    'the forbidden-write scan is inert');
});

test('the read takes no tenant parameter and names none', () => {
  for (const forbidden of [/\bfirm_id\b/, /\bclient_id\b/, /\btenant_id\b/]) {
    assert.ok(!forbidden.test(codeOnly),
      `K1's owning scope is the platform — ${forbidden} must not appear in its read`);
  }
});

// ─── Jurisdiction: validated before the query ───────────────────────────────

test('an unknown jurisdiction THROWS before any SQL runs', async () => {
  const client = makeMockClient([row()]);
  await assert.rejects(
    () => loadKnowledgeCandidates(client, { jurisdiction: 'SG' }),
    /outside the curated corpus/
  );
  assert.equal(client.calls.length, 0, 'no query may run for a jurisdiction we have not curated');
});

test('a lowercase or aliased jurisdiction is NOT normalised here — that is the strategy\'s job', async () => {
  const client = makeMockClient([]);
  await assert.rejects(() => loadKnowledgeCandidates(client, { jurisdiction: 'fi' }), /outside the curated corpus/);
  assert.equal(client.calls.length, 0,
    'one normaliser, in one place; a second would be a place for the two to disagree');
});

// ─── The query ──────────────────────────────────────────────────────────────

test('both sides of the join are filtered to active, in the jurisdiction', async () => {
  const client = makeMockClient([row()]);
  await loadKnowledgeCandidates(client, { jurisdiction: 'FI' });

  const sql = client.calls[0].sql.replace(/\s+/g, ' ').toLowerCase();
  assert.match(sql, /p\.status = 'active'/);
  assert.match(sql, /s\.status = 'active'/);
  assert.match(sql, /p\.jurisdiction = \$1/);
  assert.match(sql, /s\.jurisdiction = \$1/);
  assert.deepEqual(client.calls[0].params, ['FI', null]);
});

test('the window and staleness rules are NOT applied in SQL', async () => {
  const client = makeMockClient([row()]);
  await loadKnowledgeCandidates(client, { jurisdiction: 'FI' });
  const sql = client.calls[0].sql.toLowerCase();
  // A SQL-level window filter would erase the difference between "no such rule"
  // and "that rule did not apply on the transaction date" — the difference
  // between a refusal and a good answer.
  assert.ok(!sql.includes('effective_from <'), 'the window is evaluated against the DECISION date, in the strategy');
  assert.ok(!sql.includes('review_due_at <'), 'staleness is evaluated against NOW, in the strategy');
  assert.ok(!sql.includes('now()'), 'the read must not carry a clock of its own');
});

test('topics narrow the query when known, and are dropped when not', async () => {
  const withTopics = makeMockClient([row()]);
  await loadKnowledgeCandidates(withTopics, { jurisdiction: 'FI', topics: ['vat_rates', 'home_office'] });
  assert.deepEqual(withTopics.calls[0].params[1], JSON.stringify(['vat_rates', 'home_office']));

  const unknown = makeMockClient([row()]);
  await loadKnowledgeCandidates(unknown, { jurisdiction: 'FI', topics: ['not_a_topic'] });
  assert.equal(unknown.calls[0].params[1], null,
    'an unrecognised hint degrades to no narrowing, never to a refusal of an answerable question');

  const none = makeMockClient([row()]);
  await loadKnowledgeCandidates(none, { jurisdiction: 'FI' });
  assert.equal(none.calls[0].params[1], null);
});

// ─── Reshaping ──────────────────────────────────────────────────────────────

test('rows reshape into the { passage, source } pair the predicates expect', async () => {
  const client = makeMockClient([row()]);
  const [candidate] = await loadKnowledgeCandidates(client, { jurisdiction: 'FI' });

  assert.equal(candidate.passage.id, 'kpsg-1');
  assert.equal(candidate.passage.answer_shape, 'rate');
  assert.equal(candidate.source.id, 'ksrc-1');
  assert.equal(candidate.source.authority_class, 'tax_authority_guidance');
  assert.equal(candidate.source.confirmed_against_primary, true);
  assert.equal(candidate.source.review_due_at, '2027-01-01T00:00:00.000Z');
  // The two halves stay separate: the predicates evaluate different rules
  // against each.
  assert.equal(candidate.passage.source_excerpt, 'Yleinen verokanta on 25,5 prosenttia.');
  assert.equal(candidate.passage.curated_proposition, 'The standard rate is 25.5%.');
});

test('question_forms survive whether the driver returns jsonb or text', async () => {
  const asArray = makeMockClient([row({ question_forms: ['a', 'b'] })]);
  const [fromArray] = await loadKnowledgeCandidates(asArray, { jurisdiction: 'FI' });
  assert.deepEqual(fromArray.passage.question_forms, ['a', 'b']);

  const asText = makeMockClient([row({ question_forms: '["a","b"]' })]);
  const [fromText] = await loadKnowledgeCandidates(asText, { jurisdiction: 'FI' });
  assert.deepEqual(fromText.passage.question_forms, ['a', 'b']);

  const missing = makeMockClient([row({ question_forms: null })]);
  const [fromNull] = await loadKnowledgeCandidates(missing, { jurisdiction: 'FI' });
  assert.deepEqual(fromNull.passage.question_forms, []);
});

test('the bound loader is the dependency shape the strategy injects', async () => {
  const client = makeMockClient([row()]);
  const loader = knowledgeCandidateLoader(client);
  const out = await loader({ jurisdiction: 'FI', topics: ['vat_rates'] });
  assert.equal(out.length, 1);
  assert.equal(client.calls[0].params[0], 'FI');
});
