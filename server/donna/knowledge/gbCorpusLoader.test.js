// The corpus loader (scripts/load_knowledge_corpus.mjs): the D3 split executed
// — unready entries refuse by name; a curation-filled entry loads as
// `pending_review` through the K1-1 writers (never around them), and the
// insert actually RAN (the fake-pool rule: assert the query, not the return).

import test from 'node:test';
import assert from 'node:assert/strict';

import { GB_CORPUS_V1 } from './gbCorpusV1.js';
import {
  planCorpusLoad,
  executeCorpusLoad
} from '../../../scripts/load_knowledge_corpus.mjs';

// Stateful fake: an inserted row is served back to the writer's own
// read-before-write (loadKnowledgePassage verifies its source row exists —
// correct behavior the fake must honour, not stub away).
const fakeClient = () => ({
  queries: [],
  rowsById: {},
  async query(sql, params) {
    this.queries.push({ sql, params });
    const insert = sql.match(/insert into (knowledge_\w+) \(([^)]+)\)/);
    if (insert) {
      const columns = insert[2].split(',').map((c) => c.trim());
      const row = Object.fromEntries(columns.map((c, i) => [c, params[i]]));
      this.rowsById[row.id] = row;
      return { rows: [], rowCount: 1 };
    }
    if (/from knowledge_\w+\s+where id = \$1/.test(sql)) {
      const row = this.rowsById[params[0]];
      return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
    }
    return { rows: [], rowCount: 0 };
  },
  matching(re) { return this.queries.filter((q) => re.test(q.sql)); }
});

// A curation-session simulation: fill exactly what the session captures for
// the first source and its Q1 passage, nothing else.
const filledCorpus = () => {
  const sources = GB_CORPUS_V1.sources.map((s) => (s.key === 'vat_registration_when'
    ? { ...s, as_of: '2026-08-15T00:00:00.000Z', content_hash: 'sha256:fixture-q1', snapshot_ref: 'snap://gb/vat-reg/2026-08-15', confirmed_against_primary: true, verification_note: null }
    : s));
  const passages = GB_CORPUS_V1.passages.map((p) => (p.spec_question === 'Q1'
    ? { ...p, source_excerpt: 'You must register if your total taxable turnover for the last 12 months goes over the threshold. [fixture]' }
    : p));
  return { ...GB_CORPUS_V1, sources, passages };
};

test('unready entries refuse by name; the one filled source + passage become loadable', () => {
  const plan = planCorpusLoad(filledCorpus());
  const readySources = plan.sources.filter((s) => s.ready);
  const readyPassages = plan.passages.filter((p) => p.ready);
  assert.deepEqual(readySources.map((s) => s.key), ['vat_registration_when']);
  assert.deepEqual(readyPassages.map((p) => p.spec_question), ['Q1']);
  assert.equal(readySources[0].record.status, 'pending_review', 'the loader may never set active');
  assert.equal(readyPassages[0].record.status, 'pending_review');
  // A passage whose excerpt exists but whose source is unfetched stays blocked
  // — check the shape of the refusal on an unready sibling.
  const q2 = plan.passages.find((p) => p.spec_question === 'Q2');
  assert.equal(q2.ready, false);
  assert.ok(q2.missing.includes('source_excerpt'));
});

test('executeCorpusLoad writes the ready rows through the writers as pending_review — and the inserts RAN', async () => {
  const client = fakeClient();
  const results = await executeCorpusLoad({ client, plan: planCorpusLoad(filledCorpus()) });
  const loadedSources = results.sources.filter((r) => r.outcome === 'loaded');
  const loadedPassages = results.passages.filter((r) => r.outcome === 'loaded');
  assert.equal(loadedSources.length, 1);
  assert.equal(loadedPassages.length, 1);
  assert.equal(results.sources.filter((r) => r.outcome === 'pending_curation').length, GB_CORPUS_V1.sources.length - 1);
  assert.equal(results.passages.filter((r) => r.outcome === 'pending_curation').length, GB_CORPUS_V1.passages.length - 1);
  assert.equal(results.sources.filter((r) => r.outcome === 'refused').length, 0, JSON.stringify(results.sources.filter((r) => r.outcome === 'refused')));
  assert.equal(results.passages.filter((r) => r.outcome === 'refused').length, 0, JSON.stringify(results.passages.filter((r) => r.outcome === 'refused')));

  const sourceInserts = client.matching(/insert into knowledge_sources/);
  const passageInserts = client.matching(/insert into knowledge_passages/);
  assert.equal(sourceInserts.length, 1, 'the source insert ran');
  assert.equal(passageInserts.length, 1, 'the passage insert ran');
  assert.ok(sourceInserts[0].params.includes('pending_review'));
  assert.ok(passageInserts[0].params.includes('pending_review'));
  assert.ok(!sourceInserts[0].params.includes('active') && !passageInserts[0].params.includes('active'),
    'activation is the reviewer’s separate act; the loader cannot perform it');
});

test('the untouched worksheet loads NOTHING — a dry run today is a pure readiness report', async () => {
  const client = fakeClient();
  const results = await executeCorpusLoad({ client, plan: planCorpusLoad(GB_CORPUS_V1) });
  assert.equal(client.queries.length, 0, 'no DB touch for a fully-unready corpus');
  assert.ok(results.sources.every((r) => r.outcome === 'pending_curation'));
  assert.ok(results.passages.every((r) => r.outcome === 'pending_curation'));
});
