// Donna — K1, the sourced knowledge base: the RUNTIME READ over migration 109
// (docs/design-donna-knowledge-base.md §9; slice K1-4). The strategy is
// knowledgeRetrieval.js; the contract layer is knowledgeBase.js.
//
// WHY THIS IS A SEPARATE FILE FROM knowledgeBaseDb.js. That module is the
// CURATION LOADER and says so in its own header — "nothing in the request path
// calls them". This one is the opposite: it is the only K1 read a request path
// may make, and it is read-only by construction. Keeping them apart is what
// stops a request path acquiring a writer by import proximity.
//
// THE DISCIPLINE:
//
//   - READ-ONLY, STRUCTURALLY. There is no insert, update, delete or `begin` in
//     this file, and knowledgeRetrievalDb.test.js pins that by reading it. A
//     retrieval that could mutate the corpus it cites is a corpus that can be
//     rewritten by the act of being read.
//
//   - JURISDICTION IS FILTERED IN SQL AND VALIDATED BEFORE IT (design §9, law
//     1). The parameter is checked against the closed vocabulary before any
//     query runs, so an unexpected value refuses here rather than returning an
//     empty set that reads downstream as "the corpus has nothing on this".
//     Those two outcomes mean completely different things to an owner.
//
//   - ONLY 'active' ROWS, ON BOTH SIDES OF THE JOIN. A passage under a source
//     that is draft, superseded or withdrawn is not grounding — it is a row
//     mid-curation. The join enforces it; the strategy re-applies it anyway.
//
//   - THE WINDOW AND STALENESS RULES ARE NOT APPLIED HERE. They are decided by
//     knowledgeBase.js's `passageRetrievability`, in the strategy, against the
//     DECISION DATE and NOW respectively — one implementation, one place. This
//     read deliberately returns in- and out-of-window rows so the strategy can
//     record WHY a row was withheld; a SQL-level window filter would erase the
//     difference between "no such rule" and "that rule did not apply on the
//     transaction date", which is the difference between a refusal and a good
//     answer.
//
//   - NO TENANT PARAMETER, EVER (design §3). This read takes a jurisdiction and
//     an optional topic list. It has no firm, no client, and no way to accept
//     one — K1's owning scope is the platform.

import { KNOWLEDGE_JURISDICTIONS, KNOWLEDGE_TOPICS } from './knowledgeBase.js';

// THE CANDIDATE QUERY IS WRITTEN INLINE at the `client.query(` callsite below,
// not hoisted into a named const. That is deliberate and it was measured, not
// assumed: sqlWriterLint only reads SQL written AT the callsite, so hoisting it
// silently opts the query out of the one check that catches the `column "X"
// does not exist` class of bug. Planting a bogus column into a hoisted version
// left the sweep green — a green sweep over a query the linter never read is
// worth nothing. Every reference is alias-qualified so the linter validates all
// of them against migration 109's real column set, and the columns are listed
// explicitly rather than `select *` so a future migration adding one cannot
// silently widen what reaches a prompt.

// Reshape into the { passage, source } pair the strategy's predicates expect.
// The two halves stay separate all the way down: `passageRetrievability` takes
// both and evaluates different rules against each.
const toCandidate = (row) => ({
  passage: {
    id: row.passage_id,
    source_id: row.passage_source_id,
    jurisdiction: row.passage_jurisdiction,
    topic: row.topic,
    question_forms: Array.isArray(row.question_forms)
      ? row.question_forms
      : (typeof row.question_forms === 'string' ? JSON.parse(row.question_forms) : []),
    source_excerpt: row.source_excerpt,
    source_anchor: row.source_anchor,
    curated_proposition: row.curated_proposition,
    answer_shape: row.answer_shape,
    caveats: row.caveats,
    effective_from: row.passage_effective_from,
    effective_until: row.passage_effective_until,
    status: row.passage_status
  },
  source: {
    id: row.source_row_id,
    authority: row.authority,
    authority_class: row.authority_class,
    jurisdiction: row.source_jurisdiction,
    title: row.title,
    citation: row.citation,
    source_url: row.source_url,
    content_hash: row.content_hash,
    snapshot_ref: row.snapshot_ref,
    language: row.language,
    translation_status: row.translation_status,
    published_at: row.published_at,
    effective_from: row.source_effective_from,
    effective_until: row.source_effective_until,
    as_of: row.as_of,
    review_due_at: row.review_due_at,
    confirmed_against_primary: row.confirmed_against_primary === true,
    verification_note: row.verification_note,
    status: row.source_status
  }
});

// Throws on an unknown jurisdiction rather than returning []. See the header:
// an empty result and a rejected filter are different facts, and only one of
// them means "we have nothing on this".
export const loadKnowledgeCandidates = async (client, { jurisdiction, topics = [] } = {}) => {
  if (!KNOWLEDGE_JURISDICTIONS.includes(jurisdiction)) {
    throw new Error(`knowledge retrieval: jurisdiction "${jurisdiction}" is outside the curated corpus (${KNOWLEDGE_JURISDICTIONS.join(', ')})`);
  }
  // An unrecognised topic is dropped rather than throwing: topics are an
  // optional narrowing hint from an upstream classifier, and a hint the
  // vocabulary does not know should degrade to "no narrowing", not to a refusal
  // of an otherwise answerable question.
  const known = (Array.isArray(topics) ? topics : []).filter((t) => KNOWLEDGE_TOPICS.includes(t));
  const topicParam = known.length > 0 ? JSON.stringify(known) : null;

  const { rows } = await client.query(`
  select p.id                              as passage_id,
         p.source_id                       as passage_source_id,
         p.jurisdiction                    as passage_jurisdiction,
         p.topic                           as topic,
         p.question_forms                  as question_forms,
         p.source_excerpt                  as source_excerpt,
         p.source_anchor                   as source_anchor,
         p.curated_proposition             as curated_proposition,
         p.answer_shape                    as answer_shape,
         p.caveats                         as caveats,
         p.effective_from                  as passage_effective_from,
         p.effective_until                 as passage_effective_until,
         p.status                          as passage_status,
         s.id                              as source_row_id,
         s.authority                       as authority,
         s.authority_class                 as authority_class,
         s.jurisdiction                    as source_jurisdiction,
         s.title                           as title,
         s.citation                        as citation,
         s.source_url                      as source_url,
         s.content_hash                    as content_hash,
         s.snapshot_ref                    as snapshot_ref,
         s.language                        as language,
         s.translation_status              as translation_status,
         s.published_at                    as published_at,
         s.effective_from                  as source_effective_from,
         s.effective_until                 as source_effective_until,
         s.as_of                           as as_of,
         s.review_due_at                   as review_due_at,
         s.confirmed_against_primary       as confirmed_against_primary,
         s.verification_note               as verification_note,
         s.status                          as source_status
    from knowledge_passages p
    join knowledge_sources s on s.id = p.source_id
   where p.status = 'active'
     and s.status = 'active'
     and p.jurisdiction = $1
     and s.jurisdiction = $1
     and ($2::jsonb is null or p.topic in (select jsonb_array_elements_text($2::jsonb)))
   order by p.topic asc, p.id asc
  `, [jurisdiction, topicParam]);
  return (rows || []).map(toCandidate);
};

// The dependency the strategy injects. Bound to a client here so the strategy
// itself stays free of SQL and testable without a database.
export const knowledgeCandidateLoader = (client) =>
  ({ jurisdiction, topics }) => loadKnowledgeCandidates(client, { jurisdiction, topics });
