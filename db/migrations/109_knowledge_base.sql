-- Donna — K1, the sourced knowledge base: `knowledge_sources` +
-- `knowledge_passages` (docs/design-donna-knowledge-base.md §4, as revised
-- 2026-07-29 after the external review; slice K1-1).
--
-- WHY THIS EXISTS: the 2026-07-23 self-service re-amendment removed the
-- professional backstop, so Donna answers KNOWLEDGE questions (tax treatment,
-- VAT/ALV, capitalize-vs-expense) herself. Today she answers them from the
-- model's training corpus — no provenance, no as-of date, no citation, no way
-- for a reader to check. These two tables are the substrate that makes a
-- knowledge answer GROUNDED and CITABLE. Sources are what we trust; passages
-- are what we retrieve.
--
-- THE THREE STRUCTURAL LAWS, in the TABLES (not merely in the validator):
--
--   1. NO TENANT IDENTIFIER, EVER (design §3). K1 is GLOBAL: the Finnish VAT
--      Act is not a fact about a customer. There is deliberately NO firm_id,
--      NO client_id, and NO foreign key to firms/clients anywhere below — the
--      absence is the invariant, and migrations.test.js asserts it by reading
--      this file. This is NOT an exception to "memory dies with its client":
--      K1's owning scope is the PLATFORM, so it does not die with a tenant.
--      The writer (knowledgeBaseDb.js) refuses any payload carrying a client /
--      firm / party identifier; that refusal is a test, not a convention.
--
--   2. APPEND-MOSTLY WITH SUPERSESSION, NEVER PURGE (design §4 lifecycle law).
--      A change is a NEW row plus a `supersedes` link; an in-place content edit
--      is not a thing. A wrong or dead row goes 'withdrawn' — kept, never
--      retrieved as current. Hard deletion would orphan the receipts of every
--      answer the row ever grounded ("an answer given last March must remain
--      explicable from the rows as they stood"). The partial unique index on
--      `supersedes` is the no-last-write-wins backstop: a row may be superseded
--      exactly once, so the chain cannot fork.
--
--   3. ACTIVE MEANS REVIEWED, SNAPSHOTTED AND HONEST (design §4.1, §7, §8).
--      Three CHECKs gate `status = 'active'`, which is the only status
--      retrieval will ever read:
--        - a reviewer and a review date (curation governance — "a passage
--          nobody read is not a source");
--        - `content_hash` + `snapshot_ref` (official pages are edited
--          silently; without a snapshot, "what Donna read in March" is not
--          reconstructable in October);
--        - `confirmed_against_primary` true, OR a `verification_note` saying
--          why it could not be — the GB_VAT_RATE_PROVENANCE honesty
--          convention. Kari's 2026-07-29 call: GB ships primary-verified via a
--          network-open CURATION session, so unconfirmed is a narrow, labelled
--          exception, never the default grounding.
--
-- AUDIT, AND WHY IT IS NOT audit_events: `audit_events.firm_id` is NOT NULL
-- with an ON DELETE CASCADE to firms (migration 001). A global corpus has no
-- firm — writing curation events there would either invent a tenant identifier
-- on a tenant-free plane (law 1) or let a tenant deletion cascade away the
-- provenance of platform-wide knowledge. So K1's curation history lives IN THE
-- ROWS: append-mostly + supersession + reviewer fields + withdrawal reasons ARE
-- the trail. knowledgeBaseDb.test.js pins that the writer never touches
-- audit_events.
--
-- WHAT THESE TABLES MAY NOT DO (design §2 — GROUND vs GOVERN): nothing here
-- authorizes anything. K1 grounds natural-language answers; packs and country
-- modules (finland/alvCodes.js, gb/vatCodes.js) GOVERN actions. No K1 read may
-- appear in a code path that reaches a ledger writer, and a passage that
-- disagrees with a pack is a conflict to SURFACE, never a silent override and
-- never a reason to block a posting (a veto would be authority).
--
-- CHECK vocabularies below are pinned to knowledgeBase.js by migrations.test.js
-- — a value the writer emits but the column rejects is a silent fail.

create table if not exists knowledge_sources (
  -- Deterministic id ('ksrc-…'), minted from jurisdiction + citation/url +
  -- effective_from so re-curating the same document is idempotent.
  id text primary key,
  schema_version text not null default 'knowledge.v1' check (schema_version = 'knowledge.v1'),

  -- Provenance. `authority_class` is the trust ladder AND it ranks:
  -- statute > tax_authority_guidance > regulator_guidance > professional_body.
  authority text not null,
  authority_class text not null check (authority_class in
                    ('statute', 'tax_authority_guidance', 'regulator_guidance', 'professional_body')),
  -- ISO-2, never null. Closed to the two ICP markets (2026-07-27 amendment:
  -- FI and GB, neither first-class over the other). A third market is a
  -- decision, not a commit — widen this CHECK deliberately.
  jurisdiction text not null check (jurisdiction in ('FI', 'GB')),
  title text not null,
  citation text,
  source_url text not null,

  -- What was actually read, pinned so it stays reconstructable (§4.1).
  content_hash text,
  snapshot_ref text,
  language text not null,
  translation_status text not null default 'original' check (translation_status in
                    ('original', 'curator_translated')),

  -- Truth validity (the statute's own dates) vs when WE read it — different
  -- axes, never collapsed.
  published_at timestamptz,
  effective_from timestamptz,
  effective_until timestamptz,
  as_of timestamptz not null,
  review_due_at timestamptz,

  -- Honesty about verification (§7).
  confirmed_against_primary boolean not null default false,
  verification_note text,

  -- Curation governance (§4.1).
  reviewed_by text,
  reviewed_at timestamptz,
  withdrawn_reason text,

  -- Lifecycle. 'draft' → 'pending_review' → 'active'; 'superseded' and
  -- 'withdrawn' are terminal history that stays readable. No state means
  -- deleted (law 2).
  status text not null default 'draft' check (status in
                    ('draft', 'pending_review', 'active', 'superseded', 'withdrawn')),
  supersedes text references knowledge_sources(id),

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- Active is reviewed (curation governance is structural, not a habit).
  constraint knowledge_sources_active_is_reviewed check (
    status <> 'active' or (reviewed_by is not null and reviewed_at is not null)
  ),
  -- Active is snapshotted (the curation session captured the artifact).
  constraint knowledge_sources_active_is_snapshotted check (
    status <> 'active' or (content_hash is not null and snapshot_ref is not null)
  ),
  -- Unconfirmed is allowed, but never silent: it must say why.
  constraint knowledge_sources_unconfirmed_explains check (
    confirmed_against_primary = true or verification_note is not null
  ),
  -- A window that closes before it opens is a curation error, not a fact.
  constraint knowledge_sources_window_ordered check (
    effective_from is null or effective_until is null or effective_until > effective_from
  ),
  -- Withdrawal states its reason (a silent withdrawal is unexplainable later).
  constraint knowledge_sources_withdrawal_explains check (
    status <> 'withdrawn' or withdrawn_reason is not null
  )
);

create table if not exists knowledge_passages (
  -- Deterministic id ('kpsg-…') from source + topic + anchor.
  id text primary key,
  schema_version text not null default 'knowledge.v1' check (schema_version = 'knowledge.v1'),
  -- No cascade: a source is never deleted, so a passage can never be orphaned
  -- by one disappearing.
  source_id text not null references knowledge_sources(id),

  -- Denormalized from the source for cheap filtering. Jurisdiction is a HARD
  -- FILTER at retrieval, never a ranking signal — a GB question is never
  -- answered from an FI passage.
  jurisdiction text not null check (jurisdiction in ('FI', 'GB')),

  -- Closed topic vocabulary (design §5). Extending it is a decision.
  topic text not null check (topic in (
    'vat_registration', 'vat_rates', 'vat_deduction', 'reverse_charge',
    'entertainment_and_meals', 'vehicle_costs', 'home_office',
    'travel_and_per_diem', 'capitalize_vs_expense', 'payroll_basics',
    'invoice_requirements', 'record_retention', 'fiscal_period_basics'
  )),
  -- The natural phrasings this answers — the deterministic retrieval key for
  -- v1 (no embeddings; ~60 passages do not need them and a deterministic
  -- ranker is testable and explicable).
  question_forms jsonb not null,

  -- THE SPLIT THAT MAKES GROUNDING CHECKABLE (§4.2, adopted from the external
  -- review): a quote and a faithful summary are epistemically different
  -- things, and human-written summaries introduce errors too. The excerpt is
  -- exact text, never edited; the proposition is the reviewed interpretation
  -- Donna may apply. Storing them apart is what makes "does the interpretation
  -- actually follow from the source?" a checkable question rather than a hope.
  source_excerpt text not null,
  source_anchor text not null,
  curated_proposition text not null,

  -- Drives the staleness risk-class (§7): a stale 'rate'/'threshold' — an
  -- exact value someone will act on — is NOT retrieved as current, while a
  -- stale explanation degrades visibly but stays retrievable.
  answer_shape text not null check (answer_shape in
                    ('rule', 'rate', 'threshold', 'procedure', 'definition')),
  caveats text,

  -- Inherited from the source unless the passage NARROWS it (the validator
  -- refuses a widening — a passage may not outlive its source's authority).
  effective_from timestamptz,
  effective_until timestamptz,

  reviewed_by text,
  reviewed_at timestamptz,
  withdrawn_reason text,

  status text not null default 'draft' check (status in
                    ('draft', 'pending_review', 'active', 'superseded', 'withdrawn')),
  supersedes text references knowledge_passages(id),

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint knowledge_passages_active_is_reviewed check (
    status <> 'active' or (reviewed_by is not null and reviewed_at is not null)
  ),
  constraint knowledge_passages_question_forms_nonempty check (
    jsonb_typeof(question_forms) = 'array' and jsonb_array_length(question_forms) > 0
  ),
  constraint knowledge_passages_window_ordered check (
    effective_from is null or effective_until is null or effective_until > effective_from
  ),
  constraint knowledge_passages_withdrawal_explains check (
    status <> 'withdrawn' or withdrawn_reason is not null
  )
);

-- No-last-write-wins backstop (law 2): a row may be superseded exactly once,
-- so the supersession chain is linear and an answer's grounding stays
-- reconstructable.
create unique index if not exists knowledge_sources_supersedes_unique
  on knowledge_sources (supersedes)
  where supersedes is not null;

create unique index if not exists knowledge_passages_supersedes_unique
  on knowledge_passages (supersedes)
  where supersedes is not null;

-- Retrieval shape: jurisdiction (hard filter) → topic, over ACTIVE rows only.
create index if not exists knowledge_passages_active_retrieval_idx
  on knowledge_passages (jurisdiction, topic)
  where status = 'active';

create index if not exists knowledge_passages_source_id_idx
  on knowledge_passages (source_id);

create index if not exists knowledge_sources_active_jurisdiction_idx
  on knowledge_sources (jurisdiction, authority_class)
  where status = 'active';

-- The staleness sweep's read (K1-6): active sources past their review date.
create index if not exists knowledge_sources_review_due_idx
  on knowledge_sources (review_due_at)
  where status = 'active' and review_due_at is not null;
