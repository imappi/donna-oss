// Donna — K1, the sourced knowledge base: the CONTRACT layer
// (docs/design-donna-knowledge-base.md, as revised 2026-07-29 after the
// external review; slice K1-1. Migration 109 is the store.)
//
// WHAT THIS IS FOR. Under the 2026-07-23 self-service re-amendment the fork is
// FACT vs KNOWLEDGE: a business fact only the owner knows → ask the owner; a
// knowledge/judgment question (ALV/VAT, capitalize-vs-expense, deductibility)
// → Donna answers HERSELF, grounded in curated high-trust sources. This module
// is the vocabulary + validation for those sources. It holds no SQL; the
// writers are knowledgeBaseDb.js.
//
// TRUST-THE-STRONG-LLM, THE POSITIVE CASE. Everywhere else the principle argues
// for DELETING scaffolding; here it argues for BUILDING substrate — the gap is
// not the model's reasoning, it is that the model has no grounded, current,
// citable source for what the law says TODAY in THIS jurisdiction. So nothing
// below encodes anyone's recollection of Vero or HMRC guidance as executable
// logic (that is a rules engine, and it is the named anti-goal). It validates
// PROVENANCE and SHAPE, and it refuses rows that cannot be grounded. The model
// still does the reasoning and the drafting; K1 gives it something true and
// current to reason FROM, and a citation to show its work.
//
// THE FOUR LAWS THIS MODULE ENFORCES:
//
//   1. NO TENANT IDENTIFIER (design §3). K1 is GLOBAL — the Finnish VAT Act is
//      not a fact about a customer. findTenantIdentifiers() refuses any draft
//      carrying a firm/client/party identifier, by KEY and by id-shaped VALUE.
//      Deliberately tuned not to fire on prose: "a client must retain records
//      for six years" is a perfectly good passage; `client_id: 'client-acme'`
//      is not. A customer-specific observation belongs in plane M and dies
//      with its client, as before.
//   2. GROUNDING IS CHECKABLE (§4.2). A passage carries the exact
//      `source_excerpt` AND the reviewed `curated_proposition` separately, so a
//      human (or a test) can ask whether the interpretation follows from the
//      source. A proposition without an excerpt is refused.
//   3. THE EFFECTIVE WINDOW IS A HARD FILTER (§7). A passage outside its window
//      is NOT retrieved — not merely down-ranked. And the window is evaluated
//      against the DECISION DATE (the transaction/tax-point date where the
//      question is about one, else today), so a 2026 question about a 2024
//      transaction gets 2024's rule.
//   4. STALENESS IS RISK-CLASSED (§7). Past `review_due_at`, an exact-value
//      passage ('rate'/'threshold' — something someone will act on) is NOT
//      retrievable as current; an explanation ('rule'/'procedure'/'definition')
//      stays retrievable with the staleness STATED. Degrade the claim, never
//      hide it — but degrade exact values harder than explanations.
//
// WHAT THIS MODULE MAY NEVER DO (§2, GROUND vs GOVERN): authorize anything. No
// export here belongs in a code path that reaches a ledger writer. Executable
// statutory logic lives in the packs and country modules (finland/alvCodes.js,
// gb/vatCodes.js); when a passage disagrees with a pack that is a conflict to
// SURFACE, never a silent override and never a block on posting.

import { createHash } from 'node:crypto';

export const KNOWLEDGE_SCHEMA_VERSION = 'knowledge.v1';

// The two ICP markets (2026-07-27 market amendment: FI and GB, and Kari's
// 2026-07-29 call — equally deep, neither first-class). A third jurisdiction is
// a decision; widen this AND migration 109's CHECK together.
export const KNOWLEDGE_JURISDICTIONS = Object.freeze(['FI', 'GB']);

// The trust ladder, in rank order — index IS the rank (0 = highest). Where two
// active passages conflict the higher class wins AND the conflict is surfaced
// (§7); it is never resolved silently.
export const KNOWLEDGE_AUTHORITY_CLASSES = Object.freeze([
  'statute',
  'tax_authority_guidance',
  'regulator_guidance',
  'professional_body'
]);

// Closed topic vocabulary (§5) — the questions a single-owner service business
// actually asks in its first months. Every entry has a real answer in BOTH
// jurisdictions, which is what makes equal-depth curation possible. Extending
// this list is a decision (design §13 Q3), not a commit.
export const KNOWLEDGE_TOPICS = Object.freeze([
  'vat_registration',
  'vat_rates',
  'vat_deduction',
  'reverse_charge',
  'entertainment_and_meals',
  'vehicle_costs',
  'home_office',
  'travel_and_per_diem',
  'capitalize_vs_expense',
  'payroll_basics',
  'invoice_requirements',
  'record_retention',
  'fiscal_period_basics'
]);

export const KNOWLEDGE_ANSWER_SHAPES = Object.freeze([
  'rule',
  'rate',
  'threshold',
  'procedure',
  'definition'
]);

// The shapes carrying an EXACT VALUE someone will act on. These are the ones a
// stale source may not ground as current (law 4).
export const EXACT_VALUE_ANSWER_SHAPES = Object.freeze(['rate', 'threshold']);

export const KNOWLEDGE_STATUSES = Object.freeze([
  'draft',
  'pending_review',
  'active',
  'superseded',
  'withdrawn'
]);

export const KNOWLEDGE_TRANSLATION_STATUSES = Object.freeze(['original', 'curator_translated']);

// Rank for the trust ladder — lower is stronger. Unknown classes sort last
// rather than throwing: an unrecognised class is a curation bug the validator
// catches, and ranking should never be the thing that explodes.
export const authorityRank = (authorityClass) => {
  const idx = KNOWLEDGE_AUTHORITY_CLASSES.indexOf(authorityClass);
  return idx === -1 ? KNOWLEDGE_AUTHORITY_CLASSES.length : idx;
};

// ─── Law 1: the no-tenant-identifier refusal ────────────────────────────────

// Keys that name a tenant, a legal entity, a principal or a counterparty.
// Matched on the FULL key, case-insensitively, so `client_id` and `partyRef`
// are caught while `identifier_requirements` (a plausible passage field name)
// is not.
const TENANT_IDENTIFIER_KEY_RE =
  /^(firm|tenant|client|customer|party|counterparty|contact|user|owner|principal|collaborator|subscription|account|merchant|vendor|supplier)_?(id|ids|ref|refs|uuid|key)$/i;

// Our internal id shapes as whole tokens: `firm-abc123`, `client_acme`.
//
// TUNED AGAINST FALSE POSITIVES, ON PURPOSE. A refusal that fired on ordinary
// curated text would make legitimate passages impossible to load, which is a
// worse failure than the one it guards: real English and real official URLs are
// full of hyphenated compounds — `customer-liability` in a gov.uk path,
// "client-facing", "party-appointed". So a bare hyphen + word is NOT an
// identifier. A hit requires the tail to look like a MACHINE id: either an
// underscore separator (identifier syntax, not English) or a digit in the tail.
// `source_url` is exempt entirely — a public document address is never a tenant
// identifier, and gov.uk/vero.fi paths are exactly where these words live.
//
// This heuristic is a BACKSTOP, and it is honest about being one. The real
// guards are structural: the tables have no tenant column and no FK to
// firms/clients (migration 109), and the KEY scan above catches the shape an
// accident actually takes (a stray `client_id` field on a curated record).
const TENANT_IDENTIFIER_VALUE_RE =
  /\b(firm|tenant|client|customer|party|counterparty|principal|merchant)([-_])([A-Za-z0-9][A-Za-z0-9_-]{1,})\b/;

const VALUE_SCAN_EXEMPT_KEYS = new Set(['source_url', 'snapshot_ref']);

const looksLikeMachineId = (match) => {
  const [, , separator, tail] = match;
  return separator === '_' || /\d/.test(tail);
};

// Recursive scan. Returns every hit with its path, so a refusal can say exactly
// what it refused and the curator can fix the row rather than guess.
export const findTenantIdentifiers = (payload, path = '') => {
  const hits = [];
  if (payload === null || payload === undefined) return hits;

  if (Array.isArray(payload)) {
    payload.forEach((item, i) => hits.push(...findTenantIdentifiers(item, `${path}[${i}]`)));
    return hits;
  }

  if (typeof payload === 'object') {
    for (const [key, value] of Object.entries(payload)) {
      const here = path ? `${path}.${key}` : key;
      if (TENANT_IDENTIFIER_KEY_RE.test(key)) {
        hits.push({ path: here, reason: 'tenant_identifier_key' });
      }
      hits.push(...findTenantIdentifiers(value, here));
    }
    return hits;
  }

  if (typeof payload === 'string') {
    const key = path.split('.').pop();
    if (VALUE_SCAN_EXEMPT_KEYS.has(key)) return hits;
    const match = payload.match(TENANT_IDENTIFIER_VALUE_RE);
    if (match && looksLikeMachineId(match)) {
      hits.push({ path: path || '(root)', reason: 'tenant_identifier_value', token: match[0] });
    }
  }

  return hits;
};

// ─── Deterministic ids ──────────────────────────────────────────────────────

const sha = (parts, prefix) =>
  `${prefix}-${createHash('sha256').update(parts.filter((p) => p !== null && p !== undefined).join('\u0000')).digest('hex').slice(0, 24)}`;

// Same document re-curated ⇒ same id ⇒ the loader is idempotent rather than
// minting a duplicate source row.
export const knowledgeSourceId = ({ jurisdiction, citation = null, source_url = null, effective_from = null } = {}) =>
  sha([jurisdiction, citation || source_url, effective_from], 'ksrc');

export const knowledgePassageId = ({ source_id, topic, source_anchor } = {}) =>
  sha([source_id, topic, source_anchor], 'kpsg');

// Content fingerprint for load idempotency: re-loading an UNCHANGED passage is
// a no-op; changed content is a supersession (a new row), never an in-place
// edit of a row an answer may already cite.
export const knowledgeContentFingerprint = (record = {}) =>
  createHash('sha256')
    .update(
      JSON.stringify([
        record.source_excerpt ?? null,
        record.curated_proposition ?? null,
        record.caveats ?? null,
        record.answer_shape ?? null,
        record.topic ?? null,
        [...(record.question_forms || [])].sort()
      ])
    )
    .digest('hex');

// ─── Validation ─────────────────────────────────────────────────────────────

const toUtcIso = (value, field, errors) => {
  if (value === null || value === undefined) return null;
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) {
    errors.push(`${field}: not a valid timestamp`);
    return null;
  }
  return d.toISOString();
};

const requireString = (value, field, errors) => {
  if (typeof value !== 'string' || value.trim() === '') {
    errors.push(`${field}: required`);
    return null;
  }
  return value;
};

const requireOneOf = (value, allowed, field, errors) => {
  if (!allowed.includes(value)) {
    errors.push(`${field}: must be one of ${allowed.join(' | ')}`);
    return null;
  }
  return value;
};

// A source draft → a validated, id-bearing record, or a list of errors. Never
// both: a refused draft produces NO record, so a caller cannot half-write one.
export const validateKnowledgeSourceDraft = ({ source = {} } = {}) => {
  const errors = [];

  const tenantHits = findTenantIdentifiers(source);
  for (const hit of tenantHits) {
    errors.push(`${hit.path}: ${hit.reason}${hit.token ? ` (${hit.token})` : ''} — K1 is global and carries no tenant identifier`);
  }

  const record = { schema_version: KNOWLEDGE_SCHEMA_VERSION };

  record.authority = requireString(source.authority, 'authority', errors);
  record.authority_class = requireOneOf(source.authority_class, KNOWLEDGE_AUTHORITY_CLASSES, 'authority_class', errors);
  record.jurisdiction = requireOneOf(source.jurisdiction, KNOWLEDGE_JURISDICTIONS, 'jurisdiction', errors);
  record.title = requireString(source.title, 'title', errors);
  record.source_url = requireString(source.source_url, 'source_url', errors);
  record.language = requireString(source.language, 'language', errors);
  record.citation = source.citation ?? null;

  record.translation_status = requireOneOf(
    source.translation_status ?? 'original',
    KNOWLEDGE_TRANSLATION_STATUSES,
    'translation_status',
    errors
  );

  record.content_hash = source.content_hash ?? null;
  record.snapshot_ref = source.snapshot_ref ?? null;

  record.published_at = toUtcIso(source.published_at ?? null, 'published_at', errors);
  record.effective_from = toUtcIso(source.effective_from ?? null, 'effective_from', errors);
  record.effective_until = toUtcIso(source.effective_until ?? null, 'effective_until', errors);
  if (source.as_of === null || source.as_of === undefined) errors.push('as_of: required');
  record.as_of = toUtcIso(source.as_of ?? null, 'as_of', errors);
  record.review_due_at = toUtcIso(source.review_due_at ?? null, 'review_due_at', errors);

  if (record.effective_from && record.effective_until && record.effective_until <= record.effective_from) {
    errors.push('effective_until: must be after effective_from');
  }

  record.confirmed_against_primary = source.confirmed_against_primary === true;
  record.verification_note = source.verification_note ?? null;
  // Unconfirmed is permitted and honest — but never silent (§7).
  if (!record.confirmed_against_primary && !record.verification_note) {
    errors.push('verification_note: required when confirmed_against_primary is false — say why it could not be verified');
  }

  record.reviewed_by = source.reviewed_by ?? null;
  record.reviewed_at = toUtcIso(source.reviewed_at ?? null, 'reviewed_at', errors);
  record.withdrawn_reason = source.withdrawn_reason ?? null;

  // A draft is loaded as 'draft' or 'pending_review'. Reaching 'active' is the
  // reviewer's separate act (reviewKnowledgeSource), never a field a loader
  // may set for itself — that is what keeps "a passage nobody read is not a
  // source" structural.
  record.status = requireOneOf(source.status ?? 'draft', ['draft', 'pending_review'], 'status', errors);
  record.supersedes = source.supersedes ?? null;

  if (errors.length) return { record: null, errors };

  record.id = source.id || knowledgeSourceId(record);
  return { record, errors: [] };
};

export const validateKnowledgePassageDraft = ({ passage = {}, source = null } = {}) => {
  const errors = [];

  const tenantHits = findTenantIdentifiers(passage);
  for (const hit of tenantHits) {
    errors.push(`${hit.path}: ${hit.reason}${hit.token ? ` (${hit.token})` : ''} — K1 is global and carries no tenant identifier`);
  }

  const record = { schema_version: KNOWLEDGE_SCHEMA_VERSION };

  record.source_id = requireString(passage.source_id, 'source_id', errors);
  record.jurisdiction = requireOneOf(passage.jurisdiction, KNOWLEDGE_JURISDICTIONS, 'jurisdiction', errors);
  record.topic = requireOneOf(passage.topic, KNOWLEDGE_TOPICS, 'topic', errors);
  record.answer_shape = requireOneOf(passage.answer_shape, KNOWLEDGE_ANSWER_SHAPES, 'answer_shape', errors);

  // Law 2: grounding is checkable. Both halves, always.
  record.source_excerpt = requireString(passage.source_excerpt, 'source_excerpt', errors);
  record.source_anchor = requireString(passage.source_anchor, 'source_anchor', errors);
  record.curated_proposition = requireString(passage.curated_proposition, 'curated_proposition', errors);

  const forms = passage.question_forms;
  if (!Array.isArray(forms) || forms.length === 0) {
    errors.push('question_forms: required, non-empty array');
    record.question_forms = [];
  } else if (!forms.every((f) => typeof f === 'string' && f.trim() !== '')) {
    errors.push('question_forms: every entry must be a non-empty string');
    record.question_forms = [];
  } else {
    record.question_forms = forms;
  }

  record.caveats = passage.caveats ?? null;
  record.effective_from = toUtcIso(passage.effective_from ?? null, 'effective_from', errors);
  record.effective_until = toUtcIso(passage.effective_until ?? null, 'effective_until', errors);

  if (record.effective_from && record.effective_until && record.effective_until <= record.effective_from) {
    errors.push('effective_until: must be after effective_from');
  }

  // A passage INHERITS its source's window and may only NARROW it. A passage
  // that outlived its source's authority would ground an answer on a rule the
  // source no longer carries.
  if (source) {
    if (source.jurisdiction && record.jurisdiction && source.jurisdiction !== record.jurisdiction) {
      errors.push(`jurisdiction: must match its source (${source.jurisdiction})`);
    }
    const srcFrom = source.effective_from ? new Date(source.effective_from).toISOString() : null;
    const srcUntil = source.effective_until ? new Date(source.effective_until).toISOString() : null;
    if (srcFrom && record.effective_from && record.effective_from < srcFrom) {
      errors.push('effective_from: may narrow its source window, never widen it');
    }
    if (srcUntil && record.effective_until && record.effective_until > srcUntil) {
      errors.push('effective_until: may narrow its source window, never widen it');
    }
    if (srcUntil && !record.effective_until) {
      // Inherit rather than refuse — the common curation case.
      record.effective_until = srcUntil;
    }
    if (srcFrom && !record.effective_from) record.effective_from = srcFrom;
  }

  record.reviewed_by = passage.reviewed_by ?? null;
  record.reviewed_at = toUtcIso(passage.reviewed_at ?? null, 'reviewed_at', errors);
  record.withdrawn_reason = passage.withdrawn_reason ?? null;
  record.status = requireOneOf(passage.status ?? 'draft', ['draft', 'pending_review'], 'status', errors);
  record.supersedes = passage.supersedes ?? null;

  if (errors.length) return { record: null, errors };

  record.id = passage.id || knowledgePassageId(record);
  return { record, errors: [] };
};

// ─── Laws 3 and 4: the retrieval predicates ─────────────────────────────────

const asTime = (value) => {
  if (value === null || value === undefined) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.getTime();
};

// Law 3. `at` is the DECISION DATE — the transaction/tax-point date where the
// question is about one, else today. A passage outside its window is not
// retrieved at all.
export const passageIsEffectiveAt = (passage = {}, at = new Date()) => {
  const t = asTime(at);
  if (t === null) return false;
  const from = asTime(passage.effective_from);
  const until = asTime(passage.effective_until);
  if (from !== null && t < from) return false;
  if (until !== null && t >= until) return false;
  return true;
};

// Law 4. Staleness is about when WE last verified the source, so it is measured
// against NOW — not against the decision date. (A 2024 question asked today is
// still answered from a source we last checked in 2024; that source being
// unreviewed for two years is exactly what the owner deserves to be told.)
export const sourceIsStaleAt = (source = {}, now = new Date()) => {
  const due = asTime(source.review_due_at);
  if (due === null) return false;
  const t = asTime(now);
  return t !== null && t >= due;
};

// The single predicate a retrieval strategy (K1-4) calls. Returns WHY, not just
// whether — an answer that cannot say why a passage was withheld is not
// auditable.
//
//   { retrievable: false, reason }                  → not usable at all
//   { retrievable: true, staleness: 'fresh' }       → ordinary grounding
//   { retrievable: true, staleness: 'stale' }       → usable, and the answer
//                                                     MUST state the source has
//                                                     not been re-verified
export const passageRetrievability = ({ passage = {}, source = {}, at = new Date(), now = new Date() } = {}) => {
  if (passage.status !== 'active') {
    return { retrievable: false, reason: `passage_status_${passage.status || 'unknown'}`, staleness: null };
  }
  if (source.status !== 'active') {
    return { retrievable: false, reason: `source_status_${source.status || 'unknown'}`, staleness: null };
  }
  if (!passageIsEffectiveAt(passage, at)) {
    return { retrievable: false, reason: 'outside_effective_window', staleness: null };
  }

  const stale = sourceIsStaleAt(source, now);
  if (!stale) return { retrievable: true, reason: null, staleness: 'fresh' };

  // The risk class: an exact value nobody re-verified is the confident-and-wrong
  // failure mode in miniature. Withhold it; let the answer degrade to an honest
  // partial naming the unverified value's date.
  if (EXACT_VALUE_ANSWER_SHAPES.includes(passage.answer_shape)) {
    return { retrievable: false, reason: 'stale_exact_value', staleness: 'stale' };
  }
  return { retrievable: true, reason: null, staleness: 'stale' };
};
