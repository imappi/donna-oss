// Donna — K1, the sourced knowledge base: the RETRIEVAL STRATEGY
// (docs/design-donna-knowledge-base.md §9; slice K1-4). Registered as
// `knowledge.retrieve.v1`. The store is migration 109, the contract layer is
// knowledgeBase.js, and the curation writers are knowledgeBaseDb.js.
//
// WHAT THIS IS FOR. Under the 2026-07-23 self-service re-amendment Donna answers
// KNOWLEDGE questions herself (ALV/VAT, capitalize-vs-expense, deductibility)
// instead of deferring them to a human. This module is how she finds something
// true and current to answer FROM. It returns GROUNDING — passages plus their
// provenance plus an honest account of what was withheld and why. It does not
// compose the answer; that is K1-5's four-outcome contract (§6), and the split
// is deliberate: retrieval must not be able to make an answer sound better than
// its sources.
//
// TRUST-THE-STRONG-LLM, THE POSITIVE CASE. Nothing here reasons about tax. The
// model reasons; this module decides — deterministically — which curated rows it
// is allowed to reason from, and records which ones it used. No embedding store,
// no model call, no ranking heuristic that could dress an ungrounded answer up as
// a grounded one.
//
// ── THE SIX LAWS THIS MODULE ENFORCES ───────────────────────────────────────
//
//   1. JURISDICTION IS A HARD FILTER, KEYED ON THE LEGAL ENTITY (§9). Not the
//      tenant, not the user: one owner may hold entities in both markets, so the
//      question "which law applies" is answered by the `clients` row the case
//      belongs to. It is applied BEFORE ranking and is never a ranking signal —
//      a GB question is never answered from an FI passage, at any score. It
//      FAILS CLOSED: `clients.jurisdiction` is nullable and (migration 077's own
//      words) "unreliably set", so an unresolved or out-of-scope jurisdiction is
//      a REFUSAL, never a default and never a silent fallback to the other
//      market.
//
//   2. THE EFFECTIVE WINDOW FILTERS AGAINST THE DECISION DATE (§9). The decision
//      date is the transaction / tax-point date where the question is about one,
//      else today. A 2026 question about a 2024 transaction retrieves 2024's
//      rule, and the receipt says which date was used. Staleness is measured
//      against NOW instead — they are different axes and collapsing them would
//      make a 2024 question silently immune to the staleness rules.
//
//   3. STALENESS IS RISK-CLASSED, AND WITHHOLDING IS VISIBLE (§7). The predicate
//      is knowledgeBase.js's `passageRetrievability` — reused, never
//      re-implemented. What this module adds is that a withheld passage still
//      appears in the receipt with its reason and its source's dates, because
//      that is exactly what outcome 3 (honest partial) needs in order to say
//      "there is a rate here, we last verified it in March, I will not quote it
//      as current". A withheld row that vanished silently would turn an honest
//      partial into a bare refusal.
//
//   4. RANKING IS DETERMINISTIC AND TOTAL (§9). jurisdiction (already filtered)
//      → topic → question_forms lexical match → authority_class → recency →
//      passage id. The final key makes the order total, so the same corpus and
//      the same question always produce the same bundle in the same sequence —
//      a receipt that cannot be reproduced is not a receipt.
//
//   5. CONFLICTS ARE SURFACED, NEVER RESOLVED SILENTLY (§7). Where the ladder
//      picks a winner, the loser is still named in the receipt. See
//      `detectExactValueConflicts` for exactly what this catches and — more
//      importantly — what it does not.
//
//   6. THIS MODULE NEVER AUTHORIZES ANYTHING (§2, GROUND vs GOVERN). It returns
//      prose and provenance. It has no writer, mutates nothing, and no export
//      here may appear in a code path that reaches a ledger writer — machine-
//      checked by knowledgeRetrievalBoundary.test.js, which walks the import
//      graph rather than trusting the convention. A passage that disagrees with
//      a pack is a conflict to SURFACE; the pack remains the single execution
//      authority, and K1 neither overrides it nor blocks it (a veto would be
//      authority).
//
// ── WHY ONE RECEIPT, NOT THE SPLIT RECEIPT memory.retrieve.v2 USES ──────────
//
// The governed memory service splits its receipt in two because its rows are
// tenant-confidential: naming an excluded row would leak its existence to a
// caller not entitled to it. K1 rows are PUBLISHED STATUTE AND OFFICIAL GUIDANCE
// with no tenant and no confidentiality class — there is nothing about a K1 row
// to hide from the person whose question it failed to answer, and the whole
// design turns on the owner being able to see what grounded (or failed to
// ground) an answer. So the receipt is single and complete on purpose. This is a
// deliberate divergence from the sibling strategy, not an omission; if K1 ever
// acquires a non-public source class, it needs the split back.

import { createHash } from 'node:crypto';

import {
  KNOWLEDGE_JURISDICTIONS,
  KNOWLEDGE_TOPICS,
  authorityRank,
  passageRetrievability
} from './knowledgeBase.js';
import { clientFlagActs, clientFlagObserves } from './clientConfig.js';

// ── Service versions (pinned into every receipt) ─────────────────────────────
// Following the MEMORY_RETRIEVAL_*_VERSION convention. A meaning/schema change
// is a NEW capability id (knowledge.retrieve.v2), never an in-place bump here.
export const KNOWLEDGE_RETRIEVAL_SERVICE_VERSION = 'knowret.svc.v1';
export const KNOWLEDGE_RETRIEVAL_POLICY_VERSION = 'knowret.policy.v1';
export const KNOWLEDGE_RETRIEVAL_RANKER_VERSION = 'knowret.rank.v1';
export const KNOWLEDGE_RETRIEVAL_RENDERER_VERSION = 'knowret.render.v1';
// The fifth constant, and it is NOT row-level access control — K1 rows are
// public statute and have none. It versions the LANE gate: purpose ∩ consumer ∩
// audience ∩ flag ∩ jurisdiction-entitlement. Named for parity with the sibling
// strategy so a receipt reader compares like with like; the comment is here so
// nobody mistakes it for a row ACL that does not exist.
export const KNOWLEDGE_RETRIEVAL_ACL_VERSION = 'knowret.lane.v1';

export const KNOWLEDGE_RETRIEVAL_CAPABILITY_ID = 'knowledge.retrieve.v1';

// ── The rollout flag (CLAUDE.md rail: config plane, born off, never an env pair)
export const KNOWLEDGE_BASE_RETRIEVAL_FLAG_KEY = 'KNOWLEDGE_BASE_RETRIEVAL';

// Fully dormant until a DB stage row exists. envFallback () => false means no
// env var can turn this ON — env may only ever KILL a behaviour here.
export const knowledgeBaseRetrievalActs = ({ snapshot = null, env = process.env } = {}) =>
  clientFlagActs({ flagKey: KNOWLEDGE_BASE_RETRIEVAL_FLAG_KEY, snapshot, envFallback: () => false, env });

export const knowledgeBaseRetrievalObserves = ({ snapshot = null, env = process.env } = {}) =>
  clientFlagObserves({ flagKey: KNOWLEDGE_BASE_RETRIEVAL_FLAG_KEY, snapshot, envFallback: () => false, env });

// ── The failure taxonomy ─────────────────────────────────────────────────────
// EVERY non-happy outcome maps to one of these AND to empty grounding. There is
// no laxer path to fall back to: an ungrounded answer is precisely the failure
// mode the design exists to prevent, so a retrieval failure must surface as a
// refusal upstream, never as "answer it from training memory instead".
export const KNOWLEDGE_RETRIEVAL_FAILURES = Object.freeze([
  'invalid_request',
  'unknown_purpose',
  'consumer_not_permitted',
  'audience_not_permitted',
  'retrieval_disabled',
  'jurisdiction_unresolved',
  'jurisdiction_out_of_scope',
  'store_unavailable'
]);

// ── Coverage — a SIGNAL for K1-5, never the outcome itself ───────────────────
// The four outcomes (§6) are the answer contract's to decide, because only it
// can tell whether the passages actually answer THIS question. What retrieval
// can say honestly is how well the corpus covered the ask.
export const KNOWLEDGE_COVERAGE = Object.freeze(['covered', 'adjacent', 'none']);

// ── Purposes (the §5-style registry, K1's own) ───────────────────────────────
// A purpose only NARROWS. Both purposes below read the SAME public corpus — the
// difference is who the output is rendered to and how much of it there is room
// for, not which rows exist.
const PURPOSE_DEFINITIONS = Object.freeze({
  owner_knowledge_answer: {
    purpose_id: 'owner_knowledge_answer',
    purpose_version: 1,
    decision_policy_version: KNOWLEDGE_RETRIEVAL_POLICY_VERSION,
    // The surfaces that already exist (§10 — no new surface).
    allowed_consumer_ids: ['clientPortalChatContext', 'ownerChannelKnowledgeContext'],
    allowed_audience_classes: ['owner'],
    // An owner answer is a short channel message: fewer passages, tighter text.
    default_budget: { max_passages: 4, max_excerpt_chars: 1200 },
    maximum_budget: { max_passages: 8, max_excerpt_chars: 2400 }
  },
  operator_knowledge_answer: {
    purpose_id: 'operator_knowledge_answer',
    purpose_version: 1,
    decision_policy_version: KNOWLEDGE_RETRIEVAL_POLICY_VERSION,
    allowed_consumer_ids: ['adminChatKnowledgeContext'],
    allowed_audience_classes: ['firm_operator'],
    default_budget: { max_passages: 8, max_excerpt_chars: 4000 },
    maximum_budget: { max_passages: 16, max_excerpt_chars: 8000 }
  }
});

const canonicalize = (node) => {
  if (Array.isArray(node)) return node.map(canonicalize);
  if (node && typeof node === 'object') {
    const out = {};
    for (const key of Object.keys(node).sort()) out[key] = canonicalize(node[key]);
    return out;
  }
  return node;
};

const sha = (obj, prefix) => `${prefix}-${createHash('sha256').update(JSON.stringify(canonicalize(obj))).digest('hex')}`;

export const knowledgePurposeRegistryFingerprint = () =>
  sha(Object.values(PURPOSE_DEFINITIONS).map(canonicalize), 'kpurpreg');

export const getKnowledgeRetrievalPurpose = (purposeId) => PURPOSE_DEFINITIONS[purposeId] || null;
export const listKnowledgeRetrievalPurposeIds = () => Object.keys(PURPOSE_DEFINITIONS);

// The idempotent retrieval id — derived ONLY from the request (event, purpose,
// jurisdiction, decision date, versions, config snapshot). It carries no passage
// information, so it is stable across a corpus change and a retry never mints a
// second identity for the same ask.
export const knowledgeRetrievalIdFor = ({
  sourceEventId = null,
  purposeId = null,
  jurisdiction = null,
  decisionDate = null,
  configSnapshotId = null
} = {}) =>
  sha({
    source_event_id: sourceEventId,
    purpose_id: purposeId,
    jurisdiction,
    decision_date: decisionDate,
    service_version: KNOWLEDGE_RETRIEVAL_SERVICE_VERSION,
    policy_version: KNOWLEDGE_RETRIEVAL_POLICY_VERSION,
    config_snapshot_id: configSnapshotId
  }, 'kretr');

// ── Law 1: jurisdiction from the legal entity, failing closed ────────────────
//
// `clients.jurisdiction` is free-form in this tree — 'FI', 'fi', 'GB', 'gb',
// 'UK', 'uk', 'SG', 'US' all occur. Normalising is therefore required, and the
// ONE alias worth encoding is UK → GB: they name the same jurisdiction and the
// tree writes both. Everything else that is not FI or GB is OUT OF SCOPE and
// refuses — a Singapore entity asking "is this deductible?" must get a refusal,
// never the nearest available market's answer.
export const normalizeKnowledgeJurisdiction = (raw) => {
  if (typeof raw !== 'string') return null;
  const code = raw.trim().toUpperCase();
  if (!code) return null;
  const canonical = code === 'UK' ? 'GB' : code;
  return KNOWLEDGE_JURISDICTIONS.includes(canonical) ? canonical : { out_of_scope: canonical };
};

// ── Law 4: the deterministic lexical scorer ──────────────────────────────────
//
// Unicode-aware on purpose: Finnish curation is in Finnish, and a tokenizer that
// split 'arvonlisävero' on its 'ä' would make the FI corpus unrankable. Pinned
// by id + version in the receipt so a bundle stays reproducible.
export const KNOWLEDGE_TOKENIZER = Object.freeze({
  id: 'knowret.tok.unicode',
  version: '1',
  tokenize: (s) =>
    (typeof s === 'string' ? s : '')
      .normalize('NFKC')
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((t) => t.length > 1)
});

// Overlap of the question's tokens with a passage's question_forms. Scored
// per-form and maxed rather than pooled, so a passage carrying many phrasings
// does not out-rank a passage carrying the RIGHT one — the retrieval key is
// "does this passage answer this question", not "how many ways was it phrased".
export const lexicalScore = (questionText, questionForms = []) => {
  const qTokens = new Set(KNOWLEDGE_TOKENIZER.tokenize(questionText));
  if (qTokens.size === 0) return 0;
  let best = 0;
  for (const form of Array.isArray(questionForms) ? questionForms : []) {
    const fTokens = KNOWLEDGE_TOKENIZER.tokenize(form);
    if (fTokens.length === 0) continue;
    let hits = 0;
    for (const t of new Set(fTokens)) if (qTokens.has(t)) hits += 1;
    // Normalised by the FORM's length: matching 3 of a 4-token phrasing is a
    // stronger signal than matching 3 of a 20-token one.
    const score = hits / new Set(fTokens).size;
    if (score > best) best = score;
  }
  return best;
};

// ── Law 5: conflict surfacing, and an honest account of its narrowness ───────
//
// WHAT THIS CATCHES: two active, in-window passages in the same jurisdiction and
// topic that both assert an EXACT VALUE ('rate' / 'threshold') from sources of
// DIFFERENT authority_class. Two documents stating a rate for the same thing
// over the same period is a genuine curation smell, and the trust ladder has a
// defensible winner (statute over guidance).
//
// WHAT IT DOES NOT CATCH, deliberately: semantic disagreement between two
// 'rule' or 'definition' passages. Detecting that needs a model, and a model in
// this position would be intelligence-substituting scaffolding in the one place
// the Keep layer owns — worse, a false conflict is not free: it either spams
// every answer or trains the reader to ignore the marker, and a conflict nobody
// reads is not surfaced. So this stays narrow and deterministic. Two passages on
// the same topic coexisting is NORMAL (a standard rate and a reduced rate are
// not in conflict) and is not flagged.
//
// The winner is ranked first; the loser is NOT dropped — it is named in the
// receipt so a curator can see the disagreement and fix the corpus. Ranking a
// winner is not resolving a conflict, and this never blocks anything.
export const detectExactValueConflicts = (entries) => {
  const conflicts = [];
  const byTopic = new Map();
  for (const entry of entries) {
    if (!['rate', 'threshold'].includes(entry.passage.answer_shape)) continue;
    const key = `${entry.passage.jurisdiction}::${entry.passage.topic}::${entry.passage.answer_shape}`;
    if (!byTopic.has(key)) byTopic.set(key, []);
    byTopic.get(key).push(entry);
  }
  for (const [key, group] of byTopic) {
    if (group.length < 2) continue;
    const classes = new Set(group.map((e) => e.source.authority_class));
    if (classes.size < 2) continue;   // same class ⇒ no ladder to apply, no claim to make
    const ordered = [...group].sort(
      (a, b) => authorityRank(a.source.authority_class) - authorityRank(b.source.authority_class)
        || String(a.passage.id).localeCompare(String(b.passage.id))
    );
    const [winner, ...losers] = ordered;
    conflicts.push({
      key,
      topic: winner.passage.topic,
      answer_shape: winner.passage.answer_shape,
      prevailing_passage_id: winner.passage.id,
      prevailing_authority_class: winner.source.authority_class,
      conflicting_passage_ids: losers.map((l) => l.passage.id),
      conflicting_authority_classes: losers.map((l) => l.source.authority_class),
      // Said plainly, because the marker is read by a human under time pressure.
      note: 'two sources of different authority class carry an exact value for the same topic and period — the higher class prevails and BOTH are shown; route to curation review'
    });
  }
  return conflicts.sort((a, b) => a.key.localeCompare(b.key));
};

// ── Projection ───────────────────────────────────────────────────────────────
//
// Curated corpus text is far safer than tenant free text — it was written by a
// reviewer, not pasted from an invoice. It is still DATA, not instructions, so
// it is delimited, control-stripped and bounded before it reaches a prompt. A
// truncation is recorded rather than hidden: an answer grounded on half a
// paragraph should be visibly grounded on half a paragraph.
const stripControl = (s) => String(s).replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, ' ');

const boundText = (text, max) => {
  const clean = stripControl(text ?? '');
  if (clean.length <= max) return { text: clean, truncated: false };
  return { text: clean.slice(0, max), truncated: true };
};

const projectPassage = ({ passage, source, staleness, maxChars, rank, score }) => {
  const excerpt = boundText(passage.source_excerpt, maxChars);
  const proposition = boundText(passage.curated_proposition, maxChars);
  return {
    passage_id: passage.id,
    source_id: source.id,
    rank,
    lexical_score: score,
    topic: passage.topic,
    answer_shape: passage.answer_shape,
    jurisdiction: passage.jurisdiction,
    // The two halves stay SEPARATE all the way to the prompt (§4.2) — collapsing
    // them here would destroy the one property that makes "does the
    // interpretation follow from the source?" checkable downstream.
    source_excerpt: excerpt.text,
    source_anchor: passage.source_anchor,
    curated_proposition: proposition.text,
    caveats: passage.caveats ?? null,
    truncated: excerpt.truncated || proposition.truncated,
    effective_from: passage.effective_from ?? null,
    effective_until: passage.effective_until ?? null,
    // Staleness travels WITH the passage, so an answer cannot quote the text and
    // drop the caveat.
    staleness,
    citation: {
      authority: source.authority,
      authority_class: source.authority_class,
      citation: source.citation ?? null,
      title: source.title,
      source_url: source.source_url,
      language: source.language,
      translation_status: source.translation_status,
      published_at: source.published_at ?? null,
      as_of: source.as_of ?? null,
      review_due_at: source.review_due_at ?? null,
      confirmed_against_primary: source.confirmed_against_primary === true,
      // Never dropped when false: an unconfirmed source may ground an answer
      // ONLY with its unconfirmed status stated (§7).
      verification_note: source.verification_note ?? null,
      snapshot_ref: source.snapshot_ref ?? null,
      content_hash: source.content_hash ?? null
    }
  };
};

// ── The executor ─────────────────────────────────────────────────────────────
//
// retrieveKnowledge({ trustedContext, request, deps }) → {
//   status: 'ok' | 'refused',
//   failure,                 // one of KNOWLEDGE_RETRIEVAL_FAILURES on refusal
//   grounding: { jurisdiction, decision_date, coverage, passages, conflicts },
//   receipt                  // complete, single, and always present
// }
//
// A refusal returns EMPTY grounding plus a receipt naming the failure. It never
// widens the filter, never drops to the other jurisdiction, and never returns
// out-of-window rows "for context".
export const retrieveKnowledge = async ({ trustedContext = null, request = null, deps = {} } = {}) => {
  const purpose = getKnowledgeRetrievalPurpose(request?.purpose_id);
  const purposeFingerprint = knowledgePurposeRegistryFingerprint();

  const nowIso = trustedContext?.occurred_at ?? new Date().toISOString();
  const rawJurisdiction = trustedContext?.legal_entity?.jurisdiction ?? null;
  const normalized = normalizeKnowledgeJurisdiction(rawJurisdiction);
  const jurisdiction = typeof normalized === 'string' ? normalized : null;

  // Decision date (law 2): the transaction/tax-point date where the question is
  // about one, else the authoritative clock. Never a caller-supplied "now".
  const decisionDateRaw = request?.decision_date ?? null;
  const decisionDate = (() => {
    if (decisionDateRaw === null || decisionDateRaw === undefined) return nowIso;
    const d = new Date(decisionDateRaw);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  })();

  const retrievalId = knowledgeRetrievalIdFor({
    sourceEventId: trustedContext?.source_event_id ?? null,
    purposeId: request?.purpose_id ?? null,
    jurisdiction,
    decisionDate,
    configSnapshotId: trustedContext?.config_snapshot_id ?? null
  });

  const baseReceipt = (extra = {}) => ({
    retrieval_id: retrievalId,
    capability: KNOWLEDGE_RETRIEVAL_CAPABILITY_ID,
    purpose_id: request?.purpose_id ?? null,
    purpose_version: purpose?.purpose_version ?? null,
    purpose_registry_fingerprint: purposeFingerprint,
    service_version: KNOWLEDGE_RETRIEVAL_SERVICE_VERSION,
    policy_version: KNOWLEDGE_RETRIEVAL_POLICY_VERSION,
    ranker_version: KNOWLEDGE_RETRIEVAL_RANKER_VERSION,
    renderer_version: KNOWLEDGE_RETRIEVAL_RENDERER_VERSION,
    acl_version: KNOWLEDGE_RETRIEVAL_ACL_VERSION,
    tokenizer_id: KNOWLEDGE_TOKENIZER.id,
    tokenizer_version: KNOWLEDGE_TOKENIZER.version,
    // "The model id is part of the receipt" (CLAUDE.md). The ANSWERING model is
    // the caller's, not this module's — recorded, never inferred, and null when
    // the caller did not state it rather than guessed from a code default.
    model_id: trustedContext?.model_id ?? null,
    config_snapshot_id: trustedContext?.config_snapshot_id ?? null,
    legal_entity_id: trustedContext?.legal_entity?.client_id ?? null,
    jurisdiction,
    jurisdiction_source: 'legal_entity',
    decision_date: decisionDate,
    evaluated_at: nowIso,
    included: [],
    withheld: [],
    conflicts: [],
    coverage: 'none',
    failure: null,
    ...extra
  });

  const refuse = (failure, extra = {}) => ({
    status: 'refused',
    failure,
    grounding: { jurisdiction, decision_date: decisionDate, coverage: 'none', passages: [], conflicts: [] },
    receipt: baseReceipt({ failure, ...extra })
  });

  // ── Lane gate. Order matters only in that each check is independent and all
  // fail closed; none of them consults the corpus.
  if (!trustedContext || typeof trustedContext !== 'object') return refuse('invalid_request');
  if (!request || typeof request !== 'object') return refuse('invalid_request');
  if (!purpose) return refuse('unknown_purpose');
  if (!purpose.allowed_consumer_ids.includes(trustedContext.consumer_capability_id)) {
    return refuse('consumer_not_permitted');
  }
  if (!purpose.allowed_audience_classes.includes(trustedContext.resolved_audience?.audience_class)) {
    return refuse('audience_not_permitted');
  }
  if (decisionDate === null) return refuse('invalid_request');

  // Born off. A client with no stage row retrieves nothing at all.
  if (!knowledgeBaseRetrievalActs({ snapshot: trustedContext.config_snapshot ?? null, env: deps.env ?? process.env })) {
    return refuse('retrieval_disabled');
  }

  // Law 1, failing closed.
  if (normalized === null) return refuse('jurisdiction_unresolved');
  if (typeof normalized !== 'string') {
    return refuse('jurisdiction_out_of_scope', { out_of_scope_jurisdiction: normalized.out_of_scope });
  }

  const requestedTopics = Array.isArray(request.topics)
    ? request.topics.filter((t) => KNOWLEDGE_TOPICS.includes(t))
    : [];

  // Budget: a caller may only LOWER the registered maximum.
  const budget = { ...purpose.default_budget };
  const override = request.budget_override;
  if (override && typeof override === 'object') {
    for (const key of Object.keys(budget)) {
      if (typeof override[key] === 'number' && override[key] >= 0) {
        budget[key] = Math.min(override[key], purpose.maximum_budget[key]);
      }
    }
  }
  for (const key of Object.keys(budget)) budget[key] = Math.min(budget[key], purpose.maximum_budget[key]);

  // ── Load candidates. The store read filters by jurisdiction and active
  // status; this module RE-APPLIES every rule regardless of what the loader
  // returned (defence in depth — never trust the loader to have gated).
  let candidates = [];
  try {
    if (typeof deps.loadKnowledgeCandidates !== 'function') return refuse('store_unavailable');
    candidates = (await deps.loadKnowledgeCandidates({
      jurisdiction,
      topics: requestedTopics
    })) || [];
  } catch {
    return refuse('store_unavailable');
  }

  const included = [];
  const withheld = [];

  for (const candidate of candidates) {
    const passage = candidate?.passage;
    const source = candidate?.source;
    if (!passage || !source) continue;

    // Law 1 re-applied. A loader bug that returned the other market's rows must
    // not become a cross-jurisdiction answer.
    if (passage.jurisdiction !== jurisdiction || source.jurisdiction !== jurisdiction) {
      withheld.push({
        passage_id: passage.id ?? null,
        topic: passage.topic ?? null,
        answer_shape: passage.answer_shape ?? null,
        reason: 'jurisdiction_mismatch',
        source_as_of: source.as_of ?? null,
        source_review_due_at: source.review_due_at ?? null
      });
      continue;
    }

    // Laws 2 + 3, through the shared predicate — window against the DECISION
    // date, staleness against NOW.
    const verdict = passageRetrievability({
      passage,
      source,
      at: decisionDate,
      now: nowIso
    });

    if (!verdict.retrievable) {
      withheld.push({
        passage_id: passage.id,
        topic: passage.topic,
        answer_shape: passage.answer_shape,
        reason: verdict.reason,
        // These two are what let outcome 3 say "there is a rate here and this is
        // when we last checked it" without quoting the unverified number.
        source_as_of: source.as_of ?? null,
        source_review_due_at: source.review_due_at ?? null
      });
      continue;
    }

    included.push({ passage, source, staleness: verdict.staleness });
  }

  // ── Law 4: rank. Every key is deterministic and the last one is total.
  const scored = included.map((entry) => ({
    ...entry,
    topic_match: requestedTopics.length > 0 && requestedTopics.includes(entry.passage.topic),
    score: lexicalScore(request.question_text, entry.passage.question_forms)
  }));

  const recencyKey = (entry) => {
    const from = entry.passage.effective_from ?? entry.source.effective_from ?? null;
    const t = from ? new Date(from).getTime() : null;
    return Number.isFinite(t) ? t : -Infinity;
  };

  scored.sort((a, b) =>
    Number(b.topic_match) - Number(a.topic_match)
    || b.score - a.score
    || authorityRank(a.source.authority_class) - authorityRank(b.source.authority_class)
    || recencyKey(b) - recencyKey(a)
    || String(a.passage.id).localeCompare(String(b.passage.id))
  );

  // Conflicts are computed over EVERYTHING retained, before the budget cut —
  // a conflict that fell off the end of the list is still a conflict, and the
  // curator needs to see it.
  const conflicts = detectExactValueConflicts(scored);

  const kept = scored.slice(0, budget.max_passages);
  for (const dropped of scored.slice(budget.max_passages)) {
    withheld.push({
      passage_id: dropped.passage.id,
      topic: dropped.passage.topic,
      answer_shape: dropped.passage.answer_shape,
      reason: 'budget',
      source_as_of: dropped.source.as_of ?? null,
      source_review_due_at: dropped.source.review_due_at ?? null
    });
  }

  const passages = kept.map((entry, i) =>
    projectPassage({
      passage: entry.passage,
      source: entry.source,
      staleness: entry.staleness,
      maxChars: budget.max_excerpt_chars,
      rank: i,
      score: entry.score
    })
  );

  // Coverage (the signal, not the outcome). 'covered' requires a passage that
  // actually engaged the ask — a topic hit or a real lexical overlap. Passages
  // that merely exist in the jurisdiction are 'adjacent', which is precisely the
  // shape of an honest partial.
  const engaged = kept.some((e) => e.topic_match || e.score > 0);
  const coverage = kept.length === 0 ? 'none' : (engaged ? 'covered' : 'adjacent');

  const receipt = baseReceipt({
    coverage,
    conflicts,
    included: passages.map((p) => ({
      passage_id: p.passage_id,
      source_id: p.source_id,
      rank: p.rank,
      topic: p.topic,
      answer_shape: p.answer_shape,
      staleness: p.staleness,
      lexical_score: p.lexical_score,
      truncated: p.truncated,
      authority: p.citation.authority,
      authority_class: p.citation.authority_class,
      citation: p.citation.citation,
      source_url: p.citation.source_url,
      as_of: p.citation.as_of,
      confirmed_against_primary: p.citation.confirmed_against_primary,
      content_hash: p.citation.content_hash
    })),
    withheld
  });

  return {
    status: 'ok',
    failure: null,
    grounding: { jurisdiction, decision_date: decisionDate, coverage, passages, conflicts },
    receipt
  };
};
