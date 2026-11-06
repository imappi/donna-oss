// Donna — K1 corpus loader (design-donna-k1-uk-corpus-mvp.md §7 B2).
//
// Takes the committed corpus WORKSHEET (server/donna/knowledge/gbCorpusV1.js)
// and loads the entries the store contract will accept, as `pending_review`
// rows, through the K1-1 curation writers — never around them. Activation
// (reviewKnowledgeSource / reviewKnowledgePassage, with a named reviewer) is
// the curation session's separate act; this loader cannot perform it.
//
// The load REFUSES, entry by entry and by name, everything the worksheet
// cannot honestly provide from an egress-locked terminal: a source without
// `as_of` + `content_hash` + `snapshot_ref` (not yet fetched/snapshotted), a
// passage without its exact `source_excerpt`. Until the network-open curation
// session fills those, this script is a READINESS REPORT — run it with no
// flags to see exactly what the session still owes. That is the D3 split
// working as signed: nothing model-recalled can reach the store.
//
// Usage:
//   node scripts/load_knowledge_corpus.mjs            # readiness report only
//   node scripts/load_knowledge_corpus.mjs --load     # load ready rows (needs DATABASE_URL)

import { GB_CORPUS_V1, GB_CORPUS_REVIEW_DUE } from '../server/donna/knowledge/gbCorpusV1.js';
import { EXACT_VALUE_ANSWER_SHAPES, knowledgeSourceId } from '../server/donna/knowledgeBase.js';
import { loadKnowledgeSource, loadKnowledgePassage } from '../server/donna/knowledgeBaseDb.js';

// D4 (signed): review cadence is risk-classed by answer shape.
export const reviewDueForShape = (shape, reviewDue = GB_CORPUS_REVIEW_DUE) =>
  (EXACT_VALUE_ANSWER_SHAPES.includes(shape) ? reviewDue.exact_value : reviewDue.rule);

// A source's review_due_at is the EARLIEST due date across its passages'
// shapes — a source carrying one exact value re-verifies on the exact-value
// cadence even if its other passages are rules.
export const reviewDueForSource = (sourceKey, passages, reviewDue = GB_CORPUS_REVIEW_DUE) => {
  const shapes = passages.filter((p) => p.source_key === sourceKey).map((p) => p.answer_shape);
  if (shapes.length === 0) return reviewDue.rule;
  const dues = shapes.map((s) => reviewDueForShape(s, reviewDue));
  return dues.sort()[0];
};

// Worksheet source → the draft record the store contract validates. Worksheet-
// only fields (key) are dropped; nothing else is invented.
export const mapWorksheetSource = (ws, passages, reviewDue = GB_CORPUS_REVIEW_DUE) => ({
  authority: ws.authority,
  authority_class: ws.authority_class,
  jurisdiction: ws.jurisdiction,
  language: ws.language,
  title: ws.title,
  source_url: ws.source_url,
  citation: ws.citation ?? null,
  as_of: ws.as_of ?? null,
  content_hash: ws.content_hash ?? null,
  snapshot_ref: ws.snapshot_ref ?? null,
  effective_from: ws.effective_from ?? null,
  effective_until: ws.effective_until ?? null,
  review_due_at: reviewDueForSource(ws.key, passages, reviewDue),
  confirmed_against_primary: ws.confirmed_against_primary === true,
  verification_note: ws.verification_note ?? null,
  status: 'pending_review'
});

// Worksheet passage → the draft record. `draft_proposition` becomes the
// curated_proposition ONLY here, at load time — and load requires the excerpt,
// so a proposition can never enter the store without the excerpt it must be
// checkable against. Worksheet-only fields (spec_question, curation_expected,
// outcome2, refusal_boundary) are deliberately NOT loaded: they are curation
// apparatus, not corpus content.
export const mapWorksheetPassage = (ws, { sourceId }) => ({
  source_id: sourceId,
  jurisdiction: 'GB',
  topic: ws.topic,
  answer_shape: ws.answer_shape,
  source_excerpt: ws.source_excerpt,
  source_anchor: ws.source_anchor,
  curated_proposition: ws.draft_proposition,
  question_forms: [...ws.question_forms],
  caveats: ws.caveats ?? null,
  effective_from: ws.effective_from ?? null,
  effective_until: ws.effective_until ?? null,
  status: 'pending_review'
});

export const sourceReadiness = (ws) => {
  const missing = [];
  if (!ws.as_of) missing.push('as_of');
  if (!ws.content_hash) missing.push('content_hash');
  if (!ws.snapshot_ref) missing.push('snapshot_ref');
  return { ready: missing.length === 0, missing };
};

export const passageReadiness = (ws) => {
  const missing = [];
  if (!ws.source_excerpt) missing.push('source_excerpt');
  return { ready: missing.length === 0, missing };
};

// The full plan for a corpus: per entry — load it, or the NAMED reason it
// rests in the worksheet awaiting the curation session. Pure.
export const planCorpusLoad = (corpus = GB_CORPUS_V1, reviewDue = GB_CORPUS_REVIEW_DUE) => {
  const plan = { sources: [], passages: [] };
  const sourceIdByKey = {};
  for (const ws of corpus.sources) {
    const readiness = sourceReadiness(ws);
    const record = mapWorksheetSource(ws, corpus.passages, reviewDue);
    if (readiness.ready) sourceIdByKey[ws.key] = knowledgeSourceId(record);
    plan.sources.push({ key: ws.key, ready: readiness.ready, missing: readiness.missing, record: readiness.ready ? record : null });
  }
  for (const ws of corpus.passages) {
    const readiness = passageReadiness(ws);
    const sourceId = sourceIdByKey[ws.source_key] ?? null;
    const blocked = !readiness.ready || !sourceId;
    const missing = [...readiness.missing, ...(sourceId ? [] : ['source_not_loadable'])];
    plan.passages.push({
      spec_question: ws.spec_question,
      ready: !blocked,
      missing,
      record: blocked ? null : mapWorksheetPassage(ws, { sourceId })
    });
  }
  return plan;
};

// Execute a plan through the K1-1 writers. `client` is a pg client the caller
// owns. Returns per-entry results; a validation refusal from the contract is
// reported, never swallowed.
export const executeCorpusLoad = async ({ client, plan }) => {
  const results = { sources: [], passages: [] };
  for (const entry of plan.sources) {
    if (!entry.ready) { results.sources.push({ key: entry.key, outcome: 'pending_curation', missing: entry.missing }); continue; }
    const loaded = await loadKnowledgeSource({ client, source: entry.record });
    results.sources.push({ key: entry.key, outcome: loaded.errors?.length ? 'refused' : 'loaded', errors: loaded.errors ?? [], id: loaded.record?.id ?? null });
  }
  for (const entry of plan.passages) {
    if (!entry.ready) { results.passages.push({ spec_question: entry.spec_question, outcome: 'pending_curation', missing: entry.missing }); continue; }
    const loaded = await loadKnowledgePassage({ client, passage: entry.record });
    results.passages.push({ spec_question: entry.spec_question, outcome: loaded.errors?.length ? 'refused' : 'loaded', errors: loaded.errors ?? [], id: loaded.record?.id ?? null });
  }
  return results;
};

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop());

if (isMain) {
  const plan = planCorpusLoad();
  const readySources = plan.sources.filter((s) => s.ready).length;
  const readyPassages = plan.passages.filter((p) => p.ready).length;
  console.log(`K1 corpus ${GB_CORPUS_V1.corpus_version}: ${plan.sources.length} sources (${readySources} ready), ${plan.passages.length} passages (${readyPassages} ready)`);
  for (const s of plan.sources.filter((x) => !x.ready)) console.log(`  source ${s.key}: pending_curation — missing ${s.missing.join(', ')}`);
  for (const p of plan.passages.filter((x) => !x.ready)) console.log(`  passage ${p.spec_question}: pending_curation — missing ${p.missing.join(', ')}`);

  if (process.argv.includes('--load')) {
    if (!process.env.DATABASE_URL) { console.error('DATABASE_URL is required for --load'); process.exit(1); }
    const { default: pg } = await import('pg');
    const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    try {
      const results = await executeCorpusLoad({ client, plan });
      const loaded = [...results.sources, ...results.passages].filter((r) => r.outcome === 'loaded').length;
      const refused = [...results.sources, ...results.passages].filter((r) => r.outcome === 'refused');
      console.log(`loaded ${loaded} rows as pending_review (review + activation is the curation session's act)`);
      for (const r of refused) console.error(`  REFUSED ${r.key || r.spec_question}: ${(r.errors || []).join('; ')}`);
      process.exit(refused.length ? 1 : 0);
    } finally {
      await client.end();
    }
  }
}
